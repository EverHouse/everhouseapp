import { db } from '../db';
import { pool } from './db';
import { users, bookingRequests, trackmanUnmatchedBookings, trackmanImportRuns, notifications, bookingMembers, bookingGuests, bookingSessions, bookingParticipants, usageLedger, guests as guestsTable } from '../../shared/schema';
import { eq, or, ilike, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { getTodayPacific, getPacificDateParts, formatNotificationDateTime } from '../utils/dateUtils';
import { sendPushNotification } from '../routes/push';
import { getHubSpotClient } from './integrations';
import { bookingEvents } from './bookingEvents';
import { getMemberTierByEmail } from './tierService';
import { createSession, recordUsage, ParticipantInput } from './bookingService/sessionManager';

interface ParsedPlayer {
  type: 'member' | 'guest';
  email: string | null;
  name: string | null;
}

function parseNotesForPlayers(notes: string): ParsedPlayer[] {
  const players: ParsedPlayer[] = [];
  if (!notes) return players;
  
  const lines = notes.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Match M: format - M: email | Name or M: email
    const memberMatch = trimmed.match(/^M:\s*([^\s|]+)(?:\s*\|\s*(.+))?$/i);
    if (memberMatch) {
      players.push({
        type: 'member',
        email: memberMatch[1].trim().toLowerCase(),
        name: memberMatch[2]?.trim() || null
      });
      continue;
    }
    
    // Match G: format - G: email | Name or G: none | Name or G: Name
    const guestMatch = trimmed.match(/^G:\s*(?:([^\s|]+)\s*\|\s*)?(.+)$/i);
    if (guestMatch) {
      const emailOrName = guestMatch[1]?.trim().toLowerCase();
      const name = guestMatch[2]?.trim();
      
      // Check if first part is "none" or looks like an email
      if (emailOrName === 'none' || !emailOrName) {
        players.push({
          type: 'guest',
          email: null,
          name: name || null
        });
      } else if (emailOrName.includes('@')) {
        players.push({
          type: 'guest',
          email: emailOrName,
          name: name || null
        });
      } else {
        // No email, just name
        players.push({
          type: 'guest',
          email: null,
          name: emailOrName + (name ? ' ' + name : '')
        });
      }
    }
  }
  
  return players;
}

interface TrackmanRow {
  bookingId: string;
  userName: string;
  userEmail: string;
  bookedDate: string;
  startDate: string;
  endDate: string;
  durationMins: number;
  status: string;
  bayNumber: string;
  playerCount: number;
  notes: string;
}

const PLACEHOLDER_EMAILS = [
  'anonymous@yourgolfbooking.com',
  'booking@evenhouse.club',
  'bookings@evenhouse.club'
];

function isPlaceholderEmail(email: string): boolean {
  const normalizedEmail = email.toLowerCase().trim();
  if (PLACEHOLDER_EMAILS.includes(normalizedEmail)) return true;
  if (normalizedEmail.endsWith('@evenhouse.club') && normalizedEmail.length < 25) {
    const localPart = normalizedEmail.split('@')[0];
    if (/^[a-z]{3,12}$/.test(localPart) && !/\d/.test(localPart)) {
      return true;
    }
  }
  return false;
}

async function loadEmailMapping(): Promise<Map<string, string>> {
  const mappingPath = path.join(process.cwd(), 'attached_assets', 'even_house_cleaned_member_data_1767012619480.csv');
  const mapping = new Map<string, string>();
  
  // Load from CSV file first
  if (fs.existsSync(mappingPath)) {
    try {
      const content = fs.readFileSync(mappingPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length >= 10) {
          const realEmail = fields[3]?.trim().toLowerCase();
          const linkedEmails = fields[9]?.trim();
          
          if (realEmail && linkedEmails) {
            const placeholders = linkedEmails.split(',').map(e => e.trim().toLowerCase());
            for (const placeholder of placeholders) {
              if (placeholder) {
                mapping.set(placeholder, realEmail);
              }
            }
          }
        }
      }
      
      process.stderr.write(`[Trackman Import] Loaded ${mapping.size} email mappings from CSV\n`);
    } catch (err: any) {
      process.stderr.write('[Trackman Import] Error loading CSV mapping: ' + err.message + '\n');
    }
  }
  
  // Also load from database (from manual resolutions)
  try {
    const usersWithMappings = await db.select({
      email: users.email,
      manuallyLinkedEmails: users.manuallyLinkedEmails
    })
    .from(users)
    .where(sql`manually_linked_emails IS NOT NULL AND jsonb_array_length(manually_linked_emails) > 0`);
    
    let dbMappingsCount = 0;
    for (const user of usersWithMappings) {
      if (user.email && Array.isArray(user.manuallyLinkedEmails)) {
        for (const placeholder of user.manuallyLinkedEmails) {
          if (typeof placeholder === 'string' && placeholder.trim()) {
            mapping.set(placeholder.toLowerCase().trim(), user.email.toLowerCase());
            dbMappingsCount++;
          }
        }
      }
    }
    
    if (dbMappingsCount > 0) {
      process.stderr.write(`[Trackman Import] Loaded ${dbMappingsCount} email mappings from database\n`);
    }
  } catch (err: any) {
    process.stderr.write('[Trackman Import] Error loading DB mappings: ' + err.message + '\n');
  }
  
  process.stderr.write(`[Trackman Import] Total email mappings: ${mapping.size}\n`);
  return mapping;
}

interface HubSpotMember {
  email: string;
  firstName: string;
  lastName: string;
  status: string;
}

// Valid membership statuses that represent real members (active or former)
const VALID_MEMBER_STATUSES = ['active', 'expired', 'terminated', 'former_member', 'inactive'];

async function getAllHubSpotMembers(): Promise<HubSpotMember[]> {
  try {
    const hubspot = await getHubSpotClient();
    
    const properties = [
      'firstname',
      'lastname',
      'email',
      'membership_status'
    ];
    
    let allContacts: any[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await hubspot.crm.contacts.basicApi.getPage(100, after, properties);
      allContacts = allContacts.concat(response.results);
      after = response.paging?.next?.after;
    } while (after);
    
    // Include contacts with active OR former member status (for historical matching)
    const validMembers = allContacts
      .filter((contact: any) => {
        const status = (contact.properties.membership_status || '').toLowerCase();
        return VALID_MEMBER_STATUSES.includes(status);
      })
      .map((contact: any) => ({
        email: (contact.properties.email || '').toLowerCase(),
        firstName: contact.properties.firstname || '',
        lastName: contact.properties.lastname || '',
        status: (contact.properties.membership_status || '').toLowerCase()
      }))
      .filter((m: HubSpotMember) => m.email);
    
    const activeCount = validMembers.filter(m => m.status === 'active').length;
    const formerCount = validMembers.length - activeCount;
    process.stderr.write(`[Trackman Import] Loaded ${validMembers.length} members from HubSpot (${activeCount} active, ${formerCount} former)\n`);
    return validMembers;
  } catch (err: any) {
    process.stderr.write(`[Trackman Import] Error fetching HubSpot contacts: ${err.message}\n`);
    // Fall back to database users if HubSpot fails
    return [];
  }
}

function normalizeStatus(status: string, bookingDate: string, startTime: string): string | null {
  const s = status.toLowerCase().trim();
  const isFuture = isFutureBooking(bookingDate, startTime);
  
  // For future bookings with confirmed/attended status, mark as approved so they show as active
  if (s === 'attended' || s === 'confirmed') {
    return isFuture ? 'approved' : 'attended';
  }
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'no_show' || s === 'noshow') return 'no_show';
  return null;
}

function isFutureBooking(bookingDate: string, startTime: string): boolean {
  const todayPacific = getTodayPacific();
  
  // If booking is in the future (date after today), it's definitely future
  if (bookingDate > todayPacific) return true;
  
  // If booking is before today, it's definitely past
  if (bookingDate < todayPacific) return false;
  
  // Same day - compare times as integers to avoid string comparison issues
  const pacificNow = getPacificDateParts();
  const currentMinutesSinceMidnight = pacificNow.hour * 60 + pacificNow.minute;
  
  // Parse startTime (could be "HH:MM:SS" or "H:MM:SS" or "HH:MM")
  const timeParts = startTime.split(':');
  const bookingHour = parseInt(timeParts[0], 10) || 0;
  const bookingMinute = parseInt(timeParts[1], 10) || 0;
  const bookingMinutesSinceMidnight = bookingHour * 60 + bookingMinute;
  
  return bookingMinutesSinceMidnight > currentMinutesSinceMidnight;
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  return hours * 60 + minutes;
}

function isTimeWithinTolerance(time1: string, time2: string, toleranceMinutes: number = 5): boolean {
  const mins1 = timeToMinutes(time1);
  const mins2 = timeToMinutes(time2);
  return Math.abs(mins1 - mins2) <= toleranceMinutes;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSVWithMultilineSupport(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      if (char === '\r') i++;
      currentRow.push(currentField.trim());
      if (currentRow.length > 0 && currentRow.some(f => f)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else if (char === '\r' && !inQuotes) {
      currentRow.push(currentField.trim());
      if (currentRow.length > 0 && currentRow.some(f => f)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }
  
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.length > 0 && currentRow.some(f => f)) {
      rows.push(currentRow);
    }
  }
  
  return rows;
}

function extractTime(dateTimeStr: string): string {
  if (!dateTimeStr) return '00:00';
  const parts = dateTimeStr.split(' ');
  if (parts.length >= 2) {
    return parts[1] + ':00';
  }
  return '00:00:00';
}

function extractDate(dateTimeStr: string): string {
  if (!dateTimeStr) return getTodayPacific();
  const parts = dateTimeStr.split(' ');
  return parts[0];
}

interface SessionCreationInput {
  bookingId: number;
  trackmanBookingId: string;
  resourceId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  ownerEmail: string;
  ownerName: string;
  parsedPlayers: ParsedPlayer[];
  membersByEmail: Map<string, string>;
  trackmanEmailMapping: Map<string, string>;
  isPast: boolean;
}

// Helper function to resolve an email to the primary member email
function resolveEmail(email: string, membersByEmail: Map<string, string>, trackmanEmailMapping: Map<string, string>): string {
  const emailLower = email.toLowerCase();
  // First check if it's a trackman_email alias
  const trackmanResolved = trackmanEmailMapping.get(emailLower);
  if (trackmanResolved) {
    return trackmanResolved.toLowerCase();
  }
  // Then check membersByEmail
  const memberResolved = membersByEmail.get(emailLower);
  if (memberResolved) {
    return memberResolved.toLowerCase();
  }
  return emailLower;
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows[0]?.id || null;
}

async function createTrackmanSessionAndParticipants(input: SessionCreationInput): Promise<void> {
  try {
    // Gather all participants with resolved user IDs
    const participantInputs: ParticipantInput[] = [];
    const memberData: { userId: string; tier: string }[] = [];
    
    // Resolve owner's user ID and tier
    const ownerUserId = await getUserIdByEmail(input.ownerEmail);
    const ownerTier = await getMemberTierByEmail(input.ownerEmail) || 'social';
    
    // Normalize owner email for duplicate detection (resolve any aliases including trackman_email)
    const ownerEmailNormalized = resolveEmail(input.ownerEmail, input.membersByEmail, input.trackmanEmailMapping);
    
    // Calculate per-participant duration (split equally among all participants)
    // Count unique members by resolving emails first to avoid counting owner twice
    const uniqueMemberCount = input.parsedPlayers.filter(p => {
      if (p.type !== 'member' || !p.email) return false;
      const resolvedEmail = resolveEmail(p.email, input.membersByEmail, input.trackmanEmailMapping);
      return resolvedEmail !== ownerEmailNormalized;
    }).length;
    const guestCount = input.parsedPlayers.filter(p => p.type === 'guest').length;
    const totalParticipants = 1 + uniqueMemberCount + guestCount;
    const perParticipantMinutes = totalParticipants > 0 
      ? Math.floor(input.durationMinutes / totalParticipants) 
      : input.durationMinutes;
    
    participantInputs.push({
      userId: ownerUserId || undefined,
      participantType: 'owner',
      displayName: input.ownerName || input.ownerEmail,
      slotDuration: perParticipantMinutes
    });
    
    if (ownerUserId) {
      memberData.push({ userId: ownerUserId, tier: ownerTier });
    }
    
    // Add members from parsed notes
    const memberPlayers = input.parsedPlayers.filter(p => p.type === 'member' && p.email);
    for (const member of memberPlayers) {
      if (member.email) {
        // Resolve member email to real email BEFORE comparing to owner (check trackman_email mappings too)
        const normalizedMemberEmail = resolveEmail(member.email, input.membersByEmail, input.trackmanEmailMapping);
        
        // Skip if this member is the same person as the owner (prevents duplicates)
        // Check by email first
        if (normalizedMemberEmail === ownerEmailNormalized) {
          continue;
        }
        
        // Also get member's user ID to compare - catches cases where emails differ but it's the same person
        const memberUserId = await getUserIdByEmail(normalizedMemberEmail);
        
        // Skip if same user_id as owner (catches alias mismatches like max.lee vs maxwell.lee)
        if (memberUserId && ownerUserId && memberUserId === ownerUserId) {
          continue;
        }
        
        const memberTier = await getMemberTierByEmail(normalizedMemberEmail) || 'social';
        
        participantInputs.push({
          userId: memberUserId || undefined,
          participantType: 'member',
          displayName: member.name || normalizedMemberEmail,
          slotDuration: perParticipantMinutes
        });
        
        if (memberUserId) {
          memberData.push({ userId: memberUserId, tier: memberTier });
        }
      }
    }
    
    // Add guests from parsed notes
    const guestPlayers = input.parsedPlayers.filter(p => p.type === 'guest');
    for (const guest of guestPlayers) {
      let guestId: number | undefined;
      if (guest.name) {
        const existingGuest = await db.select()
          .from(guestsTable)
          .where(sql`LOWER(name) = LOWER(${guest.name})`)
          .limit(1);
        
        if (existingGuest.length > 0) {
          guestId = existingGuest[0].id;
        } else {
          const [newGuest] = await db.insert(guestsTable).values({
            name: guest.name,
            email: guest.email,
            createdByMemberId: input.ownerEmail
          }).returning();
          guestId = newGuest?.id;
        }
      }
      
      participantInputs.push({
        guestId,
        participantType: 'guest',
        displayName: guest.name || 'Guest',
        slotDuration: perParticipantMinutes
      });
    }
    
    // Use sessionManager.createSession to create session and participants
    const { session, participants } = await createSession(
      {
        resourceId: input.resourceId,
        sessionDate: input.sessionDate,
        startTime: input.startTime,
        endTime: input.endTime,
        trackmanBookingId: input.trackmanBookingId,
        createdBy: 'trackman_import'
      },
      participantInputs,
      'trackman_import'
    );

    // Link the booking_request to the session
    await db.update(bookingRequests)
      .set({ sessionId: session.id })
      .where(eq(bookingRequests.id, input.bookingId));

    // Update payment_status for past bookings (sessionManager defaults to 'pending')
    if (input.isPast && participants.length > 0) {
      const participantIds = participants.map(p => p.id);
      await db.execute(sql`
        UPDATE booking_participants 
        SET payment_status = 'paid' 
        WHERE id = ANY(${participantIds})
      `);
    }

    // Create usage_ledger entries for members using recordUsage
    for (const md of memberData) {
      await recordUsage(
        session.id,
        {
          memberId: md.userId,
          minutesCharged: perParticipantMinutes,
          overageFee: 0,
          guestFee: 0,
          tierAtBooking: md.tier,
          paymentMethod: input.isPast ? 'credit_card' : 'unpaid'
        },
        'trackman_import'
      );
    }

    process.stderr.write(`[Trackman Import] Created session #${session.id} with ${participants.length} participants for Trackman ID ${input.trackmanBookingId}\n`);
  } catch (error: any) {
    process.stderr.write(`[Trackman Import] Error creating session for ${input.trackmanBookingId}: ${error.message}\n`);
  }
}

export async function importTrackmanBookings(csvPath: string, importedBy?: string): Promise<{
  totalRows: number;
  matchedRows: number;
  linkedRows: number;
  unmatchedRows: number;
  skippedRows: number;
  removedFromUnmatched: number;
  cancelledBookings: number;
  updatedRows: number;
  errors: string[];
}> {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const parsedRows = parseCSVWithMultilineSupport(content);
  
  if (parsedRows.length < 2) {
    return { totalRows: 0, matchedRows: 0, linkedRows: 0, unmatchedRows: 0, skippedRows: 0, removedFromUnmatched: 0, cancelledBookings: 0, updatedRows: 0, errors: ['Empty or invalid CSV'] };
  }

  // Fetch all members (active + former) from HubSpot for matching
  // This allows historical bookings to match former members who made them
  const hubSpotMembers = await getAllHubSpotMembers();
  
  const membersByName = new Map<string, string[]>(); // Now stores arrays to detect ambiguity
  const membersByEmail = new Map<string, string>();
  
  if (hubSpotMembers.length === 0) {
    // HubSpot is unavailable or returned no members - abort import
    process.stderr.write(`[Trackman Import] ERROR: Cannot fetch members from HubSpot. Import aborted.\n`);
    return { 
      totalRows: parsedRows.length - 1, 
      matchedRows: 0, 
      linkedRows: 0,
      unmatchedRows: 0, 
      skippedRows: 0, 
      removedFromUnmatched: 0,
      cancelledBookings: 0,
      updatedRows: 0,
      errors: ['HubSpot unavailable - cannot verify members. Please try again later or contact support.'] 
    };
  }
  
  // Use all HubSpot members (active + former) for matching
  // Build name-to-emails arrays to detect ambiguity (multiple members with same name)
  for (const member of hubSpotMembers) {
    if (member.email) {
      membersByEmail.set(member.email.toLowerCase(), member.email);
      const fullName = `${member.firstName || ''} ${member.lastName || ''}`.toLowerCase().trim();
      if (fullName) {
        const existing = membersByName.get(fullName) || [];
        existing.push(member.email);
        membersByName.set(fullName, existing);
      }
    }
  }
  
  // Log any ambiguous names (multiple members with same name)
  let ambiguousNameCount = 0;
  for (const [name, emails] of membersByName.entries()) {
    if (emails.length > 1) {
      ambiguousNameCount++;
      if (ambiguousNameCount <= 5) {
        process.stderr.write(`[Trackman Import] Ambiguous name "${name}" matches ${emails.length} members: ${emails.join(', ')}\n`);
      }
    }
  }
  if (ambiguousNameCount > 0) {
    process.stderr.write(`[Trackman Import] Total ambiguous names: ${ambiguousNameCount} (name matching will be skipped for these)\n`);
  }
  process.stderr.write(`[Trackman Import] Using ${membersByEmail.size} HubSpot members for matching (includes former members)\n`);

  const emailMapping = await loadEmailMapping();
  process.stderr.write(`[Trackman Import] Email mapping loaded with ${emailMapping.size} entries, membersByEmail has ${membersByEmail.size} entries\n`);

  // Task 6C: Build trackman_email -> member email mapping from database
  const trackmanEmailMapping = new Map<string, string>();
  try {
    const usersWithTrackmanEmail = await db.select({
      email: users.email,
      trackmanEmail: users.trackmanEmail
    })
    .from(users)
    .where(sql`trackman_email IS NOT NULL AND trackman_email != ''`);
    
    for (const user of usersWithTrackmanEmail) {
      if (user.email && user.trackmanEmail) {
        trackmanEmailMapping.set(user.trackmanEmail.toLowerCase().trim(), user.email.toLowerCase());
      }
    }
    process.stderr.write(`[Trackman Import] Loaded ${trackmanEmailMapping.size} trackman_email mappings from users table\n`);
  } catch (err: any) {
    process.stderr.write(`[Trackman Import] Error loading trackman_email mappings: ${err.message}\n`);
  }

  let matchedRows = 0;
  let unmatchedRows = 0;
  let skippedRows = 0;
  let linkedRows = 0;
  let removedFromUnmatched = 0;
  let cancelledBookings = 0;
  let updatedRows = 0;
  const errors: string[] = [];
  let mappingMatchCount = 0;
  let mappingFoundButNotInDb = 0;

  // Collect all valid (non-cancelled) booking IDs from the import file
  const importBookingIds = new Set<string>();
  for (let i = 1; i < parsedRows.length; i++) {
    const fields = parsedRows[i];
    if (fields.length >= 12) {
      const bookingId = fields[0];
      const status = fields[11];
      // Only track non-cancelled bookings
      if (bookingId && status.toLowerCase() !== 'cancelled') {
        importBookingIds.add(bookingId);
      }
    }
  }
  process.stderr.write(`[Trackman Import] Found ${importBookingIds.size} valid booking IDs in import file\n`);

  for (let i = 1; i < parsedRows.length; i++) {
    try {
      const fields = parsedRows[i];
      if (fields.length < 12) {
        skippedRows++;
        continue;
      }

      const row: TrackmanRow = {
        bookingId: fields[0],
        userName: fields[5],
        userEmail: fields[6],
        bookedDate: fields[7],
        startDate: fields[8],
        endDate: fields[9],
        durationMins: parseInt(fields[10]) || 60,
        status: fields[11],
        bayNumber: fields[20] || '',
        playerCount: parseInt(fields[14]) || 1,
        notes: fields[16] || ''
      };

      // Handle cancelled bookings - check if booking exists and cancel it
      if (row.status.toLowerCase() === 'cancelled' || row.status.toLowerCase() === 'canceled') {
        // Check if this booking exists in the system
        const existingBookingToCancel = await db.select({ 
          id: bookingRequests.id,
          status: bookingRequests.status
        })
          .from(bookingRequests)
          .where(sql`trackman_booking_id = ${row.bookingId} OR notes LIKE ${'%[Trackman Import ID:' + row.bookingId + ']%'}`)
          .limit(1);
        
        if (existingBookingToCancel.length > 0) {
          const booking = existingBookingToCancel[0];
          
          // Only cancel if not already cancelled
          if (booking.status !== 'cancelled') {
            // Update booking status to cancelled
            await db.update(bookingRequests)
              .set({ 
                status: 'cancelled',
                updatedAt: new Date()
              })
              .where(eq(bookingRequests.id, booking.id));
            
            // Delete associated booking_members records
            await db.delete(bookingMembers)
              .where(eq(bookingMembers.bookingId, booking.id));
            
            // Delete associated booking_guests records
            await db.delete(bookingGuests)
              .where(eq(bookingGuests.bookingId, booking.id));
            
            process.stderr.write(`[Trackman Import] Cancelled booking #${booking.id} (Trackman ID: ${row.bookingId}) - status was ${booking.status}\n`);
            cancelledBookings++;
          } else {
            // Already cancelled, just skip
            skippedRows++;
          }
        } else {
          // Booking doesn't exist, nothing to cancel - just skip
          skippedRows++;
        }
        continue;
      }

      let matchedEmail: string | null = null;
      let matchReason = '';

      const mappedEmail = emailMapping.get(row.userEmail.toLowerCase().trim());
      if (mappedEmail) {
        const existingMember = membersByEmail.get(mappedEmail.toLowerCase());
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched via email mapping';
          mappingMatchCount++;
          if (mappingMatchCount <= 3) {
            process.stderr.write(`[Trackman Import] Match: ${row.userEmail} -> ${mappedEmail} -> ${existingMember}\n`);
          }
        } else {
          mappingFoundButNotInDb++;
          if (mappingFoundButNotInDb <= 3) {
            process.stderr.write(`[Trackman Import] Mapped ${row.userEmail} -> ${mappedEmail} but NOT in membersByEmail\n`);
          }
        }
      }

      if (!matchedEmail && !isPlaceholderEmail(row.userEmail) && row.userEmail.includes('@')) {
        const existingMember = membersByEmail.get(row.userEmail.toLowerCase());
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched by email';
        }
      }

      // Task 6C: Match by trackman_email field
      if (!matchedEmail && row.userEmail.includes('@')) {
        const trackmanEmailMatch = trackmanEmailMapping.get(row.userEmail.toLowerCase().trim());
        if (trackmanEmailMatch) {
          const existingMember = membersByEmail.get(trackmanEmailMatch.toLowerCase());
          if (existingMember) {
            matchedEmail = existingMember;
            matchReason = 'Matched by trackman_email';
            process.stderr.write(`[Trackman Import] Trackman email match: ${row.userEmail} -> ${existingMember}\n`);
          }
        }
      }

      // Task 6B/6C: Parse notes for M:/G: format and match members from notes
      const parsedPlayers = parseNotesForPlayers(row.notes);
      const memberEmailsFromNotes: string[] = [];
      const requiresReview: { name: string; reason: string }[] = [];
      
      for (const player of parsedPlayers) {
        if (player.type === 'member' && player.email) {
          // Try to match member email from notes to actual member
          const noteEmail = player.email.toLowerCase().trim();
          
          // First check if it's a trackman_email format (firstname.lastname@evenhouse.club)
          const trackmanMatch = trackmanEmailMapping.get(noteEmail);
          if (trackmanMatch) {
            memberEmailsFromNotes.push(trackmanMatch);
          } else if (membersByEmail.has(noteEmail)) {
            // Direct email match
            memberEmailsFromNotes.push(noteEmail);
          } else {
            // Email in notes doesn't match any member - flag for review
            requiresReview.push({ 
              name: player.name || noteEmail, 
              reason: `Email ${noteEmail} not found in member database` 
            });
          }
        } else if (player.type === 'member' && !player.email && player.name) {
          // Task 6E: Member with name but no email - flag for fuzzy matching
          requiresReview.push({ 
            name: player.name, 
            reason: 'Partial name without email - requires manual matching' 
          });
        }
      }

      if (!matchedEmail && row.userName) {
        const normalizedName = row.userName.toLowerCase().trim();
        const byNameEmails = membersByName.get(normalizedName);
        if (byNameEmails && byNameEmails.length === 1) {
          // Only match if name is unique (single member with this name)
          matchedEmail = byNameEmails[0];
          matchReason = 'Matched by name';
        } else if (byNameEmails && byNameEmails.length > 1) {
          // Ambiguous - multiple members have this name, skip name matching
          process.stderr.write(`[Trackman Import] Skipping name match for "${row.userName}" - ${byNameEmails.length} members share this name\n`);
        } else {
          // Try partial name matching (first + last name)
          const nameParts = normalizedName.split(' ');
          if (nameParts.length >= 2) {
            const firstName = nameParts[0];
            const lastName = nameParts[nameParts.length - 1];
            
            let partialMatches: string[] = [];
            let matchedName = '';
            for (const [name, emails] of membersByName.entries()) {
              if (name.includes(firstName) && name.includes(lastName)) {
                partialMatches = partialMatches.concat(emails);
                matchedName = name;
              }
            }
            
            // Only use partial match if it's unique
            if (partialMatches.length === 1) {
              matchedEmail = partialMatches[0];
              matchReason = `Matched by partial name: ${matchedName}`;
            } else if (partialMatches.length > 1) {
              process.stderr.write(`[Trackman Import] Skipping partial name match for "${row.userName}" - ${partialMatches.length} potential matches\n`);
            }
          }
        }
      }

      const bookingDate = extractDate(row.startDate);
      const startTime = extractTime(row.startDate);
      const endTime = extractTime(row.endDate);
      const normalizedStatus = normalizeStatus(row.status, bookingDate, startTime);
      const isUpcoming = isFutureBooking(bookingDate, startTime);

      if (!normalizedStatus) {
        skippedRows++;
        errors.push(`Row ${i}: Unknown status "${row.status}"`);
        continue;
      }

      const existingUnmatched = await db.select({ id: trackmanUnmatchedBookings.id })
        .from(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.trackmanBookingId, row.bookingId))
        .limit(1);
      
      if (existingUnmatched.length > 0) {
        skippedRows++;
        continue;
      }

      const parsedBayId = parseInt(row.bayNumber) || null;

      const existingBooking = await db.select({ 
        id: bookingRequests.id,
        resourceId: bookingRequests.resourceId,
        startTime: bookingRequests.startTime,
        endTime: bookingRequests.endTime,
        durationMinutes: bookingRequests.durationMinutes,
        notes: bookingRequests.notes
      })
        .from(bookingRequests)
        .where(sql`trackman_booking_id = ${row.bookingId} OR notes LIKE ${'%[Trackman Import ID:' + row.bookingId + ']%'}`)
        .limit(1);
      
      if (existingBooking.length > 0) {
        // Booking already exists - update with latest data from CSV
        const existing = existingBooking[0];
        
        // Build update object with changed fields
        const updateFields: Record<string, any> = {};
        let changes: string[] = [];
        
        // Check if bay/resource changed
        if (parsedBayId && existing.resourceId !== parsedBayId) {
          updateFields.resourceId = parsedBayId;
          changes.push(`bay: ${existing.resourceId} -> ${parsedBayId}`);
        }
        
        // Check if start time changed
        if (existing.startTime !== startTime) {
          updateFields.startTime = startTime;
          changes.push(`start: ${existing.startTime} -> ${startTime}`);
        }
        
        // Check if end time changed
        if (existing.endTime !== endTime) {
          updateFields.endTime = endTime;
          changes.push(`end: ${existing.endTime} -> ${endTime}`);
        }
        
        // Check if duration changed
        if (existing.durationMinutes !== row.durationMins) {
          updateFields.durationMinutes = row.durationMins;
          changes.push(`duration: ${existing.durationMinutes} -> ${row.durationMins}`);
        }
        
        // Check if notes should be updated (ensure Trackman ID prefix is present)
        const trackmanIdPrefix = `[Trackman Import ID:${row.bookingId}]`;
        if (existing.notes && !existing.notes.includes(trackmanIdPrefix)) {
          updateFields.notes = `${trackmanIdPrefix} ${existing.notes}`;
          changes.push('notes: added Trackman ID prefix');
        } else if (!existing.notes && row.notes) {
          updateFields.notes = `${trackmanIdPrefix} ${row.notes}`;
          changes.push('notes: added from Trackman');
        }
        
        // If there are changes, update the booking
        if (Object.keys(updateFields).length > 0) {
          updateFields.updatedAt = new Date();
          await db.update(bookingRequests)
            .set(updateFields)
            .where(eq(bookingRequests.id, existing.id));
          
          process.stderr.write(`[Trackman Import] Updated booking #${existing.id} (Trackman ID: ${row.bookingId}): ${changes.join(', ')}\n`);
          updatedRows++;
        } else {
          // No changes needed, count as matched
          matchedRows++;
        }
        continue;
      }
      if (!parsedBayId && row.bayNumber) {
        process.stderr.write(`[Trackman Import] Warning: Invalid bay number "${row.bayNumber}" for booking ${row.bookingId} (${row.userName})\n`);
      } else if (!row.bayNumber) {
        process.stderr.write(`[Trackman Import] Warning: Missing bay number for booking ${row.bookingId} (${row.userName}) on ${bookingDate}\n`);
      }

      if (matchedEmail) {
        try {
          // Check for existing app booking that can be linked (same member/date/time/bay)
          // Step 1: Try exact time match first
          if (parsedBayId && bookingDate && startTime) {
            const existingAppBooking = await db.select({ 
              id: bookingRequests.id,
              trackmanBookingId: bookingRequests.trackmanBookingId,
              status: bookingRequests.status,
              sessionId: bookingRequests.sessionId
            })
              .from(bookingRequests)
              .where(sql`
                LOWER(user_email) = LOWER(${matchedEmail})
                AND request_date = ${bookingDate}
                AND start_time = ${startTime}
                AND resource_id = ${parsedBayId}
                AND status NOT IN ('cancelled', 'declined')
              `)
              .limit(1);

            if (existingAppBooking.length > 0) {
              const existing = existingAppBooking[0];
              if (!existing.trackmanBookingId) {
                // Link Trackman ID to existing app booking
                await db.update(bookingRequests)
                  .set({ trackmanBookingId: row.bookingId })
                  .where(eq(bookingRequests.id, existing.id));
                
                // Create player slots for this linked booking
                if (row.playerCount >= 1) {
                  // Check if booking_members already exist
                  const existingMembers = await db.select({ id: bookingMembers.id })
                    .from(bookingMembers)
                    .where(eq(bookingMembers.bookingId, existing.id));
                  
                  if (existingMembers.length === 0) {
                    // Create primary member slot
                    await db.insert(bookingMembers).values({
                      bookingId: existing.id,
                      userEmail: matchedEmail,
                      slotNumber: 1,
                      isPrimary: true,
                      trackmanBookingId: row.bookingId,
                      linkedAt: new Date(),
                      linkedBy: 'trackman_import'
                    });
                    
                    // Create additional empty slots for remaining players
                    for (let slot = 2; slot <= row.playerCount; slot++) {
                      await db.insert(bookingMembers).values({
                        bookingId: existing.id,
                        userEmail: null,
                        slotNumber: slot,
                        isPrimary: false,
                        trackmanBookingId: row.bookingId
                      });
                    }
                  }
                }
                
                // Create booking_session for linked booking
                const linkedParsedPlayers = parseNotesForPlayers(row.notes);
                await createTrackmanSessionAndParticipants({
                  bookingId: existing.id,
                  trackmanBookingId: row.bookingId,
                  resourceId: parsedBayId!,
                  sessionDate: bookingDate,
                  startTime: startTime,
                  endTime: endTime,
                  durationMinutes: row.durationMins,
                  ownerEmail: matchedEmail,
                  ownerName: row.userName,
                  parsedPlayers: linkedParsedPlayers,
                  membersByEmail: membersByEmail,
                  trackmanEmailMapping: trackmanEmailMapping,
                  isPast: !isUpcoming
                });
                
                process.stderr.write(`[Trackman Import] Auto-linked Trackman ID ${row.bookingId} to existing app booking #${existing.id} (${matchedEmail}) - exact time match\n`);
                linkedRows++;
                continue;
              } else if (existing.trackmanBookingId === row.bookingId) {
                // Already matched - but check if session exists, backfill if missing
                if (!existing.sessionId) {
                  const backfillParsedPlayers = parseNotesForPlayers(row.notes);
                  await createTrackmanSessionAndParticipants({
                    bookingId: existing.id,
                    trackmanBookingId: row.bookingId,
                    resourceId: parsedBayId!,
                    sessionDate: bookingDate,
                    startTime: startTime,
                    endTime: endTime,
                    durationMinutes: row.durationMins,
                    ownerEmail: matchedEmail,
                    ownerName: row.userName,
                    parsedPlayers: backfillParsedPlayers,
                    membersByEmail: membersByEmail,
                    trackmanEmailMapping: trackmanEmailMapping,
                    isPast: !isUpcoming
                  });
                  
                  // Also update player counts if missing
                  await db.update(bookingRequests)
                    .set({ 
                      trackmanPlayerCount: row.playerCount,
                      declaredPlayerCount: row.playerCount
                    })
                    .where(eq(bookingRequests.id, existing.id));
                  
                  process.stderr.write(`[Trackman Import] Backfilled session for matched booking #${existing.id} (Trackman ID: ${row.bookingId})\n`);
                }
                matchedRows++;
                continue;
              } else {
                process.stderr.write(`[Trackman Import] Conflict: Booking #${existing.id} already has Trackman ID ${existing.trackmanBookingId}, cannot link ${row.bookingId}\n`);
                skippedRows++;
                continue;
              }
            }
            
            // Step 2: No exact match - try time tolerance match (±5 minutes)
            const potentialMatches = await db.select({ 
              id: bookingRequests.id,
              trackmanBookingId: bookingRequests.trackmanBookingId,
              status: bookingRequests.status,
              startTime: bookingRequests.startTime
            })
              .from(bookingRequests)
              .where(sql`
                LOWER(user_email) = LOWER(${matchedEmail})
                AND request_date = ${bookingDate}
                AND resource_id = ${parsedBayId}
                AND status NOT IN ('cancelled', 'declined')
                AND trackman_booking_id IS NULL
              `);
            
            // Filter by time tolerance
            const matchesWithinTolerance = potentialMatches.filter(m => 
              m.startTime && isTimeWithinTolerance(startTime, m.startTime, 5)
            );
            
            if (matchesWithinTolerance.length === 1) {
              // Exactly one match within tolerance - auto-link
              const existing = matchesWithinTolerance[0];
              await db.update(bookingRequests)
                .set({ trackmanBookingId: row.bookingId })
                .where(eq(bookingRequests.id, existing.id));
              
              // Create player slots for this linked booking
              if (row.playerCount >= 1) {
                const existingMembers = await db.select({ id: bookingMembers.id })
                  .from(bookingMembers)
                  .where(eq(bookingMembers.bookingId, existing.id));
                
                if (existingMembers.length === 0) {
                  await db.insert(bookingMembers).values({
                    bookingId: existing.id,
                    userEmail: matchedEmail,
                    slotNumber: 1,
                    isPrimary: true,
                    trackmanBookingId: row.bookingId,
                    linkedAt: new Date(),
                    linkedBy: 'trackman_import'
                  });
                  
                  for (let slot = 2; slot <= row.playerCount; slot++) {
                    await db.insert(bookingMembers).values({
                      bookingId: existing.id,
                      userEmail: null,
                      slotNumber: slot,
                      isPrimary: false,
                      trackmanBookingId: row.bookingId
                    });
                  }
                }
              }
              
              // Create booking_session for linked booking (tolerance match)
              const toleranceParsedPlayers = parseNotesForPlayers(row.notes);
              await createTrackmanSessionAndParticipants({
                bookingId: existing.id,
                trackmanBookingId: row.bookingId,
                resourceId: parsedBayId!,
                sessionDate: bookingDate,
                startTime: startTime,
                endTime: endTime,
                durationMinutes: row.durationMins,
                ownerEmail: matchedEmail,
                ownerName: row.userName,
                parsedPlayers: toleranceParsedPlayers,
                membersByEmail: membersByEmail,
                trackmanEmailMapping: trackmanEmailMapping,
                isPast: !isUpcoming
              });
              
              process.stderr.write(`[Trackman Import] Auto-linked Trackman ID ${row.bookingId} to existing app booking #${existing.id} (${matchedEmail}) - time tolerance match (${existing.startTime} vs ${startTime})\n`);
              linkedRows++;
              continue;
            } else if (matchesWithinTolerance.length > 1) {
              // Multiple matches - log as potential match, don't auto-link
              process.stderr.write(`[Trackman Import] Potential match - requires staff confirmation: Trackman ID ${row.bookingId} has ${matchesWithinTolerance.length} possible matches for ${matchedEmail} on ${bookingDate} at ${startTime}\n`);
              // Continue to create new booking - staff can resolve via potential-matches endpoint
            }
          }

          const originalBookedDate = row.bookedDate ? new Date(row.bookedDate.replace(' ', 'T') + ':00') : null;
          
          // Parse notes BEFORE insert to count actual guests
          const parsedPlayers = parseNotesForPlayers(row.notes);
          const actualGuestCount = parsedPlayers.filter(p => p.type === 'guest').length;
          
          const insertResult = await db.insert(bookingRequests).values({
            userEmail: matchedEmail,
            userName: row.userName,
            resourceId: parsedBayId,
            requestDate: bookingDate,
            startTime: startTime,
            durationMinutes: row.durationMins,
            endTime: endTime,
            notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
            status: normalizedStatus,
            createdAt: originalBookedDate || new Date(),
            trackmanBookingId: row.bookingId,
            originalBookedDate: originalBookedDate,
            guestCount: actualGuestCount,
            trackmanPlayerCount: row.playerCount,
            declaredPlayerCount: row.playerCount,
          }).returning({ id: bookingRequests.id });

          // Create booking_members entries based on player count
          if (insertResult[0] && row.playerCount >= 1) {
            const bookingId = insertResult[0].id;
            
            // Slot 1 is always the primary booker (matched member)
            await db.insert(bookingMembers).values({
              bookingId: bookingId,
              userEmail: matchedEmail,
              slotNumber: 1,
              isPrimary: true,
              trackmanBookingId: row.bookingId,
              linkedAt: new Date(),
              linkedBy: 'trackman_import'
            });
            
            // Track which members from notes we've processed
            const memberEmails = parsedPlayers
              .filter(p => p.type === 'member' && p.email)
              .map(p => p.email!.toLowerCase());
            
            const guests = parsedPlayers.filter(p => p.type === 'guest');
            
            let memberSlot = 2;
            let guestSlot = 1;
            
            // Create slots for additional members from notes (skip if same as primary)
            // Resolve owner email using trackman mapping for comparison
            const ownerResolvedEmail = resolveEmail(matchedEmail, membersByEmail, trackmanEmailMapping);
            
            for (const memberEmail of memberEmails) {
              // Resolve member email to check if it's the same person as owner
              const memberResolvedEmail = resolveEmail(memberEmail, membersByEmail, trackmanEmailMapping);
              
              // Skip if this member is the same person as the owner
              if (memberResolvedEmail === ownerResolvedEmail) {
                continue;
              }
              
              if (memberSlot <= row.playerCount) {
                // Check if this email exists in our members database
                const memberExists = membersByEmail.get(memberEmail) || trackmanEmailMapping.get(memberEmail);
                await db.insert(bookingMembers).values({
                  bookingId: bookingId,
                  userEmail: memberExists || memberEmail, // Use real email if mapped, otherwise placeholder
                  slotNumber: memberSlot,
                  isPrimary: false,
                  trackmanBookingId: row.bookingId,
                  linkedAt: new Date(),
                  linkedBy: 'trackman_import'
                });
                
                // Send notification to linked member for future bookings
                if (memberExists && normalizedStatus === 'approved' && isUpcoming) {
                  const linkedMessage = `You've been added to a simulator booking on ${formatNotificationDateTime(bookingDate, startTime)}.`;
                  await db.insert(notifications).values({
                    userEmail: memberExists,
                    title: 'Added to Booking',
                    message: linkedMessage,
                    type: 'booking_approved',
                    relatedId: bookingId,
                    relatedType: 'booking_request'
                  });
                  sendPushNotification(memberExists, {
                    title: 'Added to Booking',
                    body: linkedMessage,
                    tag: `booking-linked-${bookingId}`
                  }).catch(() => {});
                }
                
                // Increment lifetime visits for linked members on attended bookings
                if (memberExists && normalizedStatus === 'attended') {
                  await db.execute(sql`
                    UPDATE users 
                    SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
                    WHERE email = ${memberExists}
                  `);
                }
                
                memberSlot++;
              }
            }
            
            // Create guest entries
            for (const guest of guests) {
              await db.insert(bookingGuests).values({
                bookingId: bookingId,
                guestName: guest.name,
                guestEmail: guest.email,
                slotNumber: guestSlot,
                trackmanBookingId: row.bookingId
              });
              guestSlot++;
            }
            
            // Create empty member slots for remaining player count (if any)
            // memberSlot starts at 2 and increments for each additional member found in notes
            // guests.length counts guests found in notes
            // We need empty slots from current memberSlot up to playerCount (excluding guest slots)
            const filledMemberSlots = memberSlot - 1; // Slots 1 through (memberSlot-1) are filled
            const guestCount = guests.length;
            const totalFilled = filledMemberSlots + guestCount;
            
            // Create empty slots for remaining players if playerCount > totalFilled
            if (row.playerCount > totalFilled) {
              for (let slot = memberSlot; slot <= row.playerCount - guestCount; slot++) {
                await db.insert(bookingMembers).values({
                  bookingId: bookingId,
                  userEmail: null, // Empty slot to be filled later
                  slotNumber: slot,
                  isPrimary: false,
                  trackmanBookingId: row.bookingId
                });
              }
            }
            
            // Create booking_session, booking_participants, and usage_ledger entries
            await createTrackmanSessionAndParticipants({
              bookingId: bookingId,
              trackmanBookingId: row.bookingId,
              resourceId: parsedBayId!,
              sessionDate: bookingDate,
              startTime: startTime,
              endTime: endTime,
              durationMinutes: row.durationMins,
              ownerEmail: matchedEmail,
              ownerName: row.userName,
              parsedPlayers: parsedPlayers,
              membersByEmail: membersByEmail,
              trackmanEmailMapping: trackmanEmailMapping,
              isPast: !isUpcoming
            });
          }

          if (normalizedStatus === 'attended') {
            await db.execute(sql`
              UPDATE users 
              SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
              WHERE email = ${matchedEmail}
            `);
          }

          // Send notification for upcoming approved bookings
          if (normalizedStatus === 'approved' && isUpcoming && insertResult[0]) {
            const approvalMessage = `Your simulator booking for ${formatNotificationDateTime(bookingDate, startTime)} has been approved.`;
            
            await db.insert(notifications).values({
              userEmail: matchedEmail,
              title: 'Booking Confirmed',
              message: approvalMessage,
              type: 'booking_approved',
              relatedId: insertResult[0].id,
              relatedType: 'booking_request'
            });
            
            // Send push notification (non-blocking)
            sendPushNotification(matchedEmail, {
              title: 'Booking Confirmed!',
              body: approvalMessage,
              tag: `booking-${insertResult[0].id}`
            }).catch(err => {
              process.stderr.write(`[Trackman Import] Push notification failed for ${matchedEmail}: ${err.message}\n`);
            });
          }

          matchedRows++;
        } catch (insertErr: any) {
          const errDetails = insertErr.cause?.message || insertErr.detail || insertErr.code || 'no details';
          process.stderr.write(`[Trackman Import] Insert error for ${row.bookingId}: ${insertErr.message} | Details: ${errDetails}\n`);
          throw insertErr;
        }
      } else {
        // Determine match attempt reason with fuzzy match indicator (Task 6E)
        let matchAttemptReason = isPlaceholderEmail(row.userEmail) 
          ? 'Placeholder email, name not found in members' 
          : 'Email not found in members database';
        
        // Check if this needs fuzzy matching (partial name without clear match)
        const normalizedName = row.userName?.toLowerCase().trim() || '';
        if (normalizedName && normalizedName.includes(' ')) {
          // Has first and last name - good candidate for fuzzy matching
          matchAttemptReason = `REQUIRES_REVIEW: ${matchAttemptReason} - name "${row.userName}" may match existing member`;
        }
        
        // Add info about additional players that need review
        if (requiresReview.length > 0) {
          const reviewItems = requiresReview.map(r => `${r.name}: ${r.reason}`).join('; ');
          matchAttemptReason += ` | Additional players need review: ${reviewItems}`;
        }
        
        await db.insert(trackmanUnmatchedBookings).values({
          trackmanBookingId: row.bookingId,
          userName: row.userName,
          originalEmail: row.userEmail,
          bookingDate: bookingDate,
          startTime: startTime,
          endTime: endTime,
          durationMinutes: row.durationMins,
          status: normalizedStatus,
          bayNumber: row.bayNumber,
          playerCount: row.playerCount,
          notes: row.notes,
          matchAttemptReason: matchAttemptReason
        });

        unmatchedRows++;
      }
    } catch (err: any) {
      errors.push(`Row ${i}: ${err.message}`);
      skippedRows++;
    }
  }

  process.stderr.write(`[Trackman Import] Summary: mappingMatchCount=${mappingMatchCount}, mappingFoundButNotInDb=${mappingFoundButNotInDb}, matchedRows=${matchedRows}, linkedRows=${linkedRows}, unmatchedRows=${unmatchedRows}, skipped=${skippedRows}\n`);

  // Clean up bookings that are no longer in the import file
  // This handles cases where members cancel bookings in Trackman
  
  // 1. Remove unmatched bookings not in current import file
  const unmatchedToRemove = await db.select({ 
    id: trackmanUnmatchedBookings.id, 
    trackmanBookingId: trackmanUnmatchedBookings.trackmanBookingId,
    userName: trackmanUnmatchedBookings.userName 
  })
    .from(trackmanUnmatchedBookings)
    .where(sql`trackman_booking_id IS NOT NULL`);
  
  for (const booking of unmatchedToRemove) {
    if (booking.trackmanBookingId && !importBookingIds.has(booking.trackmanBookingId)) {
      await db.delete(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.id, booking.id));
      removedFromUnmatched++;
      process.stderr.write(`[Trackman Import] Removed unmatched booking ${booking.trackmanBookingId} (${booking.userName}) - no longer in Trackman\n`);
    }
  }

  // 2. Cancel matched bookings (booking_requests) that are no longer in the import file
  // Only cancel future bookings to avoid messing with historical data
  const todayStr = getTodayPacific();
  const matchedToCancel = await db.select({ 
    id: bookingRequests.id, 
    trackmanBookingId: bookingRequests.trackmanBookingId,
    userName: bookingRequests.userName,
    userEmail: bookingRequests.userEmail,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    status: bookingRequests.status
  })
    .from(bookingRequests)
    .where(sql`trackman_booking_id IS NOT NULL AND status NOT IN ('cancelled', 'attended', 'no_show')`);
  
  for (const booking of matchedToCancel) {
    if (booking.trackmanBookingId && !importBookingIds.has(booking.trackmanBookingId)) {
      // Only cancel if the booking is in the future (including time check for same-day bookings)
      const bookingDateStr = typeof booking.requestDate === 'object' && booking.requestDate !== null
        ? (booking.requestDate as Date).toISOString().split('T')[0]
        : String(booking.requestDate);
      
      // Use isFutureBooking for accurate future check (includes time for same-day bookings)
      const isStillFuture = isFutureBooking(bookingDateStr, booking.startTime || '00:00');
      
      if (isStillFuture) {
        await db.update(bookingRequests)
          .set({ 
            status: 'cancelled',
            notes: sql`COALESCE(notes, '') || ' [Auto-cancelled: Removed from Trackman]'`
          })
          .where(eq(bookingRequests.id, booking.id));
        cancelledBookings++;
        process.stderr.write(`[Trackman Import] Cancelled booking ${booking.trackmanBookingId} (${booking.userName}) for ${bookingDateStr} - no longer in Trackman\n`);
        
        // Send notification to member about cancellation
        if (booking.userEmail) {
          const cancelMessage = `Your simulator booking for ${formatNotificationDateTime(bookingDateStr, booking.startTime || '')} has been cancelled as it was removed from the booking system.`;
          
          await db.insert(notifications).values({
            userEmail: booking.userEmail,
            title: 'Booking Cancelled',
            message: cancelMessage,
            type: 'booking_cancelled',
            relatedId: booking.id,
            relatedType: 'booking_request'
          });
          
          // Send push notification (non-blocking)
          sendPushNotification(booking.userEmail, {
            title: 'Booking Cancelled',
            body: cancelMessage,
            tag: `booking-cancelled-${booking.id}`
          }).catch(err => {
            process.stderr.write(`[Trackman Import] Push notification failed for cancellation ${booking.userEmail}: ${err.message}\n`);
          });
        }
      }
    }
  }

  if (removedFromUnmatched > 0 || cancelledBookings > 0 || updatedRows > 0) {
    process.stderr.write(`[Trackman Import] Cleanup: removed ${removedFromUnmatched} unmatched, cancelled ${cancelledBookings} matched bookings, updated ${updatedRows} existing bookings\n`);
  }

  await db.insert(trackmanImportRuns).values({
    filename: path.basename(csvPath),
    totalRows: parsedRows.length - 1,
    matchedRows,
    unmatchedRows,
    skippedRows,
    importedBy
  });

  return {
    totalRows: parsedRows.length - 1,
    matchedRows,
    linkedRows,
    unmatchedRows,
    skippedRows,
    removedFromUnmatched,
    cancelledBookings,
    updatedRows,
    errors
  };
}

export async function getUnmatchedBookings(options?: { 
  resolved?: boolean; 
  limit?: number; 
  offset?: number;
  search?: string;
}): Promise<{ data: any[]; totalCount: number }> {
  let whereCondition = sql`1=1`;
  
  if (options?.resolved === false) {
    whereCondition = sql`resolved_email IS NULL`;
  } else if (options?.resolved === true) {
    whereCondition = sql`resolved_email IS NOT NULL`;
  }

  // Add search filter if provided
  if (options?.search && options.search.trim()) {
    const searchTerm = `%${options.search.trim().toLowerCase()}%`;
    whereCondition = sql`${whereCondition} AND (LOWER(user_name) LIKE ${searchTerm} OR LOWER(original_email) LIKE ${searchTerm})`;
  }

  const [data, countResult] = await Promise.all([
    db.select()
      .from(trackmanUnmatchedBookings)
      .where(whereCondition)
      .orderBy(sql`booking_date DESC`)
      .limit(options?.limit || 100)
      .offset(options?.offset || 0),
    db.select({ count: sql<number>`count(*)::int` })
      .from(trackmanUnmatchedBookings)
      .where(whereCondition)
  ]);

  return {
    data,
    totalCount: countResult[0]?.count || 0
  };
}

async function insertBookingIfNotExists(
  booking: typeof trackmanUnmatchedBookings.$inferSelect,
  memberEmail: string,
  resolvedBy?: string
): Promise<{ inserted: boolean; linked?: boolean; reason?: string; finalStatus?: string; bookingId?: number }> {
  const trackmanIdPattern = `[Trackman Import ID:${booking.trackmanBookingId}]`;
  
  // Check 1: Already imported this Trackman booking (check both new column and notes for backwards compatibility)
  const existingTrackman = await db.select({ id: bookingRequests.id })
    .from(bookingRequests)
    .where(sql`trackman_booking_id = ${booking.trackmanBookingId} OR notes LIKE ${`%${trackmanIdPattern}%`}`)
    .limit(1);

  if (existingTrackman.length > 0) {
    return { inserted: false, reason: 'Already imported (Trackman ID exists)' };
  }

  // Check 2: Existing booking with same member, date, time that already has final status
  const resourceId = parseInt(booking.bayNumber || '') || null;
  if (booking.bookingDate && booking.startTime) {
    const existingWithFinalStatus = await db.select({ 
      id: bookingRequests.id, 
      status: bookingRequests.status,
      trackmanBookingId: bookingRequests.trackmanBookingId 
    })
      .from(bookingRequests)
      .where(sql`
        LOWER(user_email) = LOWER(${memberEmail})
        AND request_date = ${booking.bookingDate}
        AND start_time = ${booking.startTime}
        AND status IN ('attended', 'no_show')
      `)
      .limit(1);

    if (existingWithFinalStatus.length > 0) {
      const existing = existingWithFinalStatus[0];
      if (!existing.trackmanBookingId && booking.trackmanBookingId) {
        await db.update(bookingRequests)
          .set({ trackmanBookingId: booking.trackmanBookingId })
          .where(eq(bookingRequests.id, existing.id));
        process.stderr.write(`[Trackman Import] Linked Trackman ID ${booking.trackmanBookingId} to existing booking #${existing.id} (status: ${existing.status})\n`);
        return { inserted: false, linked: true, reason: `Linked Trackman ID to existing booking with status: ${existing.status}` };
      } else if (existing.trackmanBookingId === booking.trackmanBookingId) {
        return { inserted: false, reason: `Already linked (idempotent match)` };
      }
      return { inserted: false, reason: `Booking already exists with status: ${existing.status}` };
    }
  }

  // Check 3: Duplicate booking - same member, date, time, and bay (non-final status)
  // Instead of skipping, link the Trackman ID to the existing app booking
  if (resourceId && booking.bookingDate && booking.startTime) {
    const existingDuplicate = await db.select({ 
      id: bookingRequests.id,
      trackmanBookingId: bookingRequests.trackmanBookingId 
    })
      .from(bookingRequests)
      .where(sql`
        LOWER(user_email) = LOWER(${memberEmail})
        AND request_date = ${booking.bookingDate}
        AND start_time = ${booking.startTime}
        AND resource_id = ${resourceId}
        AND status NOT IN ('cancelled', 'declined')
      `)
      .limit(1);

    if (existingDuplicate.length > 0) {
      const existing = existingDuplicate[0];
      if (!existing.trackmanBookingId && booking.trackmanBookingId) {
        await db.update(bookingRequests)
          .set({ trackmanBookingId: booking.trackmanBookingId })
          .where(eq(bookingRequests.id, existing.id));
        process.stderr.write(`[Trackman Import] Linked Trackman ID ${booking.trackmanBookingId} to existing app booking #${existing.id}\n`);
        return { inserted: false, linked: true, reason: 'Linked Trackman ID to existing app booking' };
      } else if (existing.trackmanBookingId === booking.trackmanBookingId) {
        return { inserted: false, reason: 'Already linked (idempotent match)' };
      }
      return { inserted: false, reason: 'Duplicate booking exists (same member/date/time/bay)' };
    }
  }

  // CRITICAL: Recalculate status based on CURRENT date/time, not import time
  // Future bookings should be 'approved' so staff can check them in
  // Past bookings should be 'attended' (historical data) unless they have a final status like 'no_show'
  const isUpcoming = isFutureBooking(booking.bookingDate || '', booking.startTime || '');
  const originalStatus = booking.status || 'attended';
  let finalStatus: string;
  
  if (isUpcoming) {
    // Future booking: always set to 'approved' so it appears in upcoming bookings for check-in
    finalStatus = 'approved';
    if (originalStatus !== 'approved') {
      process.stderr.write(`[Trackman Import] Status recalculated: ${originalStatus} -> approved (future booking on ${booking.bookingDate})\n`);
    }
  } else {
    // Past booking: 'approved' should be converted to 'attended' (they attended in the past)
    // Other final statuses like 'no_show' should be preserved
    if (originalStatus === 'approved') {
      finalStatus = 'attended';
      process.stderr.write(`[Trackman Import] Status recalculated: approved -> attended (past booking on ${booking.bookingDate})\n`);
    } else {
      // Preserve other statuses: attended, no_show, etc.
      finalStatus = originalStatus;
    }
  }

  // Parse notes BEFORE insert to count actual guests
  const parsedPlayers = parseNotesForPlayers(booking.notes || '');
  const actualGuestCount = parsedPlayers.filter(p => p.type === 'guest').length;

  const insertResult = await db.insert(bookingRequests).values({
    userEmail: memberEmail,
    userName: booking.userName,
    resourceId: resourceId,
    requestDate: booking.bookingDate,
    startTime: booking.startTime,
    durationMinutes: booking.durationMinutes || 60,
    endTime: booking.endTime,
    notes: `[Trackman Import ID:${booking.trackmanBookingId}] ${booking.notes || ''}`,
    status: finalStatus,
    createdAt: booking.createdAt,
    trackmanBookingId: booking.trackmanBookingId,
    originalBookedDate: booking.createdAt,
    guestCount: actualGuestCount,
  }).returning({ id: bookingRequests.id });

  const bookingId = insertResult[0]?.id;

  // Create booking_members entries based on player count
  if (bookingId && (booking.playerCount || 1) >= 1) {
    
    // Slot 1 is always the primary booker
    await db.insert(bookingMembers).values({
      bookingId: bookingId,
      userEmail: memberEmail,
      slotNumber: 1,
      isPrimary: true,
      trackmanBookingId: booking.trackmanBookingId,
      linkedAt: new Date(),
      linkedBy: resolvedBy || 'trackman_resolve'
    });
    
    // Create empty slots for remaining players (to be filled later)
    const playerCount = booking.playerCount || 1;
    for (let slot = 2; slot <= playerCount; slot++) {
      await db.insert(bookingMembers).values({
        bookingId: bookingId,
        userEmail: null, // Empty slot to be filled later
        slotNumber: slot,
        isPrimary: false,
        trackmanBookingId: booking.trackmanBookingId
      });
    }
    
    // Create guest entries if notes have G: format
    const guests = parsedPlayers.filter(p => p.type === 'guest');
    for (let i = 0; i < guests.length; i++) {
      await db.insert(bookingGuests).values({
        bookingId: bookingId,
        guestName: guests[i].name,
        guestEmail: guests[i].email,
        slotNumber: i + 1,
        trackmanBookingId: booking.trackmanBookingId
      });
    }
  }

  if (finalStatus === 'approved') {
    const formattedDate = new Date(booking.bookingDate + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
    });
    const formatTime = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour12 = h % 12 || 12;
      return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
    };
    
    bookingEvents.publish('booking_approved', {
      bookingId: 0,
      memberEmail: memberEmail,
      memberName: booking.userName || undefined,
      resourceId: resourceId || undefined,
      bookingDate: booking.bookingDate || '',
      startTime: booking.startTime || '',
      endTime: booking.endTime || undefined,
      status: 'approved',
      isTrackmanImport: true
    }, {
      notifyMember: true,
      notifyStaff: true,
      memberNotification: {
        title: 'Booking Confirmed',
        message: `Your golf simulator booking for ${formattedDate} at ${formatTime(booking.startTime || '')} has been confirmed via Trackman.`,
        type: 'booking_approved'
      }
    }).catch(err => process.stderr.write(`[Trackman] Booking event publish failed: ${err}\n`));
  }

  return { inserted: true, finalStatus, bookingId };
}

export async function resolveUnmatchedBooking(
  unmatchedId: number, 
  memberEmail: string, 
  resolvedBy: string
): Promise<{ success: boolean; resolved: number; autoResolved: number }> {
  const unmatched = await db.select()
    .from(trackmanUnmatchedBookings)
    .where(eq(trackmanUnmatchedBookings.id, unmatchedId));

  if (unmatched.length === 0) return { success: false, resolved: 0, autoResolved: 0 };

  const booking = unmatched[0];
  const originalEmail = booking.originalEmail?.toLowerCase().trim();

  const insertResult = await insertBookingIfNotExists(booking, memberEmail, resolvedBy);

  // Only increment lifetime_visits if the FINAL status is 'attended' (past booking)
  // NOT for future bookings which get 'approved' status
  // Also increment for linked bookings that are past (they were attended)
  if (insertResult.inserted && insertResult.finalStatus === 'attended') {
    await db.execute(sql`
      UPDATE users 
      SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
      WHERE email = ${memberEmail}
    `);
  }
  
  // Log linking outcome
  if (insertResult.linked) {
    process.stderr.write(`[Trackman Resolve] Linked existing booking for ${memberEmail}: ${insertResult.reason}\n`);
  }

  // Save the placeholder email mapping to the member's manually_linked_emails for future imports
  if (originalEmail && isPlaceholderEmail(originalEmail)) {
    const emailAsJsonb = JSON.stringify(originalEmail);
    await db.execute(sql`
      UPDATE users 
      SET manually_linked_emails = 
        CASE 
          WHEN COALESCE(manually_linked_emails, '[]'::jsonb) ? ${originalEmail}
          THEN manually_linked_emails
          ELSE COALESCE(manually_linked_emails, '[]'::jsonb) || ${emailAsJsonb}::jsonb
        END
      WHERE email = ${memberEmail}
    `);
    process.stderr.write(`[Trackman Resolve] Saved email mapping: ${originalEmail} -> ${memberEmail}\n`);
  }

  await db.update(trackmanUnmatchedBookings)
    .set({
      resolvedEmail: memberEmail,
      resolvedAt: new Date(),
      resolvedBy: resolvedBy
    })
    .where(eq(trackmanUnmatchedBookings.id, unmatchedId));

  if (insertResult.inserted && insertResult.finalStatus === 'approved') {
    bookingEvents.publish('booking_approved', {
      bookingId: 0,
      memberEmail: memberEmail,
      memberName: booking.userName || undefined,
      resourceId: parseInt(booking.bayNumber || '') || undefined,
      bookingDate: booking.bookingDate || '',
      startTime: booking.startTime || '',
      status: 'approved',
      isTrackmanImport: true
    }, {
      notifyMember: true,
      notifyStaff: true,
      memberNotification: {
        title: 'Booking Confirmed',
        message: `Your golf simulator booking has been confirmed.`,
        type: 'booking_approved'
      }
    }).catch(err => process.stderr.write(`[Trackman Resolve] Booking event publish failed: ${err}\n`));
  }

  // Auto-resolve other unmatched bookings with the same original email
  let autoResolved = 0;
  if (originalEmail) {
    const otherUnmatched = await db.select()
      .from(trackmanUnmatchedBookings)
      .where(sql`LOWER(TRIM(original_email)) = ${originalEmail} AND resolved_email IS NULL AND id != ${unmatchedId}`);

    for (const other of otherUnmatched) {
      const otherResult = await insertBookingIfNotExists(other, memberEmail, resolvedBy);

      // Only increment lifetime_visits if the FINAL status is 'attended' (past booking)
      if (otherResult.inserted && otherResult.finalStatus === 'attended') {
        await db.execute(sql`
          UPDATE users 
          SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
          WHERE email = ${memberEmail}
        `);
      }

      // Send notification for auto-resolved future bookings
      if (otherResult.inserted && otherResult.finalStatus === 'approved') {
        bookingEvents.publish('booking_approved', {
          bookingId: 0,
          memberEmail: memberEmail,
          memberName: other.userName || undefined,
          resourceId: parseInt(other.bayNumber || '') || undefined,
          bookingDate: other.bookingDate || '',
          startTime: other.startTime || '',
          status: 'approved',
          isTrackmanImport: true
        }, {
          notifyMember: true,
          notifyStaff: false,
          memberNotification: {
            title: 'Booking Confirmed',
            message: `Your golf simulator booking has been confirmed.`,
            type: 'booking_approved'
          }
        }).catch(err => process.stderr.write(`[Trackman Resolve] Auto-resolved booking notification failed: ${err}\n`));
      }

      await db.update(trackmanUnmatchedBookings)
        .set({
          resolvedEmail: memberEmail,
          resolvedAt: new Date(),
          resolvedBy: resolvedBy
        })
        .where(eq(trackmanUnmatchedBookings.id, other.id));

      autoResolved++;
    }

    if (autoResolved > 0) {
      process.stderr.write(`[Trackman Resolve] Auto-resolved ${autoResolved} additional bookings with same email: ${originalEmail}\n`);
    }
  }

  return { success: true, resolved: 1 + autoResolved, autoResolved };
}

export async function getImportRuns() {
  return await db.select()
    .from(trackmanImportRuns)
    .orderBy(sql`created_at DESC`);
}

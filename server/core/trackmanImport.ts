import { db } from '../db';
import { getErrorMessage, getErrorCode } from '../utils/errorUtils';
import { pool } from './db';
import { users, bookingRequests, trackmanUnmatchedBookings, trackmanImportRuns, notifications, bookingMembers, bookingGuests, bookingSessions, bookingParticipants, usageLedger, guests as guestsTable, availabilityBlocks, facilityClosures } from '../../shared/schema';
import { eq, or, ilike, sql, and } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { getTodayPacific, getPacificDateParts, formatNotificationDateTime } from '../utils/dateUtils';
import { sendPushNotification } from '../routes/push';
import { getHubSpotClient } from './integrations';
import { bookingEvents } from './bookingEvents';
import { getMemberTierByEmail } from './tierService';
import { createSession, recordUsage, ParticipantInput } from './bookingService/sessionManager';
import { calculateFullSessionBilling, FLAT_GUEST_FEE, Participant } from './bookingService/usageCalculator';
import { useGuestPass } from '../routes/guestPasses';
import { cancelPaymentIntent } from './stripe';
import { alertOnTrackmanImportIssues } from './dataAlerts';
import { staffUsers } from '../../shared/schema';

import { logger } from './logger';
/**
 * Fetches email addresses of all active staff members with the 'golf_instructor' role.
 * Used to identify lesson bookings during Trackman import and cleanup.
 */
export async function getGolfInstructorEmails(): Promise<string[]> {
  try {
    const instructors = await db.select({ email: staffUsers.email })
      .from(staffUsers)
      .where(and(
        eq(staffUsers.role, 'golf_instructor'),
        eq(staffUsers.isActive, true)
      ));
    
    return instructors
      .map(i => i.email?.toLowerCase())
      .filter((email): email is string => !!email);
  } catch (err: unknown) {
    logger.error('[Trackman] Error fetching golf instructor emails:', { error: err });
    // Fallback to empty array - caller should handle gracefully
    return [];
  }
}

async function cancelPendingPaymentIntentsForBooking(bookingId: number): Promise<void> {
  try {
    const pendingIntents = await db.execute(
      sql`SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`
    );
    for (const row of pendingIntents.rows) {
      try {
        await cancelPaymentIntent(row.stripe_payment_intent_id as string);
        process.stderr.write(`[Trackman Import] Cancelled payment intent ${row.stripe_payment_intent_id}\n`);
      } catch (cancelErr: unknown) {
        process.stderr.write(`[Trackman Import] Failed to cancel payment intent ${row.stripe_payment_intent_id}: ${getErrorMessage(cancelErr)}\n`);
      }
    }
  } catch (e: unknown) {
    // Non-blocking
  }
}

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
    
    // NEW FORMAT: Pipe-separated CSV-style format
    // M|email|firstname|lastname or G|email|firstname|lastname
    const pipeSeparatedMatch = trimmed.match(/^([MG])\|([^|]*)\|([^|]*)\|(.*)$/i);
    if (pipeSeparatedMatch) {
      const type = pipeSeparatedMatch[1].toUpperCase() === 'M' ? 'member' : 'guest';
      const email = pipeSeparatedMatch[2].trim().toLowerCase();
      const firstName = pipeSeparatedMatch[3].trim();
      const lastName = pipeSeparatedMatch[4].trim();
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;
      
      players.push({
        type,
        email: email && email !== 'none' ? email : null,
        name: fullName
      });
      continue;
    }
    
    // LEGACY FORMAT: M: email | Name or M: email
    const memberMatch = trimmed.match(/^M:\s*([^\s|]+)(?:\s*\|\s*(.+))?$/i);
    if (memberMatch) {
      let memberName = memberMatch[2]?.trim() || null;
      
      if (memberName) {
        const guestTagIndex = memberName.search(/\bG:\s*/i);
        if (guestTagIndex !== -1) {
          const beforeGuests = memberName.substring(0, guestTagIndex).trim();
          const guestPortion = memberName.substring(guestTagIndex);
          
          memberName = beforeGuests.replace(/\s+(Guests?\s+pay\s+separately|NO\s+additional|Used\s+\$).*$/i, '').trim() || null;
          
          const inlineGuestMatches = guestPortion.matchAll(/G:\s*([A-Za-z][A-Za-z'-]*(?:\s+(?!G:|M:|NO\b|Used\b|additional\b)[A-Za-z][A-Za-z'-]*)?)/gi);
          for (const gm of inlineGuestMatches) {
            const guestName = gm[1].trim();
            if (guestName && guestName.length >= 2) {
              players.push({
                type: 'guest',
                email: null,
                name: guestName
              });
            }
          }
        } else {
          memberName = memberName.replace(/\s+(Guests?\s+pay\s+separately|NO\s+additional|Used\s+\$).*$/i, '').trim() || null;
        }
      }
      
      players.push({
        type: 'member',
        email: memberMatch[1].trim().toLowerCase(),
        name: memberName
      });
      continue;
    }
    
    // LEGACY FORMAT: G: email | Name or G: none | Name or G: Name (at start of line)
    const guestMatch = trimmed.match(/^G:\s*(?:([^\s|]+)\s*\|\s*)?(.+)$/i);
    if (guestMatch) {
      const emailOrName = guestMatch[1]?.trim().toLowerCase();
      const name = guestMatch[2]?.trim();
      
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
        players.push({
          type: 'guest',
          email: null,
          name: emailOrName + (name ? ' ' + name : '')
        });
      }
      continue;
    }
    
    // INLINE G: tags on lines that don't start with M: or G:
    // (e.g., "Guests pay separately G: Chris G: Alex G: Dalton")
    const inlineGuestMatches = trimmed.matchAll(/G:\s*([A-Za-z][A-Za-z'-]*(?:\s+(?!G:|M:|NO\b|Used\b|additional\b)[A-Za-z][A-Za-z'-]*)?)/gi);
    for (const gm of inlineGuestMatches) {
      const guestName = gm[1].trim();
      if (guestName && guestName.length >= 2) {
        players.push({
          type: 'guest',
          email: null,
          name: guestName
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
  'bookings@evenhouse.club',
  'tccmembership@evenhouse.club'
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
  // Also treat trackman.local and unmatched- prefixes as placeholders
  if (normalizedEmail.endsWith('@trackman.local') || normalizedEmail.startsWith('unmatched-')) return true;
  return false;
}

/**
 * Check if a booking has already been converted to a private event block.
 * This prevents creating duplicate unmatched bookings when re-importing CSV data
 * after a booking was marked as a private event.
 */
async function isConvertedToPrivateEventBlock(
  resourceId: number | null,
  bookingDate: string,
  startTime: string,
  endTime: string | null
): Promise<boolean> {
  if (!resourceId || !bookingDate || !startTime) return false;
  
  try {
    // Build effective end time - use provided endTime or default to 1 hour after start
    const effectiveEndTime = endTime 
      ? sql`${endTime}::time`
      : sql`${startTime}::time + interval '1 hour'`;
    
    // Look for availability blocks on this resource/date/time that are linked to private_event closures
    const matchingBlocks = await db.select({
      blockId: availabilityBlocks.id,
      closureId: availabilityBlocks.closureId
    })
      .from(availabilityBlocks)
      .innerJoin(facilityClosures, eq(availabilityBlocks.closureId, facilityClosures.id))
      .where(and(
        eq(availabilityBlocks.resourceId, resourceId),
        eq(availabilityBlocks.blockDate, bookingDate),
        eq(facilityClosures.noticeType, 'private_event'),
        eq(facilityClosures.isActive, true),
        // Time overlap check: block starts before booking ends AND block ends after booking starts
        sql`${availabilityBlocks.startTime} < ${effectiveEndTime}`,
        sql`${availabilityBlocks.endTime} > ${startTime}::time`
      ))
      .limit(1);
    
    return matchingBlocks.length > 0;
  } catch (err: unknown) {
    // Non-blocking - if check fails, allow booking creation
    process.stderr.write(`[Trackman Import] Error checking for private event block: ${getErrorMessage(err)}\n`);
    return false;
  }
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
    } catch (err: unknown) {
      process.stderr.write('[Trackman Import] Error loading CSV mapping: ' + getErrorMessage(err) + '\n');
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
      process.stderr.write(`[Trackman Import] Loaded ${dbMappingsCount} email mappings from users.manuallyLinkedEmails\n`);
    }
  } catch (err: unknown) {
    process.stderr.write('[Trackman Import] Error loading DB mappings: ' + getErrorMessage(err) + '\n');
  }
  
  // Load from user_linked_emails table (staff resolutions and auto-learning)
  try {
    const linkedEmailsResult = await db.execute(
      sql`SELECT primary_email, linked_email FROM user_linked_emails`
    );
    
    let linkedCount = 0;
    for (const row of linkedEmailsResult.rows) {
      if (row.primary_email && row.linked_email) {
        const normalizedLinked = (row.linked_email as string).toLowerCase().trim();
        const normalizedPrimary = (row.primary_email as string).toLowerCase().trim();
        if (!mapping.has(normalizedLinked)) {
          mapping.set(normalizedLinked, normalizedPrimary);
          linkedCount++;
        }
      }
    }
    
    if (linkedCount > 0) {
      process.stderr.write(`[Trackman Import] Loaded ${linkedCount} email mappings from user_linked_emails table\n`);
    }
  } catch (err: unknown) {
    process.stderr.write('[Trackman Import] Error loading user_linked_emails: ' + getErrorMessage(err) + '\n');
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
    
    // Only fetch the minimal properties needed for matching (memory optimization)
    const properties = [
      'firstname',
      'lastname',
      'email',
      'membership_status'
    ];
    
    // Memory-efficient approach: filter as we paginate instead of storing everything
    const validMembers: HubSpotMember[] = [];
    let after: string | undefined = undefined;
    let totalProcessed = 0;
    const BATCH_SIZE = 100;
    
    do {
      const response = await hubspot.crm.contacts.basicApi.getPage(BATCH_SIZE, after, properties);
      totalProcessed += response.results.length;
      
      // Process and filter each batch immediately (not storing raw contacts)
      for (const contact of response.results) {
        const status = (contact.properties.membership_status || '').toLowerCase();
        if (VALID_MEMBER_STATUSES.includes(status)) {
          const email = (contact.properties.email || '').toLowerCase();
          if (email) {
            validMembers.push({
              email,
              firstName: contact.properties.firstname || '',
              lastName: contact.properties.lastname || '',
              status
            });
          }
        }
      }
      
      after = response.paging?.next?.after;
      
      // Log progress for large imports
      if (totalProcessed % 500 === 0) {
        process.stderr.write(`[Trackman Import] Processed ${totalProcessed} contacts, found ${validMembers.length} valid members...\n`);
      }
    } while (after);
    
    const activeCount = validMembers.filter(m => m.status === 'active').length;
    const formerCount = validMembers.length - activeCount;
    process.stderr.write(`[Trackman Import] Loaded ${validMembers.length} members from HubSpot (${activeCount} active, ${formerCount} former) from ${totalProcessed} total contacts\n`);
    return validMembers;
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Import] Error fetching HubSpot contacts: ${getErrorMessage(err)}\n`);
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

// Check if an email belongs to a user (via primary email, trackman_email, or manually_linked_emails)
async function isEmailLinkedToUser(email: string, userEmail: string): Promise<boolean> {
  const emailLower = email.toLowerCase().trim();
  const userEmailLower = userEmail.toLowerCase().trim();
  
  // Direct match
  if (emailLower === userEmailLower) return true;
  
  // Check if email matches user's trackman_email or is in manually_linked_emails
  const result = await pool.query(
    `SELECT 1 FROM users 
     WHERE LOWER(email) = LOWER($1) 
     AND (
       LOWER(trackman_email) = LOWER($2)
       OR COALESCE(manually_linked_emails, '[]'::jsonb) ? $2
     )
     LIMIT 1`,
    [userEmail, emailLower]
  );
  return result.rowCount > 0;
}

// Normalize a name for comparison (lowercase, remove extra spaces, handle common variations)
function normalizeName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z\s]/g, '') // Remove non-letters
    .replace(/\s+/g, ' ')     // Normalize whitespace
    .trim();
}

// Check if two names are similar enough to be the same person
function areNamesSimilar(name1: string, name2: string): boolean {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  
  // Exact match
  if (n1 === n2) return true;
  
  // Split into parts
  const parts1 = n1.split(' ').filter(p => p.length > 1);
  const parts2 = n2.split(' ').filter(p => p.length > 1);
  
  if (parts1.length === 0 || parts2.length === 0) return false;
  
  // Check if first names match (handles Joshua/Josh, Michael/Mike, etc.)
  const firstName1 = parts1[0];
  const firstName2 = parts2[0];
  
  // One is prefix of the other (Josh/Joshua, Alex/Alexander)
  const firstNameMatch = firstName1.startsWith(firstName2) || firstName2.startsWith(firstName1) ||
    firstName1.slice(0, 4) === firstName2.slice(0, 4); // First 4 chars match
  
  // Check last names if available
  const lastName1 = parts1[parts1.length - 1];
  const lastName2 = parts2[parts2.length - 1];
  
  // Last name should match closely (allow for typos like Mcgeeney/Mcgeeny)
  const lastNameMatch = lastName1 === lastName2 || 
    lastName1.replace(/e+y$/i, 'y') === lastName2.replace(/e+y$/i, 'y') || // Normalize -eey/-ey endings
    levenshteinDistance(lastName1, lastName2) <= 2; // Allow 2 char typos
  
  return firstNameMatch && lastNameMatch;
}

// Search for members by name when email is not provided or not matched
// Returns: { match: 'unique' | 'ambiguous' | 'none', members: Array<{id, email, name}> }
async function findMembersByName(name: string): Promise<{
  match: 'unique' | 'ambiguous' | 'none';
  members: Array<{ id: string; email: string; name: string }>;
}> {
  if (!name || name.trim().length < 2) {
    return { match: 'none', members: [] };
  }
  
  const normalized = normalizeName(name);
  const nameParts = normalized.split(' ').filter(p => p.length > 1);
  
  if (nameParts.length === 0) {
    return { match: 'none', members: [] };
  }
  
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
  
  // Search for members with matching name
  let query: string;
  let params: string[];
  
  if (lastName) {
    // Full name search - more specific
    query = `
      SELECT id, email, 
        COALESCE(
          (SELECT contact->>'firstname' || ' ' || contact->>'lastname' 
           FROM (SELECT $3::text) AS dummy(contact) WHERE false),
          email
        ) as name,
        LOWER(COALESCE(
          (SELECT hs.properties->>'firstname' FROM hubspot_contacts hs WHERE LOWER(hs.properties->>'email') = LOWER(u.email) LIMIT 1),
          SPLIT_PART(u.email, '@', 1)
        )) as first_name,
        LOWER(COALESCE(
          (SELECT hs.properties->>'lastname' FROM hubspot_contacts hs WHERE LOWER(hs.properties->>'email') = LOWER(u.email) LIMIT 1),
          ''
        )) as last_name
      FROM users u
      WHERE u.tier IS NOT NULL 
        AND u.tier != ''
        AND (
          LOWER(u.email) LIKE $1 || '%'
          OR EXISTS (
            SELECT 1 FROM hubspot_contacts hs 
            WHERE LOWER(hs.properties->>'email') = LOWER(u.email)
            AND (
              LOWER(hs.properties->>'firstname') LIKE $1 || '%'
              OR LOWER(hs.properties->>'firstname') = $1
            )
            AND (
              LOWER(hs.properties->>'lastname') LIKE $2 || '%'
              OR LOWER(hs.properties->>'lastname') = $2
            )
          )
        )
      LIMIT 10
    `;
    params = [firstName, lastName, ''];
  } else {
    // First name only - will likely have multiple matches
    query = `
      SELECT u.id, u.email,
        COALESCE(hs.properties->>'firstname', '') || ' ' || COALESCE(hs.properties->>'lastname', '') as name
      FROM users u
      LEFT JOIN hubspot_contacts hs ON LOWER(hs.properties->>'email') = LOWER(u.email)
      WHERE u.tier IS NOT NULL 
        AND u.tier != ''
        AND (
          LOWER(SPLIT_PART(u.email, '@', 1)) LIKE $1 || '%'
          OR LOWER(COALESCE(hs.properties->>'firstname', '')) = $1
          OR LOWER(COALESCE(hs.properties->>'firstname', '')) LIKE $1 || '%'
        )
      LIMIT 10
    `;
    params = [firstName];
  }
  
  try {
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return { match: 'none', members: [] };
    }
    
    if (result.rows.length === 1) {
      return { 
        match: 'unique', 
        members: result.rows.map(r => ({ id: r.id, email: r.email, name: r.name?.trim() || r.email }))
      };
    }
    
    // Multiple matches - ambiguous
    return { 
      match: 'ambiguous', 
      members: result.rows.map(r => ({ id: r.id, email: r.email, name: r.name?.trim() || r.email }))
    };
  } catch (error: unknown) {
    process.stderr.write(`[Trackman Import] Error searching members by name "${name}": ${error}\n`);
    return { match: 'none', members: [] };
  }
}

// Simple Levenshtein distance for typo detection
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// Auto-link an M: email to the owner's manually_linked_emails
async function autoLinkEmailToOwner(aliasEmail: string, ownerEmail: string, reason: string): Promise<boolean> {
  try {
    const aliasLower = aliasEmail.toLowerCase().trim();
    
    // Add to manually_linked_emails if not already present
    const result = await pool.query(
      `UPDATE users 
       SET manually_linked_emails = 
         CASE 
           WHEN COALESCE(manually_linked_emails, '[]'::jsonb) ? $2
           THEN manually_linked_emails
           ELSE COALESCE(manually_linked_emails, '[]'::jsonb) || to_jsonb($2::text)
         END
       WHERE LOWER(email) = LOWER($1)
       RETURNING email`,
      [ownerEmail, aliasLower]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      process.stderr.write(`[Trackman Import] Auto-linked ${aliasLower} to ${ownerEmail}: ${reason}\n`);
      return true;
    }
    return false;
  } catch (error: unknown) {
    process.stderr.write(`[Trackman Import] Failed to auto-link ${aliasEmail} to ${ownerEmail}: ${error}\n`);
    return false;
  }
}

async function createTrackmanSessionAndParticipants(input: SessionCreationInput): Promise<void> {
  try {
    try {
    // Gather all participants with resolved user IDs
    const participantInputs: ParticipantInput[] = [];
    const memberData: { userId: string; tier: string; email?: string }[] = [];
    
    // Resolve owner's user ID and tier
    const ownerUserId = await getUserIdByEmail(input.ownerEmail);
    const ownerTier = await getMemberTierByEmail(input.ownerEmail) || 'social';
    
    // Normalize owner email for duplicate detection (resolve any aliases including trackman_email)
    const ownerEmailNormalized = resolveEmail(input.ownerEmail, input.membersByEmail, input.trackmanEmailMapping);
    
    // Calculate per-participant duration (split equally among all participants)
    // Count unique members by resolving emails first to avoid counting owner twice
    // Note: This is a sync count, actual duplicates are filtered later with async DB checks
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
        
        // Also check if this email is linked to the owner in the database
        const isLinkedToOwner = await isEmailLinkedToUser(member.email, input.ownerEmail);
        if (isLinkedToOwner) {
          continue;
        }
        
        // STRICT: No name-based matching fallback - email only for data integrity
        if (!memberUserId && member.email) {
          process.stderr.write(`[Trackman Import] Participant "${member.name}" (${member.email}) has no user match - adding as guest-type participant\n`);
        }
        
        // If still no userId (unmatched or ambiguous), treat them as a guest
        if (!memberUserId) {
          let guestId: number | undefined;
          const guestName = member.name || normalizedMemberEmail;
          const existingGuest = await db.select()
            .from(guestsTable)
            .where(sql`LOWER(name) = LOWER(${guestName})`)
            .limit(1);
          
          if (existingGuest.length > 0) {
            guestId = existingGuest[0].id;
          } else {
            const [newGuest] = await db.insert(guestsTable).values({
              name: guestName,
              email: member.email,
              createdByMemberId: input.ownerEmail
            }).returning();
            guestId = newGuest?.id;
          }
          
          participantInputs.push({
            guestId,
            participantType: 'guest',
            displayName: guestName,
            slotDuration: perParticipantMinutes
          });
          process.stderr.write(`[Trackman Import] Unmatched member "${guestName}" (${member.email}) treated as guest\n`);
          continue;
        }
        
        const memberTier = await getMemberTierByEmail(normalizedMemberEmail) || 'social';
        
        participantInputs.push({
          userId: memberUserId,
          participantType: 'member',
          displayName: member.name || normalizedMemberEmail,
          slotDuration: perParticipantMinutes
        });
        
        memberData.push({ userId: memberUserId, tier: memberTier, email: normalizedMemberEmail });
      }
    }
    
    // Add guests from parsed notes
    const guestPlayers = input.parsedPlayers.filter(p => p.type === 'guest');
    for (const guest of guestPlayers) {
      // Skip if guest name matches owner name (prevents duplicate owner as guest)
      const ownerDisplayName = (input.ownerName || input.ownerEmail).toLowerCase().trim();
      const guestDisplayName = (guest.name || '').toLowerCase().trim();
      if (guestDisplayName && (
        guestDisplayName === ownerDisplayName ||
        ownerDisplayName.includes(guestDisplayName) ||
        guestDisplayName.includes(ownerDisplayName.split(' ')[0]) // First name match
      )) {
        process.stderr.write(`[Trackman Import] Skipping guest "${guest.name}" - matches owner name "${input.ownerName || input.ownerEmail}"\n`);
        continue;
      }
      
      // Check if guest email matches any existing member - if so, add as member, not guest
      if (guest.email) {
        const memberByEmail = await getUserIdByEmail(guest.email);
        if (memberByEmail) {
          // Skip if this member is the owner
          if (memberByEmail === ownerUserId) {
            process.stderr.write(`[Trackman Import] Skipping guest "${guest.name}" - email resolves to owner\n`);
            continue;
          }
          
          const memberTier = await getMemberTierByEmail(guest.email) || 'social';
          participantInputs.push({
            userId: memberByEmail,
            participantType: 'member',
            displayName: guest.name || guest.email,
            slotDuration: perParticipantMinutes
          });
          memberData.push({ userId: memberByEmail, tier: memberTier, email: guest.email });
          process.stderr.write(`[Trackman Import] Guest "${guest.name}" has member email - adding as member\n`);
          continue;
        }
      }
      
      // Warn if guest has no email - slot will show as unfilled
      if (!guest.email) {
        process.stderr.write(`[Trackman Import] WARNING: Guest "${guest.name}" has no email - slot will show as unfilled until email is added\n`);
      }
      
      let guestId: number | undefined;
      if (guest.name) {
        const existingGuest = await db.select()
          .from(guestsTable)
          .where(sql`LOWER(name) = LOWER(${guest.name})`)
          .limit(1);
        
        if (existingGuest.length > 0) {
          guestId = existingGuest[0].id;
          // If existing guest has no email but we have one now, update it
          if (guest.email && !existingGuest[0].email) {
            await db.update(guestsTable)
              .set({ email: guest.email.toLowerCase() })
              .where(eq(guestsTable.id, existingGuest[0].id));
            process.stderr.write(`[Trackman Import] Updated guest "${guest.name}" with email: ${guest.email}\n`);
          }
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

    // Update payment_status based on past/future sessions
    // Past sessions are marked as 'paid' (already happened, assumed settled externally)
    // Future sessions are marked as 'pending' (require payment through the app)
    if (participants.length > 0) {
      const participantIds = participants.map(p => p.id);
      if (input.isPast) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET payment_status = 'paid', paid_at = NOW()
          WHERE id IN (${sql.join(participantIds.map(id => sql`${id}`), sql`, `)})
        `);
      } else {
        await db.execute(sql`
          UPDATE booking_participants 
          SET payment_status = 'pending'
          WHERE id IN (${sql.join(participantIds.map(id => sql`${id}`), sql`, `)})
        `);
      }
    }

    // Build Participant array for billing calculation
    const billingParticipants: Participant[] = [];
    
    // Add owner
    billingParticipants.push({
      userId: ownerUserId || undefined,
      email: input.ownerEmail,
      participantType: 'owner',
      displayName: input.ownerName || input.ownerEmail
    });
    
    // Add members from memberData
    for (const md of memberData) {
      billingParticipants.push({
        userId: md.userId,
        email: md.email,
        participantType: 'member',
        displayName: md.email
      });
    }
    
    // Add guests from participantInputs (those with participantType === 'guest')
    const guestInputs = participantInputs.filter(p => p.participantType === 'guest');
    for (const g of guestInputs) {
      billingParticipants.push({
        guestId: g.guestId,
        participantType: 'guest',
        displayName: g.displayName
      });
    }
    
    // Calculate billing using calculateFullSessionBilling
    const billingResult = await calculateFullSessionBilling(
      input.sessionDate,
      input.durationMinutes,
      billingParticipants,
      input.ownerEmail
    );

    // Create usage_ledger entries for members with calculated fees
    for (const md of memberData) {
      const memberBilling = billingResult.billingBreakdown.find(
        b => b.userId === md.userId || b.email?.toLowerCase() === md.email.toLowerCase()
      );
      
      await recordUsage(
        session.id,
        {
          memberId: md.userId,
          minutesCharged: memberBilling?.minutesAllocated ?? perParticipantMinutes,
          overageFee: memberBilling?.overageFee ?? 0,
          guestFee: 0,
          tierAtBooking: md.tier,
          paymentMethod: input.isPast ? 'credit_card' : 'unpaid'
        },
        'trackman_import'
      );
    }
    
    // Record owner usage with calculated overage
    if (ownerUserId) {
      const ownerBilling = billingResult.billingBreakdown.find(b => b.participantType === 'owner');
      await recordUsage(
        session.id,
        {
          memberId: ownerUserId,
          minutesCharged: ownerBilling?.minutesAllocated ?? perParticipantMinutes,
          overageFee: ownerBilling?.overageFee ?? 0,
          guestFee: billingResult.totalGuestFees,
          tierAtBooking: ownerTier,
          paymentMethod: input.isPast ? 'credit_card' : 'unpaid'
        },
        'trackman_import'
      );
    }

    // Set cached_fee_cents on booking_participants from billing breakdown
    for (const billing of billingResult.billingBreakdown) {
      const matchingParticipant = participants.find(p => {
        if (billing.userId && p.userId === billing.userId) return true;
        if (billing.guestId && p.guestId === billing.guestId) return true;
        if (billing.participantType === 'owner' && p.participantType === 'owner') return true;
        return false;
      });
      if (matchingParticipant) {
        const feeCents = Math.round(billing.totalFee * 100);
        await db.execute(sql`
          UPDATE booking_participants 
          SET cached_fee_cents = ${feeCents}
          WHERE id = ${matchingParticipant.id}
        `);
      }
    }
    
    if (billingResult.totalFees > 0) {
      process.stderr.write(`[Trackman Import] Session #${session.id} billing: overage=$${billingResult.totalOverageFees}, guest=$${billingResult.totalGuestFees}\n`);
    }

    process.stderr.write(`[Trackman Import] Created session #${session.id} with ${participants.length} participants for Trackman ID ${input.trackmanBookingId}\n`);
    } catch (innerError: unknown) {
      process.stderr.write(`[Trackman Import] Full session creation failed for booking ${input.bookingId}, falling back to owner-only session: ${getErrorMessage(innerError)}\n`);

      try {
        const fallbackOwnerUserId = await getUserIdByEmail(input.ownerEmail);

        const { session: fallbackSession } = await createSession(
          {
            resourceId: input.resourceId,
            sessionDate: input.sessionDate,
            startTime: input.startTime,
            endTime: input.endTime,
            trackmanBookingId: input.trackmanBookingId,
            createdBy: 'trackman_import_fallback'
          },
          [{
            userId: fallbackOwnerUserId || undefined,
            participantType: 'owner',
            displayName: input.ownerName || input.ownerEmail,
            slotDuration: input.durationMinutes
          }],
          'trackman_import'
        );

        await db.update(bookingRequests)
          .set({ sessionId: fallbackSession.id })
          .where(eq(bookingRequests.id, input.bookingId));

        if (input.isPast) {
          await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW() WHERE session_id = ${fallbackSession.id}`);
        } else {
          await db.execute(sql`UPDATE booking_participants SET payment_status = 'pending' WHERE session_id = ${fallbackSession.id}`);
        }

        const [bookingForNote] = await db.select({ staffNotes: bookingRequests.staffNotes })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, input.bookingId));
        const existingNotes = bookingForNote?.staffNotes || '';
        const failureNote = `[SESSION_PARTIAL] Owner-only session created (${new Date().toISOString().split('T')[0]}). Additional participants may need to be added manually.`;
        const updatedNotes = existingNotes ? `${existingNotes}\n${failureNote}` : failureNote;
        await db.update(bookingRequests)
          .set({ staffNotes: updatedNotes })
          .where(eq(bookingRequests.id, input.bookingId));

        process.stderr.write(`[Trackman Import] Fallback owner-only session ${fallbackSession.id} created for booking ${input.bookingId}\n`);
      } catch (fallbackError: unknown) {
        process.stderr.write(`[Trackman Import] CRITICAL: Even fallback session creation failed for booking ${input.bookingId}: ${getErrorMessage(fallbackError)}\n`);
        try {
          const [bookingForCriticalNote] = await db.select({ staffNotes: bookingRequests.staffNotes })
            .from(bookingRequests)
            .where(eq(bookingRequests.id, input.bookingId));
          const existingCriticalNotes = bookingForCriticalNote?.staffNotes || '';
          const criticalNote = `[SESSION_CREATION_FAILED] Auto session failed (${new Date().toISOString().split('T')[0]}). Please create a session manually.`;
          const updatedCriticalNotes = existingCriticalNotes ? `${existingCriticalNotes}\n${criticalNote}` : criticalNote;
          await db.update(bookingRequests)
            .set({ staffNotes: updatedCriticalNotes })
            .where(eq(bookingRequests.id, input.bookingId));
        } catch (noteErr: unknown) { logger.warn('[TrackmanImport] Failed to save session creation failure note:', { error: getErrorMessage(noteErr) || noteErr }); }
      }
    }
  } catch (outerError: unknown) {
    process.stderr.write(`[Trackman Import] Unexpected error in session creation for booking ${input.bookingId}: ${getErrorMessage(outerError)}\n`);
  }
}

export async function importTrackmanBookings(csvPath: string, importedBy?: string): Promise<{
  totalRows: number;
  matchedRows: number;
  linkedRows: number;
  unmatchedRows: number;
  skippedRows: number;
  skippedAsPrivateEventBlocks: number;
  removedFromUnmatched: number;
  cancelledBookings: number;
  updatedRows: number;
  errors: string[];
}> {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const parsedRows = parseCSVWithMultilineSupport(content);
  
  if (parsedRows.length < 2) {
    return { totalRows: 0, matchedRows: 0, linkedRows: 0, unmatchedRows: 0, skippedRows: 0, skippedAsPrivateEventBlocks: 0, removedFromUnmatched: 0, cancelledBookings: 0, updatedRows: 0, errors: ['Empty or invalid CSV'] };
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
      skippedAsPrivateEventBlocks: 0,
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

  // Supplement membersByEmail with local database users (non-members, visitors, etc.)
  try {
    const localUsers = await db.select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName
    }).from(users).where(sql`email IS NOT NULL AND email != '' AND COALESCE(membership_status, '') != 'merged'`);
    
    let addedFromDb = 0;
    for (const user of localUsers) {
      if (user.email) {
        const lowerEmail = user.email.toLowerCase();
        if (!membersByEmail.has(lowerEmail)) {
          membersByEmail.set(lowerEmail, user.email);
          addedFromDb++;
          // Also add to membersByName
          const fullName = `${user.firstName || ''} ${user.lastName || ''}`.toLowerCase().trim();
          if (fullName) {
            const existing = membersByName.get(fullName) || [];
            existing.push(user.email);
            membersByName.set(fullName, existing);
          }
        }
      }
    }
    process.stderr.write(`[Trackman Import] Added ${addedFromDb} additional users from local database to membersByEmail (total: ${membersByEmail.size})\n`);
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Import] Error loading local users: ${getErrorMessage(err)}\n`);
  }

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
    .where(sql`trackman_email IS NOT NULL AND trackman_email != '' AND COALESCE(membership_status, '') != 'merged'`);
    
    for (const user of usersWithTrackmanEmail) {
      if (user.email && user.trackmanEmail) {
        trackmanEmailMapping.set(user.trackmanEmail.toLowerCase().trim(), user.email.toLowerCase());
      }
    }
    process.stderr.write(`[Trackman Import] Loaded ${trackmanEmailMapping.size} trackman_email mappings from users table\n`);
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Import] Error loading trackman_email mappings: ${getErrorMessage(err)}\n`);
  }

  // Fetch golf instructor emails once before processing rows
  const INSTRUCTOR_EMAILS = await getGolfInstructorEmails();
  process.stderr.write(`[Trackman Import] Loaded ${INSTRUCTOR_EMAILS.length} golf instructor emails: ${INSTRUCTOR_EMAILS.join(', ') || '(none)'}\n`);

  let matchedRows = 0;
  let unmatchedRows = 0;
  let skippedRows = 0;
  let linkedRows = 0;
  let removedFromUnmatched = 0;
  let cancelledBookings = 0;
  let updatedRows = 0;
  let skippedAsPrivateEventBlocks = 0;
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

  // Calculate CSV date range to prevent accidental cancellations outside the CSV's date scope
  let csvDateRange: { min: string; max: string } | null = null;
  const csvDates = new Set<string>();
  for (let i = 1; i < parsedRows.length; i++) {
    const fields = parsedRows[i];
    if (fields.length >= 9) {
      const startDate = fields[8]; // startDate field
      if (startDate) {
        const date = extractDate(startDate);
        if (date) {
          csvDates.add(date);
        }
      }
    }
  }
  
  if (csvDates.size > 0) {
    const sortedDates = Array.from(csvDates).sort();
    csvDateRange = {
      min: sortedDates[0],
      max: sortedDates[sortedDates.length - 1]
    };
    process.stderr.write(`[Trackman Import] CSV date range: ${csvDateRange.min} to ${csvDateRange.max}\n`);
  }

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

      // -----------------------------------------------------------------------
      // STAFF EMAIL DETECTION: Convert lessons to availability blocks
      // When staff book in Trackman using their @evenhouse.club emails, or when
      // notes contain "lesson" keywords, convert to blocks instead of bookings.
      // This prevents financial pollution and directory distortion.
      // (INSTRUCTOR_EMAILS is loaded dynamically from staff_users with role 'golf_instructor')
      // -----------------------------------------------------------------------
      const notesLower = (row.notes || '').toLowerCase();
      const userNameLower = (row.userName || '').toLowerCase();
      const userEmailLower = (row.userEmail || '').toLowerCase().trim();
      
      // CRITICAL: Resolve email aliases BEFORE checking if they're an instructor
      // This handles cases like rebecca.bentham@evenhouse.club -> rebecca@evenhouse.club
      const resolvedEmail = emailMapping.get(userEmailLower) || 
                           trackmanEmailMapping.get(userEmailLower) || 
                           userEmailLower;
      
      const isStaffLesson = 
        // 1. Check resolved email against instructor list (handles aliases)
        INSTRUCTOR_EMAILS.includes(resolvedEmail.toLowerCase()) ||
        // 2. Also check raw email as fallback
        INSTRUCTOR_EMAILS.includes(userEmailLower) ||
        // 3. Check for lesson keywords in notes
        notesLower.includes('lesson') ||
        notesLower.includes('private instruction') ||
        // 4. Check for lesson keywords in userName
        userNameLower.includes('lesson');
      
      if (isStaffLesson && row.status.toLowerCase() !== 'cancelled' && row.status.toLowerCase() !== 'canceled') {
        const bookingDate = extractDate(row.startDate);
        const startTime = extractTime(row.startDate);
        const endTime = extractTime(row.endDate);
        const resourceId = parseInt(row.bayNumber) || null;
        
        if (resourceId && bookingDate && startTime) {
          // Check if block already exists to avoid duplicates
          const existingBlock = await isConvertedToPrivateEventBlock(
            resourceId,
            bookingDate,
            startTime,
            endTime
          );
          
          if (!existingBlock) {
            try {
              // Create Facility Closure (container)
              const [closure] = await db.insert(facilityClosures).values({
                resourceId,
                startDate: bookingDate,
                endDate: bookingDate,
                startTime: startTime,
                endTime: endTime || startTime,
                reason: `Lesson: ${row.userName || 'Private Instruction'}`,
                noticeType: 'private_event',
                isActive: true,
                createdBy: 'trackman_import'
              } as typeof facilityClosures.$inferInsert).returning();
              
              // Create Availability Block (time slot)
              await db.insert(availabilityBlocks).values({
                closureId: closure.id,
                resourceId,
                blockDate: bookingDate,
                startTime: startTime,
                endTime: endTime || startTime,
                reason: `Lesson - ${row.userName}`
              } as typeof availabilityBlocks.$inferInsert);
              
              process.stderr.write(`[Trackman Import] Converted staff lesson to block: ${row.userEmail} -> "${row.userName}" on ${bookingDate}\n`);
            } catch (blockErr: unknown) {
              process.stderr.write(`[Trackman Import] Error creating lesson block for ${row.bookingId}: ${getErrorMessage(blockErr)}\n`);
            }
          }
          
          // Skip creation of booking_request - this is a block, not a booking
          skippedAsPrivateEventBlocks++;
          continue;
        }
      }
      // -----------------------------------------------------------------------

      // Handle cancelled bookings - check if booking exists and cancel it
      if (row.status.toLowerCase() === 'cancelled' || row.status.toLowerCase() === 'canceled') {
        // Check if this booking exists in the system
        const existingBookingToCancel = await db.select({ 
          id: bookingRequests.id,
          status: bookingRequests.status,
          sessionId: bookingRequests.sessionId,
          createdAt: bookingRequests.createdAt
        })
          .from(bookingRequests)
          .where(sql`trackman_booking_id = ${row.bookingId} OR notes LIKE ${'%[Trackman Import ID:' + row.bookingId + ']%'}`)
          .limit(1);
        
        if (existingBookingToCancel.length > 0) {
          const booking = existingBookingToCancel[0];
          
          // Determine the booking's date for date-range validation
          let bookingDate: string | null = null;
          if (booking.sessionId) {
            try {
              const sessionResult = await db.select({ 
                sessionDate: bookingSessions.sessionDate
              })
                .from(bookingSessions)
                .where(eq(bookingSessions.id, booking.sessionId))
                .limit(1);
              
              if (sessionResult.length > 0) {
                bookingDate = sessionResult[0].sessionDate;
              }
            } catch (dateErr: unknown) {
              process.stderr.write(`[Trackman Import] Warning: Failed to fetch session date for booking #${booking.id}: ${getErrorMessage(dateErr)}\n`);
            }
          }
          
          // Fallback to booking creation date if session date not found
          if (!bookingDate && booking.createdAt) {
            const date = booking.createdAt instanceof Date ? booking.createdAt : new Date(booking.createdAt);
            bookingDate = date.toISOString().split('T')[0];
          }
          
          // Skip cancellations outside CSV date range to prevent accidental data loss
          if (csvDateRange && bookingDate && (bookingDate < csvDateRange.min || bookingDate > csvDateRange.max)) {
            process.stderr.write(`[Trackman Import] Skipping out-of-range cancellation: Booking #${booking.id} (Trackman ID: ${row.bookingId}, date: ${bookingDate}) is outside CSV range [${csvDateRange.min} to ${csvDateRange.max}]\n`);
            skippedRows++;
            continue;
          }
          
          // Only cancel if not already cancelled
          if (booking.status !== 'cancelled') {
            // Update booking status to cancelled
            await db.update(bookingRequests)
              .set({ 
                status: 'cancelled',
                updatedAt: new Date()
              })
              .where(eq(bookingRequests.id, booking.id));
            
            // Cancel pending payment intents
            await cancelPendingPaymentIntentsForBooking(booking.id);
            
            // Delete associated booking_members records
            await db.delete(bookingMembers)
              .where(eq(bookingMembers.bookingId, booking.id));
            
            // Delete associated booking_guests records
            await db.delete(bookingGuests)
              .where(eq(bookingGuests.bookingId, booking.id));
            
            process.stderr.write(`[Trackman Import] Cancelled booking #${booking.id} (Trackman ID: ${row.bookingId}, date: ${bookingDate}) - status was ${booking.status}\n`);
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

      // FALLBACK: If no email match from CSV email field, try M: tag emails from notes
      // This handles cases where Trackman's email field is empty but notes contain member emails
      if (!matchedEmail && memberEmailsFromNotes.length > 0) {
        const noteEmail = memberEmailsFromNotes[0].toLowerCase();
        const existingMember = membersByEmail.get(noteEmail);
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched via M: tag in notes';
          process.stderr.write(`[Trackman Import] Notes fallback match: ${noteEmail} -> ${existingMember} for "${row.userName}"\n`);
        }
      }

      // STRICT EMAIL-ONLY MATCHING: Do NOT fallback to name matching
      // Name matching causes data integrity issues when multiple members share similar names
      if (!matchedEmail && row.userName && !isPlaceholderEmail(row.userEmail)) {
        process.stderr.write(`[Trackman Import] No email match for "${row.userName}" (email: ${row.userEmail}) - name matching disabled for accuracy\n`);
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

      // Check if booking exists in legacy table - if so, we'll migrate it to the new system
      const existingUnmatched = await db.select({ 
        id: trackmanUnmatchedBookings.id,
        resolvedAt: trackmanUnmatchedBookings.resolvedAt
      })
        .from(trackmanUnmatchedBookings)
        .where(eq(trackmanUnmatchedBookings.trackmanBookingId, row.bookingId))
        .limit(1);
      
      // Legacy entry exists but resolved - we can proceed (booking should exist in booking_requests)
      // Legacy entry exists but unresolved - check booking_requests, if missing create it and auto-resolve legacy
      const hasLegacyEntry = existingUnmatched.length > 0;
      const legacyIsUnresolved = hasLegacyEntry && !existingUnmatched[0].resolvedAt;

      const parsedBayId = parseInt(row.bayNumber) || null;

      // Match ONLY by trackman_booking_id to prevent notes-based cross-updates that could affect wrong bookings
      const existingBooking = await db.select({ 
        id: bookingRequests.id,
        resourceId: bookingRequests.resourceId,
        startTime: bookingRequests.startTime,
        endTime: bookingRequests.endTime,
        durationMinutes: bookingRequests.durationMinutes,
        notes: bookingRequests.notes,
        trackmanPlayerCount: bookingRequests.trackmanPlayerCount,
        declaredPlayerCount: bookingRequests.declaredPlayerCount,
        guestCount: bookingRequests.guestCount,
        trackmanCustomerNotes: bookingRequests.trackmanCustomerNotes,
        staffNotes: bookingRequests.staffNotes,
        sessionId: bookingRequests.sessionId,
        userEmail: bookingRequests.userEmail,
        userName: bookingRequests.userName,
        origin: bookingRequests.origin,
        isUnmatched: bookingRequests.isUnmatched
      })
        .from(bookingRequests)
        .where(eq(bookingRequests.trackmanBookingId, row.bookingId))
        .limit(1);
      
      if (existingBooking.length > 0) {
        // Booking already exists - update with latest data from CSV (backfill webhook-created bookings)
        const existing = existingBooking[0];
        const isWebhookCreated = existing.origin === 'trackman_webhook';
        
        // Build update object with changed fields
        const updateFields: Record<string, unknown> = {};
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
        
        // PLAYER COUNT HANDLING: Preserve app request's declared_player_count as source of truth
        // Only update trackmanPlayerCount (Trackman's report), NEVER override declaredPlayerCount
        if (row.playerCount >= 1) {
          // Always record what Trackman reports
          if (existing.trackmanPlayerCount !== row.playerCount) {
            updateFields.trackmanPlayerCount = row.playerCount;
            changes.push(`trackmanPlayerCount: ${existing.trackmanPlayerCount ?? 0} -> ${row.playerCount}`);
          }
          
          // ONLY set declaredPlayerCount if the request never had one (webhook-only booking)
          // App request's declared_player_count is the source of truth
          const requestDeclaredCount = existing.declaredPlayerCount;
          if (requestDeclaredCount === null || requestDeclaredCount === undefined || requestDeclaredCount === 0) {
            // No app request declaration - use Trackman's count
            updateFields.declaredPlayerCount = row.playerCount;
            changes.push(`declaredPlayerCount (backfill): 0 -> ${row.playerCount}`);
          } else if (row.playerCount > requestDeclaredCount) {
            // MISMATCH DETECTION: Trackman reports MORE players than app request declared
            updateFields.playerCountMismatch = true;
            const warningNote = `[Warning: Trackman reports ${row.playerCount} players but app request only declared ${requestDeclaredCount}]`;
            const existingStaffNotes = existing.staffNotes || '';
            if (!existingStaffNotes.includes('[Warning: Trackman reports')) {
              updateFields.staffNotes = existingStaffNotes ? `${warningNote} ${existingStaffNotes}` : warningNote;
              changes.push(`mismatch: Trackman ${row.playerCount} > request ${requestDeclaredCount}`);
            }
            process.stderr.write(`[Trackman Import] MISMATCH: Booking #${existing.id} - Trackman reports ${row.playerCount} players but app request declared ${requestDeclaredCount}\n`);
          }
        }
        
        // BACKFILL: Add notes from import if existing booking has no customer notes
        if (!existing.trackmanCustomerNotes && row.notes) {
          updateFields.trackmanCustomerNotes = row.notes;
          changes.push('trackmanNotes: added from import');
        }
        
        // BACKFILL: If this was an unmatched webhook booking, update member info from import
        if (existing.isUnmatched && matchedEmail) {
          updateFields.userEmail = matchedEmail;
          updateFields.userName = row.userName;
          updateFields.isUnmatched = false;
          changes.push(`member: linked ${matchedEmail}`);
          
          // Email learning: if original email differs from matched member email, learn the association
          const originalEmail = row.userEmail?.toLowerCase().trim();
          if (originalEmail && 
              originalEmail.includes('@') && 
              originalEmail !== matchedEmail.toLowerCase() &&
              !isPlaceholderEmail(originalEmail)) {
            try {
              const existingLink = await pool.query(
                `SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = $1`,
                [originalEmail]
              );
              
              if (existingLink.rows.length === 0) {
                await pool.query(
                  `INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
                   VALUES ($1, $2, 'trackman_import_auto', 'system')`,
                  [matchedEmail.toLowerCase(), originalEmail]
                );
                process.stderr.write(`[Email Learning] Auto-linked ${originalEmail} -> ${matchedEmail} from import\n`);
              }
            } catch (linkErr: unknown) {
              if (!getErrorMessage(linkErr)?.includes('duplicate key')) {
                process.stderr.write(`[Email Learning] Error: ${getErrorMessage(linkErr)}\n`);
              }
            }
          }
        } else if (existing.isUnmatched && !matchedEmail && row.userName && row.userName !== 'Unknown' && !existing.userName?.includes(row.userName)) {
          updateFields.userName = row.userName;
          changes.push(`name: "${existing.userName}" -> "${row.userName}" (still unmatched)`);
        }
        
        // Always update sync tracking fields
        updateFields.lastSyncSource = 'trackman_import';
        updateFields.lastTrackmanSyncAt = new Date();
        updateFields.updatedAt = new Date();
        
        // If there are changes, update the booking
        if (changes.length > 0) {
          try {
            await db.update(bookingRequests)
              .set(updateFields)
              .where(eq(bookingRequests.id, existing.id));
            
            process.stderr.write(`[Trackman Import] Updated booking #${existing.id} (Trackman ID: ${row.bookingId}): ${changes.join(', ')}${isWebhookCreated ? ' [webhook backfill]' : ''}\n`);
            updatedRows++;
          } catch (updateErr: unknown) {
            const errMsg = (updateErr instanceof Error && updateErr.cause instanceof Error ? updateErr.cause.message : null) || getErrorMessage(updateErr) || '';
            if (errMsg.includes('booking_requests_no_overlap') || errMsg.includes('exclusion constraint')) {
              delete updateFields.startTime;
              delete updateFields.endTime;
              delete updateFields.durationMinutes;
              const timeChanges = changes.filter(c => c.startsWith('start:') || c.startsWith('end:') || c.startsWith('duration:'));
              const otherChanges = changes.filter(c => !c.startsWith('start:') && !c.startsWith('end:') && !c.startsWith('duration:'));
              
              if (Object.keys(updateFields).length > 0) {
                await db.update(bookingRequests)
                  .set(updateFields)
                  .where(eq(bookingRequests.id, existing.id));
              }
              
              process.stderr.write(`[Trackman Import] Booking #${existing.id}: skipped time update (${timeChanges.join(', ')}) - overlaps with another booking on the same bay${otherChanges.length > 0 ? `. Other updates applied: ${otherChanges.join(', ')}` : ''}\n`);
              updatedRows++;
            } else {
              throw updateErr;
            }
          }
        } else {
          // No field changes, but still update sync tracking
          try {
            await db.update(bookingRequests)
              .set(updateFields)
              .where(eq(bookingRequests.id, existing.id));
          } catch (updateErr: unknown) {
            const errMsg = (updateErr instanceof Error && updateErr.cause instanceof Error ? updateErr.cause.message : null) || getErrorMessage(updateErr) || '';
            if (errMsg.includes('booking_requests_no_overlap') || errMsg.includes('exclusion constraint')) {
              process.stderr.write(`[Trackman Import] Booking #${existing.id}: sync tracking update skipped due to overlap constraint\n`);
            } else {
              throw updateErr;
            }
          }
          matchedRows++;
        }
        
        // BACKFILL: Create/populate booking_members and booking_guests for ALL bookings
        // Handles both webhook-originated and CSV-imported bookings
        if (row.playerCount >= 1) {
          const requestPlayerCount = existing.declaredPlayerCount || 0;
          const targetPlayerCount = requestPlayerCount > 0 ? requestPlayerCount : row.playerCount;
          
          const existingMembers = await db.select({ 
            id: bookingMembers.id, 
            slotNumber: bookingMembers.slotNumber,
            userEmail: bookingMembers.userEmail 
          })
            .from(bookingMembers)
            .where(eq(bookingMembers.bookingId, existing.id));
          
          const existingSlotNumbers = new Set(existingMembers.map(m => m.slotNumber));
          const slotsToCreate: number[] = [];
          for (let slot = 1; slot <= targetPlayerCount; slot++) {
            if (!existingSlotNumbers.has(slot)) {
              slotsToCreate.push(slot);
            }
          }
          
          const parsedPlayers = parseNotesForPlayers(row.notes);
          const guestPlayers = parsedPlayers.filter(p => p.type === 'guest');
          
          if (slotsToCreate.length > 0) {
            for (const slot of slotsToCreate) {
              const isPrimary = slot === 1;
              const guestIndex = slot - 2;
              const guestInfo = guestIndex >= 0 ? guestPlayers[guestIndex] : null;
              
              await db.insert(bookingMembers).values({
                bookingId: existing.id,
                userEmail: isPrimary && matchedEmail ? matchedEmail : null,
                slotNumber: slot,
                isPrimary: isPrimary,
                trackmanBookingId: row.bookingId,
                linkedAt: isPrimary && matchedEmail ? new Date() : null,
                linkedBy: isPrimary && matchedEmail ? 'trackman_import' : null
              });
              
              if (!isPrimary && guestInfo?.name) {
                await pool.query(
                  `INSERT INTO booking_guests (booking_id, guest_name, slot_number, trackman_booking_id)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT DO NOTHING`,
                  [existing.id, guestInfo.name, slot, row.bookingId]
                );
              }
            }
            
            process.stderr.write(`[Trackman Import] Created ${slotsToCreate.length} player slots (${slotsToCreate.join(',')}) for booking #${existing.id} (target: ${targetPlayerCount})\n`);
          }
          
          // BACKFILL: Populate empty existing booking_members with owner email and guest names
          const emptySlot1 = existingMembers.find(m => m.slotNumber === 1 && !m.userEmail);
          if (emptySlot1 && matchedEmail) {
            await pool.query(
              `UPDATE booking_members SET user_email = $1, linked_at = NOW(), linked_by = 'trackman_import'
               WHERE id = $2`,
              [matchedEmail, emptySlot1.id]
            );
            process.stderr.write(`[Trackman Import] Backfilled slot 1 email for booking #${existing.id}: ${matchedEmail}\n`);
          }
          
          const emptyGuestSlots = existingMembers
            .filter(m => m.slotNumber > 1 && !m.userEmail)
            .sort((a, b) => a.slotNumber - b.slotNumber);
          
          if (emptyGuestSlots.length > 0 && guestPlayers.length > 0) {
            for (let gi = 0; gi < Math.min(emptyGuestSlots.length, guestPlayers.length); gi++) {
              const slot = emptyGuestSlots[gi];
              const guest = guestPlayers[gi];
              
              if (guest.name) {
                const existingGuest = await pool.query(
                  `SELECT id FROM booking_guests WHERE booking_id = $1 AND slot_number = $2`,
                  [existing.id, slot.slotNumber]
                );
                if (existingGuest.rows.length === 0) {
                  await pool.query(
                    `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, trackman_booking_id)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [existing.id, guest.name, guest.email || null, slot.slotNumber, row.bookingId]
                  );
                  process.stderr.write(`[Trackman Import] Backfilled guest slot ${slot.slotNumber} for booking #${existing.id}: ${guest.name}\n`);
                }
              }
            }
          }
        }
        
        // BACKFILL: Create session and participants for WEBHOOK-ORIGINATED bookings if missing
        // Only backfill if we have confirmed ownership and required fields
        if (isWebhookCreated && !existing.sessionId && parsedBayId && bookingDate && startTime) {
          const ownerEmail = matchedEmail || existing.userEmail;
          const ownerName = row.userName || existing.userName;
          
          // Only create session if we have a confirmed owner email
          if (ownerEmail && ownerEmail !== 'unmatched@trackman.import') {
            const backfillParsedPlayers = parseNotesForPlayers(row.notes);
            await createTrackmanSessionAndParticipants({
              bookingId: existing.id,
              trackmanBookingId: row.bookingId,
              resourceId: parsedBayId,
              sessionDate: bookingDate,
              startTime: startTime,
              endTime: endTime,
              durationMinutes: row.durationMins,
              ownerEmail: ownerEmail,
              ownerName: ownerName || 'Unknown',
              parsedPlayers: backfillParsedPlayers,
              membersByEmail: membersByEmail,
              trackmanEmailMapping: trackmanEmailMapping,
              isPast: !isUpcoming
            });
            process.stderr.write(`[Trackman Import] Backfilled session for webhook booking #${existing.id} (Trackman ID: ${row.bookingId})\n`);
          }
        }
        
        // Auto-resolve legacy entry if it exists - booking is now tracked in booking_requests
        if (legacyIsUnresolved && existingUnmatched[0]) {
          try {
            await db.update(trackmanUnmatchedBookings)
              .set({ 
                resolvedAt: new Date(),
                resolvedBy: 'trackman_import_sync',
                notes: sql`COALESCE(notes, '') || ' [Auto-resolved: booking exists in booking_requests]'`
              })
              .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
            process.stderr.write(`[Trackman Import] Auto-resolved legacy entry for booking ${row.bookingId}\n`);
          } catch (resolveErr: unknown) {
            // Non-blocking
          }
        }
        
        continue;
      }
      // PRIORITY 1: Merge with webhook-created placeholder/ghost bookings
      // Look for existing bookings at same simulator/time that are unmatched or unknown
      if (!existingBooking.length && parsedBayId && bookingDate && startTime) {
        const placeholderBooking = await pool.query(
          `SELECT id, user_email, user_name, status, session_id, trackman_booking_id, origin,
                  ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) as time_diff_seconds
           FROM booking_requests
           WHERE resource_id = $1
           AND request_date = $2
           AND ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 120
           AND trackman_booking_id IS NULL
           AND (is_unmatched = true 
                OR LOWER(user_name) LIKE '%unknown%' 
                OR LOWER(user_name) LIKE '%unassigned%'
                OR (user_email = '' AND user_name IS NOT NULL))
           AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
           ORDER BY ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))), created_at DESC`,
          [parsedBayId, bookingDate, startTime]
        );
        
        if (placeholderBooking.rows.length > 1) {
          process.stderr.write(`[Trackman Import] Multiple placeholder candidates (${placeholderBooking.rows.length}) for Trackman ${row.bookingId} on bay ${parsedBayId} at ${startTime} - skipping auto-merge, requires manual resolution\n`);
        } else if (placeholderBooking.rows.length === 1) {
          const placeholder = placeholderBooking.rows[0];
          const mergeStatus = matchedEmail ? 'approved' : (normalizedStatus || 'approved');
          
          // UPDATE the placeholder with real data from CSV
          const updateFields: Record<string, unknown> = {
            trackman_booking_id: row.bookingId,
            user_name: row.userName || placeholder.user_name,
            start_time: startTime,
            end_time: endTime,
            duration_minutes: row.durationMins,
            trackman_player_count: row.playerCount,
            declared_player_count: row.playerCount,
            notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
            trackman_customer_notes: row.notes || null,
            is_unmatched: !matchedEmail,
            status: mergeStatus,
            last_sync_source: 'trackman_import',
            last_trackman_sync_at: new Date(),
            updated_at: new Date(),
            origin: 'trackman_import'
          };
          
          if (matchedEmail) {
            updateFields.user_email = matchedEmail;
          }
          
          // Build SET clause dynamically
          const setClauses: string[] = [];
          const setValues: unknown[] = [];
          let paramIdx = 1;
          for (const [key, value] of Object.entries(updateFields)) {
            setClauses.push(`${key} = $${paramIdx}`);
            setValues.push(value);
            paramIdx++;
          }
          setValues.push(placeholder.id);
          
          await pool.query(
            `UPDATE booking_requests SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
            setValues
          );
          
          process.stderr.write(`[Trackman Import] MERGED: CSV row ${row.bookingId} into placeholder booking #${placeholder.id} (was: "${placeholder.user_name}", now: "${row.userName}"${matchedEmail ? `, linked to ${matchedEmail}` : ''})\n`);
          
          // Create booking_members and booking_guests for merged booking
          if (matchedEmail) {
            try {
              const existingMembers = await pool.query(
                `SELECT id FROM booking_members WHERE booking_id = $1`,
                [placeholder.id]
              );
              
              if (existingMembers.rows.length === 0) {
                const mergeParsedPlayers = parseNotesForPlayers(row.notes);
                const mergeGuestPlayers = mergeParsedPlayers.filter(p => p.type === 'guest');
                
                await pool.query(
                  `INSERT INTO booking_members (booking_id, user_email, slot_number, is_primary, trackman_booking_id, linked_at, linked_by)
                   VALUES ($1, $2, 1, true, $3, NOW(), 'trackman_import')`,
                  [placeholder.id, matchedEmail, row.bookingId]
                );
                
                for (let slot = 2; slot <= row.playerCount; slot++) {
                  const guestIndex = slot - 2;
                  const guestInfo = guestIndex < mergeGuestPlayers.length ? mergeGuestPlayers[guestIndex] : null;
                  
                  await pool.query(
                    `INSERT INTO booking_members (booking_id, slot_number, is_primary, trackman_booking_id)
                     VALUES ($1, $2, false, $3)`,
                    [placeholder.id, slot, row.bookingId]
                  );
                  
                  if (guestInfo?.name) {
                    await pool.query(
                      `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, trackman_booking_id)
                       VALUES ($1, $2, $3, $4, $5)
                       ON CONFLICT DO NOTHING`,
                      [placeholder.id, guestInfo.name, guestInfo.email || null, slot, row.bookingId]
                    );
                  }
                }
                
                if (mergeGuestPlayers.length > 0) {
                  process.stderr.write(`[Trackman Import] Created ${row.playerCount} member slots with ${mergeGuestPlayers.length} guest names for merged booking #${placeholder.id}\n`);
                }
              }
            } catch (memberErr: unknown) {
              process.stderr.write(`[Trackman Import] Failed to create booking_members for merged booking #${placeholder.id}: ${getErrorMessage(memberErr)}\n`);
            }
          }
          
          // Create billing session for merged booking if matched
          if (matchedEmail && parsedBayId && bookingDate && startTime) {
            try {
              const parsedPlayers = parseNotesForPlayers(row.notes);
              if (parsedPlayers.length > 0) {
                process.stderr.write(`[Trackman Import] Merged booking - parsed ${parsedPlayers.length} players from notes: ${parsedPlayers.map(p => `${p.type}:${p.name||p.email||'unknown'}`).join(', ')}\n`);
              }
              await createTrackmanSessionAndParticipants({
                bookingId: placeholder.id,
                trackmanBookingId: row.bookingId,
                resourceId: parsedBayId,
                sessionDate: bookingDate,
                startTime: startTime,
                endTime: endTime,
                durationMinutes: row.durationMins,
                ownerEmail: matchedEmail,
                ownerName: row.userName || 'Unknown',
                parsedPlayers: parsedPlayers,
                membersByEmail: membersByEmail,
                trackmanEmailMapping: trackmanEmailMapping,
                isPast: !isUpcoming
              });
            } catch (sessionErr: unknown) {
              process.stderr.write(`[Trackman Import] Session creation failed for merged booking #${placeholder.id}: ${getErrorMessage(sessionErr)}\n`);
            }
          }
          
          // Auto-resolve legacy entry if exists
          if (legacyIsUnresolved && existingUnmatched[0]) {
            try {
              await db.update(trackmanUnmatchedBookings)
                .set({ 
                  resolvedAt: new Date(),
                  resolvedBy: 'trackman_import_merge',
                  notes: sql`COALESCE(notes, '') || ' [Auto-resolved: merged with placeholder]'`
                })
                .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
            } catch (e: unknown) { /* non-blocking */ }
          }
          
          updatedRows++;
          continue;
        }
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
              sessionId: bookingRequests.sessionId,
              declaredPlayerCount: bookingRequests.declaredPlayerCount,
              guestCount: bookingRequests.guestCount,
              staffNotes: bookingRequests.staffNotes
            })
              .from(bookingRequests)
              .where(sql`
                LOWER(user_email) = LOWER(${matchedEmail})
                AND request_date = ${bookingDate}
                AND start_time = ${startTime}
                AND resource_id = ${parsedBayId}
                AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
              `)
              .limit(1);

            if (existingAppBooking.length > 0) {
              const existing = existingAppBooking[0];
              if (!existing.trackmanBookingId) {
                // Link Trackman ID to existing app booking with sync tracking
                // Preserve request's player count - only update trackmanPlayerCount, not declaredPlayerCount
                const updateFields: Record<string, unknown> = { 
                  trackmanBookingId: row.bookingId,
                  trackmanPlayerCount: row.playerCount,
                  lastSyncSource: 'trackman_import',
                  lastTrackmanSyncAt: new Date(),
                  updatedAt: new Date()
                };
                
                // Check for player count mismatch (Trackman > request)
                const requestPlayerCount = existing.declaredPlayerCount || 0;
                if (requestPlayerCount > 0 && row.playerCount > requestPlayerCount) {
                  updateFields.playerCountMismatch = true;
                  const warningNote = `[Warning: Trackman reports ${row.playerCount} players but app request only declared ${requestPlayerCount}]`;
                  const existingStaffNotes = existing.staffNotes || '';
                  if (!existingStaffNotes.includes('[Warning: Trackman reports')) {
                    updateFields.staffNotes = existingStaffNotes ? `${warningNote} ${existingStaffNotes}` : warningNote;
                  }
                  process.stderr.write(`[Trackman Import] MISMATCH: Linking booking #${existing.id} - Trackman reports ${row.playerCount} players but app request declared ${requestPlayerCount}\n`);
                }
                
                await db.update(bookingRequests)
                  .set(updateFields)
                  .where(eq(bookingRequests.id, existing.id));
                
                // Create player slots for this linked booking
                // Use request's declared player count as source of truth
                const targetPlayerCount = requestPlayerCount > 0 ? requestPlayerCount : row.playerCount;
                
                if (targetPlayerCount >= 1) {
                  // Check if booking_members already exist (preserve existing participants)
                  const existingMembers = await db.select({ 
                    id: bookingMembers.id,
                    slotNumber: bookingMembers.slotNumber,
                    userEmail: bookingMembers.userEmail
                  })
                    .from(bookingMembers)
                    .where(eq(bookingMembers.bookingId, existing.id));
                  
                  // Build set of existing slot numbers to preserve them
                  const existingSlotNumbers = new Set(existingMembers.map(m => m.slotNumber));
                  
                  // Only create missing slots (don't duplicate)
                  for (let slot = 1; slot <= targetPlayerCount; slot++) {
                    if (!existingSlotNumbers.has(slot)) {
                      const isPrimary = slot === 1;
                      await db.insert(bookingMembers).values({
                        bookingId: existing.id,
                        userEmail: isPrimary ? matchedEmail : null,
                        slotNumber: slot,
                        isPrimary: isPrimary,
                        trackmanBookingId: row.bookingId,
                        linkedAt: isPrimary ? new Date() : null,
                        linkedBy: isPrimary ? 'trackman_import' : null
                      });
                    }
                  }
                  
                  if (existingMembers.length > 0) {
                    process.stderr.write(`[Trackman Import] Preserved ${existingMembers.length} existing booking_members for booking #${existing.id}\n`);
                  }
                  
                  const linkedParsedPlayersForGuests = parseNotesForPlayers(row.notes);
                  const linkedGuestPlayers = linkedParsedPlayersForGuests.filter(p => p.type === 'guest');
                  
                  for (let gi = 0; gi < linkedGuestPlayers.length; gi++) {
                    const guest = linkedGuestPlayers[gi];
                    const guestSlotNumber = gi + 2;
                    if (guestSlotNumber <= targetPlayerCount && guest.name) {
                      const existingGuest = await pool.query(
                        `SELECT id FROM booking_guests WHERE booking_id = $1 AND slot_number = $2`,
                        [existing.id, guestSlotNumber]
                      );
                      if (existingGuest.rows.length === 0) {
                        await pool.query(
                          `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, trackman_booking_id)
                           VALUES ($1, $2, $3, $4, $5)`,
                          [existing.id, guest.name, guest.email || null, guestSlotNumber, row.bookingId]
                        );
                        process.stderr.write(`[Trackman Import] Created booking_guest slot ${guestSlotNumber} for linked booking #${existing.id}: ${guest.name}\n`);
                      }
                    }
                  }
                }
                
                // Create booking_session for linked booking
                const linkedParsedPlayers = parseNotesForPlayers(row.notes);
                if (linkedParsedPlayers.length > 0) {
                  process.stderr.write(`[Trackman Import] Linked booking - parsed ${linkedParsedPlayers.length} players from notes: ${linkedParsedPlayers.map(p => `${p.type}:${p.name||p.email||'unknown'}`).join(', ')}\n`);
                }
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
                
                // Auto-resolve legacy entry if it exists
                if (legacyIsUnresolved && existingUnmatched[0]) {
                  try {
                    await db.update(trackmanUnmatchedBookings)
                      .set({ 
                        resolvedAt: new Date(),
                        resolvedBy: 'trackman_import_link',
                        notes: sql`COALESCE(notes, '') || ' [Auto-resolved: linked to app booking]'`
                      })
                      .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
                  } catch (e: unknown) { /* non-blocking */ }
                }
                
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
                  
                  // Update only trackmanPlayerCount (preserve declaredPlayerCount from app request)
                  await db.update(bookingRequests)
                    .set({ 
                      trackmanPlayerCount: row.playerCount
                    })
                    .where(eq(bookingRequests.id, existing.id));
                  
                  process.stderr.write(`[Trackman Import] Backfilled session for matched booking #${existing.id} (Trackman ID: ${row.bookingId})\n`);
                }
                
                // Auto-resolve legacy entry if it exists
                if (legacyIsUnresolved && existingUnmatched[0]) {
                  try {
                    await db.update(trackmanUnmatchedBookings)
                      .set({ 
                        resolvedAt: new Date(),
                        resolvedBy: 'trackman_import_existing',
                        notes: sql`COALESCE(notes, '') || ' [Auto-resolved: booking already exists]'`
                      })
                      .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
                  } catch (e: unknown) { /* non-blocking */ }
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
              startTime: bookingRequests.startTime,
              declaredPlayerCount: bookingRequests.declaredPlayerCount,
              staffNotes: bookingRequests.staffNotes
            })
              .from(bookingRequests)
              .where(sql`
                LOWER(user_email) = LOWER(${matchedEmail})
                AND request_date = ${bookingDate}
                AND resource_id = ${parsedBayId}
                AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
                AND trackman_booking_id IS NULL
              `);
            
            // Filter by time tolerance
            const matchesWithinTolerance = potentialMatches.filter(m => 
              m.startTime && isTimeWithinTolerance(startTime, m.startTime, 5)
            );
            
            if (matchesWithinTolerance.length === 1) {
              // Exactly one match within tolerance - auto-link with sync tracking
              const existing = matchesWithinTolerance[0];
              
              // Preserve request's player count - only update trackmanPlayerCount
              const updateFields: Record<string, unknown> = { 
                trackmanBookingId: row.bookingId,
                trackmanPlayerCount: row.playerCount,
                lastSyncSource: 'trackman_import',
                lastTrackmanSyncAt: new Date(),
                updatedAt: new Date()
              };
              
              // Check for player count mismatch (Trackman > request)
              const requestPlayerCount = existing.declaredPlayerCount || 0;
              if (requestPlayerCount > 0 && row.playerCount > requestPlayerCount) {
                updateFields.playerCountMismatch = true;
                const warningNote = `[Warning: Trackman reports ${row.playerCount} players but app request only declared ${requestPlayerCount}]`;
                const existingStaffNotes = existing.staffNotes || '';
                if (!existingStaffNotes.includes('[Warning: Trackman reports')) {
                  updateFields.staffNotes = existingStaffNotes ? `${warningNote} ${existingStaffNotes}` : warningNote;
                }
                process.stderr.write(`[Trackman Import] MISMATCH: Tolerance linking booking #${existing.id} - Trackman reports ${row.playerCount} players but app request declared ${requestPlayerCount}\n`);
              }
              
              await db.update(bookingRequests)
                .set(updateFields)
                .where(eq(bookingRequests.id, existing.id));
              
              // Create player slots for this linked booking
              // Use request's declared player count as source of truth
              const targetPlayerCount = requestPlayerCount > 0 ? requestPlayerCount : row.playerCount;
              
              if (targetPlayerCount >= 1) {
                const existingMembers = await db.select({ 
                  id: bookingMembers.id,
                  slotNumber: bookingMembers.slotNumber
                })
                  .from(bookingMembers)
                  .where(eq(bookingMembers.bookingId, existing.id));
                
                // Build set of existing slot numbers to preserve them
                const existingSlotNumbers = new Set(existingMembers.map(m => m.slotNumber));
                
                // Only create missing slots (don't duplicate)
                for (let slot = 1; slot <= targetPlayerCount; slot++) {
                  if (!existingSlotNumbers.has(slot)) {
                    const isPrimary = slot === 1;
                    await db.insert(bookingMembers).values({
                      bookingId: existing.id,
                      userEmail: isPrimary ? matchedEmail : null,
                      slotNumber: slot,
                      isPrimary: isPrimary,
                      trackmanBookingId: row.bookingId,
                      linkedAt: isPrimary ? new Date() : null,
                      linkedBy: isPrimary ? 'trackman_import' : null
                    });
                  }
                }
                
                if (existingMembers.length > 0) {
                  process.stderr.write(`[Trackman Import] Preserved ${existingMembers.length} existing booking_members for booking #${existing.id} (tolerance match)\n`);
                }
                
                const toleranceParsedPlayersForGuests = parseNotesForPlayers(row.notes);
                const toleranceGuestPlayers = toleranceParsedPlayersForGuests.filter(p => p.type === 'guest');
                
                for (let gi = 0; gi < toleranceGuestPlayers.length; gi++) {
                  const guest = toleranceGuestPlayers[gi];
                  const guestSlotNumber = gi + 2;
                  if (guestSlotNumber <= targetPlayerCount && guest.name) {
                    const existingGuest = await pool.query(
                      `SELECT id FROM booking_guests WHERE booking_id = $1 AND slot_number = $2`,
                      [existing.id, guestSlotNumber]
                    );
                    if (existingGuest.rows.length === 0) {
                      await pool.query(
                        `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, trackman_booking_id)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [existing.id, guest.name, guest.email || null, guestSlotNumber, row.bookingId]
                      );
                      process.stderr.write(`[Trackman Import] Created booking_guest slot ${guestSlotNumber} for tolerance-matched booking #${existing.id}: ${guest.name}\n`);
                    }
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
              
              // Auto-resolve legacy entry if it exists
              if (legacyIsUnresolved && existingUnmatched[0]) {
                try {
                  await db.update(trackmanUnmatchedBookings)
                    .set({ 
                      resolvedAt: new Date(),
                      resolvedBy: 'trackman_import_link',
                      notes: sql`COALESCE(notes, '') || ' [Auto-resolved: linked to app booking]'`
                    })
                    .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
                } catch (e: unknown) { /* non-blocking */ }
              }
              
              linkedRows++;
              continue;
            } else if (matchesWithinTolerance.length > 1) {
              // Multiple matches - log as potential match, don't auto-link
              process.stderr.write(`[Trackman Import] Potential match - requires staff confirmation: Trackman ID ${row.bookingId} has ${matchesWithinTolerance.length} possible matches for ${matchedEmail} on ${bookingDate} at ${startTime}\n`);
              // Continue to create new booking - staff can resolve via potential-matches endpoint
            }
          }

          // PRIORITY: Check if a ghost booking already exists with this trackman_booking_id
          // This prevents creating duplicates when CSV re-imports a booking that was already
          // created by webhook as a ghost/placeholder booking
          const existingByTrackmanId = await db.select({
            id: bookingRequests.id,
            trackmanBookingId: bookingRequests.trackmanBookingId,
            userEmail: bookingRequests.userEmail,
            status: bookingRequests.status,
            sessionId: bookingRequests.sessionId,
            isUnmatched: bookingRequests.isUnmatched,
          }).from(bookingRequests)
            .where(eq(bookingRequests.trackmanBookingId, row.bookingId))
            .limit(1);

          if (existingByTrackmanId.length > 0) {
            const existingGhost = existingByTrackmanId[0];
            const ghostUpdateStatus = matchedEmail ? 'approved' : (normalizedStatus || existingGhost.status);

            const ghostUpdateFields: Record<string, unknown> = {
              userName: row.userName || undefined,
              startTime: startTime,
              endTime: endTime,
              durationMinutes: row.durationMins,
              trackmanPlayerCount: row.playerCount,
              declaredPlayerCount: row.playerCount,
              notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
              trackmanCustomerNotes: row.notes || null,
              isUnmatched: !matchedEmail,
              status: ghostUpdateStatus,
              lastSyncSource: 'trackman_import',
              lastTrackmanSyncAt: new Date(),
              updatedAt: new Date(),
              origin: 'trackman_import',
            };

            if (matchedEmail) {
              ghostUpdateFields.userEmail = matchedEmail;
            }
            if (parsedBayId) {
              ghostUpdateFields.resourceId = parsedBayId;
            }
            if (bookingDate) {
              ghostUpdateFields.requestDate = bookingDate;
            }

            await db.update(bookingRequests)
              .set(ghostUpdateFields)
              .where(eq(bookingRequests.id, existingGhost.id));

            process.stderr.write(`[Trackman Import] UPDATED ghost booking #${existingGhost.id} (trackman_booking_id=${row.bookingId}) instead of creating duplicate${matchedEmail ? `, assigned to ${matchedEmail}` : ''}\n`);

            if (matchedEmail) {
              try {
                const existingMembers = await pool.query(
                  `SELECT id FROM booking_members WHERE booking_id = $1`,
                  [existingGhost.id]
                );

                if (existingMembers.rows.length === 0) {
                  const ghostParsedPlayers = parseNotesForPlayers(row.notes);
                  const ghostGuestPlayers = ghostParsedPlayers.filter(p => p.type === 'guest');

                  await pool.query(
                    `INSERT INTO booking_members (booking_id, user_email, slot_number, is_primary, trackman_booking_id, linked_at, linked_by)
                     VALUES ($1, $2, 1, true, $3, NOW(), 'trackman_import')`,
                    [existingGhost.id, matchedEmail, row.bookingId]
                  );

                  for (let slot = 2; slot <= row.playerCount; slot++) {
                    const guestIndex = slot - 2;
                    const guestInfo = guestIndex < ghostGuestPlayers.length ? ghostGuestPlayers[guestIndex] : null;

                    await pool.query(
                      `INSERT INTO booking_members (booking_id, slot_number, is_primary, trackman_booking_id)
                       VALUES ($1, $2, false, $3)`,
                      [existingGhost.id, slot, row.bookingId]
                    );

                    if (guestInfo?.name) {
                      await pool.query(
                        `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, trackman_booking_id)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT DO NOTHING`,
                        [existingGhost.id, guestInfo.name, guestInfo.email || null, slot, row.bookingId]
                      );
                    }
                  }

                  if (ghostGuestPlayers.length > 0) {
                    process.stderr.write(`[Trackman Import] Created ${row.playerCount} member slots with ${ghostGuestPlayers.length} guest names for updated ghost booking #${existingGhost.id}\n`);
                  }
                }
              } catch (memberErr: unknown) {
                process.stderr.write(`[Trackman Import] Failed to create booking_members for ghost booking #${existingGhost.id}: ${getErrorMessage(memberErr)}\n`);
              }

              if (parsedBayId && bookingDate && startTime && !existingGhost.sessionId) {
                try {
                  const ghostSessionPlayers = parseNotesForPlayers(row.notes);
                  await createTrackmanSessionAndParticipants({
                    bookingId: existingGhost.id,
                    trackmanBookingId: row.bookingId,
                    resourceId: parsedBayId,
                    sessionDate: bookingDate,
                    startTime: startTime,
                    endTime: endTime,
                    durationMinutes: row.durationMins,
                    ownerEmail: matchedEmail,
                    ownerName: row.userName || 'Unknown',
                    parsedPlayers: ghostSessionPlayers,
                    membersByEmail: membersByEmail,
                    trackmanEmailMapping: trackmanEmailMapping,
                    isPast: !isUpcoming
                  });
                } catch (sessionErr: unknown) {
                  process.stderr.write(`[Trackman Import] Session creation failed for ghost booking #${existingGhost.id}: ${getErrorMessage(sessionErr)}\n`);
                }
              }
            }

            if (legacyIsUnresolved && existingUnmatched[0]) {
              try {
                await db.update(trackmanUnmatchedBookings)
                  .set({
                    resolvedAt: new Date(),
                    resolvedBy: 'trackman_import_ghost_update',
                    notes: sql`COALESCE(notes, '') || ' [Auto-resolved: ghost booking updated with member info]'`
                  })
                  .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
              } catch (e: unknown) { /* non-blocking */ }
            }

            updatedRows++;
            continue;
          }

          const originalBookedDate = row.bookedDate ? new Date(row.bookedDate.replace(' ', 'T') + ':00') : null;
          
          // Parse notes BEFORE insert to count actual guests
          const parsedPlayers = parseNotesForPlayers(row.notes);
          const actualGuestCount = parsedPlayers.filter(p => p.type === 'guest').length;
          if (parsedPlayers.length > 0) {
            process.stderr.write(`[Trackman Import] Parsed ${parsedPlayers.length} players from notes: ${parsedPlayers.map(p => `${p.type}:${p.name||p.email||'unknown'}`).join(', ')}\n`);
          }
          
          const insertResult = await db.insert(bookingRequests).values({
            userEmail: matchedEmail,
            userName: row.userName,
            resourceId: parsedBayId,
            requestDate: bookingDate,
            startTime: startTime,
            durationMinutes: row.durationMins,
            endTime: endTime,
            notes: `[Trackman Import ID:${row.bookingId}] ${row.notes}`,
            status: matchedEmail ? 'approved' : normalizedStatus,
            createdAt: originalBookedDate || new Date(),
            trackmanBookingId: row.bookingId,
            originalBookedDate: originalBookedDate,
            guestCount: actualGuestCount,
            trackmanPlayerCount: row.playerCount,
            declaredPlayerCount: row.playerCount,
            origin: 'trackman_import',
            lastSyncSource: 'trackman_import',
            lastTrackmanSyncAt: new Date(),
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
            
            // Get parsed player objects (with name and email) for name matching
            const memberPlayers = parsedPlayers.filter(p => p.type === 'member' && p.email);
            
            for (const memberPlayer of memberPlayers) {
              const memberEmail = memberPlayer.email!.toLowerCase();
              const memberName = memberPlayer.name || '';
              
              // Resolve member email to check if it's the same person as owner
              const memberResolvedEmail = resolveEmail(memberEmail, membersByEmail, trackmanEmailMapping);
              
              // Skip if this member is the same person as the owner
              // Check both resolved emails AND database-linked emails
              if (memberResolvedEmail === ownerResolvedEmail) {
                continue;
              }
              
              // Also check if this email is linked to the owner in the database
              // (handles cases where trackman_email or manually_linked_emails aren't in the CSV mapping)
              let isLinkedToOwner = await isEmailLinkedToUser(memberEmail, matchedEmail);
              if (isLinkedToOwner) {
                process.stderr.write(`[Trackman Import] Skipping M: ${memberEmail} - linked to owner ${matchedEmail}\n`);
                continue;
              }
              
              // Check if this email exists in our members database
              const memberExists = membersByEmail.get(memberEmail) || trackmanEmailMapping.get(memberEmail);
              
              // For solo bookings: if M: email is unresolved but M: name matches owner name,
              // auto-link the email to the owner's manually_linked_emails for future imports.
              // This handles staff entering non-standard emails that don't match member records.
              // Control flow: if auto-link succeeds, we skip slot allocation entirely.
              // For solo bookings, memberSlot=2 > playerCount=1 also prevents duplicate insertion.
              if (!memberExists && row.playerCount === 1 && memberName) {
                if (areNamesSimilar(memberName, row.userName)) {
                  const linked = await autoLinkEmailToOwner(memberEmail, matchedEmail, 
                    `Solo booking name match: "${memberName}" ~ "${row.userName}"`);
                  if (linked) {
                    continue;
                  }
                }
              }
              
              // For multi-player bookings: try name-based matching to identify unmatched M: entries
              // If we find a unique name match, auto-link the Trackman email to that member
              let resolvedMemberEmail = memberExists;
              let skipAsDuplicateOwner = false;
              
              if (!memberExists && memberName) {
                const nameMatch = await findMembersByName(memberName);
                if (nameMatch.match === 'unique') {
                  const matchedMember = nameMatch.members[0];
                  
                  // Check if this name-matched member is the same as the booking owner
                  // This prevents adding the owner as a guest under their own booking
                  if (matchedMember.email.toLowerCase() === matchedEmail.toLowerCase()) {
                    process.stderr.write(`[Trackman Import] Name-match "${memberName}" resolved to owner ${matchedEmail} - skipping duplicate\n`);
                    // Still auto-link the alternate email for future imports
                    if (memberEmail !== matchedEmail.toLowerCase()) {
                      await autoLinkEmailToOwner(
                        memberEmail,
                        matchedEmail,
                        `Owner name-match auto-link: "${memberName}" is owner, linking ${memberEmail}`
                      );
                    }
                    skipAsDuplicateOwner = true;
                  } else {
                    // Auto-link the Trackman email to this member for future imports
                    if (memberEmail !== matchedMember.email.toLowerCase()) {
                      await autoLinkEmailToOwner(
                        memberEmail,
                        matchedMember.email,
                        `Multi-player name-match: "${memberName}" matched to ${matchedMember.email}`
                      );
                    }
                    
                    resolvedMemberEmail = matchedMember.email;
                    process.stderr.write(`[Trackman Import] Name-matched "${memberName}" to ${matchedMember.email} for booking_members\n`);
                  }
                }
              }
              
              // Skip this M: entry if it resolved to the booking owner
              if (skipAsDuplicateOwner) {
                continue;
              }
              
              if (memberSlot <= row.playerCount) {
                await db.insert(bookingMembers).values({
                  bookingId: bookingId,
                  userEmail: resolvedMemberEmail || memberEmail, // Use resolved email if matched, otherwise placeholder
                  slotNumber: memberSlot,
                  isPrimary: false,
                  trackmanBookingId: row.bookingId,
                  linkedAt: new Date(),
                  linkedBy: 'trackman_import'
                });
                
                // Send notification to linked member for future bookings
                if (resolvedMemberEmail && normalizedStatus === 'approved' && isUpcoming) {
                  const linkedMessage = `You've been added to a simulator booking on ${formatNotificationDateTime(bookingDate, startTime)}.`;
                  await db.insert(notifications).values({
                    userEmail: resolvedMemberEmail,
                    title: 'Added to Booking',
                    message: linkedMessage,
                    type: 'booking_approved',
                    relatedId: bookingId,
                    relatedType: 'booking_request'
                  });
                  sendPushNotification(resolvedMemberEmail, {
                    title: 'Added to Booking',
                    body: linkedMessage,
                    tag: `booking-linked-${bookingId}`
                  }).catch(() => {});
                }
                
                // Increment lifetime visits for linked members on attended bookings
                if (resolvedMemberEmail && normalizedStatus === 'attended') {
                  await db.execute(sql`
                    UPDATE users 
                    SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
                    WHERE email = ${resolvedMemberEmail}
                  `);
                }
                
                memberSlot++;
              }
            }
            
            // Create guest entries (skip if guest name matches owner name to prevent duplicates)
            const ownerNameNormalized = (row.userName || matchedEmail).toLowerCase().trim();
            for (const guest of guests) {
              const guestNameNormalized = (guest.name || '').toLowerCase().trim();
              
              // Skip if guest name matches owner name (prevents owner appearing as guest of their own booking)
              if (guestNameNormalized && (
                guestNameNormalized === ownerNameNormalized ||
                ownerNameNormalized.includes(guestNameNormalized) ||
                guestNameNormalized.includes(ownerNameNormalized.split(' ')[0])
              )) {
                process.stderr.write(`[Trackman Import] Skipping booking_guests entry for "${guest.name}" - matches owner name "${row.userName || matchedEmail}"\n`);
                continue;
              }
              
              await db.insert(bookingGuests).values({
                bookingId: bookingId,
                guestName: guest.name,
                guestEmail: guest.email,
                slotNumber: guestSlot,
                trackmanBookingId: row.bookingId
              });
              guestSlot++;
              
              // Guest pass logic: only try to use a guest pass if the guest has identifying info
              // (first name, last name, or email). Guests with no info at all always get a fee charged.
              const hasGuestInfo = !!(guest.name?.trim() || guest.email?.trim());
              if (hasGuestInfo) {
                const guestPassResult = await useGuestPass(matchedEmail, guest.name || undefined, isUpcoming);
                if (!guestPassResult.success) {
                  process.stderr.write(`[Trackman Import] Guest pass deduction failed for ${matchedEmail} (guest: ${guest.name}): ${guestPassResult.error}\n`);
                } else {
                  process.stderr.write(`[Trackman Import] Deducted guest pass for ${matchedEmail} (guest: ${guest.name}), ${guestPassResult.remaining} remaining\n`);
                }
              } else {
                process.stderr.write(`[Trackman Import] Guest has no identifying info - skipping guest pass, fee will be charged for ${matchedEmail}\n`);
              }
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
              process.stderr.write(`[Trackman Import] Push notification failed for ${matchedEmail}: ${getErrorMessage(err)}\n`);
            });
          }

          // Auto-resolve legacy entry if it exists - booking now tracked in booking_requests
          if (legacyIsUnresolved && existingUnmatched[0]) {
            try {
              await db.update(trackmanUnmatchedBookings)
                .set({ 
                  resolvedAt: new Date(),
                  resolvedBy: 'trackman_import_create',
                  resolvedEmail: matchedEmail,
                  notes: sql`COALESCE(notes, '') || ' [Auto-resolved: matched booking created]'`
                })
                .where(eq(trackmanUnmatchedBookings.id, existingUnmatched[0].id));
              process.stderr.write(`[Trackman Import] Auto-resolved legacy entry for booking ${row.bookingId} -> ${matchedEmail}\n`);
            } catch (e: unknown) { /* non-blocking */ }
          }

          matchedRows++;
        } catch (insertErr: unknown) {
          // Handle duplicate key violations gracefully (race condition with webhook)
          if (getErrorMessage(insertErr)?.includes('duplicate key') || getErrorCode(insertErr) === '23505') {
            process.stderr.write(`[Trackman Import] Booking ${row.bookingId} already exists (race with webhook) - skipping\n`);
            skippedRows++;
            continue;
          }
          const errDetails = (insertErr instanceof Error && insertErr.cause instanceof Error ? insertErr.cause.message : null) || getErrorCode(insertErr) || 'no details';
          process.stderr.write(`[Trackman Import] Insert error for ${row.bookingId}: ${getErrorMessage(insertErr)} | Details: ${errDetails}\n`);
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
        
        // Check if this booking was already converted to a private event block
        // This prevents duplicate bookings when re-importing CSVs after converting to blocks
        const alreadyConvertedToBlock = await isConvertedToPrivateEventBlock(
          parsedBayId,
          bookingDate,
          startTime,
          endTime
        );
        
        if (alreadyConvertedToBlock) {
          // Skip creating unmatched booking - this time slot is already blocked by a private event
          process.stderr.write(`[Trackman Import] Skipping unmatched booking ${row.bookingId} - already converted to private event block\n`);
          continue; // Skip to next row - no need to create duplicate unmatched entry
        }
        
        // CRITICAL: Create booking_request to block the time slot even for unmatched bookings
        // This ensures no double-booking regardless of member matching
        // Use null for userEmail - staff will manually assign via TrackmanLinkModal
        
        try {
          const unmatchedInsertResult = await db.insert(bookingRequests).values({
            userEmail: '',
            userName: row.userName,
            resourceId: parsedBayId,
            requestDate: bookingDate,
            startTime: startTime,
            durationMinutes: row.durationMins,
            endTime: endTime,
            notes: `[Trackman Import ID:${row.bookingId}] [UNMATCHED - requires staff resolution] ${row.notes}`,
            status: normalizedStatus,
            createdAt: row.bookedDate ? new Date(row.bookedDate.replace(' ', 'T') + ':00') : new Date(),
            trackmanBookingId: row.bookingId,
            trackmanPlayerCount: row.playerCount,
            declaredPlayerCount: row.playerCount,
            isUnmatched: true,
            trackmanCustomerNotes: `Original name: ${row.userName}, Original email: ${row.userEmail}`,
            origin: 'trackman_import',
            lastSyncSource: 'trackman_import',
            lastTrackmanSyncAt: new Date(),
          }).returning({ id: bookingRequests.id });
          
          process.stderr.write(`[Trackman Import] Created unmatched booking #${unmatchedInsertResult[0]?.id} to block slot (Trackman ID: ${row.bookingId})\n`);
        } catch (unmatchedErr: unknown) {
          // If booking already exists (unique constraint), just continue
          if (!getErrorMessage(unmatchedErr)?.includes('duplicate key')) {
            process.stderr.write(`[Trackman Import] Error creating unmatched booking for ${row.bookingId}: ${getErrorMessage(unmatchedErr)}\n`);
          }
        }
        
        // Also insert into trackmanUnmatchedBookings for staff resolution UI (only if not already there)
        if (!hasLegacyEntry) {
          try {
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
          } catch (legacyErr: unknown) {
            // Ignore duplicate key errors - entry already exists
            if (!getErrorMessage(legacyErr)?.includes('duplicate key')) {
              process.stderr.write(`[Trackman Import] Error creating legacy unmatched entry: ${getErrorMessage(legacyErr)}\n`);
            }
          }
        }

        unmatchedRows++;
      }
    } catch (err: unknown) {
      const dbError = (err instanceof Error && err.cause instanceof Error ? err.cause.message : null) || getErrorMessage(err);
      errors.push(`Row ${i}: ${dbError}`);
      skippedRows++;
    }
  }

  process.stderr.write(`[Trackman Import] Summary: mappingMatchCount=${mappingMatchCount}, mappingFoundButNotInDb=${mappingFoundButNotInDb}, matchedRows=${matchedRows}, linkedRows=${linkedRows}, unmatchedRows=${unmatchedRows}, skipped=${skippedRows}, skippedAsPrivateEventBlocks=${skippedAsPrivateEventBlocks}\n`);

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
  // FIX: Scope to CSV date range to prevent "wipeout" of future bookings not in partial CSV
  const todayStr = getTodayPacific();
  
  // Calculate date range from the imported CSV to prevent canceling bookings outside CSV scope
  let csvMinDate: string | null = null;
  let csvMaxDate: string | null = null;
  for (let i = 1; i < parsedRows.length; i++) {
    const fields = parsedRows[i];
    if (fields.length >= 9) {
      const dateStr = extractDate(fields[8]); // Start date column
      if (dateStr) {
        if (!csvMinDate || dateStr < csvMinDate) csvMinDate = dateStr;
        if (!csvMaxDate || dateStr > csvMaxDate) csvMaxDate = dateStr;
      }
    }
  }
  
  process.stderr.write(`[Trackman Import] CSV date range: ${csvMinDate || 'none'} to ${csvMaxDate || 'none'}\n`);
  
  // Only run cancellation logic if we have a valid date range
  const matchedToCancel = csvMinDate && csvMaxDate ? await db.select({ 
    id: bookingRequests.id, 
    trackmanBookingId: bookingRequests.trackmanBookingId,
    userName: bookingRequests.userName,
    userEmail: bookingRequests.userEmail,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    status: bookingRequests.status
  })
    .from(bookingRequests)
    .where(sql`
      trackman_booking_id IS NOT NULL 
      AND status NOT IN ('cancelled', 'attended', 'no_show', 'cancellation_pending')
      AND request_date >= ${csvMinDate}::date 
      AND request_date <= ${csvMaxDate}::date
    `) : [];
  
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
        
        // Cancel pending payment intents
        await cancelPendingPaymentIntentsForBooking(booking.id);
        
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
            process.stderr.write(`[Trackman Import] Push notification failed for cancellation ${booking.userEmail}: ${getErrorMessage(err)}\n`);
          });
        }
      }
    }
  }

  if (removedFromUnmatched > 0 || cancelledBookings > 0 || updatedRows > 0) {
    process.stderr.write(`[Trackman Import] Cleanup: removed ${removedFromUnmatched} unmatched, cancelled ${cancelledBookings} matched bookings, updated ${updatedRows} existing bookings\n`);
  }

  // POST-IMPORT CLEANUP: Auto-approve any pending bookings from this import that are linked to a member
  try {
    const autoApproved = await pool.query(
      `UPDATE booking_requests 
       SET status = 'approved', updated_at = NOW(), staff_notes = COALESCE(staff_notes, '') || ' [Auto-approved by import: member linked]'
       WHERE origin = 'trackman_import'
       AND status = 'pending'
       AND user_email IS NOT NULL 
       AND user_email != ''
       AND is_unmatched IS NOT TRUE
       AND last_trackman_sync_at >= NOW() - INTERVAL '1 hour'
       RETURNING id, user_email, user_name`
    );
    
    if (autoApproved.rows.length > 0) {
      process.stderr.write(`[Trackman Import] Post-import cleanup: Auto-approved ${autoApproved.rows.length} pending member-linked bookings\n`);
      for (const approved of autoApproved.rows) {
        process.stderr.write(`[Trackman Import]   Auto-approved booking #${approved.id} for ${approved.user_name || approved.user_email}\n`);
      }
    }
  } catch (cleanupErr: unknown) {
    process.stderr.write(`[Trackman Import] Post-import cleanup error: ${getErrorMessage(cleanupErr)}\n`);
  }

  await db.insert(trackmanImportRuns).values({
    filename: path.basename(csvPath),
    totalRows: parsedRows.length - 1,
    matchedRows,
    unmatchedRows,
    skippedRows,
    importedBy
  });

  // Alert staff on import issues (errors or low match rate)
  await alertOnTrackmanImportIssues({
    totalRows: parsedRows.length - 1,
    matchedRows,
    unmatchedRows,
    skippedRows,
    errors
  });

  return {
    totalRows: parsedRows.length - 1,
    matchedRows,
    linkedRows,
    unmatchedRows,
    skippedRows,
    skippedAsPrivateEventBlocks,
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
}): Promise<{ data: Record<string, unknown>[]; totalCount: number }> {
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
        AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
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

  let insertResult;
  try {
    insertResult = await db.insert(bookingRequests).values({
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
  } catch (insertErr: unknown) {
    // Handle duplicate key violations gracefully (race condition)
    if (getErrorMessage(insertErr)?.includes('duplicate key') || getErrorCode(insertErr) === '23505') {
      process.stderr.write(`[Trackman Import] Booking ${booking.trackmanBookingId} already exists (race condition) - skipping\n`);
      return { inserted: false, reason: 'Already imported (race condition)' };
    }
    throw insertErr;
  }

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
    
    // Create guest entries if notes have G: format (skip if guest name matches owner name)
    const guests = parsedPlayers.filter(p => p.type === 'guest');
    const ownerNameNormalized = (booking.userName || memberEmail).toLowerCase().trim();
    let guestSlotNumber = 1;
    for (let i = 0; i < guests.length; i++) {
      const guestNameNormalized = (guests[i].name || '').toLowerCase().trim();
      
      // Skip if guest name matches owner name (prevents owner appearing as guest of their own booking)
      if (guestNameNormalized && (
        guestNameNormalized === ownerNameNormalized ||
        ownerNameNormalized.includes(guestNameNormalized) ||
        guestNameNormalized.includes(ownerNameNormalized.split(' ')[0])
      )) {
        process.stderr.write(`[Trackman Import] Skipping booking_guests entry for "${guests[i].name}" - matches owner name "${booking.userName || memberEmail}"\n`);
        continue;
      }
      
      await db.insert(bookingGuests).values({
        bookingId: bookingId,
        guestName: guests[i].name,
        guestEmail: guests[i].email,
        slotNumber: guestSlotNumber,
        trackmanBookingId: booking.trackmanBookingId
      });
      guestSlotNumber++;
      
      // Guest pass logic: only try to use a guest pass if the guest has identifying info
      // (first name, last name, or email). Guests with no info at all always get a fee charged.
      const hasGuestInfo = !!(guests[i].name?.trim() || guests[i].email?.trim());
      if (hasGuestInfo) {
        const guestPassResult = await useGuestPass(memberEmail, guests[i].name || undefined, isUpcoming);
        if (!guestPassResult.success) {
          process.stderr.write(`[Trackman Import] Guest pass deduction failed for ${memberEmail} (guest: ${guests[i].name}): ${guestPassResult.error}\n`);
        } else {
          process.stderr.write(`[Trackman Import] Deducted guest pass for ${memberEmail} (guest: ${guests[i].name}), ${guestPassResult.remaining} remaining\n`);
        }
      } else {
        process.stderr.write(`[Trackman Import] Guest has no identifying info - skipping guest pass, fee will be charged for ${memberEmail}\n`);
      }
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

  // CRITICAL FIX: Create Session & Ledger if this is a new booking
  // This ensures billing is properly tracked for resolved bookings
  if (insertResult.inserted && insertResult.bookingId) {
    // IDEMPOTENCY: Check if booking already has a session (from previous resolve attempt)
    const existingSession = await db.execute(sql`
      SELECT session_id FROM booking_requests WHERE id = ${insertResult.bookingId} AND session_id IS NOT NULL
    `);
    
    if ((existingSession.rows as Record<string, unknown>[]).length === 0 || !(existingSession.rows[0] as Record<string, unknown>)?.session_id) {
      const bookingDate = booking.bookingDate ? new Date(booking.bookingDate).toISOString().split('T')[0] : '';
      const startTime = booking.startTime?.toString() || '';
      const endTime = booking.endTime?.toString() || '';
      
      // Parse players from notes to ensure accurate billing (guests vs members)
      const parsedPlayers = parseNotesForPlayers(booking.notes || '');
      const resourceId = parseInt(booking.bayNumber || '0') || 1;
      const isPast = insertResult.finalStatus === 'attended' || insertResult.finalStatus === 'completed';

      try {
        // Use stable trackman_booking_id if available, otherwise use booking ID
        const stableTrackmanId = booking.trackmanBookingId || `booking-${insertResult.bookingId}`;
        
        await createTrackmanSessionAndParticipants({
          bookingId: insertResult.bookingId,
          trackmanBookingId: stableTrackmanId,
          resourceId,
          sessionDate: bookingDate,
          startTime,
          endTime,
          durationMinutes: booking.durationMinutes || 60,
          ownerEmail: memberEmail,
          ownerName: booking.userName || 'Unknown',
          parsedPlayers,
          membersByEmail: new Map(),
          trackmanEmailMapping: new Map(),
          isPast
        });
        process.stderr.write(`[Trackman Resolve] Created Session & Ledger for Booking #${insertResult.bookingId}\n`);
      } catch (sessionErr: unknown) {
        process.stderr.write(`[Trackman Resolve] Warning: Session creation failed for Booking #${insertResult.bookingId}: ${sessionErr}\n`);
      }
    } else {
      process.stderr.write(`[Trackman Resolve] Booking #${insertResult.bookingId} already has session, skipping creation\n`);
    }
  }

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

      // CRITICAL FIX: Create Session & Ledger for auto-resolved bookings too
      if (otherResult.inserted && otherResult.bookingId) {
        // IDEMPOTENCY: Check if booking already has a session
        const otherExistingSession = await db.execute(sql`
          SELECT session_id FROM booking_requests WHERE id = ${otherResult.bookingId} AND session_id IS NOT NULL
        `);
        
        if ((otherExistingSession.rows as Record<string, unknown>[]).length === 0 || !(otherExistingSession.rows[0] as Record<string, unknown>)?.session_id) {
          const otherBookingDate = other.bookingDate ? new Date(other.bookingDate).toISOString().split('T')[0] : '';
          const otherStartTime = other.startTime?.toString() || '';
          const otherEndTime = other.endTime?.toString() || '';
          const otherParsedPlayers = parseNotesForPlayers(other.notes || '');
          const otherResourceId = parseInt(other.bayNumber || '0') || 1;
          const otherIsPast = otherResult.finalStatus === 'attended' || otherResult.finalStatus === 'completed';

          try {
            // Use stable trackman_booking_id if available, otherwise use booking ID
            const otherStableTrackmanId = other.trackmanBookingId || `booking-${otherResult.bookingId}`;
            
            await createTrackmanSessionAndParticipants({
              bookingId: otherResult.bookingId,
              trackmanBookingId: otherStableTrackmanId,
              resourceId: otherResourceId,
              sessionDate: otherBookingDate,
              startTime: otherStartTime,
              endTime: otherEndTime,
              durationMinutes: other.durationMinutes || 60,
              ownerEmail: memberEmail,
              ownerName: other.userName || 'Unknown',
              parsedPlayers: otherParsedPlayers,
              membersByEmail: new Map(),
              trackmanEmailMapping: new Map(),
              isPast: otherIsPast
            });
            process.stderr.write(`[Trackman Resolve] Created Session & Ledger for auto-resolved Booking #${otherResult.bookingId}\n`);
          } catch (sessionErr: unknown) {
            process.stderr.write(`[Trackman Resolve] Warning: Session creation failed for auto-resolved Booking #${otherResult.bookingId}: ${sessionErr}\n`);
          }
        } else {
          process.stderr.write(`[Trackman Resolve] Auto-resolved Booking #${otherResult.bookingId} already has session, skipping\n`);
        }
      }

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

/**
 * Re-scan unmatched Trackman bookings against current member list
 * This finds bookings that couldn't be matched during import but may now match
 * after new members have been synced from HubSpot (including former members)
 */
export async function rescanUnmatchedBookings(performedBy: string = 'system'): Promise<{
  scanned: number;
  matched: number;
  lessonsConverted: number;
  resolved: { trackmanId: string; memberEmail: string; matchReason: string }[];
  errors: string[];
}> {
  const resolved: { trackmanId: string; memberEmail: string; matchReason: string }[] = [];
  const errors: string[] = [];
  let lessonsConverted = 0;
  
  // Fetch all unresolved unmatched bookings
  const unmatchedBookings = await db.select()
    .from(trackmanUnmatchedBookings)
    .where(sql`resolved_at IS NULL`);
  
  if (unmatchedBookings.length === 0) {
    return { scanned: 0, matched: 0, lessonsConverted: 0, resolved: [], errors: [] };
  }
  
  process.stderr.write(`[Trackman Rescan] Starting rescan of ${unmatchedBookings.length} unmatched bookings\n`);
  
  // Fetch golf instructor emails for lesson detection
  const instructorEmails = await getGolfInstructorEmails();
  process.stderr.write(`[Trackman Rescan] Loaded ${instructorEmails.length} golf instructor emails for lesson detection\n`);
  
  // Fetch all members (active + former) from HubSpot for matching
  const hubSpotMembers = await getAllHubSpotMembers();
  
  if (hubSpotMembers.length === 0) {
    return { 
      scanned: unmatchedBookings.length, 
      matched: 0, 
      lessonsConverted: 0,
      resolved: [], 
      errors: ['HubSpot unavailable - cannot fetch members for matching'] 
    };
  }
  
  // Build member lookup maps
  const membersByName = new Map<string, string[]>();
  const membersByEmail = new Map<string, string>();
  
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
  
  process.stderr.write(`[Trackman Rescan] Loaded ${membersByEmail.size} members for matching\n`);
  
  // Load email mappings (from CSV and database)
  const emailMapping = await loadEmailMapping();
  
  // Load trackman_email mappings from database
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
  } catch (err: unknown) {
    process.stderr.write(`[Trackman Rescan] Error loading trackman_email mappings: ${getErrorMessage(err)}\n`);
  }
  
  let matchedCount = 0;
  
  for (const booking of unmatchedBookings) {
    try {
      const originalEmail = booking.originalEmail || '';
      const userName = booking.userName || '';
      const notes = booking.notes || '';
      
      // CRITICAL: Resolve email aliases BEFORE checking if they're an instructor
      // This handles cases like rebecca.bentham@evenhouse.club -> rebecca@evenhouse.club
      const rawEmailLower = originalEmail.toLowerCase().trim();
      const resolvedEmail = emailMapping.get(rawEmailLower) || 
                           trackmanEmailMapping.get(rawEmailLower) || 
                           rawEmailLower;
      
      // Check if this is a golf instructor lesson booking BEFORE member matching
      const isInstructorEmail = resolvedEmail && (
        instructorEmails.includes(resolvedEmail.toLowerCase()) ||
        instructorEmails.includes(rawEmailLower)
      );
      const containsLessonKeyword = userName.toLowerCase().includes('lesson') || notes.toLowerCase().includes('lesson');
      
      if (isInstructorEmail || containsLessonKeyword) {
        // This is a lesson booking - convert to availability block
        const resourceId = parseInt(booking.bayNumber || '') || null;
        const bookingDate = booking.bookingDate ? 
          ((booking.bookingDate as string | Date) instanceof Date ? (booking.bookingDate as Date).toISOString().split('T')[0] : booking.bookingDate) : null;
        const startTime = booking.startTime?.toString() || null;
        const endTime = booking.endTime?.toString() || startTime;
        
        if (resourceId && resourceId > 0 && bookingDate && startTime) {
          // Check if block already exists for this time slot
          const existingBlock = await pool.query(`
            SELECT ab.id FROM availability_blocks ab
            JOIN facility_closures fc ON ab.closure_id = fc.id
            WHERE ab.resource_id = $1
              AND ab.block_date = $2
              AND ab.start_time < $4::time
              AND ab.end_time > $3::time
              AND fc.notice_type = 'private_event'
              AND fc.is_active = true
            LIMIT 1
          `, [resourceId, bookingDate, startTime, endTime]);
          
          if (existingBlock.rows.length === 0) {
            // Create facility closure and availability block
            const closureTitle = `Lesson: ${userName || 'Unknown'}`;
            const closureReason = `Lesson (Converted from Rescan): ${userName || 'Unknown'} [TM:${booking.trackmanBookingId || booking.id}]`;
            
            const closureResult = await pool.query(`
              INSERT INTO facility_closures 
                (title, start_date, end_date, start_time, end_time, reason, notice_type, is_active, created_by)
              VALUES ($1, $2, $2, $3, $4, $5, 'private_event', true, $6)
              RETURNING id
            `, [
              closureTitle,
              bookingDate,
              startTime,
              endTime,
              closureReason,
              performedBy
            ]);
            
            await pool.query(`
              INSERT INTO availability_blocks 
                (closure_id, resource_id, block_date, start_time, end_time, block_type, notes, created_by)
              VALUES ($1, $2, $3, $4, $5, 'blocked', $6, $7)
            `, [
              closureResult.rows[0].id,
              resourceId,
              bookingDate,
              startTime,
              endTime,
              `Lesson - ${userName || 'Unknown'}`,
              performedBy
            ]);
            
            process.stderr.write(`[Trackman Rescan] Created availability block for lesson: ${userName} on ${bookingDate} ${startTime}-${endTime}\n`);
          } else {
            process.stderr.write(`[Trackman Rescan] Block already exists for lesson: ${userName} on ${bookingDate} ${startTime}-${endTime}\n`);
          }
          
          // Mark unmatched booking as resolved
          await db.update(trackmanUnmatchedBookings)
            .set({
              resolvedAt: new Date(),
              resolvedBy: performedBy,
              matchAttemptReason: 'Converted to Availability Block (Lesson)'
            })
            .where(eq(trackmanUnmatchedBookings.id, booking.id));
          
          lessonsConverted++;
          process.stderr.write(`[Trackman Rescan] Converted lesson booking: ${userName} (${originalEmail || 'no email'}) -> Availability Block\n`);
        } else {
          process.stderr.write(`[Trackman Rescan] Skipping lesson ${booking.trackmanBookingId}: missing resource/date/time (bay=${resourceId}, date=${bookingDate}, time=${startTime})\n`);
        }
        
        // Skip normal member matching for lesson bookings
        continue;
      }
      
      let matchedEmail: string | null = null;
      let matchReason = '';
      
      // Try email mapping first
      if (originalEmail) {
        const mappedEmail = emailMapping.get(originalEmail.toLowerCase().trim());
        if (mappedEmail) {
          const existingMember = membersByEmail.get(mappedEmail.toLowerCase());
          if (existingMember) {
            matchedEmail = existingMember;
            matchReason = 'Matched via email mapping';
          }
        }
      }
      
      // Try direct email match
      if (!matchedEmail && originalEmail && originalEmail.includes('@')) {
        const existingMember = membersByEmail.get(originalEmail.toLowerCase());
        if (existingMember) {
          matchedEmail = existingMember;
          matchReason = 'Matched by email';
        }
      }
      
      // Try trackman_email match
      if (!matchedEmail && originalEmail && originalEmail.includes('@')) {
        const trackmanMatch = trackmanEmailMapping.get(originalEmail.toLowerCase().trim());
        if (trackmanMatch) {
          const existingMember = membersByEmail.get(trackmanMatch.toLowerCase());
          if (existingMember) {
            matchedEmail = existingMember;
            matchReason = 'Matched by trackman_email';
          }
        }
      }
      
      // Try name matching
      if (!matchedEmail && userName) {
        const normalizedName = userName.toLowerCase().trim();
        const byNameEmails = membersByName.get(normalizedName);
        if (byNameEmails && byNameEmails.length === 1) {
          matchedEmail = byNameEmails[0];
          matchReason = 'Matched by name';
        } else if (!byNameEmails || byNameEmails.length === 0) {
          // Try partial name matching
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
            
            if (partialMatches.length === 1) {
              matchedEmail = partialMatches[0];
              matchReason = `Matched by partial name: ${matchedName}`;
            }
          }
        }
      }
      
      // If we found a match, resolve it
      if (matchedEmail) {
        await db.update(trackmanUnmatchedBookings)
          .set({
            resolvedEmail: matchedEmail,
            resolvedAt: new Date(),
            resolvedBy: performedBy,
            matchAttemptReason: matchReason
          })
          .where(eq(trackmanUnmatchedBookings.id, booking.id));
        
        resolved.push({
          trackmanId: booking.trackmanBookingId || '',
          memberEmail: matchedEmail,
          matchReason
        });
        
        matchedCount++;
        process.stderr.write(`[Trackman Rescan] Resolved: ${booking.userName} (${originalEmail}) -> ${matchedEmail} (${matchReason})\n`);
        
        // Create the booking request for this resolved entry
        try {
          const bookingDate = booking.bookingDate ? new Date(booking.bookingDate).toISOString().split('T')[0] : '';
          const startTime = booking.startTime?.toString() || '';
          const endTime = booking.endTime?.toString() || '';
          const bayId = parseInt(booking.bayNumber || '') || null;
          
          if (bookingDate && startTime) {
            // Check if booking already exists
            const existingBooking = await db.select({ id: bookingRequests.id })
              .from(bookingRequests)
              .where(sql`trackman_booking_id = ${booking.trackmanBookingId}`)
              .limit(1);
            
            if (existingBooking.length === 0) {
              // Create the booking with ON CONFLICT to handle race conditions
              try {
                await pool.query(
                  `INSERT INTO booking_requests (
                    user_email, user_name, request_date, start_time, end_time,
                    duration_minutes, resource_id, status, trackman_booking_id,
                    notes, trackman_player_count, created_at, updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
                  ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO NOTHING`,
                  [
                    matchedEmail,
                    booking.userName || '',
                    bookingDate,
                    startTime,
                    endTime,
                    booking.durationMinutes || 60,
                    bayId,
                    'approved',
                    booking.trackmanBookingId,
                    `[Trackman Import ID:${booking.trackmanBookingId}] ${booking.notes || ''}`.trim(),
                    booking.playerCount || 1
                  ]
                );
                process.stderr.write(`[Trackman Rescan] Created booking for ${matchedEmail} (Trackman ID: ${booking.trackmanBookingId})\n`);
              } catch (insertErr: unknown) {
                // Handle any remaining duplicate key errors
                if (getErrorMessage(insertErr)?.includes('duplicate key') || getErrorCode(insertErr) === '23505') {
                  process.stderr.write(`[Trackman Rescan] Booking ${booking.trackmanBookingId} already exists - skipping\n`);
                } else {
                  throw insertErr;
                }
              }
            }
          }
        } catch (bookingError: unknown) {
          process.stderr.write(`[Trackman Rescan] Error creating booking: ${getErrorMessage(bookingError)}\n`);
        }
      }
    } catch (err: unknown) {
      errors.push(`Error processing booking ${booking.trackmanBookingId}: ${(err instanceof Error && err.cause instanceof Error ? err.cause.message : null) || getErrorMessage(err)}`);
    }
  }
  
  process.stderr.write(`[Trackman Rescan] Completed: scanned ${unmatchedBookings.length}, matched ${matchedCount}, lessons converted ${lessonsConverted}\n`);
  
  return {
    scanned: unmatchedBookings.length,
    matched: matchedCount,
    lessonsConverted,
    resolved,
    errors
  };
}

/**
 * MASS CLEANUP: Converts Instructor Bookings -> Availability Blocks
 * 
 * This function scans booking_requests for:
 * - Staff emails (Tim or Rebecca at everclub.app)
 * - Bookings containing the keyword 'Lesson' in user_name or notes
 * 
 * For each matching booking, it:
 * 1. Creates a facility_closure (with notice_type 'private_event')
 * 2. Creates a corresponding availability_block
 * 3. Soft-deletes the original booking (sets status to 'cancelled', cleans up financial artifacts)
 * 
 * @param dryRun - If true, only logs what would be done without making changes
 * @returns Array of log messages describing actions taken
 */
export async function cleanupHistoricalLessons(dryRun = false): Promise<{
  logs: string[];
  convertedBookings: number;
  resolvedUnmatched: number;
  skipped: number;
}> {
  const logs: string[] = [];
  const log = (msg: string) => { logger.info(msg); logs.push(msg); };

  log(`[Lesson Cleanup] Starting run (Dry Run: ${dryRun})...`);

  // Fetch instructor emails dynamically from staff_users with role 'golf_instructor'
  const INSTRUCTOR_EMAILS = await getGolfInstructorEmails();
  log(`[Lesson Cleanup] Found ${INSTRUCTOR_EMAILS.length} golf instructors: ${INSTRUCTOR_EMAILS.join(', ') || '(none)'}`);

  let convertedBookings = 0;
  let resolvedUnmatched = 0;
  let skipped = 0;

  // 1. Find bookings linked to Tim/Rebecca or containing "Lesson" keyword
  const lessonBookingsResult = await pool.query(`
    SELECT 
      br.id,
      br.user_name,
      br.user_email,
      br.resource_id,
      br.request_date,
      br.start_time,
      br.end_time,
      br.duration_minutes,
      br.notes,
      br.trackman_booking_id,
      br.session_id
    FROM booking_requests br
    WHERE br.status NOT IN ('cancelled', 'cancellation_pending')
      AND br.archived_at IS NULL
      AND (
        LOWER(br.user_email) = ANY($1)
        OR LOWER(br.user_name) LIKE '%lesson%'
        OR LOWER(br.notes) LIKE '%lesson%'
      )
    ORDER BY br.request_date DESC
    LIMIT 1000
  `, [INSTRUCTOR_EMAILS]);

  const lessonBookings = lessonBookingsResult.rows;
  log(`[Lesson Cleanup] Found ${lessonBookings.length} lesson bookings to process.`);

  for (const booking of lessonBookings) {
    if (!booking.resource_id || !booking.request_date || !booking.start_time) {
      skipped++;
      continue;
    }

    const bookingDate = booking.request_date instanceof Date 
      ? booking.request_date.toISOString().split('T')[0]
      : booking.request_date;
    const endTime = booking.end_time || booking.start_time;

    // Check if block already exists for this time slot
    const existingBlock = await pool.query(`
      SELECT ab.id FROM availability_blocks ab
      JOIN facility_closures fc ON ab.closure_id = fc.id
      WHERE ab.resource_id = $1
        AND ab.block_date = $2
        AND ab.start_time < $4::time
        AND ab.end_time > $3::time
        AND fc.notice_type = 'private_event'
        AND fc.is_active = true
      LIMIT 1
    `, [booking.resource_id, bookingDate, booking.start_time, endTime]);

    const blockAlreadyExists = existingBlock.rows.length > 0;

    if (!dryRun) {
      // Create block if it doesn't exist
      if (!blockAlreadyExists) {
        const closureTitle = `Lesson: ${booking.user_name || 'Unknown'}`;
        const closureReason = `Lesson (Converted): ${booking.user_name || 'Unknown'} [TM:${booking.trackman_booking_id || booking.id}]`;
        
        // Create Facility Closure (matching pattern from trackman/admin cleanup)
        const closureResult = await pool.query(`
          INSERT INTO facility_closures 
            (title, start_date, end_date, start_time, end_time, reason, notice_type, is_active, created_by)
          VALUES ($1, $2, $2, $3, $4, $5, 'private_event', true, $6)
          RETURNING id
        `, [
          closureTitle,
          bookingDate, 
          booking.start_time, 
          endTime,
          closureReason,
          'system_cleanup'
        ]);

        // Create Availability Block
        await pool.query(`
          INSERT INTO availability_blocks 
            (closure_id, resource_id, block_date, start_time, end_time, block_type, notes, created_by)
          VALUES ($1, $2, $3, $4, $5, 'blocked', $6, 'system_cleanup')
        `, [
          closureResult.rows[0].id,
          booking.resource_id,
          bookingDate,
          booking.start_time,
          endTime,
          `Lesson - ${booking.user_name || 'Unknown'}`
        ]);
      }

      // Soft-delete the booking: mark as cancelled with cleanup note
      await pool.query(`
        UPDATE booking_requests 
        SET status = 'cancelled',
            archived_at = NOW(),
            archived_by = 'system_cleanup',
            staff_notes = COALESCE(staff_notes, '') || ' [Converted to Availability Block by cleanupHistoricalLessons]',
            updated_at = NOW()
        WHERE id = $1
      `, [booking.id]);

      // Clean up booking participants, members, and guests
      await pool.query(`DELETE FROM booking_members WHERE booking_id = $1`, [booking.id]);
      await pool.query(`DELETE FROM booking_guests WHERE booking_id = $1`, [booking.id]);
      await pool.query(`DELETE FROM booking_participants WHERE booking_id = $1`, [booking.id]);

      // Clean up financial artifacts: usage_ledger entries
      await pool.query(`DELETE FROM usage_ledger WHERE booking_id = $1`, [booking.id]);

      // Cancel any pending payment intents
      const pendingIntents = await pool.query(`
        SELECT stripe_payment_intent_id FROM stripe_payment_intents 
        WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')
      `, [booking.id]);
      
      for (const intent of pendingIntents.rows) {
        try {
          const stripe = await import('./stripe').then(m => m.getStripeClient());
          await stripe.paymentIntents.cancel(intent.stripe_payment_intent_id);
          log(`[Lesson Cleanup] Cancelled payment intent ${intent.stripe_payment_intent_id}`);
        } catch (err: unknown) {
          log(`[Lesson Cleanup] Could not cancel payment intent ${intent.stripe_payment_intent_id}: ${getErrorMessage(err)}`);
        }
      }

      // Clean up booking sessions linked to this booking
      if (booking.session_id) {
        await pool.query(`DELETE FROM booking_sessions WHERE id = $1`, [booking.session_id]);
      }
    }

    log(`[Lesson Cleanup] ${blockAlreadyExists ? 'Block exists, cleaned up booking' : 'Converted Booking'} #${booking.id} (${booking.user_name || 'Unknown'}).`);
    convertedBookings++;
  }

  // 2. Resolve unmatched lesson entries from the trackman_unmatched_bookings queue
  const unmatchedRows = await db.select({
    id: trackmanUnmatchedBookings.id,
    userName: trackmanUnmatchedBookings.userName,
    bookingDate: trackmanUnmatchedBookings.bookingDate,
    startTime: trackmanUnmatchedBookings.startTime,
    endTime: trackmanUnmatchedBookings.endTime,
    bayNumber: trackmanUnmatchedBookings.bayNumber,
    notes: trackmanUnmatchedBookings.notes,
    trackmanBookingId: trackmanUnmatchedBookings.trackmanBookingId,
  })
    .from(trackmanUnmatchedBookings)
    .where(and(
      sql`${trackmanUnmatchedBookings.resolvedAt} IS NULL`,
      or(
        ilike(trackmanUnmatchedBookings.userName, '%lesson%'),
        ilike(trackmanUnmatchedBookings.notes, '%lesson%')
      )
    ))
    .limit(500);

  const unmatched = unmatchedRows;
  log(`[Lesson Cleanup] Found ${unmatched.length} unmatched lesson entries to resolve.`);

  for (const item of unmatched) {
    const resourceId = parseInt(item.bayNumber) || null;
    
    if (!resourceId || resourceId <= 0) {
      log(`[Lesson Cleanup] Skipping Unmatched Item #${item.id} - invalid bay number: ${item.bayNumber}`);
      skipped++;
      continue;
    }

    if (!item.bookingDate || !item.startTime) {
      skipped++;
      continue;
    }

    const bookingDate = (item.bookingDate as string | Date) instanceof Date 
      ? (item.bookingDate as Date).toISOString().split('T')[0]
      : item.bookingDate;

    if (!dryRun) {
      // Check if block already exists
      const existingBlock = await pool.query(`
        SELECT ab.id FROM availability_blocks ab
        JOIN facility_closures fc ON ab.closure_id = fc.id
        WHERE ab.resource_id = $1
          AND ab.block_date = $2
          AND ab.start_time < $4::time
          AND ab.end_time > $3::time
          AND fc.notice_type = 'private_event'
          AND fc.is_active = true
        LIMIT 1
      `, [resourceId, bookingDate, item.startTime, item.endTime || item.startTime]);

      if (existingBlock.rows.length === 0) {
        const closureTitle = `Lesson: ${item.userName || 'Unknown'}`;
        const closureReason = `Lesson: ${item.userName || 'Unknown'} [TM:${item.trackmanBookingId || item.id}]`;
        
        // Create Facility Closure
        const closureResult = await pool.query(`
          INSERT INTO facility_closures 
            (title, start_date, end_date, start_time, end_time, reason, notice_type, is_active, created_by)
          VALUES ($1, $2, $2, $3, $4, $5, 'private_event', true, $6)
          RETURNING id
        `, [
          closureTitle,
          bookingDate,
          item.startTime,
          item.endTime || item.startTime,
          closureReason,
          'system_cleanup'
        ]);

        // Create Availability Block
        await pool.query(`
          INSERT INTO availability_blocks 
            (closure_id, resource_id, block_date, start_time, end_time, block_type, notes, created_by)
          VALUES ($1, $2, $3, $4, $5, 'blocked', $6, 'system_cleanup')
        `, [
          closureResult.rows[0].id,
          resourceId,
          bookingDate,
          item.startTime,
          item.endTime || item.startTime,
          `Lesson - ${item.userName || 'Unknown'}`
        ]);
      }

      // Mark as Resolved
      await pool.query(`
        UPDATE trackman_unmatched_bookings
        SET resolved_at = NOW(),
            resolved_by = 'system_cleanup',
            match_attempt_reason = 'Converted to Availability Block (Lesson Cleanup)'
        WHERE id = $1
      `, [item.id]);
    }

    log(`[Lesson Cleanup] Resolved unmatched lesson #${item.id} (${item.userName || 'Unknown'}).`);
    resolvedUnmatched++;
  }

  log(`[Lesson Cleanup] Completed. Converted: ${convertedBookings}, Resolved Unmatched: ${resolvedUnmatched}, Skipped: ${skipped}`);
  
  return {
    logs,
    convertedBookings,
    resolvedUnmatched,
    skipped
  };
}

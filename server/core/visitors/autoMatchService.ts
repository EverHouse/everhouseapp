import { pool } from '../db';
import { findMatchingUser, upsertVisitor } from './matchingService';
import { updateVisitorType, VisitorType } from './typeService';
import { getMemberTierByEmail } from '../tierService';
import { recordUsage } from '../bookingService/sessionManager';

export interface BookingTypeInfo {
  keyword: string | null;
  visitorType: VisitorType;
  legacyCategories: string[];
}

export interface ParsedBookingNotes {
  bookingType: BookingTypeInfo | null;
  memberEmail: string | null;
  playerNames: string[];
  rawNotes: string;
}

export interface PurchaseMatch {
  userId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  mindbodyClientId: string | null;
  purchaseId: number;
  itemName: string;
  itemCategory: string;
  saleDate: Date;
}

export interface AutoMatchResult {
  bookingId: number;
  matched: boolean;
  matchType: 'purchase' | 'private_event' | 'golfnow_fallback' | 'failed';
  visitorEmail?: string;
  visitorType?: VisitorType;
  purchaseId?: number;
  sessionId?: number;
  reason?: string;
}

const BOOKING_TYPE_MAPPINGS: Record<string, BookingTypeInfo> = {
  classpass: {
    keyword: 'classpass',
    visitorType: 'classpass',
    legacyCategories: ['lesson']
  },
  golfnow: {
    keyword: 'golfnow',
    visitorType: 'golfnow',
    legacyCategories: []
  },
  day_pass: {
    keyword: 'day pass',
    visitorType: 'day_pass',
    legacyCategories: ['guest_pass', 'day_pass']
  },
  private_lesson: {
    keyword: 'private lesson',
    visitorType: 'private_lesson',
    legacyCategories: ['lesson']
  },
  kids_lesson: {
    keyword: 'kids lesson',
    visitorType: 'private_lesson',
    legacyCategories: ['lesson']
  },
  sim_walkin: {
    keyword: 'sim walk-in',
    visitorType: 'sim_walkin',
    legacyCategories: ['sim_walk_in', 'guest_sim_fee']
  },
  sim_walkin_alt: {
    keyword: 'walk-in',
    visitorType: 'sim_walkin',
    legacyCategories: ['sim_walk_in', 'guest_sim_fee']
  },
  sim_walkin_alt2: {
    keyword: 'simulator walk',
    visitorType: 'sim_walkin',
    legacyCategories: ['sim_walk_in', 'guest_sim_fee']
  },
  guest_sim: {
    keyword: 'guest simulator',
    visitorType: 'guest',
    legacyCategories: ['guest_sim_fee']
  },
  guest_fee: {
    keyword: 'guest fee',
    visitorType: 'guest',
    legacyCategories: ['guest_sim_fee']
  }
};

export function parseBookingNotes(notes: string | null | undefined): ParsedBookingNotes {
  const result: ParsedBookingNotes = {
    bookingType: null,
    memberEmail: null,
    playerNames: [],
    rawNotes: notes || ''
  };

  if (!notes) return result;

  const lowerNotes = notes.toLowerCase();

  const emailMatch = notes.match(/M:\s*([^\s|]+@[^\s|]+)/i);
  if (emailMatch) {
    result.memberEmail = emailMatch[1].trim().toLowerCase();
  }

  for (const [key, typeInfo] of Object.entries(BOOKING_TYPE_MAPPINGS)) {
    if (typeInfo.keyword && lowerNotes.includes(typeInfo.keyword)) {
      result.bookingType = typeInfo;
      break;
    }
  }

  const namePatterns = [
    /playing with\s+([^.]+)/i,
    /for\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/,
  ];
  
  for (const pattern of namePatterns) {
    const match = notes.match(pattern);
    if (match) {
      const names = match[1].split(/,\s*|\s+and\s+/i).map(n => n.trim()).filter(Boolean);
      result.playerNames.push(...names);
    }
  }

  return result;
}

export function mapNotesToLegacyCategories(notes: string | null | undefined): string[] {
  const parsed = parseBookingNotes(notes);
  if (parsed.bookingType) {
    return parsed.bookingType.legacyCategories;
  }
  return ['guest_sim_fee', 'sim_walk_in', 'guest_pass', 'lesson'];
}

export async function matchBookingToPurchase(
  bookingDate: Date | string,
  startTime: string,
  notes: string | null | undefined
): Promise<PurchaseMatch | null> {
  try {
    const dateStr = typeof bookingDate === 'string' 
      ? bookingDate.split('T')[0] 
      : bookingDate.toISOString().split('T')[0];

    const categories = mapNotesToLegacyCategories(notes);
    
    if (categories.length === 0) {
      return null;
    }

    const timeParts = startTime.split(':');
    const bookingHour = parseInt(timeParts[0], 10);
    const bookingMinute = parseInt(timeParts[1] || '0', 10);
    
    const minHour = Math.max(0, bookingHour - 2);
    const maxHour = Math.min(23, bookingHour + 2);
    
    const minTime = `${String(minHour).padStart(2, '0')}:00:00`;
    const maxTime = `${String(maxHour).padStart(2, '0')}:59:59`;

    const query = `
      SELECT 
        lp.id as purchase_id,
        lp.item_name,
        lp.item_category,
        lp.sale_date,
        lp.member_email,
        lp.mindbody_client_id,
        u.id as user_id,
        u.email,
        u.first_name,
        u.last_name
      FROM legacy_purchases lp
      LEFT JOIN users u ON LOWER(u.email) = LOWER(lp.member_email) 
        OR u.mindbody_client_id = lp.mindbody_client_id
      WHERE DATE(lp.sale_date) = $1
        AND lp.item_category = ANY($2)
        AND lp.linked_booking_session_id IS NULL
        AND lp.linked_at IS NULL
        AND lp.sale_date::time BETWEEN $4::time AND $5::time
      ORDER BY 
        ABS(EXTRACT(EPOCH FROM (lp.sale_date::time - $3::time))) ASC
      LIMIT 1
    `;

    const result = await pool.query(query, [dateStr, categories, startTime, minTime, maxTime]);
    
    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      email: row.email || row.member_email,
      firstName: row.first_name,
      lastName: row.last_name,
      mindbodyClientId: row.mindbody_client_id,
      purchaseId: row.purchase_id,
      itemName: row.item_name,
      itemCategory: row.item_category,
      saleDate: row.sale_date
    };
  } catch (error) {
    console.error('[AutoMatch] Error matching booking to purchase:', error);
    return null;
  }
}

export function isAfterClosingHours(startTime: string): boolean {
  const hour = parseInt(startTime.split(':')[0], 10);
  return hour >= 22 || hour < 6;
}

export function isFutureBooking(bookingDate: Date | string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const bookingDay = typeof bookingDate === 'string' 
    ? new Date(bookingDate + 'T00:00:00')
    : new Date(bookingDate);
  bookingDay.setHours(0, 0, 0, 0);
  
  return bookingDay >= today;
}

interface UnmatchedBookingDetails {
  id: number;
  trackmanBookingId: string | null;
  bayNumber: string | null;
  bookingDate: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number;
  userName: string | null;
  notes: string | null;
}

async function getUnmatchedBookingDetails(bookingId: number): Promise<UnmatchedBookingDetails | null> {
  const result = await pool.query(`
    SELECT 
      id,
      trackman_booking_id,
      bay_number,
      booking_date::text as booking_date,
      start_time::text as start_time,
      end_time::text as end_time,
      duration_minutes,
      user_name,
      notes
    FROM trackman_unmatched_bookings
    WHERE id = $1
  `, [bookingId]);
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    id: row.id,
    trackmanBookingId: row.trackman_booking_id,
    bayNumber: row.bay_number,
    bookingDate: row.booking_date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: row.duration_minutes || 60,
    userName: row.user_name,
    notes: row.notes
  };
}

async function getResourceIdByBay(bayNumber: string | null): Promise<number | null> {
  if (!bayNumber) return null;
  
  const result = await pool.query(`
    SELECT id FROM resources 
    WHERE LOWER(name) LIKE LOWER($1) OR bay_number = $2
    LIMIT 1
  `, [`%${bayNumber}%`, bayNumber]);
  
  return result.rows.length > 0 ? result.rows[0].id : null;
}

async function createBookingSessionForAutoMatch(
  booking: UnmatchedBookingDetails,
  userId: number,
  email: string,
  displayName: string
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const resourceId = await getResourceIdByBay(booking.bayNumber);
    if (!resourceId) {
      console.log(`[AutoMatch] No resource found for bay ${booking.bayNumber}, skipping session creation`);
      await client.query('ROLLBACK');
      return null;
    }
    
    // Create the booking session
    const sessionResult = await client.query(`
      INSERT INTO booking_sessions (
        resource_id, session_date, start_time, end_time, 
        trackman_booking_id, source, created_by
      )
      VALUES ($1, $2, $3, $4, $5, 'trackman', 'auto_match')
      ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL
      DO UPDATE SET updated_at = NOW()
      RETURNING id
    `, [
      resourceId, 
      booking.bookingDate, 
      booking.startTime, 
      booking.endTime || booking.startTime,
      booking.trackmanBookingId
    ]);
    
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    
    const sessionId = sessionResult.rows[0].id;
    
    // Add participant as owner
    await client.query(`
      INSERT INTO booking_participants (session_id, user_id, display_name, participant_type)
      VALUES ($1, $2, $3, 'owner')
      ON CONFLICT (session_id, participant_type) WHERE participant_type = 'owner'
      DO UPDATE SET user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name
    `, [sessionId, userId, displayName]);
    
    // Check if user is an active member and record initial usage
    // Note: Actual fees will be calculated at check-in based on daily usage
    const memberTier = await getMemberTierByEmail(email);
    
    if (memberTier) {
      // Member: record usage with tier - fees calculated at check-in based on daily allowance
      await recordUsage(sessionId, {
        memberId: userId,
        minutesCharged: booking.durationMinutes,
        overageFee: 0, // Initial - actual overage calculated at check-in
        guestFee: 0,
        tierAtBooking: memberTier
      }, 'trackman');
      console.log(`[AutoMatch] Created session ${sessionId} for member ${email} (${memberTier})`);
    } else {
      // Non-member (visitor): record usage without tier - visitor fees apply at check-in
      await recordUsage(sessionId, {
        memberId: userId,
        minutesCharged: booking.durationMinutes,
        overageFee: 0,
        guestFee: 0,
        tierAtBooking: undefined
      }, 'trackman');
      console.log(`[AutoMatch] Created session ${sessionId} for visitor ${email}`);
    }
    
    await client.query('COMMIT');
    return sessionId;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[AutoMatch] Error creating booking session:', error);
    return null;
  } finally {
    client.release();
  }
}

export async function autoMatchSingleBooking(
  bookingId: number,
  bookingDate: Date | string,
  startTime: string,
  userName: string | null,
  notes: string | null,
  staffEmail?: string
): Promise<AutoMatchResult> {
  const result: AutoMatchResult = {
    bookingId,
    matched: false,
    matchType: 'failed'
  };

  try {
    // Get full booking details for session creation
    const bookingDetails = await getUnmatchedBookingDetails(bookingId);
    const isFuture = isFutureBooking(bookingDate);
    const parsed = parseBookingNotes(notes);
    
    // Helper to create session for future bookings
    const maybeCreateSession = async (userId: number, email: string, displayName: string): Promise<number | null> => {
      if (!isFuture || !bookingDetails) return null;
      return createBookingSessionForAutoMatch(bookingDetails, userId, email, displayName);
    };
    
    // Try email from notes first
    if (parsed.memberEmail) {
      const user = await findMatchingUser({ email: parsed.memberEmail });
      if (user) {
        const sessionId = await maybeCreateSession(
          user.id, 
          user.email, 
          `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email
        );
        await resolveBookingWithUser(bookingId, user.id, user.email, staffEmail, sessionId);
        result.matched = true;
        result.matchType = 'purchase';
        result.visitorEmail = user.email;
        if (sessionId) result.sessionId = sessionId;
        return result;
      }
    }

    // Try purchase match
    const purchaseMatch = await matchBookingToPurchase(bookingDate, startTime, notes);
    
    if (purchaseMatch && purchaseMatch.email) {
      let userId = purchaseMatch.userId;
      let displayName = `${purchaseMatch.firstName || ''} ${purchaseMatch.lastName || ''}`.trim() || purchaseMatch.email;
      
      if (!userId) {
        const visitor = await upsertVisitor({
          email: purchaseMatch.email,
          firstName: purchaseMatch.firstName || undefined,
          lastName: purchaseMatch.lastName || undefined,
          mindbodyClientId: purchaseMatch.mindbodyClientId || undefined
        });
        userId = visitor.id;
      }
      
      // For future bookings, create session first so we can link purchase correctly
      const sessionId = await maybeCreateSession(userId, purchaseMatch.email, displayName);
      
      await resolveBookingWithUser(bookingId, userId, purchaseMatch.email, staffEmail, sessionId);
      
      // Only link purchase to session if we have a real session ID
      if (sessionId) {
        await linkPurchaseToSession(purchaseMatch.purchaseId, sessionId);
      } else {
        // Historical booking: just mark purchase as used (via unmatched booking reference)
        await markPurchaseAsUsed(purchaseMatch.purchaseId, bookingId);
      }
      
      const visitorType = parsed.bookingType?.visitorType || 'guest';
      await updateVisitorType({
        email: purchaseMatch.email,
        type: visitorType,
        activitySource: 'trackman_auto_match',
        activityDate: typeof bookingDate === 'string' ? new Date(bookingDate) : bookingDate
      });
      
      result.matched = true;
      result.matchType = 'purchase';
      result.visitorEmail = purchaseMatch.email;
      result.visitorType = visitorType;
      result.purchaseId = purchaseMatch.purchaseId;
      if (sessionId) result.sessionId = sessionId;
      return result;
    }

    // After hours = private event
    if (isAfterClosingHours(startTime)) {
      await markBookingAsPrivateEvent(bookingId, staffEmail);
      result.matched = true;
      result.matchType = 'private_event';
      result.reason = 'After hours booking (10 PM - 6 AM)';
      return result;
    }

    // Fallback: create GolfNow visitor
    if (parsed.bookingType?.keyword === 'golfnow' || !parsed.bookingType) {
      const visitorEmail = await createGolfNowVisitor(userName, bookingDate, startTime);
      if (visitorEmail) {
        const user = await findMatchingUser({ email: visitorEmail });
        if (user) {
          const sessionId = await maybeCreateSession(user.id, visitorEmail, userName || 'GolfNow Visitor');
          await resolveBookingWithUser(bookingId, user.id, visitorEmail, staffEmail, sessionId);
          result.matched = true;
          result.matchType = 'golfnow_fallback';
          result.visitorEmail = visitorEmail;
          result.visitorType = 'golfnow';
          if (sessionId) result.sessionId = sessionId;
          return result;
        }
      }
    }

    result.reason = 'No matching purchase found and no fallback applicable';
    return result;
  } catch (error) {
    console.error('[AutoMatch] Error auto-matching booking:', error);
    result.reason = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

async function resolveBookingWithUser(
  bookingId: number,
  userId: number,
  email: string,
  staffEmail?: string,
  sessionId?: number | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE trackman_unmatched_bookings
      SET 
        status = 'resolved',
        resolved_email = $2,
        resolved_at = NOW(),
        resolved_by = $3,
        match_attempt_reason = $4
      WHERE id = $1
    `, [
      bookingId, 
      email, 
      staffEmail || 'system',
      sessionId ? 'auto_matched_with_session' : 'auto_matched'
    ]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Link purchase to a real booking session (for future bookings)
async function linkPurchaseToSession(purchaseId: number, sessionId: number): Promise<void> {
  await pool.query(`
    UPDATE legacy_purchases
    SET 
      linked_booking_session_id = $2,
      linked_at = NOW()
    WHERE id = $1
  `, [purchaseId, sessionId]);
  console.log(`[AutoMatch] Linked purchase ${purchaseId} to session ${sessionId}`);
}

// Mark purchase as used without linking to session (for historical bookings)
// We use linked_at to prevent re-matching but don't set linked_booking_session_id
async function markPurchaseAsUsed(purchaseId: number, unmatchedBookingId: number): Promise<void> {
  await pool.query(`
    UPDATE legacy_purchases
    SET linked_at = NOW()
    WHERE id = $1 AND linked_at IS NULL
  `, [purchaseId]);
  console.log(`[AutoMatch] Marked purchase ${purchaseId} as used (historical, unmatched booking ${unmatchedBookingId})`);
}

async function markBookingAsPrivateEvent(bookingId: number, staffEmail?: string): Promise<void> {
  await pool.query(`
    UPDATE trackman_unmatched_bookings
    SET 
      status = 'resolved',
      match_attempt_reason = 'private_event',
      resolved_at = NOW(),
      resolved_by = $2
    WHERE id = $1
  `, [bookingId, staffEmail || 'system']);
}

async function createGolfNowVisitor(
  userName: string | null,
  bookingDate: Date | string,
  startTime: string
): Promise<string | null> {
  if (!userName) return null;
  
  const nameParts = userName.split(/[,\s]+/).filter(Boolean);
  let firstName = nameParts[0] || 'GolfNow';
  let lastName = nameParts.slice(1).join(' ') || 'Visitor';
  
  if (userName.includes(',')) {
    lastName = nameParts[0] || 'Visitor';
    firstName = nameParts.slice(1).join(' ') || 'GolfNow';
  }
  
  const dateStr = typeof bookingDate === 'string' 
    ? bookingDate.replace(/-/g, '') 
    : bookingDate.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = startTime.replace(/:/g, '').substring(0, 4);
  const generatedEmail = `golfnow-${dateStr}-${timeStr}@visitors.evenhouse.club`;
  
  try {
    const visitor = await upsertVisitor({
      email: generatedEmail,
      firstName,
      lastName
    }, false);
    
    await updateVisitorType({
      email: generatedEmail,
      type: 'golfnow',
      activitySource: 'trackman_auto_match',
      activityDate: typeof bookingDate === 'string' ? new Date(bookingDate) : bookingDate
    });
    
    return generatedEmail;
  } catch (error) {
    console.error('[AutoMatch] Error creating GolfNow visitor:', error);
    return null;
  }
}

// Auto-match bookings from the legacy trackman_unmatched_bookings table
async function autoMatchLegacyUnmatchedBookings(
  staffEmail?: string
): Promise<{ matched: number; failed: number; results: AutoMatchResult[] }> {
  const results: AutoMatchResult[] = [];
  let matched = 0;
  let failed = 0;

  const query = `
    SELECT id, booking_date, start_time, user_name, notes
    FROM trackman_unmatched_bookings
    WHERE status = 'pending' OR status = 'unmatched'
    ORDER BY booking_date DESC, start_time DESC
  `;
  
  const { rows } = await pool.query(query);
  
  console.log(`[AutoMatch] Processing ${rows.length} legacy unmatched bookings...`);
  
  for (const row of rows) {
    const result = await autoMatchSingleBooking(
      row.id,
      row.booking_date,
      row.start_time,
      row.user_name,
      row.notes,
      staffEmail
    );
    
    results.push(result);
    
    if (result.matched) {
      matched++;
      console.log(`[AutoMatch] Matched legacy booking #${row.id}: ${result.matchType} -> ${result.visitorEmail || 'private_event'}`);
    } else {
      failed++;
    }
  }
  
  return { matched, failed, results };
}

// Auto-match GolfNow bookings from booking_requests table
async function autoMatchBookingRequests(
  staffEmail?: string
): Promise<{ matched: number; failed: number; results: AutoMatchResult[] }> {
  const results: AutoMatchResult[] = [];
  let matched = 0;
  let failed = 0;

  // Get unmatched booking_requests with GolfNow/lesson/visitor indicators
  // Check user_name, notes, staff_notes, and trackman_customer_notes for keywords
  const query = `
    SELECT 
      id, 
      user_email,
      user_name,
      request_date as booking_date,
      start_time,
      end_time,
      duration_minutes,
      resource_id,
      notes,
      staff_notes,
      trackman_customer_notes,
      trackman_booking_id
    FROM booking_requests 
    WHERE is_unmatched = true 
      AND (user_email LIKE 'unmatched-%@%' OR user_email LIKE '%@trackman.local')
      AND (
        LOWER(user_name) LIKE '%golfnow%'
        OR LOWER(notes) LIKE '%golfnow%'
        OR LOWER(staff_notes) LIKE '%golfnow%'
        OR LOWER(trackman_customer_notes) LIKE '%golfnow%'
        OR LOWER(user_name) LIKE '%classpass%'
        OR LOWER(notes) LIKE '%classpass%'
        OR LOWER(staff_notes) LIKE '%classpass%'
        OR LOWER(trackman_customer_notes) LIKE '%classpass%'
        OR LOWER(user_name) LIKE '%walk-in%'
        OR LOWER(user_name) LIKE '%walk in%'
        OR LOWER(user_name) LIKE '%lesson%'
        OR LOWER(notes) LIKE '%lesson%'
        OR LOWER(user_name) LIKE '%anonymous%'
      )
    ORDER BY request_date DESC, start_time DESC
    LIMIT 500
  `;
  
  const { rows } = await pool.query(query);
  
  console.log(`[AutoMatch] Processing ${rows.length} GolfNow/walk-in booking_requests...`);
  
  for (const row of rows) {
    try {
      const isFuture = isFutureBooking(row.booking_date);
      const userName = row.user_name || 'Visitor';
      const allNotes = `${row.notes || ''} ${row.staff_notes || ''} ${row.trackman_customer_notes || ''}`.toLowerCase();
      const lowerName = userName.toLowerCase();
      
      // Determine visitor type based on content
      let visitorType: VisitorType = 'guest';
      let emailPrefix = 'visitor';
      
      if (lowerName.includes('golfnow') || allNotes.includes('golfnow')) {
        visitorType = 'golfnow';
        emailPrefix = 'golfnow';
      } else if (lowerName.includes('classpass') || allNotes.includes('classpass')) {
        visitorType = 'classpass';
        emailPrefix = 'classpass';
      } else if (lowerName.includes('lesson') || allNotes.includes('lesson')) {
        visitorType = 'private_lesson';
        emailPrefix = 'lesson';
      } else if (lowerName.includes('anonymous') || allNotes.includes('anonymous')) {
        visitorType = 'guest';
        emailPrefix = 'anonymous';
      } else if (lowerName.includes('walk-in') || lowerName.includes('walk in')) {
        visitorType = 'sim_walkin';
        emailPrefix = 'walkin';
      }
      
      // Generate visitor email
      const dateStr = row.booking_date instanceof Date 
        ? row.booking_date.toISOString().split('T')[0].replace(/-/g, '') 
        : row.booking_date.replace(/-/g, '');
      const timeStr = (row.start_time || '12:00').replace(/:/g, '').substring(0, 4);
      const generatedEmail = `${emailPrefix}-${dateStr}-${timeStr}@visitors.evenhouse.club`;
      
      // Parse name - extract actual person name from booking name if possible
      let firstName = 'Visitor';
      let lastName = '';
      
      // Try to extract real name (e.g., "Beginner Group Lesson Tim Silverman" -> "Tim Silverman")
      const nameMatch = userName.match(/(?:lesson|group|private|beginner|advanced)\s+(.+)/i);
      if (nameMatch) {
        const extractedName = nameMatch[1].trim();
        const parts = extractedName.split(/\s+/);
        firstName = parts[0] || 'Visitor';
        lastName = parts.slice(1).join(' ') || '';
      } else {
        const nameParts = userName.split(/[,\s]+/).filter(Boolean);
        firstName = nameParts[0] || 'Visitor';
        lastName = nameParts.slice(1).join(' ') || '';
        
        // Handle "Last, First" format
        if (userName.includes(',')) {
          lastName = nameParts[0] || '';
          firstName = nameParts.slice(1).join(' ') || 'Visitor';
        }
      }
      
      // Create visitor
      const visitor = await upsertVisitor({
        email: generatedEmail,
        firstName,
        lastName: lastName || 'Visitor'
      }, false);
      
      // Update visitor type
      await updateVisitorType({
        email: generatedEmail,
        type: visitorType,
        activitySource: 'trackman_auto_match',
        activityDate: new Date(row.booking_date)
      });
      
      // For future bookings, create a session
      let sessionId: number | null = null;
      if (isFuture && row.resource_id) {
        try {
          const sessionResult = await pool.query(`
            INSERT INTO booking_sessions (
              resource_id, session_date, start_time, end_time, 
              trackman_booking_id, source, created_by
            )
            VALUES ($1, $2, $3, $4, $5, 'trackman', 'auto_match')
            ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL
            DO UPDATE SET updated_at = NOW()
            RETURNING id
          `, [
            row.resource_id, 
            row.booking_date, 
            row.start_time, 
            row.end_time || row.start_time,
            row.trackman_booking_id
          ]);
          
          if (sessionResult.rows.length > 0) {
            sessionId = sessionResult.rows[0].id;
            
            // Add participant
            await pool.query(`
              INSERT INTO booking_participants (session_id, user_id, display_name, participant_type)
              VALUES ($1, $2, $3, 'owner')
              ON CONFLICT (session_id, participant_type) WHERE participant_type = 'owner'
              DO UPDATE SET user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name
            `, [sessionId, visitor.id, userName]);
            
            // Record usage for visitor
            await recordUsage(sessionId, {
              memberId: visitor.id,
              minutesCharged: row.duration_minutes || 60,
              overageFee: 0,
              guestFee: 0,
              tierAtBooking: undefined
            }, 'trackman');
          }
        } catch (sessionError) {
          console.log(`[AutoMatch] Could not create session for booking ${row.id}:`, sessionError);
        }
      }
      
      // Update booking_request with the visitor email
      await pool.query(`
        UPDATE booking_requests
        SET 
          user_id = $2,
          user_email = $3,
          is_unmatched = false,
          session_id = COALESCE($4, session_id),
          staff_notes = COALESCE(staff_notes, '') || $5,
          updated_at = NOW()
        WHERE id = $1
      `, [
        row.id,
        visitor.id,
        generatedEmail,
        sessionId,
        ` [Auto-matched to ${visitorType} visitor by ${staffEmail || 'system'}]`
      ]);
      
      results.push({
        bookingId: row.id,
        matched: true,
        matchType: 'golfnow_fallback',
        visitorEmail: generatedEmail,
        visitorType: visitorType,
        sessionId: sessionId || undefined
      });
      matched++;
      console.log(`[AutoMatch] Matched booking_request #${row.id} -> ${generatedEmail}`);
    } catch (error) {
      console.error(`[AutoMatch] Error matching booking_request #${row.id}:`, error);
      results.push({
        bookingId: row.id,
        matched: false,
        matchType: 'failed',
        reason: error instanceof Error ? error.message : 'Unknown error'
      });
      failed++;
    }
  }
  
  return { matched, failed, results };
}

export async function autoMatchAllUnmatchedBookings(
  staffEmail?: string
): Promise<{ matched: number; failed: number; results: AutoMatchResult[] }> {
  try {
    // Process both tables
    const [legacyResults, requestsResults] = await Promise.all([
      autoMatchLegacyUnmatchedBookings(staffEmail),
      autoMatchBookingRequests(staffEmail)
    ]);
    
    const totalMatched = legacyResults.matched + requestsResults.matched;
    const totalFailed = legacyResults.failed + requestsResults.failed;
    const allResults = [...legacyResults.results, ...requestsResults.results];
    
    console.log(`[AutoMatch] Complete: ${totalMatched} matched, ${totalFailed} failed (legacy: ${legacyResults.matched}/${legacyResults.failed}, requests: ${requestsResults.matched}/${requestsResults.failed})`);
    
    return { matched: totalMatched, failed: totalFailed, results: allResults };
  } catch (error) {
    console.error('[AutoMatch] Error in batch auto-match:', error);
    throw error;
  }
}

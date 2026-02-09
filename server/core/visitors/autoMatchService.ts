import { pool } from '../db';
import { findMatchingUser, upsertVisitor } from './matchingService';
import { updateVisitorType, VisitorType } from './typeService';
import { getMemberTierByEmail } from '../tierService';
import { recordUsage, ensureSessionForBooking } from '../bookingService/sessionManager';

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
  source?: 'legacy' | 'day_pass'; // Which table the purchase came from
}

export interface AutoMatchResult {
  bookingId: number;
  matched: boolean;
  matchType: 'purchase' | 'private_event' | 'golfnow_fallback' | 'classpass_visitor' | 'name_match' | 'failed';
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

    // Query 1: Search Legacy Purchases (existing behavior)
    const legacyQuery = `
      SELECT 
        lp.id as purchase_id,
        'legacy' as source,
        lp.item_name,
        lp.item_category,
        lp.sale_date,
        lp.member_email,
        lp.mindbody_client_id,
        u.id as user_id,
        u.email,
        u.first_name,
        u.last_name,
        ABS(EXTRACT(EPOCH FROM (lp.sale_date::time - $3::time))) as time_diff
      FROM legacy_purchases lp
      LEFT JOIN users u ON LOWER(u.email) = LOWER(lp.member_email) 
        OR u.mindbody_client_id = lp.mindbody_client_id
      WHERE DATE(lp.sale_date) = $1
        AND lp.item_category = ANY($2)
        AND lp.linked_booking_session_id IS NULL
        AND lp.linked_at IS NULL
        AND lp.sale_date::time BETWEEN $4::time AND $5::time
        AND (u.archived_at IS NULL OR u.id IS NULL)
      ORDER BY time_diff ASC
      LIMIT 1
    `;

    // Query 2: FIX for "Day Pass Ignore" bug - also search day_pass_purchases table
    // GUARD: Only query day_pass_purchases when there's explicit day-pass signal in the notes
    // Check parsed bookingType or explicit keywords in notes - NOT just default fallback categories
    const parsed = parseBookingNotes(notes);
    const dayPassKeywords = ['day pass', 'daypass', 'walk-in', 'walkin', 'sim walk'];
    const notesLower = (notes || '').toLowerCase();
    const hasExplicitDayPassSignal = 
      parsed.bookingType?.visitorType === 'sim_walkin' ||
      categories.includes('day_pass') ||
      dayPassKeywords.some(kw => notesLower.includes(kw));
    const shouldQueryDayPass = hasExplicitDayPassSignal;
    
    let dayPassResult: { rows: any[] } = { rows: [] };
    
    if (shouldQueryDayPass) {
      // Query day_pass_purchases - uses purchaser_email, status, and booking_date
      // Apply same time window constraint as legacy to prevent false matches
      const dayPassQuery = `
        SELECT 
          dp.id as purchase_id,
          'day_pass' as source,
          'Day Pass' as item_name,
          'day_pass' as item_category,
          dp.purchased_at as sale_date,
          dp.purchaser_email as member_email,
          NULL as mindbody_client_id,
          u.id as user_id,
          u.email,
          u.first_name,
          u.last_name,
          ABS(EXTRACT(EPOCH FROM (dp.purchased_at::time - $3::time))) as time_diff
        FROM day_pass_purchases dp
        LEFT JOIN users u ON LOWER(u.email) = LOWER(dp.purchaser_email)
        WHERE (DATE(dp.booking_date) = $1 OR DATE(dp.purchased_at) = $1)
          AND dp.status NOT IN ('redeemed', 'expired', 'cancelled')
          AND dp.remaining_uses > 0
          AND (u.archived_at IS NULL OR u.id IS NULL)
          AND dp.purchased_at::time BETWEEN $2::time AND $4::time
        ORDER BY time_diff ASC
        LIMIT 1
      `;
      dayPassResult = await pool.query(dayPassQuery, [dateStr, minTime, startTime, maxTime]);
    }

    // Execute legacy query
    const legacyResult = await pool.query(legacyQuery, [dateStr, categories, startTime, minTime, maxTime]);
    
    // Pick the best match - prefer day_pass (modern) if same time, otherwise pick closest
    let row = null;
    if (legacyResult.rows.length > 0 && dayPassResult.rows.length > 0) {
      // Both found - pick the one closer to booking time
      row = (dayPassResult.rows[0].time_diff <= legacyResult.rows[0].time_diff) 
        ? dayPassResult.rows[0] 
        : legacyResult.rows[0];
    } else {
      row = dayPassResult.rows[0] || legacyResult.rows[0];
    }
    
    if (!row) {
      return null;
    }
    return {
      userId: row.user_id,
      email: row.email || row.member_email,
      firstName: row.first_name,
      lastName: row.last_name,
      mindbodyClientId: row.mindbody_client_id,
      purchaseId: row.purchase_id,
      itemName: row.item_name,
      itemCategory: row.item_category,
      saleDate: row.sale_date,
      source: row.source as 'legacy' | 'day_pass'
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
    
    const sessionResult = await ensureSessionForBooking({
      bookingId: booking.id,
      resourceId,
      sessionDate: booking.bookingDate,
      startTime: booking.startTime,
      endTime: booking.endTime || booking.startTime,
      ownerEmail: email,
      ownerName: displayName,
      ownerUserId: userId?.toString(),
      trackmanBookingId: booking.trackmanBookingId || undefined,
      source: 'trackman',
      createdBy: 'auto_match'
    }, client);
    
    if (!sessionResult.sessionId || sessionResult.error) {
      await client.query('ROLLBACK');
      return null;
    }
    
    const sessionId = sessionResult.sessionId;
    
    const memberTier = await getMemberTierByEmail(email);
    
    if (memberTier) {
      await recordUsage(sessionId, {
        memberId: userId,
        minutesCharged: booking.durationMinutes,
        overageFee: 0,
        guestFee: 0,
        tierAtBooking: memberTier
      }, 'trackman');
      console.log(`[AutoMatch] Created session ${sessionId} for member ${email} (${memberTier})`);
    } else {
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
      // Pass trackman booking ID for audit trail (especially for day pass)
      const trackmanBookingId = bookingDetails?.trackmanBookingId;
      if (sessionId) {
        await linkPurchaseToSession(purchaseMatch.purchaseId, sessionId, purchaseMatch.source, trackmanBookingId);
      } else {
        // Historical booking: just mark purchase as used (via unmatched booking reference)
        await markPurchaseAsUsed(purchaseMatch.purchaseId, bookingId, purchaseMatch.source, trackmanBookingId);
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

    // Fallback: create GolfNow or ClassPass visitor
    const isGolfNow = parsed.bookingType?.keyword === 'golfnow';
    const isClassPass = parsed.bookingType?.keyword === 'classpass';
    
    if (isGolfNow || isClassPass || !parsed.bookingType) {
      const visitorEmail = await createGolfNowVisitor(userName, bookingDate, startTime);
      if (visitorEmail) {
        const user = await findMatchingUser({ email: visitorEmail });
        if (user) {
          const visitorType: VisitorType = isClassPass ? 'classpass' : 'golfnow';
          const visitorLabel = isClassPass ? 'ClassPass Visitor' : 'GolfNow Visitor';
          const sessionId = await maybeCreateSession(user.id, visitorEmail, userName || visitorLabel);
          await resolveBookingWithUser(bookingId, user.id, visitorEmail, staffEmail, sessionId);
          result.matched = true;
          result.matchType = isClassPass ? 'classpass_visitor' : 'golfnow_fallback';
          result.visitorEmail = visitorEmail;
          result.visitorType = visitorType;
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
// FIX: Handle both legacy_purchases and day_pass_purchases tables based on source
async function linkPurchaseToSession(purchaseId: number | string, sessionId: number, source?: 'legacy' | 'day_pass', trackmanBookingId?: string): Promise<void> {
  if (source === 'day_pass') {
    // Day pass uses status='redeemed', remaining_uses, and trackman_booking_id for audit trail
    // Only store actual trackman_booking_id, not sessionId (they are different identifiers)
    // Guard: prevent duplicate linking by checking trackman_booking_id not already set to different value
    const result = await pool.query(`
      UPDATE day_pass_purchases
      SET 
        status = CASE WHEN remaining_uses <= 1 THEN 'redeemed' ELSE status END,
        remaining_uses = GREATEST(0, COALESCE(remaining_uses, 1) - 1),
        trackman_booking_id = CASE 
          WHEN $2::text IS NOT NULL THEN COALESCE(trackman_booking_id, $2)
          ELSE trackman_booking_id
        END,
        updated_at = NOW()
      WHERE id = $1 
        AND (remaining_uses > 0 OR remaining_uses IS NULL)
        AND (trackman_booking_id IS NULL OR trackman_booking_id = $2 OR $2 IS NULL)
    `, [purchaseId, trackmanBookingId || null]);
    
    if (result.rowCount === 0) {
      console.warn(`[AutoMatch] Day pass ${purchaseId} not updated - may be exhausted or already linked to different booking`);
    } else {
      console.log(`[AutoMatch] Linked day pass purchase ${purchaseId} to session ${sessionId}${trackmanBookingId ? ` (trackman: ${trackmanBookingId})` : ''}`);
    }
  } else {
    await pool.query(`
      UPDATE legacy_purchases
      SET 
        linked_booking_session_id = $2,
        linked_at = NOW()
      WHERE id = $1
    `, [purchaseId, sessionId]);
    console.log(`[AutoMatch] Linked legacy purchase ${purchaseId} to session ${sessionId}`);
  }
}

// Mark purchase as used without linking to session (for historical bookings)
// We use linked_at/status to prevent re-matching but don't set linked_booking_session_id
// FIX: Handle both legacy_purchases and day_pass_purchases tables based on source
async function markPurchaseAsUsed(purchaseId: number | string, unmatchedBookingId: number, source?: 'legacy' | 'day_pass', trackmanBookingId?: string): Promise<void> {
  if (source === 'day_pass') {
    // Use trackman_booking_id for audit trail (only store actual trackman ID, not synthetic values)
    // Guard: prevent duplicate linking by checking trackman_booking_id not already set to different value
    const result = await pool.query(`
      UPDATE day_pass_purchases
      SET 
        status = CASE WHEN remaining_uses <= 1 THEN 'redeemed' ELSE status END,
        remaining_uses = GREATEST(0, COALESCE(remaining_uses, 1) - 1),
        trackman_booking_id = CASE 
          WHEN $2::text IS NOT NULL THEN COALESCE(trackman_booking_id, $2)
          ELSE trackman_booking_id
        END,
        updated_at = NOW()
      WHERE id = $1 
        AND (remaining_uses > 0 OR remaining_uses IS NULL)
        AND (trackman_booking_id IS NULL OR trackman_booking_id = $2 OR $2 IS NULL)
    `, [purchaseId, trackmanBookingId || null]);
    
    if (result.rowCount === 0) {
      console.warn(`[AutoMatch] Day pass ${purchaseId} not updated - may be exhausted or already linked to different booking`);
    } else {
      console.log(`[AutoMatch] Marked day pass purchase ${purchaseId} as redeemed (historical, unmatched booking ${unmatchedBookingId})`);
    }
  } else {
    await pool.query(`
      UPDATE legacy_purchases
      SET linked_at = NOW()
      WHERE id = $1 AND linked_at IS NULL
    `, [purchaseId]);
    console.log(`[AutoMatch] Marked legacy purchase ${purchaseId} as used (historical, unmatched booking ${unmatchedBookingId})`);
  }
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

/**
 * REFACTORED: No longer creates placeholder visitors with fake emails.
 * GolfNow bookings should remain unmatched until staff manually assigns a real member/visitor.
 * Staff will use TrackmanLinkModal to assign the booking to a real user.
 * 
 * @returns null - booking should remain unmatched with null user_email
 */
async function createGolfNowVisitor(
  userName: string | null,
  bookingDate: Date | string,
  startTime: string
): Promise<string | null> {
  // No longer create placeholder visitors - return null to keep booking unmatched
  // Staff will manually assign via TrackmanLinkModal
  console.log(`[AutoMatch] GolfNow booking for "${userName}" will remain unmatched - staff must assign manually`);
  return null;
}

// Auto-match bookings from the legacy trackman_unmatched_bookings table
async function autoMatchLegacyUnmatchedBookings(
  staffEmail?: string
): Promise<{ matched: number; failed: number; results: AutoMatchResult[] }> {
  const results: AutoMatchResult[] = [];
  let matched = 0;
  let failed = 0;

  const query = `
    SELECT tub.id, tub.booking_date, tub.start_time, tub.user_name, tub.notes
    FROM trackman_unmatched_bookings tub
    WHERE (tub.status = 'pending' OR tub.status = 'unmatched')
      AND NOT EXISTS (
        SELECT 1 FROM booking_requests br 
        WHERE br.trackman_booking_id = tub.trackman_booking_id::text
      )
    ORDER BY tub.booking_date DESC, tub.start_time DESC
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
      AND (user_email IS NULL OR user_email LIKE 'unmatched-%@%' OR user_email LIKE '%@trackman.local' OR user_email LIKE '%@visitors.evenhouse.club')
      AND status IN ('pending', 'approved', 'attended')
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
        OR LOWER(user_name) = 'birthday booking'
        OR LOWER(user_name) LIKE '%birthday party%'
        OR LOWER(notes) LIKE '%''s event%'
        OR LOWER(notes) LIKE '%private event%'
        OR LOWER(notes) LIKE '%birthday party%'
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
      
      // Check if this should be marked as a private event
      // Only match very specific patterns to avoid false positives:
      // - "Birthday Booking" or similar (specific name patterns)
      // - Notes containing "'s Event" (e.g., "Jeanne Stein's Event")
      // - Notes containing "private event" explicitly
      const isPrivateEventBooking = 
        (lowerName === 'birthday booking') || 
        (lowerName.includes('birthday') && lowerName.includes('booking')) ||
        (lowerName.includes('birthday') && lowerName.includes('party')) ||
        allNotes.includes("'s event") ||
        allNotes.includes('private event') ||
        allNotes.includes('birthday party');
      
      if (isPrivateEventBooking) {
        // Mark as private event - clear unmatched status
        await pool.query(`
          UPDATE booking_requests
          SET 
            is_unmatched = false,
            staff_notes = COALESCE(staff_notes, '') || ' [Auto-resolved: Private event by ${staffEmail || 'system'}]',
            updated_at = NOW()
          WHERE id = $1
        `, [row.id]);
        
        results.push({
          bookingId: row.id,
          matched: true,
          matchType: 'private_event',
          reason: `Auto-resolved as private event: ${userName}`
        });
        matched++;
        console.log(`[AutoMatch] Marked booking_request #${row.id} as private event: ${userName}`);
        continue;
      }
      
      // Determine visitor type based on content
      let visitorType: VisitorType = 'guest';
      
      if (lowerName.includes('golfnow') || allNotes.includes('golfnow')) {
        visitorType = 'golfnow';
      } else if (lowerName.includes('classpass') || allNotes.includes('classpass')) {
        visitorType = 'classpass';
      } else if (lowerName.includes('lesson') || allNotes.includes('lesson')) {
        visitorType = 'private_lesson';
      } else if (lowerName.includes('walk-in') || lowerName.includes('walk in')) {
        visitorType = 'sim_walkin';
      }
      
      // Parse name - extract actual person name from booking name if possible
      let firstName = '';
      let lastName = '';
      
      // Try to extract real name (e.g., "Beginner Group Lesson Tim Silverman" -> "Tim Silverman")
      const nameMatch = userName.match(/(?:lesson|group|private|beginner|advanced)\s+(.+)/i);
      if (nameMatch) {
        const extractedName = nameMatch[1].trim();
        const parts = extractedName.split(/\s+/);
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
      } else {
        const nameParts = userName.split(/[,\s]+/).filter(Boolean);
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
        
        // Handle "Last, First" format
        if (userName.includes(',')) {
          lastName = nameParts[0] || '';
          firstName = nameParts.slice(1).join(' ') || '';
        }
      }
      
      // REFACTORED: Only match to EXISTING real visitors by name - don't create placeholder visitors
      // If no existing visitor found, keep booking unmatched for staff to manually assign
      let visitor: { id: string; email: string } | null = null;
      
      if (firstName && lastName) {
        const existingVisitorResult = await pool.query(`
          SELECT id, email, first_name, last_name, visitor_type
          FROM users
          WHERE LOWER(first_name) = LOWER($1)
            AND LOWER(last_name) = LOWER($2)
            AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
            AND archived_at IS NULL
            AND email NOT LIKE '%@visitors.evenhouse.club'
            AND email NOT LIKE '%@trackman.local'
            AND email NOT LIKE 'unmatched-%'
          ORDER BY created_at ASC
          LIMIT 1
        `, [firstName, lastName]);
        
        if (existingVisitorResult.rows.length > 0) {
          const existing = existingVisitorResult.rows[0];
          visitor = { id: existing.id, email: existing.email };
          console.log(`[AutoMatch] Found existing REAL visitor ${firstName} ${lastName} (${existing.email}) - linking booking`);
        }
      }
      
      // If no existing real visitor found, skip this booking - staff must manually assign
      if (!visitor) {
        console.log(`[AutoMatch] No existing real visitor found for "${userName}" - booking #${row.id} will remain unmatched for staff to assign`);
        results.push({
          bookingId: row.id,
          matched: false,
          matchType: 'failed',
          reason: `No existing real visitor found for "${userName}" - requires manual staff assignment`
        });
        failed++;
        continue;
      }
      
      // Update visitor type for existing visitor (if applicable)
      await updateVisitorType({
        email: visitor.email,
        type: visitorType,
        activitySource: 'trackman_auto_match',
        activityDate: new Date(row.booking_date)
      });
      
      // For future bookings, create a session
      let sessionId: number | null = null;
      if (isFuture && row.resource_id) {
        try {
          const sessionResult = await ensureSessionForBooking({
            bookingId: row.id,
            resourceId: row.resource_id,
            sessionDate: row.booking_date,
            startTime: row.start_time,
            endTime: row.end_time || row.start_time,
            ownerEmail: visitor.email || '',
            ownerName: userName || visitor.email,
            ownerUserId: visitor.id?.toString(),
            trackmanBookingId: row.trackman_booking_id,
            source: 'trackman',
            createdBy: 'auto_match'
          });
          sessionId = sessionResult.sessionId || null;
          
          if (sessionId) {
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
      const matchNote = ` [Auto-matched to existing ${visitorType} visitor ${visitor.email} by ${staffEmail || 'system'}]`;
      
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
        visitor.email,
        sessionId,
        matchNote
      ]);
      
      results.push({
        bookingId: row.id,
        matched: true,
        matchType: 'name_match',
        visitorEmail: visitor.email,
        visitorType: visitorType,
        sessionId: sessionId || undefined
      });
      matched++;
      console.log(`[AutoMatch] Matched booking_request #${row.id} -> ${visitor.email} (existing real visitor)`);
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

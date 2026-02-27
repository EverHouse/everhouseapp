import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../logger';
import { ACTIVE_BOOKING_STATUSES } from '../../../shared/constants/statuses';
import { toTextArrayLiteral } from '../../utils/sqlArrayLiteral';

interface UserIdRow {
  id: number;
}

interface BookingConflictRow {
  booking_id: number;
  resource_name: string;
  request_date: string;
  start_time: string;
  end_time: string;
  owner_name: string | null;
  owner_email: string;
}

interface ParticipantConflictRow extends BookingConflictRow {
  invite_status: string;
}

const OCCUPIED_STATUSES = [...ACTIVE_BOOKING_STATUSES, 'checked_in', 'attended'];

export interface ConflictingBooking {
  bookingId: number;
  resourceName: string;
  requestDate: string;
  startTime: string;
  endTime: string;
  ownerName: string | null;
  ownerEmail: string;
  conflictType: 'owner' | 'participant';
}

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflicts: ConflictingBooking[];
}

function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1] || '0', 10);
  return hours * 60 + minutes;
}

/**
 * Check if two time periods overlap, handling cross-midnight cases.
 * A cross-midnight booking (e.g., 23:00-01:00) has end_time < start_time.
 * We handle this by adding 24 hours (1440 minutes) to the end time.
 */
function timePeriodsOverlap(
  start1: string,
  end1: string,
  start2: string,
  end2: string
): boolean {
  let s1 = timeToMinutes(start1);
  let e1 = timeToMinutes(end1);
  let s2 = timeToMinutes(start2);
  let e2 = timeToMinutes(end2);
  
  // Handle cross-midnight: if end < start, add 24 hours to end
  if (e1 < s1) e1 += 1440;
  if (e2 < s2) e2 += 1440;
  
  return s1 < e2 && s2 < e1;
}

/**
 * Find bookings that conflict with the specified time slot for a member.
 * 
 * Handles cross-midnight bookings (e.g., 11pm-1am) on the SAME DATE via timePeriodsOverlap().
 * 
 * NOTE: Adjacent-date cross-midnight conflicts are not checked because:
 * - Club operating hours are 8:30 AM - 10:00 PM (closes before midnight)
 * - Cross-midnight bookings cannot be created through normal booking flows
 * - If overnight bookings become needed, extend this to query adjacent dates
 */
export async function findConflictingBookings(
  memberEmail: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: number
): Promise<ConflictCheckResult> {
  const conflicts: ConflictingBooking[] = [];
  const normalizedEmail = memberEmail.trim().toLowerCase();

  try {
    const memberResult = await db.execute(
      sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${normalizedEmail}) LIMIT 1`
    );
    const memberRows = memberResult.rows as unknown as UserIdRow[];
    const memberId = memberRows[0]?.id;

    const ownerResult = await db.execute(sql`
      SELECT 
        br.id as booking_id,
        COALESCE(r.name, 'Unknown Resource') as resource_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.user_name as owner_name,
        br.user_email as owner_email
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE LOWER(br.user_email) = LOWER(${normalizedEmail})
        AND br.request_date = ${date}
        AND br.status = ANY(${toTextArrayLiteral(OCCUPIED_STATUSES)}::text[])
        ${excludeBookingId ? sql`AND br.id != ${excludeBookingId}` : sql``}
    `);
    
    const ownerRows = ownerResult.rows as unknown as BookingConflictRow[];
    for (const row of ownerRows) {
      if (timePeriodsOverlap(startTime, endTime, String(row.start_time), String(row.end_time))) {
        conflicts.push({
          bookingId: row.booking_id,
          resourceName: row.resource_name,
          requestDate: String(row.request_date),
          startTime: String(row.start_time),
          endTime: String(row.end_time),
          ownerName: row.owner_name,
          ownerEmail: row.owner_email,
          conflictType: 'owner'
        });
      }
    }

    if (memberId) {
      const participantResult = await db.execute(sql`
        SELECT 
          br.id as booking_id,
          COALESCE(r.name, 'Unknown Resource') as resource_name,
          bs.session_date as request_date,
          bs.start_time,
          bs.end_time,
          br.user_name as owner_name,
          br.user_email as owner_email,
          bp.invite_status
        FROM booking_participants bp
        JOIN booking_sessions bs ON bp.session_id = bs.id
        JOIN booking_requests br ON br.session_id = bs.id
        LEFT JOIN resources r ON bs.resource_id = r.id
        WHERE bp.user_id = ${memberId}
          AND bs.session_date = ${date}
          AND bp.invite_status = 'accepted'
          AND br.status = ANY(${toTextArrayLiteral(OCCUPIED_STATUSES)}::text[])
          ${excludeBookingId ? sql`AND br.id != ${excludeBookingId}` : sql``}
      `);
      
      const participantRows = participantResult.rows as unknown as ParticipantConflictRow[];
      for (const row of participantRows) {
        if (timePeriodsOverlap(startTime, endTime, String(row.start_time), String(row.end_time))) {
          const isDuplicate = conflicts.some(c => c.bookingId === row.booking_id);
          if (!isDuplicate) {
            conflicts.push({
              bookingId: row.booking_id,
              resourceName: row.resource_name,
              requestDate: String(row.request_date),
              startTime: String(row.start_time),
              endTime: String(row.end_time),
              ownerName: row.owner_name,
              ownerEmail: row.owner_email,
              conflictType: 'participant'
            });
          }
        }
      }
    }

    const linkedMemberResult = await db.execute(sql`
      SELECT 
        br.id as booking_id,
        COALESCE(r.name, 'Unknown Resource') as resource_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.user_name as owner_name,
        br.user_email as owner_email
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      JOIN booking_requests br ON br.session_id = bs.id
      JOIN users u ON bp.user_id = u.id
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE LOWER(u.email) = LOWER(${normalizedEmail})
        AND bp.invite_status = 'accepted'
        AND br.request_date = ${date}
        AND br.status = ANY(${toTextArrayLiteral(OCCUPIED_STATUSES)}::text[])
        ${excludeBookingId ? sql`AND br.id != ${excludeBookingId}` : sql``}
    `);
    
    const linkedRows = linkedMemberResult.rows as unknown as BookingConflictRow[];
    for (const row of linkedRows) {
      if (timePeriodsOverlap(startTime, endTime, String(row.start_time), String(row.end_time))) {
        const isDuplicate = conflicts.some(c => c.bookingId === row.booking_id);
        if (!isDuplicate) {
          conflicts.push({
            bookingId: row.booking_id,
            resourceName: row.resource_name,
            requestDate: String(row.request_date),
            startTime: String(row.start_time),
            endTime: String(row.end_time),
            ownerName: row.owner_name,
            ownerEmail: row.owner_email,
            conflictType: 'participant'
          });
        }
      }
    }

    if (conflicts.length > 0) {
      logger.info('[conflictDetection] Conflicts found for member', {
        extra: {
          memberEmail: normalizedEmail,
          date,
          startTime,
          endTime,
          conflictCount: conflicts.length,
          conflictBookingIds: conflicts.map(c => c.bookingId)
        }
      });
    }

    return {
      hasConflict: conflicts.length > 0,
      conflicts
    };
  } catch (error: unknown) {
    logger.error('[conflictDetection] Error checking conflicts', {
      error,
      extra: { memberEmail, date, startTime, endTime }
    });
    throw error;
  }
}

export async function checkMemberAvailability(
  memberEmail: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: number
): Promise<{ available: boolean; conflicts: ConflictingBooking[] }> {
  const result = await findConflictingBookings(memberEmail, date, startTime, endTime, excludeBookingId);
  return {
    available: !result.hasConflict,
    conflicts: result.conflicts
  };
}

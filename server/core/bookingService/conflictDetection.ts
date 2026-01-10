import { pool } from '../db';
import { logger } from '../logger';

export interface ConflictingBooking {
  bookingId: number;
  resourceName: string;
  requestDate: string;
  startTime: string;
  endTime: string;
  ownerName: string | null;
  ownerEmail: string;
  conflictType: 'owner' | 'participant' | 'invite';
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

function timePeriodsOverlap(
  start1: string,
  end1: string,
  start2: string,
  end2: string
): boolean {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);
  return s1 < e2 && s2 < e1;
}

export async function findConflictingBookings(
  memberEmail: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: number
): Promise<ConflictCheckResult> {
  const conflicts: ConflictingBooking[] = [];
  const normalizedEmail = memberEmail.toLowerCase();

  try {
    const memberResult = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [normalizedEmail]
    );
    const memberId = memberResult.rows[0]?.id;

    const ownerQuery = `
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
      WHERE LOWER(br.user_email) = LOWER($1)
        AND br.request_date = $2
        AND br.status IN ('pending', 'approved', 'confirmed')
        ${excludeBookingId ? 'AND br.id != $5' : ''}
    `;
    const ownerParams = excludeBookingId 
      ? [normalizedEmail, date, startTime, endTime, excludeBookingId]
      : [normalizedEmail, date, startTime, endTime];
    
    const ownerResult = await pool.query(ownerQuery, ownerParams);
    
    for (const row of ownerResult.rows) {
      if (timePeriodsOverlap(startTime, endTime, row.start_time, row.end_time)) {
        conflicts.push({
          bookingId: row.booking_id,
          resourceName: row.resource_name,
          requestDate: row.request_date,
          startTime: row.start_time,
          endTime: row.end_time,
          ownerName: row.owner_name,
          ownerEmail: row.owner_email,
          conflictType: 'owner'
        });
      }
    }

    if (memberId) {
      const participantQuery = `
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
        WHERE bp.user_id = $1
          AND bs.session_date = $2
          AND bp.invite_status IN ('pending', 'accepted')
          AND br.status IN ('pending', 'approved', 'confirmed')
          ${excludeBookingId ? 'AND br.id != $5' : ''}
      `;
      const participantParams = excludeBookingId
        ? [memberId, date, startTime, endTime, excludeBookingId]
        : [memberId, date, startTime, endTime];
      
      const participantResult = await pool.query(participantQuery, participantParams);
      
      for (const row of participantResult.rows) {
        if (timePeriodsOverlap(startTime, endTime, row.start_time, row.end_time)) {
          const isDuplicate = conflicts.some(c => c.bookingId === row.booking_id);
          if (!isDuplicate) {
            conflicts.push({
              bookingId: row.booking_id,
              resourceName: row.resource_name,
              requestDate: row.request_date,
              startTime: row.start_time,
              endTime: row.end_time,
              ownerName: row.owner_name,
              ownerEmail: row.owner_email,
              conflictType: 'participant'
            });
          }
        }
      }
    }

    const inviteQuery = `
      SELECT 
        br.id as booking_id,
        COALESCE(r.name, 'Unknown Resource') as resource_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.user_name as owner_name,
        br.user_email as owner_email
      FROM booking_members bm
      JOIN booking_requests br ON bm.booking_id = br.id
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE LOWER(bm.user_email) = LOWER($1)
        AND br.request_date = $2
        AND br.status IN ('pending', 'approved', 'confirmed')
        ${excludeBookingId ? 'AND br.id != $5' : ''}
    `;
    const inviteParams = excludeBookingId
      ? [normalizedEmail, date, startTime, endTime, excludeBookingId]
      : [normalizedEmail, date, startTime, endTime];
    
    const inviteResult = await pool.query(inviteQuery, inviteParams);
    
    for (const row of inviteResult.rows) {
      if (timePeriodsOverlap(startTime, endTime, row.start_time, row.end_time)) {
        const isDuplicate = conflicts.some(c => c.bookingId === row.booking_id);
        if (!isDuplicate) {
          conflicts.push({
            bookingId: row.booking_id,
            resourceName: row.resource_name,
            requestDate: row.request_date,
            startTime: row.start_time,
            endTime: row.end_time,
            ownerName: row.owner_name,
            ownerEmail: row.owner_email,
            conflictType: 'invite'
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
  } catch (error) {
    logger.error('[conflictDetection] Error checking conflicts', {
      error: error as Error,
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

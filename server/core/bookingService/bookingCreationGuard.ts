import { sql } from 'drizzle-orm';
import { logger } from '../logger';
import { formatTime12Hour } from '../../utils/dateUtils';
import { getErrorMessage } from '../../utils/errorUtils';

function isUndefinedTableError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('42P01') || msg.includes('does not exist');
}

export class BookingConflictError extends Error {
  constructor(public statusCode: number, public errorBody: Record<string, unknown>) {
    super(typeof errorBody.error === 'string' ? errorBody.error : 'Booking conflict');
    this.name = 'BookingConflictError';
  }
}

interface BookingCreationGuardParams {
  resourceId: number | null;
  requestDate: string;
  startTime: string;
  endTime: string;
  requestEmail: string;
  isStaffRequest: boolean;
  isViewAsMode: boolean;
  resourceType: string;
}

export async function acquireBookingLocks(
  tx: { execute: (query: unknown) => Promise<{ rows: Record<string, unknown>[] }> },
  params: BookingCreationGuardParams
): Promise<void> {
  const { resourceId, requestDate, requestEmail, isStaffRequest, isViewAsMode, resourceType } = params;

  const lockIdentifiers: string[] = [];

  if (resourceId) {
    lockIdentifiers.push(`${String(resourceId)}::${requestDate}`);
  }

  const needsUserLock = !isStaffRequest || isViewAsMode;
  if (needsUserLock) {
    lockIdentifiers.push(requestEmail);
  }

  lockIdentifiers.sort();

  for (const lockId of lockIdentifiers) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockId}))`);
    logger.debug('[BookingGuard] Acquired advisory lock', { extra: { lockId } });
  }

  if (needsUserLock && resourceType !== 'conference_room') {
    const pendingCheck = await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM booking_requests
      WHERE LOWER(user_email) = LOWER(${requestEmail}) AND status = 'pending'
    `);
    if ((pendingCheck.rows[0] as Record<string, unknown>).cnt as number > 0) {
      throw new BookingConflictError(409, {
        error: 'You already have a pending request. Please wait for it to be approved or denied before requesting another slot.'
      });
    }
  }
}

export async function checkResourceOverlap(
  tx: { execute: (query: unknown) => Promise<{ rows: Record<string, unknown>[] }> },
  params: Pick<BookingCreationGuardParams, 'resourceId' | 'requestDate' | 'startTime' | 'endTime'>
): Promise<void> {
  const { resourceId, requestDate, startTime, endTime } = params;

  if (!resourceId) return;

  const overlapCheck = await tx.execute(sql`
    SELECT id, start_time, end_time FROM booking_requests 
    WHERE resource_id = ${resourceId} 
    AND request_date = ${requestDate} 
    AND status IN ('pending', 'pending_approval', 'approved', 'confirmed', 'attended', 'cancellation_pending')
    AND start_time < ${endTime} AND end_time > ${startTime}
    ORDER BY id ASC
    FOR UPDATE
  `);

  if (overlapCheck.rows.length > 0) {
    const conflict = overlapCheck.rows[0] as Record<string, unknown>;
    const conflictStart = (conflict.start_time as string)?.substring(0, 5);
    const conflictEnd = (conflict.end_time as string)?.substring(0, 5);

    const errorMsg = conflictStart && conflictEnd
      ? `This time slot conflicts with an existing booking from ${formatTime12Hour(conflictStart)} to ${formatTime12Hour(conflictEnd)}. Please adjust your time or duration.`
      : 'This time slot is already booked';

    throw new BookingConflictError(409, { error: errorMsg });
  }

  let trackmanBayCheck: { rows: Record<string, unknown>[] };
  try {
    trackmanBayCheck = await tx.execute(sql`
      SELECT resource_id, start_time, end_time FROM trackman_bay_slots
      WHERE resource_id = ${resourceId}
      AND slot_date = ${requestDate}
      AND status = 'booked'
      AND start_time < ${endTime} AND end_time > ${startTime}
      LIMIT 1
    `);
  } catch (err: unknown) {
    if (isUndefinedTableError(err)) {
      trackmanBayCheck = { rows: [] };
    } else {
      logger.error('[BookingGuard] Failed to check trackman_bay_slots', { extra: { error: getErrorMessage(err) } });
      throw new BookingConflictError(503, { error: 'Unable to verify slot availability. Please try again.' });
    }
  }

  if (trackmanBayCheck.rows.length > 0) {
    const conflict = trackmanBayCheck.rows[0] as Record<string, unknown>;
    const conflictStart = (conflict.start_time as string)?.substring(0, 5);
    const conflictEnd = (conflict.end_time as string)?.substring(0, 5);

    const errorMsg = conflictStart && conflictEnd
      ? `This time slot conflicts with a Trackman booking from ${formatTime12Hour(conflictStart)} to ${formatTime12Hour(conflictEnd)}. Please choose a different time.`
      : 'This time slot conflicts with an existing Trackman booking';

    throw new BookingConflictError(409, { error: errorMsg });
  }

  const resourceIdStr = String(resourceId);
  let unmatchedCheck: { rows: Record<string, unknown>[] };
  try {
    unmatchedCheck = await tx.execute(sql`
      SELECT tub.bay_number, tub.start_time, tub.end_time FROM trackman_unmatched_bookings tub
      WHERE tub.bay_number = ${resourceIdStr}
      AND tub.booking_date = ${requestDate}
      AND tub.resolved_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM booking_requests br
        WHERE br.trackman_booking_id = tub.trackman_booking_id::text
      )
      AND tub.start_time < ${endTime} AND tub.end_time > ${startTime}
      LIMIT 1
    `);
  } catch (err: unknown) {
    if (isUndefinedTableError(err)) {
      unmatchedCheck = { rows: [] };
    } else {
      logger.error('[BookingGuard] Failed to check trackman_unmatched_bookings', { extra: { error: getErrorMessage(err) } });
      throw new BookingConflictError(503, { error: 'Unable to verify slot availability. Please try again.' });
    }
  }

  if (unmatchedCheck.rows.length > 0) {
    const conflict = unmatchedCheck.rows[0] as Record<string, unknown>;
    const conflictStart = (conflict.start_time as string)?.substring(0, 5);
    const conflictEnd = (conflict.end_time as string)?.substring(0, 5);

    const errorMsg = conflictStart && conflictEnd
      ? `This time slot conflicts with an unresolved Trackman booking from ${formatTime12Hour(conflictStart)} to ${formatTime12Hour(conflictEnd)}. Please choose a different time.`
      : 'This time slot conflicts with an unresolved Trackman booking';

    throw new BookingConflictError(409, { error: errorMsg });
  }

  let sessionCheck: { rows: Record<string, unknown>[] };
  try {
    sessionCheck = await tx.execute(sql`
      SELECT bs.id, bs.start_time, bs.end_time FROM booking_sessions bs
      WHERE bs.resource_id = ${resourceId}
      AND bs.session_date = ${requestDate}
      AND bs.start_time < ${endTime} AND bs.end_time > ${startTime}
      AND EXISTS (
        SELECT 1 FROM booking_requests br
        WHERE br.session_id = bs.id
        AND br.status NOT IN ('cancelled', 'deleted', 'declined')
      )
      LIMIT 1
    `);
  } catch (err: unknown) {
    if (isUndefinedTableError(err)) {
      sessionCheck = { rows: [] };
    } else {
      logger.error('[BookingGuard] Failed to check booking_sessions', { extra: { error: getErrorMessage(err) } });
      throw new BookingConflictError(503, { error: 'Unable to verify slot availability. Please try again.' });
    }
  }

  if (sessionCheck.rows.length > 0) {
    const conflict = sessionCheck.rows[0] as Record<string, unknown>;
    const conflictStart = (conflict.start_time as string)?.substring(0, 5);
    const conflictEnd = (conflict.end_time as string)?.substring(0, 5);

    const errorMsg = conflictStart && conflictEnd
      ? `This time slot conflicts with an active session from ${formatTime12Hour(conflictStart)} to ${formatTime12Hour(conflictEnd)}. Please choose a different time.`
      : 'This time slot conflicts with an active session';

    throw new BookingConflictError(409, { error: errorMsg });
  }
}

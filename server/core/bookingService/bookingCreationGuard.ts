import { sql } from 'drizzle-orm';
import { logger } from '../logger';
import { formatTime12Hour } from '../../utils/dateUtils';

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

  if (resourceId) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${String(resourceId)} || '::' || ${requestDate}))`);
    logger.debug('[BookingGuard] Acquired resource advisory lock', { extra: { resourceId, requestDate } });
  }

  if (!isStaffRequest || isViewAsMode) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${requestEmail}))`);
    if (resourceType !== 'conference_room') {
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
}

import { db } from '../db';
import { facilityClosures, bookingRequests, availabilityBlocks } from '../../shared/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { parseAffectedAreasBatch } from './affectedAreas';
import { logger } from './logger';
import { getErrorMessage, getErrorCode } from '../utils/errorUtils';

interface ClosureCacheEntry {
  closures: Record<string, unknown>[];
  expiry: number;
}

const closureCache = new Map<string, ClosureCacheEntry>();
const CLOSURE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const CLOSURE_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const pruneInterval = setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [key, entry] of closureCache) {
    if (entry.expiry <= now) {
      closureCache.delete(key);
      pruned++;
    }
  }
  if (pruned > 0) {
    logger.info(`[Cache] Pruned ${pruned} expired closure cache entries (${closureCache.size} remaining)`);
  }
}, CLOSURE_CACHE_PRUNE_INTERVAL_MS);
pruneInterval.unref();

export function clearClosureCache(): void {
  closureCache.clear();
  logger.info('[Cache] Closure cache cleared');
}

export function parseTimeToMinutes(time: string | null | undefined): number {
  if (!time) return 0;
  const parts = time.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

export function hasTimeOverlap(start1: number, end1: number, start2: number, end2: number): boolean {
  const normalizedEnd1 = start1 > end1 ? end1 + 1440 : end1;
  const normalizedEnd2 = start2 > end2 ? end2 + 1440 : end2;

  const overlapsNormal = Math.max(start1, start2) < Math.min(normalizedEnd1, normalizedEnd2);

  if (start1 > end1 && start2 <= end2) {
    return overlapsNormal || (start2 < end1);
  }
  if (start2 > end2 && start1 <= end1) {
    return overlapsNormal || (start1 < end2);
  }

  return overlapsNormal;
}

async function getActiveClosuresForDate(bookingDate: string, txClient?: { select: typeof db.select, execute: typeof db.execute }): Promise<Record<string, unknown>[]> {
  if (txClient) {
    return txClient
      .select()
      .from(facilityClosures)
      .where(and(
        eq(facilityClosures.isActive, true),
        sql`${facilityClosures.startDate} <= ${bookingDate}`,
        sql`${facilityClosures.endDate} >= ${bookingDate}`
      ));
  }

  const cacheKey = `closures_${bookingDate}`;
  const cached = closureCache.get(cacheKey);
  
  if (cached && cached.expiry > Date.now()) {
    return cached.closures;
  }
  
  const closures = await db
    .select()
    .from(facilityClosures)
    .where(and(
      eq(facilityClosures.isActive, true),
      sql`${facilityClosures.startDate} <= ${bookingDate}`,
      sql`${facilityClosures.endDate} >= ${bookingDate}`
    ));
  
  closureCache.set(cacheKey, {
    closures,
    expiry: Date.now() + CLOSURE_CACHE_TTL_MS
  });
  
  return closures;
}

export async function checkClosureConflict(
  resourceId: number,
  bookingDate: string,
  startTime: string,
  endTime: string,
  txClient?: { select: typeof db.select, execute: typeof db.execute }
): Promise<{ hasConflict: boolean; closureTitle?: string }> {
  try {
    const activeClosures = await getActiveClosuresForDate(bookingDate, txClient);

    const bookingStartMinutes = parseTimeToMinutes(startTime);
    const bookingEndMinutes = parseTimeToMinutes(endTime);

    const allAffectedIds = await parseAffectedAreasBatch(
      activeClosures.map(c => c.affectedAreas as string)
    );

    for (let i = 0; i < activeClosures.length; i++) {
      const closure = activeClosures[i];
      const affectedResourceIds = allAffectedIds[i];

      if (!affectedResourceIds.includes(resourceId)) continue;

      if (!closure.startTime && !closure.endTime) {
        return { hasConflict: true, closureTitle: (closure.title as string) || 'Facility Closure' };
      }

      const closureStartDate = (closure.startDate as string);
      const closureEndDate = (closure.endDate as string);
      const isStartDate = bookingDate === closureStartDate;
      const isEndDate = bookingDate === closureEndDate;
      const isIntermediateDay = !isStartDate && !isEndDate;

      let effectiveStartMinutes: number;
      let effectiveEndMinutes: number;

      if (isIntermediateDay) {
        effectiveStartMinutes = 0;
        effectiveEndMinutes = 24 * 60;
      } else if (isStartDate && isEndDate) {
        effectiveStartMinutes = closure.startTime ? parseTimeToMinutes(closure.startTime as string) : 0;
        effectiveEndMinutes = closure.endTime ? parseTimeToMinutes(closure.endTime as string) : 24 * 60;
        if (effectiveEndMinutes === 0 && closure.endTime) {
          effectiveEndMinutes = 24 * 60;
        }
      } else if (isStartDate) {
        effectiveStartMinutes = closure.startTime ? parseTimeToMinutes(closure.startTime as string) : 0;
        effectiveEndMinutes = 24 * 60;
      } else {
        effectiveStartMinutes = 0;
        effectiveEndMinutes = closure.endTime ? parseTimeToMinutes(closure.endTime as string) : 24 * 60;
        if (effectiveEndMinutes === 0 && closure.endTime) {
          effectiveEndMinutes = 24 * 60;
        }
      }

      if (hasTimeOverlap(bookingStartMinutes, bookingEndMinutes, effectiveStartMinutes, effectiveEndMinutes)) {
        return { hasConflict: true, closureTitle: (closure.title as string) || 'Facility Closure' };
      }
    }

    return { hasConflict: false };
  } catch (error: unknown) {
    logger.error('[checkClosureConflict] Error checking closure conflict:', { error: new Error(getErrorMessage(error)) });
    throw error;
  }
}

export async function checkBookingConflict(
  resourceId: number,
  bookingDate: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: number
): Promise<{ hasConflict: boolean; conflictingBooking?: Record<string, unknown>; conflictSource?: string }> {
  try {
    const conditions = [
      eq(bookingRequests.resourceId, resourceId),
      sql`${bookingRequests.requestDate} = ${bookingDate}`,
      or(
        eq(bookingRequests.status, 'pending'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'pending_approval'),
        eq(bookingRequests.status, 'attended'),
        eq(bookingRequests.status, 'cancellation_pending')
      ),
      and(
        sql`${bookingRequests.startTime}::time < ${endTime ?? null}::time`,
        sql`${bookingRequests.endTime}::time > ${startTime ?? null}::time`
      )
    ];

    const existingBookings = await db
      .select()
      .from(bookingRequests)
      .where(and(...conditions));

    const conflicts = excludeBookingId
      ? existingBookings.filter(b => b.id !== excludeBookingId)
      : existingBookings;

    if (conflicts.length > 0) {
      return { hasConflict: true, conflictingBooking: conflicts[0], conflictSource: 'booking_request' };
    }

    try {
      const trackmanBayResult = await db.execute(sql`
        SELECT resource_id, start_time, end_time FROM trackman_bay_slots
        WHERE resource_id = ${resourceId}
        AND slot_date = ${bookingDate}
        AND status = 'booked'
        AND start_time < ${endTime} AND end_time > ${startTime}
        LIMIT 1
      `);
      if (trackmanBayResult.rows.length > 0) {
        return { hasConflict: true, conflictingBooking: trackmanBayResult.rows[0] as Record<string, unknown>, conflictSource: 'trackman_bay_slot' };
      }
    } catch (err: unknown) {
      if (getErrorCode(err) !== '42P01') {
        logger.error('[checkBookingConflict] Failed to check trackman_bay_slots', { error: err instanceof Error ? err : new Error(String(err)) });
        throw err;
      }
    }

    const resourceIdStr = String(resourceId);
    try {
      const unmatchedResult = await db.execute(sql`
        SELECT tub.bay_number, tub.start_time, tub.end_time FROM trackman_unmatched_bookings tub
        WHERE tub.bay_number = ${resourceIdStr}
        AND tub.booking_date = ${bookingDate}
        AND tub.resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM booking_requests br
          WHERE br.trackman_booking_id = tub.trackman_booking_id::text
        )
        AND tub.start_time < ${endTime} AND tub.end_time > ${startTime}
        LIMIT 1
      `);
      if (unmatchedResult.rows.length > 0) {
        return { hasConflict: true, conflictingBooking: unmatchedResult.rows[0] as Record<string, unknown>, conflictSource: 'trackman_unmatched' };
      }
    } catch (err: unknown) {
      if (getErrorCode(err) !== '42P01') {
        logger.error('[checkBookingConflict] Failed to check trackman_unmatched_bookings', { error: err instanceof Error ? err : new Error(String(err)) });
        throw err;
      }
    }

    try {
      const sessionResult = await db.execute(sql`
        SELECT bs.id, bs.start_time, bs.end_time FROM booking_sessions bs
        WHERE bs.resource_id = ${resourceId}
        AND bs.session_date = ${bookingDate}
        AND bs.start_time < ${endTime} AND bs.end_time > ${startTime}
        AND EXISTS (
          SELECT 1 FROM booking_requests br
          WHERE br.session_id = bs.id
          AND br.status NOT IN ('cancelled', 'deleted', 'declined')
        )
        LIMIT 1
      `);
      if (sessionResult.rows.length > 0) {
        return { hasConflict: true, conflictingBooking: sessionResult.rows[0] as Record<string, unknown>, conflictSource: 'booking_session' };
      }
    } catch (err: unknown) {
      if (getErrorCode(err) !== '42P01') {
        logger.error('[checkBookingConflict] Failed to check booking_sessions', { error: err instanceof Error ? err : new Error(String(err)) });
        throw err;
      }
    }

    return { hasConflict: false };
  } catch (error: unknown) {
    logger.error('[checkBookingConflict] Error checking booking conflict:', { error: new Error(getErrorMessage(error)) });
    throw error;
  }
}

export async function checkAvailabilityBlockConflict(
  resourceId: number,
  bookingDate: string,
  startTime: string,
  endTime: string,
  txClient?: { select: typeof db.select, execute: typeof db.execute }
): Promise<{ hasConflict: boolean; blockType?: string; blockNotes?: string }> {
  try {
    const dbCtx = txClient || db;
    const blocks = await dbCtx
      .select()
      .from(availabilityBlocks)
      .where(and(
        eq(availabilityBlocks.resourceId, resourceId),
        sql`${availabilityBlocks.blockDate} = ${bookingDate}`,
        and(
          sql`${availabilityBlocks.startTime}::time < ${endTime ?? null}::time`,
          sql`${availabilityBlocks.endTime}::time > ${startTime ?? null}::time`
        )
      ));

    if (blocks.length > 0) {
      const block = blocks[0];
      return { 
        hasConflict: true, 
        blockType: block.blockType || 'Event Block',
        blockNotes: block.notes || undefined
      };
    }

    return { hasConflict: false };
  } catch (error: unknown) {
    logger.error('[checkAvailabilityBlockConflict] Error checking availability block conflict:', { error: new Error(getErrorMessage(error)) });
    throw error;
  }
}

export async function checkAllConflicts(
  resourceId: number,
  bookingDate: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: number
): Promise<{ hasConflict: boolean; conflictType?: 'closure' | 'availability_block' | 'booking'; conflictTitle?: string }> {
  const closureCheck = await checkClosureConflict(resourceId, bookingDate, startTime, endTime);
  if (closureCheck.hasConflict) {
    return { hasConflict: true, conflictType: 'closure', conflictTitle: closureCheck.closureTitle || 'Facility Closure' };
  }

  const blockCheck = await checkAvailabilityBlockConflict(resourceId, bookingDate, startTime, endTime);
  if (blockCheck.hasConflict) {
    return { hasConflict: true, conflictType: 'availability_block', conflictTitle: blockCheck.blockType || 'Event Block' };
  }

  const bookingCheck = await checkBookingConflict(resourceId, bookingDate, startTime, endTime, excludeBookingId);
  if (bookingCheck.hasConflict) {
    return { hasConflict: true, conflictType: 'booking', conflictTitle: 'Existing Booking' };
  }

  return { hasConflict: false };
}

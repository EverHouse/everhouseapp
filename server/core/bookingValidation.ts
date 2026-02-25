import { db } from '../db';
import { facilityClosures, bookingRequests, availabilityBlocks } from '../../shared/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { parseAffectedAreas } from './affectedAreas';
import { logger } from './logger';

interface ClosureCacheEntry {
  closures: Record<string, unknown>[];
  expiry: number;
}

const closureCache = new Map<string, ClosureCacheEntry>();
const CLOSURE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const CLOSURE_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
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
  if (start2 > end2) {
    // Overnight wrap-around: split into [start2, 1440) and [0, end2)
    return (start1 < 1440 && end1 > start2) || (start1 < end2 && end1 > 0);
  }
  return start1 < end2 && end1 > start2;
}

async function getActiveClosuresForDate(bookingDate: string): Promise<Record<string, unknown>[]> {
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
  endTime: string
): Promise<{ hasConflict: boolean; closureTitle?: string }> {
  try {
    const activeClosures = await getActiveClosuresForDate(bookingDate);

    const bookingStartMinutes = parseTimeToMinutes(startTime);
    const bookingEndMinutes = parseTimeToMinutes(endTime);

    for (const closure of activeClosures) {
      const affectedResourceIds = await parseAffectedAreas(closure.affectedAreas as string);

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
    logger.error('[checkClosureConflict] Error checking closure conflict:', error);
    throw error;
  }
}

export async function checkBookingConflict(
  resourceId: number,
  bookingDate: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: number
): Promise<{ hasConflict: boolean; conflictingBooking?: Record<string, unknown> }> {
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
        sql`${bookingRequests.startTime}::time < ${endTime}::time`,
        sql`${bookingRequests.endTime}::time > ${startTime}::time`
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
      return { hasConflict: true, conflictingBooking: conflicts[0] };
    }

    return { hasConflict: false };
  } catch (error: unknown) {
    logger.error('[checkBookingConflict] Error checking booking conflict:', error);
    throw error;
  }
}

export async function checkAvailabilityBlockConflict(
  resourceId: number,
  bookingDate: string,
  startTime: string,
  endTime: string
): Promise<{ hasConflict: boolean; blockType?: string; blockNotes?: string }> {
  try {
    const blocks = await db
      .select()
      .from(availabilityBlocks)
      .where(and(
        eq(availabilityBlocks.resourceId, resourceId),
        sql`${availabilityBlocks.blockDate} = ${bookingDate}`,
        and(
          sql`${availabilityBlocks.startTime}::time < ${endTime}::time`,
          sql`${availabilityBlocks.endTime}::time > ${startTime}::time`
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
    logger.error('[checkAvailabilityBlockConflict] Error checking availability block conflict:', error);
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

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

      const closureStartMinutes = closure.startTime ? parseTimeToMinutes(closure.startTime as string) : 0;
      let closureEndMinutes = closure.endTime ? parseTimeToMinutes(closure.endTime as string) : 24 * 60;
      if (closureEndMinutes === 0 && closure.endTime) {
        closureEndMinutes = 24 * 60;
      }

      if (hasTimeOverlap(bookingStartMinutes, bookingEndMinutes, closureStartMinutes, closureEndMinutes)) {
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
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'pending_approval')
      ),
      and(
        sql`${bookingRequests.startTime} < ${endTime}`,
        sql`${bookingRequests.endTime} > ${startTime}`
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
          sql`${availabilityBlocks.startTime} < ${endTime}`,
          sql`${availabilityBlocks.endTime} > ${startTime}`
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

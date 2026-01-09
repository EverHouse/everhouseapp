import { db } from '../db';
import { facilityClosures, bookingRequests } from '../../shared/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { parseAffectedAreas } from './affectedAreas';
import { logger } from './logger';

interface ClosureCacheEntry {
  closures: any[];
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

async function getActiveClosuresForDate(bookingDate: string): Promise<any[]> {
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
      const affectedResourceIds = await parseAffectedAreas(closure.affectedAreas);

      if (!affectedResourceIds.includes(resourceId)) continue;

      if (!closure.startTime && !closure.endTime) {
        return { hasConflict: true, closureTitle: closure.title || 'Facility Closure' };
      }

      const closureStartMinutes = closure.startTime ? parseTimeToMinutes(closure.startTime) : 0;
      let closureEndMinutes = closure.endTime ? parseTimeToMinutes(closure.endTime) : 24 * 60;
      if (closureEndMinutes === 0 && closure.endTime) {
        closureEndMinutes = 24 * 60;
      }

      if (hasTimeOverlap(bookingStartMinutes, bookingEndMinutes, closureStartMinutes, closureEndMinutes)) {
        return { hasConflict: true, closureTitle: closure.title || 'Facility Closure' };
      }
    }

    return { hasConflict: false };
  } catch (error) {
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
): Promise<{ hasConflict: boolean; conflictingBooking?: any }> {
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
  } catch (error) {
    logger.error('[checkBookingConflict] Error checking booking conflict:', error);
    throw error;
  }
}

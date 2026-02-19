import { db } from '../../db';
import { getErrorCode } from '../../utils/errorUtils';
import { pool } from '../db';
import { PoolClient } from 'pg';
import { 
  bookingSessions, 
  availabilityBlocks, 
  facilityClosures 
} from '../../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../logger';
import { 
  checkClosureConflict, 
  checkAvailabilityBlockConflict,
  parseTimeToMinutes,
  hasTimeOverlap
} from '../bookingValidation';
import { parseAffectedAreas } from '../affectedAreas';

export interface AvailabilityResult {
  available: boolean;
  conflictType?: 'closure' | 'availability_block' | 'session';
  conflictTitle?: string;
  conflictDetails?: {
    id: number;
    startTime: string;
    endTime: string;
  };
}

export async function checkUnifiedAvailability(
  resourceId: number,
  date: string,
  startTime: string,
  endTime: string,
  excludeSessionId?: number
): Promise<AvailabilityResult> {
  try {
    const closureConflict = await checkClosureConflict(resourceId, date, startTime, endTime);
    if (closureConflict.hasConflict) {
      return {
        available: false,
        conflictType: 'closure',
        conflictTitle: closureConflict.closureTitle || 'Facility Closure'
      };
    }
    
    const blockConflict = await checkAvailabilityBlockConflict(resourceId, date, startTime, endTime);
    if (blockConflict.hasConflict) {
      return {
        available: false,
        conflictType: 'availability_block',
        conflictTitle: blockConflict.blockType || 'Event Block'
      };
    }
    
    const sessionConflict = await checkSessionConflict(resourceId, date, startTime, endTime, excludeSessionId);
    if (sessionConflict.hasConflict) {
      return {
        available: false,
        conflictType: 'session',
        conflictTitle: 'Existing Booking Session',
        conflictDetails: sessionConflict.conflictDetails
      };
    }
    
    return { available: true };
  } catch (error: unknown) {
    logger.error('[checkUnifiedAvailability] Error:', { error });
    throw error;
  }
}

interface SessionConflictResult {
  hasConflict: boolean;
  conflictDetails?: {
    id: number;
    startTime: string;
    endTime: string;
  };
}

async function checkSessionConflict(
  resourceId: number,
  date: string,
  startTime: string,
  endTime: string,
  excludeSessionId?: number
): Promise<SessionConflictResult> {
  try {
    const result = await pool.query(
      `SELECT id, start_time, end_time
       FROM booking_sessions
       WHERE resource_id = $1
         AND session_date = $2
         AND start_time < $3
         AND end_time > $4
         ${excludeSessionId ? 'AND id != $5' : ''}
       LIMIT 1`,
      excludeSessionId 
        ? [resourceId, date, endTime, startTime, excludeSessionId]
        : [resourceId, date, endTime, startTime]
    );
    
    if (result.rows.length > 0) {
      const conflict = result.rows[0];
      return {
        hasConflict: true,
        conflictDetails: {
          id: conflict.id,
          startTime: conflict.start_time,
          endTime: conflict.end_time
        }
      };
    }
    
    return { hasConflict: false };
  } catch (error: unknown) {
    logger.error('[checkSessionConflict] Error:', { error });
    throw error;
  }
}

export async function checkSessionConflictWithLock(
  client: PoolClient,
  resourceId: number,
  date: string,
  startTime: string,
  endTime: string,
  excludeSessionId?: number
): Promise<SessionConflictResult> {
  try {
    const result = await client.query(
      `SELECT id, start_time, end_time
       FROM booking_sessions
       WHERE resource_id = $1
         AND session_date = $2
         AND start_time < $3
         AND end_time > $4
         ${excludeSessionId ? 'AND id != $5' : ''}
       FOR UPDATE NOWAIT
       LIMIT 1`,
      excludeSessionId 
        ? [resourceId, date, endTime, startTime, excludeSessionId]
        : [resourceId, date, endTime, startTime]
    );
    
    if (result.rows.length > 0) {
      const conflict = result.rows[0];
      return {
        hasConflict: true,
        conflictDetails: {
          id: conflict.id,
          startTime: conflict.start_time,
          endTime: conflict.end_time
        }
      };
    }
    
    return { hasConflict: false };
  } catch (error: unknown) {
    if (getErrorCode(error) === '55P03') {
      logger.warn('[checkSessionConflictWithLock] Row locked by concurrent transaction', {
        extra: { resourceId, date, startTime, endTime }
      });
      return {
        hasConflict: true,
        conflictDetails: undefined
      };
    }
    logger.error('[checkSessionConflictWithLock] Error:', { error });
    throw error;
  }
}

export async function checkUnifiedAvailabilityWithLock(
  client: PoolClient,
  resourceId: number,
  date: string,
  startTime: string,
  endTime: string,
  excludeSessionId?: number
): Promise<AvailabilityResult> {
  try {
    const closureConflict = await checkClosureConflict(resourceId, date, startTime, endTime);
    if (closureConflict.hasConflict) {
      return {
        available: false,
        conflictType: 'closure',
        conflictTitle: closureConflict.closureTitle || 'Facility Closure'
      };
    }
    
    const blockConflict = await checkAvailabilityBlockConflict(resourceId, date, startTime, endTime);
    if (blockConflict.hasConflict) {
      return {
        available: false,
        conflictType: 'availability_block',
        conflictTitle: blockConflict.blockType || 'Event Block'
      };
    }
    
    const sessionConflict = await checkSessionConflictWithLock(client, resourceId, date, startTime, endTime, excludeSessionId);
    if (sessionConflict.hasConflict) {
      return {
        available: false,
        conflictType: 'session',
        conflictTitle: 'Existing Booking Session',
        conflictDetails: sessionConflict.conflictDetails
      };
    }
    
    return { available: true };
  } catch (error: unknown) {
    logger.error('[checkUnifiedAvailabilityWithLock] Error:', { error });
    throw error;
  }
}

export async function getAvailableSlots(
  resourceId: number,
  date: string,
  slotDurationMinutes: number = 60,
  operatingStart: string = '06:00',
  operatingEnd: string = '22:00'
): Promise<{ startTime: string; endTime: string }[]> {
  try {
    const sessions = await pool.query(
      `SELECT start_time, end_time FROM booking_sessions
       WHERE resource_id = $1 AND session_date = $2
       ORDER BY start_time`,
      [resourceId, date]
    );
    
    const blocks = await pool.query(
      `SELECT start_time, end_time FROM availability_blocks
       WHERE resource_id = $1 AND block_date = $2
       ORDER BY start_time`,
      [resourceId, date]
    );
    
    const bookedSlots: { start: number; end: number }[] = [];
    
    for (const session of sessions.rows) {
      bookedSlots.push({
        start: parseTimeToMinutes(session.start_time),
        end: parseTimeToMinutes(session.end_time)
      });
    }
    
    for (const block of blocks.rows) {
      bookedSlots.push({
        start: parseTimeToMinutes(block.start_time),
        end: parseTimeToMinutes(block.end_time)
      });
    }
    
    bookedSlots.sort((a, b) => a.start - b.start);
    
    const operatingStartMinutes = parseTimeToMinutes(operatingStart);
    const operatingEndMinutes = parseTimeToMinutes(operatingEnd);
    
    const availableSlots: { startTime: string; endTime: string }[] = [];
    let currentTime = operatingStartMinutes;
    
    for (const slot of bookedSlots) {
      if (currentTime + slotDurationMinutes <= slot.start) {
        for (let t = currentTime; t + slotDurationMinutes <= slot.start; t += slotDurationMinutes) {
          availableSlots.push({
            startTime: minutesToTime(t),
            endTime: minutesToTime(t + slotDurationMinutes)
          });
        }
      }
      currentTime = Math.max(currentTime, slot.end);
    }
    
    for (let t = currentTime; t + slotDurationMinutes <= operatingEndMinutes; t += slotDurationMinutes) {
      availableSlots.push({
        startTime: minutesToTime(t),
        endTime: minutesToTime(t + slotDurationMinutes)
      });
    }
    
    return availableSlots;
  } catch (error: unknown) {
    logger.error('[getAvailableSlots] Error:', { error });
    return [];
  }
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

export async function isResourceAvailableForDate(
  resourceId: number,
  date: string
): Promise<boolean> {
  try {
    const closures = await pool.query(
      `SELECT id, affected_areas FROM facility_closures
       WHERE is_active = true
         AND start_date <= $1
         AND end_date >= $1
         AND start_time IS NULL
         AND end_time IS NULL`,
      [date]
    );
    
    for (const closure of closures.rows) {
      if (closure.affected_areas) {
        const affectedIds = await parseAffectedAreas(closure.affected_areas);
        if (affectedIds.includes(resourceId)) {
          return false;
        }
      }
    }
    
    return true;
  } catch (error: unknown) {
    logger.error('[isResourceAvailableForDate] Error:', { error });
    return true;
  }
}

export { parseTimeToMinutes, hasTimeOverlap };

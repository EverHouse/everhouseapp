import { Router } from 'express';
import { db } from '../../db';
import { users } from '../../../shared/schema';
import { sql } from 'drizzle-orm';
import { getAllActiveBayIds, getConferenceRoomId } from '../../core/affectedAreas';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../core/logger';

export interface WellnessClassRow {
  id: number;
  title: string;
  time: string;
  instructor: string;
  duration: string;
  category: string;
  spots: string;
  status: string;
  description: string | null;
  date: string | Date;
  is_active: boolean;
  image_url: string | null;
  external_url: string | null;
  google_calendar_id: string | null;
  block_bookings: boolean;
  block_simulators: boolean;
  block_conference_room: boolean;
  recurring_event_id: string | null;
  capacity: number | null;
  waitlist_enabled: boolean;
  enrolled_count?: number;
  waitlist_count?: string;
  spots_available?: number;
  needs_review?: boolean;
  recurringUpdated?: number;
}

export interface WellnessRecurringRow {
  id: number;
  date: string;
  time: string;
  duration: string;
  title: string;
}

export interface WaitlistedUserRow {
  id: number;
  user_email: string;
  class_id: number;
  status: string;
  is_waitlisted: boolean;
}

export interface WellnessClassDetailRow {
  id: number;
  title: string;
  instructor: string;
}

export async function getMemberDisplayName(email: string): Promise<string> {
  try {
    const normalizedEmail = email.toLowerCase();
    const result = await db.select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .limit(1);
    
    if (result.length > 0 && (result[0].firstName || result[0].lastName)) {
      return [result[0].firstName, result[0].lastName].filter(Boolean).join(' ');
    }
  } catch (err: unknown) {
    logger.warn('Failed to lookup member name', { extra: { error: getErrorMessage(err) } });
  }
  return email.split('@')[0];
}

export async function createWellnessAvailabilityBlocks(
  wellnessClassId: number, 
  classDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  createdBy?: string,
  classTitle?: string
): Promise<void> {
  const resourceIds: number[] = [];
  
  if (blockSimulators) {
    const bayIds = await getAllActiveBayIds();
    resourceIds.push(...bayIds);
  }
  
  if (blockConferenceRoom) {
    const conferenceRoomId = await getConferenceRoomId();
    if (conferenceRoomId && !resourceIds.includes(conferenceRoomId)) {
      resourceIds.push(conferenceRoomId);
    }
  }
  
  const blockNotes = classTitle ? `Blocked for: ${classTitle}` : 'Blocked for wellness class';
  
  for (const resourceId of resourceIds) {
    await db.execute(sql`INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by, wellness_class_id)
       VALUES (${resourceId}, ${classDate}, ${startTime}, ${endTime || startTime}, ${'wellness'}, ${blockNotes ?? null}, ${createdBy || 'system'}, ${wellnessClassId ?? null})
       ON CONFLICT (resource_id, block_date, start_time, end_time, wellness_class_id) WHERE wellness_class_id IS NOT NULL
       DO UPDATE SET block_type = EXCLUDED.block_type, notes = EXCLUDED.notes, created_by = EXCLUDED.created_by`);
  }
}

export async function removeWellnessAvailabilityBlocks(wellnessClassId: number): Promise<void> {
  await db.execute(sql`DELETE FROM availability_blocks WHERE wellness_class_id = ${wellnessClassId}`);
}

export async function updateWellnessAvailabilityBlocks(
  wellnessClassId: number, 
  classDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  createdBy?: string,
  classTitle?: string
): Promise<void> {
  await removeWellnessAvailabilityBlocks(wellnessClassId);
  if (blockSimulators || blockConferenceRoom) {
    await createWellnessAvailabilityBlocks(wellnessClassId, classDate, startTime, endTime, blockSimulators, blockConferenceRoom, createdBy, classTitle);
  }
}

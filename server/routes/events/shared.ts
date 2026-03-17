import { db } from '../../db';
import { users, availabilityBlocks } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { getAllActiveBayIds, getConferenceRoomId } from '../../core/affectedAreas';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../core/logger';

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
  } catch (error: unknown) {
    logger.warn('Failed to lookup member name', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
  }
  return email.split('@')[0];
}

export async function createEventAvailabilityBlocks(
  eventId: number, 
  eventDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean, 
  blockConferenceRoom: boolean,
  createdBy?: string,
  eventTitle?: string,
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
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
  
  if (resourceIds.length === 0 && (blockSimulators || blockConferenceRoom)) {
    logger.warn(`[Events] No resources found for event #${eventId} block creation (blockSimulators=${blockSimulators}, blockConferenceRoom=${blockConferenceRoom})`);
    return;
  }
  
  const blockNotes = eventTitle ? `Blocked for: ${eventTitle}` : 'Blocked for event';
  const executor = tx || db;
  
  for (const resourceId of resourceIds) {
    await executor.insert(availabilityBlocks).values({
      resourceId,
      blockDate: eventDate,
      startTime,
      endTime: endTime || startTime,
      blockType: 'event',
      notes: blockNotes,
      createdBy: createdBy || 'system',
      eventId,
    }).onConflictDoUpdate({
      target: [availabilityBlocks.resourceId, availabilityBlocks.blockDate, availabilityBlocks.startTime, availabilityBlocks.endTime, availabilityBlocks.eventId],
      targetWhere: sql`${availabilityBlocks.eventId} IS NOT NULL`,
      set: {
        blockType: 'event',
        notes: blockNotes,
        createdBy: createdBy || 'system',
      },
    });
  }
  
  logger.info(`[Events] Created ${resourceIds.length} availability blocks for event #${eventId} on ${eventDate}`);
}

export async function removeEventAvailabilityBlocks(eventId: number): Promise<void> {
  await db.delete(availabilityBlocks).where(eq(availabilityBlocks.eventId, eventId));
}

export async function updateEventAvailabilityBlocks(
  eventId: number, 
  eventDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  createdBy?: string,
  eventTitle?: string
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
  
  await db.transaction(async (tx) => {
    await tx.delete(availabilityBlocks).where(eq(availabilityBlocks.eventId, eventId));
    
    if (blockSimulators || blockConferenceRoom) {
      const blockNotes = eventTitle ? `Blocked for: ${eventTitle}` : 'Blocked for event';
      
      for (const resourceId of resourceIds) {
        await tx.insert(availabilityBlocks).values({
          resourceId,
          blockDate: eventDate,
          startTime,
          endTime: endTime || startTime,
          blockType: 'event',
          notes: blockNotes,
          createdBy: createdBy || 'system',
          eventId,
        }).onConflictDoUpdate({
          target: [availabilityBlocks.resourceId, availabilityBlocks.blockDate, availabilityBlocks.startTime, availabilityBlocks.endTime, availabilityBlocks.eventId],
          targetWhere: sql`${availabilityBlocks.eventId} IS NOT NULL`,
          set: {
            blockType: 'event',
            notes: blockNotes,
            createdBy: createdBy || 'system',
          },
        });
      }
    }
  });
}

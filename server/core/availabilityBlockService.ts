import { db } from '../db';
import { sql } from 'drizzle-orm';
import { availabilityBlocks } from '../../shared/models/scheduling';
import { logger } from './logger';

interface ExistingBlock {
  id: number;
  block_type: string;
  created_by: string;
  event_id: number | null;
  wellness_class_id: number | null;
  closure_id: number | null;
}

export async function findCoveringBlock(
  resourceId: number,
  blockDate: string,
  startTime: string,
  endTime: string,
): Promise<ExistingBlock | null> {
  const result = await db.execute(sql`
    SELECT id, block_type, created_by, event_id, wellness_class_id, closure_id 
    FROM availability_blocks 
    WHERE resource_id = ${resourceId} 
      AND block_date = ${blockDate}
      AND start_time <= ${startTime}
      AND end_time >= ${endTime}
    LIMIT 1
  `);
  
  if (result.rows.length > 0) {
    return result.rows[0] as ExistingBlock;
  }
  return null;
}

export async function createStandaloneBlock(params: {
  resourceId: number;
  blockDate: string;
  startTime: string;
  endTime: string;
  blockType: string;
  notes: string;
  createdBy: string;
  source: string;
}): Promise<{ created: boolean; absorbed: boolean; existingBlock?: ExistingBlock }> {
  const existing = await findCoveringBlock(
    params.resourceId,
    params.blockDate,
    params.startTime,
    params.endTime,
  );

  if (existing) {
    logger.info(`[AvailabilityBlocks] ${params.source}: Block absorbed by existing coverage`, {
      extra: {
        resourceId: params.resourceId,
        blockDate: params.blockDate,
        startTime: params.startTime,
        endTime: params.endTime,
        existingBlockId: existing.id,
        existingBlockType: existing.block_type,
        existingCreatedBy: existing.created_by,
        eventId: existing.event_id,
        wellnessClassId: existing.wellness_class_id,
        closureId: existing.closure_id,
      }
    });
    return { created: false, absorbed: true, existingBlock: existing };
  }

  await db.insert(availabilityBlocks).values({
    resourceId: params.resourceId,
    blockDate: params.blockDate,
    startTime: params.startTime,
    endTime: params.endTime,
    blockType: params.blockType,
    notes: params.notes,
    createdBy: params.createdBy,
  }).onConflictDoNothing();

  return { created: true, absorbed: false };
}

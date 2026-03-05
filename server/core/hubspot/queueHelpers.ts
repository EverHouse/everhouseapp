import { enqueueHubSpotSync } from './queue';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import type { SyncPaymentParams, SyncDayPassParams } from '../stripe/hubspotSync';
import type { AddMemberInput } from './members';

export async function queuePaymentSyncToHubSpot(params: SyncPaymentParams): Promise<void> {
  await enqueueHubSpotSync('sync_payment', params, {
    priority: 3,
    idempotencyKey: `payment_sync_${params.paymentIntentId}`,
    maxRetries: 5
  });
}

export async function queueDayPassSyncToHubSpot(params: SyncDayPassParams): Promise<void> {
  await enqueueHubSpotSync('sync_day_pass', params, {
    priority: 3,
    idempotencyKey: `day_pass_sync_${params.paymentIntentId}`,
    maxRetries: 5
  });
}

export async function queueMemberCreation(params: AddMemberInput): Promise<void> {
  await enqueueHubSpotSync('sync_member', params, {
    priority: 3,
    idempotencyKey: `member_creation_${params.email}`,
    maxRetries: 5
  });
}

export interface TierSyncParams {
  email: string;
  newTier: string;
  oldTier?: string;
  changedBy?: string;
  changedByName?: string;
}

export async function queueTierSync(params: TierSyncParams): Promise<void> {
  const newTierKey = (params.newTier || 'none').replace(/\s+/g, '_');
  const emailKey = params.email.toLowerCase();

  await db.execute(sql`UPDATE hubspot_sync_queue 
    SET status = 'completed', completed_at = NOW() 
    WHERE operation = 'sync_tier' 
      AND status = 'pending' 
      AND LOWER(payload->>'email') = ${emailKey}`);

  await enqueueHubSpotSync('sync_tier', params, {
    priority: 2,
    idempotencyKey: `tier_sync_${emailKey}_to_${newTierKey}_${Date.now()}`,
    maxRetries: 5
  });
}

import { enqueueHubSpotSync } from './queue';
import type { SyncPaymentParams, SyncDayPassParams } from '../stripe/hubspotSync';
import type { AddMemberInput } from './members';

export async function queuePaymentSyncToHubSpot(params: SyncPaymentParams): Promise<void> {
  await enqueueHubSpotSync('sync_payment', params as unknown as Record<string, unknown>, {
    priority: 3,
    idempotencyKey: `payment_sync_${params.paymentIntentId}`,
    maxRetries: 5
  });
}

export async function queueDayPassSyncToHubSpot(params: SyncDayPassParams): Promise<void> {
  await enqueueHubSpotSync('sync_day_pass', params as unknown as Record<string, unknown>, {
    priority: 3,
    idempotencyKey: `day_pass_sync_${params.paymentIntentId}`,
    maxRetries: 5
  });
}

export async function queueMemberCreation(params: AddMemberInput): Promise<void> {
  await enqueueHubSpotSync('sync_member', params as unknown as Record<string, unknown>, {
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
  const oldTierKey = (params.oldTier || 'none').replace(/\s+/g, '_');
  const newTierKey = (params.newTier || 'none').replace(/\s+/g, '_');
  await enqueueHubSpotSync('sync_tier', params as unknown as Record<string, unknown>, {
    priority: 2,
    idempotencyKey: `tier_sync_${params.email}_${oldTierKey}_to_${newTierKey}`,
    maxRetries: 5
  });
}

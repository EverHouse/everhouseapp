import { enqueueHubSpotSync } from './queue';
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

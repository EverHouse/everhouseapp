import { z } from 'zod';

export const resolveIssueSchema = z.object({
  issue_key: z.string().min(1, 'issue_key is required'),
  action: z.enum(['resolved', 'ignored', 'reopened']).default('resolved'),
  resolution_method: z.string().optional(),
  notes: z.string().optional(),
}).refine(
  (data) => data.action !== 'resolved' || !!data.resolution_method,
  { message: 'resolution_method is required for resolved action', path: ['resolution_method'] }
);

export const syncPushPullSchema = z.preprocess(
  (val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const rawUserId = obj.user_id ?? obj.userId;
      return {
        issue_key: obj.issue_key || obj.issueKey,
        target: obj.target,
        user_id: rawUserId != null ? Number(rawUserId) : undefined,
        hubspot_contact_id: obj.hubspot_contact_id || obj.hubspotContactId,
        stripe_customer_id: obj.stripe_customer_id || obj.stripeCustomerId,
      };
    }
    return val;
  },
  z.object({
    issue_key: z.string().min(1, 'issue_key is required'),
    target: z.enum(['hubspot', 'stripe'], { message: 'Valid target (hubspot or stripe) is required' }),
    user_id: z.number().int().positive().optional(),
    hubspot_contact_id: z.string().optional(),
    stripe_customer_id: z.string().optional(),
  }).refine(
    (data) => data.user_id != null,
    { message: 'user_id is required for sync operations', path: ['user_id'] }
  )
);

export const ignoreIssueSchema = z.object({
  issue_key: z.string().min(1, 'issue_key is required'),
  duration: z.enum(['24h', '1w', '30d'], { message: 'Valid duration (24h, 1w, 30d) is required' }),
  reason: z.string().min(1, 'reason is required'),
});

export const bulkIgnoreSchema = z.object({
  issue_keys: z.array(z.string()).min(1, 'issue_keys array is required').max(5000, 'Maximum 5000 issues can be excluded at once'),
  duration: z.enum(['24h', '1w', '30d'], { message: 'Valid duration (24h, 1w, 30d) is required' }),
  reason: z.string().min(1, 'reason is required'),
});

export const placeholderDeleteSchema = z.object({
  stripeCustomerIds: z.array(z.string()).optional(),
  hubspotContactIds: z.array(z.string()).optional(),
  localDatabaseUserIds: z.array(z.string()).optional(),
}).refine(
  (data) =>
    (Array.isArray(data.stripeCustomerIds) && data.stripeCustomerIds.length > 0) ||
    (Array.isArray(data.hubspotContactIds) && data.hubspotContactIds.length > 0) ||
    (Array.isArray(data.localDatabaseUserIds) && data.localDatabaseUserIds.length > 0),
  { message: 'Must provide stripeCustomerIds, hubspotContactIds, or localDatabaseUserIds arrays' }
);

export const recordIdSchema = z.object({
  recordId: z.union([z.string(), z.number()]).transform(String),
});

export const userIdSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

export const unlinkHubspotSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  hubspotContactId: z.string().optional(),
});

export const mergeHubspotSchema = z.object({
  primaryUserId: z.string().min(1, 'primaryUserId is required'),
  secondaryUserId: z.string().min(1, 'secondaryUserId is required'),
  hubspotContactId: z.string().optional(),
});

export const mergeStripeSchema = z.object({
  email: z.string().email('Valid email is required'),
  keepCustomerId: z.string().min(1, 'keepCustomerId is required'),
  removeCustomerId: z.string().min(1, 'removeCustomerId is required'),
});

export const changeBillingProviderSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  newProvider: z.enum(['stripe', 'manual', 'comped'], { message: 'newProvider is required' }),
});

export const acceptTierSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  acceptedTier: z.string().min(1, 'acceptedTier is required'),
  source: z.enum(['app', 'stripe'], { message: 'source must be "app" or "stripe"' }),
});

export const reviewItemSchema = z.object({
  recordId: z.union([z.string(), z.number()]).transform(String),
  table: z.enum(['wellness_classes', 'events'], { message: 'table is required' }),
});

export const assignSessionOwnerSchema = z.object({
  sessionId: z.number().int().positive('sessionId is required'),
  ownerEmail: z.string().email('Valid ownerEmail is required'),
  additional_players: z.array(z.any()).optional(),
});

export const cancelOrphanedPiSchema = z.object({
  paymentIntentId: z.string().startsWith('pi_', 'paymentIntentId must start with "pi_"'),
});

export const dryRunSchema = z.object({
  dryRun: z.boolean().default(true),
});

export const updateTourStatusSchema = z.object({
  recordId: z.union([z.string(), z.number()]).transform(String),
  newStatus: z.enum(['completed', 'no_show', 'cancelled'], { message: 'newStatus must be completed, no_show, or cancelled' }),
});

export const clearStripeIdSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

export const deleteOrphanByEmailSchema = z.object({
  table: z.enum(['notifications', 'push_subscriptions', 'user_dismissed_notices'], { message: 'Invalid table for orphan cleanup' }),
  email: z.string().min(1, 'email is required').transform(v => v.trim().toLowerCase()),
});

export type ResolveIssueInput = z.infer<typeof resolveIssueSchema>;
export type SyncPushPullInput = z.infer<typeof syncPushPullSchema>;
export type IgnoreIssueInput = z.infer<typeof ignoreIssueSchema>;
export type BulkIgnoreInput = z.infer<typeof bulkIgnoreSchema>;
export type PlaceholderDeleteInput = z.infer<typeof placeholderDeleteSchema>;
export type RecordIdInput = z.infer<typeof recordIdSchema>;
export type UserIdInput = z.infer<typeof userIdSchema>;
export type UnlinkHubspotInput = z.infer<typeof unlinkHubspotSchema>;
export type MergeHubspotInput = z.infer<typeof mergeHubspotSchema>;
export type MergeStripeInput = z.infer<typeof mergeStripeSchema>;
export type ChangeBillingProviderInput = z.infer<typeof changeBillingProviderSchema>;
export type AcceptTierInput = z.infer<typeof acceptTierSchema>;
export type ReviewItemInput = z.infer<typeof reviewItemSchema>;
export type AssignSessionOwnerInput = z.infer<typeof assignSessionOwnerSchema>;
export type CancelOrphanedPiInput = z.infer<typeof cancelOrphanedPiSchema>;
export type DryRunInput = z.infer<typeof dryRunSchema>;
export type UpdateTourStatusInput = z.infer<typeof updateTourStatusSchema>;
export type ClearStripeIdInput = z.infer<typeof clearStripeIdSchema>;

# Stripe → HubSpot Bridge

How Stripe webhook events trigger HubSpot syncs, what data flows, and how loops are prevented.

## Sync Architecture

Webhook handlers do NOT call HubSpot directly inside the database transaction. Instead, syncs happen through three mechanisms:

1. **Deferred actions** — async closures that run after the DB transaction commits. Used for immediate syncs like `syncMemberToHubSpot` and `handleTierChange`.
2. **Job queue** — `queueJobInTransaction(client, jobType, payload, options)` inserts a job row within the transaction. The job worker processes it asynchronously with retry logic. Used for `sync_to_hubspot`, `send_payment_receipt`, and similar operations.
3. **HubSpot sync queue** — `enqueueHubSpotSync(type, params, options)` via queue helpers in `hubspot/queueHelpers.ts`. Used for payment syncs, day pass syncs, and tier syncs with idempotency keys.

### HubSpot Sync Queue Processing

`processHubSpotQueue(batchSize)` in `hubspot/queue.ts` processes enqueued jobs:

1. Atomically claim pending jobs using `UPDATE ... FOR UPDATE SKIP LOCKED` to prevent race conditions between parallel workers
2. Execute each job via `executeHubSpotOperation(operation, payload)`
3. On success: mark job as `completed`
4. On failure:
   - **Unrecoverable errors** (403, 401, MISSING_SCOPES) → mark as `dead`, notify staff about permission error
   - **Transient errors** → increment `retry_count`, calculate next retry with exponential backoff (1 min base, 1 hour max: `min(60s × 2^retryCount, 3600s)`), set status back to `failed` with `next_retry_at`
   - After `max_retries` (default 5) exhausted → mark as `dead` (dead letter)

## What Gets Synced

### Contact Properties

`syncMemberToHubSpot(params)` (from `hubspot/stages.ts`) updates HubSpot contact properties:

| HubSpot Property | Source | Transform |
|---|---|---|
| `membership_status` | `users.membership_status` | `DB_STATUS_TO_HUBSPOT_STATUS` map (e.g., `active` → `Active`, `frozen` → `Froze`, `cancelled` → `Terminated`) |
| `billing_provider` | `users.billing_provider` | `DB_BILLING_PROVIDER_TO_HUBSPOT` map (e.g., `stripe` → `stripe`, `family_addon` → `stripe`, `comped` → `Comped`) |
| `membership_tier` | `users.tier` | `denormalizeTierForHubSpot()` via `DB_TIER_TO_HUBSPOT` (e.g., `core` → `Core Membership`, `premium-founding` → `Premium Membership Founding Members`) |
| `lifecyclestage` | derived from status | Active/trialing/past_due → `customer`; all others → `other` |
| `member_since` | `users.join_date` | ISO date string, midnight UTC |
| `billing_group_role` | webhook context | `Primary` or `Sub-member` |

Stripe-specific contact fields (passed when available):

| HubSpot Property | Source |
|---|---|
| `stripe_customer_id` | Stripe customer ID |
| `stripe_created_date` | Stripe customer creation date |
| `stripe_delinquent` | Stripe customer delinquent flag |
| `stripe_discount_id` | Active Stripe discount/coupon ID |
| `stripe_pricing_interval` | monthly/yearly from subscription price |

`findOrCreateHubSpotContact(email, firstName, lastName, phone, tier)` creates or finds the contact in HubSpot. Searches by email first; creates if not found.

### Deal Management

`handleTierChange(email, oldTier, newTier, changedBy, changedByName)` (from `hubspot/members.ts`):
- Updates deal line items to reflect the new tier
- Called when subscription tier changes are detected

`handleMembershipCancellation(email, changedBy, changedByName)` (from `hubspot/members.ts`):
- Removes deal line items
- Moves deal stage to lost
- Called from `handleSubscriptionDeleted`

### Payment Syncs

`syncPaymentToHubSpot(params)` (from `stripe/hubspotSync.ts`):
- Finds the member's HubSpot deal
- Creates a line item with the payment amount
- Associates the line item with the deal
- Records in `hubspot_line_items` table
- Creates billing audit log entry

`syncDayPassToHubSpot(params)` (from `stripe/hubspotSync.ts`):
- Similar to payment sync but for day pass purchases
- Skips if no existing deal (non-member purchases)

### Company Syncs

`syncCompanyToHubSpot({ companyName, userEmail })`:
- Called from `checkout.session.completed` when `company_name` is in metadata
- Creates/finds company in HubSpot
- Updates user and billing_group with `hubspot_company_id`

## Queue Helpers

All queue helpers live in `hubspot/queueHelpers.ts`:

| Function | Job Type | Idempotency Key | Priority |
|---|---|---|---|
| `queuePaymentSyncToHubSpot` | `sync_payment` | `payment_sync_{paymentIntentId}` | 3 |
| `queueDayPassSyncToHubSpot` | `sync_day_pass` | `day_pass_sync_{paymentIntentId}` | 3 |
| `queueTierSync` | `sync_tier` | `tier_sync_{email}_{oldTier}_to_{newTier}` | 2 |
| `queueMemberCreation` | `sync_member` | `member_creation_{email}` | 3 |

All use `maxRetries: 5`.

## Which Webhook Events Trigger HubSpot Syncs

| Event | HubSpot Action |
|---|---|
| `customer.subscription.created` | `findOrCreateHubSpotContact` + `syncMemberToHubSpot` (status, tier, billing_provider) + `handleTierChange` (deal line items) |
| `customer.subscription.updated` (tier change) | `handleTierChange` → fallback `queueTierSync` on failure |
| `customer.subscription.updated` (status change) | `syncMemberToHubSpot` with new status |
| `customer.subscription.paused` | `syncMemberToHubSpot` (status=frozen) |
| `customer.subscription.resumed` | `syncMemberToHubSpot` (status=active) |
| `customer.subscription.deleted` | `syncMemberToHubSpot` (status=cancelled) + `handleMembershipCancellation` (deal→lost) |
| `customer.subscription.updated` (sub-member cascade) | `syncMemberToHubSpot` for each affected sub-member |
| `invoice.payment_succeeded` | `hubspot_deals.last_payment_status = 'current'` (direct DB update, not HubSpot API) |
| `invoice.payment_failed` | `hubspot_deals.last_payment_status = 'failed'` (direct DB update, not HubSpot API) |
| `payment_intent.succeeded` | `sync_to_hubspot` job via queue (payment line item on deal) |
| `checkout.session.completed` (activation_link) | `findOrCreateHubSpotContact` + `syncMemberToHubSpot` |
| `checkout.session.completed` (staff_invite) | `findOrCreateHubSpotContact` + `syncMemberToHubSpot` |
| `checkout.session.completed` (day_pass) | `queueDayPassSyncToHubSpot` (line item on deal) |
| `checkout.session.completed` (company) | `syncCompanyToHubSpot` |

## Mindbody-Billed Member Handling

Members whose `billing_provider` is `'mindbody'` (or any value other than `'stripe'`) receive special handling at two levels:

### Webhook Level

All subscription and invoice handlers check `billing_provider` before modifying the user. If `billing_provider !== 'stripe'`, the handler skips the status/tier update entirely and logs a skip message. This prevents Stripe webhook events for stale or secondary subscriptions from overwriting the Mindbody-managed membership state.

### HubSpot Sync Level

`syncMemberToHubSpot` contains an additional guard: if the member is Mindbody-billed and a `status` property is included in the sync payload, it explicitly drops the status field before calling the HubSpot API. This prevents any code path that inadvertently passes a status from writing incorrect data to HubSpot. The member's HubSpot contact retains whatever status Mindbody (or manual processes) set.

Non-status fields (tier, billing_group_role, Stripe contact fields) can still be synced for Mindbody members when explicitly passed, because those represent supplementary data rather than authoritative billing state.

## Loop Prevention

### Single Writer to HubSpot Contacts

The app is the single writer to HubSpot contact properties for membership data. No other system (Mindbody, manual HubSpot edits) should write to `membership_status`, `membership_tier`, or `billing_provider` on HubSpot contacts. This eliminates bidirectional sync conflicts — the app pushes to HubSpot but never reads membership state back from it.

### Billing Provider Guard

Before any HubSpot sync triggered by a webhook, the handler checks `billing_provider`. If it is not `'stripe'`, the sync is skipped entirely. This prevents:
- A stale Stripe event from syncing incorrect status to HubSpot for a Mindbody member
- HubSpot showing conflicting data from multiple billing providers

### Product Creation Loop Guard

`handleProductCreated` skips products with `metadata.source === 'ever_house_app'`. This prevents a product created by the app from triggering a redundant sync back into the app.

### Idempotency Keys

Queue helpers use idempotency keys (e.g., `payment_sync_{paymentIntentId}`) to prevent duplicate HubSpot API calls when the same webhook is retried or replayed.

### Error Isolation

HubSpot sync failures are caught and logged but never roll back the webhook transaction. If `handleTierChange` fails, it falls back to `queueTierSync` for retry. This ensures billing state is always correct locally even if HubSpot is temporarily unavailable.

## Direct DB Updates vs HubSpot API

Some "HubSpot" operations only update the local `hubspot_deals` table without calling the HubSpot API:
- `invoice.payment_succeeded` → updates `hubspot_deals.last_payment_status = 'current'`
- `invoice.payment_failed` → updates `hubspot_deals.last_payment_status = 'failed'`

These are local tracking fields used for reconciliation and reporting, not synced to HubSpot in real-time.

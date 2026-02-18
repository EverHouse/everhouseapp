---
name: stripe-webhook-flow
description: End-to-end Stripe webhook handling pipeline for the Ever Club Members App. Covers stripe webhook processing, webhook handling flow, stripe wins rule for billing authority, subscription sync from webhooks, webhook dedup via processed events table, stripe events dispatch and routing, payment webhook succeeded/failed/refunded handling, subscription webhook lifecycle (created/updated/deleted/paused/resumed), deferred action pattern, resource-based event ordering, and ghost reactivation blocking.
---

# Stripe Webhook Flow

How Stripe webhook events flow through the Ever Club Members App — from raw HTTP receipt to downstream side effects.

For billing rules and the 10 Commandments, see the `billing-stripe-expert` skill.

## The Webhook Pipeline

Every Stripe webhook follows this exact sequence:

```
Stripe POST → raw Buffer received → signature verified via Stripe SDK
  → event parsed → dedup check (tryClaimEvent) → resource order check
  → BEGIN transaction → dispatch to handler → COMMIT
  → execute deferred actions → cleanup old events
```

### 1. Receive and Verify

`processStripeWebhook(payload: Buffer, signature: string)` in `webhooks.ts` is the entry point.

- Payload MUST be a raw `Buffer` — if `express.json()` parses it first, the signature check fails.
- The Stripe SDK (`getStripeSync().processWebhook()`) verifies the webhook signature against the endpoint secret.
- After verification, the payload is parsed as JSON to extract the event.

### 2. Dedup Check — Prevent Double-Processing

`tryClaimEvent(client, eventId, eventType, eventTimestamp, resourceId)` inserts a row into `webhook_processed_events`:

```sql
INSERT INTO webhook_processed_events (event_id, event_type, resource_id, processed_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id
```

If `rowCount === 0`, the event was already processed → skip it. This is the primary dedup mechanism.

Old events are cleaned up after each webhook via `cleanupOldProcessedEvents()`, which deletes rows older than 7 days (`EVENT_DEDUP_WINDOW_DAYS = 7`).

### 3. Resource-Based Event Ordering

`checkResourceEventOrder(client, resourceId, eventType, eventTimestamp)` prevents out-of-order processing for the same Stripe resource (subscription, payment intent, invoice).

`extractResourceId(event)` maps event types to their resource ID:
- `payment_intent.*` → `obj.id`
- `invoice.*` → `obj.id`
- `customer.subscription.*` → `obj.id`
- `checkout.session.*` → `obj.id`
- `charge.*` → `obj.payment_intent || obj.id`

Each event type has a priority number in `EVENT_PRIORITY`:

```
Payment lifecycle:     created(1) → processing(2) → requires_action(3) → succeeded/failed(10) → refunded(20) → dispute(25-26)
Invoice lifecycle:     created(1) → finalized(2) → payment_succeeded/failed(10) → paid(11) → voided/uncollectible(20)
Subscription lifecycle: created(1) → updated(5) → paused(8) → resumed(9) → deleted(20)
```

If the last processed event for that resource has a HIGHER priority than the incoming event, the incoming event is blocked.

#### Ghost Reactivation Blocking

Special case: if `subscription.created` arrives AFTER `subscription.deleted` for the same resource, it is blocked. This prevents a delayed `created` event from reactivating a cancelled member.

However, `subscription.created` is allowed through for all other out-of-order scenarios because subscription creation should never be silently dropped.

### 4. Transaction Boundary and Dispatch

All handler work runs inside a single PostgreSQL transaction (`BEGIN` / `COMMIT`). If any handler throws, the transaction is rolled back and the error propagates to Stripe (which will retry).

The dispatch is a chain of `if/else if` blocks matching `event.type` to handler functions. See `references/event-handling.md` for the complete mapping.

### 5. The Deferred Action Pattern

Every handler returns `DeferredAction[]` — an array of async closures. These represent non-critical side effects:

- Transaction cache updates (`upsertTransactionCache`)
- WebSocket broadcasts (`broadcastBillingUpdate`)
- Notifications (member + staff)
- Email sends (receipts, failed payment alerts)
- Audit log entries (`logSystemAction`)
- HubSpot syncs (`syncMemberToHubSpot`, `handleTierChange`)

Deferred actions run AFTER the transaction commits via `executeDeferredActions()`. Each action is wrapped in try/catch — a deferred action failure is logged but never rolls back the committed transaction.

Critical operations (DB writes, status changes, booking payment updates) happen INSIDE the transaction. Non-critical operations (notifications, emails, syncs) are deferred.

Some operations use `queueJobInTransaction(client, jobType, payload, options)` to enqueue jobs that run asynchronously via the job queue system. These jobs are inserted within the transaction but executed later by a worker.

## The "Stripe Wins" Rule

When `billing_provider = 'stripe'`, Stripe is the authoritative source for `membership_status` and `tier`.

### How It Works

Every subscription and invoice handler checks `billing_provider` before modifying the user:

```
1. Look up user by stripe_customer_id
2. Read user.billing_provider
3. If billing_provider is set AND billing_provider !== 'stripe' → SKIP the update
4. Log: "Skipping [event] for {email} — billing_provider is '{provider}', not 'stripe'"
```

This guard appears in:
- `handleSubscriptionUpdated` — skips status/tier changes
- `handleSubscriptionPaused` — skips freeze
- `handleSubscriptionResumed` — skips unfreeze
- `handleSubscriptionDeleted` — skips cancellation
- `handleSubscriptionCreated` (existing user path) — skips if billing_provider is not stripe
- `handleInvoicePaymentSucceeded` — skips grace period clearing
- `handleInvoicePaymentFailed` — skips grace period start

### Why It Prevents Loops

Members billed through Mindbody, manual, or comped billing providers have their `billing_provider` set to something other than `'stripe'`. Without this guard, a stale Stripe subscription event could overwrite their status — e.g., marking a Mindbody member as "cancelled" because their old Stripe subscription expired.

### Sub-Member Billing Provider Guard

Group billing operations (family/corporate) also check billing_provider before propagating status to sub-members:

```sql
AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
```

This protects sub-members who have their own non-Stripe billing arrangement.

## Subscription Sync Race Condition Guard

When `handleSubscriptionCreated` processes a new subscription for an existing user, it uses a conditional update pattern:

```sql
UPDATE users SET
  membership_status = CASE
    WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member') THEN $status
    ELSE membership_status
  END
WHERE LOWER(email) = LOWER($email)
```

This prevents a `subscription.created` webhook from overwriting a status that was set by a later event (e.g., if `subscription.updated` with `status=active` arrived and was processed before `subscription.created`).

Similarly, `handleSubscriptionDeleted` includes a subscription ID match guard:

```sql
WHERE LOWER(email) = LOWER($1) AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)
```

This prevents cancellation of a user who has already been assigned a newer subscription.

## Subscription Status Mapping

Stripe subscription statuses map to app membership statuses:

| Stripe Status | App Status |
|---|---|
| `active` | `active` |
| `trialing` | `trialing` |
| `past_due` | `past_due` |
| `unpaid` | `suspended` |
| `canceled` | `cancelled` |
| `paused` | `frozen` |
| `incomplete` | `pending` |
| `incomplete_expired` | `pending` |

## Group Billing Cascade

Subscription status changes cascade to sub-members in billing groups:

- `active` → reactivate all suspended/past_due sub-members
- `past_due` → mark all active sub-members as past_due
- `unpaid` → suspend all active sub-members
- `deleted` → `handlePrimarySubscriptionCancelled(subscriptionId)` deactivates group members

Each cascade respects the billing provider guard — sub-members with non-Stripe billing are not affected.

## Invoice Grace Period System

`handleInvoicePaymentFailed` starts a grace period:
- Sets `grace_period_start` and `grace_period_email_count` on the user
- Only applies when `billing_provider = 'stripe'`
- Grace period lasts 7 days before suspension

`handleInvoicePaymentSucceeded` clears the grace period:
- Resets `grace_period_start = NULL` and `grace_period_email_count = 0`
- Restores tier from price ID if available
- Only applies when `billing_provider = 'stripe'`

## Payment Retry and Dunning

`handlePaymentIntentFailed` tracks retry attempts:
- `MAX_RETRY_ATTEMPTS = 3`
- Increments `retry_count` on `stripe_payment_intents`
- After 3 failures, sets `requires_card_update = true`
- Sends escalating notifications to member and staff

## Product Catalog Sync

Product/price webhooks keep the local catalog in sync with Stripe:

- `product.updated` → update `membership_tiers.highlighted_features` from marketing features, update cafe items
- `product.created` → trigger `pullTierFeaturesFromStripe()` if matched to a tier
- `product.deleted` → clear Stripe references from tier, deactivate cafe items
- `price.updated/created` → update `cafe_items.price` and `membership_tiers.price_cents`, update overage/guest fee configs
- `coupon.updated/created` → update family discount percent for `FAMILY20` coupon

## Checkout Session Handling

`handleCheckoutSessionCompleted` routes based on `session.metadata`:

1. **`purpose === 'add_funds'`** — Credit member's Stripe customer balance via `stripe.customers.createBalanceTransaction()`, send receipt email, notify staff
2. **`company_name` present** — Sync company to HubSpot via `syncCompanyToHubSpot`, update user and billing_group with `hubspot_company_id`
3. **`source === 'activation_link'`** — Activate pending user: set `membership_status = 'active'`, `billing_provider = 'stripe'`, attach `stripe_customer_id` and `stripe_subscription_id`. Sync contact and deal to HubSpot.
4. **`source === 'staff_invite'`** — Resolve user via `resolveUserByEmail` (handles linked emails). If user exists, update Stripe customer ID and activate. If not, check `sync_exclusions` (permanently deleted users), then create new user. Auto-unarchive if archived. Sync to HubSpot. Mark `form_submissions` as converted.
5. **`purpose === 'day_pass'`** — Record day pass via `recordDayPassPurchaseFromWebhook`, send QR code email via `sendPassWithQrEmail`, notify staff, broadcast day pass update, queue HubSpot sync via `queueDayPassSyncToHubSpot`

## Linked Email Resolution

Several checkout handlers use `resolveUserByEmail(email)` from `customers.ts` to find users who may have registered with a different email. This handles cases where a member's Stripe email differs from their app email (e.g., personal vs. work email). The resolution returns:
- `userId` — the matched user's ID
- `primaryEmail` — the canonical email
- `matchType` — `'direct'` or the type of linked email match

## Sync Exclusions

Before creating a new user from a webhook, handlers check the `sync_exclusions` table:

```sql
SELECT 1 FROM sync_exclusions WHERE email = $1
```

If a match is found, the user was permanently deleted and should not be recreated. The webhook logs this and skips user creation.

## Event Replay

`replayStripeEvent(eventId, forceReplay)` re-fetches an event from Stripe and re-processes it through the same pipeline. With `forceReplay = false`, it respects dedup (won't re-process already-claimed events). With `forceReplay = true`, it skips the claim check but still respects resource ordering to prevent out-of-order processing.

Replay is exposed via `POST /api/admin/stripe/replay-webhook` (admin-only).

## Transaction Cache

Every payment, invoice, refund, and charge event upserts into `stripe_transaction_cache` via deferred `upsertTransactionCache()`. This local cache enables reconciliation reporting without hitting the Stripe API.

## Reconciliation

`reconcileDailyPayments()` in `reconciliation.ts` scans Stripe for succeeded payment intents from the last 24 hours, compares against the local `stripe_payment_intents` table, and heals any missing or mismatched records by calling `confirmPaymentSuccess()`.

`reconcileSubscriptions()` cross-references active DB members against their Stripe subscription status to detect drift.

## Key References

- `references/event-handling.md` — Complete event type → handler → downstream effects mapping
- `references/hubspot-bridge.md` — How webhook events sync to HubSpot
- `billing-stripe-expert` skill — The 10 Commandments of billing and billing provider rules

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

### Subscription ID Match Guard (Invoice Failures)

`handleInvoicePaymentFailed` includes a subscription ID match guard to prevent late-arriving failed invoices from old subscriptions from downgrading active members:

```
1. Extract subscription ID from invoice
2. Query user's current stripe_subscription_id
3. If user has a different current subscription → SKIP (stale invoice from old sub)
4. If user is already cancelled/inactive → SKIP
5. Only proceed with grace period if subscription IDs match
```

This prevents the scenario where a member cancels Subscription A, starts Subscription B, and a retried failed invoice from Subscription A sets them to `past_due` despite actively paying on Subscription B.

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

### Webhook Dedup Table Cleanup

After deferred actions execute, `cleanupOldProcessedEvents()` is called probabilistically (5% of webhooks) to delete `webhook_processed_events` rows older than 7 days. This fire-and-forget call prevents unbounded table growth without impacting webhook latency. Errors are logged but never propagated.

Critical operations (DB writes, status changes, booking payment updates) happen INSIDE the transaction. Non-critical operations (notifications, emails, syncs) are deferred.

Some operations use `queueJobInTransaction(client, jobType, payload, options)` to enqueue jobs that run asynchronously via the job queue system. These jobs are inserted within the transaction but executed later by a worker.

### Transaction Safety: No External API Calls Inside Transactions (v8.12.0)

**RULE: Never make HTTP calls (Stripe API, HubSpot, etc.) inside a BEGIN/COMMIT transaction block.**

External API calls hold the database connection while waiting for a network response. During high-traffic periods (subscription renewal batches), this exhausts the connection pool and causes cascading failures.

**Enforced patterns:**

1. **Replace with DB query** — If checking Stripe resource status, query the local database instead. Example: `handleInvoicePaymentFailed` checks `users.membership_status` instead of calling `stripe.subscriptions.retrieve()`.
2. **Move to deferred action** — Non-critical enrichment (phone fetch for HubSpot, product name lookups for tier matching) should be pushed to `deferredActions[]` and run after COMMIT.
3. **Timeout wrapper** — If an external call is unavoidable inside a transaction (e.g., customer retrieve for new user creation), wrap it with `Promise.race()` and a 5-second timeout to prevent indefinite blocking.

### Documented In-Transaction Exceptions (v8.12.0)

Five legitimate Stripe/external API calls have been audited and approved to stay inside transactions because their results are required for immediate DB writes:

1. **`stripe.customers.retrieve()` in `handleSubscriptionCreated`** — When creating a new user from a subscription event (no matching user exists), the customer email and name are required to populate the user record. This call is unavoidable.

2. **`stripe.products.retrieve()` in `handleSubscriptionUpdated`** — When tier matching via `price_id` fails (product may have been deleted), the product name is fetched as a fallback to attempt legacy name-based matching. Required before DB writes to `users.tier`.

3. **`stripe.paymentMethods.list()` in `handlePaymentMethodDetached`** — Determines the count of remaining payment methods on the customer. If zero, `requires_card_update` must be set to `true` on the user record in the same transaction.

4. **`syncCompanyToHubSpot()` in `handleCheckoutSessionCompleted`** — Syncs a new company to HubSpot and returns `hubspotCompanyId`. This ID must be written to both `users.hubspot_company_id` and `billing_groups.hubspot_company_id` in the same transaction.

5. **`stripe.prices.retrieve()` in `guestPassConsumer.ts`** — Fetches the guest pass Stripe price to determine `cached_fee_cents` for the booking participant record. The fee amount must be written to `booking_participants.cached_fee_cents` in the same transaction to maintain consistency.

### Timeout Wrapper Pattern

Every in-transaction exception MUST be wrapped with `Promise.race()` and a 5-second timeout to prevent indefinite network blocking:

```typescript
// NOTE: Must stay in transaction - result needed for DB writes (reason why)
const result = await Promise.race([
  stripe.someApi.call(params),
  new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('Description timed out after 5s')), 5000)
  )
]) as ExpectedType;
```

Every documented exception MUST have BOTH:
- A `// NOTE: Must stay in transaction - result needed for DB writes (reason)` comment explaining why the call cannot be deferred
- A 5-second `Promise.race()` timeout wrapper to prevent connection pool exhaustion during high-traffic periods

### broadcastBillingUpdate

`broadcastBillingUpdate()` is a **local WebSocket broadcast** (not an external HTTP call to an external service). It pushes real-time updates to connected staff/admin clients.

Because it does **NOT** make external API calls, it does **NOT** need to be deferred and can safely be called inside or outside transactions. It is lightweight and non-blocking.

Note: `broadcastBillingUpdate()` calls are sometimes placed in deferred actions for organizational clarity (to group side effects together), but this is optional — they can be called inline within a transaction without risk of connection pool exhaustion.

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
- `handleInvoicePaymentFailed` — skips grace period if billing_provider is not stripe, AND skips if invoice's subscription doesn't match user's current subscription

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

## Supporting Stripe Services

The webhook system relies on several supporting services. These are not triggered by webhooks themselves, but are called by webhook handlers or used for data validation:

### `groupBilling.ts` — Family & Corporate Billing Groups
Manages group subscriptions where a primary account pays for sub-members (family or corporate teams). When a primary subscription status changes, cascades updates to all active group members (respecting their billing provider). Syncs family coupon (`FAMILY20`) and group add-on products to Stripe. Used by `handleSubscriptionUpdated` and `handleSubscriptionDeleted`.

### `discounts.ts` — Discount Rule Sync
Syncs discount rules from the local `discount_rules` table to Stripe coupons. Each rule becomes a coupon with ID format `{TAG}_{PERCENT}PCT`. Called manually via admin routes but also referenced by `handleCouponUpdated` to detect family discount changes. Enables staff to manage discount codes that apply to checkouts.

### `invoices.ts` — Invoice Creation & Management
CRUD operations for one-time invoices (outside subscriptions): create draft, add line items, finalize, send, void, charge one-time fees. Automatically applies customer balance credits before charging the card. Used by webhook handlers (`handleInvoicePaymentSucceeded`, `handleInvoicePaymentFailed`) to track invoice state and by `handleCheckoutSessionCompleted` for add_funds and day pass purposes.

### `paymentRepository.ts` — Payment Queries
Query interfaces for admin dashboards: `getRefundablePayments()` (succeeded in last 30 days), `getFailedPayments()` (failed/requires_action), `getPendingAuthorizations()` (pre-authorized/incomplete). Provides visibility into payment status without hitting Stripe API repeatedly.

### `customerSync.ts` — MindBody Customer Metadata Sync
Updates Stripe customer metadata for users with `billing_provider = 'mindbody'` to keep tier and billing info synchronized. Detects and clears stale customer IDs if they've been deleted in Stripe. Prevents out-of-date metadata from influencing webhook logic.

### `environmentValidation.ts` — Stripe Environment Validation
Startup task that validates stored Stripe IDs (products, prices, subscription IDs) actually exist in the current Stripe account. Clears stale IDs if environment changed (e.g., test → production). Warns if subscription tiers or cafe items lost their Stripe links. Prevents webhooks from failing due to invalid resource references.

### `transactionCache.ts` — Transaction Cache
Lightweight local cache of Stripe transactions (payments, invoices, refunds) for reconciliation reporting and audit logs. Currently a stub; full implementation planned. Deferred actions upsert into this cache after each webhook commit so admins can see transaction history without querying Stripe API.

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

### Async Payment Handlers

`handleCheckoutSessionAsyncPaymentSucceeded` handles delayed payment methods (ACH, Klarna, Affirm). For day pass purchases, it must:

1. Extract the same metadata fields as the synchronous handler (`product_slug`, `email`, `first_name`, `last_name`, `phone`)
2. Call `recordDayPassPurchaseFromWebhook()` with the correct object payload (NOT positional args)
3. **Throw** on failure so Stripe retries the webhook — never silently swallow errors for financial operations

**Rule**: Async payment handlers must maintain **payload parity** with their synchronous counterparts. Any change to the synchronous handler's payload construction must be mirrored in the async handler.

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

## Audit Findings (Feb 2026)

### Error Handling Audit Results
A comprehensive code-reviewer audit confirmed:
- **Zero empty catch blocks** across all webhook handlers — every catch re-throws, logs via `logger.error`/`logger.warn`, or uses `safeDbOperation()`
- **Financial operation errors always propagate** — async day pass, payment intents, invoice finalization all throw on failure to enable Stripe retry
- **Savepoint usage in batch operations** (trackman/admin.ts) uses internally-generated names (`sp_${counter}`), NOT user input — verified safe from SQL injection

### Deferred Action Error Isolation
Deferred actions (HubSpot sync, email, notifications) execute AFTER the database transaction commits. Errors in deferred actions are logged but never propagate back to the webhook response — this is by design, to prevent non-critical side-effect failures from triggering unnecessary Stripe retries.

### Billing Provider Guard Coverage
The following handlers include `billing_provider` guards:
- `handleCustomerSubscriptionUpdated` — skips if billing_provider ≠ stripe
- `handleCustomerSubscriptionDeleted` — skips if billing_provider ≠ stripe  
- `handleInvoicePaymentFailed` — skips if billing_provider ≠ stripe, AND skips if invoice's subscription doesn't match user's current subscription
- `handleInvoicePaymentSucceeded` — skips if billing_provider ≠ stripe

Handlers that do NOT need billing_provider guards (they operate on Stripe-specific resources):
- `handlePaymentIntentSucceeded` — operates on payment intents, always from Stripe
- `handleChargeRefunded` — operates on charges, always from Stripe
- `handleCheckoutSessionCompleted` — operates on checkout sessions, always from Stripe

## Key References

- `references/event-handling.md` — Complete event type → handler → downstream effects mapping
- `references/hubspot-bridge.md` — How webhook events sync to HubSpot
- `billing-stripe-expert` skill — The 10 Commandments of billing and billing provider rules

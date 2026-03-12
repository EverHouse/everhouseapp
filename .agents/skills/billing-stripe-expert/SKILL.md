---
name: billing-stripe-expert
description: Expert rules for Stripe payments, billing, fee calculations, subscriptions, webhooks, and product catalog in the Ever Club Members App. Use whenever creating or modifying Stripe API calls, webhooks, or product catalog; payment processing (one-time, subscriptions, terminal, day passes); fee calculation (guest fees, overage fees, prepayments); booking sessions and billing sessions; subscription lifecycle (create, update, cancel, tier change); grace periods, dunning, or payment recovery; invoices, refunds, disputes, or coupons; pricing display on any frontend page; any table: booking_sessions, stripe_payment_intents, booking_fee_snapshots, webhook_processed_events, stripe_transaction_cache, guest_passes, billing_groups, terminal_payments.
---

# Billing & Stripe Expert

## The 10 Commandments of Billing

### 1. Stripe Is the Source of Truth
**NEVER hardcode prices** (e.g., `$25`) anywhere in the codebase. All dollar amounts must come from the Stripe Product Catalog or the database cache of it.

- **Pricing singleton**: `server/core/billing/pricingConfig.ts`
  - `PRICING.OVERAGE_RATE_DOLLARS` / `PRICING.OVERAGE_RATE_CENTS` — dynamic getters
  - `PRICING.GUEST_FEE_DOLLARS` / `PRICING.GUEST_FEE_CENTS` — dynamic getters
  - `PRICING.OVERAGE_BLOCK_MINUTES` = 30 (business logic, not a price)
  - `updateOverageRate(cents)` and `updateGuestFee(cents)` — called at startup and via webhooks
- **Startup loader**: `server/loaders/startup.ts` fetches current prices from Stripe on boot
- **Webhook refresh**: `product.updated` / `price.updated` webhooks trigger `updateOverageRate()` / `updateGuestFee()`
- **Frontend hook**: `src/hooks/usePricing.ts` fetches dynamic pricing from the API — never import constants

**If you see a raw number like `2500` or `25` representing dollars/cents, it is a bug.**

### 2. Sessions = Money
A **Booking** (`booking_requests`) is just a calendar reservation. A **BookingSession** (`booking_sessions`) is the billable financial record. Every billable booking MUST have a session.

- **Mandatory function**: `ensureSessionForBooking()` in `server/core/bookingService/sessionManager.ts`
- Call this after every booking approval, Trackman link, or CSV import
- **3-step lookup chain** (v7.26.1): (1) match by `trackman_booking_id`, (2) match by `resource_id + session_date + start_time`, (3) match by time range overlap. Only INSERTs if all 3 fail.
- **Transaction-aware**: throws immediately on failure when called with a `client` (no retry). 500ms retry only with pool connections.
- Flags booking for staff review on persistent failure (never silently fails)
- Also: `createSessionWithUsageTracking()` — creates session + usage ledger entries + guest pass deductions atomically

### 3. No Ghost Sessions
When creating a session, MUST immediately link it to the **Booking ID** and the **User ID**.

- `createSession()` in `sessionManager.ts` requires `bookingId` and `userId`
- Link the session before any fee calculations run
- An unlinked session = lost revenue (no way to bill)

### 4. Webhooks Rule
Do NOT poll for payment status. Rely on Stripe Webhooks to update the database.

- **Webhook handler**: `server/core/stripe/webhooks.ts` — `processStripeWebhook()`
- Key events handled:
  - `payment_intent.succeeded` → marks payment as paid
  - `payment_intent.failed` → marks payment as failed
  - `payment_intent.canceled` → marks payment as canceled
  - `invoice.payment_succeeded` → subscription payment confirmed
  - `invoice.payment_failed` → triggers grace period logic
  - `checkout.session.completed` → day pass / membership purchase confirmed
  - `customer.subscription.created/updated/deleted` → membership lifecycle
  - `charge.refunded` → refund processing
  - `charge.dispute.created/closed` → dispute handling (suspends membership)
  - `product.updated/created/deleted` → pricing refresh
  - `price.updated/created` → pricing refresh
- **Route**: `server/routes/stripe/payments.ts` receives the raw webhook POST
- **Raw body required**: Webhook endpoint must receive `Buffer` payload (not JSON-parsed). Exclude Express JSON middleware from the webhook route.

### 5. Idempotency Is Key
All billing webhooks must check `event.id` to ensure the same payment is never processed twice.

- **Dedup table**: `webhook_processed_events` — stores `event_id`, `event_type`, `resource_id`, `processed_at`
- **Claim function**: `tryClaimEvent()` in `webhooks.ts`
  - Uses `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING event_id`
  - If `rowCount === 0`, the event is a duplicate → skip
- **Transaction wrapping**: The entire webhook handler runs inside `BEGIN`/`COMMIT`. If the handler fails, `ROLLBACK` ensures the claim is also rolled back, so Stripe can retry.
- **Stripe API idempotency**: When creating payment intents, pass `idempotencyKey` to `stripe.paymentIntents.create()` (see `server/core/stripe/payments.ts`)
- **Cleanup**: Old processed events are pruned by scheduled maintenance

**CRITICAL — PaymentIntent dedup for bookings**:
Before creating ANY Stripe PaymentIntent for a booking, ALWAYS query `stripe_payment_intents` for an existing open intent:
```sql
SELECT * FROM stripe_payment_intents
WHERE booking_id = $1 AND status NOT IN ('succeeded', 'canceled', 'refunded')
```
If one exists, return it instead of creating a new one. `prepaymentService.ts` implements this pattern — follow it everywhere. Include `metadata.bookingId` on ALL payment intents for traceability.

### 6. Guest Fees
Guest fees are calculated based on filled slots in a booking that do NOT have a valid member assigned.

- **Calculation**: `computeFeeBreakdown()` in `server/core/billing/unifiedFeeService.ts`
- A participant is a "guest" only if they have NO `userId` (i.e., not a linked member)
- Members incorrectly marked as guests are NOT charged guest fees (explicit check)
- Placeholder guests (`Guest 1`, `Guest 2`) vs. real named guests have different treatment
- Empty booking slots generate synthetic guest fee line items
- Guest fee amount comes from `PRICING.GUEST_FEE_CENTS` (Commandment 1)
- **Guest pass system**: `server/core/billing/guestPassConsumer.ts` deducts from member's monthly allocation
- **Guest pass holds**: `server/core/billing/guestPassHoldService.ts` temporarily holds passes during booking flow before finalizing

### 7. Overage Fees
Overage is calculated in **30-minute blocks**. Use `computeFeeBreakdown()` — do NOT write custom math.

- **Block size**: `PRICING.OVERAGE_BLOCK_MINUTES` = 30 (business logic constant)
- **Rate**: `PRICING.OVERAGE_RATE_CENTS` (dynamic from Stripe, Commandment 1)
- **Calculation chain**:
  1. `computeUsageAllocation()` in `usageCalculator.ts` — divides session duration among participants
  2. `calculateOverageFee()` in `usageCalculator.ts` — computes overage based on minutes vs. daily allowance
  3. `computeFeeBreakdown()` in `unifiedFeeService.ts` — orchestrates everything
- **Duration rule**: Uses `GREATEST(session_duration, booking_duration)` to handle Trackman extensions
- **Prior usage**: Checks `usage_ledger` for same-day usage before calculating overage

### 8. Grace Periods
If a membership payment fails, do NOT cut off access immediately. Set status to `past_due` and allow the 3-day grace period logic to handle it.

- **Webhook trigger**: `invoice.payment_failed` → sets `membership_status = 'past_due'` and records `grace_period_start`
- **Scheduler**: `server/schedulers/gracePeriodScheduler.ts`
  - Runs periodically, checks `grace_period_start IS NOT NULL`
  - Sends escalating emails (tracked by `grace_period_email_count`)
  - After 3 days: suspends membership, clears grace period fields
- **Email templates**: `server/emails/paymentEmails.ts` — payment failure notifications
- **Do NOT**: Manually set `membership_status = 'cancelled'` on payment failure. Let the grace period scheduler handle the lifecycle.

### 9. Transactions
Any action that touches `booking_sessions`, `payments`, `stripe_payment_intents`, or `booking_fee_snapshots` tables MUST be wrapped in a database transaction.

- Pattern: Use `db.transaction(async (tx) => { ... })` from Drizzle ORM, or `safeDbTransaction()` from `server/core/safeDbOperation.ts` for automatic error alerting
- Drizzle handles BEGIN/COMMIT/ROLLBACK automatically
- On error: transaction auto-rolls back; `safeDbTransaction` also triggers `alertOnScheduledTaskFailure`
- **Webhook transactions**: The entire webhook handler is wrapped in a single transaction. If any handler fails, all DB changes roll back.
- **Fee calculations**: `calculateAndCacheParticipantFees()` in `feeCalculator.ts` wraps its multi-table updates in a transaction
- **Payment status**: `PaymentStatusService` methods (`markPaymentSucceeded`, `markPaymentRefunded`) use transactions to update snapshots + intents + participants atomically

### 10. Logs
Log all payment failures or unexpected billing states to the error alert system immediately.

- **Error alert module**: `server/core/errorAlerts.ts`
  - Sends email alerts via Resend to the configured alert address
  - Built-in protections: 4-hour cooldown per alert type, 3 alerts/day cap, 5-minute startup grace period
  - Filters transient errors (ECONNRESET, rate limits, etc.) to avoid noise
- **Logger**: `server/core/logger.ts` — structured logging for all billing events
- **Audit log**: `server/core/auditLog.ts` — `logFromRequest()` for all staff billing actions
- Always log: payment intent creation, payment success/failure, refund processing, subscription changes, dispute events, reconciliation mismatches

---

## Reference Files

### [references/patterns.md](references/patterns.md) — Additional Billing Patterns (11–23)
Read when implementing or modifying: deferred actions in webhooks, fee snapshots, prepayment lifecycle, Stripe client usage, customer creation, subscription lifecycle, dispute handling, day pass checkout, terminal payments, reconciliation, transaction caching, product/pricing sync, or card expiry monitoring.

### [references/file-map.md](references/file-map.md) — Complete File Map
Read when locating any billing-related file or understanding which module owns a responsibility. Contains tables for every server module, route, scheduler, email, frontend component, hook, and peripheral file that touches billing.

---

## Fee Order of Operations (Cross-Reference)

See `booking-import-standards/SKILL.md` Rule 15a for the MANDATORY fee calculation order:
Status → Staff → Active Membership → Tier → Unlimited → Social → Usage → Overage Blocks

**Key reminders:**
- Cancelled bookings = $0 (no further checks)
- Staff = $0 (no further checks)
- Inactive member = treated as guest, fee charged to HOST (not to the inactive participant)

---

## Outstanding Balance Queries

There are two endpoints that compute a member's outstanding fees:

1. **`/api/member/balance`** (`server/routes/stripe/member-payments.ts`) — used by the Overview tab's Outstanding Fees card
2. **`/api/member-billing/:email/outstanding`** (`server/routes/memberBilling.ts`) — used by the Billing tab's Outstanding Fees section

Both endpoints query `booking_participants` for unpaid fees. **All balance queries MUST include these three filters:**

1. **90-day lookback:** `bs.session_date >= CURRENT_DATE - INTERVAL '90 days'`
2. **Exclude cancelled bookings:** `NOT EXISTS (SELECT 1 FROM booking_requests br2 WHERE br2.session_id = bs.id AND br2.status IN ('cancelled', 'declined', 'cancellation_pending'))`
3. **Exclude settled sessions:** `NOT EXISTS (SELECT 1 FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status IN ('completed', 'paid'))`

Missing any of these filters causes phantom fees to appear (cancelled bookings or already-paid sessions showing as outstanding). This was a production bug fixed in v8.86.0.

---

## Anti-Patterns — NEVER Do These

1. **Never hardcode `$25`, `2500`, or any dollar amount** — always use `PRICING.*` from `pricingConfig.ts`
2. **Never create a booking without calling `ensureSessionForBooking()`** — sessions = money
3. **Never call `stripe.customers.create()` directly** — use `getOrCreateStripeCustomer()`
4. **Never instantiate `new Stripe(...)` directly** — use `getStripeClient()`
5. **Never poll Stripe for payment status** — rely on webhooks
6. **Never call external APIs inside a webhook transaction** — use the Deferred Action pattern
7. **Never set `membership_status = 'cancelled'` on payment failure** — set `past_due` and let grace period scheduler handle it
8. **Never write fee calculation math** — use `computeFeeBreakdown()` from `unifiedFeeService.ts`
9. **Never update `booking_sessions` or `stripe_payment_intents` outside a transaction**
10. **Never skip idempotency checks in webhook handlers** — always call `tryClaimEvent()`
11. **Never parse webhook body as JSON before signature verification** — it must be a raw `Buffer`
12. **Never create a PaymentIntent without checking for an existing open intent** — query `stripe_payment_intents` first (Commandment 5)
13. **Never query outstanding fees without filtering cancelled bookings and paid snapshots** — always include `NOT EXISTS` checks for cancelled/declined booking statuses AND completed/paid fee snapshots. See Outstanding Balance Queries section above.

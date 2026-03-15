---
name: billing-stripe-expert
description: Expert rules for Stripe payments, billing, fee calculations, subscriptions, webhooks, and product catalog in the Ever Club Members App. Use whenever creating or modifying Stripe API calls, webhooks, or product catalog; payment processing (one-time, subscriptions, terminal, day passes); fee calculation (guest fees, overage fees, prepayments); booking sessions and billing sessions; subscription lifecycle (create, update, cancel, tier change); grace periods, dunning, or payment recovery; invoices, refunds, disputes, or coupons; pricing display on any frontend page; any table: booking_sessions, stripe_payment_intents, booking_fee_snapshots, webhook_processed_events, stripe_transaction_cache, guest_passes, billing_groups, terminal_payments.
---

# Billing & Stripe Expert

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Pricing config (dynamic) | `server/core/billing/pricingConfig.ts` | `PRICING.*` getters, rate updates |
| Startup price loader | `server/loaders/startup.ts` | Fetches Stripe prices at boot |
| Fee computation | `server/core/billing/unifiedFeeService.ts` | `computeFeeBreakdown()` |
| Session management | `server/core/bookingService/sessionManager.ts` | `ensureSessionForBooking()` |
| Webhook handler | `server/core/stripe/webhooks.ts` (re-export shim), `server/core/stripe/webhooks/index.ts` (dispatch), `server/core/stripe/webhooks/handlers/` (handler files) | `processStripeWebhook()` |
| Webhook route | `server/index.ts` (line ~365) | Raw buffer POST endpoint |
| Payment intents | `server/core/stripe/payments.ts` | Create, track, cancel intents |
| Payment status | `server/core/billing/PaymentStatusService.ts` | Atomic status transitions |
| Fee snapshots | `server/core/billing/feeCalculator.ts` | Cache + snapshot lifecycle |
| Prepayment | `server/core/billing/prepaymentService.ts` | Intent creation, dedup |
| Guest pass consumer | `server/core/billing/guestPassConsumer.ts` | Pass consumption/refund |
| Guest pass holds | `server/core/billing/guestPassHoldService.ts` | Hold during booking |
| Grace period | `server/schedulers/gracePeriodScheduler.ts` | Payment failure follow-up |
| Error alerts | `server/core/errorAlerts.ts` | Email alerts for billing failures |
| Audit log | `server/core/auditLog.ts` | `logFromRequest()` for staff actions |
| Frontend pricing | `src/hooks/usePricing.ts` | Dynamic pricing from API |

## The 10 Commandments of Billing

### 1. Stripe Is the Source of Truth
All dollar amounts come from Stripe Product Catalog. `PRICING.OVERAGE_RATE_CENTS`, `PRICING.GUEST_FEE_CENTS` are dynamic getters. Refreshed at startup and via `product.updated`/`price.updated` webhooks. **If you see a raw number like `2500` or `25` representing dollars/cents, it is a bug.**

### 2. Sessions = Money
A booking is a calendar reservation. A session (`booking_sessions`) is the billable record. Every billable booking MUST have a session via `ensureSessionForBooking()`. 3-step lookup: (1) `trackman_booking_id`, (2) `resource_id + date + start_time`, (3) time range overlap.

### 3. No Ghost Sessions
Sessions MUST be linked to a booking ID and user ID immediately. Unlinked session = lost revenue.

### 4. Webhooks Rule
Do NOT poll for payment status. Rely on Stripe webhooks. Key events: `payment_intent.succeeded/failed/canceled`, `invoice.payment_succeeded/failed`, `checkout.session.completed`, `customer.subscription.*`, `charge.refunded`, `charge.dispute.*`, `product/price.updated`.

### 5. Idempotency Is Key
All webhooks check `event.id` via `tryClaimEvent()`. Before creating ANY PaymentIntent for a booking, query `stripe_payment_intents` for an existing open intent first. Include `metadata.bookingId` on all intents. Booking payment idempotency keys are deterministic (content-hash based). POS uses `customerId + SHA-256(cart) + SHA-256(description)`. Non-booking one-off payments use `crypto.randomUUID()` (v8.87.35). `chargeWithBalance` stores actual PI ID from `paidInvoice.payment_intent` — fallback `invoice-` prefix only for 100% balance-paid (v8.87.35).

### 6. Guest Fees
Participants without `userId` are guests. Members incorrectly in guest slots are NOT charged. Placeholder guests vs real named guests have different treatment. Empty slots generate synthetic guest fee line items. Amount from `PRICING.GUEST_FEE_CENTS`.

### 7. Overage Fees
Calculated in 30-minute blocks via `computeFeeBreakdown()`. Duration uses `GREATEST(session, booking)`. Checks `usage_ledger` for same-day prior usage.

### 8. Grace Periods
Payment failure → status `past_due` → 3-day grace period with escalating emails → `terminated` after 3 days. `DEFAULT_GRACE_PERIOD_DAYS = 3`. NEVER manually set `cancelled` on payment failure.

### 9. Transactions
All writes to `booking_sessions`, `payments`, `stripe_payment_intents`, `booking_fee_snapshots` MUST be in a transaction. Webhook handlers run in a single transaction. Fee calculations run POST-COMMIT (global pool, not inside transaction).

### 10. Logs
Log all payment failures to `errorAlerts.ts`. Built-in: 4h cooldown, 3/day cap, 5-min startup grace. Always log: intent creation, payment success/failure, refunds, subscription changes, disputes, reconciliation mismatches.

## Hard Rules

1. **NEVER hardcode dollar amounts.** Always use `PRICING.*` from `pricingConfig.ts`.
2. **NEVER create a booking without calling `ensureSessionForBooking()`.** Sessions = money.
3. **NEVER call `stripe.customers.create()` directly.** Use `getOrCreateStripeCustomer()`.
4. **NEVER instantiate `new Stripe(...)` directly.** Use `getStripeClient()`.
5. **NEVER poll Stripe for payment status.** Rely on webhooks.
6. **NEVER call external APIs inside a webhook transaction.** Use the Deferred Action pattern.
7. **NEVER set `membership_status = 'cancelled'` on payment failure.** Set `past_due`, let grace period handle it.
8. **NEVER write fee calculation math.** Use `computeFeeBreakdown()`.
9. **NEVER update billing tables outside a transaction.**
10. **NEVER skip `tryClaimEvent()` in webhook handlers.**
11. **NEVER parse webhook body as JSON before signature verification.** Must be raw `Buffer`.
12. **NEVER create a PaymentIntent without checking for existing open intent.**
13. **NEVER query outstanding fees without 3 filters:** 90-day lookback, exclude cancelled bookings, exclude paid snapshots. (v8.86.0 fix)

14. **Member-facing saved card payments use Stripe Customer Sessions (v8.87.9).** `member-payments.ts` creates a `customerSession` with `payment_method_redisplay`, `payment_method_save`, and `payment_method_remove` features enabled. Two saved card endpoints exist: `POST /api/member/bookings/:id/pay-saved-card` (booking prepayment — creates a draft invoice with line items, finalizes, and charges the selected payment method) and `POST /api/member/invoices/:invoiceId/pay-saved-card` (invoice payment — pays an existing open invoice using the selected payment method). On 3D Secure / `requires_action` results, the frontend falls back to the standard Payment Element flow.
15. **Invoices use `payment_method_types: ['card', 'link']` (v8.87.8).** `createDraftInvoiceForBooking()` in `bookingInvoiceService.ts` and all `invoices.update()` calls in `member-payments.ts` set `payment_settings.payment_method_types` to `['card', 'link']`. This enables Apple Pay, Google Pay, and Stripe Link wallets on all booking and member-facing invoices. NEVER remove or override this setting — it's required for wallet payments.
16. **WebSocket billing broadcasts use `payment_confirmed` action (v8.87.10).** `broadcastBillingUpdate()` and `broadcastBookingInvoiceUpdate()` must use `action: 'payment_confirmed'` (not `payment_completed`) for consistency with frontend event handlers.
18. **`stripe_payment_intents.user_id` must use actual userId, not email (v8.87.35).** `createBalanceAwarePayment` and `chargeWithBalance` in `payments.ts` set the `user_id` column to the member's UUID, not their email address. Previous versions incorrectly stored email in the user_id column for some paths.
19. **POS idempotency keys are deterministic (v8.87.35).** POS payment intents use `customerId + SHA-256(sorted cart JSON) + SHA-256(description)` as the idempotency key. Non-booking one-off payments (merchandise, cafe) use `crypto.randomUUID()` — deterministic keys are only required for booking payments.
20. **`cancelPaymentIntent` handles `processing` state (v8.87.35).** Returns structured `{ error: 'processing', message: ... }` and syncs local DB status. Callers check the error type instead of crashing.
21. **Stale amount detection in `StripePaymentForm` (v8.87.35).** When amount or fee changes while a PI already exists, the form cancels the existing PI and creates a new one with the correct amount. Prevents charging stale amounts.
17. **Conference room bookings skip invoice finalization when no fees are due (v8.87.7).** After `syncBookingInvoice()`, if `getBookingInvoiceId()` returns null (meaning total is $0 and no invoice was created), all three paths skip finalization: member booking (`bookings.ts`) and staff booking (`staff-conference-booking.ts`) log "No fees due — skipping invoice finalization"; booking approval (`approvalService.ts`) logs "No invoice found for conference room booking — skipping finalization".

## Outstanding Balance Queries

Two endpoints compute outstanding fees:
1. **`/api/member/balance`** (`server/routes/stripe/member-payments.ts`) — Overview tab
2. **`/api/member-billing/:email/outstanding`** (`server/routes/memberBilling.ts`) — Billing tab

Both MUST include:
1. 90-day lookback: `session_date >= CURRENT_DATE - INTERVAL '90 days'`
2. Exclude cancelled: `NOT EXISTS ... status IN ('cancelled', 'declined', 'cancellation_pending')`
3. Exclude settled: `NOT EXISTS ... bfs.status IN ('completed', 'paid')`

## Fee Order of Operations

Status → Staff → Active Membership → Tier → Unlimited → Social → Usage → Overage Blocks. Cancelled = $0. Staff = $0. Inactive member = guest fee charged to HOST.

## Cross-References

- **Fee calculation details** → `fee-calculation` skill
- **Webhook pipeline** → `stripe-webhook-flow` skill
- **Member status from webhooks** → `member-lifecycle` skill
- **Booking session creation** → `booking-flow` skill, `booking-import-standards` skill
- **Guest pass lifecycle** → `guest-pass-system` skill
- **Grace period scheduler** → `scheduler-jobs` skill

## Detailed Reference

- **[references/patterns.md](references/patterns.md)** — Additional billing patterns (11–23): deferred actions, fee snapshots, prepayment lifecycle, Stripe client usage, customer creation, subscription lifecycle, dispute handling, day pass checkout, terminal payments, reconciliation, transaction caching, product/pricing sync, card expiry monitoring.
- **[references/file-map.md](references/file-map.md)** — Complete file map for every billing-related module, route, scheduler, email, frontend component, and hook.

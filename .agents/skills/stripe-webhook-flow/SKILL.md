---
name: stripe-webhook-flow
description: End-to-end Stripe webhook handling pipeline for the Ever Club Members App. Covers stripe webhook processing, webhook handling flow, stripe wins rule for billing authority, subscription sync from webhooks, webhook dedup via processed events table, stripe events dispatch and routing, payment webhook succeeded/failed/refunded handling, subscription webhook lifecycle (created/updated/deleted/paused/resumed), deferred action pattern, resource-based event ordering, and ghost reactivation blocking. Use when modifying Stripe webhook handlers, adding new event types, changing subscription status mapping, or debugging payment/billing webhook issues.
---

# Stripe Webhook Flow

For billing rules, see the `fee-calculation` skill. For member status transitions, see `member-lifecycle`.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Webhook pipeline & dispatch | `server/core/stripe/webhooks.ts` (re-export shim), `server/core/stripe/webhooks/index.ts` (real dispatch) | Adding event types, changing dedup/ordering |
| Dedup, ordering, deferred actions | `server/core/stripe/webhooks/framework.ts` | Event claiming, resource ordering, deferred execution |
| Shared types | `server/core/stripe/webhooks/types.ts` | DeferredAction, StripeEventObject, CacheTransactionParams |
| Payment handlers (succeeded/failed/refunded) | `server/core/stripe/webhooks/handlers/payments.ts` | Payment event handling |
| Subscription handlers (CRUD/pause/resume) | `server/core/stripe/webhooks/handlers/subscriptions.ts` | Subscription lifecycle |
| Invoice handlers | `server/core/stripe/webhooks/handlers/invoices.ts` | Invoice payment success/failure |
| Checkout session handler | `server/core/stripe/webhooks/handlers/checkout.ts` | Checkout flows (add_funds, day_pass, activation) |
| Customer handlers (reassignment) | `server/core/stripe/webhooks/handlers/customers.ts` | Customer metadata/ownership changes |
| Catalog handlers | `server/core/stripe/webhooks/handlers/catalog.ts` | Product/price sync |
| Group billing cascade | `server/core/stripe/groupBilling.ts` | Family/corporate status propagation |
| Subscription sync | `server/core/stripe/subscriptionSync.ts` | Full subscription reconciliation |
| Reconciliation | `server/core/stripe/reconciliation.ts` | Daily payment reconciliation |
| Environment validation | `server/core/stripe/environmentValidation.ts` | Startup Stripe ID validation |
| Transaction cache | `server/core/stripe/transactionCache.ts` | Payment history cache |
| Webhook route | `server/index.ts` (line ~365) | HTTP endpoint, raw buffer handling |

## The Webhook Pipeline

Every Stripe webhook follows this exact sequence:

```
Stripe POST → raw Buffer → signature verify → parse event
  → tryClaimEvent (dedup) → checkResourceEventOrder
  → BEGIN tx → dispatch to handler → COMMIT
  → execute deferred actions → cleanup old events (5% probabilistic)
```

## Decision Trees

### Adding a new webhook event type

```
1. Add handler function in the appropriate `webhooks/handlers/*.ts` file
2. Add if/else if branch in dispatch chain
3. Handler MUST return DeferredAction[]
4. All DB writes inside the transaction
5. All notifications/emails/syncs in deferred actions
6. Add event type to EVENT_PRIORITY map
```

### Where does this code go — transaction or deferred?

```
Does it write to the database?
├── Yes → Inside transaction (handler body)
└── No
    Does it call an external API (Stripe, HubSpot, etc.)?
    ├── Yes → Deferred action (after COMMIT)
    │   └── Does it move money? → STOP. Money ops MUST be in handler body with idempotency key.
    └── No (WebSocket broadcast, cache update) → Either is fine, deferred preferred
```

## Hard Rules

1. **Raw Buffer required.** Payload MUST be a raw `Buffer` for signature verification. If `express.json()` parses first, signature check fails.
2. **Stripe Wins rule.** When `billing_provider = 'stripe'`, Stripe is authoritative for `membership_status` and `tier`. Every handler checks `billing_provider` before modifying the user — if not `'stripe'`, SKIP the update.
3. **No external API calls in transactions.** HTTP calls to Stripe/HubSpot inside `BEGIN`/`COMMIT` exhaust the connection pool. Move to deferred actions. Five documented exceptions exist with `Promise.race()` 5s timeout and `// NOTE: Must stay in transaction` comments.
4. **Deferred actions never roll back committed data.** Each deferred action is wrapped in try/catch. Failures are logged but never propagate.
5. **Deferred actions must NOT move money.** Any operation that creates/transfers/destroys money MUST be in the handler body with an idempotency key. Deferred actions already returned 200 — Stripe won't retry.
6. **Ghost reactivation blocked.** `subscription.created` after `subscription.deleted` for the same resource is blocked to prevent reactivating cancelled members.
7. **Subscription ID match guard on invoice failures.** `handleInvoicePaymentFailed` checks that the invoice's subscription matches the user's current `stripe_subscription_id`. Stale invoices from old subscriptions are skipped.
8. **Grace period is 3 days.** Default `DEFAULT_GRACE_PERIOD_DAYS = 3`, configurable via `scheduling.grace_period_days`.
9. **Cascade must NOT overwrite sub-member billing_provider.** Group status cascades only change `membership_status` and `updated_at` — never force `billing_provider = 'stripe'` on sub-members.
10. **Event dedup via `webhook_processed_events`.** `tryClaimEvent` uses `INSERT ON CONFLICT DO NOTHING`. If `rowCount === 0`, event already processed → skip.
11. **Async payment handlers must maintain payload parity.** Any change to the synchronous checkout handler must be mirrored in `handleCheckoutSessionAsyncPaymentSucceeded`.
12. **`FOR UPDATE` queries MUST use `ORDER BY id ASC`.** Multi-row `FOR UPDATE` without consistent ordering causes PostgreSQL deadlocks when concurrent transactions lock rows in different orders. This applies everywhere in `payments.ts` and `manualBooking.ts`.
13. **All catch blocks MUST use `getErrorMessage(err)`.** Import from `utils/errorUtils`. Never log raw `err` or cast to `Error`. This applies to handler bodies AND deferred action wrappers in `framework.ts`.
14. **Dispute-won reactivation is guarded.** `handleChargeDisputeClosed` checks for OTHER open disputes on the same member AND verifies the Stripe subscription status. Reactivation is blocked if subscription is `past_due`, `unpaid`, or `canceled`. Subscription lookup failures are fail-closed (block reactivation, alert staff). The `membershipAction` variable tracks whether reactivation actually happened so audit logs and notifications reflect the real outcome.

## Anti-Patterns (NEVER)

1. NEVER make Stripe/HubSpot API calls inside a DB transaction without the 5s `Promise.race()` timeout.
2. NEVER put money-moving operations in deferred actions.
3. NEVER overwrite `billing_provider` during group cascade updates.
4. NEVER skip the `billing_provider` guard — non-Stripe members must not have their status changed by Stripe events.
5. NEVER use `express.json()` on the webhook route — it destroys the raw buffer needed for signature verification.
6. NEVER process a `subscription.created` event that arrives after `subscription.deleted` for the same subscription.
7. NEVER use `FOR UPDATE` on multi-row queries without `ORDER BY id ASC` — guaranteed deadlocks under concurrency.
8. NEVER log raw error objects — always use `getErrorMessage(err)` from `utils/errorUtils`.
9. NEVER call `stripe.paymentIntents.cancel()` directly — always use `cancelPaymentIntent()` from `server/core/stripe/payments.ts`. It detects invoice-generated PIs (via `expand: ['invoice']` + booking DB fallback) and voids/deletes the invoice instead, since Stripe rejects direct cancel on invoice-created PIs. **Exception**: Pre-OOB payment flows (where `invoices.pay(id, { paid_out_of_band: true })` follows immediately) intentionally use direct cancel to avoid voiding the invoice — these call sites are annotated with explanatory comments (v8.87.29). The `stripe_cancel_payment_intent` job handler in `jobQueue.ts` also uses `cancelPaymentIntent()` and auto-queues a refund if the PI raced to 'succeeded' (v8.87.31).
10. NEVER call `stripe.paymentIntents.confirm()` on invoice-generated PIs — always use `stripe.invoices.pay(invoiceId)` instead. Detect invoice PIs via `expand: ['invoice']` on retrieve, with DB fallback via `getBookingInvoiceId(bookingId)`.
11. NEVER insert directly into `notifications` table from webhook handlers — use `notifyMember()` / `notifyAllStaff()` from `server/core/notificationService.ts` (v8.87.28).

## Cross-References

- **Member status transitions** → `member-lifecycle` skill
- **Fee calculation after payment events** → `fee-calculation` skill
- **Group billing operations** → `member-lifecycle` skill (Group Billing section)
- **HubSpot sync from webhooks** → `hubspot-sync` skill
- **Booking invoice lifecycle** → `fee-calculation` skill (Invoice Lifecycle section)

## Detailed Reference

- **[references/event-handling.md](references/event-handling.md)** — Complete event type → handler mapping, subscription status mapping table, checkout session routing, product catalog sync, payment retry/dunning.
- **[references/hubspot-bridge.md](references/hubspot-bridge.md)** — HubSpot sync triggered by webhook handlers, deal stage updates, company sync.

---

## Subscription Status Mapping

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

## Resource-Based Event Ordering

Each event type has a priority number. If the last processed event for a resource has a HIGHER priority, the incoming event is blocked:

```
Payment:      created(1) → processing(2) → requires_action(3) → succeeded/failed(10) → refunded(20)
Invoice:      created(1) → finalized(2) → payment_succeeded/failed(10) → paid(11) → voided(20)
Subscription: created(1) → updated(5) → paused(8) → resumed(9) → deleted(20)
```

## Migration Webhook Handling

Migration subscriptions have `metadata.migration === 'true'`. When detected in `handleSubscriptionCreated`:
- Sets `migration_status = 'completed'`
- `billing_provider` is already `'stripe'` (flipped during migration initiation)
- Standard subscription processing continues

## Checkout Session Routing

`handleCheckoutSessionCompleted` routes on `session.metadata`:

| Metadata | Action |
|---|---|
| `purpose === 'add_funds'` | Credit member's Stripe balance, send receipt |
| `company_name` present | Sync company to HubSpot, update billing group |
| `source === 'activation_link'` | Activate pending user |
| `source === 'staff_invite'` | Resolve via linked emails, create/activate user |
| `purpose === 'day_pass'` | Record day pass, send QR email |

## Critical Rules: Off-Session / Saved Card Payments

**NEVER use `paymentIntents.confirm()` with `off_session: true` on an invoice-generated PI.**
Invoice-generated PIs may have `confirmation_method: automatic` or use `confirmation_secret` (newer Stripe API), making them incompatible with server-side `off_session` confirmation.

**ALWAYS use `stripe.invoices.pay(invoiceId, { payment_method: pmId })` for off-session saved card charges.**
This is the correct Stripe API — it handles PI creation/confirmation internally.

**Before creating a new charge, check Stripe live PI state:**
- If existing PI is `succeeded`, `processing`, or `requires_capture` → block the operation (already paid / in progress)
- If existing PI has `livePi.invoice` set → SKIP cancel entirely; let `invoices.pay()` handle it
- If existing PI is `requires_payment_method`, `requires_confirmation`, or `requires_action` (non-invoice) → cancel it first via `cancelPaymentIntent()` helper, then proceed
- Only mark local DB status as `canceled` AFTER confirmed Stripe cancel succeeds

**Double-refund prevention (v8.87.26):**
When `voidBookingInvoice()` queues a refund for a paid invoice's PI, and a direct refund path also tries to refund the same PI, the direct path must check `stripe_payment_intents` for `status IN ('refunding', 'refunded')` before calling `stripe.refunds.create()`. If already queued, skip the direct refund and just mark the participant as refunded.

**Invoice reuse loop prevention (v8.87.25):**
When `finalizeAndPayInvoice` fails on an existing invoice and the fallback tries `createDraftInvoiceForBooking`, the latter will REUSE the same broken `open` invoice if the amount matches. This causes the same failure in a loop. FIX: before calling `createDraftInvoiceForBooking`, VOID the broken invoice via `stripe.invoices.voidInvoice()` and clear `booking_requests.stripe_invoice_id` in DB. Also mark stale PIs as `canceled` in `stripe_payment_intents` table.

**Files where this rule applies:**
- `server/core/billing/bookingInvoiceService.ts` — `finalizeAndPayInvoice()`
- `server/core/stripe/invoices.ts` — `createBookingFeeInvoice()`
- `server/routes/stripe/booking-fees.ts` — staff "Charge Card on File"
- `server/routes/stripe/member-payments.ts` — member "Pay with Saved Card"
- `server/routes/stripe/quick-charge.ts` — POS saved card charges

**POS invoice settlement metadata (v8.87.33, Task #69):**
The `payment_intent.succeeded` handler in `handlers/payments.ts` must check BOTH `metadata?.draftInvoiceId` and `metadata?.invoice_id` when detecting standalone terminal payments that need invoice settlement. The `invoice_id` key is set by `createInvoiceWithLineItems` in `payments.ts`. Checking only one key causes some terminal payments to skip invoice settlement.

**Card vaulting via `setup_future_usage` (v8.87.33, Task #69):**
Both `createPaymentIntent` and `createBalanceAwarePayment` in `server/core/stripe/payments.ts` include `setup_future_usage: 'off_session'` so the payment method is saved to the customer for future billing (subscriptions, staff charges). Removing this breaks card vaulting.

**iOS Safari Stripe Elements rendering (v8.87.33, Task #69):**
`StripePaymentWithSecret` and `StripePaymentForm` in `src/components/stripe/StripePaymentForm.tsx` wrap the payment form in a div with `transform: 'none', animation: 'none'` to prevent iOS Safari CSS interference when Stripe Elements renders inside modals with CSS animations/transforms.

**React StrictMode payment intent cleanup (v8.87.33, Task #69):**
`StripePaymentForm` uses `intentCreatedRef` inside `initStripe()` to guard against duplicate payment intent creation in React StrictMode. The cleanup function (cancels orphaned PIs on unmount) is returned unconditionally from the useEffect — it was previously only returned conditionally, causing orphaned PIs when StrictMode double-mounted.

**Payment state fragmentation prevention (v8.87.34, Task #70):**
When `PaymentStatusService.markPaymentSucceeded` fails in `server/core/stripe/payments.ts`, the fallback now sets the PI status to `requires_reconciliation` (not `succeeded`). This prevents split-brain state where the Stripe PI shows succeeded but booking/participants remain pending. The `requires_reconciliation` status signals that manual intervention or the next reconciliation run should resolve the state.

**3D Secure / bank redirect return handling (v8.87.34, Task #70):**
`StripePaymentForm.tsx` has a useEffect that checks for `payment_intent` and `payment_intent_client_secret` URL params on mount. If present, it calls `stripe.retrievePaymentIntent(piSecret)` and validates that `paymentIntent.id === piId` (security check) and `status === 'succeeded'` before calling `onSuccess`. URL params are cleaned via `history.replaceState` after successful verification.

**Partial refund safety (v8.87.34, Task #70):**
`cancellation.ts` balance refund path now queries `amount_cents - COALESCE(refunded_amount_cents, 0) AS remaining_cents` before issuing the refund — uses `remainingRaw ?? null` (nullish coalescing) to avoid treating 0 as falsy. Skips refund entirely if `remainingCents <= 0`. Stripe card refunds omit the explicit `amount` param so Stripe defaults to refunding the remaining unrefunded balance.

**Guest pass transaction deadlock fix (v8.87.34, Task #70):**
`refundGuestPass()` in `server/routes/guestPasses.ts` accepts optional `txClient` parameter. When provided, it uses the existing transaction client directly instead of creating a nested `db.transaction()` (which would deadlock). `bookingStateService.ts` passes `tx` when calling inside `completePendingCancellation`.

**Cancellation rollback floating promise fix (v8.87.34, Task #70):**
Rollback `db.execute()` calls in `cancellation.ts` use `await` + `try/catch` instead of `.catch()` chains to prevent unhandled promise rejections.

**`cancelPaymentIntent` processing state handling (v8.87.35, Task #71):**
`cancelPaymentIntent()` in `server/core/stripe/payments.ts` now handles PIs in `processing` state — returns a structured error `{ error: 'processing', message: ... }` and syncs the local DB status to `processing`. Callers can check the error type and retry later instead of crashing.

**POS idempotency key determinism (v8.87.35, Task #71):**
POS payment intents use a deterministic idempotency key derived from `customerId + SHA-256(sorted cart JSON) + SHA-256(description)`. This prevents duplicate charges from double-taps while allowing legitimate re-charges of the same items.

**Non-booking payment idempotency (v8.87.35, Task #73):**
Non-booking payments (merchandise, cafe, etc.) use `crypto.randomUUID()` for idempotency keys instead of time-bucketed keys. Time-bucketed keys could collide when multiple payments happen within the same time window, causing false duplicate detection. Convention 14 in `project-architecture` is updated — deterministic keys are required for booking payments; `randomUUID()` is acceptable for non-booking one-off charges.

**`chargeWithBalance` PI ID storage (v8.87.35, Task #73):**
`chargeWithBalance` now stores the actual Stripe payment intent ID from `paidInvoice.payment_intent` in the `stripe_payment_intents` table. Falls back to `invoice-${invoiceId}` prefix only for 100% balance-paid invoices (where no real PI exists). Previously fabricated IDs for all paths.

**Hard-delete PI cleanup (v8.87.35, Task #71):**
When hard-deleting a booking, PI cleanup refunds succeeded PIs and cancels non-terminal ones. Skips both `balance-` and `invoice-` prefixed synthetic IDs (not real Stripe objects). Pending participant PIs are also cancelled in both `cancelBooking` and `completePendingCancellation`.

**`refund_succeeded_sync_failed` status (v8.87.35, Tasks #71-#73):**
When a Stripe refund succeeds but the local `markPaymentRefunded` DB call fails, the system sets status to `refund_succeeded_sync_failed` with CRITICAL logging. This applies in `executeInlineRefund` (bookingStateService), `voidBookingInvoice` (bookingInvoiceService), and the cancellation cascade. Prevents silent data divergence.

**`StripePaymentWithSecret` unmount cleanup (v8.87.35, Task #72):**
The `StripePaymentWithSecret` component now uses `keepalive: true` in its unmount cleanup `fetch` call, matching the existing pattern in `StripePaymentForm`. Without this, the browser could abort the PI cancellation request during tab close/navigation.

**`failed_side_effects` recovery table (v8.87.35, Task #73):**
New `failed_side_effects` table (migration 0056) tracks cancellation side-effect failures. Fields: `booking_id`, `action_type`, `stripe_payment_intent_id`, `error_message`, `retry_count`, `resolved`. Populated by `BookingStateService.executeSideEffects` when refunds, calendar cleanup, or notifications fail.

## Supporting Services

| Service | File | Purpose |
|---|---|---|
| Group Billing | `groupBilling.ts` | Family/corporate cascade, coupon sync |
| Discounts | `discounts.ts` | Discount rule → Stripe coupon sync |
| Invoices | `invoices.ts` | One-time invoice CRUD, balance credit application |
| Payment Queries | `paymentRepository.ts` | Admin dashboard payment queries |
| Customer Sync | `customerSync.ts` | MindBody customer metadata sync |
| Environment Validation | `environmentValidation.ts` | Startup Stripe ID validation |
| Transaction Cache | `transactionCache.ts` | Local payment history cache |

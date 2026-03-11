---
name: fee-calculation
description: Fee calculation system — computeFeeBreakdown, guest fees, overage fees, prepayment, dynamic pricing, billing, and the unified fee service that produces per-participant line items for simulator and conference room bookings.
---

# Fee Calculation System

## Overview

The Ever Club app calculates session fees through a **unified fee service** (`server/core/billing/unifiedFeeService.ts`). Every booking session produces a `FeeBreakdown` containing per-participant line items with overage charges and guest fees. The central entry point is `computeFeeBreakdown()`, which accepts either a live session/booking ID or raw parameters for preview mode. When fees change due to roster updates, the booking's Stripe invoice is automatically synced via `syncBookingInvoice()` from `bookingInvoiceService.ts`.

Fees break down into two categories:
- **Overage fees** — charged to members who exceed their daily included minutes for the resource type (simulator or conference room).
- **Guest fees** — flat per-guest charge for non-member participants, offset by guest passes when available.

Pricing is **dynamic**: default rates (overage per 30-min block, flat guest fee) start at hardcoded defaults in `pricingConfig.ts` but are overwritten at server startup by reading Stripe product prices. This means Stripe is the single source of truth for live rates.

## How computeFeeBreakdown Works

### Inputs

Accept a `FeeComputeParams` object (defined in `shared/models/billing.ts`) containing:
- `sessionId` / `bookingId` — resolve session data from the database, OR
- Raw fields (`sessionDate`, `sessionDuration`, `hostEmail`, `participants`, etc.) for preview calculations.
- `source` — one of `preview`, `approval`, `checkin`, `stripe`, `roster_update`.
- `isConferenceRoom` — toggle between simulator and conference room allowance logic.
- `excludeSessionFromUsage` — exclude the current session from prior-usage tallies to avoid double-counting during recalculation.

### Processing Pipeline

1. **Load or accept session data** — resolve participants, duration (using `GREATEST` of session and booking durations), host email, resource type.
2. **Short-circuit cancelled/declined bookings** — return `$0` immediately.
3. **Compute effective player count** — `Math.max(declared, actual, 1)`.
4. **Compute minutes per participant** — `floor(sessionDuration / effectivePlayerCount)` for simulators; full duration for conference rooms.
5. **Resolve host tier and guest pass availability** — look up membership tier, tier limits, and remaining guest passes for the host.
6. **Batch-fetch participant tiers, roles, and daily usage** — single queries for all participants to avoid N+1.
7. **Build line items** — iterate participants and apply rules per type (see reference: `references/fee-breakdown.md`).
8. **Owner absorbs non-member time** — empty slots and guest slot minutes are added to the owner's allocated minutes, then overage is recalculated.
9. **Empty slot = guest treatment (v8.85.0)** — each unfilled declared slot is treated identically to a guest: its minutes are absorbed into the owner's allocated minutes (increasing potential overage), AND `GUEST_FEE_CENTS` is charged as a flat guest fee per empty slot. This ensures there is no cost advantage to leaving a slot empty vs. inviting a guest.
10. **Return `FeeBreakdown`** — totals, participant line items, and metadata.

### Output

```
FeeBreakdown {
  totals: { totalCents, overageCents, guestCents, guestPassesUsed, guestPassesAvailable }
  participants: FeeLineItem[]
  metadata: { effectivePlayerCount, declaredPlayerCount, actualPlayerCount, sessionDuration, sessionDate, source }
}
```

## Fee Types

### Overage Fees

Charged when a member's cumulative daily usage (prior sessions + current allocation) exceeds their tier's daily allowance.

**Calculation steps for each member participant:**

1. Retrieve `usedMinutesToday` — minutes already consumed by earlier sessions on the same day for the same resource type.
2. Compute `totalAfterSession = usedMinutesToday + minutesAllocated`.
3. Compute overage for the full day: `overageResult = calculateOverageFee(totalAfterSession, dailyAllowance)`.
4. Compute overage that was already present before this session: `priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance)`.
5. Marginal overage from this session only: `overageMinutes = max(0, overageResult.overageMinutes - priorOverage.overageMinutes)`.
6. Round up to 30-minute blocks: `blocks = ceil(overageMinutes / 30)`.
7. Fee in cents: `blocks * PRICING.OVERAGE_RATE_CENTS`.
8. Tiers with `unlimited_access = true` or `dailyAllowance >= 999` skip this entirely and pay $0.

**Chronological ordering rule:** only bookings that start earlier than the current booking count toward `usedMinutesToday`. This prevents a later booking's usage from inflating an earlier booking's overage. When two bookings start at the same time, tie-break by booking ID (lower ID goes first).

**Owner absorbs non-member time:** after initial per-participant line items, the owner's `minutesAllocated` is increased by `(emptySlots + guestCount) * minutesPerParticipant`. The owner's overage is then recalculated with this expanded allocation, so the owner bears the usage cost for guests and unfilled player slots.

### Guest Fees

Charged per non-member participant at `PRICING.GUEST_FEE_CENTS` (flat rate, default $25).

**Exemptions (in evaluation order):**

1. Conference room bookings → no guest fees at all (guests are skipped).
2. Staff/admin/golf_instructor in a guest slot ("Pro in the Slot" rule) → $0, `isStaff = true`.
3. Participant has a `userId` (actually a member marked as guest) → $0 (member misclassification guard).
4. Real named guest with an available guest pass and `hasGuestPassBenefit` → fee waived, `guestPassUsed = true`, decrement `guestPassesRemaining`.
5. All other guests → charged `PRICING.GUEST_FEE_CENTS`.

**Placeholder guests** matching `/^Guest \d+$/i` (e.g., "Guest 1", "Guest 2") are not considered "real named guests" and cannot consume guest passes, but still incur the flat guest fee.

**Empty slot handling (v8.85.0):** when `effectivePlayerCount > actualParticipantCount`, empty slots are treated identically to guests. Each empty slot's minutes are absorbed into the owner's allocated minutes (increasing potential overage), AND each empty slot incurs `GUEST_FEE_CENTS` as a flat guest fee. Empty slot line items appear in the breakdown with `guestCents = GUEST_FEE_CENTS` and `totalCents = GUEST_FEE_CENTS`. This ensures there is no cost difference between leaving a slot empty and inviting a guest.

### Prepayment

When `computeFeeBreakdown` determines fees > $0, the approval flow can trigger `createPrepaymentIntent()` (`prepaymentService.ts`) to collect payment before the session.

**Prepayment flow:**

1. Skip if `totalFeeCents <= 0`.
1b. Safety net: skip if user is staff/admin/golf_instructor or has an unlimited-access tier (single DB query check).
2. Check for existing non-cancelled prepayment intents for the session (by `session_id`) or booking (by `booking_id`). If found, skip to prevent duplicate charges.
3. Get or create a Stripe customer for the member.
4. Call `createBalanceAwarePayment()` — this checks the member's Stripe customer balance (account credit) first:
   - If credit fully covers the fee → return `paidInFull = true` with a `balanceTransactionId`, no card needed.
   - If partial or no credit → create a Stripe PaymentIntent for the remaining amount, return `clientSecret` for frontend payment collection.
5. Store the payment intent in `stripe_payment_intents` with `purpose = 'prepayment'`.

**Metadata stored on payment:** `bookingId`, `sessionId`, `overageCents`, `guestCents`, `prepaymentType = 'booking_approval'`.

### Already-Paid Participant Guard (v8.68.0)

Fee recalculation skips participants who have already paid (`cached_fee_cents > 0` with a completed payment intent). This prevents `cached_fee_cents` from being overwritten during roster updates, which would cause billing discrepancies. Usage lookups sum both `userId` and `email` entries in the `usage_ledger` to prevent double-dipping when the same person appears under different identifiers across booking types.

### Invoice Lifecycle (v8.68.0)

- **Cancellation cleanup**: Draft invoices are deleted and `stripe_invoice_id` is cleared when a booking is cancelled.
- **Permanent deletion**: Invoices are voided when a booking is permanently deleted from the data integrity dashboard.
- **Invoice-to-booking link**: Orphaned invoice references (where the Stripe invoice no longer exists) are cleaned up automatically.

### Booking Invoice Sync

When roster changes trigger fee recalculation (via `recalculateSessionFees()`), the booking's draft Stripe invoice is automatically synced by `syncBookingInvoice()`. This ensures the invoice line items always reflect the current participant fees. The sync:

- Reads `cached_fee_cents` from `booking_participants` for the session.
- Builds `BookingFeeLineItem[]` with per-participant overage and guest fee breakdowns.
- Calls `updateDraftInvoiceLineItems()` to replace all invoice line items.
- If total fees drop to $0, deletes the draft invoice and clears `stripe_invoice_id`.
- **$0→$X fee transition**: If no invoice exists yet (e.g., booking was approved with $0 fees) but current fees are > $0, `syncBookingInvoice` creates a new draft invoice on-the-fly using the stored `stripe_customer_id` from the users table. This handles the case where a booking starts with no guests/overage but gains fees through later roster edits.
- Guards: skips if invoice is already `paid`, `open`, `void`, or `uncollectible` (logs warning and notifies staff for paid/open invoices).
- Guards: skips non-approved bookings.

Note: As of v8.16.0 (2026-02-24), conference room bookings use the same invoice-based flow as simulators. Old `conference_prepayments` records are grandfathered at check-in.

**Conference prepayment staff access (v8.57.0):** Staff and admin users can view and manage conference room prepayments on behalf of any member via `server/routes/conference/prepayment.ts`. Authorization checks permit admin/staff to act on any member's prepayments while restricting regular users to their own.

## Conference Room vs Simulator Differences

The fee engine handles two resource types with distinct rules:

| Aspect | Simulator | Conference Room |
|--------|-----------|-----------------|
| Minutes per participant | `floor(duration / effectivePlayerCount)` | Full `sessionDuration` (no splitting) |
| Guest fees | Charged per non-member guest | Not charged (guests skipped) |
| Member overage | Each member's own tier allowance | Only owner's allowance matters |
| Daily allowance field | `daily_sim_minutes` | `daily_conf_room_minutes` |
| Usage tracking | Separate from conference room usage | Separate from simulator usage |
| Owner absorbs guest/empty time | Yes | No (no splitting) |

The `isConferenceRoom` flag on `FeeComputeParams` (or derived from `resources.type = 'conference_room'`) controls which branch executes. Non-owner members and guests in conference room bookings receive line items with `$0` fees and `minutesAllocated = 0`.

## Fee Caching and Application

Calculated fees are cached at two levels to avoid redundant computation:

1. **`booking_participants.cached_fee_cents`** — per-participant cached total fee. Set by `applyFeeBreakdownToParticipants()` or `calculateAndCacheParticipantFees()`. Cleared by `invalidateCachedFees()` or `clearCachedFees()` when roster changes occur.
2. **`booking_requests.overage_fee_cents` and `overage_minutes`** — session-level totals for legacy dashboard compatibility (Pay Now button). These columns are NOT synced by `recalculateSessionFees()`; callers handle invoice sync separately via `syncBookingInvoice()`. (Legacy — scheduled for removal when overage payment UI migrates to invoice flow)

When `feeCalculator.ts` resolves fees, it checks in order: cached → ledger → calculated. This means a participant whose fee was already cached will not trigger a recalculation unless the cache is explicitly cleared. In ledger-mode fallback, if no `usage_ledger` rows exist for a participant (ghost usage), the calculator falls back to computing a guest fee from tier data or `PRICING.GUEST_FEE_CENTS`.

`recalculateSessionFees()` orchestrates a two-step recalculation pipeline: compute (via `computeFeeBreakdown`) → apply to participants (via `applyFeeBreakdownToParticipants`). It does NOT sync to `booking_requests` columns or update the Stripe invoice directly. Invoice sync is the caller's responsibility via `syncBookingInvoice()`.

**Cascade behavior (v8.26.7, Bug 13):** After recalculating a session's fees, `recalculateSessionFees` automatically finds and recalculates all later same-day bookings for the same member (matched by `user_email` and `session_date`, ordered by `start_time ASC`, limited to 10). This ensures that changing an earlier booking's duration correctly adjusts overage calculations on subsequent sessions. The cascade uses `skipCascade: true` internally to prevent infinite loops. Cascade failures are logged as warnings and are non-blocking.

**CRITICAL — Transaction isolation (v8.26.7, Bug 22):** `recalculateSessionFees()` uses the global `db` pool for all its queries. It does NOT accept a transaction handle (`tx`). This means it **MUST NEVER** be called inside a `db.transaction()` block. Under Postgres Read Committed isolation, the global pool cannot see uncommitted rows from an active transaction, causing:
- $0 fee calculations (session/participants invisible)
- Deadlock (global pool waits for tx to commit, tx waits for fee calculation)

**Pattern:** Always commit the transaction first, then call `recalculateSessionFees()`:
```typescript
const { createdSessionId } = await db.transaction(async (tx) => {
  // ... create session and participants using tx ...
  return { createdSessionId };
});
// Fee calculation AFTER commit — global pool can now see the rows
const breakdown = await recalculateSessionFees(createdSessionId, 'approval');
```

**Known callers that MUST also call `syncBookingInvoice()`:**
- Booking approval (`server/routes/bays/approval.ts`) — creates invoice at approval time
- Roster changes: add/remove participant, update player count (`server/routes/roster.ts`)
- Staff direct-add during check-in (`server/routes/staffCheckin.ts`)
- Trackman admin reassign (`server/routes/trackman/admin.ts` — `PUT /api/admin/booking/:id/reassign`)
- Trackman admin link member (`server/routes/trackman/admin.ts` — `PUT /api/admin/booking/:bookingId/members/:slotId/link`)
- Trackman admin resolve unmatched (`server/routes/trackman/admin.ts` — `PUT /api/admin/trackman/unmatched/:id/resolve`)
- Check-in payment actions (`PATCH /api/bookings/:id/payments`) — uses `settleBookingInvoiceAfterCheckin()` instead

**Audit findings (Feb 2026):** The reassign and resolve endpoints were both missing `syncBookingInvoice()` after `recalculateSessionFees()`, causing Stripe invoices to retain stale overage charges. Fixed by adding the sync call to both endpoints.

The `usedGuestPass` field on a booking participant record is an input to guest pass logic: when `used_guest_pass = TRUE`, `computeFeeBreakdown` treats that participant's guest fee as already waived and does not attempt to consume another guest pass.

## Key Invariants

1. **Staff = $0** — users with `role = 'staff'` or `role = 'admin'` always pay nothing, regardless of participant type.
2. **Tier-based daily allowance** — each membership tier defines `daily_sim_minutes` and `daily_conf_room_minutes` in the `membership_tiers` table. Overages are calculated against the allowance for the resource type being booked.
3. **Stripe products as price source** — on startup, `ensureSimulatorOverageProduct()`, `ensureGuestPassProduct()`, `ensureDayPassCoworkingProduct()`, and `ensureDayPassGolfSimProduct()` read Stripe prices and call `updateOverageRate()` / `updateGuestFee()` to set in-memory rates. All pass products are loaded dynamically from `membership_tiers` by slug (`guest-pass`, `day-pass-coworking`, `day-pass-golf-sim`) — no hardcoded Stripe IDs. The `ensure*Product()` functions create DB records and Stripe Products/Prices if missing, and sync canonical product names on startup.
4. **Cancelled bookings = $0** — statuses `cancelled`, `declined`, `cancellation_pending` short-circuit to zero.
5. **Effective player count ≥ 1** — prevents division by zero in per-participant minutes.
6. **Simulator vs conference room** — separate daily allowances and separate usage tracking per resource type.
7. **One invoice per booking** — each booking (simulator or conference room) has at most one Stripe invoice. Draft created at approval, updated on roster/fee changes, finalized at payment. Managed by `bookingInvoiceService.ts`. Conference rooms were migrated to the same invoice flow in v8.16.0 (2026-02-24).
8. **Fee calculation is post-commit only** — `recalculateSessionFees()` and `computeFeeBreakdown()` use the global `db` pool. They must NEVER run inside a `db.transaction()` block. See cascade behavior section above for the correct pattern.
9. **Account credit payments need audit trails** — when `createPrepaymentIntent` returns `paidInFull: true` (account credit covered the full fee), call `logPaymentAudit()` with `paymentMethod: 'account_credit'`. Without this, credit-based payments have no audit record. (v8.26.7, Bug 17)
10. **Cascade recalculation** — when a session's fees change (e.g., duration edit, roster change), all later same-day bookings for the same member must also be recalculated. `recalculateSessionFees()` handles this automatically unless `skipCascade: true` is passed.

## Social Member Booking Fees

Social members (`tier = 'social'`) can book golf simulators. Their fee treatment:
- **Daily allowance**: 0 minutes (`daily_sim_minutes = 0`), so the ENTIRE booking duration is treated as overage.
- **Overage**: Calculated at `$25.00` per 30-minute block. A 60-minute booking = 2 blocks = $50.00 before guest fees.
- **Guest passes**: 0 complimentary passes per month (`guest_passes_per_month = 0`), so every guest incurs the flat `$25.00` guest fee.
- **Owner absorbs time**: The host absorbs time from empty and guest slots, increasing their overage. A social member booking with a guest pays both the guest fee AND the overage for the guest's time.
- **Tier rules**: `enforceSocialTierRules()` in `server/core/bookingService/tierRules.ts` explicitly allows social members to have guests.

## Daily Allowance / Included Minutes

Each membership tier grants a number of included minutes per day per resource type:
- `daily_sim_minutes` — simulator bay minutes.
- `daily_conf_room_minutes` — conference room minutes.

Usage accumulates across all sessions in a day. The system tracks usage via:
- **Usage ledger** (`usage_ledger` table) for finalized sessions.
- **Booking requests** for preview mode (pending/approved bookings that haven't generated ledger entries yet).

Only bookings that start **earlier** than the current booking count toward prior usage, preventing the later booking from inflating the earlier one's overage.

## Guest Pass System

Members receive a monthly allocation of guest passes (`guest_passes_per_month` from their tier).

### Hold → Consume Flow

1. **Hold** — when a booking with guests is created, `createGuestPassHold()` reserves passes in `guest_pass_holds` (expires after 30 days). Available passes = `total - used - held`.
2. **Consume** — when the session is finalized, `consumeGuestPassForParticipant()` increments `passes_used` in `guest_passes`, sets `payment_status = 'waived'` and `used_guest_pass = TRUE` on the booking participant, logs a `legacy_purchases` record, and sends a notification.
3. **Release** — if a booking is cancelled, `releaseGuestPassHold()` deletes the hold rows, freeing the passes.
4. **Refund** — `refundGuestPassForParticipant()` decrements `passes_used`, restores the guest fee on the participant, and deletes the `legacy_purchases` record.

Placeholder guests (`/^Guest \d+$/i`) cannot consume guest passes; only named guests or guests with a `guest_id` can.

## Supporting Services

### Fee Calculator (`feeCalculator.ts`)

Provides `calculateAndCacheParticipantFees()` for session-level fee resolution:
- Read cached fees from `booking_participants.cached_fee_cents`.
- Fall back to `usage_ledger` overage + guest fee totals.
- Fall back to calculated guest fee from tier or `PRICING.GUEST_FEE_CENTS`.
- Cache results back to `booking_participants`.

Also provides `estimateBookingFees()` for quick estimates without database queries.

### Usage Calculator (`usageCalculator.ts`)

- `getDailyUsageFromLedger()` — sum `minutes_charged` from `usage_ledger` for a member on a date, optionally filtered by resource type.
- `calculateOverageFee()` — given total minutes and tier allowance, compute overage minutes and fee in 30-min blocks.
- `computeUsageAllocation()` — distribute session duration evenly across participants, with remainder going to index-0 or to owner.
- `calculateSessionBilling()` / `calculateFullSessionBilling()` — full session-level billing with per-participant breakdowns (used by routes and background jobs).
- `getGuestPassInfo()` — check remaining guest passes for a member.

### Pricing Config (`pricingConfig.ts`)

In-memory rate store with getters/setters. Default: $25 overage per 30-min block, $25 guest fee. Updated at startup from Stripe. Also holds corporate volume tiers and family discount percent.

### Card Expiry Checking (`cardExpiryChecker.ts`)

Monitoring service that runs periodically to detect payment cards expiring within 7 days. For each expiring card, sends email notifications to the member and WebSocket alerts to staff. Prevents failed payments by proactively notifying members to update their payment methods. Implements duplicate-prevention logic to avoid repeatedly notifying for the same card.

## Reference Files

- `references/fee-breakdown.md` — detailed `computeFeeBreakdown` flow, input parameters, line item rules, guest pass hold/consume logic, usage calculator specifics.
- `references/pricing-sources.md` — dynamic pricing from Stripe products, pricing config cache, rate determination, product catalog sync.

## Key Source Files

| File | Purpose |
|------|---------|
| `server/core/billing/unifiedFeeService.ts` | `computeFeeBreakdown()`, `applyFeeBreakdownToParticipants()`, `recalculateSessionFees()` |
| `server/core/billing/feeCalculator.ts` | `calculateAndCacheParticipantFees()`, `estimateBookingFees()` |
| `server/core/billing/pricingConfig.ts` | `PRICING` object, `updateOverageRate()`, `updateGuestFee()` |
| `server/core/billing/prepaymentService.ts` | `createPrepaymentIntent()` |
| `server/core/billing/guestPassConsumer.ts` | `consumeGuestPassForParticipant()`, `refundGuestPassForParticipant()` |
| `server/core/billing/guestPassHoldService.ts` | `getAvailableGuestPasses()`, `createGuestPassHold()`, `releaseGuestPassHold()`, `convertHoldToUsage()` — guest pass reservation mechanics |
| `server/core/billing/PaymentStatusService.ts` | `markPaymentSucceeded()`, `markPaymentRefunded()`, `markPaymentCancelled()` — atomic payment status updates across participants and snapshots |
| `server/core/billing/cardExpiryChecker.ts` | `checkExpiringCards()` — monitors for cards expiring within 7 days, sends member and staff notifications |
| `server/core/bookingService/usageCalculator.ts` | `getDailyUsageFromLedger()`, `calculateOverageFee()`, `computeUsageAllocation()` |
| `server/core/stripe/products.ts` | `ensureSimulatorOverageProduct()`, `ensureGuestPassProduct()`, tier sync |
| `shared/models/billing.ts` | `FeeBreakdown`, `FeeComputeParams`, `FeeLineItem` type definitions |
| `server/core/billing/bookingInvoiceService.ts` | `createDraftInvoiceForBooking()`, `syncBookingInvoice()`, `finalizeAndPayInvoice()`, `voidBookingInvoice()`, `isBookingInvoicePaid()` |

---
name: fee-calculation
description: Fee calculation system — computeFeeBreakdown, guest fees, overage fees, prepayment, dynamic pricing, billing, and the unified fee service that produces per-participant line items for simulator and conference room bookings. Use when modifying fee computation, overage logic, guest fee rules, prepayment flow, invoice sync, daily allowance, pricing config, or any code that calls computeFeeBreakdown or recalculateSessionFees.
---

# Fee Calculation System

Central entry point: `computeFeeBreakdown()` in `server/core/billing/unifiedFeeService.ts`.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Fee computation | `server/core/billing/unifiedFeeService.ts` | `computeFeeBreakdown()`, line item rules |
| Fee recalculation | `server/core/billing/unifiedFeeService.ts` | `recalculateSessionFees()` |
| Fee caching | `server/core/billing/feeCalculator.ts` | `calculateAndCacheParticipantFees()` |
| Usage calculation | `server/core/bookingService/usageCalculator.ts` | Daily usage, overage, allocation |
| Pricing config | `server/core/billing/pricingConfig.ts` | In-memory rate store |
| Prepayment | `server/core/billing/prepaymentService.ts` | Payment intent creation |
| Invoice lifecycle | `server/core/billing/bookingInvoiceService.ts` | Draft, sync, finalize, void |
| Guest pass consumer | `server/core/billing/guestPassConsumer.ts` | Pass consumption/refund |
| Card expiry checker | `server/core/billing/cardExpiryChecker.ts` | Expiring card notifications |
| Payment intent cleanup | `server/core/billing/paymentIntentCleanup.ts` | `cancelPendingPaymentIntentsForBooking()` — cancels Stripe PIs and all fee snapshots (including NULL-PI orphans). `booking_fee_snapshots` has `updated_at` column (added v8.87.93). All status updates MUST set `updated_at = NOW()`. |
| Payment status service | `server/core/billing/PaymentStatusService.ts` | Payment status tracking and transitions |
| Billing types | `shared/models/billing.ts` | `FeeComputeParams`, `FeeBreakdown` |

## Decision Trees

### Fee Order of Operations (CRITICAL)

```
1. Status check: cancelled/declined/cancellation_pending? → $0, STOP
2. Staff check: role = staff/admin/golf_instructor? → $0, STOP
3. Active membership check: status IN (active, trialing, past_due)? 
   ├── No → Treat as guest (guest fee to HOST)
   └── Yes → Continue
4. Tier lookup: getTierLimits()
5. Unlimited check: daily_sim_minutes >= 999 or unlimited_access? → $0
6. Social tier: ALL minutes are overage (0 daily allowance)
7. Daily usage: usedToday + allocated - dailyAllowance = overage
8. Round up to 30-min blocks × rate
```

### When to call `syncBookingInvoice()`

```
After calling recalculateSessionFees()?
├── Booking has stripe_invoice_id? → MUST call syncBookingInvoice()
├── Fees went from $0 to >$0? → syncBookingInvoice() creates draft on-the-fly
└── Invoice is paid/open/void? → syncBookingInvoice() skips (logs warning)
```

### Simulator vs Conference Room

| Aspect | Simulator | Conference Room |
|---|---|---|
| Minutes per participant | `floor(duration / playerCount)` | Full duration |
| Guest fees | Charged per guest | Not charged |
| Member overage | Each member's own allowance | Only owner's |
| Daily allowance field | `daily_sim_minutes` | `daily_conf_room_minutes` |
| Owner absorbs guest/empty time | Yes | No |

## Hard Rules

1. **Fee calc is POST-COMMIT only.** `recalculateSessionFees()` and `computeFeeBreakdown()` use the global `db` pool. NEVER call inside `db.transaction()`. Causes $0 fees or deadlock.
2. **Staff = $0.** `role = 'staff'` or `'admin'` always pays nothing.
3. **Cancelled = $0.** Statuses `cancelled`, `declined`, `cancellation_pending` short-circuit to zero.
4. **Effective player count ≥ 1.** Prevents division by zero.
5. **Empty slot = guest fee (v8.85.0).** Each unfilled declared slot incurs `GUEST_FEE_CENTS` and its minutes absorb into owner's allocation.
6. **Chronological ordering.** Only bookings starting EARLIER count toward daily usage. Same start time → lower booking ID first.
7. **Owner absorbs non-member time.** Guest + empty slot minutes add to owner's allocated minutes, then owner's overage recalculates.
8. **Cascade recalculation.** After a session's fees change, all later same-day bookings for the same member auto-recalculate (up to 10, `skipCascade: true` prevents loops).
9. **Prices from Stripe.** Dollar amounts loaded at startup from Stripe products. NEVER hardcode fee amounts.
10. **One invoice per booking.** Draft at approval → sync on roster changes → finalize at payment → void on cancel. Invoices are created with `payment_settings.payment_method_types: ['card', 'link']` to enable wallet payments (Apple Pay, Google Pay, Stripe Link).
11. **Already-paid guard (v8.68.0).** Fee recalculation skips participants with `cached_fee_cents > 0` and a completed payment intent.
12. **Account credit audit trail.** When `createPrepaymentIntent` returns `paidInFull: true`, call `logPaymentAudit()` with `paymentMethod: 'account_credit'`.
13. **Outstanding balance queries MUST include 3 filters:** 90-day lookback, exclude cancelled bookings, exclude paid snapshots.
14. **Conference room zero-fee bookings skip invoice finalization (v8.87.7).** When `totalCents === 0` (within daily allowance), `syncBookingInvoice()` creates no invoice. All downstream code must check `getBookingInvoiceId()` before calling `finalizeAndPayInvoice()` — if null, skip finalization. This applies to member bookings (`bookings.ts`), staff bookings (`staff-conference-booking.ts`), and booking approvals (`approvalService.ts`).

## Anti-Patterns (NEVER)

1. NEVER call `recalculateSessionFees()` or `computeFeeBreakdown()` inside a `db.transaction()`.
2. NEVER skip step 1 (status check) or step 3 (active membership check) in the fee order of operations.
3. NEVER hardcode dollar amounts — always source from Stripe product prices.
4. NEVER skip `syncBookingInvoice()` after fee recalculation when a Stripe invoice exists.
5. NEVER skip the cascade recalculation — changing one booking's fees affects later same-day bookings.
6. NEVER call `recalculateSessionFees()` without calling `invalidateCachedFees()` on all session participants first — stale cached fees cause the already-paid guard (rule 11) to skip participants, producing incorrect totals. All roster mutation paths (member-side `rosterService.ts` and staff-side `admin-roster.ts`) must invalidate before recalculating.
7. NEVER auto-waive member fees during Trackman import — only ghost/placeholder participants (`user_id IS NULL AND guest_id IS NULL`) get `'waived'`. Real members and named guests must be `'pending'` so fees are properly computed (v8.87.52).

## Fee Computation Sources

`FeeComputeParams.source` in `shared/models/billing.ts` identifies the caller context. Valid values:
- `'booking_creation'`, `'booking_approval'`, `'roster_change'`, `'check_in'`, `'admin_override'`, `'cascade'`, `'system_recalc'`, `'trackman_import'`

The `'trackman_import'` source (v8.87.52) is used for fee recalculations triggered by Trackman CSV import paths in `server/core/trackman/service.ts`.

## Cross-References

- **Booking lifecycle (triggers fee calc)** → `booking-flow` skill
- **Check-in billing flow** → `checkin-flow` skill
- **Guest pass consumption** → `guest-pass-system` skill
- **Stripe webhook invoice events** → `stripe-webhook-flow` skill
- **Transaction isolation rule** → `project-architecture` skill (Convention 8a)

## Detailed Reference

- **[references/fee-breakdown.md](references/fee-breakdown.md)** — Detailed `computeFeeBreakdown` flow, input params, line item rules, guest pass hold/consume, usage calculator specifics.
- **[references/pricing-sources.md](references/pricing-sources.md)** — Dynamic pricing from Stripe products, pricing config cache, rate determination, product catalog sync.

---

## Social Member Fees

Social tier (`tier = 'social'`):
- **Daily allowance**: 0 minutes → entire duration is overage
- **Overage**: $25/30-min block (60 min = $50)
- **Guest passes**: 0/month → every guest pays $25 flat fee
- **Owner absorbs**: Host pays overage for guest time too
- `enforceSocialTierRules()` always returns `{ allowed: true }` — restriction is economic, not a block

## Guest Fee Exemptions (evaluation order)

1. Conference room bookings → no guest fees
2. Staff/admin/golf_instructor in guest slot → $0 ("Pro in the Slot")
3. Guest with `userId` (actually a member) → $0
4. Named guest with available pass + `hasGuestPassBenefit` → waived, `guestPassUsed = true`
5. All other guests → `GUEST_FEE_CENTS`

Placeholder guests (`/^Guest \d+$/i`, `/^Guest\s*\(.*pending.*\)$/i`) cannot consume guest passes but still incur the flat fee.

## Fee Caching

Two cache levels:
1. `booking_participants.cached_fee_cents` — per-participant. Set by `applyFeeBreakdownToParticipants()`. Cleared by `invalidateCachedFees()`.
2. `booking_requests.overage_fee_cents` / `overage_minutes` — session-level totals (legacy, scheduled for removal).

Resolution order: cached → ledger → calculated.

## Callers That MUST Also Call `syncBookingInvoice()`

- Booking approval (`approval.ts`)
- Roster changes: add/remove participant, update player count (`roster.ts`)
- Staff direct-add during check-in (`staffCheckin.ts`)
- Trackman admin reassign/link/resolve (`trackman/admin.ts`)
- Check-in payments use `settleBookingInvoiceAfterCheckin()` instead

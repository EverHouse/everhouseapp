---
name: checkin-flow
description: Staff check-in flow for the Ever Club Members App. Covers check-in, check in, staff check-in, billing verification, prepayment enforcement, QR scan, member check-in, guest pass consumption, fee recalculation, and session creation during the check-in process.
---

# Staff Check-In Flow

## Overview

The staff check-in flow is how front-desk staff verify billing, settle prepayments, and mark members as checked in for their bookings. There are two distinct paths:

1. **Booking check-in** — Staff opens a scheduled booking, reviews per-participant fees, settles outstanding balances (confirm cash, charge card, waive, or consume guest pass), then marks the booking as `checked_in`.
2. **QR walk-in check-in** — Staff scans a member's QR code. The system records a walk-in visit (`walk_in_visits` table), increments `lifetime_visits`, syncs to HubSpot, and sends a first-visit email for trialing members on their first visit. No booking or billing is involved.

## Check-In Flow (Booking Path)

```
Staff selects booking in Command Center
       │
       ▼
GET /api/bookings/:id/staff-checkin-context
  ├─ Ensure a billing session exists (ensureSessionForBooking)
  ├─ Sync-clean orphaned participants
  ├─ Compute fee breakdown (computeFeeBreakdown, source: 'checkin')
  ├─ Check for prepaid snapshots (booking_fee_snapshots)
  ├─ Return CheckinContext with participants, fees, audit history
       │
       ▼
Staff reviews CheckinBillingModal
  ├─ Per-participant fee cards (overage + guest fee)
  ├─ Payment actions: confirm, waive, use_guest_pass, confirm_all, waive_all
  ├─ Optional: charge saved card, Stripe terminal, or online payment
       │
       ▼
PATCH /api/bookings/:id/payments
  ├─ Recalculate fees before action (recalculateSessionFees)
  ├─ Update participant payment_status
  ├─ Consume guest pass if applicable
  ├─ Write booking_payment_audit row
  ├─ Send notifications (fee waived email, member notification)
       │
       ▼
Invoice Settlement (automatic, non-blocking)
  ├─ settleBookingInvoiceAfterCheckin(bookingId, sessionId)
  ├─ Conference rooms excluded (different prepayment flow)
  ├─ If NOT all participants settled (some still pending) → sync invoice line items
  ├─ If all settled AND any paid with fees > $0 → finalize invoice as paid OOB
  ├─ If all settled AND all waived (no paid fees) → void the invoice
       │
       ▼
PUT /api/bookings/:id/checkin (server/routes/bays/approval.ts)
  ├─ Verify no unpaid participants with outstanding fees
  ├─ Set booking status to targetStatus ('attended' or 'no_show', defaults to 'attended')
  ├─ Publish booking_checked_in event
  ├─ Notify member via WebSocket + notification
```

## Check-In Flow (QR Walk-In Path)

```
Staff opens QR scanner in Command Center
       │
       ▼
QrScannerModal scans member QR code
  ├─ Uses html5-qrcode library
  ├─ Extracts member ID from QR data
       │
       ▼
POST /api/staff/qr-checkin { memberId }
  ├─ Look up member by ID
  ├─ Deduplicate (reject if checked in within 2 minutes)
  ├─ Increment lifetime_visits on users table
  ├─ Sync visit count to HubSpot (async, non-blocking)
  ├─ Broadcast stats update via WebSocket
  ├─ Insert walk_in_visits row
  ├─ Send first-visit email if trialing + visit #1
  ├─ Return pinned notes for staff display
       │
       ▼
CheckInConfirmationModal shows result
  ├─ Member name, tier, lifetime visits
  ├─ Pinned notes (staff alerts)
  ├─ Membership status warnings
```

## Key Invariants

1. **Fees recalculate at check-in time.** When the checkin context is loaded, `computeFeeBreakdown` runs with `source: 'checkin'`. Before any payment action, `recalculateSessionFees` persists updated fees to `cached_fee_cents` on each participant.

2. **Prepayment must be settled before check-in.** `POST /api/bookings/:id/checkin` queries for participants with `payment_status NOT IN ('paid', 'waived')` and outstanding fees > 0. If any exist, it returns HTTP 402 with `OUTSTANDING_BALANCE`.

3. **Guest passes consume atomically.** `consumeGuestPassForParticipant` runs in a database transaction: it checks availability, increments `passes_used` on `guest_passes`, sets participant `payment_status = 'waived'` and `used_guest_pass = TRUE`, creates a `legacy_purchases` record, sends a notification, and cleans up any guest pass holds.

4. **Session must exist for billing.** If a booking lacks a `session_id`, the checkin context endpoint calls `ensureSessionForBooking` to create one. This also creates the owner participant and guest placeholder participants based on `declared_player_count`.

5. **Fee uses the lower of cached vs. calculated.** The checkin context compares `cached_fee_cents` (set at booking time) with the freshly computed fee and uses the minimum. This protects members from mid-day price increases while honoring tier upgrades that reduce fees.

6. **Every payment action is audited.** All confirm, waive, guest pass, and bulk actions insert rows into `booking_payment_audit` with the staff email, previous status, new status, and reason.

7. **Cancelled/declined bookings always have $0 fees.** `computeFeeBreakdown` checks the booking status and returns zero totals for cancelled, declined, or cancellation_pending bookings.

8. **Invoice settlement at check-in.** After each payment action (confirm, waive, guest pass, bulk confirm/waive), `settleBookingInvoiceAfterCheckin()` runs as a non-blocking background task. It first checks if all participants are settled (paid or waived). If NOT all settled yet, it syncs the invoice line items to reflect the current state. Once all participants are settled: if any participant has `payment_status = 'paid'` with `cached_fee_cents > 0`, the draft invoice is finalized as "paid out of band" via `finalizeInvoicePaidOutOfBand()`; if all are waived (no paid fees), the invoice is voided. Conference rooms are excluded. **Settlement failures are logged as ERROR level** (added v8.6.0) — if invoice finalization fails, the error is captured for manual staff review rather than silently swallowed.

9. **Cash payment route.** `POST /api/stripe/staff/mark-booking-paid` allows staff to mark a booking as paid via cash. This sets all pending participants to `payment_status = 'paid'` and triggers invoice settlement.

10. **Auto check-in for past bookings.** Approved/confirmed bookings that are not checked in within 24 hours after their end time are automatically marked as `attended` (auto checked-in) by the auto-complete scheduler (`bookingAutoCompleteScheduler.ts`, runs every 2h). This assumes most members attended and avoids noisy false no-show notifications. Staff can manually correct to `no_show` via the BookingStatusDropdown if needed. The scheduler uses Pacific timezone and excludes relocating bookings.

## Billing Verification at Check-In

The unified fee service (`computeFeeBreakdown`) calculates fees per participant:

- **Owner/Member overage**: Look up member tier → get daily allowance (`daily_sim_minutes`) → subtract prior usage for the day → if session minutes exceed remaining allowance, charge overage at `PRICING.OVERAGE_RATE_PER_30_MIN`.
- **Guest fees**: Each guest participant incurs `PRICING.GUEST_FEE_CENTS` unless covered by a guest pass.
- **Staff/admin**: Staff and admin roles always get $0 fees regardless of usage.
- **Conference rooms**: Use full duration (no per-player splitting). Separate daily allowance tracked independently from simulator usage.

Fee computation uses chronological ordering: only usage from bookings that start *earlier* than the current booking counts toward the daily allowance. This prevents a later booking's usage from making an earlier booking appear to have overage.

## Guest Pass Consumption

Guest passes are per-member monthly allocations defined by tier (`guest_passes_per_month` on `membership_tiers`). During check-in:

1. `canUseGuestPass(ownerEmail)` checks remaining passes.
2. If available, `consumeGuestPassForParticipant` runs in a transaction:
   - Rejects placeholder guests (e.g., "Guest 2") — a real guest name is required.
   - Checks idempotency (already consumed → return success).
   - Increments `passes_used` on `guest_passes` table.
   - Sets participant `cached_fee_cents = 0`, `payment_status = 'waived'`, `used_guest_pass = TRUE`.
   - Zeros out `guest_fee` on the owner's `usage_ledger` entry.
   - Creates a `legacy_purchases` record for accounting.
   - Sends an in-app notification with remaining pass count.
   - Cleans up any `guest_pass_holds` for this booking.

## Staff Direct-Add During Check-In

Staff can add participants directly via `POST /api/bookings/:id/staff-direct-add`:

- For guests: validates tier rules (Social tier guest limits), creates participant with `PRICING.GUEST_FEE_CENTS`, triggers fee recalculation and prepayment intent creation.
- For members: validates tier booking permissions (with optional override reason), checks for duplicate roster entries, converts matching guest entries to member participants.
- Both paths recalculate session fees and attempt to create a prepayment intent if fees are outstanding.

## Payment Methods at Check-In

The CheckinBillingModal supports multiple payment methods:

- **Confirm (cash/external)**: Mark participant as `paid` without processing a charge.
- **Charge saved card**: Call `/api/stripe/staff/check-saved-card/:email` to find a card on file, then charge via `chargeCardOnFile`.
- **Stripe terminal (WisePOS E)**: Process payment through physical terminal hardware.
- **Online Stripe payment**: Show `StripePaymentForm` for card entry.
- **Waive with reason**: Mark as `waived`, require a text reason, send fee-waived email.
- **Use guest pass**: Consume from owner's monthly allocation.
- **Mark as paid (cash)**: Staff calls `POST /api/stripe/staff/mark-booking-paid` to mark all pending fees as paid via cash, triggering invoice finalization as paid out-of-band.

## Overdue Payments

`GET /api/bookings/overdue-payments` returns bookings from the last 30 days with pending fees or unreviewed waivers. Staff can bulk-review stale waivers (>12 hours old) via `POST /api/bookings/bulk-review-all-waivers`.

## Waiver Review

Guest fee waivers that are not backed by a guest pass require staff review. The `waiverNeedsReview` flag is set when `participant_type = 'guest'`, `payment_status = 'waived'`, `used_guest_pass = false`, and `waiver_reviewed_at IS NULL`. Staff marks them reviewed via:

- `POST /api/booking-participants/:id/mark-waiver-reviewed` (single)
- `POST /api/bookings/:bookingId/mark-all-waivers-reviewed` (per booking)
- `POST /api/bookings/bulk-review-all-waivers` (global, stale >12h)

## Authorization

All check-in endpoints require `isStaffOrAdmin` middleware. The booking check-in (`/api/bookings/:id/checkin`) and QR check-in (`/api/staff/qr-checkin`) are staff-only operations.

Booking authorization for members is handled separately by `isAuthorizedForMemberBooking` in `server/core/bookingAuth.ts`, which checks the tier's `can_book_simulators` permission.

## Key Files

| Area | File |
|------|------|
| Check-in API routes | `server/routes/staffCheckin.ts` |
| Booking check-in endpoint | `server/routes/bays/approval.ts` (PUT /api/bookings/:id/checkin) |
| Fee computation | `server/core/billing/unifiedFeeService.ts` |
| Prepayment service | `server/core/billing/prepaymentService.ts` |
| Guest pass consumer | `server/core/billing/guestPassConsumer.ts` |
| Session manager | `server/core/bookingService/sessionManager.ts` |
| Booking auth | `server/core/bookingAuth.ts` |
| Pricing config | `server/core/billing/pricingConfig.ts` |
| Audit logger | `server/core/auditLog.ts` |
| Checkin billing modal (FE) | `src/components/staff-command-center/modals/CheckinBillingModal.tsx` |
| Unified booking sheet (FE) | `src/components/staff-command-center/modals/UnifiedBookingSheet.tsx` |
| Booking logic hook (FE) | `src/components/staff-command-center/modals/useUnifiedBookingLogic.ts` |
| QR scanner modal (FE) | `src/components/staff-command-center/modals/QrScannerModal.tsx` |
| Booking invoice service | `server/core/billing/bookingInvoiceService.ts` |
| Booking actions hook (FE) | `src/hooks/useBookingActions.ts` |
| Staff Command Center (FE) | `src/components/staff-command-center/StaffCommandCenter.tsx` |

## Reference Files

- `references/backend-flow.md` — Detailed API call flow, fee recalculation, prepayment enforcement, guest pass logic, audit logging, edge cases.
- `references/frontend-touchpoints.md` — Unified Booking Sheet check-in mode, QR scanner flow, Command Center triggers, UI states.

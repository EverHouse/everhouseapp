---
name: checkin-flow
description: Staff check-in flow for the Ever Club Members App. Covers check-in, check in, staff check-in, billing verification, prepayment enforcement, QR scan, member check-in, guest pass consumption, fee recalculation, and session creation during the check-in process.
---

# Staff Check-In Flow

## Overview

The staff check-in flow is how front-desk staff verify billing, settle prepayments, and mark members as checked in for their bookings. There are two distinct paths:

1. **Booking check-in** — Staff opens a scheduled booking, reviews per-participant fees, settles outstanding balances (confirm cash, charge card, waive, or consume guest pass), then marks the booking as `attended` (or `no_show` via the BookingStatusDropdown). All check-in flows use `PUT /api/bookings/:id/checkin` → `approvalService.checkinBooking()`.
2. **QR/NFC walk-in check-in** — Staff scans a member's QR code or NFC tag. The system records a walk-in visit (`walk_in_visits` table with `source: 'qr' | 'nfc'` and `checked_in_by`/`checked_in_by_name`), increments `lifetime_visits` on the `users` table, syncs the updated count to HubSpot via `updateHubSpotContactVisitCount()`, sends a "Check-In Complete" push notification to the member, broadcasts `walkin_checkin` event to staff and `member-stats-updated` event to the member's client, and sends a first-visit email for trialing members on their first visit. No booking or billing is involved. The member dashboard shows a unified lifetime visit count (bookings attended + wellness enrollments + event RSVPs + walk-in visits) calculated via a `UNION ALL` SQL query. The member history page displays walk-ins with an emerald "Walk-in" badge, `qr_code_scanner` icon, and "Checked in by [Staff Name]" attribution.

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
  ├─ Handles both simulator and conference room bookings (unified since v8.16.0)
  ├─ If NOT all participants settled (some still pending) → sync invoice line items
  ├─ If all settled AND any paid with fees > $0 → finalize invoice as paid OOB
  ├─ If all settled AND all waived (no paid fees) → void the invoice
       │
       ▼
PUT /api/bookings/:id/checkin (server/routes/bays/approval.ts)
  ├─ Verify no unpaid participants with outstanding fees
  ├─ Set booking status to targetStatus ('attended' or 'no_show', defaults to 'attended')
  ├─ Publish booking_checked_in event (event name kept for backward compat; status is 'attended' or 'no_show')
  ├─ Notify member via WebSocket + notification
```

## Check-In Flow (QR Path — Smart Booking Detection, v8.36.0)

```
Staff opens QR scanner (FAB → QR Scanner, positioned near "New User")
       │
       ▼
QrScannerModal scans member QR code (MEMBER:<uuid>)
  ├─ Uses html5-qrcode library
  ├─ Extracts member ID from QR data
       │
       ▼
Smart Booking Detection
  ├─ Auto-checks for today's scheduled bookings for the scanned member
  ├─ If booking found → routes to booking check-in path (with billing via Unified Booking Sheet)
  ├─ If no booking found → routes to walk-in check-in path
  ├─ QR booking context is preserved when redirecting to payment or roster screens
       │
       ▼
Walk-In Path: POST /api/staff/qr-checkin { memberId }
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
  ├─ Booking details (bay, time, resource type) if booking check-in
  ├─ Pinned notes (staff alerts)
  ├─ Membership status warnings
  ├─ Members receive immediate feedback after check-in
```

## Key Invariants

1. **Fees recalculate at check-in time.** When the checkin context is loaded, `computeFeeBreakdown` runs with `source: 'checkin'`. Before any payment action, `recalculateSessionFees` persists updated fees to `cached_fee_cents` on each participant.

2. **Prepayment must be settled before check-in.** `PUT /api/bookings/:id/checkin` queries for participants with `payment_status NOT IN ('paid', 'waived')` and outstanding fees > 0. If any exist, it returns HTTP 402 with `OUTSTANDING_BALANCE`.

3. **Guest passes consume atomically.** `consumeGuestPassForParticipant` runs in a database transaction: it checks availability, increments `passes_used` on `guest_passes`, sets participant `payment_status = 'waived'` and `used_guest_pass = TRUE`, creates a `legacy_purchases` record, sends a notification, and cleans up any guest pass holds.

4. **Session must exist for billing.** If a booking lacks a `session_id`, the checkin context endpoint calls `ensureSessionForBooking` to create one. This also creates the owner participant and guest placeholder participants based on `declared_player_count`.

5. **Fee uses the lower of cached vs. calculated.** The checkin context compares `cached_fee_cents` (set at booking time) with the freshly computed fee and uses the minimum. This protects members from mid-day price increases while honoring tier upgrades that reduce fees.

6. **Every payment action is audited.** All confirm, waive, guest pass, and bulk actions insert rows into `booking_payment_audit` with the staff email, previous status, new status, and reason.

7. **Cancelled/declined bookings always have $0 fees.** `computeFeeBreakdown` checks the booking status and returns zero totals for cancelled, declined, or cancellation_pending bookings.

8. **Invoice settlement at check-in.** After each payment action (confirm, waive, guest pass, bulk confirm/waive), `settleBookingInvoiceAfterCheckin()` runs as a non-blocking background task. It first checks if all participants are settled (paid or waived). If NOT all settled yet, it syncs the invoice line items to reflect the current state. Once all participants are settled: if any participant has `payment_status = 'paid'` with `cached_fee_cents > 0`, the draft invoice is finalized as "paid out of band" via `finalizeInvoicePaidOutOfBand()`; if all are waived (no paid fees), the invoice is voided. Both simulator and conference room bookings are settled (unified since v8.16.0). Old `conference_prepayments` records are grandfathered. **Settlement failures are logged as ERROR level** (added v8.6.0) — if invoice finalization fails, the error is captured for manual staff review rather than silently swallowed.

9. **Cash payment route.** `POST /api/stripe/staff/mark-booking-paid` allows staff to mark a booking as paid via cash. This sets all pending participants to `payment_status = 'paid'` and triggers invoice settlement.

10. **Auto check-in for past bookings.** Approved/confirmed bookings that are not checked in within 24 hours after their end time are automatically marked as `attended` (auto checked-in) by the auto-complete scheduler (`bookingAutoCompleteScheduler.ts`, runs every 2h). This assumes most members attended and avoids noisy false no-show notifications. Staff can manually correct to `no_show` via the BookingStatusDropdown if needed. The scheduler uses Pacific timezone.

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

## UI: BookingStatusDropdown Portal Rendering

The `BookingStatusDropdown` component (`src/components/BookingStatusDropdown.tsx`) renders its dropdown menu via `createPortal(…, document.body)` to escape CSS stacking contexts. The Command Center booking cards use `backdrop-filter` (glassmorphic styling), which creates new stacking contexts that trap `position: fixed` elements — even with `z-index: 9999`, the menu would render behind sibling cards and the calendar grid.

**Key implementation details:**
- The dropdown menu and backdrop overlay are portaled to `document.body`.
- `getBoundingClientRect()` positions the menu relative to the trigger button at open time.
- The backdrop uses `style={{ zIndex: 9998 }}` and the menu uses `style` with `zIndex: 9999`.
- `menuDirection` prop controls whether the menu opens upward or downward.
- **Scroll dismiss:** On open, the component walks up the DOM tree to find all scrollable ancestors. It attaches passive `scroll` listeners to each ancestor and `window`. Any scroll event immediately closes the dropdown. This prevents the menu from detaching from the button when the booking queue is scrolled.

**Rule:** Any dropdown or popover rendered inside a container with `backdrop-filter`, `transform`, `filter`, `perspective`, or `will-change` MUST use a React portal to `document.body`. These CSS properties create new stacking contexts that prevent fixed-position children from layering above sibling elements.

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

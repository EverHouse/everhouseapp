---
name: checkin-flow
description: Staff check-in flow for the Ever Club Members App. Covers check-in, check in, staff check-in, billing verification, prepayment enforcement, QR scan, member check-in, guest pass consumption, fee recalculation, and session creation during the check-in process. Use when modifying check-in endpoints, billing modals, QR scanner, walk-in visits, payment actions, waiver review, or the BookingStatusDropdown component.
---

# Staff Check-In Flow

Two distinct paths: **Booking check-in** (billing + status change) and **QR/NFC walk-in** (visit tracking only).

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Check-in API routes | `server/routes/staffCheckin/` (index.ts + sub-modules: context.ts, billing.ts, directAdd.ts, shared.ts) | Check-in context, payment actions, staff direct-add |
| Booking check-in endpoint | `server/routes/bays/approval.ts` | `PUT /api/bookings/:id/checkin` |
| Fee computation | `server/core/billing/unifiedFeeService.ts` | `computeFeeBreakdown()` |
| Prepayment service | `server/core/billing/prepaymentService.ts` | Prepayment intent creation |
| Guest pass consumer | `server/core/billing/guestPassConsumer.ts` | Pass consumption at check-in |
| Session manager | `server/core/bookingService/sessionManager.ts` | `ensureSessionForBooking()` |
| Invoice settlement | `server/core/billing/bookingInvoiceService.ts` | `settleBookingInvoiceAfterCheckin()` |
| Pricing config | `server/core/billing/pricingConfig.ts` | Rate lookups |
| Checkin billing modal | `src/components/staff-command-center/modals/CheckinBillingModal.tsx` | UI |
| Unified booking sheet | `src/components/staff-command-center/modals/UnifiedBookingSheet.tsx` | Roster + billing UI |
| QR scanner modal | `src/components/staff-command-center/modals/QrScannerModal.tsx` | QR/NFC scan UI |
| Booking status dropdown | `src/components/BookingStatusDropdown.tsx` | Status toggle UI |
| Booking actions hook | `src/hooks/useBookingActions.ts` | Frontend API calls |

## Decision Trees

### Booking check-in flow

```
Staff selects booking
  → GET /api/bookings/:id/staff-checkin-context
    ├── Ensure session exists (ensureSessionForBooking)
    ├── Compute fees (computeFeeBreakdown, source: 'checkin')
    └── Return CheckinContext
  → Staff reviews CheckinBillingModal
    ├── Per-participant payment actions: confirm, waive, use_guest_pass, charge card
    └── PATCH /api/bookings/:id/payments
        ├── Recalculate fees before action
        ├── Update participant payment_status
        └── settleBookingInvoiceAfterCheckin() (non-blocking)
  → PUT /api/bookings/:id/checkin
    ├── Verify no unpaid participants with outstanding fees
    └── Set status to 'attended' or 'no_show'
```

### QR scan — booking or walk-in?

```
Staff scans QR code (MEMBER:<uuid>)
  → Auto-check for today's scheduled bookings
    ├── Booking found → Route to booking check-in (with billing)
    └── No booking → Walk-in path
        POST /api/staff/qr-checkin
        ├── Deduplicate (reject if checked in within 2 min)
        ├── Increment lifetime_visits
        ├── Sync to HubSpot (async)
        ├── Send first-visit email if trialing + visit #1
        └── Return pinned notes for staff display
```

## Hard Rules

1. **Fees recalculate at check-in time.** `computeFeeBreakdown` runs with `source: 'checkin'`. Before any payment action, `recalculateSessionFees` persists updated fees.
2. **Prepayment must be settled before check-in.** Returns HTTP 402 with `OUTSTANDING_BALANCE` if any unpaid participants with fees > 0.
3. **Guest passes consume atomically.** Transaction: check availability → increment `passes_used` → set `payment_status = 'waived'` + `used_guest_pass = TRUE` → create `legacy_purchases` → delete holds.
4. **Session must exist for billing.** If booking lacks `session_id`, checkin context calls `ensureSessionForBooking`.
5. **Fee uses the lower of cached vs. calculated.** Protects members from mid-day price increases while honoring tier upgrades.
6. **Every payment action is audited.** All actions insert into `booking_payment_audit` with staff email, previous/new status, reason.
7. **Cancelled/declined bookings = $0 fees.** `computeFeeBreakdown` short-circuits to zero for terminal statuses.
8. **Invoice settlement is non-blocking.** `settleBookingInvoiceAfterCheckin()` runs as background task. If all settled + any paid → finalize. If all waived → void. Failures logged as ERROR.
9. **Cash payment route.** `POST /api/stripe/staff/mark-booking-paid` marks all pending as `paid` and triggers settlement.
10. **Auto check-in runs every 1 hr.** Marks approved/confirmed as `attended` 30 min after end time (same-day) or next day (overnight). Fee guard blocks if unpaid fees.
11. **Placeholder guests cannot consume guest passes.** `/^Guest \d+$/i` pattern rejected — real name required.
12. **BookingStatusDropdown uses portal rendering.** Portaled to `document.body` to escape `backdrop-filter` stacking contexts. Any dropdown inside a container with `backdrop-filter`/`transform`/`filter` MUST use a portal.

## Anti-Patterns (NEVER)

1. NEVER allow check-in with unpaid fees — always enforce prepayment settlement.
2. NEVER consume guest passes for placeholder guests ("Guest 1", "Guest 2").
3. NEVER call fee calculation inside a transaction. Fee computation (`computeFeeBreakdown`) and snapshot insert run outside `db.transaction()` using plain `db.execute()` (v8.87.28).
4. NEVER create inline check-in buttons without the BookingStatusDropdown component.
5. NEVER insert directly into `notifications` table — use `notifyMember()` or `notifyAllStaff()` from `server/core/notificationService.ts`.

## Cross-References

- **Fee calculation internals** → `fee-calculation` skill
- **Guest pass lifecycle** → `guest-pass-system` skill
- **Booking lifecycle** → `booking-flow` skill
- **Unified Booking Sheet** → `project-architecture` skill

## Detailed Reference

- **[references/backend-flow.md](references/backend-flow.md)** — API call flow, fee recalculation, prepayment enforcement, guest pass logic, audit logging, edge cases.
- **[references/frontend-touchpoints.md](references/frontend-touchpoints.md)** — Unified Booking Sheet check-in mode, QR scanner flow, Command Center triggers, UI states.

---

## Payment Methods at Check-In

| Method | How |
|---|---|
| Confirm (cash/external) | Mark `paid` without charge |
| Charge saved card (staff) | `/api/stripe/staff/charge-saved-card` in `booking-fees.ts` → charges member's default payment method |
| Stripe terminal (WisePOS E) | Physical terminal hardware |
| Online Stripe payment | `StripePaymentForm` for card entry |
| Waive with reason | Mark `waived`, require text reason, send email |
| Use guest pass | Consume from owner's monthly allocation |
| Mark as paid (cash) | `POST /api/stripe/staff/mark-booking-paid` |

## Waiver Review

Guest fee waivers not backed by guest passes require staff review. `waiverNeedsReview` flag set when `participant_type = 'guest'`, `payment_status = 'waived'`, `used_guest_pass = false`, `waiver_reviewed_at IS NULL`.

Review endpoints:
- `POST /api/booking-participants/:id/mark-waiver-reviewed` (single)
- `POST /api/bookings/:bookingId/mark-all-waivers-reviewed` (per booking)
- `POST /api/bookings/bulk-review-all-waivers` (global, stale >12h)

## Overdue Payments

`GET /api/bookings/overdue-payments` returns bookings from last 30 days with pending fees. Staff can bulk-review stale waivers (>12h old).

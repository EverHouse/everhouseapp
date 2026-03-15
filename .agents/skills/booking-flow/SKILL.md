---
name: booking-flow
description: End-to-end booking lifecycle in the Ever Club Members App — booking request creation, booking flow, booking lifecycle, session creation, conflict detection, bay assignment, approval flow, auto-approve, Trackman sync, Trackman booking modifications, booking request statuses, guest pass holds, usage tracking, member cancel, staff approval, prepayment, calendar sync, and reconciliation. Use when modifying booking creation, approval, cancellation, status transitions, conflict detection, session linking, or the booking event system.
---

# Booking Flow

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Member booking creation | `server/routes/bays/bookings.ts` | Adding/changing booking request creation |
| Booking creation guard | `server/core/bookingService/bookingCreationGuard.ts` | Advisory locks (`acquireBookingLocks`) and overlap checks (`checkResourceOverlap`) for booking creation (v8.86.0) |
| Staff manual booking | `server/routes/staff/manualBooking.ts` | Staff-created bookings |
| Booking approval | `server/routes/bays/approval.ts` | Approval logic, conflict checks, session creation |
| Member cancellation | `server/routes/bays/bookings.ts` (member-cancel) | Cancel flow, refund logic |
| Trackman cancellation | `server/core/bookingService/bookingStateService.ts` | Webhook-driven cancel with side-effects manifest |
| Session creation | `server/core/bookingService/sessionManager.ts` | `ensureSessionForBooking()`, `createSession()` |
| Session billing | `server/core/bookingService/sessionManager.ts` | `createSessionWithUsageTracking()` |
| Tier rules | `server/core/bookingService/tierRules.ts` | Social tier permissions |
| Conflict detection | `server/core/bookingValidation.ts` | Time overlap, availability checks |
| Booking events | `server/core/bookingEvents.ts` | Pub/sub for booking lifecycle |
| Booking expiry | `server/schedulers/bookingExpiryScheduler.ts` | Pending booking timeout |
| Auto-complete | `server/schedulers/bookingAutoCompleteScheduler.ts` | Auto check-in past bookings |
| Draft invoices | `server/core/billing/bookingInvoiceService.ts` | Invoice lifecycle per booking |
| Booking auth | `server/core/bookingAuth.ts` | Member booking permissions |
| Frontend booking | `src/pages/Member/BookGolf.tsx`, `src/components/staff-command-center/` | Booking UI |

## Decision Trees

### New booking → What status?

```
Is it a conference room?
├── Yes → status = 'confirmed' (auto-approve)
│   └── Create session + draft invoice immediately (post-commit)
└── No (simulator) → status = 'pending' (staff approval required)
    └── Trackman webhook matches? → tryAutoApproveBooking()
```

### Cancelling a booking → Which path?

```
Who is cancelling?
├── Member → PUT /api/booking-requests/:id/member-cancel
│   └── Has trackman_booking_id?
│       ├── Yes → status = 'cancellation_pending' (wait for Trackman cleanup)
│       └── No → status = 'cancelled' (instant)
├── Trackman webhook → BookingStateService.cancelBooking()
│   └── Was already cancellation_pending?
│       ├── Yes → completePendingCancellation()
│       └── No → cancelBooking() with side-effects manifest
├── Staff → same as member path (via acting_as_email)
│   └── Staff can override cancellation_pending → 'cancelled' directly (v8.87.35)
└── Staff decline → declineBooking()
    └── Deletes ALL trackman_bay_slots in duration range (not just first slot) (v8.87.35)
    └── Cancels ALL pending PIs via cancelPendingPaymentIntentsForBooking() (v8.87.42)
    └── Marks fee snapshots as 'cancelled'
```

### Fee calculation timing

```
Is this inside a db.transaction()?
├── Yes → STOP. Fee calc MUST be post-commit.
└── No → Call recalculateSessionFees(sessionId, source)
    └── Then call syncBookingInvoice() if invoice exists
```

## Hard Rules

1. **Session before roster.** A `booking_sessions` row must exist before any `booking_participants` can be linked. Always call `ensureSessionForBooking()`.
2. **Fee calculation is post-commit.** `recalculateSessionFees()` uses the global `db` pool. NEVER call inside `db.transaction()` — causes $0 fees or deadlock under Read Committed isolation.
3. **Optimistic locking on status transitions.** All status-changing UPDATEs must include `WHERE status IN (...)` matching expected source statuses. Check `rowCount` after — if 0, reject (concurrent change).
3a. **Advisory locks on booking creation.** `acquireBookingLocks()` in `bookingCreationGuard.ts` acquires `pg_advisory_xact_lock` on resource and member, **sorted lexicographically by identifier** to prevent ABBA deadlocks between concurrent requests (v8.87.36). `checkResourceOverlap()` uses `SELECT FOR UPDATE` to verify no overlapping bookings exist (multi-row — must use `ORDER BY id ASC` per convention 18a in `project-architecture`). Roster edits use `roster_version` optimistic locking with `SELECT FOR UPDATE` (v8.86.0, single-row by booking ID).
4. **Social tier CAN bring guests.** `enforceSocialTierRules()` always returns `{ allowed: true }`. Social members pay full overage (0 daily minutes) and full guest fees (0 complimentary passes). The restriction is economic, not a hard block.
5. **Post-commit notifications.** Send HTTP response BEFORE post-commit ops (notifications, event publishing, availability broadcast).
6. **One invoice per booking.** Each booking has at most one Stripe invoice (`booking_requests.stripe_invoice_id`). Draft at approval → updated on roster changes → finalized at payment → voided on cancel.
7. **Roster lock after paid invoice.** `enforceRosterLock()` blocks edits after invoice is paid. Staff can override with reason. `isBookingInvoicePaid()` checks Stripe first; on Stripe failure, falls back to `booking_fee_snapshots` — locks only if a completed snapshot with `total_cents > 0` exists (meaning real money was collected). This avoids false locks on $0 bookings (within daily allowance) while preventing fail-open when Stripe is unreachable.
8. **Conflict check must include all 6 active statuses.** `pending`, `pending_approval`, `approved`, `confirmed`, `attended`, `cancellation_pending`.
9. **Guest pass hold-then-convert.** Holds at booking creation → converted to usage inside session creation transaction → released on cancellation. `releaseGuestPassHold` runs AFTER the hard-delete transaction commits — prevents premature release if the delete fails (v8.87.35).
10. **Auto-complete runs every 1 hr.** Marks approved/confirmed as `attended` 30 min after end time (same-day) or next day (overnight). Fee guard: blocks auto-complete if unpaid fees exist.
11. **Usage ledger stores emails, not UUIDs.** `resolveUserIdToEmail()` converts before ledger writes.

## Anti-Patterns (NEVER)

1. NEVER call `recalculateSessionFees()` inside a `db.transaction()` block.
2. NEVER write raw `INSERT INTO booking_sessions` — use `ensureSessionForBooking()`.
3. NEVER update booking status without `WHERE status IN (...)` guard.
3b. NEVER acquire advisory locks in non-deterministic order. `acquireBookingLocks()` sorts lock identifiers lexicographically before calling `pg_advisory_xact_lock` — this prevents ABBA deadlocks when concurrent booking requests lock the same resources in different orders. If you add new lock acquisition code, always sort the lock keys first (v8.87.36).
4. NEVER skip `syncBookingInvoice()` after `recalculateSessionFees()` if the booking has a Stripe invoice.
5. NEVER assume social tier members are blocked from guests — they are allowed but pay full fees.
6. NEVER create new roster editors or player management modals — use the Unified Booking Sheet.
7. NEVER use raw `fetch()` to booking endpoints in UI components — use `useBookingActions()` hook.
8. NEVER call `finalizeAndPayInvoice()` without first checking `getBookingInvoiceId()` — conference room bookings within daily allowance have zero fees and no invoice. All three conference room paths (member, staff, approval) must guard with this check (v8.87.7).
9. NEVER call `refundGuestPass()` inside a `db.transaction()` without passing the transaction client as `txClient` — creates a nested transaction that deadlocks. See `bookingStateService.ts` for the correct pattern (v8.87.34).
10. NEVER issue a Stripe refund for the full `amount_cents` without first querying `amount_cents - COALESCE(refunded_amount_cents, 0)` — partial refunds may have already been issued. For Stripe card refunds, omit the explicit `amount` param so Stripe defaults to the remaining balance (v8.87.34).
11. NEVER use `.catch()` chains for rollback `db.execute()` calls in cancellation paths — use `await` + `try/catch` to prevent floating promises and unhandled rejections (v8.87.34).
12. NEVER assume Trackman bay slot cleanup only needs to delete a single slot — multi-slot bookings require duration-aware range DELETE covering `startTime` through `startTime + durationMinutes` at 30-min intervals. Both `cancelBooking`, `completePendingCancellation`, and `declineBooking` use this pattern (v8.87.35).
13. NEVER silently discard cancellation side-effect failures (refunds, calendar cleanup, notifications). Failed side effects are persisted to the `failed_side_effects` table with `booking_id`, `action_type`, `stripe_payment_intent_id`, and `error_message` for staff recovery (v8.87.35).

## Cross-References

- **Fee calculation details** → `fee-calculation` skill
- **Guest pass lifecycle** → `guest-pass-system` skill
- **Check-in billing flow** → `checkin-flow` skill
- **Trackman CSV import rules** → `booking-import-standards` skill
- **Stripe invoice/webhook handling** → `stripe-webhook-flow` skill
- **Booking action architecture** → `project-architecture` skill (Unified Booking Sheet section)
- **Apple Wallet membership passes** → `project-architecture` skill (Apple Wallet section)

## Detailed Reference

- **[references/server-flow.md](references/server-flow.md)** — Full server-side lifecycle: request creation, approval steps, session creation internals, cancellation side-effects, conflict detection SQL, availability checks.
- **[references/trackman-sync.md](references/trackman-sync.md)** — Trackman webhook auto-approve, duration/bay updates, placeholder merging, `[PENDING_TRACKMAN_SYNC]` marker.

---

## Apple Wallet Booking Passes (v8.87.13, updated v8.87.16)

Approved bookings can generate Apple Wallet event tickets. The pass shows bay name, date/time, player count, booking status, and includes geofencing for the club address.

**Wallet changeMessage notifications (v8.87.16):** All booking pass fields include `changeMessage` templates so iOS shows lock-screen alerts when field values change:
- `eventDate` → "Booking date changed to %@"
- `eventTime` → "Booking time changed to %@"
- `bayName` → "Bay changed to %@"
- `duration` → "Duration changed to %@"
- `playerCount` → "Player count changed to %@"
- `bookingStatus` → "Booking status changed to %@"

**PWA push dedupe:** Booking notification types (`booking_approved`, `booking_update(d)`, `booking_confirmed`, `booking_auto_confirmed`, `booking_cancelled*`, `booking_checked_in`) are deduped in `notifyMember()`. If the specific booking has a registered wallet pass (`EVERBOOKING-{bookingId}` in `wallet_pass_device_registrations`), PWA web push is skipped. In-app and WebSocket notifications always fire.

**Back-field deep link:** Booking passes include a "View Bookings" back-field linking to `/dashboard/bookings` with `attributedValue` for tappable link on iOS.

| Hook | File | When |
|---|---|---|
| Generate pass | `server/walletPass/bookingPassService.ts` → `generateBookingPass()` | Member taps "Add to Apple Wallet" on approved/confirmed/checked_in/attended booking |
| Void pass | `bookingPassService.ts` → `voidBookingPass()` | Booking cancelled (member cancel, staff cancel, Trackman webhook) |
| Refresh pass | `bookingPassService.ts` → `refreshBookingPass()` | Trackman import updates bay/time for a booking with an existing pass |
| Web service | `server/routes/walletPassWebService.ts` | Apple device polls for updates (`/v1/passes/...`) — delegates to `generateBookingPassForWebService()` |
| Email link | `server/emails/bookingEmails.ts` | Confirmation email includes optional "Add to Apple Wallet" link when `walletPassEnabled` |
| Frontend button | `src/pages/Member/BookGolf.tsx` | "Add to Apple Wallet" button on booking cards |
| DB table | `booking_wallet_passes` in `shared/models/scheduling.ts` | Serial number, auth token, member ID, voided timestamp |
| Route | `GET /api/member/booking-wallet-pass/:bookingId` | Member-authenticated download, ownership check, status guard |

**Void lifecycle:** Voided passes are still served to Apple Wallet (so the device receives the void update), but `voided: true` flag is set in the pass data. `bumpSerialChangeTimestamp()` + APN push notify the device.

**Allowed statuses for pass generation:** `approved`, `confirmed`, `attended`, `checked_in`. Cancelled bookings with a previously-created pass also generate (for void delivery).

## Lifecycle Overview

```
Request → Guest Pass Hold → Staff Approval → Session Creation → Invoice Draft → Trackman Link → Check-in → Completion / Auto Check-In
```

### Booking Statuses

| Status | Meaning |
|---|---|
| `pending` | Awaiting staff review (simulators) |
| `pending_approval` | Needs additional approval |
| `approved` | Staff approved, session created |
| `confirmed` | Auto-confirmed (conference rooms) or Trackman-linked |
| `attended` | Checked in (manual or auto-complete) |
| `no_show` | Staff marked no-show |
| `cancelled` | Cancelled by member/staff/system |
| `cancellation_pending` | Trackman-linked booking awaiting hardware cleanup |
| `declined` | Staff declined |
| `expired` | Pending booking timed out (20 min past start) |

### Booking Event System

`bookingEvents.publish()` fires these events:

| Event | When |
|---|---|
| `booking_created` | After booking request inserted |
| `booking_approved` | After staff approves |
| `booking_declined` | After staff declines |
| `booking_cancelled` | After cancellation (member or Trackman) |
| `booking_checked_in` | After staff marks attended |

### Key Invariants (Additional)

- **Pending booking soft lock**: Pending requests on a specific bay block that slot in member-facing availability. Self-exclusive (member sees their own slot as accessible). Only bay-assigned requests trigger the lock.
- **Booking expiry**: Targets `pending` and `pending_approval` statuses, 20-min grace past start_time. Trackman-linked bookings → `cancellation_pending` (not `expired`). Broadcasts availability update after each status change.
- **Roster fetch race protection**: `fetchRosterData()` uses `rosterFetchIdRef` counter to prevent stale data from WebSocket events overwriting current state.
- **Cancellation status guard includes 'confirmed'**: The `wasApproved` check includes both `'approved'` AND `'confirmed'` to prevent cancelling in-progress bookings without Trackman cleanup.

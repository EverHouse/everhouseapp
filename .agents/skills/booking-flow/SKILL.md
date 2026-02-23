---
name: booking-flow
description: End-to-end booking lifecycle in the Ever Club Members App — booking request creation, booking flow, booking lifecycle, session creation, conflict detection, bay assignment, approval flow, auto-approve, reschedule, Trackman sync, booking request statuses, guest pass holds, usage tracking, member cancel, staff approval, prepayment, calendar sync, and reconciliation.
---

# Booking Flow

How a booking moves through its lifecycle from member request to completion.

## Lifecycle Stages

```
Request → Guest Pass Hold → Staff Approval → Session Creation → Invoice Draft → Trackman Link → Check-in → Completion / Auto No-Show
```

### 1. Request (status: `pending`)

Member submits via `POST /api/booking-requests`. The route:

1. Validate time bounds (no cross-midnight: `endHours >= 24` blocked), resource availability, and participant membership status.
2. Run `findConflictingBookings()` — check owner bookings, participant bookings, and invites on the same date for time overlap.
3. Run `checkUnifiedAvailability()` — check closures, availability blocks, and existing sessions on the target resource.
4. Sanitize and deduplicate participants:
   - Resolve email → userId by looking up users table.
   - Resolve userId → email for directory-selected members (userId set but email missing).
   - Reject participants with `membershipStatus = 'inactive' | 'cancelled'`.
   - Deduplicate by email and userId sets; owner email always added first.
5. Determine initial status:
   - **Conference rooms** → `confirmed` (auto-approve, skip staff review).
   - **Golf simulators** → `pending` (require staff approval).
6. For conference rooms with overage fees:
   - Compute overage: `getMemberTierByEmail()` → `getTierLimits()` → `getDailyBookedMinutes()`.
   - If `calculateOverageCents(overageMinutes) > 0`, require `conference_prepayment_id` in the request body.
   - Validate prepayment status (`'succeeded'` or `'completed'`) and amount ≥ required.
7. Insert into `booking_requests` table within a raw pg transaction.
8. If guests present, call `createGuestPassHold()` to reserve guest passes (non-blocking — hold failure does not block booking).
9. If conference room with prepayment: link prepayment to booking via `conference_prepayments.booking_id` and update `stripe_payment_intents.booking_id`.
10. COMMIT transaction, then for conference rooms call `ensureSessionForBooking()`.
11. Send HTTP response, then asynchronously:
    - Publish `booking_created` event via `bookingEvents.publish()`.
    - Notify staff via `notifyAllStaff()` with push notification.
    - Broadcast availability update via WebSocket.
    - Track first booking for onboarding (`users.first_booking_at`).

### 2. Guest Pass Hold

Guest passes use a hold-then-convert pattern for atomicity:

- **At request time**: `createGuestPassHold()` reserves passes in `guest_pass_holds` table (does NOT decrement `passes_used` yet).
- **At approval time**: Inside the session creation transaction, holds are converted to actual usage via `SELECT ... FOR UPDATE` on `guest_passes`, then the hold row is deleted.
- **At cancellation**: `releaseGuestPassHold()` deletes the hold without decrementing.

This ensures passes are never double-spent even if approval and cancellation race.

### 3. Approval (status: `approved`)

Staff approves via `PUT /api/booking-requests/:id` with `status: 'approved'`. The route:

1. Validate `trackman_booking_id` format if provided (must be numeric, not UUID). Check for duplicates on other bookings.
2. Enter `db.transaction()`:
   a. Verify bay is assigned (`resource_id` required before approval).
   b. Run conflict detection within the transaction: booking time overlaps (approved/confirmed/attended), closure conflicts, availability block conflicts.
   c. Create Google Calendar event: `getCalendarNameForBayAsync()` → `getCalendarIdByName()` → `createCalendarEventOnCalendar()`.
   d. Determine final status: conference rooms → `'attended'`, simulators → `'approved'`.
   e. If `pending_trackman_sync` flag is set without a `trackman_booking_id`, append `[PENDING_TRACKMAN_SYNC]` marker to `staff_notes`.
   f. Build participant list from `request_participants` JSON column:
      - Start with owner as first participant (resolve `userId` from email if needed).
      - For each request participant: resolve email ↔ userId, detect "guests" who are actually members, deduplicate.
      - Guests with a matching email in the `users` table are converted to `member` type.
   g. Call `createSessionWithUsageTracking()` with `bookingId` (enables hold-to-usage conversion).
   h. Link session: `UPDATE booking_requests SET session_id`.
   i. Call `recalculateSessionFees(sessionId, 'approval')` → returns `{ totalCents, overageCents, guestCents }`.
   j. If `totalCents > 0`, create a prepayment intent via `createPrepaymentIntent()`.
   k. If simulator booking with fees > 0, create draft Stripe invoice via `createDraftInvoiceForBooking()`. Stores `stripe_invoice_id` on `booking_requests`. Non-blocking — invoice failure does not block approval.
3. Post-transaction:
   - Link and notify participants via `linkAndNotifyParticipants()`.
   - Notify member: push notification, WebSocket update, email.
   - Publish `booking_approved` event.
   - Broadcast availability and billing updates.

### 4. Session Creation

`createSessionWithUsageTracking()` is the central orchestrator. It accepts an optional external transaction and either joins it or creates its own. Steps:

**Pre-transaction validation** (runs outside transaction to avoid long locks):

1. **Tier validation**: `getMemberTier(ownerEmail)` → ownerTier. Then `enforceSocialTierRules(ownerTier, participants)`:
   - Check if any participant has `type: 'guest'`.
   - If owner is Social tier and guests are present → return `{ allowed: false, errorType: 'social_tier_blocked' }`.
2. **Resolve identities**: For each participant with a `userId`, call `resolveUserIdToEmail(userId)` → build `userIdToEmail` map. This is needed because `usage_ledger.member_id` stores emails.
3. **Calculate billing**: `calculateFullSessionBilling(sessionDate, durationMinutes, billingParticipants, ownerEmail, declaredPlayerCount, { resourceType })` → returns `billingBreakdown[]` with per-participant `minutesAllocated`, `overageFee`, `guestFee`, plus totals and `guestPassesUsed`.

**Database writes** (all-or-nothing within transaction):

4. **Find or create session**: `findOverlappingSession(resourceId, sessionDate, startTime, endTime)` uses Postgres `tsrange` with `[)` bounds and the overlap operator `&&`. If found, call `linkParticipants(existingSession.id, participants, tx)`. If not found, call `createSession({ resourceId, sessionDate, startTime, endTime, trackmanBookingId, createdBy }, participants, source, tx)`.
5. **Record usage ledger**: For each billing entry:
   - **Guest**: `recordUsage(sessionId, { memberId: ownerEmail, minutesCharged: 0, guestFee, ... })` — fee assigned to host, zero minutes to avoid double-counting in host's daily usage.
   - **Member/Owner**: `recordUsage(sessionId, { memberId: email, minutesCharged, overageFee, ... })`.
6. **Deduct guest passes** (if `guestPassesUsed > 0`):
   - **Path 1 — Booking request flow** (has `bookingId`): `SELECT guest_pass_holds FOR UPDATE` → verify hold exists. `SELECT guest_passes FOR UPDATE` → verify `passes_used + passesToConvert <= passes_total`. `UPDATE guest_passes SET passes_used += passesToConvert`. `DELETE FROM guest_pass_holds`.
   - **Path 2 — Staff/Trackman flow** (no `bookingId`): `SELECT guest_passes FOR UPDATE` → verify available ≥ needed. `UPDATE guest_passes SET passes_used += passesNeeded`.
   - If either path fails validation → throw error → entire transaction rolls back.

### 5. Trackman Link

Trackman webhooks and CSV imports link external bookings to app bookings:

- **Webhook auto-approve**: `tryAutoApproveBooking()` matches pending bookings by email + date + time (±10 minute tolerance). On match, sets `status='approved'`, links `trackman_booking_id`, and calls `ensureSessionForBooking()`. After session creation and fee calculation, creates a draft Stripe invoice via `createDraftInvoiceForBooking()` (non-blocking, simulator bookings only).
- **Webhook create**: `createBookingForMember()` tries to match existing `[PENDING_TRACKMAN_SYNC]` bookings first, then creates new booking records. Uses `was_auto_linked=true` flag.
- **Duration updates**: If Trackman reports different duration, update `booking_requests` and `booking_sessions` times, then call `recalculateSessionFees()` for delta billing, then sync the draft invoice via `syncBookingInvoice()` to update line items.
- **Bay changes**: If Trackman reports a different `resource_id`, update both `booking_requests.resource_id` and `booking_sessions.resource_id`, then broadcast availability for old and new bays.

See `references/trackman-sync.md` for full details.

### 6. Check-in (status: `attended` / `checked_in`)

Staff marks booking as attended. Session must exist before check-in. If no session exists yet, the check-in flow calls `ensureSessionForBooking()` to create one.

### 7. Cancellation

Two cancellation paths:

**Member cancel** (`PUT /api/booking-requests/:id/member-cancel`):

1. Validate ownership — three accepted conditions:
   - Session email matches booking's `user_email`.
   - Admin/staff with `acting_as_email` matching booking email.
   - Session user has linked email matching booking email (checked via `trackman_email`, `linked_emails` JSONB, or `manually_linked_emails` JSONB).
2. Verify booking is not already cancelled.
3. Update `booking_requests.status = 'cancelled'`.
4. Release guest pass holds via `releaseGuestPassHold(bookingId)`.
5. Cancel all pending Stripe payment intents linked to the booking (`status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`).
5a. Handle Stripe invoice cleanup via `voidBookingInvoice(bookingId)` (non-blocking). This handles all invoice states: draft (deletes), open (voids), paid (auto-refunds via `stripe.refunds.create`, notifies staff on failure), void/uncollectible (skips).
6. Delete Google Calendar event via `deleteCalendarEvent(calendarEventId)`.
7. Publish `booking_cancelled` event with `cleanupNotifications: true` (deletes related notifications).
8. Broadcast availability update.

**Trackman cancel** (`cancelBookingByTrackmanId()`):

1. Find booking by `trackman_booking_id`.
2. Guard: if `is_relocating=true`, unlink `trackman_booking_id` and skip cancellation (booking is being rescheduled).
3. Update status to `'cancelled'`, append `'[Cancelled via Trackman webhook]'` to staff notes.
4. Clear pending fees: set `booking_participants.cached_fee_cents = 0`, `payment_status = 'waived'` for the session's pending participants.
5. Cancel pending Stripe payment intents (same as member flow).
5a. Handle Stripe invoice cleanup via `voidBookingInvoice(bookingId)` (non-blocking). This handles all invoice states: draft (deletes), open (voids), paid (auto-refunds via `stripe.refunds.create`, notifies staff on failure), void/uncollectible (skips).
6. Refund already-paid participant fees: for each participant with `payment_status='paid'`, call `stripe.refunds.create()`, update participant and payment records to `'refunded'`.
7. Refund guest passes via `refundGuestPassesForCancelledBooking()`.
8. Notify staff and member. If `wasPendingCancellation`, send member a confirmation push notification.
9. Log audit entry via `logSystemAction({ action: 'booking_cancelled_webhook' })`.
10. Broadcast availability update.

### 8. Auto No-Show (status: `no_show`)

The auto-complete scheduler (`server/schedulers/bookingAutoCompleteScheduler.ts`) runs every 2 hours. It marks approved/confirmed bookings as `no_show` when 24 hours have passed since the booking's end time without a check-in. This prevents stale bookings from occupying active status indefinitely and removes them from conflict detection (which filters by `approved`, `confirmed`, `attended`).

- Uses Pacific timezone via `getTodayPacific()` / `formatTimePacific()`
- Excludes relocating bookings (`is_relocating IS NOT TRUE`)
- Notifies staff when 2+ bookings are auto-marked
- Manual trigger available via `runManualBookingAutoComplete()`

### 9. Reschedule

Three-step flow (all staff-only):

1. **Start** (`POST /api/admin/booking/:id/reschedule/start`): Set `is_relocating=true`. This flag prevents Trackman webhook cancellation from interfering.
2. **Confirm** (`POST /api/admin/booking/:id/reschedule/confirm`): Validate new time slot via centralized `checkBookingConflict()` (closures, blocks, session overlaps, advisory lock). Update booking and session times, link new `trackman_booking_id`. Store original values in `original_resource_id`, `original_start_time`, etc. Recalculate fees. Sync invoice line items via `syncBookingInvoice()` after fee recalculation. Send reschedule email to member. WebSocket broadcast errors are logged as warnings (non-blocking).
3. **Cancel** (`POST /api/admin/booking/:id/reschedule/cancel`): Clear `is_relocating` flag, abort the reschedule.

**Note:** Reschedule UI is currently hidden across SimulatorTab, BookingActions, and PaymentSection. Backend routes are preserved for future use.

## Conflict Detection Detail

`findConflictingBookings(memberEmail, date, startTime, endTime, excludeBookingId?)` checks two sources:

1. **Owner conflicts**: Query `booking_requests` where `LOWER(user_email)` matches and `status IN OCCUPIED_STATUSES` on the same date. Apply `timePeriodsOverlap()` in application code.
2. **Participant conflicts**: Query `booking_participants` → `booking_sessions` → `booking_requests` where `bp.user_id` matches the member's UUID and `bp.invite_status = 'accepted'`. Also apply `timePeriodsOverlap()`. (Note: All participants are now auto-accepted — `invite_status` defaults to `'accepted'` at the database level. The invite system and `inviteExpiryScheduler` have been removed as of v7.92.0.)

`timePeriodsOverlap()` handles cross-midnight by adding 1440 minutes to any end time < start time. However, cross-midnight bookings cannot be created through normal flows (club closes at 10 PM).

`checkUnifiedAvailability(resourceId, date, startTime, endTime, excludeSessionId?)` runs three layered checks:

1. `checkClosureConflict()` — facility-wide closures from `facility_closures` table.
2. `checkAvailabilityBlockConflict()` — per-resource event blocks from `availability_blocks` table (e.g., tournaments, private events).
3. `checkSessionConflict()` — existing sessions on `booking_sessions` with time overlap (`start_time < endTime AND end_time > startTime`).

For pessimistic locking during concurrent session creation, `checkSessionConflictWithLock()` uses `FOR UPDATE NOWAIT` to immediately fail if another transaction holds the lock on a conflicting session row.

## Key Decision Trees

### Approval vs Auto-Approve

```
Is resource a conference room?
├── Yes → Auto-confirm (status='confirmed'), create session immediately
│   └── Has overage fees?
│       ├── Yes → Require prepayment (conference_prepayment_id), validate amount
│       └── No → Confirm directly
└── No (golf simulator) → Pending staff approval (status='pending')
    └── Trackman webhook arrives?
        ├── Yes, matching pending booking → Auto-approve, create session
        └── No match → Save to trackman_unmatched_bookings
```

### Conference Room vs Simulator at Approval

```
Resource type?
├── conference_room → Final status = 'attended' (skip 'approved' stage)
└── simulator → Final status = 'approved'
```

## Key Invariants

1. **Session before roster**: A `booking_sessions` row must exist before any `booking_participants` can be linked. The session is the anchor for the participant roster and usage ledger.

2. **Conflict detection scope**: `findConflictingBookings()` checks OCCUPIED_STATUSES = `['pending', 'pending_approval', 'approved', 'confirmed', 'checked_in', 'attended']`. It checks both owner bookings and participant bookings on the same date. The `attended` status was added in v8.6.0 to prevent double-booking against checked-in sessions. The auto-complete scheduler moves stale `approved`/`confirmed` bookings to `no_show` after 24h, removing them from conflict detection.

3. **Availability guard layers**: `checkUnifiedAvailability()` runs three checks in order:
   - Facility closures (`facility_closures` table)
   - Availability blocks (`availability_blocks` table)
   - Existing sessions (`booking_sessions` table with time overlap)

4. **Guest pass atomicity**: Guest pass deduction happens INSIDE the session creation transaction. If session creation fails, guest passes are not deducted. Two paths: hold-then-convert (booking request flow) vs direct deduction (staff/Trackman flow).

5. **Social tier restriction**: Social tier members cannot bring guests. Enforced by `enforceSocialTierRules()` before session creation. This is a hard block, not a warning.

6. **Overlapping session reuse**: `findOverlappingSession()` uses Postgres `tsrange` overlap operator (`&&`) to find existing sessions within the time window. If a session already exists (e.g., from Trackman import), participants are linked to it rather than creating a duplicate.

7. **Time tolerance matching**: Trackman webhook matching uses ±10 minute tolerance (`ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 600`). This accounts for Trackman sessions starting slightly earlier/later than booked times.

8. **Relocating guard**: When `is_relocating=true`, Trackman webhook cancellation is skipped. The old `trackman_booking_id` is cleared so the Trackman cancellation event does not cancel the booking being rescheduled.

9. **Row-level locking**: `checkSessionConflictWithLock()` uses `FOR UPDATE NOWAIT` on `booking_sessions` for pessimistic locking during session creation. Guest pass deduction uses `FOR UPDATE` on `guest_passes` for atomic read-modify-write.

10. **Usage ledger stores emails**: `usage_ledger.member_id` stores email addresses (not UUIDs) for historical consistency. The `resolveUserIdToEmail()` step converts UUIDs to emails before ledger writes.

11. **Post-commit notifications**: Booking creation sends the HTTP response BEFORE executing post-commit operations (staff notifications, event publishing, availability broadcast). This ensures the client gets a success response even if notifications fail.

12. **One invoice per booking**: Each simulator booking has at most one Stripe invoice (`booking_requests.stripe_invoice_id`). Draft created at approval (if fees > $0), updated on roster changes, finalized at payment. If a booking is approved with $0 fees (no invoice created) and later gains fees through roster edits, `syncBookingInvoice()` creates the draft invoice on-the-fly. Conference rooms are excluded (checked via `resources.type` JOIN). The invoice lifecycle is managed by `bookingInvoiceService.ts`.

13. **Roster lock after paid invoice**: Once a booking's Stripe invoice is paid, roster edits (add/remove participant, change player count) are blocked via `enforceRosterLock()`. Staff can override with a reason (logged via audit). The lock is fail-open: if the Stripe API check fails, edits proceed.

## Booking Event System

`bookingEvents` provides a pub/sub system via `publish()`:

| Event | When |
|---|---|
| `booking_created` | After booking request inserted |
| `booking_approved` | After staff approves booking |
| `booking_declined` | After staff declines booking |
| `booking_cancelled` | After cancellation (member or Trackman) |
| `booking_rescheduled` | After reschedule confirmed |
| `booking_checked_in` | After staff marks attended |

Each event can trigger member notifications (push, WebSocket, email) and staff notifications independently via `PublishOptions`.

## Reconciliation

After a booking is completed, `findAttendanceDiscrepancies()` compares `declared_player_count` (from member's request) against `trackman_player_count` (from Trackman data). If they differ:

- Calculate potential fee adjustment based on additional players × duration × overage rate.
- Staff reviews via reconciliation UI: mark as `reviewed` or `adjusted`.
- Fee adjustments use `calculatePotentialFeeAdjustment()` — computes per-player minute allocation and applies 30-minute block overage rates.

See `references/trackman-sync.md` for reconciliation details.

## References

**Core Reference Docs:**
- `references/server-flow.md` — Detailed API route → core service call chains for each booking operation.
- `references/trackman-sync.md` — Trackman webhook handling, CSV import matching, reconciliation, and delta billing.

**Key Implementation Files:**
- `server/core/bookingService/tierRules.ts` — Tier validation rules, daily minute limits, Social tier guest restrictions, and `TierValidationResult` interface. See `references/server-flow.md#tier-validation-rules` for detailed documentation.
- `server/core/bookingService/sessionManager.ts` — Session creation, participant linking, usage ledger recording, and guest pass deduction.
- `server/core/bookingService/conflictDetection.ts` — Booking conflict detection (owner and participant conflicts).
- `server/core/bookingValidation.ts` — Centralized booking conflict detection (`checkBookingConflict`). Used by reschedule confirm and booking creation for consistent conflict validation with advisory locks.
- `server/core/bookingService/availabilityGuard.ts` — Availability validation (closures, blocks, session overlaps).
- `server/core/billing/bookingInvoiceService.ts` — Draft invoice creation, line item sync, finalization, voiding, paid-status check. Key exports: `createDraftInvoiceForBooking`, `syncBookingInvoice`, `finalizeAndPayInvoice`, `finalizeInvoicePaidOutOfBand`, `voidBookingInvoice`, `isBookingInvoicePaid`. `finalizeAndPayInvoice()` includes terminal payment detection: before charging, it checks for existing terminal payments on the booking to avoid double-charging. It is also balance-aware: if the customer's Stripe balance fully covers the invoice amount, the invoice is finalized and auto-paid without requiring a card charge.
- `server/core/bookingService/rosterService.ts` — Roster changes with `enforceRosterLock()` guard. Exports: `addParticipant`, `removeParticipant`, `updateDeclaredPlayerCount`, `applyRosterBatch`.

**Related Skills:**
- Refer to `booking-import-standards` skill for CSV parsing rules, roster protection, and import data integrity rules.

# Backend Check-In Flow

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/bookings/:id/staff-checkin-context` | Load billing context for a booking |
| PATCH | `/api/bookings/:id/payments` | Confirm, waive, or consume guest pass for participants |
| POST | `/api/bookings/:id/checkin` | Mark booking as checked_in (requires all fees settled) |
| POST | `/api/staff/qr-checkin` | Walk-in check-in via QR scan (no booking) |
| POST | `/api/bookings/:id/staff-direct-add` | Add member or guest to roster during check-in |
| GET | `/api/bookings/overdue-payments` | List bookings with unpaid fees from last 30 days |
| POST | `/api/booking-participants/:id/mark-waiver-reviewed` | Mark single waiver as reviewed |
| POST | `/api/bookings/:bookingId/mark-all-waivers-reviewed` | Mark all waivers for a booking as reviewed |
| POST | `/api/bookings/bulk-review-all-waivers` | Bulk review all stale waivers (>12h old) |
| GET | `/api/bookings/stale-waivers` | List unreviewed waivers older than 12 hours |

## Step-by-Step: Booking Check-In Context

When staff opens the billing modal for a booking:

1. **Query booking data.** Join `booking_requests` with `resources` and `users` to get owner info, times, resource name, overage data.

2. **Ensure session exists.** If `session_id` is null, call `ensureSessionForBooking`:
   - Search for existing session by trackman_booking_id, then by resource+date+time, then by time overlap.
   - If none found, insert a new `booking_sessions` row.
   - Create an owner participant if none exists.
   - Update `booking_requests.session_id`.
   - Create guest placeholder participants based on `declared_player_count`.

3. **Recalculate session fees.** Call `recalculateSessionFees(sessionId, 'checkin')` to persist fees to `cached_fee_cents` on each participant.

4. **Sync-clean orphaned participants.** Query `booking_members` for valid emails, compare against `booking_participants` with type `'member'`. Delete participants whose email is not in the valid set or whose user_id resolves to no email.

5. **Compute fee breakdown.** Call `computeFeeBreakdown({ sessionId, source: 'checkin' })` to get per-participant fees:
   - Load session data (duration, player count, host email, resource type).
   - Load participants from `booking_participants` joined with `users`.
   - Resolve member tiers and roles (staff/admin get $0).
   - Calculate daily usage from `usage_ledger` + ghost bookings (bookings without ledger entries).
   - Per participant: overage = max(0, minutesPerParticipant - remainingAllowance) × rate.
   - Guest fee = `PRICING.GUEST_FEE_CENTS` for guest participants.

6. **Check prepaid snapshots.** Query `booking_fee_snapshots` for completed snapshots with a `stripe_payment_intent_id`. Track which participants were already prepaid.

7. **Build CheckinContext.** For each participant, use `Math.min(cachedFee, calculatedFee)` as the display fee. Sum unpaid fees for `totalOutstanding`. Include audit history from `booking_payment_audit`.

## Fee Recalculation at Check-In Time

`recalculateSessionFees(sessionId, source)` in `unifiedFeeService.ts`:

1. Call `computeFeeBreakdown({ sessionId, source })`.
2. Call `applyFeeBreakdownToParticipants(sessionId, breakdown)` which updates `cached_fee_cents` on each `booking_participants` row.
3. This ensures fees reflect the member's current tier, daily usage, and any roster changes since booking time.

Key rules:
- Duration uses the GREATER of session duration and booking duration (handles Trackman imports with shorter session times).
- Effective player count = max(declared, actual, 1).
- Simulator sessions split duration by player count; conference rooms use full duration.
- Only count usage from bookings that start EARLIER than the current booking (chronological ordering).
- Cancelled/declined bookings always return $0.

## Prepayment Enforcement

`createPrepaymentIntent` in `prepaymentService.ts`:

1. Check for existing prepayment intent by session_id (skip if one exists that is not canceled/failed).
2. Check for existing prepayment intent by booking_id (skip if active).
3. Get or create a Stripe customer for the booking owner.
4. Call `createBalanceAwarePayment`:
   - First apply any account credit balance.
   - If fully covered by credit, return `paidInFull: true` with a balance transaction ID.
   - Otherwise, create a Stripe PaymentIntent for the remaining amount.
5. The checkin endpoint (`POST /api/bookings/:id/checkin`) enforces settlement:
   - Query participants with `payment_status NOT IN ('paid', 'waived')` and fees > 0.
   - Return HTTP 402 `OUTSTANDING_BALANCE` if any unpaid participants exist.
   - Only set `status = 'checked_in'` when all fees are resolved.

## Guest Pass Verification and Consumption

### Check Availability

`canUseGuestPass(ownerEmail)`:
1. Look up tier's `guest_passes_per_month` from `membership_tiers`.
2. Query `guest_passes` table for `passes_used` and `passes_total`.
3. Return `{ canUse, remaining, total }`.

### Consume Pass

`consumeGuestPassForParticipant(participantId, ownerEmail, guestName, sessionId, sessionDate, staffEmail)`:

1. Reject placeholder guests (names matching `Guest \d+`).
2. Check idempotency — if `used_guest_pass` is already true, return success.
3. Look up owner's user ID and tier guest pass allocation.
4. Lock `guest_passes` row with `FOR UPDATE`.
5. If no row exists, insert one with `passes_used = 1`.
6. If row exists, check `passes_used < passes_total`. Increment `passes_used`.
7. Update owner's `usage_ledger` to zero out `guest_fee` and set `payment_method = 'guest_pass'`.
8. Set participant: `payment_status = 'waived'`, `cached_fee_cents = 0`, `used_guest_pass = TRUE`.
9. Insert `legacy_purchases` record (category: `guest_pass`, price: 0, is_comp: true).
10. Send in-app notification with remaining count.
11. Clean up `guest_pass_holds` for this booking.

### Refund Pass

`refundGuestPassForParticipant` reverses the consumption:
- Decrement `passes_used` on `guest_passes`.
- Reset participant to `payment_status = 'pending'`, restore `cached_fee_cents` to guest fee amount.
- Delete the corresponding `legacy_purchases` record.

## Audit Logging

Every payment action inserts a row into `booking_payment_audit`:

| Column | Source |
|--------|--------|
| `booking_id` | From the booking being processed |
| `session_id` | From the booking's linked session |
| `participant_id` | The specific participant affected |
| `action` | `payment_confirmed`, `payment_waived`, `guest_pass_used`, `staff_direct_add`, `tier_override` |
| `staff_email` | From session user (authenticated staff) |
| `staff_name` | From session user |
| `reason` | Staff-provided reason (required for waivers) |
| `previous_status` | Payment status before the action |
| `new_status` | Payment status after the action |
| `metadata` | JSON with additional context (participant type, tier info, etc.) |

Additionally, `logFromRequest` writes to the general audit log with action types like `update_payment_status`, `direct_add_participant`, `qr_walkin_checkin`, `review_waiver`.

## QR Walk-In Check-In Flow

`POST /api/staff/qr-checkin { memberId }`:

1. Look up member by UUID from `users` table.
2. Deduplicate: reject if a `walk_in_visits` row exists for this email within the last 2 minutes (HTTP 409).
3. Increment `lifetime_visits` on `users`.
4. Sync visit count to HubSpot via `updateHubSpotContactVisitCount` (async, non-blocking).
5. Broadcast stats update via WebSocket (`broadcastMemberStatsUpdated`).
6. Send in-app notification ("Welcome back! You've been checked in by staff.").
7. Insert `walk_in_visits` row with `member_email`, `checked_in_by`, `checked_in_by_name`.
8. If first visit (`lifetime_visits === 1`) and member is trialing, send first-visit confirmation email.
9. Return pinned notes from `member_notes` (for staff alerts).

## Edge Cases

### Expired or Past Bookings
The overdue payments endpoint (`GET /api/bookings/overdue-payments`) catches bookings from the last 30 days with unpaid fees. There is no automatic expiry — staff must manually resolve these.

### Cancelled Members
`computeFeeBreakdown` only considers tiers for users with `membership_status IN ('active', 'trialing', 'past_due')`. Members with other statuses (cancelled, suspended) get no tier benefits and are charged full rates.

### Cancelled Bookings
`computeFeeBreakdown` returns $0 for bookings with status `cancelled`, `declined`, or `cancellation_pending`.

### Missing Session
If a booking has no session at check-in time, `ensureSessionForBooking` creates one. If creation fails after retry, it flags the booking with a staff note (`[SESSION_CREATION_FAILED]`) for manual resolution.

### Duplicate Check-In (QR)
QR walk-in check-in deduplicates within a 2-minute window. A second scan within 2 minutes returns HTTP 409 with `alreadyCheckedIn: true`.

### Placeholder Guests
Guest pass consumption rejects placeholder names (e.g., "Guest 2"). Staff must assign a real guest name before consuming a pass.

### Tier Override
When adding a member whose tier lacks simulator booking permission, staff can provide an `overrideReason` to bypass the restriction. This is logged as a `tier_override` action in the audit.

### Race Conditions on Fee Snapshots
Fee snapshot creation uses `ON CONFLICT (session_id) WHERE status = 'completed' DO NOTHING` to handle concurrent check-in attempts. If a snapshot already exists, the system logs and skips creation.

### Booking Without Participants
If no participants exist in session or booking_members, the system creates a single owner participant from the booking's host email.

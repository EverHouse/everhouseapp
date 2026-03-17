# Server Flow: API Route → Core Service Chains

Detailed call chains for each booking operation. Shows the actual function names, route paths, and parameter shapes.

## Create Booking

**Route**: `POST /api/booking-requests`
**File**: `server/routes/bays/bookings.ts`

```
POST /api/booking-requests
  ├── Validate inputs (date, time, duration, resource_id or resource_preference)
  ├── Compute end_time from start_time + duration_minutes
  ├── Reject cross-midnight: endHours >= 24
  │
  ├── conflictDetection.findConflictingBookings(memberEmail, date, startTime, endTime)
  │   ├── Query booking_requests for owner conflicts (OCCUPIED_STATUSES on same date)
  │   ├── Query booking_participants → booking_sessions for participant conflicts
  │   └── timePeriodsOverlap() handles cross-midnight via +1440 min adjustment
  │
  ├── availabilityGuard.checkUnifiedAvailability(resourceId, date, startTime, endTime)
  │   ├── checkClosureConflict(resourceId, date, startTime, endTime)
  │   ├── checkAvailabilityBlockConflict(resourceId, date, startTime, endTime)
  │   └── checkSessionConflict(resourceId, date, startTime, endTime)
  │
  ├── Sanitize participants:
  │   ├── Resolve email → userId (lookup users table)
  │   ├── Resolve userId → email (for directory-selected members)
  │   ├── Check membershipStatus != 'inactive' | 'cancelled'
  │   └── Deduplicate by email and userId (owner always first)
  │
  ├── Determine initialStatus:
  │   ├── conference_room → 'confirmed'
  │   └── simulator → 'pending'
  │
  ├── BEGIN transaction (raw pg client)
  │   ├── INSERT INTO booking_requests (...) RETURNING *
  │   └── If guests > 0: createGuestPassHold(email, bookingId, guestCount, client)
  ├── COMMIT
  │
  ├── If conference_room + resourceId:
  │   ├── ensureSessionForBooking({ bookingId, resourceId, sessionDate, ... })
  │   ├── syncBookingInvoice(bookingId, sessionId)
  │   ├── invoiceId = getBookingInvoiceId(bookingId)
  │   ├── If invoiceId exists (fees due):
  │   │   └── finalizeAndPayInvoice({ bookingId }) — auto-charge or collect later
  │   └── If no invoiceId (zero fees, within daily allowance):
  │       └── Log "No fees due — skipping invoice finalization" (v8.87.7)
  │
  ├── res.status(201).json(booking) — response sent BEFORE post-commit ops
  │
  └── Post-commit (async, non-blocking):
      ├── notifyAllStaff(title, message, 'booking', { relatedId, sendPush: true })
      ├── bookingEvents.publish('booking_created', data, { notifyMember: false })
      ├── broadcastAvailabilityUpdate({ resourceId, resourceType, date, action: 'booked' })
      └── UPDATE users SET first_booking_at, onboarding_completed_at (if applicable)
```

## Approve Booking

**Route**: `PUT /api/booking-requests/:id` (with `status: 'approved'`)
**File**: `server/routes/bays/approval.ts`

```
PUT /api/booking-requests/:id { status: 'approved', resource_id, staff_notes, ... }
  ├── Middleware: isStaffOrAdmin
  │
  ├── Validate trackman_booking_id format (must be numeric, no UUIDs)
  ├── Check for duplicate trackman_booking_id on other bookings
  │
  ├── db.transaction(async (tx) => {
  │   ├── SELECT booking request (tx)
  │   ├── Require assignedBayId (resource_id || existing resourceId)
  │   │
  │   ├── Conflict detection within transaction:
  │   │   ├── SELECT from booking_requests for time overlaps (approved/confirmed/attended)
  │   │   ├── checkClosureConflict(assignedBayId, requestDate, startTime, endTime)
  │   │   └── checkAvailabilityBlockConflict(assignedBayId, requestDate, startTime, endTime)
  │   │
  │   ├── Create Google Calendar event:
  │   │   ├── getCalendarNameForBayAsync(assignedBayId) → calendarName
  │   │   ├── getCalendarIdByName(calendarName) → calendarId
  │   │   └── createCalendarEventOnCalendar(calendarId, summary, description, date, start, end)
  │   │
  │   ├── Determine finalStatus:
  │   │   ├── conference_room → 'attended'
  │   │   └── simulator → 'approved'
  │   │
  │   ├── If pending_trackman_sync && !trackman_booking_id:
  │   │   └── Append '[PENDING_TRACKMAN_SYNC]' to staff_notes
  │   │
  │   ├── UPDATE booking_requests SET status, resourceId, staffNotes, calendarEventId, ...
  │   │
  │   ├── Session creation (if no existing session):
  │   │   ├── Resolve ownerUserId from email
  │   │   ├── Build participants array (owner + request_participants)
  │   │   │   ├── Deduplicate by userId and email
  │   │   │   ├── Resolve guest-type participants who match existing users → convert to member
  │   │   │   └── Resolve names for userId-only participants
  │   │   │
  │   │   └── createSessionWithUsageTracking({
  │   │       ownerEmail, resourceId, sessionDate, startTime, endTime,
  │   │       durationMinutes, participants, trackmanBookingId, declaredPlayerCount,
  │   │       bookingId  // enables hold-to-usage conversion
  │   │     }, 'member_request', tx)
  │   │
  │   ├── Link session: UPDATE booking_requests SET session_id = createdSessionId
  │   │
  │   ├── recalculateSessionFees(createdSessionId, 'approval')
  │   │   └── Returns { totals: { totalCents, overageCents, guestCents } }
  │   │
  │   └── If totalCents > 0:
  │       └── createPrepaymentIntent({ bookingId, memberEmail, totalCents, ... })
  │   })
  │
  ├── Post-transaction:
  │   ├── linkAndNotifyParticipants(bookingId, ...) — send invites to participants
  │   ├── Notify member: push notification, WebSocket, email
  │   ├── bookingEvents.publish('booking_approved', data)
  │   ├── broadcastAvailabilityUpdate(...)
  │   └── broadcastMemberStatsUpdated(memberEmail), broadcastBillingUpdate(memberEmail)
```

## Cancel Booking (Member)

**Route**: `PUT /api/booking-requests/:id/member-cancel`
**File**: `server/routes/bays/bookings.ts`

```
PUT /api/booking-requests/:id/member-cancel
  ├── Validate ownership:
  │   ├── Check session email matches booking email
  │   ├── Check admin/staff acting-as (acting_as_email in body)
  │   └── Check linked emails (trackman_email, linked_emails, manually_linked_emails)
  │
  ├── Verify booking not already cancelled
  │
  ├── UPDATE booking_requests SET status = 'cancelled'
  │
  ├── Release guest pass holds: releaseGuestPassHold(bookingId)
  │
  ├── Cancel pending Stripe payment intents:
  │   └── SELECT from stripe_payment_intents WHERE booking_id AND status IN ('pending', ...)
  │       └── cancelPaymentIntent(stripePaymentIntentId) for each
  │
  ├── Delete Google Calendar event:
  │   └── deleteCalendarEvent(calendarEventId)
  │
  ├── bookingEvents.publish('booking_cancelled', data, { cleanupNotifications: true })
  └── broadcastAvailabilityUpdate({ action: 'cancelled' })
```

## Cancel Booking (Trackman Webhook)

**Function**: `cancelBookingByTrackmanId(trackmanBookingId)`
**File**: `server/routes/trackman/webhook-update.ts` (split from `webhook-handlers.ts` in v8.87.59)

```
cancelBookingByTrackmanId(trackmanBookingId)
  ├── SELECT booking by trackman_booking_id
  │
  ├── If already cancelled: return { cancelled: true }
  │
  ├── Detect wasPendingCancellation (status === 'cancellation_pending')
  │
  ├── Delegate to BookingStateService:
  │   ├── If wasPendingCancellation:
  │   │   └── BookingStateService.completePendingCancellation({ bookingId, staffEmail: 'trackman-webhook@system', source: 'trackman_webhook' })
  │   └── Else:
  │       └── BookingStateService.cancelBooking({ bookingId, source: 'trackman_webhook', staffNotes: '[Cancelled via Trackman webhook]' })
  │
  ├── BookingStateService handles side effects via manifest:
  │   ├── Refund paid Stripe payment intents (stripe.refunds.create)
  │   ├── Cancel pending Stripe payment intents
  │   ├── Refund balance payments (credit balance restoration)
  │   ├── Void booking invoice via voidBookingInvoice(bookingId)
  │   ├── Delete Google Calendar event
  │   ├── Release guest pass holds
  │   ├── Notify staff and member (push + WebSocket)
  │   ├── Publish booking_cancelled event
  │   └── broadcastAvailabilityUpdate({ action: 'cancelled' })
  │
  └── Return { cancelled: true, bookingId, wasPendingCancellation }
```

## Session Creation (Core)

**Function**: `createSessionWithUsageTracking(request, source, externalTx?)`
**File**: `server/core/bookingService/sessionManager.ts`

```
createSessionWithUsageTracking(request: OrchestratedSessionRequest, source, externalTx?)
  │
  ├── Pre-transaction validation:
  │   ├── getMemberTier(ownerEmail) → ownerTier
  │   ├── enforceSocialTierRules(ownerTier, participants)
  │   │   └── If Social tier + guests → return { success: false, errorType: 'social_tier_blocked' }
  │   │
  │   ├── resolveUserIdToEmail(userId) for each participant → userIdToEmail map
  │   │
  │   └── calculateFullSessionBilling(sessionDate, durationMinutes, billingParticipants,
  │         ownerEmail, declaredPlayerCount, { resourceType })
  │       → billingResult { billingBreakdown, totalOverageFees, totalGuestFees, guestPassesUsed }
  │
  ├── Execute DB writes (in transaction):
  │   ├── findOverlappingSession(resourceId, sessionDate, startTime, endTime)
  │   │   └── Uses tsrange overlap: '[)' && '[)' on (session_date + time)::timestamp
  │   │
  │   ├── If overlapping session found:
  │   │   └── linkParticipants(existingSession.id, participants, tx)
  │   ├── Else:
  │   │   └── createSession({ resourceId, sessionDate, startTime, endTime, trackmanBookingId, createdBy }, participants, source, tx)
  │   │
  │   ├── Record usage ledger (for each billing entry):
  │   │   ├── Guest: recordUsage(sessionId, { memberId: ownerEmail, minutesCharged: 0, guestFee, ... })
  │   │   └── Member/Owner: recordUsage(sessionId, { memberId: email, minutesCharged, overageFee, ... })
  │   │
  │   └── Deduct guest passes (if guestPassesUsed > 0):
  │       ├── Path 1 (has bookingId): Convert holds to usage
  │       │   ├── SELECT guest_pass_holds FOR UPDATE
  │       │   ├── SELECT guest_passes FOR UPDATE → verify sufficient passes
  │       │   ├── UPDATE guest_passes SET passes_used += passesToConvert
  │       │   └── DELETE FROM guest_pass_holds WHERE booking_id
  │       └── Path 2 (no holds): Direct atomic deduction
  │           ├── SELECT guest_passes FOR UPDATE → verify sufficient passes
  │           └── UPDATE guest_passes SET passes_used += passesNeeded
  │
  └── Return { success, session, participants, usageLedgerEntries }
```

## Ensure Session For Booking (Idempotent)

**Function**: `ensureSessionForBooking(params)`
**File**: `server/core/bookingService/sessionManager.ts`

Uses a 4-step lookup chain to find or create a session, guaranteeing idempotency. Each step narrows the search; the first match wins.

```
ensureSessionForBooking({ bookingId, resourceId, sessionDate, startTime, endTime,
                          ownerEmail, ownerName?, ownerUserId?, trackmanBookingId?,
                          source, createdBy })
  │
  ├── Step 1: Match by trackman_booking_id (if provided)
  │   └── SELECT id FROM booking_sessions WHERE trackman_booking_id = $1
  │
  ├── Step 2: Exact match by resource + date + start time
  │   └── SELECT id FROM booking_sessions WHERE resource_id = $1 AND session_date = $2 AND start_time = $3
  │
  ├── Step 3: Overlap match using Postgres tsrange
  │   └── SELECT id FROM booking_sessions WHERE resource_id = $1 AND session_date = $2
  │       AND tsrange((session_date + start_time)::timestamp, (session_date + end_time)::timestamp, '[)')
  │       && tsrange(($2::date + $3::time)::timestamp, ($2::date + $4::time)::timestamp, '[)')
  │
  ├── Step 4: No match found → INSERT new session
  │   └── INSERT INTO booking_sessions (...) ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL
  │       DO UPDATE SET updated_at = NOW() RETURNING id
  │
  ├── Ensure owner participant exists:
  │   └── If no 'owner' participant on session → INSERT into booking_participants
  │
  ├── Link booking to session:
  │   └── UPDATE booking_requests SET session_id = $1 WHERE id = $2
  │
  ├── Transaction-aware mode (v8.87.28):
  │   └── Pass createTxQueryClient(tx) as externalTx to run all SQL inside the caller's transaction
  │       Used by: manualBooking.ts, webhook-matching.ts (Trackman auto-approve)
  │
  ├── Retry logic (when not inside an external transaction):
  │   ├── First attempt fails → wait 500ms, retry once
  │   └── Retry also fails → flag booking for staff review:
  │       └── UPDATE booking_requests SET staff_notes += '[SESSION_CREATION_FAILED] ... : {truncated error} ...'
  │       └── Return { sessionId: 0, created: false, error }
  │
  └── Return { sessionId, created: true/false }
```

## Tier Validation Rules

**File**: `server/core/bookingService/tierRules.ts`

This module enforces membership tier restrictions during booking and session creation. It validates daily minute limits, handles overage calculations, and enforces Social tier guest restrictions.

### Key Functions

#### `validateTierWindowAndBalance(memberEmail, bookingDate, duration, resourceType)`

Checks if a booking fits within the member's tier daily limits.

```
Returns TierValidationResult {
  allowed: boolean;           // true if booking is allowed
  reason?: string;            // error message if not allowed
  remainingMinutes?: number;  // minutes left in daily allowance
  overageMinutes?: number;    // minutes that would be overage
  includedMinutes?: number;   // tier's daily included minutes
  tier?: string;              // member's tier name
}
```

Processes:
1. Fetch member's tier via `getMemberTierByEmail()`
2. Get tier daily limits (e.g., `daily_sim_minutes` for simulators, `daily_conf_room_minutes` for conference rooms)
3. Query booked minutes today via `getDailyBookedMinutes(memberEmail, date, resourceType)`
4. Calculate remaining via `dailyLimit - bookedToday`
5. If overage would occur, set `overageMinutes = bookingDuration - remainingMinutes`

#### `getRemainingMinutes(memberEmail, tier?, date?, resourceType?)`

Quick lookup of remaining daily minutes for a member. Returns 0 if no tier, 999 if unlimited access. Queries `getDailyBookedMinutes` and subtracts from tier limit.

#### `enforceSocialTierRules(ownerTier, participants)`

Validates Social tier restrictions before session creation.

```
Returns SocialTierResult {
  allowed: boolean;   // true if guests allowed
  reason?: string;    // error message if not allowed
}
```

Behavior:
- **Non-Social tiers**: Always allowed; can have guests.
- **Social tier with `guest_passes_per_month > 0`**: Allowed; member can use their allocated passes.
- **Social tier with `guest_passes_per_month = 0`**: Check `participants` array. If any `type: 'guest'` found → **blocked** with error `"Social tier members cannot bring guests to simulator bookings. Your membership includes 0 guest passes per month."`.
- **Social tier with `guest_passes_per_month > 0` and has guests**: Allowed (pass allocation checked separately during session creation).

Example from session creation:
```
enforceSocialTierRules(ownerTier, participants)
├── If Social tier + 0 guest passes + guests in participants → { allowed: false }
└── Else → { allowed: true }
```

#### `getGuestPassesRemaining(memberEmail)`

Counts guest passes used this calendar month and returns remaining balance.

Query:
1. Find all sessions in current calendar month where:
   - Member is the owner (participant_type = 'owner')
   - Booking not cancelled/declined
   - Participant used a guest pass (`participant_type = 'guest'` AND `used_guest_pass = true`)
2. Subtract used from tier's `guest_passes_per_month`

### Daily Minute Limits by Tier

Each tier in `membership_tiers` table has:

| Column | Purpose |
|--------|---------|
| `daily_sim_minutes` | Daily simulator session limit (e.g., 240 = 4 hours) |
| `daily_conf_room_minutes` | Daily conference room limit |
| `unlimited_access` | Boolean flag: if true, no daily limits apply |

Tiers with `unlimited_access = true` or `daily_sim_minutes >= 999` return remaining = 999.

### Overage Minute Calculation

During booking request creation (conference rooms):

```
bookedMinutes = getDailyBookedMinutes(userEmail, date, 'conference_room')
remainingToday = tier.daily_conf_room_minutes - bookedMinutes

if (newBookingDuration > remainingToday) {
  overageMinutes = newBookingDuration - remainingToday
  overageCents = calculateOverageCents(overageMinutes)
  // Overage fees are captured via draft invoice (same flow as simulators since v8.16.0)
}
```

Overage fees are applied per-block (e.g., 30-minute block = one tier's overage rate) or pro-rated. Calculation done by `feeCalculator` module using tier `overage_rate_cents_per_minute`.

## Booking Statuses Reference

| Status | Meaning |
|---|---|
| `pending` | Submitted by member, awaiting staff review |
| `pending_approval` | Variant of pending (used in some flows) |
| `approved` | Staff approved, session created |
| `confirmed` | Auto-confirmed (conference rooms) |
| `attended` | Checked in by staff or auto-completed after 24h |
| `checked_in` | Legacy status (backward compatible, mapped to attended) |
| `declined` | Staff declined the request |
| `cancelled` | Cancelled by member or system |
| `cancellation_pending` | Member requested cancel, awaiting Trackman sync |
| `no_show` | Member did not attend |

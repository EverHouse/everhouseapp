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
  ├── Conference room overage check:
  │   ├── getMemberTierByEmail(userEmail) → tierName
  │   ├── getTierLimits(tierName) → dailyAllowance
  │   ├── getDailyBookedMinutes(userEmail, date, 'conference_room') → usedToday
  │   ├── calculateOverageCents(overageMinutes) → totalCents
  │   └── If totalCents > 0: require conference_prepayment_id, validate prepayment
  │
  ├── BEGIN transaction (raw pg client)
  │   ├── INSERT INTO booking_requests (...) RETURNING *
  │   ├── If guests > 0: createGuestPassHold(email, bookingId, guestCount, client)
  │   └── If conference room + prepayment: UPDATE conference_prepayments SET booking_id
  ├── COMMIT
  │
  ├── If conference_room + resourceId:
  │   └── ensureSessionForBooking({ bookingId, resourceId, sessionDate, ... })
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
**File**: `server/routes/trackman/webhook-handlers.ts`

```
cancelBookingByTrackmanId(trackmanBookingId)
  ├── SELECT booking by trackman_booking_id
  │
  ├── If is_relocating=true:
  │   ├── Clear trackman_booking_id (unlink so webhook doesn't interfere)
  │   └── Return { cancelled: false } — skip cancellation during reschedule
  │
  ├── If already cancelled: return { cancelled: true }
  │
  ├── UPDATE booking_requests SET status='cancelled', staff_notes += '[Cancelled via Trackman webhook]'
  │
  ├── Clear pending fees on session:
  │   └── UPDATE booking_participants SET cached_fee_cents=0, payment_status='waived'
  │       WHERE session_id AND payment_status='pending'
  │
  ├── Cancel pending payment intents (same as member cancel flow)
  │
  ├── Refund paid participant fees:
  │   ├── SELECT booking_participants WHERE payment_status='paid' AND stripe_payment_intent_id
  │   ├── For each: stripe.refunds.create({ charge, reason: 'requested_by_customer' })
  │   └── UPDATE booking_participants SET refunded_at, payment_status='waived'
  │   └── UPDATE stripe_payment_intents SET status='refunded'
  │   └── UPDATE booking_fee_snapshots SET status='refunded'
  │
  ├── refundGuestPassesForCancelledBooking(bookingId, memberEmail)
  │
  ├── notifyAllStaff('Booking Cancelled via TrackMan', message)
  ├── logSystemAction({ action: 'booking_cancelled_webhook', ... })
  ├── If wasPendingCancellation: notifyMember({ title: 'Booking Cancelled', ... })
  └── broadcastAvailabilityUpdate({ action: 'cancelled' })
```

## Reschedule Booking

**Routes**: `server/routes/bays/reschedule.ts`

```
POST /api/admin/booking/:id/reschedule/start
  ├── Middleware: isStaffOrAdmin
  ├── Validate booking exists and not cancelled
  ├── Validate booking is not in the past
  └── UPDATE booking_requests SET is_relocating=true, relocating_started_at=NOW()

POST /api/admin/booking/:id/reschedule/confirm
  ├── Middleware: isStaffOrAdmin
  ├── Required body: resource_id, request_date, start_time, end_time, duration_minutes, trackman_booking_id
  ├── Validate booking exists, not cancelled, is_relocating=true
  │
  ├── Conflict checks:
  │   ├── SELECT booking_requests for time overlaps on new slot
  │   ├── checkClosureConflict(resource_id, request_date, start_time, end_time)
  │   └── checkAvailabilityBlockConflict(resource_id, request_date, start_time, end_time)
  │
  ├── BEGIN transaction
  │   ├── UPDATE booking_requests SET resource_id, request_date, start_time, end_time,
  │   │     duration_minutes, trackman_booking_id, is_relocating=false,
  │   │     original_resource_id, original_start_time, original_end_time, original_booked_date
  │   │
  │   └── If session exists:
  │       └── UPDATE booking_sessions SET resource_id, session_date, start_time, end_time, trackman_booking_id
  ├── COMMIT
  │
  ├── If session exists: recalculateSessionFees(sessionId, 'reschedule')
  ├── sendBookingRescheduleEmail(memberEmail, ...)
  ├── broadcastAvailabilityUpdate (old slot freed, new slot booked)
  └── logFromRequest(req, 'booking_rescheduled', ...)

POST /api/admin/booking/:id/reschedule/cancel
  ├── Middleware: isStaffOrAdmin
  └── UPDATE booking_requests SET is_relocating=false, relocating_started_at=NULL
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
  ├── Retry logic (when not inside an external transaction):
  │   ├── First attempt fails → wait 500ms, retry once
  │   └── Retry also fails → flag booking for staff review:
  │       └── UPDATE booking_requests SET staff_notes += '[SESSION_CREATION_FAILED] ...'
  │       └── Return { sessionId: 0, created: false, error }
  │
  └── Return { sessionId, created: true/false }
```

## Booking Statuses Reference

| Status | Meaning |
|---|---|
| `pending` | Submitted by member, awaiting staff review |
| `pending_approval` | Variant of pending (used in some flows) |
| `approved` | Staff approved, session created |
| `confirmed` | Auto-confirmed (conference rooms) |
| `attended` | Checked in / completed |
| `checked_in` | Marked as checked in by staff |
| `declined` | Staff declined the request |
| `cancelled` | Cancelled by member or system |
| `cancellation_pending` | Member requested cancel, awaiting Trackman sync |
| `no_show` | Member did not attend |

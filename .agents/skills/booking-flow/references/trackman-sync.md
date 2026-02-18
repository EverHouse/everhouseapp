# Trackman Sync: Webhooks, CSV Import, Reconciliation, and Delta Billing

How Trackman data flows into the booking system, how bookings are matched/created, and how billing adjustments work.

## Webhook Flow

**Entry point**: Trackman sends webhook payloads to the app. Handlers are in `server/routes/trackman/webhook-handlers.ts` and `server/routes/trackman/webhook-billing.ts`.

### Webhook Matching Pipeline

When a Trackman webhook arrives with booking data:

```
Webhook payload arrives
  ├── normalizeBookingFields() → extract date, startTime, endTime, resourceId, email, playerCount
  ├── mapBayNameToResourceId() → resolve bay name to resource_id
  ├── resolveLinkedEmail() → check trackman_email, linked_emails, manually_linked_emails
  │
  ├── Step 1: Check if trackman_booking_id already linked
  │   └── linkByExternalBookingId(trackmanBookingId) → if found, update existing booking
  │
  ├── Step 2: Try auto-approve pending booking
  │   └── tryAutoApproveBooking(email, date, startTime, trackmanBookingId)
  │       ├── Match criteria:
  │       │   ├── LOWER(user_email) = LOWER(customerEmail)
  │       │   ├── request_date = slotDate
  │       │   ├── |start_time - webhookStartTime| <= 600 seconds (±10 min)
  │       │   ├── status = 'pending'
  │       │   └── trackman_booking_id IS NULL (not already linked)
  │       │
  │       ├── On match:
  │       │   ├── UPDATE booking_requests SET status='approved', trackman_booking_id, reviewed_by='trackman_webhook'
  │       │   └── ensureSessionForBooking({ bookingId, resourceId, ..., source: 'trackman_webhook' })
  │       │       └── If session creation fails → revert to status='pending'
  │       │
  │       └── On no match: continue to Step 3
  │
  ├── Step 3: Try match to existing booking (approved or PENDING_TRACKMAN_SYNC)
  │   └── createBookingForMember(member, trackmanBookingId, slotDate, startTime, endTime, resourceId, playerCount)
  │       ├── Check existing booking with same trackman_booking_id → update duration if changed
  │       ├── Match criteria for pending sync:
  │       │   ├── LOWER(user_email) matches
  │       │   ├── request_date matches
  │       │   ├── resource_id matches (OR resource_id IS NULL)
  │       │   ├── |start_time diff| <= 600 seconds
  │       │   ├── status IN ('approved', 'pending')
  │       │   ├── trackman_booking_id IS NULL
  │       │   ├── Prefer staff_notes LIKE '%[PENDING_TRACKMAN_SYNC]%'
  │       │   └── Secondary sort: exact resource match, closest time, most recent
  │       │
  │       ├── On match:
  │       │   ├── UPDATE booking_requests SET trackman_booking_id, status='approved', was_auto_linked=true
  │       │   ├── Replace '[PENDING_TRACKMAN_SYNC]' → '[Linked via Trackman webhook]'
  │       │   ├── If time tolerance: append '[Time adjusted: original → trackman]'
  │       │   └── If session exists → update session trackman_booking_id
  │       │
  │       └── On no match: create new booking_requests row
  │
  └── Step 4: If no match found anywhere
      └── saveToUnmatchedBookings(trackmanBookingId, slotDate, startTime, endTime, resourceId, email, name, playerCount)
          └── INSERT/UPDATE trackman_unmatched_bookings for staff review
```

### Webhook Cancellation

```
cancelBookingByTrackmanId(trackmanBookingId)
  ├── Find booking by trackman_booking_id
  ├── Guard: if is_relocating=true → unlink trackman_booking_id, skip cancellation
  ├── UPDATE status='cancelled'
  ├── Clear pending fees on booking_participants
  ├── Cancel pending Stripe payment intents
  ├── Refund paid participant fees (stripe.refunds.create)
  ├── refundGuestPassesForCancelledBooking()
  ├── Notify staff and member
  └── broadcastAvailabilityUpdate({ action: 'cancelled' })
```

### Delta Billing on Duration Change

When Trackman reports a different duration than what was originally booked:

```
createBookingForMember() detects duration change
  ├── Old duration ≠ new duration
  ├── UPDATE booking_requests SET start_time, end_time, duration_minutes
  ├── If session exists:
  │   ├── UPDATE booking_sessions SET start_time, end_time
  │   └── recalculateSessionFees(sessionId, 'trackman_webhook')
  │       ├── computeFeeBreakdown() with new duration
  │       ├── Update booking_participants.cached_fee_cents
  │       └── Return new totals for potential additional charge or refund
  └── Return { success: true, bookingId, updated: true }
```

### Bay Slot Cache

`updateBaySlotCache()` maintains the `trackman_bay_slots` table as a fast lookup for current bay status:

- Upsert on `(resource_id, slot_date, start_time, trackman_booking_id)`
- Tracks: status (`booked` / `cancelled` / `completed`), customer email/name, player count

## CSV Import

**Entry point**: `server/core/trackmanImport.ts`

The CSV import handles bulk Trackman booking data. For CSV parsing rules (field mapping, notes format, placeholder emails), refer to the `booking-import-standards` skill.

### Import Matching Pipeline

```
For each TrackmanRow in CSV:
  ├── Skip placeholder emails (anonymous@yourgolfbooking.com, booking@evenhouse.club, etc.)
  ├── parseNotesForPlayers(notes) → ParsedPlayer[] { type, email, name }
  │   ├── New format: M|email|first|last or G|email|first|last (pipe-separated)
  │   └── Legacy format: M: email | Name or G: none | Name
  │
  ├── Map bay number → resource_id
  ├── resolveLinkedEmail() → find canonical member email
  │
  ├── Match to existing booking:
  │   ├── By trackman_booking_id (exact match)
  │   ├── By email + date + time tolerance (±10 min)
  │   └── By email + date + resource (PENDING_TRACKMAN_SYNC marker)
  │
  ├── If matched:
  │   ├── Update trackman_booking_id, trackman_player_count
  │   ├── Update times if different (delta billing via recalculateSessionFees)
  │   └── Link session if not yet linked
  │
  ├── If no match:
  │   ├── Create new booking_requests row (status: 'approved', source: 'trackman_import')
  │   ├── Create session and usage records
  │   └── cancelPendingPaymentIntentsForBooking() — clean up any orphaned intents
  │
  └── alertOnTrackmanImportIssues() — generate data alerts for staff review
```

### Golf Instructor Detection

`getGolfInstructorEmails()` fetches emails of active staff with `golf_instructor` role. During import, bookings by instructors are identified as lessons and handled differently (not charged as member bookings).

## Reconciliation

**File**: `server/core/bookingService/trackmanReconciliation.ts`

After bookings complete, reconciliation compares declared vs actual player counts.

### Finding Discrepancies

`findAttendanceDiscrepancies(options)` queries:

```sql
WHERE br.status = 'attended'
  AND br.trackman_booking_id IS NOT NULL
  AND br.trackman_player_count IS NOT NULL
  AND br.declared_player_count IS NOT NULL
  AND br.trackman_player_count != br.declared_player_count
```

Returns `ReconciliationResult[]` with:
- `discrepancy`: `'over_declared'` | `'under_declared'` | `'matched'`
- `discrepancyAmount`: absolute difference between declared and actual
- `requiresReview`: true when discrepancy exists
- `potentialFeeAdjustment`: calculated fee difference in dollars

### Fee Adjustment Calculation

`calculatePotentialFeeAdjustment(durationMinutes, declaredCount, actualCount, overageRatePer30Min)`:

```
If actualCount <= declaredCount → $0 (no adjustment)
additionalPlayers = actualCount - declaredCount
minutesPerPlayer = floor(durationMinutes / actualCount)
additionalMinutes = minutesPerPlayer × additionalPlayers
thirtyMinBlocks = ceil(additionalMinutes / 30)
adjustment = thirtyMinBlocks × overageRatePer30Min
```

The overage rate comes from `membership_tiers.guest_fee_cents` for the member's tier, falling back to `PRICING.OVERAGE_RATE_DOLLARS`.

### Reconciliation Statuses

| Status | Meaning |
|---|---|
| `null` / `pending` | Discrepancy detected, awaiting staff review |
| `reviewed` | Staff reviewed, no action needed |
| `adjusted` | Staff applied fee adjustment |

### Stats Aggregation

`ReconciliationStats` provides dashboard metrics:
- `totalDiscrepancies` — count of all mismatched bookings
- `pendingReview` — unreviewed discrepancies
- `reviewed` — reviewed without adjustment
- `adjusted` — reviewed with fee adjustment applied
- `totalPotentialFeeAdjustment` — sum of all potential adjustments

## Calendar Sync

Golf calendar sync (`server/core/calendar/sync/golf.ts`) is **deprecated** — bookings are done in-app only. The module returns immediately without performing any sync operations. Calendar events are still created per-booking during the approval flow via `createCalendarEventOnCalendar()` in the approval handler.

## Key Integration Points

- **Email resolution**: `resolveLinkedEmail()` checks `users.trackman_email`, `users.linked_emails` (JSONB), and `users.manually_linked_emails` (JSONB) to map Trackman emails to canonical member emails.
- **Idempotency**: `trackman_booking_id` uniqueness constraint prevents duplicate booking creation. The `AND trackman_booking_id IS NULL` guard in update queries prevents race conditions between concurrent webhook/import runs.
- **Session reuse**: `findOverlappingSession()` with `tsrange` overlap prevents duplicate sessions when Trackman times differ slightly from booked times.

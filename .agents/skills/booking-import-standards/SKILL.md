---
name: booking-import-standards
description: Mandatory rules for booking management, Trackman CSV import, billing sessions, cancellation flow, roster protection, and fee calculation in the Ever Club Members App. Use whenever creating or modifying booking endpoints, CSV import logic, billing/fee code, cancellation flows, roster/participant management, or Trackman webhook handlers. Triggers on trackman, CSV import, booking import, session creation, cancellation pending, roster lock, ensureSessionForBooking.
---

# Booking & Import Standards

Violating any of these rules has caused real data integrity issues in the past.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Session creation/linking | `server/core/bookingService/sessionManager.ts` | Any session creation code |
| CSV import | `server/core/trackmanImport.ts` | CSV parsing, member matching |
| Fee calculation | `server/core/billing/unifiedFeeService.ts` | Fee computation |
| Booking CRUD | `server/routes/bays/bookings.ts` | Member booking creation |
| Booking approval | `server/routes/bays/approval.ts` | Approval, prepayment |
| Conference booking | `server/routes/bays/staff-conference-booking.ts` | Staff conference room booking |
| Manual booking | `server/routes/staff/manualBooking.ts` | Staff manual booking |
| Check-in | `server/routes/staffCheckin.ts` | Check-in flow, session creation |
| Roster changes | `server/routes/roster.ts` | Roster edits, optimistic locking |
| Webhook handlers | `server/routes/trackman/webhook-handlers.ts` | Webhook booking updates |
| Webhook billing | `server/routes/trackman/webhook-billing.ts` | Session creation, fee recalc |
| Cancellation | `server/core/bookingService/bookingStateService.ts` | Centralized cancel with side-effects |
| Invoice lifecycle | `server/core/billing/bookingInvoiceService.ts` | Draft, sync, finalize, void |
| Roster service | `server/core/bookingService/rosterService.ts` | Roster changes with invoice lock |

## Decision Trees

### Creating a session — which path?

```
Does a session exist for this booking?
├── Check 1: Match by trackman_booking_id (exact)
├── Check 2: Match by resource_id + date + start_time (exact)
├── Check 3: Match by resource_id + date + time range overlap (tsrange)
├── Any match? → Link to existing session (don't create duplicate)
└── No match → INSERT new session (ON CONFLICT safety net)
```

### Cancelling a Trackman-linked booking

```
Has trackman_booking_id?
├── Yes → status = 'cancellation_pending' (NOT 'cancelled')
│   ├── Set cancellation_pending_at = NOW()
│   ├── Notify staff to cancel in Trackman first
│   └── Time slot stays OCCUPIED until Trackman confirms
└── No → Instant cancel to 'cancelled'
```

### Cancellation financial cleanup order

```
1. Refund Stripe charges (individual participant, not bulk)
   └── Before each refund, atomically CLAIM the PI: UPDATE status='refunding' WHERE status='succeeded'
       If rowCount=0, skip — another process already claimed it (v8.87.27)
   └── For direct refund paths, also check stripe_payment_intents for status IN ('refunding', 'refunded')
       to avoid double-refunding PIs already queued by voidBookingInvoice (v8.87.26)
   └── If refund succeeds but markPaymentRefunded fails → set refund_succeeded_sync_failed (v8.87.35)
2. After EACH successful refund → mark that participant 'refunded'
3. Clear fee snapshots, refund guest passes
4. Delete trackman_bay_slots (duration-aware range: startTime through startTime + durationMinutes at 30-min intervals) (v8.87.35)
5. THEN update status to 'cancelled'
6. THEN notify member
7. Persist any side-effect failures to failed_side_effects table for staff recovery (v8.87.35)
```

## Hard Rules

1. **Every booking MUST have a billing session.** Use `ensureSessionForBooking()` for ALL session creation. NEVER write raw `INSERT INTO booking_sessions`.
2. **All entry points covered.** Every code path that creates or approves a booking must call `ensureSessionForBooking()`. If you add a new entry point, it MUST call this function.
3. **`trackman_booking_id` is THE key.** Match Trackman bookings by this field only. NEVER match by name, time alone, or fuzzy criteria.
4. **Financial cleanup BEFORE status change.** Refund Stripe → mark participants → update status → notify. Prevents partial cancellation states.
5. **Individual refund status updates.** Update each participant's `payment_status` to `'refunded'` AFTER confirming its individual Stripe refund. NEVER bulk-update before confirming.
6. **Availability stays reserved during cancellation_pending.** Treat as occupied in ALL availability queries.
7. **Handle `cancellation_pending` in every booking status query.** Availability checks, active counts, payment guards, command center, member lists.
8. **Email-only member matching.** No name-based fallback. If email doesn't match, booking stays unmatched.
9. **Placeholder merging ±2 min tolerance.** Match by `resource_id`, `request_date`, `start_time` within ±2 min. Multiple candidates → SKIP (log for manual resolution).
10. **Force Approved on linked CSV bookings.** Set `status = 'approved'` for CSV imports linked to a member. Don't use Trackman's status.
11. **Parse both Notes formats.** `M|email|first|last` (pipe) and `M: email | Name` (colon). Also parse inline `G: Name` guest tags anywhere in the line.
12. **Immediately populate `booking_participants`.** Owner at slot 1, guests at slots 2-4. `booking_participants` is the sole roster table (legacy tables deprecated v7.92.0).
13. **Optimistic locking with `roster_version`.** `SELECT FOR UPDATE` → compare version → perform change → increment version.
14. **Fee calculation is post-commit.** `recalculateSessionFees()` uses global `db` pool. NEVER call inside `db.transaction()`.
15. **Duration uses `GREATEST(session, booking)`.** Always use the longer to avoid undercharging.
16. **Empty slots generate guest fee line items.** Dollar amounts from Stripe prices, never hardcoded.
17. **Outstanding balance queries MUST filter:** (a) 90-day lookback, (b) exclude cancelled/declined bookings, (c) exclude completed/paid snapshots.
18. **One Stripe invoice per booking.** Draft at approval → sync on roster changes → finalize at payment → void on cancel.
19. **`FOR UPDATE` queries MUST use `ORDER BY id ASC`.** Multi-row `FOR UPDATE` without consistent ordering causes PostgreSQL deadlocks. Applied in `manualBooking.ts` and `payments.ts`.
20. **Roster lock after paid invoice.** `enforceRosterLock()` blocks edits. Staff override with reason. `isBookingInvoicePaid()` checks Stripe first; on Stripe failure, falls back to `booking_fee_snapshots` (locks only if completed snapshot with `total_cents > 0` — real money collected). If both Stripe and DB fallback fail, locks as a precaution. Staff check-in direct-add path bypasses roster lock entirely (correct — staff need to add walk-in guests).
21. **Auto-complete runs every 1 hr.** Marks approved/confirmed as `attended` 30 min after end time (same-day) or next day (overnight). Fee guard blocks if unpaid fees exist.
22. **Terminal status MUST clear `is_unmatched`.** Three defense layers: DB trigger, application code, scheduler safety net.
23. **Drizzle SQL null safety.** All optional values in `sql` template literals MUST use `?? null`. Prevents empty placeholder syntax errors.
24. **Session lookup must NOT filter by booking status.** Cancelled bookings may share sessions. Filtering causes unique constraint violations.
25. **Stuck cancellation safety net.** Scheduler runs every 2 hr, alerts staff about bookings in `cancellation_pending` for 4+ hours.

26. **Notifications via `notifyMember()` / `notifyAllStaff()` only (v8.87.28).** NEVER insert directly into the `notifications` table from booking files. Use `notifyMember()` for member notifications and `notifyAllStaff()` for staff-wide notifications from `server/core/notificationService.ts`. These handle in-app DB insert, WebSocket broadcast, and push notification delivery in a single call.
27. **Trackman service uses structured logger (v8.87.28).** NEVER use `process.stderr.write` in `server/core/trackman/service.ts`. All logging uses `logger.info/warn/error` with structured metadata.
28. **Wallet pass hooks on Trackman import changes (v8.87.13).** When a Trackman import updates a booking's time, duration, or bay assignment, call `refreshBookingPass(bookingId)` to regenerate the Apple Wallet pass with updated details. When a Trackman import cancels a booking, call `voidBookingPass(bookingId)` to invalidate the pass. Both are fire-and-forget (`.catch(err => logger.error(...))`). Import from `../../walletPass/bookingPassService`.

## Anti-Patterns (NEVER)

1. NEVER write `INSERT INTO booking_sessions` outside `ensureSessionForBooking()`.
2. NEVER match Trackman bookings by name or fuzzy time matching.
3. NEVER bulk-update participant payment_status before confirming individual refunds.
4. NEVER call `recalculateSessionFees()` inside a `db.transaction()`.
5. NEVER skip `syncBookingInvoice()` after fee recalculation when a Stripe invoice exists.
6. NEVER create separate roster editors — use the Unified Booking Sheet.
7. NEVER refund guest passes from `tryLinkCancelledBooking` — cancellation workflows handle their own refunds.
8. NEVER pass `undefined` to Drizzle `sql` template literals — use `?? null`.
9. NEVER filter session lookups by booking status — sessions can be shared across bookings including cancelled ones.
10. NEVER call `recalculateSessionFees()` without calling `invalidateCachedFees()` first — stale cached fees cause the recalculation to skip participants, producing incorrect fee totals.
11. NEVER add a member to a booking without calling `findConflictingBookings()` first — applies to both member-facing `addParticipant` and staff-facing link-member endpoints.
12. NEVER insert directly into `notifications` table from booking code — use `notifyMember()` or `notifyAllStaff()`.
13. NEVER use `process.stderr.write` in Trackman service — use structured `logger.*` calls.
14. NEVER ignore `ensureSessionForBooking()` return value — always check `sessionResult.error` and log/throw on failure. The function returns `{error}` for validation failures (missing time, invalid format, zero duration) instead of throwing (v8.87.31).
15. NEVER ignore `refundGuestPass()` return value — always check `refundResult.success`. The function returns `{success: false}` on failure instead of throwing, so catch blocks alone are dead code (v8.87.31).
16. NEVER assume Trackman bay slot cleanup only needs to delete a single slot — multi-slot bookings require duration-aware range DELETE covering `startTime` through `startTime + durationMinutes` at 30-min intervals (v8.87.35).
17. NEVER silently discard cancellation side-effect failures — persist to `failed_side_effects` table for staff recovery (v8.87.35).

## Cross-References

- **Booking lifecycle** → `booking-flow` skill
- **Fee calculation details** → `fee-calculation` skill
- **Check-in billing** → `checkin-flow` skill
- **Guest pass lifecycle** → `guest-pass-system` skill
- **Stripe invoice handling** → `stripe-webhook-flow` skill
- **Apple Wallet booking passes** → `booking-flow` skill (wallet pass lifecycle section)
- **Unified Booking Sheet** → `project-architecture` skill

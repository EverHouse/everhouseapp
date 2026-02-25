---
name: booking-import-standards
description: Mandatory rules for booking management, Trackman CSV import, billing sessions, cancellation flow, roster protection, and fee calculation in the Ever Club Members App. Use whenever creating or modifying booking endpoints, CSV import logic, billing/fee code, cancellation flows, or roster/participant management.
---

# Booking & Import Standards

Follow these rules whenever touching booking, import, billing, or cancellation code. Violating any of these rules has caused real data integrity issues in the past.

## Key Files

- `server/core/bookingService/sessionManager.ts` — `ensureSessionForBooking()`, `createSession()`, `linkParticipants()`
- `server/core/trackmanImport.ts` — CSV import, placeholder merging, Notes parsing
- `server/core/billing/unifiedFeeService.ts` — `computeFeeBreakdown()`, fee line items
- `server/routes/bays/bookings.ts` — Booking CRUD, member booking creation
- `server/routes/bays/approval.ts` — Approval, prepayment creation
- `server/routes/bays/reschedule.ts` — Reschedule flow (start, confirm, cancel)
- `server/routes/bays/staff-conference-booking.ts` — Staff conference room booking
- `server/routes/staff/manualBooking.ts` — Staff manual booking creation
- `server/routes/staffCheckin.ts` — Staff check-in flow, session creation at check-in
- `server/routes/roster.ts` — Roster changes, optimistic locking
- `server/routes/trackman/webhook-handlers.ts` — Webhook booking updates
- `server/routes/trackman/webhook-billing.ts` — Webhook billing, session creation, fee recalculation
- `server/routes/dataTools.ts` — Data tools, backfill, session repair
- `server/routes/resources.ts` — Resource management, session linking
- `server/core/calendar/sync/conference-room.ts` — Conference room calendar sync, auto-session creation
- `server/core/visitors/autoMatchService.ts` — Visitor auto-match, session linking
- `server/schedulers/stuckCancellationScheduler.ts` — Safety net for stuck cancellations
- `server/core/billing/bookingInvoiceService.ts` — Invoice lifecycle: draft, sync, finalize, void
- `server/core/bookingService/rosterService.ts` — Roster changes with invoice-paid lock guard

---

## Section 1: Session Safety

### Rule 1 — Every booking MUST have a billing session

Use `ensureSessionForBooking()` from `sessionManager.ts` for ALL session creation. It implements a 3-step lookup chain:
1. Match by `trackman_booking_id` (exact)
2. Match by `resource_id + session_date + start_time` (exact)
3. Match by `resource_id + session_date + time range overlap` (tsrange intersection)

Only INSERT if all 3 lookups fail. The INSERT uses `ON CONFLICT (trackman_booking_id)` to handle race conditions. On failure, write `[SESSION_CREATION_FAILED]` to the booking's `staff_notes`. When called with a `client` (transaction), throw immediately on failure (no retry). The 500ms retry only applies when using the default pool connection.

**NEVER** write raw `INSERT INTO booking_sessions` anywhere outside this function. Every entry point that creates or links a booking must call `ensureSessionForBooking()`.

### Rule 1a — Overlap detection prevents double-booking trigger failures

The `booking_sessions` table has a `prevent_booking_session_overlap` trigger that rejects INSERTs when time ranges overlap on the same bay. The 3-step lookup in `ensureSessionForBooking()` handles this by finding overlapping sessions BEFORE attempting INSERT. If an overlapping session exists (different Trackman ID but overlapping time), link the booking to that existing session. The booking keeps its own `trackman_booking_id` in `booking_requests` — only `session_id` is shared.

### Rule 1b — Backfill endpoint error handling

The backfill endpoint (`POST /api/admin/backfill-sessions` in `server/routes/trackman/admin.ts`) uses savepoints per-booking so individual failures do not abort the entire transaction. When `ensureSessionForBooking` returns `sessionId: 0` with an error, roll back to the savepoint, record the error, and continue to the next booking.

### Rule 1c — Auto-complete prevents stale booking accumulation

The auto-complete scheduler (`bookingAutoCompleteScheduler.ts`, every 2h) marks approved/confirmed bookings as `attended` (auto checked-in) when 24h have passed since the booking end time. This assumes most members attended and prevents stale bookings from:
- Appearing in conflict detection (OCCUPIED_STATUSES includes `approved` and `confirmed`)
- Inflating active booking counts
- Causing false overlap warnings during CSV import
Staff can manually correct to `no_show` via the BookingStatusDropdown if needed.

CASCADE constraints on `wellness_enrollments.class_id → wellness_classes.id` and `booking_participants.session_id → booking_sessions.id` ensure orphan records are automatically cleaned up when parent records are deleted.

### Rule 2 — All entry points covered

Every code path that can create or approve a booking must call `ensureSessionForBooking()`:
- Member booking request approval (`server/routes/bays/approval.ts`)
- Staff manual booking (`server/routes/staff/manualBooking.ts`)
- Staff check-in flow (`server/routes/staffCheckin.ts`)
- Trackman webhook auto-create (`server/routes/trackman/webhook-handlers.ts`)
- Trackman webhook billing (`server/routes/trackman/webhook-billing.ts`)
- Trackman webhook index (`server/routes/trackman/webhook-index.ts`)
- CSV import — new bookings AND merged placeholders (`server/core/trackmanImport.ts`)
- Reschedule (`server/routes/bays/reschedule.ts`)
- Conference room calendar sync (`server/core/calendar/sync/conference-room.ts`)
- Data tools / backfill (`server/routes/dataTools.ts`)
- Resource management (`server/routes/resources.ts`)
- Auto-match service (`server/core/visitors/autoMatchService.ts`)
- Backfill admin endpoint (`server/routes/trackman/admin.ts`)

If you add a new entry point, it MUST call `ensureSessionForBooking()`.

---

## Section 2: Cancellation Flow

### Rule 3 — Trackman-linked bookings use cancellation_pending

When a member or staff cancels an approved simulator booking that has a `trackman_booking_id`:
1. Set status to `cancellation_pending` (NOT `cancelled`)
2. Set `cancellation_pending_at = NOW()`
3. Notify staff to cancel in Trackman first
4. Show member "Cancellation Pending — your request is being processed"

Non-Trackman bookings (conference rooms, etc.) keep instant cancel behavior.

### Rule 4 — Financial cleanup BEFORE status change

When completing a cancellation (via webhook or manual):
1. **First**: Refund Stripe charges, clear fee snapshots, refund guest passes
2. **First (continued)**: After each successful Stripe refund, call `PaymentStatusService.markPaymentRefunded()` to update the participant and payment records to `'refunded'`. Each participant's status update must only happen after its individual refund succeeds — never bulk-update all participants before confirming each refund. (v8.26.7, Bugs 12 & 15)
3. **Then**: Update status to `cancelled`
4. **Then**: Notify member

This ordering prevents partial cancellation states where the status changed but money was not returned.

### Rule 5 — Call cancelPendingPaymentIntentsForBooking()

When any booking is cancelled (CSV import cancellation path, regular cancellation, webhook cancellation), always call `cancelPendingPaymentIntentsForBooking(bookingId)` to clean up outstanding payment intents.

### Rule 6 — Availability stays reserved during cancellation_pending

Time slots remain occupied while a booking is in `cancellation_pending`. Availability queries must exclude both `approved` AND `cancellation_pending` slots to prevent double-booking.

**Soft lock extension**: The member-facing availability endpoint (`server/routes/availability.ts`) also reserves slots for `pending` and `pending_approval` booking requests on specific bays. This "soft lock" prevents members from requesting a bay/time that another member has already requested but not yet been approved. The requesting member's own pending bookings are excluded from the lock. See booking-flow skill Key Invariant #15.

### Rule 7 — Status filtering: cancellation_pending everywhere

Handle `cancellation_pending` status in every query that filters by booking status:
- Availability checks (treat as occupied)
- Active booking counts (include in active)
- Reschedule guards (block reschedule)
- Payment guards (block new payments)
- Command center views (show with special badge)
- Member booking lists (show with pending message)

When adding new booking queries, always ask: "Does this query need to handle cancellation_pending?"

### Rule 8 — Stuck cancellation safety net

`stuckCancellationScheduler.ts` runs every 2 hours:
- Find bookings in `cancellation_pending` for 4+ hours
- Deduplicate alerts (check if staff was already notified in the last 4 hours for each booking)
- Send summary notification to all staff
- Staff can use manual completion endpoint as fallback

---

## Section 3: CSV Import & Data Parsing

### Rule 8a — `trackman_booking_id` is THE key for all Trackman matching

The `trackman_booking_id` field (stored as VARCHAR on `booking_requests`, `booking_sessions`) is the **stable unique identifier** from Trackman. Use it for:
- CSV import deduplication: `ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO NOTHING`
- Webhook matching: `tryAutoApproveBooking()` matches by `trackman_booking_id`
- Session creation: `ensureSessionForBooking()` first checks `booking_sessions.trackman_booking_id`
- Ghost booking detection: CSV import checks if a ghost booking already exists with the same `trackman_booking_id` before creating a new one

**NEVER** match Trackman bookings by name, time alone, or other fuzzy criteria. `trackman_booking_id` is the only reliable key.

### Rule 8b — CSV Backfill Strategy: Update-then-Insert

The CSV import uses a strict **Update-first, Insert-second** strategy to prevent duplicates:

1. **Ghost match by `trackman_booking_id`**: Check if a booking already exists with this Trackman ID. If yes, UPDATE it (merge member data, update status, populate roster).
2. **Placeholder merge by time/resource (±2 min)**: Check if a webhook-created placeholder exists at the same bay/date/time. If yes, UPDATE it with the CSV data (Rule 12).
3. **Insert new**: Only if both checks fail, INSERT a new `booking_requests` row with `ON CONFLICT (trackman_booking_id) DO NOTHING` as a safety net.

This ordering guarantees no duplicate bookings for the same Trackman slot.

### Rule 9 — Parse member tags from Notes field

The CSV `Notes` field contains member identification strings in two formats:

**New pipe-separated format** (4 fields):
```
M|email|firstname|lastname
```

**Legacy colon format**:
```
M: email | Name
```

Parse both `M|email|firstname|lastname` and `M: email | Name` patterns to extract the member's email for matching. This is the primary source of member identity in the CSV data. Without parsing this, the system cannot link bookings to members.

### Rule 10 — Parse guest tags from Notes field (including INLINE tags)

The CSV `Notes` field also contains guest identification strings in two formats:

**New pipe-separated format**:
```
G|email|firstname|lastname
```

**Legacy colon format**:
```
G: Guest Name
```

Parse `G|...|firstname|lastname` and `G: name` tags to fill booking guest slots with actual guest names. This directly prevents Rule 17 (empty slot = guest fee) from incorrectly charging guest fees when a guest name was actually provided in the data.

**CRITICAL: Inline G: tags must also be parsed.** Guest tags often appear inline on the same line as the M: tag or within freeform text, NOT on their own line:
```
M: member@email.com | Member Name Guests pay separately G: Chris G: Alex G: Dalton NO additional charge.
```
The parser (`parseNotesForPlayers()`) MUST scan for `G: Name` patterns anywhere in the line, not just at line start (`^G:`). The regex uses a negative lookahead to stop name capture before the next `G:`, `M:`, `NO`, `Used`, or `additional` keyword.

### Rule 10a — Imported bookings must IMMEDIATELY populate booking_participants

When a Trackman CSV import identifies a member (via Notes parsing), immediately populate the `booking_participants` table:

1. **Owner at Slot 1**: Create a `booking_participants` record with `slot_number: 1`, `participant_type: 'owner'`, and the member's email.
2. **Guests at Slots 2-4**: For each parsed guest tag, create a `booking_participants` record at the next available slot with `participant_type: 'guest'` and the guest name.
3. **Session participants**: Call `createTrackmanSessionAndParticipants()` which creates the `booking_participants` records (the table the roster UI reads from).

Legacy tables `booking_members` and `booking_guests` no longer receive writes (v7.92.0). `booking_participants` is the sole source of truth for rosters.

This ensures the roster is fully populated immediately after import — no empty "Search" slots when guest names were provided in the CSV data.

### Rule 11 — Strict email-only member matching

Match members by email ONLY. No name-based fallback matching (no partial name, no Levenshtein distance, no first-name-only matching). This was removed because multiple members share similar names, causing incorrect booking links.

If the parsed email does not match a known member, the booking stays unmatched. This is a deliberate tradeoff: accuracy over coverage.

### Rule 12 — Placeholder merging (±2 min tolerance)

When a CSV row matches a simulator + date + time that already has a webhook-created placeholder booking ("Unknown (Trackman)"), UPDATE that record instead of creating a duplicate.

Query rules:
- Match by `resource_id`, `request_date`, and `start_time` within ±2 minutes (`ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 120`)
- Only match placeholders: `is_unmatched = true OR LOWER(user_name) LIKE '%unknown%' OR '%unassigned%'`
- Only match unlinked: `trackman_booking_id IS NULL`
- Exclude terminal statuses: `status NOT IN ('cancelled', 'declined', 'cancellation_pending')`
- **Deterministic**: If multiple candidates match, SKIP the merge and log for manual resolution. Never auto-merge when ambiguous.
- After merge: call `ensureSessionForBooking()` (Rule 1)

### Rule 13 — Force Approved on new CSV bookings

Set any newly created booking from CSV import that is successfully linked to a member to `status = 'approved'` immediately. Do NOT leave it as `pending` or use whatever status Trackman provides.

Unmatched bookings (no member email found) keep their original status.

### Rule 14 — Post-import auto-approve (timestamp-guarded)

After processing all CSV rows, a cleanup query auto-approves remaining `pending` bookings that:
- Have `origin = 'trackman_import'`
- Have a non-empty `user_email`
- Have `is_unmatched IS NOT TRUE`
- Were touched in THIS import run: `last_trackman_sync_at >= NOW() - INTERVAL '1 hour'`

The 1-hour constraint prevents accidentally flipping legacy pending bookings from previous imports.

### Rule 14a — Private event block detection

Before creating an unmatched booking during CSV import, check if the time slot has been converted to a private event block via `isConvertedToPrivateEventBlock()`. This prevents creating duplicate unmatched bookings when re-importing CSV data after a booking was marked as a private event. The check looks for `availability_blocks` linked to `facility_closures` with `notice_type = 'private_event'` that overlap the booking's time range.

### Rule 14b — Trackman webhook SQL null safety

All Trackman webhook handlers that use Drizzle `sql` template literals with optional parameters MUST coalesce `undefined` to `null` using `?? null`. This prevents Drizzle from producing empty SQL placeholders.

**Affected functions:**
- `updateBaySlotCache()` in `webhook-billing.ts` — `customerEmail`, `customerName`
- `logWebhookEvent()` in `webhook-validation.ts` — `trackmanUserId`, `matchedBookingId`, `matchedUserId`, `error`

**Pattern:**
```typescript
sql`INSERT INTO table (col) VALUES (${optionalValue ?? null})`
```

This was a production bug discovered Feb 2026 — undefined optional params caused `VALUES ($1, $2, , $3)` syntax errors that silently failed Trackman webhook processing for all incoming bookings.

---

## Section 4: Billing & Fees

### Rule 15 — Unified fee calculation via computeFeeBreakdown()

Route ALL fee calculations through `computeFeeBreakdown()` in `unifiedFeeService.ts`. Never calculate fees inline or in route handlers.

**CRITICAL — Transaction isolation:** `recalculateSessionFees()` and `computeFeeBreakdown()` use the global `db` pool. They MUST NEVER be called inside a `db.transaction()` block. The global pool cannot see uncommitted rows from an active transaction (Postgres Read Committed), causing $0 fees or deadlock. Always call fee calculation AFTER the transaction commits. (v8.26.7, Bug 22)

### Rule 15a — Fee Order of Operations (CRITICAL)

Follow this exact order for fee calculation. Getting this wrong causes incorrect charges.

1. **Status Check**: Is the booking in a billable status (`approved`, `confirmed`, `attended`)? If `cancelled`, `declined`, or `cancellation_pending` — STOP. Fee is $0.
2. **Staff Check**: Is the participant a staff member? Check `staff_users` table by email. If staff → $0, no further checks.
3. **Active Membership Check**: Does the participant have `membership_status IN ('active', 'trial', 'past_due')`? If NOT active, treat as guest (guest fee applies, charged to the booking HOST).
4. **Tier Lookup**: Get the participant's tier and tier limits via `getTierLimits()`.
5. **Unlimited Check**: If tier has `daily_sim_minutes >= 999` or `unlimited_access = true` → $0.
6. **Social Tier Check**: If tier is `Social`, ALL minutes are overage (no included daily allowance).
7. **Daily Usage Check**: Calculate `usedToday` via `getTotalDailyUsageMinutes()`, then compute overage = `MAX(0, (usedToday + perPersonMins) - dailyAllowance)`.
8. **Overage Blocks**: Round overage up to 30-minute blocks, multiply by `PRICING.OVERAGE_RATE_DOLLARS` (sourced from Stripe).

**NEVER** skip step 1 (status check). A cancelled booking must never generate fees. **NEVER** skip step 3 (active membership check). An inactive member is treated as a guest.

### Rule 16 — Duration uses GREATEST(session, booking)

Use `GREATEST(session_duration, booking_duration)` for fee duration because:
- Session times come from Trackman imports and may not reflect staff-updated extensions
- Booking duration reflects staff-updated times and is authoritative
- Always use the longer of the two to avoid undercharging

### Rule 17 — Empty slots generate guest fee line items

Empty booking slots (declared player count minus actual participants) generate synthetic guest fee line items. The business logic (empty slot = guest fee, 30-min overage blocks, guest pass rules) is hardcoded, but dollar amounts ALWAYS come from Stripe product prices — never hardcode dollar amounts.

This is why Rule 10 (parsing guest tags) is critical: filling guest slots with actual names prevents false guest fees.

---

## Section 4a: Invoice Lifecycle

### Rule 15b — One Stripe invoice per simulator booking

Each simulator booking has at most one Stripe invoice, tracked by `booking_requests.stripe_invoice_id`. The invoice lifecycle:

1. **Draft created at approval**: When a simulator booking is approved (staff or Trackman auto-approve) with fees > 0, `createDraftInvoiceForBooking()` creates a draft Stripe invoice with itemized line items (one per participant fee).
2. **Updated on roster changes**: When participants are added/removed or player count changes, `syncBookingInvoice()` updates the draft invoice line items. If fees drop to $0, the draft invoice is deleted. This includes Trackman admin reassignment (`PUT /api/admin/booking/:id/reassign`) — after `recalculateSessionFees()`, `syncBookingInvoice()` must be called to propagate the new fee totals to the Stripe invoice.
3. **Finalized at payment**: At check-in or member payment, the invoice is finalized and marked paid via `finalizeAndPayInvoice()` or `finalizeInvoicePaidOutOfBand()`.
4. **Voided on cancellation**: When a booking is cancelled, `voidBookingInvoice()` voids the draft/open invoice.

**Note:** As of v8.16.0 (2026-02-24), conference room bookings use the same invoice-based flow as simulators. Old `conference_prepayments` records are grandfathered at check-in.

### Rule 15c — Roster lock after paid invoice

Once a booking's Stripe invoice is paid, roster edits are blocked by `enforceRosterLock()` in `rosterService.ts`. This prevents changes that would invalidate a paid invoice. Staff can override with `forceOverride: true` and a required `overrideReason` (logged via `logger.warn`, not the formal audit trail). The lock is fail-open: if the Stripe API check fails, edits proceed to avoid blocking staff.

---

## Section 5: Unified Player Management

### Rule 20 — Single-Sheet Roster Management

Perform all booking roster edits, owner assignments, and guest additions exclusively via the **Unified Booking Sheet** (`src/components/staff-command-center/modals/UnifiedBookingSheet.tsx`).

Sub-components:
- `SheetHeader.tsx` — Header with booking info
- `BookingActions.tsx` — Action buttons
- `PaymentSection.tsx` — Fee display and payment status
- `AssignModeSlots.tsx` — Slot assignment UI for unlinked bookings
- `AssignModeFooter.tsx` — Footer actions for assign mode
- `ManageModeRoster.tsx` — Roster editing for existing bookings
- `CheckinBillingModal.tsx` — Check-in billing flow
- `CheckInConfirmationModal.tsx` — Check-in confirmation

**NEVER** create separate inline roster editors or "complete roster" popups. The Unified Booking Sheet is the single source of truth for:
- Validating slot counts (declared player count vs filled slots)
- Guest pass usage tracking and auto-application
- Fee updates and real-time recalculation
- Owner assignment (slot 1, required) and player slots (2-4, optional)
- Check-in roster completion flow

**Two sheet modes:**
- **Mode A (Assign Players):** Unlinked bookings — "Assign & Confirm" button
- **Mode B (Manage Players):** Existing bookings — pre-fills roster from `/api/admin/booking/:id/members`, "Save Changes" button

The backend populates `booking_participants` directly. Legacy tables `booking_members` and `booking_guests` no longer receive writes (v7.92.0). All **staff-facing UI** for viewing and editing rosters goes through the Unified Booking Sheet.

---

## Section 6: Roster Protection

### Rule 18 — Optimistic locking with roster_version

For any participant/roster change on a booking:
1. `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE` (row-level lock)
2. Compare the version against what the client sent
3. Perform the change
4. `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`

This prevents concurrent roster edits from silently overwriting each other.

---

## Section 7: Prepayment Lifecycle

### Rule 19 — Prepayment after approval

After a booking is approved (or auto-linked via Trackman), create a prepayment intent for expected fees (overage, guests). Members can pay from their dashboard. Check-in is blocked until fees are paid. Cancellations auto-refund succeeded prepayments with idempotency protection.

---

## Quick Checklist for New Booking Features

When adding any new booking-related code, verify:

- [ ] Does it call `ensureSessionForBooking()`? (Rule 1)
- [ ] Does it handle `cancellation_pending` status? (Rule 7)
- [ ] Does financial cleanup happen BEFORE status change? (Rule 4)
- [ ] Does it call `cancelPendingPaymentIntentsForBooking()` on cancel? (Rule 5)
- [ ] Does it use `computeFeeBreakdown()` for fees? (Rule 15)
- [ ] Does it check `roster_version` for participant changes? (Rule 18)
- [ ] For CSV import: Does it parse `M|email|firstname|lastname` and `G|...|firstname|lastname` from Notes (including INLINE G: tags)? (Rules 9-10)
- [ ] For CSV import: Does it immediately populate booking_participants? (Rule 10a)
- [ ] For CSV import: Does it force `approved` status for member-linked bookings? (Rule 13)
- [ ] For CSV import: Does it attempt placeholder merge before creating new? (Rule 12)
- [ ] For CSV import: Does it check for private event block conversion? (Rule 14a)
- [ ] For staff UI: Does roster editing go through the Unified Booking Sheet? (Rule 20)
- [ ] For simulator bookings: Does approval create a draft invoice? (Rule 15b)
- [ ] For cancellation: Does it void the booking invoice? (Rule 15b)
- [ ] For roster changes: Does it check roster lock via `enforceRosterLock()`? (Rule 15c)
- [ ] Does the invoice sync after fee recalculation? (Rule 15b)
- [ ] Does the availability endpoint account for pending booking requests on specific bays? (Rule 6, soft lock)

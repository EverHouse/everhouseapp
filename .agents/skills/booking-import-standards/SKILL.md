---
name: booking-import-standards
description: Mandatory rules for booking management, Trackman CSV import, billing sessions, cancellation flow, roster protection, and fee calculation in the Ever Club Members App. Use whenever creating or modifying booking endpoints, CSV import logic, billing/fee code, cancellation flows, or roster/participant management.
---

# Booking & Import Standards

These rules were established through production debugging and must be followed whenever touching booking, import, billing, or cancellation code. Violating any of these rules has caused real data integrity issues in the past.

## Key Files

- `server/core/bookingService/sessionManager.ts` — `ensureSessionForBooking()`, `createSession()`, `linkParticipants()`
- `server/core/trackmanImport.ts` — CSV import, placeholder merging, Notes parsing
- `server/core/billing/unifiedFeeService.ts` — `computeFeeBreakdown()`, fee line items
- `server/routes/bays/bookings.ts` — Booking CRUD, cancellation flow
- `server/routes/bays/approval.ts` — Approval, prepayment creation
- `server/routes/roster.ts` — Roster changes, optimistic locking
- `server/routes/trackman/webhook-handlers.ts` — Webhook booking updates
- `server/schedulers/stuckCancellationScheduler.ts` — Safety net for stuck cancellations

---

## Section 1: Session Safety

### Rule 1 — Every booking MUST have a billing session

Use `ensureSessionForBooking()` from `sessionManager.ts` for ALL session creation. This function has:
- Built-in retry (500ms delay, then second attempt)
- Staff-note safety: on double failure, writes `[SESSION_CREATION_FAILED]` to booking's `staff_notes` for manual review
- `ON CONFLICT (trackman_booking_id)` to handle race conditions
- Lookup chain: check by `trackman_booking_id` first, then by `resource_id + session_date + start_time`, then INSERT

**NEVER** write raw `INSERT INTO booking_sessions` anywhere outside this function. Every entry point that creates or links a booking must call `ensureSessionForBooking()`.

### Rule 2 — All 26+ entry points covered

Every code path that can create or approve a booking must call `ensureSessionForBooking()`:
- Staff manual booking
- Member booking request approval
- Trackman webhook auto-create
- Trackman webhook link-to-existing
- CSV import (new bookings AND merged placeholders)
- Reschedule
- Conference room sync
- Data tools / auto-match service

If you add a new entry point, it MUST call `ensureSessionForBooking()`.

---

## Section 2: Cancellation Flow

### Rule 3 — Trackman-linked bookings use cancellation_pending

When a member or staff cancels an approved simulator booking that has a `trackman_booking_id`:
1. Set status to `cancellation_pending` (NOT `cancelled`)
2. Set `cancellation_pending_at = NOW()`
3. Notify staff to cancel in Trackman first
4. Member sees "Cancellation Pending — your request is being processed"

Non-Trackman bookings (conference rooms, etc.) keep instant cancel behavior.

### Rule 4 — Financial cleanup BEFORE status change

When completing a cancellation (via webhook or manual):
1. **First**: Refund Stripe charges, clear fee snapshots, refund guest passes
2. **Then**: Update status to `cancelled`
3. **Then**: Notify member

This ordering prevents partial cancellation states where the status changed but money wasn't returned.

### Rule 5 — Call cancelPendingPaymentIntentsForBooking()

When any booking is cancelled (CSV import cancellation path, regular cancellation, webhook cancellation), always call `cancelPendingPaymentIntentsForBooking(bookingId)` to clean up outstanding payment intents.

### Rule 6 — Availability stays reserved during cancellation_pending

Time slots remain occupied while a booking is in `cancellation_pending`. Availability queries must exclude both `approved` AND `cancellation_pending` slots to prevent double-booking.

### Rule 7 — Status filtering: cancellation_pending everywhere

The `cancellation_pending` status must be handled in every query that filters by booking status:
- Availability checks (treat as occupied)
- Active booking counts (include in active)
- Reschedule guards (block reschedule)
- Payment guards (block new payments)
- Command center views (show with special badge)
- Member booking lists (show with pending message)

When adding new booking queries, always ask: "Does this query need to handle cancellation_pending?"

### Rule 8 — Stuck cancellation safety net

`stuckCancellationScheduler.ts` runs every 2 hours:
- Finds bookings in `cancellation_pending` for 4+ hours
- Deduplicates alerts (checks if staff was already notified in the last 4 hours for each booking)
- Sends summary notification to all staff
- Staff can use manual completion endpoint as fallback

---

## Section 3: CSV Import & Data Parsing

### Rule 9 — Parse M|email|name from Notes field

The CSV `Notes` field contains member identification strings in the format:
```
M|member@email.com|Member Name
```
You MUST parse this `M|email|name` pattern to extract the member's email for matching. This is the primary source of member identity in the CSV data. Without parsing this, the system cannot link bookings to members.

### Rule 10 — Parse G|name guest tags from Notes field (including INLINE tags)

The CSV `Notes` field also contains guest identification strings:
```
G|Guest Name
```
You MUST parse `G|name` tags to fill booking guest slots with actual guest names. This is critical because it directly prevents Rule 17 (empty slot = guest fee) from incorrectly charging guest fees when a guest name was actually provided in the data.

**CRITICAL: Inline G: tags must also be parsed.** Guest tags often appear inline on the same line as the M: tag or within freeform text, NOT on their own line:
```
M: member@email.com | Member Name Guests pay separately G: Chris G: Alex G: Dalton NO additional charge.
```
The parser (`parseNotesForPlayers()`) MUST scan for `G: Name` patterns anywhere in the line, not just at line start (`^G:`). The regex uses a negative lookahead to stop name capture before the next `G:`, `M:`, `NO`, `Used`, or `additional` keyword.

### Rule 10a — Imported bookings must IMMEDIATELY populate booking_players

When a Trackman CSV import identifies a member (via `M|email|name` parsing), the import MUST immediately populate the `booking_members` and `booking_participants` tables:

1. **Owner at Slot 1**: Insert a `booking_members` record with `slot_number: 1`, `is_primary: true`, and the member's email.
2. **Guests at Slots 2-4**: For each parsed `G: Name` guest tag, insert a `booking_members` record at the next available slot with `is_primary: false` and the guest name. Also insert into `booking_guests` with the guest name.
3. **Session participants**: Call `createTrackmanSessionAndParticipants()` which creates `booking_participants` records (the table the roster UI reads from).

This ensures the roster is fully populated immediately after import — no empty "Search" slots when guest names were provided in the CSV data. Without this, the roster shows 0/N players even though the owner appears in the booking header.

### Rule 11 — Strict email-only member matching

Member matching uses email ONLY. No name-based fallback matching (no partial name, no Levenshtein distance, no first-name-only matching). This was removed because multiple members share similar names, causing incorrect booking links.

If the `M|email|name` email doesn't match a known member, the booking stays unmatched. This is a deliberate tradeoff: accuracy over coverage.

### Rule 12 — Placeholder merging (±2 min tolerance)

When a CSV row matches a simulator + date + time that already has a webhook-created placeholder booking ("Unknown (Trackman)"), UPDATE that record instead of creating a duplicate.

Query rules:
- Match by `resource_id`, `request_date`, and `start_time` within ±2 minutes (`ABS(EXTRACT(EPOCH FROM (start_time::time - $3::time))) <= 120`)
- Only match placeholders: `is_unmatched = true OR LOWER(user_name) LIKE '%unknown%' OR '%unassigned%'`
- Only match unlinked: `trackman_booking_id IS NULL`
- Exclude terminal statuses: `status NOT IN ('cancelled', 'declined', 'cancellation_pending')`
- **Deterministic**: If multiple candidates match, SKIP the merge and log for manual resolution. Never auto-merge when ambiguous.
- After merge: create `booking_members` slots (primary + guest slots based on player count)
- After merge: call `ensureSessionForBooking()` (Rule 1)

### Rule 13 — Force Approved on new CSV bookings

Any newly created booking from CSV import that is successfully linked to a member (via `M|email|name` parsing) MUST be set to `status = 'approved'` immediately. Do NOT leave it as `pending` or use whatever status Trackman provides.

Unmatched bookings (no member email found) keep their original status.

### Rule 14 — Post-import auto-approve (timestamp-guarded)

After processing all CSV rows, a cleanup query auto-approves remaining `pending` bookings that:
- Have `origin = 'trackman_import'`
- Have a non-empty `user_email`
- Have `is_unmatched IS NOT TRUE`
- Were touched in THIS import run: `last_trackman_sync_at >= NOW() - INTERVAL '1 hour'`

The 1-hour constraint prevents accidentally flipping legacy pending bookings from previous imports.

---

## Section 4: Billing & Fees

### Rule 15 — Unified fee calculation via computeFeeBreakdown()

ALL fee calculations go through `computeFeeBreakdown()` in `unifiedFeeService.ts`. Never calculate fees inline or in route handlers.

### Rule 16 — Duration uses GREATEST(session, booking)

Fee duration uses `GREATEST(session_duration, booking_duration)` because:
- Session times come from Trackman imports and may not reflect staff-updated extensions
- Booking duration reflects staff-updated times and is authoritative
- Always use the longer of the two to avoid undercharging

### Rule 17 — Empty slots generate guest fee line items

Empty booking slots (declared player count minus actual participants) generate synthetic guest fee line items. The business logic (empty slot = guest fee, 30-min overage blocks, guest pass rules) is hardcoded, but dollar amounts ALWAYS come from Stripe product prices — never hardcode dollar amounts.

This is why Rule 10 (parsing `G|name` tags) is critical: filling guest slots with actual names prevents false guest fees.

---

## Section 5: Unified Player Management

### Rule 20 — Single-Modal Roster Management

All booking roster edits, owner assignments, and guest additions must be performed exclusively via the **Unified Player Modal** (`PlayerManagementModal.tsx`, formerly `TrackmanLinkModal.tsx`).

**NEVER** create separate inline roster editors or "complete roster" popups. The Unified Modal is the single source of truth for:
- Validating slot counts (declared player count vs filled slots)
- Guest pass usage tracking and auto-application
- Fee updates and real-time recalculation
- Owner assignment (slot 1, required) and player slots (2-4, optional)
- Check-in roster completion flow

**Deprecated approaches (do NOT use):**
- `BookingMembersEditor.tsx` — inline editor formerly embedded in booking details modals
- `CompleteRosterModal.tsx` — check-in roster popup that wrapped BookingMembersEditor

When importing CSV data or processing webhooks, the backend still populates `booking_members` and `booking_guests` tables directly (Rules 10a, 12). But all **staff-facing UI** for viewing and editing rosters goes through the Unified Player Modal.

**Two modal modes:**
- **Mode A (Assign Players):** Unlinked bookings — "Assign & Confirm" button
- **Mode B (Manage Players):** Existing bookings — pre-fills roster from `/api/admin/booking/:id/members`, "Save Changes" button

---

## Section 6: Roster Protection

### Rule 18 — Optimistic locking with roster_version

Any participant/roster change on a booking must:
1. `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE` (row-level lock)
2. Compare the version against what the client sent
3. Perform the change
4. `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`

This prevents concurrent roster edits from silently overwriting each other.

---

## Section 7: Prepayment Lifecycle

### Rule 19 — Prepayment after approval

After a booking is approved (or auto-linked via Trackman), a prepayment intent is created for expected fees (overage, guests). Members can pay from their dashboard. Check-in is blocked until fees are paid. Cancellations auto-refund succeeded prepayments with idempotency protection.

---

## Quick Checklist for New Booking Features

When adding any new booking-related code, verify:

- [ ] Does it call `ensureSessionForBooking()`? (Rule 1)
- [ ] Does it handle `cancellation_pending` status? (Rule 7)
- [ ] Does financial cleanup happen BEFORE status change? (Rule 4)
- [ ] Does it call `cancelPendingPaymentIntentsForBooking()` on cancel? (Rule 5)
- [ ] Does it use `computeFeeBreakdown()` for fees? (Rule 15)
- [ ] Does it check `roster_version` for participant changes? (Rule 18)
- [ ] For CSV import: Does it parse `M|email|name` and `G|name` from Notes (including INLINE G: tags)? (Rules 9-10)
- [ ] For CSV import: Does it immediately populate booking_members AND booking_participants? (Rule 10a)
- [ ] For CSV import: Does it force `approved` status for member-linked bookings? (Rule 13)
- [ ] For CSV import: Does it attempt placeholder merge before creating new? (Rule 12)
- [ ] For staff UI: Does roster editing go through the Unified Player Modal? (Rule 20)

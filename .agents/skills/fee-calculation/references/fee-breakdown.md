# computeFeeBreakdown — Detailed Flow

## Entry Point

`computeFeeBreakdown(params: FeeComputeParams)` in `server/core/billing/unifiedFeeService.ts`.

## Input Parameters (FeeComputeParams)

| Parameter | Type | Purpose |
|-----------|------|---------|
| `sessionId` | `number?` | Load session data from `booking_sessions` + `booking_requests` |
| `bookingId` | `number?` | Load booking data when no session exists yet |
| `sessionDate` | `string?` | Date of session (required for preview mode) |
| `startTime` | `string?` | Start time — used for chronological usage ordering |
| `sessionDuration` | `number?` | Duration in minutes (required for preview mode) |
| `declaredPlayerCount` | `number?` | Number of players declared at booking time |
| `hostEmail` | `string?` | Booking owner's email (required for preview mode) |
| `participants` | `Array?` | Participant list with `userId`, `email`, `displayName`, `participantType` |
| `source` | `string` | Context: `preview`, `approval`, `checkin`, `stripe`, `roster_update` |
| `excludeSessionFromUsage` | `boolean?` | Exclude this session from prior-usage tally (for recalculation) |
| `isConferenceRoom` | `boolean?` | Use conference room allowances instead of simulator |

## Two Modes

### Database Mode (sessionId or bookingId provided)

1. Call `loadSessionData()` to query `booking_sessions` + `booking_requests`:
   - Duration = `GREATEST(session_duration, booking_duration)` to handle Trackman imports vs staff-updated times.
   - Declared player count = `COALESCE(declared_player_count, trackman_player_count, guest_count + 1, 1)`.
   - Resource type determined from `resources.type`.
2. Load participants from `booking_participants` (by session), then `booking_members` (by booking), then fallback to host-only.
3. Check booking status — if `cancelled`, `declined`, or `cancellation_pending`, return `$0` immediately.

### Preview Mode (raw parameters)

Require `sessionDate`, `sessionDuration`, `hostEmail`, `participants`. Use provided values directly without database lookups for session data.

## Processing Steps

### Step 1: Effective Player Count

```
effectivePlayerCount = Math.max(declaredPlayerCount, actualParticipants.length, 1)
```

Prevent fee manipulation by declaring fewer players than actually present.

### Step 2: Minutes Per Participant

- **Simulator**: `Math.floor(sessionDuration / effectivePlayerCount)`
- **Conference room**: `sessionDuration` (full duration for owner, no splitting)

### Step 3: Resolve Host Tier and Guest Passes

- Look up host's membership tier via `getMemberTierByEmail()`.
- Fetch tier limits via `getTierLimits()` — includes `daily_sim_minutes`, `daily_conf_room_minutes`, `unlimited_access`, `guest_passes_per_month`.
- Fetch guest pass availability via `getGuestPassInfo()` — returns `remaining` count and `hasGuestPassBenefit` flag.

### Step 4: Batch Data Fetching

- Resolve all participant emails (handle UUID → email conversion via `MemberService.findById()`).
- Batch-query `users` table for tiers, roles, and membership status.
- Only count tiers for members with `membership_status` in `active`, `trialing`, `past_due`.
- Batch-query daily usage for all participants.

### Step 5: Usage Calculation

#### Preview Mode Usage

Query `booking_requests` directly (usage ledger not yet populated):
- `owned_bookings` — bookings where member is owner.
- `member_bookings` — bookings where member is participant via `booking_members`.
- `session_participant_bookings` — bookings via `booking_participants` → `booking_sessions`.
- Deduplicate by `(identifier, booking_id)` to prevent double-counting.
- Per-participant minutes = `floor(duration / max(1, declared_player_count))`.
- **Only count bookings starting earlier** than the current booking (chronological ordering).

#### Ledger Mode Usage

Query `usage_ledger` joined with `booking_sessions` and `resources`:
- `ledger_usage` — sum `minutes_charged` from finalized sessions.
- `ghost_usage` — approved/confirmed bookings with no ledger entries yet (fallback).
- Filter by resource type (simulator vs conference room — separate allowances).
- Apply chronological time filter when `startTime` is available.

### Step 6: Build Line Items

Iterate each participant and create a `FeeLineItem`:

#### Guest Participants

1. Conference rooms → skip (no guest fees).
2. Staff/admin in guest slot → $0 ("Pro in the Slot" rule), set `isStaff = true`.
3. Has `userId` (actually a member) → $0 guest fee (member mistyped as guest).
4. Real named guest with available guest pass → consume pass, $0 fee, set `guestPassUsed = true`.
5. Otherwise → charge `PRICING.GUEST_FEE_CENTS`.

#### Owner Participant

1. Staff/admin → $0, set `isStaff = true`.
2. Look up tier and daily allowance for the resource type.
3. Retrieve prior usage from batch map.
4. If not unlimited and allowance < 999:
   - `totalAfterSession = usedMinutesToday + minutesAllocated`
   - `newOverage = calculateOverageFee(totalAfterSession, dailyAllowance)`
   - `priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance)`
   - `marginalOverage = max(0, newOverage - priorOverage)` — only charge the incremental overage from this session.
5. `overageCents = round(marginalOverageFee * 100)`.

#### Member Participant

1. Conference rooms → $0 (only owner matters for conference rooms).
2. Staff/admin → $0.
3. Same overage logic as owner but using the member's own tier and usage.

### Step 7: Owner Absorbs Non-Member Time

After initial line items:
- Count empty slots = `effectivePlayerCount - owners - members - guests`.
- `nonMemberMinutes = (emptySlots + guestCount) * minutesPerParticipant`.
- Add `nonMemberMinutes` to owner's `minutesAllocated`.
- Recalculate owner's overage with the expanded allocation.
- Adjust `totalOverageCents` accordingly.

### Step 8: Empty Slot Line Items

For each empty slot (not conference rooms), generate a line item:
- `displayName = 'Empty Slot'`
- `participantType = 'guest'`
- `guestCents = PRICING.GUEST_FEE_CENTS`

## Line Item Fields (FeeLineItem)

| Field | Type | Description |
|-------|------|-------------|
| `participantId` | `number?` | Database ID of the booking participant |
| `userId` | `string?` | User UUID if participant is a member |
| `displayName` | `string` | Name shown in UI |
| `participantType` | `'owner' \| 'member' \| 'guest'` | Role in the booking |
| `minutesAllocated` | `number` | Minutes of simulator/room time attributed |
| `overageCents` | `number` | Overage charge in cents |
| `guestCents` | `number` | Guest fee in cents |
| `totalCents` | `number` | Sum of overage + guest fees |
| `guestPassUsed` | `boolean` | Whether a guest pass was consumed |
| `tierName` | `string?` | Member's tier name |
| `dailyAllowance` | `number?` | Tier's daily minutes for this resource type |
| `usedMinutesToday` | `number?` | Minutes already used today before this session |
| `isStaff` | `boolean?` | Whether participant is staff/admin |

## Guest Pass Hold/Consume Logic

### Hold Phase (at booking creation)

`guestPassHoldService.ts` → `createGuestPassHold()`:

1. Lock the member's `guest_passes` row with `FOR UPDATE`.
2. Calculate available = `total - used - held` (held = sum of active `guest_pass_holds`).
3. Hold = `min(passesNeeded, available)`.
4. Insert into `guest_pass_holds` with 30-day expiry.
5. Return `holdId`, `passesHeld`, `passesAvailable`.

### Consume Phase (at session finalization)

`guestPassConsumer.ts` → `consumeGuestPassForParticipant()`:

1. Reject placeholder guests (`/^Guest \d+$/i`).
2. Check idempotency — skip if `used_guest_pass` already `TRUE`.
3. Look up tier's `guest_passes_per_month`.
4. Find or create `guest_passes` row, increment `passes_used`.
5. If no passes remaining, return error.
6. Zero out `guest_fee` in `usage_ledger` for the session owner.
7. Set `payment_status = 'waived'`, `cached_fee_cents = 0`, `used_guest_pass = TRUE` on participant.
8. Insert `legacy_purchases` record (category `guest_pass`, price $0, `is_comp = true`).
9. Send notification to owner with remaining count.
10. Clean up corresponding `guest_pass_holds` row.

### Release Phase (at booking cancellation)

`releaseGuestPassHold()` — delete all `guest_pass_holds` for the booking.

### Refund Phase

`refundGuestPassForParticipant()`:
1. Verify `used_guest_pass = TRUE` on participant.
2. Decrement `passes_used` in `guest_passes`.
3. Restore guest fee on participant (`cached_fee_cents` = Stripe guest pass price or default).
4. Delete the corresponding `legacy_purchases` record.

## Usage Calculator Details

### calculateOverageFee(minutesUsed, tierAllowance)

- If `tierAllowance >= 999` or `minutesUsed <= tierAllowance` → no overage.
- `overageMinutes = minutesUsed - tierAllowance`.
- `blocks = ceil(overageMinutes / 30)`.
- `fee = blocks * PRICING.OVERAGE_RATE_DOLLARS`.

### computeUsageAllocation(duration, participants, options?)

Distribute session time evenly:
- Divisor = `declaredSlots` (if provided) or `participants.length`.
- `minutesPerParticipant = floor(duration / divisor)`.
- Remainder distributed to first N participants (or to owner if `assignRemainderToOwner`).

### getDailyUsageFromLedger(email, date, excludeSessionId?, resourceType?)

Sum `minutes_charged` from `usage_ledger` joined to `booking_sessions` for a specific member, date, and resource type. Optionally exclude a session ID to avoid counting the current session.

Includes a safety check that warns if sessions have participants but no ledger entries (indicating missing ledger data).

## Post-Calculation: Apply and Recalculate

### applyFeeBreakdownToParticipants(sessionId, breakdown)

Batch-update `booking_participants.cached_fee_cents` with calculated fees in a single transaction.

### recalculateSessionFees(sessionId, source)

1. Call `computeFeeBreakdown()` with `excludeSessionFromUsage = true`.
2. Apply fees to participants.
3. Sync `overage_fee_cents` and `overage_minutes` to `booking_requests` for legacy dashboard compatibility.

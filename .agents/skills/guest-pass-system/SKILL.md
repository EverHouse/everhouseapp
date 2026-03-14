---
name: guest-pass-system
description: "Guest pass lifecycle — allocation, holds, consumption, refunds, and monthly reset. Covers guest pass holds during booking, pass consumption at check-in, refund on cancellation, tier-based allocation, monthly reset scheduler, and the pending guest count system. Use when modifying guest pass logic, debugging pass counts, adding guest features, or working on check-in guest handling."
---

# Guest Pass System

**Lifecycle:** Available → Held (booking created) → Consumed (check-in) or Released (cancellation)

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| REST endpoints + helpers | `server/routes/guestPasses.ts` | API, `useGuestPass`, `refundGuestPass`, `getGuestPassesRemaining` |
| Consumption/refund logic | `server/core/billing/guestPassConsumer.ts` | `consumeGuestPassForParticipant`, `refundGuestPassForParticipant` |
| Hold lifecycle | `server/core/billing/guestPassHoldService.ts` | `createGuestPassHold`, `releaseGuestPassHold`, `convertHoldToUsage` |
| Monthly reset | `server/schedulers/guestPassResetScheduler.ts` | Reset scheduler (1st of month, 3 AM Pacific) |

## Decision Trees

### Guest pass flow through a booking

```
Booking created with guests
  → createGuestPassHold(email, bookingId, passesNeeded)
    ├── Passes available? → Hold created (30-day expiry)
    └── No passes? → Hold fails (booking proceeds, guest pays fee)

Booking approved / session created
  → convertHoldToUsage(bookingId, email) [inside transaction]
    ├── Hold exists? → Increment passes_used, delete hold
    └── No hold? → Direct deduction from guest_passes

Check-in: staff clicks "Use Guest Pass"
  → consumeGuestPassForParticipant(participantId, ownerEmail, ...)
    ├── Placeholder guest? → REJECT (real name required)
    ├── Already consumed? → Skip (idempotent)
    ├── Passes remaining? → Consume, waive fee, notify
    └── No passes? → REJECT

Booking cancelled
  → releaseGuestPassHold(bookingId) [delete holds]
  → If >= 1hr before start: refundGuestPassForParticipant()
  → If < 1hr before start: passes forfeited
```

## Hard Rules

1. **Always normalize email to lowercase** for all guest pass operations.
2. **Reject placeholder guests** (`/^Guest \d+$/i`) from pass consumption.
3. **Holds expire after 30 days.** `cleanupExpiredHolds()` reclaims them.
4. **Hold-to-usage uses `Math.min(passesHeld, guestPassesUsed)`.** Never trust holds match final guest count.
5. **Guest pass refund window: 1 hour.** Cancellation >= 1hr before start → refund passes. Late cancellation → forfeited.
6. **Never refund from `tryLinkCancelledBooking`.** Cancellation workflows handle their own refunds.
7. **Use `SELECT FOR UPDATE`** on `guest_passes` for all atomic operations.
8. **Broadcast after pass use/refund.** `broadcastMemberStatsUpdated(email, { guestPasses: remaining })`.
9. **Auto-update allocation on tier change.** GET endpoint compares `passes_total` against tier config. On downgrade, clamp `passes_used` to new total.
10. **Monthly reset is idempotent.** Uses `system_settings` key `'last_guest_pass_reset'` with month key `YYYY-MM`.

## Anti-Patterns (NEVER)

1. NEVER consume guest passes for placeholder guests ("Guest 1", "Guest 2").
2. NEVER refund guest passes from `tryLinkCancelledBooking`.
3. NEVER skip `SELECT FOR UPDATE` on concurrent pass operations. `createGuestPassHold`, `convertHoldToUsage`, and `consumeGuestPassForParticipant` all use `FOR UPDATE` with `UPDATE WHERE passes_used < passes_total` guards (v8.86.0 — verified with 14 concurrency tests in `tests/guestPassConcurrency.test.ts`).
4. NEVER trust that holds match the final guest count — use `Math.min()`.

## Cross-References

- **Fee calculation (guest fee exemptions)** → `fee-calculation` skill
- **Check-in consumption flow** → `checkin-flow` skill
- **Booking creation (hold phase)** → `booking-flow` skill
- **Monthly reset scheduler** → `scheduler-jobs` skill

## Detailed Reference

- **[references/hold-consume-flow.md](references/hold-consume-flow.md)** — Step-by-step transactional flow for consumption and refund.
- **[references/allocation-reset.md](references/allocation-reset.md)** — Monthly reset scheduler internals.

---

## Database Tables

### guest_passes

| Column | Type | Description |
|---|---|---|
| member_email | text | Normalized (lowercase) |
| passes_used | integer | Consumed this month |
| passes_total | integer | Monthly allocation from tier |

### guest_pass_holds

| Column | Type | Description |
|---|---|---|
| member_email | text | Normalized |
| booking_id | integer | Associated booking request |
| passes_held | integer | Passes reserved |
| expires_at | timestamp | 30 days from creation |

## Available Passes Formula

`available = passes_total - passes_used - active_holds`

## Pending Guest Count

GET endpoint calculates: query `booking_requests` with status in `pending/pending_approval/approved/confirmed`, parse `requestParticipants` JSONB, count `type === 'guest'` with email or userId set.

`passes_remaining_conservative = Math.max(0, passes_remaining - pendingGuestCount)`

## Exported Helpers (from `guestPasses.ts`)

- `useGuestPass(email, guestName?, sendNotification?)` — programmatic use
- `refundGuestPass(email, guestName?, sendNotification?)` — programmatic refund
- `getGuestPassesRemaining(email, tier?)` — remaining count
- `ensureGuestPassRecord(email, tier?)` — create record if missing

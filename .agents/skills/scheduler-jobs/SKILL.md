---
name: scheduler-jobs
description: "Scheduled maintenance tasks — daily, hourly, and continuous background jobs. Covers all 25+ schedulers, their timing, idempotency, the scheduler tracker, and the job queue processor. Use when adding new scheduled tasks, debugging scheduler issues, understanding maintenance windows, or checking scheduler health via the admin dashboard."
---

# Scheduler Jobs

## Overview

All schedulers are registered and started in `server/schedulers/index.ts` via the `initSchedulers()` function. Each scheduler uses `schedulerTracker` (from `server/core/schedulerTracker.ts`) to report its health status. All time-gated schedulers use Pacific timezone via `getPacificHour()` and `getTodayPacific()` from `server/utils/dateUtils`.

## Key Files

- `server/schedulers/index.ts` — registry: import, register, and start all schedulers
- `server/core/schedulerTracker.ts` — in-memory tracker reporting scheduler health to admin dashboard
- `server/core/jobQueue.ts` — generic background job queue processor
- `server/schedulers/*.ts` — individual scheduler implementations

## Scheduler Registry

All schedulers registered in `initSchedulers()`:

| Name | File | Interval | Time Gate | Purpose |
|------|------|----------|-----------|---------|
| Background Sync | backgroundSyncScheduler.ts | 5 min | None | Sync Google Calendar events, wellness, tours, closures, conference rooms |
| Daily Reminder | dailyReminderScheduler.ts | 30 min | 6 PM Pacific | Send tomorrow's event/booking/wellness reminders (defined in push.ts, triggered by dailyReminderScheduler) |
| Morning Closure | morningClosureScheduler.ts | 30 min | 8 AM Pacific | Notify members about today's facility closures (defined in push.ts, triggered by morningClosureScheduler) |
| Weekly Cleanup | weeklyCleanupScheduler.ts | 1 hr | Sunday 3 AM Pacific | Clean up old data, expired records, stale sessions |
| Invite Expiry | inviteExpiryScheduler.ts | 5 min | None | Expire stale booking participant invitations |
| Integrity Check | integrityScheduler.ts | 30 min | Midnight Pacific | Run data integrity checks, send alert emails |
| Auto-Fix Tiers | integrityScheduler.ts | 4 hr | None | Sub-task of Integrity Scheduler: Fix missing tiers, normalize membership_status case |
| Abandoned Pending Cleanup | integrityScheduler.ts | 6 hr | None | Sub-task of Integrity Scheduler: Delete abandoned pending users (24h+ old, no subscription) |
| Waiver Review | waiverReviewScheduler.ts | 4 hr | None | Check for waivers pending staff review > 12 hours |
| Stripe Reconciliation | stripeReconciliationScheduler.ts | 1 hr | 5 AM Pacific | Reconcile Stripe subscriptions and payments with DB |
| Fee Snapshot Reconciliation | feeSnapshotReconciliationScheduler.ts | 15 min | None | Reconcile pending fee snapshots, cancel abandoned payment intents |
| Grace Period | gracePeriodScheduler.ts | 1 hr | 10 AM Pacific | Process membership grace periods, send reminder emails, terminate |
| Booking Expiry | bookingExpiryScheduler.ts | 1 hr | None | Expire past-due pending/pending_approval bookings (20-min grace period past start_time) |
| Booking Auto-Complete | bookingAutoCompleteScheduler.ts | 2 hr | None | Mark approved/confirmed bookings as attended (auto checked-in) 24h after end time. Also calls `ensureSessionForBooking()` for each booking without a session to prevent "Active Bookings Without Sessions" data integrity failures. |
| Communication Logs Sync | communicationLogsScheduler.ts | 30 min | None | Sync communication log records |
| Webhook Log Cleanup | webhookLogCleanupScheduler.ts | 1 hr | 4 AM Pacific | Delete webhook logs older than 30 days |
| Session Cleanup | sessionCleanupScheduler.ts | 1 hr | 2 AM Pacific | Clean up expired HTTP sessions |
| Unresolved Trackman | unresolvedTrackmanScheduler.ts | 15 min | 9 AM Pacific | Alert staff about unmatched Trackman bookings > 24h |
| HubSpot Queue | hubspotQueueScheduler.ts | 2 min | None | Process queued HubSpot sync operations (batch of 20) |
| HubSpot Form Sync | hubspotFormSyncScheduler.ts | 30 min | None | Sync HubSpot form submissions |
| Member Sync | memberSyncScheduler.ts | 24 hr | 3 AM Pacific | Full daily member data sync from HubSpot |
| Duplicate Cleanup | duplicateCleanupScheduler.ts | 1 hr | 4 AM Pacific | Remove duplicate Trackman bookings (keep earliest) |
| Guest Pass Reset | guestPassResetScheduler.ts | 1 hr | 3 AM Pacific, 1st of month | Reset monthly guest pass counters |
| Relocation Cleanup | relocationCleanupScheduler.ts | 5 min | None | Clear stale bay relocation records |
| Stuck Cancellation | stuckCancellationScheduler.ts | 2 hr | None | Alert staff about bookings stuck in cancellation_pending > 4h |
| Pending User Cleanup | pendingUserCleanupScheduler.ts | 6 hr | None | Delete old pending Stripe users (48h+, no subscription), cancel Stripe customer |
| Webhook Event Cleanup | webhookEventCleanupScheduler.ts | 24 hr | None | Remove webhook_processed_events older than 7 days |
| Onboarding Nudge | onboardingNudgeScheduler.ts | 1 hr | 10 AM Pacific | Send graduated onboarding nudge emails to stalled members |
| Job Queue Processor | jobQueue.ts | 5 sec | None | Process background job queue (emails, notifications, syncs) |

## Scheduler Tracker

`SchedulerTracker` class in `server/core/schedulerTracker.ts` provides in-memory tracking of all scheduler runs.

### API

- `registerScheduler(name, intervalMs)` — register a scheduler with its expected interval; call during `initSchedulers()`
- `recordRun(name, success, error?, durationMs?)` — record a run result; updates `lastRunAt`, `nextRunAt`, `runCount`
- `getSchedulerStatuses()` — return sorted array of all scheduler statuses for admin dashboard

### Status Fields

- `taskName` — scheduler display name
- `lastRunAt` — timestamp of last run (null if never run)
- `lastResult` — `'success'` | `'error'` | `'pending'`
- `lastError` — error message from last failed run
- `intervalMs` — expected interval between runs
- `nextRunAt` — computed next expected run time
- `runCount` — total number of recorded runs
- `lastDurationMs` — duration of last run in milliseconds

## Idempotency Patterns

Prevent double execution of time-gated schedulers. See `references/idempotency-patterns.md` for code examples.

### Time Gate

Check `getPacificHour()` against a target hour constant. Only proceed when current hour matches.

### Claim Slot (Database)

Use `INSERT INTO system_settings ON CONFLICT DO UPDATE ... WHERE value IS DISTINCT FROM <today>` to atomically claim a daily slot. Return `true` only if the row was actually updated (first run today).

### Local Variable Gate

Track `lastCleanupDate` in memory; compare to `getTodayPacific()`. Simpler but not crash-safe.

### Monthly Gate

Use a month key (`YYYY-MM`) instead of a date key in the claim slot pattern. Combine with day-of-month check (`getPacificDayOfMonth() === 1`).

### Weekly Gate

Check `getDay() === 0` (Sunday) + hour check + week-number tracking to prevent re-runs within the same week.

## Adding a New Scheduler

1. Create a new file in `server/schedulers/` (e.g., `myNewScheduler.ts`)
2. Export a `startMyNewScheduler()` function that sets up `setInterval`
3. Import and call the start function in `server/schedulers/index.ts`
4. Register with `schedulerTracker.registerScheduler('My New Scheduler', intervalMs)` in `initSchedulers()`
5. Call `schedulerTracker.recordRun('My New Scheduler', true)` on success
6. Call `schedulerTracker.recordRun('My New Scheduler', false, String(error))` on failure
7. Use `getPacificHour()` / `getTodayPacific()` for time gating if needed
8. Use the `tryClaimSlot` pattern (INSERT ON CONFLICT) for idempotency if the task must run only once per day/month
9. Wrap the main logic in try/catch — never let errors crash the interval
10. Add a `[Startup]` console.log in the start function for boot visibility
11. **All `setTimeout()` and `setInterval()` timer IDs must be stored in a variable or collection** so they can be cleared on shutdown. The `stopSchedulers()` function must clear all interval AND timeout IDs. The booking expiry scheduler stores individual setTimeout IDs in a `Map` and clears them in its stop function. (v8.26.7)
12. **Booking expiry targets both `pending` and `pending_approval`** statuses. A 20-minute grace period past `start_time` prevents premature expiry for members arriving at the front desk. **Trackman-linked bookings** (those with `trackman_booking_id IS NOT NULL`) are set to `cancellation_pending` instead of `expired` so the Trackman hardware cleanup flow can unlock the physical bay. Non-Trackman bookings are set to `expired` directly. After each status change, the scheduler calls `broadcastAvailabilityUpdate()` for every booking that has a `resourceId`, so front desk iPads and member phones update instantly without manual refresh. (v8.26.7)
13. **Every scheduler using `setTimeout` chains must store the current timeout ID** in a module-level variable and export a `stopXxxScheduler()` function that clears it. This prevents zombie processes on hot-reload or graceful restart. Both `memberSyncScheduler` and `backgroundSyncScheduler` follow this pattern. All stop functions must be called in `stopSchedulers()` in `server/schedulers/index.ts`. (v8.26.7)

## Job Queue

`server/core/jobQueue.ts` provides a generic database-backed job queue for deferred work.

### How It Works

- Poll every 5 seconds for pending jobs
- Claim jobs atomically with `FOR UPDATE SKIP LOCKED` (prevents double-processing)
- Execute each job by type (switch/case dispatcher)
- Mark completed or failed with exponential backoff retry
- Lock timeout: 5 minutes (auto-release stale locks)
- Batch size: 10 jobs per poll cycle
- Max retries: 3 (configurable per job)

### Job Types

`send_payment_receipt`, `send_payment_failed_email`, `send_membership_renewal_email`, `send_membership_failed_email`, `send_pass_with_qr_email`, `notify_payment_success`, `notify_payment_failed`, `notify_staff_payment_failed`, `notify_member`, `notify_all_staff`, `broadcast_billing_update`, `broadcast_day_pass_update`, `send_notification_to_user`, `sync_to_hubspot`, `sync_company_to_hubspot`, `sync_day_pass_to_hubspot`, `upsert_transaction_cache`, `update_member_tier`, `stripe_credit_refund`, `stripe_credit_consume`, `generic_async_task`

### Queueing Jobs

```typescript
import { queueJob } from '../core/jobQueue';

await queueJob('send_payment_receipt', {
  to: email,
  memberName: name,
  amount: '$50.00',
  date: '2026-02-18',
  description: 'Bay booking fee'
}, { priority: 0, maxRetries: 3 });
```

Use `queueJobInTransaction(client, ...)` to enqueue within an existing DB transaction. Use `queueJobs([...])` for batch inserts.

### Monitoring

- `getJobQueueStats()` — returns counts by status (pending, processing, completed, failed)
- `cleanupOldJobs(daysToKeep)` — remove completed/failed jobs older than N days

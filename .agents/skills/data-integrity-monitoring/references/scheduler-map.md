# Scheduler Map

## Registration & Management

All schedulers are registered and started in `server/schedulers/index.ts` via `initSchedulers()`. Each scheduler is:

1. **Registered** with `schedulerTracker.registerScheduler(name, intervalMs)` to enable status tracking.
2. **Started** by calling its `start*Scheduler()` function, which sets up a `setInterval` loop.
3. **Tracked** by calling `schedulerTracker.recordRun(name, success, error?, durationMs?)` after each execution.

### Multi-Instance Safety

Schedulers that must run exactly once per day use a database lock pattern:

1. Insert/update a row in `system_settings` with the current date as value.
2. Use `IS DISTINCT FROM` in the `WHERE` clause to ensure only one instance claims the slot.
3. If the upsert returns a result, the instance has the lock and proceeds. Others skip silently.

This prevents duplicate execution when multiple deployment instances are running.

### Scheduler Tracker

`server/core/schedulerTracker.ts` — In-memory singleton that stores per-scheduler:

| Field | Type | Purpose |
|---|---|---|
| `taskName` | string | Scheduler display name |
| `lastRunAt` | Date | Timestamp of last execution |
| `lastResult` | success/error/pending | Outcome of last run |
| `lastError` | string | Error message if last run failed |
| `intervalMs` | number | Expected interval between runs |
| `nextRunAt` | Date | Computed next expected run |
| `runCount` | number | Total runs since server start |
| `lastDurationMs` | number | Execution time of last run |

Exposed via `GET /api/admin/monitoring/schedulers`.

---

## Every 5 Seconds

| Scheduler | File | Purpose |
|---|---|---|
| Job Queue Processor | `server/core/jobQueue.ts` | Poll `job_queue` table for pending jobs, lock and process them with retry logic. Clean up completed jobs older than 7 days. |

---

## Every 2 Minutes

| Scheduler | File | Purpose |
|---|---|---|
| HubSpot Queue | `hubspotQueueScheduler.ts` | Process pending items in `hubspot_sync_queue`. Execute CRM operations (create/update contacts, deals) with retry logic. |

---

## Every 5 Minutes

| Scheduler | File | Purpose |
|---|---|---|
| Background Sync | `backgroundSyncScheduler.ts` | Sync member data changes to external services (HubSpot, Google Calendar). |
| Invite Expiry | `inviteExpiryScheduler.ts` | Expire pending membership invitations that have passed their deadline. |
| Relocation Cleanup | `relocationCleanupScheduler.ts` | Clean up temporary relocation-related data. |

---

## Every 15 Minutes

| Scheduler | File | Purpose |
|---|---|---|
| Fee Snapshot Reconciliation | `feeSnapshotReconciliationScheduler.ts` | Reconcile fee snapshot records against actual billing data. Detect and correct discrepancies. |
| Unresolved Trackman | `unresolvedTrackmanScheduler.ts` | Retry matching of unresolved Trackman webhook events to local bookings. |

---

## Every 30 Minutes

| Scheduler | File | Purpose |
|---|---|---|
| Integrity Check | `integrityScheduler.ts` | Poll loop that triggers the nightly integrity check at midnight Pacific. Does nothing outside the target hour. |
| Daily Reminder | `dailyReminderScheduler.ts` | Check if daily booking/event reminders need to be sent. Runs at a configured Pacific hour. |
| Morning Closure | `morningClosureScheduler.ts` | Automatically close/process morning-related booking workflows at a configured Pacific hour. |
| Communication Logs Sync | `communicationLogsScheduler.ts` | Sync communication log records (emails sent, notifications delivered). |
| HubSpot Form Sync | `hubspotFormSyncScheduler.ts` | Sync HubSpot form submissions to local records. |

---

## Every 1 Hour

| Scheduler | File | Purpose |
|---|---|---|
| Weekly Cleanup | `weeklyCleanupScheduler.ts` | Poll loop that triggers weekly database cleanup tasks (test data, old cancelled bookings, old notifications, old availability blocks, old jobs). |
| Stripe Reconciliation | `stripeReconciliationScheduler.ts` | Poll loop that triggers daily reconciliation at 5am Pacific. Compare Stripe subscriptions and payments against local records. Uses database lock. |
| Grace Period | `gracePeriodScheduler.ts` | Check members in grace period status at 10am Pacific. Send reminder emails, process expirations after 3 days. Creates Stripe reactivation links. |
| Booking Expiry | `bookingExpiryScheduler.ts` | Expire stale booking requests where the booking time has passed without confirmation. Notify staff of expired bookings. |
| Webhook Log Cleanup | `webhookLogCleanupScheduler.ts` | Delete Trackman webhook logs older than 30 days. Runs at 4am Pacific. |
| Session Cleanup | `sessionCleanupScheduler.ts` | Delete expired HTTP sessions from the `session` table. |
| Duplicate Cleanup | `duplicateCleanupScheduler.ts` | Detect and merge or flag duplicate member records. |
| Guest Pass Reset | `guestPassResetScheduler.ts` | Reset monthly guest pass counters, process expired passes, reconcile guest pass data. |
| Onboarding Nudge | `onboardingNudgeScheduler.ts` | Send reminder notifications to members who have not completed onboarding steps. |

---

## Every 2 Hours

| Scheduler | File | Purpose |
|---|---|---|
| Stuck Cancellation | `stuckCancellationScheduler.ts` | Find and resolve members stuck in cancellation-pending states beyond expected timeframes. |

---

## Every 4 Hours

| Scheduler | File | Purpose |
|---|---|---|
| Auto-Fix Tiers | `integrityScheduler.ts` | Normalize `membership_status` casing, set `billing_provider='mindbody'` for members with MindBody IDs, fix tiers from alternate emails, sync staff roles. |
| Waiver Review | `waiverReviewScheduler.ts` | Check for waivers that need staff review and send reminders. |

---

## Every 6 Hours

| Scheduler | File | Purpose |
|---|---|---|
| Abandoned Pending Cleanup | `integrityScheduler.ts` | Delete users in `pending` status >24h with no Stripe subscription. Cascade-deletes notifications, bookings, RSVPs, enrollments, fees, notes, and guest passes in a transaction. |
| Pending User Cleanup | `pendingUserCleanupScheduler.ts` | Additional cleanup for stale pending user records. |

---

## Every 24 Hours

| Scheduler | File | Purpose |
|---|---|---|
| Member Sync | `memberSyncScheduler.ts` | Full member data synchronization across all external services. |
| Webhook Event Cleanup | `webhookEventCleanupScheduler.ts` | Delete old processed webhook events from the `trackman_webhook_events` table. |

---

## Daily at Specific Hours (Pacific)

These schedulers use the poll-and-check pattern (run their interval loop but only execute at a specific hour):

| Hour | Task | Lock |
|---|---|---|
| 00:00 | Integrity Check — run all 25 checks, pre-check cleanup, email alert | `system_settings` lock |
| 04:00 | Webhook Log Cleanup — delete Trackman logs >30 days | No lock (idempotent) |
| 05:00 | Stripe Reconciliation — daily payment and subscription reconciliation | `system_settings` lock |
| 10:00 | Grace Period — process grace period expirations and send reminders | No lock |

---

## Failure Handling

When a scheduler fails:

1. `schedulerTracker.recordRun(name, false, errorMessage)` records the failure.
2. For critical schedulers (Integrity Check, Stripe Reconciliation), `alertOnScheduledTaskFailure()` sends an in-app notification to all staff with the task name and error details.
3. The scheduler continues its interval loop — failures do not stop future runs.
4. The admin monitoring dashboard shows the last error message and failure status for each scheduler.

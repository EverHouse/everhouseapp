---
name: scheduler-jobs
description: "Scheduled maintenance tasks — daily, hourly, and continuous background jobs. Covers all 29 logical schedulers (26 files — `integrityScheduler.ts` contains 3), their timing, idempotency, the scheduler tracker, and the job queue processor. Use when adding new scheduled tasks, debugging scheduler issues, understanding maintenance windows, or checking scheduler health via the admin dashboard."
---

# Scheduler Jobs

All schedulers registered in `server/schedulers/index.ts` via `initSchedulers()`. Health tracked by `schedulerTracker` (`server/core/schedulerTracker.ts`). Time gates use Pacific timezone via `getPacificHour()` / `getTodayPacific()`.

Note: `notificationCleanupScheduler.ts` uses `node-cron` (not `setInterval`) — it is started/stopped in `initSchedulers()`/`stopSchedulers()` and registered with `schedulerTracker`. It uses `cron.schedule('0 0 * * *', ...)` for midnight scheduling. Its timer handle is a `ScheduledTask` object (not a `NodeJS.Timeout`), so it is stopped via `cronTask.stop()` rather than `clearInterval()`.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Scheduler registry | `server/schedulers/index.ts` | Import, register, start all schedulers |
| Scheduler health tracking | `server/core/schedulerTracker.ts` | In-memory tracker for admin dashboard |
| Job queue processor | `server/core/jobQueue.ts` | Background job processing |
| Individual schedulers | `server/schedulers/*.ts` | Each scheduler implementation |

## Scheduler Registry (29 logical tasks across 26 files)

| Name | File | Interval | Time Gate | Purpose |
|---|---|---|---|---|
| Background Sync | backgroundSyncScheduler.ts | 5 min | None | Google Calendar events, wellness, closures, conference rooms |
| Daily Reminder | dailyReminderScheduler.ts | 30 min | 6 PM Pacific | Tomorrow's reminders (push.ts) |
| Morning Closure | morningClosureScheduler.ts | 30 min | 8 AM Pacific | Today's closure alerts (push.ts) |
| Weekly Cleanup | weeklyCleanupScheduler.ts | 1 hr | Sun 3 AM Pacific | Old data cleanup |
| Integrity Check | integrityScheduler.ts | 30 min | Midnight Pacific | Data integrity checks + email |
| Auto-Fix Tiers | integrityScheduler.ts | 24 hr | None | Fix missing tiers, normalize status |
| Abandoned Pending | integrityScheduler.ts | 6 hr | None | Delete 24h+ pending users |
| Waiver Review | waiverReviewScheduler.ts | 4 hr | None | Stale waivers >12h (6h dedup) |
| Stripe Reconciliation | stripeReconciliationScheduler.ts | 1 hr | 5 AM Pacific | Stripe vs DB reconciliation |
| Fee Snapshot Recon | feeSnapshotReconciliationScheduler.ts | 15 min | None | Pending fee snapshots |
| Grace Period | gracePeriodScheduler.ts | 1 hr | 10 AM Pacific | Payment failure follow-up |
| Booking Expiry | bookingExpiryScheduler.ts | 1 hr | None | Expire stale pending bookings |
| Booking Auto-Complete | bookingAutoCompleteScheduler.ts | 1 hr | None | Auto check-in 30 min after end |
| Communication Logs | communicationLogsScheduler.ts | 30 min | None | Sync communication logs |
| Webhook Log Cleanup | webhookLogCleanupScheduler.ts | 1 hr | 4 AM Pacific | Delete 30-day-old webhook logs |
| Session Cleanup | sessionCleanupScheduler.ts | 1 hr | 2 AM Pacific | Expired HTTP sessions |
| Unresolved Trackman | unresolvedTrackmanScheduler.ts | 15 min | 9 AM Pacific | Unmatched Trackman >24h alert |
| HubSpot Queue | hubspotQueueScheduler.ts | 2 min | None | Process HubSpot sync ops (batch 50) |
| HubSpot Form Sync | hubspotFormSyncScheduler.ts | 30 min | None | Ingest HubSpot forms |
| Member Sync | memberSyncScheduler.ts | 24 hr | 3 AM Pacific | Full HubSpot member sync |
| Duplicate Cleanup | duplicateCleanupScheduler.ts | 24 hr | 4 AM Pacific | Remove duplicate Trackman bookings |
| Guest Pass Reset | guestPassResetScheduler.ts | 1 hr | 3 AM, January 1st | Yearly pass counter reset |
| Stuck Cancellation | stuckCancellationScheduler.ts | 2 hr | None | Alert for cancellation_pending >4h |
| Pending User Cleanup | pendingUserCleanupScheduler.ts | 6 hr | None | Delete 48h+ pending users |
| Webhook Event Cleanup | webhookEventCleanupScheduler.ts | 24 hr | None | Remove 7-day-old processed events |
| Onboarding Nudge | onboardingNudgeScheduler.ts | 1 hr | 10 AM Pacific | Stalled member nudge emails |
| Supabase Heartbeat | supabaseHeartbeatScheduler.ts | 6 hr | None | Keep Supabase connection alive |
| Notification Cleanup | notificationCleanupScheduler.ts | 24 hr (cron) | Midnight Pacific | Delete old notifications, push subscriptions, dismissed notices (configurable retention via `cleanup.notification_retention_days` setting, default 30 days) |
| Job Queue Processor | jobQueue.ts | 5 sec | None | Process background jobs |

## Hard Rules — Adding a New Scheduler

1. Create file in `server/schedulers/`, export `startMyScheduler()`.
2. Import and call in `server/schedulers/index.ts`.
3. `schedulerTracker.registerScheduler('Name', intervalMs)` in `initSchedulers()`.
4. `schedulerTracker.recordRun('Name', true/false, error?, durationMs?)` on each run.
5. Use `getPacificHour()` / `getTodayPacific()` for time gating.
6. Use `tryClaimSlot` pattern (`INSERT ON CONFLICT`) for once-per-day/month idempotency.
7. Wrap main logic in try/catch — never crash the interval.
8. Add `[Startup]` console.log in start function.
9. **`isRunning` overlap guard required (v8.78.0).** Module-scope `let isRunning = false`, check + set at top, reset in `finally`. All scheduler files have this.
10. **Store all timer IDs** (`setTimeout`/`setInterval`) in a variable/collection. `stopSchedulers()` must clear all.
11. **Export `stopXxxScheduler()` for setTimeout chains.** Both `memberSyncScheduler` and `backgroundSyncScheduler` follow this.
12. **Booking expiry targets `pending` AND `pending_approval`.** 20-min grace past start_time. Trackman-linked → `cancellation_pending`. Non-Trackman → `expired`. Call `broadcastAvailabilityUpdate()` after each.

## Idempotency Patterns

| Pattern | When to use | How |
|---|---|---|
| Time Gate (deprecated) | Exact hour match — **AVOID** (drift-prone) | `if (getPacificHour() !== TARGET) return` |
| Hour-Range + DB Claim Slot (v8.87.98) | Once per day, crash-safe, drift-safe | `if (hour >= TARGET && hour < TARGET + 2)` + `tryClaimXxxSlot(today)` DB INSERT ON CONFLICT |
| Hour-Range + Local Variable (v8.87.98) | Once per day, lightweight | `if (hour >= TARGET && hour < TARGET + N && lastDate !== today)` + reset `lastDate = ''` in catch |
| Yearly Gate | Once per year | Month + day-of-month check + year key claim slot |
| Weekly Gate | Once per week | `getDay() === 0` + hour-range + week-number tracking |

See [references/idempotency-patterns.md](references/idempotency-patterns.md) for code examples.

## Anti-Patterns (NEVER)

1. NEVER let errors propagate out of interval callbacks — always try/catch.
2. NEVER skip the `isRunning` overlap guard.
3. NEVER leave timer IDs untracked — all must be clearable on shutdown.
4. NEVER run time-gated schedulers without Pacific timezone helpers.
5. NEVER use exact-hour matching (`getPacificHour() === N`) for daily tasks — `setInterval` drift can skip the target hour entirely. Always use the date-windowed pattern (v8.87.96).

## Cross-References

- **Integrity checks** → `data-integrity-monitoring` skill
- **HubSpot queue processing** → `hubspot-sync` skill
- **Booking auto-complete** → `booking-flow` skill
- **Guest pass reset** → `guest-pass-system` skill
- **Grace period** → `member-lifecycle` skill

## Detailed Reference

- **[references/idempotency-patterns.md](references/idempotency-patterns.md)** — Code examples for all 5 idempotency patterns.
- **[references/scheduler-details.md](references/scheduler-details.md)** — Individual scheduler internals, edge cases, and timing details.

---

## Job Queue

`server/core/jobQueue.ts` — database-backed background job processor.

- Poll every 5 seconds for pending jobs
- Claim atomically with `FOR UPDATE SKIP LOCKED`
- Lock timeout: 5 minutes (auto-release stale locks)
- Batch size: 10 jobs per poll
- Max retries: 3 (configurable)
- Exponential backoff on failure

### Job Types

`send_payment_receipt`, `send_payment_failed_email`, `send_membership_renewal_email`, `send_membership_failed_email`, `send_pass_with_qr_email`, `notify_payment_success`, `notify_payment_failed`, `notify_staff_payment_failed`, `notify_member`, `notify_all_staff`, `broadcast_billing_update`, `broadcast_day_pass_update`, `send_notification_to_user`, `sync_to_hubspot`, `sync_company_to_hubspot`, `sync_day_pass_to_hubspot`, `upsert_transaction_cache`, `update_member_tier`, `stripe_credit_refund`, `stripe_credit_consume`, `generic_async_task`

### Queueing

```typescript
import { queueJob } from '../core/jobQueue';
await queueJob('send_payment_receipt', { to: email, ... }, { priority: 0, maxRetries: 3 });
```

Use `queueJobInTransaction(client, ...)` for in-transaction enqueue. Use `queueJobs([...])` for batch.

### Monitoring

- `getJobQueueStats()` — counts by status
- `cleanupOldJobs(daysToKeep)` — remove old completed/failed

## Scheduler Tracker API

- `registerScheduler(name, intervalMs)` — register at startup
- `recordRun(name, success, error?, durationMs?)` — record result
- `getSchedulerStatuses()` — sorted array for admin dashboard

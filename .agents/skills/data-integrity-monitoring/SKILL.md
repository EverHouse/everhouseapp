---
name: data-integrity-monitoring
description: Data integrity checks, monitoring infrastructure, alerts, webhook monitor, job queue monitor, HubSpot queue monitor, scheduler tracker, health checks, reconciliation, and the admin data integrity dashboard.
---

# Data Integrity & Monitoring System

## Architecture Overview

The monitoring system operates as a layered defense against data corruption, sync drift, and operational failures across four external services (Stripe, HubSpot, Google Calendar, Trackman) and the internal database.

```
┌─────────────────────────────────────────────────────────┐
│                   Admin Dashboard                        │
│  /admin/data-integrity  •  /admin/monitoring             │
├─────────────┬──────────────┬──────────────┬──────────────┤
│  Integrity  │  Scheduler   │  Webhook     │  Queue       │
│  Checks     │  Tracker     │  Monitor     │  Monitors    │
├─────────────┴──────────────┴──────────────┴──────────────┤
│               Alert & Notification Layer                  │
│  dataAlerts.ts  •  errorAlerts.ts  •  monitoring.ts       │
├─────────────────────────────────────────────────────────┤
│               Scheduler Engine (25+ tasks)                │
│  server/schedulers/index.ts  •  schedulerTracker.ts       │
├─────────────────────────────────────────────────────────┤
│               Database  •  External Services              │
│  PostgreSQL  •  Stripe  •  HubSpot  •  Google  •  Trackman│
└─────────────────────────────────────────────────────────┘
```

### Core Components

| Component | File | Purpose |
|---|---|---|
| Integrity Engine | `server/core/dataIntegrity.ts` | Run 25 integrity checks, store history, track issues, support ignore rules and audit log |
| Data Alerts | `server/core/dataAlerts.ts` | Send in-app staff notifications for integrity failures, sync errors, import issues |
| Error Alerts | `server/core/errorAlerts.ts` | Send email alerts for server errors, payment failures, external service issues |
| Monitoring Core | `server/core/monitoring.ts` | Log alerts to `system_alerts` table, provide in-memory recent alert buffer |
| Scheduler Tracker | `server/core/schedulerTracker.ts` | Track last run, success/failure, run count, and duration for every scheduler |
| Health Check | `server/core/healthCheck.ts` | Probe Database, Stripe, HubSpot, Resend, and Google Calendar for availability |
| Webhook Monitor | `server/core/webhookMonitor.ts` | Query Trackman webhook events by type, status, with pagination |
| Job Queue Monitor | `server/core/jobQueueMonitor.ts` | Report pending/processing/completed/failed jobs and oldest pending age |
| HubSpot Queue Monitor | `server/core/hubspotQueueMonitor.ts` | Report queue depth, failed items, avg processing time, and queue lag |
| Alert History | `server/core/alertHistoryMonitor.ts` | Query system-type notifications with date filtering, deduplicated by minute |
| Monitoring Routes | `server/routes/monitoring.ts` | Expose `/api/admin/monitoring/*` endpoints for the admin dashboard |

## Alert Severity Model

### Integrity Check Severities

Each of the 25 integrity checks has an assigned severity in `severityMap`:

- **Critical** — Require immediate attention. Trigger staff notifications on every run if status is `fail`. Examples: Stripe Subscription Sync, Billing Provider Hybrid State, Orphaned Payment Intents, Deal Stage Drift, Stuck Transitional Members.
- **High** — Trigger notifications when issue count exceeds a threshold (default 10). Examples: Tier Reconciliation, Duplicate Stripe Customers, Members Without Email, HubSpot ID Duplicates.
- **Medium** — Logged and visible in dashboard but do not trigger proactive alerts. Examples: Orphan Booking Participants, MindBody Stale Sync, Unmatched Trackman Bookings.
- **Low** — Informational. Examples: Sessions Without Participants, Items Needing Review.

### Error Alert Severities (Email)

`errorAlerts.ts` sends styled HTML emails to staff with plain-language translations:

| Type | Label Shown | When Sent |
|---|---|---|
| `server_error` | App Issue | Unhandled server errors (non-transient) |
| `database_error` | Database Issue | Database query failures |
| `external_service_error` | Connection Issue | Stripe/HubSpot/Google/Resend failures |
| `booking_failure` | Booking Issue | Booking processing errors |
| `payment_failure` | Payment Issue | Always sent (bypasses transient filter) |
| `security_alert` | Security Notice | Always sent (bypasses transient filter) |

### Monitoring Core Severities (In-Memory + DB)

`monitoring.ts` logs alerts with `critical | warning | info` to both an in-memory ring buffer (100 entries) and the `system_alerts` database table.

## Rate Limiting & Alert Fatigue Prevention

The system uses multiple mechanisms to prevent alert storms:

1. **Startup grace period** — Suppress all email alerts for 5 minutes after server start (`errorAlerts.ts`).
2. **Transient error filtering** — Skip alerts for ECONNRESET, ETIMEDOUT, 429, 502, 503, and similar patterns. Payment and security alerts bypass this filter.
3. **Per-key cooldown** — 4-hour cooldown between identical alert types (`errorAlerts.ts`). 30-minute cooldown for data alerts (`dataAlerts.ts`). 4-hour cooldown for integrity alerts specifically.
4. **Daily cap** — Maximum 3 email alerts per 24-hour period, tracked in `app_settings` table for persistence across restarts.
5. **Fingerprint deduplication** — Integrity alerts compare a fingerprint of current issues against the last-sent fingerprint. Suppress re-notification if issues have not changed and cooldown has not expired.

## How Checks Run

### Scheduled Execution

The integrity scheduler (`server/schedulers/integrityScheduler.ts`) polls every 30 minutes. At midnight Pacific (hour 0), it:

1. Claim a database lock via `system_settings` (upsert with `IS DISTINCT FROM` guard) to prevent duplicate execution across multiple deployment instances.
2. Run pre-check cleanup: remove orphaned notifications, mark orphaned bookings, normalize emails.
3. Execute all 25 integrity checks in parallel via `runAllIntegrityChecks()`.
4. Apply active ignore rules (time-bounded, stored in `integrity_ignores` table).
5. Store results in `integrity_check_history` (JSON blob + summary counts).
6. Update `integrity_issues_tracking` — mark new issues, auto-resolve issues no longer detected.
7. Send email alert via `sendIntegrityAlertEmail()` if errors or warnings found.
8. Send in-app staff notifications for critical and high-severity failures.

### On-Demand Execution

Staff can trigger a manual integrity check from the admin dashboard. This calls `runManualIntegrityCheck()` which runs the same 25 checks but skips the database lock claim and always sends an email if errors are found.

### Cached Results

`getCachedIntegrityResults()` returns the most recent stored results from `integrity_check_history` without re-running checks. The admin dashboard loads cached results by default and offers a "Run Now" button for fresh execution.

## Key Monitors

### Scheduler Tracker

`schedulerTracker.ts` maintains an in-memory registry of all 27 schedulers. Each scheduler calls `registerScheduler(name, intervalMs)` at startup and `recordRun(name, success, error?, durationMs?)` after each execution. The admin dashboard queries `/api/admin/monitoring/schedulers` to display:

- Task name, last run time, result (success/error/pending)
- Run count, last duration, expected interval, next expected run

### Webhook Monitor

`webhookMonitor.ts` queries the `trackman_webhook_events` table to surface:

- Events filtered by type and status (processed/failed/pending)
- Retry count and last retry timestamp per event
- Total count with pagination

### Job Queue Monitor

`jobQueueMonitor.ts` queries the `job_queue` table to report:

- Counts by status: pending, processing (locked), completed (last 24h), failed
- 20 most recent failed jobs with error messages, retry counts
- 10 most recent completed jobs
- Age of oldest pending job (detect stuck queue)

### HubSpot Queue Monitor

`hubspotQueueMonitor.ts` queries `hubspot_sync_queue` to report:

- Counts: pending, failed, completed (last 24h), currently processing
- 20 most recent failed items with operation type, error, retry info
- Average processing time (last 24h)
- Queue lag — time since oldest pending item was created

### Health Check

`healthCheck.ts` probes five services with a 5-second timeout each:

| Service | Check Method | Degraded Threshold |
|---|---|---|
| Database | `SELECT 1` | >1000ms latency |
| Stripe | `stripe.customers.list({limit:1})` | >2000ms latency |
| HubSpot | `contacts.basicApi.getPage({limit:1})` | >3000ms latency |
| Resend | API key existence check | — |
| Google Calendar | `calendarList.list({maxResults:1})` | >3000ms latency |

## Auto-Fix and Reconciliation

The system includes automated correction tasks:

- **Auto-Fix Tiers** (every 4h) — Normalize `membership_status` casing, set `billing_provider='mindbody'` for members with MindBody IDs, sync staff roles.
- **Stripe Reconciliation** (daily at 5am Pacific) — Compare Stripe subscriptions and daily payments against database records. Uses database lock for multi-instance safety.
- **Fee Snapshot Reconciliation** (every 15min) — Reconcile fee snapshot records against actual billing data.
- **Abandoned Pending Cleanup** (every 6h) — Delete users stuck in `pending` status >24h with no Stripe subscription, cascade-deleting related records in a transaction.

## Dashboard Overview

The admin data integrity dashboard is accessible at `/admin/data-integrity` (staff/admin only). It provides:

1. **Summary cards** — Total checks, passed, warnings, failed, total issues, last run time.
2. **Check results table** — Each check with status badge, issue count, severity, expandable issue details.
3. **Issue actions** — Per-issue: resolve, ignore (24h/1w/30d with reason), reopen. Sync push/pull for HubSpot mismatches.
4. **History view** — Trend chart (increasing/decreasing/stable), run history with timestamps and triggered-by.
5. **Active issues tracker** — Unresolved issues with days-unresolved counter, first-detected and last-seen dates.
6. **Audit log** — All resolve/ignore/reopen actions with who, when, and notes.
7. **Monitoring tabs** — Scheduler status, webhook events, job queue, HubSpot queue, alert history (via `/api/admin/monitoring/*` routes).

## Reference Files

- **[references/integrity-checks.md](references/integrity-checks.md)** — Complete list of all 25 integrity checks with detection logic, severity, and recommended actions. Also covers webhook, job queue, and HubSpot queue monitors.
- **[references/scheduler-map.md](references/scheduler-map.md)** — All 27+ scheduled tasks with frequencies, execution windows, and multi-instance safety details.

## Database Tables Used by Monitoring

| Table | Purpose |
|---|---|
| `integrity_check_history` | Store full results JSON and summary counts for each integrity run |
| `integrity_issues_tracking` | Track individual issues: first detected, last seen, resolved timestamps |
| `integrity_audit_log` | Record all resolve/ignore/reopen actions with attribution |
| `integrity_ignores` | Time-bounded ignore rules with reason and expiry |
| `system_alerts` | Persistent alert log written by `monitoring.ts` |
| `system_settings` | Database locks for multi-instance scheduler safety |
| `app_settings` | Persist error alert rate-limit state across restarts |
| `notifications` | System-type notifications used for in-app staff alerts and alert history |
| `trackman_webhook_events` | Webhook event log queried by webhook monitor |
| `job_queue` | Background job records queried by job queue monitor |
| `hubspot_sync_queue` | HubSpot async operation queue queried by HubSpot queue monitor |
| `session` | HTTP session table cleaned by session cleanup scheduler |

## Key Source Files

| File | Role |
|---|---|
| `server/core/dataIntegrity.ts` | 25 integrity checks, issue tracking, ignore rules, audit log, sync push/pull, bulk operations |
| `server/core/dataAlerts.ts` | In-app staff notifications for imports, sync failures, integrity issues, scheduled task failures |
| `server/core/errorAlerts.ts` | Email alerts with plain-language translation, rate limiting, transient error filtering |
| `server/core/monitoring.ts` | Alert logging to `system_alerts` table and in-memory buffer |
| `server/core/schedulerTracker.ts` | In-memory scheduler registry with run tracking |
| `server/core/healthCheck.ts` | Service availability probes with timeout and latency measurement |
| `server/core/webhookMonitor.ts` | Trackman webhook event queries |
| `server/core/jobQueueMonitor.ts` | Background job queue status queries |
| `server/core/hubspotQueueMonitor.ts` | HubSpot sync queue depth and failure queries |
| `server/core/alertHistoryMonitor.ts` | System notification history queries |
| `server/schedulers/index.ts` | Scheduler registration and startup |
| `server/schedulers/integrityScheduler.ts` | Nightly integrity check, auto-fix tiers, abandoned user cleanup |
| `server/routes/monitoring.ts` | Admin monitoring API endpoints |
| `server/core/sessionCleanup.ts` | Expired session deletion |
| `server/core/databaseCleanup.ts` | Test data, old bookings, old notifications, availability blocks, old jobs cleanup |

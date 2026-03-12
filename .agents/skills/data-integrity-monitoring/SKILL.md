---
name: data-integrity-monitoring
description: Data integrity checks, monitoring infrastructure, alerts, webhook monitor, job queue monitor, HubSpot queue monitor, scheduler tracker, health checks, reconciliation, and the admin data integrity dashboard.
---

# Data Integrity & Monitoring System

Layered defense against data corruption, sync drift, and operational failures across Stripe, HubSpot, Google Calendar, Trackman, and the internal database.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Integrity checks (26) | `server/core/dataIntegrity.ts` | Check logic, issue tracking, ignore rules, audit log |
| Data alerts (in-app) | `server/core/dataAlerts.ts` | Staff notifications for failures |
| Error alerts (email) | `server/core/errorAlerts.ts` | Email alerts with plain-language translation |
| Monitoring core | `server/core/monitoring.ts` | `system_alerts` table + in-memory buffer |
| Scheduler tracker | `server/core/schedulerTracker.ts` | In-memory scheduler health |
| Health check | `server/core/healthCheck.ts` | Service availability probes |
| Webhook monitor | `server/core/webhookMonitor.ts` | Trackman webhook events |
| Job queue monitor | `server/core/jobQueueMonitor.ts` | Background job status |
| HubSpot queue monitor | `server/core/hubspotQueueMonitor.ts` | HubSpot sync queue depth |
| Alert history | `server/core/alertHistoryMonitor.ts` | System notification queries |
| Monitoring routes | `server/routes/monitoring.ts` | `/api/admin/monitoring/*` endpoints |
| Integrity scheduler | `server/schedulers/integrityScheduler.ts` | Nightly checks, auto-fix, cleanup |

## Decision Trees

### When does an integrity alert fire?

```
Check completes
├── Severity = critical AND status = fail?
│   → Notify staff on EVERY run (even if same issues)
├── Severity = high AND issue_count > threshold (default 10)?
│   → Notify staff (with fingerprint dedup)
├── Severity = medium?
│   → Dashboard-visible only, no proactive alert
└── Severity = low?
    → Informational only
```

### Where does an alert go — email or in-app?

```
What type of alert?
├── Integrity check failure → In-app staff notification (dataAlerts.ts)
│   └── Also email if errors or warnings found (sendIntegrityAlertEmail)
├── Server/DB/external error → Email (errorAlerts.ts)
│   ├── Payment or security? → Always sent (bypass transient filter)
│   ├── ECONNRESET/ETIMEDOUT/429/502/503? → Filtered (transient)
│   └── Other → Subject to per-key 4h cooldown + 3/day cap
└── Monitoring metric → In-memory buffer + system_alerts table
```

### Adding a new integrity check

```
1. Add check function in dataIntegrity.ts
2. Register in runAllIntegrityChecks()
3. Assign severity in severityMap
4. Verify check detects STALE/INVALID state, not just counts records
5. Update total count in reference docs
```

## Hard Rules

1. **Integrity checks detect stale state, not just counts.** Lesson learned: "Unmatched Trackman Bookings" only counted unmatched — didn't detect stale terminal-status bookings still flagged as unmatched. A DB trigger now handles this. Verify new checks detect invalid state.
2. **Startup grace period.** Suppress all email alerts for 5 min after server start.
3. **Transient error filtering.** ECONNRESET, ETIMEDOUT, 429, 502, 503 are skipped. Payment and security alerts bypass this.
4. **Per-key cooldowns.** Error alerts: 4-hour. Data alerts: 30 min. Integrity alerts: 4 hours. Fingerprint dedup prevents re-notification for unchanged issues.
5. **Daily email cap: 3 per 24h.** Stored in `system_settings` (key: `alert_rate_limits`) for persistence across restarts.
6. **DB lock for multi-instance safety.** Integrity scheduler uses `system_settings` upsert with `IS DISTINCT FROM` guard.
7. **Auto-fix tiers run every 24h (daily safety net).** Normalize status casing, auto-classify billing_provider (Stripe first, then MindBody), sync staff roles. Primary enforcement is via DB triggers.
8. **Stripe billing_provider classification takes priority over MindBody.** Auto-fix checks Stripe subscription first.
9. **Default billing_provider is `'stripe'`.** Schema default + db-init ALTER + explicit creation paths.
10. **Booking auto-complete runs every 1 hr.** Marks approved/confirmed as `attended` 30 min after end time for same-day, or next day for overnight. Fee guard: blocks if unpaid fees exist.
11. **Abandoned pending cleanup (every 6h).** Delete users pending >24h with no Stripe subscription, cascade-deleting related records in transaction.
12. **Drizzle SQL null safety.** All optional values in `sql` template literals MUST use `?? null`. Prevents empty placeholder syntax errors.
13. **Webhook dedup cleanup.** `cleanupOldProcessedEvents()` runs probabilistically (5% of webhooks).

## Anti-Patterns (NEVER)

1. NEVER create an integrity check that only counts records — always detect stale/invalid state.
2. NEVER skip the startup grace period for email alerts.
3. NEVER bypass the daily email cap (3/day).
4. NEVER use `|| 0` for nullable IDs — use `?? null` to avoid matching id=0.

## Cross-References

- **All 27 schedulers** → `scheduler-jobs` skill
- **Stripe reconciliation** → `stripe-webhook-flow` skill
- **HubSpot queue monitoring** → `hubspot-sync` skill
- **Booking auto-complete** → `booking-flow` skill
- **Fee guard for auto-complete** → `fee-calculation` skill
- **Terminal status clears is_unmatched** → `booking-import-standards` Rule 21

## Detailed Reference

- **[references/integrity-checks.md](references/integrity-checks.md)** — Complete list of all 26 integrity checks with detection logic, severity, and recommended actions. Webhook, job queue, and HubSpot queue monitors.
- **[references/scheduler-map.md](references/scheduler-map.md)** — All 27 scheduled tasks with frequencies, execution windows, multi-instance safety.

---

## Alert Severity Model

### Integrity Check Severities

| Severity | Behavior | Examples |
|---|---|---|
| **Critical** | Notify staff every run | Stripe Sub Sync, Billing Provider Hybrid, Orphaned Payments, Overlapping Bookings |
| **High** | Notify when count > threshold (10) | Tier Reconciliation, Duplicate Stripe Customers, Guest Pass Drift |
| **Medium** | Dashboard only, no proactive alert | Orphan Participants, Unmatched Trackman, Email Cascade Orphans |
| **Low** | Informational | Sessions Without Participants, Items Needing Review |

### Error Alert Email Types

| Type | Label | When |
|---|---|---|
| `server_error` | App Issue | Unhandled server errors |
| `database_error` | Database Issue | DB query failures |
| `external_service_error` | Connection Issue | Stripe/HubSpot/Google/Resend |
| `booking_failure` | Booking Issue | Booking processing errors |
| `payment_failure` | Payment Issue | Always sent |
| `security_alert` | Security Notice | Always sent |

## Error Alert Email Enhancements (v8.12.0)

- **Plain-language translation:** `translateErrorToPlainLanguage()` converts raw errors → human-readable
- **Area detection:** `getFriendlyAreaName(path)` → "Stripe Payments", "Calendar Sync", etc.
- **Subject line specificity:** `⚠️ [Area] Specific Title`
- **Expandable technical details:** `<details>` section with full stack trace

## Rate Limiting Summary

| Mechanism | Scope | Details |
|---|---|---|
| Startup grace | Global | 5 min after server start |
| Transient filter | Per-error | Skip ECONNRESET, ETIMEDOUT, 429, 502, 503 |
| Per-key cooldown | Per-alert-type | 4h (errors), 30min (data), 4h (integrity) |
| Daily cap | Global | 3 emails/24h, persisted in system_settings |
| Fingerprint dedup | Integrity | Suppress if issues unchanged |
| DB-level dedup | Specific checks | 6h window for waiver review + stuck bookings |

## Health Check Probes

| Service | Method | Degraded Threshold |
|---|---|---|
| Database | `SELECT 1` | >1000ms |
| Stripe | `customers.list({limit:1})` | >2000ms |
| HubSpot | `contacts.basicApi.getPage({limit:1})` | >3000ms |
| Resend | API key check | — |
| Google Calendar | `calendarList.list({maxResults:1})` | >3000ms |

## Auto-Fix and Reconciliation

| Task | Interval | What |
|---|---|---|
| Auto-Fix Tiers | 24h | Normalize status, classify billing_provider, sync staff |
| Stripe Reconciliation | Daily 5 AM | Subscriptions + payments vs DB |
| Fee Snapshot Recon | 15 min | Pending fee snapshots |
| Abandoned Pending | 6h | Delete 24h+ pending users |
| Booking Auto-Complete | 1 hr | Mark attended 30 min after end |

## Database Tables

| Table | Purpose |
|---|---|
| `integrity_check_history` | Results JSON + summary per run |
| `integrity_issues_tracking` | Individual issues: detected, seen, resolved |
| `integrity_audit_log` | Resolve/ignore/reopen actions |
| `integrity_ignores` | Time-bounded ignore rules |
| `system_alerts` | Persistent alert log |
| `system_settings` | DB locks + alert rate-limit state |

## Admin Dashboard

`/admin/data-integrity` (staff/admin only):
1. Summary cards — total, passed, warnings, failed, issues, last run
2. Check results — status badge, issue count, severity, expandable details
3. Issue actions — resolve, ignore (24h/1w/30d), reopen, sync push/pull
4. History — trend chart, run history
5. Active issues — unresolved with days-unresolved counter
6. Audit log — all actions with attribution
7. Monitoring tabs — schedulers, webhooks, job queue, HubSpot queue, alert history

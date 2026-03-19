# Integrity Checks Reference

## Integrity Check Engine

All checks are defined in `server/core/integrity/` (modular split from `server/core/dataIntegrity.ts` in v8.69.0) and executed via `runAllIntegrityChecks()` in `server/core/integrity/core.ts`. Member-specific checks live in `server/core/integrity/memberChecks.ts`. Each check returns a result with `status` (pass/warning/fail), `issueCount`, and an array of `IntegrityIssue` objects containing `category`, `severity`, `table`, `recordId`, `description`, `suggestion`, and `context`.

Issues are categorized as: `orphan_record`, `sync_mismatch`, `data_quality`, `booking_issue`, `billing_issue`.

**Active checks: 21** (reduced from 27 — 6 eliminated by DB constraints/triggers)

---

## Eliminated Checks (prevented at DB level)

The following checks were removed because their issues are now impossible at the database level:

| Former Check | DB Protection | Added In |
|---|---|---|
| Participant User Relationships | `booking_participants.user_id` FK → `users.id ON DELETE SET NULL` (Drizzle schema) | Schema |
| Booking Time Validity | `booking_requests_time_order_check` + `booking_sessions_time_order_check` CHECK constraints | db-init.ts |
| Members Without Email | `users_active_email_check` CHECK constraint (active members must have email) | db-init.ts |
| HubSpot ID Duplicates | `users_hubspot_id_unique` partial unique index (production) | db-init.ts |
| Guest Passes Without Members | `trg_validate_guest_pass_member` trigger (validates member_email exists on INSERT/UPDATE) | db-init.ts |
| Email Cascade Orphans | 3-layer protection: (1) `trg_cascade_user_email_delete` + `trg_cascade_user_email_update` cascade user changes/deletes to 7 dependent tables; (2) `trg_validate_email_*` triggers on 6 child tables REJECT orphan inserts/updates (RAISE EXCEPTION); (3) startup cleanup removes existing orphans | db-init.ts |

---

## Downgraded Checks (informational safety nets)

These checks remain active but downgraded because DB triggers prevent new occurrences:

| Check | Old Severity | New Severity | DB Protection |
|---|---|---|---|
| Overlapping Bookings | critical | low | `check_booking_session_overlap` exclusion trigger |
| Billing Provider Hybrid State | critical | medium | `users_billing_provider_no_hybrid` CHECK + `trg_auto_billing_provider` trigger |
| Sessions Without Participants | low (fail) | low (warning) | `trg_link_participant_user_id` trigger auto-links owner |

---

## Critical Severity Checks

### HubSpot Sync Mismatch
- **Detects**: Members where app tier/name differs from HubSpot contact properties (firstname, lastname, membership_tier).
- **Logic**: Fetch HubSpot contacts by `hubspot_id`, compare normalized tier values using `denormalizeTierForHubSpot()`. Skip churned/no-tier statuses.
- **Action**: Use sync push (app→HubSpot) or sync pull (HubSpot→app) from the dashboard. Bulk push available via `bulkPushToHubSpot()`.

### Stripe Subscription Sync
- **Detects**: Members with `billing_provider='stripe'` whose local subscription status differs from the actual Stripe subscription state.
- **Logic**: Query Stripe API for each member's `stripe_subscription_id`, compare `status` field.
- **Action**: Update local status to match Stripe, or investigate why Stripe state diverged.

### Stuck Transitional Members
- **Detects**: Members in transitional statuses (pending, grace_period, etc.) for longer than expected thresholds.
- **Action**: Complete the transition or revert to a stable status.

### Active Bookings Without Sessions
- **Detects**: Confirmed booking requests that have no corresponding booking sessions. Excludes unassigned Trackman placeholder bookings (empty `user_email`) since those correctly defer session creation until a member is assigned (v8.87.93).
- **Action**: Create sessions for the booking or cancel the orphaned request.

### Orphaned Payment Intents
- **Detects**: Stripe payment intents recorded locally that have no matching booking or user.
- **Action**: Verify in Stripe dashboard and clean up orphaned records.

### Invoice-Booking Reconciliation
- **Detects**: (1) Duplicate Stripe invoices shared across multiple active bookings (double-billing risk). (2) Attended bookings within the last 90 days with no Stripe invoice created (unbilled service).
- **Action**: For duplicates, verify in Stripe dashboard and void/refund the duplicate invoice. For missing invoices, create invoice retroactively or investigate why billing was skipped.

---

## High Severity Checks

### Tier Reconciliation
- **Detects**: Members where `tier` and `membership_tier` fields disagree, or tier does not match what Stripe subscription metadata indicates.
- **Action**: Normalize tier values to match the authoritative source.

### Duplicate Stripe Customers
- **Detects**: Multiple Stripe customer IDs associated with the same member email.
- **Action**: Merge duplicate Stripe customers and update local references.

### Guest Pass Accounting Drift
- **Detects**: Three sub-conditions: (1) Guest pass records where passes_used exceeds passes_total (error). (2) Guest pass holds referencing non-existent bookings (orphan). (3) Expired guest pass holds not cleaned up.
- **Action**: For over-used passes, reconcile the count. For orphan/expired holds, clean up and adjust pass totals if needed.

### Stale Pending Bookings
- **Detects**: Booking requests in pending or approved status whose start time has already passed (within last 30 days, using Pacific timezone).
- **Action**: Mark as no-show, cancel, or confirm retroactively. Investigate why the booking was not processed before its start time.

### Archived Member Lingering Data
- **Detects**: Archived members who still have active future bookings, guest pass holds, group memberships, push subscriptions, confirmed wellness enrollments, future event RSVPs, or booking participations in others' bookings.
- **Action**: Clean up lingering data for the archived member or re-archive them using the updated archive flow (which now auto-cleans these records).

### Lingering Payment Intents on Terminal Bookings
- **Detects**: Payment intents in succeeded/requires_capture state on bookings that have been cancelled, declined, or are in other terminal statuses.
- **Action**: Cancel or refund the lingering payment intent.

---

## Medium Severity Checks

### MindBody Stale Sync
- **Detects**: Members with MindBody client IDs whose last sync timestamp is older than a threshold.
- **Action**: Trigger a fresh MindBody sync for affected members.

### MindBody Data Quality
- **Detects**: Members with MindBody data that has quality issues (missing fields, inconsistent status).
- **Action**: Review and correct member data.

### Unmatched Trackman Bookings
- **Detects**: Trackman webhook booking events that could not be matched to any local booking request.
- **Action**: Manually match or create bookings for unmatched Trackman events.

### Billing Provider Hybrid State (downgraded from critical)
- **Detects**: Active members with no billing provider set, or `billing_provider='stripe'` but no `stripe_subscription_id`.
- **Note**: The critical case (billing_provider='mindbody' with Stripe subscription) is now prevented by `users_billing_provider_no_hybrid` CHECK constraint. Auto-classification is handled by `trg_auto_billing_provider` trigger.
- **Action**: Classify billing provider as stripe, mindbody, manual, or comped.

### Active Members Without Waivers
- **Detects**: Active members (status='active', role='member') who have no signed waiver on file (waiver_signed_at IS NULL AND waiver_version IS NULL), created more than 7 days ago.
- **Action**: Request waiver signature from the member at their next visit.

---

## Low Severity Checks

### Sessions Without Participants (downgraded)
- **Detects**: Booking sessions that have no participants assigned.
- **Note**: `trg_link_participant_user_id` trigger auto-links owner participants on insert. This check catches edge cases only.
- **Action**: Add participants or review if session is still needed.

### Overlapping Bookings (downgraded from critical)
- **Detects**: Booking sessions where two or more active bookings overlap on the same resource on the same date within the last 30 days.
- **Note**: `check_booking_session_overlap` trigger prevents new overlaps. Remaining detections are legacy data or edge cases.
- **Action**: Reschedule or cancel one of the overlapping bookings.

### Items Needing Review
- **Detects**: Records across various tables flagged with `needs_review=true`.
- **Action**: Review and clear the flag.

### Stale Past Tours
- **Detects**: Tour records past their date still in active state.
- **Action**: Clean up stale tour records.

---

## Issue Management

### Ignore Rules
- Create time-bounded ignore rules (24h, 1w, 30d) with a reason via `createIgnoreRule()`.
- Stored in `integrity_ignores` table with `isActive` flag and `expiresAt` timestamp.
- Applied during check execution — ignored issues are annotated but still counted.

### Issue Tracking
- `integrity_issues_tracking` table tracks each unique issue by `issueKey` (format: `table_recordId`).
- Records `firstDetectedAt`, `lastSeenAt`, `resolvedAt`, `severity`, `checkName`, `description`.
- Issues auto-resolve when they disappear from check results.

### Audit Log
- Every resolve/ignore/reopen action is recorded in `integrity_audit_log` with `actionBy`, `actionAt`, `resolutionMethod`, and `notes`.

### History & Trends
- Each full run is stored in `integrity_check_history` with summary counts (critical, high, medium, low) and full JSON results.
- `getIntegrityHistory()` computes a trend (increasing/decreasing/stable) by comparing average issue counts of the 5 most recent vs 5 oldest runs in the window.

---

## Webhook Monitor

**File**: `server/core/webhookMonitor.ts`

Queries the `trackman_webhook_events` table to provide visibility into Trackman integration health.

### What It Tracks
- **Event types**: Distinct webhook event types received (e.g., booking.created, booking.updated).
- **Processing status**: Each event is classified as `processed` (has `processed_at`, no error), `failed` (has `processing_error`), or `pending` (neither).
- **Retry tracking**: `retry_count` and `last_retry_at` per event.
- **Matching**: Whether the webhook was matched to a local booking (`matched_booking_id`) and user (`matched_user_id`).

### API
- `GET /api/admin/monitoring/webhooks` — Paginated webhook events with type/status filtering (max 200 per page).
- `GET /api/admin/monitoring/webhook-types` — List of distinct event types.

---

## Job Queue Monitor

**File**: `server/core/jobQueueMonitor.ts`

Queries the `job_queue` table used by the background job processor.

### What It Tracks
- **Status counts**: pending, processing (locked), completed (last 24h), failed.
- **Failed jobs**: Last 20 failed jobs with `job_type`, `last_error`, `retry_count`, `max_retries`.
- **Completed jobs**: Last 10 completed jobs with timestamps.
- **Queue health**: Age of oldest pending job — if this grows, the processor may be stuck or overloaded.

### Stuck Job Detection
A job is considered "processing" if it has `status='pending'` and `locked_at IS NOT NULL`. The job processor runs every 5 seconds. If `oldestPending` age exceeds several minutes, investigate the processor.

### API
- `GET /api/admin/monitoring/jobs`

---

## HubSpot Queue Monitor

**File**: `server/core/hubspotQueueMonitor.ts`

Queries the `hubspot_sync_queue` table used for async HubSpot CRM operations.

### What It Tracks
- **Queue depth**: pending, failed, completed (last 24h), currently processing.
- **Failed syncs**: Last 20 failed items with `operation`, `last_error`, `retry_count`, `max_retries`, `next_retry_at`.
- **Performance**: Average processing time in ms (last 24h).
- **Queue lag**: Human-readable age of oldest pending item (e.g., "5m", "2h").

### Thresholds
- Queue lag >1h suggests the HubSpot queue processor is falling behind.
- Failed items with `retry_count >= max_retries` will not be retried automatically.

### API
- `GET /api/admin/monitoring/hubspot-queue`

---

## Alert History

**File**: `server/core/alertHistoryMonitor.ts`

Queries the `notifications` table for system-type alerts to provide a chronological view of all automated alerts sent to staff.

### How Alerts Are Stored
- All data alerts (`dataAlerts.ts`) call `notifyAllStaff()` which creates notification records with `type='system'`.
- Error alerts (`errorAlerts.ts`) send emails directly via Resend — these are not stored in the notifications table.
- Monitoring alerts (`monitoring.ts`) are stored in the `system_alerts` table (separate from notifications).

### How Alerts Are Surfaced
- `getAlertHistory()` queries notifications with `type='system'`, deduplicates by title per minute, and sorts by recency.
- Supports date range filtering and configurable limit (max 200).
- Available via `GET /api/admin/monitoring/alerts` with `startDate`, `endDate`, and `limit` query parameters.

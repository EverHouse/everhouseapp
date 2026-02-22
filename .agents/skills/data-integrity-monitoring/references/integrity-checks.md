# Integrity Checks Reference

## Integrity Check Engine

All checks are defined in `server/core/dataIntegrity.ts` and executed via `runAllIntegrityChecks()`. Each check returns a result with `status` (pass/warning/fail), `issueCount`, and an array of `IntegrityIssue` objects containing `category`, `severity`, `table`, `recordId`, `description`, `suggestion`, and `context`.

Issues are categorized as: `orphan_record`, `sync_mismatch`, `data_quality`, `booking_issue`, `billing_issue`.

---

## Critical Severity Checks

### HubSpot Sync Mismatch
- **Detects**: Members where app tier/name differs from HubSpot contact properties (firstname, lastname, membership_tier).
- **Logic**: Fetch HubSpot contacts by `hubspot_id`, compare normalized tier values using `denormalizeTierForHubSpot()`. Skip churned/no-tier statuses.
- **Action**: Use sync push (app→HubSpot) or sync pull (HubSpot→app) from the dashboard. Bulk push available via `bulkPushToHubSpot()`.

### Deal Stage Drift
- **Detects**: HubSpot deals where the pipeline stage does not match the expected stage based on the member's current membership status.
- **Action**: Review deal in HubSpot and update stage, or update member status in app.

### Stripe Subscription Sync
- **Detects**: Members with `billing_provider='stripe'` whose local subscription status differs from the actual Stripe subscription state.
- **Logic**: Query Stripe API for each member's `stripe_subscription_id`, compare `status` field.
- **Action**: Update local status to match Stripe, or investigate why Stripe state diverged.

### Stuck Transitional Members
- **Detects**: Members in transitional statuses (pending, grace_period, etc.) for longer than expected thresholds.
- **Action**: Complete the transition or revert to a stable status.

### Active Bookings Without Sessions
- **Detects**: Confirmed booking requests that have no corresponding booking sessions.
- **Action**: Create sessions for the booking or cancel the orphaned request.

### Orphaned Fee Snapshots
- **Detects**: Fee snapshot records referencing users or bookings that no longer exist.
- **Action**: Delete orphaned snapshots or re-link to correct records.

### Orphaned Payment Intents
- **Detects**: Stripe payment intents recorded locally that have no matching booking or user.
- **Action**: Verify in Stripe dashboard and clean up orphaned records.

### Billing Provider Hybrid State
- **Detects**: Three sub-conditions: (1) `billing_provider='mindbody'` but has Stripe subscription (severity: error), (2) Active member with no billing provider set (severity: warning), (3) `billing_provider='stripe'` but no `stripe_subscription_id` (severity: warning).
- **Action**: Update billing_provider to match actual billing source.

---

## High Severity Checks

### Participant User Relationships
- **Detects**: Booking participants referencing user IDs that do not exist in the users table.
- **Action**: Delete orphaned participants or re-link to correct user.

### Booking Resource Relationships
- **Detects**: Booking requests referencing resource IDs that do not exist in the resources table.
- **Action**: Update resource assignment or cancel booking.

### Booking Time Validity
- **Detects**: Bookings with invalid time ranges (end before start, zero duration, excessive duration).
- **Action**: Correct time values or cancel invalid bookings.

### Members Without Email
- **Detects**: User records with role='member' that have no email address.
- **Action**: Add email or archive the record.

### Deals Without Line Items
- **Detects**: HubSpot deals that have no associated line items.
- **Action**: Add line items in HubSpot or mark deal as informational.

### Tier Reconciliation
- **Detects**: Members where `tier` and `membership_tier` fields disagree, or tier does not match what Stripe subscription metadata indicates.
- **Action**: Normalize tier values to match the authoritative source.

### Duplicate Stripe Customers
- **Detects**: Multiple Stripe customer IDs associated with the same member email.
- **Action**: Merge duplicate Stripe customers and update local references.

### HubSpot ID Duplicates
- **Detects**: Multiple local user records pointing to the same HubSpot contact ID.
- **Action**: Merge duplicate users or correct HubSpot ID assignments.

---

## Medium Severity Checks

### Orphan Booking Participants
- **Detects**: Booking participants referencing booking sessions that no longer exist.
- **Action**: Delete orphaned participant records.

### Orphan Wellness Enrollments
- **Detects**: Wellness class enrollments referencing classes that no longer exist.
- **Action**: Delete orphaned enrollment records.

### Orphan Event RSVPs
- **Detects**: Event RSVPs referencing events that no longer exist.
- **Action**: Delete orphaned RSVP records.

### MindBody Stale Sync
- **Detects**: Members with MindBody client IDs whose last sync timestamp is older than a threshold.
- **Action**: Trigger a fresh MindBody sync for affected members.

### MindBody Data Quality
- **Detects**: Members with MindBody data that has quality issues (missing fields, inconsistent status).
- **Action**: Review and correct member data.

### Unmatched Trackman Bookings
- **Detects**: Trackman webhook booking events that could not be matched to any local booking request.
- **Action**: Manually match or create bookings for unmatched Trackman events.

### Guest Passes Without Members
- **Detects**: Guest pass records where the associated member email does not match any user.
- **Action**: Link to correct member or delete orphaned passes.

### Invoice-Booking Reconciliation
- **Detects**: (1) Duplicate Stripe invoices shared across multiple active bookings (double-billing risk). (2) Attended bookings within the last 90 days with no Stripe invoice created (unbilled service).
- **Action**: For duplicates, verify in Stripe dashboard and void/refund the duplicate invoice. For missing invoices, create invoice retroactively or investigate why billing was skipped.

### Overlapping Bookings
- **Detects**: Booking sessions where two or more active bookings (approved/confirmed/attended) overlap on the same resource (bay) on the same date within the last 30 days.
- **Action**: Reschedule or cancel one of the overlapping bookings to resolve the conflict. Investigate if this resulted from a race condition in the booking flow.

### Guest Pass Accounting Drift
- **Detects**: Three sub-conditions: (1) Guest pass records where passes_used exceeds passes_total (error). (2) Guest pass holds referencing non-existent bookings (orphan). (3) Expired guest pass holds not cleaned up.
- **Action**: For over-used passes, reconcile the count. For orphan/expired holds, clean up and adjust pass totals if needed.

### Stale Pending Bookings
- **Detects**: Booking requests in pending or approved status whose start time has already passed (within last 30 days, using Pacific timezone).
- **Action**: Mark as no-show, cancel, or confirm retroactively. Investigate why the booking was not processed before its start time.

---

## Low Severity Checks

### Sessions Without Participants
- **Detects**: Booking sessions that have no participants assigned.
- **Action**: Add participants or review if session is still needed.

### Items Needing Review
- **Detects**: Records across various tables flagged with `needs_review=true`.
- **Action**: Review and clear the flag.

### Duplicate Tour Sources / Stale Past Tours
- **Detects**: Tour records with duplicate source identifiers or tours past their date still in active state.
- **Action**: Clean up duplicate or stale tour records.

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

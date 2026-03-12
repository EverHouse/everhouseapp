# Scheduler Details

Detailed logic for each scheduler, grouped by category.

## Notification Schedulers

### Daily Reminder (6 PM Pacific)

**File:** `server/schedulers/dailyReminderScheduler.ts`
**Interval:** 30 min check | **Time Gate:** `getPacificHour() === 18`

1. Check if current Pacific hour is 18 (6 PM)
2. Claim daily slot via `tryClaimReminderSlot(todayStr)` — INSERT INTO system_settings with key `last_daily_reminder_date`, ON CONFLICT update only if value IS DISTINCT FROM today
3. If claimed, call `sendDailyReminders()` which queries tomorrow's event RSVPs, approved bookings, and wellness enrollments
4. Batch insert notifications + push notifications + WebSocket broadcasts
5. Record success/failure via `schedulerTracker.recordRun('Daily Reminder', ...)`

### Morning Closure (8 AM Pacific)

**File:** `server/schedulers/morningClosureScheduler.ts`
**Interval:** 30 min check | **Time Gate:** `getPacificHour() === 8`

1. Check if current Pacific hour is 8 (8 AM)
2. Claim daily slot via `tryClaimMorningSlot(todayStr)` — same INSERT ON CONFLICT pattern with key `last_morning_closure_notification_date`
3. If claimed, call `sendMorningClosureNotifications()` which queries today's active published closures
4. Send idempotent notification per closure to all members + push notifications

### Onboarding Nudge (10 AM Pacific)

**File:** `server/schedulers/onboardingNudgeScheduler.ts`
**Interval:** 1 hr | **Time Gate:** `getPacificHour() === 10`

1. Check if current Pacific hour is 10 (10 AM)
2. Query stalled members: `membership_status IN ('active', 'trialing')`, `billing_provider = 'stripe'`, `first_login_at IS NULL`, `onboarding_completed_at IS NULL`, `onboarding_nudge_count < 3`, created > 20 hours ago, last nudge > 20 hours ago
3. For each member, determine which nudge to send based on `onboarding_nudge_count` and hours since signup:
   - Nudge #1: 24+ hours → `sendOnboardingNudge24h()`
   - Nudge #2: 72+ hours → `sendOnboardingNudge72h()`
   - Nudge #3: 168+ hours (7 days) → `sendOnboardingNudge7d()`
4. Update `onboarding_nudge_count` and `onboarding_last_nudge_at` on success
5. Limit: 20 members per run

## Billing & Stripe Schedulers

### Stripe Reconciliation (5 AM Pacific)

**File:** `server/schedulers/stripeReconciliationScheduler.ts`
**Interval:** 1 hr check | **Time Gate:** `getPacificHour() === 5`

1. Check if current Pacific hour is 5 (5 AM)
2. Claim daily slot via `tryClaimReconciliationSlot(todayStr)` — key `last_stripe_reconciliation_date`
3. If claimed, run two reconciliation passes:
   - `reconcileDailyPayments()` — sync payment records with Stripe
   - `reconcileSubscriptions()` — sync subscription statuses with Stripe
4. On failure, alert staff via `alertOnScheduledTaskFailure('Daily Stripe Reconciliation', ...)`

### Fee Snapshot Reconciliation (15 min)

**File:** `server/schedulers/feeSnapshotReconciliationScheduler.ts`
**Interval:** 15 min | **Time Gate:** None

Runs three sub-tasks every 15 minutes:

1. **Reconcile pending snapshots** — find `booking_fee_snapshots` with status `pending` and a Stripe payment intent, older than 5 minutes. Check Stripe for actual status:
   - If `succeeded` → call `PaymentStatusService.markPaymentSucceeded()`
   - If `canceled` → call `PaymentStatusService.markPaymentCancelled()`
   - If PI not found in Stripe → mark snapshot as cancelled
   - Limit: 50 per run

2. **Cancel abandoned payment intents** — find `stripe_payment_intents` in pending/requires_* states older than 2 hours:
   - Cancel in Stripe, then update local DB status to `canceled`
   - Handle `payment_intent_unexpected_state` by syncing actual Stripe status
   - Limit: 30 per run

3. **Reconcile stale payment intents** — find `stripe_payment_intents` with status `pending` older than 7 days:
   - If no linked booking or booking is cancelled/declined/expired → mark as canceled
   - If booking is attended/confirmed → check Stripe for actual status and sync
   - Limit: 20 per run

Uses DB connection timeouts (10s) and statement timeouts (30s) for safety.

### Grace Period (10 AM Pacific)

**File:** `server/schedulers/gracePeriodScheduler.ts`
**Interval:** 1 hr | **Time Gate:** `getPacificHour() === 10`

1. Query members with `grace_period_start IS NOT NULL` and `grace_period_email_count < 3`
2. For each member:
   - Generate a Stripe billing portal reactivation link
   - Send grace period reminder email (day 1, 2, or 3 of 3)
   - Increment `grace_period_email_count`
3. If email count reaches 3 AND days since grace start ≥ 3:
   - Set `tier = NULL`, `membership_status = 'terminated'`, clear grace period fields
   - Sync terminated status to HubSpot
   - Notify all staff about membership termination

## Booking Schedulers

### Booking Expiry (hourly)

**File:** `server/schedulers/bookingExpiryScheduler.ts`
**Interval:** 1 hr | **Time Gate:** None

1. Compare each pending booking's `request_date` and `start_time` against current Pacific date/time
2. UPDATE matching bookings to status `expired`, set `reviewed_by = 'system-auto-expiry'`
3. Log each expired booking with member name and date
4. If 2+ bookings expired, send summary notification to all staff (up to 5 listed)
5. Initial run after 1 minute delay

### Stuck Cancellation (2 hr)

**File:** `server/schedulers/stuckCancellationScheduler.ts`
**Interval:** 2 hr | **Time Gate:** None

1. Query bookings with `status = 'cancellation_pending'` and `cancellation_pending_at < NOW() - INTERVAL '4 hours'`
2. Check if each booking was already alerted in the last 4 hours (via notifications table with type `cancellation_stuck`)
3. For new stuck bookings, build a summary (up to 10) showing member name, date, time, bay, hours stuck
4. Send URGENT push notification to all staff
5. Initial run after 1 minute delay

## Data Sync Schedulers

### Background Sync (5 min)

**File:** `server/schedulers/backgroundSyncScheduler.ts`
**Interval:** 5 min | **Time Gate:** None

Syncs five Google Calendar sources with retry logic:
1. Events calendar → `syncGoogleCalendarEvents()`
2. Wellness calendar → `syncWellnessCalendarEvents()`
3. Tours calendar → `syncToursFromCalendar()`
4. Closures calendar → `syncInternalCalendarToClosures()`
5. Conference room calendar → `syncConferenceRoomCalendarToBookings()`

Each sync uses `syncWithRetry()`: attempt once, if failed retry after 5 seconds. Track consecutive failures per source; alert staff via `alertOnSyncFailure()` after 2 consecutive failures. First sync starts 5 minutes after boot.

### Member Sync (3 AM Pacific)

**File:** `server/schedulers/memberSyncScheduler.ts`
**Interval:** ~24 hr (computed) | **Time Gate:** 3 AM Pacific

1. Calculate milliseconds until next 3 AM Pacific using `getPacificDateParts()`
2. At 3 AM, call `syncAllMembersFromHubSpot()` for full daily member data synchronization
3. Update `lastMemberSyncTime` on success
4. Schedule next run dynamically (recalculate ms until next 3 AM)

### Communication Logs Sync (30 min)

**File:** `server/schedulers/communicationLogsScheduler.ts`
**Interval:** 30 min | **Time Gate:** None

1. Wait 10 minutes after startup
2. Call `triggerCommunicationLogsSync()` from `server/core/memberSync`
3. Repeat every 30 minutes

### HubSpot Queue (2 min)

**File:** `server/schedulers/hubspotQueueScheduler.ts`
**Interval:** 2 min | **Time Gate:** None

1. Recover any jobs stuck in `processing` state (server crash recovery) via `recoverStuckProcessingJobs()`
2. Process up to 50 queued HubSpot operations per batch via `processHubSpotQueue(50)`
3. Log queue stats (pending, failed, dead counts)
4. On startup, ensure HubSpot properties exist via `ensureHubSpotPropertiesExist()`
5. Mutex guard: skip if already processing (`isProcessing` flag)
6. Alert staff on failure via `alertOnScheduledTaskFailure()`

### HubSpot Form Sync (30 min)

**File:** `server/schedulers/hubspotFormSyncScheduler.ts`
**Interval:** 30 min | **Time Gate:** None

1. Call `syncHubSpotFormSubmissions()` from `server/core/hubspot/formSync`
2. Mutex guard: skip if already syncing (`isSyncing` flag)
3. Initial run after 1 minute delay

## Cleanup Schedulers

### Weekly Cleanup (Sunday 3 AM Pacific)

**File:** `server/schedulers/weeklyCleanupScheduler.ts`
**Interval:** 1 hr check | **Time Gate:** Sunday (`getDay() === 0`) + hour 3

1. Check day of week is Sunday AND hour is 3 AM Pacific
2. Track current week number to prevent re-runs within same week (`lastCleanupWeek`)
3. Call `runScheduledCleanup()` from `server/core/databaseCleanup`
4. Call `runSessionCleanup()` from `server/core/sessionCleanup`

### Duplicate Cleanup (4 AM Pacific)

**File:** `server/schedulers/duplicateCleanupScheduler.ts`
**Interval:** 1 hr check | **Time Gate:** `getPacificHour() === 4`

1. Check if current hour is 4 AM and `lastCleanupDate !== todayStr`
2. Find duplicate `booking_requests` by `trackman_booking_id` (keep earliest by `created_at`)
3. Delete related records in order: `booking_payment_audit`, `booking_fee_snapshots`, `booking_members`, then `booking_requests`
4. Run within a transaction (BEGIN/COMMIT/ROLLBACK)
5. Also run once on startup (10s delay)

### Session Cleanup (2 AM Pacific)

**File:** `server/schedulers/sessionCleanupScheduler.ts`
**Interval:** 1 hr check | **Time Gate:** `getPacificHour() === 2`

1. Check if current Pacific hour is 2
2. Dynamically import and call `runSessionCleanup()` from `server/core/sessionCleanup`
3. Remove expired HTTP sessions from the database

### Webhook Log Cleanup (4 AM Pacific)

**File:** `server/schedulers/webhookLogCleanupScheduler.ts`
**Interval:** 1 hr check | **Time Gate:** `getPacificHour() === 4`

1. Check if current Pacific hour is 4
2. Dynamically import and call `cleanupOldWebhookLogs()` from `server/routes/trackman/index`
3. Delete webhook logs older than 30 days

### Webhook Event Cleanup (24 hr)

**File:** `server/schedulers/webhookEventCleanupScheduler.ts`
**Interval:** 24 hr | **Time Gate:** None

1. DELETE FROM `webhook_processed_events` WHERE `processed_at < NOW() - INTERVAL '7 days'`
2. Log count of deleted deduplication records
3. Initial run after 5 minutes delay

### Pending User Cleanup (6 hr)

**File:** `server/schedulers/pendingUserCleanupScheduler.ts`
**Interval:** 6 hr | **Time Gate:** None

1. Query users with `membership_status = 'pending'`, `billing_provider = 'stripe'`, created > 48 hours ago, no subscription
2. For each user with a Stripe customer ID:
   - List and cancel all active/trialing/past_due/incomplete subscriptions
   - Delete the Stripe customer
   - Skip DB deletion if Stripe cleanup fails (prevent orphaned billing)
3. DELETE the user from the database
4. Limit: 50 per run
5. Initial run after 1 minute delay

## Compliance Schedulers

### Integrity Check (Midnight Pacific)

**File:** `server/schedulers/integrityScheduler.ts`
**Interval:** 30 min check | **Time Gate:** `getPacificHour() === 0`

1. Claim daily slot via `tryClaimIntegritySlot(todayStr)` — key `last_integrity_check_date`
2. Run pre-check cleanup: `runDataCleanup()` (orphaned notifications, orphaned bookings, email normalization)
3. Run `runAllIntegrityChecks()` — full data integrity validation suite
4. Count errors and warnings across all check results
5. If any issues found and `ADMIN_ALERT_EMAIL` is configured, send integrity alert email
6. On failure, alert staff via `alertOnScheduledTaskFailure()`

**Sub-schedulers in same file:**
- **Auto-Fix Tiers** (4 hr, no time gate): call `autoFixMissingTiers()` — normalize membership_status case, set billing_provider for MindBody members, fix tiers from alternate emails, sync staff roles
- **Abandoned Pending Cleanup** (6 hr, no time gate): delete users with `membership_status = 'pending'` older than 24 hours with no subscription, cascade-delete related records (notifications, booking participants, sessions, RSVPs, enrollments, fees, notes, guest passes)

### Waiver Review (4 hr)

**File:** `server/schedulers/waiverReviewScheduler.ts`
**Interval:** 4 hr | **Time Gate:** None (but has 3-hour minimum between checks)

1. Query `booking_participants` where `payment_status = 'waived'`, `waiver_reviewed_at IS NULL`, not a guest pass, created > 12 hours ago
2. If stale waivers found, notify all staff with count
3. Track `lastCheckTime` to enforce minimum 3-hour gap between checks
4. On failure, alert staff via `alertOnScheduledTaskFailure()`

### Unresolved Trackman (9 AM Pacific)

**File:** `server/schedulers/unresolvedTrackmanScheduler.ts`
**Interval:** 15 min check | **Time Gate:** `getPacificHour() === 9`

1. Claim daily slot via `tryClaimUnresolvedTrackmanSlot(todayStr)` — key `last_unresolved_trackman_check_date`
2. Query `booking_requests` where origin is `trackman_webhook` or `trackman_import`, `user_id IS NULL`, status is `pending` or `unmatched`, created > 24 hours ago
3. If unresolved bookings found, notify all staff with count and oldest date (push notification)

## Pass Management

### Guest Pass Reset (3 AM Pacific, 1st of Month)

**File:** `server/schedulers/guestPassResetScheduler.ts`
**Interval:** 1 hr check | **Time Gate:** `getPacificHour() === 3` AND `getPacificDayOfMonth() === 1`

1. Check if current hour is 3 AM AND day of month is 1
2. Claim monthly slot via `tryClaimResetSlot(monthKey)` — key `last_guest_pass_reset`, value format `YYYY-MM`
3. UPDATE `guest_passes` SET `passes_used = 0` WHERE `passes_used > 0`
4. Log each member's reset status

## Infrastructure Schedulers

### Supabase Heartbeat (6 hr)

**File:** `server/schedulers/supabaseHeartbeatScheduler.ts`
**Interval:** 6 hr | **Time Gate:** None

1. Skip if Supabase is not configured
2. Ping Supabase by querying user count
3. Log successful heartbeat with user count
4. Record run via `schedulerTracker.recordRun('Supabase Heartbeat', ...)`

# Changelog

All notable changes to the Ever Club Members App are documented here.

## [8.79.0] - 2026-03-06

### Staff Analytics Dashboard
- **Booking Analytics Page**: New staff-only analytics dashboard at `/admin/analytics` with 14 visualizations across three endpoints (`/api/analytics/booking-stats`, `/api/analytics/extended-stats`, `/api/analytics/membership-insights`). Includes:
  - Total Bookings / Cancellation Rate / Avg Session Length stat cards
  - Weekly Peak Hours Heatmap (day × hour grid with color intensity)
  - Resource Utilization horizontal bar chart (total hours per bay/room)
  - Top 5 Members leaderboard (by total hours booked)
  - Bookings Over Time line chart (weekly counts, last 6 months)
  - Revenue Over Time stacked area chart (confirmed Stripe payments by category)
  - Day of Week bar chart (all-time booking distribution)
  - Utilization by Hour bar chart (average utilization % per time slot)
  - Active vs Inactive Members ring charts (30/60/90 day windows)
  - Booking Frequency histogram (member count by booking bucket over 90 days)
  - Tier Distribution donut pie chart (active members by membership tier)
  - At-Risk Members list (no booking in 45+ days, max 15)
  - New Member Growth line chart (monthly signups over 6 months)
- **Tech**: Recharts library (BarChart, LineChart, AreaChart, PieChart, SVG ring charts), TanStack Query with three parallel queries.
- **Files**: `server/routes/analytics.ts`, `src/pages/Admin/tabs/AnalyticsTab.tsx`
- **Navigation**: Analytics added to both desktop sidebar and mobile hamburger menu via shared `nav-constants.ts`.

### Marketing & Tracking
- **Meta Pixel Integration**: Facebook/Meta Pixel tracking code added to `index.html` for all public pages — enables ad performance measurement, conversion tracking, and retargeting.

### Analytics Data Accuracy Fixes
- **Revenue Categorization**: `extended-stats` endpoint now checks both `metadata.type` and `description` fields on Stripe charges for accurate category assignment (memberships, overage, guest, day pass, other).
- **Tier Normalization**: `membership-insights` endpoint normalizes tier names (trims whitespace, lowercases) before grouping — prevents duplicate chart entries like "Gold" and "gold".
- **New Member Count**: `membership-insights` filters out imported HubSpot contacts (`source != 'hubspot_import'`) — only counts genuinely new signups.
- **Guest Fee Calculation**: `booking-stats` now joins `booking_participants` to include participant-level fee data in financial summaries.

### Bug & Stability Fixes
- **Tour Status Dropdown**: Adjusted z-index layering on `ToursTab.tsx` dropdown so it renders above adjacent elements — previously unclickable on mobile.
- **Cafe/Tiers Stale Data**: `CafeTab.tsx` and `TiersTab.tsx` now trigger React Query refetch after pulling latest data from Stripe — previously showed stale prices until a full page reload.
- **Billing Provider Validation**: Added database-level CHECK constraints and server-side validation for `billing_provider` column — prevents invalid values from being written. Cleanup migration corrects any existing invalid entries.
- **Database Connection Handling**: Improved connection pool error handling in `db-init.ts` to prevent cascading failures during high-traffic periods.
- **WebSocket Domain Cleanup**: Removed old domain from allowed WebSocket origins in `server/core/websocket.ts`.

## [8.78.0] - 2026-03-06

### Scheduler & Realtime Hardening
- **Full Scheduler Overlap Protection**: All 25 schedulers now have overlap guards preventing duplicate concurrent executions. Added `isRunning` guards to 9 previously unguarded schedulers across two audit passes:
  - **Pass 1**: `gracePeriodScheduler` (most critical — prevented duplicate termination emails), `stripeReconciliationScheduler`, `dailyReminderScheduler`, `morningClosureScheduler`, `unresolvedTrackmanScheduler`.
  - **Pass 2**: `onboardingNudgeScheduler` (also added error handling — previously had no try/catch so failures were unhandled rejections), `waiverReviewScheduler`, `supabaseHeartbeatScheduler`, `feeSnapshotReconciliationScheduler` (rewired 3 concurrent Stripe/billing sub-tasks to use `Promise.allSettled` with a single guard — previously the next interval could fire all 3 again while previous ones were still running).
- **Scheduler Startup Safety**: `staggerStart()` in `schedulers/index.ts` now wraps each scheduler start in try/catch so a single scheduler failure doesn't prevent the rest from starting.
- **Background Sync Tracking**: `backgroundSyncScheduler.ts` now calls `schedulerTracker.recordRun()` on success for accurate health dashboard reporting.
- **Supabase Realtime Gap Fixes (6 issues)**: Corrected React Query cache invalidation keys (`['bookings']`, `['command-center']`, `['trackman']`, `['simulator']`, `['announcements']`), added reconnection-triggered cache invalidation, recovery timer cleanup on disconnect, and initial heartbeat timer tracking in `supabaseHeartbeatScheduler`.
- **Data Integrity Sync Fixes**: Fixed Zod schema validation — `user_id` type corrected from `string` to `number` to match DB column type, removed unsupported `'calendar'` sync target from validator (backend only supports `'hubspot'` and `'stripe'`), and fixed Stripe handler push/pull sync implementation.
- **Member Sync Overlap Guard**: Added `isRunning` flag and double-start protection to `memberSyncScheduler.ts` — the last scheduler without overlap protection. Now all 25 schedulers are fully guarded.

## [8.77.5] - 2026-03-05

### Comprehensive Audit Fixes
- **Unhandled Rejection Shutdown**: `process.on('unhandledRejection')` in `server/index.ts` now schedules `process.exit(1)` with a 5-second grace period (`.unref()`). Prevents the app from continuing in a potentially inconsistent state after an unhandled promise rejection.
- **Silent Catch Elimination (Server)**: 3 silent `.catch(() => {})` in `server/schedulers/feeSnapshotReconciliationScheduler.ts` replaced with logged warnings for connection release failures.
- **Silent Catch Elimination (Frontend)**: 32+ silent error-swallowing patterns (`.catch(() => {})` and empty `catch {}`) across 23 frontend files replaced with `console.warn` logging. Covers payment components (`TerminalPayment`, `StripePaymentForm`, `MemberPaymentModal`, `BillingSection`), staff tools (`AvailabilityBlocksContent`, `DirectoryTab`, `MemberProfileDrawer`, `CommandCenterData`), public pages (`Footer`, `FAQ`, `Contact`), error boundaries (`PageErrorBoundary`), data contexts (`CafeDataContext`, `EventDataContext`), member pages (`Dashboard`, `Checkout`), onboarding (`FirstLoginWelcomeModal`, `OnboardingChecklist`), utilities (`useFormPersistence`, `simulatorUtils`), and service worker (`main.tsx`, `useServiceWorkerUpdate`).
- **Prefetch Error Logging**: 4 silent catches in `src/lib/prefetch-actions.ts` replaced with `console.warn` for API, member history, member notes, and booking detail prefetch failures.
- **Auth Middleware Consistency**: `GET /api/booking-requests` and `GET /api/booking-requests/:id` in `server/routes/bays/bookings.ts` now use `isAuthenticated` middleware (previously relied only on in-handler session checks). Handler-level checks remain as defense-in-depth.
- **Public Route Documentation**: 30 intentionally public routes across 18 route files marked with `// PUBLIC ROUTE` comments for audit clarity (auth, booking, calendar, availability, tours, announcements, wellness, Stripe config, push VAPID key, day passes, etc.).
- **dataTools.ts Split**: `server/routes/dataTools.ts` (2,683 lines) split into `server/routes/dataTools/` directory with 5 sub-routers: `member-sync.ts`, `booking-tools.ts`, `audit.ts`, `stripe-tools.ts`, `maintenance.ts`, plus barrel `index.ts`.
- **New Test Coverage**: Added `tests/errorUtils.test.ts` (26 tests for error utility functions including sensitive data redaction) and `tests/middleware.test.ts` (4 tests for Zod body validation middleware). Fixed pre-existing `guestPassLogic.test.ts` mock (missing `safeRelease`).

## [8.77.4] - 2026-03-05

### Bug & Stability Fixes
- **TrackmanBookingModal Timer Leaks**: Three `setTimeout` calls (50ms overlay transition, 2s copy feedback, 3.5s auto-close) were not tracked in refs and could fire after unmount. Added `overlayTimerRef` and `copyTimerRef` refs; all timers now cleared in `handleClose`, the `!isOpen` reset path, and the `useEffect` cleanup function.
- **TerminalPayment Success Timer Leak**: Four `setTimeout` calls for 1.5s success-to-callback transitions (payment success, card save success, $0 free activation, already-succeeded cancel path) were not tracked. Added `successTimeoutRef`; all four paths now store the timer ID and clear it on unmount, cancel, and before setting a new one.
- **NoticeFormDrawer Silent Fetch Failures**: Three fetch calls (`/api/notice-types`, `/api/closure-reasons`, `/api/resources`) used `.catch(() => {})`, silently swallowing errors. Staff would see empty dropdowns with no explanation and be unable to submit the form. Now shows error toasts so staff know to retry.

## [8.77.3] - 2026-03-05

### Performance Optimization
- **Booking List N+1 Elimination**: Consolidated 5 sequential `booking_participants` queries in `GET /api/booking-requests` into a single batch query with in-memory partitioning. Reduces database round-trips from ~6 to ~2 per booking list request, significantly improving response time for member and staff booking views.
- **Fee Calculation Parallelization**: `computeFeeBreakdown` in `unifiedFeeService.ts` now runs `getTierLimits` and `getGuestPassInfo` concurrently via `Promise.all` instead of sequentially, shaving ~1 DB round-trip from every fee preview and check-in.
- **Payment Record Error Escalation**: Silent `logger.warn` on payment record DB insert failures in `quick-charge.ts` (guest checkout + quick charge) and `terminal.ts` escalated to `logger.error` with `CRITICAL` tag and full payment context. These failures mean Stripe charged the customer but the local record is missing — now visible in error monitoring instead of buried in warnings.

## [8.77.2] - 2026-03-04

### Bug & Stability Fixes
- **TabTransition Timer Leak**: `TabTransition` component's `enterTimer` was created inside a `setTimeout` callback but never tracked for cleanup on unmount. Both exit and enter timers now stored in refs with proper cleanup in the `useEffect` return — prevents state updates on unmounted components during rapid tab switches.
- **Circular Import HMR Fix**: Extracted shared navigation constants (`TabType`, `tabToPath`, `pathToTab`, `getTabFromPathname`) from `src/pages/Admin/layout/types.ts` into `src/lib/nav-constants.ts`. `StaffMobileSidebar` and all Staff Command Center sections now import from the shared file instead of reaching into the Admin layout directory — breaks the HMR circular dependency chain that caused repeated page reloads during development.
- **Scheduler Overlap Guards**: Added `isRunning` flags to `sessionCleanupScheduler`, `communicationLogsScheduler`, and `webhookLogCleanupScheduler` to prevent overlapping executions if a task runs longer than its interval. `communicationLogsScheduler` now calls `syncCommunicationLogsFromHubSpot` directly (awaited) instead of the fire-and-forget `triggerCommunicationLogsSync` wrapper, and calls `stopCommunicationLogsScheduler()` before starting to prevent duplicate intervals on hot-reload.

### Additional Bug Fixes (v8.77.2)
- **TabTransition timer leak fix**: Both `enterTimer` and `delayTimer` in `TabTransition.tsx` are now tracked via refs with proper `useEffect` cleanup, preventing orphaned timers on unmount.
- **Circular import chain fix**: Extracted `TabType`, `tabToPath`, `pathToTab`, `getTabFromPathname` from `src/pages/Admin/layout/types.ts` into `src/lib/nav-constants.ts`. All `src/components/` files import from `nav-constants.ts`; `layout/types.ts` re-exports for backward compatibility within Admin pages. This breaks the HMR cycle that caused repeated page reloads.
- **Scheduler overlap guards**: Added `isRunning` flags to `sessionCleanupScheduler`, `communicationLogsScheduler`, `webhookLogCleanupScheduler`, `pendingUserCleanupScheduler`, `stuckCancellationScheduler`, `webhookEventCleanupScheduler`. Added `stop` functions and double-start protection to `sessionCleanupScheduler`, `webhookLogCleanupScheduler`, `weeklyCleanupScheduler`, `duplicateCleanupScheduler`. `supabaseHeartbeatScheduler` now calls `stop` before re-starting.
- **TrackmanWebhookEventsSection timeout cleanup**: All three `setTimeout(() => setAutoMatchResult(null), 5000)` calls in `handleAutoMatch` now use an `autoMatchTimeoutRef` with `useEffect` unmount cleanup, preventing state updates on unmounted components.
- **Empty catch block fix**: `server/core/trackman/service.ts:749` now logs a warning with booking ID instead of silently swallowing errors during legacy unmatched entry resolution.

## [8.77.1] - 2026-03-04

### Code Quality Audit Fixes
- **Global Express Error Middleware**: Added catch-all `(err, req, res, next)` error handler at the end of the Express middleware chain in `server/index.ts`. Any unhandled route error now returns a JSON `{ error: 'Internal server error' }` with 500 status instead of a raw HTML page. Uses `getErrorStatusCode` for proper status propagation.
- **Eliminated `as any` Casts**: Removed all `as any` type casts from server code. `server/utils/resend.ts` now uses a typed `ResendConnectionSettings` interface. `server/routes/hubspot.ts` now uses `getErrorStatusCode()` from `errorUtils.ts` instead of `(err as any)?.code` chains.
- **Enhanced `getErrorStatusCode`**: `server/utils/errorUtils.ts` now checks `error.response.status` (nested object) in addition to `error.statusCode`, `error.status`, and `error.code` — properly handles HubSpot SDK error objects.
- **Consolidated Date Formatting**: `src/utils/dateUtils.ts` gained `formatDatePacific()` and `formatTimePacific()` exports. `RedeemPassCard.tsx` now imports shared date utilities instead of defining local duplicates.

### Bug Fixes
- **CafeTab controlled/uncontrolled fix**: Added `|| ''` fallback to `value={newItem.category}` in `CafeTab.tsx` select input to prevent React controlled/uncontrolled warnings when category is undefined.
- **AdminDashboard circular import fix**: Replaced barrel import from `./layout` with direct imports from individual modules (`./layout/types`, `./layout/StaffBottomNav`, `./layout/StaffSidebar`, etc.) to reduce HMR invalidation chain and fix Vite HMR churn.
- **AdminDashboard training step inputs**: Added `|| ''` fallback to `step.title` and `step.content` inputs in the TrainingSectionModal to prevent controlled/uncontrolled warnings.
- **TodayScheduleSection null crash fix**: Changed `nextEvent &&` to `nextEvent != null &&` before using the `in` operator, preventing TypeError when `nextEvent` is null/undefined.
- **AlertsCard null guard**: Added `(notifications || [])` guard on `.filter()` and `!notifications ||` check on `.length` to prevent crash when notifications prop is null/undefined.

## [8.77.0] - 2026-03-03

### Bug Audit Fixes
- **Orphaned Promise Fix**: `useAsyncAction` debounce now resolves superseded promises with `undefined` instead of leaving them hanging forever — prevents frozen UI when users triple-click buttons.
- **Webhook TOCTOU Race**: `recordDayPassPurchaseFromWebhook` now catches `day_pass_purchases_stripe_pi_unique` constraint violations gracefully, matching the client-facing `/confirm` routes — prevents Stripe webhook retry storms from duplicate webhook bursts.
- **Zombie Tier Sync Prevention**: `queueTierSync` now cancels both `pending` AND `failed` jobs (was only `pending`), preventing stale failed jobs from waking up via exponential backoff and overwriting the correct tier in HubSpot.
- **Queue Status Accuracy**: Aborted tier sync jobs now marked as `superseded` instead of `completed` — keeps queue monitoring metrics accurate and distinguishes cancelled jobs from successful ones. DB idempotency index updated to exclude `superseded`.
- **HubSpot Queue Throughput**: Scheduler interval reduced from 2 minutes to 30 seconds, batch size increased from 20 to 50 — eliminates multi-hour queue backlogs after bulk operations.
- **Stripe Idempotency Keys**: All 7 non-deterministic Stripe idempotency keys replaced with 5-minute time-bucketed keys (`Math.floor(Date.now() / 300000)` + business identifiers). Prevents duplicate charges/customers/subscriptions on network retries. Affected: `quick-charge.ts` (guest POS, saved card POS), `subscriptions.ts`, `customers.ts`, `groupBilling.ts` (corp add/remove), `memberBilling.ts` (coupon creation).
- **Empty Directory Cold Boot**: First staff member to open the Member Directory after a server restart now waits for the initial HubSpot sync instead of seeing an empty list. Subsequent requests still use the 30-minute cache with background refresh.
- **Last Admin Deletion Bypass**: `DELETE /api/staff-users/:id` now checks if the target is the last active admin before allowing deletion, matching the safeguards already present in the admin-specific routes.
- **Late Cancellation Fee Collection**: `cancelPendingPaymentIntentsForBooking` now gated behind `!shouldSkipRefund` in member-cancel route — previously killed the Stripe PaymentIntent even on late cancellations, making forfeited fees permanently uncollectible.
- **Guest Pass Double-Refund**: Pre-check-in booking cancellations no longer call `refundGuestPass()` — deleting the `guest_pass_holds` row is sufficient. Previously both the hold delete and the refund ran, driving `passes_used` to -1 and granting infinite guest passes.
- **Availability Lock Missing Pending Requests**: `checkUnifiedAvailabilityWithLock` now checks `booking_requests` for pending conflicts, matching the standard `checkUnifiedAvailability`. Previously staff/Trackman bookings could double-book over pending member requests.
- **Zombie Booking Resurrection**: Trackman import no longer frees and recreates bookings in `cancellation_pending` status. Previously the sync would see Trackman still showing "approved", detach the Trackman ID, and create a brand-new active booking — reversing the member's cancellation. Now `cancellation_pending` bookings are skipped entirely.
- **Orphaned Placeholder Sessions**: Trackman placeholder merge now checks `!placeholder.session_id` before creating a session, matching other code paths. Previously merging into a placeholder that already had a session created a second orphaned session.
- **Stripe Reconciliation Scheduler**: Runs initial check on startup and polls every 5 minutes (was 60 minutes). Previously a restart at 5:01 AM would skip the entire day's financial reconciliation.
- **Background Sync Idempotency**: `startBackgroundSyncScheduler` now guards against double-initialization with `if (currentTimeoutId) return`. Previously hot-reloads could spawn duplicate sync loops that doubled API requests and leaked memory.
- **Corporate Infinite Free Seats**: `addCorporateMember` now enforces `max_seats` limit inside the transaction, before inserting the new member. Previously there was no validation — admins could add unlimited members beyond the pre-paid seat count, all for free.
- **Guest Pass Balance Hallucination**: `getGuestPassesRemaining` now reads from the `guest_passes` ledger table (`passes_total - passes_used`) instead of dynamically counting `booking_participants`. The old calculation missed manual deductions, POS usage, and tier changes, showing a different balance than what Stripe enforced.
- **Undeletable Deactivated Billing Groups**: `deleteBillingGroup` now checks `isActive !== false` alongside `primaryStripeSubscriptionId`. Previously, cancelled groups kept their subscription ID forever, permanently blocking deletion.
- **Mixed POS Full Refund**: Booking cancellation refunds now use `participant.cachedFeeCents` (the exact guest fee amount) instead of looking up the full PaymentIntent amount. Previously, if a POS payment covered both a guest fee and cafe items, cancelling the guest fee refunded everything.
- **Subscription Webhook Staff Demotion**: `subscription.created` webhook ON CONFLICT no longer overwrites `role = 'member'` unconditionally. Staff and admin roles are preserved.
- **Advisory Lock Key Mismatch**: `ensureSessionForBooking` now uses Postgres `hashtext()` with `::` separator, matching the booking route's `hashtext(resource_id || '::' || request_date)`. Previously it used a JS bitwise hash with `:` separator — both the algorithm and format differed, so both code paths generated different lock integers for the same resource, allowing concurrent double-bookings.
- **Double-Tap Check-in Race Condition**: Walk-in check-in now runs inside `db.transaction()` with `SELECT ... FOR UPDATE` on the user row. Previously two simultaneous NFC taps could both pass the "recent check-in" guard, doubling `lifetime_visits` and sending duplicate alerts.

## [8.76.0] - 2026-03-01

### Concurrency & Data Integrity Fixes
- **Waitlist Promotion Race Condition**: `FOR UPDATE SKIP LOCKED` on waitlist promotion now runs inside `db.transaction()` — previously the lock was released immediately because it ran on the global pool outside a transaction. Two simultaneous cancellations could promote the same waitlisted user.
- **Trackman Reconciliation Atomicity**: `recordUsage()` and the reconciliation status UPDATE are now wrapped in a single `db.transaction()`. If either fails, both roll back — prevents double-charges when staff retries a failed adjustment.
- **Timezone-Safe DOW Matching**: Recurring wellness class bulk updates replaced `new Date(dateStr).getDay()` (which evaluates in server timezone, shifting the day) with `EXTRACT(DOW FROM dateStr::date)` in SQL, letting PostgreSQL handle the day-of-week calculation correctly.
- **Manual Enrollment Notifications**: Staff-initiated wellness enrollments now send in-app notification, push notification, and WebSocket broadcast to both the enrolled member and staff dashboards — previously the member received zero communication.

## [8.75.0] - 2026-02-28

### Security & Reliability Audit Fixes
- **Rate Limiting**: Global rate limiter corrected — authenticated users get 2,000 req/min, anonymous users get 600. Previously reversed.
- **HubSpot Queue Idempotency**: `queueIntegrityFixSync` and `queueTierSync` idempotency keys now use daily bucket (`Math.floor(Date.now() / 86400000)`) instead of raw `Date.now()` which defeated duplicate prevention.
- **Announcement Banner**: `showAsBanner` column added to Drizzle schema (`shared/models/content.ts`). Banner create/update operations wrapped in `db.transaction()` for atomicity. Banner query and access use native Drizzle column references instead of raw SQL casts.
- **HubSpot Webhook Notifications**: `activeStatuses` in webhook handler includes `past_due` to prevent false "New Member Activated" notifications when members recover from delinquent billing.
- **Tier Update Safety**: `PUT /api/hubspot/contacts/:id/tier` no longer force-sets `membershipStatus: 'active'` — preserves billing states like `past_due`.
- **HubSpot Token Deduplication**: `getHubSpotAccessToken()` now uses a shared promise for concurrent token refresh requests, preventing thundering herd 429 rate limit errors from the Replit connector API (10 req/s limit).
- **HubSpot Deal Sync Removed**: All membership deal syncing completely removed — no more deal creation, line items, pipeline stages, deal stage drift checks. Contact syncing preserved (findOrCreateHubSpotContact, syncTierToHubSpot, updateContactMembershipStatus). Deleted files: `server/routes/hubspotDeals.ts`, `server/core/hubspotDeals.ts`, `server/core/hubspot/lineItems.ts`, `server/core/hubspot/pipeline.ts`, `server/core/stripe/hubspotSync.ts`. Settings page renamed "HubSpot Contact Mappings" (pipeline ID and stage IDs removed, tier/status mappings kept).
- **CSV Parser**: Tier sync CSV parser rewritten to handle RFC 4180 escaped double quotes (`""` inside quoted fields), preventing data corruption on fields containing commas or quotes.
- **React Safety**: `useAsyncAction` adds cleanup `useEffect` to clear debounce timers on unmount. `NewUserDrawer` cooldown timer side effects moved out of state updater into `useEffect`. Mode switch calls `resetForm()` to prevent stale form data.
- **safeDbTransaction**: Rewritten to use Drizzle's native `db.transaction()` instead of raw `PoolClient`, ensuring Drizzle queries participate in the transaction.
- **HubSpot Status Code**: `remove-marketing-contacts` endpoint returns 422 instead of 500 for missing HubSpot property configuration.
- **Date Parsing**: `last_manual_fix_at` parsing uses `instanceof Date` check for safe handling of both Date objects and ISO strings.

## [8.74.0] - 2026-02-26

### Admin Settings Expansion
- **Settings Infrastructure**: Key-value store in `system_settings` table, cached via `settingsHelper.ts` (30s TTL), bulk save via `PUT /api/admin/settings`. Public settings exposed via unauthenticated `GET /api/settings/public` (contact, social, apple_messages, hours_display categories only). App Display Settings (club name, support email, timezone) and Purchase Category Labels sections were removed — they were not wired to any consumers.
- **Contact & Social Media**: Phone, email, address, Google/Apple Maps URLs, social media links (Instagram, TikTok, LinkedIn), Apple Messages for Business (toggle + Business ID), display hours configurable from admin settings. Contact page and Footer read from settings with hardcoded fallbacks.
- **Resource Operating Hours**: Availability hours are derived from the Display Hours settings (`hours.monday`, `hours.tuesday_thursday`, `hours.friday_saturday`, `hours.sunday`) — parsed per day of week with minute-level precision. Monday "Closed" = no bookable slots. "8:30 AM – 8:00 PM" = slots from 8:30 AM to 8:00 PM. Display Hours UI uses time picker selects (30-min increments) with Closed checkbox per day group. Per-resource slot durations (golf=60, conference=30, tours=30) are individually configurable. Wellness & Classes have no configurable hours (Google Calendar events). All business hours consumers read from settings: `getResourceConfig(type, date?)` in `config.ts`, `getBusinessHoursFromSettings(date)` in `availability.ts`, staff conference booking route, and frontend `isFacilityOpen(displayHours?)` in `dateUtils.ts`.
- **HubSpot Contact Mappings**: Tier name mappings and status mappings configurable from admin settings. Async wrapper functions (`getDbStatusToHubSpotMapping`, `getTierToHubSpotMapping`) read from settings with hardcoded fallbacks. Pipeline ID and stage ID settings removed (deal sync fully removed).
- **Notification & Communication**: Daily reminder hour, morning closure hour, onboarding nudge hour, grace period hour/days, max onboarding nudges, and trial coupon code all read from settings at runtime via `getSettingValue()`. HubSpot stage/tier/status collapsible sections in UI use expand/collapse pattern.

## [8.73.0] - 2026-02-24

### Booking Data Integrity Fixes
- **Owner slot link sync**: When staff links a member to an empty owner slot via `PUT /api/admin/booking/:bookingId/members/:slotId/link`, the `booking_requests` row (`user_id`, `user_email`, `user_name`) is now updated to match the new owner. Previously, the participant record was updated but the booking header still showed the original Trackman import name, causing a visible mismatch between the booking title and the roster owner.
- **Booking source enum fix**: `revertToApproved()` and the Member Balance endpoint (`/api/member/balance`) no longer use `COALESCE(bs.source, '')` to check for Trackman-sourced sessions — PostgreSQL rejected the empty string as an invalid `booking_source` enum value. Fixed to use `(bs.source IS NULL OR bs.source::text NOT IN (...))`, which correctly handles NULL sources without enum coercion errors.

## [8.72.0] - 2026-02-22

### Staff Admin UX Robustness
- **Resume subscription confirmation**: Resume button now opens a confirmation modal (`ConfirmResumeModal`) instead of firing immediately — prevents accidental resumption of paused subscriptions.
- **Billing source change confirmation**: Billing provider dropdown changes now route through `ConfirmBillingSourceModal` showing current→new source before executing, preventing accidental billing source switches.
- **Tier sync coalescing**: `queueTierSync` cancels any pending/failed `sync_tier` jobs for the same email before enqueueing a new one. Rapid A→B→C tier changes result in a single HubSpot sync for the final tier, not three separate jobs.
- **Unsaved changes guard**: `MemberProfileDrawer` warns staff with a `window.confirm` dialog when closing with unsaved notes or communication drafts. Backdrop click, close button, and escape all route through `handleDrawerClose`.
- **Mutation button disable**: All billing mutation buttons (`StripeBillingSection`) properly use `disabled={isPending}` during async operations to prevent double-clicks.
- **Toast/haptic consistency migration**: Older admin components (`BugReportsAdmin`, `DiscountsSubTab`, `ApplicationPipeline`) migrated from `console.error` or custom inline toast state to the global `useToast` + `haptic` utilities for consistent success/error feedback across all staff actions.

## [8.71.0] - 2026-02-20

### HubSpot Webhook-First Inbound Sync
- **Webhook-first architecture**: The `POST /api/hubspot/webhooks` endpoint is the primary inbound sync mechanism. All HubSpot `contact.propertyChange` events are processed in real-time, replacing the 5-minute incremental poll.
- **Profile property handling**: Webhooks handle all profile fields (firstname, lastname, phone, address, city, state, zip, date_of_birth, mindbody_client_id, membership_start_date, discount_reason, opt-in preferences) with COALESCE rules — only fill empty DB fields, never overwrite existing data. Opt-in fields and `membership_discount_reason` always overwrite (HubSpot is authoritative for communication preferences).
- **Protection rules**: Skip archived users, skip sync_exclusions, STRIPE WINS for status/tier on Stripe-billed members, skip visitors for status changes, skip unknown users (no upsert from webhooks).
- **Weekly reconciliation**: Full member sync (`syncAllMembersFromHubSpot`) changed from daily 3 AM to weekly Sunday 3 AM Pacific. Acts as a safety net to catch any missed webhooks.
- **5-minute incremental poll removed**: The `INCREMENTAL_SYNC_INTERVAL` and `fetchRecentlyModifiedContacts` polling logic removed from the contact cache. Cache still refreshes every 30 minutes and is invalidated instantly when webhooks fire.

## [8.70.0] - 2026-02-18

### HubSpot Outbound Sync Hardening
- **`findOrCreateHubSpotContact`**: When an existing contact is found, updates lifecycle stage (`customer` for members, `lead` for visitors/day-pass) and `membership_status` without downgrading `customer`→`lead`. Fills missing name/phone. Clears lifecycle before setting (HubSpot API requirement). Restores previous lifecycle on failure to prevent blank lifecycle states.
- **`syncDayPassPurchaseToHubSpot`**: Promotes existing contacts from dead lifecycle stages to `lead` without downgrading `customer`. Fills missing names during promotion.
- **`syncMemberToHubSpot` fallback**: Looks up user's name from the database before calling `findOrCreateHubSpotContact` instead of passing empty strings.

### HubSpot Sync Filtering
- **API-Level Filtering**: `syncAllMembersFromHubSpot` uses `searchApi.doSearch()` with filter groups: meaningful statuses (`active`, `trialing`, `past_due`, `pending`, `suspended`, `declined`, `frozen`) OR contacts with `mindbody_client_id` (billing history). Dead statuses (`non-member`, `archived`, `cancelled`, `expired`, `terminated`) excluded at the API level unless they have Mindbody billing history.
- **Archived User Protection**: Both sync functions skip any local user where `archived_at IS NOT NULL`. Only manual staff action can un-archive a user — HubSpot sync cannot resurrect archived records.
- **Non-Transacting Safety Net**: New contacts with dead statuses and no Mindbody ID are not imported into the users table (secondary guard behind API-level filter).
- **Dev Stripe Check Suppression**: In non-production environments, the "Billing Provider Hybrid State" integrity check skips the `billing_provider='stripe' AND stripe_subscription_id IS NULL` condition — Stripe env validation clears production subscription IDs in test mode, making this check produce false positives.

## [8.69.0] - 2026-02-16

### Codebase Modularization
- **Backend Modular Splits**: Large monolithic files split into sub-module directories with barrel re-exports (all external import paths unchanged):
  - `server/core/stripe/webhooks/` — Webhook dispatcher + 8 handler files (was `webhooks.ts`, 6,149 lines)
  - `server/core/trackman/` — CSV import pipeline in 7 files (was `trackmanImport.ts`, 4,213 lines)
  - `server/routes/trackman/admin.ts` — Split into `admin-resolution.ts`, `admin-roster.ts`, `admin-maintenance.ts` (was 4,040 lines)
  - `server/core/integrity/` — Data integrity checks in 8 files (was `dataIntegrity.ts`, 3,891 lines)
  - `server/routes/stripe/payments.ts` — Split into `booking-fees.ts`, `quick-charge.ts`, `payment-admin.ts`, `financial-reports.ts` (was 3,160 lines)
  - `server/core/resource/` — Resource service in 6 files (was `resourceService.ts`, 2,566 lines)
  - `server/routes/dataTools/` — 5 sub-routers: `member-sync.ts`, `booking-tools.ts`, `audit.ts`, `stripe-tools.ts`, `maintenance.ts` (was `dataTools.ts`, 2,683 lines)
- **Frontend Modular Splits**:
  - `src/pages/Admin/tabs/dataIntegrity/` — 6 sub-components + hooks (was `DataIntegrityTab.tsx`, 2,314 lines)
  - `src/pages/Admin/tabs/directory/` — 9 sub-components + hooks (was `DirectoryTab.tsx`, 2,233 lines)
  - `src/components/admin/memberBilling/` — 11 sub-components + hooks (was `MemberBillingTab.tsx`, 2,130 lines)

### WebSocket & Safety Fixes
- **WebSocket Zombie Prevention**: Client-side `useWebSocket` hook uses `intentionalCloseRef` + stale-socket guard (`wsRef.current === ws`) to prevent zombie reconnection loops on unmount or rapid email changes.
- **Rate Limiter Crash Fix**: Rate limiter key generators use `String()` coercion before `.toLowerCase()` to prevent TypeError crashes from non-string input.
- **Event Loop Cleanup**: In-memory lock cleanup interval uses `.unref()` to avoid pinning the event loop on server shutdown.
- **Advisory Lock Safety**: `ensureSessionForBooking` uses `pg_advisory_xact_lock` when an external client (in-transaction) is passed to prevent lock leaks in aborted transactions; session-level `pg_advisory_lock` with explicit unlock when managing its own client.

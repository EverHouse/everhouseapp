# Ever Club Members App

**Current Version**: 8.77.0 (March 5, 2026)

## Overview
The Ever Club Members App is a private members club application designed for golf and wellness centers. Its primary purpose is to serve as a central digital hub for managing golf simulator bookings, wellness service appointments, and club events. The project aims to enhance member satisfaction and operational efficiency through comprehensive membership management, facility booking, and community-building tools, ultimately creating a seamless digital experience for club members and staff.

## User Preferences
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## System Architecture

### Core Architecture
- **Naming Conventions**: `snake_case` for PostgreSQL; `camelCase` for Drizzle schemas, API JSON, and React/TypeScript frontend. Raw database rows are not exposed in API responses.
- **Type Safety**: Strict TypeScript with zero errors; no `as any`. All raw SQL results are typed.
- **Database Interaction**: Drizzle ORM query builders or parameterized `sql` template literals are mandatory.
- **Timezone**: All date/time operations explicitly use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions are logged.
- **API/Frontend Consistency**: API response field names align with frontend TypeScript interfaces.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints.
- **Real-time Updates**: WebSocket broadcasting for booking and invoice changes via Supabase Realtime. React Query with WebSocket-driven cache invalidation is used for the Staff Command Center.
- **Member Dashboard**: Features a chronological card layout for bookings, events, and wellness sessions with "Add to Calendar" functionality.

### UI/UX & Frontend
- **Design System**: Liquid Glass UI system using Tailwind CSS v4, supporting dark mode and M3-compliant motion tokens.
- **Design Token Standards**: All brand colors must use named Tailwind tokens (`primary`, `lavender`, `danger`, `bone`, `surface-dark-*`) — never hardcoded hex values in class strings. Z-index uses named scale (`z-banner`, `z-modal`, `z-fab`, etc.) defined in `tailwind.config.js`.
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a Header, scrollable Body, and Sticky Footer structure. Button hierarchy differentiates actions.
- **Accessibility**: Adheres to WCAG conventions, including skip navigation, focus trapping, and proper roles/attributes. `prefers-reduced-motion` is respected. All clickable non-button elements must have `role="button"`, `tabIndex={0}`, and `onKeyDown` handlers. Modal backdrops must not use `aria-hidden="true"` with `onClick`.
- **M3 Components**: Custom components like `SegmentedButton`, `Chip`, `SearchBar`, and `FloatingActionButton` support M3 design principles.
- **Bottom Sheet Variants**: `SlideUpDrawer` supports `modal` (default) and `standard` variants.
- **Navigation Rail**: Staff portal uses `StaffNavigationRail` for tablet/desktop, bottom nav for mobile.
- **Interaction Polish**: Enhanced visual feedback and M3 motion patterns for transitions.
- **Pull-to-Refresh**: `PullToRefresh` component triggers a hard reload with a branded `WalkingGolferLoader`.
- **Mobile Status Bar Blending**: Uses `viewport-fit=cover` and `safe-area-inset-top` for seamless integration.
- **Mutation Patterns**: `useAppMutation` hook provides automatic toasts, haptic feedback, optimistic updates, and query invalidation.
- **Form Persistence**: `useFormPersistence` persists form data to sessionStorage. `useUnsavedChanges` uses `beforeunload`.
- **Large List Pattern**: Large lists use server-side limits, client progressive rendering, memoized sorting, and O(1) lookup maps.
- **Prefetch System**: Route-level prefetch via `src/lib/prefetch.ts` and detail-level prefetch on hover/focus via `usePrefetchOnHover`.
- **Connection Health**: `OfflineBanner` monitors network and WebSocket health; staff header shows status.
- **Error Boundaries**: Three-tier system (Global → Page → Feature) using `ErrorFallback`.
- **MemberSearchInput Portal**: `MemberSearchInput` renders its dropdown via `createPortal` to `document.body`.

### Core Domain Features
- **Booking & Scheduling**: "Request & Hold" model, unified participant management, calendar synchronization, auto-complete scheduler, and conflict resolution. Integrates with Trackman webhooks and handles guest/overage fees. Staff golf lessons create only `availability_blocks` (no `facility_closures` notice records). Trackman webhook auto-approval transfers all booking participants to the new session. Staff can assign additional players to sessions. Booking approvals are separated from session creation for cleaner code paths. Booking cancellation uses a transactional DB status change with post-commit best-effort side effects (guest pass refund, usage ledger cleanup, Stripe refund, calendar deletion). **Trackman imports are usage-tracking only — all trackman-sourced participants get `payment_status = 'waived'` and the balance endpoint excludes `trackman_import`/`trackman_webhook` sessions from fee calculations.** V2 Trackman webhook auto-link (`tryMatchByBayDateTime`) uses a tight 5-minute tolerance with end-time verification and refuses ambiguous matches (multiple candidates). CSV import corrects session owner mismatches when the authoritative customer data differs from the auto-linked owner. **Booking owner invariant**: all 9 paths that set `booking_requests.user_email` also update `booking_requests.user_id` and the `booking_participants` session owner row — including CSV unmatched→matched, CSV placeholder merge, CSV ghost update, staff assign/change-owner, staff link-trackman-to-member, and admin resolution.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, and guest fees based on a "one invoice per booking" architecture. Supports dual payment paths and existing payments. Roster changes trigger fee recalculation; payment locks the roster. Staff can manage conference room prepayments on behalf of members. Fee recalculation skips already-paid participants. Draft invoices are cleaned up when bookings are cancelled. Invoices are voided on permanent booking deletion.
- **Member Lifecycle**: Membership tiers, QR/NFC check-in, and onboarding processes. QR scans route to booking check-in or walk-in.
- **Walk-In Visit Tracking**: Walk-in visits are recorded via QR/NFC scan, syncing to HubSpot and broadcasting WebSocket events.
- **Error Handling**: Prohibits empty catch blocks; all must re-throw, log, or use `safeDbOperation()`. `safeDbTransaction()` uses Drizzle's native `db.transaction()` with automatic rollback and staff alert notifications on failure (rewritten from raw `PoolClient` in v8.75.0). Global Express error middleware (`server/index.ts`) catches unhandled route errors and returns JSON 500 responses instead of raw HTML.
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: Public endpoints creating database records are rate-limited. Subscription creation endpoints have a dedicated `subscriptionCreationRateLimiter` and an in-memory per-email operation lock (v8.58.0). OTP verification uses three-tier rate limiting: per-IP+email (5 attempts), per-IP global (15 attempts), and per-email aggregate (20 attempts). Keys always include IP (fallback to 'unknown') to prevent unauthenticated lockout of legitimate users. Rate limiter key generators use `String()` coercion before `.toLowerCase()` to prevent TypeError crashes from non-string input (v8.69.0). The in-memory lock cleanup interval uses `.unref()` to avoid pinning the event loop (v8.69.0).
- **Subscription Creation Safety**: Per-email operation locks prevent duplicate membership creation via PostgreSQL `subscription_locks` table (atomic `INSERT...ON CONFLICT WHERE` with 120s expiry, in-memory fallback). `acquireSubscriptionLock` and `releaseSubscriptionLock` are **async** — all callers must `await`. Existing incomplete subscriptions can be reused via payment intent refresh. Idempotency keys prevent duplicate Stripe charges. Frontend guardrails: email pre-check on blur (`GET /api/visitors/check-email`), form submission debounce refs, 5-second post-creation cooldown, session-level recent-creation alerts (10-min window), and "Recently Added (24h)" directory filter.
- **Scheduler Robustness**: Schedulers use `isRunning` flags, catch-up windows, claim slots, and persistent notification deduplication (6-hour windows for waiver review and stuck booking alerts). **Staggered startup**: `initSchedulers()` staggers all 27 schedulers across ~270s in 6 waves (10s apart) to prevent database connection spikes at deployment. Wave order: real-time → booking/calendar → notifications → financial → HubSpot/external → cleanup. **Instant DB triggers** (`trg_auto_billing_provider`, `trg_sync_staff_role`, `trg_link_participant_user_id`) handle data fixes at write time; schedulers are daily safety nets only. Linked email users should be merged into the primary via `userMerge.ts` — the system no longer copies tiers to linked user records (`trg_copy_tier_on_link` was removed). **Error reporting**: `alertOnScheduledTaskFailure` extracts `error.cause` from Drizzle ORM errors to surface the actual database error in staff alerts (Drizzle wraps PG errors and hides the real message in `cause`).
- **Stripe Integration Specifics**: Includes webhook safety, payment handler logic, coupon application, and specific requirements for `trial_end` and $0 subscriptions. Manual Stripe refunds trigger full resource teardown (guest pass refund, usage_ledger cleanup). Customer linking requires authenticated metadata (`source=app` or `userId`). Day pass fulfillment handles $0 checkouts (100% promo codes) via synthetic paymentIntentId.
- **Data Integrity and Consistency**: Prevents double-charging, ensures orphaned invoice cleanup, uses optimistic locking for booking status transitions, and maintains atomicity for critical operations. `usage_ledger` has `ON DELETE CASCADE`. `booking_fee_snapshots` has `ON DELETE CASCADE` on both `booking_id` and `session_id`. `booking_participants` has `ON DELETE CASCADE` on `session_id`. Cancellation refunds use `refund_pending` status inside the transaction, updated to `refunded` after Stripe confirms. Advisory locks for session creation serialize on `resourceId:sessionDate` (not startTime) to prevent overlapping-timeslot races; `ensureSessionForBooking` uses `pg_advisory_xact_lock` when an external client (in-transaction) is passed to prevent lock leaks in aborted transactions, and session-level `pg_advisory_lock` with explicit unlock when managing its own client (v8.69.0). Fee recalculation skips already-paid participants to prevent cached_fee_cents overwrite. Usage lookups sum both userId and email entries to prevent double-dipping. Conference room bookings revert to 'pending' if payment fails after auto-confirm. `createSessionWithUsageTracking` acquires a user-level advisory lock (`usage::email::date`) covering both billing read and DB write to prevent concurrent fee calculation races; uses `pg_advisory_xact_lock` when called with `externalTx`, session-level `pg_advisory_lock` otherwise. DB-level CHECK constraints enforce: booking/session time order (`end_time > start_time`), active members must have email, `stripe_customer_id` uniqueness (partial unique index). Partial unique index on `day_pass_purchases.stripe_payment_intent_id` (non-null) prevents duplicate day pass purchases under concurrent requests. Partial unique index on `wellness_enrollments(class_id, user_email) WHERE status='confirmed'` prevents duplicate active enrollments. Both day pass confirm and wellness enrollment inserts catch unique constraint violations gracefully. `guest_pass_holds` and `conference_prepayments` have `ON DELETE CASCADE` on `booking_id`. Orphan checks for `booking_participants`, `wellness_enrollments`, `event_rsvps`, `booking_fee_snapshots`, and `booking_resource_relationships` retired in favor of CASCADE/FK constraints. `cleanup.ts` no longer runs redundant orphan-deletion for fee snapshots, wellness enrollments, or booking participants (all CASCADE-protected).
- **Participant Validation**: Booking participant emails use `z.preprocess` to normalize empty strings. Members need email OR userId (not both). Frontend only sends email when it contains `@`.
- **Tier Hierarchy Validation**: Startup validates DB membership tier slugs against `TIER_NAMES`.
- **Deferred Webhook Actions**: Post-commit webhook side-effects log event context.
- **WebSocket Robustness**: Features periodic session revalidation, cryptographic verification, and reconnect jitter. Client-side `useWebSocket` hook uses `intentionalCloseRef` + stale-socket guard (`wsRef.current === ws`) to prevent zombie reconnection loops on unmount or rapid email changes (v8.69.0).
- **Supabase Hardening**: Frontend client configures `eventsPerSecond`; server-side calls are wrapped with `Promise.race` / `withTimeout()`.

### Web Performance & Security
- **Google Fonts**: Newsreader and Instrument Sans loaded non-render-blocking.
- **Typography Hierarchy**: Defined hierarchy for titles, headers, and body text.
- **Edge-to-Edge Hover Pattern**: Consistent styling for cards and interactive rows.
- **Geometry Standards**: Standardized `rounded-xl` for cards/panels, `rounded-[4px]` for buttons/tags.
- **Material Symbols**: Icon font lazy-loaded via JavaScript.
- **Splash Screen**: Walking golfer GIF with random tagline, 2-second minimum display.
- **Hero Image**: Preloaded in `index.html` with `fetchpriority="high"`.
- **HubSpot**: Script deferred via `requestIdleCallback`.
- **PWA & Service Worker**: Versioned cache, Network-First for navigation/API, immutable for hashed assets. `sw.js`, `index.html`, and `manifest.webmanifest` served with `no-cache`.
- **Security Headers**: HSTS, CSP with `upgrade-insecure-requests`, COOP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- **robots.txt**: Static file and server route kept in sync with disallow rules.
- **Crawler Navigation**: Hidden navigation links for search engine indexing.

### POS Register Features
- **Quick Guest Checkout**: Staff can skip customer info for walk-in sales; restricts payment to terminal-only.
- **Dynamic Pass Products**: Pass products loaded from `membership_tiers` table by slug, with server startup functions ensuring DB records and Stripe Product + Price synchronization.
- **Backend Endpoints**: `POST /api/stripe/staff/quick-charge` and `POST /api/stripe/staff/quick-charge/attach-email` for guest checkout and email linking.

### Notification Source Attribution
- **Status Change Notifications**: Staff notifications for member status changes include the source of the change. Staff admin actions are audit-logged with the performing staff member's email.

### Staff Command Center Enhancements
- **Calendar Grid**: Current time indicator (red line) on the booking calendar for at-a-glance status.
- **Simulator Tab**: Date navigation with route-level prefetching for faster browsing.
- **Bulk Actions**: Staff can mark all stale bookings as attended from the data integrity dashboard.
- **Trackman Events Section**: Expanded webhook event display with additional participant details for unmatched requests.

### File Structure — Modular Splits (v8.69.0)
The following large files have been split into sub-modules with barrel re-exports (all external import paths remain unchanged):
- **Backend**:
  - `server/core/stripe/webhooks/` — Webhook dispatcher + 8 handler files (was `webhooks.ts`, 6,149 lines)
  - `server/core/trackman/` — CSV import pipeline in 7 files (was `trackmanImport.ts`, 4,213 lines)
  - `server/routes/trackman/admin.ts` — Split into `admin-resolution.ts`, `admin-roster.ts`, `admin-maintenance.ts` sub-routers (was 4,040 lines)
  - `server/core/integrity/` — Data integrity checks in 8 files (was `dataIntegrity.ts`, 3,891 lines)
  - `server/routes/stripe/payments.ts` — Split into `booking-fees.ts`, `quick-charge.ts`, `payment-admin.ts`, `financial-reports.ts` sub-routers (was 3,160 lines)
  - `server/core/resource/` — Resource service in 6 files (was `resourceService.ts`, 2,566 lines)
- **Frontend**:
  - `src/pages/Admin/tabs/dataIntegrity/` — 6 sub-components + hooks (was `DataIntegrityTab.tsx`, 2,314 lines)
  - `src/pages/Admin/tabs/directory/` — 9 sub-components + hooks (was `DirectoryTab.tsx`, 2,233 lines)
  - `src/components/admin/memberBilling/` — 11 sub-components + hooks (was `MemberBillingTab.tsx`, 2,130 lines)

### Developer Experience & Tooling
- **Linting**: ESLint v9 flat config with `typescript-eslint`, `react-hooks`, and `react-refresh`.
- **Formatting**: Prettier with `eslint-config-prettier`.
- **Type Checking**: `tsc --noEmit` for full project type validation.
- **Unit Testing**: Vitest with `@vitest-environment node` for server tests, covering various core functionalities.
- **Route Index**: Auto-generated route-to-file lookup at `docs/ROUTE_INDEX.md`.
- **Editor Config**: `.editorconfig` for consistent indentation.
- **Env Template**: `.env.example` documents environment variables.
- **Ghost Column Guard**: Custom script `scripts/check-ghost-columns.sh` prevents invalid DB column references.
- **Input Validation**: Shared Zod schemas in `shared/validators/` with `validateBody` middleware. Validator files: `payments.ts` (payment intents, quick charge, saved card, receipts), `paymentAdmin.ts` (guest passes, notes, retry/cancel/refund/capture/void), `subscriptions.ts` (create subscription, new member subscription), `dataIntegrity.ts` (resolve/ignore/sync issues, merge, billing provider), `resources.ts` (assign member, link Trackman, bookings, events), `booking.ts` (booking requests), `roster.ts` (participants, batch), `members.ts` (create member, tier change).
- **API Documentation**: Comprehensive endpoint reference at `docs/API.md`.

### HubSpot Sync Filtering (v8.70.0)
- **API-Level Filtering**: `syncAllMembersFromHubSpot` uses `searchApi.doSearch()` with filter groups: meaningful statuses (`active`, `trialing`, `past_due`, `pending`, `suspended`, `declined`, `frozen`) OR contacts with `mindbody_client_id` (billing history). Dead statuses (`non-member`, `archived`, `cancelled`, `expired`, `terminated`) excluded at the API level unless they have Mindbody billing history.
- **Archived User Protection**: Both sync functions skip any local user where `archived_at IS NOT NULL`. Only manual staff action can un-archive a user — HubSpot sync cannot resurrect archived records.
- **Non-Transacting Safety Net**: New contacts with dead statuses and no Mindbody ID are not imported into the users table (secondary guard behind API-level filter).
- **Dev Stripe Check Suppression**: In non-production environments, the "Billing Provider Hybrid State" integrity check skips the `billing_provider='stripe' AND stripe_subscription_id IS NULL` condition — Stripe env validation clears production subscription IDs in test mode, making this check produce false positives.

### HubSpot Webhook-First Inbound Sync (v8.71.0)
- **Webhook-first architecture**: The `POST /api/hubspot/webhooks` endpoint is the primary inbound sync mechanism. All HubSpot `contact.propertyChange` events are processed in real-time, replacing the 5-minute incremental poll.
- **Profile property handling**: Webhooks handle all profile fields (firstname, lastname, phone, address, city, state, zip, date_of_birth, mindbody_client_id, membership_start_date, discount_reason, opt-in preferences) with COALESCE rules — only fill empty DB fields, never overwrite existing data. Opt-in fields and `membership_discount_reason` always overwrite (HubSpot is authoritative for communication preferences).
- **Protection rules**: Skip archived users, skip sync_exclusions, STRIPE WINS for status/tier on Stripe-billed members, skip visitors for status changes, skip unknown users (no upsert from webhooks).
- **Weekly reconciliation**: Full member sync (`syncAllMembersFromHubSpot`) changed from daily 3 AM to weekly Sunday 3 AM Pacific. Acts as a safety net to catch any missed webhooks.
- **5-minute incremental poll removed**: The `INCREMENTAL_SYNC_INTERVAL` and `fetchRecentlyModifiedContacts` polling logic removed from the contact cache. Cache still refreshes every 30 minutes and is invalidated instantly when webhooks fire.

### Staff Admin UX Robustness (v8.72.0)
- **Resume subscription confirmation**: Resume button now opens a confirmation modal (`ConfirmResumeModal`) instead of firing immediately — prevents accidental resumption of paused subscriptions.
- **Billing source change confirmation**: Billing provider dropdown changes now route through `ConfirmBillingSourceModal` showing current→new source before executing, preventing accidental billing source switches.
- **Tier sync coalescing**: `queueTierSync` cancels any pending/failed `sync_tier` jobs for the same email before enqueueing a new one. Rapid A→B→C tier changes result in a single HubSpot sync for the final tier, not three separate jobs.
- **Unsaved changes guard**: `MemberProfileDrawer` warns staff with a `window.confirm` dialog when closing with unsaved notes or communication drafts. Backdrop click, close button, and escape all route through `handleDrawerClose`.
- **Mutation button disable**: All billing mutation buttons (`StripeBillingSection`) properly use `disabled={isPending}` during async operations to prevent double-clicks.
- **Toast/haptic consistency migration**: Older admin components (`BugReportsAdmin`, `DiscountsSubTab`, `ApplicationPipeline`) migrated from `console.error` or custom inline toast state to the global `useToast` + `haptic` utilities for consistent success/error feedback across all staff actions.

### Performance Optimization (v8.77.3)
- **Booking List N+1 Elimination**: Consolidated 5 sequential `booking_participants` queries in `GET /api/booking-requests` into a single batch query with in-memory partitioning. Reduces database round-trips from ~6 to ~2 per booking list request, significantly improving response time for member and staff booking views.
- **Fee Calculation Parallelization**: `computeFeeBreakdown` in `unifiedFeeService.ts` now runs `getTierLimits` and `getGuestPassInfo` concurrently via `Promise.all` instead of sequentially, shaving ~1 DB round-trip from every fee preview and check-in.
- **Payment Record Error Escalation**: Silent `logger.warn` on payment record DB insert failures in `quick-charge.ts` (guest checkout + quick charge) and `terminal.ts` escalated to `logger.error` with `CRITICAL` tag and full payment context. These failures mean Stripe charged the customer but the local record is missing — now visible in error monitoring instead of buried in warnings.

### Bug & Stability Fixes (v8.77.2)
- **TabTransition Timer Leak**: `TabTransition` component's `enterTimer` was created inside a `setTimeout` callback but never tracked for cleanup on unmount. Both exit and enter timers now stored in refs with proper cleanup in the `useEffect` return — prevents state updates on unmounted components during rapid tab switches.
- **Circular Import HMR Fix**: Extracted shared navigation constants (`TabType`, `tabToPath`, `pathToTab`, `getTabFromPathname`) from `src/pages/Admin/layout/types.ts` into `src/lib/nav-constants.ts`. `StaffMobileSidebar` and all Staff Command Center sections now import from the shared file instead of reaching into the Admin layout directory — breaks the HMR circular dependency chain that caused repeated page reloads during development.
- **Scheduler Overlap Guards**: Added `isRunning` flags to `sessionCleanupScheduler`, `communicationLogsScheduler`, and `webhookLogCleanupScheduler` to prevent overlapping executions if a task runs longer than its interval. `communicationLogsScheduler` now calls `syncCommunicationLogsFromHubSpot` directly (awaited) instead of the fire-and-forget `triggerCommunicationLogsSync` wrapper, and calls `stopCommunicationLogsScheduler()` before starting to prevent duplicate intervals on hot-reload.

### Code Quality Audit Fixes (v8.77.1)
- **Global Express Error Middleware**: Added catch-all `(err, req, res, next)` error handler at the end of the Express middleware chain in `server/index.ts`. Any unhandled route error now returns a JSON `{ error: 'Internal server error' }` with 500 status instead of a raw HTML page. Uses `getErrorStatusCode` for proper status propagation.
- **Eliminated `as any` Casts**: Removed all `as any` type casts from server code. `server/utils/resend.ts` now uses a typed `ResendConnectionSettings` interface. `server/routes/hubspot.ts` now uses `getErrorStatusCode()` from `errorUtils.ts` instead of `(err as any)?.code` chains.
- **Enhanced `getErrorStatusCode`**: `server/utils/errorUtils.ts` now checks `error.response.status` (nested object) in addition to `error.statusCode`, `error.status`, and `error.code` — properly handles HubSpot SDK error objects.
- **Consolidated Date Formatting**: `src/utils/dateUtils.ts` gained `formatDatePacific()` and `formatTimePacific()` exports. `RedeemPassCard.tsx` now imports shared date utilities instead of defining local duplicates.

### Bug Audit Fixes (v8.77.0)
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

### Concurrency & Data Integrity Fixes (v8.76.0)
- **Waitlist Promotion Race Condition**: `FOR UPDATE SKIP LOCKED` on waitlist promotion now runs inside `db.transaction()` — previously the lock was released immediately because it ran on the global pool outside a transaction. Two simultaneous cancellations could promote the same waitlisted user.
- **Trackman Reconciliation Atomicity**: `recordUsage()` and the reconciliation status UPDATE are now wrapped in a single `db.transaction()`. If either fails, both roll back — prevents double-charges when staff retries a failed adjustment.
- **Timezone-Safe DOW Matching**: Recurring wellness class bulk updates replaced `new Date(dateStr).getDay()` (which evaluates in server timezone, shifting the day) with `EXTRACT(DOW FROM dateStr::date)` in SQL, letting PostgreSQL handle the day-of-week calculation correctly.
- **Manual Enrollment Notifications**: Staff-initiated wellness enrollments now send in-app notification, push notification, and WebSocket broadcast to both the enrolled member and staff dashboards — previously the member received zero communication.

### Security & Reliability Audit Fixes (v8.75.0)
- **Rate Limiting**: Global rate limiter corrected — authenticated users get 2,000 req/min, anonymous users get 600. Previously reversed (v8.75.0).
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

### Admin Settings Expansion (v8.74.0)
- **Settings Infrastructure**: Key-value store in `system_settings` table, cached via `settingsHelper.ts` (30s TTL), bulk save via `PUT /api/admin/settings`. Public settings exposed via unauthenticated `GET /api/settings/public` (contact, social, apple_messages, hours_display categories only). App Display Settings (club name, support email, timezone) and Purchase Category Labels sections were removed — they were not wired to any consumers.
- **Contact & Social Media**: Phone, email, address, Google/Apple Maps URLs, social media links (Instagram, TikTok, LinkedIn), Apple Messages for Business (toggle + Business ID), display hours configurable from admin settings. Contact page and Footer read from settings with hardcoded fallbacks.
- **Resource Operating Hours**: Availability hours are derived from the Display Hours settings (`hours.monday`, `hours.tuesday_thursday`, `hours.friday_saturday`, `hours.sunday`) — parsed per day of week with minute-level precision. Monday "Closed" = no bookable slots. "8:30 AM – 8:00 PM" = slots from 8:30 AM to 8:00 PM. Display Hours UI uses time picker selects (30-min increments) with Closed checkbox per day group. Per-resource slot durations (golf=60, conference=30, tours=30) are individually configurable. Wellness & Classes have no configurable hours (Google Calendar events). All business hours consumers read from settings: `getResourceConfig(type, date?)` in `config.ts`, `getBusinessHoursFromSettings(date)` in `availability.ts`, staff conference booking route, and frontend `isFacilityOpen(displayHours?)` in `dateUtils.ts`.
- **HubSpot Contact Mappings**: Tier name mappings and status mappings configurable from admin settings. Async wrapper functions (`getDbStatusToHubSpotMapping`, `getTierToHubSpotMapping`) read from settings with hardcoded fallbacks. Pipeline ID and stage ID settings removed (deal sync fully removed).
- **Notification & Communication**: Daily reminder hour, morning closure hour, onboarding nudge hour, grace period hour/days, max onboarding nudges, and trial coupon code all read from settings at runtime via `getSettingValue()`. HubSpot stage/tier/status collapsible sections in UI use expand/collapse pattern.

### Bug Fixes (v8.77.2)
- **TabTransition timer leak fix**: Both `enterTimer` and `delayTimer` in `TabTransition.tsx` are now tracked via refs with proper `useEffect` cleanup, preventing orphaned timers on unmount.
- **Circular import chain fix**: Extracted `TabType`, `tabToPath`, `pathToTab`, `getTabFromPathname` from `src/pages/Admin/layout/types.ts` into `src/lib/nav-constants.ts`. All `src/components/` files import from `nav-constants.ts`; `layout/types.ts` re-exports for backward compatibility within Admin pages. This breaks the HMR cycle that caused repeated page reloads.
- **Scheduler overlap guards**: Added `isRunning` flags to `sessionCleanupScheduler`, `communicationLogsScheduler`, `webhookLogCleanupScheduler`, `pendingUserCleanupScheduler`, `stuckCancellationScheduler`, `webhookEventCleanupScheduler`. Added `stop` functions and double-start protection to `sessionCleanupScheduler`, `webhookLogCleanupScheduler`, `weeklyCleanupScheduler`, `duplicateCleanupScheduler`. `supabaseHeartbeatScheduler` now calls `stop` before re-starting.
- **TrackmanWebhookEventsSection timeout cleanup**: All three `setTimeout(() => setAutoMatchResult(null), 5000)` calls in `handleAutoMatch` now use an `autoMatchTimeoutRef` with `useEffect` unmount cleanup, preventing state updates on unmounted components.
- **Empty catch block fix**: `server/core/trackman/service.ts:749` now logs a warning with booking ID instead of silently swallowing errors during legacy unmatched entry resolution.

### Bug Fixes (v8.77.1)
- **CafeTab controlled/uncontrolled fix**: Added `|| ''` fallback to `value={newItem.category}` in `CafeTab.tsx` select input to prevent React controlled/uncontrolled warnings when category is undefined.
- **AdminDashboard circular import fix**: Replaced barrel import from `./layout` with direct imports from individual modules (`./layout/types`, `./layout/StaffBottomNav`, `./layout/StaffSidebar`, etc.) to reduce HMR invalidation chain and fix Vite HMR churn.
- **AdminDashboard training step inputs**: Added `|| ''` fallback to `step.title` and `step.content` inputs in the TrainingSectionModal to prevent controlled/uncontrolled warnings.
- **TodayScheduleSection null crash fix**: Changed `nextEvent &&` to `nextEvent != null &&` before using the `in` operator, preventing TypeError when `nextEvent` is null/undefined.
- **AlertsCard null guard**: Added `(notifications || [])` guard on `.filter()` and `!notifications ||` check on `.length` to prevent crash when notifications prop is null/undefined.

### Booking Data Integrity Fixes (v8.73.0)
- **Owner slot link sync**: When staff links a member to an empty owner slot via `PUT /api/admin/booking/:bookingId/members/:slotId/link`, the `booking_requests` row (`user_id`, `user_email`, `user_name`) is now updated to match the new owner. Previously, the participant record was updated but the booking header still showed the original Trackman import name, causing a visible mismatch between the booking title and the roster owner.
- **Booking source enum fix**: `revertToApproved()` and the Member Balance endpoint (`/api/member/balance`) no longer use `COALESCE(bs.source, '')` to check for Trackman-sourced sessions — PostgreSQL rejected the empty string as an invalid `booking_source` enum value. Fixed to use `(bs.source IS NULL OR bs.source::text NOT IN (...))`, which correctly handles NULL sources without enum coercion errors.

### HubSpot Outbound Sync Hardening (v8.70.0)
- **`findOrCreateHubSpotContact`**: When an existing contact is found, updates lifecycle stage (`customer` for members, `lead` for visitors/day-pass) and `membership_status` without downgrading `customer`→`lead`. Fills missing name/phone. Clears lifecycle before setting (HubSpot API requirement). Restores previous lifecycle on failure to prevent blank lifecycle states.
- **`syncDayPassPurchaseToHubSpot`**: Promotes existing contacts from dead lifecycle stages to `lead` without downgrading `customer`. Fills missing names during promotion.
- **`syncMemberToHubSpot` fallback**: Looks up user's name from the database before calling `findOrCreateHubSpotContact` instead of passing empty strings.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Contact-only synchronization for membership status, tier, and profile data (deal sync removed).
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
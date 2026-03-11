# Ever Club Members App

**Current Version**: 8.82.0 (March 11, 2026)

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
- **Booking & Scheduling**: "Request & Hold" model, unified participant management, calendar synchronization, auto-complete scheduler, and conflict resolution. Integrates with Trackman webhooks and handles guest/overage fees. Staff golf lessons create only `availability_blocks` (no `facility_closures` notice records). The Google Calendar sync (`syncInternalCalendarToClosures`) explicitly skips lesson-titled events to prevent them from creating notices. Trackman webhook auto-approval transfers all booking participants to the new session. Staff can assign additional players to sessions. Booking approvals are separated from session creation for cleaner code paths. Booking cancellation uses a transactional DB status change with post-commit best-effort side effects (guest pass refund, usage ledger cleanup, Stripe refund, calendar deletion). **Trackman imports are usage-tracking only — all trackman-sourced participants get `payment_status = 'waived'` and the balance endpoint excludes `trackman_import`/`trackman_webhook` sessions from fee calculations.** V2 Trackman webhook auto-link (`tryMatchByBayDateTime`) uses a tight 5-minute tolerance with end-time verification and refuses ambiguous matches (multiple candidates). CSV import corrects session owner mismatches when the authoritative customer data differs from the auto-linked owner. **Booking owner invariant**: all 9 paths that set `booking_requests.user_email` also update `booking_requests.user_id` and the `booking_participants` session owner row — including CSV unmatched→matched, CSV placeholder merge, CSV ghost update, staff assign/change-owner, staff link-trackman-to-member, and admin resolution. **Participant overlap protection**: Booking creation checks both the owner AND each member participant for time conflicts (owned or participant bookings at overlapping times). Conference room frontend uses `.filter()` (not `.find()`) to check ALL simulator bookings when blocking overlapping time slots. `checkExistingBookings` and `checkExistingBookingsForStaff` both include participant bookings via subquery. During booking approval, conflicting participants are silently skipped (not added to the session) with a warning log — the approval itself is not blocked.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, and guest fees based on a "one invoice per booking" architecture. Supports dual payment paths and existing payments. Roster changes trigger fee recalculation; payment locks the roster. Staff can manage conference room prepayments on behalf of members. Fee recalculation skips already-paid participants. Draft invoices are cleaned up when bookings are cancelled. Invoices are voided on permanent booking deletion. **Usage ledger queries must filter out cancelled bookings**: `ledger_usage` CTE in `unifiedFeeService.ts` and `getDailyUsageFromLedger` in `usageCalculator.ts` use `EXISTS (... status NOT IN cancelled/declined/cancellation_pending/deleted)` to only count usage from sessions with at least one active booking. Conference room and simulator daily allowances are tracked separately (`daily_conf_room_minutes` vs `daily_sim_minutes`). **Invoice PI architecture**: Member portal interactive payments use `collection_method: 'charge_automatically'` with `expand: ['payment_intent', 'confirmation_secret']` on `finalizeInvoice()` to get the PI's `client_secret` synchronously. The member chooses their payment method via Stripe Payment Element. When the PI succeeds, Stripe auto-settles the invoice — no OOB needed. **Unified payment modal**: Both Dashboard and History page use `MemberPaymentModal` for booking-linked invoices (detected via `metadata.bookingId`). `InvoicePaymentModal` is only used for non-booking invoices. The fee summary shows per-participant line items with fee type descriptions (Overage Fee, Guest Fee) computed by `describeFee()` using `PRICING.OVERAGE_RATE_DOLLARS`. Staff paths (booking-fees.ts) keep `charge_automatically` via `finalizeAndPayInvoice` for explicit charge-saved-card, terminal, and mark-as-paid flows. OOB reconciliation (`paid_out_of_band`) is reserved exclusively for terminal/in-person payments (`card_present`/`interac_present`) and staff mark-as-paid. `buildInvoiceDescription` uses only the booking reference — fee details come from Stripe line items. Stale open invoices (amount mismatch with recalculated fees) are voided and recreated.
- **Member Lifecycle**: Membership tiers, QR/NFC check-in, and onboarding processes. QR scans route to booking check-in or walk-in.
- **Walk-In Visit Tracking**: Walk-in visits are recorded via QR/NFC scan, syncing to HubSpot and broadcasting WebSocket events.
- **Error Handling**: Prohibits empty catch blocks; all must re-throw, log, or use `safeDbOperation()`. `safeDbTransaction()` uses Drizzle's native `db.transaction()` with automatic rollback and staff alert notifications on failure (rewritten from raw `PoolClient` in v8.75.0). Global Express error middleware (`server/index.ts`) catches unhandled route errors and returns JSON 500 responses instead of raw HTML. Custom `AppError` class (`server/core/errors.ts`) replaces plain thrown objects with proper Error instances preserving stack traces. `sql.raw()` calls validated against column allowlists to prevent SQL injection. Session/billing lookups re-throw DB errors instead of silently returning null/empty.
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: Public endpoints creating database records are rate-limited. Subscription creation endpoints have a dedicated `subscriptionCreationRateLimiter` and an in-memory per-email operation lock (v8.58.0). OTP verification uses three-tier rate limiting: per-IP+email (5 attempts), per-IP global (15 attempts), and per-email aggregate (20 attempts). Keys always include IP (fallback to 'unknown') to prevent unauthenticated lockout of legitimate users. Rate limiter key generators use `String()` coercion before `.toLowerCase()` to prevent TypeError crashes from non-string input (v8.69.0). The in-memory lock cleanup interval uses `.unref()` to avoid pinning the event loop (v8.69.0).
- **Subscription Creation Safety**: Per-email operation locks prevent duplicate membership creation via PostgreSQL `subscription_locks` table (atomic `INSERT...ON CONFLICT WHERE` with 120s expiry, in-memory fallback). `acquireSubscriptionLock` and `releaseSubscriptionLock` are **async** — all callers must `await`. Existing incomplete subscriptions can be reused via payment intent refresh. Idempotency keys prevent duplicate Stripe charges. Frontend guardrails: email pre-check on blur (`GET /api/visitors/check-email`), form submission debounce refs, 5-second post-creation cooldown, session-level recent-creation alerts (10-min window), and "Recently Added (24h)" directory filter.
- **Scheduler Robustness**: All 25 schedulers have overlap protection — `isRunning` flags (19), named guards (3), `isProcessing`/`isSyncing` (2), recursive setTimeout (2). Also uses catch-up windows, claim slots, and persistent notification deduplication (6-hour windows for waiver review and stuck booking alerts). **Staggered startup**: `initSchedulers()` staggers all 27 schedulers across ~270s in 6 waves (10s apart) to prevent database connection spikes at deployment. Wave order: real-time → booking/calendar → notifications → financial → HubSpot/external → cleanup. **Instant DB triggers** (`trg_auto_billing_provider`, `trg_sync_staff_role`, `trg_link_participant_user_id`) handle data fixes at write time; schedulers are daily safety nets only. Linked email users should be merged into the primary via `userMerge.ts` — the system no longer copies tiers to linked user records (`trg_copy_tier_on_link` was removed). **Error reporting**: `alertOnScheduledTaskFailure` extracts `error.cause` from Drizzle ORM errors to surface the actual database error in staff alerts (Drizzle wraps PG errors and hides the real message in `cause`).
- **Stripe Integration Specifics**: Includes webhook safety, payment handler logic, coupon application, and specific requirements for `trial_end` and $0 subscriptions. Manual Stripe refunds trigger full resource teardown (guest pass refund, usage_ledger cleanup). Customer linking requires authenticated metadata (`source=app` or `userId`). Day pass fulfillment handles $0 checkouts (100% promo codes) via synthetic paymentIntentId. Webhook dispatch uses shared `dispatchWebhookEvent()` function (not duplicated between process and replay). Idempotency keys are deterministic (content-hash based, no `Date.now()`). Deferred webhook actions use standalone `db` or `pool.connect()`, never released transaction clients.
- **Database Performance**: Indexes on `users.hubspot_id`, `users.tier_id`, `LOWER(users.trackman_email)`, `member_notes.member_email`, `communication_logs.member_email`, `magic_links.token`. Tier joins use `u.tier_id = mt.id` FK (not `LOWER(u.tier) = LOWER(mt.name)` string matching). N+1 queries fixed in cancellation cascade (batch email fetch) and integrity checks (parallel Stripe calls). `RETRYABLE_ERRORS` consolidated in `server/core/retry.ts` as single source of truth.
- **Data Integrity and Consistency**: All three staff notification fan-out paths (`notificationService.notifyAllStaff`, `staffNotifications.getStaffAndAdminEmails`, `bookingEvents.getStaffEmails`) INNER JOIN `staff_users` against `users` to prevent notifications for deleted staff. Archive and permanent-delete flows deactivate the `staff_users` entry. `isSyntheticEmail()` guard blocks notifications for synthetic/imported emails (`@trackman.local`, `@visitors.evenhouse.club`, `private-event@`, `classpass-*`, etc.) across all 25 `db.insert(notifications)` paths. Event RSVP integrity checks filter `COALESCE(er.source, 'local') = 'local'` to exclude Eventbrite-imported external guest RSVPs from orphan/lingering-data alerts. Prevents double-charging, ensures orphaned invoice cleanup, uses optimistic locking for booking status transitions, and maintains atomicity for critical operations. `usage_ledger` has `ON DELETE CASCADE`. `booking_fee_snapshots` has `ON DELETE CASCADE` on both `booking_id` and `session_id`. `booking_participants` has `ON DELETE CASCADE` on `session_id`. Cancellation refunds use `refund_pending` status inside the transaction, updated to `refunded` after Stripe confirms. Advisory locks for session creation serialize on `resourceId:sessionDate` (not startTime) to prevent overlapping-timeslot races; `ensureSessionForBooking` uses `pg_advisory_xact_lock` when an external client (in-transaction) is passed to prevent lock leaks in aborted transactions, and session-level `pg_advisory_lock` with explicit unlock when managing its own client (v8.69.0). Fee recalculation skips already-paid participants to prevent cached_fee_cents overwrite. Usage lookups sum both userId and email entries to prevent double-dipping. Conference room bookings revert to 'pending' if payment fails after auto-confirm or if session creation fails (safety net guard in bookings.ts). `createSessionWithUsageTracking` now calls `linkBookingRequestToSession` when `bookingId` is provided, ensuring `booking_requests.session_id` is always set after successful session creation. `createSessionWithUsageTracking` acquires a user-level advisory lock (`usage::email::date`) covering both billing read and DB write to prevent concurrent fee calculation races; uses `pg_advisory_xact_lock` when called with `externalTx`, session-level `pg_advisory_lock` otherwise. DB-level CHECK constraints enforce: booking/session time order (`end_time > start_time`), active members must have email, `stripe_customer_id` uniqueness (partial unique index). Partial unique index on `day_pass_purchases.stripe_payment_intent_id` (non-null) prevents duplicate day pass purchases under concurrent requests. Partial unique index on `wellness_enrollments(class_id, user_email) WHERE status='confirmed'` prevents duplicate active enrollments. Both day pass confirm and wellness enrollment inserts catch unique constraint violations gracefully. `guest_pass_holds` and `conference_prepayments` have `ON DELETE CASCADE` on `booking_id`. Orphan checks for `booking_participants`, `wellness_enrollments`, `event_rsvps`, `booking_fee_snapshots`, and `booking_resource_relationships` retired in favor of CASCADE/FK constraints. `cleanup.ts` no longer runs redundant orphan-deletion for fee snapshots, wellness enrollments, or booking participants (all CASCADE-protected).
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
- **Meta Pixel**: Facebook/Meta Pixel tracking code in `index.html` for conversion tracking and retargeting on all public pages.
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
  - `server/routes/dataTools/` — Data tools in 5 sub-routers: `member-sync.ts`, `booking-tools.ts`, `audit.ts`, `stripe-tools.ts`, `maintenance.ts` (was `dataTools.ts`, 2,683 lines)
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
- **Input Validation**: Shared Zod schemas in `shared/validators/` with `validateBody` middleware. Validator files: `payments.ts` (payment intents, quick charge, saved card, receipts), `paymentAdmin.ts` (guest passes, notes, retry/cancel/refund/capture/void), `subscriptions.ts` (create subscription, new member subscription), `dataIntegrity.ts` (resolve/ignore/sync issues, merge, billing provider, tour status, clear stripe ID), `resources.ts` (assign member, link Trackman, bookings, events), `booking.ts` (booking requests), `roster.ts` (participants, batch), `members.ts` (create member, tier change).
- **API Documentation**: Comprehensive endpoint reference at `docs/API.md`.

### Booking Analytics
- **Analytics Page**: Staff-only analytics dashboard at `/admin/analytics` with 14 visualizations across three endpoints:
  - **Core Stats** (`GET /api/analytics/booking-stats`):
    1. Total Bookings / Cancellation Rate / Avg Session Length stat cards
    2. Weekly Peak Hours Heatmap (day × hour grid with color intensity)
    3. Resource Utilization horizontal bar chart (total hours per bay/room)
    4. Top 5 Members leaderboard (by total hours booked)
  - **Extended Stats** (`GET /api/analytics/extended-stats`):
    5. Bookings Over Time line chart (weekly counts, last 6 months)
    6. Revenue Over Time stacked area chart (confirmed Stripe payments by category: memberships/overage/guest/day pass/other from `stripe_transaction_cache`)
    7. Day of Week bar chart (all-time booking distribution by weekday)
    8. Utilization by Hour bar chart (average simulator utilization % per time slot, color-coded by threshold)
    9. Active vs Inactive Members ring charts (unique bookers in 30/60/90 day windows vs total active members)
    10. Booking Frequency histogram (member count by booking frequency bucket over 90 days)
  - **Membership Insights** (`GET /api/analytics/membership-insights`):
    11. Tier Distribution donut pie chart (active members by membership tier with legend)
    12. At-Risk Members list (no booking in 45+ days, with days-ago badges, max 15)
    13. New Member Growth line chart (monthly signups over last 6 months)
- **Tech**: Recharts library (BarChart, LineChart, AreaChart, PieChart, SVG ring charts), TanStack Query for data fetching, three parallel queries
- **Files**: `server/routes/analytics.ts`, `src/pages/Admin/tabs/AnalyticsTab.tsx`

### Recent Changes
- **Bug Audit Fixes (v8.82.1)**: Comprehensive bug audit with 13 fixes plus 3 realtime gaps: (1) Server now exits on `initializeApp` failure instead of running in zombie state. (2) Health check (`isReady`) deferred until WebSocket and schedulers are fully initialized. (3) `booking_fee_snapshots` table added to Drizzle schema with partial unique index on `sessionId WHERE status='completed'` to prevent schema drift/accidental drops. (4) Unique constraint added to `usage_ledger(session_id, member_id, source)` to prevent duplicate billing. (5) Foreign key added to `booking_participants.user_id → users.id` to prevent orphaned records. (6) Rate limiting added to public `PATCH /api/tours/:id/confirm` endpoint. (7) Advisory lock added to `createSession()` to match `ensureSessionForBooking`'s locking pattern. (8) Fee calculation in `usageCalculator.ts` converted from dollar-based to cents-based math via `PRICING.OVERAGE_RATE_CENTS`. (9) Payment matching tolerance reduced from 50 cents to 5 cents in `PaymentStatusService`. (10) WebSocket module now uses the shared database pool instead of creating a redundant separate pool. (11) Session secret fallback uses `crypto.randomBytes()` instead of predictable `Date.now()`. (12) `onError` handlers added to booking mutations (approve/decline/cancel/check-in) to revert stale UI state on failure. (13) BookGolf realtime: `booking-update` handler now invalidates availability queries (was missing), added `availability-update` listener for WebSocket-pushed slot changes. (14) Booking availability `staleTime` set to 2 minutes (realtime handles freshness via Supabase + WebSocket). (15) Fixed `useWebSocketQuerySync` invalidating `['book-golf']` (kebab-case) instead of `['bookGolf']` (camelCase) — 6 invalidation calls were silently doing nothing.
- **Session & Auth TTL Alignment (v8.82.0)**: Internal session `expires_at` changed from 7 days to 30 days across all login paths (OTP, password, Google OAuth, dev login) to match the cookie and Postgres session store TTL. Eliminates confusing "logged in but expired" state after 7 days.
- **Guest Pass Refund Window Consistency (v8.82.0)**: Staff/system cancellation cascade (`cancellation.ts`) changed from 24-hour to 1-hour threshold, matching member-facing cancellation. Member cancellation now also gates guest pass refunds behind the same `shouldSkipRefund` check. Both paths use `>= 1 hour` consistently.
- **Fee Calculator Null Guard (v8.82.0)**: `feeCalculator.ts` now checks `ledger_fee` for null/NaN before `parseFloat()`, preventing incorrect `NaN` billing when a usage ledger join returns no match.
- **Invoice Rounding Safety (v8.82.0)**: `bookingInvoiceService.ts` now verifies fee amounts are exact multiples of the rate before using Stripe price × quantity. Falls back to raw cent amounts when there's a remainder, preventing invoice amount mismatches. Also requires rate > 0 for the price-based branch.
- **Conference Room Approval Status (v8.82.0)**: Conference room bookings now go through `'approved'` status like simulators, instead of skipping to `'attended'`. Fixes conference rooms being non-cancellable after approval and ensures reminder/notification logic works consistently.
- **Lesson Closure Guard & Cleanup**: `markBookingAsEvent` now rejects lesson-named bookings (prefixes: lesson, private lesson, kids lesson, group lesson, beginner group lesson) with a 400 error directing staff to use "Assign to Staff" instead. New `cleanupLessonClosures()` deactivates only past lesson-titled closures (not private events, maintenance, or other notice types). Runs on startup (immediate effect on deploy) and weekly via `runScheduledCleanup`. Fixes 470+ accumulated past lesson notices.
- **Data Integrity Expansion (v8.81.0)**: Three new integrity checks: `checkArchivedMemberLingeringData` detects archived members with leftover bookings/passes/enrollments, `checkActiveMembersWithoutWaivers` flags active members missing signed waivers after 7 days, `checkEmailOrphans` finds records orphaned by email changes or user deletions. New resolution endpoints: `POST /api/data-integrity/fix/delete-orphan-records-by-email` and `POST /api/data-integrity/fix/mark-waiver-signed`. Event RSVP integrity checks filter `COALESCE(er.source, 'local') = 'local'` to exclude Eventbrite-imported external guest RSVPs from orphan alerts.
- **Synthetic Email Notification Guard (v8.81.0)**: `isSyntheticEmail()` guard in `notificationService.ts` blocks notifications for synthetic/imported emails (`@trackman.local`, `@visitors.evenhouse.club`, `private-event@`, `classpass-*`, etc.) in `notifyMember()` and caller-level guards in approval, cancellation, staff action, and Trackman flows. All three staff notification fan-out paths (`notifyAllStaff`, `staffNotifications.getStaffAndAdminEmails`, `bookingEvents.getStaffEmails`) INNER JOIN `staff_users` against `users` to prevent notifications for deleted staff. Archive and permanent-delete flows deactivate the `staff_users` entry.
- **Member Archiving Cascade Cleanup (v8.81.0)**: Member deletion/archiving now performs cascading cleanups across `event_rsvps`, `booking_requests`, `wellness_enrollments`, `guest_pass_holds`, `group_members`, and `push_subscriptions`. Email change cascading expanded to cover `notifications`, `event_rsvps`, `push_subscriptions`, `wellness_enrollments`, and `user_dismissed_notices`.
- **Booking Notification Fixes (v8.81.0)**: Restored member notifications for booking approvals and declines that were accidentally removed. Fixed duplicate notification bug where approval/decline flows sent the same notification twice.
- **Android/Pixel Scrolling Hardening (v8.81.0)**: PullToRefresh direction lock prevents accidental horizontal swipes. CSS `overflow` properties adjusted for Android Chrome. Touch listeners moved to document level for Pixel/stock Chrome. Edge swipe gesture defers to system back gesture when Android gesture nav is active (`isAndroidGestureNav`).
- **Print Style & Logger Improvements (v8.81.0)**: Print styles use CSS attribute selectors instead of backslash-escaped Tailwind classes for Lightning CSS compatibility. Server logger suppresses noisy 404s for non-existent paths and unauthenticated session checks to debug level. `suppressWarnings.ts` filters pg-connection-string SSL mode warnings.
- **Email Templates: Full Coverage & Non-Toggleable Categories (v8.80.0)**: All system emails now extracted into dedicated email modules and registered in the template preview system. Template count: 25 (was 17).
- **Mark as Private Event Workflow Fixes (v8.80.0)**: `markBookingAsEvent` now accepts an optional `eventTitle` parameter (defaults to "Private Event"). Affected areas stored as comma-separated strings. Notice type labels formatted consistently via `formatTitleForDisplay`.
- **Session Isolation for Cancelled Bookings**: `ensureSessionForBooking` no longer reuses sessions where all bookings are cancelled/deleted.
- **Usage Ledger Cleanup on Cancellation**: `usage_ledger` entries deleted inside the cancellation transaction when the member has no other active bookings on the same session.
- **Pull-to-Refresh Fix**: Now correctly invokes `onRefresh` callback instead of always doing a full page reload. Android touch handling made passive with direction locking.
- **Pixel Optimizations**: `touch-action: manipulation` on tactile elements, GPU promotion for staggered animations, `overscroll-behavior: contain` on scroll-lock elements.
- **Chunk Error Auto-Recovery**: Error boundaries clear service worker caches before reloading on chunk load errors.
- **Trackman User Update/Purchase Webhooks**: Backend handles `user_update` and `purchase` event types with proper extraction, member matching, and logging.

See [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for the full changelog (v8.70.0+).

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Contact-only synchronization for membership status, tier, and profile data (deal sync removed).
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
# Ever Club Members App

**Current Version**: 8.80.0 (March 7, 2026)

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
- **Booking & Scheduling**: "Request & Hold" model, unified participant management, calendar synchronization, auto-complete scheduler, and conflict resolution. Integrates with Trackman webhooks and handles guest/overage fees. Staff golf lessons create only `availability_blocks` (no `facility_closures` notice records). Trackman webhook auto-approval transfers all booking participants to the new session. Staff can assign additional players to sessions. Booking approvals are separated from session creation for cleaner code paths. Booking cancellation uses a transactional DB status change with post-commit best-effort side effects (guest pass refund, usage ledger cleanup, Stripe refund, calendar deletion). **Trackman imports are usage-tracking only — all trackman-sourced participants get `payment_status = 'waived'` and the balance endpoint excludes `trackman_import`/`trackman_webhook` sessions from fee calculations.** V2 Trackman webhook auto-link (`tryMatchByBayDateTime`) uses a tight 5-minute tolerance with end-time verification and refuses ambiguous matches (multiple candidates). CSV import corrects session owner mismatches when the authoritative customer data differs from the auto-linked owner. **Booking owner invariant**: all 9 paths that set `booking_requests.user_email` also update `booking_requests.user_id` and the `booking_participants` session owner row — including CSV unmatched→matched, CSV placeholder merge, CSV ghost update, staff assign/change-owner, staff link-trackman-to-member, and admin resolution. **Participant overlap protection**: Booking creation checks both the owner AND each member participant for time conflicts (owned or participant bookings at overlapping times). Conference room frontend uses `.filter()` (not `.find()`) to check ALL simulator bookings when blocking overlapping time slots. `checkExistingBookings` and `checkExistingBookingsForStaff` both include participant bookings via subquery. During booking approval, conflicting participants are silently skipped (not added to the session) with a warning log — the approval itself is not blocked.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, and guest fees based on a "one invoice per booking" architecture. Supports dual payment paths and existing payments. Roster changes trigger fee recalculation; payment locks the roster. Staff can manage conference room prepayments on behalf of members. Fee recalculation skips already-paid participants. Draft invoices are cleaned up when bookings are cancelled. Invoices are voided on permanent booking deletion.
- **Member Lifecycle**: Membership tiers, QR/NFC check-in, and onboarding processes. QR scans route to booking check-in or walk-in.
- **Walk-In Visit Tracking**: Walk-in visits are recorded via QR/NFC scan, syncing to HubSpot and broadcasting WebSocket events.
- **Error Handling**: Prohibits empty catch blocks; all must re-throw, log, or use `safeDbOperation()`. `safeDbTransaction()` uses Drizzle's native `db.transaction()` with automatic rollback and staff alert notifications on failure (rewritten from raw `PoolClient` in v8.75.0). Global Express error middleware (`server/index.ts`) catches unhandled route errors and returns JSON 500 responses instead of raw HTML.
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: Public endpoints creating database records are rate-limited. Subscription creation endpoints have a dedicated `subscriptionCreationRateLimiter` and an in-memory per-email operation lock (v8.58.0). OTP verification uses three-tier rate limiting: per-IP+email (5 attempts), per-IP global (15 attempts), and per-email aggregate (20 attempts). Keys always include IP (fallback to 'unknown') to prevent unauthenticated lockout of legitimate users. Rate limiter key generators use `String()` coercion before `.toLowerCase()` to prevent TypeError crashes from non-string input (v8.69.0). The in-memory lock cleanup interval uses `.unref()` to avoid pinning the event loop (v8.69.0).
- **Subscription Creation Safety**: Per-email operation locks prevent duplicate membership creation via PostgreSQL `subscription_locks` table (atomic `INSERT...ON CONFLICT WHERE` with 120s expiry, in-memory fallback). `acquireSubscriptionLock` and `releaseSubscriptionLock` are **async** — all callers must `await`. Existing incomplete subscriptions can be reused via payment intent refresh. Idempotency keys prevent duplicate Stripe charges. Frontend guardrails: email pre-check on blur (`GET /api/visitors/check-email`), form submission debounce refs, 5-second post-creation cooldown, session-level recent-creation alerts (10-min window), and "Recently Added (24h)" directory filter.
- **Scheduler Robustness**: All 25 schedulers have overlap protection — `isRunning` flags (19), named guards (3), `isProcessing`/`isSyncing` (2), recursive setTimeout (2). Also uses catch-up windows, claim slots, and persistent notification deduplication (6-hour windows for waiver review and stuck booking alerts). **Staggered startup**: `initSchedulers()` staggers all 27 schedulers across ~270s in 6 waves (10s apart) to prevent database connection spikes at deployment. Wave order: real-time → booking/calendar → notifications → financial → HubSpot/external → cleanup. **Instant DB triggers** (`trg_auto_billing_provider`, `trg_sync_staff_role`, `trg_link_participant_user_id`) handle data fixes at write time; schedulers are daily safety nets only. Linked email users should be merged into the primary via `userMerge.ts` — the system no longer copies tiers to linked user records (`trg_copy_tier_on_link` was removed). **Error reporting**: `alertOnScheduledTaskFailure` extracts `error.cause` from Drizzle ORM errors to surface the actual database error in staff alerts (Drizzle wraps PG errors and hides the real message in `cause`).
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
- **Email Templates: Full Coverage & Non-Toggleable Categories (v8.80.0)**: All system emails now extracted into dedicated email modules and registered in the template preview system. Extracted: OTP login (`auth.ts` → `otpEmail.ts`), tour confirmation (`tours.ts` → `tourEmails.ts`), membership invitation + win-back + account deletion (inline in `stripe/admin.ts` and `account.ts` → `memberInviteEmail.ts`), onboarding nudge HTML generators exported from `onboardingNudgeEmails.ts`. Admin Email Templates tab shows Authentication category (first position, lock icon) with "Always On" badge and non-toggleable UI. Onboarding category added to template browser. Template count: 25 (was 17). Only excluded: CCPA data export (internal staff notification) and custom staff-composed emails (freeform).
- **Mark as Private Event Workflow Fixes (v8.80.0)**: `markBookingAsEvent` now accepts an optional `eventTitle` parameter (defaults to "Private Event") instead of using the placeholder "Unknown (Trackman)" as the notice title. Affected areas stored as comma-separated strings (`bay_1,bay_2`) instead of JSON arrays. Frontend `AssignModeFooter.tsx` shows a title input when creating new notices. Notice type labels (`private_event` → "Private Event") formatted consistently across BlocksTab, AssignModeFooter overlapping notices list, and BookGolf closure alerts via `formatTitleForDisplay` from `closureUtils.ts`. Bay badges display "Simulator Bay X" consistently via `formatSingleArea`. Schema validator updated in `shared/validators/resources.ts`.
- **Name-Based Matching Fully Removed**: All name-based auto-matching removed from Trackman system. Backend `rescanUnmatched` uses email/trackman_email/email-mapping only (no `membersByName` map). CSV import no longer builds a `membersByName` map, logs ambiguous names, or does participant name-matching (`areNamesSimilar`/`findMembersByName` removed from `matching.ts`). `calculateMatchScore` helpers and `GET /api/admin/trackman/fuzzy-matches/:id` endpoints removed from both `admin.ts` and `admin-resolution.ts`. Dead helper functions removed: `areNamesSimilar`, `findMembersByName`, `levenshteinDistance`, `normalizeName`, `autoLinkEmailToOwner`. Frontend `TrackmanTab.tsx` no longer fetches fuzzy-matches or shows "Suggested Matches" — the resolve modal is now search-only (member search input + resolve button). CSV import participant matching now checks `emailMapping` (user_linked_emails + manually_linked_emails + CSV mappings) in addition to `membersByEmail` and `trackmanEmailMapping`.
- **Session Isolation for Cancelled Bookings**: `ensureSessionForBooking` no longer reuses sessions where all bookings are cancelled/deleted. The exact-match and overlap-match queries now include an `EXISTS` check requiring at least one active booking on the session. New bookings always get their own fresh session, preserving cancelled session history for auditing. Sessions with active bookings are still correctly shared (for legitimate overlapping bookings).
- **Usage Ledger Cleanup on Cancellation**: When a booking is cancelled (both direct and pending-cancellation paths), `usage_ledger` entries for that member/session are now deleted inside the same transaction — only if the member has no other active bookings on the same session. Fixes a bug where waived/zero-fee cancellations left stale usage minutes counting against daily allowances (paid cancellations were already handled by the Stripe refund webhook).
- **WebSocket Notification Fetch Error Handling**: `fetchNotificationsForEmail` in `useWebSocket.ts` wrapped in try/catch to prevent unhandled promise rejections when network requests fail during WebSocket message handling.
- **GoogleSignInButton Listener Cleanup**: Event listener on the Google Sign-In script element is now properly removed on component unmount.
- **Pull-to-Refresh Fix**: `PullToRefresh` component was ignoring its `onRefresh` callback — it always did a full page reload instead of calling the provided handler. Now correctly invokes `onRefresh` (which refetches all active React Query queries and dispatches `app-refresh` event), so data actually refreshes in-place without a full reload. Refreshing overlay updated to show mascot + "Refreshing..." text.
- **Chunk Error Auto-Recovery**: Both `ErrorBoundary` and `PageErrorBoundary` now automatically clear service worker caches and unregister stale workers before reloading on chunk load errors (previously did plain reload which could loop on stale cache).
- **Trackman User Update/Purchase Webhooks**: Backend handles `user_update` and `purchase` event types with proper extraction, member matching, and logging. Frontend renders these with distinct indigo/amber styling. Dedup skipped for non-booking events. Stats queries exclude these from booking counts.

See [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for the full changelog (v8.70.0+).

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Contact-only synchronization for membership status, tier, and profile data (deal sync removed).
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
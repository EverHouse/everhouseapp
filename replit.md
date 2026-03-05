# Ever Club Members App

**Current Version**: 8.76.0 (March 5, 2026)

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
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a Header, scrollable Body, and Sticky Footer structure. Button hierarchy differentiates actions.
- **Accessibility**: Adheres to WCAG conventions, including skip navigation, focus trapping, and proper roles/attributes. `prefers-reduced-motion` is respected.
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
- **Booking & Scheduling**: "Request & Hold" model, unified participant management, calendar synchronization, auto-complete scheduler, and conflict resolution. Integrates with Trackman webhooks and handles guest/overage fees. Staff golf lessons create only `availability_blocks` (no `facility_closures` notice records). Trackman webhook auto-approval transfers all booking participants to the new session. Staff can assign additional players to sessions. Booking approvals are separated from session creation for cleaner code paths. Booking cancellation uses a transactional DB status change with post-commit best-effort side effects (guest pass refund, usage ledger cleanup, Stripe refund, calendar deletion). **Trackman imports are usage-tracking only — all trackman-sourced participants get `payment_status = 'waived'` and the balance endpoint excludes `trackman_import`/`trackman_webhook` sessions from fee calculations.**
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, and guest fees based on a "one invoice per booking" architecture. Supports dual payment paths and existing payments. Roster changes trigger fee recalculation; payment locks the roster. Staff can manage conference room prepayments on behalf of members. Fee recalculation skips already-paid participants. Draft invoices are cleaned up when bookings are cancelled. Invoices are voided on permanent booking deletion.
- **Member Lifecycle**: Membership tiers, QR/NFC check-in, and onboarding processes. QR scans route to booking check-in or walk-in.
- **Walk-In Visit Tracking**: Walk-in visits are recorded via QR/NFC scan, syncing to HubSpot and broadcasting WebSocket events.
- **Error Handling**: Prohibits empty catch blocks; all must re-throw, log, or use `safeDbOperation()`. `safeDbTransaction()` uses Drizzle's native `db.transaction()` with automatic rollback and staff alert notifications on failure (rewritten from raw `PoolClient` in v8.75.0).
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: Public endpoints creating database records are rate-limited. Subscription creation endpoints have a dedicated `subscriptionCreationRateLimiter` and an in-memory per-email operation lock (v8.58.0). OTP verification uses three-tier rate limiting: per-IP+email (5 attempts), per-IP global (15 attempts), and per-email aggregate (20 attempts). Keys always include IP (fallback to 'unknown') to prevent unauthenticated lockout of legitimate users. Rate limiter key generators use `String()` coercion before `.toLowerCase()` to prevent TypeError crashes from non-string input (v8.69.0). The in-memory lock cleanup interval uses `.unref()` to avoid pinning the event loop (v8.69.0).
- **Subscription Creation Safety**: Per-email operation locks prevent duplicate membership creation via PostgreSQL `subscription_locks` table (atomic `INSERT...ON CONFLICT WHERE` with 120s expiry, in-memory fallback). `acquireSubscriptionLock` and `releaseSubscriptionLock` are **async** — all callers must `await`. Existing incomplete subscriptions can be reused via payment intent refresh. Idempotency keys prevent duplicate Stripe charges. Frontend guardrails: email pre-check on blur (`GET /api/visitors/check-email`), form submission debounce refs, 5-second post-creation cooldown, session-level recent-creation alerts (10-min window), and "Recently Added (24h)" directory filter.
- **Scheduler Robustness**: Schedulers use `isRunning` flags, catch-up windows, claim slots, and persistent notification deduplication (6-hour windows for waiver review and stuck booking alerts). **Instant DB triggers** (`trg_auto_billing_provider`, `trg_sync_staff_role`, `trg_link_participant_user_id`) handle data fixes at write time; schedulers are daily safety nets only. Linked email users should be merged into the primary via `userMerge.ts` — the system no longer copies tiers to linked user records (`trg_copy_tier_on_link` was removed).
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
- **Deal Enrichment Queue**: `enrichEventDeal` migrated from `setTimeout` to `enqueueHubSpotSync('enrich_event_deal', ...)` — survives server restarts with retry logic.
- **CSV Parser**: Tier sync CSV parser rewritten to handle RFC 4180 escaped double quotes (`""` inside quoted fields), preventing data corruption on fields containing commas or quotes.
- **React Safety**: `useAsyncAction` adds cleanup `useEffect` to clear debounce timers on unmount. `NewUserDrawer` cooldown timer side effects moved out of state updater into `useEffect`. Mode switch calls `resetForm()` to prevent stale form data.
- **safeDbTransaction**: Rewritten to use Drizzle's native `db.transaction()` instead of raw `PoolClient`, ensuring Drizzle queries participate in the transaction.
- **HubSpot Status Code**: `remove-marketing-contacts` endpoint returns 422 instead of 500 for missing HubSpot property configuration.
- **Date Parsing**: `last_manual_fix_at` parsing uses `instanceof Date` check for safe handling of both Date objects and ISO strings.

### Admin Settings Expansion (v8.74.0)
- **Settings Infrastructure**: Key-value store in `system_settings` table, cached via `settingsHelper.ts` (30s TTL), bulk save via `PUT /api/admin/settings`. Public settings exposed via unauthenticated `GET /api/settings/public` (contact, social, apple_messages, hours_display categories only). App Display Settings (club name, support email, timezone) and Purchase Category Labels sections were removed — they were not wired to any consumers.
- **Contact & Social Media**: Phone, email, address, Google/Apple Maps URLs, social media links (Instagram, TikTok, LinkedIn), Apple Messages for Business (toggle + Business ID), display hours configurable from admin settings. Contact page and Footer read from settings with hardcoded fallbacks.
- **Resource Operating Hours**: Availability hours are derived from the Display Hours settings (`hours.monday`, `hours.tuesday_thursday`, `hours.friday_saturday`, `hours.sunday`) — parsed per day of week with minute-level precision. Monday "Closed" = no bookable slots. "8:30 AM – 8:00 PM" = slots from 8:30 AM to 8:00 PM. Display Hours UI uses time picker selects (30-min increments) with Closed checkbox per day group. Per-resource slot durations (golf=60, conference=30, tours=30) are individually configurable. Wellness & Classes have no configurable hours (Google Calendar events). All business hours consumers read from settings: `getResourceConfig(type, date?)` in `config.ts`, `getBusinessHoursFromSettings(date)` in `availability.ts`, staff conference booking route, and frontend `isFacilityOpen(displayHours?)` in `dateUtils.ts`.
- **HubSpot Mappings**: Pipeline ID, stage IDs, tier name mappings, and status mappings all configurable from admin settings. Async wrapper functions (`getHubSpotPipelineId`, `getHubSpotStageId`, `getDbStatusToHubSpotMapping`, `getTierToHubSpotMapping`) read from settings with hardcoded fallbacks. Original sync exports preserved for backward compatibility.
- **Notification & Communication**: Daily reminder hour, morning closure hour, onboarding nudge hour, grace period hour/days, max onboarding nudges, and trial coupon code all read from settings at runtime via `getSettingValue()`. HubSpot stage/tier/status collapsible sections in UI use expand/collapse pattern.

### Booking Data Integrity Fixes (v8.73.0)
- **Owner slot link sync**: When staff links a member to an empty owner slot via `PUT /api/admin/booking/:bookingId/members/:slotId/link`, the `booking_requests` row (`user_id`, `user_email`, `user_name`) is now updated to match the new owner. Previously, the participant record was updated but the booking header still showed the original Trackman import name, causing a visible mismatch between the booking title and the roster owner.
- **Revert-to-approved enum fix**: `revertToApproved()` no longer uses `COALESCE(bs.source, '')` to check for Trackman-sourced sessions — PostgreSQL rejected the empty string as an invalid `booking_source` enum value. Fixed to use `(bs.source IS NULL OR bs.source::text NOT IN (...))`, which correctly handles NULL sources without enum coercion errors.

### HubSpot Outbound Sync Hardening (v8.70.0)
- **`findOrCreateHubSpotContact`**: When an existing contact is found, updates lifecycle stage (`customer` for members, `lead` for visitors/day-pass) and `membership_status` without downgrading `customer`→`lead`. Fills missing name/phone. Clears lifecycle before setting (HubSpot API requirement). Restores previous lifecycle on failure to prevent blank lifecycle states.
- **`syncDayPassPurchaseToHubSpot`**: Promotes existing contacts from dead lifecycle stages to `lead` without downgrading `customer`. Fills missing names during promotion.
- **`syncMemberToHubSpot` fallback**: Looks up user's name from the database before calling `findOrCreateHubSpotContact` instead of passing empty strings.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Two-way data synchronization for membership and profile data.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
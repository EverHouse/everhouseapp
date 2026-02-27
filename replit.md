# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application designed for golf and wellness centers. It aims to be a central digital hub for managing golf simulator bookings, wellness service appointments, and club events. The project's vision is to enhance member satisfaction and operational efficiency for private clubs through comprehensive membership management, facility booking, and community-building tools.

## User Preferences
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## System Architecture

### Core Architecture
- **Naming Conventions**: `snake_case` for PostgreSQL tables/columns; `camelCase` for Drizzle schemas, API JSON payloads, and React/TypeScript frontend. Raw database rows must not be exposed in API responses.
- **Type Safety**: Fix underlying schemas or DTOs to resolve TypeScript mismatches; avoid using `as any`. All raw SQL `db.execute()` results must be typed with row interfaces and cast via `as unknown as RowType[]`. The codebase maintains 0 TypeScript errors.
- **Database Interaction**: Use Drizzle ORM query builders or parameterized `sql` template literals for all SQL queries; raw string-interpolated SQL is forbidden.
- **Timezone**: All date/time operations must explicitly use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged.
- **API/Frontend Consistency**: API response field names must align exactly with frontend TypeScript interfaces.
- **Database & Data Integrity**: Uses PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints.
- **Real-time Updates**: Implements WebSocket broadcasting for booking and invoice changes. Supabase Realtime subscriptions cover `notifications`, `booking_sessions`, `announcements`, and `trackman_unmatched_bookings` tables. Staff Command Center uses React Query (`useCommandCenterQueries.ts`) with WebSocket-driven cache invalidation via `useWebSocketQuerySync.ts` — no polling. `commandCenterKeys` factory in `src/hooks/queries/useCommandCenterQueries.ts` defines query keys; all hooks use `placeholderData: keepPreviousData` for anti-flicker.
- **Member Dashboard**: Member schedule uses a chronological card layout with rich visual cards for bookings, events, and wellness sessions. Cards show player count, start/end times, and "Add to Calendar" functionality.

### UI/UX & Frontend
- **Design System**: Liquid Glass UI system, utilizing Tailwind CSS v4 and supporting dark mode.
- **Interactions**: Features spring-physics for motion and drag-to-dismiss functionality.
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a structure of a Header, a scrollable Body for content, and a Sticky Footer for actions.
- **Button Hierarchy**: Differentiates between primary, secondary, and destructive actions.
- **Accessibility**: Adheres to WCAG conventions including skip navigation, focus trapping, proper roles and attributes for interactive elements (e.g., `role="button"`, `role="combobox"`), form labels, and image alt text.

### Core Domain Features
- **Booking & Scheduling**: Implements a "Request & Hold" model, unified participant management, calendar synchronization, and an auto-complete scheduler. Booking conflicts are checked against all 6 active booking statuses. Trackman Booking Update webhooks handle creation, cancellation, AND modification — when staff move a booking to a different bay or adjust the time in Trackman, the app auto-updates the booking, session, fees, and invoice.
- **Fees & Billing**: Features a unified fee service, dynamic pricing, prepayment, and guest fees, based on a "one invoice per booking" architecture. Supports dual payment paths (Stripe PaymentIntent for online, draft Stripe invoice for auto-approvals) and handles existing payments. Invoice lifecycle transitions through Draft, Finalize, and Pay/Void. Fee recalculation is triggered by roster changes and cascades to later same-day bookings. Roster is locked after invoice payment — admin override with logged reason required for post-payment changes. Credit balances are properly restored on booking cancellation refunds.
- **Member Lifecycle**: Includes membership tiers, QR/NFC check-in, and onboarding processes. QR scan (`MEMBER:<uuid>`) auto-detects today's bookings — if found, routes to booking check-in (with Unified Booking Sheet for outstanding fees) instead of walk-in check-in. Confirmation modal shows booking details (bay, time, resource type) on success.
- **Error Handling**: Empty catch blocks are prohibited; all `catch` blocks must re-throw, log, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: All public endpoints creating database records are rate-limited. Authenticated users get 600 req/min, unauthenticated IP-based traffic gets 2000 req/min.
- **Scheduler Robustness**: Schedulers (auto-complete, expiry, integrity, auto-fix, cleanup, guest pass reset, refund reconciliation) use `isRunning` flags to prevent concurrent execution, catch-up windows, and claim slots to prevent double runs. They also include alerts for claim failures and handle graceful shutdowns.
- **Stripe Integration Specifics**: Includes Stripe webhook safety, payment handler logic (auto-refunds, error handling for retries), stable idempotency keys (format: `tier-upgrade-{subId}-{priceId}-{itemId}`), coupon application, and specific requirements for `trial_end` and $0 subscriptions. Daily refund reconciliation (`reconcileDailyRefunds()`) heals split-brain scenarios where Stripe refunds succeed but database isn't updated.
- **Data Integrity and Consistency**: Prevents double-charging, ensures orphaned invoice cleanup, uses optimistic locking for booking status transitions, and maintains atomicity for critical operations like billing group creation. NaN guards on all numeric route params. Cart item validation enforces non-negative finite `priceCents` and positive integer `quantity`. `usage_ledger.session_id` has an `ON DELETE CASCADE` FK to `booking_sessions.id`, preventing orphaned ledger entries. Tours sync exclusively from HubSpot Meetings (Google Calendar is only used for availability checks and creating calendar events for booked tours, not as a tour source).
- **Tier Hierarchy Validation**: Startup validates DB membership tier slugs against `TIER_NAMES` in `shared/constants/tiers.ts`, logging drift warnings. Actual tier logic is DB-driven via `getTierLimits()`.
- **Deferred Webhook Actions**: Post-commit webhook side-effects (notifications, HubSpot sync) log event context (`eventId`, `eventType`) for production debuggability.
- **WebSocket Robustness**: Includes periodic session revalidation, cryptographic verification of session cookies, reconnect jitter, and guards against duplicate socket registrations.
- **Supabase Hardening**: Frontend client sets `eventsPerSecond: 100` to prevent quota disconnects during batch updates. Realtime hook uses refs for optional callbacks to prevent re-subscription churn. Server anon client enforces `SUPABASE_ANON_KEY` presence (no empty-string fallback). ALL server-side Supabase network calls are wrapped with `Promise.race` / `withTimeout()` (10s) to prevent hangs on dropped connections — this includes `createSupabaseToken` (3 admin auth calls), all 6 Supabase auth route handlers in `server/supabase/auth.ts`, the `isSupabaseAuthenticated` middleware, the heartbeat scheduler, and `enableRealtimeForTable`. `server/supabase/auth.ts` delegates to the centralized singleton in `server/core/supabase/client.ts`. Only 3 `createClient()` calls exist: frontend singleton (`src/lib/supabase.ts`), server admin singleton, and server anon singleton (both in `server/core/supabase/client.ts`). Vite watcher ignores `.local/`, `.agents/`, `replit.nix`, and `.git/`.

## Web Performance & Security
- **Google Fonts**: Geologica (variable, 100–900) and Playfair Display (400,600,700) loaded non-render-blocking via `media="print" onload` pattern with `font-display: swap` fallback. Heritage luxury aesthetic: Playfair Display (Bold) for major headings, Geologica (Light/Regular) for all body text and UI elements.
- **Material Symbols**: Icon font lazy-loaded via JavaScript after first paint using `requestAnimationFrame`. Icons hidden via `visibility: hidden` until font loads, then revealed by adding `icons-loaded` class to `<html>`. Prevents FOUC (flash of unstyled icon text).
- **Splash Screen**: Walking golfer GIF with random tagline, 2-second minimum display. Brand requirement — do not remove.
- **Hero Image**: Preloaded in `index.html` with `fetchpriority="high"` and server-side `Link` header for production.
- **HubSpot**: Script deferred via `requestIdleCallback` (falls back to 3s `setTimeout`).
- **Security Headers**: HSTS with preload, CSP with `upgrade-insecure-requests`, COOP `same-origin-allow-popups` (required for Google GSI popup sign-in), X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. All headers sent in all environments.
- **robots.txt**: Static file (`public/robots.txt`) and server route (`server/index.ts`) kept in sync. Disallow rules listed before Allow.
- **Crawler Navigation**: Hidden navigation links rendered for search engine crawlers to improve site indexing and discoverability.

## Startup Sequence
- **Dev script** (`npm run dev`): Pre-flight cleanup (removes Vite cache, kills stale node processes), then uses `concurrently` to run backend (`tsx server/index.ts` on port 3001) and frontend (`vite` on port 5000) side-by-side. The old `dev:all` script with bash `&` operators has been removed.
- **Workflow**: The "Dev Server" workflow simply runs `npm run dev` and waits for port 5000.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Two-way data synchronization. The app DB is the primary source of truth for membership status, tier, role, and billing provider, with HubSpot providing profile fill-in data.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its purpose is to serve as a central digital hub for managing golf simulator bookings, wellness service appointments, and club events. The project aims to enhance member satisfaction and operational efficiency through comprehensive membership management, facility booking, and community-building tools.

## User Preferences
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## System Architecture

### Core Architecture
- **Naming Conventions**: `snake_case` for PostgreSQL tables/columns; `camelCase` for Drizzle schemas, API JSON payloads, and React/TypeScript frontend. Raw database rows must not be exposed in API responses.
- **Type Safety**: Strict TypeScript with zero errors, disallowing `as any` and similar constructs. All raw SQL results must be typed, and Stripe/HubSpot integrations use specific typed interfaces.
- **Database Interaction**: Drizzle ORM query builders or parameterized `sql` template literals are mandatory; raw string-interpolated SQL is forbidden.
- **Timezone**: All date/time operations must explicitly use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged.
- **API/Frontend Consistency**: API response field names must align exactly with frontend TypeScript interfaces.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints.
- **Real-time Updates**: WebSocket broadcasting for booking and invoice changes, powered by Supabase Realtime subscriptions. Staff Command Center uses React Query with WebSocket-driven cache invalidation.
- **Member Dashboard**: Features a chronological card layout for bookings, events, and wellness sessions with "Add to Calendar" functionality.

### UI/UX & Frontend
- **Design System**: Liquid Glass UI system using Tailwind CSS v4, supporting dark mode, with M3-compliant motion tokens and drag-to-dismiss functionality. Motion system uses Material Design 3 easing curves (`--m3-standard`, `--m3-standard-decel`, `--m3-standard-accel`, `--m3-emphasized-decel`, `--m3-emphasized-accel`) and a 10-step duration scale (`--duration-short-1` through `--duration-long-2`). Legacy spring tokens (`--spring-bounce`, `--spring-smooth`) preserved for brand flourishes. All animations use CSS custom property tokens — no raw `cubic-bezier` values in component code.
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a Header, scrollable Body, and Sticky Footer structure. Button hierarchy differentiates primary, secondary, and destructive actions.
- **Accessibility**: Adheres to WCAG conventions including skip navigation, focus trapping, proper roles/attributes, form labels, and image alt text. Specific color token usage for accessibility. `prefers-reduced-motion` preserves color/background transitions at 50ms while eliminating spatial motion. PullToRefresh and WalkingGolferLoader have local reduced-motion blocks for inline style coverage.
- **M3 Components**: Custom `SegmentedButton` (used on BookGolf, History, Wellness pages), `Chip`, `SearchBar` (with mobile full-viewport expansion), and `ErrorFallback` components supporting M3 design principles, light/dark mode, and touch targets. `TabButton` is only used on Events.tsx (10 category filters).
- **Extended FAB**: `FloatingActionButton` supports `extended` prop for icon+text pill shape that collapses to icon-only on scroll.
- **Bottom Sheet Variants**: `SlideUpDrawer` supports `variant="modal"` (default, with scrim/focus trap) and `variant="standard"` (no scrim, page remains interactive).
- **Navigation Rail**: Staff portal uses `StaffNavigationRail` at tablet breakpoint (md-lg), full sidebar at desktop (lg+), bottom nav on mobile.
- **Interaction Polish**: Enhanced visual feedback for interactive elements like `SwipeableListItem`, `SlideUpDrawer`, `Toggle`, and `ConfirmDialog`. M3 motion patterns: Tab Fade Through (90ms exit / 210ms enter with scale), SegmentedButton sliding indicator, FAB exit animation, dialog scale-in, drawer content entrance, and staggered list entry (45ms intervals for list items, 60ms for content).
- **Pull-to-Refresh**: `PullToRefresh` component wraps the app in `App.tsx`. Uses resistance factor 0.33 on touch, 0.3 wheel multiplier on desktop, 160px pull threshold, 5px deadzone, and 300ms desktop settle delay to prevent accidental triggers. On trigger, sets a `sessionStorage` flag and performs a hard reload; `InitialLoadingScreen` shows the branded `WalkingGolferLoader` for 2 seconds minimum during the reload. `prefers-reduced-motion` is respected.
- **Mobile Status Bar Blending**: `viewport-fit=cover` + `apple-mobile-web-app-status-bar-style: black-translucent` + `theme-color: #293515`. CSS uses `env(safe-area-inset-top)` for header padding. A `#safari-tint-top` div in `index.html` provides a background plug to prevent white flashes. Admin header, landing hero, and pull-to-refresh all extend behind the status bar using safe-area-aware padding/margins.
- **Mutation Patterns**: `useAppMutation` hook provides automatic success/error toasts, haptic feedback, optimistic updates with rollback, and query invalidation. Error messages are mapped to user-friendly strings. Profile edits, SMS preferences, and booking submissions use optimistic UI.
- **Form Persistence**: `useFormPersistence` hook persists form data to sessionStorage. `useUnsavedChanges` hook blocks navigation with `useBlocker` and shows `ConfirmDialog` when form has unsaved changes.
- **Prefetch System**: Route-level prefetch via `src/lib/prefetch.ts`, plus detail-level prefetch on hover/focus via `usePrefetchOnHover` hook for booking cards and directory rows.
- **Connection Health**: `OfflineBanner` monitors both network status and WebSocket health. Staff header shows green/amber/red connection dot. Cache invalidation on reconnection.
- **Error Boundaries**: Three-tier system (Global → Page → Feature) using standardized `ErrorFallback` component with Liquid Glass styling.
- **MemberSearchInput Portal**: `MemberSearchInput` renders its dropdown via `createPortal` to `document.body` with `position: fixed`, preventing clipping inside modals/drawers/cards. All member search UIs (AddMemberModal, RosterManager, ManualBookingModal) use this shared component.

### Core Domain Features
- **Booking & Scheduling**: "Request & Hold" model, unified participant management, calendar synchronization, and auto-complete scheduler. Handles booking conflicts and auto-updates from Trackman webhooks. Social members can book golf simulators and bring guests — they pay overage fees (entire duration treated as overage since their daily allowance is 0 minutes) and guest fees (no complimentary passes).
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, and guest fees based on a "one invoice per booking" architecture. Supports dual payment paths and handles existing payments. Roster changes trigger fee recalculation, and payment locks the roster.
- **Member Lifecycle**: Membership tiers, QR/NFC check-in, and onboarding processes. QR scans intelligently route to booking check-in or walk-in.
- **Walk-In Visit Tracking**: Walk-in visits recorded in `walk_in_visits` table via QR/NFC scan. Increments `lifetime_visits` on the user, syncs count to HubSpot, sends push notification, and broadcasts `walkin_checkin` + `member-stats-updated` WebSocket events. Dashboard shows unified lifetime visit count (bookings + wellness + events + walk-ins). Member history page displays walk-ins with a "Walk-in" badge and staff attribution.
- **Error Handling**: Prohibits empty catch blocks; all must re-throw, log, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: Public endpoints creating database records are rate-limited.
- **Scheduler Robustness**: Schedulers use `isRunning` flags, catch-up windows, and claim slots to prevent concurrent execution, with alerts for failures.
- **Stripe Integration Specifics**: Includes webhook safety, payment handler logic (auto-refunds with deterministic idempotency keys, invoice idempotency), coupon application, and specific requirements for `trial_end` and $0 subscriptions. Daily refund reconciliation mechanism. Transaction lock ordering: always `users` before `hubspot_deals` to prevent deadlocks. Group billing cascades preserve sub-member billing provider labels. Terminal payment refunds resolve `paymentIntentId` from `invoice.metadata.terminalPaymentIntentId` when `invoice.payment_intent` is absent. Financial operations (`createBalanceTransaction` for `add_funds`) must execute in the main webhook handler (not deferred) with idempotency keys — deferred actions are only for notifications/emails/broadcasts.
- **Data Integrity and Consistency**: Prevents double-charging, ensures orphaned invoice cleanup, uses optimistic locking for booking status transitions, and maintains atomicity for critical operations. Strict validation for numeric parameters and cart items. `usage_ledger` has `ON DELETE CASCADE` to `booking_sessions`. Deferred webhook actions capture finalized canonical variables, not raw payload variables. Guest pass hold-to-usage conversion uses `Math.min(passesHeld, guestPassesUsed)` and only marks `actualPassesDeducted` guests as paid. Delayed Trackman links never re-refund guest passes. Trackman `tryAutoApproveBooking` and `handleBookingModification` wrap multi-table updates in `db.transaction()` for crash-safe atomicity.
- **Tier Hierarchy Validation**: Startup validates DB membership tier slugs against `TIER_NAMES`.
- **Deferred Webhook Actions**: Post-commit webhook side-effects log event context for debuggability.
- **WebSocket Robustness**: Features periodic session revalidation, cryptographic verification, reconnect jitter, and guards against duplicate socket registrations.
- **Supabase Hardening**: Frontend client configures `eventsPerSecond`. Realtime hook uses refs for optional callbacks. Server-side Supabase network calls are wrapped with `Promise.race` / `withTimeout()` to prevent hangs. Limited and controlled `createClient()` calls.

### Web Performance & Security
- **Google Fonts**: Newsreader and Instrument Sans loaded non-render-blocking with `font-display: swap` for a luxury editorial aesthetic using specific CSS variable roles.
- **Typography Hierarchy**: Defined hierarchy for page titles, hero titles, section headers, and body text, with optical nudges.
- **Edge-to-Edge Hover Pattern**: Consistent styling for card wrappers and interactive rows.
- **Geometry Standards**: Standardized `rounded-xl` for cards/panels, `rounded-[4px]` for buttons/tags, header bar height, and vertical rhythm.
- **Sidebar Navigation**: Consistent font treatment, ALL CAPS, and active state styling for all navigation elements.
- **Material Symbols**: Icon font lazy-loaded via JavaScript with `requestAnimationFrame` to prevent FOUC.
- **Splash Screen**: Required walking golfer GIF with random tagline, 2-second minimum display.
- **Hero Image**: Preloaded in `index.html` with `fetchpriority="high"`.
- **HubSpot**: Script deferred via `requestIdleCallback`.
- **PWA & Service Worker**: Versioned cache (`ever-club-{version}`), Network-First for navigation/API, immutable for hashed assets. `sw.js`, `index.html`, and `manifest.webmanifest` served with `no-cache, no-store, must-revalidate`. Stale asset middleware returns a reload script for 404'd hashed `.js`/`.css` files. `useServiceWorkerUpdate` hook checks for updates every 10 minutes and on tab visibility change; `UpdateNotification` component prompts user to refresh with 30-minute dismissal cooldown.
- **Security Headers**: HSTS, CSP with `upgrade-insecure-requests`, COOP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- **robots.txt**: Static file and server route kept in sync with disallow rules.
- **Crawler Navigation**: Hidden navigation links for search engine indexing.

### POS Register Features
- **Quick Guest Checkout**: Staff can skip customer info entirely for walk-in sales. Activates via "Quick Guest" button, restricts payment to terminal-only, and shows a post-payment email capture dialog to optionally send a receipt and retroactively link the payment to a Stripe customer/visitor record. Email validation applied before sending receipts.
- **Dynamic Pass Products**: Pass products (Day Pass Coworking, Day Pass Golf Sim, Guest Fee) are loaded dynamically from the `membership_tiers` table by slug (`day-pass-coworking`, `day-pass-golf-sim`, `guest-pass`). On server startup, `ensure*Product()` functions in `server/core/stripe/products.ts` check the DB for each slug, create the record if missing, sync the canonical product name, and ensure a corresponding Stripe Product + Price exists. Product IDs and pricing resolve automatically per Stripe environment — no hardcoded Stripe IDs in the codebase. The `PRICING.GUEST_FEE_CENTS` in-memory rate is updated from the Stripe price at startup.
- **Backend Endpoints**: `POST /api/stripe/staff/quick-charge` accepts `guestCheckout: true` to create a bare PaymentIntent (no customer). `POST /api/stripe/staff/quick-charge/attach-email` retroactively links an email to a guest payment (creates/finds Stripe customer, updates PaymentIntent, creates visitor record, syncs HubSpot).

### Notification Source Attribution
- **Status Change Notifications**: When member status changes, staff notifications include the source of the change. The HubSpot sync route determines the source dynamically: "via MindBody" (if `billing_provider = 'mindbody'`), "via Stripe" (if `billing_provider = 'stripe'`), "via Quick Guest Checkout" (if `visitor_type = 'day_pass'`), "via App" (if `data_source = 'APP'`), or "via HubSpot sync" (fallback). Stripe webhook notifications are implicitly attributed by event type (e.g., "paused (frozen)", "resumed", "reactivated"). Staff admin actions are audit-logged with the performing staff member's email.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Two-way data synchronization for membership and profile data.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
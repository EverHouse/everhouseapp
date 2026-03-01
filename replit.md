# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to serve as a central digital hub for managing golf simulator bookings, wellness service appointments, and club events. The project aims to enhance member satisfaction and operational efficiency through comprehensive membership management, facility booking, and community-building tools.

## User Preferences
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## System Architecture

### Core Architecture
- **Naming Conventions**: `snake_case` for PostgreSQL tables/columns; `camelCase` for Drizzle schemas, API JSON payloads, and React/TypeScript frontend. Raw database rows must not be exposed in API responses.
- **Type Safety**: Strict TypeScript with zero errors, disallowing `as any` and similar constructs. All raw SQL results must be typed.
- **Database Interaction**: Drizzle ORM query builders or parameterized `sql` template literals are mandatory.
- **Timezone**: All date/time operations must explicitly use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged.
- **API/Frontend Consistency**: API response field names must align exactly with frontend TypeScript interfaces.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints.
- **Real-time Updates**: WebSocket broadcasting for booking and invoice changes, powered by Supabase Realtime subscriptions. Staff Command Center uses React Query with WebSocket-driven cache invalidation.
- **Member Dashboard**: Features a chronological card layout for bookings, events, and wellness sessions with "Add to Calendar" functionality.

### UI/UX & Frontend
- **Design System**: Liquid Glass UI system using Tailwind CSS v4, supporting dark mode, with M3-compliant motion tokens and drag-to-dismiss functionality. Animations use CSS custom property tokens.
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a Header, scrollable Body, and Sticky Footer structure. Button hierarchy differentiates primary, secondary, and destructive actions.
- **Accessibility**: Adheres to WCAG conventions including skip navigation, focus trapping, proper roles/attributes, form labels, and image alt text. `prefers-reduced-motion` is respected for animations.
- **M3 Components**: Custom `SegmentedButton`, `Chip`, `SearchBar`, `ErrorFallback`, `TabButton`, and `FloatingActionButton` components supporting M3 design principles, light/dark mode, and touch targets.
- **Bottom Sheet Variants**: `SlideUpDrawer` supports `variant="modal"` (default, with scrim/focus trap) and `variant="standard"` (no scrim, page remains interactive).
- **Navigation Rail**: Staff portal uses `StaffNavigationRail` at tablet breakpoint (md-lg), full sidebar at desktop (lg+), bottom nav on mobile.
- **Interaction Polish**: Enhanced visual feedback for interactive elements. M3 motion patterns are implemented for transitions and element interactions.
- **Pull-to-Refresh**: `PullToRefresh` component wraps the app, triggers a hard reload, and displays a branded `WalkingGolferLoader` for a minimum duration. `prefers-reduced-motion` is respected.
- **Mobile Status Bar Blending**: Uses `viewport-fit=cover`, `apple-mobile-web-app-status-bar-style: black-translucent`, and `theme-color` with `safe-area-inset-top` for header padding and background blending.
- **Mutation Patterns**: `useAppMutation` hook provides automatic success/error toasts, haptic feedback, optimistic updates with rollback, and query invalidation. Error messages are user-friendly.
- **Form Persistence**: `useFormPersistence` persists form data to sessionStorage. `useUnsavedChanges` uses `beforeunload` only (no popstate/history manipulation).
- **Auto-Animate Safety Rule**: `useAutoAnimate` refs must NEVER be attached to elements inside conditional blocks (`{condition && <div ref={ref}>}`). Refs must always stay mounted while the hook is alive — or remove `useAutoAnimate` entirely and rely on CSS `animate-list-item` / `animate-content-enter` classes. Remaining safe usages exist in standalone pages and sub-components that fully mount/unmount. Additionally, `useAutoAnimate` must NEVER be on elements with large unbounded lists — causes layout thrashing.
- **Large List Pattern**: Large lists need: server-side limit + client progressive rendering (20 at a time with "Show More" button) + memoized sort + O(1) lookup maps (Set/Map). Examples: Wellness page, History page visits/payments.
- **Prefetch System**: Route-level prefetch via `src/lib/prefetch.ts`, plus detail-level prefetch on hover/focus via `usePrefetchOnHover` hook.
- **Connection Health**: `OfflineBanner` monitors network and WebSocket health. Staff header shows connection status. Cache invalidation on reconnection.
- **Error Boundaries**: Three-tier system (Global → Page → Feature) using standardized `ErrorFallback` component.
- **MemberSearchInput Portal**: `MemberSearchInput` renders its dropdown via `createPortal` to `document.body` to prevent clipping.

### Core Domain Features
- **Booking & Scheduling**: "Request & Hold" model, unified participant management, calendar synchronization, auto-complete scheduler, and conflict resolution. Integrates with Trackman webhooks. Handles social member guest fees and overage fees.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, and guest fees based on a "one invoice per booking" architecture. Supports dual payment paths and existing payments. Roster changes trigger fee recalculation, and payment locks the roster.
- **Member Lifecycle**: Membership tiers, QR/NFC check-in, and onboarding processes. QR scans intelligently route to booking check-in or walk-in.
- **Walk-In Visit Tracking**: Walk-in visits are recorded via QR/NFC scan, incrementing `lifetime_visits`, syncing to HubSpot, sending push notifications, and broadcasting WebSocket events. Dashboard shows unified lifetime visit count.
- **Error Handling**: Prohibits empty catch blocks; all must re-throw, log, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes require authentication.
- **Rate Limiting**: Public endpoints creating database records are rate-limited.
- **Scheduler Robustness**: Schedulers use `isRunning` flags, catch-up windows, and claim slots to prevent concurrent execution, with alerts for failures.
- **Stripe Integration Specifics**: Includes webhook safety, payment handler logic (auto-refunds with deterministic idempotency keys), coupon application, and specific requirements for `trial_end` and $0 subscriptions. Daily refund reconciliation. Transaction lock ordering and group billing cascade. Terminal payment refunds resolve `paymentIntentId` from metadata. Financial operations must execute in the main webhook handler with idempotency keys.
- **Data Integrity and Consistency**: Prevents double-charging, ensures orphaned invoice cleanup, uses optimistic locking for booking status transitions, and maintains atomicity for critical operations. Strict validation for numeric parameters and cart items. `usage_ledger` has `ON DELETE CASCADE`. Deferred webhook actions capture finalized canonical variables. Guest pass hold-to-usage conversion logic. Trackman integrations (`tryAutoApproveBooking`, `handleBookingModification`) use `db.transaction()` for atomicity.
- **Tier Hierarchy Validation**: Startup validates DB membership tier slugs against `TIER_NAMES`.
- **Deferred Webhook Actions**: Post-commit webhook side-effects log event context for debuggability.
- **WebSocket Robustness**: Features periodic session revalidation, cryptographic verification, reconnect jitter, and guards against duplicate socket registrations.
- **Supabase Hardening**: Frontend client configures `eventsPerSecond`. Realtime hook uses refs. Server-side Supabase network calls are wrapped with `Promise.race` / `withTimeout()`. Limited and controlled `createClient()` calls.

### Web Performance & Security
- **Google Fonts**: Newsreader and Instrument Sans loaded non-render-blocking with `font-display: swap`.
- **Typography Hierarchy**: Defined hierarchy for page titles, hero titles, section headers, and body text.
- **Edge-to-Edge Hover Pattern**: Consistent styling for card wrappers and interactive rows.
- **Geometry Standards**: Standardized `rounded-xl` for cards/panels, `rounded-[4px]` for buttons/tags, header bar height, and vertical rhythm.
- **Sidebar Navigation**: Consistent font treatment, ALL CAPS, and active state styling.
- **Material Symbols**: Icon font lazy-loaded via JavaScript with `requestAnimationFrame`.
- **Splash Screen**: Required walking golfer GIF with random tagline, 2-second minimum display.
- **Hero Image**: Preloaded in `index.html` with `fetchpriority="high"`.
- **HubSpot**: Script deferred via `requestIdleCallback`.
- **PWA & Service Worker**: Versioned cache, Network-First for navigation/API, immutable for hashed assets. `sw.js`, `index.html`, and `manifest.webmanifest` served with `no-cache, no-store, must-revalidate`. Stale asset middleware returns a reload script. `useServiceWorkerUpdate` hook checks for updates; `UpdateNotification` component prompts user to refresh.
- **Security Headers**: HSTS, CSP with `upgrade-insecure-requests`, COOP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- **robots.txt**: Static file and server route kept in sync with disallow rules.
- **Crawler Navigation**: Hidden navigation links for search engine indexing.

### POS Register Features
- **Quick Guest Checkout**: Staff can skip customer info for walk-in sales. Restricts payment to terminal-only, and shows a post-payment email capture dialog. Email validation applied.
- **Dynamic Pass Products**: Pass products are loaded dynamically from `membership_tiers` table by slug. Server startup functions `ensure*Product()` check/create DB records, sync product names, and ensure corresponding Stripe Product + Price exists. Product IDs and pricing resolve automatically per Stripe environment.
- **Backend Endpoints**: `POST /api/stripe/staff/quick-charge` accepts `guestCheckout: true` to create a bare PaymentIntent. `POST /api/stripe/staff/quick-charge/attach-email` retroactively links an email to a guest payment.

### Notification Source Attribution
- **Status Change Notifications**: Staff notifications for member status changes include the source of the change (e.g., "via MindBody", "via Stripe", "via Quick Guest Checkout", "via App", "via HubSpot sync", or implicitly by Stripe event type). Staff admin actions are audit-logged with the performing staff member's email.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Two-way data synchronization for membership and profile data.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
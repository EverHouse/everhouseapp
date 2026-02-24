# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to manage golf simulator bookings, wellness service appointments, and club events, aiming to enhance member engagement and optimize operations. The project's vision is to become a central digital hub for private members clubs, offering comprehensive tools for membership, facility booking, and community building to improve member satisfaction and operational efficiency.

## User Preferences
- **Skill-Driven Development**: We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## Recent Changes (2026-02-24)

### Bug Fixes — Stripe Webhook Safety (8 fixes)
1. **Overnight closure validation** — `hasTimeOverlap()` in `bookingValidation.ts` now handles wrap-around closures (e.g., 22:00–06:00) by splitting into two ranges across midnight.
2. **Earlier-today booking cancellation** — `handleSubscriptionDeleted` no longer cancels bookings that already started today; only future/unstarted bookings are auto-cancelled on membership end.
3. **Webhook dedup table cleanup** — `cleanupOldProcessedEvents()` is now called probabilistically (5%) after each webhook to prevent unbounded `webhook_processed_events` growth.
4. **Out-of-order partial refund protection** — `handleChargeRefunded` uses `GREATEST(COALESCE(refund_amount_cents, 0), $2)` to prevent lower cumulative refund amounts from overwriting higher ones.
5. **Booking fee fallback row locking** — Added `FOR UPDATE` to the booking_participants fallback query in `handlePaymentIntentSucceeded` to prevent concurrent webhook retries from racing.
6. **Async day pass financial loss** — Fixed `handleCheckoutSessionAsyncPaymentSucceeded` which was calling `recordDayPassPurchaseFromWebhook(client, session)` with wrong arguments; now passes correct object payload and throws on failure so Stripe retries.
7. **Stale asset interceptor** — Fixed middleware in `server/index.ts` that sent HTML with `Content-Type: text/html` for missing JS assets; now sends valid JavaScript with `Content-Type: application/javascript` to prevent white screen of death.
8. **Late-arriving failed invoice guard** — `handleInvoicePaymentFailed` now checks if the invoice's subscription ID matches the user's current subscription before applying `past_due` status, preventing old subscription invoices from downgrading active members.

### Production-Readiness Audit Fixes (2026-02-24)
1. **Unauthenticated upload endpoint** — Added `isAuthenticated` middleware to `POST /api/uploads/request-url` to prevent anonymous file upload URL generation.
2. **Rate limiting on public endpoints** — Added `checkoutRateLimiter` to `POST /api/tours/book`, `POST /api/tours/schedule`, `POST /api/day-passes/confirm`, and strict rate limiting (10 req/15min) to `POST /api/client-error`.
3. **Connection pool leak** — Fixed `Promise.race` timeout pattern in `feeSnapshotReconciliationScheduler.ts` to release connections if timeout wins the race.
4. **Stripe customer idempotency** — Added deterministic idempotency key to `stripe.customers.create()` in `customers.ts`.
5. **Scheduler shutdown** — Modified 15 scheduler files to return interval IDs; `stopSchedulers()` now clears all timers on shutdown.
6. **Database indexes** — Added `booking_requests_status_idx` and `booking_requests_status_date_idx` indexes for query performance.
7. **Console.log cleanup** — Wrapped ~50 unguarded `console.log` calls in `useStaffWebSocket.ts` and `useWebSocketQuerySync.ts` with `import.meta.env.DEV` guards.
8. **Unbounded query safety** — Added LIMIT guards to `syncAllCustomerMetadata`, `GET /api/admin/inquiries`, and `GET /api/admin/bug-reports`.
9. **Alert cooldown pruning** — Added `pruneExpiredCooldowns()` to `dataAlerts.ts` to prevent unbounded Map growth.

### Previously Fixed (prior sessions)
- **SQL OR cross-linking** in activation_link checkout — replaced with id-first lookup + IS NULL guard.
- **Multi-day facility closures** — intermediate days now correctly treated as fully closed.
- **Stripe webhook security** — removed auto-reassignment in `handleCustomerUpdated`, added `stripe_customer_id` conflict check, case-insensitive email matching.

## System Architecture

### Core Architecture & Data Flow
- **Naming Conventions**: `snake_case` for PostgreSQL tables/columns; `camelCase` for Drizzle schemas, API JSON payloads, and React/TypeScript frontend. Raw database rows must not be exposed in API responses.
- **Type Safety**: Fix underlying schemas or DTOs to resolve TypeScript mismatches; avoid using `as any`.
- **Database Interaction**: Use Drizzle ORM query builders or parameterized `sql` template literals for all SQL queries; raw string-interpolated SQL is forbidden.
- **Timezone**: All date/time operations must explicitly use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged using `logFromRequest()`.
- **API/Frontend Consistency**: API response field names must align exactly with frontend TypeScript interfaces.

### UI/UX & Frontend
- **Design System**: Liquid Glass UI system, utilizing Tailwind CSS v4 and supporting dark mode.
- **Interactions**: Features spring-physics for motion and drag-to-dismiss functionality.
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a structure of a Header (title and close "X"), a scrollable Body for content, and a Sticky Footer for actions.
- **Button Hierarchy**: Differentiates between primary actions, secondary actions (as ghost links), and destructive actions. Buttons within scrollable bodies must have `type="button"`.
- **Fee Recalculation**: Roster changes trigger server-side fee recalculation, with visual feedback for loading states on the Financial Summary.

### Core Domain Features
- **Booking & Scheduling**: Implements a "Request & Hold" model, unified participant management, calendar synchronization, and an auto-complete scheduler that marks past bookings as `attended`.
- **Fees & Billing**: Features a unified fee service, dynamic pricing, prepayment capabilities, and guest fees, based on a "one invoice per booking" architecture. It supports dual payment paths: staff-approved bookings use a PaymentIntent for online payment, while Trackman auto-approvals create a draft Stripe invoice. The system `finalizeAndPayInvoice()` method intelligently handles existing payments to prevent double-charging. Both simulator and conference room bookings utilize a unified invoice-based flow, auto-applying Stripe customer credit balances. Roster edits are blocked post-payment unless a force-override with a reason is provided by staff. Invoice lifecycle transitions through Draft, Finalize, and Pay/Void states.
- **Database & Data Integrity**: Uses PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints on `wellness_enrollments.class_id` and `booking_participants.session_id`.
- **Member Lifecycle**: Includes membership tiers, QR/NFC check-in, and onboarding processes.

### Enforced Code Conventions
- **Error Handling**: Empty catch blocks are prohibited; all `catch` blocks must re-throw, log via `logger.debug`/`logger.warn`, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes (POST/PUT/PATCH/DELETE) must be protected by authentication.
- **Stripe Webhook Safety**: Webhook handlers modifying member status must include a `billing_provider` guard to prevent data overwrites from other systems.
- **Stripe Subscription ID Matching**: Invoice payment failure handlers must verify the invoice's `subscription_id` matches the user's current `stripe_subscription_id` before applying status downgrades, preventing stale invoices from affecting members on new subscriptions.
- **Async Webhook Payload Parity**: All async payment handlers (`checkout.session.async_payment_succeeded`) must construct identical payloads to their synchronous counterparts and throw errors on failure (not swallow them) to ensure Stripe retries.
- **Booking Race Condition Guards**: `approveBooking()`, `declineBooking()`, and `checkinBooking()` implement status guards and optimistic locking to prevent race conditions and ensure data integrity.
- **Rate Limiting**: All public endpoints creating database records must have rate limiting middleware.
- **Unbounded Queries**: All SELECT queries must have a LIMIT clause or be naturally bounded.
- **Scheduler Lifecycle**: All `setInterval()` in schedulers must return their timer ID for shutdown cleanup.
- **Real-time Updates**: Implements WebSocket broadcasting for booking and invoice changes, ensuring staff and members receive real-time updates.
- **Route Authentication Audit (Feb 2026)**: Two authentication patterns coexist: middleware guards (`isAuthenticated`, `isStaffOrAdmin`) and inline `getSessionUser(req)` checks. Both provide equivalent authentication (identity check). Inline checks are acceptable only for member-facing routes; staff/admin routes must use middleware guards (`isStaffOrAdmin`, `isAdmin`) for role-based authorization. Middleware is preferred for new routes. Intentionally public routes include auth endpoints, webhook endpoints (signature-verified), tour booking, day pass confirm, and availability checks.

## External Dependencies
- **Stripe**: For payment processing, subscriptions, and webhooks.
- **HubSpot**: Used for two-way data synchronization and form submissions.
- **Communications**: Handles in-app notifications, push notifications, and email via Resend.
- **Other**: Integrations include Trackman (for booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (for ID scanning).
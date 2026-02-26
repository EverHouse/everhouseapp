# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application designed for golf and wellness centers. Its core purpose is to streamline the management of golf simulator bookings, wellness service appointments, and club events. The project aims to create a central digital hub for private members clubs, providing comprehensive tools for membership management, facility booking, and community building, ultimately enhancing member satisfaction and operational efficiency.

## User Preferences
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

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
- **Button Hierarchy**: Differentiates between primary actions, secondary actions (as ghost links), and destructive actions.
- **Fee Recalculation**: Roster changes trigger server-side fee recalculation, with visual feedback for loading states on the Financial Summary.

### Core Domain Features
- **Booking & Scheduling**: Implements a "Request & Hold" model, unified participant management, calendar synchronization, and an auto-complete scheduler.
- **Fees & Billing**: Features a unified fee service, dynamic pricing, prepayment, and guest fees, based on a "one invoice per booking" architecture. It supports dual payment paths (PaymentIntent for online, draft Stripe invoice for auto-approvals). The system handles existing payments to prevent double-charging and utilizes Stripe customer credit balances. Roster edits are blocked post-payment without staff override. Invoice lifecycle transitions through Draft, Finalize, and Pay/Void.
- **Database & Data Integrity**: Uses PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints. The primary connection uses Replit's helium proxy via `DATABASE_URL` (auto-managed by Replit). `DATABASE_POOLER_URL` (Supabase session pooler, port 6543) exists but is disabled (`ENABLE_PGBOUNCER=false`) because it connects to a different Supabase project with an incomplete schema. Supabase direct connection (`db.*.supabase.co`) is IPv6-only and unreachable from Replit's IPv4 network. The session store (`connect-pg-simple`) and WebSocket pool both use the shared `pool` from `server/core/db.ts`.
- **Member Lifecycle**: Includes membership tiers, QR/NFC check-in, and onboarding processes.
- **Real-time Updates**: Implements WebSocket broadcasting for booking and invoice changes. Supabase Realtime subscriptions cover `notifications`, `booking_sessions`, `announcements`, and `trackman_unmatched_bookings` tables.

### Enforced Code Conventions
- **Error Handling**: Empty catch blocks are prohibited; all `catch` blocks must re-throw, log, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes must be protected by authentication.
- **Stripe Webhook Safety**: Webhook handlers modifying member status must include a `billing_provider` guard. Async payment handlers must construct identical payloads to synchronous counterparts and throw errors on failure for Stripe retries. Payment handlers must auto-refund overpayments when participants are already paid.
- **Fee Calculation Transaction Isolation**: `recalculateSessionFees()` and `computeFeeBreakdown()` use the global `db` pool. They MUST NEVER be called inside `db.transaction()`. Always commit the transaction first, then calculate fees.
- **Individual Refund Status Updates**: When refunding multiple participants, update each participant's `payment_status` to `'refunded'` only AFTER its individual Stripe refund succeeds.
- **Fee Cascade Recalculation**: `recalculateSessionFees()` automatically cascades to later same-day bookings for the same member.
- **Account Credit Audit Trails**: When account credit covers a full fee, `logPaymentAudit()` must be called with `paymentMethod: 'account_credit'`.
- **Booking Race Condition Guards**: `approveBooking()`, `declineBooking()`, and `checkinBooking()` implement status guards and optimistic locking. All status-transition UPDATEs must include `WHERE status IN (...)` matching expected source statuses, and check `rowCount` after UPDATE.
- **Rate Limiting**: All public endpoints creating database records must have rate limiting.
- **Unbounded Queries**: All SELECT queries must have a LIMIT clause or be naturally bounded.
- **Scheduler Lifecycle**: All `setInterval()` and `setTimeout()` in schedulers must store their timer IDs for shutdown cleanup.
- **WebSocket Session Revalidation**: WebSocket connections are periodically re-verified against the database (every 5 minutes). Expired or revoked sessions are terminated automatically.
- **Cookie Signature Verification**: WebSocket `parseSessionId()` uses `cookie-signature.unsign()` to cryptographically verify session cookies.
- **Lock Ordering (Group Billing)**: In all group billing transactions, always lock `billing_groups` FOR UPDATE before `group_members`.
- **Stripe Rollback on Failure**: Both `addCorporateMember` and `removeCorporateMember` track `newStripeItemId` and roll back newly created subscription items if subsequent Stripe operations fail.
- **Booking Expiry Grace Period**: The booking expiry scheduler waits 20 minutes past `start_time` before auto-expiring pending/pending_approval bookings. Trackman-linked bookings are routed to `cancellation_pending`.
- **Group Member Removal Status Revocation**: When removing a member from a billing group, always set `membership_status = 'cancelled'`, `last_tier = tier`, `tier = NULL` on the user record.
- **Group Add Rollback Status Reset**: When Stripe fails during `addGroupMember`/`addCorporateMember`, the compensating DB update must reset `membership_status = 'pending'` and `tier = NULL`.
- **WebSocket Staff Presence Accuracy**: On `ws.on('close')`, if no remaining staff connections for a user, remove from `staffEmails`.
- **WebSocket Pool Size**: Session verification pool uses `max: 20` connections.
- **WebSocket Token-Based Auth Fallback**: The `{ type: 'auth', sessionId: '...' }` message accepts a `sessionId` field for mobile/React Native clients.
- **Frontend Async Race Protection**: All async fetches in `useEffect` hooks must use `AbortController` + `isCurrent` flags or `fetchIdRef` counters.
- **WebSocket Reconnect Jitter**: Frontend WebSocket reconnection uses random delay to prevent thundering herd.
- **WebSocket Duplicate Socket Guard**: Prevent the same WebSocket object from being registered multiple times.
- **Billing Group Creation Atomicity**: `createBillingGroup` and `createCorporateBillingGroupFromSubscription` wrap INSERT and UPDATE in a single `db.transaction()`.
- **Visitor Search Race Protection**: The visitor search `useEffect` uses an `isActive` flag pattern.
- **Scheduler Graceful Shutdown Completeness**: Every scheduler that uses `setTimeout` chains must store the current timeout ID and export a `stopXxxScheduler()` function.
- **WebSocket Mobile Staff Registration**: The `staff_register` handler falls back to a direct DB lookup to verify staff status for mobile clients.
- **Booking Expiry WebSocket Broadcast**: After expiring or setting bookings to `cancellation_pending`, the scheduler must call `broadcastAvailabilityUpdate()`.
- **Conflict Check Status Completeness**: `checkBookingConflict()` must check all 6 active booking statuses.
- **Closure Cache Pruning**: The `closureCache` Map in `bookingValidation.ts` has a 10-minute pruning interval.
- **Auto-Complete Session Backfill**: The `bookingAutoCompleteScheduler` now calls `ensureSessionForBooking()` for each booking it marks as `attended` that has no `session_id`.
- **Billing Provider Auto-Classification**: The periodic auto-fix (`autoFixMissingTiers()`) classifies Stripe billing providers in addition to MindBody.
- **No 'hubspot' Billing Provider**: The `billing_provider` CHECK constraint does not allow `'hubspot'`. Staff-created members via HubSpot now get `billing_provider='stripe'`.
- **Default billing_provider Is 'stripe'**: The column default for `billing_provider` is `'stripe'`.
- **App DB Is Primary Brain for HubSpot Sync**: The app database is the single source of truth for `membership_status`, `tier`, `role`, and `billing_provider`. HubSpot → App sync only provides profile fill-in data.
- **MindBody → Stripe Migration Flow**: Staff initiates migration via the directory profile drawer. System sets `migration_status = 'pending'`, processes MindBody status, then creates Stripe subscription.
- **Auto-Complete Fee Guard**: The booking auto-complete scheduler only marks bookings as `attended` if no session yet, or all participants are paid/waived/zero-fee. It also alerts staff about bookings stuck with unpaid fees for 2+ days.
- **Session Creation Failure Detection**: `ensureSessionForBooking()` return values are checked for `error` or `sessionId === 0` in both auto-complete and manual flows, incrementing `sessionErrors` count.
- **Scheduler In-Flight Guards**: All schedulers (auto-complete, expiry, integrity, auto-fix, cleanup, guest pass reset) use `isRunning` flags to prevent concurrent execution of the same task.
- **Scheduler Catch-Up Windows**: Integrity check runs midnight–6am (was midnight only). Guest pass reset runs 3am–8am on 1st (was 3am only). Both use DB-level claim slots to prevent double runs.
- **Scheduler Claim Failure Alerts**: `tryClaimIntegritySlot` and `tryClaimResetSlot` DB errors now trigger `alertOnScheduledTaskFailure()` to notify staff.
- **Overnight Session Expiry**: Booking expiry scheduler handles overnight sessions (end_time < start_time) correctly, using end_time from the next day instead of start_time only.
- **Double-Charge Prevention**: `create-payment-intent` checks for existing succeeded payments for the booking before creating a new one. Snapshot lookup no longer limited to 30-min window.
- **Orphaned Invoice Prevention**: `createDraftInvoiceForBooking` cleans up Stripe invoices if line item addition or DB linkage fails, preventing orphaned invoices in Stripe.
- **Route Authentication Audit**: Both middleware guards and inline `getSessionUser(req)` checks are used.
- **Staff Conference Room Booking — No Slot Check**: The `StaffManualBookingModal` does NOT fetch available slots from the server.
- **Admin Calendar Grid Hours**: The calendar grid starts at 8:30 AM and extends to 10:00 PM.
- **No Name-Only Member Matching**: MindBody sales import must NEVER fall back to name-only matching for financial linking.
- **Immediate Cancellation Means Now**: For subscription cancellation, `cancel_at` must be `Date.now()`.
- **Stripe Coupon API — Use discounts Array**: When applying coupons, use `discounts: [{ coupon: couponId }]`.
- **Stripe Idempotency Keys — Include Timestamp**: Idempotency keys for Stripe subscription creation must include `Date.now()`.
- **Free Activation Flow ($0 Subscriptions)**: When `createSubscription` returns `amountDue: 0`, the server sets `freeActivation: true`, marks the $0 invoice as paid, activates the member, and returns `clientSecret: null`.
- **PostgreSQL Result Row Count**: Use `.rowCount` for affected rows by an UPDATE/INSERT/DELETE.
- **Migration Concurrency Guard**: `processPendingMigrations()` must set `migration_status = 'processing'` before calling `executePendingMigration()`.
- **Stripe trial_end 48-Hour Minimum**: Stripe requires `trial_end` to be at least 48 hours in the future.
- **ISO Dates for SQL**: Always use `.toISOString()` for date values passed to Postgres.
- **Sharp limitInputPixels**: All `sharp()` calls must pass `{ limitInputPixels: 268402689 }`.
- **Auth Rate Limiting — Dual Limiters**: `authRateLimiter` is an array of two middleware: `authRateLimiterByIp` and `authRateLimiterByEmail`.
- **AbortController for Polling Fetches**: Any `useCallback` fetch that can be triggered by events or polling must use `AbortController`.
- **Global Rate Limiter — Tiered Limits**: Authenticated users get 600 req/min, unauthenticated IP-based traffic gets 2000 req/min.
- **Closure Calendar Sync — Patch, Don't Delete+Create**: When editing a closure, try to PATCH the existing Google Calendar event.
- **Closure Sync — Duplicate Prevention**: Before creating a new closure, check for existing active closures.

### Accessibility (WCAG) Conventions
- **Skip Navigation**: `src/App.tsx` includes a "Skip to main content" link.
- **Focus Trapping**: `SlideUpDrawer` and `ConfirmDialog` trap Tab/Shift+Tab within their bounds.
- **Clickable Non-Button Elements**: Any `div`, `span`, `tr`, or `li` with an `onClick` must also have `role="button"`, `tabIndex={0}`, and an `onKeyDown` handler.
- **Combobox Pattern (MemberSearchInput)**: Uses `role="combobox"` on input, `role="listbox"` on dropdown, `role="option"` on items, with `aria-expanded`, `aria-controls`, `aria-activedescendant`, and an `aria-live="polite"` region.
- **Dropdown/Menu Pattern (BookingStatusDropdown)**: Uses `aria-haspopup="listbox"`, `aria-expanded`, `role="listbox"`, `role="option"`, with arrow key navigation, Enter to select, Escape to close.
- **Tab Pattern (TabButton)**: Always include `role="tab"` and `aria-selected` on TabButton. Parent containers must have `role="tablist"`.
- **Form Labels**: Every `<input>`, `<select>`, and `<textarea>` must have either a `<label>` element or an `aria-label` attribute.
- **Image Alt Text**: All `<img>` tags must have an `alt` attribute.
- **Backdrop Overlays**: Modal/drawer backdrop divs must include `aria-hidden="true"`.
- **Toast Roles**: Error toasts use `role="alert"` with `aria-live="assertive"`. Non-error toasts use `role="status"` with `aria-live="polite"`.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Two-way data synchronization and form submissions.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
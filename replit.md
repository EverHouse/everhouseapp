# Ever House Members App

## Overview
The Ever House Members App is a private members club application for golf and wellness centers. Its purpose is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to improve member engagement and streamline operational workflows, providing a cohesive digital experience for members and staff. The project's vision is to become a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building, thereby boosting member satisfaction and operational efficiency.

## User Preferences
- **CRITICAL: Communication Style** - The founder is non-technical. Always explain changes in plain English, focusing on how they affect the member/staff experience or business operations. Avoid jargon like "ORM," "WebSocket," "orchestration," "middleware," etc. If a technical term is necessary, explain it simply first (e.g., "the notification system" instead of "WebSocket server").
- **CRITICAL: Pacific Timezone (America/Los_Angeles) is THE FIRST PRIORITY for any date/time operations.** All time comparisons must use Pacific time utilities, never local server time.
- **CRITICAL: Changelog Updates** - Update `src/data/changelog.ts` after EVERY significant change, not just when asked. Each feature or fix should be documented immediately. Bump version numbers appropriately (patch for fixes, minor for features, major for breaking/significant changes). Mark major releases with `isMajor: true`.
- **CRITICAL: Staff Activity Logging** - ALL staff actions must be logged to the audit system using `logFromRequest()` from `server/core/auditLog.ts`. When adding new staff features, always add audit logging with appropriate action type, resource type, resource ID/name, and relevant details. Add new action types to `AuditAction` type if needed. This ensures all staff activity appears in the Staff Activity feed on the Changelog page.
- **HIGH PRIORITY: API/Frontend Field Name Consistency** - When creating or modifying API endpoints, ALWAYS ensure the response field names EXACTLY match the frontend TypeScript interface expectations. Before returning `res.json({...})`, verify field names against the corresponding frontend interface. Common mismatches to avoid: `visits` vs `visitHistory`, `bookings` vs `bookingHistory`, `eventRsvps` vs `eventRsvpHistory`, `wellness` vs `wellnessHistory`, `guestPass` vs `guestPassInfo`, `guestCheckIns` vs `guestCheckInsHistory`, `estimatedOverageFee` vs `overageFee`, `dailyAllowance` vs `includedDailyMinutes`, `estimatedTotalFees` vs `totalFees`. When in doubt, search for the frontend interface definition and match it exactly.
- I prefer simple language.
- I like functional programming.
- I want iterative development.
- Ask before making major changes.
- I prefer detailed explanations.
- Do not make changes to the folder `Z`.
- Do not make changes to the file `Y`.

## System Architecture
The application uses a React 19 frontend with Vite, styled with Tailwind CSS, and an Express.js backend with a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism) with an EH monogram logo, WCAG AA contrast compliance, and `aria-label` attributes for accessibility.
- **Typography**: Playfair Display for headlines and Inter for body/UI.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav.
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Supports Light, Dark, and System themes, persisted locally.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling, and entry/exit animations.
- **Drawer UX**: MemberProfileDrawer hides bottom navigation and floating action button on mobile.

### Backend Route Organization (v9.25.0+)
The backend routes are organized into modular directories for maintainability:
- **server/routes/stripe/** - Payment processing (config, payments, subscriptions, invoices, coupons, overage, member-payments, admin)
- **server/routes/members/** - Member management (search, profile, admin-actions, communications, notes, visitors)
- **server/routes/bays/** - Booking system (resources, bookings, approval, calendar, notifications)
- **server/routes/trackman/** - Trackman integration (webhook handling, validation, billing, imports, admin, reconciliation)

### Backend Startup Architecture (v9.26.0+)
Server startup is organized into loader modules for clean separation of concerns:
- **server/loaders/routes.ts** - Registers all API routes in a single function
- **server/loaders/startup.ts** - Contains heavy startup tasks (DB constraints, Stripe sync, Supabase realtime)
- **Readiness Probe**: `/api/ready` returns 503 until startup tasks complete, then 200
- **Health Check**: `/healthz` always returns 200 immediately (for liveness probes)
- **Graceful Shutdown**: SIGTERM/SIGINT handlers properly close server and database connections

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Timezone Handling**: All date/time operations prioritize the 'America/Los_Angeles' timezone.
- **Member Management**: Supports member tiers, tags, a comprehensive directory, and unified billing groups (family and corporate) with primary payer and add-on members.
- **Booking System**: Features "Request & Hold," conflict detection, staff/member initiated bookings, multi-member bookings, and calendar management. Includes guardian consent for minors and uses database transactions with row-level locking for concurrency control. Database trigger (`prevent_booking_session_overlap`) prevents double-bookings on INSERT/UPDATE operations.
- **Check-In Notifications (v9.29.5)**: Members receive in-app + WebSocket notifications when checked in ("Check-In Complete") or marked as no-show ("Missed Booking"). Refund notifications sent when booking payments are refunded.
- **Trackman Data Sync Architecture**: Unified 1:1 sync for CSV imports and webhook integration using `trackman_booking_id`. Origin tracking for bookings (member_request, staff_manual, trackman_webhook, trackman_import) with sync metadata. UPSERT logic prevents duplication and enriches data during CSV imports. Unmatched bookings use a placeholder email and queue for staff resolution.
- **Trackman Webhook Integration**: Real-time booking synchronization with delta billing, idempotency checks, and handling for cross-midnight durations. Supports both V1 and V2 webhook formats. Features time matching, bay conflict detection, and cancelled request handling. Staff receive real-time toast notifications via WebSocket.
- **Linked Email Addresses**: Supports alternate email addresses for members and auto-learns associations during Trackman imports.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a sequential notice dismissal system with 3-channel delivery.
- **Real-Time Sync**: Instant updates via WebSocket, with Supabase Realtime as a parallel channel.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Performance Optimizations**: List virtualization (`react-window`), skeleton loaders, optimized CSS, lazy-loaded admin tabs, optimistic updates, and memoized context functions (useCallback/useMemo in DataContext).
- **Admin Tools**: Admin-configurable features, data integrity dashboard, and data migration tools.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA features, account deletion, and member data export. Admin audit log tracks staff access to member data.
- **Waiver Management**: Tracks waiver versions and requires signing on login.
- **Unified Fee Service (v9.27.0+)**: Single authoritative source for all fee calculations (`server/core/billing/unifiedFeeService.ts`). All fee previews, approvals, check-in, and payment flows use `computeFeeBreakdown()`. Always uses `effectivePlayerCount = MAX(declared, actual)` for time allocation. Roster changes trigger `invalidateCachedFees()` to ensure fresh calculations. Staff assignment of Trackman bookings (assign-with-players, link-trackman-to-member) triggers `recalculateSessionFees()` if a session exists.
- **Webhook Safety**: Stripe webhooks process exactly once via transactional dedup (claim event → process → commit). Deferred action pattern for external calls (emails/notifications execute only after commit). Resource-based ordering guards prevent out-of-order event processing.
- **Roster Protection**: Optimistic locking with `roster_version` column. Row-level locking (`FOR UPDATE`) prevents concurrent modifications. Returns 409 `ROSTER_CONFLICT` on version mismatch with current version for retry.
- **Billing Management**: Staff Payments Dashboard for POS, unified payment history, member billing management, self-service portal, tier change wizard with proration, dunning for failed payments, and refund processing.
- **Payment Recovery (Dunning)**: Tracks failed payments, retries, and notifies members.
- **Grace Period System**: 3-day grace period for billing failures. **Note:** Automatic reminder emails are currently disabled pending billing system finalization - staff must manually send payment links via member directory. Membership terminates after 3 days if not resolved.
- **Day Pass System**: Non-members can purchase day passes with visitor matching, HubSpot sync, and QR code delivery.
- **QR Code System**: QR codes for day passes and digital access cards for members, with staff scanning functionality.
- **Corporate Membership**: Supports unified billing groups, volume pricing, corporate checkout, HubSpot company sync, and individual tracking.
- **Data Integrity Architecture**: Stripe as the source of truth for billing, transaction rollback, fail-fast on Stripe errors, webhook idempotency, and automatic status sync. Dual-source active tracking using HubSpot and Stripe.
- **Stripe Member Auto-Fix**: Login flow automatically verifies Stripe subscription status and corrects `membership_status` if database is out of sync. If a member has a Stripe subscription but incorrect status (e.g., 'non-member'), the system checks Stripe directly and auto-corrects the database. This prevents login failures due to stale data from imports or missed webhooks.
- **Stripe Subscription → HubSpot Sync**: When a Stripe subscription is created (via webhook), the system automatically: (1) Sets `membership_status` to 'active' in database, (2) Updates member tier based on price ID, (3) Syncs membership status and tier to HubSpot contact. This works for both new users and existing users.
- **Member Balance Stripe Validation**: The member balance display only shows fees that have a valid 'pending' fee snapshot in the database. Fees from sessions with cancelled/paid/failed Stripe payment intents are filtered out, ensuring orphaned database records don't inflate member balances. This enforces Stripe as the source of truth for billing.
- **Stripe Customer Metadata Sync**: Customer metadata (userId, tier) is synced to Stripe automatically and via a bulk sync endpoint.
- **Stripe Transaction Cache**: Transactions are cached locally in `stripe_transaction_cache` for fast querying.
- **Scheduled Maintenance**: Daily scheduled tasks for session cleanup, webhook log cleanup, Stripe reconciliation, and grace period checks.

## External Dependencies
- **Stripe Payments**: For in-app payment collection, subscription management, and webhook processing.
- **Resend**: For email-based OTP verification and automated alerts.
- **HubSpot CRM**: For contact and member management, two-way data sync, and communication preferences.
- **HubSpot Forms**: For application form submissions.
- **Eventbrite**: For syncing members-only events.
- **Google Calendar**: For integration with various club calendars.
- **Apple Messages for Business**: For direct messaging.
- **Amarie Aesthetics MedSpa**: For direct booking links.
- **Supabase**: For backend admin client, Realtime subscriptions, and session token generation.
# Ever House Members App

## Overview
The Ever House Members App is a private members club application for golf and wellness centers. Its primary purpose is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to improve member engagement and streamline operational workflows, providing a cohesive digital experience. The project envisions becoming a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building, thereby boosting member satisfaction and operational efficiency.

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
The application utilizes a React 19 frontend with Vite, styled using Tailwind CSS, and an Express.js backend with a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism) with an EH monogram logo, WCAG AA contrast compliance, and `aria-label` attributes for accessibility.
- **Typography**: Playfair Display for headlines and Inter for body/UI.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav.
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Supports Light, Dark, and System themes, persisted locally.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling, and entry/exit animations.
- **Drawer UX**: MemberProfileDrawer hides bottom navigation and floating action button on mobile.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Timezone Handling**: All date/time operations prioritize the 'America/Los_Angeles' timezone.
- **Backend Structure**: Modular API routes, loader modules for startup tasks, readiness/health checks, and graceful shutdown.
- **Member Management**: Supports member tiers, tags, directory, and unified billing groups with primary payers.
- **Booking System**: Features "Request & Hold," conflict detection, staff/member initiated bookings, multi-member bookings, calendar management, and uses database transactions with row-level locking and a trigger to prevent double-bookings.
- **Check-In Notifications**: In-app and WebSocket notifications for check-in status and refunds.
- **Trackman Integration**: Unified 1:1 sync for CSV imports and webhooks with origin tracking, UPSERT logic, and placeholder handling. Webhook integration supports real-time booking synchronization, delta billing, idempotency, and cross-midnight durations.
- **Linked Email Addresses**: Supports alternate email addresses and auto-learns associations during Trackman imports.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware. Staff roles: `admin`, `staff`, `golf_instructor`. Golf instructors get special handling in Trackman imports (their bookings are converted to availability blocks instead of member bookings).
- **Notifications**: In-app real-time notifications and a sequential notice dismissal system with 3-channel delivery.
- **Real-Time Sync**: Instant updates via WebSocket, with Supabase Realtime as a parallel channel.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Performance Optimizations**: List virtualization, skeleton loaders, optimized CSS, lazy-loaded admin tabs, optimistic updates, and memoized context functions.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, and data migration tools.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA features, account deletion, data export, and admin audit log for staff access to member data.
- **Waiver Management**: Tracks waiver versions and requires signing on login.
- **Unified Fee Service**: Single authoritative source for all fee calculations, using `computeFeeBreakdown()` and `effectivePlayerCount = MAX(declared, actual)`. Roster changes invalidate cached fees.
- **Webhook Safety**: Stripe webhooks process once via transactional dedup. Deferred action pattern for external calls and resource-based ordering guards.
- **Roster Protection**: Optimistic locking with `roster_version` and row-level locking.
- **Billing Management**: Staff Payments Dashboard, unified payment history, member billing management, self-service portal, tier change wizard with proration, dunning for failed payments, and refund processing.
- **Payment Recovery (Dunning)**: Tracks failed payments, retries, and notifies members.
- **Grace Period System**: 3-day grace period for billing failures, with manual staff intervention for payment links.
- **Day Pass System**: Non-members can purchase day passes with visitor matching, HubSpot sync, and QR code delivery.
- **QR Code System**: QR codes for day passes and digital access cards for members, with staff scanning functionality.
- **Corporate Membership**: Supports unified billing groups, volume pricing, corporate checkout, HubSpot company sync, and individual tracking.
- **Data Integrity Architecture**: Stripe as the source of truth for billing, transaction rollback, webhook idempotency, and automatic status sync. Dual-source active tracking using HubSpot and Stripe.
- **Stripe Member Auto-Fix**: Login flow automatically verifies Stripe subscription status and corrects `membership_status` if the database is out of sync.
- **Stripe Subscription → HubSpot Sync**: Automated sync of `membership_status` and tier to HubSpot contact upon Stripe subscription creation.
- **Member Balance Display**: Balance shows all fees where `payment_status = 'pending'` and `cached_fee_cents > 0`. Booking cancellations automatically clear fees.
- **Stripe Customer Metadata Sync**: Customer metadata (userId, tier) is synced to Stripe.
- **Stripe Transaction Cache**: Transactions are cached locally in `stripe_transaction_cache`.
- **Scheduled Maintenance**: Daily tasks for session cleanup, webhook log cleanup, Stripe reconciliation, and grace period checks.

## External Dependencies
- **Stripe Payments**: For in-app payment collection, subscription management, and webhook processing.
- **Resend**: For email-based OTP verification and automated alerts.
- **HubSpot CRM**: For contact and member management, two-way data sync, and communication preferences. Enhanced bidirectional sync includes: Stripe delinquent status tracking, granular SMS preferences (promotional, transactional, reminders), and linked emails extraction from merged HubSpot contacts (stored in `user_linked_emails` with source `hubspot_merge`).
- **HubSpot Forms**: For application form submissions.
- **Eventbrite**: For syncing members-only events.
- **Google Calendar**: For integration with various club calendars.
- **Apple Messages for Business**: For direct messaging.
- **Amarie Aesthetics MedSpa**: For direct booking links.
- **Supabase**: For backend admin client, Realtime subscriptions, and session token generation.
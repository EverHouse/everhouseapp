# Ever House Members App

## Overview
The Ever House Members App is a private members club application designed for golf and wellness centers. It facilitates golf simulator bookings, wellness service appointments, and club event management. The application aims to enhance member engagement, streamline operational workflows, and provide a unified digital experience. The project aspires to become a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building to boost member satisfaction and operational efficiency.

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
The application uses a React 19 frontend with Vite and Tailwind CSS, connected to an Express.js backend with a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism) with WCAG AA compliance and `aria-label` attributes.
- **Typography**: Playfair Display for headlines and Inter for body text.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav; Admin uses route-based navigation with React Router. Sidebar sections: Main Nav (Dashboard, Bookings, Financials, Tours, Calendar, Facility, Updates, Directory, Training Guide), Admin (Products & Pricing, Manage Team, Gallery, FAQs, Inquiries, Bug Reports, Changelog, Data Integrity). Cafe Menu management is a sub-tab within Products & Pricing.
- **Responsive Design**: Optimized for mobile, tablet, and desktop, with responsive table patterns.
- **Theme System**: Supports Light, Dark, and System themes, persisted locally.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax, and entry/exit animations.
- **Drawer UX**: SlideUpDrawer for modals with drag-to-dismiss.
- **Staff FAB**: Floating action button for quick staff actions (New User, Announcement, Booking, QR Scanner).
- **ConfirmDialog**: Custom Liquid Glass styled confirmation dialogs.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Timezone Handling**: All date/time operations are prioritized for 'America/Los_Angeles' timezone.
- **Backend Structure**: Modular API routes, loader modules, health checks, graceful shutdown.
- **Member Management**: Supports tiers, tags, directory, and unified billing groups.
- **Tier Features System**: Database-driven, flexible comparison table for tier features.
- **Booking System**: "Request & Hold," conflict detection, staff/member bookings, multi-member bookings, calendar management, transactional with row-level locking.
- **Trackman Integration**: Unified 1:1 sync with CSV imports and webhooks for real-time booking and delta billing.
- **Linked Email Addresses**: Supports alternate emails and auto-learns associations from Trackman imports.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications**: In-app real-time notifications and sequential notice dismissal, with 3-channel delivery.
- **Real-Time Sync**: Instant updates via WebSocket and Supabase Realtime.
- **PWA Features**: Service Worker caching, offline support, iOS-style interactions, automatic cache invalidation, and "Update Available" notifications.
- **Stale Asset Detection**: PageErrorBoundary handles chunk load failures and auto-reloads.
- **Error Resilience**: Exponential backoff for retries, fallbacks to cached data, and comprehensive API error logging.
- **Performance Optimizations**: List virtualization, skeleton loaders, lazy-loaded components, optimistic updates, and memoized context functions.
- **State Management**: Zustand stores for atomic state (e.g., notificationStore) and TanStack Query for data fetching.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, and migration tools.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA features, account deletion, data export, and admin audit log.
- **Waiver Management**: Tracks waiver versions and enforces signing on login.
- **Unified Fee Service**: Centralized `computeFeeBreakdown()` for all fee calculations.
- **Webhook Safety**: Transactional dedup for Stripe webhooks, deferred action pattern, resource-based ordering.
- **Roster Protection**: Optimistic locking with `roster_version` and row-level locking.
- **Billing Management**: Staff Payments Dashboard, unified payment history, member billing, self-service portal, tier change wizard with proration, dunning, and refund processing.
- **Payment Recovery (Dunning)**: Tracks failed payments, retries, and member notifications.
- **Grace Period System**: 3-day grace period for billing failures.
- **Day Pass System**: Non-member day pass purchases with visitor matching and QR code delivery.
- **QR Code System**: QR codes for day passes and digital access cards for members, with staff scanning.
- **Corporate Membership**: Unified billing groups, volume pricing, corporate checkout, HubSpot sync, individual tracking.
- **Data Integrity Architecture**: Stripe as source of truth for billing, transaction rollback, webhook idempotency, and dual-source active tracking with HubSpot.
- **Stripe Member Auto-Fix**: Login flow verifies Stripe subscription status and corrects `membership_status`.
- **Stripe Subscription → HubSpot Sync**: Automated sync of `membership_status` and tier to HubSpot contact.
- **Member Balance Display**: Shows pending fees; booking cancellations clear fees.
- **Booking Prepayment System**: After booking approval or Trackman auto-linking, creates a prepayment intent for expected fees (overage, guests). Members can pay from their dashboard with optional credit application toggle. Check-in is blocked until fees are paid. Cancellations auto-refund succeeded prepayments with idempotency protection.
- **Stripe Customer Metadata Sync**: User ID and tier synced to Stripe customer metadata.
- **Stripe Transaction Cache**: Local caching of Stripe transactions.
- **Tier Data Automation**: Member creation requires valid tier, real-time sync queues tier changes to HubSpot, auto-fix copies tiers from alternate emails every 4 hours.
- **Scheduled Maintenance**: Daily tasks for session cleanup, webhook log cleanup, Stripe reconciliation, and grace period checks.
- **Security Implementation**: Rate limiting, SQL injection prevention (parameterized queries/Drizzle ORM), webhook signature verification (Stripe, HubSpot, Resend), secure session management (httpOnly, secure, sameSite=none), CORS origin whitelist, authentication middleware for push notifications, and dependency overrides for CVEs.
- **Stripe Terminal Integration**: In-person card reader support for membership signup. Staff can tap/swipe member cards using WisePOS E or S700 readers. Payment flow: create subscription → collect payment on Terminal → confirm and activate membership. Includes idempotency keys, metadata validation, amount verification, and audit logging. Supports simulated readers for development testing.
- **Stripe Product Catalog as Source of Truth**: Two-way sync between app and Stripe. Push sync (`syncMembershipTiersToStripe`, `syncCafeItemsToStripe`, `syncTierFeaturesToStripe`) pushes app data to Stripe. Reverse sync (`pullTierFeaturesFromStripe`, `pullCafeItemsFromStripe`) reads Stripe Features and products back into the database. Webhook handlers for `product.updated/created/deleted` and `price.updated/created` trigger automatic reverse sync. Manual "Pull from Stripe" button available as fallback. Tier booking limits and access permissions show "Managed by Stripe" labels and become read-only when linked to a Stripe product. Cafe menu items are view-only in the app with prices managed in Stripe Dashboard.

## External Dependencies
- **Stripe Payments**: Payment collection, subscription management, webhooks.
- **Resend**: Email-based OTP verification and automated alerts.
- **HubSpot CRM**: Contact and member management, two-way data sync, communication preferences, and forms.
- **Eventbrite**: Members-only event synchronization.
- **Google Calendar**: Integration with various club calendars.
- **Apple Messages for Business**: Direct messaging.
- **Amarie Aesthetics MedSpa**: Direct booking links.
- **Supabase**: Backend admin client, Realtime subscriptions, and session token generation.
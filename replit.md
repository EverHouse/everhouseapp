# Ever House Members App

## Overview
The Ever House Members App is a private members club application for golf and wellness centers. Its primary purpose is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to enhance member engagement and streamline operational workflows, providing a cohesive digital experience for members and staff. The project envisions becoming the central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building, ultimately boosting member satisfaction and operational efficiency.

## User Preferences
- **CRITICAL: Communication Style** - The founder is non-technical. Always explain changes in plain English, focusing on how they affect the member/staff experience or business operations. Avoid jargon like "ORM," "WebSocket," "orchestration," "middleware," etc. If a technical term is necessary, explain it simply first (e.g., "the notification system" instead of "WebSocket server").
- **CRITICAL: Pacific Timezone (America/Los_Angeles) is THE FIRST PRIORITY for any date/time operations.** All time comparisons must use Pacific time utilities, never local server time.
- **CRITICAL: Changelog Updates** - Update `src/data/changelog.ts` after EVERY significant change, not just when asked. Each feature or fix should be documented immediately. Bump version numbers appropriately (patch for fixes, minor for features, major for breaking/significant changes). Mark major releases with `isMajor: true`.
- **CRITICAL: Staff Activity Logging** - ALL staff actions must be logged to the audit system using `logFromRequest()` from `server/core/auditLog.ts`. When adding new staff features, always add audit logging with appropriate action type, resource type, resource ID/name, and relevant details. Add new action types to `AuditAction` type if needed. This ensures all staff activity appears in the Staff Activity feed on the Changelog page.
- I prefer simple language.
- I like functional programming.
- I want iterative development.
- Ask before making major changes.
- I prefer detailed explanations.
- Do not make changes to the folder `Z`.
- Do not make changes to the file `Y`.

## System Architecture
The application features a React 19 frontend with Vite, styled using Tailwind CSS, and an Express.js backend powered by a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism) with EH monogram logo.
- **Accessibility**: WCAG AA contrast compliance and `aria-label` attributes.
- **Typography**: Playfair Display for headlines, Inter for body/UI.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav.
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Light, Dark, and System themes, persisted locally.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling, and entry/exit animations.
- **Drawer UX**: MemberProfileDrawer hides bottom navigation and floating action button on mobile.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Modular Architecture**: Components like AdminDashboard and StaffCommandCenter are modular.
- **Timezone Handling**: All date/time operations prioritize America/Los_Angeles timezone.
- **Member Management**: Supports member tiers, tags, comprehensive directory, and unified billing groups (family and corporate) with primary payer and add-on members.
- **Booking System**: Supports "Request & Hold," conflict detection, staff/member initiated bookings, multi-member bookings, and calendar management. Includes guardian consent for minors. Booking creation uses database transactions with row-level locking to prevent race conditions when checking daily limits.
- **Trackman Data Sync Architecture**: Unified 1:1 sync between CSV imports and webhook integration using `trackman_booking_id` as the unique key. Both data sources create booking_requests to block time slots (preventing double-booking). **Origin Tracking**: Each booking tracks its source (member_request, staff_manual, trackman_webhook, trackman_import) plus sync metadata (last_sync_source, last_trackman_sync_at). **UPSERT Logic**: CSV import updates existing bookings instead of duplicating; enriches missing fields but preserves member linkage and staff edits. **Unmatched Handling**: Unmatched bookings use placeholder email (`unmatched-{id}@trackman.local`) and queue for staff resolution.
- **Trackman Webhook Integration**: Real-time booking synchronization via webhooks. Features delta billing for session extensions (only charges the difference), idempotency checks to prevent duplicate charges on webhook retries, and cross-midnight duration handling. Secure endpoint (`/api/webhooks/trackman`) supports both V1 (legacy) and V2 (nested venue/booking) formats. V2 webhooks use ISO 8601 UTC timestamps converted to Pacific timezone, bay.ref mapping (1-4 → resource_id), and externalBookingId-first matching for reliable linking. Bay serial mapping for V1: 24120062→Bay 1, 23510044→Bay 2, 24070104→Bay 3, 24080064→Bay 4. **Simplified Flow**: Member requests → Staff sees request → Staff books in Trackman portal → Webhook auto-confirms. Features: time matching updates our records to match Trackman's actual times; bay conflict detection warns staff of overlapping bookings; cancelled request handling links Trackman ID but keeps cancelled + refunds guest passes; auto-expiry scheduler (hourly) expires pending requests past their time. Unmatched bookings queue for staff resolution with "Remember Email" feature. Staff get real-time toast notifications when bookings auto-confirm via WebSocket. **Webhook Events UI**: TrackmanWebhookEventsSection component displays recent webhook events with stats (total, auto-approved, errors) at the bottom of the Bookings page (SimulatorTab). **Manual Link to Member**: Staff can manually link any unmatched Trackman webhook event to a member using the "Link to Member" button on each event card, which opens a member search modal.
- **Linked Email Addresses**: Supports alternate email addresses for members to facilitate automatic booking creation. Trackman import auto-learns email associations when M: entries are matched by name but have unrecognized emails.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system with 3-channel delivery.
- **Real-Time Sync**: Instant updates via WebSocket, with Supabase Realtime as a parallel channel.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Action Management**: `useAsyncAction` hook for preventing double-tap submissions, loading states, and error handling.
- **Performance Optimizations**: List virtualization (`react-window`), skeleton loaders, optimized CSS, lazy-loaded admin tabs, and optimistic updates.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, and data migration tools.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA compliance features, account deletion, and member data export (Right to Know). Admin audit log tracks staff access to member data with IP/user-agent logging.
- **Waiver Management**: Tracks waiver versions and requires signing on login.
- **Member Lookup**: Centralized `MemberService` with caching.
- **Billing Management**: Staff Payments Dashboard for POS, unified payment history, member billing management, self-service portal, tier change wizard with proration, dunning for failed payments, and refund processing.
- **Add User Workflow**: Staff can add new users via the "New User" modal (creates visitor with type='NEW', source='APP'). Payment links with tier selection are sent from the visitor profile drawer. When visitors pay, they automatically become active members with Stripe billing and sync to HubSpot.
- **Closed-Loop Activation**: Automated member activation upon Stripe subscription confirmation.
- **Payment Recovery (Dunning)**: Tracks failed payments with retry attempts and notifies members to update payment methods.
- **Grace Period System**: Automated 3-day grace period for billing failures. Daily scheduler (10am Pacific) sends reminder emails with Stripe billing portal links. After 3 days, membership terminates (tier=NULL, last_tier preserved). Staff can manually send reactivation links via MemberProfileDrawer. TierBadge displays "No Active Membership" with grayed-out last tier for terminated members.
- **Day Pass System**: Non-members can purchase day passes with visitor matching, HubSpot sync, and QR code delivery.
- **QR Code System**: QR codes for day passes and digital access cards for members, with staff scanning functionality.
- **Membership Invites**: Staff can send Stripe payment links to prospective members.
- **Stripe Price Linking**: Tiers can be linked to Stripe prices for consistent pricing.
- **Tier Normalization**: Centralized utility for tier matching and parsing.
- **Guest Fee Configuration**: Guest fees are configurable per-tier.
- **Guest Pass Accuracy**: Guest pass counting excludes cancelled/declined bookings.
- **Guest Email Requirement**: Guest email is required on all UI and API paths for adding guests to bookings. Guests without email are treated as unfilled slots until email is provided. Staff API available at GET /api/guests/needs-email and PATCH /api/guests/:guestId/email.
- **Pre-Declared Participants**: Members can specify player emails when submitting booking requests (before staff approval). The `request_participants` JSONB field stores [{email, type}] where type is 'member' or 'guest'. When bookings are confirmed, `linkAndNotifyParticipants()` in `server/core/bookingEvents.ts` automatically creates booking_members/booking_guests entries and notifies member participants. Bookings appear on each participant's dashboard via the booking_members join query.
- **PWA Gesture Handling**: Edge swipe gestures are disabled in standalone PWA mode.
- **Corporate Membership**: Supports unified billing groups, volume pricing, corporate checkout, HubSpot company sync, and individual tracking within groups.
- **Data Integrity Architecture**: Stripe as the source of truth for billing, transaction rollback for group member operations, fail-fast on Stripe errors, webhook idempotency, and automatic status sync between Stripe and database. Payment confirmation uses database transactions to prevent partial updates. Refunds properly update booking_participants and add reversing ledger entries with payment intent linkage for audit trail. Dual-source active tracking using HubSpot and Stripe. Tier sync utility for consistency. Database pool client management ensures proper release.
- **Stripe Customer Metadata Sync**: Customer metadata (userId, tier) is automatically synced to Stripe when customers are created or linked, and when tier changes occur. Bulk sync endpoint available at POST /api/data-integrity/sync-stripe-metadata for syncing all existing customers.
- **Stripe Transaction Cache**: Transactions are cached locally in `stripe_transaction_cache` table for fast querying. Webhooks automatically populate the cache on payment events. Backfill endpoint available at POST /api/financials/backfill-stripe-cache for historical data. This eliminates slow Stripe API calls and fixes pagination limits.
- **Scheduled Maintenance**: Daily session cleanup (2am Pacific), webhook log cleanup (4am Pacific, 30-day retention), Stripe reconciliation (5am Pacific), and grace period checks (10am Pacific). All schedulers are modularized in `server/schedulers/` for maintainability.
- **Dynamic Resource Lookup**: Conference room and bay IDs are fetched from the database dynamically rather than hardcoded, allowing resource configuration changes without code updates.

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
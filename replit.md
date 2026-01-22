# Ever House Members App

## Overview
The Ever House Members App is a private members club application for golf and wellness centers. Its primary purpose is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to enhance member engagement and streamline operational workflows, providing a cohesive digital experience for members and staff. The project envisions becoming the central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building, ultimately boosting member satisfaction and operational efficiency.

## User Preferences
- **CRITICAL: Communication Style** - The founder is non-technical. Always explain changes in plain English, focusing on how they affect the member/staff experience or business operations. Avoid jargon like "ORM," "WebSocket," "orchestration," "middleware," etc. If a technical term is necessary, explain it simply first (e.g., "the notification system" instead of "WebSocket server").
- **CRITICAL: Pacific Timezone (America/Los_Angeles) is THE FIRST PRIORITY for any date/time operations.** All time comparisons must use Pacific time utilities, never local server time.
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
- **Booking System**: Supports "Request & Hold," conflict detection, staff/member initiated bookings, multi-member bookings, and calendar management. Includes guardian consent for minors.
- **Trackman Webhook Integration**: Real-time booking synchronization via webhooks replaces manual email-parsing. Secure endpoint (`/api/webhooks/trackman`) validates HMAC SHA256 signatures. Bay serial mapping (24120062→Bay 1, 23510044→Bay 2, 24070104→Bay 3, 24080064→Bay 4) provides precise bay identification. Auto-approval matches Trackman bookings to pending member requests (exact or ±30-minute fuzzy). Auto-creates confirmed bookings for known members without prior request. Smart notification delivery: WebSocket first, email only if user not actively viewing app. Unmatched bookings queue for staff resolution with "Remember Email" feature.
- **Linked Email Addresses**: Supports alternate email addresses for members to facilitate automatic booking creation. Trackman import auto-learns email associations when M: entries are matched by name but have unrecognized emails.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system with 3-channel delivery.
- **Real-Time Sync**: Instant updates via WebSocket, with Supabase Realtime as a parallel channel.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Action Management**: `useAsyncAction` hook for preventing double-tap submissions, loading states, and error handling.
- **Performance Optimizations**: List virtualization (`react-window`), skeleton loaders, optimized CSS, lazy-loaded admin tabs, and optimistic updates.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, and data migration tools.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA compliance features, and account deletion.
- **Waiver Management**: Tracks waiver versions and requires signing on login.
- **Member Lookup**: Centralized `MemberService` with caching.
- **Billing Management**: Staff Payments Dashboard for POS, unified payment history, member billing management, self-service portal, tier change wizard with proration, dunning for failed payments, and refund processing.
- **Add Member Workflow**: Staff can invite new members via payment links for automated account creation.
- **Closed-Loop Activation**: Automated member activation upon Stripe subscription confirmation.
- **Payment Recovery (Dunning)**: Tracks failed payments with retry attempts and notifies members to update payment methods.
- **Day Pass System**: Non-members can purchase day passes with visitor matching, HubSpot sync, and QR code delivery.
- **QR Code System**: QR codes for day passes and digital access cards for members, with staff scanning functionality.
- **Membership Invites**: Staff can send Stripe payment links to prospective members.
- **Stripe Price Linking**: Tiers can be linked to Stripe prices for consistent pricing.
- **Tier Normalization**: Centralized utility for tier matching and parsing.
- **Guest Fee Configuration**: Guest fees are configurable per-tier.
- **Guest Pass Accuracy**: Guest pass counting excludes cancelled/declined bookings.
- **Guest Email Requirement**: Guest email is required on all UI and API paths for adding guests to bookings. Guests without email are treated as unfilled slots until email is provided. Staff API available at GET /api/guests/needs-email and PATCH /api/guests/:guestId/email.
- **PWA Gesture Handling**: Edge swipe gestures are disabled in standalone PWA mode.
- **Corporate Membership**: Supports unified billing groups, volume pricing, corporate checkout, HubSpot company sync, and individual tracking within groups.
- **Data Integrity Architecture**: Stripe as the source of truth for billing, transaction rollback for group member operations, fail-fast on Stripe errors, webhook idempotency, and automatic status sync between Stripe and database. Dual-source active tracking using HubSpot and Stripe. Tier sync utility for consistency. Database pool client management ensures proper release.

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
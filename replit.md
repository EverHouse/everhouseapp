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
- **Design System**: Liquid Glass (iOS-inspired glassmorphism).
- **Branding**: EH monogram logo and consistent page titles.
- **Accessibility**: WCAG AA contrast compliance, `aria-label` attributes for icon-only buttons.
- **Typography**: Playfair Display for headlines, Inter for body/UI.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav for core features.
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Light, Dark, and System themes, persisted locally.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling, entry/exit animations for modals, toasts, cards.
- **Drawer UX**: MemberProfileDrawer hides bottom navigation and floating action button on mobile.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Modular Architecture**: Components like AdminDashboard and StaffCommandCenter are modular.
- **Timezone Handling**: All date/time operations prioritize America/Los_Angeles timezone.
- **Member Management**: Supports member tiers, tags, comprehensive member directory with history and notes, and unified billing groups (family and corporate) with primary payer and add-on members.
- **Booking System**: Supports "Request & Hold," conflict detection, staff-initiated bookings, member rescheduling, multi-member bookings with fair usage tracking, and calendar management. Includes features for staff check-in, payment guards, fee waiving, and Trackman import/reconciliation. Guardian consent for minors is integrated.
- **Trackman Webhook Integration**: Real-time booking synchronization via webhooks replaces manual email-parsing. Secure endpoint (`/api/webhooks/trackman`) validates HMAC SHA256 signatures. `trackman_webhook_events` table provides audit trail; `trackman_bay_slots` table caches live availability. Auto-approval matches incoming Trackman bookings to pending member requests (exact or ±30-minute fuzzy match). Confirmed bookings trigger multi-channel notifications (push + email). Admin "Webhook Events" section in TrackmanTab displays event stats, recent events, and payload inspection.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system with 3-channel delivery (database + push + real-time) and user targeting.
- **Real-Time Sync**: Instant updates across clients via WebSocket, with Supabase Realtime as a parallel channel (when enabled in Supabase dashboard).
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Action Management**: `useAsyncAction` hook prevents double-tap submissions, provides loading states, and error handling. Toast component prevents stacking identical messages and supports key-based updates.
- **Performance Optimizations**: List virtualization using `react-window` for large lists, skeleton loaders, optimized CSS glass effects, lazy-loaded admin tabs, and optimistic updates for booking actions.
- **Directory Layout**: Member directory uses flex layout filling available viewport height. Lists scroll internally without page scroll. Scroll fade gradients (top/bottom) indicate scrollability on both mobile and desktop. Row heights: mobile 180px, desktop 56px.
- **Bookings Layout**: Simulator bookings page uses split panel layout on desktop. Left panel (queue/scheduled) and right panel (calendar grid) scroll independently. Date picker header stays fixed. Scroll fade gradients on both panels.
- **Admin Tools**: Admin-configurable features (push notifications, booking intervals, RSVP, banners, capacity, waitlists, closure reasons), data integrity dashboard with email alerts, data migration tools (Mindbody), and self-service recovery tools.
- **Privacy Compliance**: Includes a Privacy modal for App Store compliance with links to policy/TOS and account deletion. CCPA/CPRA compliance features like "Do Not Sell/Share My Info" toggle, "Request Data Export," and PII anonymization.
- **Waiver Management**: Tracks waiver versions, requires signing on login via a non-dismissible modal.
- **Member Lookup**: Centralized `MemberService` handles member data lookups by various identifiers with caching.
- **Billing Management**: Staff Payments Dashboard for full POS functionality. Unified payment history for members from multiple sources. Staff can manage member billing (subscriptions, credits, discounts) via a dedicated tab in the member profile. Members have a self-service billing portal to view subscriptions and invoices. Features include: Tier Change Wizard with proration preview (immediate or end-of-cycle changes), Upcoming Changes visibility for members (cancellations, pauses, pending tier changes), automated dunning for failed payments with 3-channel notifications (database + WebSocket push + email), staff retry button with attempt counter (max 3 attempts), and refund processing UI.
- **Add Member Workflow**: Staff can invite new members directly by entering their info and clicking "Send Payment Link." The system sends a Stripe checkout email, and when the person completes payment, their account is automatically created and activated (no manual member creation needed). The modal shows tier pricing and provides a copyable payment link for sharing.
- **Closed-Loop Activation**: When a Stripe subscription is confirmed, the system automatically activates the member's tier and sets their status to active (if they were pending/inactive).
- **Payment Recovery (Dunning)**: Failed payments are tracked in `stripe_payment_intents` with retry_count, last_retry_at, failure_reason, and requires_card_update fields. Staff can retry failed payments up to 3 times via the Payments tab. After 3 failed attempts, the system prompts members to update their payment method. All failures trigger 3-channel notifications (database notification, WebSocket push, email).
- **Day Pass System**: Non-members can purchase day passes (Guest Pass $25, Coworking $35, Golf Sim $50) without creating an account. Visitor matching service links purchases to existing users by email/phone/name/Mindbody ID. Purchases tracked in `day_pass_purchases` table, synced to HubSpot contacts, and viewable by staff via `/api/visitors` endpoints. Public `/day-pass` page allows direct Stripe Checkout purchases. QR codes are emailed automatically after purchase for easy check-in.
- **QR Code System**: Day pass purchases receive QR code emails (format: `PASS:{passId}`). Members have Digital Access Cards on their profile with QR codes (format: `MEMBER:{userId}`). Staff can scan QR codes in the Payments tab to redeem passes and view redemption history.
- **Membership Invites**: Staff can send Stripe payment links to prospective members via the "Send Membership Invite" card in PaymentsTab. Emails include tier details and checkout links.
- **Stripe Price Linking**: TiersTab allows linking membership tiers directly to Stripe prices. When linked, pricing syncs from Stripe ensuring consistency across app and billing.
- **Tier Normalization**: Centralized tier matching utility (`server/utils/tierUtils.ts`) provides exact slug-based matching with warning logs for fuzzy fallbacks. All tier name parsing uses this utility.
- **Guest Fee Configuration**: Guest fees are stored per-tier in `membership_tiers.guest_fee_cents` (default $25), allowing pricing changes without code deployment.
- **Guest Pass Accuracy**: Guest pass counting excludes cancelled/declined bookings so members don't lose passes when cancelling.
- **PWA Gesture Handling**: Edge swipe gestures are disabled in standalone PWA mode to avoid conflicts with iOS native back gestures.

## External Dependencies
- **Stripe Payments**: Integrated for in-app payment collection, customer management, subscription management, payment tracking, HubSpot sync, and webhook processing. Supports one-time products (day passes, guest fees) and recurring subscriptions. Admin "Sync to Stripe" button syncs membership tier pricing and privileges (daily simulator minutes, guest passes, booking window) to Stripe product metadata.
- **Resend**: Used for email-based OTP verification and automated email alerts.
- **HubSpot CRM**: Integrated for contact and member management, two-way sync of communication preferences, background sync of member data, visit count push, profile preference updates, tour scheduling sync, tier management, and webhooks. Handles tier logic, join date mapping, notes sync, and communication log sync.
- **HubSpot Forms**: Application forms submit to the HubSpot Forms API.
- **Eventbrite**: Syncs members-only events and attendee information.
- **Google Calendar**: Integrates with MBO_Conference_Room, Public/Member Events, and Wellness & Classes calendars.
- **Apple Messages for Business**: Direct messaging support.
- **Amarie Aesthetics MedSpa**: Direct booking link for wellness services.
- **Supabase**: Backend admin client for billing reconciliations using SERVICE_ROLE_KEY. Frontend Realtime subscriptions for notifications, bookings, and announcements (works alongside WebSocket). Auth routes generate Supabase session tokens for realtime connections using the generateLink + verifyOtp pattern (requires Supabase email confirmations enabled for full functionality).

## Corporate Membership
- **Unified Billing Groups**: Single `billing_groups` table supports both family and corporate memberships via `type` field ('family' | 'corporate'). Family members automatically receive the FAMILY20 coupon (20% discount) when added to a billing group.
- **Volume Pricing**: Corporate tier offers volume discounts from $350/seat (1-4 employees) down to $249/seat (50+).
- **Checkout Flow**: Corporate checkout captures company name, job title, and employee count with real-time price calculation.
- **HubSpot Company Sync**: Corporate members sync to HubSpot as Companies with contact associations.
- **Individual Tracking**: Each corporate member tracked in `group_members` table with Stripe subscription item linking.

## Data Integrity Architecture (Jan 2026)
- **Stripe/Database Sync Pattern**: Stripe is the source of truth for billing state. Database syncs via webhooks.
- **Transaction Rollback**: `addCorporateMember` and `removeGroupMember` use database transactions with Stripe rollback capability. If the database transaction fails after Stripe is updated, the system attempts to revert the Stripe change.
- **Fail-Fast on Stripe Errors**: Group member operations fail immediately on Stripe errors before making database changes, preventing data drift between systems.
- **Webhook Idempotency**: Stripe webhook handler uses database-backed event ID deduplication (`webhook_processed_events` table, 24-hour retention) to prevent duplicate event processing. Events are only marked as processed after successful handler execution, allowing Stripe retries on failure.
- **Automatic Status Sync**: When a Stripe subscription is cancelled, the user's `membership_status` is automatically updated to 'cancelled' and `stripe_subscription_id` is cleared. When a subscription becomes active, status is set to 'active'. Past due and unpaid subscriptions update to 'past_due' and 'suspended' respectively.
- **Dual-Source Active Tracking**: Member directory uses both HubSpot and Stripe to determine active members. A member shows as active if: (1) HubSpot says active, (2) status is NULL, or (3) has Stripe subscription AND status is transitional (pending/non-member). Directory pagination defaults to 500 members.
- **Tier Sync Utility**: `server/core/memberService/tierSync.ts` provides centralized functions for syncing membership tiers from Stripe price IDs, syncing status, and validating tier consistency between `tier` and `tier_id` fields.
- **Pool Client Management**: Database pool clients are released only in `finally` blocks, never on early return paths, to prevent double-release errors.
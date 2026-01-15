# Even House Members App

## Overview
The Even House Members App is a private members club application designed for golf and wellness centers. Its core purpose is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to significantly enhance member engagement and streamline operational workflows, offering a cohesive digital experience for both members and staff. The project envisions becoming the central digital hub for private members clubs, providing comprehensive tools for membership management, facility booking, and community building, ultimately driving higher member satisfaction and operational efficiency.

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
- **Versioning Guidelines**:
  - **Major (8.0 → 9.0)**: Complete visual redesign, new major feature area, fundamental changes to how people use the app
  - **Minor (8.0 → 8.1)**: New features within existing areas, significant workflow improvements, multiple related enhancements, bug fix bundles
  - **Skip patch versions** - They add clutter. Just increment minor versions.
  - **Changelog rules**: Only log changes members/staff would notice. Group a week's small fixes into one entry. Write like you're texting: "You can now see who's coming to events"
  - **Files to update**: `src/data/changelog.ts` (newest at top) and `src/config/version.ts` (APP_VERSION and LAST_UPDATED)
- **Loading animations**: When updating loading screen animations/mascot, update ALL instances across the app including: WalkingGolferLoader, WalkingGolferSpinner, Gallery MascotLoader, PullToRefresh, and any other loading components using the mascot.
- **Training Guide Sync**: When changing how any feature works, update the corresponding training guide section in `server/routes/training.ts` (`TRAINING_SEED_DATA`). The training guide auto-syncs on server startup.

## System Architecture
The application is built with a React 19 frontend utilizing Vite, styled with Tailwind CSS, and an Express.js backend powered by a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism).
- **Branding**: EH monogram logo and consistent page titles.
- **Accessibility**: WCAG AA contrast compliance.
- **Typography**: Playfair Display for headlines, Inter for body/UI.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav for core features.
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Light, Dark, and System themes, persisted locally.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Modular Architecture**: Components like AdminDashboard and StaffCommandCenter are modular.
- **Pacific Timezone Handling**: All date/time operations prioritize America/Los_Angeles timezone.
- **Member Tiers & Tags**: Database-driven access control, booking limits, and guest passes.
- **Booking System**: Supports "Request & Hold," conflict detection, staff-initiated bookings, member rescheduling, multi-member bookings with fair usage tracking, and calendar management.
- **Database Consolidation**: Uses `resources`, `booking_requests`, and `staff_users` tables.
- **Enhanced Member Directory**: Comprehensive member profile drawer with history, communication logs, and staff notes.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system. Centralized `notificationService.ts` handles all notifications with 3-channel delivery (database + push + real-time) and proper user targeting (staff vs member). Member notifications include tier changes, check-in confirmations, RSVP/wellness cancellations, guest pass refunds, and bug report resolutions. Staff notifications include new form submissions, tour status changes, data alerts, and bug reports.
- **Real-Time Sync**: Instant updates across clients via WebSocket for various data points (e.g., simulator availability, waitlists, announcements).
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions (haptic feedback, pull-to-refresh).
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling.
- **Trackman Historical Import**: Staff and admin tool for importing CSV data, auto-matching to bookings, handling cancellations, and managing player counts. Enhanced with email matching, notes parsing, fuzzy matching, and creation of `booking_sessions` and `usage_ledger` entries.
- **Conference Room Auto Check-In**: Conference room bookings automatically mark as checked-in upon approval (no manual check-in required). Check-in buttons are hidden for conference room bookings in the staff interface.
- **Multi-Member Booking System**: Central `booking_sessions` table, `booking_participants`, `usage_ledger`, and `guests` tables for tracking participants, usage, and payments. Includes auto-generated `trackman_email` for matching.
- **Staff Check-In Tools**: Payment guard, check-in billing modal with fee breakdown, individual payment marking, fee waiving, and staff direct-add with tier override. All actions are audited in `booking_payment_audit`.
- **Conflict Detection**: Prevents double-booking members; API checks for overlapping times in `booking_requests`, `booking_participants`, and `booking_members`, returning 409 status with details.
- **Cancellation Cascade**: Owner cancellation notifies roster members, refunds guest passes (if applicable), and atomically cleans up related booking entries.
- **Guest Pass Consumption**: Server-side atomic guest pass processing in `guestPassConsumer.ts`. When staff marks a guest as "using a guest pass", the system: (1) decrements the owner's pass count in `guest_passes`, (2) updates booking participant status to waived with $0 fee, (3) creates a $0 purchase record in `legacy_purchases` for purchase history, (4) sends a notification to the member. All operations run in a single database transaction for data integrity. Staff can use the explicit `use_guest_pass` action or include "guest pass" in the waive reason.
- **Trackman Reconciliation**: Admin service to compare declared vs. actual player counts, with endpoints for reviewing discrepancies and adjusting fees.
- **Fair Usage Tracking**: Time is split equally among all players.
- **Modal Pattern**: Standardized, accessible, viewport-centered modal implementation.
- **Needs Review & Reconciliation Features**: Flags HubSpot meetings, calendar events, and wellness classes missing metadata for staff review.
- **Data Integrity Dashboard**: Admin-only page with checks for orphan records, missing relationships, and sync mismatches, sending email alerts for critical issues. Automated daily checks.
- **Code Architecture**: Refactored database schema and calendar modules into domain-focused files.
- **Admin-Configurable Features**: Push notifications, booking intervals, RSVP management, promotional banners, wellness class capacity, waitlists, closure reasons, and notice types.
- **Mindbody Data Migration**: Import of historical sales data into `legacy_purchases`, member matching, item categorization, and linking guest fees to Trackman sessions. Member purchase history is viewable by staff and members.
- **HubSpot Name Fallback**: Extracts names from `hs_calculated_full_name` when firstname/lastname are NULL.
- **Admin Settings Dashboard**: Staff can configure app options (club name, support email, purchase category labels, notification toggles) via `app_settings` table without code changes.
- **Data Tools Panel**: Self-service recovery tools for re-syncing members, relinking guest fees, correcting attendance, and re-importing data with audit logging.
- **Automatic Monitoring Alerts**: `dataAlerts.ts` sends staff notifications for import failures, low match rates, sync issues, and data integrity problems.
- **Former Members Caching**: 10-minute cache in DataContext reduces repeated API calls when viewing former/inactive members, with force-refresh option.
- **Reusable MemberSearchInput Component**: Located at `src/components/shared/MemberSearchInput.tsx`. Use this component whenever you need member selection with predictive dropdown. It uses DataContext members, supports keyboard navigation, shows name/email/tier, and returns a `SelectedMember` object with id, email, name, tier, and stripeCustomerId. Props: `onSelect`, `onClear`, `placeholder`, `label`, `selectedMember`, `disabled`, `showTier`, `autoFocus`. **ALWAYS use this component for member search instead of building custom search logic.**
- **Staff Payments Dashboard**: Full POS functionality at `/admin?tab=payments` with Quick Charge, Cash/Check Recording, Refunds, Failed Payments, Daily Summary, Pending Authorizations, Member Lookup with balance/history, and Guest Pass adjustments. All payment actions logged in `billing_audit_log`.
- **Unified Purchase History**: Members can view their complete payment history in the History tab under "Purchases". The system combines 4 sources: (1) Legacy Mindbody purchases, (2) Stripe invoices, (3) Stripe payment intents (quick charges, guest fees), and (4) Cash/check payments. Each entry shows the amount, date, category badge (with icon), and source badge (Mindbody, Stripe, Cash, Check, or Even House). The `getUnifiedPurchasesForEmail` function in `server/routes/legacyPurchases.ts` handles the aggregation with robust date handling via `safeToISOString`.

## External Dependencies
- **Stripe Payments**: Integrated via Replit Connectors for in-app payment collection.
    - **Hybrid Billing**: Existing Mindbody members stay on current billing; Stripe handles new signups and one-off charges.
    - **Payment Collection**: Staff can collect guest fees and overage payments in-app via Stripe Elements in the Check-In Billing Modal.
    - **Customer Management**: Members are linked to Stripe customers (`stripe_customer_id` on users table).
    - **Payment Tracking**: All payment intents tracked in `stripe_payment_intents` table with status and HubSpot sync.
    - **HubSpot Sync**: Successful payments create line items on member deals for accounting visibility.
    - **Webhook Processing**: Real-time payment status updates via managed webhooks (auto-configured).
    - **HubSpot-to-Stripe Product Sync**: Admin Billing tab imports membership products from HubSpot, creates Stripe Products with recurring Prices (monthly/yearly). Tracked in `stripe_products` table.
    - **Subscription Management**: Create, view, and cancel member subscriptions via admin Billing tab. Subscriptions auto-charge members on recurring schedule.
    - **Invoice Management**: Create one-off invoices, preview subscription invoices, finalize and send invoices to members. Staff can void draft/open invoices.
    - **Key Files**: `server/core/stripe/`, `server/routes/stripe.ts`, `src/pages/Admin/tabs/BillingTab.tsx`
- **Resend**: Used for email-based OTP verification and email alerts from automated integrity checks.
- **HubSpot CRM**: Integrated for contact and member management using Replit Connectors.
    - **Two-Way Sync**: Communication preferences (`eh_email_updates_opt_in`, `eh_sms_updates_opt_in`) sync bidirectionally.
    - **Background Sync**: Member data (including interest flags) pulls every 5 minutes.
    - **Visit Count Push**: Updates `total_visit_count` in HubSpot on member check-in.
    - **Profile Preferences**: Real-time push of email/SMS toggle changes to HubSpot.
    - **Tour Scheduling Sync**: HubSpot Meetings API syncs tours to the app database, with Google Calendar fallback.
    - **Tier Management**: Admin tier edits push to HubSpot with audit logging.
    - **Webhooks**: Receives real-time updates for contact and deal changes, invalidating cache and broadcasting updates.
    - **Deal Stage Sync**: Mindbody `membership_status` drives HubSpot deal stages.
- **HubSpot Forms**: Application forms submit to HubSpot Forms API.
- **Eventbrite**: Syncs members-only events and attendee information.
- **Google Calendar**: Integrates with three calendars (MBO_Conference_Room, Public/Member Events, Wellness & Classes).
- **MindBody Conference Room Sync**: Automatic syncing of conference room bookings.
- **Apple Messages for Business**: Direct messaging support.
- **Amarie Aesthetics MedSpa**: Direct booking link for wellness services.
# Ever House Members App

## Overview
The Ever House Members App is a private members club application for golf and wellness centers. Its primary goal is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to enhance member engagement and streamline operational workflows, providing a cohesive digital experience for members and staff. The project envisions becoming the central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building, ultimately boosting member satisfaction and operational efficiency.

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
- **Member Directory**: Comprehensive member profile with history, communication logs, and staff notes.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system with 3-channel delivery (database + push + real-time) and user targeting.
- **Real-Time Sync**: Instant updates across clients via WebSocket for various data points.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling. Entry/exit animations for modals, toasts, cards. Staggered list item animations for DirectoryTab and BookingQueuesSection.
- **Double-Tap Prevention**: `useAsyncAction` hook (`src/hooks/useAsyncAction.ts`) provides loading states, debounce protection, and error handling for all async button actions to prevent duplicate submissions.
- **Toast Deduplication**: Toast component prevents stacking identical messages within 2 seconds and supports key-based updates for action-in-progress patterns. Exit animations for smooth dismissal.
- **Performance Optimizations**: 
  - List virtualization using react-window v2.2.5 for DirectoryTab and StaffCommandCenter booking lists (threshold: 20+ items for directory, 6+ items for bookings). **v2 API**: Uses named row components (`MobileRowComponent`, `DesktopRowComponent`) with `rowComponent` prop and `rowProps` for data passing. v2 has automatic sizing (no AutoSizer needed) and requires React 18+.
  - Skeleton loaders for member/admin routes during data loading (`src/components/skeletons/`).
  - CSS glass effects optimized for mobile with reduced blur, touch device detection, and prefers-reduced-motion support.
  - Admin tabs lazy-loaded in AdminDashboard to reduce initial bundle size.
  - Optimistic updates for booking approve/deny actions in StaffCommandCenter.
- **Trackman Historical Import**: Staff and admin tool for importing CSV data, auto-matching to bookings, handling cancellations, and managing player counts, creating `booking_sessions` and `usage_ledger` entries.
- **Multi-Member Booking System**: Uses `booking_sessions`, `booking_participants`, `usage_ledger`, and `guests` tables for tracking.
- **Staff Check-In Tools**: Payment guard, check-in billing modal with fee breakdown, individual payment marking, fee waiving, and staff direct-add with tier override, all audited in `booking_payment_audit`.
- **Conflict Detection**: Prevents double-booking members by checking for overlapping times in booking tables.
- **Cancellation Cascade**: Owner cancellation notifies roster members, refunds guest passes, and cleans up related booking entries atomically.
- **Guest Pass Consumption**: Server-side atomic processing in `guestPassConsumer.ts` decrements passes, updates participant status, creates a purchase record, and sends notifications in a single transaction.
- **Trackman Reconciliation**: Admin service to compare declared vs. actual player counts, with tools for reviewing discrepancies and adjusting fees.
- **Fair Usage Tracking**: Time is split equally among all players.
- **Needs Review & Reconciliation Features**: Flags missing metadata for staff review.
- **Data Integrity Dashboard**: Admin-only page with checks for orphan records, missing relationships, and sync mismatches, with email alerts for critical issues and daily automated checks.
- **Admin-Configurable Features**: Push notifications, booking intervals, RSVP management, promotional banners, wellness class capacity, waitlists, closure reasons, and notice types.
- **Mindbody Data Migration**: Import of historical sales data into `legacy_purchases`, member matching, item categorization, and linking guest fees.
- **Admin Settings Dashboard**: Staff can configure app options via `app_settings` table.
- **Data Tools Panel**: Self-service recovery tools for re-syncing members, relinking guest fees, correcting attendance, and re-importing data with audit logging.
- **Automatic Monitoring Alerts**: `dataAlerts.ts` sends staff notifications for import failures, low match rates, sync issues, and data integrity problems.
- **Privacy Section (App Store Compliance)**: Member Profile includes a Privacy modal with Privacy Policy link, Terms of Service link, and Delete Account functionality with confirmation flow. Required for iOS App Store Guideline 5.1.1.
- **CCPA/CPRA Privacy Compliance**: Privacy modal includes "Do Not Sell/Share My Info" toggle stored in database (`do_not_sell_my_info` column), "Request Data Export" button that emails all active admin staff with 45-day deadline reminder, and PII anonymization endpoint (`/api/members/:email/anonymize`) for proper data erasure while preserving financial records.
- **Waiver Version Tracking**: Database columns `waiver_version` and `waiver_signed_at` track member waiver consent. `WaiverModal.tsx` appears on member login when waiver needs signing, is non-dismissible, and requires scrolling to bottom before enabling consent. Waivers API at `server/routes/waivers.ts`.
- **Guardian Consent for Minors**: Booking system requires guardian consent for members under 18. `GuardianConsentForm.tsx` captures guardian name, relationship, and phone number with validation. Consent stored in `guardian_*` columns on booking records.
- **WCAG AA Accessibility**: Glassmorphism text uses minimum opacity of 80% (e.g., `text-primary/80`, `text-white/80`) for contrast compliance. All icon-only buttons have `aria-label` attributes for screen readers.
- **Reusable MemberSearchInput Component**: Located at `src/components/shared/MemberSearchInput.tsx` for consistent member selection across all staff tools (BillingTab, StaffDirectAddModal, ManagePlayersModal, BookingMembersEditor, PaymentsTab). Supports `privacyMode` prop to redact emails for member-facing contexts.
- **Staff Payments Dashboard**: Full POS functionality at `/admin?tab=payments` with Quick Charge, Cash/Check Recording, Refunds, Failed Payments, Daily Summary, Pending Authorizations, Member Lookup, and Guest Pass adjustments, all logged in `billing_audit_log`.
- **Unified Payment History**: Members can view combined payment history from Mindbody, Stripe, and POS sources, with `Pay Now` and `View` links for invoices.
- **Database Integrity**: Added `user_id` FK to `booking_requests` and FK constraints for `resource_id` across booking tables with appropriate ON DELETE behaviors. Optimized admin member loading with pagination.
- **Centralized Member Lookup (MemberService)**: All member data lookups should go through `server/core/memberService/`. This service handles the complexity of matching members by email, UUID, linked emails, trackman email, HubSpot ID, or Mindbody client ID in a single place. Key methods: `findByEmail()`, `findById()`, `findByHubSpotId()`, `findByMindbodyClientId()`, `findByAnyIdentifier()`, `resolveMemberForBilling()`. The service includes caching to improve performance. SQL join helpers (`USAGE_LEDGER_MEMBER_JOIN`, `USAGE_LEDGER_MEMBER_JOIN_WITH_BOOKING`) are exported for use in raw SQL queries. **Identifier priority chain**: Email → UUID → HubSpot ID → Mindbody Client ID (legacy, being phased out).
- **Family Billing System**: Allows a primary member to pay for family add-on members at discounted rates. Uses `family_groups`, `family_members`, and `family_add_on_products` tables. Each family member maintains their own tier and individual daily booking allowances. Staff can manage family groups via the "Family" tab in the member profile drawer (`FamilyBillingManager.tsx`). Stripe integration automatically adds/removes subscription line items when family members change. Database constraints ensure data integrity with unique active member enforcement and cascading deletes. Backend routes at `server/routes/familyBilling.ts`, business logic at `server/core/stripe/familyBilling.ts`.
- **Member Billing Management Tab**: Staff-only "Billing" tab in MemberProfileDrawer (`src/components/admin/MemberBillingTab.tsx`) provides comprehensive billing management. Shows different UI based on billing source (`billing_provider` column: stripe, mindbody, family_addon, comped). **Stripe members**: View subscription status, pause/resume subscription, cancel at period end, apply account credits, apply percentage discounts (once or forever), update payment method via hosted link, and view invoice history. **Mindbody members**: Read-only view with link to legacy system. **Family add-ons**: Shows primary payer information. **Comped members**: Instructions for transitioning to paid plans. Backend routes at `server/routes/memberBilling.ts` with 9 endpoints using `isStaffOrAdmin` middleware. Subscription operations properly handle both 'active' and 'trialing' statuses.

## External Dependencies
- **Stripe Payments**: Integrated via Replit Connectors for in-app payment collection, customer management, payment tracking, HubSpot sync, webhook processing, product synchronization, subscription management, and invoice management.
- **Resend**: Used for email-based OTP verification and automated email alerts.
- **HubSpot CRM**: Integrated via Replit Connectors for contact and member management, two-way sync of communication preferences, background sync of member data, visit count push, profile preference updates, tour scheduling sync, tier management, and webhooks for real-time updates. **Strict tier logic** (tier is NULL when HubSpot value is blank/unrecognized, never defaults to 'Social'). **Join date mapping** prioritizes HubSpot's `createdate` with timezone parsing, falls back to `membership_start_date`. **Notes sync** imports `membership_notes` and `message` properties to member_notes table with prefixes for deduplication. **Assign Tier modal** allows staff to assign tiers to members with missing tier assignments, pushing to HubSpot first. **Communication logs sync** (calls, SMS) from HubSpot Engagements API runs every 30 minutes, stores in `communication_logs` table with deduplication by `hubspot_engagement_id`.
- **HubSpot Forms**: Application forms submit to HubSpot Forms API.
- **Eventbrite**: Syncs members-only events and attendee information.
- **Google Calendar**: Integrates with MBO_Conference_Room, Public/Member Events, and Wellness & Classes calendars.
- **MindBody Conference Room Sync**: Automatic syncing of conference room bookings.
- **Apple Messages for Business**: Direct messaging support.
- **Amarie Aesthetics MedSpa**: Direct booking link for wellness services.
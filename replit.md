# Even House Members App

## Overview
The Even House Members App is a private members club application for golf and wellness centers. Its primary purpose is to manage golf simulator bookings, wellness service appointments, and club events. The application aims to enhance member engagement and streamline operational workflows, providing a seamless digital experience for members and staff alike.

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
The application features a React 19 frontend with Vite, styled using Tailwind CSS, and an Express.js backend backed by a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism with backdrop blur, reflective edges, extra-large rounded corners, fluid hover animations).
- **Branding**: EH monogram logo on public pages, page titles in portal headers.
- **Accessibility**: WCAG AA contrast compliance for all interactive elements.
- **Typography**: Playfair Display for headlines, Inter for body/UI.
- **Color Palette**: Deep Green (#293515), Lavender (#CCB8E4), Bone (#F2F2EC), Background Dark (#0f120a).
- **Navigation**: Unified header, Member Bottom Nav for core features (Home, Book, Wellness, Events).
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Light, Dark, and System themes, persisted via `localStorage`.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Modular Architecture**: AdminDashboard and StaffCommandCenter are built with modular components.
- **Pacific Timezone Handling**: All date/time operations use America/Los_Angeles timezone, with specific utilities for both frontend and backend.
- **Member Tiers & Tags**: Database-driven access control, booking limits, and guest passes based on tiers and JSONB tags.
- **Booking System**: Supports "Request & Hold", conflict detection, staff-initiated bookings, member rescheduling, and multi-member bookings with fair usage tracking. Includes calendar management and facility closure integration.
- **Database Consolidation**: Uses `resources` for bookable resources, `booking_requests` for all bookings, and `staff_users` for staff/admin roles. Legacy tables deprecated.
- **Enhanced Member Directory**: Comprehensive member profile drawer with tabbed sections for history, communication logs, and staff notes.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system. Notice types sync via Google Calendar bracket prefixes; custom types are auto-detected.
- **Real-Time Sync**: Instant updates across all clients via WebSocket broadcasts for simulator availability, wellness waitlists, member directory changes, cafe menu updates, facility closures/notices, and announcements. No page refresh needed.
- **PWA Features**: Service Worker caching, offline support, safe area, overscroll prevention, and pull-to-refresh.
- **iOS-Style Interactions**: Haptic feedback, button bounce animations, segmented control, edge swipe back navigation, and swipeable list items.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling.
- **Trackman Historical Import**: Admin tool for importing CSV data with auto-matching to app bookings (±5 min tolerance), cancellation handling, and update-on-reimport. Import UI shows five sections: Unmatched → Requires Review → Potential Matches → Needs Players → Matched. Stores original player count in `trackman_player_count` for accurate fair usage calculations.
- **Trackman Import Enhancements (Phase 6)**:
  - Auto-match via `trackman_email` field (firstname.lastname@evenhouse.club format) before name matching
  - M:/G: notes parsing to extract multiple players from Trackman booking notes
  - "Requires Review" queue with fuzzy member matching suggestions for partial names (e.g., "Bobby S.")
  - Creates `booking_sessions` and `usage_ledger` entries for ALL players with proper session linking
  - Past imports default to payment_status='paid' (historical bookings assumed settled)
- **Multi-Member Booking System (Phase 1)**: 
  - Central `booking_sessions` table links bookings to Trackman imports and participants
  - Unified `booking_participants` table (owner/member/guest types) with display name snapshots
  - `usage_ledger` table tracks per-member time and fees with tier snapshots and payment_method (GUEST_PASS/CREDIT_CARD/UNPAID/WAIVED)
  - `guests` table for persistent guest tracking across bookings
  - `trackman_email` auto-generated for Trackman matching (firstname.lastname@evenhouse.club)
  - Social tier has 0 simulator guest passes (cannot bring guests)
- **Staff Check-In Tools (Phase 5)**:
  - Payment guard blocks check-in when unpaid balance exists (returns 402 status)
  - Check-in billing modal displays per-participant fee breakdown and individual payment status
  - Staff can mark individual payments, waive fees with required reason, or confirm all at once
  - `booking_payment_audit` table logs all staff payment actions (confirm, waive, tier override) with timestamps
  - Staff direct-add allows adding members/guests with tier override support and audit logging
  - Member notes field (280 chars) displayed on approval cards and booking details for staff visibility
- **Multi-Member Booking System (Phase 7)**:
  - **Auto-Expire Invites**: Pending member invites auto-expire 30 minutes before booking start time. Scheduler runs every 5 minutes, notifies booking owner when invites expire.
  - **Conflict Detection**: Prevents double-booking members. API checks booking_requests (owner), booking_participants (invites), and booking_members for overlapping times. Returns 409 with conflict details.
  - **Cancellation Cascade**: When owner cancels a booking, all roster members are notified. Guest passes are refunded if cancelled >24 hours in advance (no-show policy). Cleanup of booking_members and booking_participants handled atomically.
  - **Trackman Reconciliation**: Admin service compares declared vs actual player counts. Reconciliation endpoints (GET/PUT) for viewing discrepancies and marking as reviewed/adjusted. Fee adjustment tracking in usage_ledger and audit trail.
  - **Frontend Enhancements**: Conflict warning modal when adding members with scheduling conflicts. Expiry countdown badges show time remaining for pending invites. Structured error handling in apiRequest for conflict details.
- **Unified Conflict Validation**: All booking routes check closures, availability blocks, AND existing bookings via `checkAllConflicts` function
- **Fair Usage Tracking**: Time is split equally among all players for accurate usage calculations. Guest history is tracked and displayed in member profiles.
- **Modal Pattern**: Standardized, accessible, viewport-centered modal implementation.
- **Needs Review & Reconciliation Features**:
  - **Tours Needs Review**: HubSpot meetings without matching app records appear in Tours tab for staff to link, create tours from, or dismiss. Uses 5-minute cache to avoid API throttling.
  - **Events Needs Review**: Calendar events without bracket prefixes are flagged for staff to configure category/access. Uses `reviewDismissed` flag to persist staff decisions across syncs.
  - **Wellness Needs Review**: Wellness classes missing proper metadata flagged for staff configuration with same dismissal persistence.
- **Data Integrity Dashboard**: Admin-only page at /admin/data-integrity with comprehensive checks for orphan records, missing relationships, sync mismatches between app and external systems (HubSpot, Google Calendar), and data quality issues. Accessible from Employee Resources in admin settings.
- **Automated Integrity Checks**: Daily scheduler runs integrity checks at midnight Pacific time. If critical (error/warning) issues are detected, sends an email alert to the configured `ADMIN_ALERT_EMAIL` address with a summary breakdown and issue details. Uses Resend for email delivery.
- **Code Architecture**: Database schema and calendar modules have been refactored into domain-focused files for improved organization and maintainability.
- **Admin-Configurable Features**: Includes push notifications for announcements, 15-minute booking intervals for staff, RSVP management, promotional banner options, wellness class capacity and waitlists, and configurable closure reasons and notice types.

### Feature Specifications
- **Public Pages**: Landing, Login, Contact, FAQ, Gallery, Membership details, Cafe Menu.
- **Member-Only Pages**: Dashboard, Book Golf, Updates, Events, Profile, Wellness.
- **Staff/Admin Portal**: Dedicated interfaces for managing members, events, bookings, content, and system configurations.
- **API Endpoints**: Comprehensive REST API supporting all application functionalities.

## External Dependencies
-   **Verification Code Authentication**: Email-based OTP via Resend.
-   **HubSpot CRM**: Integrated for contact and member management, utilizing Replit Connectors.
    - **Two-Way Sync**: Communication preferences (email/SMS opt-in) sync bidirectionally between the app and HubSpot via `eh_email_updates_opt_in` and `eh_sms_updates_opt_in` properties.
    - **Background Sync**: Member data pulls from HubSpot every 5 minutes, including interest flags (golf, cafe, events, workspace).
    - **Visit Count Push**: When a member checks in at a simulator, their lifetime visit count updates in HubSpot (`total_visit_count` property).
    - **Profile Preferences**: Members can toggle email/SMS updates in their Profile settings; changes push to HubSpot in real-time.
    - **Tour Scheduling Sync**: Tours scheduled via HubSpot scheduler sync directly to the app database using HubSpot Meetings API. Matches by guest email + date/time window (±15 min). Supports backfilling legacy Google-synced tours. Google Calendar fallback available via `?source=calendar` query parameter.
    - **Tier Management (Phase 1)**: Admins can edit member tiers directly from the member profile drawer. Changes push to HubSpot in real-time with audit logging. Directory shows raw tier values including "No Tier" for members needing assignment.
    - **HubSpot Webhooks**: Endpoint at `/api/hubspot/webhooks` receives real-time updates when contacts or deals change in HubSpot. Validates signatures using HMAC-SHA256 with `HUBSPOT_WEBHOOK_SECRET`. Invalidates cache and broadcasts updates to all connected clients. Configure in HubSpot with events: contact.propertyChange, deal.propertyChange, deal.creation.
-   **HubSpot Forms**: Application forms submit to HubSpot Forms API.
-   **Eventbrite**: Syncs members-only events and attendee information.
-   **Google Calendar**: Three-calendar integration for sync (MBO_Conference_Room, Public/Member Events, Wellness & Classes). Note: Golf/simulator bookings are handled in-app only and no longer sync to Google Calendar.
-   **MindBody Conference Room Sync**: Automatic syncing of conference room bookings from MindBody (via Google Calendar) to `booking_requests`.
-   **Apple Messages for Business**: Direct messaging support.
-   **Amarie Aesthetics MedSpa**: Direct booking link for wellness services.
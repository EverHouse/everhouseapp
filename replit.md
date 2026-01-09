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
- **PWA Features**: Service Worker caching, offline support, safe area, overscroll prevention, and pull-to-refresh.
- **iOS-Style Interactions**: Haptic feedback, button bounce animations, segmented control, edge swipe back navigation, and swipeable list items.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling.
- **Trackman Historical Import**: Admin tool for importing CSV data with auto-matching to app bookings (±5 min tolerance), cancellation handling, and update-on-reimport. Import UI shows four sections: Unmatched → Potential Matches → Needs Players → Matched. Stores original player count in `trackman_player_count` for accurate fair usage calculations.
- **Multi-Member Bookings**: Supports linking multiple members and guests to a single booking via `booking_members` and `booking_guests` tables. ManagePlayersModal allows staff to assign players with predictive search, tier display, and owner lock. Members see linked bookings on their dashboard with "Player" badge and "Booked by" attribution.
- **Fair Usage Tracking**: Time is split equally among all players for accurate usage calculations. Guest history is tracked and displayed in member profiles.
- **Modal Pattern**: Standardized, accessible, viewport-centered modal implementation.
- **Calendar Import "Needs Review" Feature**: Calendar sync auto-imports events, flagging those without bracket prefixes as `needsReview` for staff configuration.
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
-   **HubSpot Forms**: Application forms submit to HubSpot Forms API.
-   **Eventbrite**: Syncs members-only events and attendee information.
-   **Google Calendar**: Three-calendar integration for sync (MBO_Conference_Room, Public/Member Events, Wellness & Classes). Note: Golf/simulator bookings are handled in-app only and no longer sync to Google Calendar.
-   **MindBody Conference Room Sync**: Automatic syncing of conference room bookings from MindBody (via Google Calendar) to `booking_requests`.
-   **Apple Messages for Business**: Direct messaging support.
-   **Amarie Aesthetics MedSpa**: Direct booking link for wellness services.
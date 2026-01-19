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
- **Member Management**: Supports member tiers, tags, comprehensive member directory with history and notes, and family billing with primary payer and add-on members.
- **Booking System**: Supports "Request & Hold," conflict detection, staff-initiated bookings, member rescheduling, multi-member bookings with fair usage tracking, and calendar management. Includes features for staff check-in, payment guards, fee waiving, and Trackman import/reconciliation. Guardian consent for minors is integrated.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications & Notices**: In-app real-time notifications and a database-tracked sequential notice dismissal system with 3-channel delivery (database + push + real-time) and user targeting.
- **Real-Time Sync**: Instant updates across clients via WebSocket.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Action Management**: `useAsyncAction` hook prevents double-tap submissions, provides loading states, and error handling. Toast component prevents stacking identical messages and supports key-based updates.
- **Performance Optimizations**: List virtualization using `react-window` for large lists, skeleton loaders, optimized CSS glass effects, lazy-loaded admin tabs, and optimistic updates for booking actions.
- **Directory Layout**: Member directory uses flex layout filling available viewport height. Lists scroll internally without page scroll. Scroll fade gradients (top/bottom) indicate scrollability on both mobile and desktop. Row heights: mobile 180px, desktop 56px.
- **Bookings Layout**: Simulator bookings page uses split panel layout on desktop. Left panel (queue/scheduled) and right panel (calendar grid) scroll independently. Date picker header stays fixed. Scroll fade gradients on both panels.
- **Admin Tools**: Admin-configurable features (push notifications, booking intervals, RSVP, banners, capacity, waitlists, closure reasons), data integrity dashboard with email alerts, data migration tools (Mindbody), and self-service recovery tools.
- **Privacy Compliance**: Includes a Privacy modal for App Store compliance with links to policy/TOS and account deletion. CCPA/CPRA compliance features like "Do Not Sell/Share My Info" toggle, "Request Data Export," and PII anonymization.
- **Waiver Management**: Tracks waiver versions, requires signing on login via a non-dismissible modal.
- **Member Lookup**: Centralized `MemberService` handles member data lookups by various identifiers with caching.
- **Billing Management**: Staff Payments Dashboard for full POS functionality. Unified payment history for members from multiple sources. Staff can manage member billing (subscriptions, credits, discounts) via a dedicated tab in the member profile. Members have a self-service billing portal to view subscriptions and invoices.

## External Dependencies
- **Stripe Payments**: Integrated for in-app payment collection, customer management, subscription management, payment tracking, HubSpot sync, and webhook processing.
- **Resend**: Used for email-based OTP verification and automated email alerts.
- **HubSpot CRM**: Integrated for contact and member management, two-way sync of communication preferences, background sync of member data, visit count push, profile preference updates, tour scheduling sync, tier management, and webhooks. Handles tier logic, join date mapping, notes sync, and communication log sync.
- **HubSpot Forms**: Application forms submit to the HubSpot Forms API.
- **Eventbrite**: Syncs members-only events and attendee information.
- **Google Calendar**: Integrates with MBO_Conference_Room, Public/Member Events, and Wellness & Classes calendars.
- **Apple Messages for Business**: Direct messaging support.
- **Amarie Aesthetics MedSpa**: Direct booking link for wellness services.
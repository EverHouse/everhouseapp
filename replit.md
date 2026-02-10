# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to streamline golf simulator bookings, wellness service appointments, and club event management. The application aims to boost member engagement, optimize operational workflows, and provide a unified digital experience. The long-term vision is to establish it as a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building to enhance member satisfaction and operational efficiency.

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
The application is built with a React 19 frontend (Vite, Tailwind CSS) and an Express.js backend, utilizing a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism) with WCAG AA compliance.
- **Typography**: Playfair Display for headlines, Inter for body text.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header, Member Bottom Nav, and Admin route-based navigation with a comprehensive sidebar.
- **Responsiveness**: Optimized for mobile, tablet, and desktop.
- **Theming**: Light, Dark, and System themes with local persistence.
- **Motion**: Pure CSS keyframe animations, staggered content, parallax, and entry/exit animations.
- **Drawer UX**: SlideUpDrawer for modals with drag-to-dismiss.
- **Staff FAB**: Floating action button for quick staff actions (Staff Command Center).
- **ConfirmDialog**: Custom Liquid Glass styled confirmation dialogs.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Timezone Handling**: All date/time operations prioritize 'America/Los_Angeles'.
- **Backend**: Modular API routes, core services, loader modules, health checks, graceful shutdown.
- **Member Management**: Supports tiers, tags, directory, unified billing groups, member notes, communications log, visitor matching, and a database-driven flexible tier features system.
- **Booking System**: "Request & Hold," conflict detection, staff/member bookings, multi-member bookings, calendar management, conference room bookings, transactional with row-level locking. A unified Player Management Modal (TrackmanLinkModal) handles all player/roster management.
- **Trackman Integration**: 1:1 sync with CSV imports and webhooks for real-time booking and delta billing, including cancellation flow and reconciliation tools.
- **Google Sign-In**: Members can sign in with Google or link accounts.
- **Security**: Role-based access control, rate limiting, SQL injection prevention, webhook signature verification, secure session management, CORS origin whitelist, authentication middleware.
- **Notifications**: In-app real-time notifications with 3-channel delivery (in-app, email, push).
- **Real-Time Sync**: Instant updates via WebSocket and Supabase Realtime.
- **PWA Features**: Service Worker caching, offline support, and automatic cache invalidation.
- **Error Handling**: PageErrorBoundary for chunk load failures, exponential backoff for retries, API error logging, error alerts.
- **Performance**: List virtualization, skeleton loaders, lazy-loading, optimistic updates.
- **State Management**: Zustand for atomic state and TanStack Query for data fetching.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, staff command center, data tools, bug report management, FAQ management, gallery management, inquiry management.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA features, account deletion, data export, admin audit log.
- **Waiver Management**: Tracks waiver versions and enforces signing.
- **Unified Fee Service**: Centralized `computeFeeBreakdown()` in `server/core/billing/unifiedFeeService.ts` for all fee calculations.
- **Dynamic Pricing**: Guest fee and overage rates pulled from Stripe product prices and updated via webhooks. Pricing config in `server/core/billing/pricingConfig.ts`.
- **Webhook Safety**: Transactional dedup for Stripe webhooks, deferred action pattern, resource-based ordering.
- **Roster Protection**: Optimistic locking with `roster_version` and row-level locking.
- **Billing Management**: Staff Payments Dashboard, unified payment history, member billing, self-service portal, tier change wizard with proration, dunning, card expiry checking, and refund processing.
- **Day Pass System**: Non-member day pass purchases with visitor matching and QR code delivery.
- **QR Code System**: QR codes for day passes and member check-in; staff QR scanner confirms member details.
- **ID/License Scanning**: Staff can scan IDs using OpenAI Vision (GPT-4o) to extract and auto-fill registration form fields, with images stored and viewable in member profiles.
- **Corporate Membership**: Unified billing groups, volume pricing, corporate checkout, HubSpot sync.
- **Data Integrity**: Stripe as source of truth for billing, transaction rollback, webhook idempotency, dual-source active tracking with HubSpot.
- **Stripe Member Auto-Fix**: Login flow verifies Stripe subscription status and corrects `membership_status`.
- **Stripe Subscription → HubSpot Sync**: Automated sync of membership status and tier.
- **Booking Prepayment**: Creates prepayment intents for expected fees, blocking check-in until paid, with auto-refunds on cancellation.
- **Stripe Customer Metadata Sync**: User ID and tier synced to Stripe customer metadata.
- **Scheduled Maintenance**: Daily tasks for session cleanup, webhook log cleanup, Stripe reconciliation, grace period checks, booking expiry, duplicate cleanup, guest pass resets, stuck cancellation checks, member sync, unresolved Trackman checks, communication log sync.
- **Stripe Terminal Integration**: In-person card reader support for membership signup.
- **Stripe Product Catalog as Source of Truth**: Two-way sync between app and Stripe.
- **Google Sheets Integration**: Announcement sync.
- **Staff Training System**: Training sections managed via `server/routes/training.ts` with seed data.
- **Tours Management**: Tour scheduling and tracking.
- **Cafe/POS System**: Cafe item management, POS register for in-person sales.
- **Guest Pass System**: Monthly guest pass allocation, guest pass purchase, hold/consume flow.
- **Availability/Closures Management**: Bay availability blocks and club closure scheduling.
- **Job Queue**: Background job processing.
- **HubSpot Queue**: Queued sync operations to HubSpot, runs every 2 minutes.
- **User Merge**: Duplicate member merging.
- **Staff = VIP Rule**: All staff/admin/golf_instructor users are automatically treated as VIP members. Auth enforces `tier='VIP'` and `membership_status='active'` on every login. Booking fee service has a safety net that checks `staff_users` table and applies $0 fees. Roster UI shows "Staff" badge (display label) while database stores "VIP" (benefits tier) — intentional dual representation. `BookingMember.isStaff` flag is the explicit source of truth for staff detection.

## Recent Changes
- **v7.31.8 (2026-02-10)**: Trackman Import Matching & Unresolved Table Improvements — CSV import now matches bookings to non-members/visitors from local database (not just HubSpot contacts), unresolved bookings table shows Booking ID column instead of redundant Status.
- **v7.31.7 (2026-02-10)**: Outstanding Balance & Payment Receipt Details — staff can now see outstanding balance in member profile drawer's Billing tab (total owed + itemized unpaid fees). Stripe payment receipts show per-participant fee breakdown (e.g. "Guest: John Doe — $25.00, Overage — $25.00"). Staff-initiated charges also include breakdown. Fixed remaining hardcoded $25 guest fees.
- **v7.31.6 (2026-02-10)**: Billing Audit — Dynamic Pricing & Hardcoded Fee Fixes — fixed Trackman admin pending-assignment slot fee using hardcoded $25 instead of dynamic guest fee from Stripe. Staff simulator fee estimates now pull tier-specific daily minutes from the database instead of hardcoded values. Pricing API now exposes tier included minutes alongside guest fee and overage rate.
- **v7.31.4 (2026-02-10)**: POS Receipt Line Items — POS purchases now create Stripe Invoices with individual InvoiceItems so each product appears as a separate line item on Stripe dashboard and receipts. All three payment methods (terminal, online card, saved card) updated. Invoice items isolated per transaction to prevent leakage. Automatic cleanup on failure.
- **v7.31.3 (2026-02-10)**: Fee Display Fix & Code Cleanup — fixed booking card fee button showing $75 instead of $125 (was ignoring database-computed fees when player slots unfilled, and estimate was incorrectly dividing duration by player count instead of using full duration for owner overage). Removed 6 orphaned component files (~1,526 lines dead code), consolidated duplicate PlayerSlot type, removed unused TrackmanNotesModal, fixed Trackman needs-players SQL join.
- **v7.31.1 (2026-02-10)**: Guest Booking UX Improvements — split single "Guest name" field into "First name" and "Last name" for proper guest pass identification, fixed confusing "0 of 15 passes remaining" display by conditionally hiding passes row and showing "Enter guest details above to use passes" amber message when guest info is incomplete, updated eligibility checks to require firstName + lastName + email.
- **v7.31.0 (2026-02-10)**: Major Code Organization Refactoring — split 6 large files (2,000-3,500 lines each) into modular subdirectories, reducing main files by 23-94%. Created shared FeeBreakdownCard and PlayerSlotEditor components for reuse across member/staff interfaces. Consolidated duplicate utility functions (status badges, closure display logic) into shared utilities.
- **v7.30.2 (2026-02-10)**: Timezone & Reliability Fixes — future bookings query and user merge active session check now use Pacific time instead of UTC, removed dead duplicate billing portal route, Trackman session failure notes log warnings on save failure, payment confirmation handles corrupted fee data gracefully.
- **v7.30.1 (2026-02-10)**: Bug Fixes & Performance — closure sync no longer re-deactivates ~60 already-inactive closures every cycle, HubSpot products endpoint handles missing scopes gracefully, member-billing endpoint returns empty data instead of 404 for members without subscriptions.
- **v7.30.0 (2026-02-10)**: Calendar Sync Improvements — app-created events no longer flagged as drafts when synced to dev, deleted/cancelled Google Calendar events properly removed, default location set to club address.

## External Dependencies
- **Stripe**: Payment collection, subscription management, webhooks, terminal/POS, product catalog sync, dynamic pricing.
- **Resend**: Email-based OTP verification, automated alerts, transactional emails.
- **HubSpot CRM**: Contact and member management, two-way data sync, deal pipeline, corporate membership sync.
- **Google Calendar**: Integration for club calendars and booking sync.
- **Google Sheets**: Announcement content sync.
- **Supabase**: Realtime subscriptions, backend admin client, session token generation.
- **OpenAI Vision (GPT-4o)**: ID/License scanning and data extraction.
- **Trackman**: Golf simulator booking sync, CSV imports, webhook events, billing reconciliation.
- **MindBody**: Legacy member data import and customer sync.
- **Eventbrite**: Members-only event synchronization.
- **Amarie Aesthetics MedSpa**: Direct booking links (wellness page integration).
- **Apple Messages for Business**: Direct messaging link (contact page).
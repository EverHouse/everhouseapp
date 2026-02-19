# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to streamline golf simulator bookings, wellness service appointments, and club event management. The application aims to boost member engagement, optimize operational workflows, and provide a unified digital experience. The long-term vision is to establish it as a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building to enhance member satisfaction and operational efficiency.

## User Preferences
- **CRITICAL: Communication Style** - The founder is non-technical. Always explain changes in plain English, focusing on how they affect the member/staff experience or business operations. Avoid jargon like "ORM," "WebSocket," "orchestration," "middleware," etc. If a technical term is necessary, explain it simply first (e.g., "the notification system" instead of "WebSocket server").
- **CRITICAL: Pacific Timezone (America/Los_Angeles) is THE FIRST PRIORITY for any date/time operations.** All time comparisons must use Pacific time utilities, never local server time.
- **CRITICAL: Changelog Updates** - Update `src/data/changelog.ts` after EVERY significant change, not just when asked. Each feature or fix should be documented immediately. Bump version numbers appropriately (patch for fixes, minor for features, major for breaking/significant changes). Mark major releases with `isMajor: true`.
- **CRITICAL: Staff Activity Logging** - ALL staff actions must be logged to the audit system using `logFromRequest()` from `server/core/auditLog.ts`. When adding new staff features, always add audit logging with appropriate action type, resource type, resource ID/name, and relevant details. Add new action types to `AuditAction` type if needed. This ensures all staff activity appears in the Staff Activity feed on the Changelog page.
- **CRITICAL: Load Skills Before Answering** - Before answering questions about, debugging, or modifying any system covered by a skill (see Skill Auto-Update Protocol table at bottom), ALWAYS read the relevant SKILL.md file first. Match the user's question to the skill by topic: bookings → booking-flow, payments/webhooks → stripe-webhook-flow, members → member-lifecycle, HubSpot → hubspot-sync, fees → fee-calculation, data checks → data-integrity-monitoring, check-in → checkin-flow, notifications → notification-system, guest passes → guest-pass-system, scheduled jobs → scheduler-jobs. Load the skill BEFORE searching code or answering. Read reference files in the skill's `references/` folder when deeper detail is needed.
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
- **Motion**: Spring-physics motion system with tokenized duration scale and easing curves. Uses `@formkit/auto-animate` for list reflow animations, CSS grid for smooth expand/collapse, tactile utility classes for hover lift + press-down feedback, and various animations for transitions and loading states. All motion respects `prefers-reduced-motion`.
- **Drawer UX**: `SlideUpDrawer` for modals with drag-to-dismiss.
- **Staff FAB**: Floating action button for quick staff actions (Staff Command Center).
- **ConfirmDialog**: Custom Liquid Glass styled confirmation dialogs.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Timezone Handling**: All date/time operations prioritize 'America/Los_Angeles'.
- **Backend**: Modular API routes, core services, loader modules, health checks, graceful shutdown.
- **Member Management**: Supports tiers, discount tracking, directory, billing groups, member notes, communications log, visitor matching, and flexible tier features.
- **Booking System**: "Request & Hold," conflict detection, staff/member bookings, multi-member bookings, calendar management, conference room bookings, transactional with row-level locking. Player Management Modal handles all player/roster management. Players added to bookings are auto-confirmed.
- **Trackman Integration**: 1:1 sync with CSV imports and webhooks.
- **Google Sign-In**: Members can sign in with Google or link accounts.
- **Error Handling**: Shared `server/utils/errorUtils.ts` utility for safe error handling.
- **Security**: Role-based access control, rate limiting, SQL injection prevention, webhook signature verification, secure session management, CORS origin whitelist, authentication middleware.
- **Notifications**: In-app real-time notifications with 3-channel delivery (in-app, email, push).
- **Real-Time Sync**: Instant updates via WebSocket and Supabase Realtime.
- **PWA Features**: Service Worker caching, offline support, and automatic cache invalidation.
- **Performance**: List virtualization, skeleton loaders, lazy-loading, optimistic updates.
- **State Management**: Zustand for atomic state and TanStack Query for data fetching.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, staff command center, data tools, bug report management, FAQ management, gallery management, inquiry management, application pipeline.
- **Member Onboarding System**: 4-step onboarding checklist, tracks key dates, welcome modal, automated email nudges, and admin view.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA features, account deletion, data export, admin audit log.
- **Waiver Management**: Tracks waiver versions and enforces signing.
- **Unified Fee Service**: Centralized `computeFeeBreakdown()` for all fee calculations, including overage and remainder minute handling.
- **Dynamic Pricing**: Guest fee and overage rates pulled from Stripe product prices and updated via webhooks.
- **Webhook Safety**: Transactional dedup, deferred action pattern, resource-based ordering, subscription sync race condition guard.
- **Roster Protection**: Optimistic locking with `roster_version` and row-level locking.
- **Billing Management**: Staff Payments Dashboard, unified payment history, member billing, self-service portal, tier change wizard with proration, dunning, card expiry checking, and refund processing.
- **Day Pass System**: Non-member day pass purchases with visitor matching and QR code delivery.
- **QR Code System**: QR codes for day passes and member check-in; staff QR scanner confirms member details.
- **ID/License Scanning**: Staff can scan IDs using OpenAI Vision (GPT-4o) to extract and auto-fill registration form fields.
- **Corporate Membership**: Unified billing groups, volume pricing, corporate checkout, HubSpot sync.
- **Data Integrity**: Stripe as source of truth for billing, transaction rollback, webhook idempotency, dual-source active tracking with HubSpot. Stripe is authoritative for `membership_status` and `tier` when `billing_provider='stripe'`.
- **Stripe Member Auto-Fix**: Login flow verifies Stripe subscription status and corrects `membership_status`.
- **Stripe Subscription → HubSpot Sync**: Automated sync of membership status, tier, billing_provider, and Stripe contact fields. App is the single writer to HubSpot contacts.
- **Booking Prepayment**: Creates prepayment intents for expected fees, blocking check-in until paid, with auto-refunds on cancellation.
- **Stripe Customer Metadata Sync**: User ID and tier synced to Stripe customer metadata.
- **Scheduled Maintenance**: Daily and hourly tasks for various system cleanups, reconciliations, and member syncs.
- **Stripe Terminal Integration**: In-person card reader support for membership signup, with card saving for future renewals.
- **Stripe Product Catalog as Source of Truth**: Two-way sync between app and Stripe.
- **Google Sheets Integration**: Announcement sync.
- **Staff Training System**: Training sections managed via `server/routes/training.ts` with seed data.
- **Tours Management**: Native tour scheduling with Google Calendar integration, 2-step booking flow, server-side conflict detection, configurable business hours and slot duration. Public endpoint.
- **Cafe/POS System**: Cafe item management, POS register for in-person sales.
- **Guest Pass System**: Monthly guest pass allocation, guest pass purchase, hold/consume flow.
- **Availability/Closures Management**: Bay availability blocks and club closure scheduling.
- **Job Queue**: Background job processing.
- **HubSpot Queue**: Queued sync operations to HubSpot.
- **User Merge**: Duplicate member merging.
- **Staff = VIP Rule**: All staff/admin/golf_instructor users are automatically treated as VIP members with $0 fees and a "Staff" badge in the UI.

## External Dependencies
- **Stripe**: Payment collection, subscription management, webhooks, terminal/POS, product catalog sync, dynamic pricing.
- **Resend**: Email-based OTP verification, automated alerts, transactional emails.
- **HubSpot CRM**: Contact and member management, two-way data sync, deal pipeline, corporate membership sync, form submissions.
- **Google Calendar**: Integration for club calendars and booking sync.
- **Google Sheets**: Announcement content sync.
- **Supabase**: Realtime subscriptions, backend admin client, session token generation.
- **OpenAI Vision (GPT-4o)**: ID/License scanning and data extraction.
- **Trackman**: Golf simulator booking sync, CSV imports, webhook events, billing reconciliation.
- **MindBody**: Legacy member data import and customer sync.
- **Eventbrite**: Members-only event synchronization.
- **Amarie Aesthetics MedSpa**: Direct booking links (wellness page integration).
- **Apple Messages for Business**: Direct messaging link (contact page).
- **Stripe MCP**: Connected as an MCP server for development — allows direct lookup of customers, subscriptions, payments, products, prices, invoices, disputes, and Stripe documentation without needing screenshots from the dashboard.

## Future Considerations
- **Stripe Agent Toolkit**: Could power a staff AI assistant for conversational Stripe operations (e.g., "generate a payment link for John" or "look up Sarah's last 3 payments"). Uses `@stripe/agent-toolkit` with OpenAI/Vercel AI SDK. Not needed currently since all billing operations are handled through purpose-built admin tools, but worth revisiting once core billing is fully stable. Stripe recommends sandbox testing first since agent behavior is non-deterministic. Use restricted API keys (`rk_*`) for security.
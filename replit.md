# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application designed for golf and wellness centers. Its core purpose is to streamline the management of golf simulator bookings, wellness service appointments, and club events. The project aims to create a central digital hub for private members clubs, providing comprehensive tools for membership management, facility booking, and community building, ultimately enhancing member satisfaction and operational efficiency.

## User Preferences
- **Skill-Driven Development**: We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).
- **Changelog Updates**: Every session that produces user-facing changes MUST end with an update to `src/data/changelog.ts` and `src/data/changelog-version.ts`. Group related changes into versioned entries (bump minor version per logical feature/fix group). Never leave a session without updating the changelog — members see this in-app.

## System Architecture

### Core Architecture & Data Flow
- **Naming Conventions**: `snake_case` for PostgreSQL tables/columns; `camelCase` for Drizzle schemas, API JSON payloads, and React/TypeScript frontend. Raw database rows must not be exposed in API responses.
- **Type Safety**: Fix underlying schemas or DTOs to resolve TypeScript mismatches; avoid using `as any`.
- **Database Interaction**: Use Drizzle ORM query builders or parameterized `sql` template literals for all SQL queries; raw string-interpolated SQL is forbidden.
- **Timezone**: All date/time operations must explicitly use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged using `logFromRequest()`.
- **API/Frontend Consistency**: API response field names must align exactly with frontend TypeScript interfaces.

### UI/UX & Frontend
- **Design System**: Liquid Glass UI system, utilizing Tailwind CSS v4 and supporting dark mode.
- **Interactions**: Features spring-physics for motion and drag-to-dismiss functionality.
- **Technology Stack**: React 19, Vite, and state management using Zustand/TanStack libraries.
- **Component Design**: Sheets and modals follow a structure of a Header (title and close "X"), a scrollable Body for content, and a Sticky Footer for actions.
- **Button Hierarchy**: Differentiates between primary actions, secondary actions (as ghost links), and destructive actions.
- **Fee Recalculation**: Roster changes trigger server-side fee recalculation, with visual feedback for loading states on the Financial Summary.

### Core Domain Features
- **Booking & Scheduling**: Implements a "Request & Hold" model, unified participant management, calendar synchronization, and an auto-complete scheduler.
- **Fees & Billing**: Features a unified fee service, dynamic pricing, prepayment, and guest fees, based on a "one invoice per booking" architecture. It supports dual payment paths (PaymentIntent for online, draft Stripe invoice for auto-approvals). The system handles existing payments to prevent double-charging and utilizes Stripe customer credit balances. Roster edits are blocked post-payment without staff override. Invoice lifecycle transitions through Draft, Finalize, and Pay/Void.
- **Database & Data Integrity**: Uses PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints.
- **Member Lifecycle**: Includes membership tiers, QR/NFC check-in, and onboarding processes.
- **Real-time Updates**: Implements WebSocket broadcasting for booking and invoice changes.

### Enforced Code Conventions
- **Error Handling**: Empty catch blocks are prohibited; all `catch` blocks must re-throw, log, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes must be protected by authentication.
- **Stripe Webhook Safety**: Webhook handlers modifying member status must include a `billing_provider` guard. Invoice payment failure handlers must verify `subscription_id` to prevent stale invoices from affecting active members. Async payment handlers must construct identical payloads to synchronous counterparts and throw errors on failure for Stripe retries.
- **Booking Race Condition Guards**: `approveBooking()`, `declineBooking()`, and `checkinBooking()` implement status guards and optimistic locking.
- **Rate Limiting**: All public endpoints creating database records must have rate limiting.
- **Unbounded Queries**: All SELECT queries must have a LIMIT clause or be naturally bounded.
- **Scheduler Lifecycle**: All `setInterval()` in schedulers must return their timer ID for shutdown cleanup.
- **Route Authentication Audit**: Both middleware guards and inline `getSessionUser(req)` checks are used, with middleware preferred for staff/admin routes.

## External Dependencies
- **Stripe**: Payment processing, subscriptions, and webhooks.
- **HubSpot**: Two-way data synchronization and form submissions.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (ID scanning).
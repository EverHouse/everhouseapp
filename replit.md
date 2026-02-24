# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to manage golf simulator bookings, wellness service appointments, and club events, aiming to enhance member engagement and optimize operations. The project's vision is to become a central digital hub for private members clubs, offering comprehensive tools for membership, facility booking, and community building to improve member satisfaction and operational efficiency.

## User Preferences
- **Skill-Driven Development**: We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

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
- **Button Hierarchy**: Differentiates between primary actions, secondary actions (as ghost links), and destructive actions. Buttons within scrollable bodies must have `type="button"`.
- **Fee Recalculation**: Roster changes trigger server-side fee recalculation, with visual feedback for loading states on the Financial Summary.

### Core Domain Features
- **Booking & Scheduling**: Implements a "Request & Hold" model, unified participant management, calendar synchronization, and an auto-complete scheduler that marks past bookings as `attended`.
- **Fees & Billing**: Features a unified fee service, dynamic pricing, prepayment capabilities, and guest fees, based on a "one invoice per booking" architecture. It supports dual payment paths: staff-approved bookings use a PaymentIntent for online payment, while Trackman auto-approvals create a draft Stripe invoice. The system `finalizeAndPayInvoice()` method intelligently handles existing payments to prevent double-charging. Both simulator and conference room bookings utilize a unified invoice-based flow, auto-applying Stripe customer credit balances. Roster edits are blocked post-payment unless a force-override with a reason is provided by staff. Invoice lifecycle transitions through Draft, Finalize, and Pay/Void states.
- **Database & Data Integrity**: Uses PostgreSQL, Supabase Realtime, and Drizzle ORM with CASCADE constraints on `wellness_enrollments.class_id` and `booking_participants.session_id`.
- **Member Lifecycle**: Includes membership tiers, QR/NFC check-in, and onboarding processes.

### Enforced Code Conventions
- **Error Handling**: Empty catch blocks are prohibited; all `catch` blocks must re-throw, log via `logger.debug`/`logger.warn`, or use `safeDbOperation()`.
- **Authentication**: All mutating API routes (POST/PUT/PATCH/DELETE) must be protected by authentication.
- **Stripe Webhook Safety**: Webhook handlers modifying member status must include a `billing_provider` guard to prevent data overwrites from other systems.
- **Booking Race Condition Guards**: `approveBooking()`, `declineBooking()`, and `checkinBooking()` implement status guards and optimistic locking to prevent race conditions and ensure data integrity.
- **Real-time Updates**: Implements WebSocket broadcasting for booking and invoice changes, ensuring staff and members receive real-time updates.

## External Dependencies
- **Stripe**: For payment processing, subscriptions, and webhooks.
- **HubSpot**: Used for two-way data synchronization and form submissions.
- **Communications**: Handles in-app notifications, push notifications, and email via Resend.
- **Other**: Integrations include Trackman (for booking CSV/webhooks), Eventbrite, Google Sheets, and OpenAI Vision (for ID scanning).
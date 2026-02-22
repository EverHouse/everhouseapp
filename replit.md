# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to streamline golf simulator bookings, wellness service appointments, and club event management. The application aims to boost member engagement, optimize operational workflows, and provide a unified digital experience. The long-term vision is to establish it as a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building to enhance member satisfaction and operational efficiency.

## User Preferences
- **Skill-Driven Development**: We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## System Architecture

### Core Architecture & Data Flow

#### Camel-to-Snake Boundary Map
- **Database (PostgreSQL)**: `snake_case` for tables and columns.
- **ORM (Drizzle)**: `camelCase` for schemas, bridging DB columns to TS properties.
- **API / JSON**: `camelCase` for all `res.json()` payloads. Raw DB rows must not be leaked.
- **Frontend (React/TS)**: `camelCase` for component props and state, strictly typed.

Additional rules:
- **TypeScript Mismatches**: Fix underlying schema or DTOs; avoid `as any`.
- **External Property Mappings (HubSpot)**: Consult `hubspot-sync` skill for exact property names.
- **SQL Security**: Use Drizzle ORM query builders or parameterized `sql` template literals. Raw string-interpolated SQL is forbidden.

### UI/UX & Interaction Standards
We use a **Liquid Glass UI** system.

#### Sheet/Modal Design
- **Header**: Title and close "X".
- **Body**: Scrollable for data entry.
- **Sticky Footer**: Fixed at bottom, contains Primary and Secondary Actions.

#### Button Hierarchy & Logic
- **Primary Action**: "Collect" if balance > $0, "Check In" if $0 balance.
- **Secondary Actions**: Reschedule and Cancel, as ghost text links.
- **Destructive Actions**: "Void All Payments" in payment drawer.
- Buttons in scrollable bodies must have `type="button"`.
- Only Sticky Footer actions handle sheet lifecycle.

#### Fee Recalculation
- All roster changes trigger automatic server-side fee recalculation.
- Visual Feedback: Subtle loading states (opacity or skeleton) for Financial Summary.

### System Non-Negotiables
- **Timezone**: All date/time operations must use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged using `logFromRequest()`.
- **API/Frontend Consistency**: API response field names must exactly match frontend TypeScript interfaces.

### UI/UX & Frontend
- **Design System & Styling**: Liquid Glass UI, Tailwind CSS v4, dark mode.
- **Interactions & Motion**: Spring-physics, drag-to-dismiss.
- **React & Framework**: React 19, Vite, state management (Zustand/TanStack).

### Core Domain
- **Booking & Scheduling**: "Request & Hold" model, unified participants, calendar sync. Auto no-show scheduler (every 2h) marks approved/confirmed bookings as `no_show` 24h after end time.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, guest fees. "One invoice per booking" architecture.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, Drizzle ORM. CASCADE constraints on `wellness_enrollments.class_id` and `booking_participants.session_id`.
- **Member Lifecycle & Check-In**: Tiers, QR/NFC check-in, onboarding.

## Enforced Code Conventions (Audit-Verified Feb 2026)
The following conventions were comprehensively audited and enforced across the entire server codebase. All violations have been fixed. Future code must maintain these standards:

### Error Handling
- **Empty catch blocks are BANNED.** Every `catch` must either re-throw, log via `logger.debug`/`logger.warn`, or use `safeDbOperation()`. 60 violations fixed across 33 files.
- Use `logger.debug` for expected/benign failures (JSON parse fallbacks, optional lookups). Use `logger.warn` for operationally meaningful errors (DB rollback failures, sync errors).

### Timezone
- **ALL `toLocaleDateString()` calls must include `timeZone: 'America/Los_Angeles'`** in the options object. No exceptions — not even for staff-only notifications or internal logging. 32 violations fixed (including 3 that incorrectly used `timeZone: 'UTC'`).
- Prefer `dateUtils.ts` Pacific timezone helpers over raw `Date` operations.

### Authentication
- **All mutating API routes (POST/PUT/PATCH/DELETE) must have auth protection** — either `isAuthenticated`/`isStaff` middleware or inline `getSessionUser()` + 401 check. 8 routes secured with middleware.
- Exceptions: login/auth endpoints, inbound webhooks (use signature verification), and intentionally public forms (tour booking, day pass checkout).

### Stripe Webhook Safety
- **All webhook handlers that modify member status must include a `billing_provider` guard** — skip processing if the member's `billing_provider !== 'stripe'`. 6 handlers secured.
- This prevents Stripe webhooks from overwriting status for members billed through other systems.

### Database
- 3 missing FK indexes added on `event_rsvps` and `wellness_enrollments` to prevent slow JOINs.

### Booking Race Condition Guards
- **`approveBooking()` has status guard + optimistic lock** — only allows approval from `pending`/`pending_approval` status. UPDATE WHERE clause includes status condition to prevent double-approve race creating duplicate sessions/participants/calendar events. Returns 409 on conflict.
- **`declineBooking()` has status guard** — only allows declining from `pending`/`pending_approval` status. Approved bookings must use cancel flow instead (which handles cleanup of sessions, participants, calendar events).
- **`checkinBooking()` payment confirmation moved after atomic status update** — prevents payment confirmations from persisting when the booking status has been changed by another concurrent request.

## Recent Changes
- **Feb 2026**: Deep architectural audit — fixed 60 empty catch blocks, 75+ timezone violations (server + frontend), 16 unprotected async routes, 6 webhook guard gaps, 3 missing DB indexes, 3 critical booking race conditions (double-approve, decline-after-approve, checkin payment ordering), enhanced placeholder account detection across 60+ files.

## External Dependencies
- **Stripe**: Terminal, subscriptions, webhooks for billing authority.
- **HubSpot**: Two-way sync, form submissions.
- **Communications**: In-app, push, email via Resend (inbound emails via webhooks targeting `/api/webhooks/resend-inbound`).
- **Other**: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).
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
- **Booking & Scheduling**: "Request & Hold" model, unified participants, calendar sync.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, guest fees. "One invoice per booking" architecture.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, Drizzle ORM.
- **Member Lifecycle & Check-In**: Tiers, QR/NFC check-in, onboarding.

## External Dependencies
- **Stripe**: Terminal, subscriptions, webhooks for billing authority.
- **HubSpot**: Two-way sync, form submissions.
- **Communications**: In-app, push, email via Resend (inbound emails via webhooks targeting `/api/webhooks/resend-inbound`).
- **Other**: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).
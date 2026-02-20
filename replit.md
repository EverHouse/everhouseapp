# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to streamline golf simulator bookings, wellness service appointments, and club event management. The application aims to boost member engagement, optimize operational workflows, and provide a unified digital experience. The long-term vision is to establish it as a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building to enhance member satisfaction and operational efficiency.

## User Preferences
CRITICAL: Skill-Driven Development - We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.

CRITICAL: Mandatory Verification - You must NEVER complete a task or claim to be done without first explicitly invoking the verification-before-completion skill to check for Vite compilation errors, TypeScript warnings, and dev server health.

Communication Style - The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.

Development Approach - Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

System Non-Negotiables:

Timezone: All date/time operations must strictly prioritize Pacific Time (America/Los_Angeles).

Changelog: Update src/data/changelog.ts after EVERY significant change.

Audit Logging: ALL staff actions must be logged using logFromRequest() from server/core/auditLog.ts.

API/Frontend Consistency: Ensure API response field names EXACTLY match frontend TypeScript interfaces to avoid data mapping errors.

## System Architecture & Implementation
Our system architecture, UI/UX, and external integrations are strictly governed by our installed Agent Skills. Do not guess or assume implementation details—always load the associated skill first.

UI/UX & Frontend
Design System & Styling: Liquid Glass UI, Tailwind CSS v4, dark mode. Required Skills: ui-ux-pro-max, frontend-design, tailwind-design-system.

Interactions & Motion: Spring-physics, drag-to-dismiss. Required Skills: interaction-design, auto-animate.

React & Framework: React 19, Vite, state management (Zustand/TanStack). Required Skills: react-dev, vite, vercel-react-best-practices.

Core Domain & Technical Implementation
Project Map: Always consult project-architecture before touching, moving, or planning files.

Booking & Scheduling: "Request & Hold" model, unified participants, calendar sync. Required Skills: booking-flow, booking-import-standards.

Fees & Billing: Unified fee service, dynamic pricing, prepayment, guest fees. Required Skills: fee-calculation, billing-automation.

Database & Data Integrity: PostgreSQL, Supabase Realtime, Drizzle ORM. Required Skills: postgres-drizzle, supabase-postgres-best-practices, data-integrity-monitoring.

Member Lifecycle & Check-In: Tiers, QR/NFC check-in, onboarding. Required Skills: member-lifecycle, checkin-flow, guest-pass-system.

Maintenance: Required Skills: scheduler-jobs.

External Dependencies & Integrations
Payments (Stripe): Terminal, subscriptions. Required Skills: stripe-integration, stripe-webhook-flow.

CRM (HubSpot): Two-way sync, form submissions. Required Skills: hubspot-integration, hubspot-sync.

Communications: In-app, push, email. Required Skills: resend, notification-system, email-best-practices.

Other: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).

Future Considerations
Consult strategy-advisor and brainstorming before proposing major architectural shifts (e.g., Stripe Agent Toolkit integration).
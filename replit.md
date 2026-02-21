# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application for golf and wellness centers. Its primary purpose is to streamline golf simulator bookings, wellness service appointments, and club event management. The application aims to boost member engagement, optimize operational workflows, and provide a unified digital experience. The long-term vision is to establish it as a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building to enhance member satisfaction and operational efficiency.

## The Prime Directive
Before every task, you MUST:
1. **Load Skills**: Identify the specific domain (e.g., `postgres-drizzle`, `ui-ux-pro-max`, `fee-calculation`) and load the relevant skill.
2. **Boundary Check**: Verify the Camel-to-Snake data map below. Never assume column names.
3. **Verification**: You are forbidden from claiming "Done" without running `verification-before-completion`. Evidence of success (logs/build status) is mandatory.

## User Preferences
- **Skill-Driven Development**: We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

### System Non-Negotiables
- **Timezone**: All date/time operations must strictly use Pacific Time (`America/Los_Angeles`).
- **Changelog**: Update `src/data/changelog.ts` after EVERY significant change.
- **Audit Logging**: ALL staff actions must be logged using `logFromRequest()` from `server/core/auditLog.ts`.
- **API/Frontend Consistency**: Ensure API response field names EXACTLY match frontend TypeScript interfaces.

## Core Architecture & Data Flow

### Camel-to-Snake Boundary Map
AI-generated casing mismatches are a critical source of bugs. Strictly adhere to this boundary map:

| Layer | Casing Style | Enforcement Rule |
| :--- | :--- | :--- |
| **Database (PostgreSQL)** | `snake_case` | Tables and columns MUST be lowercase with underscores. |
| **ORM (Drizzle)** | `camelCase` | Schemas MUST bridge DB columns to TS properties (e.g., `firstName: text('first_name')`). |
| **API / JSON** | `camelCase` | All `res.json()` payloads must be camelCase. **NEVER** leak raw DB rows. |
| **Frontend (React/TS)** | `camelCase` | Component props and state must be strictly typed. No `as any`. |

Additional rules:
- **TypeScript Mismatches**: Never forcefully cast types with `as any`. If frontend interfaces and backend Drizzle inferred types mismatch, fix the underlying schema or DTO rather than bypassing the compiler.
- **External Property Mappings (HubSpot)**: Never hallucinate CRM internal property names. Always consult the `hubspot-sync` skill for the exact, up-to-date property dictionary before writing sync payloads.

### SQL Security
- All database queries MUST use Drizzle ORM query builders or parameterized `sql` template literals.
- Raw string-interpolated SQL is forbidden. This was enforced via a 51-file refactoring pass (Feb 2026).

## UI/UX & Interaction Standards
We use a **Liquid Glass UI** system. Follow these rules to ensure consistency:

### Sheet/Modal Design
- **Header**: Contains title and close "X".
- **Body**: Scrollable area for data entry (e.g., Player Slots).
- **Sticky Footer**: Fixed at bottom. Contains Primary Action and Secondary Actions.

### Button Hierarchy & Logic
- **Primary Action**: Determined by payment status — "Collect" if balance > $0, "Check In" if $0 balance.
- **Secondary Actions**: Reschedule and Cancel, rendered as ghost text links below the primary button.
- **Destructive Actions**: "Void All Payments" lives inside the payment drawer, not the main footer.
- Buttons inside scrollable bodies MUST have `type="button"` to avoid accidental form submission.
- Only the final action in the Sticky Footer should handle the sheet's lifecycle.

### Fee Recalculation
- All roster changes (add/remove guest, link/unlink member, player count update) trigger **automatic server-side fee recalculation**. There is no manual "Recalculate" button — fees update in real time.
- Visual Feedback: Use subtle loading states (opacity or skeleton) in the Financial Summary while background math is updating.

## System Architecture & Skill Map
Our system architecture, UI/UX, and external integrations are strictly governed by our installed Agent Skills. Do not guess or assume implementation details — always load the associated skill first.

### UI/UX & Frontend
- **Design System & Styling**: Liquid Glass UI, Tailwind CSS v4, dark mode. Skills: `ui-ux-pro-max`, `frontend-design`, `tailwind-design-system`.
- **Interactions & Motion**: Spring-physics, drag-to-dismiss. Skills: `interaction-design`, `auto-animate`.
- **React & Framework**: React 19, Vite, state management (Zustand/TanStack). Skills: `react-dev`, `vite`, `vercel-react-best-practices`.

### Core Domain
- **Project Map**: Always consult `project-architecture` before touching, moving, or planning files.
- **Booking & Scheduling**: "Request & Hold" model, unified participants, calendar sync. Skills: `booking-flow`, `booking-import-standards`.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, guest fees. Skills: `fee-calculation`, `billing-automation`.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, Drizzle ORM. Skills: `postgres-drizzle`, `supabase-postgres-best-practices`, `data-integrity-monitoring`.
- **Member Lifecycle & Check-In**: Tiers, QR/NFC check-in, onboarding. Skills: `member-lifecycle`, `checkin-flow`, `guest-pass-system`.
- **Maintenance**: Skills: `scheduler-jobs`.

### External Integrations
- **Stripe**: Terminal, subscriptions. The "Stripe Wins" rule applies — all billing authority comes from Stripe webhooks. Skills: `stripe-integration`, `stripe-webhook-flow`.
- **HubSpot**: Two-way sync, form submissions. Never guess internal property names — consult `hubspot-sync` skill dictionary. Skills: `hubspot-integration`, `hubspot-sync`.
- **Communications**: In-app, push, email via Resend. All inbound emails handled via webhooks targeting `/api/webhooks/resend-inbound`. Skills: `resend`, `notification-system`, `email-best-practices`.
- **Other**: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).

### Future Considerations
Consult `strategy-advisor` and `brainstorming` before proposing major architectural shifts.

## Environment & Reference Variables
Do not guess or hallucinate environment variables. Use these exact keys:

- **Frontend (Vite/React)**: `import.meta.env.VITE_SUPABASE_URL`, `import.meta.env.VITE_SUPABASE_ANON_KEY`
- **Backend/Server Core**: `process.env.SUPABASE_URL`, `process.env.SERVICE_ROLE_KEY`, `process.env.SESSION_SECRET`
- **Feature Flags**: `process.env.DEV_LOGIN_ENABLED`, `process.env.ENABLE_TEST_LOGIN`, `process.env.ENABLE_CORPORATE_BILLING`, `process.env.NODE_ENV`
- **Integrations**: `process.env.HUBSPOT_PORTAL_ID`, `process.env.HUBSPOT_PRIVATE_APP_TOKEN`, `process.env.RESEND_API_KEY`, `process.env.VAPID_PUBLIC_KEY`, `process.env.VAPID_PRIVATE_KEY`

## Pre-Completion Checklist
Before marking any task as done:
- [ ] No `snake_case` properties are present in the React Frontend.
- [ ] No `ECONNREFUSED` errors in the server logs.
- [ ] `npm run build` passes with zero TypeScript errors.
- [ ] All staff actions are logged via `logFromRequest()`.
- [ ] Vite dev server is running without compilation errors.

## Recent Changes
- **Feb 21, 2026**: Overage payment migration (v7.93.0) — Deleted standalone `overage.ts` route (370 lines). Dropped 4 deprecated columns from `booking_requests` (overage_fee_cents, overage_minutes, overage_paid, overage_payment_intent_id). All billing now flows through "one invoice per booking" architecture. Removed overage payment UI from CheckinBillingModal and member Dashboard. Roster lock check now uses `isBookingInvoicePaid()`. Cancel/deny flows no longer handle standalone overage PaymentIntents — `voidBookingInvoice` handles all refunds. Removed overage fee sync from unifiedFeeService. Updated 15+ files across backend and frontend. Note: "overageMinutes" as a pricing concept (in fee calculations) is preserved — only the DB columns were removed. Legacy systems still deferred: legacyPurchases.ts (admin tools), MindBody billing_provider guards.
- **Feb 21, 2026**: Legacy system cleanup (v7.92.0) — Deleted dead `inviteExpiryScheduler`. Removed all writes to `booking_members` (10+ files) and `booking_guests` (7 files) — `booking_participants` is now the sole roster source of truth. Changed `invite_status` DB default from 'pending' to 'accepted' and removed redundant hardcoded values from all participant inserts. Tables and read queries preserved temporarily for data migration safety.
- **Feb 21, 2026**: Fixed gap in `syncBookingInvoice`: when a booking starts with $0 fees (no invoice created at approval) and later gains fees through roster edits, the sync now creates a draft invoice on-the-fly using the stored `stripe_customer_id`. Added conference room exclusion check (via `resources.type` JOIN) to prevent accidental invoice creation for conference bookings. Improved invoice line item deletion to use `invoiceItems.list()` API. Updated `booking-flow` and `fee-calculation` skills with the new $0→$X invoice creation behavior.
- **Feb 21, 2026**: Completed full "one invoice per booking" wiring: Trackman auto-approve creates draft invoice, cancel voids it, duration/bay changes sync it, check-in payment actions settle it (finalize OOB, void, or sync). Added roster lock after paid invoice with staff admin override. Bay change detection from Trackman now updates resource_id on booking+session and broadcasts availability. Reschedule UI hidden (backend preserved). New exports: `isBookingInvoicePaid()`, `enforceRosterLock()`, `settleBookingInvoiceAfterCheckin()`. Files: `bookingInvoiceService.ts`, `rosterService.ts`, `staffCheckin.ts`, `webhook-handlers.ts`, `webhook-billing.ts`, `reschedule.ts`, `SimulatorTab.tsx`, `BookingActions.tsx`, `PaymentSection.tsx`.
- **Feb 21, 2026**: Implemented "one invoice per booking" architecture for simulator bookings. Draft invoice created at booking approval, updated on roster changes (member portal + staff edits), finalized+paid via member portal, staff saved-card, terminal (OOB), or cash/confirm. Eliminates duplicate/voided invoices. New `bookingInvoiceService.ts` manages full lifecycle. Added `stripe_invoice_id` column to `booking_requests`. New staff route `POST /api/stripe/staff/mark-booking-paid` for cash payments.
- **Feb 20, 2026**: Migrated booking fee payments from raw PaymentIntents to Stripe Invoices with itemized line items. Each overage fee and guest fee is a separate line item. Members get downloadable invoice PDFs. Affected files: `server/core/stripe/invoices.ts`, `server/core/billing/prepaymentService.ts`, `server/routes/stripe/member-payments.ts`, `server/routes/stripe/payments.ts`.
- **Feb 20, 2026**: Merged engineering standards into replit.md — added Prime Directive, Camel-to-Snake boundary table, UI/UX interaction standards, pre-completion checklist.
- **Feb 20, 2026**: Removed manual "Recalculate Fees" button and deferred fee recalculation pattern. Server now auto-recalculates fees immediately on every roster change.
- **Feb 20, 2026**: Finalized Booking Details sheet layout — smart primary button logic (Collect if unpaid, Check In if $0 balance), secondary actions as ghost text links, Void All Payments inside payment drawer.
- **Feb 20, 2026**: Fixed all missing `type="button"` attributes in PaymentSection.tsx.
- **Feb 2026**: Completed 51-file SQL security refactoring — all raw SQL replaced with Drizzle ORM query builders or parameterized sql template literals. Fixed 4 snake_case-to-camelCase boundary violations in API responses.

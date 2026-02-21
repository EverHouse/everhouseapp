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

| Layer | Casing Style | Enforcement Rule |
| :--- | :--- | :--- |
| **Database (PostgreSQL)** | `snake_case` | Tables and columns MUST be lowercase with underscores. |
| **ORM (Drizzle)** | `camelCase` | Schemas MUST bridge DB columns to TS properties (e.g., `firstName: text('first_name')`). |
| **API / JSON** | `camelCase` | All `res.json()` payloads must be camelCase. **NEVER** leak raw DB rows. |
| **Frontend (React/TS)** | `camelCase` | Component props and state must be strictly typed. No `as any`. |

Additional rules:
- **TypeScript Mismatches**: Never forcefully cast types with `as any`. If frontend interfaces and backend Drizzle inferred types mismatch, fix the underlying schema or DTO rather than bypassing the compiler.
- **External Property Mappings (HubSpot)**: Never hallucinate CRM internal property names. Always consult the `hubspot-sync` skill for the exact, up-to-date property dictionary before writing sync payloads.

#### SQL Security
- All database queries MUST use Drizzle ORM query builders or parameterized `sql` template literals.
- Raw string-interpolated SQL is forbidden.

### UI/UX & Interaction Standards
We use a **Liquid Glass UI** system.

#### Sheet/Modal Design
- **Header**: Contains title and close "X".
- **Body**: Scrollable area for data entry (e.g., Player Slots).
- **Sticky Footer**: Fixed at bottom. Contains Primary Action and Secondary Actions.

#### Button Hierarchy & Logic
- **Primary Action**: Determined by payment status — "Collect" if balance > $0, "Check In" if $0 balance.
- **Secondary Actions**: Reschedule and Cancel, rendered as ghost text links below the primary button.
- **Destructive Actions**: "Void All Payments" lives inside the payment drawer, not the main footer.
- Buttons inside scrollable bodies MUST have `type="button"` to avoid accidental form submission.
- Only the final action in the Sticky Footer should handle the sheet's lifecycle.

#### Fee Recalculation
- All roster changes (add/remove guest, link/unlink member, player count update) trigger **automatic server-side fee recalculation**. There is no manual "Recalculate" button — fees update in real time.
- Visual Feedback: Use subtle loading states (opacity or skeleton) in the Financial Summary while background math is updating.

### System Non-Negotiables
- **Timezone**: All date/time operations must strictly use Pacific Time (`America/Los_Angeles`).
- **Changelog**: Update `src/data/changelog.ts` after EVERY significant change.
- **Audit Logging**: ALL staff actions must be logged using `logFromRequest()` from `server/core/auditLog.ts`.
- **API/Frontend Consistency**: Ensure API response field names EXACTLY match frontend TypeScript interfaces.

### UI/UX & Frontend
- **Design System & Styling**: Liquid Glass UI, Tailwind CSS v4, dark mode.
- **Interactions & Motion**: Spring-physics, drag-to-dismiss.
- **React & Framework**: React 19, Vite, state management (Zustand/TanStack).

### Core Domain
- **Booking & Scheduling**: "Request & Hold" model, unified participants, calendar sync.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, guest fees. "One invoice per booking" architecture.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, Drizzle ORM.
- **Member Lifecycle & Check-In**: Tiers, QR/NFC check-in, onboarding.

## Recent Changes
- **Feb 21, 2026**: Database table consolidation — Reduced tables from 82 to 77 by merging redundant tables:
  1. `app_settings` → merged into `system_settings` (added `category`, `updated_by` columns)
  2. `trackman_webhook_dedup` → merged into `trackman_webhook_events` (added `dedup_key` column with unique index)
  3. Four audit tables (`billing_audit_log`, `booking_payment_audit`, `integrity_audit_log`) → merged into unified `admin_audit_log` with JSONB `details` column. Helper functions in `server/core/auditLog.ts`: `logBillingAudit()`, `logPaymentAudit()`, `logIntegrityAudit()`.
  All existing data was migrated before dropping old tables.
- **Feb 21, 2026**: Dependency & dead code cleanup — Removed unused npm packages (`@modelcontextprotocol/sdk`). Moved 11 dev-only packages to devDependencies (`@vitest/ui`, `drizzle-kit`, `postcss`, `tailwindcss`, `@tailwindcss/postcss`, `vite-plugin-compression`, `vitest`, 4x `@types/*`). Deleted 3 dead code files: `server/routes/mcp.ts` (empty), `server/utils/calendarSync.ts` (superseded), `server/utils/stringUtils.ts` (superseded by emailNormalization.ts).
- **Feb 21, 2026**: Project root cleanup — Removed 30+ dead/outdated files. See changelog for full list.
- **Feb 21, 2026**: Ghost column fix (v7.95.0) + CI guard. See changelog for details.
- **Feb 21, 2026**: Fixed 4 pre-existing bugs found during consolidation audit:
  1. Member-cancel refund fix — session lookup now uses `booking_requests.session_id` directly instead of broken `trackman_booking_id` join that failed for app-created bookings.
  2. Cross-midnight tsrange fix — overlap detection queries now handle sessions spanning midnight (e.g., 23:00–01:00) by adding `INTERVAL '1 day'` when end_time < start_time.
  3. Guest pass refund on member-cancel — approved bookings with consumed guest passes now properly refund passes, matching the staff-cancel behavior.
  4. UUID vs email fix in usage tracking — `recordUsage()` now detects email-format `memberId` inputs and routes to `getMemberTierByEmail()` instead of crashing on UUID cast.

## External Dependencies
- **Stripe**: Terminal, subscriptions, webhooks for billing authority.
- **HubSpot**: Two-way sync, form submissions.
- **Communications**: In-app, push, email via Resend (inbound emails via webhooks targeting `/api/webhooks/resend-inbound`).
- **Other**: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).
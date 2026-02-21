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
- **Feb 21, 2026**: v8.2.0 — Drizzle ORM Migration & Database Integrity Hardening:
  1. Migrated 107+ pool.query calls across 4 critical files to Drizzle ORM (approvalService, subscriptions, member-payments, rosterService).
  2. Converted 8 manual pool.connect() transaction blocks to db.transaction() for automatic BEGIN/COMMIT/ROLLBACK.
  3. Added UNIQUE index on booking_sessions (resource_id, session_date, start_time, end_time) to prevent double-booking at DB level.
  4. Added partial UNIQUE index on booking_participants (session_id, user_id) for active participants to prevent roster duplication.
  5. Added CHECK constraints on guest_passes (passes_used >= 0, passes_used <= passes_total) to prevent negative/over-allocation.
  6. All parameterized queries now use Drizzle sql template literals (no raw string interpolation).
- **Feb 21, 2026**: v8.1.0 — Race Conditions, Billing Math & Data Integrity Fixes (6 bugs):
  1. Advisory lock prevents concurrent double-booking of same bay.
  2. Reconciliation math uses flat guest fees instead of absurd time-based formula.
  3. Guests with app profiles no longer force-upgraded to member billing.
  4. Cross-midnight sessions now calculate correct duration instead of defaulting to 60 min.
  5. Resolved walk-in bookings cleared from Unmatched queue on approve/check-in.
  6. Shared HubSpot ID tier matches flagged for manual review instead of auto-applied.
- **Feb 21, 2026**: v8.0.0 — Security, Transaction Safety & Operational Fixes (6 bugs):
  1. Staff notes filtered from member-facing API responses (data leak fix).
  2. Fee calculation errors no longer silently swallowed during approval (free golf exploit fix).
  3. Staff can now correct check-in mistakes by toggling attended/no_show.
  4. Conference room prepayments deducted from check-in balance guard (double-charge fix).
  5. devConfirmBooking wrapped in database transaction (ghost session fix).
  6. HubSpot batch sync falls back to individual pushes on failure (data loss fix).
- **Feb 21, 2026**: v7.99.0 — Booking Safety & Payment Integrity Fixes (11 bugs):
  1. Conference room prepayments now properly refunded on cancellation (succeeded charges get refund, not cancel).
  2. Trackman participant linking now inserts participants into DB before sending notifications.
  3. First-time guest pass users auto-initialized instead of crashing staff approvals.
  4. Guest pass hold failures now block booking creation (402 error) instead of creating un-approvable requests.
  5. Dev-confirm returns error on session creation failure instead of creating ghost bookings.
  6. Declined invitations excluded from conflict detection (no longer lock schedules).
  7. completeCancellation now refunds fee snapshot payments (matching cancelBooking).
  8. Reconciliation uses idempotency-guarded recordUsage() instead of raw SQL.
  9. Partial unique index on booking_participants(session_id, user_id) prevents roster duplication.
  10. Guest pass refund restricted to passes where used_guest_pass=true (no longer refunds paid guests).
  11. Check-in fee recalc guard catches zeroed-out cached fees (not just NULL).
- **Feb 21, 2026**: v7.98.0 — Critical Billing & Booking Bug Fixes (6 bugs):
  Fee calculator SQL fan-out, usage tracking idempotency aggregation, participant linking substring matching, conference room usage limits, cancellation notes appending, reconciliation date filtering.
- **Feb 21, 2026**: Database table consolidation, dependency cleanup, dead code removal, ghost column fix. See changelog for full details.

## External Dependencies
- **Stripe**: Terminal, subscriptions, webhooks for billing authority.
- **HubSpot**: Two-way sync, form submissions.
- **Communications**: In-app, push, email via Resend (inbound emails via webhooks targeting `/api/webhooks/resend-inbound`).
- **Other**: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).
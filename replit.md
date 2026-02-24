# Ever Club Members App

## ⛔ MANDATORY — READ BEFORE EVERY TASK ⛔

**SKILL-LOADING IS NON-NEGOTIABLE.** Before ANY work — planning, auditing, discussing, OR coding — you MUST:
1. Match the user's request against skill trigger words (every skill has "use when..." triggers in the skill list)
2. Identify ALL relevant skills — not just implementation skills, but planning/audit skills too
3. Read the full SKILL.md file for each relevant skill (e.g., `.agents/skills/booking-flow/SKILL.md`)
4. Follow the architectural rules in those skills as the single source of truth
5. If you skip this step, you WILL introduce bugs that violate established patterns

**This applies to ALL task types, not just code changes:**
- Planning a new feature → load `brainstorming` + domain skills BEFORE discussing
- Auditing/reviewing code → load `code-reviewer`, `clean-code`, `project-architecture` + domain skills
- Designing UI → load `frontend-design`, `ui-ux-pro-max`, `react-dev` BEFORE proposing anything
- Debugging → load `systematic-debugging` + domain skills BEFORE investigating
- Researching an approach → load relevant domain skills BEFORE making recommendations

**SCAN ALL INSTALLED SKILLS — not just the common mappings below.** The full skill list is in the system context with 80+ skills. Every skill has "use when..." trigger descriptions. You MUST scan ALL of them against the user's request — the table below is only a quick reference for the most common Ever Club domain areas. If a request touches marketing, SEO, copy, A/B testing, animations, forms, popups, pricing strategy, mobile design, email sequences, schema markup, website auditing, or ANY other area covered by an installed skill, load that skill too.

Common skill mappings (quick reference — NOT exhaustive):
- Booking changes → `booking-flow`, `booking-import-standards`, `checkin-flow`
- Payment/billing → `fee-calculation`, `stripe-webhook-flow`, `stripe-integration`
- Database/schema → `postgres-drizzle`, `project-architecture`
- Frontend/UI → `react-dev`, `frontend-design`, `ui-ux-pro-max`
- HubSpot → `hubspot-sync`, `hubspot-integration`
- Notifications → `notification-system`
- Data integrity → `data-integrity-monitoring`
- Guest passes → `guest-pass-system`
- Member status → `member-lifecycle`
- Scheduled jobs → `scheduler-jobs`
- New feature planning → `brainstorming`, `project-architecture` + domain skills
- Code audit/review → `code-reviewer`, `clean-code`, `project-architecture`
- Strategy/business → `strategy-advisor`, `pricing-strategy`
- Email features → `email-best-practices`, `resend` (+ sub-skills)
- Performance → `performance`, `sql-optimization-patterns`
- Testing → `test-driven-development`, `e2e-testing-patterns`, `webapp-testing`

**CONVERSATION MEMORY IS NON-NEGOTIABLE.** At the start of every session and whenever making architectural decisions, use the `remembering-conversations` skill to search past conversations for relevant context, past decisions, known gotchas, and previous approaches. This prevents repeating mistakes and re-inventing solutions that were already discussed. Load this skill FIRST — before planning, before coding, before proposing anything.

**CHANGELOG IS NON-NEGOTIABLE.** Every session that produces user-facing changes MUST end with an update to `src/data/changelog.ts` and `src/data/changelog-version.ts`. Group related changes into versioned entries (bump minor version per logical feature/fix group). Never leave a session without updating the changelog — members see this in-app.

**INCIDENT LOG:** If you fail to follow ANY of the above rules, you MUST immediately log it in `.agents/incident-log.md` with: what rule was violated, what happened, estimated wasted agent usage, and corrective action. This is how the founder tracks accountability.

## ⛔ ANTI-PATTERNS — NEVER DO THESE ⛔

These are the most expensive mistakes from the incident log (`.agents/incident-log.md`). Read the incident log at the start of every session to learn from past failures.

1. **NO THRASHING.** If a fix doesn't work after 2 attempts, STOP. Do not make a 3rd attempt at the same approach. Instead: research the problem (web search, read docs, load relevant skills), understand the root cause, then try a fundamentally different approach. The incident log documents cases of 7-22 consecutive failed attempts on the same problem — this is the single most expensive pattern.

2. **RESEARCH BEFORE CODING on unfamiliar topics.** If you don't know how something works (Safari viewport behavior, a library API, a CSS feature, a Stripe flow), search for documentation FIRST. Do not trial-and-error your way through it. One informed attempt beats 10 blind ones.

3. **AUDIT THE FULL SCOPE, FIX ONCE.** When you find a bug, investigate whether there are related issues before writing any fix. Don't fix one symptom, deploy, find the next symptom, fix that, deploy — that's piecemeal and wastes messages. Audit everything, fix everything in one commit.

4. **CHECK DATABASE CONSTRAINTS before using values.** Before using any enum/status value in code, verify it exists in the database CHECK constraint. The booking_requests.status CHECK allows ONLY: pending, approved, confirmed, declined, cancelled, cancellation_pending, attended, no_show, expired. Load `project-architecture` skill to confirm valid values for any table.

5. **DON'T REPEAT A FAILED APPROACH.** If something was tried before and didn't work (check incident log + conversation memory), a different approach is needed — not the same approach again.

## Overview
The Ever Club Members App is a private members club application designed for golf and wellness centers. Its core purpose is to streamline the management of golf simulator bookings, wellness service appointments, and club events. The project aims to create a central digital hub for private members clubs, providing comprehensive tools for membership management, facility booking, and community building, ultimately enhancing member satisfaction and operational efficiency.

## User Preferences
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
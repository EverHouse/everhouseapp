---
name: project-architecture
description: Master map of the Ever Club Members App codebase. Check this FIRST before planning any changes to ensure you modify the correct files and maintain architectural standards. Use whenever creating, modifying, moving, or deleting files anywhere in the project. Triggers on any task involving file creation, code modification, feature planning, refactoring, or architectural questions about the Ever Club app.
---

# Project Architecture & Key Files

Single source of truth for where everything lives. Check here FIRST before modifying any code.

## Project Structure Overview

```
├── src/                    # Frontend (React + Vite + Tailwind)
├── server/
│   ├── core/               # ALL business logic lives here
│   ├── routes/             # Thin HTTP handlers (no business logic)
│   ├── schedulers/         # Timed background jobs
│   ├── emails/             # Email templates
│   ├── middleware/          # Express middleware
│   ├── loaders/            # Route & startup loaders
│   ├── replit_integrations/ # Replit service integrations
│   └── utils/              # Server utilities
├── shared/                 # Shared types & Drizzle schema
├── drizzle/                # Database migrations (auto-generated)
├── public/                 # PWA & static assets
└── tests/                  # Unit (Vitest) & E2E (Playwright)
```

## Root Configuration Files

| File | Purpose | When to touch |
|------|---------|---------------|
| `vite.config.ts` | Frontend bundler, dev server port (5000), proxy rules | Adding aliases, changing ports |
| `tailwind.config.js` | Tailwind theme, colors, fonts | Changing design tokens |
| `tsconfig.json` | TypeScript compiler options, path aliases | Adding path aliases |
| `drizzle.config.ts` | Drizzle ORM config, migration output | Changing schema location |
| `package.json` | Dependencies, npm scripts (`dev`, `server`, `db:push`) | Adding packages, scripts |
| `index.html` | Vite HTML entry — loads `src/main.tsx` | Changing `<head>` tags, meta |
| `.replit` | Replit environment: modules, nix, workflows, integrations | Adding system packages |
| `shared/schema.ts` | Drizzle ORM schema — THE database schema definition | Any DB schema changes |

---

## Reference File Index

Detailed file maps live in `references/`. Read the appropriate file based on your task:

### [references/frontend.md](references/frontend.md)
Read when modifying any frontend code — pages, components, hooks, stores, contexts, utils, services, or types under `src/`.

### [references/backend.md](references/backend.md)
Read when modifying business logic in `server/core/`, shared types in `shared/`, or server infrastructure (middleware, loaders, utils, Replit integrations). Also covers the database schema location and server entry points.

### [references/routes.md](references/routes.md)
Read when adding or modifying API endpoints in `server/routes/`. Remember: routes are THIN — all business logic goes in `server/core/`.

### [references/schedulers-emails.md](references/schedulers-emails.md)
Read when adding or modifying scheduled jobs in `server/schedulers/` or email templates in `server/emails/`.

---

## Key Conventions

### 1. Thin Routes
Routes (`server/routes/`) handle HTTP only. All business logic lives in `server/core/`. Never write business logic inline in route handlers.

### 2. Audit Logging
Log ALL staff actions using `logFromRequest()` from `server/core/auditLog.ts`. Include appropriate action type, resource type, and details.

### 3. Changelog Updates
Update `src/data/changelog.ts` after EVERY significant change. Bump version numbers: patch for fixes, minor for features, major for breaking.

### 4. Pacific Timezone First
All date/time operations use Pacific timezone (`America/Los_Angeles`). Use `server/utils/dateUtils.ts` utilities, never raw `new Date()` comparisons.

### 5. API Field Name Consistency
Response field names must EXACTLY match frontend TypeScript interfaces. Verify field names against the frontend interface before returning `res.json({...})`.

### 6. Safe Database Operations (v7.26.0)
Use `safeDbOperation()` and `safeDbTransaction()` from `server/core/safeDbOperation.ts`. **BANNED:** Empty `catch {}` blocks anywhere in server code.

### 7. Database Migrations
NEVER write migration files manually — use `npm run db:push`. Schema changes go in `shared/schema.ts`, then push.

### 8. No External API Calls in DB Transactions (v8.12.0)
HTTP calls to Stripe, HubSpot, or any external service must NOT be made inside `BEGIN`/`COMMIT` blocks. They hold connections while waiting for network responses. Use the deferred action pattern (`deferredActions.push(async () => { ... })`) or DB-side checks instead. Exceptions: 5 Stripe/HubSpot calls that must stay in-transaction (customer retrieve, product retrieve, payment methods list, company sync, prices retrieve in guestPassConsumer) are wrapped with 5-second `Promise.race()` timeouts and marked with `// NOTE: Must stay in transaction` comments. See `stripe-webhook-flow` skill for the full pattern.

### 9. Route Authentication Patterns (Audit Finding, Feb 2026)
Two authentication patterns coexist in the codebase:

**Pattern A — Middleware guard (preferred):**
```typescript
router.post('/api/admin/resource', isStaffOrAdmin, async (req, res) => { ... })
```

**Pattern B — Inline check (legacy, acceptable):**
```typescript
router.post('/api/resource', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ error: 'Authentication required' });
  ...
})
```

Both patterns provide equivalent **authentication** (identity verification). However, Pattern B only verifies the user is logged in — it does NOT enforce role-based authorization. Routes requiring staff/admin access MUST use `isStaffOrAdmin` or `isAdmin` middleware. Inline `getSessionUser()` is only acceptable for member-authenticated endpoints where any logged-in user may access the route.

Pattern A is preferred for new routes. Pattern B is used in roster.ts, bays/bookings.ts, and some other files. Do NOT treat Pattern B routes as "missing authentication" — they verify identity. But always verify they do not need role-based authorization that only middleware provides.

**Intentionally public routes** (no auth required):
- `POST /api/auth/*` — login/registration flows
- `POST /api/tours/book` — prospect tour booking
- `POST /api/day-passes/confirm` — day pass purchase confirmation (verifies via Stripe session)
- `POST /api/webhooks/*` — Stripe, Trackman, Resend, HubSpot webhooks (verified by signature/secret)
- `POST /api/availability/batch` — public availability check
- `POST /api/hubspot/forms/*` — HubSpot form submissions

### 10. Rate Limiting
All public endpoints that create database records or trigger notifications MUST have rate limiting middleware. Currently protected: `/api/tours/book`, `/api/tours/schedule`, `/api/day-passes/confirm`, `/api/client-error`. Use `checkoutRateLimiter` from `../middleware/rateLimiting` for public form submissions.

### 11. Input Validation
All API endpoints SHOULD validate request body with Zod schemas. Currently only 3 route files use Zod (checkout.ts, members/onboarding.ts, members/profile.ts). All `parseInt(req.params.id)` calls MUST be followed by an `isNaN()` check with 400 response. Many routes are missing this guard.

### 12. Unbounded Queries
All SELECT queries MUST have a LIMIT clause or be naturally bounded (e.g., by FK or date range). Admin list endpoints should support `?limit=N` query parameter with a sensible default (200-500). Never load all rows from a growing table into memory.

### 13. Scheduler Lifecycle
All `setInterval()` calls in schedulers MUST return their `NodeJS.Timeout` ID. The `initSchedulers()` function collects all IDs and `stopSchedulers()` clears them on shutdown. Never create timers that can't be stopped.

### 14. Stripe Idempotency
All `stripe.*.create()` calls MUST include an `idempotencyKey` parameter with a deterministic value (NOT `randomUUID()`). Pattern: `operation_type_${uniqueBusinessKey}`. Idempotency keys on `update()` calls are nice-to-have but not required.

### 15. Connection Pool Safety
Never use `pool.connect()` inside `Promise.race()` without ensuring the connection is released regardless of which promise wins. Always use try/finally for connection release. The `safeDbTransaction()` helper handles this correctly.

---

## Unified Booking Sheet Architecture

**CRITICAL ARCHITECTURAL STANDARD — Established February 2026**

The **Unified Booking Sheet** (`UnifiedBookingSheet.tsx` + `useUnifiedBookingLogic.ts`) in `src/components/staff-command-center/modals/` is the **SINGLE AUTHORITY** for all player, roster, owner, and guest management on bookings.

**The Rule:** If the user asks to edit players, guests, or owners, ALWAYS route to the Unified Booking Sheet. Do not create inline editors, separate roster popups, or new modals for player management.

**Two Modes:**
- **Mode A (Assign Players):** For unlinked/new bookings — search and assign owner + players, then "Assign & Confirm"
- **Mode B (Manage Players):** For existing bookings — pre-fills roster from `/api/admin/booking/:id/members`, allows editing, then "Save Changes"

**Sub-components:**
- `SheetHeader.tsx` — Header with booking info
- `AssignModeFooter.tsx` — Assign mode footer actions
- `ManageModeRoster.tsx` — Manage mode roster display
- `PaymentSection.tsx` — Inline payment collection
- `CheckinBillingModal.tsx` — Check-in billing flow
- `CheckInConfirmationModal.tsx` — Check-in confirmation
- `BookingStatusDropdown.tsx` — Shared check-in/no-show status dropdown

**Features absorbed into this single component:**
- Owner assignment (slot 1, required), player slot management (slots 2-4)
- Guest placeholder creation and named guest forms
- Member search and reassignment
- Guest pass tracking and auto-application
- Financial summary with real-time fee recalculation
- Inline payment collection via Stripe, fee waiver with required reason
- Quick Add from Notes, player count editing, check-in flow integration

**DEPRECATED components (do NOT use or extend):**
- `src/components/admin/BookingMembersEditor.tsx` — replaced by Mode B
- `PlayerManagementModal.tsx` — replaced by UnifiedBookingSheet
- `src/components/staff-command-center/modals/CompleteRosterModal.tsx` — replaced by Mode B with check-in context

**All triggers route to the Unified Booking Sheet:**
- Owner edit pencil icon → Mode B
- "Manage Players" button → Mode B
- Player count edit click → Mode B
- Check-in with incomplete roster → Mode B with check-in context
- Unlinked Trackman booking assignment → Mode A

---

## Booking Action Architecture

**Established February 2026 — ABSOLUTE, no exceptions.**

ALL booking actions (Check-in, Cancel, Pay/Charge) in the frontend are centralized into TWO hooks:

| Hook | Location | Responsibility |
|------|----------|----------------|
| `useBookingActions` | `src/hooks/useBookingActions.ts` | Low-level API calls for check-in, cancel, and card charging |
| `useUnifiedBookingLogic` | `src/components/staff-command-center/modals/useUnifiedBookingLogic.ts` | High-level orchestration for the Unified Booking Sheet |

**BANNED Patterns:**
1. Raw `fetch()` calls to booking endpoints in UI components — use `useBookingActions()` instead
2. Local `handleCheckIn` / `handleCancel` / `handlePay` functions in page components — call hook methods instead
3. Duplicating query invalidation logic — `useBookingActions` already handles this
4. Inline check-in buttons without the BookingStatusDropdown — always use `BookingStatusDropdown` from `src/components/BookingStatusDropdown.tsx` for any check-in UI surface

**Allowed exceptions:**
- Member-facing cancel in `Dashboard.tsx` / `BookGolf.tsx` (different UX, hits `/api/bookings/:id/member-cancel`)
- Tour check-in in `ToursTab.tsx` (tours are not bookings, hits `/api/tours/:id/checkin`)

---

## Other Directories

| Directory | Purpose | Editable? |
|-----------|---------|-----------|
| `tests/unit/` | Vitest unit tests | When adding/changing logic |
| `tests/e2e/` | Playwright E2E tests | When adding features |
| `public/` | PWA manifest, service worker, static images | When changing PWA config |
| `drizzle/` | Auto-generated migrations & snapshots | NEVER edit manually |
| `docs/` | ER diagrams, feature roadmap, UI audit, API docs | Reference only |
| `scripts/` | Root-level maintenance scripts | Run manually |
| `uploads/trackman/` | Uploaded Trackman CSV files | Auto-managed |
| `attached_assets/` | Reference images from conversations | Read-only |
| `.cache/`, `.config/`, `.upm/`, `node_modules/` | Auto-generated | NEVER touch |

---

## The Refactoring Rule

**CRITICAL**: If asked to move files, rename folders, or refactor code structure, update this skill file AND the relevant reference files at the end of the task to reflect new paths.

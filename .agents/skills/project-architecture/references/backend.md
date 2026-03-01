# Backend Core Business Logic (`server/core/`)

ALL business logic lives here. Routes call these modules — never write logic inline in routes.

---

## Billing & Finance (`server/core/billing/`)

| File | Purpose |
|------|---------|
| `unifiedFeeService.ts` | `computeFeeBreakdown()` — ALL fee calculations go through here |
| `pricingConfig.ts` | Stripe-sourced pricing (guest fee, overage rate, day pass prices) |
| `prepaymentService.ts` | Prepayment intent creation, payment, refund |
| `feeCalculator.ts` | Low-level fee math helpers |
| `guestPassConsumer.ts` | Guest pass deduction logic |
| `guestPassHoldService.ts` | Guest pass hold/release during booking |
| `bookingInvoiceService.ts` | Booking invoice creation and management |
| `cardExpiryChecker.ts` | Card expiry monitoring and alerts |
| `paymentIntentCleanup.ts` | Stale payment intent cleanup |
| `PaymentStatusService.ts` | Payment status tracking and transitions |

---

## Booking Service (`server/core/bookingService/`)

| File | Purpose |
|------|---------|
| `sessionManager.ts` | `ensureSessionForBooking()`, `createSession()`, `linkParticipants()` — THE session creation function |
| `approvalService.ts` | Booking approval/rejection logic |
| `availabilityGuard.ts` | Slot availability checks |
| `bookingStateService.ts` | Booking state transitions |
| `conflictDetection.ts` | Double-booking prevention |
| `rosterService.ts` | Roster/participant management |
| `tierRules.ts` | Tier-based booking limits and access rules |
| `usageCalculator.ts` | Daily usage, guest pass remaining, overage calculation |
| `trackmanReconciliation.ts` | Trackman data reconciliation |
| `index.ts` | Re-exports |

### Session Overlap Detection (v7.26.1)

`ensureSessionForBooking()` uses a **3-step lookup chain** before attempting INSERT:

1. Match by `trackman_booking_id` (exact)
2. Match by `resource_id + session_date + start_time` (exact)
3. Match by `resource_id + session_date + time range overlap` (tsrange intersection)

Only if all 3 fail does it INSERT a new session. When called inside a transaction (with a `client` parameter), the function does NOT retry on failure — it throws immediately so the caller's savepoint/rollback handling works correctly.

---

## Stripe Integration (`server/core/stripe/`)

| File | Purpose |
|------|---------|
| `client.ts` | Stripe client initialization |
| `webhooks.ts` | Stripe webhook event handlers |
| `payments.ts` | Payment intent creation and processing |
| `subscriptions.ts` | Subscription CRUD |
| `subscriptionSync.ts` | Subscription status sync |
| `customers.ts` | Customer creation and lookup |
| `customerSync.ts` | Customer metadata sync (user ID, tier) |
| `products.ts` | Product/price catalog management, `ensure*Product()` startup sync (guest-pass, day-pass-coworking, day-pass-golf-sim slugs) |
| `invoices.ts` | Invoice generation and retrieval |
| `reconciliation.ts` | Stripe vs local data reconciliation |
| `tierChanges.ts` | Tier change proration handling |
| `groupBilling.ts` | Corporate/family group billing |
| `discounts.ts` | Coupon and discount management |
| `hubspotSync.ts` | Stripe subscription → HubSpot sync |
| `environmentValidation.ts` | Stripe test/live mode validation |
| `paymentRepository.ts` | Payment data access layer |
| `billingMigration.ts` | Billing provider migration logic |
| `transactionCache.ts` | Stripe transaction cache management |
| `index.ts` | Re-exports |

---

## HubSpot CRM (`server/core/hubspot/`)

| File | Purpose |
|------|---------|
| `contacts.ts` | Contact create/update/search |
| `companies.ts` | Company management |
| `members.ts` | Member data sync to HubSpot |
| `products.ts` | HubSpot product sync |
| `pipeline.ts` | Deal pipeline management |
| `stages.ts` | Pipeline stage definitions |
| `lineItems.ts` | Deal line items |
| `discounts.ts` | HubSpot discount sync |
| `queue.ts` | Async sync queue |
| `queueHelpers.ts` | Queue utility functions |
| `request.ts` | HubSpot API request wrapper |
| `admin.ts` | Admin HubSpot tools |
| `constants.ts` | HubSpot property/pipeline IDs |
| `formSync.ts` | HubSpot form sync |
| `index.ts` | Re-exports |

---

## Calendar (`server/core/calendar/`)

| File | Purpose |
|------|---------|
| `google-client.ts` | Google Calendar API client |
| `availability.ts` | Calendar availability calculation |
| `cache.ts` | Calendar data caching |
| `config.ts` | Calendar IDs and settings |
| `sync/closures.ts` | Closure calendar sync |
| `sync/conference-room.ts` | Conference room calendar sync |
| `sync/wellness.ts` | Wellness calendar sync |
| `sync/events.ts` | Event calendar sync |
| `sync/index.ts` | Sync orchestration |
| `index.ts` | Re-exports |

---

## Member Service (`server/core/memberService/`)

| File | Purpose |
|------|---------|
| `MemberService.ts` | Core member CRUD, lookup, search |
| `memberCache.ts` | Member data caching |
| `memberTypes.ts` | Member type definitions |
| `emailChangeService.ts` | Email change handling |
| `tierSync.ts` | Tier sync to external systems |
| `index.ts` | Re-exports |

---

## Visitor Management (`server/core/visitors/`)

| File | Purpose |
|------|---------|
| `autoMatchService.ts` | Auto-match visitors to members |
| `matchingService.ts` | Visitor matching algorithms |
| `typeService.ts` | Visitor type classification |
| `index.ts` | Re-exports |

---

## Standalone Core Files

| File | Purpose |
|------|---------|
| `trackmanImport.ts` | CSV import, placeholder merging, Notes parsing (`M\|email\|name`, `G\|name`) |
| `notificationService.ts` | In-app notification creation and delivery |
| `websocket.ts` | WebSocket server, `broadcastToStaff()`, real-time updates |
| `auditLog.ts` | `logFromRequest()` — ALL staff actions must be logged here |
| `middleware.ts` | `isAdmin`, `isStaffOrAdmin` middleware |
| `bookingAuth.ts` | Booking-level authorization checks |
| `bookingValidation.ts` | Booking input validation |
| `bookingEvents.ts` | Booking event broadcasting |
| `tierService.ts` | Tier lookup, limits, feature checks |
| `memberSync.ts` | Full member data sync orchestration |
| `memberTierUpdateProcessor.ts` | Tier change processing queue |
| `integrations.ts` | External service integration helpers |
| `jobQueue.ts` | Background job queue processing |
| `jobQueueMonitor.ts` | Job queue monitoring |
| `logger.ts` | Structured logging with `logAndRespond()` |
| `dataIntegrity.ts` | Data integrity checks and repairs |
| `dataAlerts.ts` | Data anomaly alerting |
| `databaseCleanup.ts` | Database cleanup utilities |
| `errorAlerts.ts` | Error alerting to staff |
| `staffNotifications.ts` | Staff notification helpers |
| `healthCheck.ts` | Health check endpoint logic |
| `monitoring.ts` | Performance monitoring |
| `sessionCleanup.ts` | Expired session cleanup |
| `userMerge.ts` | Duplicate user merge logic |
| `retry.ts`, `retryUtils.ts` | Retry with exponential backoff |
| `affectedAreas.ts` | Change impact analysis |
| `db.ts` | Database pool connection |
| `hubspotDeals.ts` | HubSpot deal management |
| `alertHistoryMonitor.ts` | Alert history tracking |
| `emailTemplatePreview.ts` | Email template preview rendering |
| `hubspotQueueMonitor.ts` | HubSpot queue monitoring |
| `safeDbOperation.ts` | Safe database operations wrapper (`safeDbOperation()`, `safeDbTransaction()`) |
| `schedulerTracker.ts` | Scheduler execution tracking |
| `walkInCheckinService.ts` | Walk-in check-in processing |
| `resourceService.ts` | Resource/bay management logic |
| `queryCache.ts` | Query result caching |
| `settingsHelper.ts` | App settings helper |
| `webhookMonitor.ts` | Webhook monitoring |
| `googleSheets/announcementSync.ts` | Google Sheets → announcements sync |
| `mindbody/import.ts`, `mindbody/index.ts` | MindBody data import |
| `supabase/client.ts` | Supabase admin client |
| `utils/emailNormalization.ts` | Email normalization utilities |

### Safe Database Operation Wrappers (v7.26.0)

| Wrapper | Location | Purpose |
|---------|----------|---------|
| `safeDbOperation()` | `server/core/safeDbOperation.ts` | Wrap single DB operations with structured error logging. Use instead of empty `try/catch {}` blocks. |
| `safeDbTransaction()` | `server/core/safeDbOperation.ts` | Wrap multi-statement DB operations in a transaction with automatic rollback on failure. |

**BANNED:** Empty `catch {}` blocks anywhere in server code. Every error must be either thrown, logged via `safeDbOperation`, or handled with a meaningful fallback.
- Use `logger.debug` for expected/benign failures (JSON parse fallbacks, optional lookups).
- Use `logger.warn` for operationally meaningful errors (DB rollback failures, sync errors).

### Timezone Enforcement (Audit-Verified Feb 2026)
- **ALL `toLocaleDateString()` calls must include `timeZone: 'America/Los_Angeles'`** in the options object. No exceptions — not even for staff-only notifications, internal logging, or tour scheduling.
- **Never use `timeZone: 'UTC'`** for user-facing date formatting. The club operates in Pacific Time.
- Prefer `dateUtils.ts` Pacific timezone helpers over raw `Date` operations.

### Authentication Enforcement (Audit-Verified Feb 2026)
- **All mutating API routes (POST/PUT/PATCH/DELETE) must have auth protection** — either `isAuthenticated`/`isStaff` middleware or inline `getSessionUser()` + 401 check.
- **Exceptions**: login/auth endpoints, inbound webhooks (use signature verification), and intentionally public forms (tour booking, day pass checkout).

### Stripe Webhook Safety (Audit-Verified Feb 2026)
- **All webhook handlers that modify member status must include a `billing_provider` guard** — skip processing if the member's `billing_provider !== 'stripe'`.
- This prevents Stripe webhooks from overwriting status for members billed through other systems (e.g., HubSpot-managed billing).

---

## Shared Types & Schema (`shared/`)

| File/Dir | Purpose |
|----------|---------|
| `schema.ts` | Drizzle ORM schema — THE database schema definition |
| `models/billing.ts` | Billing types (FeeBreakdown, FeeLineItem, etc.) |
| `models/scheduling.ts` | Booking types (roster_version, booking status, etc.) |
| `models/membership.ts` | Membership/tier types |
| `models/notifications.ts` | Notification types |
| `models/users.ts` | User types |
| `models/auth.ts`, `models/auth-session.ts` | Auth types |
| `models/content.ts` | Content types (announcements, FAQs) |
| `models/system.ts` | System config types |
| `models/hubspot-billing.ts` | HubSpot billing types |
| `constants/statuses.ts` | Booking/payment status strings |
| `constants/tiers.ts` | Tier name constants |
| `constants/products.ts` | Stripe product ID constants |
| `constants/index.ts` | Re-exports |

---

## Server Infrastructure

### Server Entry & Init

| File | Purpose |
|------|---------|
| `server/tsconfig.json` | Server-specific TypeScript config |
| `server/index.ts` | Express server bootstrap, middleware, route registration |
| `server/db.ts` | Drizzle ORM client initialization |
| `server/db-init.ts` | Database initialization (triggers, indexes, seeds) |
| `server/seed.ts` | Database seeding |

### Middleware (`server/middleware/`)

- `rateLimiting.ts` — Rate limiting configuration

### Loaders (`server/loaders/`)

- `routes.ts` — Dynamic route loading
- `startup.ts` — Deferred startup tasks

### Server Utils (`server/utils/`)

- `dateUtils.ts` — Pacific timezone date utilities (ALWAYS use these, never raw Date)
- `dateNormalize.ts` — Date normalization helpers
- `resend.ts` — Resend email sending
- `errorUtils.ts` — Error formatting and handling utilities
- `sqlArrayLiteral.ts` — SQL array literal helpers
- `tierUtils.ts` — Server-side tier utilities

### Server Types (`server/types/`)

- `session.ts` — Express session type extensions
- `stripe-helpers.ts` — Stripe helper types

### Server Scripts (`server/scripts/`)

- `classifyMemberBilling.ts` — One-off billing classification
- `cleanup-stripe-duplicates.ts` — Stripe duplicate cleanup

### Supabase (`server/supabase/`)

- `auth.ts` — Supabase auth client setup

### Replit Integrations (`server/replit_integrations/`)

- `auth/` — Replit auth integration
- `batch/` — Batch processing
- `image/` — Image handling (OpenAI Vision)
- `object_storage/` — Object storage (ID images, uploads)

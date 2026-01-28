# Ever House Members App

## Overview
The Ever House Members App is a private members club application for golf and wellness centers. Its primary purpose is to facilitate golf simulator bookings, wellness service appointments, and club event management. The application aims to improve member engagement and streamline operational workflows, providing a cohesive digital experience. The project envisions becoming a central digital hub for private members clubs, offering comprehensive tools for membership management, facility booking, and community building, thereby boosting member satisfaction and operational efficiency.

## User Preferences
- **CRITICAL: Communication Style** - The founder is non-technical. Always explain changes in plain English, focusing on how they affect the member/staff experience or business operations. Avoid jargon like "ORM," "WebSocket," "orchestration," "middleware," etc. If a technical term is necessary, explain it simply first (e.g., "the notification system" instead of "WebSocket server").
- **CRITICAL: Pacific Timezone (America/Los_Angeles) is THE FIRST PRIORITY for any date/time operations.** All time comparisons must use Pacific time utilities, never local server time.
- **CRITICAL: Changelog Updates** - Update `src/data/changelog.ts` after EVERY significant change, not just when asked. Each feature or fix should be documented immediately. Bump version numbers appropriately (patch for fixes, minor for features, major for breaking/significant changes). Mark major releases with `isMajor: true`.
- **CRITICAL: Staff Activity Logging** - ALL staff actions must be logged to the audit system using `logFromRequest()` from `server/core/auditLog.ts`. When adding new staff features, always add audit logging with appropriate action type, resource type, resource ID/name, and relevant details. Add new action types to `AuditAction` type if needed. This ensures all staff activity appears in the Staff Activity feed on the Changelog page.
- **HIGH PRIORITY: API/Frontend Field Name Consistency** - When creating or modifying API endpoints, ALWAYS ensure the response field names EXACTLY match the frontend TypeScript interface expectations. Before returning `res.json({...})`, verify field names against the corresponding frontend interface. Common mismatches to avoid: `visits` vs `visitHistory`, `bookings` vs `bookingHistory`, `eventRsvps` vs `eventRsvpHistory`, `wellness` vs `wellnessHistory`, `guestPass` vs `guestPassInfo`, `guestCheckIns` vs `guestCheckInsHistory`, `estimatedOverageFee` vs `overageFee`, `dailyAllowance` vs `includedDailyMinutes`, `estimatedTotalFees` vs `totalFees`. When in doubt, search for the frontend interface definition and match it exactly.
- I prefer simple language.
- I like functional programming.
- I want iterative development.
- Ask before making major changes.
- I prefer detailed explanations.
- Do not make changes to the folder `Z`.
- Do not make changes to the file `Y`.

## System Architecture
The application utilizes a React 19 frontend with Vite, styled using Tailwind CSS, and an Express.js backend with a PostgreSQL database.

### UI/UX Decisions
- **Design System**: Liquid Glass (iOS-inspired glassmorphism) with an EH monogram logo, WCAG AA contrast compliance, and `aria-label` attributes for accessibility.
- **Typography**: Playfair Display for headlines and Inter for body/UI.
- **Color Palette**: Deep Green, Lavender, Bone, Background Dark.
- **Navigation**: Unified header and Member Bottom Nav.
- **Responsive Design**: Optimized for iPhone, iPad, and Desktop.
- **Theme System**: Supports Light, Dark, and System themes, persisted locally.
- **Motion Architecture**: Pure CSS keyframe animations, staggered content, parallax scrolling, and entry/exit animations.
- **Drawer UX**: MemberProfileDrawer hides bottom navigation and floating action button on mobile.

### Backend Structure
- **Route Organization**: Modular directories for API routes (e.g., `server/routes/stripe/`, `server/routes/members/`, `server/routes/bays/`, `server/routes/trackman/`).
- **Startup Architecture**: Loader modules for startup tasks (e.g., `server/loaders/routes.ts`, `server/loaders/startup.ts`). Includes a readiness probe (`/api/ready`) and a health check (`/healthz`), along with graceful shutdown handlers.

### Technical Implementations
- **Core Stack**: React 19 (Vite), React Router DOM, Express.js (REST API), PostgreSQL, Tailwind CSS.
- **Timezone Handling**: All date/time operations prioritize the 'America/Los_Angeles' timezone.
- **Member Management**: Supports member tiers, tags, a directory, and unified billing groups (family and corporate) with primary payers.
- **Booking System**: Features "Request & Hold," conflict detection, staff/member initiated bookings, multi-member bookings, and calendar management. Uses database transactions with row-level locking and a trigger (`prevent_booking_session_overlap`) to prevent double-bookings.
- **Check-In Notifications**: Members receive in-app and WebSocket notifications for check-in status and refunds.
- **Trackman Integration**: Unified 1:1 sync for CSV imports and webhooks using `trackman_booking_id`. Includes origin tracking, UPSERT logic, and placeholder handling for unmatched bookings. Webhook integration supports real-time booking synchronization, delta billing, idempotency, and cross-midnight durations.
- **Linked Email Addresses**: Supports alternate email addresses and auto-learns associations during Trackman imports.
- **Security**: Role-based access control with `isAdmin` and `isStaffOrAdmin` middleware.
- **Notifications**: In-app real-time notifications and a sequential notice dismissal system with 3-channel delivery.
- **Real-Time Sync**: Instant updates via WebSocket, with Supabase Realtime as a parallel channel.
- **PWA Features**: Service Worker caching, offline support, and iOS-style interactions.
- **Performance Optimizations**: List virtualization, skeleton loaders, optimized CSS, lazy-loaded admin tabs, optimistic updates, and memoized context functions.
- **Admin Tools**: Admin-configurable features, data integrity dashboard, and data migration tools.
- **Privacy Compliance**: Privacy modal, CCPA/CPRA features, account deletion, and data export. Admin audit log for staff access to member data.
- **Waiver Management**: Tracks waiver versions and requires signing on login.
- **Unified Fee Service**: Single authoritative source for all fee calculations (`server/core/billing/unifiedFeeService.ts`). Uses `computeFeeBreakdown()` for all fee-related operations and `effectivePlayerCount = MAX(declared, actual)`. Roster changes invalidate cached fees.
- **Webhook Safety**: Stripe webhooks process once via transactional dedup. Deferred action pattern for external calls and resource-based ordering guards.
- **Roster Protection**: Optimistic locking with `roster_version` and row-level locking.
- **Billing Management**: Staff Payments Dashboard, unified payment history, member billing management, self-service portal, tier change wizard with proration, dunning for failed payments, and refund processing.
- **Payment Recovery (Dunning)**: Tracks failed payments, retries, and notifies members.
- **Grace Period System**: 3-day grace period for billing failures, with manual staff intervention for payment links.
- **Day Pass System**: Non-members can purchase day passes with visitor matching, HubSpot sync, and QR code delivery.
- **QR Code System**: QR codes for day passes and digital access cards for members, with staff scanning functionality.
- **Corporate Membership**: Supports unified billing groups, volume pricing, corporate checkout, HubSpot company sync, and individual tracking.
- **Data Integrity Architecture**: Stripe as the source of truth for billing, transaction rollback, webhook idempotency, and automatic status sync. Dual-source active tracking using HubSpot and Stripe.
- **Stripe Member Auto-Fix**: Login flow automatically verifies Stripe subscription status and corrects `membership_status` if the database is out of sync.
- **Stripe Subscription → HubSpot Sync**: Automated sync of `membership_status` and tier to HubSpot contact upon Stripe subscription creation.
- **Member Balance Display**: Balance shows all fees where `payment_status = 'pending'` and `cached_fee_cents > 0`. Booking cancellations automatically clear fees.
- **Stripe Customer Metadata Sync**: Customer metadata (userId, tier) is synced to Stripe.
- **Stripe Transaction Cache**: Transactions are cached locally in `stripe_transaction_cache`.
- **Scheduled Maintenance**: Daily tasks for session cleanup, webhook log cleanup, Stripe reconciliation, and grace period checks.

## External Dependencies
- **Stripe Payments**: For in-app payment collection, subscription management, and webhook processing.
- **Resend**: For email-based OTP verification and automated alerts.
- **HubSpot CRM**: For contact and member management, two-way data sync, and communication preferences.
- **HubSpot Forms**: For application form submissions.
- **Eventbrite**: For syncing members-only events.
- **Google Calendar**: For integration with various club calendars.
- **Apple Messages for Business**: For direct messaging.
- **Amarie Aesthetics MedSpa**: For direct booking links.
- **Supabase**: For backend admin client, Realtime subscriptions, and session token generation.

## Bug Prevention Guidelines
These patterns have caused bugs before. Watch out for them:

### Timezone Bugs (CRITICAL)
- **NEVER use `CURRENT_DATE` in SQL** - It returns UTC date, not Pacific time
- **ALWAYS use**: `(CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date` for date comparisons
- **Use `server/utils/dateUtils.ts`** - Contains `getPacificDate()`, `getPacificNow()`, `toPacificTime()` utilities
- **Test during evening hours** (5 PM - midnight Pacific) when UTC is "tomorrow" but Pacific is still "today"

### Active Membership Status (CRITICAL - v9.32.31)
**The canonical definition of "has membership access":**
```sql
-- SQL pattern for active members
WHERE (membership_status IN ('active', 'trialing', 'past_due') 
       OR stripe_subscription_id IS NOT NULL)
```
```typescript
// TypeScript pattern for active members
const activeStatuses = ['active', 'trialing', 'past_due'];
const isActive = activeStatuses.includes(status) || !!stripeSubscriptionId;
```

**Why this matters:**
- `trialing` = New member in trial period (full access)
- `past_due` = Payment failed but still in grace period (full access for 3 days)
- `stripeSubscriptionId` = Has subscription in Stripe regardless of DB status (DB can be stale)

**Audit checklist when modifying status-related code:**
1. Search for `membership_status = 'active'` - should usually be `IN ('active', 'trialing', 'past_due')`
2. Search for `status: 'active'` in Stripe API calls - should include trialing/past_due
3. Check SQL queries in: `server/routes/`, `server/core/stripe/`, `server/schedulers/`
4. Check frontend filters in: `src/contexts/`, `src/pages/Admin/`
5. Never put `past_due` in "former/inactive" lists - they're still active!

**Files that check membership status (audit these when making changes):**
- `server/routes/auth.ts` - Login flow
- `server/routes/members/search.ts` - Directory search
- `server/routes/hubspot.ts` - HubSpot sync and webhooks
- `server/routes/stripe/payments.ts` - Billing member search
- `server/routes/waivers.ts` - Waiver counts
- `server/core/stripe/reconciliation.ts` - Stripe reconciliation
- `server/core/stripe/subscriptionSync.ts` - Subscription sync
- `server/routes/memberBilling.ts` - Member billing operations
- `src/components/MemberProfileDrawer.tsx` - Member profile UI

### MindBody/HubSpot Status Sync (v9.32.32)
- **MindBody billing status flows through HubSpot** → HubSpot webhook → Database
- **HubSpot webhooks update database instantly** when `membership_status` or `membership_tier` changes
- **Background sync runs every 5 minutes** as a fallback
- **Both billing sources are valid**: Stripe members have `billing_provider = 'stripe'`, MindBody members have `billing_provider = 'mindbody'`

### Data Cleanup on Actions
- **When cancelling bookings**: Clear associated fees (`cached_fee_cents = 0`, `payment_status = 'waived'`)
- **When deleting records**: Consider all related data (participants, fees, sessions, notifications)
- **Think through side effects**: What other data depends on this record?

### Keep Filtering Logic Simple
- **Prefer single source of truth** - Use `payment_status = 'pending'` instead of complex snapshot-based filtering
- **Don't over-engineer** - If a simple field tells you the state, trust it
- **Avoid "orphan detection" logic** - It's usually wrong; fix the root cause instead
---
name: member-lifecycle
description: Member status transitions, onboarding flow, cancellation, reactivation, grace periods, tier changes, application pipeline, and membership state machine for the Ever Club Members App.
---

# Member Lifecycle

## State Machine Overview

Every member has a `membership_status` column in the `users` table. The following values are valid:

| Status | Meaning |
|--------|---------|
| `active` | Paying member with full access |
| `trialing` | Free trial member (7-day trial via Stripe) |
| `past_due` | Payment failed; grace period started; still has access |
| `suspended` | Admin-initiated pause (Stripe `pause_collection` or manual Mindbody pause) |
| `frozen` | Stripe webhook `customer.subscription.paused` sets this automatically |
| `paused` | Trial ended without conversion; account preserved but booking blocked |
| `cancelled` | Subscription deleted in Stripe; tier cleared, `last_tier` preserved |
| `terminated` | Grace period expired after 3 days of failed payment; Mindbody members only |
| `pending` | Stripe subscription `incomplete` — waiting for initial payment |
| `inactive` | Catch-all for other deactivation scenarios |
| `archived` | Soft-deleted by staff; `archived_at` timestamp set |
| `non-member` | Tier cleared by admin; no active membership |
| `merged` | Duplicate record merged into another user |

Former-member statuses (used for filtering/archival):
`expired`, `terminated`, `former_member`, `cancelled`, `canceled`, `inactive`, `churned`, `declined`, `suspended`, `frozen`, `froze`, `pending`, `non-member`.

## Key Invariants

### Stripe Is Authoritative for Stripe-Billed Members

When `billing_provider = 'stripe'`, Stripe is the source of truth for `membership_status` and `tier`. HubSpot sync skips status/tier updates for Stripe-protected members (`STRIPE WINS` rule in `memberSync.ts`). The database is corrected from Stripe on login (auto-fix) and via webhooks. All Stripe webhook handlers check `billing_provider` before processing and bail out if it is not `'stripe'` (e.g., `'mindbody'`, `'manual'`, `'comped'`).

### HubSpot Is Authoritative for Mindbody Legacy Members

When `billing_provider = 'mindbody'`, HubSpot drives membership status during sync. The `syncAllMembersFromHubSpot` function in `server/core/memberSync.ts` pulls `membership_status` and `membership_tier` from HubSpot contact properties and writes them to the database. Unrecognized tier strings from HubSpot are logged but not overwritten (preserves existing DB tier via `COALESCE`).

### Staff = VIP Rule

All staff, admin, and golf instructor users are automatically set to `tier = 'VIP'` and `membership_status = 'active'` on every login. The `upsertUserWithTier` function in `server/routes/auth.ts` enforces this with: `UPDATE users SET membership_status = 'active', tier = 'VIP', membership_tier = 'VIP'`. Booking fee service applies $0 fees to staff. The `BookingMember.isStaff` flag is the explicit source of truth for staff detection in booking/roster contexts.

### Email Is the Primary Identifier

All lookups normalize email to lowercase. `MemberService.findByEmail` checks three sources in one query: `users.email`, `users.trackman_email`, and each element of the `users.linked_emails` JSONB array. The `resolveUserByEmail` function in `server/core/stripe/customers.ts` handles linked-email resolution for login, sync, and subscription matching — preventing duplicate user creation for members who use multiple email addresses.

### Billing Provider Guards

The `billing_provider` column controls which system manages a member. Valid values: `'stripe'`, `'mindbody'`, `'manual'`, `'comped'`. Subscription sync preserves non-stripe providers: `CASE WHEN billing_provider IN ('mindbody', 'manual', 'comped') THEN billing_provider ELSE 'stripe' END`. Comped members have full access without billing.

### Member Cache

`MemberService` uses an in-memory cache (`server/core/memberService/memberCache.ts`) to reduce database load:

- **TTL**: 5 minutes per entry
- **Max size**: 1000 entries per cache (total ~3000 across all caches)
- **Caching strategy**: Caches by normalized email AND by member ID for fast lookups in both directions. All linked emails (from `linked_emails` JSONB and `trackman_email`) are also cached to the same entry.
- **Staff cache**: Separate from member cache; staff lookup via `getStaffByEmail(email)` queries a dedicated `staffByEmail` map.
- **Invalidation**: Individual entries are auto-evicted on TTL expiry. Manual invalidation via `invalidateMember(emailOrId)` or `invalidateStaff(email)` when member data is updated.
- **Bypass**: Pass `{ bypassCache: true }` to `MemberService.findByEmail()` or `MemberService.findById()` to force a database read and update the cache.

The cache is shared globally in memory (`memberCache` singleton) and is not persistent across server restarts.

### Email Change Cascade

`cascadeEmailChange()` in `server/core/memberService/emailChangeService.ts` updates a member's email across all tables atomically: users, bookings, sessions, guest passes, billing records, notifications, audit logs, and more. Returns a report of tables and rows affected. Always call this instead of updating email in a single table.

### Type Definitions

`server/core/memberService/memberTypes.ts` defines `MemberRecord`, `StaffRecord`, `BillingMemberMatch`, `MemberLookupOptions`, and identifier detection utilities (`isUUID`, `isEmail`, `isHubSpotId`, `detectIdentifierType`, `normalizeEmail`).

## Login-Time Auto-Fix (Stripe Member Auto-Fix)

When a Stripe-billed member logs in and their database `membership_status` is not in `['active', 'trialing', 'past_due']`:

1. Retrieve the Stripe subscription via `stripe.subscriptions.retrieve(stripeSubscriptionId)`
2. If Stripe says `active`, `trialing`, or `past_due`, update the database to match
3. Sync the corrected status to HubSpot via `syncMemberToHubSpot`
4. If Stripe confirms the subscription is not active, reject login with 403

This runs in both the Google sign-in path and the OTP verification path in `server/routes/auth.ts`.

## Onboarding Flow

### 4-Step Checklist

The onboarding checklist is served by `GET /api/member/onboarding` in `server/routes/members/onboarding.ts`:

1. **Complete profile** — `first_name`, `last_name`, and `phone` must all be set. Tracked by `profile_completed_at`.
2. **Sign club waiver** — Tracked by `waiver_signed_at` and `waiver_version`.
3. **Book first session** — Tracked by `first_booking_at`.
4. **Install the app** — Tracked by `app_installed_at`.

When all four steps are complete, `onboarding_completed_at` is set. Members can dismiss the checklist (`onboarding_dismissed_at`).

### Key Dates in Users Table

| Column | Set When |
|--------|----------|
| `first_login_at` | First successful login (set in auth.ts, non-blocking) |
| `profile_completed_at` | Profile has name + phone |
| `waiver_signed_at` | Waiver signed |
| `first_booking_at` | First booking made |
| `app_installed_at` | PWA installed |
| `onboarding_completed_at` | All 4 steps done |
| `onboarding_dismissed_at` | Member dismissed checklist |
| `welcome_email_sent_at` | Welcome email sent |

### FirstLoginWelcomeModal

On first login, the member dashboard shows `FirstLoginWelcomeModal` (`src/components/FirstLoginWelcomeModal.tsx`). This modal greets the member and introduces the app. It is gated on whether the user has logged in before.

### Welcome Emails

- **Standard welcome**: `sendWelcomeEmail` in `server/emails/welcomeEmail.ts` — sent on first login if `welcome_email_sent` is false and role is `member`. Highlights golf simulators, wellness, and events.
- **Trial welcome**: `sendTrialWelcomeWithQrEmail` in `server/emails/trialWelcomeEmail.ts` — sent to trial members. Includes QR code pass (`MEMBER:{userId}`) for front desk check-in, 7-day trial info, and coupon code (default `ASTORIA7` for 50% off first month).

### Onboarding Nudge Emails

The scheduler in `server/schedulers/onboardingNudgeScheduler.ts` runs hourly but only acts at 10 AM Pacific:

1. Query members where `membership_status IN ('active', 'trialing')`, `billing_provider = 'stripe'`, `first_login_at IS NULL`, `onboarding_completed_at IS NULL`, `onboarding_nudge_count < 3`, and created > 20 hours ago.
2. Send nudge based on `onboarding_nudge_count`:
   - **Nudge 1** at 24h: `sendOnboardingNudge24h`
   - **Nudge 2** at 72h: `sendOnboardingNudge72h`
   - **Nudge 3** at 7d (168h): `sendOnboardingNudge7d`
3. Increment `onboarding_nudge_count` and set `onboarding_last_nudge_at`.

Maximum 20 members processed per run. Minimum 20-hour gap between nudges to a single member.

## Application Pipeline

Membership applications flow through `form_submissions` with `form_type = 'membership'`. Managed in `server/routes/members/applicationPipeline.ts`.

### Pipeline Stages (ordered)

1. `new` — Just submitted
2. `read` — Staff has viewed it
3. `reviewing` — Under review
4. `approved` — Approved for membership
5. `invited` — Stripe checkout link sent via `send-membership-link` endpoint
6. `converted` — Member completed payment and joined
7. `declined` — Application rejected
8. `archived` — No longer relevant

Staff update status via `PUT /api/admin/applications/:id/status`. The invite action (`POST /api/admin/applications/:id/send-invite`) sends a Stripe membership checkout link for the selected tier.

## Grace Period System

When a Stripe invoice payment fails (`invoice.payment_failed` webhook):

1. Set `grace_period_start = NOW()` and `membership_status = 'past_due'` (only if currently `active`)
2. Guard: skip if subscription is already `canceled`/`incomplete_expired`, user is already `cancelled`/`suspended`, or `billing_provider != 'stripe'`
3. Update `hubspot_deals.last_payment_status` to `'failed'` with failure reason
4. Send immediate notifications: in-app notification to member, payment failed email, staff notification (escalating urgency on attempts ≥ 2)
5. The grace period scheduler (`server/schedulers/gracePeriodScheduler.ts`) runs every hour but only acts at 10 AM Pacific
6. Send up to 3 daily emails with a Stripe billing portal link for payment method update
7. The reactivation link is generated via `stripe.billingPortal.sessions.create` with `flow_data.type = 'payment_method_update'` (falls back to `/billing` page)
8. After 3 days and 3 emails: set `membership_status = 'terminated'`, save `tier` to `last_tier`, clear `tier` to NULL, clear grace period fields, sync to HubSpot, notify all staff with push notification

For Mindbody members: grace period is started by `memberSync.ts` when it detects a status transition to a problematic status (past_due, declined, suspended, expired, terminated, cancelled, frozen). Only applies when `billing_provider = 'mindbody'` and no existing grace period.

### Grace Period Database Fields

| Column | Purpose |
|--------|---------|
| `grace_period_start` | When the grace period began (NULL = not in grace period) |
| `grace_period_email_count` | Number of reminder emails sent (0-3) |

When a member reactivates (new subscription or subscription sync), both fields are cleared: `grace_period_start = NULL`, `grace_period_email_count = 0`.

## Cancellation Flow

Cancellation is triggered by the `customer.subscription.deleted` Stripe webhook. The behavior differs based on the member's previous status:

- **Trial members** (`membership_status = 'trialing'`): set to `paused` (account preserved, booking blocked). Stripe subscription ID cleared. Staff notified "Trial Expired."
- **Regular members**: set to `cancelled`, tier saved to `last_tier`, tier cleared to NULL, subscription ID cleared. HubSpot deal moved to lost, deal line items removed. If member was primary on a billing group, all sub-members are deactivated and the group is deactivated.

Guard: the webhook only processes if the user's `stripe_subscription_id` matches the deleted subscription. This prevents processing old/duplicate subscription deletions.

See [references/transitions.md](references/transitions.md) for all status transitions.

## Tier Changes

Tier changes can be immediate (upgrade, proration invoiced) or end-of-cycle (downgrade, no proration). Staff initiate changes via the admin panel. The system previews the financial impact before committing.

See [references/tier-changes.md](references/tier-changes.md) for the full tier change flow including proration handling and HubSpot sync.

## Member Sync from HubSpot

`syncAllMembersFromHubSpot` in `server/core/memberSync.ts` performs a full reconciliation:

1. Fetch all contacts from HubSpot with membership properties (tier, status, Mindbody ID, etc.)
2. Load `sync_exclusions` table to skip permanently deleted members
3. Process contacts in parallel batches of 25 with concurrency limit of 10
4. For each contact: resolve email via linked emails, check for existing user in DB
5. Upsert user with HubSpot data; **Stripe-protected members skip status/tier updates** (`STRIPE WINS`)
6. Visitor-protected users skip status/tier/role updates
7. Detect status changes and send notifications for problematic transitions (past_due, suspended, etc.)
8. Detect HubSpot ID collisions (same HubSpot contact mapped to multiple DB users) and create `user_linked_emails` entries
9. Sync membership notes from HubSpot (via Mindbody) with change-detection hashing to avoid duplicate notes
10. 5-minute cooldown between syncs to prevent overload

## Subscription Sync from Stripe

`syncActiveSubscriptionsFromStripe` in `server/core/stripe/subscriptionSync.ts`:

1. Fetch all Stripe subscriptions with status `active`, `trialing`, or `past_due` (global list first, per-customer fallback for test clocks)
2. Batch-fetch product details to extract tier names from metadata or product name
3. For each subscription: extract customer email, tier, name, and Stripe IDs
4. For existing users: update if Stripe IDs, tier, or HubSpot ID changed; skip if updated within 5 minutes (webhook race guard)
5. For new users: resolve via linked email first; if no match, check `sync_exclusions`; then create user with `data_source = 'stripe_sync'`
6. Clear grace period fields for all synced members
7. Sync each user to HubSpot (create contact + sync stage/status)

## Startup Backfills

On server startup (`server/loaders/startup.ts`):

- Backfill `first_login_at` from booking history for members who have self-requested bookings but no recorded first login
- Backfill `last_tier` for former members (status in `cancelled`, `expired`, `paused`, `inactive`, `terminated`, `suspended`, `frozen`, `declined`, `churned`, `former_member`) who have a tier set but no `last_tier` value

## Webhook Event Ordering

Stripe webhooks use deduplication and priority-based ordering (`server/core/stripe/webhooks.ts`):

- Events are deduplicated with 7-day window via `webhook_processed_events` table
- Each event is claimed atomically via `INSERT ... ON CONFLICT DO NOTHING`
- Resource-level ordering prevents stale events using priority scores:
  - `subscription.created` (1) → `subscription.updated` (5) → `subscription.paused` (8) → `subscription.resumed` (9) → `subscription.deleted` (20)
  - Special case: `subscription.created` after `subscription.deleted` is blocked to prevent ghost reactivation
- All DB mutations run in transactions; non-critical side effects (HubSpot sync, notifications, emails) are deferred and executed after the transaction commits
- Failed deferred actions are logged but do not roll back the core state change

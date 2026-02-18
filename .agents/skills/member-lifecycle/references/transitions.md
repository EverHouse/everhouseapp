# Status Transitions

## Active Membership Transitions

### → `active`

| From | Trigger | Guard |
|------|---------|-------|
| `(new user)` | Stripe subscription sync creates user with active subscription | Subscription status is `active` or `trialing` |
| `(new user)` | Staff creates member via admin action or HubSpot sync | — |
| `past_due` | Stripe `customer.subscription.updated` webhook with status `active` | `billing_provider = 'stripe'` |
| `frozen` | Stripe `customer.subscription.resumed` webhook | `billing_provider = 'stripe'` |
| `suspended` | Stripe `customer.subscription.resumed` webhook | `billing_provider = 'stripe'` |
| `cancelled` | New Stripe subscription created (re-subscription) | Subscription sync or webhook processes new subscription |
| `(any inactive)` | Login auto-fix: Stripe subscription is actually active | `stripeSubscriptionId` exists and Stripe confirms active status |
| `trialing` | Stripe subscription transitions from `trialing` to `active` | Webhook `customer.subscription.updated` |

### → `trialing`

| From | Trigger | Guard |
|------|---------|-------|
| `(new user)` | Stripe subscription created with trial period | Subscription status is `trialing` |
| `(new user)` | Admin creates trial member | Trial welcome email with QR code sent |

### → `past_due`

| From | Trigger | Guard |
|------|---------|-------|
| `active` | Stripe `invoice.payment_failed` webhook | `billing_provider = 'stripe'`; subscription not already `canceled`; user not already `cancelled`/`suspended` |

Grace period starts simultaneously. The `grace_period_start` column is set and `grace_period_email_count` initialized to 0.

### → `suspended`

| From | Trigger | Guard |
|------|---------|-------|
| `active` | Admin pauses membership via `POST /api/members/:id/suspend` | Staff/admin role required |
| `active` | Stripe `pause_collection` set on subscription (admin-initiated) | `billing_provider = 'stripe'` and `stripeSubscriptionId` exists |

For Stripe members: calls `pauseSubscription` which sets `pause_collection.behavior = 'mark_uncollectible'` with a resume date.
For Mindbody members: sets status to `suspended` in DB only; staff must pause billing in Mindbody manually.

### → `frozen`

| From | Trigger | Guard |
|------|---------|-------|
| `active` | Stripe `customer.subscription.paused` webhook | `billing_provider = 'stripe'` |

This is the automatic Stripe pause (distinct from admin-initiated suspension). Maps Stripe's paused state to `frozen` in the database. Syncs to HubSpot as `frozen`.

### → `paused`

| From | Trigger | Guard |
|------|---------|-------|
| `trialing` | Stripe `customer.subscription.deleted` webhook when previous status was `trialing` | — |

Trial end: account is preserved but booking is blocked. The `stripe_subscription_id` is cleared. Staff receives "Trial Expired" notification. Member notified "Your free trial has ended."

### → `cancelled`

| From | Trigger | Guard |
|------|---------|-------|
| `active` | Stripe `customer.subscription.deleted` webhook (non-trial) | `billing_provider = 'stripe'`; current subscription ID matches |
| `past_due` | Stripe `customer.subscription.deleted` webhook | Same guards as above |

On cancellation:
1. Save current tier to `last_tier`
2. Clear `tier` to NULL
3. Set `membership_status = 'cancelled'`
4. Clear `stripe_subscription_id`
5. Clear grace period fields
6. Sync `cancelled` status to HubSpot
7. Call `handleMembershipCancellation` to remove HubSpot deal line items and move deal to lost
8. If member was primary on a billing group: deactivate group, deactivate all sub-members, notify staff of orphaned members

Guard: if the `stripe_subscription_id` on the user does not match the deleted subscription, skip (prevents processing old subscription deletions).

### → `terminated`

| From | Trigger | Guard |
|------|---------|-------|
| `past_due` | Grace period scheduler after 3 days and 3 emails sent | `grace_period_email_count >= 3` AND `days_since_start >= 3` |

On termination:
1. Save current tier to `last_tier`
2. Clear `tier` to NULL
3. Set `membership_status = 'terminated'`
4. Clear grace period fields
5. Sync to HubSpot as `terminated`
6. Notify all staff with push notification

### → `archived`

| From | Trigger | Guard |
|------|---------|-------|
| `(any)` | Staff archives member via `DELETE /api/members/:email` | Staff/admin role; member not already archived |

On archival:
1. Set `archived_at`, `archived_by`, `membership_status = 'archived'`
2. Clear `id_image_url`
3. If Stripe subscription exists: cancel it via `stripe.subscriptions.cancel`
4. If no direct subscription but Stripe customer exists: list and cancel all active subscriptions
5. Archived members are excluded from most queries via `archived_at IS NULL`

### → `non-member`

| From | Trigger | Guard |
|------|---------|-------|
| `(any)` | Admin clears tier via `PATCH /api/members/:email/tier` with empty tier | Staff/admin role |

When tier is set to null/empty: save current tier to `last_tier`, clear tier, set status to `non-member`.

### → `merged`

| From | Trigger | Guard |
|------|---------|-------|
| `(any)` | User merge operation via `executeMerge` | Duplicate detection found matching users |

## Grace Period Details

### How It Starts

- **Stripe members**: `invoice.payment_failed` webhook sets `grace_period_start = NOW()` and transitions status to `past_due`
- **Mindbody members**: `memberSync.ts` detects status change to a problematic status and sets `grace_period_start`

### Daily Processing

The grace period scheduler (`server/schedulers/gracePeriodScheduler.ts`) runs every hour but only acts at 10 AM Pacific:

1. Query all users with `grace_period_start IS NOT NULL` and `grace_period_email_count < 3`
2. For each member:
   - Generate a Stripe billing portal session URL for payment method update (falls back to `/billing` page)
   - Send `sendGracePeriodReminderEmail` with day number (1/3, 2/3, 3/3), urgency escalation on day 3
   - Increment `grace_period_email_count`
3. After sending email 3: check if `days_since_start >= 3` (Pacific time), then terminate

### Stuck Cancellation Check

Before starting a grace period, the webhook verifies the Stripe subscription is not already `canceled` or `incomplete_expired`. This prevents starting grace periods for subscriptions that Stripe has already terminated.

## Reactivation

### Stripe Re-subscription

A cancelled member can reactivate by:
1. Creating a new Stripe subscription (via checkout link or membership signup)
2. The `customer.subscription.created` webhook or subscription sync creates/updates the user with `active` status
3. Grace period fields are cleared: `grace_period_start = NULL`, `grace_period_email_count = 0`

### Login Auto-Fix

If a member's database status is stale (e.g., marked `cancelled` but Stripe subscription is actually `active`), the login flow auto-corrects:
1. Retrieve subscription from Stripe
2. If Stripe says active/trialing/past_due, update database to match
3. Allow login to proceed

### Subscription Sync

`syncActiveSubscriptionsFromStripe` bulk-reconciles: any user with an active Stripe subscription gets set to `active` status, grace period cleared, and tier synced.

## Billing Provider Guards

Most webhook handlers check `billing_provider` before processing:
- If `billing_provider` is not `'stripe'` (e.g., `'mindbody'`, `'manual'`, `'comped'`), Stripe webhooks skip the user
- This prevents Stripe events from overwriting manually-managed or legacy member status
- The subscription sync preserves non-stripe billing providers: `CASE WHEN billing_provider IN ('mindbody', 'manual', 'comped') THEN billing_provider ELSE 'stripe' END`

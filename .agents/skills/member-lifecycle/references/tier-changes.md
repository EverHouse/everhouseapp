# Tier Changes

## Membership Tiers

| Tier | Rank | Description |
|------|------|-------------|
| Social | 1 | Basic access |
| Core | 2 | Standard membership |
| Premium | 3 | Enhanced access |
| VIP | 4 | Full access (also auto-assigned to staff) |
| Corporate | 5 | Business membership |

Each tier is stored in `membership_tiers` table with: `id`, `name`, `slug`, `stripe_price_id`, `founding_price_id`, `price_cents`, `daily_sim_minutes`, `guest_passes_per_month`, `booking_window_days`, `can_book_simulators`, `can_book_conference`, `can_book_wellness`, `unlimited_access`.

## Tier Change Flow (Staff-Initiated via Admin Panel)

### Step 1: Preview

Staff selects a new tier for a member. The system calls `previewTierChange` in `server/core/stripe/tierChanges.ts`:

1. Retrieve the current subscription from Stripe with expanded price/product
2. Retrieve the new price details from Stripe
3. If immediate change: use `stripe.invoices.createPreview` to calculate proration amount and next invoice
4. If end-of-cycle: return zero proration with effective date at `current_period_end`
5. Return `TierChangePreview` with current/new tier names, amounts, proration, and effective date

### Step 2: Commit

Staff confirms the change. The system calls `commitTierChange` in `server/core/stripe/tierChanges.ts`:

1. Look up the current tier name from the database using the current Stripe price ID
2. Find the new tier in `membership_tiers` by `stripe_price_id`
3. Call `changeSubscriptionTier` to update the Stripe subscription
4. If immediate: update `users.tier` in the database, sync metadata to Stripe customer, sync to HubSpot
5. If end-of-cycle: skip DB update (the `customer.subscription.updated` webhook handles it when Stripe applies the change)
6. Insert a `member_notes` audit trail entry with old tier, new tier, change type, and staff email
7. Verify the DB update by re-reading the tier (log warning if mismatch)

### Available Tiers for Change

`getAvailableTiersForChange` returns active tiers that have a `stripe_price_id` and are not `one_time` products. This filters out day passes and other non-subscription products.

## Stripe Subscription Tier Change

`changeSubscriptionTier` in `server/core/stripe/subscriptions.ts`:

### Immediate Change (Upgrade)
1. Retrieve the subscription and get the current item ID
2. Resolve the customer's default payment method (check subscription → customer invoice_settings → first attached card)
3. Update the subscription item with the new price, `proration_behavior: 'always_invoice'`, and `cancel_at_period_end: false`
4. Set the `default_payment_method` on the subscription to ensure the proration invoice charges the card

### End-of-Cycle Change (Downgrade)
1. Update the subscription item with the new price, `proration_behavior: 'none'`, and `cancel_at_period_end: false`
2. The price change takes effect at the next billing cycle

## Webhook-Driven Tier Sync

When Stripe fires `customer.subscription.updated`, the webhook handler in `server/core/stripe/webhooks.ts`:

1. Extract the current price ID from the subscription
2. Look up the tier in `membership_tiers` by `stripe_price_id` or `founding_price_id`
3. If no match: fall back to matching by Stripe product name against tier keywords (`vip`, `premium`, `corporate`, `core`, `social`)
4. If the new tier differs from the current `users.tier`, update the database
5. Sync the tier change to HubSpot via `handleTierChange` (updates contact properties and deal line items)
6. If HubSpot sync fails, queue for retry via `queueTierSync`
7. Notify the member of the tier change and broadcast via WebSocket

Guard: skip if `billing_provider` is not `'stripe'`.

## tierSync Module

`server/core/memberService/tierSync.ts` provides three functions:

### `syncMemberTierFromStripe(email, stripePriceId)`

1. Look up the tier by `stripe_price_id` or `founding_price_id` in `membership_tiers`
2. Update `users.tier` and `users.tier_id` for the matching email
3. Sync the new tier to HubSpot via `syncMemberToHubSpot`

### `syncMemberStatusFromStripe(email, stripeStatus)`

Map Stripe subscription status to membership status:
- `active` / `trialing` → `active`
- `past_due` → `past_due`
- `canceled` → `cancelled`
- `unpaid` → `suspended`
- `incomplete` → `pending`

Update `users.membership_status` and sync to HubSpot.

### `validateTierConsistency(email)`

Check that `users.tier` matches the slug of `users.tier_id`'s membership tier. Report issues like:
- `tier` doesn't match `tier_id`'s slug
- `tier_id` is set but `tier` is null (or vice versa)

Recommend running `syncMemberTierFromStripe` to fix inconsistencies.

## memberTierUpdateProcessor

`server/core/memberTierUpdateProcessor.ts` processes tier updates from any source (admin, CSV import, etc.):

1. Fetch the current user data (tier, billing provider, subscription ID)
2. Skip if the user is already on the target tier
3. Update `users.tier` and `users.tier_id` in the database
4. If `syncToHubspot` is true: call `handleTierChange` to sync to HubSpot (contact properties + deal line items)
5. If HubSpot sync fails: queue for retry via `queueTierSync`
6. Determine change type (set, upgraded, changed, cleared) based on tier rank comparison
7. Send in-app notification to the member about the tier change

Tier rank for comparison: Social (1) < Core (2) < Premium (3) < VIP (4) < Corporate (5).

## Subscription Sync Tier Extraction

During `syncActiveSubscriptionsFromStripe`, tiers are extracted from Stripe products:

1. Check `product.metadata.tier` first
2. Fall back to `product.name` and normalize via `normalizeTierName`
3. The `normalizeTierName` utility maps various formats (e.g., "VIP Membership", "core-monthly") to canonical tier names

## HubSpot Tier Sync

When a tier changes, HubSpot is updated via two paths:

1. **Contact properties**: `syncMemberToHubSpot` updates the contact's `membership_tier` property
2. **Deal line items**: `handleTierChange` removes the old tier's line item from the member's deal and adds the new tier's line item; logs the change via `queueTierSync` if immediate sync fails

## Tier ID Mapping

The `getTierIdFromTierName` function maps display names to numeric IDs:
- Social → 1, Core → 2, Premium → 3, Corporate → 4, VIP → 5

The `membership_tiers` table is the authoritative source; this mapping is a fallback for quick lookups during processing.

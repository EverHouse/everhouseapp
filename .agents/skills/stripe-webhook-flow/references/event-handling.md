# Stripe Event Handling Reference

Complete mapping of every Stripe event type handled by the webhook system, the function that processes it, and the downstream effects it triggers.

## Error Handling and Retry Behavior

- If any handler throws, the PostgreSQL transaction is rolled back (including the `webhook_processed_events` claim). The endpoint returns a 500, and Stripe retries with exponential backoff (up to ~72 hours).
- Deferred actions (notifications, HubSpot syncs, emails) are wrapped in try/catch — failures are logged but never propagate. If `handleTierChange` fails during a deferred action, it falls back to `queueTierSync` for async retry.
- Payment retry tracking: `handlePaymentIntentFailed` increments `retry_count` on `stripe_payment_intents`. After `MAX_RETRY_ATTEMPTS` (3), it sets `requires_card_update = true` and sends escalating notifications.
- HubSpot queue operations retry with exponential backoff (1 min base, 1 hour max). After 5 retries, jobs move to dead letter status.

## Payment Intent Events

### `payment_intent.succeeded` → `handlePaymentIntentSucceeded`

- Update `stripe_payment_intents` status to `succeeded`
- If `feeSnapshotId` in metadata: validate snapshot, verify fee amounts, mark participants as paid, create audit records
- If no snapshot but `participantFees` in metadata: fallback DB-based validation, mark participants as paid
- Process pending credit refunds (`stripe_credit_refund` job) if `pendingCreditRefund` in metadata
- Process credit consumption (`stripe_credit_consume` job) if `creditToConsume` in metadata
- **Deferred:** upsert transaction cache, audit log, HubSpot sync (`sync_to_hubspot` job), payment receipt email, member notification, staff notification, billing broadcast

### `payment_intent.payment_failed` → `handlePaymentIntentFailed`

- Increment `retry_count` on `stripe_payment_intents`, set `failure_reason`
- After `MAX_RETRY_ATTEMPTS` (3), set `requires_card_update = true`
- Mark related `booking_fee_snapshots` as failed
- **Deferred:** upsert transaction cache, audit log, error alert, member email (payment failed), staff notification, billing broadcast

### `payment_intent.canceled` → `handlePaymentIntentCanceled`

- If `paymentType === 'subscription_terminal'`: update `terminal_payments` to canceled
- **Deferred:** staff notification, audit log

### `payment_intent.processing` / `payment_intent.requires_action` → `handlePaymentIntentStatusUpdate`

- Update `stripe_payment_intents` status
- **Deferred:** upsert transaction cache

## Charge Events

### `charge.refunded` → `handleChargeRefunded`

- Cache each refund object in transaction cache
- Update `stripe_payment_intents` status to refunded/partially_refunded
- Mark `booking_participants` as refunded, create audit records
- If full refund on terminal payment: suspend membership, notify member
- **Deferred:** upsert transaction cache (charge + refunds), audit log per refund, billing broadcast

### `charge.dispute.created` → `handleChargeDisputeCreated`

- Update `terminal_payments` to disputed status
- Suspend member's membership
- **Deferred:** urgent staff notification, audit log, billing broadcast

### `charge.dispute.closed` → `handleChargeDisputeClosed`

- If dispute won: reactivate membership, mark terminal payment as succeeded
- If dispute lost: mark terminal payment as disputed_lost
- **Deferred:** staff notification, audit log, billing broadcast

## Invoice Events

### `invoice.payment_succeeded` → `handleInvoicePaymentSucceeded`

- Skip if no subscription (one-time invoice)
- **Billing provider guard:** skip grace period clearing if not stripe
- Clear grace period: `grace_period_start = NULL`, `grace_period_email_count = 0`
- Restore tier from subscription price ID
- Update `hubspot_deals.last_payment_status` to `current`
- **Deferred:** upsert transaction cache, renewal email, staff notification, HubSpot deal sync, billing broadcast

### `invoice.payment_failed` → `handleInvoicePaymentFailed`

- **Billing provider guard:** skip grace period if not stripe
- Set `grace_period_start` and increment `grace_period_email_count`
- Update `hubspot_deals.last_payment_status` to `failed`
- **Deferred:** upsert transaction cache, failed payment email, staff notification, billing broadcast

### `invoice.created` / `invoice.finalized` / `invoice.updated` → `handleInvoiceLifecycle`

- **Deferred:** upsert transaction cache

### `invoice.voided` / `invoice.marked_uncollectible` → `handleInvoiceVoided`

- **Deferred:** upsert transaction cache

## Subscription Events

### `customer.subscription.created` → `handleSubscriptionCreated`

- Find user by `stripe_customer_id` or `purchaser_email` metadata
- If no user found: fetch Stripe customer, create user with tier from metadata/price lookup
- If existing user: **billing provider guard** — skip if not stripe; conditional status update (only upgrade from pending/inactive/non-member)
- Resolve tier from: subscription metadata (`tier_slug`/`tierSlug`) → price ID lookup → product name keyword match
- Check sync_exclusions to prevent creating permanently deleted users
- **Direct:** member notification ("Subscription Started"), staff notification ("New Member Joined"), billing broadcast
- **Deferred:** HubSpot contact creation, tier sync via `handleTierChange`, queue `queueTierSync` on failure

### `customer.subscription.updated` → `handleSubscriptionUpdated`

- Detect item changes via `previous_attributes.items` → call `handleSubscriptionItemsChanged`
- **Billing provider guard:** skip if not stripe
- Tier change detection: match price ID → `membership_tiers`, fallback to product name keyword match
- Status handling:
  - `active` → set active, reactivate sub-members (group cascade), sync to HubSpot
  - `past_due` → set past_due, cascade to sub-members, notify member + staff
  - `unpaid` → set suspended, cascade to sub-members, notify member + staff
  - `canceled` → logged only (handled by `subscription.deleted`)
- **Deferred:** HubSpot tier/status sync, billing broadcast

### `customer.subscription.paused` → `handleSubscriptionPaused`

- **Billing provider guard:** skip if not stripe
- Set `membership_status = 'frozen'`
- **Deferred:** HubSpot sync (status=frozen), member notification, staff notification, audit log

### `customer.subscription.resumed` → `handleSubscriptionResumed`

- **Billing provider guard:** skip if not stripe
- Set `membership_status = 'active'`
- **Deferred:** HubSpot sync (status=active), member notification, staff notification, audit log

### `customer.subscription.deleted` → `handleSubscriptionDeleted`

- Call `handlePrimarySubscriptionCancelled(subscriptionId)` for group billing cleanup
- **Billing provider guard:** skip if not stripe
- **Subscription ID match guard:** only cancel if `stripe_subscription_id` matches
- If was trialing: set status to `paused` (account preserved), notify about trial end
- If not trialing: set `membership_status = 'cancelled'`, clear tier (save to `last_tier`), clear subscription ID
- Deactivate billing group, notify about orphaned sub-members
- **Deferred:** HubSpot sync (status=cancelled), `handleMembershipCancellation` (remove deal line items, move deal to lost), member/staff notifications

## Checkout Session Events

### `checkout.session.completed` → `handleCheckoutSessionCompleted`

Routing based on `session.metadata`:

| Metadata | Action |
|---|---|
| `purpose === 'add_funds'` | Credit Stripe customer balance, send receipt, notify staff |
| `company_name` present | `syncCompanyToHubSpot`, update user and billing_group with HubSpot company ID |
| `source === 'activation_link'` | Activate pending user, set billing_provider=stripe, HubSpot contact+deal sync |
| `source === 'staff_invite'` | Create/update user, resolve via linked emails, HubSpot sync, mark form as converted |
| `purpose === 'day_pass'` | `recordDayPassPurchaseFromWebhook`, QR code email, staff notification, HubSpot day pass sync |

## Product and Price Events

### `product.updated` → `handleProductUpdated`

- If matched to a tier: update `highlighted_features` from `marketing_features`, defer `pullTierFeaturesFromStripe()`
- If `config_type === 'corporate_volume_pricing'`: defer `pullCorporateVolumePricingFromStripe()`
- If `cafe_item_id` in metadata: update cafe item name, description, image, category

### `product.created` → `handleProductCreated`

- Skip if `metadata.source === 'ever_house_app'` (prevent loop)
- If matched to a tier: defer `pullTierFeaturesFromStripe()`

### `product.deleted` → `handleProductDeleted`

- If matched to a tier: clear `stripe_product_id` and `stripe_price_id`, call `clearTierCache()`
- If matched to cafe items: deactivate them

### `price.updated` / `price.created` → `handlePriceChange`

- Update `cafe_items.price` and `stripe_price_id` for matching product
- Update `membership_tiers.price_cents` and `stripe_price_id` for matching product
- If tier slug is `simulator-overage-30min`: call `updateOverageRate(priceCents)`
- If tier slug is `guest-pass`: call `updateGuestFee(priceCents)`
- Call `clearTierCache()` after tier price updates

## Coupon Events

### `coupon.updated` / `coupon.created`

- If `coupon.id === 'FAMILY20'`: call `updateFamilyDiscountPercent(coupon.percent_off)`

### `coupon.deleted`

- If `coupon.id === 'FAMILY20'`: log that it will be recreated on next use

## Credit Note Events

### `credit_note.created` → `handleCreditNoteCreated`

- **Deferred:** upsert transaction cache (as refund type), member notification ("Credit Applied")

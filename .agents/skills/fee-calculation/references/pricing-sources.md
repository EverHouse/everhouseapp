# Pricing Sources — Dynamic Pricing and Stripe Product Sync

## Architecture

Pricing flows from **Stripe products → in-memory config → fee calculations**:

1. Stripe holds the authoritative price for each fee product.
2. On server startup, `ensureSimulatorOverageProduct()` and `ensureGuestPassProduct()` read the Stripe price and call `updateOverageRate()` / `updateGuestFee()`.
3. All fee calculations read from the `PRICING` object in `pricingConfig.ts`, which returns the dynamically updated values.

## Pricing Config (pricingConfig.ts)

### In-Memory Rate Store

```
_overageRateCents = 2500  (default $25)
_guestFeeCents    = 2500  (default $25)
```

Exposed via the `PRICING` object with computed getters:
- `PRICING.OVERAGE_RATE_CENTS` / `PRICING.OVERAGE_RATE_DOLLARS`
- `PRICING.OVERAGE_BLOCK_MINUTES` = 30 (constant)
- `PRICING.GUEST_FEE_CENTS` / `PRICING.GUEST_FEE_DOLLARS`

### Update Functions

- `updateOverageRate(cents)` — set `_overageRateCents`, log the change.
- `updateGuestFee(cents)` — set `_guestFeeCents`, log the change.

These are called at startup from `server/core/stripe/products.ts` after reading Stripe prices.

### Helper Functions

- `calculateOverageCents(overageMinutes)` — `ceil(minutes / 30) * OVERAGE_RATE_CENTS`.
- `calculateOverageDollars(overageMinutes)` — same logic, returns dollars.
- `getOverageRateCents()` / `getGuestFeeCents()` — direct accessors.

### Corporate and Family Pricing

Also maintained in `pricingConfig.ts`:
- **Corporate volume tiers** — descending brackets by member count (50+ → $249, 20+ → $275, 10+ → $299, 5+ → $325, base → $350).
- `updateCorporateVolumePricing(tiers, basePrice, stripeProductId?)` — update from Stripe.
- `updateFamilyDiscountPercent(percent)` — default 20%.

## Stripe Product Catalog (products.ts)

### Simulator Overage Product

`ensureSimulatorOverageProduct()`:

1. Check `membership_tiers` for slug `simulator-overage-30min`.
2. Create database record if missing (product type: `one_time`, price: `PRICING.OVERAGE_RATE_CENTS`).
3. Create or verify Stripe product with metadata `fee_type: 'simulator_overage'`, `app_category: 'fee'`.
4. Create or verify Stripe price (`unit_amount` = overage rate in cents, currency USD).
5. Store `stripeProductId` and `stripePriceId` in `membership_tiers`.
6. **Read the actual Stripe price** via `stripe.prices.retrieve()` and call `updateOverageRate(actualPrice.unit_amount)`.

This last step is what makes pricing dynamic — if an admin changes the Stripe price, the app picks it up on next restart.

### Guest Pass Product

`ensureGuestPassProduct()`:

Same pattern as overage product:
1. Slug: `guest-pass`, name: "Guest Pass".
2. Create database and Stripe records if missing.
3. Read actual Stripe price and call `updateGuestFee(actualPrice.unit_amount)`.

### Tier-Specific Guest Fees

Individual membership tiers can define a `guest_fee_cents` column in `membership_tiers`. When present, `feeCalculator.ts` uses `tier_guest_fee_cents` instead of the global `PRICING.GUEST_FEE_CENTS` for that tier's bookings. This allows different tiers to have different guest fee rates.

### Day Pass Products

Additional one-time products created via `ensureDayPassCoworkingProduct()` and similar functions:
- "Day Pass - Coworking" at $35.
- Each follows the same ensure pattern: check DB → create Stripe product → create price → store IDs.

## HubSpot → Stripe Product Sync

Products originating from HubSpot can be synced to Stripe:

1. `fetchHubSpotProducts()` — paginate all HubSpot CRM products with properties `name`, `price`, `hs_sku`, `description`, `hs_recurring_billing_period`.
2. `syncHubSpotProductToStripe()` — for each product:
   - If already synced (exists in `stripe_products` table by `hubspot_product_id`), update the Stripe product and check for price changes.
   - If price changed, deactivate old Stripe price, create new one.
   - If not synced, search Stripe for existing product by metadata or name to prevent duplicates, then create product + price.
   - Store in `stripe_products` table: `hubspot_product_id`, `stripe_product_id`, `stripe_price_id`, `name`, `price_cents`, `billing_interval`.
3. `syncAllHubSpotProductsToStripe()` — batch sync all HubSpot products.

### Recurring vs One-Time

- Products with names matching `/pass|pack|fee|merch/i` are forced to one-time pricing (no recurring).
- Otherwise, parse `hs_recurring_billing_period` (ISO 8601 duration like `P1M`, `P1Y`) to set Stripe recurring interval.

## Membership Tier Sync to Stripe

`syncMembershipTiersToStripe()`:

1. Load all active tiers from `membership_tiers`.
2. For each tier with `priceCents > 0`:
   - Build privilege metadata (daily sim minutes, guest passes, booking window, etc.).
   - Build marketing features for Stripe Pricing Tables from `highlighted_features`.
   - Create or update Stripe product with metadata and features.
   - Create or update Stripe price (detect price changes, deactivate old price, create new).
   - Store `stripeProductId` and `stripePriceId` back to `membership_tiers`.

Privilege metadata includes: `privilege_daily_sim_minutes`, `privilege_guest_passes`, `privilege_booking_window_days`, `privilege_conf_room_minutes`, `privilege_unlimited_access`, booking capabilities, and lesson flags.

## How Rates Flow Into Fee Calculations

1. **Server starts** → `ensureSimulatorOverageProduct()` and `ensureGuestPassProduct()` run.
2. Both read the live Stripe price → call `updateOverageRate()` / `updateGuestFee()`.
3. `PRICING.OVERAGE_RATE_CENTS` and `PRICING.GUEST_FEE_CENTS` now reflect Stripe values.
4. `computeFeeBreakdown()` reads `PRICING.GUEST_FEE_CENTS` for guest line items.
5. `calculateOverageFee()` in `usageCalculator.ts` reads `PRICING.OVERAGE_RATE_DOLLARS` and `PRICING.OVERAGE_BLOCK_MINUTES`.
6. `feeCalculator.ts` reads `PRICING.GUEST_FEE_CENTS` as fallback when no tier-specific guest fee exists.

To change a fee rate: update the Stripe price for the corresponding product, then restart the server (or wait for the next deployment).

## Key Database Tables

| Table | Role |
|-------|------|
| `membership_tiers` | Tier definitions including `stripe_product_id`, `stripe_price_id`, `guest_fee_cents`, daily allowances |
| `stripe_products` | HubSpot-synced product catalog with Stripe IDs and prices |
| `usage_ledger` | Per-session per-member usage records with `minutes_charged`, `overage_fee`, `guest_fee` |
| `guest_passes` | Monthly guest pass tracking: `passes_used`, `passes_total` per member |
| `guest_pass_holds` | Reserved passes for pending bookings |
| `booking_participants` | Per-participant data including `cached_fee_cents`, `payment_status`, `used_guest_pass` |
| `stripe_payment_intents` | Prepayment and other payment intent records |

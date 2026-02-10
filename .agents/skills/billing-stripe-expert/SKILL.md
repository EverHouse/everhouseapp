# Billing & Stripe Expert

## When to Use This Skill
Consult this skill **before** writing or modifying ANY code that touches:
- Stripe API calls, webhooks, or product catalog
- Payment processing (one-time, subscriptions, terminal, day passes)
- Fee calculation (guest fees, overage fees, prepayments)
- Booking sessions and billing sessions
- Subscription lifecycle (create, update, cancel, tier change)
- Grace periods, dunning, or payment recovery
- Invoices, refunds, disputes, or coupons
- Pricing display on any frontend page
- Any table: `booking_sessions`, `stripe_payment_intents`, `booking_fee_snapshots`, `webhook_processed_events`, `stripe_transaction_cache`, `guest_passes`, `billing_groups`, `terminal_payments`

---

## The 10 Commandments of Billing

### 1. Stripe Is the Source of Truth
**NEVER hardcode prices** (e.g., `$25`) anywhere in the codebase. All dollar amounts must come from the Stripe Product Catalog or the database cache of it.

- **Pricing singleton**: `server/core/billing/pricingConfig.ts`
  - `PRICING.OVERAGE_RATE_DOLLARS` / `PRICING.OVERAGE_RATE_CENTS` — dynamic getters
  - `PRICING.GUEST_FEE_DOLLARS` / `PRICING.GUEST_FEE_CENTS` — dynamic getters
  - `PRICING.OVERAGE_BLOCK_MINUTES` = 30 (business logic, not a price)
  - `updateOverageRate(cents)` and `updateGuestFee(cents)` — called at startup and via webhooks
- **Startup loader**: `server/loaders/startup.ts` fetches current prices from Stripe on boot
- **Webhook refresh**: `product.updated` / `price.updated` webhooks trigger `updateOverageRate()` / `updateGuestFee()`
- **Frontend hook**: `src/hooks/usePricing.ts` fetches dynamic pricing from the API — never import constants

**If you see a raw number like `2500` or `25` representing dollars/cents, it is a bug.**

### 2. Sessions = Money
A **Booking** (`booking_requests`) is just a calendar reservation. A **BookingSession** (`booking_sessions`) is the billable financial record. Every billable booking MUST have a session.

- **Mandatory function**: `ensureSessionForBooking()` in `server/core/bookingService/sessionManager.ts`
- Call this after every booking approval, Trackman link, or CSV import
- **3-step lookup chain** (v7.26.1): (1) match by `trackman_booking_id`, (2) match by `resource_id + session_date + start_time`, (3) match by time range overlap. Only INSERTs if all 3 fail.
- **Transaction-aware**: throws immediately on failure when called with a `client` (no retry). 500ms retry only with pool connections.
- Flags booking for staff review on persistent failure (never silently fails)
- Also: `createSessionWithUsageTracking()` — creates session + usage ledger entries + guest pass deductions atomically

### 3. No Ghost Sessions
When creating a session, you MUST immediately link it to the **Booking ID** and the **User ID**.

- `createSession()` in `sessionManager.ts` requires `bookingId` and `userId`
- The session must be linked before any fee calculations run
- An unlinked session = lost revenue (no way to bill)

### 4. Webhooks Rule
We do NOT poll for payment status. We rely on Stripe Webhooks to update our database.

- **Webhook handler**: `server/core/stripe/webhooks.ts` — `processStripeWebhook()`
- Key events handled:
  - `payment_intent.succeeded` → marks payment as paid
  - `payment_intent.failed` → marks payment as failed
  - `payment_intent.canceled` → marks payment as canceled
  - `invoice.payment_succeeded` → subscription payment confirmed
  - `invoice.payment_failed` → triggers grace period logic
  - `checkout.session.completed` → day pass / membership purchase confirmed
  - `customer.subscription.created/updated/deleted` → membership lifecycle
  - `charge.refunded` → refund processing
  - `charge.dispute.created/closed` → dispute handling (suspends membership)
  - `product.updated/created/deleted` → pricing refresh
  - `price.updated/created` → pricing refresh
- **Route**: `server/routes/stripe/payments.ts` receives the raw webhook POST
- **Raw body required**: Webhook endpoint must receive `Buffer` payload (not JSON-parsed). Express JSON middleware must be excluded from the webhook route.

### 5. Idempotency Is Key
All billing webhooks must check `event.id` to ensure we never process the same payment twice.

- **Dedup table**: `webhook_processed_events` — stores `event_id`, `event_type`, `resource_id`, `processed_at`
- **Claim function**: `tryClaimEvent()` in `webhooks.ts`
  - Uses `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING event_id`
  - If `rowCount === 0`, the event is a duplicate → skip
- **Transaction wrapping**: The entire webhook handler runs inside `BEGIN`/`COMMIT`. If the handler fails, `ROLLBACK` ensures the claim is also rolled back, so Stripe can retry.
- **Stripe API idempotency**: When creating payment intents, pass `idempotencyKey` to `stripe.paymentIntents.create()` (see `server/core/stripe/payments.ts`)
- **Cleanup**: Old processed events are pruned by scheduled maintenance

**CRITICAL — PaymentIntent dedup for bookings**:
Before creating ANY Stripe PaymentIntent for a booking, ALWAYS query `stripe_payment_intents` for an existing open intent:
```sql
SELECT * FROM stripe_payment_intents
WHERE booking_id = $1 AND status NOT IN ('succeeded', 'canceled', 'refunded')
```
If one exists, return it instead of creating a new one. `prepaymentService.ts` implements this pattern — follow it everywhere. Include `metadata.bookingId` on ALL payment intents for traceability.

### 6. Guest Fees
Guest fees are calculated based on filled slots in a booking that do NOT have a valid member assigned.

- **Calculation**: `computeFeeBreakdown()` in `server/core/billing/unifiedFeeService.ts`
- A participant is a "guest" only if they have NO `userId` (i.e., not a linked member)
- Members incorrectly marked as guests are NOT charged guest fees (explicit check)
- Placeholder guests (`Guest 1`, `Guest 2`) vs. real named guests have different treatment
- Empty booking slots generate synthetic guest fee line items
- Guest fee amount comes from `PRICING.GUEST_FEE_CENTS` (Commandment 1)
- **Guest pass system**: `server/core/billing/guestPassConsumer.ts` deducts from member's monthly allocation
- **Guest pass holds**: `server/core/billing/guestPassHoldService.ts` temporarily holds passes during booking flow before finalizing

### 7. Overage Fees
Overage is calculated in **30-minute blocks**. Use `computeFeeBreakdown()` — do NOT write custom math.

- **Block size**: `PRICING.OVERAGE_BLOCK_MINUTES` = 30 (business logic constant)
- **Rate**: `PRICING.OVERAGE_RATE_CENTS` (dynamic from Stripe, Commandment 1)
- **Calculation chain**:
  1. `computeUsageAllocation()` in `usageCalculator.ts` — divides session duration among participants
  2. `calculateOverageFee()` in `usageCalculator.ts` — computes overage based on minutes vs. daily allowance
  3. `computeFeeBreakdown()` in `unifiedFeeService.ts` — orchestrates everything
- **Duration rule**: Uses `GREATEST(session_duration, booking_duration)` to handle Trackman extensions
- **Prior usage**: Checks `usage_ledger` for same-day usage before calculating overage

### 8. Grace Periods
If a membership payment fails, do NOT cut off access immediately. Set status to `past_due` and allow the 3-day grace period logic to handle it.

- **Webhook trigger**: `invoice.payment_failed` → sets `membership_status = 'past_due'` and records `grace_period_start`
- **Scheduler**: `server/schedulers/gracePeriodScheduler.ts`
  - Runs periodically, checks `grace_period_start IS NOT NULL`
  - Sends escalating emails (tracked by `grace_period_email_count`)
  - After 3 days: suspends membership, clears grace period fields
- **Email templates**: `server/emails/paymentEmails.ts` — payment failure notifications
- **Do NOT**: Manually set `membership_status = 'cancelled'` on payment failure. Let the grace period scheduler handle the lifecycle.

### 9. Transactions
Any action that touches `booking_sessions`, `payments`, `stripe_payment_intents`, or `booking_fee_snapshots` tables MUST be wrapped in a database transaction.

- Pattern: `const client = await pool.connect(); await client.query('BEGIN'); ... await client.query('COMMIT');`
- Always use `try/catch/finally` with `client.release()` in `finally`
- On error: `await client.query('ROLLBACK');`
- **Webhook transactions**: The entire webhook handler is wrapped in a single transaction. If any handler fails, all DB changes roll back.
- **Fee calculations**: `calculateAndCacheParticipantFees()` in `feeCalculator.ts` wraps its multi-table updates in a transaction
- **Payment status**: `PaymentStatusService` methods (`markPaymentSucceeded`, `markPaymentRefunded`) use transactions to update snapshots + intents + participants atomically

### 10. Logs
All payment failures or unexpected billing states must be logged to the error alert system immediately.

- **Error alert module**: `server/core/errorAlerts.ts`
  - Sends email alerts via Resend to the configured alert address
  - Built-in protections: 4-hour cooldown per alert type, 3 alerts/day cap, 5-minute startup grace period
  - Filters transient errors (ECONNRESET, rate limits, etc.) to avoid noise
- **Logger**: `server/core/logger.ts` — structured logging for all billing events
- **Audit log**: `server/core/auditLog.ts` — `logFromRequest()` for all staff billing actions
- Always log: payment intent creation, payment success/failure, refund processing, subscription changes, dispute events, reconciliation mismatches

---

## Additional Billing Patterns

### 11. Deferred Action Pattern
Stripe webhook side effects (notifications, HubSpot syncs, emails) execute AFTER the DB transaction commits, never inside it.

- **Type**: `DeferredAction = () => Promise<void>`
- Each webhook handler returns `DeferredAction[]`
- `executeDeferredActions()` runs after `COMMIT` succeeds
- **Why**: Prevents orphaned side effects if the transaction rolls back (e.g., sending a "payment confirmed" email for a rolled-back payment)
- If you add a new webhook handler, return deferred actions — never call external APIs inside the transaction

### 12. Fee Snapshots
`booking_fee_snapshots` captures point-in-time fee calculations tied to payment intents.

- Created when a prepayment intent is generated
- Stores: `session_id`, `booking_id`, `participant_fees` (JSON), `total_cents`, `stripe_payment_intent_id`, `status`
- `PaymentStatusService` in `server/core/billing/PaymentStatusService.ts` coordinates atomic updates across:
  - `booking_fee_snapshots` (status → paid/refunded)
  - `stripe_payment_intents` (status → succeeded/refunded)
  - `booking_participants` (cached_fee_cents updates)
- **Reconciliation**: `server/schedulers/feeSnapshotReconciliationScheduler.ts` cross-checks snapshots against Stripe payment intent status

### 13. Prepayment Lifecycle
After booking approval or Trackman auto-linking, a prepayment intent is created for expected fees.

- **Service**: `server/core/billing/prepaymentService.ts` — `createPrepaymentIntent()`
- **Flow**:
  1. Check for existing active prepayment intent (prevents duplicates)
  2. Create Stripe PaymentIntent with metadata (booking ID, session ID, fee breakdown)
  3. Record in `stripe_payment_intents` table with `purpose = 'prepayment'`
  4. Return `client_secret` to frontend for payment
- **Cancellation**: `cancelPaymentIntent()` in `server/core/stripe/payments.ts` — cancels in Stripe + updates local DB
- **Refund**: `markPaymentRefunded()` in `PaymentStatusService` — refunds succeeded prepayments with idempotency
- **Check-in block**: Members cannot check in until prepayment fees are paid

### 14. Stripe Client Singleton
Always use `getStripeClient()` from `server/core/stripe/client.ts`. NEVER instantiate Stripe directly.

- Ensures consistent API version and configuration
- **Environment validation**: `server/core/stripe/environmentValidation.ts` validates Stripe keys on startup

### 15. Stripe Customer Rules
- **Function**: `getOrCreateStripeCustomer()` in `server/core/stripe/customers.ts`
- Blocks placeholder emails (e.g., `placeholder+...@...`) from creating Stripe customers
- **Metadata sync**: `syncCustomerMetadataToStripe()` pushes `userId` + `tier` to Stripe customer metadata
- **Customer sync**: `server/core/stripe/customerSync.ts` — bulk sync of customer metadata
- Always use `getOrCreateStripeCustomer()`, never call `stripe.customers.create()` directly

### 16. Subscription Lifecycle
All subscription changes flow through webhooks, not direct DB updates.

- **Creation** (`customer.subscription.created`): Creates/links user, sets tier, syncs to HubSpot
- **Update** (`customer.subscription.updated`): Handles status changes (active → past_due → canceled), tier changes
- **Deletion** (`customer.subscription.deleted`): Deactivates group members, sets status to cancelled, syncs to HubSpot
- **Tier changes**: `changeSubscriptionTier()` in `server/core/stripe/subscriptions.ts` — handles proration (`always_invoice` for immediate, `none` for end-of-cycle)
- **Subscription sync**: `server/core/stripe/subscriptionSync.ts` — bulk subscription status sync
- **Group billing**: `server/core/stripe/groupBilling.ts` — corporate subscriptions with multiple seats. Primary cancellation cascades to all sub-members via `handlePrimarySubscriptionCancelled()`
- **Tier sync**: `server/core/stripe/tierChanges.ts` — tier change processing with HubSpot sync
- **HubSpot sync**: `server/core/stripe/hubspotSync.ts` — syncs subscription status/tier to HubSpot contact

### 17. Dispute Handling
Payment disputes trigger immediate membership suspension — different from grace period logic.

- `charge.dispute.created` → suspends membership immediately, notifies staff and member
- `charge.dispute.closed` → updates dispute status, may restore membership
- Disputes on terminal payments update `terminal_payments` table with `dispute_id` and `dispute_status`

### 18. Day Pass & Checkout
Day pass purchases use Stripe Checkout Sessions, not Payment Intents.

- **Route**: `server/routes/stripe/payments.ts` — `/api/public/day-pass/checkout`
- Uses `stripe.checkout.sessions.create()` with `mode: 'payment'`
- Metadata includes: product type, buyer info, purchase source
- **Visitor matching**: `server/core/visitors/matchingService.ts` matches day pass purchases to existing visitor records
- **Frontend**: `src/pages/Public/BuyDayPass.tsx`
- **Checkout page**: `src/pages/Checkout.tsx` — handles post-checkout confirmation

### 19. Terminal Payments
In-person card reader (WisePOS E / S700) support for membership signup and payments.

- **Route**: `server/routes/stripe/terminal.ts`
- Endpoints: connection tokens, reader listing, payment processing, subscription payment, confirmation
- Uses `stripe.terminal.readers.processPaymentIntent()` for card-present payments
- Simulated readers available for development testing (`testHelpers.terminal.readers.presentPaymentMethod`)
- Requires idempotency keys, metadata validation, and audit logging
- **Frontend**: `src/components/staff-command-center/TerminalPayment.tsx`

### 20. Reconciliation
Daily and subscription reconciliation schedulers cross-check Stripe vs. local DB to catch drift.

- **Daily payments**: `server/core/stripe/reconciliation.ts` — `reconcileDailyPayments()` checks recent Stripe payment intents against local records
- **Subscriptions**: `reconcileSubscriptions()` — verifies all active subscriptions match Stripe status
- **Scheduler**: `server/schedulers/stripeReconciliationScheduler.ts`
- **Fee snapshots**: `server/schedulers/feeSnapshotReconciliationScheduler.ts` — ensures snapshots match actual Stripe payment status
- **Duplicate cleanup**: `server/schedulers/duplicateCleanupScheduler.ts` — removes duplicate payment records

### 21. Stripe Transaction Cache
Local caching of Stripe transaction history for fast querying.

- **Table**: `stripe_transaction_cache`
- Populated by `server/core/stripe/invoices.ts` and webhook handlers
- Used by financials dashboard and member billing views
- **Payment repository**: `server/core/stripe/paymentRepository.ts` — query layer for cached transactions

### 22. Stripe Products & Pricing Sync
Two-way sync between app and Stripe Product Catalog.

- **Push sync**: `server/core/stripe/products.ts` — `syncMembershipTiersToStripe()`, `syncCafeItemsToStripe()`, `syncTierFeaturesToStripe()`
- **Pull sync**: Reverse sync reads Stripe products/features back into DB
- **Webhook refresh**: `product.updated/created/deleted` and `price.updated/created` trigger automatic reverse sync
- **Discounts**: `server/core/stripe/discounts.ts` — coupon and discount management
- **Coupons route**: `server/routes/stripe/coupons.ts` — CRUD endpoints for Stripe coupons

### 23. Card Expiry Monitoring
Proactive warnings for members with expiring payment methods.

- **Module**: `server/core/billing/cardExpiryChecker.ts`
- Checks card expiry dates and sends advance warning emails
- Prevents surprise payment failures on subscription renewal

---

## Complete File Map

### Core Billing Engine (`server/core/billing/`)
| File | Single Responsibility |
|------|----------------------|
| `pricingConfig.ts` | Dynamic pricing singleton — rates from Stripe (Commandment 1) |
| `unifiedFeeService.ts` | `computeFeeBreakdown()` — orchestrates all fee calculations (Commandments 6 & 7) |
| `feeCalculator.ts` | `calculateAndCacheParticipantFees()` — per-participant fee caching |
| `prepaymentService.ts` | `createPrepaymentIntent()` — prepayment lifecycle (Pattern 13) |
| `PaymentStatusService.ts` | Atomic payment status updates across snapshots/intents/participants (Pattern 12) |
| `cardExpiryChecker.ts` | Proactive card expiry warnings (Pattern 23) |
| `guestPassConsumer.ts` | Guest pass deduction from monthly allocation (Commandment 6) |
| `guestPassHoldService.ts` | Temporary guest pass holds during booking flow (Commandment 6) |

### Stripe Integration (`server/core/stripe/`)
| File | Single Responsibility |
|------|----------------------|
| `client.ts` | `getStripeClient()` singleton (Pattern 14) |
| `webhooks.ts` | `processStripeWebhook()`, `tryClaimEvent()`, all event handlers (Commandments 4 & 5) |
| `payments.ts` | `createPaymentIntent()`, `confirmPaymentSuccess()`, `cancelPaymentIntent()` |
| `customers.ts` | `getOrCreateStripeCustomer()`, `syncCustomerMetadataToStripe()` (Pattern 15) |
| `customerSync.ts` | Bulk customer metadata sync to Stripe |
| `subscriptions.ts` | `changeSubscriptionTier()`, subscription CRUD with proration (Pattern 16) |
| `subscriptionSync.ts` | Bulk subscription status verification |
| `products.ts` | Two-way Stripe Product Catalog sync (Pattern 22) |
| `invoices.ts` | Invoice retrieval, transaction cache population |
| `reconciliation.ts` | `reconcileDailyPayments()`, `reconcileSubscriptions()` (Pattern 20) |
| `groupBilling.ts` | Corporate billing, multi-seat subscriptions, primary cancellation cascade |
| `tierChanges.ts` | Tier change processing with HubSpot sync |
| `hubspotSync.ts` | Subscription status → HubSpot contact property sync |
| `discounts.ts` | Stripe coupon/discount application logic (Pattern 22) |
| `environmentValidation.ts` | Stripe API key validation on startup |
| `paymentRepository.ts` | Query layer for `stripe_transaction_cache` (Pattern 21) |
| `index.ts` | Stripe module barrel export and initialization |

### Booking ↔ Billing Bridge (`server/core/bookingService/`)
| File | Single Responsibility |
|------|----------------------|
| `sessionManager.ts` | `ensureSessionForBooking()`, `createSession()`, `createSessionWithUsageTracking()` (Commandments 2 & 3) |
| `usageCalculator.ts` | `computeUsageAllocation()`, `calculateOverageFee()`, `calculateFullSessionBilling()` (Commandment 7) |
| `trackmanReconciliation.ts` | Reconciles Trackman sessions with billing records |
| `index.ts` | BookingService barrel export |

### Billing-Related Routes (`server/routes/stripe/`)
| File | Single Responsibility |
|------|----------------------|
| `payments.ts` | Webhook receiver, day pass checkout, payment management endpoints |
| `member-payments.ts` | Member-facing payment history and actions |
| `subscriptions.ts` | Subscription management endpoints |
| `invoices.ts` | Invoice retrieval endpoints |
| `terminal.ts` | Stripe Terminal (card reader) endpoints (Pattern 19) |
| `admin.ts` | Admin Stripe management actions |
| `overage.ts` | Overage fee display/management endpoints |
| `config.ts` | Stripe publishable key / configuration endpoint |
| `coupons.ts` | Coupon CRUD endpoints (Pattern 22) |
| `helpers.ts` | Shared utilities for Stripe routes (`getStaffInfo()`, imports `PRICING`) |
| `index.ts` | Stripe routes barrel/registration |

### Other Billing-Adjacent Routes
| File | Single Responsibility |
|------|----------------------|
| `server/routes/financials.ts` | Staff financials dashboard data |
| `server/routes/myBilling.ts` | Member self-service billing portal |
| `server/routes/memberBilling.ts` | Staff-facing member billing management |
| `server/routes/groupBilling.ts` | Corporate/group billing management |
| `server/routes/checkout.ts` | Membership checkout flow |
| `server/routes/dayPasses.ts` | Day pass management |
| `server/routes/passes.ts` | Guest pass purchase/management |
| `server/routes/legacyPurchases.ts` | Legacy purchase records |
| `server/routes/pricing.ts` | Public pricing page data endpoint |
| `server/routes/cafe.ts` | Cafe menu items (Stripe-managed prices) |
| `server/routes/membershipTiers.ts` | Tier management (Stripe price IDs) |
| `server/routes/settings.ts` | Fee configuration settings |
| `server/routes/conference/prepayment.ts` | Conference room prepayment endpoints |
| `server/routes/guestPasses.ts` | Guest pass management (allocation, reset, staff actions) |
| `server/routes/trackman/webhook-billing.ts` | Trackman webhook billing logic (fee calculation on Trackman events) |

### Schedulers
| File | Single Responsibility |
|------|----------------------|
| `server/schedulers/gracePeriodScheduler.ts` | Grace period email escalation + suspension (Commandment 8) |
| `server/schedulers/stripeReconciliationScheduler.ts` | Daily Stripe ↔ DB reconciliation (Pattern 20) |
| `server/schedulers/feeSnapshotReconciliationScheduler.ts` | Fee snapshot ↔ Stripe payment status reconciliation (Pattern 20) |
| `server/schedulers/duplicateCleanupScheduler.ts` | Duplicate Stripe record cleanup (Pattern 20) |

### Emails
| File | Single Responsibility |
|------|----------------------|
| `server/emails/paymentEmails.ts` | Payment success/failure/reminder email templates (Commandment 8) |
| `server/emails/membershipEmails.ts` | Membership-related email templates (welcome, tier change, cancellation) |
| `server/emails/passEmails.ts` | Guest pass and day pass email templates (QR codes, confirmations) |

### Error & Monitoring
| File | Single Responsibility |
|------|----------------------|
| `server/core/errorAlerts.ts` | Email alerts via Resend with cooldown/rate limiting (Commandment 10) |
| `server/core/logger.ts` | Structured logging for billing events (Commandment 10) |
| `server/core/auditLog.ts` | Staff action audit trail (Commandment 10) |
| `server/core/monitoring.ts` | System health monitoring |
| `server/core/healthCheck.ts` | Health check endpoint (includes Stripe connectivity) |

### Support Files
| File | Single Responsibility |
|------|----------------------|
| `server/types/stripe-helpers.ts` | TypeScript type definitions for Stripe objects |
| `server/scripts/cleanup-stripe-duplicates.ts` | Manual script to fix duplicate Stripe records |
| `server/scripts/classifyMemberBilling.ts` | Script to classify member billing providers |

### Related Core Modules
| File | Billing Relevance |
|------|-------------------|
| `server/core/memberSync.ts` | Syncs membership status (affected by billing state) |
| `server/core/memberTierUpdateProcessor.ts` | Processes tier changes triggered by subscription updates |
| `server/core/memberService/tierSync.ts` | Tier ↔ Stripe price ID mapping |
| `server/core/memberService/MemberService.ts` | Member queries (includes billing status fields) |
| `server/core/userMerge.ts` | Merges user accounts (must preserve billing records) |
| `server/core/hubspot/lineItems.ts` | Syncs Stripe pricing as HubSpot deal line items |
| `server/core/hubspot/stages.ts` | `syncMemberToHubSpot()` — syncs billing status to HubSpot |
| `server/core/mindbody/import.ts` | Legacy Mindbody billing import |
| `server/core/visitors/matchingService.ts` | Matches day pass purchases to visitor records |
| `server/core/visitors/autoMatchService.ts` | Auto-matches visitors by payment email |
| `server/core/jobQueue.ts` | Background job queue (billing jobs) |
| `server/core/retryUtils.ts` | Exponential backoff for Stripe API retries |
| `server/core/websocket.ts` | Real-time payment status broadcasts |
| `server/core/notificationService.ts` | Payment-related in-app notifications |
| `server/core/dataIntegrity.ts` | Data integrity checks (includes billing consistency) |

### Frontend — Billing Components (`src/components/`)
| File | Single Responsibility |
|------|----------------------|
| `billing/InvoicePaymentModal.tsx` | Invoice payment UI |
| `billing/BalancePaymentModal.tsx` | Outstanding balance payment UI |
| `billing/BalanceCard.tsx` | Member balance display card |
| `billing/GuestPassPurchaseModal.tsx` | Guest pass purchase UI |
| `booking/MemberPaymentModal.tsx` | Booking prepayment UI |
| `booking/GuestPaymentChoiceModal.tsx` | Guest fee payment options |
| `booking/RosterManager.tsx` | Roster management (fee display per participant) |
| `booking/index.ts` | Booking components barrel export |
| `stripe/StripePaymentForm.tsx` | Stripe Elements payment form wrapper |
| `stripe/stripeAppearance.ts` | Stripe Elements visual theming |
| `admin/billing/TierChangeWizard.tsx` | Tier upgrade/downgrade wizard |
| `admin/billing/StripeBillingSection.tsx` | Staff Stripe billing management |
| `admin/billing/MindbodyBillingSection.tsx` | Legacy Mindbody billing display |
| `admin/billing/CompedBillingSection.tsx` | Comped membership billing display |
| `admin/billing/FamilyAddonBillingSection.tsx` | Family add-on billing management |
| `admin/payments/POSRegister.tsx` | Point-of-sale register UI |
| `admin/payments/QuickChargeCard.tsx` | Quick charge card for staff |
| `admin/payments/TransactionList.tsx` | Transaction list component |
| `admin/payments/TransactionsSubTab.tsx` | Transactions sub-tab container |
| `admin/payments/SendMembershipInvite.tsx` | Membership payment invite sender |
| `admin/payments/OverduePaymentsPanel.tsx` | Overdue payments tracking panel |
| `admin/payments/RedeemPassCard.tsx` | Guest/day pass QR code redemption UI |
| `admin/BookingMembersEditor.tsx` | Booking member editor (fee recalculation on roster changes) |
| `admin/MemberBillingTab.tsx` | Member billing tab in profile drawer |
| `admin/GroupBillingManager.tsx` | Corporate group billing manager |
| `profile/BillingSection.tsx` | Member self-service billing section |
| `staff-command-center/TerminalPayment.tsx` | Terminal card reader payment UI |
| `staff-command-center/sections/OverduePaymentsSection.tsx` | Command center overdue payments widget |
| `staff-command-center/modals/CheckinBillingModal.tsx` | Check-in billing confirmation modal |
| `staff-command-center/modals/StaffManualBookingModal.tsx` | Fee display in manual booking flow |
| `staff-command-center/modals/StaffDirectAddModal.tsx` | Fee references when adding to roster |
| `staff-command-center/modals/CompleteRosterModal.tsx` | Payment status in roster completion |
| `staff-command-center/modals/AddMemberModal.tsx` | Payment setup in new member creation |
| `staff-command-center/modals/TrackmanLinkModal.tsx` | Trackman link modal (triggers billing session creation) |
| `staff-command-center/sections/BookingQueuesSection.tsx` | Booking queues (payment status indicators) |
| `staff-command-center/sections/AlertsCard.tsx` | Alerts card (payment failure alerts) |
| `staff-command-center/helpers.tsx` | Command center helper utilities (payment status helpers) |
| `staff-command-center/StaffCommandCenter.tsx` | Staff command center container (payment widgets) |
| `staff-command-center/index.ts` | Command center barrel export |
| `staff-command-center/drawers/NewUserDrawer.tsx` | Payment/billing setup for new users |
| `MemberProfileDrawer.tsx` | Member profile drawer (billing tab, subscription status) |
| `MemberMenuOverlay.tsx` | Member menu overlay (billing navigation) |
| `shared/MemberSearchInput.tsx` | Member search input (used in payment/billing contexts) |

### Frontend — Pages
| File | Billing Relevance |
|------|-------------------|
| `src/pages/Checkout.tsx` | Membership checkout / post-payment confirmation |
| `src/pages/Public/BuyDayPass.tsx` | Day pass purchase page |
| `src/pages/Public/Membership.tsx` | Pricing display (uses dynamic pricing) |
| `src/pages/Public/DayPassSuccess.tsx` | Post-purchase day pass confirmation page |
| `src/pages/Member/Dashboard.tsx` | Balance display, prepayment status |
| `src/pages/Member/History.tsx` | Payment/billing history |
| `src/pages/Admin/tabs/FinancialsTab.tsx` | Staff financials dashboard |
| `src/pages/Admin/tabs/TiersTab.tsx` | Tier management (Stripe price IDs) |
| `src/pages/Admin/tabs/DiscountsSubTab.tsx` | Discount/coupon management |
| `src/pages/Admin/tabs/CafeTab.tsx` | Cafe menu (Stripe-managed prices) |
| `src/pages/Admin/tabs/ProductsSubTab.tsx` | Products & pricing management |
| `src/pages/Admin/tabs/DataIntegrityTab.tsx` | Billing data integrity checks |
| `src/pages/Admin/tabs/SettingsTab.tsx` | Fee configuration settings |
| `src/pages/Admin/tabs/SimulatorTab.tsx` | Simulator management (fee/payment references) |
| `src/pages/Admin/tabs/DirectoryTab.tsx` | Member directory (subscription status display) |
| `src/pages/Admin/tabs/UpdatesTab.tsx` | Updates tab (payment-related announcements) |
| `src/pages/Admin/tabs/ChangelogTab.tsx` | Changelog (payment/billing change entries) |
| `src/pages/Admin/layout/hooks/useCommandCenter.ts` | Command center hook (payment queue data) |
| `src/pages/Public/Cafe.tsx` | Public cafe page (Stripe-managed prices) |
| `src/pages/Public/Landing.tsx` | Landing page (pricing references) |
| `src/pages/Public/PrivacyPolicy.tsx` | Privacy policy (payment data handling disclosures) |
| `src/pages/Public/TermsOfService.tsx` | Terms of service (billing terms, subscription terms) |
| `src/pages/Member/BookGolf.tsx` | Booking page (fee estimates, prepayment triggers) |
| `src/pages/Member/Profile.tsx` | Member profile (billing/subscription status) |
| `src/pages/Member/Updates.tsx` | Member updates (payment-related notifications) |
| `src/pages/Member/Wellness.tsx` | Wellness page (service pricing) |

### Frontend — Hooks & Types
| File | Billing Relevance |
|------|-------------------|
| `src/hooks/usePricing.ts` | Fetches dynamic pricing from API (Commandment 1) |
| `src/hooks/queries/useFinancialsQueries.ts` | TanStack Query hooks for financials data |
| `src/hooks/queries/useBookingsQueries.ts` | Booking queries (includes fee data) |
| `src/hooks/queries/useCafeQueries.ts` | Cafe queries (Stripe-managed prices) |
| `src/types/stripe.d.ts` | Frontend Stripe type definitions |
| `src/types/data.ts` | Data types (includes billing interfaces) |
| `src/hooks/useStaffWebSocket.ts` | Staff WebSocket hook (real-time payment status updates) |
| `src/hooks/useWebSocketQuerySync.ts` | WebSocket query sync (invalidates payment queries on updates) |
| `src/contexts/DataContext.tsx` | Data context provider (passes billing/payment data to components) |
| `src/services/pushNotifications.ts` | Push notifications (payment-related subscription alerts) |
| `src/utils/statusColors.ts` | Status color mapping (payment/subscription status colors) |
| `src/data/integrityCheckMetadata.ts` | Integrity check metadata (billing checks) |
| `src/data/changelog.ts` | Changelog entries (billing/payment feature documentation) |
| `src/data/defaults.ts` | Default values (pricing defaults) |

### Peripheral Server Files (contain billing keywords but are not billing-primary)
These files reference billing concepts incidentally. They are documented here for zero-orphan coverage.

| File | Why It Contains Billing Keywords |
|------|----------------------------------|
| `server/db-init.ts` | Creates billing-related tables, indexes, triggers |
| `server/seed.ts` | Seeds initial pricing/tier data |
| `server/loaders/routes.ts` | Registers all route modules including billing routes |
| `server/middleware/rateLimiting.ts` | Rate limits payment endpoints specifically |
| `server/core/trackmanImport.ts` | Creates billing sessions after Trackman CSV import |
| `server/core/memberService/memberTypes.ts` | Member type definitions (includes subscription fields) |
| `server/core/hubspot/queue.ts` | HubSpot sync queue (syncs billing status changes) |
| `server/core/hubspot/queueHelpers.ts` | HubSpot queue helpers (billing status sync) |
| `server/core/hubspot/members.ts` | HubSpot member sync (subscription/tier properties) |
| `server/core/hubspot/constants.ts` | HubSpot property constants (billing-related fields) |
| `server/core/hubspotDeals.ts` | HubSpot deals (subscription deal management) |
| `server/routes/auth.ts` | Auth routes (Stripe auto-fix on login) |
| `server/routes/auth-google.ts` | Google auth (Stripe auto-fix on login) |
| `server/routes/staffCheckin.ts` | Staff check-in (fee verification before check-in) |
| `server/routes/roster.ts` | Roster management (fee recalculation on changes) |
| `server/routes/resources.ts` | Resource management (payment status references) |
| `server/routes/training.ts` | Training guide (billing workflow documentation) |
| `server/routes/waivers.ts` | Waiver routes (subscription status checks) |
| `server/routes/closures.ts` | Closure management (subscription references) |
| `server/routes/push.ts` | Push notification routes (payment alert subscriptions) |
| `server/routes/dataTools.ts` | Data tools (billing data repair utilities) |
| `server/routes/hubspot.ts` | HubSpot routes (billing status sync endpoints) |
| `server/routes/hubspotDeals.ts` | HubSpot deal routes (subscription deal management) |
| `server/routes/staff/manualBooking.ts` | Manual booking (payment/fee references) |
| `server/routes/bays/approval.ts` | Booking approval (triggers prepayment creation) |
| `server/routes/bays/bookings.ts` | Booking CRUD (fee display, billing session creation) |
| `server/routes/bays/reschedule.ts` | Reschedule (fee recalculation) |
| `server/routes/bays/calendar.ts` | Calendar (payment status in booking display) |
| `server/routes/bays/staff-conference-booking.ts` | Conference booking (prepayment handling) |
| `server/routes/members/admin-actions.ts` | Member admin actions (billing status changes) |
| `server/routes/members/visitors.ts` | Visitor routes (day pass payment references) |
| `server/routes/members/search.ts` | Member search (subscription status filters) |
| `server/routes/members/profile.ts` | Member profile (billing info display) |
| `server/routes/trackman/webhook-index.ts` | Trackman webhook router (billing webhook registration) |
| `server/routes/trackman/webhook-handlers.ts` | Trackman webhook handlers (billing session creation) |
| `server/schedulers/integrityScheduler.ts` | Integrity scheduler (billing data consistency checks) |
| `server/schedulers/waiverReviewScheduler.ts` | Waiver review (subscription status checks) |

---

## Fee Order of Operations (Cross-Reference)

See `booking-import-standards/SKILL.md` Rule 15a for the MANDATORY fee calculation order:
Status → Staff → Active Membership → Tier → Unlimited → Social → Usage → Overage Blocks

**Key reminders:**
- Cancelled bookings = $0 (no further checks)
- Staff = $0 (no further checks)
- Inactive member = treated as guest, fee charged to HOST (not to the inactive participant)

---

## Anti-Patterns — NEVER Do These

1. **Never hardcode `$25`, `2500`, or any dollar amount** — always use `PRICING.*` from `pricingConfig.ts`
2. **Never create a booking without calling `ensureSessionForBooking()`** — sessions = money
3. **Never call `stripe.customers.create()` directly** — use `getOrCreateStripeCustomer()`
4. **Never instantiate `new Stripe(...)` directly** — use `getStripeClient()`
5. **Never poll Stripe for payment status** — rely on webhooks
6. **Never call external APIs inside a webhook transaction** — use the Deferred Action pattern
7. **Never set `membership_status = 'cancelled'` on payment failure** — set `past_due` and let grace period scheduler handle it
8. **Never write fee calculation math** — use `computeFeeBreakdown()` from `unifiedFeeService.ts`
9. **Never update `booking_sessions` or `stripe_payment_intents` outside a transaction**
10. **Never skip idempotency checks in webhook handlers** — always call `tryClaimEvent()`
11. **Never parse webhook body as JSON before signature verification** — it must be a raw `Buffer`
12. **Never create a PaymentIntent without checking for an existing open intent** — query `stripe_payment_intents` first (Commandment 5)

# Complete File Map

## Table of Contents
- [Core Billing Engine](#core-billing-engine-servercorébilling)
- [Stripe Integration](#stripe-integration-servercorestripe)
- [Booking ↔ Billing Bridge](#booking--billing-bridge-servercorebookingservice)
- [Billing-Related Routes](#billing-related-routes-serverroutesstripe)
- [Other Billing-Adjacent Routes](#other-billing-adjacent-routes)
- [Schedulers](#schedulers)
- [Emails](#emails)
- [Error & Monitoring](#error--monitoring)
- [Support Files](#support-files)
- [Related Core Modules](#related-core-modules)
- [Frontend — Billing Components](#frontend--billing-components-srccomponents)
- [Frontend — Pages](#frontend--pages)
- [Frontend — Hooks & Types](#frontend--hooks--types)
- [Peripheral Server Files](#peripheral-server-files)

---

## Core Billing Engine (`server/core/billing/`)
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

## Stripe Integration (`server/core/stripe/`)
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
| `transactionCache.ts` | Stripe transaction cache management (Pattern 21) |
| `index.ts` | Stripe module barrel export and initialization |

## Booking ↔ Billing Bridge (`server/core/bookingService/`)
| File | Single Responsibility |
|------|----------------------|
| `sessionManager.ts` | `ensureSessionForBooking()`, `createSession()`, `createSessionWithUsageTracking()` (Commandments 2 & 3) |
| `usageCalculator.ts` | `computeUsageAllocation()`, `calculateOverageFee()`, `calculateFullSessionBilling()` (Commandment 7) |
| `trackmanReconciliation.ts` | Reconciles Trackman sessions with billing records |
| `index.ts` | BookingService barrel export |

## Billing-Related Routes (`server/routes/stripe/`)
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

## Other Billing-Adjacent Routes
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
| `server/routes/conference/prepayment.ts` | Conference room prepayment endpoints (deprecated since v8.16.0 — conference rooms now use invoice flow) |
| `server/routes/guestPasses.ts` | Guest pass management (allocation, reset, staff actions) |
| `server/routes/trackman/webhook-billing.ts` | Trackman webhook billing logic (fee calculation on Trackman events) |

## Schedulers
| File | Single Responsibility |
|------|----------------------|
| `server/schedulers/gracePeriodScheduler.ts` | Grace period email escalation + suspension (Commandment 8) |
| `server/schedulers/stripeReconciliationScheduler.ts` | Daily Stripe ↔ DB reconciliation (Pattern 20) |
| `server/schedulers/feeSnapshotReconciliationScheduler.ts` | Fee snapshot ↔ Stripe payment status reconciliation (Pattern 20) |
| `server/schedulers/duplicateCleanupScheduler.ts` | Duplicate Stripe record cleanup (Pattern 20) |

## Emails
| File | Single Responsibility |
|------|----------------------|
| `server/emails/paymentEmails.ts` | Payment success/failure/reminder email templates (Commandment 8) |
| `server/emails/membershipEmails.ts` | Membership-related email templates (welcome, tier change, cancellation) |
| `server/emails/passEmails.ts` | Guest pass and day pass email templates (QR codes, confirmations) |

## Error & Monitoring
| File | Single Responsibility |
|------|----------------------|
| `server/core/errorAlerts.ts` | Email alerts via Resend with cooldown/rate limiting (Commandment 10) |
| `server/core/logger.ts` | Structured logging for billing events (Commandment 10) |
| `server/core/auditLog.ts` | Staff action audit trail (Commandment 10) |
| `server/core/monitoring.ts` | System health monitoring |
| `server/core/healthCheck.ts` | Health check endpoint (includes Stripe connectivity) |

## Support Files
| File | Single Responsibility |
|------|----------------------|
| `server/types/stripe-helpers.ts` | TypeScript type definitions for Stripe objects |
| `server/scripts/cleanup-stripe-duplicates.ts` | Manual script to fix duplicate Stripe records |
| `server/scripts/classifyMemberBilling.ts` | Script to classify member billing providers |

## Related Core Modules
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

## Frontend — Billing Components (`src/components/`)
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

## Frontend — Pages
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

## Frontend — Hooks & Types
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

## Peripheral Server Files
These files reference billing concepts incidentally. Documented here for zero-orphan coverage.

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
| `server/routes/bays/staff-conference-booking.ts` | Conference booking (uses invoice flow since v8.16.0) |
| `server/routes/members/admin-actions.ts` | Member admin actions (billing status changes) |
| `server/routes/members/visitors.ts` | Visitor routes (day pass payment references) |
| `server/routes/members/search.ts` | Member search (subscription status filters) |
| `server/routes/members/profile.ts` | Member profile (billing info display) |
| `server/routes/trackman/webhook-index.ts` | Trackman webhook router (billing webhook registration) |
| `server/routes/trackman/webhook-handlers.ts` | Trackman webhook handlers (billing session creation) |
| `server/schedulers/integrityScheduler.ts` | Integrity scheduler (billing data consistency checks) |
| `server/schedulers/waiverReviewScheduler.ts` | Waiver review (subscription status checks) |

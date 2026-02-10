---
name: project-architecture
description: Master map of the Ever Club Members App codebase. Check this FIRST before planning any changes to ensure you modify the correct files and maintain architectural standards. Use whenever creating, modifying, moving, or deleting files anywhere in the project.
---

# Project Architecture & Key Files

This is the single source of truth for where everything lives. Check here FIRST before modifying any code.

---

## Section 1: Root Configuration Files

| File | Purpose | When to touch |
|------|---------|---------------|
| `vite.config.ts` | Frontend bundler config, dev server port (5000), proxy rules | Adding aliases, changing ports, plugin config |
| `tailwind.config.js` | Tailwind theme, colors, fonts, custom utilities | Changing design tokens, adding custom classes |
| `postcss.config.js` | PostCSS plugins (Tailwind, autoprefixer) | Rarely — only if adding PostCSS plugins |
| `tsconfig.json` | TypeScript compiler options, path aliases | Adding path aliases, changing strictness |
| `drizzle.config.ts` | Drizzle ORM config, database connection, migration output | Changing schema location or migration paths |
| `vitest.config.ts` | Unit test runner config | Adding test setup files or aliases |
| `playwright.config.ts` | E2E test runner config | Changing test browser targets or timeouts |
| `package.json` | Dependencies, npm scripts (`dev`, `server`, `db:push`, etc.) | Adding packages, changing scripts |
| `package-lock.json` | Dependency lock file | Auto-updated by npm — never edit manually |
| `index.html` | Vite HTML entry point — loads `src/main.tsx` | Changing `<head>` tags, meta, or fonts |
| `.replit` | Replit environment: modules, nix packages, workflows, integrations | Adding system packages or integrations |
| `.gitignore` | Git ignore rules | Adding new build output or cache directories |
| `metadata.json` | Project metadata for Replit | Rarely |
| `hubspot-template.html` | HubSpot email/form HTML template | Changing email template layout |

---

## Section 2: Frontend (`src/`)

### Entry Points
| File | Purpose |
|------|---------|
| `src/main.tsx` | React app bootstrap, provider tree, router mount |
| `src/App.tsx` | Top-level routing, layout wrappers, auth guards |
| `src/index.css` | Global styles, Tailwind directives, CSS keyframe animations |

### Pages (`src/pages/`)

Three page groups organized by user role:

**Public Pages** (`src/pages/Public/`) — No auth required:
- `Landing.tsx`, `Login.tsx`, `AuthCallback.tsx`
- `Membership.tsx`, `MembershipApply.tsx`, `Checkout.tsx` (root-level)
- `BuyDayPass.tsx`, `DayPassSuccess.tsx`
- `Cafe.tsx`, `Gallery.tsx`, `FAQ.tsx`, `Contact.tsx`
- `WhatsOn.tsx`, `PrivateHire.tsx`, `PrivateHireInquire.tsx`
- `PrivacyPolicy.tsx`, `TermsOfService.tsx`

**Member Pages** (`src/pages/Member/`) — Authenticated members:
- `Dashboard.tsx` — Member home, balance, upcoming bookings
- `BookGolf.tsx` — Simulator booking flow
- `Events.tsx` — Club events and RSVPs
- `History.tsx` — Booking and payment history
- `Profile.tsx` — Member profile, settings, Google linking
- `Updates.tsx` — Club announcements
- `Wellness.tsx` — Wellness service booking

**Admin Pages** (`src/pages/Admin/`) — Staff/admin only:
- `AdminDashboard.tsx` — Staff command center
- `BugReportsAdmin.tsx`, `DataIntegrity.tsx`, `FaqsAdmin.tsx`
- `GalleryAdmin.tsx`, `InquiriesAdmin.tsx`
- Subdirectories: `components/`, `layout/` (with `hooks/` sub-dir), `tabs/`

### Components (`src/components/`)

Organized into 11 subdirectories:

| Directory | Contains |
|-----------|----------|
| `admin/` | Admin-specific UI (member drawers, data tools, settings panels). Sub-dirs: `billing/`, `payments/`. **DEPRECATED**: `BookingMembersEditor.tsx` — inline roster editor, replaced by Unified Player Modal |
| `billing/` | Payment forms, fee displays, invoice views |
| `booking/` | Booking cards, calendar views, slot pickers |
| `icons/` | Custom SVG icon components |
| `layout/` | Header, sidebar, page wrappers |
| `motion/` | Animation wrappers, parallax, staggered entry |
| `profile/` | Member profile sections, tier badges, settings |
| `shared/` | Reusable generic components (buttons, modals, inputs) |
| `skeletons/` | Loading skeleton placeholders |
| `staff-command-center/` | Staff dashboard widgets, quick actions. Sub-dirs: `drawers/`, `hooks/`, `modals/`, `sections/`. **Key modal**: `PlayerManagementModal.tsx` (formerly `TrackmanLinkModal.tsx`) — the SINGLE AUTHORITY for all roster edits. **DEPRECATED**: `CompleteRosterModal.tsx` — replaced by Unified Player Modal |
| `stripe/` | Stripe Elements wrappers, payment forms |
| `ui/` | Design system primitives (Liquid Glass styled) |

Plus root-level standalone components:
- `SlideUpDrawer.tsx` — Drawer UX with drag-to-dismiss
- `ConfirmDialog.tsx` — Liquid Glass styled confirmation dialogs
- `FloatingActionButton.tsx` — Staff FAB for quick actions
- `MemberBottomNav.tsx` — Mobile bottom navigation
- `StaffMobileSidebar.tsx` — Staff mobile nav sidebar
- `StaffCommandCenter.tsx` — Main staff dashboard component
- `MemberProfileDrawer.tsx` — Member detail drawer
- `Toast.tsx` — Toast notification system
- `WaiverModal.tsx` — Waiver signing modal
- `UpdateNotification.tsx` — PWA update prompt
- `ErrorBoundary.tsx`, `PageErrorBoundary.tsx`, `FeatureErrorBoundary.tsx`
- `WalkingGolferLoader.tsx`, `WalkingGolferSpinner.tsx` — Branded loading states
- And others (Avatar, Logo, SEO, Toggle, Input, etc.)

### Unified Player Modal Architecture

**CRITICAL ARCHITECTURAL STANDARD — Established February 2026**

The **Unified Player Modal** (`PlayerManagementModal.tsx`, formerly `TrackmanLinkModal.tsx`) in `src/components/staff-command-center/modals/` is the **SINGLE AUTHORITY** for all player, roster, owner, and guest management on bookings.

**The Rule:** If the user asks to edit players, guests, or owners, ALWAYS route them to the Unified Player Modal. Do not create inline editors, separate roster popups, or new modals for player management.

**Two Modes:**
- **Mode A (Assign Players):** For unlinked/new bookings — search and assign owner + players, then "Assign & Confirm"
- **Mode B (Manage Players):** For existing bookings — pre-fills roster from `/api/admin/booking/:id/members`, allows editing, then "Save Changes"

**Features absorbed into this single modal:**
- Owner assignment (slot 1, required)
- Player slot management (slots 2-4, optional)
- Guest placeholder creation and named guest forms
- Member search and reassignment
- Guest pass tracking and auto-application
- Financial summary with real-time fee recalculation
- Inline payment collection via Stripe
- Fee waiver flow with required reason
- Quick Add from Notes (parse player names from booking notes)
- Player count editing (1-4 slots)
- Check-in flow integration

**DEPRECATED components (do NOT use or extend):**
- `src/components/admin/BookingMembersEditor.tsx` — Was an inline roster editor embedded in booking details modals. Replaced by Unified Player Modal Mode B.
- `src/components/staff-command-center/modals/CompleteRosterModal.tsx` — Was a check-in roster completion popup that wrapped BookingMembersEditor. Replaced by Unified Player Modal with check-in context.

**All triggers route to the Unified Player Modal:**
- Owner edit pencil icon → opens Mode B
- "Manage Players" button → opens Mode B
- Player count edit click → opens Mode B
- Check-in with incomplete roster → opens Mode B with check-in context
- Unlinked Trackman booking assignment → opens Mode A

### State Management

**Zustand Stores** (`src/stores/`):
- `notificationStore.ts` — In-app notification state, unread counts
- `userStore.ts` — Current user session, role, preferences

**Contexts** (`src/contexts/`):
- `DataContext.tsx` — Central data provider (TanStack Query)
- `NotificationContext.tsx` — Notification delivery and display
- `ThemeContext.tsx` — Light/Dark/System theme
- `StaffWebSocketContext.tsx` — Real-time staff updates
- `AnnouncementBadgeContext.tsx` — Unread announcement badges
- `BottomNavContext.tsx` — Mobile bottom nav visibility
- `NavigationLoadingContext.tsx` — Page transition loading states
- `PageReadyContext.tsx` — Page-ready signals for animations

### Hooks (`src/hooks/`)
- `useStaffWebSocket.ts`, `useWebSocket.ts`, `useWebSocketQuerySync.ts` — Real-time sync
- `useSupabaseRealtime.ts` — Supabase realtime subscriptions
- `useOptimisticBookings.ts`, `useOptimisticEvents.ts` — Optimistic UI updates
- `useBookingFilters.ts` — Booking list filtering
- `usePricing.ts` — Stripe pricing data
- `useTierPermissions.ts` — Tier-based feature gating
- `useServiceWorkerUpdate.ts` — PWA update detection
- `useBreakpoint.ts` — Responsive breakpoint detection
- `useScrollLock.ts`, `useScrollLockManager.ts` — Modal scroll locking
- `useKeyboardDetection.ts` — Mobile keyboard handling
- `useAnimatedRemove.ts`, `useParallax.ts`, `useConfetti.ts` — Animations
- Sub-dir: `queries/` — TanStack Query hook definitions
- `useEdgeSwipe.ts`, `useDragAutoScroll.ts` — Touch gestures
- `useNotificationSounds.ts` — Audio alerts
- `useAsyncAction.ts` — Async action with loading/error states

### Services (`src/services/`)
- `pushNotifications.ts` — Push notification registration and handling
- `tierService.ts` — Client-side tier lookup and caching

### Lib (`src/lib/`)
- `apiRequest.ts` — Centralized fetch wrapper with auth headers
- `queryClient.ts` — TanStack Query client configuration
- `supabase.ts` — Supabase client initialization
- `bookingEvents.ts` — Booking event bus helpers
- `backgroundSync.ts` — Background data sync for offline
- `prefetch.ts` — Route prefetching

### Config (`src/config/`)
- `branding.ts` — Brand colors, names, logos
- `version.ts` — Current app version

### Data (`src/data/`)
- `changelog.ts` — Version changelog entries (UPDATE AFTER EVERY FEATURE/FIX)
- `defaults.ts` — Default values and constants
- `integrityCheckMetadata.ts` — Data integrity check definitions

### Types (`src/types/`)
- `data.ts` — Frontend data type definitions
- `stripe.d.ts` — Stripe type declarations

### Utils (`src/utils/`)
- `dateUtils.ts` — Date formatting (Pacific timezone priority)
- `formatting.ts` — Number, currency, text formatting
- `permissions.ts` — Role/permission checks
- `tierUtils.ts` — Tier comparison and display helpers
- `statusColors.ts` — Booking/payment status color mapping
- `errorHandling.ts` — Error parsing and display
- `haptics.ts` — Mobile haptic feedback
- `sounds.ts` — Audio file references
- `icalUtils.ts` — Calendar file generation

---

## Section 3: Backend Core Business Logic (`server/core/`)

This is where ALL business logic lives. Routes call these — never write logic inline in routes.

### Billing & Finance (`server/core/billing/`)
| File | Purpose |
|------|---------|
| `unifiedFeeService.ts` | `computeFeeBreakdown()` — ALL fee calculations go through here |
| `pricingConfig.ts` | Stripe-sourced pricing (guest fee, overage rate, day pass prices) |
| `prepaymentService.ts` | Prepayment intent creation, payment, refund |
| `feeCalculator.ts` | Low-level fee math helpers |
| `guestPassConsumer.ts` | Guest pass deduction logic |
| `guestPassHoldService.ts` | Guest pass hold/release during booking |
| `cardExpiryChecker.ts` | Card expiry monitoring and alerts |
| `PaymentStatusService.ts` | Payment status tracking and transitions |

### Booking Service (`server/core/bookingService/`)
| File | Purpose |
|------|---------|
| `sessionManager.ts` | `ensureSessionForBooking()`, `createSession()`, `linkParticipants()` — THE session creation function |
| `conflictDetection.ts` | Double-booking prevention |
| `availabilityGuard.ts` | Slot availability checks |
| `tierRules.ts` | Tier-based booking limits and access rules |
| `usageCalculator.ts` | Daily usage, guest pass remaining, overage calculation |
| `trackmanReconciliation.ts` | Trackman data reconciliation |
| `index.ts` | Re-exports |

### Stripe Integration (`server/core/stripe/`)
| File | Purpose |
|------|---------|
| `client.ts` | Stripe client initialization |
| `webhooks.ts` | Stripe webhook event handlers |
| `payments.ts` | Payment intent creation and processing |
| `subscriptions.ts` | Subscription CRUD |
| `subscriptionSync.ts` | Subscription status sync |
| `customers.ts` | Customer creation and lookup |
| `customerSync.ts` | Customer metadata sync (user ID, tier) |
| `products.ts` | Product/price catalog management |
| `invoices.ts` | Invoice generation and retrieval |
| `reconciliation.ts` | Stripe vs local data reconciliation |
| `tierChanges.ts` | Tier change proration handling |
| `groupBilling.ts` | Corporate/family group billing |
| `discounts.ts` | Coupon and discount management |
| `hubspotSync.ts` | Stripe subscription → HubSpot sync |
| `environmentValidation.ts` | Stripe test/live mode validation |
| `paymentRepository.ts` | Payment data access layer |
| `index.ts` | Re-exports |

### HubSpot CRM (`server/core/hubspot/`)
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
| `index.ts` | Re-exports |

### Calendar (`server/core/calendar/`)
| File | Purpose |
|------|---------|
| `google-client.ts` | Google Calendar API client |
| `availability.ts` | Calendar availability calculation |
| `cache.ts` | Calendar data caching |
| `config.ts` | Calendar IDs and settings |
| `sync/golf.ts` | Golf simulator calendar sync |
| `sync/conference-room.ts` | Conference room calendar sync |
| `sync/wellness.ts` | Wellness calendar sync |
| `sync/events.ts` | Event calendar sync |
| `sync/closures.ts` | Closure calendar sync |
| `sync/index.ts` | Sync orchestration |
| `index.ts` | Re-exports |

### Member Service (`server/core/memberService/`)
| File | Purpose |
|------|---------|
| `MemberService.ts` | Core member CRUD, lookup, search |
| `memberCache.ts` | Member data caching |
| `memberTypes.ts` | Member type definitions |
| `emailChangeService.ts` | Email change handling |
| `tierSync.ts` | Tier sync to external systems |
| `index.ts` | Re-exports |

### Visitor Management (`server/core/visitors/`)
| File | Purpose |
|------|---------|
| `autoMatchService.ts` | Auto-match visitors to members |
| `matchingService.ts` | Visitor matching algorithms |
| `typeService.ts` | Visitor type classification |
| `index.ts` | Re-exports |

### Standalone Core Files
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
| `googleSheets/announcementSync.ts` | Google Sheets → announcements sync |
| `mindbody/import.ts`, `mindbody/index.ts` | MindBody data import |
| `supabase/client.ts` | Supabase admin client |
| `utils/emailNormalization.ts` | Email normalization utilities |

---

## Section 4: API Routes (`server/routes/`)

**CRITICAL RULE: Routes are THIN.** They handle HTTP request/response only. All business logic lives in `server/core/`. Never write business logic inline in route files.

### Booking Routes (`server/routes/bays/`)
- `bookings.ts` — Booking CRUD, cancellation flow
- `approval.ts` — Booking approval, rejection, prepayment
- `reschedule.ts` — Booking rescheduling
- `calendar.ts` — Booking calendar views
- `resources.ts` — Bay/resource management
- `notifications.ts` — Booking notifications
- `helpers.ts` — Shared route helpers
- `staff-conference-booking.ts` — Staff conference room booking
- `index.ts` — Route registration

### Stripe Routes (`server/routes/stripe/`)
- `payments.ts` — Payment processing endpoints
- `member-payments.ts` — Member-facing payment endpoints
- `subscriptions.ts` — Subscription management
- `invoices.ts` — Invoice endpoints
- `overage.ts` — Overage fee endpoints
- `admin.ts` — Stripe admin tools
- `config.ts` — Stripe config endpoints
- `coupons.ts` — Coupon management
- `terminal.ts` — Stripe Terminal (in-person readers)
- `helpers.ts` — Shared Stripe helpers
- `index.ts` — Route registration

### Trackman Routes (`server/routes/trackman/`)
- `webhook-index.ts` — Webhook entry point and signature verification
- `webhook-handlers.ts` — `handleBookingUpdate()`, auto-create, auto-link
- `webhook-billing.ts` — Webhook-triggered billing operations
- `webhook-helpers.ts` — Webhook utility functions
- `webhook-validation.ts` — Payload validation
- `import.ts` — CSV import endpoint
- `admin.ts` — Trackman admin tools
- `reconciliation.ts` — Reconciliation endpoints
- `index.ts` — Route registration

### Member Routes (`server/routes/members/`)
- `dashboard.ts` — Member dashboard data
- `profile.ts` — Profile endpoints
- `admin-actions.ts` — Admin member management
- `communications.ts` — Communication preferences
- `notes.ts` — Member notes (staff)
- `search.ts` — Member search
- `visitors.ts` — Visitor management
- `helpers.ts` — Shared member helpers
- `index.ts` — Route registration

### Conference Routes (`server/routes/conference/`)
- `prepayment.ts` — Conference room prepayment

### Staff Routes (`server/routes/staff/`)
- `manualBooking.ts` — Staff manual booking creation
- `index.ts` — Route registration

### Standalone Route Files
- `auth.ts` — Login, logout, session management
- `auth-google.ts` — Google Sign-In flow
- `account.ts` — Account settings, deletion
- `roster.ts` — Roster/participant management (uses `roster_version` locking)
- `resources.ts` — Resource/bay CRUD
- `availability.ts` — Availability endpoint
- `staffCheckin.ts` — Check-in flow, fee calculation
- `notifications.ts` — Notification CRUD
- `announcements.ts` — Club announcements
- `events.ts` — Event management, Eventbrite sync
- `calendar.ts` — Calendar endpoints
- `closures.ts` — Facility closures
- `cafe.ts` — Cafe menu (view-only, prices from Stripe)
- `checkout.ts` — Membership checkout flow
- `dayPasses.ts` — Day pass purchase and validation
- `guestPasses.ts` — Guest pass management
- `passes.ts` — Pass utilities
- `wellness.ts` — Wellness service endpoints
- `tours.ts` — Facility tour scheduling
- `financials.ts` — Financial reporting
- `memberBilling.ts` — Staff member billing tools
- `myBilling.ts` — Member self-service billing
- `membershipTiers.ts` — Tier management
- `tierFeatures.ts` — Tier feature comparison
- `pricing.ts` — Pricing display endpoints
- `groupBilling.ts` — Corporate billing
- `hubspot.ts` — HubSpot endpoints
- `hubspotDeals.ts` — HubSpot deal endpoints
- `dataIntegrity.ts` — Data integrity dashboard
- `dataExport.ts` — CCPA data export
- `dataTools.ts` — Admin data repair tools
- `settings.ts` — App settings
- `gallery.ts` — Photo gallery
- `faqs.ts` — FAQ management
- `bugReports.ts` — Bug report submission
- `inquiries.ts` — Contact form inquiries
- `training.ts` — Staff training guide
- `notices.ts` — Sequential notice system
- `push.ts` — Push notification registration
- `waivers.ts` — Waiver management
- `users.ts` — User CRUD
- `imageUpload.ts` — Image upload handling
- `idScanner.ts` — ID/license scanning (OpenAI Vision)
- `resendWebhooks.ts` — Resend email webhooks
- `legacyPurchases.ts` — Legacy purchase import
- `mindbody.ts` — MindBody import endpoints
- `mcp.ts` — MCP tool endpoints
- `testAuth.ts` — Dev-only test auth

---

## Section 5: Schedulers (`server/schedulers/`)

All run automatically on timers. Registered in `index.ts`.

| Scheduler | Frequency | Purpose |
|-----------|-----------|---------|
| `stuckCancellationScheduler.ts` | Every 2 hours | Alert staff about cancellations stuck 4+ hours |
| `feeSnapshotReconciliationScheduler.ts` | Every 15 minutes | Reconcile fee snapshots |
| `hubspotQueueScheduler.ts` | Every 2 minutes | Process HubSpot sync queue |
| `inviteExpiryScheduler.ts` | Every 5 minutes | Expire stale invites |
| `relocationCleanupScheduler.ts` | Every 5 minutes | Clean up relocation temp data |
| `bookingExpiryScheduler.ts` | Every hour | Expire unconfirmed bookings |
| `communicationLogsScheduler.ts` | Every 30 minutes | Sync communication logs |
| `dailyReminderScheduler.ts` | Daily 6pm Pacific | Send booking reminders |
| `morningClosureScheduler.ts` | Daily 8am Pacific | Notify about closures |
| `sessionCleanupScheduler.ts` | Daily 2am Pacific | Clean expired sessions |
| `memberSyncScheduler.ts` | Daily 3am Pacific | Full member data sync |
| `duplicateCleanupScheduler.ts` | Daily 4am Pacific + startup | Remove duplicates |
| `webhookLogCleanupScheduler.ts` | Daily 4am Pacific | Delete logs > 30 days |
| `stripeReconciliationScheduler.ts` | Daily 5am Pacific | Reconcile with Stripe |
| `unresolvedTrackmanScheduler.ts` | Daily 9am Pacific | Alert on unresolved Trackman bookings |
| `gracePeriodScheduler.ts` | Daily 10am Pacific | Check billing grace periods |
| `integrityScheduler.ts` | Daily midnight Pacific | Run data integrity checks |
| `weeklyCleanupScheduler.ts` | Sundays 3am Pacific | Weekly deep cleanup |
| `guestPassResetScheduler.ts` | 1st of month 3am Pacific | Reset monthly guest passes |
| `waiverReviewScheduler.ts` | Every 4 hours | Check for stale waivers |
| `backgroundSyncScheduler.ts` | Periodic | Background data sync tasks |

---

## Section 6: Email Templates (`server/emails/`)

| File | Purpose |
|------|---------|
| `bookingEmails.ts` | Booking confirmation, cancellation, reminder emails |
| `membershipEmails.ts` | Membership welcome, tier change, renewal emails |
| `paymentEmails.ts` | Payment receipt, failed payment, refund emails |
| `passEmails.ts` | Day pass and guest pass delivery emails |
| `welcomeEmail.ts` | New member welcome email |
| `integrityAlertEmail.ts` | Data integrity alert emails to staff |

---

## Section 7: Shared Types & Schema (`shared/`)

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
| `models/walkInVisits.ts` | Walk-in visit types |
| `constants/statuses.ts` | Booking/payment status strings |
| `constants/tiers.ts` | Tier name constants |
| `constants/products.ts` | Stripe product ID constants |
| `constants/index.ts` | Re-exports |

---

## Section 8: Database Migrations (`drizzle/`)

- Contains numbered `.sql` migration files
- `drizzle/meta/` — Auto-generated snapshot JSON files and migration journal. Never edit manually.
- **NEVER write migration files manually** — use `npm run db:push` (or `--force`)
- Schema changes go in `shared/schema.ts`, then push

---

## Section 9: Tests (`tests/`)

### Test Setup
- `tests/setup.ts` — Unit test global setup
- `tests/e2e/setup.ts` — E2E test setup (browser config)
- `tests/e2e/globalSetup.ts` — E2E global setup (server start)

### Unit Tests (`tests/unit/`) — Vitest
- `unifiedFeeService.test.ts` — Fee calculation tests
- `bookingService.test.ts` — Booking logic tests
- `bookingValidation.test.ts` — Validation tests
- `bookingLimitOverage.test.ts` — Limit/overage tests
- `bookingEvents.test.ts` — Booking event tests
- `rosterProtection.test.ts` — Roster locking tests
- `checkinBilling.test.ts` — Check-in billing tests
- `accessControl.test.ts` — Role/permission tests
- `notificationService.test.ts` — Notification tests
- `notifications.test.ts` — Notification type tests
- `dateUtils.test.ts` — Date utility tests
- `tierUtils.test.ts` — Tier utility tests
- `trainingGuide.test.ts` — Training guide tests
- `webhookIdempotency.test.ts` — Webhook dedup tests
- `productionValidation.test.ts` — Production readiness tests

### E2E Tests (`tests/e2e/`) — Playwright
- `booking-flow.test.ts` — Full booking flow
- `notification-flow.test.ts` — Notification delivery
- `calendar-integration.test.ts` — Calendar sync
- `data-integrity.test.ts` — Data integrity checks
- `admin-features.test.ts` — Admin feature tests
- `comprehensive-notification.test.ts` — Notification coverage
- `realtime-sync.test.ts` — WebSocket sync tests
- `wellness-waitlist.test.ts` — Wellness waitlist flow

---

## Section 10: PWA & Public Assets (`public/`)

| File/Dir | Purpose |
|----------|---------|
| `sw.js` | Service Worker — caching, offline support, update notifications |
| `manifest.webmanifest` | PWA manifest (app name, icons, theme) |
| `icon-192.png`, `icon-512.png` | PWA icons |
| `favicon.ico` | Browser favicon |
| `robots.txt` | Search engine crawl rules |
| `sitemap.xml` | SEO sitemap |
| `assets/` | Static assets (fonts, etc.) |
| `images/` | Static images |

---

## Section 11: Server Infrastructure

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
- `calendarSync.ts` — Calendar sync helpers
- `resend.ts` — Resend email sending
- `stringUtils.ts` — String manipulation
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

---

## Section 12: Other Directories

| Directory | Purpose | Editable? |
|-----------|---------|-----------|
| `.github/` | GitHub config directory (contains `workflows/` for CI/CD) | When changing CI/CD |
| `uploads/trackman/` | Uploaded Trackman CSV files | Auto-managed |
| `attached_assets/` | Reference images from conversations | Read-only |
| `docs/` | ER diagrams, feature roadmap, UI audit, API docs | Reference only |
| `scripts/` | Root-level maintenance scripts | Run manually |
| `dist/` | Build output | NEVER edit — auto-generated |
| `.github/workflows/` | GitHub Actions CI/CD | When changing CI/CD |

---

## Section 13: Auto-Generated — NEVER Touch

| Directory | Purpose |
|-----------|---------|
| `.cache/` | Build caches (node-gyp, pip, replit) |
| `.config/` | npm/replit runtime config |
| `.upm/` | Replit package manager state |
| `.replit_integration_files/` | Auto-generated integration code |
| `node_modules/` | npm dependencies |

---

## Section 14: Documentation Files

| File | Purpose |
|------|---------|
| `replit.md` | Agent memory — project docs, user preferences, architecture notes |
| `README.md` | Project readme |
| `TRAINING_CORRECTIONS_NEEDED.txt` | Training guide corrections log |
| `TRAINING_GUIDE_AUDIT.md` | Training guide audit report |
| `XSS_AUDIT_REPORT.md` | Security audit report |

---

## Section 15: Do-Not-Touch Zones

- **Folder `Z`** — Do not make changes (per user preference)
- **File `Y`** — Do not make changes (per user preference)

---

## Architectural Rules

### 1. Thin Routes
Routes (`server/routes/`) handle HTTP only. All business logic lives in `server/core/`. Never write business logic inline in route handlers.

### 2. Audit Logging
ALL staff actions must be logged using `logFromRequest()` from `server/core/auditLog.ts`. When adding new staff features, always add audit logging with appropriate action type, resource type, and details.

### 3. Changelog Updates
Update `src/data/changelog.ts` after EVERY significant change. Bump version numbers appropriately (patch for fixes, minor for features, major for breaking changes).

### 4. Pacific Timezone First
All date/time operations use Pacific timezone (`America/Los_Angeles`). Use `server/utils/dateUtils.ts` utilities, never raw `new Date()` comparisons.

### 5. API Field Name Consistency
Response field names must EXACTLY match frontend TypeScript interfaces. Before returning `res.json({...})`, verify field names against the frontend interface definition.

---

## The Refactoring Rule

**CRITICAL**: If you are asked to move files, rename folders, or refactor code structure, you MUST update this skill file (`.agents/skills/project-architecture/SKILL.md`) at the end of the task to reflect the new paths. This keeps the map accurate across sessions.

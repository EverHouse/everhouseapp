# Frontend Architecture (`src/`)

## Entry Points

| File | Purpose |
|------|---------|
| `src/main.tsx` | React app bootstrap, provider tree, router mount |
| `src/App.tsx` | Top-level routing, layout wrappers, auth guards |
| `src/index.css` | Global styles, Tailwind directives, CSS keyframe animations |

---

## Pages (`src/pages/`)

Three page groups organized by user role.

### Public Pages (`src/pages/Public/`)

No auth required:

- `Landing.tsx`, `Login.tsx`, `AuthCallback.tsx`
- `Membership.tsx`, `MembershipApply.tsx`, `Checkout.tsx` (root-level)
- `BuyDayPass.tsx`, `DayPassSuccess.tsx`
- `Cafe.tsx`, `Gallery.tsx`, `FAQ.tsx`, `Contact.tsx`
- `WhatsOn.tsx`, `PrivateHire.tsx`, `PrivateHireInquire.tsx`
- `PrivacyPolicy.tsx`, `TermsOfService.tsx`
- `About.tsx` — About page
- `BookTour.tsx` — Tour booking page

### Member Pages (`src/pages/Member/`)

Authenticated members:

- `Dashboard.tsx` — Member home, balance, upcoming bookings
- `BookGolf.tsx` — Simulator booking flow
- `Events.tsx` — Club events and RSVPs
- `History.tsx` — Booking and payment history
- `Profile.tsx` — Member profile, settings, Google linking
- `Updates.tsx` — Club announcements
- `Wellness.tsx` — Wellness service booking
- `NfcCheckin.tsx` — NFC check-in page

**Subdirectory `bookGolf/`** — Booking flow sub-components:
- `bookGolfTypes.ts` — Booking flow type definitions
- `DatePickerStrip.tsx` — Date selector strip
- `ResourceCard.tsx` — Resource/bay card display

### Admin Pages (`src/pages/Admin/`)

Staff/admin only:

- `AdminDashboard.tsx` — Staff command center
- `ApplicationPipeline.tsx` — Application pipeline management
- `BugReportsAdmin.tsx`, `DataIntegrity.tsx`, `FaqsAdmin.tsx`
- `GalleryAdmin.tsx`, `InquiriesAdmin.tsx`

**Subdirectory `components/`** — Admin-specific components:
- `AvailabilityBlocksContent.tsx` — Availability blocks management content

**Subdirectory `layout/`** — Admin layout components:
- `StaffBottomNav.tsx` — Staff mobile bottom nav
- `StaffSidebar.tsx` — Staff desktop sidebar
- Types and hooks sub-dirs

**Subdirectory `tabs/`** — Admin tab panels:
- `AnnouncementsTab.tsx` — Announcements management
- `BlocksTab.tsx` — Availability blocks management
- `CafeTab.tsx` — Cafe menu management
- `ChangelogTab.tsx` — Changelog display
- `DataIntegrityTab.tsx` — Data integrity dashboard (slim orchestrator; logic split into `dataIntegrity/useDataIntegrityActions.ts`, `dataIntegrity/useDataIntegrityState.ts`, `dataIntegrity/HealthStatusGrid.tsx`, `dataIntegrity/IntegritySummaryStats.tsx`, `dataIntegrity/CalendarStatusSection.tsx`, `dataIntegrity/HistorySection.tsx`)
- `DirectoryTab.tsx` — Member directory (slim orchestrator; logic split into `directory/useDirectoryData.ts`, `directory/useDirectoryFilters.ts`, `directory/ActiveMembersList.tsx`, `directory/FormerMembersList.tsx`, `directory/VisitorsList.tsx`, `directory/TeamList.tsx`, `directory/DirectoryFilters.tsx`, `directory/DirectoryListHeader.tsx`, `directory/directoryTypes.ts`)
- `DiscountsSubTab.tsx` — Discount management
- `EmailTemplatesTab.tsx` — Email template preview and management
- `EventsTab.tsx` — Events management
- `FinancialsTab.tsx` — Financial reports
- `ProductsSubTab.tsx` — Stripe products management
- `SettingsTab.tsx` — App settings
- `SimulatorTab.tsx` — Simulator management
- `TeamTab.tsx` — Staff team management
- `TiersTab.tsx` — Membership tier management
- `ToursTab.tsx` — Tour management tab
- `TrackmanTab.tsx` — Trackman integration management
- `UpdatesTab.tsx` — Updates/changelog tab

**Subdirectory `tabs/dataIntegrity/`** — Data integrity sub-panels:
- `AlertHistoryPanel.tsx` — Alert history tracking panel
- `AuditLogPanel.tsx` — Audit log viewer
- `AutoApprovePanel.tsx` — Auto-approve settings
- `CleanupToolsPanel.tsx` — Database cleanup tools
- `EmailHealthPanel.tsx` — Email delivery health monitor
- `HubSpotQueuePanel.tsx` — HubSpot sync queue monitor
- `IgnoreModals.tsx` — Ignore/dismiss modals for integrity issues
- `IntegrityResultsPanel.tsx` — Integrity check results
- `JobQueuePanel.tsx` — Job queue monitor
- `MarketingContactsAuditPanel.tsx` — Marketing contacts audit
- `PushNotificationPanel.tsx` — Push notification management
- `SchedulerMonitorPanel.tsx` — Scheduler execution monitor
- `StripeTerminalPanel.tsx` — Stripe Terminal management
- `SyncToolsPanel.tsx` — Data sync tools
- `WebhookEventsPanel.tsx` — Webhook event log panel
- `dataIntegrityTypes.ts` — Data integrity type definitions
- `dataIntegrityUtils.ts` — Data integrity utility functions

**Subdirectory `tabs/events/`** — Event management tabs

**Subdirectory `tabs/simulator/`** — Simulator management tabs

---

## Components (`src/components/`)

### Directory-based Components

| Directory | Contains |
|-----------|----------|
| `admin/` | Admin-specific UI (member drawers, data tools, settings panels). Sub-dirs: `billing/`, `payments/`, `memberBilling/` (split from `MemberBillingTab.tsx`) |
| `billing/` | Payment forms, fee displays, invoice views |
| `booking/` | Booking cards, calendar views, slot pickers |
| `guides/` | Guided flows and walkthroughs |
| `icons/` | Custom SVG icon components |
| `layout/` | Header, sidebar, page wrappers |
| `memberProfile/` | Member profile detail components |
| `motion/` | Animation wrappers, parallax, staggered entry |
| `profile/` | Member profile sections, tier badges, settings |
| `shared/` | Reusable generic components (buttons, modals, inputs). Includes `FeeBreakdownCard.tsx` (fee display card) and `PlayerSlotEditor.tsx` (player slot editing) |
| `skeletons/` | Loading skeleton placeholders |
| `stripe/` | Stripe Elements wrappers, payment forms |
| `ui/` | Design system primitives (Liquid Glass styled) |

### Staff Command Center (`src/components/staff-command-center/`)

Sub-dirs: `drawers/`, `hooks/`, `modals/`, `sections/`.

**Key component**: `UnifiedBookingSheet.tsx` + `useUnifiedBookingLogic.ts` — the SINGLE AUTHORITY for all roster edits.

**Modals** (`modals/`):
- `UnifiedBookingSheet.tsx` — Unified booking management sheet
- `useUnifiedBookingLogic.ts` — Booking sheet orchestration hook
- `AssignModeFooter.tsx` — Assign mode footer actions
- `AssignModeSlots.tsx` — Assign mode slot display
- `bookingSheetTypes.ts` — Booking sheet type definitions
- `ManageModeRoster.tsx` — Manage mode roster display
- `PaymentSection.tsx` — Payment section in booking sheet
- `SheetHeader.tsx` — Booking sheet header
- `TrackmanBookingModal.tsx` — Trackman booking details modal
- `StaffManualBookingModal.tsx` — Staff manual booking creation
- `StaffDirectAddModal.tsx` — Staff direct add modal
- `CheckinBillingModal.tsx` — Check-in billing confirmation
- `CheckInConfirmationModal.tsx` — Check-in confirmation dialog
- `IdScannerModal.tsx` — ID/license scanning modal
- `QrScannerModal.tsx` — QR code scanning modal

**Sections** (`sections/`):
- `AlertsCard.tsx` — Staff alerts display card
- `BookingQueuesSection.tsx` — Booking queues overview
- `OverduePaymentsSection.tsx` — Overdue payments tracker
- `ResourcesSection.tsx` — Resource/bay status section
- `TrackmanWebhookEventsSection.tsx` — Trackman webhook event log

**Drawers** (`drawers/`):
- Sub-dir: `newUser/` — New user creation drawer

### Root-level Standalone Components

- `SlideUpDrawer.tsx` — Drawer UX with drag-to-dismiss
- `ConfirmDialog.tsx` — Liquid Glass styled confirmation dialogs
- `FloatingActionButton.tsx` — Staff FAB for quick actions
- `MemberBottomNav.tsx` — Mobile bottom navigation
- `StaffMobileSidebar.tsx` — Staff mobile nav sidebar
- `StaffCommandCenter.tsx` — Main staff dashboard component
- `MemberProfileDrawer.tsx` — Member detail drawer
- `ModalShell.tsx` — Shared modal shell wrapper
- `ContextualHelp.tsx` — Context-aware help tooltips
- `OnboardingChecklist.tsx` — New member onboarding checklist
- `MenuOverlay.tsx` — General menu overlay
- `MemberMenuOverlay.tsx` — Member-specific menu overlay
- `Toast.tsx` — Toast notification system
- `WaiverModal.tsx` — Waiver signing modal
- `UpdateNotification.tsx` — PWA update prompt
- `ErrorBoundary.tsx`, `PageErrorBoundary.tsx`, `FeatureErrorBoundary.tsx`
- `WalkingGolferLoader.tsx`, `WalkingGolferSpinner.tsx` — Branded loading states
- `PullToRefresh.tsx` — Pull-to-refresh with branded animation (wraps app in `App.tsx`)
- And others (Avatar, Logo, SEO, Toggle, Input, etc.)

---

## State Management

### Zustand Stores (`src/stores/`)

- `notificationStore.ts` — In-app notification state, unread counts
- `userStore.ts` — Current user session, role, preferences

### Contexts (`src/contexts/`)

- `DataContext.tsx` — Central data provider (TanStack Query)
- `AuthDataContext.tsx` — Auth session data provider
- `AnnouncementDataContext.tsx` — Announcement data provider
- `AnnouncementBadgeContext.tsx` — Unread announcement badges
- `BookingDataContext.tsx` — Booking data provider
- `CafeDataContext.tsx` — Cafe data provider
- `EventDataContext.tsx` — Event data provider
- `MemberDataContext.tsx` — Member data provider
- `NotificationContext.tsx` — Notification delivery and display
- `ThemeContext.tsx` — Light/Dark/System theme
- `StaffWebSocketContext.tsx` — Real-time staff updates
- `BottomNavContext.tsx` — Mobile bottom nav visibility
- `NavigationLoadingContext.tsx` — Page transition loading states
- `PageReadyContext.tsx` — Page-ready signals for animations

---

## Hooks (`src/hooks/`)

- `useStaffWebSocket.ts`, `useWebSocket.ts`, `useWebSocketQuerySync.ts` — Real-time sync
- `useSupabaseRealtime.ts` — Supabase realtime subscriptions
- `usePricing.ts` — Stripe pricing data
- `useTierPermissions.ts` — Tier-based feature gating
- `useServiceWorkerUpdate.ts` — PWA update detection (10-min interval + visibility change)
- `useBreakpoint.ts` — Responsive breakpoint detection
- `useScrollLock.ts`, `useScrollLockManager.ts` — Modal scroll locking
- `useKeyboardDetection.ts` — Mobile keyboard handling
- `useParallax.ts` — Parallax animations
- `useEdgeSwipe.ts`, `useDragAutoScroll.ts` — Touch gestures
- `useNotificationSounds.ts` — Audio alerts
- `useAsyncAction.ts` — Async action with loading/error states
- Sub-dir: `queries/` — TanStack Query hook definitions

---

## Services (`src/services/`)

- `pushNotifications.ts` — Push notification registration and handling
- `tierService.ts` — Client-side tier lookup and caching

## Lib (`src/lib/`)

- `apiRequest.ts` — Centralized fetch wrapper with auth headers
- `queryClient.ts` — TanStack Query client configuration
- `supabase.ts` — Supabase client initialization
- `bookingEvents.ts` — Booking event bus helpers
- `backgroundSync.ts` — Background data sync for offline
- `prefetch.ts` — Route prefetching

## Config (`src/config/`)

- `branding.ts` — Brand colors, names, logos
- `version.ts` — Current app version

## Data (`src/data/`)

- `changelog.ts` — Version changelog entries (UPDATE AFTER EVERY FEATURE/FIX)
- `changelog-version.ts` — Latest version for "new updates" badge
- `defaults.ts` — Default values and constants
- `integrityCheckMetadata.ts` — Data integrity check definitions

## Types (`src/types/`)

- `data.ts` — Frontend data type definitions
- `stripe.d.ts` — Stripe type declarations

## Utils (`src/utils/`)

- `closureUtils.ts` — Closure date helpers
- `dateUtils.ts` — Date formatting (Pacific timezone priority)
- `errorHandling.ts` — Error parsing and display
- `formatting.ts` — Number, currency, text formatting
- `haptics.ts` — Mobile haptic feedback
- `icalUtils.ts` — Calendar file generation
- `permissions.ts` — Role/permission checks
- `phoneFormat.ts` — Phone number formatting
- `sounds.ts` — Audio file references
- `statusColors.ts` — Booking/payment status color mapping
- `tierUtils.ts` — Tier comparison and display helpers

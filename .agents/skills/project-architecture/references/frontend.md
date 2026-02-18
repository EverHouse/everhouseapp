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

**Subdirectory `bookGolf/`** — Booking flow sub-components:
- `types.ts` — Booking flow type definitions
- `DatePickerStrip.tsx` — Date selector strip
- `ResourceCard.tsx` — Resource/bay card display

### Admin Pages (`src/pages/Admin/`)

Staff/admin only:

- `AdminDashboard.tsx` — Staff command center
- `ApplicationPipeline.tsx` — Application pipeline management
- `BugReportsAdmin.tsx`, `DataIntegrity.tsx`, `FaqsAdmin.tsx`
- `GalleryAdmin.tsx`, `InquiriesAdmin.tsx`

**Subdirectory `components/`** — Admin-specific components

**Subdirectory `layout/`** — Admin layout components:
- `StaffBottomNav.tsx` — Staff mobile bottom nav
- `StaffSidebar.tsx` — Staff desktop sidebar
- Types and hooks sub-dirs

**Subdirectory `tabs/`** — Admin tab panels:
- `EmailTemplatesTab.tsx` — Email template preview and management
- `ToursTab.tsx` — Tour management tab

**Subdirectory `tabs/dataIntegrity/`** — Data integrity sub-panels:
- `AlertHistoryPanel.tsx` — Alert history tracking panel
- `CleanupToolsPanel.tsx` — Database cleanup tools
- `HubSpotQueuePanel.tsx` — HubSpot sync queue monitor
- `JobQueuePanel.tsx` — Job queue monitor
- `SchedulerMonitorPanel.tsx` — Scheduler execution monitor
- `SyncToolsPanel.tsx` — Data sync tools
- `WebhookEventsPanel.tsx` — Webhook event log panel

**Subdirectory `tabs/events/`** — Event management tabs

**Subdirectory `tabs/simulator/`** — Simulator management tabs

---

## Components (`src/components/`)

### Directory-based Components

| Directory | Contains |
|-----------|----------|
| `admin/` | Admin-specific UI (member drawers, data tools, settings panels). Sub-dirs: `billing/`, `payments/` |
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
- `ManageModeRoster.tsx` — Manage mode roster display
- `PaymentSection.tsx` — Payment section in booking sheet
- `SheetHeader.tsx` — Booking sheet header
- `TrackmanBookingModal.tsx` — Trackman booking details modal
- `StaffManualBookingModal.tsx` — Staff manual booking creation
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
- And others (Avatar, Logo, SEO, Toggle, Input, etc.)

---

## State Management

### Zustand Stores (`src/stores/`)

- `notificationStore.ts` — In-app notification state, unread counts
- `userStore.ts` — Current user session, role, preferences

### Contexts (`src/contexts/`)

- `DataContext.tsx` — Central data provider (TanStack Query)
- `NotificationContext.tsx` — Notification delivery and display
- `ThemeContext.tsx` — Light/Dark/System theme
- `StaffWebSocketContext.tsx` — Real-time staff updates
- `AnnouncementBadgeContext.tsx` — Unread announcement badges
- `BottomNavContext.tsx` — Mobile bottom nav visibility
- `NavigationLoadingContext.tsx` — Page transition loading states
- `PageReadyContext.tsx` — Page-ready signals for animations

---

## Hooks (`src/hooks/`)

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
- `defaults.ts` — Default values and constants
- `integrityCheckMetadata.ts` — Data integrity check definitions

## Types (`src/types/`)

- `data.ts` — Frontend data type definitions
- `stripe.d.ts` — Stripe type declarations

## Utils (`src/utils/`)

- `dateUtils.ts` — Date formatting (Pacific timezone priority)
- `formatting.ts` — Number, currency, text formatting
- `permissions.ts` — Role/permission checks
- `tierUtils.ts` — Tier comparison and display helpers
- `statusColors.ts` — Booking/payment status color mapping
- `errorHandling.ts` — Error parsing and display
- `haptics.ts` — Mobile haptic feedback
- `sounds.ts` — Audio file references
- `icalUtils.ts` — Calendar file generation

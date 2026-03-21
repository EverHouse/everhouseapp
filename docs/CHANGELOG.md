# Changelog

All notable changes to the Ever Club Members App are documented here.

## [8.95.1] - 2026-03-21

### Dynamic Tiers Cleanup: Hardcoded Tier Mappings, Bug Fixes, Error Handling
- **Fixed**: MindBody import tier mapping now uses dynamic tier registry (`normalizeTierName` from `tierUtils`) instead of hardcoded 7-tier `TIER_MAPPING` lookup table.
- **Fixed**: HubSpot integrity resolution `hubspotTierToAppTier` now uses dynamic `normalizeTierName` instead of hardcoded `HUBSPOT_TO_APP_TIER` lookup.
- **Fixed**: Missing `getErrorMessage` import in `memberSyncRelevant.ts` — would have caused `ReferenceError` when the HubSpot email correction error branch executed.
- **Fixed**: Simulator booking upgrade error message no longer lists specific tier names — uses generic dynamic message.
- **Fixed**: `MembershipApply` tier options now filter by `product_type='subscription'` and use empty fallback instead of hardcoded `['Social', 'Core', 'Premium', 'Corporate']`.
- **Fixed**: `useTierNames` hook uses empty array fallback instead of hardcoded 5-tier list — prevents stale tier names appearing before API data loads.
- **Fixed**: All catch blocks in `server/core/hubspot/stages.ts` now use `getErrorMessage()` instead of logging raw error objects.
- **Scope**: `server/core/mindbody/import.ts`, `server/core/integrity/resolution.ts`, `server/core/memberSyncRelevant.ts`, `server/core/resource/service.ts`, `server/core/hubspot/stages.ts`, `src/hooks/useTierNames.ts`, `src/pages/Public/MembershipApply.tsx`.

## [8.95.0] - 2026-03-20

### Dynamic Tiers: Deactivation Warning, Dynamic Names, HubSpot Auto-Sync
- **Added**: Deactivation warning dialog shows active member count before a tier can be toggled inactive — prevents accidental deactivation of tiers with paying members.
- **Added**: Tier names are now fully dynamic — new tiers with custom names no longer require code changes. The DB CHECK constraint was removed; the normalization trigger now reads from the `membership_tiers` table.
- **Added**: `server/core/tierRegistry.ts` loads tiers from DB on startup; `shared/constants/tiers.ts` and `server/utils/tierUtils.ts` populated dynamically via `setTierData()`/`setServerTierData()`.
- **Added**: HubSpot `membership_tier` dropdown options auto-sync from the database via `ensureHubSpotPropertiesExist`. New tiers automatically appear as HubSpot property options.
- **Added**: HubSpot tier dropdown sync triggers fire-and-forget on tier create and rename in `server/routes/membershipTiers.ts`.
- **Improved**: `denormalizeTierForHubSpot`/`denormalizeTierForHubSpotAsync` now accept any tier name, not just 7 hardcoded ones. Unknown tiers get "{Name} Membership" suffix.
- **Improved**: Frontend components (`DirectoryFilters`, `MemberProfileDrawer`, `MembershipApply`, `StaffDirectAddModal`) load tier options dynamically via `useTierNames()` hook.
- **Fixed**: Comparison page default tier selection now picks first 3 tiers from API data instead of hardcoded `['Social', 'Core', 'Premium']`.
- **Fixed**: Tier limits fallback returns the requested tier name with restrictive permissions instead of hardcoded `'Social'`.
- **Cleaned**: Removed dead `TIER_OPTIONS_FALLBACK`, `ASSIGNABLE_TIERS_FALLBACK` exports from `directoryTypes.ts` and unused `TIER_NAMES`/`DEFAULT_TIER` re-exports from `permissions.ts`.
- **Scope**: `server/core/tierRegistry.ts`, `server/utils/tierUtils.ts`, `server/db-init.ts`, `server/routes/membershipTiers.ts`, `server/core/hubspot/stages.ts`, `server/core/hubspot/constants.ts`, `shared/constants/tiers.ts`, `src/hooks/useTierNames.ts`, `src/pages/Admin/tabs/TiersTab/useTiersTab.ts`, `src/pages/Admin/tabs/directory/directoryTypes.ts`, `src/pages/Admin/tabs/directory/DirectoryFilters.tsx`, `src/pages/Public/Membership.tsx`, `src/pages/Public/MembershipApply.tsx`, `src/utils/permissions.ts`.

## [8.94.18] - 2026-03-20

### Tier Editor UX: Vertical IDs, Copy Buttons, Price Input, Sheet Titles
- **Improved**: Stripe Product/Price IDs in the "Linked to Stripe" card now render in a vertical (stacked) layout instead of a 2-column grid. IDs no longer overflow or get clipped on mobile.
- **Added**: Copy-to-clipboard button (content_copy icon) next to every displayed Stripe Product ID and Price ID — in the tier editor linked card, dynamic fee cards (guest fee, overage rate), and one-time pass cards.
- **Added**: "Price (cents)" number input in the tier editor when no Stripe price is linked, allowing admins to set the price directly in the app (auto-push creates the Stripe price on save). Shows a human-readable dollar conversion below.
- **Added**: Stripe Price ID now shown in each dropdown item when linking to a Stripe price (format: `{product name} — {display string} — {price_id}`), making it easier to identify the correct price.
- **Fixed**: Tier editor sheet title now reflects the type: "New Subscription" for subscription tiers, "New Product" for one-time products (was "New Tier" for both).
- **Scope**: `src/pages/Admin/tabs/TiersTab/TierEditorDrawer.tsx`, `src/pages/Admin/tabs/TiersTab/FeesSubTab.tsx`.

## [8.94.17] - 2026-03-20

### Stripe Sync Hardening: Loop Prevention + Source-of-Truth Safety
- **Security**: `PUT /api/membership-tiers/:id` no longer accepts `stripe_product_id` or `stripe_price_id` from the frontend request body. These fields are now server-managed only via `autoPushTierToStripe`. Previously, the frontend could accidentally send `null` for these fields (e.g., before autoPush completed), causing the backend to erase the Stripe linkage and create duplicate Stripe products on the next save.
- **Fixed**: Added `markAppOriginated()` calls to all remaining Stripe API update paths:
  - `productCatalogSync.ts`: cafe product updates (existing, reuse, default_price), cafe price archival
  - `productCreation.ts`: guest pass product rename
  - These were the last callsites without loop-prevention tagging, meaning their webhook echoes could trigger redundant DB mutations.
- **Fixed**: Admin pricing endpoints (`/api/admin/pricing/guest-fee`, `/api/admin/pricing/overage-rate`) now only update in-memory pricing config after Stripe push succeeds. Previously they updated in-memory first (optimistic), creating the same source-of-truth drift risk that was fixed in `PUT /api/pricing` in v8.94.16.
- **Cleanup**: Removed unused `isProduction` import from `membershipTiers.ts`. Standardized error handling in `productCreation.ts` guest pass rename catch to use `getErrorMessage()`.
- **Scope**: `server/routes/membershipTiers.ts`, `server/core/stripe/productCatalogSync.ts`, `server/core/stripe/productCreation.ts`.

## [8.94.16] - 2026-03-20

### Source-of-Truth Hardening: Stripe Sync Safety + Validation
- **Fixed**: Cafe delete now returns `502` and aborts if Stripe product archival fails (non-404 errors). Previously, a Stripe outage would leave an active Stripe product with no matching DB record — an orphaned product with no way to reconcile. The delete only proceeds once Stripe confirms the archive, or if the product is already gone (404).
- **Fixed**: `handleProductDeleted` webhook handler now checks `isAppOriginated(product.id)` and skips processing if the deletion was initiated by the app. This closes the last gap in webhook loop prevention — previously only `handleProductUpdated` and `handlePriceDeleted` had this guard.
- **Fixed**: `PUT /api/pricing` now only calls `updateGuestFee()` / `updateOverageRate()` (in-memory config) after `autoPushFeeToStripe` succeeds. Previously, in-memory pricing was updated optimistically before the Stripe push, so if Stripe failed, the runtime would charge the new price while Stripe still held the old one — a source-of-truth drift.
- **Fixed**: `PUT /api/cafe-menu/:id` now validates that `price` is a non-negative number before writing to the database. Previously, invalid or negative prices could pass Zod's loose `z.union([z.string(), z.number()])` check and cause DB errors or broken Stripe sync.
- **Fixed**: Pricing route catch block now uses `getErrorMessage(error)` instead of raw `error instanceof Error ? error : new Error(String(error))` pattern, consistent with project error-handling standards.
- **Scope**: `server/routes/cafe.ts`, `server/routes/pricing.ts`, `server/core/stripe/webhooks/handlers/catalog.ts`.

## [8.94.15] - 2026-03-20

### Cafe Item Cleanup: Hard Delete + Webhook Loop Prevention
- **Fixed**: `handleProductDeleted` webhook handler (`server/core/stripe/webhooks/handlers/catalog.ts`) now hard-deletes (`DELETE FROM cafe_items`) instead of soft-deleting (`SET is_active = false`) when a Stripe product is deleted. Previously, deleted Stripe products left behind ghost cafe items that showed as "archived" in the admin view with no way to fully remove them.
- **Fixed**: Admin cafe item delete endpoint (`DELETE /api/cafe-menu/:id`) now performs a hard delete (`db.delete()`) instead of soft-delete (`SET isActive: false`). The endpoint still archives the Stripe product first if one exists and is still active.
- **Fixed**: Admin cafe delete now calls `markAppOriginated(stripeProductId)` before archiving the Stripe product, preventing the webhook handler from redundantly processing the echoed `product.updated` event. This seals the webhook loop prevention that was missing on the cafe delete path.
- **Data cleanup**: Removed 32 orphaned inactive cafe items from the database that had accumulated from previous soft-deletes. All had empty `stripe_product_id` and `stripe_price_id`.
- **Scope**: `server/core/stripe/webhooks/handlers/catalog.ts`, `server/routes/cafe.ts`.

## [8.94.14] - 2026-03-20

### Fees & Passes: New Product Button + Stripe Price IDs
- **Added**: "New Product" button on the Fees & Passes tab that creates a one-time product with appropriate defaults (`product_type: 'one_time'`, `show_in_comparison: false`, `show_on_membership_page: false`, `button_text: 'Purchase'`). Previously one-time products could only be created via the Memberships tab's "New Tier" button, which was unintuitive.
- **Added**: Stripe price IDs are now displayed on the Dynamic Fees cards (Guest Fee, Overage Rate) — found by matching the tier slug (`guest-pass`, `simulator-overage-30min`) from the tiers list. Also shown on each one-time pass card.
- **Improved**: The Memberships tab "New Tier" button now explicitly sets `product_type: 'subscription'` to prevent accidentally creating subscription tiers from the wrong tab.
- **Added**: `openCreateOneTime` function in `useTiersTab.ts` — separate creation path for one-time products with proper defaults.
- **Scope**: `src/pages/Admin/tabs/TiersTab/FeesSubTab.tsx`, `src/pages/Admin/tabs/TiersTab/useTiersTab.ts`, `src/pages/Admin/tabs/TiersTab/index.tsx`.

## [8.94.13] - 2026-03-20

### Editable Card Marketing Features
- **Fixed**: Card marketing features on the tier editor are now fully editable — admins can add, edit, and remove features directly in the app. Previously, once a tier was linked to Stripe (which all real tiers are), the features section became read-only with the message "Marketing features synced from Stripe."
- **Improved**: Features are now free-text input fields instead of checkboxes tied to boolean privilege labels. This means admins can type any description (e.g., "90 min Daily Golf", "Priority Booking (14 days)") instead of being limited to the names of enabled tier privileges.
- **Fixed**: Empty feature entries are automatically stripped out before saving, preventing blank marketing features from being pushed to Stripe.
- **Technical**: The save handler (`handleSave` in `useTiersTab.ts`) now filters `highlighted_features` to remove empty/whitespace-only strings before mutation. The existing `autoPushTierToStripe` engine already maps `highlighted_features` → Stripe `marketing_features`, so no backend changes were needed.
- **Scope**: `src/pages/Admin/tabs/TiersTab/TierEditorDrawer.tsx`, `src/pages/Admin/tabs/TiersTab/useTiersTab.ts`.

## [8.94.12] - 2026-03-20

### Stripe Sync Reliability & Cafe Item Creation
- **Fixed**: Tier create/update (`POST /api/membership-tiers`, `PUT /api/membership-tiers/:id`) and cafe item creation (`POST /api/cafe-menu`) now `await` the Stripe auto-push and return `synced`/`syncError` in the response. Previously these ran fire-and-forget with `.catch()`, so the admin UI always showed success even when Stripe sync actually failed.
- **Added**: "New Item" button and `useCreateCafeItem` mutation on the Cafe admin tab (`CafeTab.tsx`). Admins can now create new menu items directly from the UI — previously the component only supported editing existing items (the create path was never wired up).
- **Fixed**: Fee pricing updates (`PUT /api/pricing`) now delegate to `autoPushFeeToStripe` from `server/core/stripe/autoPush.ts` instead of a local `pushFeeToStripe` function that duplicated logic but skipped stale-price archival and audit logging. The local function has been deleted.
- **Added**: Audit logging (`logFromRequest`) for fee pricing changes in the `/api/pricing` PUT handler.
- **Scope**: `server/routes/pricing.ts`, `server/routes/membershipTiers.ts`, `server/routes/cafe.ts`, `src/pages/Admin/tabs/CafeTab.tsx`, `src/hooks/queries/useCafeQueries.ts`.

## [8.94.11] - 2026-03-20

### Complete Bidirectional Stripe Sync
- **Fixed**: When a Stripe product is deleted, the matching membership tier, fee, or pass is now fully deactivated in the app (sets `is_active = false`). Previously it only cleared the `stripe_product_id` and `stripe_price_id`, leaving an orphaned active tier with no Stripe backing — new subscriptions to it would silently fail.
- **Added**: `price.deleted` webhook handler. When a price is deleted in Stripe, the app clears the local `stripe_price_id` reference from matching tiers or cafe items so it won't try to use a deleted price for checkouts or renewals. Logs warnings for fee products (guest-pass, overage) that lose their price.
- **Improved**: `product.created` webhook now auto-links Stripe products to existing local records when the product's metadata contains a matching `tier_id` or `cafe_item_id`, instead of only logging. This handles the case where products are recreated in Stripe.
- **Fixed**: Bulk sync (`syncMembershipTiersToStripe`) now calls `markAppOriginated()` before every outbound Stripe API call (product create/update, price create/deactivate, default_price update, orphan archive). Previously these mutations triggered webhook echoes that caused unnecessary DB writes.
- **Fixed**: Bulk sync now sets `default_price` on the Stripe product after creating any new or replacement price. Previously the product could show a stale default price in the Stripe Dashboard.
- **Fixed**: Error logging in `productSync.ts` now uses `getErrorMessage()` consistently instead of raw error objects.
- **Added**: `handlePriceDeleted` export from `catalog.ts`, wired into the webhook dispatcher.
- **Scope**: `webhooks/handlers/catalog.ts`, `webhooks/index.ts`, `productSync.ts`.

## [8.94.10] - 2026-03-20

### Fix Stripe ID Preservation on Tier Save
- **Fixed**: The tier PUT handler used `${stripe_price_id || null}`, `${stripe_product_id || null}`, and `${price_cents || null}` instead of `COALESCE`. When the frontend saved a tier without including those fields (which is normal — they're system-managed), the values were wiped to `null` in the database. This caused `autoPushTierToStripe` to re-discover or re-create the Stripe product and price on every single save, producing unnecessary API calls and potentially orphaned prices. Changed to `COALESCE(${value}, column)` to match the pattern used by every other field in the same query.
- **Fixed**: The `handlePriceChange` webhook handler now skips inactive prices. Previously, when auto-push replaced a price (deactivating the old one and creating a new one), the `price.updated` webhook for the deactivation could arrive after the new price was set, overwriting the DB with stale `stripe_price_id` and `price_cents` values.
- **Fixed**: Editing membership privileges was failing with `all_features.events: Invalid input: expected boolean, received object`. The `all_features` field in the database stores rich feature objects (e.g. `{"label": "Programs & Events", "value": "✓", "included": true}`), not simple booleans. Updated the Zod validation schema to accept both `boolean` and `{label, value, included}` object formats.

## [8.94.9] - 2026-03-20

### Fix Tier Editor Validation
- **Fixed**: Editing membership tiers was failing with `all_features: Invalid input: expected array, received object`. The Zod validation schema in `membershipTiers.ts` defined `all_features` as `z.array(z.string())` but the frontend sends it as `Record<string, boolean>` (an object mapping feature names to booleans). Updated the schema to `z.record(z.string(), z.boolean())` to match the actual data shape.

## [8.94.8] - 2026-03-20

### Application Notes & CSP Fix
- **Fixed**: Saving notes on the Admin Applications page was silently failing with a 400 error. The `useSaveApplicationNotes` hook sends `{ notes }` to the `/api/admin/applications/:id/status` endpoint, but the route handler required a valid `status` in the body. Made `status` optional on the backend — when only `notes` are provided, only notes are updated.
- **Fixed**: Restored `'unsafe-inline'` to the Content Security Policy `style-src` directive. It had been accidentally dropped, causing browsers to block React inline styles and breaking page layout. This is a documented trade-off required by React inline styles and third-party widget CSS.

## [8.94.6] - 2026-03-20

### Error Logging Safety Sweep
- **Fixed**: Eliminated all raw error object logging across the server codebase (30+ files, ~100 occurrences). Three unsafe patterns were addressed:
  1. `{ extra: { err } }` / `{ extra: { calError } }` / `{ extra: { hubspotError } }` etc. — raw caught errors in structured extra fields, producing `[object Object]` in JSON logs. All replaced with `{ extra: { error: getErrorMessage(varName) } }`.
  2. `logger.warn('message', err)` / `logger.error('message', err)` — raw error as the logger's second positional argument. Error properties are non-enumerable, so all error details were silently discarded. 16 instances fixed.
- **Scope**: Booking approval/cancellation/completion flows, Stripe payments/subscriptions/invoices/terminal, HubSpot sync/contacts/forms, closures CRUD, member billing/communications, day passes, guest roster, training, auth (OTP, session, passkey, helpers), waivers, onboarding, Trackman import, integrity resolution, Resend webhooks, visitors, booking creation/cancellation/fees, account deletion, and kiosk check-in.
- **Added**: Missing `getErrorMessage` imports to `hubspot/forms.ts`, `members/communications.ts`, `testAuth.ts`, `account.ts`, `bays/booking-shared.ts`, `training.ts`, `waivers.ts`
- **Note**: The `{ error: err as Error }` pattern (~90 instances in schedulers/index) was evaluated and left as-is — the `logger.error()` method has built-in `instanceof Error` handling that correctly extracts message and stack from these.

## [8.94.5] - 2026-03-20

### Kiosk Check-In Redesign
- **Redesigned**: Complete UI overhaul of `KioskCheckin.tsx` to match luxury hospitality aesthetic from reference designs.
- **Visual**: Replaced purple accent (#CCB8E4) with olive/sage color palette (OLIVE_ACCENT #8B9A6B, OLIVE_TEXT #C4CFA6, CREAM #E8E4D9). Added CARD_BG and CARD_BORDER constants.
- **Idle state**: Now shows "Arrival Protocol" label, "Welcome to Ever House" serif heading, corner-bracketed QR icon area with "Aligning Sensors" text, "Secure Link Active" badge, and olive-toned "Start Check-In" button.
- **Scanning state**: Shows "Present Your Key" heading with "Scanner Active" badge and corner-bracketed camera viewport.
- **Processing state**: Shows "Verifying Identity" label with "Confirming your arrival..." heading.
- **Success state**: Completely restructured to card-based grid layout — "Confirmed Access" header with "Welcome home, [Name]. Your sanctuary is prepared." heading, current time in PT, "Digital Identity" card with member name/tier/visits/verified badge, and booking detail cards (Session Time, Party Size, Accommodation, Status) when a booking exists. Payment CTA restyled.
- **Already checked in**: Refined to "Already Registered" / "Welcome back, [Name]" with amber-toned messaging.
- **Error state**: Refined to "Access Issue" / "Unable to verify" with "Please see the concierge" messaging.
- **Passcode modal**: Restyled with olive accents matching new palette.
- **Added**: `currentPacificTime` useMemo for arrival time display.
- All logic, state management, QR scanning, payment modal, and passcode flows preserved unchanged.
- Files changed: `src/pages/Staff/KioskCheckin.tsx`

## [8.94.4] - 2026-03-20

### Rename Wallet Button to Digital Wallet
- **Changed**: All user-facing "Add to Apple Wallet" button text renamed to "Add to Digital Wallet" across MembershipCard modal, ScheduleSection actions, and ExistingBookings buttons.
- **Changed**: Apple logo SVG replaced with generic Material Symbols `wallet` icon in MembershipCard and ExistingBookings wallet buttons.
- **Changed**: Toast messages after wallet pass download updated from "Apple Wallet" to "digital wallet" in MembershipCard, useDashboardData, useDashboardActions, and ExistingBookings.
- **Changed**: Removed `isAppleDevice` gate from wallet button eligibility in ScheduleSection so Android/non-Apple users can also see and download the `.pkpass` file. The `walletPassAvailable` admin setting check is preserved.
- **Changed**: All wallet button `aria-label` attributes updated to "Add to Digital Wallet".
- **Cleanup**: Removed `isAppleDevice` prop from `ScheduleSectionProps`, `ScheduleItemRowProps`, and the Dashboard index. Removed the `isAppleDevice` `useMemo` from `useDashboardData.ts`.
- Files changed: `src/pages/Member/Dashboard/MembershipCard.tsx`, `src/pages/Member/Dashboard/ScheduleSection.tsx`, `src/pages/Member/Dashboard/useDashboardData.ts`, `src/pages/Member/Dashboard/useDashboardActions.ts`, `src/pages/Member/Dashboard/index.tsx`, `src/pages/Member/BookGolf/ExistingBookings.tsx`

## [8.94.3] - 2026-03-20

### Tab Switch Glitch Fixes
- **Fixed**: `TabTransition` component rewritten to use `useLayoutEffect` with direct DOM style manipulation. The previous CSS-class approach (`useEffect` + `animate-tab-enter`) had a one-frame flash because `useEffect` runs after the browser paint — the new content was visible at full opacity for one frame before the animation class took effect. Now `useLayoutEffect` immediately sets `opacity: 0` and `translateY(4px)` before the paint, then uses `requestAnimationFrame` to transition to full visibility over 200ms. No CSS animation classes needed.
- **Fixed**: Moved `playerSlotRef` (auto-animate) from the outer tab content wrapper to an inner div wrapping only the `PlayerSlotEditor`. Previously auto-animate was on the parent div of all tab content, so when `PlayerSlotEditor` was conditionally removed on tab switch, auto-animate played a removal animation causing the player count selector to flash.
- **Fixed**: Removed redundant `animate-content-enter` / `animate-content-enter-delay-*` classes from inner wrappers inside `TabTransition` on BookGolf, Wellness, History, and AdminDashboard pages. These caused a second competing animation on top of the tab transition.
- **Fixed**: BookGolf tab switch no longer sets `selectedDateObj` to a new object reference when the selected date hasn't changed. Previously, switching tabs always reset the date state (even to the same value), triggering unnecessary re-renders and a brief availability section flash. Now uses functional state update to preserve object identity when the date is unchanged.
- **Improved**: Wellness ClassesView loading state now renders 4 `WellnessCardSkeleton` components instead of a full-page `PageLoadingSpinner`. This provides a content-shaped placeholder that matches the final layout, eliminating the jarring pop-in when data loads.
- **Fixed**: Staff hamburger menu on profile page now derives `activeTab` from the current route instead of hardcoding `"home"`. Previously, `StaffMobileSidebar` always received `activeTab="home"` in `App.tsx`, which made the Dashboard item appear highlighted on any page. The `navigateToTab` function also had `if (tab === activeTab) return;` which blocked the click since it thought Dashboard was already active. Now passes `pathToTab[location.pathname] ?? null`, and the guard accepts `null` to allow navigation from non-admin routes.
- Files changed: `src/components/motion/TabTransition.tsx`, `src/pages/Member/BookGolf/index.tsx`, `src/pages/Member/BookGolf/useBookGolf.ts`, `src/pages/Member/Wellness.tsx`, `src/pages/Member/History.tsx`, `src/pages/Admin/AdminDashboard.tsx`, `src/App.tsx`, `src/components/StaffMobileSidebar.tsx`

## [8.94.2] - 2026-03-20

### Page Scroll & Accordion UX Fixes
- **Fixed**: Page navigation scroll-to-top now fires after the page transition animation completes (after `displayLocation` updates), not during the exit animation. Previously, the scroll would fire immediately on pathname change while the old page was still visible, causing the scroll reset to get lost.
- **Fixed**: Opening an accordion item on FAQ, Cafe, What's On, Events, and Wellness pages now auto-scrolls the expanded item into view with smooth scrolling, ensuring the content is visible after expanding.
- **Fixed**: Added global `scroll-padding-top` using the `--header-offset` CSS variable so that scroll-to-element operations (including `scrollIntoView`) account for the fixed header height. Accordion items use `scroll-margin-top` to clear the header.
- **Fixed**: Removed `tactile-row` press animation from accordion items on FAQ, Cafe, and training guide (ContextualHelp) pages. The `:active` scale transform was triggering on touch-scroll, making it feel like buttons were being pressed when the user was just scrolling.
- Files changed: `src/App.tsx`, `src/index.css`, `src/pages/Public/FAQ.tsx`, `src/pages/Public/Cafe.tsx`, `src/pages/Public/WhatsOn.tsx`, `src/pages/Member/Events.tsx`, `src/pages/Member/Wellness.tsx`, `src/components/ContextualHelp.tsx`, `src/pages/Admin/tabs/BlocksTab/NoticeList.tsx`

## [8.94.1] - 2026-03-20

### Bug Fixes & Input Validation Hardening
- **Fixed**: NFC check-in now blocks `archived` members, matching kiosk check-in behavior. Previously archived members could bypass the block via NFC scan.
- **Fixed**: QR code parser now validates that member IDs are numeric before returning them. Non-numeric IDs from malformed QR codes now return `unknown` instead of causing 500 errors on the backend.
- **Fixed**: Terminal payment cancel endpoint now returns HTTP 409 (instead of 200) when the payment has already succeeded.
- **Fixed**: Payment retry endpoint now returns HTTP 422 (instead of 200) when a retry fails, so the frontend can properly detect and handle the failure.
- **Fixed**: Staff-assisted check-in (`approvalCheckin.ts`) now includes `archived` in blocked statuses, matching all other check-in paths.
- **Fixed**: Staff QR check-in (`/api/staff/qr-checkin`) now validates membership status before check-in. Previously it bypassed the status check entirely, allowing cancelled/suspended/archived members to be checked in via staff QR scan.
- **Fixed**: Trackman auto-match endpoint now returns proper HTTP status codes: 409 for already-linked events and race conditions, 404 when no matching booking is found (was returning 200 with `success: false`).
- **Fixed**: Frontend error catch blocks for staff QR check-in (SimulatorTab, StaffCommandCenter) and Trackman auto-match now display the actual server error message instead of a generic "Failed to process" toast.
- **Hardened**: Added Zod schema validation to cafe menu POST/PUT routes (`server/routes/cafe.ts`). Category and name are now required with min-length checks; price, sort_order, and booleans are type-validated.
- **Hardened**: Added Zod schema validation to membership tier POST/PUT routes (`server/routes/membershipTiers.ts`). Name, slug, and price_string are required on create; all fields are optional on update with proper type constraints.
- **Hardened**: Added Zod schema validation to kiosk check-in (`/api/kiosk/checkin`) and passcode verification (`/api/kiosk/verify-passcode`) routes (`server/routes/kioskCheckin.ts`).
- Files changed: `server/routes/nfcCheckin.ts`, `server/routes/cafe.ts`, `server/routes/membershipTiers.ts`, `server/routes/kioskCheckin.ts`, `server/routes/stripe/terminal.ts`, `server/routes/stripe/payment-admin.ts`, `src/utils/qrCodeParser.ts`, `server/core/bookingService/approvalCheckin.ts`, `server/routes/staffCheckin/directAdd.ts`, `server/routes/trackman/webhook-admin-ops.ts`, `src/pages/Admin/tabs/SimulatorTab/index.tsx`, `src/components/staff-command-center/StaffCommandCenter.tsx`, `src/components/staff-command-center/sections/TrackmanWebhookEventsSection.tsx`

## [8.93.0] - 2026-03-20

### Toast & Animation Consistency Pass
- **Improved**: Admin notification messages (sync results, tier saves, event updates, wellness updates, discount changes) now use the standard toast instead of inline banners that auto-dismiss
- **Improved**: Directory sync status messages now appear as toasts instead of a small inline label next to the Sync button
- **Improved**: Tier editor Stripe unlink confirmation now uses the standard toast
- **Improved**: All remaining public pages (Login, Day Pass, Private Hire, Privacy Policy, Terms of Service) and admin tabs (Tiers, Discounts, Announcements) now have smooth entry animations on load
- **Fixed**: Login page no longer flashes a blank white screen while redirecting an already-authenticated user — now shows the branded loading spinner
- **Fixed**: Landing page redirect screen now matches the site background color instead of showing a white flash
- **Fixed**: Booking a golf simulator was showing two confirmation messages at once (a toast and a floating banner) — now shows only the toast
- **Cleaned up**: Removed unused duplicate confirmation banner from the Wellness page that was leftover from an earlier design
- **Improved**: Updates page, NFC check-in screen, and auth callback page now have smooth entry animations matching the rest of the app
- Files changed: `src/pages/Admin/tabs/TiersTab/TierEditorDrawer.tsx`, `src/pages/Admin/tabs/TiersTab/index.tsx`, `src/pages/Admin/tabs/DiscountsSubTab.tsx`, `src/pages/Admin/tabs/DirectoryTab.tsx`, `src/pages/Admin/tabs/directory/useDirectoryData.ts`, `src/components/admin/AnnouncementManager.tsx`, `src/pages/Public/Login.tsx`, `src/pages/Public/Landing.tsx`, `src/pages/Public/PrivateHire.tsx`, `src/pages/Public/BuyDayPass.tsx`, `src/pages/Public/DayPassSuccess.tsx`, `src/pages/Public/PrivacyPolicy.tsx`, `src/pages/Public/TermsOfService.tsx`, `src/pages/Member/BookGolf/useBookGolf.ts`, `src/pages/Member/BookGolf/BookingFooter.tsx`, `src/pages/Member/BookGolf/index.tsx`, `src/pages/Member/Wellness.tsx`

## [8.92.0] - 2026-03-20

### Animation & Interaction Polish
- **Improved**: Auth guard routes (`ProtectedRoute`, `MemberPortalRoute`, `AdminProtectedRoute`) now render `<PageSkeleton>` instead of blank `<div className="min-h-screen" />` while `sessionChecked` is false
- **Improved**: `MembershipApply.tsx` — added `animate-page-enter` to wrapper, `animate-content-enter` to back link, `animate-content-enter-delay-1` to heading, `animate-content-enter-delay-2` to form card, `animate-content-enter` to success card; `tactile-btn` on back link
- **Improved**: `PrivateHireInquire.tsx` — same stagger pattern as MembershipApply
- **Improved**: `BookTour.tsx` — same stagger pattern; `tactile-btn` on back link; success card gets `animate-content-enter`
- **Improved**: `BugReportsAdmin.tsx` — added `animate-page-enter` to top-level wrapper for consistency with other admin pages
- **Improved**: `CafeTab.tsx` — Save and Cancel buttons upgraded with `tactile-btn` for press feedback
- **Improved**: `SettingsTab.tsx` — replaced custom `success` state + inline green banner + `setTimeout` pattern with standard `useToast('Settings saved successfully', 'success')` for consistency; wallet-pass push errors now also show toast
- Files changed: `src/App.tsx`, `src/pages/Public/MembershipApply.tsx`, `src/pages/Public/PrivateHireInquire.tsx`, `src/pages/Public/BookTour.tsx`, `src/pages/Admin/BugReportsAdmin.tsx`, `src/pages/Admin/tabs/CafeTab.tsx`, `src/pages/Admin/tabs/SettingsTab.tsx`

## [8.91.0] - 2026-03-20

### Kiosk Premium Redesign & Booking Card
- **Redesigned**: Full kiosk check-in screen premium overhaul — radial gradient background (lighter forest green center fading to near-black-green edges), lavender (#CCB8E4) accent throughout
- **New**: Dynamic time-of-day greeting on success screen using Pacific time (`getPacificGreeting()`) — "Good morning, Nick" / "Good afternoon, Nick" / "Good evening, Nick"
- **New**: Tier badge with subtle metallic outline and soft glow effect
- **New**: Glassmorphism booking details card on success screen when member has an upcoming booking today — shows resource name, time, player count
- **New**: Backend `POST /api/kiosk/checkin` now queries `booking_requests` for today's upcoming confirmed/approved bookings and returns `upcomingBooking` object (bookingId, sessionId, startTime, endTime, resourceName, resourceType, declaredPlayerCount, ownerEmail, ownerName, unpaidFeeCents)
- **New**: Pay Now button on booking card opens `MemberPaymentModal` for outstanding fees
- **New**: Success screen auto-reset extended to 25s when booking card is shown (vs 5s without); paused while payment modal is open
- **Improved**: Idle screen — ghost button (transparent bg, lavender border, white text) with `.tactile-btn` spring-physics interaction; ambient radial glow behind QR icon
- **Improved**: Passcode modal — glassmorphism card (semi-transparent dark bg, backdrop-blur-xl, thin border), lavender accent on focused/filled digit inputs, explicit Submit button instead of auto-submit on 4th digit, Enter key support
- **Improved**: `handlePasscodeDigitChange` stabilized — uses functional `setPasscodeDigits(prev => ...)` updater removing `passcodeDigits` from dependency array, no longer re-creates on every keystroke
- **Improved**: `handlePasscodeKeyDown` uses `passcodeDigitsRef` for current value, removing stale closure issue
- **Improved**: Header — mascot centered horizontally via `justify-center`, exit button absolutely positioned top-right
- **Improved**: Footer — script wordmark logo image (`/images/everclub-logo-light.webp`, h-5, opacity-15) replaces `<p>` "Ever Club" text
- **Fixed**: QR scanner freeze — replaced blind `setTimeout(() => startScanner(), 500)` with `requestAnimationFrame` DOM-ready loop that waits for the scanner container element to exist
- **Fixed**: Camera init timeout — 10s timeout with retry on failure; `handleScan` added to `startScanner` dependency array
- **Fixed**: Walk-in visit timezone (`server/routes/members/communications.ts`) — `wiv.created_at::date::text` and `TO_CHAR(wiv.created_at, ...)` now use `AT TIME ZONE 'America/Los_Angeles'` for correct Pacific time display on member history page
- **Fixed**: Page exit transition race condition in `useViewTransitionLocation` — rapid navigation (A→B→A before 150ms exit timer fires) left `isExiting=true` permanently, causing `.page-fade-out` (opacity:0, pointer-events:none) to stick. Fix: always clear timer on new location change, reset `isExiting` on same-route navigation, use `latestLocationRef` so timer callback resolves to most recent location instead of stale closure.
- **Fixed**: Landing page `scroll-reveal-group` class missing from `scrollRef` wrapper — sections revealed simultaneously instead of cascading with 60ms stagger delays
- **Fixed**: `.gpu-accelerated` utility had permanent `will-change: transform, opacity` — removed (class unused in codebase, but prevents accidental layer promotion)
- **Fixed**: Accordion child reveal (`accordionChildReveal`) lacked explicit reduced-motion override — now explicitly sets `animation: none; opacity: 1` for `.accordion-content` children when `prefers-reduced-motion: reduce`
- **Fixed**: `.page-fade-in` (used by `DirectionalPageTransition`) missing from reduced-motion overrides — page enter animation still played for users who prefer reduced motion
- **Fixed**: Infinite animations (`animate-badge-pulse`, `skeleton-shimmer`, `shimmer-effect`) lacked explicit reduced-motion `animation: none` — relied on global `animation-duration: 0.01ms` which is fragile
- **Fixed**: `animate-skeleton-out` and `holographic-shimmer` missing from reduced-motion opacity/transform reset — could leave elements invisible or offset for reduced-motion users
- Files changed: `src/pages/Staff/KioskCheckin.tsx`, `server/routes/kioskCheckin.ts`, `server/routes/members/communications.ts`, `src/App.tsx`, `src/pages/Public/Landing.tsx`, `src/index.css`

## [8.90.1] - 2026-03-20

### Stripe Price Sync & Booking Queue Refresh Fixes
- **Fixed**: "Sync to Stripe" button was silently pointing to deactivated prices — now detects inactive/missing prices and creates fresh replacements automatically
- **Fixed**: Duplicate Stripe prices created across days due to stale idempotency keys — keys are now unique per sync attempt
- **Fixed**: Booking queue items (cancellation-pending bookings) were not disappearing from admin list after Trackman webhook confirmation — cancellation events now trigger immediate data refresh instead of being delayed by debounce
- **Fixed**: Staff dashboard real-time connection reconnection now refreshes all booking data automatically (previously missed events during disconnection were permanently lost)
- **Fixed**: Day Pass (Coworking and Golf Sim) products were not checking if their Stripe price was still active — if deactivated externally, billing would silently fail; now detects and recreates
- **Fixed**: Group add-on (family billing) products had the same inactive-price blindspot — now validates and replaces inactive or missing prices during sync
- **Fixed**: Cafe item Stripe sync would crash if the product was archived or deleted externally — now auto-reactivates archived products and recreates deleted ones
- **Fixed**: Members trying to sign up with a stale or deactivated Stripe price would see a confusing "Failed to create checkout session" error — now shows a clear message that pricing is temporarily unavailable
- **Fixed**: 7 duplicate icon entries in icon registry causing build warnings
- **Key files**: `server/core/stripe/productSync.ts`, `server/core/stripe/productCreation.ts`, `server/core/stripe/productCatalogSync.ts`, `server/core/stripe/groupBillingCrud.ts`, `server/routes/checkout.ts`, `src/hooks/useStaffWebSocket.ts`, `src/components/icons/iconPaths.ts`

## [8.89.2] - 2026-03-19

### Calendar Sync Fix — Timestamp Precision
- **Fixed**: Wellness classes, events, and closures edited in the app were getting stuck in an infinite sync loop — caused by a timestamp precision mismatch (microsecond vs millisecond) that made the system think every record was re-edited during sync
- **Key files**: `server/core/calendar/sync/closures.ts`, `server/core/calendar/sync/events.ts`, `server/core/calendar/sync/wellness.ts`

## [8.89.1] - 2026-03-19

### Pull-to-Refresh — Production Overlay Fix & Android Scroll Fix
- **Fixed**: Pull-to-refresh green sheet overlay was invisible in production — inline `<style>` tags were blocked by the Content Security Policy
- **Fixed**: Moved all pull-to-refresh styles (pull bar, fill animation, refresh screen, dismiss animation) from inline style tags into the main stylesheet so they pass CSP
- **Fixed**: Android/Pixel users could only scroll pages by touching the header bar — pull-to-refresh was using a document-level non-passive touch listener that blocked native scroll optimization
- **Fixed**: Touch listeners now attach to the content container (not the whole document) and are fully passive — browser no longer waits for JavaScript before scrolling
- **Key files**: `src/components/PullToRefresh.tsx`, `src/index.css`

## [8.89.0] - 2026-03-19

### Inline SVG Icons & Pull-to-Refresh Fix
- **New**: All 241 icons migrated from Google Material Symbols font to inline SVGs via `<Icon name="..." />` component — icons render instantly without font loading, network requests, or font detection delays
- **Fixed**: PWA icons show immediately on home screen launch — no more invisible icons in offline/standalone mode
- **Fixed**: Pull-to-refresh shows the green sheet with walking golfer animation again — header stays solid while pulling
- **Removed**: Google Material Symbols font dependency completely eliminated — no CDN requests, no font preloading, no icon font CSS
- **Performance**: Icons are part of the DOM and render in the first paint — zero FOIT
- **Key files**: `src/components/icons/Icon.tsx`, `src/components/icons/iconPaths.ts` (241 icons), `index.html`

## [8.88.6] - 2026-03-19

### Critical RLS Fix — Overage Fee False Positives
- **Fixed**: Supabase had enabled Row-Level Security (RLS) with a `deny_all` policy on ALL 82 application tables, silently blocking every SELECT/INSERT/UPDATE from the application's database role
- **Impact**: `getTierLimits()` returned 0 daily minutes for all tiers → every member was charged overage fees ($50/hr) because the fee calculator fell back to defaults. Also caused Stripe product sync and Apple Wallet pass generation failures
- **Fix**: Added RLS disable + `deny_all` policy cleanup as the first step in `ensureDatabaseConstraints()` in `db-init.ts`
- **Also**: Added Stripe feature name update logic to `syncTierFeaturesToStripe()` to correct stale "/month" labels to "/year" for guest pass features
- **Key files**: `server/core/db-init.ts`, `server/core/stripe/syncTierFeatures.ts`

## [8.88.5] - 2026-03-19

### Code Review Fixes — DRY Violations, Dead Code & Duplicate Logic
- **Fixed**: Removed duplicate `handleTrialWillEnd` function left in `customers.ts` after the Task #179 file split — webhook dispatcher already imported from `subscriptions/trialWillEnd.ts`
- **Fixed**: Extracted 10 duplicated TypeScript interfaces from `AnalyticsTab.tsx` and `AnalyticsChartsSection.tsx` into shared `analyticsTypes.ts`
- **Removed**: Deleted orphaned `GlassRow.tsx` component (zero usages in codebase)
- **Key files**: `server/core/stripe/webhooks/customers.ts`, `src/pages/Admin/tabs/analytics/analyticsTypes.ts`

## [8.88.4] - 2026-03-19

### Performance — N+1 Query Batching, LIMIT Enforcement & Code Splitting
- **Performance**: Visit count sync refactored from 3 queries per member to 3 bulk SQL queries per batch (up to 90% fewer DB round-trips)
- **Performance**: Added LIMIT caps — inquiries 1000, announcements export 500, wellness classes 500
- **Performance**: QR scanner module (`html5-qrcode`) dynamically imported on modal open — reduced initial bundle size
- **Performance**: Analytics charts (`recharts`) lazy-loaded with `React.lazy()` — charting library only loads when viewing Analytics tab
- **Performance**: `MotionListItem` wrapped in `React.memo` to reduce unnecessary re-renders in list views
- **Key files**: `server/core/hubspot/visitSync.ts`, `src/components/staff-command-center/modals/CheckInModal.tsx`, `src/pages/Admin/tabs/AnalyticsTab.tsx`

## [8.88.3] - 2026-03-19

### Error Handling Consistency — Complete getErrorMessage() Adoption
- **Fixed**: 100+ catch blocks across 55+ files migrated from manual `String(err)` / `err instanceof Error ? err.message : String(err)` patterns to `getErrorMessage()` from `server/utils/errorUtils.ts`
- **Scope**: All 24 schedulers, rate limiting middleware, booking validation, calendar sync, Stripe product sync, HubSpot utilities, wallet pass services, and all route handlers
- **Cleanup**: Removed stale `eslint-disable` comments for `@typescript-eslint/no-explicit-any` after catch block type annotations changed from `any` to `unknown`

## [8.88.2] - 2026-03-19

### Skill & Documentation Sync (Phase 7 Code Review)
- **Documentation**: Audited all 8 domain skill files for accuracy — fixed stale file paths from directory splits across all 8 skills
- **Updated**: Scheduler-jobs skill now documents 29 logical schedulers across 26 files (was 28/25) — added Notification Cleanup scheduler
- **Fixed**: Version file drift — `src/config/version.ts` and `package.json` were stuck at `8.87.89`; all 4 version files now in sync
- **Updated**: README.md tech stack now includes Stripe, Drizzle ORM, Zustand, React Query, Apple Wallet, and Web Push

## [8.88.1] - 2026-03-19

### Data Integrity Architecture Hardening (Code Review Pass)
- **Hardened**: Database constraint violations from triggers (state machine, guest pass limits, etc.) now return structured 409 errors from all 41 fix/sync endpoints instead of generic 500s
- **Fixed**: Cross-system drift and HubSpot member sync checks now return stable, deterministic results — both were using random sampling
- **Hardened**: Guest pass hold limit trigger now also guards UPDATE operations (previously only INSERT)

## [8.88.0] - 2026-03-19

### Optimistic UI for Data Integrity Fixes
- **Improved**: Fixing an issue in the data integrity panel now removes it from the list instantly (on click), rather than waiting for the API call
- **Improved**: After a fix succeeds, the panel silently refreshes in the background — no more 'Running Checks...' banner after every fix
- **Fixed**: If a fix fails, the issue is restored to its original position (rollback)
- **Key files**: `src/pages/Admin/tabs/dataIntegrity/`

## [8.87.99] - 2026-03-19

### DB Integrity Hardening — State Machines, Guard Triggers & Dedup Indexes
- **New**: `trg_booking_status_machine` — DB-level enforcement of valid booking status transitions (terminal: attended, no_show, cancelled, declined, expired)
- **New**: `trg_membership_status_machine` — DB-level enforcement of valid membership status transitions (terminal: archived, merged)
- **New**: Guest pass over-consumption prevention at DB level — concurrent holds cannot exceed allocation
- **New**: `trg_prevent_archived_*` (5 tables) — blocks inserts for archived members on bookings, RSVPs, wellness, guest pass holds, push subscriptions
- **New**: `trg_guard_stale_pending` — prevents approving bookings >2hr past start
- **New**: `trg_guard_attended_unpaid` — blocks attended transition with unpaid fee snapshots
- **New**: `trg_cleanup_fee_on_terminal` — auto-cancels fee snapshots on terminal booking status
- **New**: `trg_auto_expire_stale_tours` — marks stale tours as no_show
- **New**: Dedup indexes — `idx_users_email_stripe_unique`, `idx_bookings_invoice_unique`
- **Escape hatch**: `current_setting('app.bypass_status_check', true)` for data migration/repair
- **Key files**: `server/core/db-init.ts`, migration `0057`

## [8.87.98] - 2026-03-19

### Scheduler Reliability, Sync Race Conditions & HubSpot Safety
- **Fixed**: Events and wellness calendar sync now use optimistic locking during push-back — edits during sync no longer silently lost
- **Fixed**: Google Calendar events no longer retain stale extended properties when optional fields are removed
- **Fixed**: 6 additional schedulers use hour-range window instead of exact-hour matching to prevent missed runs from timer drift
- **Fixed**: Duplicate cleanup scheduler clears last-run memory on failure for retry
- **Fixed**: HubSpot `syncMemberToHubSpot` now restores lifecycle stage if contact update fails after clearing it
- **Fixed**: HubSpot day pass sync restores lifecycle stage on failure
- **Fixed**: Stripe 'unpaid' status now consistently maps to 'suspended' across all sync paths
- **Improved**: WebSocket token endpoint now rate-limited

## [8.87.97] - 2026-03-19

### Calendar Sync Hardening & Extended Property Fixes
- **Fixed**: Google Calendar extended properties properly removed when no longer relevant — previously left as empty values
- **Fixed**: Concurrent edits during calendar push-back detected via optimistic locking
- **Fixed**: Closure push-back stores Google Calendar response timestamp after updating

## [8.87.96] - 2026-03-19

### Bug Fixes: Stripe Status, HubSpot Safety, Scheduler Reliability & Security
- **Fixed**: Members with expired incomplete Stripe subscriptions now correctly marked inactive
- **Fixed**: HubSpot contact lifecycle stage restored on failed tier sync update
- **Fixed**: Daily scheduled tasks use date-based window instead of exact hour matching
- **Fixed**: Onboarding nudge scheduler alerts staff on error instead of failing silently
- **Improved**: Password change endpoint now rate-limited

## [8.87.95] - 2026-03-19

### Security: WebSocket Mobile Auth & Rate Limiter Hardening
- **Fixed**: Mobile staff clients can now connect to real-time updates without cookies — WebSocket auth uses short-lived signed token via authenticated HTTP request
- **Fixed**: Rate limiter key generators use strict type coercion to prevent crashes from malformed inputs

## [8.87.94] - 2026-03-19

### Guest Passes Now Reset Annually & Critical Bug Fixes
- **Changed**: Guest passes reset annually (January 1st) instead of monthly
- **Fixed**: Membership tiers page failing to load due to database column mismatch
- **Fixed**: Removed leftover RLS policies from previous migration
- **Key files**: `server/core/guestPassService.ts`, `server/schedulers/guestPassResetScheduler.ts`

## [8.87.93] - 2026-03-19

### Audit Fixes: Fee Snapshot Tracking & Integrity Check Improvements
- **New**: Added `updated_at` column to `booking_fee_snapshots` table
- **Fixed**: All 30 fee snapshot UPDATE paths now consistently set `updated_at = NOW()`
- **Improved**: Dev-environment integrity check results prefixed with `[DEV]` to prevent confusion with production
- **Key files**: `server/core/billing/unifiedFeeService.ts`, `server/core/integrity/`

## [8.87.92] - 2026-03-18

### Fix: Booking Owner Change Now Updates Details Immediately
- **Fixed**: Changing a booking's owner now refreshes the booking header, owner name/email, and payment sections immediately — previously only the player roster updated
- **Root cause**: `handleReassignOwner` only called `fetchRosterData()` but not the booking context re-fetch
- **Fix**: Extracted `refetchBookingContext()`, called in parallel with roster refresh after reassign, added `onRosterUpdated()` callback + `booking-action-completed` event dispatch
- **Also**: WebSocket `booking_updated` broadcast from server reassign endpoint for real-time cross-screen updates
- **Key files**: `src/components/staff-command-center/modals/useUnifiedBookingLogic.ts`, `server/routes/trackman/admin-resolution.ts`

## [8.87.91] - 2026-03-18

### Fix: Session Creation Timeout During Trackman Webhook Processing
- **Fixed**: Session creation no longer fails with statement timeouts when multiple Trackman webhooks arrive simultaneously — replaced blocking advisory lock with non-blocking retry pattern (`pg_try_advisory_lock` with up to 6 retries, 3s total)
- **Improved**: Explicit 15-second statement timeout set during session creation

## [8.87.90] - 2026-03-18

### Fix: Bookings Queue Now Updates Instantly After Trackman Auto-Confirm
- **Fixed**: Pending booking requests now disappear from the queue immediately when Trackman webhooks auto-confirm — previously UI didn't refresh due to notification data mismatch
- **Fixed**: Member dashboard refreshes booking status in real-time on Trackman confirmation
- **Improved**: Staff navigation badge count updates instantly on auto-confirmation

## [8.87.89] - 2026-03-18

### Fix: Stripe Reconnect Now Succeeds When Customer Has No Subscription
- **Fixed**: Reconnecting a member to Stripe now correctly reports success for customer-only restoration (no active subscription)
- **Fixed**: Stripe reconnect creates a new Stripe customer when none exists
- **Improved**: Bulk reconnect shows fully reconnected vs customer-only restored counts

## [8.87.88] - 2026-03-18

### Architectural Audit: Security & Reliability Hardening
- **Fixed**: HubSpot webhook now processes events before responding — failed processing will be retried by HubSpot
- **Fixed**: Fee snapshot reconciliation scheduler prevents overlapping runs during startup
- **Fixed**: Booking roster input validation rejects invalid IDs before processing
- **Hardened**: Stripe error detection in invoice service uses type-safe property checks
- **Security**: Auth middleware added to booking conflict checks, participant lists, and fee preview endpoints
- **Security**: RSVP endpoint uses standard auth middleware
- **Improved**: Cafe menu and FAQ queries include safety limits

## [8.87.87] - 2026-03-18

### Fix: WebSocket Reconnection Loop & Stripe Invoice Resilience
- **Fixed**: WebSocket connections no longer stuck in infinite reconnect loop on session expiry
- **Fixed**: WebSocket reconnection correctly resumes after user/view transitions
- **Fixed**: Stripe invoice creation gracefully handles stale price IDs — falls back to custom-amount line items
- **Hardened**: Stale-price detection uses structured error codes (`resource_missing`)
- **Improved**: WebSocket auth failure logging upgraded from debug to warn

## [8.87.85] - 2026-03-18

### Fix: Group Member Validation
- **Fixed**: Adding sub-members to a family group now validates required fields before proceeding to Review/Payment
- **Improved**: Sub-member form shows red error highlighting and asterisks on required fields

## [8.87.84] - 2026-03-18

### Fix: Stripe Name Sync & Orphaned Customer ID Cleanup
- **Fixed**: Member names no longer overwritten with email addresses from Stripe `customer.updated` webhooks
- **Fixed**: Orphaned Stripe customer IDs now auto-relinked by searching Stripe for matching email

## [8.87.82] - 2026-03-18

### Fix: Audit Log Crash & Startup DB Connection Exhaustion
- **Fixed**: Staff actions no longer crash with 'Cannot read properties of undefined' — audit logging function returns a promise correctly
- **Fixed**: Server startup no longer exhausts connection pool — Stripe product init tasks run sequentially instead of concurrently
- **Fixed**: Customer sync and corporate pricing pull run sequentially after product setup

## [8.87.81] - 2026-03-18

### Fix: WebSocket Auth Loop & Stripe Overage Billing
- **Fixed**: WebSocket clients properly stop reconnecting on auth failure (close code 4002)
- **Fixed**: Overage/guest fee billing no longer fails with deleted Stripe price IDs — validates on startup and auto-recreates

## [8.87.80] - 2026-03-18

### Fix: WebSocket Reconnection Loop Flooding Logs
- **Fixed**: WebSocket connections with expired sessions no longer spam logs — server immediately closes with 'session invalid' signal
- **Fixed**: App stops WebSocket reconnection on session expiry instead of retrying every 12 seconds
- **Improved**: WebSocket auth warnings downgraded to debug-level

## [8.87.79] - 2026-03-18

### Fix: Cafe Delete Flow, Tier Safety & Dead Code Cleanup
- **Fixed**: Deleted cafe menu items no longer reappear on 'Pull from Stripe' — sync respects locally-deleted items
- **Fixed**: Unrecognized tier names log clear errors instead of silently downgrading to Social
- **Fixed**: 'Seed Cafe' button works after all items deleted — no longer counts soft-deleted items
- **Removed**: Unused auto-seed cafe menu code

## [8.87.78] - 2026-03-18

### Fix: Facility Notices & Onboarding Checklist Persistence
- **Fixed**: Notice dismissals now persisted to database (`user_dismissed_notices` table) via `POST /api/notices/dismiss` — previously localStorage-only
- **Fixed**: OnboardingChecklist concierge step: API call fires BEFORE VCF download — iOS Contacts dialog no longer interrupts completion
- **Key files**: `src/components/ClosureAlert.tsx`, `server/routes/notices.ts`

## [8.87.77] - 2026-03-18

### Fix: Orphaned Payment Intent & Fee Snapshot Cleanup
- **Fixed**: `cancelPendingPaymentIntentsForBooking` now cancels fee snapshots with NULL `stripe_payment_intent_id`
- **Fixed**: Removed invalid `updated_at` column references
- **Cleaned**: 2 lingering Stripe PIs and 43 stale fee snapshots from cancelled bookings
- **Key files**: `server/core/billing/paymentIntentCleanup.ts`

## [8.87.76] - 2026-03-18

### Migrate Raw fetch() to apiRequest
- **Migrated**: 5 raw `fetch()` calls in `useBookingActions.ts` to `apiRequest`
- **Migrated**: 4 wallet pass downloads to `apiRequestBlob`
- **Migrated**: Hand-rolled retry in `EventsTab.tsx` sync mutation to `apiRequest`
- **Remaining**: Raw `fetch()` intentionally kept for React Query queryFn callbacks, file uploads, auth session check, error reporting

## [8.87.75] - 2026-03-18

### Fix: Remove Invalid .catch() on Synchronous sendNotificationToUser
- **Fixed**: Removed all `.catch()` chains from `sendNotificationToUser` calls across 22 server files — function is synchronous, `.catch()` would throw TypeError
- **Reverts**: v8.87.74 `.catch()` additions on the same function

## [8.87.74] - 2026-03-18

### Fix: Unhandled Async Error Boundaries
- **Fixed**: Added `.catch()` to 2 `notifyLinkedMembers`/`notifyApprovalParticipants` calls in `approvalFlow.ts`
- **Fixed**: Added `.catch()` to 2 `logFromRequest` calls in `admin-resolution.ts`
- **Note**: `sendNotificationToUser` `.catch()` additions reverted in v8.87.75

## [8.87.73] - 2026-03-18

### Security Hardening: SQL Injection Prevention & Privacy
- **Fixed**: Replaced 7 `sql.raw(ARRAY[...])` patterns with parameterized arrays across Trackman webhook handlers, `trackmanRescan.ts`, and `reconciliation.ts`
- **Fixed**: Added allowlist validation guards on all DDL `sql.raw()` calls in `db-init.ts`
- **Fixed**: Removed `memberEmail` and `cardLast4` from log output in `invoices.ts` and `saved-cards.ts`
- **Fixed**: Added `shlex` escaping to Python diagnostic scripts

## [8.87.72] - 2026-03-18

### Fix: Database Connection Stability on Supabase
- **Fixed**: Supabase session pooler returning connections with empty `search_path`, causing intermittent "relation does not exist" errors
- **Fix**: Appends `-c search_path=public` to connection string options — set synchronously at connection startup
- **Key files**: `server/core/db.ts` (both `pool` and `directPool`)

## [8.87.71] - 2026-03-18

### Bug Fixes: Cafe Soft Delete & Tier Sync Consistency
- **Fixed**: Cafe item deletion now deactivates instead of permanently removing — preserves POS transaction history
- **Fixed**: All 13 tier update paths keep tier name and tier ID in sync
- **Fixed**: Tier ID lookup queries database instead of hardcoded map

## [8.87.70] - 2026-03-18

### Fix: Corporate Volume Pricing Startup Error
- **Fixed**: Corporate Volume Pricing product init failing on startup due to stale Stripe idempotency key
- **Improved**: Product creation searches Stripe for existing products before attempting to create

## [8.87.69] - 2026-03-18

### Bug Fixes: Cafe Admin, Route Validation & Tier Sync Safety
- **Fixed**: Cafe admin tab shows inactive items (greyed out with badge) for reactivation
- **Fixed**: Cafe route IDs validated as numbers — non-numeric IDs return 400
- **Fixed**: Deleting non-existent cafe item returns 404
- **Fixed**: Tier sync explicitly skips non-subscription product types
- **Fixed**: Cafe admin errors show toast notifications

## [8.87.68] - 2026-03-18

### Fix: Wellness Calendar Sync — Missing recurring_event_id Column
- **Fixed**: Added `recurring_event_id` column to `wellness_classes` schema and db-init migration
- **Key files**: `shared/schema.ts`, `server/core/db-init.ts`

## [8.87.67] - 2026-03-18

### Accessibility: Facebook Pixel Alt Text & Thin Content Investigation
- **Fixed**: Added empty alt attribute to Facebook pixel noscript tracker image (WCAG)
- **Investigated**: Thin content warnings on 15 pages confirmed as SPA false positives

## [8.87.66] - 2026-03-18

### Security: Tightened Content Security Policy (CSP) Headers
- **Removed**: `unsafe-eval` from `script-src` CSP directive
- **Removed**: `unsafe-inline` from `script-src` — replaced with per-request cryptographic nonces
- **Added**: Nonce-based CSP for inline scripts — unique nonce per HTML response
- **Retained**: `unsafe-inline` in `style-src` (required by React inline styles and third-party widget CSS)
- **Key files**: `server/index.ts`

## [8.87.65] - 2026-03-18

### Performance: LCP Preload Hints & Critical Request Chain Optimization
- **Improved**: Server sends HTTP `Link` header with preload hints for LCP hero image, main CSS bundle, and font preconnects
- **Improved**: Main CSS stylesheet preloaded via Link header
- **Added**: `dns-prefetch` fallbacks for Google Fonts domains

## [8.87.64] - 2026-03-18

### SEO: Extended Meta Descriptions for Privacy & Terms Pages
- **Improved**: Privacy policy meta description extended to 145 characters (was 93)
- **Improved**: Terms of service meta description extended to 139 characters (was 89)

## [8.87.63] - 2026-03-18

### Accessibility Audit & SEO Canonical/OG URL Fixes
- **Verified**: All public pages wrapped in `<main id="main-content">` via global layout
- **Verified**: Skip-to-content link present on all pages (WCAG 2.4.1)
- **Fixed**: `og:url` correctly updated on all pages including fallback routes
- **Fixed**: Canonical tag replaced instead of duplicated
- **Fixed**: Tour page route alignment — SEO meta, JSON-LD, breadcrumbs, and internal links all use `/tour`

## [8.87.62] - 2026-03-18

### Dev Environment Stability & Complete Database Schema Sync
- **Fixed**: Created 7 missing tables, added 36 missing columns across 11 tables
- **Fixed**: Login, rate limiting, staff portal, and all major API endpoints working in dev
- **Improved**: Stripe initialization completes cleanly with all products and pricing ready
- **Key files**: `server/core/db-init.ts`

## [8.87.61] - 2026-03-17

### Wallet Booking Pass Voids — Bulk Cancellation Coverage
- **Fixed**: Trackman conflict-cancellation blocks in `webhook-billing.ts` now void wallet passes
- **Fixed**: Member archive in `admin-actions.ts` now voids passes for bulk-cancelled bookings (`RETURNING id` + loop)
- **Key files**: `server/core/stripe/webhooks/webhook-billing.ts`, `server/routes/admin-actions.ts`

## [8.87.60] - 2026-03-17

### Apple Wallet Pass — Complete Lifecycle Coverage
- **New**: 15 files now call wallet pass update/void covering: tier changes, subscription status changes, sub-member propagation, checkout activation, group billing, profile name changes, guest pass use/refund/reset, grace period termination, archival, and reconciliation
- **Fixed**: Booking pass void added to `cancellation_pending` in both staff and member paths with self-healing retry
- **Fixed**: Resource type hardcoded as 'simulator' in staff manual bookings → now dynamic

## [8.87.59] - 2026-03-17

### Codebase Audit — Security & Reliability
- **Security**: Added `parseInt` radix parameter and NaN validation guards across 15+ route files — invalid numeric IDs now return 400 instead of causing server errors
- **Security**: Auth rate limiting added to 5 authentication endpoints (password login, verify-member, request-otp, verify-otp, passkey) to prevent brute-force attacks
- **Reliability**: All fire-and-forget promises now have `.catch()` handlers — background operations no longer silently swallow errors
- **Reliability**: JSON.parse calls in integrity checks now wrapped in try/catch guards
- **Code Quality**: Split 9 oversized route files, 6 service files, and 7 frontend files into focused submodules
- **Code Quality**: `webhook-handlers.ts` (1815 lines) split into `webhook-modification.ts`, `webhook-matching.ts`, `webhook-update.ts` with thin barrel re-export
- **Code Quality**: `approvalService.ts` split into `approvalApprove.ts`, `approvalCancel.ts`, `approvalCompletion.ts`, `approvalFlow.ts`
- **Code Quality**: Dead approval module duplicates removed
- **Code Quality**: Frontend raw `fetch()` calls migrated to centralized `apiRequest` utility with new `apiRequestBlob` and `fireAndForgetRequest` helpers

## [8.87.58] - 2026-03-17

### Visitor Tier Protection — Complete Auth Fix
- **Fixed**: All five login flows (password, magic link, passkey, Google, Apple) now correctly detect visitor accounts and return null tier — visitors were incorrectly defaulting to 'member' role which triggered tier normalization to 'Social'
- **Fixed**: User record upsert during login no longer overwrites visitor tier with 'Social'
- **Files**: All auth route handlers (`password-login.ts`, `magic-link.ts`, `passkey.ts`, `google-auth.ts`, `apple-auth.ts`)

## [8.87.57] - 2026-03-17

### Simplify Connection Banner — Offline Only
- **Removed**: `useRealtimeHealth` hook and global WebSocket signal bridge (`window.__staffWsConnected` + custom event) — no longer needed
- **Changed**: Connection banner now only shows for full offline state ('You're offline') — removed reconnecting/degraded states since the profile icon's colored dot already indicates connection health
- **Files**: Connection banner component, staff WebSocket hook

## [8.87.56] - 2026-03-17

### Dead Code Cleanup — React Query Migration Leftovers
- **Removed**: ~48 unused React Query hooks — `useAdminQueries` (26 hooks including `useStaffActivity`), `useMemberPageQueries` (16 hooks), `useBookingsQueries` (12 hooks), plus 1 each from financials and cafe query files
- **Removed**: Orphaned query key definitions (notices, announcements, changelog, updates, groupBilling, trackmanWebhookEvents, dayPassProducts, availabilityBlocks, transactions, memberDirectory) from `adminTabKeys`
- **Reduced**: Bundle size reduction from removing dead mutation/query code and unused interface definitions

## [8.87.55] - 2026-03-17

### Fix Notification Mark Read & Dismiss Buttons
- **Fixed**: 'Mark all as read' and 'Dismiss all' notification buttons now work — React Query migration changed these to POST requests but server requires PUT and DELETE respectively, causing silent 404 errors

## [8.87.54] - 2026-03-17

### Error Handling Polish & Dead Code Cleanup
- **Fixed**: Day pass refund errors now show specific server error codes instead of generic 'network error'
- **Fixed**: Session expiration (401) and payment requirement (402) detection now uses HTTP status codes instead of fragile string-matching on error messages — affects training guide, availability blocks, and member booking pages
- **Fixed**: Group billing 'no group found' detection simplified to direct status code check
- **Cleaned up**: Removed unused error utility imports from Group Billing and Tier Change pages (data fetching migration leftovers)

## [8.87.53] - 2026-03-17

### Data Fetching Stability Fixes
- **Fixed**: Empty response handling — operations like deleting items or confirming payments no longer crash when server returns empty response body
- **Fixed**: Group billing page now correctly detects when a member has no billing group via status code check
- **Fixed**: Billing page now invalidates all balance and migration queries after payments, credits, or subscription changes
- **Fixed**: Day pass redemption errors now surface detailed info (pass holder, usage counts) instead of generic 'network error'

## [8.87.52] - 2026-03-17

### Startup Reliability & Trackman Billing Fixes
- **Fixed**: Server startup no longer fails on first deploy — app now awaits database connection readiness before running initialization tasks
- **Improved**: Consolidated scattered startup database queries into a single orchestrated startup sequence
- **Fixed**: Trackman-imported sessions no longer auto-waive member fees — real members and named guests keep 'pending' payment status for proper overage/guest fee billing. Only ghost/placeholder participants are waived
- **Fixed**: Fee recalculation now runs after every Trackman import path (CSV upload, webhook linking, placeholder merging)
- **Fixed**: Waiver verification is now fail-closed — if waiver status check fails, members see a blocking screen instead of bypass
- **Fixed**: 8 server TypeScript compilation errors across startup, HubSpot webhooks, Trackman status handling, and data integrity checks
- **Fixed**: 2 failing payment intent cleanup tests — assertions now match actual cancellation behavior

## [8.87.51] - 2026-03-17

### Deployment Migration Fix
- **Fixed**: Deployment no longer fails with foreign key constraint errors — all missing database constraints now have proper migration files that clean up orphaned data before adding constraints

## [8.87.50] - 2026-03-16

### Deployment Reliability Fix
- **Fixed**: Build step now automatically registers all existing database migrations so the platform doesn't try to re-apply them from scratch during deployment

## [8.87.49] - 2026-03-16

### Bug Fixes & Performance
- **Fixed**: Removed unnecessary API calls on public pages (login, membership) — eliminates wasted server requests and console errors for unauthenticated visitors
- **Fixed**: Page pre-loading now properly cleans up when navigating away (memory leak prevention)
- **Fixed**: Switching accounts now properly refreshes pre-loaded page data instead of showing stale content
- **Fixed**: Profile page scroll-to-passkeys timer now properly cleans up on unmount
- **Fixed**: Deployment migration error for Trackman booking references — orphaned data cleaned up before adding database constraint

## [8.87.47] - 2026-03-16

### Code Quality & Accessibility Improvements
- **Improved**: Replaced all hardcoded z-index values with the centralized z-index scale — splash screen and navigation overlay now use consistent values instead of magic numbers
- **Improved**: Migrated all 31 components from the aggregated useData() hook to specific context hooks (useAuthData, useMemberData, etc.) — reduces unnecessary re-renders across the app
- **Improved**: Added aria-expanded attributes to 10+ expandable sections across admin panels, settings, and data integrity views — better screen reader support for collapsible content

## [8.87.46] - 2026-03-16

### Recent Playing Partners in Booking Flow
- **New**: When adding players to a booking, your most frequent playing partners now appear as quick-tap chips — no more searching for the same people every time
- **New**: Recent partners are automatically built from your booking history, showing both members and guests you've played with most often
- **Improved**: Tapping a recent partner auto-fills the player slot with their info — members are selected instantly, guests have their name and email pre-filled
- **Privacy**: Partners who have opted out of the directory or data sharing are excluded from suggestions, and guest suggestions are limited to your own invited guests only

## [8.87.45] - 2026-03-16

### Calendar Sync Reliability & Cross-Environment Fix
- **Fixed**: Calendar extended properties (image URLs, categories, metadata) are now visible across all environments — previously, data written by one environment was invisible to others due to Google Calendar's private property scoping
- **Fixed**: Wellness class and event calendar syncs now automatically retry when hitting Google Calendar rate limits instead of silently failing — previously, batches of updates could be lost during busy sync cycles
- **Improved**: All Google Calendar API calls across the sync system (wellness, events, closures, and conference room) now have consistent retry-with-backoff protection

## [8.87.44] - 2026-03-16

### Membership Trends & Former Members Fix
- **Fixed**: The 'Former Members' line in the membership trends chart was always showing 0 — it now correctly displays members who have left the club over time
- **Improved**: Member status changes are now tracked with accurate dates across every possible path in the system (37+ code paths including all Stripe webhooks, admin actions, group billing, reconciliation, user merges, and more) — ensuring the membership analytics stay accurate going forward
- **Fixed**: Manual directory sync (focused sync) was returning zero contacts due to a timing bug — it now correctly picks up recent changes from HubSpot
- **Improved**: For MindBody-billed members, status change dates now use HubSpot's actual change date instead of the sync time, giving more accurate membership history

## [8.87.42] - 2026-03-15

### Declined Booking Payment Cleanup & Broader Monitoring
- **Fixed**: Declining a booking request now cancels all pending Stripe payment intents via the centralized cleanup — previously only payment intents linked to fee snapshots were cancelled, so standalone payment intents could be orphaned
- **Improved**: The payment intent monitoring check now covers all terminal booking statuses (cancelled, declined, denied, expired) — previously only cancelled bookings were monitored, meaning lingering charges on declined or expired bookings could go unnoticed

## [8.87.41] - 2026-03-15

### Resource Booking Payment Cleanup Fix
- **Fixed**: Cancelling a resource booking (conference rooms) now properly cancels any pending Stripe payment intents — previously only the database records were marked cancelled while the actual Stripe charges remained open, potentially resulting in unexpected charges
- **Fixed**: Fee snapshot status updates during resource booking cancellation no longer incorrectly mark already-collected payments as cancelled — succeeded payments are now handled through the proper refund flow

## [8.87.40] - 2026-03-15

### App Update Screen Fix & Error Logging Improvements
- **Fixed**: "App Update Required" screen now properly clears cached data on iOS — previously the Clear Cache button could fail to refresh the app on iPhones, requiring manual steps to recover
- **Improved**: Better error visibility when background systems encounter temporary issues, helping staff diagnose problems faster

## [8.87.39] - 2026-03-15

### Notification Delivery Fix — Cancellations & Booking Confirmations
- **Fixed**: Members now receive real-time push notifications and in-app notification panel updates when their cancellation request is submitted — previously only a database record was created, so members had to refresh to see the update
- **Fixed**: Booking confirmation notifications from staff actions now use the unified notification service, ensuring consistent delivery across all three channels (database, real-time panel, and push)
- **Fixed**: Assign-with-players booking confirmations now deliver push notifications — previously only database and WebSocket were triggered

## [8.87.38] - 2026-03-15

### Dashboard Cache Consistency Fix
- **Fixed**: Booking form, profile page, and prefetch now use the new split dashboard query keys — previously stale query keys meant data updates from these pages wouldn't refresh the dashboard
- **Fixed**: Optimistic booking request updates on the Book Golf page now correctly target the split booking-requests query instead of the old monolithic dashboard data
- **Fixed**: Cancelling a booking from the Book Golf page now immediately refreshes the dashboard — previously the dashboard could show stale data for up to 5 minutes
- **Fixed**: RSVPing or cancelling an RSVP from the Events page now immediately refreshes the dashboard RSVP section
- **Fixed**: Enrolling or cancelling a wellness class now immediately refreshes the dashboard wellness section
- **Improved**: Dashboard prefetch now loads bookings, booking requests, and member stats independently for faster initial page load

## [8.87.37] - 2026-03-15

### Bug Fixes — Cleanup, Auth & Staff Roster Safety
- **Fixed**: Abandoned pending user cleanup now correctly deletes notifications, push subscriptions, dismissed notices, and magic links — previously referenced wrong column names and non-existent tables, causing cleanup failures
- **Fixed**: HubSpot contact data lookups during login now safely handle missing contact properties — previously could crash if HubSpot returned incomplete data
- **Fixed**: Staff roster management views no longer crash when roster data is temporarily unavailable during loading
- **Fixed**: Group billing display no longer crashes when family group data is loading
- **Fixed**: Invoice line item display now safely handles missing line data from Stripe

## [8.87.36] - 2026-03-15

### Dashboard Performance Overhaul & Deadlock Prevention
- **Improvement**: Dashboard now loads up to 6x faster — your bookings, events, wellness, and stats all load independently instead of waiting for one big request
- **Improvement**: If one section of your dashboard has an issue, the rest still loads normally — no more blank dashboard from a single data hiccup
- **Fixed**: Booking creation no longer risks freezing when two members book the same bay at the exact same moment — lock acquisition is now ordered to prevent deadlocks
- **Fixed**: Resolved 30 TypeScript compilation errors across the server codebase for Stripe SDK v20 compatibility — payment and invoice handling now uses correct type patterns
- **Fixed**: Added missing audit action types for stale visitor cleanup and contact info updates
- **Fixed**: Booking cancellation tests now correctly mock notification service, transaction sequences, and cancellation source flows — all 10 booking state tests passing

## [8.87.35] - 2026-03-15

### Financial Safety, Booking Cleanup & Payment Reliability Fixes
- **Fixed**: Staff and webhook-initiated booking cancellations now properly release simulator bay slots — previously only member-initiated cancellations cleaned up availability
- **Fixed**: Declining a multi-slot booking now releases all time slots instead of only the first one
- **Fixed**: Payment cleanup on page navigation now reliably completes even if the browser is closing the tab
- **Fixed**: If a refund succeeds but the local record update fails, the system now flags the record for reconciliation instead of silently losing track
- **Fixed**: Failed cancellation side effects (refunds, calendar cleanup) are now tracked in a recovery table for staff resolution instead of being silently lost
- **Fixed**: Non-booking payments (merchandise, cafe) now use unique transaction keys to prevent false duplicate detection
- **Fixed**: Invoice-based payments now store the actual Stripe payment ID instead of a fabricated identifier
- **Fixed**: Guest pass holds are no longer released prematurely if the booking deletion fails partway through
- **Fixed**: Payment record user IDs are now stored correctly in all payment flows

## [8.87.34] - 2026-03-15

### Critical Financial & Checkout Bug Fixes
- **Fixed**: Partial refunds no longer crash when a previous partial refund was already issued — the system now refunds only the remaining balance instead of attempting the full original amount
- **Fixed**: Guest pass refunds during booking cancellation no longer deadlock when running inside an existing transaction
- **Fixed**: If a payment succeeds but the booking status update fails, the system now marks the payment as 'requires reconciliation' instead of incorrectly showing it as fully succeeded
- **Fixed**: Returning from 3D Secure bank verification now properly completes the payment — previously the success wasn't detected after the redirect back to the app
- **Fixed**: Cancellation rollback errors are now properly awaited instead of running as detached promises, preventing silent failures

## [8.87.33] - 2026-03-15

### HubSpot Tour Scheduler Integration & Stripe Payment Fixes
- **New**: Tour bookings from the app now automatically create a meeting in HubSpot, triggering HubSpot's confirmation and reminder emails — no more duplicate emails from the app
- **New**: Admin Settings now has a 'HubSpot Tour Scheduler' section to configure the meeting scheduler URL used for tour bookings
- **Improved**: Removed redundant Google Calendar event creation, staff notifications, and confirmation emails from tour booking — HubSpot handles all of these automatically
- **Removed**: 'Tour Request' form ID from HubSpot Form IDs settings (tours use HubSpot meeting scheduler, not forms)
- **Fixed**: iOS Safari rendering issue with Stripe payment forms in modals — CSS transform/animation interference now prevented
- **Fixed**: POS invoice settlement now correctly detects standalone terminal payments by checking both metadata keys
- **Fixed**: Card vaulting now properly saves payment methods for future billing via setup_future_usage
- **Fixed**: Stripe payment form cleanup now always runs on unmount, preventing orphaned payment intents in React StrictMode

## [8.87.32] - 2026-03-15

### Bug Audit — Notification & Wallet Pass Fixes
- **Fixed**: Members are now properly notified when Trackman cancels a conflicting booking — notifications were silently failing due to a mismatched function call format in both the webhook and reprocess paths
- **Fixed**: Apple Wallet pass generation no longer crashes when adding your membership card — a missing membership status field has been added
- **Fixed**: Staff linking a member to a booking now correctly records the booking ID in the notification — previously passed as text instead of a number
- **Fixed**: Booking approval notifications now properly skip when the approval message is unavailable, preventing empty notification delivery

## [8.87.31] - 2026-03-15

### Deep Code Audit — Race Condition & Logic Bug Fixes
- **Fixed**: Payment cancellation job now uses the cancelPaymentIntent helper instead of calling Stripe directly — if a payment races to 'succeeded' before the cancel job runs, it now automatically queues a refund instead of failing and leaving the member charged
- **Fixed**: Staff manual day pass bookings now verify session creation succeeded — previously a failed session creation would silently commit the booking without a session, consuming the day pass with no usable reservation
- **Fixed**: Guest pass refund failures during cancellation are now properly detected and logged across all 4 cancellation paths (member cancel, staff cancel, complete pending cancellation, bookingStateService) — previously the return value was ignored and the catch block was unreachable, so failed refunds were silently lost
- **Fixed**: Session creation errors now logged across all ensureSessionForBooking callers (check-in context, payment action, conference room sync, staff conference booking, resource confirmation, Trackman reprocess, admin link member) — previously validation failures returned sessionId=0 with no log entry
- **Fixed**: Admin link-member now returns 500 on session creation failure instead of setting session_id=0 in the database

## [8.87.30] - 2026-03-15

### Trackman Logging Consistency — Structured Logger Migration
- **Improved**: 42 raw process.stderr.write calls across Trackman matching, resolution, and session mapper files migrated to structured logger — all Trackman import operations now appear in the searchable, structured log system for easier monitoring and alerting

## [8.87.29] - 2026-03-15

### Payment Intent Cancellation Safety — Migrate to cancelPaymentIntent Helper
- **Fixed**: 9 direct stripe.paymentIntents.cancel() calls across schedulers, terminal, data integrity, approval, and Trackman files now use the cancelPaymentIntent() helper — properly handles invoice-generated payment intents by voiding the invoice instead of failing silently
- **Improved**: Remaining 5 intentional direct cancel calls (pre-OOB payment flows) now have explanatory comments documenting why they bypass the helper


## [8.87.28] - 2026-03-15

### Booking Workflow Audit Fixes
- **Member Cancel Financial Cleanup**: Financial cleanup (PI refunds, invoice voiding, guest pass refunds) now runs before status is set to `cancelled` in the booking cancellation flow.
- **Staff Manual Booking Locks**: Added advisory locks (`acquireBookingLocks`) and atomic session creation inside the transaction for staff manual bookings.
- **Check-in Fee Computation**: `computeFeeBreakdown()` and snapshot insert moved outside the database transaction in the staff check-in confirm_all path.
- **Trackman Auto-Approve Atomicity**: `ensureSessionForBooking` now runs inside the same transaction as the status update in Trackman webhook handlers via `TxQueryClient` adapter.
- **Structured Logging**: Replaced all ~112 `process.stderr.write` calls in `trackman/service.ts` with structured `logger.info/warn/error` calls using template literals.
- **Unified Notifications**: Replaced ~25 direct `db.insert(notifications)` calls across booking files (`bookings.ts`, `bookingStateService.ts`, `trackman/service.ts`, `approvalService.ts`, `bookingEvents.ts`, `webhook-billing.ts`, `admin-roster.ts`) with `notifyMember()` / `notifyAllStaff()` from the centralized notification service.
- **Files**: `server/routes/bays/bookings.ts`, `server/routes/staff/manualBooking.ts`, `server/routes/staffCheckin.ts`, `server/routes/trackman/webhook-handlers.ts`, `server/routes/trackman/webhook-billing.ts`, `server/routes/trackman/admin-roster.ts`, `server/core/bookingService/sessionManager.ts`, `server/core/bookingService/bookingStateService.ts`, `server/core/bookingService/approvalService.ts`, `server/core/bookingEvents.ts`, `server/core/trackman/service.ts`

## [8.87.27] - 2026-03-15

### Trackman Cancellation Safety — Idempotent Refund Handling
- **Fixed**: Trackman import cancellations now run financial cleanup (refunds, invoice void) before marking the booking as cancelled — prevents partial cancellation
- **Fixed**: `BookingStateService` now atomically claims payment intents before queueing refund jobs — prevents duplicate refund attempts when both manifest refund and invoice void target the same payment
- **Fixed**: Stale Trackman booking cancellations now follow the same cleanup-first ordering
- **Improved**: Trackman import cancellation logging now uses structured logger instead of raw stderr

## [8.87.26] - 2026-03-15

### Cancellation Safety & Timezone Fixes
- **Fixed**: Member cancel button now correctly uses Pacific timezone — previously, members in other timezones could see the cancel button disappear too early or too late
- **Fixed**: Financial cleanup (refunds, invoice void) now runs before booking status is set to 'cancelled' — prevents partial cancellation
- **Fixed**: Duplicate refund prevention — system now checks if a refund was already queued before attempting a second refund
- **Improved**: All cancellation error logging now uses structured error format

## [8.87.25] - 2026-03-15

### Saved Card Payment — Invoice Reuse Loop Fix
- **Fixed**: 'Pay with Saved Card' no longer fails when the existing invoice has a broken payment — system now voids the broken invoice and creates a fresh one instead of retrying in a loop
- **Fixed**: Staff 'Charge Card on File' has the same invoice recovery fix
- **Improved**: Better error logging when Stripe invoice payment fails — now captures specific Stripe error code and decline reason
- **Improved**: Cards requiring 3D Secure during saved-card payment now return proper status instead of generic failure

## [8.87.24] - 2026-03-15

### Stripe Payment API Fixes — Saved Card & Invoice Handling
- **Fixed**: Member 'Pay with Saved Card' — database query was referencing wrong column name, causing all saved-card payments to fail
- **Fixed**: Cancelling invoice-generated payments now voids the invoice instead of trying to cancel the payment intent directly
- **Fixed**: Staff 'Charge Card on File' now correctly cleans up stale payment intents from previous attempts
- **Fixed**: Staff payment retry now uses `invoices.pay()` instead of `paymentIntents.confirm()` for invoice-generated payments
- **Fixed**: Member saved-card payment stale PI cleanup now uses invoice-aware cancellation
- **Fixed**: Staff payment retry failure response no longer crashes (was referencing variable from wrong code branch)
- **Fixed**: Invoice payment retry failures now store valid payment status instead of invoice status
- **Safety**: Invoice cancellation fallback now verifies the invoice belongs to the payment being cancelled
- **Fixed**: Staff 'Cancel Payment' and 'Void Authorization' now handle invoice-generated payments correctly
- **Fixed**: Auto-retry on card update now uses correct API for invoice-based payments

## [8.87.23] - 2026-03-15

### Charge Card on File Fix & Payment Safety Audit
- **Fixed**: 'Charge Card on File' now works for both staff and members — previously failed with 'active payment intent already exists' error
- **Fixed**: All saved card payments now use correct Stripe API to prevent payment failures
- **Fixed**: Stale pending payment intents automatically cleaned up before new card-on-file charges
- **Safety**: Double-charge prevention — if payment is already processing or succeeded, duplicate charges blocked
- **Safety**: POS café/shop saved card charges now use the same corrected payment method
- **Fixed**: Member dashboard now shows 'Fees Paid' with green checkmark after payment — previously showed 'Estimated Fees' when some participants had $0 fees
- **Internal**: Unified payment status logic between member and staff views via shared `checkBookingPaymentStatus` function
- **Safety**: Staff 'Link Member' now checks for scheduling conflicts before adding a member
- **Safety**: Staff roster changes (add/remove guest, link/unlink member) now clear cached fees before recalculating

## [8.87.22] - 2026-03-15

### Credit Balance Protection & UX Fix
- **Fixed**: Account credit balance no longer drained by repeated Pay Now attempts — if invoice was already auto-paid from credit, system detects it and stops creating duplicates
- **Fixed**: 'Add Guest' modal now hides payment options when roster is locked after payment

## [8.87.21] - 2026-03-15

### Fee Display & Payment Fix
- **Fixed**: Dashboard no longer shows 'Fees Paid' with green checkmark when no payment was actually made
- **Fixed**: Empty slots now show 'Estimated Fees' as informational with 'Fill empty slots or pay at check-in'
- **Fixed**: 'Fees Paid' badge only appears after a verified Stripe payment
- **Fixed**: Pay Now button only appears when there are actual guest fees to pay, not for empty slot estimates
- **Fixed**: 'Payment processing failed' error when Stripe auto-applies account credit to cover the full invoice — now handled gracefully as a completed payment

## [8.87.18] - 2026-03-15

### Roster Lock Improvements
- **Fixed**: Bookings within daily allowance ($0 fees) no longer get falsely locked — staff can add walk-in guests at check-in
- **Fixed**: Roster lock now shows clear message when editing a paid booking — suggests check-in flow for walk-in guests
- **Improved**: Roster lock is now fail-closed — if system can't verify payment status, it locks as a precaution

## [8.87.17] - 2026-03-15

### Bug Fixes & Stability Improvements
- **Fixed**: Prepayment now shows specific error messages for declined/expired/insufficient funds — no more generic 'Payment processing failed'
- **Fixed**: 'Add to Apple Wallet' button now appears on Dashboard booking cards, not just the booking page
- **Fixed**: Apple Wallet pass now updates when staff approve, modify, or reassign a booking
- **Fixed**: Staff no longer receive duplicate 'Roster Changed After Payment' notifications
- **Fixed**: Roster lock now reliably blocks changes on paid bookings even during brief payment system delays
- **New**: Staff can scan QR code on Apple Wallet booking pass to check in directly

## [8.87.16] - 2026-03-15

### Apple Wallet Lock-Screen Notifications
- **New**: Apple Wallet pass shows lock-screen notifications when booking details change (bay, time, date, status, player count)
- **New**: Membership wallet pass notifications for tier changes, status updates, and guest pass balance changes
- **New**: Booking passes now show a status field (Confirmed, Checked In, Cancelled, etc.) that updates automatically
- **Improved**: Apple Wallet notifications deduplicate with push notifications — wallet notification takes priority
- **Improved**: Booking passes include a direct link to bookings page on the back of the pass

## [8.87.15] - 2026-03-14

### Sign In with Face ID & Touch ID (Passkeys)
- **New**: WebAuthn passkey registration and authentication flow — Face ID / Touch ID for instant passwordless login
- **New**: Post-login banner prompts passkey enrollment for eligible users
- **New**: Profile page passkey management — register new devices, remove old ones
- **Compatibility**: iPhone, iPad, Mac with supported browsers; synced via iCloud Keychain
- **Files**: `server/routes/passkey.ts`, passkey registration/authentication components, profile passkey section

## [8.87.14] - 2026-03-14

### Smarter Push Notifications on iOS
- **Improved**: Push notifications now show Ever Club icon and badge on iOS
- **Improved**: Notifications for the same booking or event replace each other instead of piling up (collapse key support)
- **Improved**: Notification tap deep-links to relevant page (bookings, events, billing, etc.)
- **Fixed**: Notification sounds now play correctly on iOS when an existing notification is updated

## [8.87.13] - 2026-03-14

### Add Bookings to Apple Wallet
- **New**: Apple Wallet PKPass generation for golf simulator bookings — bay, date, time, player count at a glance
- **New**: 'Add to Apple Wallet' button on approved, confirmed, and checked-in bookings
- **New**: Booking confirmation emails include Apple Wallet download link
- **New**: Pass auto-updates when booking time or bay changes; cancelled bookings are voided
- **New**: Pass includes map pin for club location
- **Files**: `server/routes/wallet.ts`, PKPass template generation, email template update

## [8.87.12] - 2026-03-14

### Bug Fixes & Data Integrity
- **Fixed**: Billing notifications now broadcast correctly when members pay with a saved card
- **Fixed**: Invoice payment processing now properly handles Stripe payment intent verification
- **Fixed**: HubSpot sync queue race condition — rapid tier changes no longer risk stale data overwriting the latest update
- **Fixed**: Winning a payment dispute no longer blindly reactivates membership — system checks for other open disputes and subscription status before auto-reactivating
- **Fixed**: Added consistent lock ordering to prevent database deadlocks when processing concurrent payments for the same booking

## [8.87.9] - 2026-03-14

### One-Tap 'Pay with Card on File' for All Member Payments
- **New**: Members with a saved card can now pay with a single tap — no need to fill out payment form
- **Scope**: Works for both booking prepayments and invoice payments from History page
- **UX**: Prominent 'Pay with card on file' button above standard payment form showing card brand and last 4 digits
- **Fallback**: If saved card requires 3D Secure, system gracefully falls back to standard payment form
- **Audit**: Full audit trail for all saved card member payments

## [8.87.8] - 2026-03-14

### Apple Pay, Google Pay & Saved Cards for Booking Prepayments
- **New**: Apple Pay and Google Pay support for booking fee prepayments
- **New**: Saved cards on file now appear in the payment form — no re-entry needed
- **New**: Members can save new cards during payment for faster checkout

## [8.87.7] - 2026-03-14

### Conference Room Booking Fix — No More False Invoice Warnings
- **Fixed**: Conference room bookings within daily allowance (no fees due) no longer trigger false 'invoice not found' warnings
- **Fixed**: All three conference room payment paths (member booking, staff booking, booking approval) now correctly skip invoice finalization when there are no charges

## [8.87.6] - 2026-03-14

### HubSpot Field Mapping Fix — No More Silently Dropped Data
- **Fixed**: Private Hire inquiry fields (event date, event time, services, additional details) now properly reach HubSpot instead of being silently dropped
- **Fixed**: Guest Check-in fields (guest name, email, phone, sponsoring member) now sync to HubSpot
- **Fixed**: Contact form 'topic' field now passes through to HubSpot
- **Fixed**: All form fields submitted by members and visitors now included in HubSpot submissions

## [8.87.5] - 2026-03-14

### Admin-Configurable HubSpot Form IDs
- **New**: HubSpot Form IDs configurable from Admin Settings — no more environment variables needed
- **New**: 'HubSpot Form IDs' section in Settings for Membership, Private Hire, Event Inquiry, Tour Request, Guest Check-in, and Contact forms
- **Architecture**: Smart 4-level fallback: Environment variable → Admin setting → Auto-discovered → Hardcoded default
- **Performance**: Settings cached for fast performance, take effect immediately when saved

## [8.87.4] - 2026-03-14

### HubSpot Form Submission Fix
- **Fixed**: Public forms no longer fail with 'Submission Failed' when HubSpot form IDs aren't set as environment variables
- **Fixed**: Forms now auto-discover correct HubSpot form ID via 3-step lookup: env var → auto-discovered → known default
- **Improved**: Better error messages on form submission failure — logs include form type, ID used, and error details
- **Improved**: Server reports which form types are ready vs missing at startup
- **Fixed**: Hardened error handling for unexpected HubSpot response formats
- **Fixed**: Form type detection now consistent across all code paths

## [8.87.3] - 2026-03-14

### Login & Database Connection Fix
- **Fixed**: Dev login no longer fails with server error
- **Fixed**: Staff members now correctly see Staff Command Center instead of Member Portal after login
- **Fixed**: All API endpoints (announcements, closures, café menu, settings, membership tiers) now load reliably
- **Improved**: Database connection safety — development environment no longer accidentally connects to production database

## [8.87.2] - 2026-03-14

### Server Code Quality & Stability
- **Fixed**: 286 type-safety issues across all backend files (billing, bookings, Trackman, member sync, etc.)
- **Improved**: Better error handling throughout server for fee calculations, booking approvals, and data integrity checks
- **Enforced**: Server type-checking now enforced automatically to catch issues before production

## [8.87.1] - 2026-03-14

### Google & Apple Account Linking Fix
- **Fixed**: Linking Google or Apple accounts from profile page no longer shows 'User account not found' error
- **Fixed**: Google account link button now correctly says 'Link' instead of 'Sign in' on profile page

## [8.87.0] - 2026-03-14

### Directory Sync Fix & Membership Status Accuracy Overhaul
- **Fixed**: Directory sync 'HubSpot: partial (push failed)' error — push now runs directly in batches of 5 instead of through a single HTTP call timing out with 255+ members
- **Fixed**: Membership status (Active, Trialing, Past Due, etc.) now displays accurately everywhere — previously all members showed as 'Active'
- **Fixed**: Members on free trial or with past-due payment can now book simulators, enroll in wellness, RSVP to events — previously incorrectly blocked
- **Fixed**: Staff booking calendar no longer highlights trial and past-due members as 'inactive'
- **Fixed**: Google and Apple sign-in now correctly carry real membership status through to the app
- **Fixed**: Directory sync now includes trial and past-due members in HubSpot push
- **Improved**: Admin directory sync results show partial push error counts (e.g. '250 synced, 3 push errors')
- **Improved**: Inactive member tier badges show 'No Active Membership' with status label for suspended, terminated, expired, cancelled, frozen, and paused members

## [8.86.2] - 2026-03-14

### Project Cleanup & Dead Code Removal
- **Disk Space**: Removed `attached_assets/` (141MB chat screenshots/pastes), `dist/` (16MB build output), and empty `uploads/` directory.
- **Security**: Removed root-level Apple certificate files (`cert_b64.txt`, `cert.der`, `cert.pem`) — certificates are stored as env secrets. Added `*.pem`, `*.der`, `cert_b64.txt` to `.gitignore`.
- **Dead Code**: Removed deprecated `src/lib/backgroundSync.ts` (fully replaced by React Query) and unused `src/components/staff-command-center/sections/QuickActionsGrid.tsx`.
- **Unused Packages**: Removed `react-window`, `react-virtualized-auto-sizer`, and their type definitions — never imported anywhere in the codebase.

## [8.86.1] - 2026-03-14

### WebSocket Reconnect Loop Fix & Error Logging
- **WebSocket Backoff**: Member and staff WebSocket hooks now use exponential backoff (2s×2^n, max 30s) with max retry limits (15/20) and reset counter on successful connection.
- **Error Logging**: Session store error logging uses `getErrorMessage()` instead of raw `err.message`.

## [8.86.0] - 2026-03-14

### Security Audit & Code Quality Hardening
- **Query Parameter Validation**: 37 route handlers now use `validateQuery` middleware with typed `req.validatedQuery`. Remaining `req.query` usages are on authenticated staff routes with simple string destructuring — zero raw `parseInt()` on query params.
- **Stripe Idempotency**: All 12 `paymentIntents.create` calls verified with deterministic idempotency keys.
- **WebSocket Auth**: Verified origin check + `getVerifiedUserFromRequest` session verification on connection.
- **Booking Advisory Locks**: Extracted `acquireBookingLocks()` and `checkResourceOverlap()` into `server/core/bookingService/bookingCreationGuard.ts` for testability. Advisory locks (`pg_advisory_xact_lock`) verified across all creation/approval paths.
- **LOWER Email Indexes**: 39 `LOWER(email)` indexes across all email-bearing tables. All Drizzle-managed tables have matching schema index definitions (6 remaining DB-only indexes are on raw SQL tables without Drizzle schemas). Schema files updated: `auth-session.ts`, `scheduling.ts`, `content.ts`, `membership.ts`, `billing.ts`, `hubspot-billing.ts`.
- **TypeScript Strict Mode**: `strict: true` enforced in both `tsconfig.json` (frontend/shared) and `server/tsconfig.json` with 0 errors.
- **ESLint Zero Warnings**: Reduced from 383 errors/974 warnings to 0/0. All 59 `react-hooks/exhaustive-deps` warnings fixed via `useCallback`/`useMemo` wrapping. 3 unused variable warnings fixed.
- **Concurrency Tests**: 31 new tests in `tests/bookingConcurrency.test.ts` (17 tests) and `tests/guestPassConcurrency.test.ts` (14 tests) covering advisory lock serialization, roster version optimistic locking, guest pass race conditions. Total test suite: 259 tests, all passing.
- **req.validatedQuery Refactor**: All routes using `validateQuery` middleware now access parsed values via `req.validatedQuery` typed cast instead of raw `req.query`.
- **Migrations**: 0052 (initial LOWER email indexes), 0053 (magic_links, tours, bug_reports), 0054 (trackman, terminal_payments, stripe_tx_cache, sync_exclusions, hubspot_sync_queue JSONB).
- **Files**: `server/core/bookingService/bookingCreationGuard.ts`, `tests/bookingConcurrency.test.ts`, `tests/guestPassConcurrency.test.ts`, `shared/models/auth-session.ts`, `shared/models/scheduling.ts`, `shared/models/content.ts`, `shared/models/membership.ts`, `shared/models/billing.ts`, `shared/models/hubspot-billing.ts`, 18 route files refactored for `req.validatedQuery`

## [8.85.1] - 2026-03-14

### Code Quality: ESLint Cleanup
- **ESLint Errors**: Resolved all 383 ESLint errors across the codebase (100% reduction).
- **ESLint Warnings**: Reduced from 974 to 60 (93.8% reduction) — removed unused imports, prefixed unused variables with `_`, added eslint-disable comments for legitimate React Compiler hook patterns.
- **Code Fixes**: Fixed unnecessary escape characters in regex patterns, empty catch blocks, useless catch statements, and missing case declarations.
- **ESLint Config**: Updated to ignore `.agents/`, `.local/`, `.config/` directories and disable `no-undef` for TypeScript files.

## [8.85.0] - 2026-03-13

### Trackman Reliability & Availability Block Improvements
- **Queue Clearing**: Trackman auto-confirmed bookings now clear from the staff queue immediately (was only clearing on refresh).
- **Duplicate Prevention**: Availability blocks prevented via `createStandaloneBlock()` which checks for existing coverage before inserting.
- **Calendar Sync**: `closures.ts` now filters out Trackman booking time slots from closure import using a `trackmanSlotSet` lookup.
- **Error Handling**: Completing already-cancelled bookings now returns a clear error instead of silently succeeding. Availability block creation handles DB constraint errors gracefully.
- **Bug Fixes**: SSL security warning fix, optional field crash fix, complimentary day pass refund fix, day pass search performance cap, staff assignment dropdown flicker fix, session expiry account deletion fix, booking cancellation date type guard fix.

## [8.84.1] - 2026-03-13

### Booking Fixes, Name Display & Apple Wallet Location
- **Apple Wallet Location**: Pass now supports lock screen location triggers with admin-configurable coordinates.
- **Multi-Player Fix**: Adding multiple players to a booking now works reliably.
- **Admin Stale Data**: Admin booking list no longer shows stale data after cancellations.
- **Name Display**: Name now displays correctly across the app after signing in with Google or Apple.
- **Welcome Messages**: Greetings now consistently use first name throughout the app.
- **Transaction Safety**: Billing and cancellation scheduling no longer conflicts with ongoing booking operations.

## [8.84.0] - 2026-03-12

### Linked Email Booking Fix (Comprehensive)
- **Booking Creation — Email Resolution**: All booking creation paths now resolve linked/secondary emails to the primary account before saving. Ensures `user_id` is always set alongside `user_email`. Affected paths: member booking (POST `/api/bays/bookings`), staff manual booking, staff conference room booking, `createBookingRequest`, `createManualBooking` (resource service), Trackman resolution inserts, and Trackman rescan inserts.
- **Member Dashboard — Linked Email Queries**: Member-facing booking queries now include bookings created under any linked email. Fixes bookings "disappearing" from the member's dashboard when they were made under a secondary email. Affected queries: dashboard GET, past booking count, last activity date, outstanding balance summary, detailed outstanding items, unfilled slots.
- **Tier Limit Enforcement**: Daily booked minutes (`getDailyBookedMinutes`, `getTotalDailyUsageMinutes`) now aggregate across all linked emails, preventing members from bypassing tier limits by booking under secondary emails.
- **Staff Check-In**: QR scan booking lookup now finds bookings across linked emails.
- **Staff Existing Booking Check**: `checkExistingBookingsForStaff` includes linked email bookings for conflict detection.
- **Calendar Sync**: `findMemberByCalendarEvent` now checks the `user_linked_emails` table when matching calendar event attendees to members, with new `'linked_email'` match method.
- **Auto-Repair on Startup**: Server startup repairs orphaned bookings (those with a linked email but missing `user_id`) automatically.
- **Admin Repair Endpoint**: `POST /api/admin/repair-linked-email-bookings` available for on-demand repair.
- **Files**: `server/routes/bays/bookings.ts`, `server/routes/members/dashboard.ts`, `server/core/resource/service.ts`, `server/core/resource/staffActions.ts`, `server/routes/staff/manualBooking.ts`, `server/routes/staff-conference-booking.ts`, `server/core/trackman/resolution.ts`, `server/core/trackman/service.ts`, `server/core/calendar/sync/conference-room.ts`, `server/core/calendar/config.ts`, `server/replit_integrations/auth/routes.ts`, `server/routes/memberBilling.ts`, `server/core/tierService.ts`, `server/routes/staffCheckin.ts`, `server/loaders/startup.ts`, `server/routes/trackman/admin-maintenance.ts`

## [8.82.0] - 2026-03-11

### Session & Auth Fixes
- **Session TTL Alignment**: Internal session `expires_at` changed from 7 days to 30 days across all login paths (OTP verification, password login, Google OAuth token, Google OAuth callback, dev login). Now matches the cookie `maxAge` and Postgres session store TTL, preventing "logged in but expired" states after 7 days.
- **Files**: `server/routes/auth.ts`, `server/routes/auth-google.ts`

### Billing & Fee Safety
- **Fee Calculator Null Guard**: `feeCalculator.ts` now guards `ledger_fee` against null/NaN before `parseFloat()`. Prevents incorrect `NaN`-based billing when a `LEFT JOIN` on `usage_ledger` returns no match for a participant.
- **Invoice Rounding Fix**: `addLineItemsToInvoice()` in `bookingInvoiceService.ts` now checks that fee amounts are exact multiples of the Stripe rate before using price × quantity. If there's a remainder (due to manual adjustments or legacy data), falls back to raw cent amounts to prevent rounding discrepancies. Rate must be > 0 for the price-based branch.
- **Files**: `server/core/billing/feeCalculator.ts`, `server/core/billing/bookingInvoiceService.ts`

### Booking & Guest Pass Consistency
- **Conference Room Approval Status**: Conference room bookings now go through `'approved'` status like simulators, instead of skipping directly to `'attended'`. Fixes conference rooms being non-cancellable after approval and ensures reminder/notification logic works consistently for all resource types.
- **Guest Pass Refund Window**: Staff/system cancellation cascade (`cancellation.ts`) changed from 24-hour to 1-hour refund threshold, matching member-facing cancellation logic. Member cancellation now also gates guest pass refunds behind the `shouldSkipRefund` check. Both paths use `>= 1 hour` consistently. Notification message updated to reflect "1 hour" window.
- **Files**: `server/core/bookingService/approvalService.ts`, `server/core/resource/cancellation.ts`, `server/routes/bays/bookings.ts`

## [8.81.3] - 2026-03-11

### Cancellation Safeguards
- **Full Refund on Cancel**: Cancelling a booking now refunds all related payments and voids any open invoices — previously some payments could be left behind.
- **Stuck Refund Prevention**: Cancellation no longer gets stuck in a 'refunding' state if a Stripe refund fails — handles partial failures gracefully.
- **Fee Snapshot Update**: Booking cancellation now correctly updates the saved fee snapshot — prevents stale fee data on cancelled bookings.
- **Past Booking Protection**: Members can no longer cancel bookings that already happened or were attended — button hidden on frontend and enforced on backend.
- **Lesson Closure Cleanup**: Lesson events from Google Calendar no longer create unwanted facility closure notices — past lesson closures auto-cleaned on startup.
- **Billing Calculation Fix**: Usage calculator and approval service edge cases resolved during check-in.
- **Manual Booking Validation**: Staff manual booking modal validates all required fields before submission.
- **Files**: `server/core/resource/cancellation.ts`, `server/core/billing/bookingInvoiceService.ts`, `server/core/databaseCleanup.ts`, `server/loaders/startup.ts`, `server/core/bookingService/approvalService.ts`, `server/core/bookingService/usageCalculator.ts`

### UI Polish
- **Command Center Notices**: Affected areas (bays, rooms) display proper labels instead of raw data.
- **Edge Swipe**: Hamburger menu easier to open on mobile — edge swipe zone widened.
- **Dropdown Consistency**: Dropdowns behave consistently across iOS and Android.
- **Conference Room Notes**: Spacing corrected on booking notes section.
- **Data Integrity Validation**: Integrity actions validate inputs more strictly.
- **Files**: `src/hooks/useEdgeSwipe.ts`, `src/components/booking/GuestPaymentChoiceModal.tsx`, `server/routes/dataIntegrity.ts`

## [8.81.2] - 2026-03-11

### Billing Accuracy & Empty Slot Fees
- **Empty Slot Charges**: Empty booking slots are now automatically charged as guest fees — if a 4-player booking has 2 empty slots, those slots incur guest fees.
- **Invoice Receipts**: Members can view full invoice receipts for all past payments directly from billing history.
- **Invoice Filters**: Invoice filter now includes Refunded and Void statuses for full lifecycle tracking.
- **Guest Pass Eligibility**: Guest pass eligibility now correctly checks all booking participants — edge cases fixed.
- **Placeholder Guest Standardization**: Placeholder guests (system-generated during imports) consistently identified across billing, roster, and fee calculations.
- **Member Minutes Fix**: Fee calculation correctly accounts for included member minutes — members were sometimes overcharged.
- **Billing History Dedup**: Billing history no longer shows duplicate entries for the same booking.
- **Stale Payment Intent Cleanup**: Old payment intents properly cancelled when an invoice is updated with a new payment.
- **Payment History Filter**: Payment history only shows completed and refunded transactions — pending/cancelled attempts removed.
- **Unified Billing Modal**: Billing and payment now use a unified modal for invoices.
- **Cancelled Booking Exclusion**: Fee calculation now excludes cancelled bookings from daily usage totals.
- **Billing History Dates**: Date formatting corrected for consistent display across all entries.
- **Stale Invoice Cleanup**: Stale invoices cleaned up before creating new payment intents.
- **Invoice Metadata Fix**: Booking IDs correctly extracted from invoice metadata for billing history lookups.
- **View Button Fix**: 'View' button on payment receipts only appears for successfully completed payments.
- **Stripe Product IDs**: Billing now uses correct Stripe product IDs for overage and guest fees.
- **Files**: `server/core/billing/unifiedFeeService.ts`, `server/core/billing/bookingInvoiceService.ts`, `server/routes/stripe/member-payments.ts`, `server/routes/myBilling.ts`, `src/pages/Member/History.tsx`

## [8.81.1] - 2026-03-10

### Invoice Payments & Multi-Booking
- **Draft Invoice Payments**: Members can pay draft invoices directly from their dashboard — choose between card on file or new card entry.
- **Multi-Slot Booking**: Members can book multiple simulator slots on the same day — old one-booking-per-day restriction removed while keeping one-pending-request limit.
- **Conference Room Pay Later**: Conference room bookings can be paid later instead of requiring immediate payment at booking time.
- **Booking Status Messages**: Status messages now clearly distinguish between 'requests' (pending) and 'confirmed bookings'.
- **Files**: `server/routes/stripe/member-payments.ts`, `server/routes/bays/bookings.ts`, `src/pages/Member/BookGolf.tsx`

### Mobile Navigation
- **Edge Swipe Menu**: Swipe from the left edge of the screen to open the hamburger menu on mobile and PWA.
- **Mobile Date Picker**: Date selector on booking calendar appears as a full-width sheet on mobile.
- **Sidebar Scroll Fix**: Background page no longer scrolls when scrolling inside the sidebar.
- **Files**: `src/hooks/useEdgeSwipe.ts`, `src/pages/Admin/tabs/simulator/CalendarGrid.tsx`

### Reliability
- **Payment Intent Descriptions**: All Stripe payment intents include descriptive text for easier identification.
- **Payment Confirmation Race Fix**: Invoice payment confirmations reliably show the success screen — resolved race condition.
- **Email Template Address**: Email templates pull the correct club address from settings instead of hardcoded value.
- **Booking Owner Auto-Fix**: Mismatched booking owners automatically corrected on server startup.
- **Session Reuse Prevention**: Booking sessions no longer reuse cancelled sessions — each gets a fresh session.
- **Overlapping Sessions**: Overlapping booking sessions for the same resource now supported — resolves back-to-back boundary errors.
- **Session-Booking Linking**: Sessions properly linked to bookings at creation — prevents orphaned sessions.
- **Session Participant Sync**: Session participants updated when roster changes — old participants removed and new ones added on startup.
- **Session Creation Logic**: Session creation and overlap detection improved for adjacent time slots.
- **Fee Backfill**: Backfill process computes fees for newly created sessions — ensures historical bookings have billing data.
- **Booking Format Parsing**: Booking request format interpretation improved for various date/time formats.
- **Lesson Closure Filter**: Lesson events from Google Calendar filtered out during event sync — no longer create closure notices.
- **Participant Transactions**: Roster changes no longer cause database constraint violations.
- **HubSpot Queue**: Queue processing no longer stalls on invalid entries — skips malformed jobs.
- **Session Error Handling**: Session creation error handling improved — prevents unnecessary error logs.
- **Error Boundaries**: App error boundaries simplified for cleaner recovery.
- **Financial Loading UX**: Financial page loading skeletons improved on mobile.
- **Scheduler Recovery**: Scheduler state management improved with better error handling.
- **Files**: `server/core/emailTemplatePreview.ts`, `server/loaders/startup.ts`, `server/core/bookingService/sessionManager.ts`, `server/core/bookingService/rosterService.ts`, `server/core/hubspot/queue.ts`, `server/routes/trackman/admin-maintenance.ts`

## [8.81.0] - 2026-03-10

### Data Integrity Expansion
- **Three New Checks**: Added `checkArchivedMemberLingeringData` (detects archived members with leftover bookings, guest passes, enrollments, group memberships, push subscriptions, or future RSVPs), `checkActiveMembersWithoutWaivers` (flags active members missing signed waivers after 7 days), and `checkEmailOrphans` (finds records in notifications, booking_participants, event_rsvps, push_subscriptions, wellness_enrollments, and user_dismissed_notices where the email doesn't match any user).
- **New Resolution Tools**: `POST /api/data-integrity/fix/delete-orphan-records-by-email` cleans up all records for a non-existent email. `POST /api/data-integrity/fix/mark-waiver-signed` resolves missing waiver flags directly from the integrity dashboard.
- **Event RSVP Filter**: Integrity checks now filter `COALESCE(er.source, 'local') = 'local'` to exclude Eventbrite-imported external guest RSVPs from orphan/lingering-data alerts.
- **Files**: `server/core/integrity/memberChecks.ts`, `server/routes/dataIntegrity.ts`, `shared/validators/dataIntegrity.ts`, `src/pages/Admin/tabs/dataIntegrity/IntegrityResultsPanel.tsx`

### Notification Refinements
- **Synthetic Email Guard**: `isSyntheticEmail()` in `notificationService.ts` blocks notifications for synthetic/imported emails (`@trackman.local`, `@visitors.evenhouse.club`, `private-event@`, `classpass-*`, etc.) across all notification insertion paths. Early return skips DB insert, WebSocket, and push delivery.
- **Staff Notification Safety**: All three staff notification fan-out paths (`notifyAllStaff`, `staffNotifications.getStaffAndAdminEmails`, `bookingEvents.getStaffEmails`) now INNER JOIN `staff_users` against `users` to prevent notifications for deleted/archived staff.
- **Booking Notifications Restored**: Member notifications for booking approvals and declines were accidentally removed — now restored with deduplication to prevent double-sending.
- **Files**: `server/core/notificationService.ts`, `server/core/bookingService/approvalService.ts`, `server/core/bookingEvents.ts`, `server/core/staffNotifications.ts`, `server/core/resource/cancellation.ts`, `server/core/resource/staffActions.ts`, `server/core/trackman/service.ts`

### Member Archiving & Email Cascade
- **Archive Cascade Cleanup**: Member deletion/archiving now cascades cleanups across `event_rsvps`, `booking_requests`, `wellness_enrollments`, `guest_pass_holds`, `group_members`, and `push_subscriptions`.
- **Email Change Cascade**: `emailChangeService` expanded to update `notifications`, `event_rsvps`, `push_subscriptions`, `wellness_enrollments`, and `user_dismissed_notices` when a member's email changes.
- **Files**: `server/routes/members/admin-actions.ts`, `server/core/memberService/emailChangeService.ts`

### Mobile & Scrolling Stability
- **Android Direction Lock**: PullToRefresh implements a direction lock to prevent horizontal swipes from triggering refresh.
- **CSS Overflow Fix**: Adjusted overflow properties on Android Chrome to prevent content from getting stuck mid-scroll.
- **Pixel/Chrome Touch Fix**: Touch listeners moved to document level to avoid Pixel Chrome compositor interference. Container-scoped guards (`containerRef.contains(e.target)`) and `hasActiveLocks()` prevent activation during overlays/menus.
- **Edge Swipe Gesture**: `useEdgeSwipe.ts` now detects Android gesture navigation (`isAndroidGestureNav`) and defers to the system back gesture.
- **Files**: `src/components/PullToRefresh.tsx`, `src/hooks/useEdgeSwipe.ts`, `src/index.css`

### Security Hardening
- **IP Spoofing Prevention**: Audit log and session manager hardened against forged requests.
- **Rate Limiting**: Authentication endpoints enforce stricter validation to prevent duplicate OTP emails and IP spoofing.
- **Files**: `server/core/auditLog.ts`, `server/core/bookingService/sessionManager.ts`, `server/routes/auth.ts`

### Booking Import & Matching
- **Placeholder Email Matching**: Trackman booking imports now match members using placeholder emails — reduces unmatched bookings.
- **Broader Email Resolution**: Unmatched bookings during CSV imports handled more gracefully with broader email matching.
- **Matched Status Enforcement**: All bookings properly marked as matched after assignment — prevents lingering in unmatched queue.
- **Unmatched Booking Handling**: Improved cancellation and resolution for unmatched Trackman bookings.
- **Files**: `server/core/trackman/service.ts`, `server/core/bookingService/approvalService.ts`, `server/db-init.ts`, `server/routes/trackman/admin-resolution.ts`

### Staff Tools & Directory
- **Bulk Waiver Action**: 'Mark All Waivers Signed' bulk action added to data integrity dashboard.
- **Activity Log Removed**: Activity log section removed from data integrity page — cleaner interface.
- **Self-Linking Prevention**: Members can no longer accidentally link their account to themselves.
- **Staff Role Auto-Sync**: User roles automatically corrected when staff status changes.
- **Member Directory**: Visibility and data consistency improvements for search results.
- **Files**: `server/routes/dataIntegrity.ts`, `server/routes/users.ts`, `server/db-init.ts`, `server/routes/members/search.ts`

### HubSpot Sync
- **Status Mapping Fix**: HubSpot sync correctly maps membership status and billing provider.
- **Contact ID Lookup**: Data integrity sync fetches contact IDs directly from the database for reliability.
- **Files**: `server/core/hubspot/members.ts`, `server/core/integrity/resolution.ts`

### Other Improvements
- **Print Styles**: Transitioned from backslash-escaped Tailwind class selectors to CSS attribute selectors for Lightning CSS compatibility.
- **Logger Noise Reduction**: Noisy 404s for `/api/v1/*`, `/api/login`, `/callback`, `*.gz` and unauthenticated `/api/auth/session` requests downgraded to debug level. Added `server/core/suppressWarnings.ts` to filter pg-connection-string SSL mode warnings.
- **Files**: `server/core/logger.ts`, `server/core/suppressWarnings.ts`, `server/index.ts`

## [8.80.0] - 2026-03-07

### Mark as Private Event Workflow
- **Custom Event Title**: Staff can now enter a custom title when marking a Trackman booking as a private event — previously the notice was titled "Unknown (Trackman)" from the placeholder booking name.
- **Title Input UI**: "Mark as Private Event" flow now shows a title input field (pre-filled "Private Event") when creating a new notice. Staff can also link to an existing overlapping notice instead.
- **Affected Areas Format**: Private event notices now store affected areas as comma-separated strings (`bay_1,bay_2`) instead of JSON arrays — both formats are parsed correctly for backwards compatibility.

### Notice Display Consistency
- **Notice Type Labels**: Raw `notice_type` values like `private_event` now display as "Private Event" across all views: staff Notices tab (active and past), overlapping notices list in the booking modal, and member booking page closure alerts.
- **Bay Badge Labels**: All bay badges now consistently display "Simulator Bay 1" instead of "Bay 1" via the `formatSingleArea` utility.
- **Files**: `src/utils/closureUtils.ts` (`formatTitleForDisplay` exported), `src/pages/Admin/tabs/BlocksTab.tsx`, `src/components/staff-command-center/modals/AssignModeFooter.tsx`, `src/pages/Member/BookGolf.tsx`

## [8.79.0] - 2026-03-06

### Staff Analytics Dashboard
- **Booking Analytics Page**: New staff-only analytics dashboard at `/admin/analytics` with 14 visualizations across three endpoints (`/api/analytics/booking-stats`, `/api/analytics/extended-stats`, `/api/analytics/membership-insights`). Includes:
  - Total Bookings / Cancellation Rate / Avg Session Length stat cards
  - Weekly Peak Hours Heatmap (day × hour grid with color intensity)
  - Resource Utilization horizontal bar chart (total hours per bay/room)
  - Top 5 Members leaderboard (by total hours booked)
  - Bookings Over Time line chart (weekly counts, last 6 months)
  - Revenue Over Time stacked area chart (confirmed Stripe payments by category)
  - Day of Week bar chart (all-time booking distribution)
  - Utilization by Hour bar chart (average utilization % per time slot)
  - Active vs Inactive Members ring charts (30/60/90 day windows)
  - Booking Frequency histogram (member count by booking bucket over 90 days)
  - Tier Distribution donut pie chart (active members by membership tier)
  - At-Risk Members list (no booking in 45+ days, max 15)
  - New Member Growth line chart (monthly signups over 6 months)
- **Tech**: Recharts library (BarChart, LineChart, AreaChart, PieChart, SVG ring charts), TanStack Query with three parallel queries.
- **Files**: `server/routes/analytics.ts`, `src/pages/Admin/tabs/AnalyticsTab.tsx`
- **Navigation**: Analytics added to both desktop sidebar and mobile hamburger menu via shared `nav-constants.ts`.

### Marketing & Tracking
- **Meta Pixel Integration**: Facebook/Meta Pixel tracking code added to `index.html` for all public pages — enables ad performance measurement, conversion tracking, and retargeting.

### Analytics Data Accuracy Fixes
- **Revenue Categorization**: `extended-stats` endpoint now checks both `metadata.type` and `description` fields on Stripe charges for accurate category assignment (memberships, overage, guest, day pass, other).
- **Tier Normalization**: `membership-insights` endpoint normalizes tier names (trims whitespace, lowercases) before grouping — prevents duplicate chart entries like "Gold" and "gold".
- **New Member Count**: `membership-insights` filters out imported HubSpot contacts (`source != 'hubspot_import'`) — only counts genuinely new signups.
- **Guest Fee Calculation**: `booking-stats` now joins `booking_participants` to include participant-level fee data in financial summaries.

### Bug & Stability Fixes
- **Tour Status Dropdown**: Adjusted z-index layering on `ToursTab.tsx` dropdown so it renders above adjacent elements — previously unclickable on mobile.
- **Cafe/Tiers Stale Data**: `CafeTab.tsx` and `TiersTab.tsx` now trigger React Query refetch after pulling latest data from Stripe — previously showed stale prices until a full page reload.
- **Billing Provider Validation**: Added database-level CHECK constraints and server-side validation for `billing_provider` column — prevents invalid values from being written. Cleanup migration corrects any existing invalid entries.
- **Database Connection Handling**: Improved connection pool error handling in `db-init.ts` to prevent cascading failures during high-traffic periods.
- **WebSocket Domain Cleanup**: Removed old domain from allowed WebSocket origins in `server/core/websocket.ts`.

## [8.78.0] - 2026-03-06

### Scheduler & Realtime Hardening
- **Full Scheduler Overlap Protection**: All 25 schedulers now have overlap guards preventing duplicate concurrent executions. Added `isRunning` guards to 9 previously unguarded schedulers across two audit passes:
  - **Pass 1**: `gracePeriodScheduler` (most critical — prevented duplicate termination emails), `stripeReconciliationScheduler`, `dailyReminderScheduler`, `morningClosureScheduler`, `unresolvedTrackmanScheduler`.
  - **Pass 2**: `onboardingNudgeScheduler` (also added error handling — previously had no try/catch so failures were unhandled rejections), `waiverReviewScheduler`, `supabaseHeartbeatScheduler`, `feeSnapshotReconciliationScheduler` (rewired 3 concurrent Stripe/billing sub-tasks to use `Promise.allSettled` with a single guard — previously the next interval could fire all 3 again while previous ones were still running).
- **Scheduler Startup Safety**: `staggerStart()` in `schedulers/index.ts` now wraps each scheduler start in try/catch so a single scheduler failure doesn't prevent the rest from starting.
- **Background Sync Tracking**: `backgroundSyncScheduler.ts` now calls `schedulerTracker.recordRun()` on success for accurate health dashboard reporting.
- **Supabase Realtime Gap Fixes (6 issues)**: Corrected React Query cache invalidation keys (`['bookings']`, `['command-center']`, `['trackman']`, `['simulator']`, `['announcements']`), added reconnection-triggered cache invalidation, recovery timer cleanup on disconnect, and initial heartbeat timer tracking in `supabaseHeartbeatScheduler`.
- **Data Integrity Sync Fixes**: Fixed Zod schema validation — `user_id` type corrected from `string` to `number` to match DB column type, removed unsupported `'calendar'` sync target from validator (backend only supports `'hubspot'` and `'stripe'`), and fixed Stripe handler push/pull sync implementation.
- **Member Sync Overlap Guard**: Added `isRunning` flag and double-start protection to `memberSyncScheduler.ts` — the last scheduler without overlap protection. Now all 25 schedulers are fully guarded.

## [8.77.5] - 2026-03-05

### Comprehensive Audit Fixes
- **Unhandled Rejection Shutdown**: `process.on('unhandledRejection')` in `server/index.ts` now schedules `process.exit(1)` with a 5-second grace period (`.unref()`). Prevents the app from continuing in a potentially inconsistent state after an unhandled promise rejection.
- **Silent Catch Elimination (Server)**: 3 silent `.catch(() => {})` in `server/schedulers/feeSnapshotReconciliationScheduler.ts` replaced with logged warnings for connection release failures.
- **Silent Catch Elimination (Frontend)**: 32+ silent error-swallowing patterns (`.catch(() => {})` and empty `catch {}`) across 23 frontend files replaced with `console.warn` logging. Covers payment components (`TerminalPayment`, `StripePaymentForm`, `MemberPaymentModal`, `BillingSection`), staff tools (`AvailabilityBlocksContent`, `DirectoryTab`, `MemberProfileDrawer`, `CommandCenterData`), public pages (`Footer`, `FAQ`, `Contact`), error boundaries (`PageErrorBoundary`), data contexts (`CafeDataContext`, `EventDataContext`), member pages (`Dashboard`, `Checkout`), onboarding (`FirstLoginWelcomeModal`, `OnboardingChecklist`), utilities (`useFormPersistence`, `simulatorUtils`), and service worker (`main.tsx`, `useServiceWorkerUpdate`).
- **Prefetch Error Logging**: 4 silent catches in `src/lib/prefetch-actions.ts` replaced with `console.warn` for API, member history, member notes, and booking detail prefetch failures.
- **Auth Middleware Consistency**: `GET /api/booking-requests` and `GET /api/booking-requests/:id` in `server/routes/bays/bookings.ts` now use `isAuthenticated` middleware (previously relied only on in-handler session checks). Handler-level checks remain as defense-in-depth.
- **Public Route Documentation**: 30 intentionally public routes across 18 route files marked with `// PUBLIC ROUTE` comments for audit clarity (auth, booking, calendar, availability, tours, announcements, wellness, Stripe config, push VAPID key, day passes, etc.).
- **dataTools.ts Split**: `server/routes/dataTools.ts` (2,683 lines) split into `server/routes/dataTools/` directory with 5 sub-routers: `member-sync.ts`, `booking-tools.ts`, `audit.ts`, `stripe-tools.ts`, `maintenance.ts`, plus barrel `index.ts`.
- **New Test Coverage**: Added `tests/errorUtils.test.ts` (26 tests for error utility functions including sensitive data redaction) and `tests/middleware.test.ts` (4 tests for Zod body validation middleware). Fixed pre-existing `guestPassLogic.test.ts` mock (missing `safeRelease`).

## [8.77.4] - 2026-03-05

### Bug & Stability Fixes
- **TrackmanBookingModal Timer Leaks**: Three `setTimeout` calls (50ms overlay transition, 2s copy feedback, 3.5s auto-close) were not tracked in refs and could fire after unmount. Added `overlayTimerRef` and `copyTimerRef` refs; all timers now cleared in `handleClose`, the `!isOpen` reset path, and the `useEffect` cleanup function.
- **TerminalPayment Success Timer Leak**: Four `setTimeout` calls for 1.5s success-to-callback transitions (payment success, card save success, $0 free activation, already-succeeded cancel path) were not tracked. Added `successTimeoutRef`; all four paths now store the timer ID and clear it on unmount, cancel, and before setting a new one.
- **NoticeFormDrawer Silent Fetch Failures**: Three fetch calls (`/api/notice-types`, `/api/closure-reasons`, `/api/resources`) used `.catch(() => {})`, silently swallowing errors. Staff would see empty dropdowns with no explanation and be unable to submit the form. Now shows error toasts so staff know to retry.

## [8.77.3] - 2026-03-05

### Performance Optimization
- **Booking List N+1 Elimination**: Consolidated 5 sequential `booking_participants` queries in `GET /api/booking-requests` into a single batch query with in-memory partitioning. Reduces database round-trips from ~6 to ~2 per booking list request, significantly improving response time for member and staff booking views.
- **Fee Calculation Parallelization**: `computeFeeBreakdown` in `unifiedFeeService.ts` now runs `getTierLimits` and `getGuestPassInfo` concurrently via `Promise.all` instead of sequentially, shaving ~1 DB round-trip from every fee preview and check-in.
- **Payment Record Error Escalation**: Silent `logger.warn` on payment record DB insert failures in `quick-charge.ts` (guest checkout + quick charge) and `terminal.ts` escalated to `logger.error` with `CRITICAL` tag and full payment context. These failures mean Stripe charged the customer but the local record is missing — now visible in error monitoring instead of buried in warnings.

## [8.77.2] - 2026-03-04

### Bug & Stability Fixes
- **TabTransition Timer Leak**: `TabTransition` component's `enterTimer` was created inside a `setTimeout` callback but never tracked for cleanup on unmount. Both exit and enter timers now stored in refs with proper cleanup in the `useEffect` return — prevents state updates on unmounted components during rapid tab switches.
- **Circular Import HMR Fix**: Extracted shared navigation constants (`TabType`, `tabToPath`, `pathToTab`, `getTabFromPathname`) from `src/pages/Admin/layout/types.ts` into `src/lib/nav-constants.ts`. `StaffMobileSidebar` and all Staff Command Center sections now import from the shared file instead of reaching into the Admin layout directory — breaks the HMR circular dependency chain that caused repeated page reloads during development.
- **Scheduler Overlap Guards**: Added `isRunning` flags to `sessionCleanupScheduler`, `communicationLogsScheduler`, and `webhookLogCleanupScheduler` to prevent overlapping executions if a task runs longer than its interval. `communicationLogsScheduler` now calls `syncCommunicationLogsFromHubSpot` directly (awaited) instead of the fire-and-forget `triggerCommunicationLogsSync` wrapper, and calls `stopCommunicationLogsScheduler()` before starting to prevent duplicate intervals on hot-reload.

### Additional Bug Fixes (v8.77.2)
- **TabTransition timer leak fix**: Both `enterTimer` and `delayTimer` in `TabTransition.tsx` are now tracked via refs with proper `useEffect` cleanup, preventing orphaned timers on unmount.
- **Circular import chain fix**: Extracted `TabType`, `tabToPath`, `pathToTab`, `getTabFromPathname` from `src/pages/Admin/layout/types.ts` into `src/lib/nav-constants.ts`. All `src/components/` files import from `nav-constants.ts`; `layout/types.ts` re-exports for backward compatibility within Admin pages. This breaks the HMR cycle that caused repeated page reloads.
- **Scheduler overlap guards**: Added `isRunning` flags to `sessionCleanupScheduler`, `communicationLogsScheduler`, `webhookLogCleanupScheduler`, `pendingUserCleanupScheduler`, `stuckCancellationScheduler`, `webhookEventCleanupScheduler`. Added `stop` functions and double-start protection to `sessionCleanupScheduler`, `webhookLogCleanupScheduler`, `weeklyCleanupScheduler`, `duplicateCleanupScheduler`. `supabaseHeartbeatScheduler` now calls `stop` before re-starting.
- **TrackmanWebhookEventsSection timeout cleanup**: All three `setTimeout(() => setAutoMatchResult(null), 5000)` calls in `handleAutoMatch` now use an `autoMatchTimeoutRef` with `useEffect` unmount cleanup, preventing state updates on unmounted components.
- **Empty catch block fix**: `server/core/trackman/service.ts:749` now logs a warning with booking ID instead of silently swallowing errors during legacy unmatched entry resolution.

## [8.77.1] - 2026-03-04

### Code Quality Audit Fixes
- **Global Express Error Middleware**: Added catch-all `(err, req, res, next)` error handler at the end of the Express middleware chain in `server/index.ts`. Any unhandled route error now returns a JSON `{ error: 'Internal server error' }` with 500 status instead of a raw HTML page. Uses `getErrorStatusCode` for proper status propagation.
- **Eliminated `as any` Casts**: Removed all `as any` type casts from server code. `server/utils/resend.ts` now uses a typed `ResendConnectionSettings` interface. `server/routes/hubspot.ts` now uses `getErrorStatusCode()` from `errorUtils.ts` instead of `(err as any)?.code` chains.
- **Enhanced `getErrorStatusCode`**: `server/utils/errorUtils.ts` now checks `error.response.status` (nested object) in addition to `error.statusCode`, `error.status`, and `error.code` — properly handles HubSpot SDK error objects.
- **Consolidated Date Formatting**: `src/utils/dateUtils.ts` gained `formatDatePacific()` and `formatTimePacific()` exports. `RedeemPassCard.tsx` now imports shared date utilities instead of defining local duplicates.

### Bug Fixes
- **CafeTab controlled/uncontrolled fix**: Added `|| ''` fallback to `value={newItem.category}` in `CafeTab.tsx` select input to prevent React controlled/uncontrolled warnings when category is undefined.
- **AdminDashboard circular import fix**: Replaced barrel import from `./layout` with direct imports from individual modules (`./layout/types`, `./layout/StaffBottomNav`, `./layout/StaffSidebar`, etc.) to reduce HMR invalidation chain and fix Vite HMR churn.
- **AdminDashboard training step inputs**: Added `|| ''` fallback to `step.title` and `step.content` inputs in the TrainingSectionModal to prevent controlled/uncontrolled warnings.
- **TodayScheduleSection null crash fix**: Changed `nextEvent &&` to `nextEvent != null &&` before using the `in` operator, preventing TypeError when `nextEvent` is null/undefined.
- **AlertsCard null guard**: Added `(notifications || [])` guard on `.filter()` and `!notifications ||` check on `.length` to prevent crash when notifications prop is null/undefined.

## [8.77.0] - 2026-03-03

### Bug Audit Fixes
- **Orphaned Promise Fix**: `useAsyncAction` debounce now resolves superseded promises with `undefined` instead of leaving them hanging forever — prevents frozen UI when users triple-click buttons.
- **Webhook TOCTOU Race**: `recordDayPassPurchaseFromWebhook` now catches `day_pass_purchases_stripe_pi_unique` constraint violations gracefully, matching the client-facing `/confirm` routes — prevents Stripe webhook retry storms from duplicate webhook bursts.
- **Zombie Tier Sync Prevention**: `queueTierSync` now cancels both `pending` AND `failed` jobs (was only `pending`), preventing stale failed jobs from waking up via exponential backoff and overwriting the correct tier in HubSpot.
- **Queue Status Accuracy**: Aborted tier sync jobs now marked as `superseded` instead of `completed` — keeps queue monitoring metrics accurate and distinguishes cancelled jobs from successful ones. DB idempotency index updated to exclude `superseded`.
- **HubSpot Queue Throughput**: Scheduler interval reduced from 2 minutes to 30 seconds, batch size increased from 20 to 50 — eliminates multi-hour queue backlogs after bulk operations.
- **Stripe Idempotency Keys**: All 7 non-deterministic Stripe idempotency keys replaced with 5-minute time-bucketed keys (`Math.floor(Date.now() / 300000)` + business identifiers). Prevents duplicate charges/customers/subscriptions on network retries. Affected: `quick-charge.ts` (guest POS, saved card POS), `subscriptions.ts`, `customers.ts`, `groupBilling.ts` (corp add/remove), `memberBilling.ts` (coupon creation).
- **Empty Directory Cold Boot**: First staff member to open the Member Directory after a server restart now waits for the initial HubSpot sync instead of seeing an empty list. Subsequent requests still use the 30-minute cache with background refresh.
- **Last Admin Deletion Bypass**: `DELETE /api/staff-users/:id` now checks if the target is the last active admin before allowing deletion, matching the safeguards already present in the admin-specific routes.
- **Late Cancellation Fee Collection**: `cancelPendingPaymentIntentsForBooking` now gated behind `!shouldSkipRefund` in member-cancel route — previously killed the Stripe PaymentIntent even on late cancellations, making forfeited fees permanently uncollectible.
- **Guest Pass Double-Refund**: Pre-check-in booking cancellations no longer call `refundGuestPass()` — deleting the `guest_pass_holds` row is sufficient. Previously both the hold delete and the refund ran, driving `passes_used` to -1 and granting infinite guest passes.
- **Availability Lock Missing Pending Requests**: `checkUnifiedAvailabilityWithLock` now checks `booking_requests` for pending conflicts, matching the standard `checkUnifiedAvailability`. Previously staff/Trackman bookings could double-book over pending member requests.
- **Zombie Booking Resurrection**: Trackman import no longer frees and recreates bookings in `cancellation_pending` status. Previously the sync would see Trackman still showing "approved", detach the Trackman ID, and create a brand-new active booking — reversing the member's cancellation. Now `cancellation_pending` bookings are skipped entirely.
- **Orphaned Placeholder Sessions**: Trackman placeholder merge now checks `!placeholder.session_id` before creating a session, matching other code paths. Previously merging into a placeholder that already had a session created a second orphaned session.
- **Stripe Reconciliation Scheduler**: Runs initial check on startup and polls every 5 minutes (was 60 minutes). Previously a restart at 5:01 AM would skip the entire day's financial reconciliation.
- **Background Sync Idempotency**: `startBackgroundSyncScheduler` now guards against double-initialization with `if (currentTimeoutId) return`. Previously hot-reloads could spawn duplicate sync loops that doubled API requests and leaked memory.
- **Corporate Infinite Free Seats**: `addCorporateMember` now enforces `max_seats` limit inside the transaction, before inserting the new member. Previously there was no validation — admins could add unlimited members beyond the pre-paid seat count, all for free.
- **Guest Pass Balance Hallucination**: `getGuestPassesRemaining` now reads from the `guest_passes` ledger table (`passes_total - passes_used`) instead of dynamically counting `booking_participants`. The old calculation missed manual deductions, POS usage, and tier changes, showing a different balance than what Stripe enforced.
- **Undeletable Deactivated Billing Groups**: `deleteBillingGroup` now checks `isActive !== false` alongside `primaryStripeSubscriptionId`. Previously, cancelled groups kept their subscription ID forever, permanently blocking deletion.
- **Mixed POS Full Refund**: Booking cancellation refunds now use `participant.cachedFeeCents` (the exact guest fee amount) instead of looking up the full PaymentIntent amount. Previously, if a POS payment covered both a guest fee and cafe items, cancelling the guest fee refunded everything.
- **Subscription Webhook Staff Demotion**: `subscription.created` webhook ON CONFLICT no longer overwrites `role = 'member'` unconditionally. Staff and admin roles are preserved.
- **Advisory Lock Key Mismatch**: `ensureSessionForBooking` now uses Postgres `hashtext()` with `::` separator, matching the booking route's `hashtext(resource_id || '::' || request_date)`. Previously it used a JS bitwise hash with `:` separator — both the algorithm and format differed, so both code paths generated different lock integers for the same resource, allowing concurrent double-bookings.
- **Double-Tap Check-in Race Condition**: Walk-in check-in now runs inside `db.transaction()` with `SELECT ... FOR UPDATE` on the user row. Previously two simultaneous NFC taps could both pass the "recent check-in" guard, doubling `lifetime_visits` and sending duplicate alerts.

## [8.76.0] - 2026-03-01

### Concurrency & Data Integrity Fixes
- **Waitlist Promotion Race Condition**: `FOR UPDATE SKIP LOCKED` on waitlist promotion now runs inside `db.transaction()` — previously the lock was released immediately because it ran on the global pool outside a transaction. Two simultaneous cancellations could promote the same waitlisted user.
- **Trackman Reconciliation Atomicity**: `recordUsage()` and the reconciliation status UPDATE are now wrapped in a single `db.transaction()`. If either fails, both roll back — prevents double-charges when staff retries a failed adjustment.
- **Timezone-Safe DOW Matching**: Recurring wellness class bulk updates replaced `new Date(dateStr).getDay()` (which evaluates in server timezone, shifting the day) with `EXTRACT(DOW FROM dateStr::date)` in SQL, letting PostgreSQL handle the day-of-week calculation correctly.
- **Manual Enrollment Notifications**: Staff-initiated wellness enrollments now send in-app notification, push notification, and WebSocket broadcast to both the enrolled member and staff dashboards — previously the member received zero communication.

## [8.75.0] - 2026-02-28

### Security & Reliability Audit Fixes
- **Rate Limiting**: Global rate limiter corrected — authenticated users get 2,000 req/min, anonymous users get 600. Previously reversed.
- **HubSpot Queue Idempotency**: `queueIntegrityFixSync` and `queueTierSync` idempotency keys now use daily bucket (`Math.floor(Date.now() / 86400000)`) instead of raw `Date.now()` which defeated duplicate prevention.
- **Announcement Banner**: `showAsBanner` column added to Drizzle schema (`shared/models/content.ts`). Banner create/update operations wrapped in `db.transaction()` for atomicity. Banner query and access use native Drizzle column references instead of raw SQL casts.
- **HubSpot Webhook Notifications**: `activeStatuses` in webhook handler includes `past_due` to prevent false "New Member Activated" notifications when members recover from delinquent billing.
- **Tier Update Safety**: `PUT /api/hubspot/contacts/:id/tier` no longer force-sets `membershipStatus: 'active'` — preserves billing states like `past_due`.
- **HubSpot Token Deduplication**: `getHubSpotAccessToken()` now uses a shared promise for concurrent token refresh requests, preventing thundering herd 429 rate limit errors from the Replit connector API (10 req/s limit).
- **HubSpot Deal Sync Removed**: All membership deal syncing completely removed — no more deal creation, line items, pipeline stages, deal stage drift checks. Contact syncing preserved (findOrCreateHubSpotContact, syncTierToHubSpot, updateContactMembershipStatus). Deleted files: `server/routes/hubspotDeals.ts`, `server/core/hubspotDeals.ts`, `server/core/hubspot/lineItems.ts`, `server/core/hubspot/pipeline.ts`, `server/core/stripe/hubspotSync.ts`. Settings page renamed "HubSpot Contact Mappings" (pipeline ID and stage IDs removed, tier/status mappings kept).
- **CSV Parser**: Tier sync CSV parser rewritten to handle RFC 4180 escaped double quotes (`""` inside quoted fields), preventing data corruption on fields containing commas or quotes.
- **React Safety**: `useAsyncAction` adds cleanup `useEffect` to clear debounce timers on unmount. `NewUserDrawer` cooldown timer side effects moved out of state updater into `useEffect`. Mode switch calls `resetForm()` to prevent stale form data.
- **safeDbTransaction**: Rewritten to use Drizzle's native `db.transaction()` instead of raw `PoolClient`, ensuring Drizzle queries participate in the transaction.
- **HubSpot Status Code**: `remove-marketing-contacts` endpoint returns 422 instead of 500 for missing HubSpot property configuration.
- **Date Parsing**: `last_manual_fix_at` parsing uses `instanceof Date` check for safe handling of both Date objects and ISO strings.

## [8.74.0] - 2026-02-26

### Admin Settings Expansion
- **Settings Infrastructure**: Key-value store in `system_settings` table, cached via `settingsHelper.ts` (30s TTL), bulk save via `PUT /api/admin/settings`. Public settings exposed via unauthenticated `GET /api/settings/public` (contact, social, apple_messages, hours_display categories only). App Display Settings (club name, support email, timezone) and Purchase Category Labels sections were removed — they were not wired to any consumers.
- **Contact & Social Media**: Phone, email, address, Google/Apple Maps URLs, social media links (Instagram, TikTok, LinkedIn), Apple Messages for Business (toggle + Business ID), display hours configurable from admin settings. Contact page and Footer read from settings with hardcoded fallbacks.
- **Resource Operating Hours**: Availability hours are derived from the Display Hours settings (`hours.monday`, `hours.tuesday_thursday`, `hours.friday_saturday`, `hours.sunday`) — parsed per day of week with minute-level precision. Monday "Closed" = no bookable slots. "8:30 AM – 8:00 PM" = slots from 8:30 AM to 8:00 PM. Display Hours UI uses time picker selects (30-min increments) with Closed checkbox per day group. Per-resource slot durations (golf=60, conference=30, tours=30) are individually configurable. Wellness & Classes have no configurable hours (Google Calendar events). All business hours consumers read from settings: `getResourceConfig(type, date?)` in `config.ts`, `getBusinessHoursFromSettings(date)` in `availability.ts`, staff conference booking route, and frontend `isFacilityOpen(displayHours?)` in `dateUtils.ts`.
- **HubSpot Contact Mappings**: Tier name mappings and status mappings configurable from admin settings. Async wrapper functions (`getDbStatusToHubSpotMapping`, `getTierToHubSpotMapping`) read from settings with hardcoded fallbacks. Pipeline ID and stage ID settings removed (deal sync fully removed).
- **Notification & Communication**: Daily reminder hour, morning closure hour, onboarding nudge hour, grace period hour/days, max onboarding nudges, and trial coupon code all read from settings at runtime via `getSettingValue()`. HubSpot stage/tier/status collapsible sections in UI use expand/collapse pattern.

## [8.73.0] - 2026-02-24

### Booking Data Integrity Fixes
- **Owner slot link sync**: When staff links a member to an empty owner slot via `PUT /api/admin/booking/:bookingId/members/:slotId/link`, the `booking_requests` row (`user_id`, `user_email`, `user_name`) is now updated to match the new owner. Previously, the participant record was updated but the booking header still showed the original Trackman import name, causing a visible mismatch between the booking title and the roster owner.
- **Booking source enum fix**: `revertToApproved()` and the Member Balance endpoint (`/api/member/balance`) no longer use `COALESCE(bs.source, '')` to check for Trackman-sourced sessions — PostgreSQL rejected the empty string as an invalid `booking_source` enum value. Fixed to use `(bs.source IS NULL OR bs.source::text NOT IN (...))`, which correctly handles NULL sources without enum coercion errors.

## [8.72.0] - 2026-02-22

### Staff Admin UX Robustness
- **Resume subscription confirmation**: Resume button now opens a confirmation modal (`ConfirmResumeModal`) instead of firing immediately — prevents accidental resumption of paused subscriptions.
- **Billing source change confirmation**: Billing provider dropdown changes now route through `ConfirmBillingSourceModal` showing current→new source before executing, preventing accidental billing source switches.
- **Tier sync coalescing**: `queueTierSync` cancels any pending/failed `sync_tier` jobs for the same email before enqueueing a new one. Rapid A→B→C tier changes result in a single HubSpot sync for the final tier, not three separate jobs.
- **Unsaved changes guard**: `MemberProfileDrawer` warns staff with a `window.confirm` dialog when closing with unsaved notes or communication drafts. Backdrop click, close button, and escape all route through `handleDrawerClose`.
- **Mutation button disable**: All billing mutation buttons (`StripeBillingSection`) properly use `disabled={isPending}` during async operations to prevent double-clicks.
- **Toast/haptic consistency migration**: Older admin components (`BugReportsAdmin`, `DiscountsSubTab`, `ApplicationPipeline`) migrated from `console.error` or custom inline toast state to the global `useToast` + `haptic` utilities for consistent success/error feedback across all staff actions.

## [8.71.0] - 2026-02-20

### HubSpot Webhook-First Inbound Sync
- **Webhook-first architecture**: The `POST /api/hubspot/webhooks` endpoint is the primary inbound sync mechanism. All HubSpot `contact.propertyChange` events are processed in real-time, replacing the 5-minute incremental poll.
- **Profile property handling**: Webhooks handle all profile fields (firstname, lastname, phone, address, city, state, zip, date_of_birth, mindbody_client_id, membership_start_date, discount_reason, opt-in preferences) with COALESCE rules — only fill empty DB fields, never overwrite existing data. Opt-in fields and `membership_discount_reason` always overwrite (HubSpot is authoritative for communication preferences).
- **Protection rules**: Skip archived users, skip sync_exclusions, STRIPE WINS for status/tier on Stripe-billed members, skip visitors for status changes, skip unknown users (no upsert from webhooks).
- **Weekly reconciliation**: Full member sync (`syncAllMembersFromHubSpot`) changed from daily 3 AM to weekly Sunday 3 AM Pacific. Acts as a safety net to catch any missed webhooks.
- **5-minute incremental poll removed**: The `INCREMENTAL_SYNC_INTERVAL` and `fetchRecentlyModifiedContacts` polling logic removed from the contact cache. Cache still refreshes every 30 minutes and is invalidated instantly when webhooks fire.

## [8.70.0] - 2026-02-18

### HubSpot Outbound Sync Hardening
- **`findOrCreateHubSpotContact`**: When an existing contact is found, updates lifecycle stage (`customer` for members, `lead` for visitors/day-pass) and `membership_status` without downgrading `customer`→`lead`. Fills missing name/phone. Clears lifecycle before setting (HubSpot API requirement). Restores previous lifecycle on failure to prevent blank lifecycle states.
- **`syncDayPassPurchaseToHubSpot`**: Promotes existing contacts from dead lifecycle stages to `lead` without downgrading `customer`. Fills missing names during promotion.
- **`syncMemberToHubSpot` fallback**: Looks up user's name from the database before calling `findOrCreateHubSpotContact` instead of passing empty strings.

### HubSpot Sync Filtering
- **API-Level Filtering**: `syncAllMembersFromHubSpot` uses `searchApi.doSearch()` with filter groups: meaningful statuses (`active`, `trialing`, `past_due`, `pending`, `suspended`, `declined`, `frozen`) OR contacts with `mindbody_client_id` (billing history). Dead statuses (`non-member`, `archived`, `cancelled`, `expired`, `terminated`) excluded at the API level unless they have Mindbody billing history.
- **Archived User Protection**: Both sync functions skip any local user where `archived_at IS NOT NULL`. Only manual staff action can un-archive a user — HubSpot sync cannot resurrect archived records.
- **Non-Transacting Safety Net**: New contacts with dead statuses and no Mindbody ID are not imported into the users table (secondary guard behind API-level filter).
- **Dev Stripe Check Suppression**: In non-production environments, the "Billing Provider Hybrid State" integrity check skips the `billing_provider='stripe' AND stripe_subscription_id IS NULL` condition — Stripe env validation clears production subscription IDs in test mode, making this check produce false positives.

## [8.69.0] - 2026-02-16

### Codebase Modularization
- **Backend Modular Splits**: Large monolithic files split into sub-module directories with barrel re-exports (all external import paths unchanged):
  - `server/core/stripe/webhooks/` — Webhook dispatcher + 8 handler files (was `webhooks.ts`, 6,149 lines)
  - `server/core/trackman/` — CSV import pipeline in 7 files (was `trackmanImport.ts`, 4,213 lines)
  - `server/routes/trackman/admin.ts` — Split into `admin-resolution.ts`, `admin-roster.ts`, `admin-maintenance.ts` (was 4,040 lines)
  - `server/core/integrity/` — Data integrity checks in 8 files (was `dataIntegrity.ts`, 3,891 lines)
  - `server/routes/stripe/payments.ts` — Split into `booking-fees.ts`, `quick-charge.ts`, `payment-admin.ts`, `financial-reports.ts` (was 3,160 lines)
  - `server/core/resource/` — Resource service in 6 files (was `resourceService.ts`, 2,566 lines)
  - `server/routes/dataTools/` — 5 sub-routers: `member-sync.ts`, `booking-tools.ts`, `audit.ts`, `stripe-tools.ts`, `maintenance.ts` (was `dataTools.ts`, 2,683 lines)
- **Frontend Modular Splits**:
  - `src/pages/Admin/tabs/dataIntegrity/` — 6 sub-components + hooks (was `DataIntegrityTab.tsx`, 2,314 lines)
  - `src/pages/Admin/tabs/directory/` — 9 sub-components + hooks (was `DirectoryTab.tsx`, 2,233 lines)
  - `src/components/admin/memberBilling/` — 11 sub-components + hooks (was `MemberBillingTab.tsx`, 2,130 lines)

### WebSocket & Safety Fixes
- **WebSocket Zombie Prevention**: Client-side `useWebSocket` hook uses `intentionalCloseRef` + stale-socket guard (`wsRef.current === ws`) to prevent zombie reconnection loops on unmount or rapid email changes.
- **Rate Limiter Crash Fix**: Rate limiter key generators use `String()` coercion before `.toLowerCase()` to prevent TypeError crashes from non-string input.
- **Event Loop Cleanup**: In-memory lock cleanup interval uses `.unref()` to avoid pinning the event loop on server shutdown.
- **Advisory Lock Safety**: `ensureSessionForBooking` uses `pg_advisory_xact_lock` when an external client (in-transaction) is passed to prevent lock leaks in aborted transactions; session-level `pg_advisory_lock` with explicit unlock when managing its own client.


## [8.68.0] - 2026-03-04

### Invoice & Booking Data Integrity
- **Fix**: Draft invoices are now properly deleted and booking references cleared when bookings are cancelled — prevents orphaned invoice records from blocking future billing
- **Fix**: Invoices are voided when bookings are permanently deleted — prevents stale charges from lingering in Stripe
- **Fix**: Duplicate bookings and charges prevented with improved data integrity checks — advisory locks and optimistic locking ensure atomic operations
- **Fix**: Booking fee estimates no longer overcharge — fee calculation correctly accounts for already-paid participants and avoids cached_fee_cents overwrite
- **Feature**: Staff can mark all stale bookings as attended in bulk — new action in the data integrity dashboard clears backlogged 'confirmed' bookings past their session date
- **Fix**: Booking and authentication system reliability improved — session revalidation, WebSocket reconnect, and OTP rate limiting hardened

## [8.67.0] - 2026-03-04

### Fee Calculation & Guest Pass Fixes
- **Fix**: Fee calculation and guest pass tracking corrected — usage lookups now sum both userId and email entries to prevent double-dipping across booking types
- **Fix**: Missing payment update flag added to user accounts — ensures payment method changes propagate correctly during billing operations
- **Fix**: Booking payments and notification delivery fixed — prevents duplicate notification sends and ensures payment status transitions are atomic

## [8.66.0] - 2026-03-04

### OTP Security & Atomic Cancellations
- **Fix**: OTP verification now uses three-tier rate limiting (per-IP+email, per-IP global, per-email aggregate) — prevents brute-force attempts while avoiding lockout of legitimate users
- **Fix**: Booking cancellation improved — status change and usage ledger cleanup are now transactional, with Stripe refund, guest pass release, and calendar deletion as reliable post-commit operations
- **Fix**: Booking errors prevented when source values are invalid — server-side validation rejects malformed booking source fields
- **Fix**: User account creation and payment processing made more reliable — handles edge cases with missing Stripe customer IDs

## [8.65.0] - 2026-03-03

### Simulator Tab & Calendar Improvements
- **Feature**: Current time indicator added to the booking calendar grid — a red line marks the current time so staff can see at a glance what's happening now
- **Feature**: Simulator tab now supports date navigation and route-level prefetching — faster tab switches and smoother browsing between days
- **Fix**: Simulator tab crashes fixed — notification update listeners no longer cause React state updates on unmounted components
- **Fix**: Alerts card list items now have proper spacing and visual separation
- **Fix**: Redundant booking request database index removed — prevents recreation on every migration push
- **Fix**: Staff sidebar properly fits tablets and iPads — navigation rail adjusts to viewport width

## [8.64.0] - 2026-03-03

### Subscription & Payment Method Management
- **Fix**: Saved payment methods now display correctly for all users — retrieval logic improved to handle both Stripe and local payment records
- **Fix**: Payment method prioritization improved — default card selection now accounts for card expiry and last-used date
- **Fix**: Card expiry notifications improved — warnings sent before cards expire instead of after
- **Fix**: Subscription creation now uses saved cards for payment — members no longer need to re-enter card details
- **Fix**: Ownership validation added for subscription management — members can only modify their own subscriptions
- **Fix**: Direct invoice links added to subscription management — members can view and pay outstanding invoices inline
- **Fix**: Incomplete subscriptions handled gracefully during authentication — prevents login failures when a subscription is mid-setup
- **Fix**: Waiver modal scrolling and visibility detection improved — completion button only appears when the full document is visible
- **Fix**: Member profile drawer auto-closes after billing actions and refreshes directory data
- **Fix**: Member billing management enhanced with better error handling and real-time WebSocket updates

## [8.63.0] - 2026-03-03

### Trackman Session Management & Staff Lessons
- **Feature**: Additional players can now be assigned to Trackman sessions and bookings — staff can manage participant rosters directly from the session view
- **Feature**: Participant transfer logic added to session creation — when Trackman auto-approves via webhook, all booking participants are transferred to the new session
- **Feature**: Additional player details shown on unmatched booking requests — staff see full roster info before matching
- **Improvement**: Booking approvals separated from session creation — cleaner code path for staff confirmation vs Trackman webhook confirmation
- **Improvement**: Staff golf lessons no longer create facility closure notice records — only availability blocks are created, keeping the notices feed clean
- **Cleanup**: Legacy booking review process removed from the application interface — replaced by the Trackman-integrated approval flow

## [8.62.0] - 2026-03-04

### Dev Confirm Moved to Trackman Modal
- **Improvement**: 'Skip Trackman (Dev Confirm)' button moved inside the Book on Trackman modal — sits right below the normal Confirm Booking button so the entire booking workflow lives in one place
- **Cleanup**: Removed standalone Dev Confirm button from booking request queue cards for a cleaner layout

## [8.61.0] - 2026-03-03

### Booking Participant Fix & Billing Diagnostics
- **Fix**: Members can now add other members to simulator booking requests without the 'Invalid participant email' error — redacted emails (privacy mode) are no longer sent as participant data; the server resolves member info from userId instead
- **Fix**: 'Dev Confirm' button on booking requests no longer fails with 'Failed to confirm booking' — removed an invalid database constraint reference that was crashing the participant insertion and rolling back the entire confirmation
- **Improvement**: MindBody member billing lookups now log Stripe environment mode and payment method count for faster troubleshooting
- **Improvement**: Warning logged when a MindBody member has no Stripe customer ID linked, with guidance to use the 'Link Stripe Customer' button

## [8.60.0] - 2026-03-03

### Cleaner Booking Request Flow
- **Improvement**: Estimated fees card removed from the simulator booking request page — members now see a clean 'Request Booking' button without confusing fee estimates that don't account for the final roster
- **Perf**: Fee estimate API call no longer fires during simulator booking requests — reduces unnecessary server load since fees are only relevant after staff confirms the booking

## [8.59.0] - 2026-03-03

### Application Pipeline & Booking Request Fixes
- **Fix**: Application pipeline no longer shows 'Feb NaN' for form submission dates — date formatter now correctly handles PostgreSQL timestamp format
- **Fix**: Members can now request bookings with other members — participant email validation no longer rejects members selected from the directory when their email isn't required (userId is sufficient)

## [8.58.0] - 2026-03-02

### Subscription & Payment Safety
- **Fix**: Duplicate membership creation prevented — per-email operation locks ensure only one membership can be created at a time for the same member
- **Fix**: Duplicate subscription creation prevented — rate limiter and in-memory lock mechanism block concurrent submission attempts for the same email
- **Fix**: Existing Stripe subscriptions can now be reused instead of creating duplicates — new endpoint refreshes payment intents with idempotency keys
- **Fix**: Terminal payment processing now uses refs to accurately track processing state, cancels terminal reader on unmount, and syncs cleanup correctly
- **Fix**: Member reactivation now properly clears archived status across all Stripe-related flows — reactivated members are no longer stuck as archived
- **Fix**: Membership activation notifications are now delayed until payment is confirmed — prevents premature welcome messages
- **Fix**: Stripe customer management improved for billing and card saving operations — more reliable customer lookup and creation
- **Fix**: New and updated member subscriptions now properly clear archived status — pending members correctly appear in directory filters
- **Fix**: Group pricing discounts now apply correctly during payment and activation

## [8.57.0] - 2026-03-01

### Billing, Notifications & Data Integrity Fixes
- **Fix**: Booking fee calculation now correctly filters out cancelled bookings and prioritizes specific booking IDs in financial summary
- **Fix**: Booking participant validation allows members without email when userId is provided — Zod schema updated to prevent data loss
- **Fix**: Marketing contact removal now instantly updates counts and properly logs webhook events
- **Fix**: Waiver review notifications now use persistent database-level deduplication with a 6-hour window — prevents repeated alerts
- **Fix**: 'Bookings Stuck — Unpaid Fees' notifications use 6-hour deduplication and only flag past bookings with 'attended' status
- **Fix**: Fee calculations correctly handle members without identified tiers in preview mode
- **Fix**: Invoices are now ensured for all attended bookings — prevents missing billing records
- **Fix**: Booking refund date handling corrected in approval service — prevents premature refund status updates
- **Fix**: Foreign key constraints corrected for booking participants and schema field name mismatch resolved
- **Fix**: HubSpot sync timezone issues corrected — dates now properly handled across timezones
- **Fix**: Silent zero balance reporting in member billing now surfaces correctly
- **Fix**: Frontend fetch requests now use AbortController with proper cleanup — prevents race conditions on rapid navigation
- **Fix**: System settings inserts now include required category and updatedBy fields
- **Fix**: Player count indicator no longer shows for conference room bookings on the dashboard
- **Fix**: Data export queries now include proper LIMIT clauses to prevent oversized responses
- **Fix**: One-time fee collection now properly reports payment failure status
- **Fix**: Wellness calendar sync SQL queries now use null coalescing — prevents crashes when Google Calendar returns undefined fields during sync
- **Fix**: Wellness availability block creation now properly handles null notes and class IDs — prevents insertion errors
- **Fix**: Dashboard booking requests query now capped at 200 results — prevents oversized responses on member dashboard
- **Fix**: Member dashboard calculations memoized — prevents unnecessary re-computation on re-renders
- **Feature**: Staff can now view and manage conference room prepayments on behalf of other members
- **Feature**: Staff-only AI image generation endpoint added for creating club marketing visuals
- **Infra**: Stripe auto-refund job queue type added for processing overpayment refunds asynchronously
- **Infra**: ESLint updated to latest major version to resolve dependency conflicts
- **Infra**: Input validation added across API endpoints with Zod schemas
- **Infra**: Route index auto-generation script added for developer reference
- **Infra**: Staff training guide updated with current Trackman webhook modification documentation

## [8.56.0] - 2026-03-01

### Performance & Crash Fixes — Wellness, Dashboard, History
- **Fix**: Wellness page no longer crashes on load — server now caps active_only queries to a 60-day window (333 classes → ~16), cutting payload from 200KB to 18KB (91% reduction)
- **Fix**: Dashboard no longer over-fetches all 333 wellness class objects — added LIMIT 5 to the 'Next Wellness Class' query since the dashboard only displays one
- **Perf**: Wellness page now uses progressive rendering (20 classes at a time with 'Show More') instead of rendering all classes at once — eliminates DOM thrashing on large lists
- **Perf**: Wellness page memoized sortedClasses, enrollment Set/Map for O(1) lookups, and wrapped ClassCard in React.memo — prevents unnecessary re-renders on scroll and filter changes
- **Perf**: Removed useAutoAnimate from Wellness class list — auto-animate refs on large unbounded lists cause layout thrashing and crashes
- **Perf**: History page visits tab now uses progressive rendering (20 at a time with 'Show More') instead of rendering all past visits at once
- **Perf**: History page payments tab now uses progressive month rendering (3 months at a time with 'Show More') instead of rendering all payment months at once
- **Perf**: CalendarGrid memoized sortedResources array — was being re-sorted on every render in two places; now computed once with useMemo

## [8.55.0] - 2026-03-01

### Membership Apply & Conditional Animation Crash Fixes
- **Fix**: Membership application page no longer crashes on load — replaced useBlocker (requires data router) with a BrowserRouter-compatible unsaved changes guard
- **Fix**: Facility page no longer crashes when switching between Notices and Blocks tabs — removed auto-animate refs from conditionally rendered elements (known auto-animate issue with conditional parents)
- **Fix**: Codebase-wide audit removed the same crash-prone auto-animate pattern from 6 additional pages — Directory, Changelog, History, Events, Wellness, and Booking Requests panels all had animation refs on tab-conditional elements that could crash on tab switch

## [8.54.0] - 2026-02-28

### 3D Secure Broadcast & Webhook Lock Fixes
- **Fix**: Off-session card payments requiring 3D Secure authentication now broadcast 'payment_requires_action' instead of misleading 'payment_confirmed' — staff UI no longer shows a false success when the member's bank requires additional verification
- **Fix**: Booking-fee fallback query in payment webhook now uses FOR UPDATE row locking — prevents concurrent webhook retries from double-processing the same participant payments

## [8.53.0] - 2026-02-28

### Crash Recovery & Atomicity Fixes
- **Fix**: add_funds balance credit now executes inside the webhook handler (not deferred) — if the Stripe API call fails, the webhook returns 500 and Stripe retries instead of silently losing the member's money
- **Fix**: Trackman auto-approve booking now wraps status update + session creation in a database transaction — a server crash can no longer leave a booking stuck in 'approved' with no billing session
- **Fix**: Trackman booking modification now wraps booking_requests + booking_sessions updates in a single transaction — prevents time/bay/date drift between the two tables if the connection drops mid-update
- **Fix**: Payment polling in the Staff booking sheet now uses an isFetching guard to prevent promise piling — slow network responses no longer cause overlapping fetches that thrash the UI with stale data

## [8.52.0] - 2026-02-28

### Financial Exploit & Race Condition Fixes
- **Fix**: Guest pass hold-to-usage conversion now uses MIN(passes_held, passes_needed) — prevents a malicious or glitching client from holding 1 pass but getting 3 guests marked as paid
- **Fix**: Guest participant payment_status marking now uses the actual number of passes deducted, not the billing result's requested count — closes the free-guest exploit completely
- **Fix**: Terminal (card reader) payment refunds now check invoice metadata for the terminal Payment Intent ID — cancelling a terminal-paid booking now issues a real card refund instead of incorrectly granting store credit
- **Fix**: Removed double guest pass refund in delayed Trackman webhook linking — a late-arriving webhook matching a cancelled booking no longer triggers a second pass refund (cancellation workflows already handle their own refunds)
- **Fix**: Duplicate visitor search now uses an isActive cleanup flag — prevents stale fetch responses from overwriting the correct duplicates list when the staff member types quickly

## [8.51.0] - 2026-02-28

### Critical Webhook & Billing Safety Fixes
- **Fix**: Stripe invoice idempotency key now uses deterministic booking + session IDs instead of timestamps — prevents duplicate invoices and double-charges on network retries
- **Fix**: Coupon retrieval during membership activation moved outside the database transaction — prevents connection pool exhaustion when Stripe API is slow during batch signups
- **Fix**: Trackman unmatched booking saves no longer crash on missing email, name, or reason fields — undefined values are properly coalesced to null for the database
- **Fix**: Stripe webhook lock ordering standardized — users table is always updated before hubspot_deals, eliminating a deadlock risk when subscription.created and invoice.payment_succeeded fire simultaneously
- **Fix**: Group billing status cascades no longer overwrite sub-member billing provider labels — family_addon and corporate members retain their correct billing type instead of being forced to 'stripe'
- **Fix**: Auto-refund calls for overpayment detection now include deterministic idempotency keys — prevents duplicate refunds if the webhook retries after a network timeout
- **Fix**: Deferred webhook actions in subscription creation now reference finalized member data instead of raw Stripe payload variables — prevents silent HubSpot sync mismatches if email normalization logic changes
- **Improvement**: Removed dead optimistic rollback code from the roster unlink flow — the snapshot was never used for optimistic UI and gave a false sense of protection

## [8.50.0] - 2026-02-28

### Search Portal Fix, Card Layout & Component Unification
- **Fix**: Member search dropdown no longer clips behind modals, drawers, or scrollable containers — results now render via a portal overlay that floats above all page content
- **Fix**: Click-outside detection now correctly closes the search dropdown even when no results are shown
- **Fix**: Segmented Button selected tab text is now fully readable in dark mode — changed from muted bone color to white
- **Improvement**: Add Member modal, Roster Manager, and Manual Booking modal now use the shared member search component instead of independent implementations — consistent search behavior and portaled results everywhere
- **Improvement**: Roster Manager search now filters out members already on the roster via ID-based exclusion, preventing duplicate additions
- **Improvement**: Book Golf, History, and Wellness pages now use M3 Segmented Button for tab switching instead of underline-style tabs — better touch targets and visual consistency
- **Improvement**: Events and Wellness cards now show a chevron indicator so it's clear they expand to reveal actions like RSVP and Cancel
- **Improvement**: Events and Wellness card lists use tighter spacing and reduced padding — content fills the screen width instead of floating in a narrow centered column
- **Improvement**: Dashboard schedule cards for RSVP'd events no longer show the club address — all events are at the club so the location line was redundant clutter

## [8.49.0] - 2026-02-28

### Phase 3: Architecture & Advanced Patterns
- **New**: Extended FAB — primary action buttons now show icon + text label, collapsing to icon-only on scroll for cleaner mobile UX
- **New**: M3 Search Bar component with pill-shaped design, debounced search, and full-viewport mobile expansion with recent searches and suggestions
- **New**: Bottom Sheet standard variant — non-blocking drawers that let you interact with content behind them, for filter panels and quick details
- **New**: Navigation Rail for tablet screens — a compact vertical icon bar replaces the hamburger menu on tablet-width screens for faster staff navigation
- **New**: ErrorFallback component with page, card, and inline variants — all error states now use consistent Liquid Glass styling with retry and support actions
- **New**: Unsaved changes warning — navigating away from partially-filled forms now shows a confirmation dialog, and form data persists across page refreshes
- **New**: Detail-level prefetch — hovering over booking cards or directory rows now pre-loads their detail data for instant navigation
- **New**: WebSocket health indicator — staff portal header shows a connection status dot, and a banner appears when live updates are paused or restored
- **Improvement**: Optimistic UI for profile edits, SMS preferences, and booking submissions — changes appear instantly with automatic rollback on errors
- **Improvement**: Admin skeleton loaders — Data Integrity, Financials, and Application Pipeline tabs now show structural loading placeholders instead of spinners
- **Improvement**: Dark mode glass readability — increased glass surface opacity and ensured body text on glass panels meets WCAG AA contrast standards
- **Improvement**: Accessibility — aria-labels added to all icon-only buttons across both portals for screen reader support
- **Improvement**: Profile page redesigned — edit button spans full card width, improved button spacing and visual hierarchy
- **Improvement**: Booking confirmation copy updated — simulator requests now show clearer, more descriptive confirmation text
- **Improvement**: Member portal page titles rewritten with evocative, instructional copy that matches the luxury brand voice
- **Improvement**: Mobile notice board layout refined with better spacing and card styling
- **Improvement**: Landing page sections updated with consistent premium layout, floating glass card hero design, and editorial italic headings

## [8.48.0] - 2026-02-27

### Marketing Contacts Audit Panel
- **New**: Marketing Contacts Audit panel added to Data Integrity tab — staff can now view all HubSpot marketing contacts, identify non-members incorrectly marked as marketing, and remove them directly from the admin dashboard
- **New**: Panel auto-refreshes after contact removal so staff see updated results immediately

## [8.47.0] - 2026-02-27

### Booking Auto-Complete & Fee Accuracy
- **Improvement**: Booking auto-complete scheduler now runs every 30 minutes instead of every 2 hours — past bookings are marked as completed faster
- **Improvement**: Auto-complete logic improved for overnight sessions and same-day bookings — correctly handles end times that cross midnight and completes bookings 30 minutes after their end time on the same day
- **Improvement**: Fee estimates now resolve member user IDs for more accurate per-player fee breakdowns when members are on the roster

## [8.46.0] - 2026-02-27

### TypeScript Strict Type Safety & Audio Fixes
- **Improvement**: Replaced hundreds of unsafe type casts (as any) across 190+ files with properly typed interfaces — eliminates an entire class of silent runtime bugs in billing, bookings, webhooks, and admin routes
- **Fix**: Notification and check-in sounds now reliably play on iOS and Android — audio context is unlocked on the first user interaction instead of failing silently
- **Fix**: Audit log detail viewer now displays structured typed fields instead of raw JSON for billing, booking, and notification events

## [8.45.0] - 2026-02-27

### Live Role Refresh on Session Check
- **Fix**: Staff/admin role changes now take effect immediately — the session endpoint re-checks the role from the database on every request instead of returning the stale role from login time

## [8.44.0] - 2026-02-27

### HubSpot Visitor Status Fix
- **Fix**: Bulk HubSpot sync tool now correctly passes user role — visitors are created as Non-Member/Lead instead of incorrectly receiving Active/Customer status

## [8.43.0] - 2026-02-27

### Smart Visitor Type Detection
- **Improvement**: New visitor creation during Trackman booking assignment no longer requires manual visitor type selection — system automatically detects Day Pass for Slot 1 (owner) and Member Guest for Slots 2-4
- **Removed**: Visitor Type dropdown from the Create New Visitor form in the booking assignment flow

## [8.42.0] - 2026-02-27

### Notification, Check-in & Connection Stability
- **Fix**: QR code booking check-in no longer gets stuck on 'processing' — check-in confirmation sound now plays only once even when multiple events arrive simultaneously
- **Fix**: QR check-in properly clears pending state when payment or roster action is required, preventing stale data on subsequent scans
- **Fix**: Supabase Realtime connection stability improved with better error handling, reconnection logic, and console spam eliminated
- **Fix**: Server-side Supabase auth requests now include timeouts to prevent hanging connections during outages
- **Fix**: Supabase Realtime setup gracefully handles missing RPC functions instead of crashing on startup
- **Fix**: Booking cancellation error details now surfaced to staff instead of showing generic failure messages
- **Improvement**: Booking modification notifications now display times in 12-hour format (e.g., '1:00 PM' instead of '13:00') for both staff and member notifications
- **Improvement**: Dev server startup improved with reliable parallel process management for frontend and backend
- **Removed**: Fee waiver email and push notifications to members — staff-only audit logging is preserved

## [8.41.0] - 2026-02-27

### Reschedule Feature Removed
- **Removed**: Staff reschedule feature (start/confirm/cancel routes) fully removed — booking modifications are now handled exclusively through Trackman webhooks
- **Removed**: Relocation cleanup scheduler no longer needed since reschedule flow is gone
- **Removed**: Booking reschedule email template and notification type
- **Removed**: Reschedule-from-ID parameter in staff manual booking creation
- **Cleanup**: Removed reschedule-related database schema columns (is_relocating, relocating_started_at, original_resource_id, original_start_time, original_end_time, original_booked_date, reschedule_booking_id) from Drizzle schema — existing database columns preserved but no longer referenced

## [8.40.0] - 2026-02-27

### Heritage Typography & Visual Polish
- **New**: App now uses Instrument Sans (variable, 400–700 weight) for all body text, labels, and UI elements
- **New**: Newsreader (variable serif) used for display and headline typography, establishing a luxury editorial aesthetic
- **Improvement**: Fonts loaded non-render-blocking via media='print' onload pattern with font-display: swap fallback — no impact on page load speed
- **Improvement**: Loading spinner automatically adapts to light and dark mode backgrounds
- **Improvement**: Staff portal navigation styling refined — header, sidebar, and hamburger menu updated for consistency with the editorial design system
- **Improvement**: Google sign-in reliability improved with a redirect fallback for browsers that block popups
- **Improvement**: Liquid Glass styling applied consistently to all staff command center cards
- **Improvement**: Day pass and payment redemption cards restyled to match the Liquid Glass design system
- **Improvement**: Trackman file upload now shows a progress bar during CSV processing

## [8.39.0] - 2026-02-27

### Member Schedule Dashboard Redesign
- **New**: Member schedule now uses a chronological card layout — bookings, events, and wellness sessions displayed as rich visual cards sorted by date and time
- **New**: Booking and event cards show player count (e.g., '2/4 players') so members can see roster status at a glance
- **New**: 'Add to Calendar' button on booking and event cards lets members save sessions to their phone calendar
- **New**: Event and wellness cards now show both start and end times instead of just the start time
- **Improvement**: Schedule cards redesigned with larger, more detailed visual elements for better readability on mobile
- **Improvement**: Booking confirmation notifications now appear directly on the member dashboard

## [8.38.0] - 2026-02-27

### Billing & Payment Reliability
- **New**: Invoice details (amount, status, line items) now included in member payment API responses — members can see exactly what they're paying for
- **New**: Active discounts (e.g., 'Comped Membership 100% off') now visible in the member billing section
- **New**: Discount and plan details now shown in subscription information — members can see their current pricing and any applied promotions
- **Fix**: $0 subscriptions now handled safely — free plans activate without attempting to charge, and invoices are automatically marked as paid
- **Fix**: Discount application to incomplete subscriptions no longer causes errors
- **Fix**: Subscription details display correctly for zero-priced and comped plans
- **Fix**: Billing links now reliably open in new tabs across all devices (iOS Safari, Android Chrome, desktop)
- **Fix**: Card charging made more reliable by handling audit log edge cases that could cause silent failures
- **Fix**: Customer credit balances now properly restored when bookings are cancelled with refunds
- **Fix**: Save card parameter now uses the correct Stripe API field, ensuring cards are saved for future use
- **Fix**: Waived payments now correctly counted when calculating roster fees and payment totals
- **Fix**: Booking fee status correctly reflects waived charges instead of showing as unpaid
- **Fix**: Booking expiration logic correctly handles overnight sessions that cross midnight

## [8.37.0] - 2026-02-27

### Roster & Booking Integrity
- **New**: Roster is now locked after payment is collected — players cannot be added or removed from a paid booking without an admin override with a logged reason
- **Fix**: Booking approval now correctly transfers all participants without creating duplicates
- **Fix**: Roster management improved for paid events — display and slot handling work correctly for bookings with collected payments
- **Fix**: Declared player count now included when modifying bookings, preventing slot count from resetting
- **Fix**: Booking status changes now reliably sync across all views (calendar, list, detail sheet)

## [8.36.0] - 2026-02-26

### Check-in & QR Code Enhancements
- **New**: Conference room bookings now support check-in via QR scan — same flow as simulator bookings
- **New**: Animated success overlay on booking confirmation modal — clear visual feedback when a booking is submitted
- **New**: Trackman auto-confirmation shows animated progress feedback when a booking is auto-matched
- **Improvement**: QR Scanner moved near 'New User' in the floating action button menu for faster staff access
- **Improvement**: QR booking context preserved when redirecting to payment or roster — staff no longer lose the booking reference mid-flow
- **Improvement**: Members now receive immediate visual feedback after being checked in, with a confirmation showing booking details (bay, time, resource type)
- **Improvement**: QR check-in confirmation now displays full booking details instead of just the member name
- **Improvement**: Check-in process refined for members with existing bookings — auto-detects today's scheduled sessions
- **Improvement**: ID scanning improved with automatic image resizing and increased upload limits for better accuracy on high-resolution phone cameras
- **Fix**: Guest pass duplicate records no longer cause constraint violations during creation
- **Fix**: Stripe customer accounts now automatically linked when matching member emails are found
- **Fix**: Member email changes now automatically sync to their Stripe customer record

## [8.35.0] - 2026-02-26

### Account Safety, Data Integrity & SEO
- **New**: Hidden navigation links added for search engine crawlers to improve site indexing and discoverability
- **New**: Supabase keep-alive scheduler prevents the project from hibernating during low-traffic periods
- **Improvement**: Database connections switched to Supabase session pooler for better connection management and reliability under load
- **Improvement**: Database functions hardened against SQL injection vulnerabilities with parameterized queries
- **Improvement**: Touch scrolling performance improved with passive native event listeners — smoother scrolling on mobile devices
- **Improvement**: Notification alert frequency now respects admin settings — staff can control how often integrity and sync alerts fire
- **Fix**: Guest pass records now properly merged when combining duplicate user accounts — prevents constraint violations
- **Fix**: Dismissed notice records now merged during user account merging — prevents notices reappearing for merged members
- **Fix**: Placeholder email patterns (e.g., 'noemail@placeholder.com') no longer block valid user accounts from being created with real emails
- **Fix**: Timestamps now consistently parsed as UTC across the application, preventing off-by-one-day errors in some timezones
- **Fix**: Webhook event timestamps display correctly in Pacific time on the admin dashboard
- **Fix**: Usage ledger entries now protected with a foreign key constraint to booking_sessions — prevents orphaned ledger records when sessions are deleted
- **Fix**: Google Calendar removed as a tour data source — HubSpot Meetings is now the sole source of truth for tours (Calendar still used for availability checks and creating events)
- **Fix**: Duplicate database index removed that was causing performance degradation
- **Fix**: robots.txt and security headers updated for better search engine indexing and site protection

## [8.34.0] - 2026-02-27

### Trackman Booking Modification Webhooks
- **New**: Trackman booking modifications (bay changes, time changes, date changes) are now automatically reflected in the app when Trackman sends a Booking Update webhook
- **New**: When staff move a booking to a different bay or adjust the time in Trackman, the app updates the booking, session, fees, and invoice automatically
- **New**: Staff receive real-time notifications when a Trackman booking is modified, with details about what changed
- **New**: Members receive push notifications when their booking is moved to a different bay or time
- **New**: Conflict detection runs on modified bookings — if the new slot has a conflict, staff are warned (Trackman remains source of truth)
- **New**: Booking modification events appear as 'booking.modified' in the Trackman webhook stats with a purple badge
- **Fix**: Webhook idempotency guard now includes content-aware signatures (bay, time, status) so modification webhooks are no longer incorrectly rejected as duplicates

## [8.33.0] - 2026-02-27

### Staff Command Center: React Query Migration & Instant Data Refresh
- **Performance**: Staff Command Center now uses React Query instead of raw fetch polling — eliminates ~50% of duplicate API calls on the admin dashboard
- **Performance**: Removed the 5-minute polling interval that re-fetched 14 endpoints every cycle — data now refreshes instantly via WebSocket events when bookings, tours, closures, or other data changes
- **Performance**: HubSpot contact lookups are now cached for 10 minutes (contacts rarely change) instead of re-fetched every 5 minutes
- **Improvement**: Stale data windows reduced from up to 5 minutes to near-instant — when a booking is approved, checked in, or cancelled, the Command Center reflects it immediately
- **Improvement**: Anti-flicker strategy ensures old data stays visible while new data loads in the background — no more blank screens during refreshes

## [8.32.0] - 2026-02-25

### Real-Time Sync Gap Audit & Fixes
- **New**: Trackman unmatched bookings now update in real time via Supabase Realtime — staff viewing the Trackman tab will see new unmatched bookings appear automatically
- **Fix**: Roster changes (adding/removing players) now refresh the booking list, admin calendar, simulator view, and financials across all open tabs — previously only the single booking detail refreshed
- **Fix**: Invoice changes (created, paid, voided) now refresh the financials dashboard and booking lists — previously only the specific booking detail and member history refreshed
- **Fix**: Waitlist changes now refresh booking availability and wellness class views across all open tabs — previously only the wellness page refreshed

## [8.31.9] - 2026-02-25

### Fix: Data Integrity & Sync Alert Toggle Now Respected
- **Fixed**: Toggling off 'Data Integrity Check Alerts' in Notification Settings now actually stops all data integrity notifications — previously the toggle was saved but the alert system never checked it
- **Fixed**: Toggling off 'Sync Failure Alerts' now stops HubSpot sync, calendar sync, and other external sync failure notifications
- **Fixed**: The nightly integrity check email alert also respects the toggle — no more midnight emails when alerts are disabled
- **Fixed**: Duplicate action icons on Stale Pending Bookings in the Data Integrity tab (open/cancel buttons appeared twice per booking)

## [8.31.8] - 2026-02-25

### Fix: Orphaned Session & Null Bay Guards on All Auto-Resolve Paths
- **Fixed**: 'Auto-resolve via same email' and 'auto-resolve via linked email' paths now detect orphaned session references (booking points to a deleted session) and create fresh sessions — previously only the main resolve path had this protection
- **Fixed**: Null bay assignment guard added to the 'auto-resolve via same email' path — prevents silent session creation failure when a booking has no bay assigned (linked-email path already had this guard)

## [8.31.7] - 2026-02-25

### Fix: Session Creation When Assigning Unmatched Trackman Bookings
- **Fixed**: Assigning unmatched Trackman bookings to members now reliably creates billing sessions — previously session creation could fail silently (e.g., missing bay assignment or orphaned session reference) and staff would see a success message without realizing no session was created
- **Fixed**: If a booking references a session that was deleted, the system now detects the orphaned reference, clears it, and creates a fresh session instead of silently skipping session creation
- **Improved**: Staff now sees a clear warning message when session creation fails during assignment, instead of a misleading success message

## [8.31.6] - 2026-02-25

### Fix: Dev/Production Scheduler Race Condition
- **Fixed**: Background schedulers (form sync, notifications, reminders, etc.) now only run in production — previously both dev and production ran the same schedulers against the shared database, causing a race condition where dev could steal notification triggers from production

## [8.31.5] - 2026-02-25

### Fix: Member Directory Search in Bookings
- **Fixed**: Members can now search for other active members when adding players to a booking — previously the member search returned no results because it relied on a staff-only data cache that regular members don't have access to

## [8.31.4] - 2026-02-25

### Android Compatibility Improvements
- **Fixed**: Modals and drawers no longer cause a visual page jump on Android — the iOS-specific position:fixed body hack is now only applied on iOS Safari, while Android uses the standard overflow:hidden approach
- **Fixed**: Scroll inside modals and drawers no longer leaks to the background page on Android — added overscroll-behavior:contain to scrollable containers
- **Improved**: Android users now see an 'Install' banner prompting them to add the app to their home screen — previously only iOS users saw the install prompt
- **Improved**: Form inputs inside modals and drawers now automatically scroll into view when the keyboard opens on Android — prevents inputs from being hidden behind the virtual keyboard
- **Improved**: PWA manifest now includes display_override for better Android standalone app behavior

## [8.31.3] - 2026-02-25

### Fix: Stripe Idempotency Bug & Android Scroll
- **Fixed**: Creating a VIP membership with a 100% coupon no longer crashes with a Stripe idempotency key conflict — the deterministic key collided on retries when parameters differed slightly between attempts
- **Fixed**: $0 memberships (100% coupon or free tiers) now activate instantly without a payment step — previously the flow showed a broken card entry screen or 'Payment Failed' error because Stripe returned a SetupIntent (seti_) which was incorrectly treated as a PaymentIntent
- **Fixed**: Switching from 'Enter Card' to 'Card Reader' on a $0 subscription no longer shows 'No such payment_intent' error — the server now detects $0 invoices and marks the subscription as a free activation, skipping the payment step entirely
- **Fixed**: Migrated Stripe subscription coupon application from deprecated root-level 'coupon' property to the modern 'discounts' array format
- **Fixed**: Billing tab 'Discounts' section now correctly shows active coupons (e.g. 'Comped Membership 100% off') — the subscription data mapper was missing the discount, planName, planAmount, currency, and interval fields from Stripe
- **Fixed**: Trackman auto-confirm animation in 'Book on Trackman' modal was not triggering — booking ID comparison used strict equality between number and string types, causing the match to always fail; also fixed a race condition where a data refresh could reset the animation state mid-flight
- **Fixed**: ID scanner 'string did not match the expected pattern' error — images from phone cameras were too large for the API. Now resized to max 1920px on capture/upload and 1500px on the server before OCR processing
- **Fixed**: Android Chrome scrolling was blocked across the app — React 19 delegates synthetic touch handlers to #root as non-passive listeners, which Android's scroll optimization rejects. Converted PullToRefresh to native addEventListener with passive: true for touchstart

## [8.31.2] - 2026-02-25

### HubSpot Form Sync: Definitive Production Fix
- **Fixed**: Form sync now uses the Private App token (which has the forms scope) instead of the Replit connector token (which does not) — this was the true root cause of all 403 MISSING_SCOPES errors in production
- **Fixed**: Form discovery uses the typed SDK method (client.marketing.forms.formsApi.getPage) instead of client.apiRequest() — typed SDK methods use OpenAPI-generated auth middleware that works in production, while apiRequest() silently drops auth headers in deployed environments
- **Fixed**: Submission fetching uses direct node-fetch with explicit Bearer header instead of client.apiRequest() — bypasses the SDK's broken HTTP pipeline entirely
- Root cause summary: Two tokens exist (connector OAuth + Private App). Connector works for contacts/properties but lacks forms scope. Private App has forms scope but only works through typed SDK methods or direct fetch, not through client.apiRequest(). Previous fixes tried one piece at a time; this fix combines both proven pieces.
- **Added**: Manual 'Sync from HubSpot' button on both Inquiries and Applications admin pages with toast feedback and auto-refresh
- **Added**: First-sync diagnostic log confirming auth method, form count, and form names on every process start
- **Added**: Detailed code documentation in formSync.ts explaining the full auth history and why specific methods must be used

## [8.31.0] - 2026-02-25

### Premium UX Polish: Payment Modals & Checkout
- **Improved**: Smooth cross-fade step transitions in guest payment modal using auto-animate, replacing instant snaps
- **Improved**: Refined button press physics app-wide — active press scale changed from 0.95 to 0.98 for a subtler, premium feel
- **Improved**: Loading buttons now maintain exact dimensions — text goes invisible with a centered spinner overlay, preventing layout jitter
- **Improved**: Error states toned down from aggressive red to softer amber styling with info icons and slide-in animations
- **Improved**: Typography hierarchy refined — demoted overused font-bold to font-semibold across modals and checkout, reserving bold for primary totals only
- **Improved**: Input focus states now use a branded accent ring with smooth shadow transition across all form inputs
- **Improved**: Required field indicators use amber instead of red for a less alarming visual tone
- **Improved**: All user-facing error messages rewritten with friendlier, more helpful copy
- **Improved**: 'Number of Employee Seats' label renamed to 'Team Size' for clarity
- **Improved**: Guest payment modal title refined from 'Guest Information' to 'Guest Details'

## [8.30.2] - 2026-02-25

### Fix: Double-Click & Payment Confirmation Guards
- **Fixed**: 'Use Guest Pass' button no longer fires before the server confirms — previously the UI showed success immediately, even if the backend failed, causing guest pass counts to desync
- **Fixed**: 'Use Guest Pass' button now shows a loading spinner and is disabled during the request, preventing duplicate guest additions from rapid clicks
- **Fixed**: Member payment confirmation now waits for backend confirmation before closing the modal — if confirmation fails, an error message is shown instead of silently proceeding
- **Fixed**: Member payment modal shows a 'Confirming payment...' spinner during backend confirmation to prevent user interaction
- **Fixed**: Day pass 'Buy Now' button no longer gets permanently stuck in a disabled state when navigating back from Stripe Checkout via browser back button
- **Improved**: Corporate membership seat count can now be typed directly instead of requiring repeated button clicks to reach the desired number

## [8.30.1] - 2026-02-25

### Fix: Payment Double-Tap Protection
- **Fixed**: Rapid double-tap on 'Pay Now' button could fire two Stripe payment confirmations before the button disabled, causing a fatal Stripe error and crashing the payment flow — now uses a synchronous guard to instantly block duplicate submissions

## [8.30.0] - 2026-02-25

### Fix: Notices Reverting to Draft After Editing
- **Fixed**: Edited notices no longer revert to 'Needs Review' after calendar sync — sync now patches events in place instead of deleting and recreating them, preserving the original event ID
- **Fixed**: Sync now preserves user-set notice_type instead of overwriting it with null when the calendar event title has no bracket prefix
- **Fixed**: Multi-day closures with comma-separated calendar event IDs now correctly match during sync instead of creating duplicate draft closures
- **Fixed**: Deactivation logic now correctly handles comma-separated calendar event IDs so configured closures don't get wrongly deactivated
- **Improved**: Editing notice_type or visibility now pushes the change to Google Calendar (previously only dates/times/title triggered calendar updates)
- **Improved**: When a calendar event can't be found by ID, sync will match by title and date to adopt existing configured closures instead of creating duplicates

## [8.29.0] - 2026-02-25

### WCAG Accessibility & Keyboard Navigation
- **New**: Skip navigation link — pressing Tab on any page now reveals a 'Skip to main content' link, allowing keyboard users to bypass the sidebar/header
- **Improved**: Focus trapping in modals and drawers — Tab and Shift+Tab now cycle within SlideUpDrawer and ConfirmDialog instead of escaping to background content. Escape key closes drawers
- **Improved**: All clickable div/span elements across shared components (GlassRow, ListItemMotion, ContextualHelp) now have role='button', tabIndex, and keyboard handlers for Enter/Space
- **Improved**: MemberSearchInput dropdown now uses proper combobox ARIA pattern with role='combobox', role='listbox', role='option', aria-expanded, aria-activedescendant, and a live region announcing result counts
- **Improved**: BookingStatusDropdown now supports full keyboard navigation (Arrow keys, Enter, Escape) with proper ARIA roles (listbox/option) and aria-expanded/aria-haspopup attributes
- **Improved**: TabButton now includes role='tab' and aria-selected attributes; parent containers use role='tablist' across member pages
- **Improved**: All interactive admin elements (sort headers, expandable rows, clickable cards in Directory, Tiers, Dashboard, AuditLog, SchedulerMonitor, WebhookEvents) are now keyboard-accessible
- **Improved**: All interactive member and public page elements (Updates cards, Dashboard cards, Profile rows, Gallery images, WhatsOn/Cafe expandable items, AlertsCard items, NFC check-in modal) are now keyboard-accessible
- **Improved**: All command center shared components (GlassListRow) now have conditional keyboard support when clickable
- **Improved**: Form fields in CafeTab, EventsAdmin, AnnouncementManager, EventFormDrawer, GalleryAdmin, ApplicationPipeline, and BugReportsAdmin now have aria-label attributes for screen reader identification
- **Improved**: Images in WellnessAdmin, EventsAdmin, and CafeTab now have descriptive alt text using item titles with fallbacks
- **Improved**: Modal backdrop overlays now have aria-hidden='true' so screen readers skip them (MemberMenuOverlay, MemberProfileDrawer, MenuOverlay, BookingStatusDropdown, TransactionsSubTab, TransactionList, CheckInConfirmationModal, TrackmanWebhookEvents, Gallery lightbox)
- **Improved**: Toast notifications now use role='status' for non-error messages and role='alert' for errors, with matching aria-live urgency levels

## [8.28.0] - 2026-02-25

### Admin Calendar, Conference Room & Critical Billing Fixes
- **Improved**: Admin calendar grid now starts at 8:30 AM and extends to 10:00 PM to match actual club operating hours — removed the unused 8:00 and 8:15 AM rows
- **Improved**: Conference room cells on the calendar now show a styled hover card with booking details instead of a plain browser tooltip
- **Improved**: Table column headers on admin pages now scroll naturally with the page instead of staying sticky, fixing visual clipping issues with hover popups
- **Fixed**: Staff conference room booking modal sometimes showed 'No available slots' even when clicking on clearly empty calendar cells — removed the unreliable slot-check and now uses the clicked time directly
- **Fixed**: 'Cancel Immediately' for member subscriptions was actually scheduling cancellation at the end of the billing cycle instead of cancelling right now — immediate cancellations now take effect instantly (Bug 36)
- **Fixed**: Applying discount coupons to subscriptions appeared to succeed but was silently ignored by Stripe due to using a deprecated API parameter — now uses the modern discounts array so coupons actually apply to billing (Bug 37)
- **Fixed**: MindBody sales import could match purchases to the wrong member when two members share the same name — removed the risky name-only fallback; unmatched purchases now go to the admin unmatched queue for manual linking (Bug 35)
- **Fixed**: Billing migration script always reported 'Updated 0 members' even when it succeeded, due to reading the wrong property from the database result (Bug 38)
- **Fixed**: Member deletion now properly cleans up related data across all tables to prevent orphaned records
- **Fixed**: Creating booking sessions with identical start and end times no longer causes an error
- **Fixed**: Database connection leak in certain error paths that could cause server crashes under load
- **Fixed**: Orphaned booking sessions (sessions without a matching booking) are now properly cleaned up during cancellation
- **New**: Staff can now assign members to unmatched or empty booking sessions directly from the booking details sheet
- **Fixed**: After charging a member for a booking and closing the details sheet, the calendar card didn't update to reflect the payment — now automatically refreshes booking data when closing after a successful payment
- **Fixed**: If the billing migration cron job took longer than its interval, the next run could process the same pending members again, creating duplicate Stripe subscriptions — members are now marked as 'processing' before migration begins so concurrent runs skip them (Bug 40)
- **Fixed**: Setting a migration billing start date less than 48 hours in the future caused Stripe to reject the subscription with a validation error — dates within 48 hours now bill immediately instead of using trial_end (Bug 41)
- **Fixed**: Cancellation effective dates were saved using a localized date format that could be misinterpreted by Postgres depending on server settings — now uses ISO format to prevent date parsing crashes (Bug 42)
- **Fixed**: Image uploads could crash the server if a malicious or oversized image was uploaded — now limits pixel dimensions before processing to prevent out-of-memory crashes (Bug 43)
- **Fixed**: Authentication rate limiter could be bypassed by rotating IP addresses or email addresses — now uses separate limiters for IP and email so both vectors are independently protected (Bug 44)
- **Fixed**: Rapid WebSocket events could fire multiple overlapping command center data requests, causing stale data overwrites — now cancels pending requests before starting new ones (Bug 45)
- **Improved**: Global rate limiter now allows higher request limits for unauthenticated traffic to prevent false blocks on shared networks like public Wi-Fi (Bug 46)

## [8.27.0] - 2026-02-25

### MindBody → Stripe Billing Migration
- **New**: Staff can now migrate MindBody members to Stripe billing one-by-one from the directory profile drawer — pick a billing start date, confirm MindBody cancellation, and the system handles the rest automatically
- **New**: Migration engine runs after daily member sync — when MindBody status goes inactive and the billing start date arrives, a Stripe subscription is created automatically using the member's card on file
- **New**: Members with a pending migration stay fully active with no access gap — the deactivation cascade skips them so their tier and status are preserved during the transition
- **New**: Staff receives notifications when a MindBody member adds a card on file (from terminal or self-service), making them eligible for migration
- **New**: Migration status badges in the billing tab show real-time progress: eligible, pending, completed, or failed with retry option
- **New**: Self-service checkout and billing portal are blocked during a pending migration to prevent double subscriptions
- **New**: Stale migrations (pending for more than 14 days) trigger staff reminder notifications

## [8.26.7] - 2026-02-25

### Critical Financial Safety, Webhook Transaction & Check-In Fixes
- **Fixed**: When a Trackman ID was re-linked to a new booking, the old booking's paid sessions were deleted without refunding Payment Intents — now properly refunds succeeded payments and cancels pending ones before cleanup (Bug 10)
- **Fixed**: devConfirmBooking could overwrite a member's cancellation due to a TOCTOU race condition — the UPDATE now includes an optimistic lock on booking status (Bug 11)
- **Fixed**: completeCancellation refunded via Stripe but never updated the database to reflect 'refunded' status — now calls PaymentStatusService.markPaymentRefunded to keep the ledger accurate (Bug 12)
- **Fixed**: Editing an earlier booking's duration didn't trigger fee recalculation on subsequent same-day bookings — recalculateSessionFees now cascades to later sessions for the same member (Bug 13)
- **Fixed**: Cancelling a booking while a member was actively playing (status 'confirmed') bypassed the Trackman cancellation guard — wasApproved now includes 'confirmed' status to prevent free golf exploits (Bug 14)
- **Fixed**: After cancelling a booking, all paid participants were bulk-marked as 'refunded' even if some individual Stripe refunds failed — each participant's status now updates only after their specific refund succeeds (Bug 15)
- **Fixed**: Webhook overpayment verification double-counted session usage, causing false 'needs_review' flags for staff — now passes excludeSessionFromUsage to prevent double-counting (Bug 16)
- **Fixed**: When account credit fully covered booking fees, no audit trail was created — now logs a payment_confirmed audit entry with 'account_credit' payment method (Bug 17)
- **Fixed**: Day pass purchases from Stripe checkout ran outside the webhook transaction boundary — recording now runs as a deferred action after commit (Bug 18)
- **Fixed**: Check In and Cancel Booking buttons in the booking details sheet did nothing when tapped — both are now properly wired to the staff command center handlers
- **Fixed**: The check-in status dropdown appeared behind the booking sheet — dropdown now renders above the sheet and centers over the button
- **Fixed**: Check-in/no-show push notifications could display raw unparsed date strings — now correctly uses ISO date parsing (Bug 20)
- **Fixed**: Check-in membership status query could crash on legacy bookings with no owner email — now safely handles null/undefined emails (Bug 21)
- **Fixed**: approveBooking called recalculateSessionFees inside a db.transaction, but the fee service used the global connection pool — the uncommitted session data was invisible, causing $0 fees or deadlocks. Fee calculation now runs after the transaction commits (Bug 22)
- **Fixed**: When a member paid cash at the front desk and their phone also completed a Stripe charge, the webhook skipped the database update but kept the Stripe payment — now auto-refunds full or partial overpayments when participants are already paid (Bug 23)

## [8.26.6] - 2026-02-24

### Check-In Race Condition, HubSpot Sync & Fee Calculation Fixes
- **New**: Staff now receive push notifications when a visitor submits a form on the website (tour requests, membership inquiries, event bookings)
- **New**: Session creation now triggers automatically for auto-resolved bookings, ensuring billing records exist from the start
- **Improvement**: Calendar event synchronization improved for more reliable event data across the app
- **Improvement**: Keyboard navigation and accessibility improved across multiple interactive components
- **Fix**: HubSpot lifecycle stage correctly synced when member status changes — archiving now sets the right stage instead of an invalid value
- **Fix**: Visitor and day-pass contact creation in HubSpot now uses correct lifecycle stage mapping
- **Fix**: Database updated to include all valid booking source values, preventing constraint errors on new booking types
- **Fixed**: If two staff members clicked check-in on the same booking at the exact same time, both could succeed — the system now locks against the exact booking status to prevent duplicate check-ins
- **Fixed**: During corporate member signup, if HubSpot was slow or timed out, the company link was permanently lost — the system now queues a reliable retry so the company always gets synced to HubSpot
- **Fixed**: On legacy or malformed bookings missing an explicit owner in the roster, overage fees for empty slots were silently skipped — the system now correctly assigns the overage to the first member participant as a fallback

## [8.26.5] - 2026-02-24

### Roster Editing Deadlock Prevention
- **Fixed**: Adding a member that replaces a guest, removing a guest participant, and batch roster edits (remove/replace) could all cause a database deadlock under heavy load — guest pass refunds in all four roster operations now run safely after the database transaction completes

## [8.26.4] - 2026-02-24

### Booking Cancellation & Webhook Stability Fixes
- **Fixed**: Cancelling a booking with guest passes could cause a database deadlock under load — guest pass refunds now run after the main booking update completes instead of inside the same database lock
- **Fixed**: When Stripe retries a failed payment for a member who was already suspended, HubSpot now receives the member's actual current status instead of being incorrectly reverted to 'past due' — this prevents marketing emails from being sent to the wrong audience

## [8.26.3] - 2026-02-24

### Background System Fixes — Revenue, HubSpot & Fee Safety
- **Fixed**: Trackman attendance reconciliation was using the guest fee rate instead of the overage rate and ignoring session duration — a member sneaking extra players into a 3-hour session was only charged a flat guest fee instead of the proper time-based overage charge
- **Fixed**: HubSpot sync queue could create duplicate jobs when a rate-limited job was retrying — the idempotency check now also covers jobs in 'failed' status awaiting retry, preventing wasted API calls and potential data races
- **Fixed**: Fee calculator now safely handles orphaned billing sessions with no linked booking — previously this could generate an invalid database query and crash the fee service for all members

## [8.26.2] - 2026-02-24

### Terminal Card Reader — New Member Signup Fix
- **Fixed**: Card reader payments during new member signup were failing with a Stripe error — the system was trying to modify a subscription payment in a way Stripe doesn't allow, now it correctly creates a separate terminal-compatible payment and reconciles it automatically
- **Fixed**: Both the 'process existing payment' and 'process subscription payment' terminal flows now gracefully fall back when the subscription's payment can't be directly routed to the card reader

## [8.26.1] - 2026-02-24

### Future Bookings Fee Display Fix
- **Fixed**: Future Bookings in the payments section was incorrectly showing $25 fees for member and staff bookings that should have $0 — these bookings no longer appear in the fees list
- **Fixed**: Fee calculation for future bookings now uses the authoritative per-participant cached fees instead of stale usage ledger data from Trackman imports

## [8.26.0] - 2026-02-24

### Booking Soft Lock — Prevent Double Requests
- **New**: When a member requests a specific bay and time slot, other members now see that slot as 'Requested' (amber indicator) instead of available — no more submitting a request only to have it declined because someone else already requested the same slot
- **New**: Time slots where all bays are already requested appear as non-selectable with a 'Requested' label in the time picker
- **New**: Bay selection now shows requested bays below available bays with a 'Pending approval for another member' message
- **Improved**: Your own pending requests do not block you — you still see your own requested slots as normal
- **Fixed**: Creation-time overlap check now includes all active booking statuses (pending_approval and cancellation_pending were previously missing), closing a safety-net gap where conflicting requests could bypass the hard block
- **Fixed**: Staff manual booking overlap check aligned to the same six active statuses
- **Fixed**: Availability cache key now includes user identity, preventing stale self-exclusion data when admins use 'view as' to switch between members
- **Fixed**: Trackman webhook now matches pending_approval bookings (not just pending), preventing webhook from creating a duplicate booking when the original request was awaiting approval
- **Fixed**: Pasting a Trackman Booking ID that's already linked to another booking for the same member now automatically re-links it instead of showing an error — handles the case where a webhook auto-created a separate booking but the original pending request still needs linking
- **Fixed**: When a Trackman ID is re-linked to a different booking for the same member, the orphaned webhook-created booking is automatically declined with an audit note, its session is deleted, and any associated draft/open invoice is voided or deleted

## [8.25.3] - 2026-02-24

### Scroll Lock — Background Scroll Prevention
- **Fixed**: Page content behind modals and slide-up sheets no longer scrolls when the sheet is open, especially on iOS/mobile Safari
- **Improved**: Scroll position is preserved when opening and closing modals — the page returns to exactly where you were

## [8.25.2] - 2026-02-24

### Day Pass — Visitor Name Capture Fix
- **Fixed**: Day pass checkout now properly captures purchaser first and last names — visitors will no longer appear as 'Unknown' in the directory
- **Fixed**: Both public and internal day pass checkout endpoints now send consistent metadata to the payment processor, ensuring names are saved correctly

## [8.25.1] - 2026-02-24

### Staff Portal — Bottom Nav Glass Fix
- **Fixed**: Staff portal bottom navigation now shows proper liquid glass transparency matching the member portal
- **Fixed**: Both staff and member bottom nav menus now correctly show a solid background when reduced transparency is enabled, and liquid glass when it is not
- **Fixed**: Staff command center FAB menu items now use liquid glass styling instead of solid backgrounds, with proper solid fallback for reduced transparency
- **Fixed**: All FAB button variants (brand, amber, purple, red) now correctly show solid backgrounds when reduced transparency is enabled
- **Improved**: FAB menu item text contrast increased for better readability on glass backgrounds

## [8.25.0] - 2026-02-24

### Admin Controls — Complete Operations Dashboard
- **Added**: Push Notification Controls — master toggle to enable/disable push notifications with VAPID key status and subscription count
- **Added**: Auto-Approve Configuration — toggle auto-approval for conference room bookings and Trackman imports independently
- **Added**: Audit Log Viewer — searchable, filterable activity log showing all staff and system actions with expandable details
- **Added**: Stripe Terminal Management — view registered card readers, check online status, and add simulated readers for testing
- **Added**: Email Delivery Health — monitor email delivery rates, bounce counts, and spam complaints across 24h/7d/30d periods with recent event feed

## [8.24.0] - 2026-02-24

### Admin Controls — Email & Scheduler Management
- **Added**: Email Controls panel in Email Templates — toggle each email category on/off (Welcome, Booking, Passes, Payments, Membership, Onboarding, System) without code changes
- **Added**: Scheduler Controls — enable/disable individual background tasks (booking expiry, HubSpot sync, onboarding nudges, etc.) from the Data Integrity panel
- **Improved**: Payment and Membership emails now controlled via admin settings instead of hardcoded flags — can be re-enabled when ready to move off Stripe-native emails
- **Improved**: Scheduler monitoring now shows enabled/disabled state for each background task with real-time toggle controls

## [8.23.0] - 2026-02-24

### Directory UX — Loading States & Performance
- **Fixed**: Removed placeholder data (fake member names) that briefly appeared when the member directory was loading
- **Improved**: Directory now shows a proper loading skeleton while member data is being fetched
- **Improved**: Added server-side caching to the member directory for faster load times on repeat visits

## [8.22.0] - 2026-02-24

### Performance Optimization — Caching, Query Efficiency & Parallel Processing
- **Improved**: Added server-side caching for frequently-accessed data (resources, cafe menu, membership tiers) — reduces database load on high-traffic pages
- **Improved**: Optimized database queries across multiple endpoints to fetch only the columns needed instead of entire rows — faster response times
- **Improved**: Booking cancellation refunds now process in parallel instead of one-at-a-time — faster cancellations when multiple refunds are needed

## [8.21.0] - 2026-02-24

### Security Hardening — Input Validation & Rate Limiting
- **Added**: Rate limiting on booking request submissions to prevent spam (30 requests per minute per user)
- **Fixed**: Multiple API routes now properly validate numeric URL parameters before database queries, preventing errors from malformed requests
- **Fixed**: Added safety limit to legacy purchase audit log query to prevent unbounded database reads

## [8.20.0] - 2026-02-24

### Data Integrity UX — Instant Fix Feedback & Mobile Layout
- **Improved**: Fix buttons now show per-issue loading spinners instead of disabling all buttons globally — you can fix multiple issues simultaneously
- **Improved**: Resolved issues now disappear instantly from the list instead of waiting for a full re-scan — background refresh confirms the fix automatically
- **Improved**: Empty check categories are automatically removed after all their issues are resolved
- **Improved**: All data integrity issue cards now use a stacked layout with action buttons below the description — no more cramped horizontal rows on mobile
- **Improved**: HubSpot sync comparison grid and check header accordions are now fully responsive on mobile screens
- **Fixed**: 'Complete Booking' action on data integrity page used invalid 'completed' status causing database constraint errors — now correctly uses 'attended' status
- **Added**: Cancel Booking and Check In actions directly from the booking detail sheet opened via data integrity

## [8.19.0] - 2026-02-24

### Stripe Webhook Safety — 8 Critical Fixes
- **Fixed**: Overnight facility closures (e.g., 22:00–06:00) were not detected correctly — time overlap validation now handles wrap-around closures spanning midnight
- **Fixed**: Membership cancellation webhook was cancelling bookings that already started today — now only cancels future/unstarted bookings
- **Fixed**: Webhook deduplication table could grow unbounded — cleanup now runs probabilistically (5%) after each webhook
- **Fixed**: Partial refund webhooks arriving out of order could overwrite higher refund amounts with lower ones — now uses GREATEST to keep the highest cumulative amount
- **Fixed**: Concurrent webhook retries could race on booking fee lookups — added row locking (FOR UPDATE) to prevent conflicts
- **Fixed**: Async day pass payment handler was passing wrong arguments, causing day passes to be lost — now passes correct payload and throws on failure for Stripe retries
- **Fixed**: Missing JavaScript assets returned HTML content type causing white screen of death — now returns valid JavaScript with correct content type
- **Fixed**: Old subscription invoices failing payment could downgrade members who already switched to a new subscription — now verifies subscription ID matches before applying past_due status

## [8.18.0] - 2026-02-24

### Day Pass Financial Reporting Fixes
- **Fixed**: Financial reports referenced wrong database table for day passes — corrected to use proper table and column names
- **Fixed**: Day pass payments appeared twice in transaction reports — added exclusion filter so each day pass purchase is counted exactly once
- **Fixed**: Day pass transaction cache wasn't populated if the initial webhook failed — added cache population in checkout completion handler
- **Fixed**: Duplicate day pass records could be created from webhook retries — added unique constraint on payment intent ID

## [8.17.0] - 2026-02-24

### Production-Readiness Security & Performance Audit
- **Security**: Upload endpoint was accessible without login — added authentication to prevent anonymous file upload URL generation
- **Security**: Public tour booking, day pass, and error reporting endpoints now have rate limiting to prevent abuse
- **Fixed**: Database connection pool could leak connections when timeout beats long-running fee reconciliation — fixed promise cleanup
- **Fixed**: Stripe customer creation could produce duplicates on retry — added deterministic idempotency key
- **Fixed**: 15 scheduler timers were not cleaned up on server shutdown — all schedulers now return interval IDs for proper cleanup
- **Improved**: Added database indexes on booking request status fields for faster query performance
- **Improved**: Wrapped ~50 debug console.log calls behind development-only guards to reduce production log noise
- **Improved**: Added LIMIT guards to unbounded admin queries (inquiries, bug reports, customer metadata sync)
- **Improved**: Alert cooldown tracking now prunes expired entries to prevent memory growth

## [8.16.0] - 2026-02-24

### Trackman & Booking Owner Assignment Fixes
- **Fixed**: Trackman auto-linked bookings showed empty roster slots because owner participant had no user ID — system now resolves user ID from email automatically
- **Fixed**: Linking a member to an owner slot failed instead of updating the existing slot — now detects owner-type slots and updates them in-place
- **Fixed**: Auto-fix backfill now repairs historical bookings with missing owner user IDs (90-day window, runs every 4 hours)
- **Fixed**: Assigning bookings to staff members without a user account caused database errors — frontend now sends null instead of invalid staff table ID
- **Fixed**: Backend booking assignment now resolves user ID from email when no valid member ID is provided
- **Fixed**: Trackman webhook SQL queries produced syntax errors from undefined values — applied null coalescing to all optional parameters
- **Fixed**: Booking event notifications crashed when receiving Date objects instead of strings — now handles both types

## [8.15.0] - 2026-02-24

### Email Deliverability & Sender Identity
- **Improved**: All emails now consistently show 'Ever Club' as the sender name for better brand recognition and deliverability
- **Improved**: QR codes in emails are now generated on our server instead of relying on external API — faster loading and no third-party dependency
- **Fixed**: Day pass type names in emails showed raw slugs with hyphens (e.g., 'day-pass-golf-sim') instead of formatted names ('Day Pass - Golf Sim')

## [8.14.0] - 2026-02-23

### Conference Room Invoice Billing & Real-Time Updates
- **Added**: Conference room bookings now use the same invoice-based billing flow as simulator bookings — consistent payment experience across all facility types
- **Added**: Conference room invoices are automatically created, finalized, and charged after booking approval
- **Added**: Real-time WebSocket updates for all booking and invoice changes — staff see instant updates when bookings are modified, approved, or paid
- **Added**: WebSocket broadcasts for roster changes, payment confirmations, and admin booking operations
- **Improved**: Booking check-in now supports manual status selection (attended/no-show) instead of auto-marking attended
- **Improved**: Removed legacy check-in functionality and consolidated status management into the unified booking sheet
- **Improved**: Booking conflict detection updated to work with new status flow

## [8.13.0] - 2026-02-23

### Security Hardening, Discount Tracking & Bug Fixes
- **Security**: Content Security Policy (CSP) headers hardened — added Google Fonts, Google Sign-In, HubSpot tracking, Google Maps, virtual tours, camera access for ID scanner, and form submission protection
- **Added**: XML sitemap and robots.txt for search engine visibility
- **Added**: Discount codes now persist on user accounts when coupons are applied — visible across all Stripe coupon application flows
- **Fixed**: Merged user accounts caused notification spam from Stripe data mismatches — now handles merged users gracefully
- **Fixed**: Booking cancellation cleaned up financial records after status change, risking partial cleanup on error — financial cleanup now runs first
- **Fixed**: Booking display now shows player counts for better visibility
- **Fixed**: Overdue payment display improved in member dashboards
- **Fixed**: Facility closure drafts stayed marked as drafts even after required fields were filled
- **Fixed**: Facility closures now default to proper visibility and notice type settings
- **Fixed**: HubSpot form sync now automatically tries backup token when primary token fails
- **Fixed**: Data integrity check now auto-cleans expired Stripe subscriptions
- **Improved**: Application bundle size reduced and database query performance optimized
- **Improved**: Booking approval flow now prevents duplicate approvals via optimistic locking

## [8.12.0] - 2026-02-22

### Payment Safety & Performance Hardening
- **Fixed**: Non-booking purchases (merchandise, cafe) could be obtained for free by purchasing the same item twice within 24 hours due to idempotency key collision — each purchase now generates a unique transaction key
- **Fixed**: Point-of-sale saved card charges used a 5-minute rolling window that caused both free items (same window) and double-charges (window boundary) — replaced with unique per-transaction keys
- **Fixed**: Inactive admin accounts could not be deleted when only 1 active admin remained — the safety guard now only blocks deletion of the last active admin, not inactive ones
- **Improved**: 4 Stripe API calls removed from webhook database transactions to prevent connection pool exhaustion during high-traffic subscription renewal periods — subscription status check replaced with database query, phone fetch removed, product lookup deferred, customer retrieve given 5-second timeout

## [8.11.0] - 2026-02-22

### Deep Architectural Audit — Error Handling, Timezone, Auth & Webhook Safety
- **Fixed**: 60 empty catch blocks replaced with proper error logging across 33 server files — silent failures in billing, booking, Stripe, HubSpot sync, and Trackman import are now visible for debugging
- **Fixed**: 32 date formatting calls were missing Pacific timezone — member-facing dates in emails, notifications, tour confirmations, billing displays, and reschedule messages could show wrong dates depending on server location
- **Fixed**: 3 tour notification dates were using UTC instead of Pacific timezone — staff notifications now show correct local dates for scheduled tours
- **Security**: 8 mutating API routes (wellness enrollment, booking cancel, RSVP delete) were missing authentication — now protected with auth middleware to prevent unauthorized access
- **Security**: 6 Stripe webhook handlers that modify member status now include billing provider guards — prevents Stripe events from overwriting status for members billed through other systems
- **Improved**: 3 missing database indexes added on event RSVPs and wellness enrollments — faster page loads for events and wellness class listings

## [8.10.0] - 2026-02-22

### Complete Inline Resolution UI for All 29 Integrity Checks
- **Added**: 9 new backend fix endpoints — cancel stale bookings (single + bulk), activate stuck members, recalculate guest passes, release expired holds, cancel orphaned payment intents, delete orphan enrollments/RSVPs, accept tier reconciliation
- **Added**: 8 new check-level tool panels with contextual guidance for Stale Pending Bookings, Stuck Transitional Members, Duplicate Stripe Customers, Tier Reconciliation, Invoice-Booking Reconciliation, Guest Pass Accounting Drift, Overlapping Bookings, and Orphaned Payment Intents
- **Added**: 11 new inline issue-level action buttons — Open Booking, Cancel Booking, Activate Member, View Profile, Recalculate Passes, Release Hold, Cancel PI, Delete Orphan Enrollment, Delete Orphan RSVP across all check types
- **Added**: 3 new category labels (Billing Issues, Booking Issues, System Errors) with proper type definitions
- **Added**: 18 new check metadata entries — all 29 checks now have user-friendly titles, descriptions, and impact explanations
- **Improved**: Bulk 'Cancel All Stale Bookings' action with confirmation dialog and proper audit logging

## [8.9.0] - 2026-02-22

### Data Integrity Hardening — 4 New Checks & Auto-Cleanup
- **Added**: Invoice-Booking Reconciliation check (critical) — detects duplicate Stripe invoices shared across bookings and attended bookings with no invoice created
- **Added**: Overlapping Bookings check (critical) — detects confirmed/approved bookings that overlap on the same bay at the same time (race condition evidence)
- **Added**: Guest Pass Accounting Drift check (high) — detects passes_used exceeding passes_total, orphan holds for deleted bookings, and expired holds not cleaned up
- **Added**: Stale Pending Bookings check (high) — detects pending/approved bookings past their start time that were never confirmed or cancelled
- **Improved**: Auto-cleanup now removes orphaned wellness enrollments (referencing deleted classes), orphaned booking participants (referencing deleted sessions), and expired guest pass holds
- **Fixed**: Upgraded 'Active Bookings Without Sessions' severity from medium to critical — bookings without sessions mean billing isn't being tracked
- **Improved**: Total integrity checks increased from 25 to 29, covering all major financial, booking, and guest pass integrity gaps

## [8.8.0] - 2026-02-22

### Complete Drizzle ORM Migration & Stripe Idempotency Hardening
- **Improved**: Migrated ~390 pool.query calls across 50+ server files to Drizzle ORM db.execute(sql`...`) — all production database queries now use parameterized template literals for SQL injection safety
- **Improved**: Converted 15+ pool.connect() manual transaction blocks to db.transaction() with automatic BEGIN/COMMIT/ROLLBACK — eliminates leaked connections on error paths
- **Fixed**: Added Stripe idempotency keys to all remaining .create() calls in invoices.ts, groupBilling.ts, discounts.ts, coupons.ts, and memberBilling.ts — complete coverage across all Stripe resource creation
- **Improved**: Only 13 pool.query calls remain in excluded files (seed.ts, one-off scripts, managed integrations, session store, pool definition) — 97% migration complete

## [8.7.0] - 2026-02-22

### Code Quality & Financial Safety Hardening
- **Fixed**: 27 silent error-swallowing patterns (.catch(() => {}) and empty catch {}) replaced with proper logging across 14 server files — billing, booking, and Stripe errors now visible for debugging
- **Fixed**: Stripe API create calls (invoices, payment intents, invoice items, refunds, products, prices) now include idempotency keys — prevents double-charges and duplicate resources on network retries
- **Added**: Audit logging for day pass purchases and conference room prepayments — all financial staff actions now have a traceable audit trail
- **Improved**: Migrated affectedAreas.ts from raw pool.query to Drizzle ORM sql template literals for database safety consistency

## [8.6.0] - 2026-02-21

### Booking Validation & Error Visibility Hardening
- **Fixed**: Reschedule conflict detection used inline SQL instead of centralized validation — replaced with checkBookingConflict() for consistent behavior and advisory lock protection against concurrent reschedules
- **Fixed**: Booking conflict detection did not check 'attended' status bookings — checked-in bays could be double-booked against during reschedule or new booking creation
- **Fixed**: Invoice settlement errors at check-in were silently swallowed (.catch(() => {})) — billing failures now logged as ERROR level for staff visibility and manual review
- **Fixed**: WebSocket broadcast errors during reschedule were silently swallowed (empty catch {}) — now logged as warnings for debugging

## [8.5.0] - 2026-02-21

### Duplicate Check-In Notification Fix
- **Fixed**: Members received 4+ duplicate 'Checked In' notifications from a single check-in — added deduplication at both the check-in handler and notification service level
- **Fixed**: Members received both 'Checked In' and 'Check-In Complete' notifications — consolidated to single 'Checked In' notification with 60-second dedup window
- **Improved**: Global notification deduplication safety net prevents any duplicate notification with same title and booking within 60 seconds

## [8.4.0] - 2026-02-21

### Duplicate Payment Prevention & Invoice Settlement Safety
- **Fixed**: Terminal payments (card reader) could trigger duplicate charges when staff clicked 'Collect' — system now detects existing terminal payments and settles the invoice without creating new charges
- **Fixed**: Invoice finalization race condition where Stripe auto-charged the customer's default card before the system could cancel the auto-generated payment intent — invoices now finalized with auto_advance disabled
- **Fixed**: Rapid 'Confirm All' clicks could trigger multiple concurrent invoice settlement attempts — added booking-level deduplication lock
- **Fixed**: Invoice paid-out-of-band flow could charge even after the invoice was already paid by a concurrent process — added pre-payment invoice status verification

## [8.1.0] - 2026-02-21

### Race Conditions, Billing Math & Data Integrity Fixes
- **Fixed**: Concurrent booking requests could double-book the same bay — added advisory lock to serialize requests per resource per day
- **Fixed**: Reconciliation math charged $200+ for a single $25 guest — switched from time-based formula to flat guest fee pricing
- **Fixed**: Guests with app profiles were force-upgraded to 'member' billing during approval, bypassing guest passes — billing type now preserved as intended
- **Fixed**: Cross-midnight sessions (e.g., 11PM–1AM) were saved as 60 minutes instead of actual duration — midnight wrap math corrected
- **Fixed**: Resolved walk-in bookings permanently lingered in the 'Unmatched' admin queue — approve and check-in now clear the unmatched flag
- **Fixed**: Nightly tier auto-fix could silently upgrade Visitors to VIP via shared HubSpot IDs — shared ID matches now flagged for manual staff review instead of auto-applied

## [8.0.0] - 2026-02-21

### Security, Transaction Safety & Operational Fixes
- **Security**: Staff notes are now filtered from member-facing booking API responses — previously visible in browser network traffic
- **Fixed**: Fee calculation errors during booking approval were silently swallowed, allowing $0 bookings — errors now properly abort the approval
- **Fixed**: Staff could not correct accidental check-ins — attended and no-show statuses are now correctable without getting locked
- **Fixed**: Conference room check-in forced double payment — prepayments are now deducted from outstanding balance before triggering the payment guard
- **Fixed**: Dev-confirm executed database changes without a transaction — partial failures could leave ghost participants or stuck statuses
- **Fixed**: HubSpot bulk sync lost entire batches of 100 when one contact had a validation error — now falls back to individual pushes

## [7.99.0] - 2026-02-21

### Booking Safety & Payment Integrity Fixes
- **Fixed**: Conference room prepayments were silently lost on cancellation — succeeded Stripe charges are now properly refunded instead of attempting invalid cancel operations
- **Fixed**: Trackman participant linking sent push notifications without actually writing to the database — members saw 'Added to Booking' but nothing appeared in their app
- **Fixed**: First-time guest pass users crashed staff approvals — system now auto-creates guest pass records on first use based on tier allocation
- **Fixed**: Members could request bookings with guests they had no passes for — hold failures now block the booking with a clear error instead of creating un-approvable requests
- **Fixed**: Dev-confirm could create 'ghost bookings' (approved with no billing session) — now returns an error if session creation fails
- **Fixed**: Declined booking invitations still blocked the member's schedule — conflict detection now correctly skips declined invites
- **Fixed**: completeCancellation trapped check-in payments — now queries and refunds fee snapshot payments matching cancelBooking behavior
- **Fixed**: Reconciliation 'Adjust Ledger' button could double-charge members on re-click — now uses idempotency-guarded usage recording
- **Fixed**: Roster duplication via ON CONFLICT DO NOTHING without a unique constraint — added partial unique index on booking_participants(session_id, user_id)
- **Fixed**: Cancellation refunded guest passes for ALL guests including those who paid cash — now only refunds passes where used_guest_pass is true
- **Fixed**: Check-in guard skipped fee recalculation when cached fees were zeroed out (vs NULL) — now catches both states

## [7.98.0] - 2026-02-21

### Critical Billing & Booking Bug Fixes
- **Fixed**: SQL fan-out in fee calculator was multiplying ledger fees across all guest participants, causing massive overcharging (e.g., $100 billed as $400 with 3 guests)
- **Fixed**: Idempotency guard in usage tracking silently discarded guest fees or overage fees when multiple entries shared the same member ID — fees now aggregated per member before recording
- **Fixed**: Loose substring matching in participant linking incorrectly stripped guests whose names were substrings of the owner (e.g., guest 'John' removed when owner is 'John Smith')
- **Fixed**: Conference room auto-confirm bypassed daily usage limits — now properly tracks time via usage ledger with graceful fallback on failure
- **Fixed**: Member cancellations of Trackman-linked bookings overwrote existing staff notes instead of appending
- **Fixed**: Trackman reconciliation dashboard stats showed lifetime totals instead of respecting selected date filters

## [7.97.0] - 2026-02-21

### Dead Code Removal
- **Deleted**: RescheduleBookingModal.tsx (377 lines) — orphaned component, reschedule UI was previously hidden from all surfaces
- **Deleted**: shared/models/walkInVisits.ts — unused Drizzle schema file (walk_in_visits table is used via raw SQL, schema model was never imported)

## [7.96.0] - 2026-02-21

### Dependency & Dead Code Cleanup
- **Removed**: @modelcontextprotocol/sdk unused npm package
- **Moved**: 11 dev-only packages to devDependencies (vitest, @vitest/ui, drizzle-kit, postcss, tailwindcss, @tailwindcss/postcss, vite-plugin-compression, @types/cookie, @types/multer, @types/react-virtualized-auto-sizer, @types/react-window, @types/ws)
- **Deleted**: server/routes/mcp.ts (empty dead file)
- **Deleted**: server/utils/calendarSync.ts (superseded by server/core/calendar/sync/)
- **Deleted**: server/utils/stringUtils.ts (superseded by server/core/utils/emailNormalization.ts)

## [7.95.0] - 2026-02-21

### Fix Ghost Column References in SQL Queries
- **Fixed**: Member cancel flow session lookup — was referencing non-existent bs.booking_id, now uses trackman_booking_id JOIN
- **Fixed**: Stripe payment participant query — bs.booking_id replaced with proper booking_requests JOIN for booking_id
- **Fixed**: Stripe webhook refund audit log — bs.booking_id replaced with booking_requests JOIN
- **Fixed**: Trackman admin lesson cleanup — booking_sessions and booking_participants deletion now uses trackman_booking_id and session_id respectively
- **Fixed**: Trackman import post-import waiver query — bs2.booking_request_id replaced with proper booking_requests JOIN
- **Fixed**: Trackman import cleanup — booking_participants deletion now uses session_id subquery instead of non-existent booking_id
- **Added**: Ghost column CI guard — build now auto-checks for references to non-existent columns on booking_sessions and booking_participants

## [7.94.0] - 2026-02-21

### Legacy Table Migration Complete
- **Removed**: booking_members table — all member roster queries now use booking_participants exclusively
- **Removed**: booking_guests table — all guest roster queries now use booking_participants exclusively
- **Migrated**: 20+ files across backend updated to read from booking_participants instead of legacy tables
- **Removed**: Dead populateBookingMembers function from approval service — was a no-op since v7.92.0
- **Removed**: Trackman import backfill logic for booking_members/booking_guests — no longer needed
- **Removed**: booking_guests schema migration check from db-init — table no longer exists
- **Improved**: Conflict detection, tier service, fee calculations all now use booking_participants directly
- **Cleaned**: All Drizzle schema definitions and type exports for legacy tables removed

## [7.93.0] - 2026-02-21

### Overage Payment Migration to Invoice System
- **Removed**: Standalone overage payment route (overage.ts) — all billing now goes through the one-invoice-per-booking system
- **Removed**: 4 deprecated overage columns from booking_requests (overage_fee_cents, overage_minutes, overage_paid, overage_payment_intent_id) — invoice system is the single source of truth
- **Removed**: Overage payment UI from check-in modal and member dashboard — fees are handled through the unified invoice flow
- **Improved**: Roster lock check now uses isBookingInvoicePaid() instead of querying deprecated overage columns
- **Improved**: Cancel/deny booking flows no longer attempt to refund standalone overage PaymentIntents — voidBookingInvoice handles all refunds
- **Cleaned**: Removed overage fee sync from unifiedFeeService — invoice system tracks all fee changes
- **Cleaned**: Removed overage column references from 15+ backend and frontend files

## [7.92.0] - 2026-02-21

### Legacy System Cleanup
- **Removed**: Dead invite expiry scheduler — system auto-accepts all participants, scheduler was running every 5 minutes doing nothing
- **Removed**: All writes to legacy booking_members table across 10+ files — booking_participants is the sole roster source of truth
- **Removed**: All writes to legacy booking_guests table across 7 files — guest data now lives in booking_participants
- **Improved**: invite_status column now defaults to 'accepted' at the database level — removed redundant hardcoded values from every participant insert
- **Cleaned**: Removed orphaned invite_status='cancelled' update from resource deletion flow

## [7.91.1] - 2026-02-21

### Training Guide & CSV Import Fixes
- **Updated**: Training guide now reflects one-invoice-per-booking architecture — updated Check-In & Billing, Players & Guests, and Reschedule sections
- **Added**: Itemized Invoices and Roster Lock After Payment training steps
- **Updated**: Reschedule training section now notes the feature is temporarily unavailable
- **Fixed**: Bookings approved with $0 fees now correctly create a draft invoice when roster changes add fees later
- **Fixed**: CSV import now creates fresh bookings when cancelled bookings still exist in Trackman — clears old Trackman ID from cancelled record and creates new booking with correct owner/participants from CSV data
- **Fixed**: CSV import payment status check no longer crashes on 'refunded' enum value — was causing all bookings to be treated as frozen
- **Fixed**: Post-import fee cleanup query corrected (booking_participants has no booking_id column)
- **Fixed**: Booking cancellation now automatically voids/refunds the Stripe invoice — draft invoices are deleted, open invoices are voided, paid invoices are refunded
- **Fixed**: All three cancellation paths (member cancel, staff cancel, Trackman cancel) now handle invoice cleanup consistently

## [7.91.0] - 2026-02-21

### One Invoice Per Booking & Roster Lock
- **Upgraded**: Each simulator booking now has exactly one Stripe invoice throughout its lifecycle — draft at approval, updated on roster changes, finalized at payment
- **Added**: Roster lock after invoice is paid — editing players is blocked once payment is collected, with staff admin override requiring a reason
- **Added**: Invoice auto-creation when Trackman auto-approves bookings (simulator only, conference rooms excluded)
- **Added**: Invoice auto-void when bookings are cancelled via Trackman webhook
- **Added**: Invoice auto-sync when Trackman detects duration changes or staff reschedules a booking
- **Added**: Bay change detection from Trackman — when a booking moves bays, both booking and session records update and availability refreshes for old and new bays
- **Added**: Staff notifications when paid invoices need attention (roster changes after payment, void attempts on paid invoices)
- **Added**: Check-in payment settlement — invoice is finalized as paid (OOB) when staff confirms, voided when all fees are waived, or synced on partial actions
- **Removed**: Reschedule UI hidden from staff and member surfaces (backend routes preserved for future measured rollout)

## [7.90.0] - 2026-02-20

### Invoice-Based Payment Processing
- **Upgraded**: Booking fee payments now generate Stripe Invoices with itemized line items instead of raw PaymentIntents — each overage fee and guest fee is a separate line item for full transparency
- **Added**: Members receive downloadable invoice PDFs showing detailed breakdowns of overage fees, guest fees, and other charges per participant
- **Improved**: Prepayment charges now use invoices with per-participant line items, making billing audits simpler
- **Improved**: Staff-initiated saved-card charges now generate invoices with full fee breakdowns
- **Maintained**: All existing metadata (bookingId, sessionId, trackmanBookingId) is preserved on both invoices and PaymentIntents for webhook compatibility
- **Maintained**: Customer balance/credit handling is now natively managed by Stripe Invoices

## [7.89.7] - 2026-02-20

### Member Portal Roster Accuracy Overhaul
- **Changed**: Player removal now waits for server confirmation before updating the display — ensures roster, fees, and slot counts always show exactly what the server calculated, never a local guess
- **Changed**: Remove button shows a loading spinner and blocks further removals until the server responds — prevents rapid-fire removals that could cause billing inconsistencies
- **Improved**: Removed complex optimistic update and rollback code in favor of a simpler, more reliable server-first approach — fewer moving parts means fewer potential bugs
- **Maintained**: Roster and fee data still load together in a single request — no cascading fetch race conditions

## [7.89.6] - 2026-02-20

### Member Portal Roster Race Condition Fix
- **Fixed**: Removed players would briefly reappear in the member portal booking roster — caused by separate data fetches racing against each other and overwriting optimistic updates
- **Improved**: Roster and fee data now load together in a single request instead of cascading separately — faster loading and no more flicker
- **Improved**: When removing a player, the slot count, player list, and fee breakdown all update instantly in one batch instead of updating piecemeal
- **Fixed**: Fee allocation display now correctly matches by both player name and type to prevent misidentification when updating optimistically

## [7.89.5] - 2026-02-20

### Team Tab Column Restructure & Alignment
- **Changed**: Team tab columns reorganized — added Phone column after Email, moved Role to the last column, removed Status column
- **Changed**: Team tab mobile cards — replaced tier/status badges with job title, moved phone number under email
- **Fixed**: Search bar and filter/sort buttons now have uniform 44px height across Active, Former, and Visitors tabs — no more mismatched heights
- **Changed**: Bookings page Import button now shows the Trackman logo icon instead of text — cleaner look that fits within the card
- **Fixed**: Bookings page Guide and Import buttons now match heights with identical styling
- **Changed**: Booking cards that show 'Paid' now display a 'Check In' button instead — since the booking is already paid, the next logical action is to check them in
- **Fixed**: Player slot cards no longer scale down when tapped — this was causing the reassign/remove buttons to shift position mid-tap, making them hard to press on mobile
- **Fixed**: Reassign and remove buttons on player slots now have larger touch targets (40px vs 28px) for easier tapping
- **Fixed**: Booking detail sheet now shows times in 12-hour format (e.g. 12:00 PM - 2:00 PM) instead of 24-hour format (12:00:00 - 14:00:00)
- **Fixed**: Bookings with $0 fees now show a direct Check In button instead of opening the fee collection sheet — no more unnecessary extra step for bookings within daily allowance
- **Fixed**: Trackman CSV import was creating duplicate guest entries — the import now checks by name and email before adding, preventing garbled duplicates
- **Fixed**: Player roster count (e.g. '3/2 assigned') now uses the correct data source instead of stale legacy data — no more over-counted rosters
- **Fixed**: Cleaned up existing duplicate guest entries on affected bookings (Adam Fogel, Suki Vaswani)
- **Fixed**: Active/Former Members tab column header hover highlights now fill the full height of the header bar — no more gaps on top/bottom when hovering
- **Fixed**: Sort icons now stay contained within their column's highlighted area — no more overlapping into adjacent headers
- **Fixed**: Column widths rebalanced so narrower columns (Visits, Joined, Last Visit) have enough room for both the label text and sort icon
- **Fixed**: Visitors tab column headers now properly align with the data rows below them — matched percentage widths with fixed table layout

## [7.89.1] - 2026-02-20

### Dead Code Cleanup & Performance Optimization
- **Removed**: 638 orphaned conversation attachment files (455MB) that were not used by the app — significantly reduces project size
- **Removed**: Unused billing components (BalanceCard, BalancePaymentModal) and 4 unused hooks (useBookingFilters, useAnimatedRemove, useConfetti, useOptimisticEvents) that were no longer imported anywhere
- **Removed**: Unused CSS animation (tap-feedback keyframe) and stale server backup file
- **Removed**: Old one-time Trackman import CSV no longer needed after initial data migration

## [7.89] - 2026-02-20

### Admin Directory Polish — Dark Mode, Animations & Mobile Layout
- **Fixed**: Directory filter popover text was unreadable in dark mode — primary green text on dark backgrounds now switches to lavender accent color automatically
- **Improved**: Filter popovers now open and close with smooth Apple-style slide+scale animations using custom easing curves
- **Improved**: All column header containers across Active, Former, Visitors, and Team tabs now have rounded corners with matching hover highlight heights
- **Improved**: Mobile layout optimized — sync button shows icon-only on small screens, billing provider badges (like MINDBODY) repositioned below divider alongside tier and status badges for cleaner card layout
- **Fixed**: Dark mode consistency across all interactive elements in the Directory — checkboxes, radio buttons, filter labels, and reset buttons all use the lavender accent color

## [7.88.1] - 2026-02-20

### Glass UI Accessibility Fallbacks for iOS
- **Fixed**: FAB menu items and other glass-style elements are no longer invisible on iPhones with 'Reduce Transparency' or 'Reduce Motion' enabled — all glass elements now show solid, readable backgrounds when blur effects are disabled
- **Improved**: Comprehensive accessibility fallbacks added for all glass components (cards, panels, modals, buttons, inputs, overlays, navbar) in both light and dark modes
- **Improved**: Inline Tailwind backdrop-blur elements (bottom nav, FAB, toasts, confirm dialogs) now also get solid dark backgrounds when accessibility settings disable blur

## [7.88] - 2026-02-20

### Unified Guest Fee Architecture & Staff Quick Add Guest
- **Fixed**: 'Pay Guest Fee' on the member portal no longer forces a separate $25 Stripe payment per guest — guest fees now appear as line items in the booking's fee breakdown, payable together with overage fees through the existing 'Pay Now' button
- **New**: Both 'Use Guest Pass' and 'Pay Guest Fee' now collect guest name and email before adding — this ensures all guests are properly tracked in the system
- **New**: Staff can Quick Add Guest (+$25) with one click in manage mode — no guest info required, instantly adds a guest and recalculates booking fees
- **Fixed**: Staff-assigned Trackman bookings now properly calculate guest fees — guest participants are inserted into the billing system before fee calculation runs
- **Improved**: Guest participants added without a guest pass are tracked with 'pending' payment status until fees are settled at check-in or via prepayment
- **Fixed**: Fee calculation now correctly charges the $25 guest fee when a member chooses 'Pay Guest Fee' instead of using a guest pass — previously the fee engine would automatically apply an available pass even when the member explicitly chose to pay
- **Fixed**: Guest pass consumption now uses a three-state system (NULL=auto-decide, true=pass used, false=charge fee) — prevents staff-added guests and empty slots from incorrectly burning member passes
- **Fixed**: Session creation now correctly marks guest participants with used_guest_pass=true after pass deduction, preventing fee recalculation from double-charging
- Cleaned up: Removed 3 orphaned backend routes and ~370 lines of dead code from the old per-guest Stripe checkout system

## [7.87.1] - 2026-02-20

### Trackman Webhook Simplification & Cancellation Fixes
- **Simplified**: V2 webhook matching now uses the Trackman booking ID directly (the number staff paste to confirm bookings) instead of the legacy external ID matching system — this removes an entire layer of complexity that was causing bugs
- **Fixed**: Trackman cancellation webhooks now properly cancel bookings in the app — previously, cancellation events were silently ignored because the system treated them as duplicates of the original creation event
- **Fixed**: Members now receive a 'Booking Cancelled' notification when Trackman cancels their booking — previously, only member-requested cancellations triggered notifications
- **Fixed**: Calendar availability updates instantly when a Trackman cancellation comes in — previously, the freed-up slot wouldn't appear available until the next page refresh
- **Fixed**: V2 webhooks no longer send incorrect 'Booking Confirmed' notifications when the actual status is 'cancelled'
- **Fixed**: Removed duplicate availability broadcasts — cancellations now broadcast exactly once
- **Improved**: Both 'cancelled' (British) and 'canceled' (American) spellings are now handled consistently across all webhook paths

## [7.87] - 2026-02-20

### Stripe Payment Integrity v2 — Phantom Charges & Terminal Traceability
- **Fixed**: Terminal POS payments no longer create duplicate 'Out of Band' charges in Stripe — the invoice is now voided after the terminal payment succeeds instead of being fake-paid, eliminating phantom transactions
- **Fixed**: Subscription and invoice payments now cancel stale invoice-generated payment intents before reconciliation, reducing the chance of accidental double-charges
- **Fixed**: All reconciled invoices now include cross-reference metadata (reconciled_by_pi, reconciliation_source) linking them to the real payment for easy auditing
- **Improved**: All terminal card reader payments now include readerId and readerLabel in Stripe metadata — staff can trace exactly which card reader processed each payment
- **Improved**: Subscription terminal payments now show descriptive labels like 'Membership activation - VIP' instead of generic 'Subscription activation - Invoice inv_xxx' text
- **Improved**: New subscription payment intents now include the tier name in the description for better dashboard readability
- **Fixed**: Duplicate charge prevention for non-booking payments improved — the retry window is now 60 seconds (was effectively zero due to Date.now() precision), preventing accidental double charges on retry

## [7.86.2] - 2026-02-20

### Google Sign-In Fix & Staff Account Protection
- **Fixed**: Google Sign-In was not working for staff/admin users because their accounts were accidentally archived by the visitor cleanup tool on Feb 13 — all 4 affected accounts (Nick, Mara, Sarah, Alyssa) are now automatically restored on deploy
- **Fixed**: The 'Archive Stale Visitors' tool now explicitly skips all staff, admin, and instructor accounts — this prevents staff from ever being caught in visitor cleanup again

## [7.86.1] - 2026-02-20

### Unmatched Booking Conflict Handling & Fee Cleanup
- **Fixed**: Trackman webhook bookings that overlap with an existing booking on the same bay are now created as 'pending' instead of 'approved' — this prevents phantom 'Needs Assignment' cards from cluttering the dashboard when the time slot is already taken by a confirmed member
- **Fixed**: Trackman CSV imports now automatically mark past booking fees as 'paid' (settled externally) and waive ghost fees from unmatched bookings — this prevents old overage fees from showing as outstanding on member profiles
- **New**: Admin data tool to clean up ghost fees and past outstanding balances in one click (Data Tools > Cleanup Ghost Fees)
- **Fixed**: Cleaned up 2 existing unmatched bookings that were incorrectly showing as active despite conflicting with real sessions

## [7.86] - 2026-02-19

### Stripe Payment Integrity & Void Fees
- **New**: 'Void / Cancel Fees' button in booking details — staff can now cancel outstanding Stripe payment intents directly from the app instead of going to the Stripe dashboard
- **Fixed**: Ghost transactions no longer created for Unknown Trackman bookings without valid owners — prepayment creation is blocked when the booking has no real email or is unmatched without an assigned member
- **Improved**: Stripe payment descriptions now show the Trackman booking ID (e.g., TM-12345) when available, making it easy to search and cross-reference in the Stripe dashboard
- **Improved**: All Stripe payment metadata now includes the Trackman booking ID for robust cross-referencing between the app and Trackman systems
- **Technical**: Voided fees mark participants as 'waived' and update internal payment intent records to 'cancelled' for consistency

## [7.85.6] - 2026-02-19

### Dashboard Booking Cards Layout Improvements
- **Improved**: Booking Requests and Today's Bookings cards on the dashboard now have better spacing — names show fully instead of truncating, and action buttons (Check In, Assign Member, etc.) sit on their own row instead of being crammed next to the booking info
- **Improved**: More breathing room between booking items across all screen sizes — mobile, tablet, and desktop

## [7.85.5] - 2026-02-19

### Unified Fee Estimate System
- **Improved**: All fee estimate displays (calendar cells, booking cards, and approval modal) now use a single shared system instead of three separate copies of the same code — this eliminates inconsistencies and makes fee amounts more reliable across the page
- **Removed**: Duplicate fee estimate server endpoint that was no longer needed

## [7.85.4] - 2026-02-19

### Fee Estimates Refresh on Calendar Sync & Booking Assignment
- **Fixed**: Fee estimates on calendar cells and booking cards now refresh when using the Sync Calendar button or after assigning/editing bookings — previously stale fee amounts stayed visible until leaving and returning to the page

## [7.85.3] - 2026-02-19

### Cancellation Requests Now Appear in Staff Queue
- **Fixed**: Member cancellation requests now properly appear in the staff bookings queue — previously they disappeared from the page entirely when a member requested cancellation
- **Note**: When staff cancel in Trackman, the app automatically completes the cancellation and notifies the member — no need to also confirm in the queue

## [7.85.2] - 2026-02-19

### Payment Status & Player Count Fixes for Unified Participant System
- **Fixed**: Booking cards and calendar cells now correctly show 'Paid' when all participants have paid — previously they ignored actual payment status and showed fees as 'Due' based on an independent estimate
- **Fixed**: Changing the player count on a booking no longer causes a 500 error — the system now correctly updates session-based bookings without touching legacy data tables
- **Fixed**: Members who are participants in a booking (not just the owner) now see those bookings on their dashboard
- **Fixed**: Booking cards no longer make unnecessary fee estimation calls when fees are already settled
- **Improved**: Player count changes for session-based bookings are now faster and more reliable

## [7.85.1] - 2026-02-19

### Critical Fixes: Guest Addition & Staff Booking Sheet Loading
- **Fixed**: Staff booking details sheet no longer gets stuck on a loading screen — added a 15-second safety timeout so it always recovers
- **Fixed**: Loading state properly resets when staff close and reopen the booking details sheet
- **Fixed**: Staff booking sheet always fetches fresh participant data instead of showing stale cached info
- **Fixed**: Adding a guest from the member side no longer shows a 'signal aborted' timeout error — the modal now closes instantly while the guest is saved in the background
- **Fixed**: If a background guest addition fails, members see a clear error message instead of a confusing timeout

## [7.85.0] - 2026-02-19

### Unified Participant Data: Staff & Member Views Now Read From One Source
- **Architecture**: Staff booking views now read participant data from the same source as member views, billing, and check-in — eliminating data inconsistencies
- **Fixed**: Players added or removed by members now appear instantly in staff views without any sync delay
- **Fixed**: Staff and member views always show identical participant lists, names, and fee calculations
- **Fixed**: Check-in process no longer cross-references legacy tables for participant validation — uses the authoritative participant data directly
- **Improved**: Legacy slot-based tables preserved as fallback for older bookings and Trackman imports that don't yet have session data

## [7.84.0] - 2026-02-19

### Improved Add Guest Experience & Unified Member/Staff Views
- **Improved**: 'Add Guest' now shows the payment choice first — members pick 'Pay Guest Fee' or 'Use Guest Pass' before entering guest details
- **Improved**: 'Pay Guest Fee' works immediately with one tap — no need to enter guest name or email first
- **Improved**: 'Use Guest Pass' requires complete guest info before submitting, with the button disabled until all fields are filled
- **Fixed**: Guests added by members now appear correctly in the staff booking details view
- **Fixed**: When a guest is removed by a member, staff booking sheets update to reflect the removal
- **Fixed**: Member portal now shows your actual name in the Manage Players list and Time Allocation section — previously showed email addresses
- **Fixed**: New sessions always store the member's name (not email) as the display name, preventing the email-showing issue from recurring
- **Fixed**: Existing bookings with email-based names are automatically corrected when viewed — a self-healing fix

## [7.83.0] - 2026-02-19

### NFC Tap Check-In: Members Can Check In by Tapping Their Phone
- **Added**: Members can now check in by tapping an NFC tag at the front desk with their phone — no need to show a QR code
- **Added**: NFC check-ins trigger the same real-time staff notification with sound and member details as QR code scanning
- **Added**: Staff see pinned notes and membership status for NFC check-ins, identical to the existing QR check-in experience
- **Added**: Walk-in check-in source tracking — each check-in now records whether it came from QR scan or NFC tap
- **Improved**: Check-in business logic consolidated into a shared service, ensuring QR and NFC flows stay perfectly in sync
- **Added**: Post-login redirect for NFC — if a member taps an NFC tag while logged out, they're redirected back to complete check-in after signing in

## [7.82.1] - 2026-02-19

### Staff Fee Exemption Fix: Golf Instructors No Longer Charged
- **Fixed**: Golf instructors were incorrectly being charged overage and guest fees for bookings — they are now properly treated as staff with $0 fees like all other staff and admin members
- **Fixed**: Staff, admin, and golf instructor members could have prepayment charges created for their bookings in edge cases — a safety check now blocks this at the payment level
- **Fixed**: Members with unlimited-access tiers are now also protected from accidental prepayment charges
- **Improved**: All three staff roles (staff, admin, golf instructor) are now consistently recognized across the fee calculation and prepayment systems

## [7.82.0] - 2026-02-19

### Complete Stripe Webhook Coverage: 47 Event Types Now Handled
- **Added**: App now handles 47 Stripe event types — up from 35 — covering virtually all payment, billing, and customer activity
- **Added**: Customer lifecycle tracking — new Stripe customers are automatically linked to member accounts, and staff are alerted if a customer is deleted externally
- **Added**: Card removal detection — when a member's last payment method is removed, the system flags them for card update and notifies staff
- **Added**: Card auto-update tracking — when a bank automatically updates card details (new expiry, replacement card), the system clears any 'card update needed' flags
- **Added**: Card expiry warnings — members get notified when their card is expiring within 30 days
- **Added**: Dispute progress tracking — staff now see real-time updates when a dispute changes status (evidence submitted, under review, won, lost)
- **Added**: Expired checkout tracking — staff are notified when a signup link or day pass checkout times out, so they can send a new link
- **Added**: Async payment support — bank transfers and other delayed payment methods are now tracked through completion or failure
- **Added**: 3D Secure / SCA detection — when a payment requires extra authentication, the member is notified to complete it and staff are alerted
- **Added**: Overdue invoice alerts — members with overdue invoices get escalated notifications, and staff see urgent alerts
- **Added**: Payment method save tracking — successful and failed attempts to save payment methods for future use are now logged and notified

## [7.81.0] - 2026-02-19

### Stripe & HubSpot Cleanup: Deletion Actually Works Now
- **Fixed**: Deleting a member now properly cancels their Stripe subscription and deletes their Stripe customer when the checkbox is checked — previously these operations could silently fail
- **Fixed**: Archiving a member now cancels Stripe subscriptions BEFORE updating the database, preventing partial failures that left subscriptions active
- **Fixed**: HubSpot contact archival now searches by email as a fallback when the HubSpot ID isn't stored locally — previously members without a synced HubSpot ID were silently skipped
- **Fixed**: Archiving a member now syncs 'archived' status to HubSpot — previously archive only updated local database
- **Improved**: Deletion and archive operations now return warnings when Stripe or HubSpot operations fail, instead of silently reporting success
- **Improved**: Archive operations now include staff activity logging for audit trail
- **Added**: Trial expiry warnings — members now get a notification when their trial is ending in 3 days, so they're never surprised by billing
- **Added**: Stripe email mismatch detection — if a customer's email changes in Stripe, staff are notified of the discrepancy
- **Added**: When a member adds a new payment method, the system automatically clears 'card update required' flags and retries any failed payments

## [7.80.0] - 2026-02-19

### Stripe Webhook: Auto-Activate New Members
- **Fixed**: New Stripe subscriptions now automatically create and activate members in the Directory — no more manual sync button clicks needed
- **Fixed**: Stripe webhook was only receiving customer and payment events, but not subscription, invoice, or checkout events — all 34 event types are now properly registered
- **Improved**: On every server start, the app checks that the Stripe webhook has all required event types and adds any missing ones automatically

## [7.79.0] - 2026-02-19

### Trackman CSV Import: No More Fake Outstanding Fees
- **Fixed**: Trackman CSV imports no longer create billing sessions — they only backfill Trackman data (names, emails, notes) to make assigning owners easier
- **Fixed**: Sessions are now created only when staff manually assigns an owner to a Trackman booking, not during CSV import
- **Fixed**: Cleaned up 47 fake outstanding fees ($2,300 total) from CSV-imported bookings — these were pre-Stripe sessions that were already settled

## [7.78.0] - 2026-02-19

### Atomic Roster Changes: No More Ghost Charges
- **Fixed**: Roster changes on the Booking Details sheet (adding/removing players, swapping guests for members) no longer trigger fees mid-edit — fees are recalculated once when you're done
- **Fixed**: Complex operations like swapping a guest for a member no longer create intermediate 'ghost charges' for removed participants
- **Improved**: 'Save Changes' button renamed to 'Recalculate Fees' — it now clearly shows what it does
- **Improved**: If you close the booking sheet without recalculating, fees are automatically updated so nothing gets stuck
- **Fixed**: Prepayment requests are now created/updated when fees are recalculated after roster changes

## [7.77.0] - 2026-02-19

### Trackman Billing Safety: No Session Without Owner
- **Fixed**: Trackman webhook bookings no longer create billing sessions when there's no member assigned — prevents fake 'Unknown (Trackman)' overdue payments from appearing on the financials page
- **Fixed**: When staff links a member to an unmatched Trackman booking, a billing session is now created at that point with correct fees calculated
- **Fixed**: CSV import backfill now recalculates fees when a member is matched to a webhook booking that already had a session
- **Fixed**: Cleaned up 11 orphaned billing sessions from previously unmatched webhook bookings

## [7.76.0] - 2026-02-19

### Data Integrity Resolve Actions
- **Added**: Delete button for 'Members Without Email' issues on the Data Integrity page — ghost member records can now be removed directly
- **Added**: 'Mark Completed' button for 'Active Bookings Without Sessions' issues — private events and resolved bookings can now be closed out
- **Fixed**: Private event bookings (private-event@resolved) are no longer flagged as missing sessions in the integrity check

## [7.75.0] - 2026-02-19

### Billing Accuracy & Fee Display Fixes
- **Fixed**: Booking cards no longer show '$0 Due' when the real-time fee calculation says $0 — now shows 'Check In' button correctly
- **Fixed**: Stale cached fee amounts are now auto-corrected when the live fee estimate detects they're outdated
- **Fixed**: Remainder minutes from uneven session splits (e.g., 65 min ÷ 3 players) are now properly assigned to the booking owner instead of being lost
- **Fixed**: Fee calculations no longer under-bill when session time doesn't divide evenly among players
- **Improved**: Error logging added to 10+ backend processes that previously failed silently
- **Improved**: Database query safety checks added to prevent crashes from missing data

## [7.74.0] - 2026-02-18

### Roster Code Cleanup & Type Safety
- **Improved**: Roster management code reorganized for better maintainability (route file reduced from 1,878 to 370 lines)
- **Improved**: All booking, billing, and roster code now uses strict type checking — eliminated 32 unsafe type patterns
- **Technical**: Business logic extracted into dedicated service layer for easier testing and debugging

## [7.73.0] - 2026-02-18

### Simplified Booking Player Flow
- **Improved**: Players added to bookings are now instantly confirmed — no more invite/accept/decline steps required
- **Removed**: Pending invites section from member dashboard (no longer needed)
- **Removed**: Invite accept and decline buttons from booking notifications
- **Removed**: Invite expiry countdown timer from roster manager
- **Removed**: Background invite auto-expiry scheduler (was running every 5 minutes unnecessarily)
- **Changed**: Added-player notifications now show as booking updates instead of invites

## [7.72.0] - 2026-02-18

### App-Wide Animation & Motion Polish
- **Added**: Smooth list animations across 36 pages — items now slide in/out gracefully instead of snapping when lists change (dashboard, bookings, wellness classes, admin panels, etc.)
- **Added**: Tactile press feedback on 565+ buttons, cards, and rows throughout the app — elements respond to touch/click with subtle lift and press effects
- **Improved**: Replaced 12 large loading spinners with the branded walking golfer animation for a more polished loading experience
- **Improved**: Standardized all transition speeds across the app for consistent, snappy feel — no more sluggish or jarring animations
- **Fixed**: Wellness page crash caused by animation variable scope issue — page now loads correctly

## [7.71.0] - 2026-02-18

### Save Concierge Contact — Onboarding Step
- **Added**: 'Save concierge contact' step to the onboarding checklist — members can download the Ever Club Concierge contact card (VCF) directly to their phone
- **Added**: Concierge contact button in the first-login welcome modal, positioned after profile setup
- **Added**: Automatic step completion tracking when the contact file is downloaded

## [7.70.0] - 2026-02-18

### Discount Code Tracking & Directory Improvements
- **Added**: Discount Code field on member records — tracks which Stripe coupon each member has (e.g. Family Member, Military, Trial Promo)
- **Added**: Discount filter on Member Directory — auto-populated from discount codes currently in use, updates dynamically as new codes are added
- **Fixed**: Add New User discount dropdown now shows coupon names (e.g. 'Family Member Discount (20% off)') instead of just the percentage
- **Fixed**: Discount selection when adding a new member now saves the coupon name to their member record
- **Removed**: Legacy tag badges (Founding Member, Investor, Referral) from Directory, Dashboard, and Member Profile — replaced by the more useful Discount filter
- **Added**: Backfill tool for staff to populate discount codes for existing members from their Stripe subscriptions
- **Improved**: Member sync from HubSpot now captures the discount reason field and saves it as the member's discount code

## [7.69.0] - 2026-02-18

### Directory Filter Redesign — Operational Filters
- **Redesigned**: Active tab now uses membership status filter (Active, Grace Period, Past Due) instead of legacy HubSpot-based filters
- **Added**: 'Never Logged In' app usage filter on Active tab — quickly find members who signed up but haven't opened the app yet
- **Added**: Billing provider badge (Stripe, Mindbody, Comped, Family, Manual) next to each member's email for instant billing context
- **Removed**: Legacy HubSpot tag filter row — tags still display on member rows but no longer clutter the filter bar
- **Added**: 'Last Tier' column on Former tab — shows what tier a member had before they left
- **Added**: Reactivation indicator on Former tab — shows 'Send Link' (has Stripe account) or 'New Signup' (needs fresh registration)
- **Improved**: Former tab status badges now use consistent styling that works in both light and dark mode
- **Data**: Migrated 49 former members' tier data to preserve their previous membership level for future reference

## [7.68.0] - 2026-02-18

### Admin Email Change from Profile Drawer
- **Added**: Admin/staff can now change a member's email directly from the profile drawer (pencil icon next to email)
- **Note**: Email changes cascade across all systems — database, Stripe, and HubSpot are all updated automatically
- **Security**: Members cannot change their own email — only admin/staff have this capability

## [7.67.5] - 2026-02-18

### Complete Sync Audit — All Gaps Closed
- **Fixed**: Creating a new visitor from the booking Player Management modal now automatically creates a Stripe customer for billing
- **Fixed**: Linking an existing visitor as a player now creates a Stripe customer if they don't have one yet
- **Added**: Both new and linked visitors from the booking modal now sync to HubSpot as contacts with their name and phone
- **Fixed**: Stripe Subscription Sync tool now creates HubSpot contacts with proper first/last name (was creating contacts with empty names)
- **Fixed**: Stripe Reconciliation tool now creates HubSpot contacts with proper first/last name
- **Fixed**: Corrected HubSpot phone parameter format in visitor sync calls
- **Fixed**: Staff-created HubSpot-billed members now sync to HubSpot as contacts (was skipped because deal creation was disabled)
- **Fixed**: Visitor-to-member conversions via staff admin now sync to HubSpot with name, phone, and tier
- **Fixed**: Linked visitor Stripe customer ID now explicitly saved to member record (defense-in-depth)
- **Fixed**: Online day pass buyers now sync to HubSpot as contacts (was only happening for in-person purchases via POS/QuickCharge)
- **Fixed**: Day pass webhook recordings now sync buyers to HubSpot with name and phone
- **Fixed**: Returning visitors with updated contact info now sync changes to Stripe and HubSpot when their record is updated
- **Fixed**: Unarchived visitors now sync to HubSpot and Stripe when reactivated via day pass purchase
- **Fixed**: Admin email change now syncs the new email to Stripe customer and HubSpot contact (was only updating database tables)

## [7.67.1] - 2026-02-18

### Member Info Syncs Everywhere (Stripe & HubSpot)
- **Fixed**: When a member updates their name or phone number from their profile, the changes now automatically sync to Stripe and HubSpot in the background
- **Fixed**: Stripe customer records now include the member's phone number — previously only name and tier were synced
- **Fixed**: Creating a new Stripe subscription for a member now syncs their name and phone to HubSpot
- **Fixed**: Adding a family or corporate sub-member to a billing group now syncs their contact info to HubSpot
- **Fixed**: Resyncing member data from HubSpot (via Data Tools) now also updates their Stripe customer record
- **Fixed**: Data Integrity sync-pull now includes phone number and updates Stripe records to match
- **Fixed**: Payment confirmation (quick charge with member creation) now syncs new member to HubSpot
- **Fixed**: QuickCharge and Terminal day-pass visitor records now sync to HubSpot for CRM tracking
- **Fixed**: Staff-invite checkout webhook now fetches phone from Stripe customer and includes it in HubSpot sync
- **Fixed**: Activation-link checkout webhook now syncs member contact info (name/phone) to HubSpot — previously only synced status

## [7.67.0] - 2026-02-18

### Migrate Mindbody Members to Stripe
- **Added**: 'Migrate to Stripe' button in the Billing tab for Mindbody-billed members — staff can now create a Stripe subscription directly from the member profile drawer
- **Improved**: Migration uses the member's existing Stripe customer (if they have one), preserving any credits or payment methods already on file
- **Improved**: Stripe contact fields (customer ID, billing dates) are now protected from sandbox data leaking into production HubSpot

## [7.66.2] - 2026-02-17

### Fix 'No Tier' Save for Members
- **Fixed**: Setting a member's Membership Level to 'No Tier' now works correctly — previously the Save button did nothing when clearing someone's tier
- **Improved**: Clearing a member's tier also sets their membership status to 'non-member' automatically

## [7.66.1] - 2026-02-17

### Data Integrity Alert Rate Limiting
- **Fixed**: Data integrity alerts (Critical and High Priority) now use a 4-hour cooldown with content-aware deduplication — you'll only be re-notified if the issues actually change or 4 hours pass
- **Fixed**: Cleaned up 724 duplicate data integrity notifications that had accumulated in the Updates feed

## [7.66.0] - 2026-02-17

### Training Guide Audit & Update
- **Updated**: Bookings Guide now accurately describes the Queue + Calendar layout, unmatched Trackman cards, Scheduled section with date filters, and the Booking Sheet workflow
- **Updated**: Managing Players & Guests guide now covers owner reassignment, creating new visitors from the roster, and player count adjustment
- **Updated**: Check-In & Billing guide now explains the Financial Summary section, inline payment method options (Card Reader, Card on File, Online Card, Waive), and fee badges
- **Updated**: Tours guide now documents native tour scheduling at /tour, 2-step booking flow, Google Calendar integration, and confirmation emails
- **New**: Application Pipeline training guide — covers the full membership application workflow from submission through checkout invitation
- **New**: Email Templates training guide — explains how to preview all automated email templates by category
- **Updated**: Getting Started guide now lists all current navigation items including Applications and Email Templates

## [7.65.3] - 2026-02-17

### Guest Participant Sync Fix
- **Fixed**: Adding a guest to a booking now correctly creates the participant record in the session — resolves $25 fee showing on calendar while booking details showed $0
- **Fixed**: Guest count on booking records now updates when guests are added through the roster
- **Fixed**: Fee recalculation now runs automatically after adding a guest, ensuring guest passes are properly applied
- **Improved**: Staff activity log now captures when guests are added to bookings

## [7.65.2] - 2026-02-17

### Booking Owner Reassignment
- **New**: Staff can now reassign booking ownership directly from the booking detail modal — tap the swap icon next to the owner's name, search for a member, and the booking transfers instantly
- **Improved**: Reassigning an owner now updates the display name, recalculates fees based on the new owner's tier, and logs the change to the staff activity feed

## [7.65.1] - 2026-02-17

### Trackman Booking ID Verification
- **New**: Trackman Booking ID verification — the system now validates that pasted IDs are real Trackman numbers (not UUIDs or other formats) before saving
- **New**: Duplicate Trackman ID prevention — blocks linking the same Trackman booking to multiple app bookings
- **Fixed**: Bookings with invalid Trackman IDs (like UUIDs) can now be cancelled directly without getting stuck in 'awaiting Trackman cancellation' state

## [7.65.0] - 2026-02-17

### Data Integrity & Zombie Member Prevention
- **New**: Permanently deleted members are now blocked from being re-created by ALL 16 user creation paths — including HubSpot sync, HubSpot webhooks, Stripe webhooks, Stripe subscription sync, Stripe reconciliation, group billing, subscription checkout, activation links, payment confirmations, POS terminal, visitor creation, and visitor matching
- **New**: Automated data integrity checks run daily and auto-fix common issues (billing provider gaps, case-inconsistent statuses, staff role mismatches)
- **New**: Calendar sync retry logic — temporary failures retry once before alerting, reducing false alarm notifications
- **Fixed**: 3 zombie test members (nick+astoria, adam+core, jack+testcore) that kept reappearing have been permanently removed and blocked
- **Fixed**: Onboarding checklist now properly tracks waiver signing, first booking, and profile completion
- **Improved**: HubSpot form sync errors are now handled quietly when they're just permission issues
- **Improved**: Payment reconciliation now has timeout protection to prevent stuck processes

## [7.64.0] - 2026-02-17

### Member Onboarding Overhaul
- **New**: Onboarding Checklist on the dashboard guides new members through 4 key steps — complete profile, sign waiver, book first session, and install the app
- **New**: First-login welcome modal greets new members with quick-start actions on their first sign-in
- **New**: Dashboard empty states now show helpful messages and action buttons instead of blank sections
- **New**: Automated email nudge sequence sends friendly reminders to members who haven't logged in (at 24 hours, 3 days, and 7 days)
- **New**: Application Pipeline admin view at /admin/applications lets staff track membership applications from inquiry through checkout invitation
- **New**: Staff can now send checkout invitations directly from the application pipeline with tier selection
- **Improved**: First login and first booking are now tracked automatically to measure member activation
- **Improved**: Waiver CTA in welcome modal now opens the waiver signing modal directly

## [7.63.5] - 2026-02-17

### Billing Security Audit — Final Hardening
- **Fixed**: Day pass billing no longer silently falls back to a hardcoded $50 price — now stops and logs an error if the price isn't properly configured
- **Fixed**: Corporate group billing no longer falls back to a hardcoded $350/seat price — now fails safely with a clear error if the Stripe subscription data is missing
- **Fixed**: Check-in fee snapshot recording now runs inside a database transaction — prevents duplicate or partial records if two staff members check in simultaneously

## [7.63.4] - 2026-02-17

### Complete Billing Idempotency Coverage
- **Fixed**: Subscription creation and its fallback payment intent now include idempotency keys — prevents duplicate subscriptions or charges during signup retries

## [7.63.3] - 2026-02-17

### Refund Safety & Complete Billing Hardening
- **Fixed**: All Stripe refund calls now include idempotency keys — prevents duplicate refunds from double-clicks or network retries across all cancellation and refund flows
- **Fixed**: Staff refund processing now wraps all database updates (payment status, participant records, usage ledger reversals, audit log) in a single transaction — partial failures no longer leave inconsistent data
- **Fixed**: Refund ledger reversal failures now properly roll back the entire refund record instead of silently continuing with partial data

## [7.63.2] - 2026-02-17

### Billing Idempotency & Transaction Safety
- **Fixed**: All Stripe payment intent creation calls now include idempotency keys — prevents accidental double charges from network retries or duplicate requests
- **Fixed**: Staff saved-card charge now wraps all database updates (participants, payment records, staff actions) in a single transaction — if any step fails, everything rolls back cleanly
- **Fixed**: POS saved-card charges now record in the payment intents table immediately — previously relied on webhook processing, which could leave a tracking gap
- **Fixed**: POS charge database writes (payment record + audit log) now wrapped in a transaction for consistency
- **Improved**: All Stripe API calls now use the managed client singleton — eliminated the last direct instantiation

## [7.63.1] - 2026-02-17

### Billing State Consistency Improvements
- **New**: Payment intents in 'processing' or 'requires action' states are now tracked in real-time — admin dashboards now accurately reflect payments waiting for 3D Secure authentication
- **Fixed**: When a payment fails, the associated fee snapshot is now immediately marked as failed — previously required the reconciliation scheduler to catch the inconsistency

## [7.63.0] - 2026-02-17

### Billing System Hardening
- **New**: Abandoned payment intents are now automatically cancelled after 2 hours — previously required manual Stripe dashboard visits or 7-day wait
- **New**: Payment modal now cleans up incomplete payments when closed or when the browser tab is closed — prevents orphaned charges
- **New**: Invoice PDF download links now appear alongside the 'View' button in the billing section
- **New**: Stripe credit notes are now processed via webhooks — members receive a notification when a credit is applied to their account
- **Improved**: Reconciliation scheduler now runs three cleanup passes every 15 minutes: fee snapshot sync, stale intent cleanup, and abandoned payment cancellation

## [7.62.0] - 2026-02-17

### Security Hardening & Bug Fixes
- **Fixed**: Payment routes (overage, member payments, guest pass purchases, balance payments) now require proper authentication — previously accessible without login in edge cases
- **Fixed**: Conference room prepayment routes now require authentication middleware
- **Fixed**: Member dashboard data endpoint now requires authentication middleware
- **Fixed**: RSVP creation now requires authentication — previously could be submitted without a logged-in session
- **Fixed**: Guest pass routes now require authentication middleware for all operations
- **Fixed**: Day pass redemption timezone bug — 'already redeemed today' check now uses Pacific time instead of UTC, preventing potential double-use near midnight
- **Fixed**: HubSpot member sync dates now use Pacific timezone instead of UTC — join dates and close dates are now accurate for evening signups
- **Fixed**: Billing date displays (booking dates, cancellation effective dates) now use Pacific timezone throughout
- **Fixed**: Staff check-in booking descriptions now show Pacific-timezone dates
- **Fixed**: Member join dates calculated from Stripe/HubSpot now use Pacific timezone
- **Fixed**: WebSocket origin validation tightened — previously a permissive substring check could match unintended domains
- **Fixed**: Background notifications and broadcasts now properly handle errors instead of silently failing
- **Fixed**: Guest pass use and refund operations are now wrapped in database transactions — partial failures can no longer leave data in an inconsistent state
- **Fixed**: Booking cancellation database writes are now transactional — prevents partially-cancelled bookings if something goes wrong mid-process
- **Fixed**: Events, RSVPs, announcements, closures, tours, wellness reviews, and member history endpoints now have result limits to prevent performance issues with large datasets
- **Fixed**: All error handling across the entire backend now uses proper TypeScript type safety (150+ catch blocks updated)
- **New**: Stripe subscription pause and resume events are now handled — if a membership is paused via Stripe, the member's status updates to frozen and staff are notified; resuming restores active status
- **New**: Staff and admin user creation, modification, and deletion now logged in the Staff Activity feed
- **New**: Application settings changes (individual and bulk) now logged in the Staff Activity feed
- **New**: Stripe coupon creation, updates, and deletion now logged in the Staff Activity feed
- **New**: Member role changes now logged in the Staff Activity feed for full accountability
- **Improved**: Database queries optimized — batch operations replace individual queries in group billing, booking notifications, calendar sync, and availability checks for faster performance

## [7.61.0] - 2026-02-15

### Staff Notification Delivery Fix
- **Fixed**: All cancellation notifications now reach every staff member individually instead of going to a single shared address — no more missed alerts
- **Fixed**: Staff-initiated cancellations, Trackman cancellation reminders, and stuck cancellation alerts all deliver to each staff member's notification feed, push, and real-time channel
- **Fixed**: Cancellation requests from the member booking page now use the same improved delivery as the command center
- **Fixed**: Trackman webhook cancellations now create proper staff notifications (database + push + real-time) instead of push-only
- **Fixed**: Manual bookings, billing migration alerts, and membership cancellation requests now use full delivery (previously database-only, no push or real-time)
- **Fixed**: Membership cancellation notification was sending broken data — now sends proper notification type
- **Improved**: Stuck cancellation scheduler checks all staff notifications instead of a single address when detecting recently alerted bookings
- **Improved**: Consolidated all staff notifications through a single reliable delivery system across the entire app

## [7.60.0] - 2026-02-15

### Cancellation Request Visibility for Staff
- **New**: Cancellation requests now appear directly in the Pending Requests queue in the Staff Command Center — no more missed cancellations
- **New**: Cancellation requests show a red 'Cancellation' badge with Trackman info so staff can immediately see what needs to be cancelled
- **New**: 'Complete Cancellation' button lets staff mark a cancellation as done directly from the command center after handling it in Trackman
- **Improved**: Cancellation alerts in the notification feed now have a prominent red border so they stand out from routine notifications
- **Improved**: Staff Command Center live-updates when a member submits or completes a cancellation — no manual refresh needed

## [7.59.0] - 2026-02-13

### Public Pages CRO Optimization
- **New**: Landing page hero rewritten with outcome-focused headline and flipped CTA hierarchy — tour booking is now the primary action
- **New**: Press/social proof bar added to landing page (Forbes, Hypebeast, etc.) and exclusivity signal with capped membership urgency
- **New**: Membership page now features Third Space positioning header, value-framing against country clubs ($20k+), and social proof section
- **New**: Book a Tour form enhanced with social proof, trust signals, and improved success screen with clear next steps
- **New**: Apply form updated with reassurance copy, privacy trust signal near submit, and enhanced confirmation screen linking to membership tiers
- **New**: Private Hire page CTA changed to 'Plan Your Event' with capacity signal (10–600+ guests), consent checkbox moved to final step per form best practices
- **New**: Gallery, What's On, Cafe, and FAQ pages now include conversion CTAs guiding visitors toward tour booking or membership
- **New**: FAQ page adds 'Is Ever Club just a simulator room?' as top objection-handling answer and a 'Still have questions?' CTA section
- **New**: Day Pass page now shows access details (wifi, cafe, lounge) and membership upsell path after purchase
- **New**: Contact page adds tour booking nudge at top and in success screen
- **New**: Phone number is now required on tour booking, membership application, and private hire inquiry forms
- **New**: Phone numbers auto-format as (xxx) xxx-xxxx across all forms for consistent data collection

## [7.58.0] - 2026-02-13

### Native Tour Scheduler
- **New**: Dedicated /tour page replaces the old external HubSpot meeting scheduler with a fully native booking experience built into the app
- **New**: 2-step flow — enter your info, then pick a date and time from real available slots pulled directly from the Tours Scheduled Google Calendar
- **New**: Booking creates a Google Calendar event on the Tours Scheduled calendar automatically
- **New**: Confirmation email sent to the guest with tour date, time, and club address
- **New**: Staff notifications for new tour bookings via in-app alerts and real-time updates
- **New**: Available time slots shown in 30-minute increments, 10am–5pm, filtered against existing calendar events and booked tours
- **Removed**: HubSpot meeting scheduler embed from landing page — 'Book a Tour' now links directly to /tour

## [7.57.0] - 2026-02-13

### HubSpot Integrity Sprint — Form Submission & Deal Enrichment
- **Fixed**: Form submissions no longer fail due to invalid contact properties being sent to HubSpot (event_date, event_time, additional_details, event_services, marketing_consent, topic were being rejected)
- **Fixed**: membership_interest casing mismatch — 'Not sure yet' now correctly maps to HubSpot's 'Not Sure Yet' dropdown value
- **New**: marketing_consent from forms now maps to eh_email_updates_opt_in contact property instead of being rejected
- **New**: Backend field filtering — only valid HubSpot contact properties are sent to the Form Submission API; all original fields still saved to local database
- **New**: Event deal enrichment — Private Hire and Event Inquiry forms now populate structured deal properties (event_date, event_time, event_type, expected_guest_count, event_services, additional_details) on the HubSpot deal record
- **New**: Created 3 custom HubSpot deal properties (event_time, event_services, additional_details) for structured event data
- **New**: Fire-and-forget deal enrichment finds the workflow-created deal and updates it with event details, or creates the deal directly if the workflow hasn't fired yet
- **Impact**: HubSpot workflows tied to form submissions (deal creation, follow-up emails) will now trigger reliably since form submissions no longer fail

## [7.56.0] - 2026-02-13

### Stripe Wins — Billing Provider Sync Hardening
- **New**: 'Stripe Wins' guard in HubSpot member sync — when a member is billed through Stripe, their membership status and tier can no longer be overwritten by stale Mindbody data flowing through HubSpot
- **New**: Database CHECK constraint on billing_provider column — only valid values (stripe, mindbody, manual, comped, family_addon) can be stored, preventing data corruption
- **New**: Billing Provider Hybrid State integrity check — daily scan detects members with mismatched billing data (e.g., labeled as Mindbody but holding a Stripe subscription)
- **New**: Outbound HubSpot sync protection — membership status is no longer pushed back to HubSpot for Mindbody-billed members, preventing sync loops between HubSpot and the app
- **New**: billing_provider_changed audit action for tracking billing provider migrations
- **Fixed**: When a Mindbody member migrates to Stripe, their grace period flags are now automatically cleared
- **Fixed**: Both full and focused HubSpot sync functions now respect the Stripe Wins guard consistently
- **Improved**: Stripe subscription sync now clears grace period data when transitioning a member from Mindbody to Stripe billing
- **Fixed**: All Stripe webhook handlers (subscription updates, terminal payments, disputes) now reinforce billing_provider='stripe' on every status change — prevents edge cases where billing provider could be missing
- **Fixed**: Subscription payment confirmation and invoice charge endpoints now set billing_provider='stripe' alongside membership activation
- **Fixed**: Grace period scheduler now explicitly passes billingProvider when syncing terminated status to HubSpot
- **New**: Sub-member HubSpot sync — when a primary member's Stripe subscription changes (active, past due, suspended, cancelled), all family/corporate sub-members now get their updated status pushed to HubSpot in real-time
- **New**: Group billing cancellation now syncs cancelled sub-members to HubSpot — previously only the primary member's status was reflected in HubSpot

## [7.55.0] - 2026-02-13

### Tier Data Integrity Hardening
- **New**: Database CHECK constraint on the tier column — only valid normalized tier values (Core, Premium, Social, VIP, Corporate, Staff, Group Lessons) can be stored, preventing data corruption at the source
- **New**: Database trigger auto-normalizes tier values on write — catches variants like 'Core Membership' and converts them to 'Core' before they reach the database
- **Fixed**: Data integrity reconciliation now normalizes HubSpot tier values before writing to the database instead of storing raw HubSpot format
- **Fixed**: All 3 HubSpot outbound push paths now consistently use denormalizeTierForHubSpot() instead of hardcoded mappings or raw values
- **Fixed**: Stripe webhook handlers now normalize tier metadata before database writes — covers subscription creation, checkout completion, group billing, and quick charge flows
- **Fixed**: Backfilled 465 membership_tier records to match canonical tier values, eliminating stale HubSpot-format values like 'Core Membership Founding Members'
- **Fixed**: Staff VIP enforcement on login now writes canonical 'VIP' to both tier and membership_tier instead of raw 'VIP Membership' format
- **Fixed**: Manual tier update tool now writes canonical tier names to database and maps legacy 'Founding' and 'Unlimited' to their correct tiers (Core and Premium)
- **Fixed**: HubSpot outbound pushes now skip unsupported tiers (like Staff) instead of sending raw values that HubSpot can't recognize
- **Improved**: membership_tier column now always derives from the canonical tier column — no more divergent values between the two columns

## [7.54.2] - 2026-02-13

### Unified Billing — Eliminate Duplicate Fee Logic
- **Fixed**: Booking detail panel now uses the same unified fee system as all other billing endpoints — eliminates ~120 lines of duplicate tier/overage/staff logic that could produce different results
- **Fixed**: Fee line items now correctly match to the right member in both new and existing bookings, preventing wrong fee assignments
- **Fixed**: All membership tiers (Social, Standard, Premium, VIP, Staff) now consistently go through the single source of truth for fee calculations
- **Improved**: Guest fee handling in booking details now uses the unified system's guest pass tracking instead of separate inline logic

## [7.54.1] - 2026-02-13

### Booking Fee Display Fix
- **Fixed**: Booking cards no longer show incorrect '$50 Due' for Premium members with unlimited access — the real-time fee calculation is now authoritative
- **Fixed**: Stale cached fee data no longer overrides fresh calculations, resolving mismatch between booking list and booking details
- **Improved**: Fee estimates for existing sessions now sync cached values to prevent future discrepancies

## [7.54.0] - 2026-02-13

### Full Frontend Audit — Dark Mode, Design Consistency & Performance Upgrades
- **New**: Dark mode support added to all 14 public pages that were missing it — Login, Contact, Gallery, Membership, WhatsOn, PrivateHire, FAQ, Cafe, forms, and more
- **New**: Liquid Glass styling added to 5 admin tabs that were visually inconsistent (Cafe, Tours, Settings, Team, Events)
- **Improved**: 70+ hardcoded color values replaced with design system tokens across 16 pages for easier theming
- **Improved**: Modal close animation — modals now smoothly fade out instead of disappearing instantly
- **Improved**: Admin feedback — CafeTab and TiersTab now show toast messages instead of browser alert popups
- **Improved**: Monitoring panels stop polling when browser tab is in background — saves battery and bandwidth
- **Improved**: Stripe and HubSpot scripts now load lazily for faster page loads
- **Improved**: Large libraries (Stripe, TanStack) split into separate bundles for better caching
- **Improved**: Stripe DNS preconnect added for faster checkout
- **Fixed**: Accessibility — 25+ form labels properly linked to inputs for screen readers
- **Fixed**: Profile page delete account error now correctly shows error message instead of success
- **Fixed**: DirectoryTab filter pills now display correctly in dark mode
- **Fixed**: EventsTab dark mode coverage expanded
- **Fixed**: Reduced-motion preference now properly handles all animated elements — no more invisible content
- **Fixed**: Theme transition speed improved from 0.4s to 0.3s for snappier feel
- **Fixed**: Safari mobile top toolbar now properly shows green to match the header — restored theme-color with light/dark mode support
- **Fixed**: Splash screen background changed from green to cream/bone for faster perceived load
- **Fixed**: PWA install splash screen background updated to match light theme
- **Fixed**: Dark mode splash screen uses proper dark olive background
- **Fixed**: Theme color dynamically updates when switching between light and dark modes
- 7.53.0
- 2026-02-13
- Admin Monitoring Dashboard — See Everything Running Under the Hood
- **New**: Email Templates page — preview all 18 email templates with sample data right from the admin sidebar, so you can see exactly what members receive
- **New**: Scheduled Tasks Monitor — see the health of all 25+ background jobs at a glance with green/yellow/red status lights, last run time, and run counts
- **New**: Webhook Event Viewer — browse incoming webhook events with type and status filtering, and click to expand full event details
- **New**: Job Queue Monitor — see pending, processing, completed, and failed background jobs with error details for failed ones
- **New**: HubSpot Sync Queue Status — monitor HubSpot sync queue depth, failed items, and average processing time
- **New**: System Alert History — timeline of all system alerts and notifications with severity colors and date range filtering
- **Fixed**: 10 scheduler error handlers that would crash instead of logging errors correctly
- **Fixed**: Security hardening on monitoring queries to prevent injection attacks
- 7.52.0
- 2026-02-12
- Data Tools: Full Audit & Optimization
- **Improved**: Reconcile Group Billing now logs all activity to the staff activity feed
- **Improved**: Backfill Stripe Cache now logs activity to the staff activity feed
- **Fixed**: Detect Duplicates now checks ALL members instead of only the first 100/500 — no more hidden duplicates
- **Improved**: Detect Duplicates HubSpot checks run faster with larger batches and shorter delays
- **Improved**: Stripe Customer Cleanup pre-loads all active members in one query instead of checking the database for each customer individually — dramatically faster
- **Improved**: Stripe Customer Cleanup skips all Stripe API calls for known active members and adds rate limiting to prevent Stripe throttling
- **Improved**: Archive Stale Visitors now uses indexed email lookups (7 new database indexes) for faster scanning
- **Improved**: Archive Stale Visitors adds rate limiting between Stripe check batches
- **Improved**: Placeholder Cleanup scan now logs activity to staff activity feed
- **Improved**: Placeholder Cleanup uses HubSpot batch delete (100 at a time) instead of deleting contacts one-by-one
- 7.51.0
- 2026-02-12
- Data Integrity: Accuracy, Resilience & Performance
- **New**: Each integrity check is now isolated — if one check fails (e.g., Stripe API is down), the rest continue running instead of the whole page crashing
- **New**: Per-check timing is now displayed so staff can see which checks are slow
- **Fixed**: Checks that failed due to API errors no longer silently report 'pass' — they now show a clear warning with the error details
- **Fixed**: Stripe Subscription Sync and Tier Reconciliation now check ALL members instead of a random sample of 100
- **Improved**: Tier Reconciliation now uses HubSpot batch API and caches Stripe products — dramatically fewer API calls
- **Improved**: Added 10 database indexes to speed up orphan record checks and foreign key lookups
- 7.50.0
- 2026-02-12
- Bulk HubSpot Push — End the Mismatch Cycle
- **New**: 'Push All to HubSpot' now pushes tier, first name, and last name for ALL members to HubSpot at once — not just the random 100 shown in the integrity check
- **Improved**: Uses HubSpot batch API to update up to 100 contacts per call, dramatically faster than one-by-one syncing
- **Improved**: Only updates contacts that actually have mismatches, saving API calls and reducing rate limit risk
- **Fixed**: Churned and expired members now correctly have their HubSpot tier cleared to empty instead of leaving stale values
- 7.49.0
- 2026-02-12
- HubSpot Sync Accuracy & Auto-Merge
- **Fixed**: HubSpot sync mismatch checks now compare the correct active membership tier instead of a stale legacy field, dramatically reducing false mismatch alerts
- **Fixed**: Terminated, expired, and non-member accounts no longer trigger false tier mismatches — their empty tier in HubSpot is now correctly recognized as expected
- **Fixed**: 'Sync to HubSpot' push now sends the properly mapped tier value and clears the tier for churned members instead of pushing stale data
- **Fixed**: 'Pull from HubSpot' now updates the active tier field in the app, not just a legacy column that the app doesn't use
- **New**: HubSpot ID Duplicate issues now have a one-click Merge button — when contacts are merged on HubSpot's side, you can merge the matching app accounts with a single click
- 7.48.8
- 2026-02-12
- Outstanding Balance Accuracy Fix
- **Fixed**: Outstanding fees now show accurately in member profile drawer by computing fees on-the-fly for sessions that hadn't been cached yet
- 7.48.7
- 2026-02-12
- Archive Stale Visitors Fix
- **Fixed**: Archive Stale Visitors tool was finding eligible visitors but failing to actually archive them due to a database query issue
- **Improved**: Archive scan now also checks the booking participants table, so visitors who have bookings through the current system won't be incorrectly flagged as stale
- 7.48.6
- 2026-02-12
- Trackman Import Merged Account Fix
- **Fixed**: Trackman bookings were incorrectly linking to old merged accounts instead of the active member account, causing false fees and a 'Merged' badge on bookings
- **Fixed**: Corrected 2 bookings for William Holder that were linked to his old merged account — fees zeroed and membership benefits now apply
- **Improved**: Trackman import now automatically skips merged accounts when matching members, preventing this issue from happening again
- 7.48.5
- 2026-02-12
- Outstanding Balance Relocated to Staff View
- **Changed**: Outstanding balance card removed from the member dashboard — members no longer see unfinalized fee amounts that could cause confusion
- **Changed**: Outstanding fees now appear in the staff member profile drawer under the Account Balance section, with total owed, item count, and expandable breakdown
- **Improved**: Staff still have full visibility into overage and guest fees pending collection for each member
- 7.48.4
- 2026-02-12
- Trackman Import Billing Accuracy Fix
- **Fixed**: Sessions imported from Trackman now correctly store billing amounts on each participant, so the Overdue Payments list shows accurate totals instead of incorrect charges
- **Fixed**: In multi-player sessions, each player is now correctly charged for their share of the time (e.g., 2 players in a 2-hour session each get 1 hour) instead of the booking owner being charged for the full session duration
- **Fixed**: $0 fees are no longer confused with 'not yet calculated' — members within their daily allowance correctly show $0 owed
- **Fixed**: Corrected billing data for 2 affected sessions that had incorrect charges from the previous import logic
- 7.48.3
- 2026-02-12
- Payment Failure Webhook Hardening
- **Improved**: Payment failure handling is now more resilient — the system validates the subscription status before putting a member into a grace period, so stale or already-canceled subscriptions don't accidentally trigger grace periods
- **Fixed**: HubSpot sync for failed payments now runs after the database save completes, preventing partial updates if something goes wrong mid-process
- **Added**: Staff now see the Stripe attempt count and specific decline codes (e.g., 'insufficient_funds') in payment failure alerts, making it faster to diagnose issues
- **Added**: Automatic error alerts are now sent for all payment failures, with escalating urgency for repeated failures
- **Fixed**: If a member's grace period was already started, duplicate payment failure events no longer send duplicate notifications
- **Improved**: Email matching for payment failures is now case-insensitive across all lookups, preventing missed notifications for members who signed up with mixed-case emails
- 7.48.2
- 2026-02-12
- Terminal Cancel & Payment Polling Improvements
- **Fixed**: Card reader payments no longer show 'Payment Failed' while the terminal is still waiting for the customer to tap — the system now correctly waits for the card instead of treating the waiting state as an error
- **Improved**: Cancel button now fully cancels both the reader action and the pending payment in Stripe, so no orphan charges are left behind
- **Added**: Cancel button shows a loading spinner while canceling to prevent double-clicks
- **Added**: If the card was already tapped right as you hit Cancel, the system detects this and treats it as a successful payment instead of erroring out
- **Improved**: Card decline messages now show the specific reason from Stripe (e.g., 'Card declined: insufficient funds') instead of a generic error
- 7.48.0
- 2026-02-12
- Create Member Flow Reliability Fix
- **Fixed**: 'Send Link' and 'Copy Link' buttons no longer error out on the first click — eliminated a race condition where the in-person payment setup would conflict with the link-sending process
- **Fixed**: 'Copy Link' now reliably copies the checkout URL to your clipboard — the link is fully generated before the copy happens
- **Improved**: Payment step now shows a clear choice between 'Collect Payment Now' (card/reader) and 'Send Payment Link' — prevents both flows from running at the same time
- **Added**: Double-click protection on Send/Copy Link buttons — prevents accidental duplicate submissions
- **Improved**: Better error messages — if a pending signup conflicts, you'll see a clear message instead of a generic error
- 7.47.1
- 2026-02-11
- POS Terminal Invoice Payment Fix
- **Fixed**: POS terminal payments with cart items now work reliably — the system creates a dedicated card-reader payment instead of relying on invoice auto-payment, which failed when customers had no card on file
- **Fixed**: Invoice is now automatically marked as paid once the card reader successfully processes the payment
- **Improved**: Terminal invoice flow properly handles the case where a new customer has never saved a card before
- 7.47.0
- 2026-02-11
- Staff Terminal UI & Card Management
- **Added**: 'Update Card via Reader' button on the member billing tab — staff can now update a member's payment method directly from their profile using the card reader, no charge required
- **Added**: When no card is on file, an 'Add Card via Reader' button appears so staff can add one right from the profile
- **Improved**: Card reader waiting screen now shows a clear 'Waiting for Reader...' display with pulsing animation, helpful instructions, and a prominent Cancel button
- **Improved**: Save-card mode shows a 'No charge — saving card only' notice so staff know no money is being taken
- **Added**: Auto-cancel notice on the waiting screen reminds staff the action will timeout after 2 minutes
- 7.46.0
- 2026-02-11
- Stripe Terminal & Wellness Improvements
- **Fixed**: Wellness class enrollment button no longer causes accidental cancellations from rapid double-taps — added cooldown protection and deferred UI updates
- **Fixed**: Terminal invoice payments now use the correct price format — resolves failed in-person invoice charges
- **Added**: Terminal subscription payments now automatically save the card for future recurring billing
- **Added**: Staff can now update a member's payment card on file via the card reader without charging them
- **Added**: Card reader interactions now have a 2-minute timeout — if the reader doesn't respond, the action is automatically canceled to prevent stuck states
- **Fixed**: Card save confirmation now properly verifies success before showing the 'saved' message — prevents false success reports
- 7.45.0
- 2026-02-11
- HubSpot Deal Creation Disabled & Cleanup
- **Changed**: HubSpot deal creation is now disabled — no new deals will be created until further notice
- **Changed**: All 2,703 existing HubSpot deals created by the app have been removed from HubSpot
- **Changed**: Local deal tracking tables cleared — HubSpot contacts and other syncing still work normally
- 7.44.2
- 2026-02-11
- New Member Signup & Reschedule Fixes
- **Fixed**: Adding a new member no longer blocks with 'incomplete signup' error — stale pending records are automatically cleaned up and reused
- **Fixed**: Rescheduling a conference room booking now shows conference rooms in the dropdown instead of simulator bays
- **Fixed**: Reschedule labels dynamically show 'Room' instead of 'Bay' for conference room bookings
- **Fixed**: Rescheduling a conference room no longer asks for a Trackman Booking ID — that only applies to simulator bookings
- 7.44.0
- 2026-02-11
- Conference Room Booking Fixes
- **Fixed**: Members can now book conference rooms even if they have a pending simulator request — these are separate systems
- **Fixed**: Having a simulator booking on the same date no longer blocks conference room bookings (and vice versa)
- **Fixed**: Conference room access is now correctly checked using the conference booking permission, not the simulator permission
- **Fixed**: Confirmed conference room bookings now properly count toward your daily allowance to prevent double-booking
- **Fixed**: Conference room access check on the booking page now uses the correct permission flag from your membership tier
- 7.43.1
- 2026-02-11
- Wellness External URL Data Fix
- **Fixed**: External URL for wellness classes was being dropped during data loading on the member page — 'Learn More' buttons now appear correctly
- **Fixed**: Data mapping now properly passes external_url from the API through to the wellness class cards
- 7.43.0
- 2026-02-11
- External Link Buttons for Events & Wellness
- **New**: Events and wellness classes with an external URL now show a 'Learn More' button that opens the link directly
- **New**: External link buttons work on the public What's On page too — replacing the greyed-out 'Members Only' placeholder
- **New**: Eventbrite events keep their existing 'Get Tickets' style; admin-set external links get the green 'Learn More' style
- **Improved**: Member events page now opens external links for all events with a URL, not just Eventbrite ones
- 7.42.2
- 2026-02-11
- Trackman Link & SQL Safety Fixes
- **Fixed**: Linking a Trackman booking to a member no longer fails due to a data type mismatch — user IDs are now properly stored as text
- **Fixed**: Staff notes on linked bookings now build correctly instead of using a raw database expression that could fail
- **Fixed**: Both 'update existing booking' and 'create new booking' paths in the Trackman link flow now handle user ID types consistently
- 7.42.1
- 2026-02-11
- Private Event Linking & Blocks Pagination
- **Improved**: 'Mark as Private Event' now always shows all same-day notices so staff can choose which one to link to, preventing duplicate blocks
- **Improved**: When no notices exist for the day, staff still sees the option to create a new one
- **New**: Blocks tab now shows 10 days at a time with a 'Load More' button at the bottom instead of the full list
- 7.42.0
- 2026-02-11
- Data Integrity Audit & Hardening
- **Fixed**: Stripe subscription sync now checks a random sample of members each run instead of always checking the same 100
- **Fixed**: Removed duplicate 'Empty Booking Sessions' check that overlapped with 'Sessions Without Participants'
- **Fixed**: Severity map now correctly maps all 24 integrity checks — removed 3 phantom entries and added 4 missing ones
- **Fixed**: Pending user cleanup now safely removes all related records (bookings, notifications, fees, etc.) in a transaction before deleting the user
- **New**: Stale tours older than 7 days are automatically marked as 'no-show' during integrity checks
- **New**: Data cleanup runs automatically before scheduled integrity checks to resolve transient issues first
- **New**: Email normalization now covers 6 tables (added event RSVPs, wellness enrollments, guest passes)
- **New**: Orphaned fee snapshots (from deleted bookings) are automatically cleaned up during data maintenance
- **Improved**: Cleanup route response now reports orphaned fee snapshot removal count
- 7.41.0
- 2026-02-11
- Facility Page Redesign — Liquid Glass
- **New**: Glass Segmented Control replaces bulky tab buttons — compact pill shape with a sliding white active indicator
- **New**: Unified Glass Toolbar consolidates filters, color legend, and Google Calendar sync status into one sticky row
- **New**: Glass Card layout for all notices — translucent cards with colored left border, hover lift effect, and shadow depth
- **New**: Edit buttons now fade in on hover (desktop) to reduce visual clutter, always visible on mobile
- **New**: Closure Reasons and Notice Types collapsed into compact pill badges instead of large grid sections
- **Improved**: Needs Review drafts use the same Glass Card treatment with cyan left border
- **Improved**: Past notices section uses glass styling with subtle opacity treatment
- 7.40.3
- 2026-02-11
- Calendar Grid Interaction Redesign
- **New**: Booked calendar slots now lift on hover with a smooth scale-up effect for better visual feedback
- **New**: Hover tooltip on booked slots shows member name, time, player count, fees owed, and status at a glance
- **New**: Empty calendar cells now display a subtle dot matrix texture instead of blank white space
- **Improved**: Tooltip adapts to light and dark themes with frosted glass styling
- 7.40.2
- 2026-02-11
- Toast Notification Redesign
- **New**: Redesigned toast notifications with Liquid Glass aesthetic — frosted glass strip with colored left border
- **New**: Spring-physics entrance animation slides toasts in from the top-right with a bouncy overshoot effect
- **New**: Progress bar countdown — a 1px bar at the bottom visually shrinks to show remaining auto-dismiss time
- **New**: Toast now displays a bold status title (Success, Error, Warning, Notice) above the message
- **Improved**: Toast styling adapts to light and dark themes with proper contrast
- 7.40.1
- 2026-02-11
- Training Guide Completeness Update
- **New**: Added POS Register training guide covering cart management, customer selection, and three payment methods
- **New**: Added Settings training guide covering club config, timezone, payment category labels, and alert toggles
- **New**: Added Discounts & Coupons training guide covering Stripe coupon creation, editing, and redemption tracking
- **New**: Added View As Member training guide explaining how staff can see the app from a member's perspective
- **Fix**: Corrected navigation icons for Facility, Directory, and Financials to match the actual sidebar
- 7.40.0
- 2026-02-11
- Training Guide Audit & Update
- **New**: Added Conference Room Bookings training guide covering auto-confirmation, daily allowance, and overage prepayment
- **New**: Added Waiver Management training guide covering waiver signing, versions, and stale waiver reviews
- **Fix**: Updated Member Directory training to show correct profile drawer tabs (Overview, Billing, Activity, Notes, Communications)
- **Fix**: Updated Financials training to reflect correct Transactions sub-sections (Summary, Pending, Overdue, Failed, Refunds, Recent)
- **Improved**: Added training steps for directory sorting, billing filters, visitor source filters, and the pending booking limit rule
- **Fix**: Corrected navigation icons for Products & Pricing, Manage Team, and Data Integrity to match the actual sidebar
- **Improved**: Day pass training now mentions the POS Register as an alternative sales channel
- 7.39.7
- 2026-02-11
- Booking Confirmation Reliability Fix
- **Fix**: Booking requests now reliably show the success confirmation — previously a database cleanup error could cause the booking to save correctly but show an error message to the member instead of the success toast
- 7.39.6
- 2026-02-11
- Chronological Fee Ordering Fix
- **Fix**: When a member has multiple bookings on the same day, overage fees are now correctly assigned to the later booking — previously the earlier booking could be charged overage because the system counted the later booking's usage first, making it look like the daily allowance was already used up
- 7.39.5
- 2026-02-11
- Fee Display Accuracy Improvements
- **Fix**: Booking cards now show the correct total fee including empty slot guest fees — previously the card could show a lower amount than what the booking sheet displays when a booking has unfilled player slots
- **Fix**: Fee estimate no longer double-counts the booking's own usage against the daily allowance, so members within their limits no longer see incorrect overage charges
- 7.39.4
- 2026-02-11
- Fee Estimate Double-Count Fix
- **Fix**: Booking cards no longer show incorrect fees due — the fee estimate was counting the booking's own usage against the member's daily allowance, making it look like every booking had overage when members were actually within their limits
- 7.39.3
- 2026-02-11
- PWA Safari Polish
- **Fix**: Safari PWA status bar now matches the green header instead of showing a light-colored bar
- **Fix**: Eliminated white gaps at the bottom of modals and drawers on iOS PWA by replacing the scroll lock strategy — no longer forces the page position, which was conflicting with Safari's dynamic viewport
- **Fix**: All modal overlays (profile drawer, booking details, confirmations, welcome banner) now use dynamic viewport height so they correctly fill the screen on iOS devices
- 7.39.2
- 2026-02-11
- Booking Confirmation Toast
- **Improvement**: Members now see a clear toast notification confirming their booking request was sent — previously the only confirmation was a brief banner that could be easily missed
- 7.39.1
- 2026-02-11
- Guest Pass & Fee Estimate Fixes
- **Fix**: Guest passes now apply correctly for Corporate tier members — previously passes weren't being used during booking even when the guest had full name and email entered
- **Fix**: Fee estimate no longer double-charges when booking with other club members — additional members were incorrectly counted as empty guest slots, adding an extra $25 per member
- **Fix**: 'Passes remaining after booking' now shows the correct count (e.g. 14 of 15) instead of always showing 0
- **Fix**: Member emails are now passed to the fee estimate so the system knows about all players in the booking, preventing phantom empty slot charges
- **Improvement**: Guest pass eligibility check is now more resilient — if a tier has monthly guest passes allocated, they'll work even if the feature flag wasn't explicitly set
- **Improvement**: Staff queue list now shows accurate fee amounts using the same calculation members see — previously it used a simplified estimate that didn't account for guest passes or member participants
- **Improvement**: Calendar grid fee indicators (red dot with $X owed tooltip) now also use the same server-side calculation — all fee displays across the app are now unified
- 7.39.0
- 2026-02-11
- Stripe Sync + Billing Safety
- **Feature**: The Sync button on the Members page now syncs both HubSpot AND Stripe — if any webhooks were missed, one tap catches up all member statuses, subscriptions, and tiers
- **Feature**: Stripe sync checks each member's subscription against Stripe and fixes mismatches (status, tier, subscription link) — also finds and links subscriptions for members who have a Stripe customer but no subscription on file
- **Fix**: Billing recalculation now uses a database transaction — if something goes wrong mid-recalculation, the original billing records are preserved instead of being lost
- 7.38.2
- 2026-02-11
- Activation Link Fix + Charge Saved Card
- **Fix**: Members who completed payment through an activation link were stuck in 'pending' status and didn't appear in the directory — the system now automatically activates them and links their subscription when payment completes
- **Fix**: Subscription webhook now properly updates existing pending members with their subscription ID and active status, instead of only sending notifications without activating them
- **Fix**: Tier detection from subscription metadata now works for all checkout flows (activation links, staff invites, corporate) regardless of metadata key format
- **Fix**: Subscription webhook now properly links the Stripe customer ID when matching members by email, preventing future webhook lookup failures
- **Feature**: Staff can now send activation emails and copy activation links directly from a member's billing tab when their subscription is awaiting payment
- **Feature**: Collect Payment modal now offers two options — Card Reader (terminal) or Charge Saved Card — so staff can charge a member's card on file without needing the physical reader
- **Improvement**: Charge Saved Card shows the specific card that will be charged (brand, last 4 digits, expiry) before confirming
- **Improvement**: All charge-card actions are logged in the staff activity feed for audit purposes
- 7.37.0
- 2026-02-11
- Stripe Customer Cleanup & Lazy Customer Creation
- **Improvement**: Stripe customer cleanup tool now preserves active members — only removes non-active members and orphaned customers with zero transaction history
- **Improvement**: Cleanup preview now shows how many active members were skipped, so staff can see they're being protected
- **Improvement**: All fee-charging flows (overage fees, guest fees, prepayments, day passes) automatically create a Stripe customer if one doesn't exist yet — no manual setup needed
- **Fix**: Hard delete for unmatched bookings was failing because of an incorrect database table name — now works correctly
- 7.36.0
- 2026-02-11
- Trackman Import Fixes, Email Sender Name & Booking Deletion
- **Fix**: Trackman CSV imports no longer fail when a booking's updated time overlaps with another booking on the same bay — the system now skips the time change and still applies all other updates (member linking, notes, player count)
- **Fix**: Trackman imports now support sessions up to 6 hours (360 minutes) — previously only allowed up to 5 hours, causing some longer sessions to fail
- **Fix**: Trackman import error notifications now show the actual reason for failure instead of raw database query text
- **Fix**: Emails now display 'Ever Club' as the sender name instead of 'noreply'
- **Fix**: Resolved deal stage drift data integrity error for members with duplicate HubSpot deals
- **Feature**: Staff can now fully delete unmatched/unassigned Trackman bookings — the booking is completely removed from all database tables so the time slot opens back up for other members
- 7.35.0
- 2026-02-11
- Account Credits + Trackman Session Fix
- **Fix**: Trackman webhook bookings now correctly create sessions — previously, unmatched bookings from Trackman failed to create sessions due to an invalid source value, causing errors on every incoming webhook
- **Improvement**: Account credits now automatically apply to overage fee payments during check-in — if a member has enough credit, the overage is covered instantly without needing to enter a card
- **Improvement**: Account credits now apply to staff-initiated booking fee payments (guest fees, overage charges from the check-in flow)
- **Improvement**: Account credits now apply to booking prepayments created when a booking is approved
- **Improvement**: Account credits now apply to guest pass purchases from the member portal
- **Improvement**: Account credits now apply when members add guests to their bookings (guest fee checkout)
- **Improvement**: Account credits now apply when staff charge booking fees using a member's saved card
- **Improvement**: When credit fully covers a charge, the system skips the payment form entirely and shows a confirmation that credit was used
- **Improvement**: When credit partially covers a charge, only the remaining amount is charged to the member's card
- 7.34.3
- 2026-02-10
- Unmatched Trackman Bookings Now Visible on Calendar & Queue
- **Fix**: Unmatched Trackman bookings (ones without a matched member) were not appearing on the calendar table or queue list — staff couldn't see them or know which bays were occupied
- **Fix**: Trackman webhook was incorrectly storing confirmed bookings as 'pending' when session creation failed, even though the booking is real and confirmed on Trackman's side — now keeps them as 'approved' so they block availability on the calendar
- **Fix**: Updated all existing pending unmatched bookings to 'approved' status so they immediately appear on the calendar and in the queue for staff assignment
- **Improvement**: Calendar table and queue list now include a safety net to always show unmatched Trackman bookings even if a future edge case sets them to pending
- 7.34.2
- 2026-02-10
- Account Credit Consumption Fix
- CRITICAL FIX: When a member's account credit only partially covered a booking fee, the credit was never actually consumed — it stayed on the account and could be reused infinitely, giving unlimited discounts
- **Fix**: The system now charges only the remaining amount (after credit) on the member's card, and properly consumes the credit from their Stripe balance after the payment succeeds
- **Improvement**: Cleaner payment flow — members no longer see a full charge followed by a partial refund; they only see the net amount charged to their card
- **Safety**: Credit is only consumed after the card payment succeeds, so if the card is declined, the credit stays on the account
- 7.34.1
- 2026-02-10
- HubSpot Lifecycle Stage Fix
- **Fix**: HubSpot sync was failing for some contacts because the system tried to set lifecycle stage to 'member' which is not a valid HubSpot stage — now correctly uses 'customer' for active members and 'other' for inactive members
- **Fix**: Applied across all HubSpot sync paths (contact creation, member sync, and stage updates) so no contacts are missed
- 7.34.0
- 2026-02-10
- Payment Status Enforcement & Pending Badge System
- CRITICAL FIX: Members are now correctly set to 'pending' status until their Stripe subscription payment actually succeeds — previously members were activated before payment completed, creating a critical billing gap
- **Feature**: Added 'Pending' badge that appears next to the tier badge (e.g., 'Premium' + 'Pending') in both the member profile drawer and the directory — staff can now clearly see when payment hasn't been completed yet
- **Fix**: Stripe webhook now properly maps all subscription statuses — incomplete subscriptions no longer trigger member activation
- Data Correction: Corrected 3 test members' status back to pending after recent billing changes
- 7.33.3
- 2026-02-10
- Activation Link Endpoint Fix
- **Fix**: Activation link endpoint now properly handles existing members — previously always failed with 'member already exists' error
- **Improvement**: If the member is fully active with a subscription, the endpoint gives a clear message that no link is needed
- **Improvement**: If the member exists but hasn't completed subscription setup (cancelled, terminated, etc.), the link can now be resent
- **Improvement**: Staff can now easily resend activation links when needed without hitting 'member already exists' errors
- 7.33.2
- 2026-02-10
- Trial Onboarding Email Flow
- **Feature**: First-visit confirmation email sent automatically when a trial member checks in via QR code for the first time
- **Feature**: Email includes step-by-step guide on how to use the app — booking golf simulators, browsing events, and exploring wellness services
- **Fix**: Paused members are now correctly blocked from logging in (account preserved for future renewal)
- **Fix**: Trialing members now correctly recognized in fee calculations and tier lookups — previously a typo ('trial' vs 'trialing') caused their membership tier to be ignored
- **Fix**: Trackman billing reconciliation now correctly identifies trialing members as active
- 7.33.1
- 2026-02-10
- Terminal Card Saving Gap Coverage
- **Fix**: Card now saves correctly even when membership is activated by a background process before staff confirms — previously the card save was skipped entirely in this scenario
- **Fix**: Subscription payment pending amount now correctly reflects any coupon or discount applied (was showing full price before)
- **Fix**: Receipt emails now included for terminal subscription payments collected from the billing tab
- **Fix**: Corrected internal data type for member ID in billing tab to prevent potential lookup mismatches
- 7.33.0
- 2026-02-10
- Terminal Card Saving & Billing Improvements
- **Feature**: Terminal card payments now automatically save the card for future subscription renewals — no extra steps needed from the member
- **Feature**: 'Collect Payment' button in member billing tab for pending members with incomplete subscriptions — staff can complete activation via card reader
- **Feature**: Billing tab now shows 'Subscription payment pending' with amount due instead of misleading 'No outstanding fees' for incomplete subscriptions
- **Feature**: 'No card on file for renewals' warning in billing tab when active subscription has no saved payment method
- **Fix**: ID scan images now save correctly after terminal and inline card payments during signup
- **Fix**: Removed duplicate ID image save that fired twice during signup flows
- 7.32.2
- 2026-02-10
- HubSpot Form Submissions Sync
- **Feature**: Added automatic sync of HubSpot form submissions — inquiries submitted on the production app now appear in all environments
- **Feature**: Sync runs every 30 minutes and can also be triggered manually from the admin tools
- 7.32.1
- 2026-02-10
- Private Hire Page Updates
- **Improvement**: Updated venue capacities — Main Hall now shows 600 max, Private Dining Room shows 30 seated
- **Improvement**: Removed firepit and outdoor heating references from Terrace listing
- **Feature**: Added comprehensive services section to Private Hire page — Flexible Floorplans, Golf Facilities, Custom Décor, Live Music, Food & Beverage Programs, Advanced AV, and Parking details
- 7.32.0
- 2026-02-10
- Visitor Directory Cleanup & Archive System
- **Feature**: Archived 2,308 non-transacting contacts (no Stripe customer or MindBody history) to declutter the visitors directory — down from ~2,800 contacts to ~470 active contacts with real transaction history
- **Feature**: Active/Archived toggle on visitors tab — staff can switch between viewing current active contacts and the archived list at any time
- **Improvement**: HubSpot sync now skips creating new local user records for contacts that have no membership status, no Stripe customer, and no MindBody client ID — prevents re-importing non-transacting contacts
- **Improvement**: Auto-unarchive — when an archived contact makes a purchase (day pass, terminal payment, etc.) and gets a Stripe customer record, they are automatically restored to the active directory
- **Safety**: Day pass purchases and visitor matching now correctly find and unarchive archived users instead of creating duplicates
- **Safety**: Creating a new membership for an archived contact now unarchives and reuses the existing record instead of blocking with 'already exists' error
- **Safety**: Subscription creation rollback safely re-archives reused records instead of deleting them
- **Safety**: Trackman import matching still searches all users including archived — historical booking data links are preserved
- **Safety**: 11 contacts with booking participation records were preserved even though they lacked Stripe/MindBody IDs
- 7.31.8
- 2026-02-10
- Trackman Import Matching & Unresolved Table Improvements
- **Fix**: Trackman CSV import now matches bookings to non-members and visitors from the local database — previously only HubSpot contacts were checked, so users with valid trackman_email mappings who weren't in HubSpot would fail to match
- **Improvement**: Unresolved Trackman bookings table now shows Booking ID column instead of redundant Status column — all rows are unmatched by definition, so the Trackman booking ID is more useful for reference
- 7.31.7
- 2026-02-10
- Outstanding Balance & Payment Receipt Details
- **Feature**: Staff can now see a member's outstanding balance in the Billing tab of the member profile drawer — shows total owed and itemized unpaid fees (date, time, bay, fee type, amount) without needing 'View As'
- **Improvement**: Stripe payment receipts now show per-participant fee breakdown — e.g. 'Guest: John Doe — $25.00, Overage — $25.00' instead of generic 'Booking Fees'
- **Improvement**: Staff-initiated saved-card charges also include per-participant breakdown in Stripe description and metadata
- **Fix**: Three remaining hardcoded $25 guest fee values now use dynamic pricing from Stripe (Trackman admin pending slots, overdue-payments endpoint)
- 7.31.6
- 2026-02-10
- Billing Audit — Dynamic Pricing & Hardcoded Fee Fixes
- **Fix**: Trackman admin pending-assignment slot fee now uses the real guest fee from Stripe instead of a hardcoded $25 — prevents drift if pricing changes
- **Improvement**: Staff simulator fee estimates now pull tier-specific daily minutes from the database instead of hardcoded values — tier limits (VIP, Premium, Corporate, Core, Base, Social) are fully dynamic
- **Improvement**: Pricing API now exposes tier included minutes alongside guest fee and overage rate — all three pricing dimensions sourced from database
- **Safety**: Frontend fee estimator retains hardcoded fallbacks if pricing API is unavailable — no regression on network failure
- 7.31.5
- 2026-02-10
- Booking Fee Display & Email Sender Fixes
- **Fix**: Booking card fee button now includes guest fees for unfilled player slots — previously only showed the owner's overage fee from the database, ignoring estimated fees for empty slots
- **Fix**: Calendar grid fee display also updated to include unfilled slot fees
- **Improvement**: All outgoing emails now consistently show 'Ever Club' as the sender name instead of 'noreply' or inconsistent variations
- 7.31.4
- 2026-02-10
- POS Receipt Line Items
- **Improvement**: POS purchases now show individual line items on Stripe receipts and dashboard — instead of a single lump sum with concatenated description
- **Improvement**: All three POS payment methods (card reader, online card, saved card) now create Stripe Invoices with itemized products
- **Improvement**: Stripe receipts now include per-item name, quantity, and price for cafe/POS purchases
- **Safety**: Invoice items are isolated per transaction — failed transactions cannot leak items into future charges
- **Safety**: Failed invoice creation automatically cleans up draft invoices before falling back to standard payment
- 7.31.3
- 2026-02-10
- Fee Display Fix & Code Cleanup
- **Fix**: My Balance card now includes expected guest fees for unfilled player slots — previously only showed owner's overage fee
- **Fix**: Booking card fee button now shows correct total ($125 instead of $75) — was ignoring database-computed fees when player slots were unfilled
- **Fix**: Fee estimate calculation no longer splits booking duration across players — owner uses full duration for overage (matches real billing engine)
- **Improvement**: Member 'Add Guest' form now uses separate First Name and Last Name fields (matching staff-side UX from v7.31.1)
- **Cleanup**: Removed 6 orphaned component files no longer used anywhere (~1,526 lines of dead code)
- **Cleanup**: Consolidated duplicate PlayerSlot type — single source of truth in shared PlayerSlotEditor, re-exported by bookGolfTypes
- **Cleanup**: Removed 9 unused imports across 5 files (unused React hooks, utility functions, type imports, components)
- **Cleanup**: Removed unused exported functions from shared utilities (closureUtils, statusColors) — kept only actively used exports
- **Cleanup**: Removed unused TrackmanNotesModal — manual bookings and pending requests already generate Trackman notes
- **Fix**: Corrected pre-existing SQL join error in Trackman needs-players endpoint (wrong column name)
- 7.31.1
- 2026-02-10
- Guest Booking UX Improvements
- **Improvement**: Split single 'Guest name' field into separate 'First name' and 'Last name' fields — guest passes now collect proper names for identification
- **Fix**: Fee estimate no longer shows confusing '0 of 15' passes remaining when guest details haven't been entered — now shows helpful 'Enter guest details above to use passes' message
- **Improvement**: Guest pass eligibility now requires first name, last name, AND email — per-slot indicator updated to show exactly what's needed
- **Improvement**: Info banner updated to clearly state 'first name, last name, and email' requirement for guest pass usage
- 7.31.0
- 2026-02-10
- Major Code Organization Refactoring
- **Improvement**: Split 6 large files (2,000-3,500 lines each) into modular subdirectories — EventsTab (94% smaller), NewUserDrawer (85% smaller), MemberProfileDrawer (29% smaller), BookGolf (23% smaller), SimulatorTab (50% smaller), DataIntegrityTab (45% smaller)
- **New**: Shared FeeBreakdownCard component — reusable fee display for both member and staff booking interfaces, showing overage, guest fees, and pass usage in one consistent layout
- **New**: Shared PlayerSlotEditor component — unified player/guest management with per-slot member search (privacy-safe redacted emails for members), guest name + email fields, clear guest pass eligibility messaging, and per-slot status indicators (green 'Pass eligible' vs amber 'Guest fee applies')
- **Improvement**: Consolidated duplicate status badge functions across 3 billing files into shared statusColors utility with new getSubscriptionStatusBadge, getInvoiceStatusBadge, and getBillingStatusBadge functions
- **Improvement**: Extracted shared closure display utilities (getNoticeTypeLabel, formatAffectedAreas, isBlockingClosure) — replaced duplicate logic in 3 files (Updates page, ClosureAlert, ResourcesSection)
- **Improvement**: No visual or behavioral changes — all refactoring is internal code organization for better maintainability
- 7.30.2
- 2026-02-10
- Timezone & Reliability Fixes
- **Fix**: Future bookings query now uses Pacific time instead of server time — no more wrong bookings showing near midnight
- **Fix**: User merge safety check now uses Pacific time — correctly detects active sessions regardless of server timezone
- **Fix**: Removed dead duplicate billing portal route that could cause confusion during maintenance
- **Fix**: Trackman auto-session failure notes now log a warning if the note itself can't be saved, so staff isn't left in the dark
- **Fix**: Payment confirmation now gracefully handles corrupted fee data instead of crashing mid-transaction
- 7.30.1
- 2026-02-10
- Bug Fixes & Performance
- **Fix**: Closure sync no longer re-processes ~60 already-deactivated closures every cycle — only checks active ones, reducing unnecessary database work
- **Fix**: HubSpot products page now shows a clear 'missing permissions' message instead of crashing when the API key doesn't have the right access
- **Fix**: Viewing a member profile who doesn't have a billing subscription no longer triggers false alarm warnings in the logs
- 7.30.0
- 2026-02-10
- Calendar Sync Improvements
- **Fix**: Events created in the production app and synced to Google Calendar no longer show up as drafts/needs review in dev — the sync now recognizes app-created events and trusts they were already reviewed
- **Fix**: Deleted or cancelled Google Calendar events are now properly removed from the database during sync (previously, cancelled events could linger)
- **Improvement**: Events synced from Google Calendar now default to the club address (15771 Red Hill Ave, Ste 500, Tustin, CA 92780) when no location is set, so staff don't have to enter it manually every time
- **Improvement**: When an event has a bracket prefix like [Social] in its Google Calendar title, the category tag is now included in the description for better visibility
- **Fix**: Session creation failure messages no longer dump raw database errors into Staff Notes — replaced with short, readable notes
- 7.29.0
- 2026-02-10
- Unified Booking Sheet & Fee Button Fix
- **Fix**: The '$X Due' fee button on booking cards now opens the Unified Booking Sheet instead of the old separate billing sheet — one consistent experience for managing bookings and payments
- **Fix**: Fee button now shows the full estimated total (owner overage + guest fees) instead of just the owner's cached fee, matching what the Unified Booking Sheet shows
- **Fix**: Check-in payment flow now opens the Unified Booking Sheet when payment is required, instead of the old billing modal
- **Fix**: 'Mark Paid (Cash/External)' button now works inline within the Unified Booking Sheet instead of opening a separate modal
- **Fix**: Overdue Payments now opens the Unified Booking Sheet instead of the old billing modal — consistent across Transactions tab and Staff Command Center
- **Fix**: Overdue payment amounts now include estimated guest fees for unfilled roster slots, matching the Unified Booking Sheet total
- **Improvement**: Overdue Payments section moved to the top of the right column on desktop Transactions tab — immediately visible without scrolling
- **Improvement**: Transactions tab now shows a red badge with the overdue payment count so staff can see at a glance if there are unpaid fees
- **Layout**: Pending Authorizations and Future Bookings moved to left column; Overdue Payments, Failed Payments, and Refunds grouped in right column
- 7.28.0
- 2026-02-10
- Data Integrity Fix Actions
- **Feature**: HubSpot duplicate contacts now have 'Unlink' buttons — choose which user to disconnect from a shared HubSpot contact when they're genuinely different people
- **Feature**: Orphaned guest passes (test/example.com records) can now be deleted directly from the Data Integrity page
- **Feature**: Orphaned fee snapshots referencing deleted bookings can now be cleaned up with one click
- **Feature**: Orphaned booking participants with no valid session can now be removed directly
- **Fix**: Data integrity checks no longer crash — corrected column name in session participant check
- **Fix**: Stripe Customer Cleanup tool now visible in the Data Tools section instead of buried in a check category
- 7.27.0
- 2026-02-10
- Stripe Customer Cleanup & Prevention
- **Feature**: New admin tool to scan and delete Stripe customers with zero transactions — preview before deleting to review the full list
- **Prevention**: Day pass checkout no longer creates a Stripe customer before payment — customers are only created when payment actually completes
- **Prevention**: Visitor creation no longer auto-creates Stripe customers — only happens when a visitor makes a real purchase
- **Prevention**: Bulk sync, CSV import, and visitor matching no longer create premature Stripe customers
- **Improvement**: Existing Stripe customers now get their metadata updated (name, tier, firstName, lastName) when accessed
- **Improvement**: All metadata sync functions now include firstName and lastName fields
- 7.26.1
- 2026-02-10
- Session Backfill & Roster Reliability
- **Fix**: Session backfill now uses overlap detection to find existing sessions with different Trackman IDs but overlapping time ranges — prevents 'No bookings could be resolved' errors
- **Fix**: Backfill endpoint properly handles session creation failures — rolls back savepoint instead of attempting release on error state
- **Fix**: Transaction-aware retry logic — when called within a transaction, session creation throws immediately instead of retrying on an aborted PostgreSQL transaction
- 7.26.0
- 2026-02-10
- Silent Failure Audit & Data Safety Net
- **Feature**: New 'safeDbOperation' wrapper for critical database writes — automatically logs failures and alerts staff, preventing silent errors
- **Feature**: New 'safeDbTransaction' wrapper — provides automatic transaction management with rollback on failure and staff notifications
- **Fix**: Eliminated all 7 empty catch blocks across billing webhooks, bookings, manual bookings, member sync, and bay helpers — errors are now always logged
- **Integrity**: Added 4 new nightly data integrity checks — orphaned fee snapshots, sessions without participants, orphaned payment intents, and guest passes for non-existent members
- **Safety**: Wrapped 3 critical member management endpoints (tier change, suspend, and archive) in database transactions to prevent half-finished data
- **Prevention**: All critical database operations now use proper error handling — no error can go unnoticed
- 7.25.1
- 2026-02-10
- Booking Spam Prevention
- **Feature**: Members are now limited to one pending booking request at a time — additional requests are blocked until the first is approved or denied
- Queue Management: Prevents members from stacking multiple pending requests and holding too many potential slots
- Staff Exemption: Staff and admin users can still create multiple bookings as needed for manual scheduling
- 7.25.0
- 2026-02-10
- Staff = VIP Rule — Automatic Tier Enforcement
- **Feature**: All staff, admin, and golf instructor users are now automatically treated as VIP members — no manual tier assignment needed
- Auth Enforcement: Every login path (OTP, Google sign-in, verification) now sets staff tier to VIP and membership status to active automatically
- Database Sync: Staff user records are auto-corrected to VIP tier and active status on every login, ensuring data never drifts
- Booking Safety Net: Fee calculation now checks the staff directory before computing fees — staff always get $0 with 'Staff — included' note
- Inactive Warning: Staff booking owners no longer show the 'Inactive Member' warning banner
- Tier Dropdown Cleanup: Removed 'Founding' and 'Unlimited' from the membership tier dropdown since they're not valid tiers
- 7.24.2
- 2026-02-10
- Revenue Protection — Inactive Owner Fee Enforcement
- CRITICAL FIX: Non-member and inactive booking owners were getting free bookings ($0) because the system checked 'is owner' before checking membership status — now status is checked FIRST
- Revenue Protection: Inactive/non-member owners are now charged the full session fee with no membership benefits — e.g., $50 for a 60-minute session instead of $0
- Logic Reorder: New order of operations — (1) check membership status, (2) if active apply tier benefits, (3) if inactive charge full overage rate regardless of role
- **Coverage**: Fix applies to all 3 fee paths — session-based, non-session with guest passes, and non-session without guest passes
- Active members with no tier assigned now also get charged (previously $0 due to missing else clause)
- 7.24.1
- 2026-02-10
- Inactive Member Handling & Dead Code Cleanup
- **Feature**: Inactive/suspended members now show a red uppercase status badge (e.g., SUSPENDED, CANCELLED) instead of their tier name in the booking roster
- **Feature**: Inactive member fees are automatically redirected to the booking owner (host) since inactive members cannot log in to pay — fee notes explain the charge transfer
- **Feature**: Backend roster API now includes membership_status for each player, enabling proper status-aware UI rendering across all booking views
- **Cleanup**: Removed dead useOptimisticBookings.ts file (209 lines, not imported anywhere in the app)
- **Fix**: Restored forward optimistic bay-status update in StaffCommandCenter check-in flow for immediate UI feedback
- 7.24.0
- 2026-02-10
- Single Source of Truth — Unified Booking Actions
- **Architecture**: Created useBookingActions hook — a single source of truth for check-in, card charging, and staff cancel actions across the entire app
- **Refactor**: Consolidated 9 separate check-in implementations into one shared function with consistent 402 payment-required handling, billing sync retry logic, and error messaging
- **Refactor**: Consolidated 2 separate charge-saved-card implementations into one shared function with consistent card-declined, no-card, and verification-required handling
- **Refactor**: StaffCommandCenter now uses useBookingActions for check-in — local optimistic UI updates preserved, API logic delegated
- **Refactor**: SimulatorTab now uses useBookingActions for both its main check-in flow and the booking sheet's check-in callback — removed duplicate retry logic
- **Refactor**: CompleteRosterModal, MemberProfileDrawer, and CheckinBillingModal all now use useBookingActions instead of inline fetch calls
- **Refactor**: useUnifiedBookingLogic now delegates check-in and charge-card calls to useBookingActions instead of raw fetch
- **Cleanup**: Removed unused useUpdateBookingStatus and useCancelBookingWithOptimistic imports from SimulatorTab
- **Cleanup**: Identified useOptimisticBookings.ts as dead code (not imported anywhere in the app)
- **Impact**: Business rule changes (e.g. 'Staff are free', 'Skip billing for certain tiers') now only need to be updated in one place and automatically apply to Dashboard, Calendar, Mobile, and all modals
- 7.23.0
- 2026-02-10
- Deep Logic Extraction — Booking Sheet Under 400 Lines
- **Refactor**: Created useUnifiedBookingLogic custom hook (1,312 lines) — ALL state management, data fetching, and handler functions moved out of the booking sheet component
- **Refactor**: Created AssignModeSlots component — player slot rendering, member search, visitor creation, and guest placeholder UI extracted into its own module
- **Refactor**: Created ManageModeRoster component — manage mode slot rendering with member linking, guest forms, and member match resolution extracted
- **Refactor**: Created AssignModeFooter component — fee estimation display, event marking with notice selection, and staff assignment list extracted
- **Achievement**: UnifiedBookingSheet.tsx reduced from 2,245 lines to 371 lines (83% reduction) — now a pure view layer that calls one hook and assembles sub-components
- **Architecture**: Booking sheet now follows hooks + view pattern — all business logic lives in the hook, all rendering is handled by focused sub-components
- 7.22.0
- 2026-02-10
- Codebase Cleanup & Booking Sheet Modularization
- **Cleanup**: Removed deprecated ManagePlayersModal, BookingDetailsModal, and TrackmanLinkModal components — all booking interactions now route exclusively through the unified booking sheet
- **Cleanup**: Removed all references to the old long-form Trackman UUID (trackman_external_id) from the staff interface — staff now only sees the short booking number
- **Cleanup**: Renamed misleading 'trackmanLinkModal' state variables to 'bookingSheet' across SimulatorTab, DataIntegrityTab, StaffCommandCenter, and TrackmanTab for code clarity
- **Refactor**: Broke down the 2,790-line booking sheet into focused sub-components — SheetHeader (booking info), PaymentSection (financial summary and payment collection), and BookingActions (check-in, reschedule, cancel)
- **Refactor**: Shared type definitions moved to a dedicated types module, reducing duplication across components
- **Reliability**: Payment and roster sections are now wrapped in error boundaries — if a Stripe glitch occurs, it won't crash the entire booking sheet; staff can close and reopen to recover
- 7.21.0
- 2026-02-10
- Stripe Clarity & Trackman Import Intelligence
- **Feature**: Stripe Dashboard now shows the booking number in every charge description (e.g. '#19607382 - Simulator Bay 2') so you can instantly see which booking a payment belongs to without clicking into metadata
- **Feature**: Overage payment intents are now reused — if an overage charge already exists for a booking, the system returns the same payment link instead of creating a duplicate 'Incomplete' charge
- **Feature**: Overage payment intents are now automatically cancelled when staff closes or backs out of the payment flow, preventing orphaned 'Incomplete' charges in Stripe
- **Feature**: Trackman webhook matching now also searches by the short booking number, making automatic linking more reliable
- **Feature**: CSV import now detects existing ghost bookings by their Trackman booking number and updates them in place instead of creating duplicates
- **Improvement**: Conference room and ad-hoc bookings (without a standard booking ID) now skip the duplicate payment check and are tagged with 'conference_booking' metadata in Stripe for easy identification
- **Improvement**: Member-facing payment descriptions now show the booking number prefix for guest fees, overage fees, and combined charges
- 7.20.4
- 2026-02-10
- Terminal Payment Reconciliation & Trackman Import Fix
- **Fix**: Terminal card reader payments now correctly mark all participants as 'paid' — previously Stripe showed 'Succeeded' but the booking still displayed 'Collect $25' because the payment status wasn't synced back
- **Fix**: Trackman-imported bookings (like Mark Mikami's) no longer show an infinite loading spinner when opening payment options — the system now finds the member's account even when the import didn't link the user ID
- **Fix**: Pay with Card form now loads for Trackman-imported members who have an email on file but were missing an internal user link
- **Fix**: Orphaned payment intents no longer pile up in Stripe — if staff opens 'Pay with Card' but then cancels or switches to a different payment method (like card reader), the original payment intent is now automatically cancelled instead of being left as 'Incomplete'
- **Fix**: Guest fees no longer appear for fully-assigned bookings — when all player slots are filled with members, the system correctly shows $0 instead of charging for orphaned extra slots that were left over from player count changes
- **Improvement**: Payment processing now resolves member identity by email when user ID isn't available, preventing payment failures for imported bookings
- 7.20.3
- 2026-02-10
- Card Terminal Reader & Payment Reliability
- **Feature**: Card terminal reader option is back in the booking sheet — staff can now tap 'Card Reader' to process payments using the physical Stripe terminal, right alongside online card payment and cash options
- **Fix**: 'Missing required fields' error when clicking 'Pay with Card' is resolved — the payment form now waits for member data to fully load before creating the payment session, with a clear message if data can't be found
- **Fix**: Stale Stripe customer IDs (from test environments) are now auto-cleared across all lookup paths — linked email and HubSpot matches are validated against Stripe before use
- **Improvement**: Payment options now show a loading state while member info loads, preventing premature payment attempts with incomplete data
- 7.20.2
- 2026-02-10
- Booking Sheet Reliability & Stale Stripe Customer Fix
- **Fix**: Opening a booking via the '1/4 Players' button now fully loads all booking details (owner, bay, time) even when limited info is passed — payment, check-in, and card-on-file features all work correctly
- **Fix**: Charge Card on File and Pay with Card buttons now find the correct member email through multiple fallback sources, preventing 'missing required fields' errors
- **Fix**: Stale Stripe customer IDs (from test environments) are now detected and auto-cleared when creating payment intents — instead of crashing, the system creates a fresh Stripe customer and proceeds normally
- **Fix**: Saved card check now triggers correctly when booking context is loaded asynchronously, so staff see the 'Charge Card on File' option without needing to reopen the sheet
- 7.20.1
- 2026-02-10
- Critical Bug Fixes & Stability Improvements
- **Fix**: Resolved crash on Bookings, Data Integrity, and Dashboard pages caused by a function ordering error in the booking sheet component
- **Fix**: Fee estimate calculations no longer fail when opening a booking — now defaults to today's date (Pacific) when a date isn't provided
- **Fix**: Stripe 'customer not found' errors for stale test accounts are now handled gracefully instead of filling server logs with noisy stack traces
- **Fix**: Added missing 'Needs Players' API endpoint for the Trackman tab — shows bookings that still need player assignments
- **Improvement**: Added automatic error reporting — page crashes now send details to the server for faster diagnosis
- 7.20.0
- 2026-02-10
- Trackman Booking ID Standardization & Payment Safety
- **Major**: Staff now paste the short Trackman Booking ID (the number you see in the portal, like 19510379) instead of the long UUID — simpler, faster, less error-prone
- **Feature**: 'Book on Trackman' modal and 'Manual Booking' flow both updated with new labels, shorter ID placeholder, and relaxed validation for the numeric format
- **Feature**: Stripe payment idempotency — if a payment session already exists for a booking, the system reuses it instead of creating a duplicate charge
- **Feature**: Saved card charges now check for already-collected payments to prevent accidental double-charges
- **Feature**: Conference room prepayments detect existing payments and return them instead of creating duplicates, with 'conference_booking' metadata for tracking
- **Improvement**: CSV import backfill already matches webhook-created bookings by Trackman Booking ID and fills in member data without creating duplicates or touching payment links
- 7.19.0
- 2026-02-10
- Inline Payment Flow & Smart Notes Deduplication
- **Major**: Payment collection now happens directly inside the booking sheet — no more separate billing popup with inconsistent fee amounts
- **Feature**: Four payment options available inline — Charge Card on File, Pay with Card (Stripe), Mark Paid (Cash/External), and Waive All Fees with reason
- **Feature**: After successful payment, a green confirmation message appears inline and the Check In button becomes enabled — all without closing the sheet
- **Feature**: Smart notes deduplication — when Booking Notes and Trackman Notes contain the same text (or one contains the other), only one block is shown to avoid wasted space
- **Improvement**: Payment amounts in the booking sheet are always consistent — the Collect button uses the exact total calculated from the roster's financial summary
- 7.18.3
- 2026-02-10
- Complete Notes Display, Inactive Member Warning & Payment-Gated Check-In
- **Feature**: All three types of booking notes now display in the booking sheet — amber for the member's request notes, blue for Trackman customer notes (imported from CSV), and purple for internal staff notes
- **Feature**: Trackman customer notes are now included in both assign mode and manage mode, so staff can see imported notes when matching unmatched bookings
- **Feature**: Inactive member warning — a red banner appears at the top of the booking sheet when the booking owner's membership is not active
- **Feature**: Check In button is disabled until all fees are collected — a clear message explains that payment must be processed first
- **Improvement**: Check In, Reschedule, and Cancel buttons now appear below the Financial Summary and Collect button, so the payment flow comes first naturally
- 7.18.0
- 2026-02-10
- Complete Booking Sheet — One Place for Everything
- **Major**: The Unified Booking Sheet is now the ONLY place for all booking operations — the old 'Booking Details' popup has been completely removed
- **Feature**: Booking context header — date, time, bay, duration, Trackman ID, and status badge are shown prominently at the top of every booking
- **Feature**: Action buttons — Check In, Reschedule, and Cancel Booking are now built into the booking sheet, with smart visibility based on booking status
- **Fix**: Player count sync — changing player count from 4 to 2 now immediately hides slots 3 & 4 from the UI instead of leaving them visible
- **Cleanup**: Deleted the old TrackmanLinkModal.tsx and the 520-line Booking Details modal block — zero dead code remaining
- **Cleanup**: Removed 5 dead state variables (selectedCalendarBooking, editingTrackmanId, trackmanIdDraft, savingTrackmanId, isCancellingFromModal)
- 7.17.0
- 2026-02-10
- Unified Booking Sheet & Staff Fee Exemption
- **Major**: Replaced the old Trackman Link Modal with a brand-new Unified Booking Sheet that handles all booking operations — assigning members, managing rosters, and reviewing fees — in one place
- **Feature**: Staff members are now fully exempt from all fees (overage, guest, and session fees) with a clear 'Staff — included' label shown in blue
- **Feature**: Staff users display a blue 'Staff' badge instead of the default tier badge throughout booking management
- **Feature**: Booking type detection — conference room bookings automatically hide Trackman, roster, and financial sections; lesson and staff block bookings show only the owner slot
- **Feature**: Dual-mode operation — 'assign' mode for linking members to bookings and 'manage' mode for editing rosters and reviewing financials
- **Improvement**: All four entry points (Simulator tab, Trackman tab, Staff Command Center, Data Integrity) now use the unified component for consistent behavior everywhere
- **Improvement**: Tapping a booking on the calendar grid now opens the Unified Booking Sheet directly — no more intermediate 'Booking Details' popup to click through
- **Fix**: Financial summary was showing fees at 1/100th their actual value — now displays correct dollar amounts
- 7.16.1
- 2026-02-10
- Financial Summary Fee Display Fix
- **Fix**: Financial summary in the Manage Players modal was showing fees at 1/100th their actual value (e.g., $0.75 instead of $75.00) — fees now display correctly in dollars
- **Fix**: Per-player fee display in roster slots also corrected to show proper dollar amounts
- 7.16.0
- 2026-02-10
- Unified Player Management Modal
- **Major**: All player and roster management is now handled by a single unified modal instead of three separate ones — no more confusion about which modal to use
- **Feature**: 'Manage Players' button in booking details opens the unified modal with the current roster pre-loaded, showing all assigned members, guests, fees, and guest passes
- **Feature**: Player count can be edited directly from the modal (1-4 players) with real-time roster updates
- **Feature**: Financial summary section shows owner overage, guest fees, guest pass usage, and total amount due — with a 'Collect Payment' button when there's an unpaid balance
- **Feature**: Guest pass tracking shows remaining passes and which guests used them (green badge for free passes)
- **Feature**: New Guest form with member match detection — if a guest's email matches an existing member, staff gets a warning with option to add as member instead
- **Feature**: Optimistic unlink/remove with rollback on failure for instant-feeling slot management
- **Improvement**: Unified modal works from all entry points: booking detail drawer, calendar grid 'Players' button, check-in error handler, Trackman tab, and Staff Command Center
- **Cleanup**: Deprecated BookingMembersEditor and CompleteRosterModal — all call sites now route through the unified modal
- 7.15.4
- 2026-02-10
- Unified Player Count Editing
- **Improvement**: Player count in booking details now scrolls to the roster editor below instead of having its own separate dropdown — one place to manage players instead of two
- **Improvement**: Roster editor now always shows the player count with an edit button, so staff can change it directly from the players list in both the booking details modal and the check-in flow
- **Cleanup**: Removed duplicate player count editing state from the booking details modal
- 7.15.3
- 2026-02-09
- Guest Pass Badge Display Fix
- **Fix**: Guest roster slots no longer show the green 'Guest Pass Used' badge when the guest actually has a $25 fee — the badge now only appears when a pass was truly applied and the fee is $0
- **Fix**: When a billing session exists, guest fee data from the session now properly overrides speculative calculations, preventing stale 'Guest Pass Used' labels on guests who were charged
- **Fix**: Financial Summary and individual guest slot displays are now always in sync — no more showing $0 per guest while the summary correctly shows $75 total
- 7.15.2
- 2026-02-09
- Unmatched Booking Resolution & Import Completeness
- **Fix**: Imports now match members via M: tag emails in notes when the CSV email field is empty — previously these bookings stayed as 'Unknown (Trackman)' even when member info existed in notes
- **Fix**: Bookings from Trackman webhooks now get their name updated from CSV data even when no member email match is found, replacing 'Unknown (Trackman)' with the actual name
- **Fix**: Guest name slots are now populated in all import paths (linked bookings and time-tolerance matches), not just new and updated bookings
- **Fix**: Guest emails no longer incorrectly placed in member slots during imports, preventing double-counting of players and incorrect fee calculations
- **Improvement**: Added database constraint to prevent duplicate guest entries on re-imports
- 7.15.1
- 2026-02-09
- Booking Roster Population Fix
- **Fix**: Imported bookings now correctly show all players in the roster instead of showing 0 players
- **Fix**: Guest names from inline tags (e.g., 'G: Chris G: Alex G: Dalton') are now properly parsed and added to the roster
- **Fix**: Guest name parsing no longer accidentally captures text from the next guest tag when multiple guests are listed on one line
- **Improvement**: Diagnostic logging added to track participant creation during imports for easier troubleshooting
- 7.15.0
- 2026-02-09
- Trackman CSV Import Accuracy Overhaul
- **New**: CSV import now merges with webhook-created placeholder bookings — no more duplicate 'Unknown (Trackman)' entries alongside real member bookings
- **New**: When a CSV row matches a simulator and time slot that has a placeholder/ghost booking, the system updates the existing record instead of creating a new one
- **Improvement**: Member matching is now strict email-only — removed name-based fallback matching that caused incorrect member links when multiple people share similar names
- **Improvement**: CSV-imported bookings linked to a member are now always set to 'Approved' status instead of staying 'Pending'
- **New**: Post-import cleanup auto-approves any remaining pending bookings that were successfully linked to a member
- **Fix**: Billing sessions are now created immediately after merging CSV data into placeholder bookings
- **Fix**: Time matching uses ±2 minute tolerance to handle rounding differences between Trackman and the app
- 7.14.0
- 2026-02-09
- Proper Trackman Cancellation Flow
- **New**: Approved simulator bookings linked to Trackman now go through a proper cancellation process instead of instant cancel
- **New**: When a member or staff cancels a Trackman-linked booking, it enters 'Cancellation Pending' status and staff are notified to cancel in Trackman first
- **New**: Once staff cancels in Trackman and the webhook confirms it, the system automatically refunds charges, clears billing, and notifies the member
- **New**: Staff can manually complete a pending cancellation via a 'Complete Cancellation' button if the Trackman webhook doesn't arrive
- **New**: Scheduled safety net checks every 2 hours for cancellations stuck for 4+ hours and escalates to staff
- **New**: Members see 'Cancellation Pending' status with messaging that their request is being processed
- **New**: Staff see 'Cancellation Pending' badge with instructions to cancel in Trackman and a manual completion option
- **Improvement**: Time slot stays reserved during pending cancellation — no double-booking risk
- **Improvement**: Non-Trackman bookings (conference rooms, etc.) keep the existing instant cancel behavior
- **Fix**: Updated 40+ booking queries across the codebase to properly handle the new cancellation_pending status
- 7.13.0
- 2026-02-09
- Complete Session Creation Safety Coverage
- **Fix**: ALL session creation paths now go through ensureSessionForBooking — a single hardened function with automatic retry and staff-note flagging on failure
- **Fix**: Staff check-in (2 paths) — check-in context and add-participant now use hardened session creation instead of raw database inserts
- **Fix**: Booking approval check-in and dev_confirm paths now use hardened session creation with retry safety
- **Fix**: Trackman webhook billing (2 paths) — pending booking link and new booking creation now retry on failure instead of silently failing
- **Fix**: Trackman webhook simulate-confirm and reprocess-backfill now use hardened session creation — eliminated a completely silent empty catch block in reprocess
- **Fix**: Trackman admin resolve (visitor + member) and backfill tool now use hardened session creation with retry
- **Fix**: Visitor auto-match (2 paths) — both transactional and non-transactional auto-match session creation now use hardened path
- **Fix**: Ghost booking fix tool now uses hardened session creation instead of raw database insert
- **Improvement**: ensureSessionForBooking now checks for existing sessions by Trackman booking ID in addition to resource/date/time — prevents duplicate session conflicts
- **Improvement**: ensureSessionForBooking INSERT now uses ON CONFLICT for Trackman booking ID dedup — handles race conditions atomically
- **Result**: Zero raw INSERT INTO booking_sessions in the codebase outside of ensureSessionForBooking — every session creation path has retry + staff-note safety
- 7.12.0
- 2026-02-09
- Session Reliability & Data Integrity Hardening
- **Fix**: Session creation now retries automatically and flags bookings with a staff note if it ultimately fails — no more silent billing gaps
- **Fix**: Roster confirmation and guest fee checkout now use the hardened session creation path with retry and staff-note safety
- **Fix**: Conference room auto-confirm no longer silently swallows session creation failures — staff notes are written if something goes wrong
- **Fix**: Trackman CSV import falls back to a minimal owner-only session on failure instead of silently skipping billing
- **Fix**: Google Calendar conference room sync now creates billing sessions for approved bookings
- **Fix**: Delete user now properly cleans up booking participants and removes empty sessions to prevent orphaned data
- **Fix**: Guest pass deduction in Trackman imports only applies when guests have identifying info (name or email); unidentified guests always get a fee charged
- **Fix**: Cleaned up orphaned test data (2 orphaned participants, 7 empty sessions)
- **Removed**: Deleted unused GuestEntryModal component (dead code cleanup)
- 7.11.7
- 2026-02-09
- Fix False Positives in Session Integrity Check
- **Fix**: 'Active Bookings Without Sessions' data integrity check no longer counts unmatched Trackman walk-in bookings — only real member bookings are flagged
- **Fix**: Backfill Sessions tool now skips unmatched Trackman bookings that have no member to bill
- **Result**: Count drops from ~38 to ~8 — only genuine missing sessions remain
- 7.11.6
- 2026-02-09
- Bulk Waiver Review
- **New**: Staff can now bulk-review all stale waivers at once from the Overdue Payments panel or Command Center
- **New**: Stale waivers API endpoint for listing all unreviewed fee waivers older than 12 hours
- **Improvement**: 'Review All Waivers' button appears when unreviewed waivers exist, with confirmation before approving
- 7.11.5
- 2026-02-09
- Fix Unknown Trackman Bookings in Request Queue
- **Fix**: Unmatched Trackman webhook bookings no longer appear as pending requests in the Bookings page — they belong only in the Trackman Needs Assignment area
- **Fix**: Command Center pending count and today's bookings no longer include unmatched Trackman entries
- **Fix**: Calendar approved bookings view no longer shows unmatched Trackman bookings
- 7.11.4
- 2026-02-09
- Past Events & Wellness Hidden by Default
- **Improvement**: Past events and past wellness classes are now collapsed by default — tap the 'Past' header to reveal them
- **Improvement**: Past events also load in batches of 20 with a 'Show more' button, matching the wellness tab behavior
- 7.11.3
- 2026-02-09
- Wellness Tab Mobile Fix
- **Fix**: Wellness tab on the Calendar page no longer crashes on mobile — classes now load in batches of 20 with a 'Show more' button instead of rendering all 370+ at once
- 7.11.2
- 2026-02-09
- Better Trackman Notification Messages
- **Improvement**: Trackman booking notifications now show bay number, day of week, 12-hour time, and duration instead of raw dates and 'Unknown'
- **Improvement**: Unmatched booking alerts lead with the bay info so you can quickly tell which booking came through
- 7.11.1
- 2026-02-09
- Notification Click Navigation
- **Fix**: Clicking notifications now takes you to the relevant page — Unmatched Trackman alerts go to Trackman, payment alerts go to Financials, member alerts go to Directory, system alerts go to Data Integrity, and so on
- **Fix**: Marking individual notifications as read no longer fails with a server error
- 7.11.0
- 2026-02-09
- Booking Session Integrity Hardening
- **Fix**: Created centralized session-creation helper used across all booking status paths — ensures every approved/confirmed booking always gets a billing session
- **Fix**: Closed 5 code paths where bookings could become approved without billing sessions — Trackman auto-match (2 paths), resource confirmation, conference room auto-confirm, and staff day pass bookings
- **Fix**: Upgraded 2 Trackman webhook paths that silently ignored session creation failures — bookings now revert to pending instead of staying approved without a session
- **Fix**: All 7 hardened paths use dedup logic so existing sessions are reused instead of creating duplicates
- **Improvement**: Eliminated root cause of 'active bookings without sessions' data integrity issue that was blocking revenue tracking
- 7.10.16
- 2026-02-08
- Guest Pass: Only Apply When Guest Info Entered
- **Fix**: Guest passes now only apply to guests where the member has actually entered information (name or email) — empty guest slots are always charged $25
- **Fix**: Fee estimate preview updates in real-time as member fills in guest details — passes show as applied only after entering guest info
- **Fix**: Strengthened guest pass protection — passes require either a real guest record or a non-placeholder name across all fee calculation paths
- **Fix**: Added placeholder guard to guest pass consumption and API endpoints for defense-in-depth
- 7.10.12
- 2026-02-08
- Guest Pass Business Rule Correction
- **Fix**: Guest passes now only apply to actual named guests/visitors — empty or unfilled player slots always charge $25 regardless of available passes
- **Fix**: Corrected fee calculation across all booking flows (member booking preview, staff financial summary, Trackman sync, check-in, player count edits) so empty slots never consume guest passes
- **Fix**: Reverted incorrect logic that was allowing guest passes to cover empty slots in the booking details financial summary
- 7.10.10
- 2026-02-08
- Empty Slot UI Improvements
- **Improvement**: The 'Find member' button on empty player slots now says 'Search' to reflect that it finds both members and visitors
- **Improvement**: The 'Add Guest' button is now labeled 'New Guest' and goes directly to a new visitor form with First Name, Last Name, Email, and Phone fields — removed the Search/New toggle since the main search already finds existing people
- **Improvement**: Empty player slots now display the $25 guest fee badge so staff can see the cost at a glance
- **Improvement**: The search bar is now dismissable — staff can close it to get back to the default slot view with the New Guest button
- **Improvement**: Empty slot warning text now says 'assign players' instead of 'link members' since guests can also fill slots
- 7.10.9
- 2026-02-08
- Guest Slot Display & Owner Overage Calculation
- **Fix**: Guests now appear directly in their assigned player slot instead of showing separately below the roster — makes it clearer who's occupying each position in the booking
- **Fix**: Booking owner is now correctly charged overage fees for time used by guests and empty slots. When a guest (like Nolan) occupies a slot, that time counts toward the owner's daily usage for overage purposes. Member slots are not affected — members handle their own overage independently.
- 7.10.8
- 2026-02-08
- Guest Fee & Removal Improvements
- **Fix**: Guest fee double-counting resolved — when a booking had both a guest participant (like Nolan) AND an empty member slot, the system was charging $25 for the guest AND another $25 for the empty slot, resulting in $50 instead of the correct $25. The financial summary now correctly accounts for guests that already fill empty slots.
- **New**: Staff can now remove guests from bookings using a remove button (X) next to each guest in the Booking Details modal — previously there was no way to remove a guest once added.
- 7.10.7
- 2026-02-08
- Empty Slot Overage Fee Fix
- **Fix**: When a booking has empty player slots, the owner is now correctly charged overage for the full booking duration. Previously, the owner was only charged for their split share (e.g., 60 min out of 120 min for a 2-player booking), even when the other slot was empty. Now the owner absorbs the empty slot time for overage purposes while the empty slot still generates the standard guest fee.
- 7.10.6
- 2026-02-08
- Billing & Payment Security Hardening
- **Security**: Staff charges over $500 on a member's saved card now require admin-level approval — prevents unauthorized large charges by non-admin staff
- **Security**: Stripe sync and backfill operations now have a 5-minute cooldown between triggers — prevents accidental repeated runs that could cause rate limit issues or data inconsistencies
- **Security**: Staff accessing another member's billing info (invoices, payments, balance, saved cards) is now logged in the audit trail — provides accountability for billing data access
- **Security**: Public day-pass checkout and all sync operations now have request rate limits — prevents abuse and protects against automated attacks
- **Fix**: Added missing audit action type for large charge approvals
- 7.10.5
- 2026-02-08
- Deep Security Audit: Booking, Billing, Members & Integrations
- **Fix**: Visitor search now uses parameterized database queries — previously used a fragile string escaping pattern that could potentially allow SQL injection in edge cases
- **Fix**: Resend email webhook verification is now mandatory in production — previously, if the webhook secret wasn't configured, all webhook events were accepted without verification, allowing potential forgery of email bounce/complaint events
- **Fix**: Guest check-in via HubSpot forms now requires staff authentication — previously the public form endpoint could be used to deplete any member's guest passes without logging in
- **Verified**: 85+ routes across booking system, member management, billing, admin tools, and integrations — all properly protected
- **Verified**: All Stripe payment routes use proper auth, transactions, and idempotency
- **Verified**: HubSpot webhook uses timing-safe signature verification with replay protection
- **Verified**: File uploads enforce 10MB size limits with image type validation
- **Verified**: Data export only returns the requesting member's own data, with sensitive fields excluded
- **Verified**: Member search redacts email addresses for non-staff users
- **Verified**: All data integrity and admin tools require admin-level access
- 7.10.4
- 2026-02-08
- Security Audit: Route Authorization Hardening
- **Fix**: Wellness class enrollment now verifies the logged-in member matches the request — previously accepted any email without checking the session
- **Fix**: Event RSVP creation now verifies the logged-in member matches the request — previously accepted any email without checking the session
- **Fix**: Event RSVP cancellation now verifies the logged-in member matches the request — previously accepted any email without checking the session
- **Fix**: Eventbrite sync endpoint now requires staff access — previously could be triggered without authentication
- **Fix**: Tour confirmation now only allows confirming tours that are in 'pending' status — prevents re-confirming already scheduled tours
- **Fix**: Updated the notification type constraint to include all 40+ notification types used across the system — previously only 19 types were allowed, causing Trackman and other notifications to silently fail
- **Verified**: All admin/staff mutation routes properly protected with role-based access control
- **Verified**: All member-facing routes enforce self-access-only (members can only modify their own data)
- **Verified**: Frontend auth guards properly redirect unauthenticated users and non-staff from admin pages
- **Verified**: Service worker properly handles cache versioning and old cache cleanup
- **Verified**: Announcements, gallery, settings, FAQs, bug reports, notices, cafe menu, and membership tier routes all properly protected
- 7.10.3
- 2026-02-08
- System Audit: Webhook & Job Queue Hardening
- **Fix**: Hardened a database query in the Stripe webhook cleanup to prevent potential issues with dynamic values in SQL
- **Improvement**: Old completed and failed background jobs are now automatically cleaned up during weekly maintenance (older than 7 days) — prevents database bloat from accumulated job records
- **Verified**: Stripe webhook system — transactional dedup, event ordering, deferred actions, and rollback all working correctly across 20+ event types
- **Verified**: Background job processor — claim locking, retry logic with exponential backoff, and stuck job recovery all working correctly
- **Verified**: Booking roster management — optimistic locking with version tracking and row-level locking prevents race conditions
- **Verified**: Prepayment system — duplicate prevention, refund handling, and fee calculation all working correctly
- **Verified**: Stripe Terminal integration — proper auth, audit logging, idempotency, and amount verification in place
- 7.10.2
- 2026-02-08
- Scheduler Timezone Fixes & Cleanup Improvements
- **Fix**: Daily reminder notifications now trigger at 6pm Pacific instead of 6pm UTC (was firing at 10am Pacific)
- **Fix**: Morning closure notifications now trigger at 8am Pacific instead of 8am UTC (was firing at midnight Pacific)
- **Fix**: Weekly cleanup now runs Sunday 3am Pacific instead of 3am UTC
- **Fix**: Daily reminders now correctly look up 'tomorrow's' bookings and events using Pacific time — previously could skip a day or show wrong day's reminders
- **Fix**: Session cleanup scheduler (2am) and webhook log cleanup scheduler (4am) now use the standard Pacific time utility — previously used a method that could misfire at midnight
- **Fix**: Hardened a database query in the payment reconciliation scheduler to prevent potential issues with dynamic values in SQL
- **Improvement**: Old calendar availability blocks (older than 30 days) are now automatically cleaned up during weekly maintenance — removed 72 accumulated blocks dating back to August 2025
- 7.10.1
- 2026-02-07
- ID Scan Address Auto-Fill
- **Improvement**: ID scanning now auto-fills address fields (street, city, state, zip) in addition to name and date of birth — for new members, visitors, and sub-members
- **Improvement**: Address data from scanned IDs is now saved to the member's record and syncs to HubSpot
- **Improvement**: All user creation flows (new member signup, day pass purchase, group member add, activation link) now pass address through to the database
- 7.10.0
- 2026-02-07
- ID & Driver's License Scanning
- **New**: Staff can scan a member's driver's license or ID card during registration — the system uses AI to automatically read and fill in the name, date of birth, and address fields
- **New**: Live camera preview with a banking-app-style guide overlay helps staff position the ID correctly before capturing
- **New**: Image quality feedback — the system warns if the photo is too blurry, too dark, has glare, or is partially obscured, and suggests retaking
- **New**: File upload option — staff can also upload an existing photo of an ID instead of using the camera
- **New**: Scanned ID images are securely stored on the member's record for future reference
- **New**: 'ID on File' section in the member profile drawer — staff can view the stored ID image full-size, re-scan, or remove it
- **New**: ID scanning works for both new member and visitor registration flows
- 7.9.1
- 2026-02-07
- QR Check-In Refinements & Activity Feed
- **New**: Walk-in QR check-ins now appear in the staff dashboard's recent activity feed with a scanner icon and staff name
- **Fix**: Lifetime visit counts now include walk-in check-ins everywhere — membership card, staff profile drawer, member directory, and HubSpot contacts all previously missed walk-in visits
- **Fix**: MindBody imports can no longer overwrite visit counts — they now only increase the count, never decrease it, so walk-in check-ins and other locally-tracked visits are preserved
- **Improvement**: Check-in confirmation popup now shows amber warnings for cancelled, suspended, or inactive memberships — not just expired
- **Fix**: Member dashboard now refreshes visit count in real-time after a walk-in check-in
- **Improvement**: Duplicate QR scan within 2 minutes shows a friendly 'already checked in' message instead of an error
- 7.9.0
- 2026-02-07
- QR Check-In & Membership Card Improvements
- **New**: Walk-in QR check-in — staff can scan a member's QR code to record a visit even without a booking, with automatic visit count tracking and HubSpot sync
- **New**: Staff check-in confirmation popup — after scanning a member's QR code, a brief modal shows the member's name, tier, and any pinned staff notes, then auto-dismisses after a few seconds
- **New**: QR code added to the membership card popup on the dashboard — members can now tap their card and show the QR code at the front desk for quick check-in
- **Improvement**: Removed the separate 'Digital Access Card' section from the profile page since the QR code now lives on the membership card popup
- **Improvement**: Removed the redundant 'Membership' section from the bottom of the profile page — the same info is already on the membership card popup
- 7.8.1
- 2026-02-07
- Google Sign-In Fix & Quieter Error Alerts
- **Fix**: Google Sign-In was returning 'Not found' in production — caused by a route registration order conflict where the test auth middleware intercepted Google auth requests before they could reach the proper handler
- **Fix**: Google Sign-In, Google account linking, and Google account status endpoints now all work correctly in production
- **Improvement**: Error alert emails reduced from up to 6/day to max 3/day, with 4-hour cooldown between similar alerts instead of 1 hour
- **Improvement**: Temporary network blips (timeouts, brief disconnections, rate limits) no longer trigger alert emails — only real, persistent issues send notifications
- **Improvement**: Alert system now remembers its limits across app restarts, so deploys no longer reset the daily email counter
- **Improvement**: 5-minute grace period after server start — no alert emails sent during the brief connection hiccups that naturally happen when the app restarts
- 7.8.0
- 2026-02-07
- **Rebrand**: Ever House → Ever Club
- **Rebrand**: All references to 'Ever House' have been updated to 'Ever Club' across the entire app — pages, emails, notifications, and legal documents
- **New**: Updated logos throughout the app with the new EverClub script wordmark
- **New**: Legal name 'Ever Members Club' now appears in the footer, Terms of Service, and Privacy Policy
- **Update**: All email sender addresses updated from @everhouse.app to @everclub.app
- **Update**: Domain references updated from everhouse.app to everclub.app across all links, sitemap, and SEO metadata
- **Update**: PWA manifest and service worker updated with new branding
- 7.7.0
- 2026-02-07
- Sign in with Google — Link Your Google Account
- **New**: 'Sign in with Google' button on the login page — members can now tap to sign in instantly with their Google account instead of waiting for an email code
- **New**: Connected Accounts section in profile settings — link or unlink your Google account anytime
- **New**: Apple account linking coming soon (placeholder in settings)
- **Security**: Google sign-in uses the same email matching system as OTP login — if your Google email is a known alternate, you'll be matched to your existing account automatically
- 7.6.2
- 2026-02-07
- Login & HubSpot Sync Deduplication — Final Gaps Closed
- **Fix**: Login flow now checks linked emails — if a member logs in with an alternate email we have on file, they're matched to their existing account instead of getting a new one
- **Fix**: HubSpot bulk sync now checks linked emails before creating or updating users — prevents duplicates when a HubSpot contact's email is a known alternate email in our system (both full sync and delta sync paths)
- 7.6.1
- 2026-02-07
- Deduplication Coverage Audit — 5 Additional Entry Points Secured
- **Fix**: New member signup (online checkout) now checks linked emails before creating a user — prevents duplicates when someone signs up with an alternate email we already know about
- **Fix**: Activation link member creation now checks linked emails before creating a user — same protection for staff-initiated signups
- **Fix**: HubSpot member creation (local) now checks linked emails before creating a user — prevents duplicates when staff adds members through HubSpot flow
- **Fix**: HubSpot member creation (with deal) now checks linked emails before creating a user — same protection for deal-based member creation
- **Fix**: Visitor creation now checks linked emails before creating a new visitor record — prevents duplicate visitors when someone uses an alternate email
- **Fix**: Group billing family path now always uses ID-based updates when a user is resolved (consistent with corporate path)
- **Fix**: resolveUserByEmail() now logs errors instead of silently swallowing them — database issues in linked-email checks will surface in logs immediately
- 7.6.0
- 2026-02-07
- Comprehensive Stripe & User Deduplication — All Entry Points Protected
- **New**: Created resolveUserByEmail() helper that checks direct email, linked emails, and manually linked emails — used as the universal lookup before any Stripe customer or user creation
- **Fix**: Eliminated 10 direct Stripe customer creation calls that bypassed all dedup logic — billing portal, payment methods, setup intents, account balance, Stripe sync, credit application, quick charge, POS terminal, overage fallback, and MindBody sync now all route through the centralized getOrCreateStripeCustomer function
- **Fix**: Day pass checkout (public + staff-initiated) and 3 member-payment paths no longer pass email as user ID — they now resolve the real user first, enabling linked-email and HubSpot dedup checks
- **Fix**: 8 user creation paths (webhook subscription, webhook staff invite, Stripe sync, reconciliation, payment confirmation, POS visitor, and 2 group billing paths) now check linked emails before inserting new records — preventing duplicate users when someone uses a different email that we know belongs to them
- **Fix**: Active members purchasing day passes are now logged with a warning for staff visibility
- **Verified**: Zero direct stripe.customers.create() calls remain outside the centralized function
- 7.5.0
- 2026-02-07
- Cross-System Deduplication & Stripe Customer Consolidation
- **New**: Merged 12 duplicate member accounts that existed across Stripe, HubSpot, and the database — consolidating bookings, visits, and payment history into one unified profile per person
- **New**: Stripe customer creation now cross-checks HubSpot contact IDs to prevent creating duplicate Stripe customers when the same person uses different emails
- **New**: HubSpot sync now detects when two database users share the same HubSpot contact and automatically links their emails to prevent future duplicates
- **New**: Data Integrity dashboard now includes a HubSpot ID duplicate check that surfaces suspected duplicate accounts for staff review
- **Fix**: Merge tool now consolidates Stripe customers when both accounts have one — keeps the customer with the active subscription and logs the orphaned one for audit
- 7.4.3
- 2026-02-07
- Complete Dynamic Pricing — All Prices From Stripe
- **New**: /api/pricing endpoint now also serves corporate volume tier pricing and day pass prices from Stripe
- **New**: Corporate volume discount tables on Membership page and Checkout page now pull prices dynamically from Stripe
- **New**: Day pass prices (Workspace and Golf Sim) on Membership page now pull from the database, synced with Stripe
- **New**: /api/pricing endpoint provides current guest fee and overage rate to all frontend components
- **Fix**: Guest payment choice modal now shows the real Stripe price instead of hardcoded $25
- **Fix**: Trackman link modal guest fee labels and Quick Add Guest button now show the real price
- **Fix**: Roster manager 'no passes left' messaging now shows the real guest fee
- **Fix**: Booking members editor guest add buttons and fee notices now show the real price
- **Fix**: Trackman admin fee notes (pending assignment, no passes) now use the real guest fee from Stripe
- **Fix**: Public membership page now shows the real guest fee in the '15 Annual Guest Passes' description
- **Fix**: Member dashboard overage dialog fallback now uses the real overage rate instead of hardcoded $25
- **Fix**: Staff training guide content now displays the real guest fee and overage rate from Stripe
- **Fix**: Staff check-in guest addition now uses the real guest fee from Stripe instead of hardcoded $25
- **Fix**: Roster guest fee assignment now uses the real guest fee from Stripe config
- **Fix**: Guest fee payment recording now uses the actual Stripe payment amount instead of hardcoded $25
- **Fix**: Stripe payment helpers fallback now references the centralized pricing config
- **Fix**: Booking page guest fee and overage rate display fallbacks now use the real Stripe price instead of hardcoded $25
- **Fix**: Staff simulator tab guest fee display fallback now uses the real Stripe price instead of hardcoded $25
- **Fix**: Backend fee calculator overage and guest fee calculations now use the real Stripe price instead of hardcoded $25
- **Fix**: Trackman admin fee breakdown (overage and empty slot fees) now uses the real Stripe price for all 5 calculation paths
- **Fix**: Simulator tab tier-based fee estimator now passes real Stripe pricing instead of hardcoded $25
- **Fix**: Trackman link modal player slot guest count total now uses the real guest fee from Stripe
- **Fix**: E2E booking test fallback now uses the centralized pricing config
- **Improvement**: All components use a shared pricing hook with 5-minute caching for efficient updates

## [7.4.1] - 2026-02-07

### Dynamic Stripe-Sourced Pricing
- **Improvement**: Guest fee and overage rate are now pulled directly from their Stripe products at startup — if you change the price on the Guest Pass or Simulator Overage product in Stripe, the app automatically picks up the new price
- **Improvement**: When Stripe sends a price update notification (webhook), the app updates the in-memory price instantly — no server restart needed
- **Fix**: All fee displays (booking page, member dashboard, staff simulator tab, overage payment dialog) now show the actual Stripe product price instead of a hardcoded $25
- **Technical**: The only hardcoded logic is the business rules — empty slots = guest fee, 30-minute overage blocks, guest pass usage — the dollar amounts always come from Stripe

## [7.4.0] - 2026-02-07

### Critical Billing & Payment Safety Fixes
- **Fix**: Core members were being incorrectly charged $50 overage fees on bookings within their included 60-minute daily allowance — affected 9 bookings across Feb 5–8 (root cause: the system was accidentally counting a booking's own time as 'prior usage,' doubling the total and triggering a false overage)
- **Fix**: All 9 affected bookings have been recalculated to the correct $0 fee. Nicholas Sherry's incorrectly collected $50 has been flagged for refund.
- **Fix**: If a member modifies their booking after starting payment (e.g., adds guests), the system now detects the amount changed and creates a fresh payment request instead of reusing the old one with the wrong amount
- **Fix**: Free guest passes are now only counted when actually used — previously, paying cash for a guest still counted against the member's monthly free pass allowance
- **Fix**: When updating corporate group billing in Stripe, if part of the update fails mid-way, the system now properly rolls back Stripe charges to prevent double-billing
- **Fix**: New membership subscriptions created in Stripe are no longer accidentally skipped if Stripe sends status updates out of order
- **Safety**: The 'Pull from Stripe' sync now refuses to overwrite tier limits (like daily simulator minutes) with zero if the current value is positive — prevents accidental billing breakage from missing Stripe feature keys
- **Fix**: If a member cancels and immediately resubscribes, the old cancellation notice from Stripe no longer accidentally locks out their new subscription
- **Fix**: Members who upgrade their tier now immediately get access to their new guest pass allowance — previously the old pass count stayed locked at the previous tier's limit
- **Fix**: At check-in, if a member upgraded their tier since booking, the system now charges the lower fee instead of the old higher one from booking time
- **Fix**: Bookings with empty player slots (e.g., 4-player booking with only 1 member assigned) now correctly show the $25/slot guest fee for unfilled positions — previously showed 'No fees due'
- **Fix**: Fee calculations now use the longer of the Trackman session time vs. the booking time — when staff extend a booking (e.g., from 4 hours to 5 hours), the financial summary now matches the displayed booking duration instead of using the shorter original session time

## [7.3.5] - 2026-02-06

### Directory Sync Speed Improvement
- **Improvement**: Sync button on Directory page now runs much faster — only syncs members with active statuses or recent changes from HubSpot, instead of re-processing all 2,000+ contacts
- **Improvement**: Removed redundant Stripe sync from the manual sync button — Stripe updates already arrive instantly through webhooks
- **New**: Sync button now also pushes your app's membership status and tier data back out to HubSpot for all active members, so HubSpot always matches what the app shows

## [7.3.4] - 2026-02-06

### Family Group Signup & Terminal Cleanup
- **Fix**: When staff signs up a new member with family sub-members, the family billing group and sub-member accounts are now actually created after payment — previously only the primary member was created and sub-member data was lost
- **Fix**: Family sub-member creation works for both online card and Card Reader payment methods
- **Fix**: If a Card Reader payment is cancelled during new member signup, the pending account and Stripe subscription are now automatically cleaned up instead of being left behind

## [7.3.3] - 2026-02-06

### Checkout Customer Fix & Corporate Billing Safety
- **Fix**: Members who re-sign up through the public checkout page now keep their existing Stripe account instead of getting a duplicate — preserves saved cards and payment history
- **Fix**: Adding and removing corporate group members at the same time can no longer cause the billing count to get out of sync with Stripe

## [7.3.2] - 2026-02-06

### Phone Formatting, Terminal Signup Fix & Auto-Close
- **New**: Phone number fields now auto-format as (XXX) XXX-XXXX while you type
- **Fix**: Card Reader payment during new member signup now correctly links to the subscription and customer instead of creating a standalone charge
- **Fix**: If the signup has an error (like an existing pending account), the Card Reader tab now shows the error and prevents an accidental unlinked charge
- **Fix**: After a successful Card Reader payment, the success screen auto-closes after a brief moment instead of staying open
- **Fix**: Card Reader now works correctly for group/family add-on signups — previously it would fail because it tried to confirm a subscription that didn't exist
- **Fix**: New members now appear immediately in the Active tab of the Directory after signup from staff quick actions
- **Removed**: Guest Pass removed from the POS product list — it's only charged automatically through the booking fee system

## [7.3.1] - 2026-02-06

### Terminal Card Reader: Default for Staff Billing & Reuse Existing Charges
- **Improvement**: Card Reader is now the default payment method in the staff check-in billing screen — no more switching from Online Card each time
- **New**: When a member started an online overage payment but didn't finish, staff can now collect that same charge on the card reader instead of creating a duplicate
- **Fix**: Incomplete overage charges in Stripe are now reused rather than orphaned — cleaner transaction history for members
- **Fix**: Corporate group billing error recovery now properly references subscription data when rolling back Stripe changes
- **Fix**: Refund calculations use precise math to prevent tiny rounding differences over many transactions
- **Fix**: Day pass visitors who sign up for membership now properly get upgraded to member status automatically

## [7.3.0] - 2026-02-06

### Announcements Export & Google Sheets Sync
- **New**: Export all announcements as a CSV file from the Announcements admin tab
- **New**: Two-way Google Sheets sync for announcements — create a linked spreadsheet, add or edit rows in Google Sheets, and pull changes into the app
- **New**: Auto-sync — when you create, edit, or delete an announcement in the app, changes are automatically pushed to the linked Google Sheet
- **New**: 'Pull from Sheet' button imports new and updated announcements from the Google Sheet
- **New**: 'Push to Sheet' button sends all current announcements to the linked Google Sheet
- **New**: Connect/disconnect Google Sheet controls with link to open the sheet directly

## [7.2.3] - 2026-02-06

### Smart Login Redirect
- **Fix**: Logged-in users visiting the home page are now instantly taken to their dashboard — staff and admins go to the Staff Portal, members go to their Member Dashboard
- **Fix**: Logged-in users visiting the login page are now redirected to their dashboard instead of seeing the login form again
- **Improvement**: Redirect uses fast client-side navigation instead of full page reloads for a smoother experience

## [7.2.2] - 2026-02-06

### Reschedule Hardening: Full Gap Audit
- **Fix**: Reschedule now checks for facility closures and availability blocks before confirming — previously it only checked for conflicting bookings, so a reschedule could land on a closed time slot
- **Fix**: Reschedule confirm now runs inside a database transaction — if the session update fails, the booking update is rolled back too, preventing data mismatches
- **New**: Members receive a branded email when their booking is rescheduled — shows the new date, time, and bay name
- **New**: Members receive a push notification when their booking is rescheduled — works even if the app isn't open
- **Improvement**: In-app reschedule notification is now generated on the server instead of the browser — more reliable delivery

## [7.2.1] - 2026-02-06

### Reschedule Safety Fixes
- **Fix**: Original booking date is now preserved when rescheduling — previously only bay, start time, and end time were saved, so a date change lost the original date
- **Fix**: Reschedule confirm now verifies the booking is actually in reschedule mode — prevents accidental confirms without starting the reschedule first
- **Fix**: Any unpaid prepayment charges are automatically voided after a reschedule — prevents members from being billed at the old rate

## [7.2.0] - 2026-02-06

### Booking Reschedule: Move Bookings to Any Bay & Time
- **New**: Staff can reschedule any upcoming booking to a different bay and/or time slot — the member, player roster, guest passes, and all booking details stay intact
- **New**: Reschedule button appears in the Booking Details modal for all future simulator bookings
- **New**: Two-step reschedule flow — first pick the new bay/date/time, then create the booking on Trackman, delete the old one, and paste the new Trackman ID to confirm
- **New**: While a reschedule is in progress, the booking is protected from accidental cancellation — if the old Trackman booking's deletion webhook arrives, the system skips all fee adjustments and member notifications
- **New**: Members receive a 'Booking Rescheduled' notification with the new bay, date, and time — no confusing cancellation notice
- **New**: If a reschedule is started but never completed, the system auto-clears the hold after 30 minutes so the booking doesn't get stuck
- **New**: Duration change warning — if the new time slot has a different duration, staff see a notice that fees may need recalculation

## [7.1.4] - 2026-02-06

### Trackman Webhook Log on Import Page
- **New**: Trackman Import page now shows a live feed of all webhooks received from Trackman — including whether each booking was created, changed, or deleted, and whether it was auto-linked or manually resolved

## [7.1.3] - 2026-02-06

### Booking Duration Options: More Flexibility for Groups
- **New**: 3-player bookings now offer 5 duration options — 90m (30 each), 120m (40 each), 150m (50 each), 180m (60 each), and 270m (90 each) — filling the gap between short and long sessions
- **New**: 4-player bookings now include a 180m option (45 each) alongside 120m and 240m, giving groups a middle-ground choice that matches common Trackman session lengths
- **Improved**: Duration options are now consistent between the member booking page and staff manual booking form

## [7.1.2] - 2026-02-06

### Billing Safety: Race Condition & Revenue Leak Fixes
- **Fixed**: Guest pass race condition — two simultaneous check-in requests could both consume the same remaining pass, allowing more uses than the member's limit. Row locking now prevents double-consumption.
- **Fixed**: Zombie subscription risk — if a new member signup failed partway through, the system could delete the member's account while Stripe kept billing them. Now the account is preserved so staff can investigate and refund.
- **Fixed**: Overage fee calculation gap — during a brief window between check-in and fee processing, a booking's usage minutes could temporarily disappear from the daily total, potentially undercharging overage fees.

## [7.1.1] - 2026-02-06

### POS Checkout: Card-Only Payments & Card on File
- **New**: 'Card on File' payment option — when a customer has a saved card in Stripe, staff can charge it instantly with one tap from the POS checkout
- **New**: POS automatically checks if the selected customer has a saved card and shows their card details (brand + last 4 digits) as a payment option
- **Improved**: POS checkout now offers only Stripe-backed payment methods — Online Card, Card Reader (terminal), and Card on File — cash/check option removed
- **Improved**: Redeem Day Pass section no longer overflows on smaller screens
- **Improved**: Financials tab bar and product category tabs now scroll horizontally on mobile instead of text getting cut off

## [7.1.0] - 2026-02-06

### Financials Redesign: POS Cash Register & Transactions Tab
- **New**: POS tab redesigned as a full cash register — products organized into Passes, Cafe, and Merch categories with a product grid, shopping cart, and checkout in one view
- **New**: Cafe menu items now appear directly in the POS register — all 33 items across 6 categories (Breakfast, Lunch, Dessert, Kids, Shareables, Sides) pulled live from the database
- **New**: Desktop POS layout — product grid on the left (2/3 width) with category tabs, customer search + cart + checkout on the right (1/3 width)
- **New**: Mobile POS layout — product grid with sticky bottom bar showing cart total and quick checkout access
- **New**: Transactions tab — all reporting and audit tools (Daily Summary, Recent Transactions, Pending Authorizations, Future Bookings, Overdue Payments, Failed Payments, Refunds) moved to their own dedicated tab
- **New**: Day Pass redemption scanner now built into the POS tab below the cart for quick access
- **Improved**: Financials page tabs reorganized from old layout to POS | Transactions | Subscriptions | Invoices — selling stuff is now clearly separated from reviewing what happened
- **Improved**: FinancialsTab code reduced from 2,200+ lines to ~880 lines by extracting components into dedicated files

## [7.0.9] - 2026-02-06

### Automatic Stripe Environment Validation & Fee Product Auto-Creation
- **New**: Server startup now validates every stored Stripe ID (products, prices, subscriptions) against the connected Stripe environment — stale IDs from the wrong environment are automatically cleared so the system can rebuild them cleanly
- **New**: Guest Pass ($25), Day Pass - Coworking ($35), and Day Pass - Golf Sim ($50) products are now auto-created on startup — they'll always exist in whatever Stripe account the server connects to, no manual setup needed
- **New**: Simulator Overage and Corporate Volume Pricing auto-creation now works correctly after environment changes — the validation clears stale IDs first so the auto-creators detect they need to rebuild
- **New**: Transaction cache is automatically cleared when an environment change is detected, preventing test data from mixing with live data
- **New**: Clear startup warnings tell staff exactly what needs manual attention — which subscription tiers and cafe items need 'Sync to Stripe' before member signups or cafe operations will work
- **Improved**: Error messages across 9 checkout and payment endpoints now give clear, actionable instructions — subscription tiers say 'Run Sync to Stripe from Products & Pricing' and auto-created products say 'This usually resolves on server restart'
- **Improved**: Stale user subscription IDs are cleared to prevent false alarms in data integrity checks

## [7.0.8] - 2026-02-06

### Stripe Deployment Safety & Environment Indicator
- **New**: 'Stripe Live' or 'Stripe Test' badge now shows next to the sync buttons on the Products & Pricing page — staff can always see which Stripe environment is active
- **New**: 'Pull from Stripe' now has safety guards — if no tiers are linked to Stripe products or Stripe returns zero cafe products but your database has existing data, the pull is skipped to prevent accidental data wipe on a fresh/misconfigured Stripe account
- **New**: Server startup now checks for Stripe environment mismatches — warns if production is using test keys or development is using live keys
- **New**: Server startup checks if live Stripe account has zero products and suggests running 'Sync to Stripe' first

## [7.0.7] - 2026-02-06

### Instant Staff Notifications for Member Status Changes
- **New**: Staff now receive instant push + in-app notifications when a new member joins via Stripe checkout — includes member name, email, and plan
- **New**: Staff now receive instant push + in-app notifications when a new member is activated via MindBody/HubSpot — includes member name, email, and tier
- **New**: Staff now receive instant push + in-app notifications when a member's status changes to inactive (expired, cancelled, etc.) via MindBody/HubSpot
- **New**: Staff now receive instant push + in-app notifications when a member drops to non-member via MindBody — only fires for actual downgrades, not default contacts
- **New**: Staff now receive instant push + in-app notifications when a previously inactive member reactivates their Stripe subscription
- **Improved**: 'New Subscription Created' notification upgraded from in-app only to full push notification with direct link to member list

## [7.0.61] - 2026-02-06

### Smarter Product Editing & Stripe Category Tagging
- **New**: Stripe products now include an app_category metadata key (membership, fee, cafe, config) — enables future auto-routing of new Stripe products to the correct admin tab
- **Improved**: Editing a fee or pass product (Simulator Overage, Guest Pass, Day Passes) now shows only relevant fields — no more confusing booking limits, access permissions, or compare table sections
- **Improved**: Section title changes from 'Membership Page Card' to 'Product Details' when editing non-membership products

## [7.0.6] - 2026-02-06

### Admin Tier Editor Overhaul & Dynamic Membership Page
- **New**: Tier edit modal reorganized into 3 clear sections — Membership Page Card, Stripe-Managed Settings, and Compare Table — each with descriptive helper text so staff know exactly what they're editing
- **New**: 'Show on Membership Page' toggle — control which tiers display as cards on the public membership page without changing any code
- **New**: Membership page now renders cards dynamically from the database instead of being locked to 4 hardcoded tiers — add, remove, or reorder cards from admin
- **New**: Card features (highlighted bullet points) now sync from Stripe's Marketing Feature list — edit them in Stripe Dashboard → Products → Marketing Features and they appear on the cards automatically
- **New**: Card features section shows 'Managed by Stripe' label when tier is linked, with read-only display of the actual feature text from Stripe
- **New**: Stripe customer metadata sync merged into the 'Sync to Stripe' button on Products & Pricing — no more separate button on Data Integrity page
- **New**: Reverse sync now pulls Marketing Features from Stripe products into the app's highlighted features (previously only pushed, never pulled)
- **New**: Product.updated webhook now syncs Marketing Features back immediately when edited in Stripe Dashboard
- **Fixed**: Highlighted features in the edit modal were showing internal permission labels (e.g. 'Can Book Simulators') instead of the actual customer-facing text from Stripe (e.g. 'Cafe, Bar & Patio Dining')
- **Removed**: 'Sync Stripe Metadata' button from Data Integrity page (functionality consolidated into Sync to Stripe)

## [7.0.5] - 2026-02-06

### Stripe-Managed Corporate Pricing & Family Discount
- **New**: Corporate volume pricing tiers ($249–$350/seat) are now stored as Stripe product metadata — edit them in Stripe Dashboard and they sync automatically
- **New**: Family discount percentage is now read directly from the FAMILY20 Stripe coupon instead of being hardcoded — change it in Stripe and it flows to the app
- **New**: Webhook handlers for coupon updates keep the family discount in sync in real-time
- **New**: Corporate volume pricing refreshes automatically when its Stripe product metadata is updated

## [7.0.42] - 2026-02-06

### Stripe Sync Gap Fixes (Round 2)
- **Fixed**: Tier cache now clears immediately after syncing from Stripe — booking limits, guest pass counts, and fee calculations reflect changes instantly instead of up to 5 minutes later
- **Fixed**: Overage fee rate now uses a single centralized source — Trackman reconciliation and Stripe product setup no longer have independent copies of the $25 rate
- **Fixed**: Tier cache clears when a Stripe tier product is deleted or price changes via webhook

## [7.0.41] - 2026-02-06

### Stripe Sync Gap Fixes
- **Fixed**: Cafe item name, price, and category fields are now properly locked (read-only) when editing Stripe-managed items
- **Fixed**: Backend API now prevents overwriting Stripe-managed cafe fields (name, price, category) via direct API calls
- **Fixed**: Deleting Stripe-managed cafe items is now blocked — archive in Stripe Dashboard instead
- **Fixed**: Tier subscription price changes in Stripe Dashboard now automatically sync back to the app
- **Fixed**: Deleting a tier product in Stripe Dashboard now properly unlocks the tier for local editing again

## [7.0.4] - 2026-02-06

### Stripe-Driven Product Management (Reverse Sync)
- **Added**: 'Pull from Stripe' button on Products & Pricing page — refreshes tier permissions and cafe items from Stripe Product Catalog
- **Added**: Booking Limits and Access Permissions now show 'Managed by Stripe' labels when a tier is linked to a Stripe product
- **Added**: Booking limit fields (daily sim minutes, guest passes, booking window, conf room minutes) become read-only when managed by Stripe
- **Added**: Access permission toggles become read-only when managed by Stripe — edit in Stripe Dashboard to update
- **Added**: Cafe Menu items now show 'Managed by Stripe' notice — prices and items sync from Stripe Product Catalog
- **Added**: Automatic webhook sync — changes made in Stripe Dashboard (product updates, price changes) automatically sync to the app
- **Added**: Product.updated, product.created, product.deleted, price.updated, price.created webhook handlers for real-time Stripe sync
- **Foundation**: Stripe Product Catalog is now the source of truth for membership permissions, booking limits, and cafe items

## [7.0.3] - 2026-02-06

### Admin Navigation Consolidation
- **Moved**: Cafe Menu management into Products & Pricing page as a new tab — all Stripe-synced products now managed from one place
- **Renamed**: 'Stripe Config' page is now 'Products & Pricing' for clarity
- **Moved**: Training Guide from Resources section to main navigation under Directory
- **Removed**: Resources sidebar section (no longer needed)

## [7.0.2] - 2026-02-06

### Stripe Sync — Product Features & Cafe Menu
- **Added**: Sync to Stripe button now syncs tier permission features to Stripe Product Catalog automatically
- **Added**: Sync to Stripe button now creates cafe menu items as Stripe one-time products with prices and category metadata
- **Added**: Tier features sync creates/removes Stripe Features dynamically based on current tier permissions — no code changes needed when permissions change
- **Added**: Cafe items sync handles price changes by archiving old prices and creating new ones
- **Added**: stripeProductId and stripePriceId columns on cafe items for Stripe product tracking
- **Foundation**: Stripe becoming source of truth for product catalog — future phases will drive POS and menus from Stripe

## [7.0.1] - 2026-02-06

### Stripe Product Catalog Features Setup
- **Added**: 22 Stripe Product Catalog Features mirroring all membership tier permissions and limits
- **Added**: Access permission features — Can Book Simulators, Can Book Conference Room, Can Book Wellness
- **Added**: Tier benefit features — Group Lessons, Extended Sessions, Private Lessons, Simulator Guest Passes, Discounted Merch, Unlimited Access
- **Added**: Numeric limit features — Daily Sim Minutes (60/90/Unlimited), Guest Passes (4/8/15/Unlimited), Booking Window (7/10/14 days), Conference Room (60/90/Unlimited min/day)
- **Added**: All features attached to correct Stripe products — Social, Core, Premium, Corporate, VIP, Base
- **Note**: Features are informational in Stripe only — app logic unchanged, no member-facing impact

## [7.0.0] - 2026-02-06

### Record Purchase Redesign — Point-of-Sale Experience
- **Redesigned**: Record Purchase card completely restructured as a point-of-sale system
- **Added**: Product selection via tappable buttons instead of dropdown — Day Pass Coworking, Day Pass Golf Sim, Guest Pass
- **Added**: Cart system with quantity controls — add multiple products and see line items with running total
- **Added**: Price is now locked to product × quantity — no manual editing of amounts
- **Removed**: Simulator Overage from purchase options (only used by fee calculator)
- **Added**: Review & Charge drawer — see all line items, subtotal, and total before charging
- **Added**: Payment method selection inside review drawer — Online Card, Card Reader (Terminal), or Cash/Check
- **Added**: Email Receipt button after successful payment — sends branded receipt with line items to the customer
- **Improved**: Layout reordered to Products → Amount → Description → Customer → Review for faster checkout flow

## [6.9.19] - 2026-02-06

### Calendar & Queue Improvements for Inactive Members
- **Improved**: Removed redundant amber dot from calendar cells — amber dotted outline already shows inactive membership status
- **Fixed**: Booking queue card now shows 'Charge' button with amount due instead of 'Checked In' when a checked-in booking has unpaid fees
- **Added**: 'Payment Due' status badge on queue cards for checked-in bookings that still need payment

## [6.9.18] - 2026-02-06

### Fee Calculation Fix for Non-Active Members
- **Fixed**: Terminated and pending members were incorrectly getting their old tier's daily allowance, showing $0.00 fees when they should be charged the full overage rate
- **Fixed**: Fee calculations now check membership status — only active, trial, and past-due members get tier benefits

## [6.9.17] - 2026-02-06

### Card Reader for Booking Payments
- **Added**: Staff can now collect booking fees (overage, guest fees) using the physical card reader during check-in
- **Added**: Payment method toggle — choose between 'Online Card' or 'Card Reader' when charging booking fees
- **Added**: Card reader also works for simulator overage fee collection at check-in

## [6.9.16] - 2026-02-06

### Stripe Customer Auto-Recovery & Terminal Simulated Reader Fix
- **Fixed**: Payments no longer fail when a member's Stripe customer record was deleted — the system now automatically detects invalid customer IDs and creates a fresh one
- **Fixed**: Both 'Pay with Card' and 'Charge' buttons for overage fees now recover gracefully from stale Stripe data
- **Fixed**: Simulated card reader now works for testing — payments no longer fail with 'declined or canceled' because the system now auto-presents a test card on simulated readers

## [6.9.15] - 2026-02-05

### Next Payment Date Tracking & Billing Safety
- **Added**: Next payment date now tracked automatically from Stripe — synced from subscription creation, renewal, and updates
- **Added**: Next payment date visible in the member directory for staff
- **Fixed**: Staff can now charge booking overage fees (was blocked by an incorrect permission check)
- **Fixed**: 'Pay with Card' for booking fees (overage and guest fees) was crashing due to an undefined variable — now works correctly
- **Fixed**: Member deletion now works for all members regardless of ID format
- **Fixed**: If a system error occurs while saving a new member's subscription, the Stripe subscription is now automatically cancelled to prevent orphaned charges

## [6.9.14] - 2026-02-05

### Billing Safety & Access Control Fixes
- **Fixed**: Corporate groups can now fill all purchased seats (previously the last seat was incorrectly blocked)
- **Fixed**: When a corporate group subscription is cancelled, all sub-members are properly deactivated (status set to cancelled, tier cleared) — previously they kept permanent free access
- **Fixed**: Quick Charge one-time payments no longer grant permanent active membership status — prevents users from staying active forever without a subscription
- **Added**: Archiving (removing) a member from the directory now automatically cancels their Stripe subscription so they stop being charged
- **Improved**: Permanent member deletion always cancels active subscriptions automatically (previously required a manual flag)

## [6.9.13] - 2026-02-05

### Comprehensive Member Deletion
- **Fixed**: Delete button now cleans ALL user data across 35+ database tables (previously only ~10)
- **Fixed**: Stripe subscriptions are now canceled before deleting the customer account
- **Fixed**: Stripe subscription pagination handles customers with many subscriptions
- **Added**: Email matching uses case-insensitive comparison on all tables
- **Added**: Cleanup covers notifications, terminal payments, billing logs, push subscriptions, linked emails, fee snapshots, and more
- **Added**: Billing groups are safely deactivated (not deleted) to protect other group members
- **Added**: Visitor deletion also comprehensively cleans all related records
- **Added**: Staff audit log entry recorded for every member/visitor deletion

## [6.9.123] - 2026-02-05

### Terminal Payment Integrity - Complete Coverage
- **Added**: Handler for abandoned/canceled Terminal payments with staff notification
- **Added**: Dispute resolution handling - membership reactivated when disputes are won
- **Fixed**: Payment record always created before checking if membership already active
- **Fixed**: Amount verification now validates against invoices whether paid or unpaid
- **Fixed**: Full refunds now processed correctly after partial refunds
- **Fixed**: Dispute events resilient to out-of-order webhook delivery

## [6.9.12] - 2026-02-05

### Terminal Payment Integrity & Reconciliation
- **Added**: Internal payment record table linking Terminal payments to subscriptions
- **Added**: Webhook handling for Terminal payment refunds - membership suspended automatically
- **Added**: Webhook handling for payment disputes - membership suspended with staff alert
- **Added**: Staff notifications when Terminal payments are refunded or disputed
- **Enhanced**: Full audit trail from payment to membership activation
- **Security**: Improved reconciliation between Stripe and internal records

## [6.9.11] - 2026-02-05

### Stripe Terminal Card Reader Support
- **Added**: Card Reader payment option for in-person membership signup
- Staff can now tap/swipe member cards using Stripe Terminal readers
- Toggle between 'Enter Card' (manual) and 'Card Reader' (terminal) in payment step
- Create simulated readers for testing without physical hardware
- Full backend support: connection tokens, reader discovery, payment processing
- Terminal payments automatically activate membership and sync to HubSpot

## [6.9.105] - 2026-02-05

### Copy Activation Link Feature
- **Added**: 'Copy Link' button next to 'Send Link' when creating new members
- Staff can now copy activation links to clipboard for manual sharing or testing

## [6.9.104] - 2026-02-05

### Fix In-Person Payment Form for New Members
- **Fixed**: Inline card payment form now appears when creating new members in person
- **Fixed**: Stripe subscription creation now explicitly uses card payment collection
- Root cause: Stripe wasn't generating payment intent for the card form

## [6.9.103] - 2026-02-05

### Member Checkout & Activation Link Fixes
- **Fixed**: Activation link expiry now 23 hours (was incorrectly set to 7 days, exceeding Stripe's 24h limit)
- **Fixed**: Better error handling when payment form fails to initialize
- **Added**: Clear error message when Stripe doesn't return payment session

## [6.9.102] - 2026-02-05

### Complete Money-Flow Audit & Fixes
- **Audited**: 261 database queries across all Stripe/billing code paths
- **Audited**: All webhook handlers, subscription management, refund logic
- **Verified**: Dual subscription prevention in family and corporate member addition
- **Verified**: Transaction rollback on database failures
- **Verified**: Idempotency keys for payment intents prevent duplicate charges
- **Verified**: Row-level locking prevents race conditions in fee snapshots
- **Fixed**: Payment record audit logging now correctly logs member email

## [6.9.101] - 2026-02-05

### Comprehensive Audit Logging Fixes
- **Fixed**: 20+ broken audit log calls missing resourceName parameter across billing, bookings, wellness, events
- **Fixed**: Subscription pause/resume/cancel actions now properly recorded in Staff Activity
- **Fixed**: Booking approval and cancellation actions now properly logged
- **Fixed**: Data sync tools (HubSpot, Stripe, duplicates) now properly log all actions
- **Added**: add_corporate_member action type for group billing

## [6.9.10] - 2026-02-05

### Critical Bug Fixes
- **Fixed**: Stripe customer lookup query referencing non-existent column
- **Fixed**: Audit logging now works with both object and positional parameter patterns
- **Added**: Missing audit action types for subscription creation and activation links
- 6.9.99
- 2026-02-05
- Incomplete Signup Cleanup
- **Fixed**: Ghost 'pending' users no longer block email reuse - now shows cleanup option
- **Added**: Automatic cleanup of abandoned signups older than 24 hours (runs every 6 hours)
- **Added**: Staff can clean up incomplete signups directly from the error message
- **Improved**: Error messages now explain when an email has an incomplete signup vs an active member

## [6.9.98] - 2026-02-05

### Family Billing Data Completeness Fix
- **Fixed**: Family member profile info (name, phone, birthday) now properly sent when adding to family plans
- **Fixed**: addFamilyMember wrapper function now passes all profile fields correctly

## [6.9.97] - 2026-02-05

### Family Billing & Subscription Safety Fixes
- **Fixed**: Family members added to billing groups now automatically get user accounts created
- **Fixed**: Family billing now matches corporate billing behavior for user account creation
- **Added**: Dual subscription prevention - users with active individual subscriptions cannot be added to family/corporate plans
- **Added**: Clear error messages when attempting to add a member who already has their own subscription
- **Verified**: Past-due status already propagates correctly to sub-members when primary account fails payment

## [6.9.96] - 2026-02-05

### Notice to Members Field
- **Added**: Dedicated 'Note to Members' field for notices, separate from Google Calendar sync
- **Added**: 'Note to Members' text area in notice form for staff to write member-facing messages
- **Fixed**: Notice cards now display the dedicated member notice instead of raw HTML from calendar
- **Fixed**: Google Calendar descriptions now sync to Staff Notes only, not member-facing content
- **Improved**: Clear labels distinguishing member-visible content from internal staff notes

## [6.9.95] - 2026-02-05

### Comprehensive Database Column Fixes
- **Fixed**: 'column user_id does not exist' error when adding new members
- **Fixed**: Linked email lookups now use correct column name (primary_email instead of user_id)
- **Fixed**: All email linking operations in Trackman, staff assignment, and member creation flows
- **Fixed**: Test account cleanup now correctly references linked emails table
- **Fixed**: Stripe webhook now uses correct 'membership_status' column instead of 'status'
- **Fixed**: Notification inserts now use correct 'user_email' column instead of 'user_id'
- **Fixed**: Booking confirmation notifications in Trackman webhook and resource assignment flows

## [6.9.94] - 2026-02-05

### Database Column Fix for New Members
- **Fixed**: 'column dob does not exist' error when adding new members
- **Fixed**: Date of birth field now uses correct database column name in all member creation flows

## [6.9.93] - 2026-02-05

### Corporate Checkout Field Fixes
- **Fixed**: Last name now properly saved when purchasing corporate volume subscription
- **Fixed**: Phone number now properly saved when purchasing corporate volume subscription
- **Fixed**: HubSpot now correctly sets lifecycle stage to 'member' for new corporate subscriptions
- **Fixed**: HubSpot now correctly sets membership status to 'Active' for new corporate subscriptions

## [6.9.92] - 2026-02-05

### Corporate & Family Billing Status Propagation
- **Fixed**: Corporate billing reconciliation now correctly skips quantity-based groups
- **Fixed**: Past-due and unpaid statuses now propagate to all family/corporate sub-members
- **Fixed**: Sub-members are automatically reactivated when primary subscription becomes active
- **Fixed**: Metadata is now preserved when corporate subscription items are replaced during price tier changes
- **Added**: Sub-members receive notifications when group billing status changes

## [6.9.91] - 2026-02-05

### Future Bookings Visibility on Financials
- **Added**: 'Future Bookings' card on Financials page shows upcoming approved bookings with expected fees
- **Added**: Track guest fees and estimated charges before payment intents are created
- **Added**: Visual indicators for member tier, guest count, and payment status on each booking

## [6.9.9] - 2026-02-05

### Activation Link for New Members
- **Added**: Staff can now send new members a payment setup link instead of charging them directly
- **Added**: New members receive a branded email with a secure Stripe checkout link
- **Added**: Links are valid for 7 days and guide members to set up their own payment method
- **Added**: Automatic member activation when payment is completed via activation link
- **Fixed**: Notification system now handles null values correctly for data integrity alerts
- **Fixed**: Corporate billing webhook now properly updates member tier and billing provider
- **Fixed**: HubSpot sync no longer overwrites membership status to 'non-member' for users with active Stripe subscriptions
- **Fixed**: Members with Stripe subscriptions now correctly appear only in Active tab, not Visitors
- **Fixed**: Cancelled bookings now properly clear pending fees (no more phantom charges after cancellation)

## [6.9.83] - 2026-02-05

### Staff Manual Booking Improvements
- **Fixed**: Duration options now adjust based on player count in staff manual booking modal
- **Fixed**: Clicking a conference room cell now opens the modal to the Conference Room tab
- **Fixed**: Conference room time slot now pre-selects based on the clicked cell
- **Improved**: Reordered fields so Player Count appears before Duration for better UX

## [6.9.82] - 2026-02-05

### Enhanced Animations & UI Polish
- **Added**: Touch feedback animations on booking cards, event cards, and member rows
- **Added**: Springy bounce animation when staff action button appears
- **Added**: Staggered entry animations in member profile drawer for all tabs
- **Added**: Staggered list animations on Events page and Staff Command Center
- **Added**: Smooth loading spinner transition effects for buttons
- **Fixed**: Stripe Config tab text no longer overflows on mobile screens
- **Improved**: Overall app feels more fluid and responsive to touch

## [6.9.81] - 2026-02-05

### Changelog Performance Optimization
- **Improved**: App Updates tab now loads 25 entries at a time instead of all at once
- **Added**: 'Load More Updates' button to progressively load older changelog entries
- **Fixed**: Changelog page performance issues caused by rendering 100+ entries simultaneously

## [6.9.8] - 2026-02-05

### Optimistic UI & Dark Mode Improvements
- **Added**: Instant visual feedback when booking, cancelling, or updating throughout the app
- **Added**: Spinners and status badges show immediately when taking actions instead of waiting for server
- **Added**: Member Wellness page now shows instant feedback for class enrollment, cancellation, and waitlist operations
- **Added**: Member Events page now shows instant feedback for event RSVPs and cancellations
- **Added**: Member Dashboard now shows instant feedback for booking cancellations and invite handling
- **Added**: Staff Simulator tab now shows instant feedback for booking creation and status updates
- **Added**: Staff Events tab now shows instant feedback for event creation, updates, and RSVP management
- **Added**: Staff Directory tab now shows instant feedback for member tier updates
- **Added**: Staff Trackman tab now shows instant feedback for booking linking and unlinking
- **Fixed**: Payment forms (Stripe) now properly display in dark mode with readable labels and inputs
- **Fixed**: All payment modals (guest passes, invoices, bookings) now use consistent dark mode styling
- **Fixed**: Update notification popup now appears below the header instead of being hidden behind it
- **Improved**: Error handling now properly reverts UI state when actions fail

## [6.9.74] - 2026-02-05

### Staff Training Guide Accuracy Update
- **Updated**: Training guide now accurately reflects current app navigation and feature locations
- **Fixed**: Bottom navigation description corrected (Home, Bookings, Financials, Calendar, Directory)
- **Fixed**: Payment button labels now match actual UI (Charge Card on File, Pay with Card, Mark Paid)
- **Fixed**: Updates page tabs renamed to Alerts and Announce to match actual labels
- **Fixed**: Directory now correctly documented as having 4 tabs including Team
- **Added**: POS Refunds section documentation in Financials training
- **Added**: Closure Reasons subtab and member visibility toggle documentation
- **Updated**: Tour sources now correctly list website widget, HubSpot, and Google Calendar
- **Updated**: All admin section navigation paths corrected to use sidebar/hamburger menu

## [6.9.73] - 2026-02-05

### Profile Page Navigation Improvement
- **Improved**: Profile page now shows hamburger menu instead of back arrow for consistent navigation
- **Improved**: Staff see their Staff Portal sidebar when tapping hamburger on Profile
- **Improved**: Members see their Member Portal sidebar when tapping hamburger on Profile

## [6.9.72] - 2026-02-05

### Staff Notes for Closures & Notices
- **Added**: Notes field for closures and notices that syncs bidirectionally with Google Calendar event descriptions
- **Added**: Notes appear after metadata brackets in calendar events for easy reading
- **Added**: Notes display on notice cards in the Blocks tab with expandable details
- **Improved**: Notice editing now shows and preserves existing notes from calendar sync
- **Fixed**: HTML formatting from calendar descriptions is now converted to plain text

## [6.9.71] - 2026-02-05

### Improved: Staff Booking Modal Animations
- **Added**: Smooth horizontal slide animation when switching between Member Booking, Lesson/Staff Block, and Conference Room tabs
- **Added**: Modal height now animates smoothly when tab content changes size instead of snapping
- **Improved**: Member search dropdown now auto-scrolls into view when results appear

## [6.9.7] - 2026-02-05

### Staff Conference Room Booking
- **Added**: New 'Conference Room' tab in staff manual booking modal for creating conference room bookings on behalf of members
- **Added**: Date, duration (30-240 min), and available time slot selection with conflict checking
- **Added**: Real-time overage fee estimation based on member's tier and daily allowance
- **Added**: Members receive notification when staff creates a booking for them
- **Improved**: Conference Room removed from Bay dropdown in Member Booking tab to prevent confusion
- 6.9.65
- 2026-02-05
- **Fixed**: Admin View As Mode
- **Fixed**: 'View As' mode now shows the actual member's dashboard data including their bookings and schedule
- **Fixed**: 'View As' mode now shows the member's outstanding fees and balance correctly
- **Fixed**: Balance card and payment modal now work correctly when admin is viewing as a member
- **Improved**: Admins can now accurately verify what members see on their dashboards

## [6.9.64] - 2026-02-05

### Fixed: Notification Timestamps & Participant Alerts
- **Fixed**: Notification timestamps now correctly display in Pacific time instead of showing 8 hours ahead
- **Fixed**: Staff calendar no longer shows false '$50 owed' indicators for complete rosters
- **Fixed**: Staff calendar now correctly shows actual participant count (e.g., '3/3 slots filled') instead of erroneous estimates
- **Added**: Participants now receive 'Added to Booking' notifications when they are added to approved bookings
- **Improved**: Fee estimation now only shows for incomplete rosters; complete rosters use actual database values

## [6.9.63] - 2026-02-04

### Fixed: Booking Participant Tracking
- **Fixed**: Members added to booking requests from directory now properly appear on their dashboards after confirmation
- **Fixed**: Trackman notes now display actual participant names instead of placeholder text
- **Fixed**: Player slots now correctly show requested participants after booking confirmation
- **Improved**: Participant email resolution from member directory selection during booking creation

## [6.9.62] - 2026-02-04

### Improved: Corporate Checkout Contact Fields
- **Added**: First Name, Last Name, Email, and Phone Number fields to corporate checkout
- **Added**: All new contact fields are required before proceeding to payment
- **Added**: Email validation to ensure proper format
- **Added**: Contact info now stored in Stripe metadata for corporate memberships

## [6.9.61] - 2026-02-04

### Fixed: Corporate Membership Navigation
- **Fixed**: Corporate 'View Details' button now correctly navigates to the Corporate Membership page
- **Fixed**: Route ordering issue that prevented nested membership routes from rendering

## [6.9.6] - 2026-02-04

### New: Membership Application Landing Page
- **Added**: New standalone landing page at /membership/apply for membership applications
- **Added**: Custom-branded 2-step form with contact info and membership preferences
- **Added**: Submissions go to HubSpot and are saved locally for staff review
- **Changed**: All 'Apply' buttons on the Membership page now navigate to the new landing page
- **Improved**: Consistent design with the Private Hire inquiry page (glassmorphism, 2-step flow)

## [6.9.5] - 2026-02-04

### New: Private Hire Inquiry Landing Page
- **Added**: New standalone landing page at /private-hire/inquire for event inquiries
- **Added**: Custom-branded 2-step form matching HubSpot fields with updated Event Type options
- **Added**: Event types now include Private Event, Birthday, Corporate, Brand Activation, Other
- **Added**: Private Hire submissions now appear on Admin Inquiries page under 'Private Hire' tab
- **Changed**: Submit Inquiry button on Private Hire page now navigates to the new landing page
- **Improved**: Consent checkbox is now required before proceeding with the inquiry

## [6.9.49] - 2026-02-04

### Fixed: Prepayment Intents Now Created When Guests Added After Approval
- **Fixed**: Adding guests via roster or staff check-in now creates prepayment intent for member to pay online
- **Fixed**: Members can now prepay fees when guests are added after initial booking approval
- **Fixed**: All participant-add flows (roster, staff check-in) now trigger prepayment creation if fees exist
- **Previously**: Guests added after booking approval had fees calculated but no prepayment intent - blocking check-in with no way to pay online

## [6.9.48] - 2026-02-04

### Fixed: Booking Cards Now Show Correct Fee Estimates
- **Fixed**: Booking card fee estimates now include guest fees ($25 per guest slot)
- **Fixed**: Fee estimates now correctly split time across all players (duration ÷ player count)
- **Fixed**: VIP with 1 guest now shows $25 (guest fee), not $0
- **Fixed**: Social with 1 guest (60 min) now shows $50 ($25 overage + $25 guest), not $50 (wrong calculation)
- **Previously**: Booking cards used a simplified estimate that ignored guests entirely - causing staff to see wrong amounts

## [6.9.47] - 2026-02-04

### Critical: Bookings No Longer Link to Wrong Sessions
- **Fixed**: Bookings now NEVER link to sessions belonging to other members
- **Fixed**: Dev Confirm and Check-In now verify session owner matches booking member before linking
- **Fixed**: Removed dangerous 'overlapping session' matching that caused bookings to steal other members' sessions
- **Fixed**: Each booking now gets its own session with correct owner and participants
- **Previously**: A booking could link to any overlapping session on the same bay - even if owned by a different member!

## [6.9.46] - 2026-02-04

### Guest Slots Always Show $25 Fee
- **Clarified**: ALL guest slots show $25 fee (linked to Stripe guest fee product)
- **Clarified**: Only way to avoid $25 guest fee is: add a member with Core tier or higher, OR use a guest pass
- **Clarified**: Empty guest slots still incur fee - if you select 2 players, the second player slot is charged
- Business rule: Selecting 2 players = 1 guest = $25 charge regardless of whether info is filled in

## [6.9.45] - 2026-02-04

### Booking Cards Always Show Expected Fees
- **Improved**: Staff booking cards now always show expected fees based on member tier, even before session is created
- **Improved**: Social tier members show '~$50 Est' for 1-hour booking before session exists, then exact amount after check-in
- **Improved**: Calendar grid now shows fee indicator (red dot) for bookings where fees are expected based on tier
- **Previously**: Staff only saw 'Check In' button until session was created - now shows fees upfront

## [6.9.44] - 2026-02-04

### Dev Confirm Workflow Simplified
- **Improved**: Dev Confirm button now directly confirms bookings without simulating webhooks
- **Improved**: Confirmation creates session and participants directly - no fake Trackman IDs needed
- **Technical**: New clean endpoint preserves all booking details while bypassing webhook simulation

## [6.9.43] - 2026-02-04

### Fee Calculation & Check-In Stability
- **Fixed**: Fee calculation now uses session actual times instead of arbitrary booking durations when multiple bookings share a session
- **Fixed**: Check-in button consolidated to use single handler - eliminates conflicting success/failure messages
- **Fixed**: Check-in now properly refreshes booking lists after successful status change
- **Improved**: Data cleanup for bookings with mismatched duration values
- **Technical**: loadSessionData() now calculates duration from session start/end times with fallback to booking duration

## [6.9.42] - 2026-02-04

### Critical: Session Duration & Fee Calculation Fix
- **Fixed**: Booking sessions now use EXACT time matching instead of overlap matching - prevents reusing sessions with wrong duration
- **Fixed**: Simulate confirmation now creates sessions with correct duration matching the booking request
- **Fixed**: Check-in and staff check-in contexts now use exact time matching for session lookup
- **Fixed**: Participant slot_duration now properly reflects actual booking length in ALL code paths
- **Fixed**: Staff-added participants (members and guests during check-in) now get correct slot_duration
- **Fixed**: Fee calculations now see the correct session duration for accurate overage charges
- **Fixed**: Corporate member 180-minute bookings now correctly show overage fees beyond 90-minute allowance
- **Previously**: 3-hour bookings could be linked to existing 90-minute sessions, causing $0 fee when fees should apply

## [6.9.4] - 2026-02-04

### Staff Can Charge Member's Card on File
- **New**: Staff can now charge a member's saved card directly during check-in without requiring the member to enter their card
- **New**: 'Charge Card on File' button appears in check-in billing modal when member has a saved payment method
- **New**: Shows card brand and last 4 digits (e.g., 'Visa ****4242') so staff knows which card will be charged
- **Improved**: Staff can still use 'Pay with Different Card' if needed for a new payment method
- **Technical**: Uses off-session charging similar to day pass auto-charge for seamless processing

## [6.9.39] - 2026-02-04

### Critical: Booking Participants Now Saved at Approval
- **Fixed**: Members and guests added during booking request are now properly converted to session participants at approval time
- **Fixed**: Booking workflow now works correctly: Member requests > adds players > staff approves > fees locked for all participants
- **Fixed**: Member participants added by email (without userId) are now properly resolved and linked
- **Fixed**: Guests who match existing member emails are automatically converted to member participants
- **Improved**: Duplicate participant detection prevents the same person being added twice
- **Previously**: Only the booking owner was created as a participant - additional players were lost at approval

## [6.9.38] - 2026-02-04

### Check-In & Fee Stability Fixes
- **Fixed**: Booking cancellation now properly refreshes the list instead of showing an error
- **Fixed**: Check-in button no longer shows conflicting success/failure messages
- **Fixed**: Fees are now locked in at approval time - members see the same price at check-in that they were quoted
- **Improved**: Added protection against accidental double check-ins
- **Improved**: Staff can now provide optional email when adding guests - if it matches a member, they're automatically added as a member instead

## [6.9.37] - 2026-02-03

### Assign Players Bug Fix
- **Fixed**: Assign players to booking feature now works correctly
- **Fixed**: SQL query generation issue when updating staff notes
- **Improved**: Better error logging for booking assignment failures

## [6.9.36] - 2026-02-03

### HubSpot Status Sync Fix
- **Fixed**: HubSpot membership status sync now uses valid status values
- **Fixed**: Statuses like 'Inactive' replaced with proper HubSpot options (Suspended, Expired, etc.)
- **Improved**: All app statuses now correctly map to HubSpot dropdown options

## [6.9.35] - 2026-02-03

### Orphaned Booking Participant Fix
- **Fixed**: Deleted 9 orphaned test booking participants referencing non-existent users
- **Fixed**: Member deletion now properly unlinks booking participants (marks as guests)
- **Fixed**: Member anonymization now also unlinks booking participants
- **Improved**: These orphan errors will no longer occur in production

## [6.9.34] - 2026-02-03

### MindBody Data Quality Check Improvement
- **Fixed**: MindBody Data Quality check now only flags active members missing a tier
- **Fixed**: Inactive members (terminated, expired, declined) no longer show in this check

## [6.9.33] - 2026-02-03

### HubSpot Billing Source Sync Improvement
- **Fixed**: When staff changes billing provider, membership status now syncs to HubSpot too
- **Fixed**: This ensures HubSpot reflects app's status even if MindBody shows cancelled

## [6.9.32] - 2026-02-03

### MindBody Member Billing Separation
- **Changed**: MindBody members can add a payment method for overage fees without requesting migration
- **Changed**: Only staff can migrate MindBody members to Stripe subscription billing
- **Changed**: Member billing messaging now focuses on overage fees, not migration

## [6.9.31] - 2026-02-03

### Account Balance in Profile Drawer
- **Added**: Staff can now see member account balance directly in the Directory profile drawer
- **Added**: Staff can apply credits to members from the profile drawer (no need to go to Billing tab)
- **Fixed**: HubSpot sync now sets lifecycle stage to 'member' for active members

## [6.9.3] - 2026-02-03

### Team Page Moved to Admin
- **Changed**: 'Team' renamed to 'Manage Team' and moved to Admin section
- **Changed**: Manage Team is now only visible to admins, not regular staff

## [6.9.29] - 2026-02-03

### MindBody Integrity Checks Added
- **Added**: MindBody Stale Sync check - finds active MindBody members with stale records (30+ days unchanged)
- **Added**: MindBody Data Quality check - finds members missing MindBody ID or tier
- **Removed**: Stale Past Tours check (not needed)
- **Removed**: Duplicate Tour Sources check (not needed)

## [6.9.28] - 2026-02-03

### Data Integrity Billing Provider Filters
- **Fixed**: Stripe Subscription Sync now correctly excludes MindBody/family/comped members
- **Fixed**: Tier Reconciliation check excludes non-Stripe-billed members
- **Fixed**: Stuck Transitional Members check excludes non-Stripe-billed members
- **Fixed**: Preview no longer shows 450 false mismatches for MindBody-billed members

## [6.9.27] - 2026-02-03

### Data Integrity Sync Fix
- **Fixed**: HubSpot sync push/pull now works correctly from Data Integrity page
- **Fixed**: 'issue_key is required' error no longer appears when syncing

## [6.9.26] - 2026-02-03

### Session Backfill Matches on Start Time
- **Fixed**: Backfill now matches sessions by start time only (not exact duration)
- **Fixed**: Bookings with different durations than actual sessions now link correctly
- **Example**: A 14:00-19:00 booking request now links to a 14:00-18:00 session

## [6.9.25] - 2026-02-03

### Session Backfill Links Existing Sessions
- **Fixed**: Bookings that match an existing session are now linked instead of failing
- **Fixed**: 'Double-booking' errors no longer occur - backfill finds and links to matching sessions
- **Improved**: Response shows count of newly created vs linked to existing sessions

## [6.9.24] - 2026-02-03

### Session Backfill Resilience
- **Fixed**: Session backfill now continues processing even when individual bookings fail
- **Fixed**: One problematic booking no longer stops the entire batch from being processed
- **Fixed**: Uses database savepoints to isolate failures and maximize successful session creation

## [6.9.23] - 2026-02-03

### Session Backfill Fix
- **Fixed**: 'Create Sessions' button now processes all bookings without sessions (was missing 'confirmed' status)
- **Fixed**: Session backfill now includes approved, attended, AND confirmed bookings
- **Fixed**: Preview count now matches actual bookings that will be processed

## [6.9.22] - 2026-02-03

### MindBody Member Credits Fix
- **Fixed**: Staff can now apply Stripe credits to MindBody-billed members
- **Fixed**: Credit application no longer restricted to Stripe-billing-only members
- **Improved**: Any member with a Stripe customer ID (or who can have one created) can now receive credits

## [6.9.21] - 2026-02-03

### Check-In Date Display Fix
- **Fixed**: 'Invalid Date' no longer appears in check-in billing modal for external bookings
- **Fixed**: Date formatting now properly handles ISO timestamps with timezone info
- **Fixed**: Same date parsing issue resolved across BookingMembersEditor, ManagePlayersModal, and CompleteRosterModal

## [6.9.2] - 2026-02-03

### Guest Pass Atomicity Hardening
- **Fixed**: Guest pass deduction now happens inside same database transaction as session creation
- **Fixed**: Both booking request flow (holds conversion) and staff/trackman flow (direct deduction) are now atomic
- **Fixed**: Passes now verified before deduction - insufficient passes fail the booking instead of allowing free sessions
- **Technical**: Uses FOR UPDATE row locking to prevent concurrent access issues

## [6.9.1] - 2026-02-03

### Critical Billing Accuracy Fixes
- **Fixed**: Fee estimates now match actual charges - declared player count used consistently in billing
- **Fixed**: All session minutes now billed correctly - remainder minutes distributed fairly instead of lost
- **Fixed**: Guest pass deduction now properly fails booking if passes unavailable (with automatic compensation on session creation failure)
- **Fixed**: Adding member to billing group now checks existing group membership - prevents silent removal from family plans

## [6.9.0] - 2026-02-03

### Security Hardening & Bug Fix Release
- **Removed**: Reschedule feature - members now cancel and request new bookings (prevents limit bypass exploit)
- **Security**: Fixed OTP replay race condition - magic links can only be used once
- **Security**: Fixed guest pass double-spend - passes are now reserved atomically during booking
- **Security**: Added 1-hour cancellation policy - no refunds for late cancellations
- **Fixed**: Members added by email no longer charged as guests - system now looks up existing accounts
- **Fixed**: Event RSVPs now enforce capacity limits - no more overbooking
- **Fixed**: Wellness waitlist race condition - concurrent cancellations now promote correct users
- **Fixed**: Day pass refunds now actually refund money to customers (not just database status)
- **Fixed**: Failed subscription DB updates now roll back Stripe charges
- **Fixed**: Bulk tier updates now run in background - no more timeouts for large updates
- **Fixed**: Deleted members now have sessions cleared - no stale logins
- **Fixed**: Cross-midnight bookings handled correctly in Trackman webhooks
- **Fixed**: Event time updates are now atomic - no availability gaps
- **Improved**: Admin page subtabs now saved in URL - shareable links work correctly

## [6.8.0] - 2026-02-03

### Comprehensive Performance & Responsiveness Overhaul
- **Fixed**: Wellness page crash/reload loop - now loads smoothly every time
- **Fixed**: Directory page slow loading - now uses incremental loading for large member lists
- **Fixed**: WebSocket reconnection loops during navigation - now maintains single connection per session
- **Fixed**: Navigation delays and blank screens - pages now render immediately with loading placeholders
- **Fixed**: All navigation (bottom nav, sidebar, mobile menu) now highlights immediately when tapped
- **Added**: Staff portal now prefetches adjacent pages for faster navigation
- **Improved**: Admin tabs (Tiers, Trackman, Tours, Events) now show skeleton placeholders instead of blocking spinners
- **Improved**: Public pages (Landing, Gallery) load faster with optimized images
- **Removed**: 133 lines of unused loading code from Gallery page

## [6.7.10] - 2026-02-03

### Cancellation Handling & Audit Trail
- **New**: Staff tier assignments now appear in Staff Activity feed (audit logging)
- **New**: When membership is cancelled, HubSpot deal moves from Won to Lost
- **New**: Cancelled members have deal line items removed from HubSpot
- **Note**: Works for both Stripe and MindBody-billed members

## [6.7.9] - 2026-02-03

### Stripe Subscription Tier Sync
- **New**: Stripe subscription changes now update HubSpot deal line items (Stripe-billed members only)
- **New**: Stripe webhook tier sync queues for retry on HubSpot failures (Stripe-billed only)
- **Note**: MindBody-billed members are unaffected - use staff tier assignment in member profile

## [6.7.8] - 2026-02-03

### Tier Sync Reliability
- **Fixed**: HubSpot sync failures now queue for automatic retry instead of being lost
- **Fixed**: First-time tier assignments correctly show 'None' as previous tier (not 'Social')
- **Fixed**: Rapid tier changes no longer get out of order - improved sync deduplication
- **Improved**: Auto-fix now prefers primary user's tier when copying from linked emails
- **Improved**: Falls back to most recently updated alternate email tier if no primary

## [6.7.7] - 2026-02-03

### Staff Tier Assignment
- **New**: Staff can now assign tiers directly in the app for MindBody-billed members without a tier
- **New**: Yellow warning appears on member profile when no tier is assigned
- **Improved**: App is source of truth for tiers - removed HubSpot pull, tier changes sync from app to HubSpot

## [6.7.6] - 2026-02-03

### Tier Data Automation
- **New**: Member creation now requires a valid tier - prevents members from being created without tier assignment
- **New**: Real-time HubSpot sync - tier changes now queue immediately to HubSpot instead of waiting for batch sync
- **New**: Scheduled auto-fix runs every 4 hours - automatically copies tiers from alternate emails (same HubSpot ID)
- **Improved**: Visitor records automatically upgrade to member when assigned a tier

## [6.7.5] - 2026-02-02

### Data Integrity Cleanup
- **Fixed**: 7 members missing tier now have tier copied from their alternate email or pulled from HubSpot
- **Added**: Script to safely pull missing tiers from HubSpot (skips unknown tiers to prevent data corruption)

## [6.7.4] - 2026-02-02

### HubSpot Tier Sync Safety
- **Fixed**: Unknown/unrecognized tiers now safely skip HubSpot updates instead of setting incorrect values
- **Fixed**: HubSpot contact/deal creation now builds properties conditionally to prevent empty tier fields
- **Added**: Group Lessons tier support for HubSpot sync
- **Improved**: Consistent null handling across all HubSpot tier sync points

## [6.7.3] - 2026-02-02

### HubSpot Tier Sync Improvements
- **Improved**: App is now source of truth for membership tiers - tier data pushed to HubSpot uses standardized format
- **Improved**: Tier names normalized when syncing to HubSpot (e.g., 'Core' becomes 'Core Membership', founding member variations simplified)
- **Fixed**: Removed orphaned Stripe customer IDs for deleted Stripe customers
- **Fixed**: Data integrity check now correctly excludes MindBody-billed members from Stripe sync warnings

## [6.7.2] - 2026-02-02

### Page Load Performance Boost
- **Performance**: Dashboard now loads all data in a single request instead of 9 separate calls - significantly faster initial load
- **Performance**: Dashboard data cached for 5 minutes - returning to the dashboard is now instant
- **Performance**: Navigation prefetching improved - data starts loading when you hover over menu items
- **Fixed**: Stripe subscription sync check now properly excludes MindBody-billed members

## [6.7.1] - 2026-02-02

### Accessibility & UX Improvements
- **Accessibility**: Added descriptive alt text to all images across the app (WCAG compliance)
- **New**: Unified Button component with primary, secondary, danger, and ghost variants
- **New**: Breadcrumb navigation component for improved admin page hierarchy
- **Improved**: Keyboard focus indicators added to TabButton and interactive elements
- **Fixed**: Modal content now properly visible on small mobile screens (was cut off)
- **Improved**: Theme color system expanded with primary and bone color variants

## [6.7.0] - 2026-02-02

### Security Hardening Update
- **Security**: Added authorization checks to member profile endpoints - users can only view their own profile unless staff/admin
- **Security**: Implemented rate limiting on checkout and member lookup endpoints to prevent abuse
- **Security**: Added Zod input validation for checkout requests to prevent malformed data
- **Security**: Standardized session access patterns across all API routes for consistent authentication
- **Security**: Enhanced audit logging for corporate checkout pricing calculations
- **Improved**: All sensitive operations now log unauthorized access attempts for security monitoring

## [6.6.4] - 2026-02-02

### Safari Toolbar Color Fix
- **Fixed**: Safari toolbar now respects device theme mode (light bone in light mode, dark in dark mode)
- **Preserved**: Green loading screen with white mascot unchanged

## [6.6.3] - 2026-02-02

### Safari Toolbar Fix
- **Fixed**: Green loading screen no longer appears between page navigations (only shows on initial app startup)
- **Fixed**: Safari toolbar should no longer flash green when switching pages
- **Improved**: Page transitions are now instant without any loading overlay

## [6.6.2] - 2026-02-02

### Notification System Fixes
- **Fixed**: Notifications no longer reappear as unread after marking all as read and returning to the page
- **Fixed**: Wellness confirmation notifications are now automatically removed when you cancel your enrollment
- **Improved**: Cleaner notification history without stale or outdated entries

## [6.6.1] - 2026-02-02

### Member Navigation Polish
- **Fixed**: Removed jarring green loading screen flash when switching between tabs in member portal
- **Improved**: Bottom navigation now switches instantly between Home, Book, Wellness, Events, and History

## [6.6.0] - 2026-02-02

### Animation System Enhancements
- **New**: Smooth tab transition animations when switching between admin tabs
- **New**: Animated success checkmark component for visual confirmation
- **New**: Notification badge now pulses to draw attention to unread items
- **New**: Animated counters for metrics - numbers animate when values change
- **New**: Card removal animations - items slide out smoothly when deleted
- **New**: Standardized skeleton loading shimmer effects across all pages
- **New**: Confetti celebration component for achievements and milestones

## [6.5.0] - 2026-02-02

### UX/UI Polish & Accessibility Improvements
- **Improved**: Consistent empty state designs across all pages (no more plain 'No results found' text)
- **Improved**: All submit buttons now show loading spinners while processing
- **Improved**: Touch targets meet accessibility standards (minimum 44x44 pixels)
- **Improved**: Better confirmation feedback with toast notifications for key actions
- **Improved**: Form validation errors are now more visible with red borders and icons
- **Improved**: Staff modals show success/error toasts when adding players or creating bookings

## [6.4.2] - 2026-02-02

### Security & Data Integrity Improvements
- **Security**: Login rate limiting now blocks requests when the database is unavailable (prevents abuse during outages)
- **Fixed**: Roster changes (adding/removing players) now use proper database transactions to prevent partial updates
- **Fixed**: If something fails while adding a player, all changes are now properly rolled back
- **Improved**: Booking member records are now part of the same transaction as participant changes

## [6.4.1] - 2026-02-02

### Bug Fixes: Guest Passes, Notifications & Check-in
- **Fixed**: Guest pass lookups now work correctly regardless of email capitalization (e.g., John@Email.com vs john@email.com)
- **Fixed**: Staff can now mark individual notifications as read for members they're helping (consistent with bulk actions)
- **Fixed**: Check-in system no longer creates duplicate participant records if called multiple times
- **Fixed**: Guest pass refunds now correctly match records regardless of email case

## [6.4.0] - 2026-02-02

### Corporate Volume Pricing & 30-Day Cancellation Notice
- **New**: Corporate memberships now use tiered volume pricing - larger teams get lower per-seat rates
- **New**: Volume tiers: $350/seat (1-4), $325/seat (5-9), $299/seat (10-19), $275/seat (20-49), $249/seat (50+)
- **New**: Subscription prices automatically adjust when employees are added or removed
- **New**: 30-day notice period for membership cancellations - cancellation takes effect 30 days after request or at billing period end (whichever is later)
- **New**: Members can request cancellation from their billing page with optional reason
- **New**: Staff are automatically notified when members request cancellation
- **New**: Staff can undo pending cancellations if members change their mind
- **New**: Cancellation status now visible in member billing info

## [6.3.7] - 2026-02-02

### Security & Error Recovery Improvements
- **Security**: Push notification routes now properly verify you're logged in before subscribing
- **Security**: Staff-only notification controls now require staff authentication
- **Fixed**: App no longer gets stuck in reload loops when errors occur - stops after 2 attempts and shows recovery options
- **Improved**: Error screens now show 'Clear Cache & Refresh' and 'Contact Support' options when something goes wrong

## [6.3.6] - 2026-02-02

### Real-Time Connection Stability Improvements
- **Fixed**: Staff dashboard no longer creates multiple simultaneous connections - now uses a single shared connection
- **Fixed**: Pages no longer crash with 'Failed to fetch' errors when loading before login is complete
- **Improved**: Data loading now waits until your session is verified, preventing errors during app startup
- **Improved**: Background syncing is more reliable and won't attempt updates before you're logged in

## [6.3.5] - 2026-02-02

### Private Events Display Fix
- **Fixed**: Private events on Updates page now show properly formatted titles instead of raw values like 'private_event'
- **Fixed**: Affected areas now display correctly (e.g., 'Bay 1, Bay 2') instead of showing raw JSON array format
- **Improved**: Snake_case notice titles are now automatically converted to Title Case for better readability

## [6.3.4] - 2026-02-01

### Directory Deletion Now Updates Immediately
- **Fixed**: Deleting a member or visitor from the directory now immediately refreshes the list
- **Fixed**: Previously, deleted members would still appear until page refresh - now they disappear right away

## [6.3.3] - 2026-02-01

### Member Profile Drawer UX Improvements
- **Fixed**: Billing tab now scrolls fully to bottom - added extra padding so all content is accessible
- **Improved**: Activity tab filters are now responsive - shows icons only on mobile, icons + text on larger screens
- **Improved**: Filter buttons have better touch targets and spacing on mobile devices

## [6.3.2] - 2026-02-01

### Billing Emails Now Handled by Stripe
- **Changed**: All billing-related emails (payment failures, renewal notices, grace period reminders) are now handled by Stripe instead of Resend
- **Changed**: Resend is now only used for login codes (OTP), welcome emails, and staff notifications
- **Fixed**: Development environment email guard added to prevent accidental emails to members
- **Technical**: Added BILLING_EMAILS_DISABLED flag to membershipEmails.ts and paymentEmails.ts

## [6.3.1] - 2026-02-01

### Resend Email Webhook Integration
- **New**: Resend webhook endpoint at /api/webhooks/resend for real-time email event tracking
- **New**: Automatic bounce detection - member accounts are flagged when their emails bounce
- **New**: Spam complaint handling - members who mark emails as spam are automatically unsubscribed from marketing
- **New**: Email delivery events are logged for debugging and analytics
- **Technical**: Added email_events table to track all email delivery status changes

## [6.3.0] - 2026-02-01

### System Health Monitoring & Error Resilience
- **New**: System Health dashboard in Data Integrity page shows live status of all external services (Database, Stripe, HubSpot, Resend, Google Calendar)
- **New**: Each service displays connection status, response latency, and error details when issues occur
- **New**: Color-coded health indicators (green/yellow/red) for quick status assessment
- **New**: FeatureErrorBoundary component allows individual page sections to fail gracefully without crashing the entire page
- **Improved**: API errors now include request IDs for easier debugging and support
- **Improved**: Retry logic with exponential backoff added for HubSpot, Stripe, and database operations
- **Technical**: Added comprehensive health check API endpoint with parallel service verification
- **Technical**: Cleaned up unused date utility functions and dashboard imports

## [6.2.3] - 2026-02-01

### Directory Page Scroll Improvements
- **Improved**: Active and Former member tabs now use full-page scrolling instead of a contained scroll area
- **Improved**: The entire page scrolls naturally based on the number of members displayed

## [6.2.2] - 2026-02-01

### Navigation Bug Fix
- **Fixed**: Critical navigation issue where clicking sidebar buttons on the Financials page would change the URL but not update the page content
- **Fixed**: Resolved infinite render loop in member search component that was blocking page updates
- **Improved**: Member search now correctly handles filter changes without causing performance issues

## [6.2.1] - 2026-02-01

### Bug Fixes for New User Drawer
- **Fixed**: Membership tier dropdown now correctly shows subscription products from Stripe
- **Fixed**: Day pass product selection now updates the amount to charge when a product is selected
- **Fixed**: Day pass payment now works correctly with the selected product
- **Improved**: Staff navigation sidebar now always stays above page content

## [6.2.0] - 2026-02-01

### New User Drawer: Unified Member & Visitor Creation
- **New**: Staff can now add both members and day pass visitors from a single, unified drawer interface
- **New**: Member creation includes tier selection, family groups with automatic discount calculation, and optional discount codes
- **New**: Member payment supports immediate card charging or sending an activation link via email
- **New**: Day pass visitor creation with integrated Stripe payment and automatic visitor record creation
- **New**: 'Book Now' handoff - after creating a visitor, staff can immediately book a session with one click
- **Improved**: Day passes are now properly tracked and redeemed when used for bookings
- **Improved**: Replaced scattered modals with consistent right-side drawer experience
- **Technical**: Added staff checkout endpoints for day pass purchases with transactional safety

## [6.1.4] - 2026-02-01

### Comprehensive Error Handling Improvements
- **Improved**: All billing operations now show clear, actionable error messages (session expired, too many requests, server issues, network problems)
- **Improved**: Check-in flow shows helpful error guidance instead of generic 'Failed' messages
- **Improved**: Booking player management has consistent error messaging across all operations
- **Improved**: Event management and class scheduling show specific error context
- **Improved**: Group billing, tier changes, and member creation all use standardized error handling
- **Technical**: Added shared error handling utility for consistent user experience across the app

## [6.1.3] - 2026-02-01

### Stability Improvements
- **Fixed**: Rate limiting no longer incorrectly blocks page navigation
- **Fixed**: Directory page virtualization disabled to prevent React Query compatibility errors
- **Improved**: Facility Blocks page shows specific error messages (session expired, server error, network issues)
- **Improved**: Facility Blocks page includes 'Try Again' and 'Clear Cache & Reload' recovery buttons when errors occur

## [6.1.2] - 2026-02-01

### Bug Fixes
- **Fixed**: Calendar closures now load correctly on booking pages (was showing 404 error)
- **Fixed**: Trackman imports no longer create fake placeholder email addresses for unmatched bookings

## [6.1.1] - 2026-02-01

### Member Profile Drawer Polish
- **Style**: Member profile drawer now matches the elegant public menu style
- **Style**: Drawer background extends beyond the screen edge for a premium feel
- **Style**: Added curved corner on the top-left for softer appearance
- **Animation**: Close button now rotates 90 degrees on hover for visual feedback

## [6.1.0] - 2026-02-01

### Smart Data Caching: Faster Navigation & Reduced Loading
- **Speed**: Pages no longer reload from scratch when navigating - data stays cached and appears instantly
- **Speed**: Reduced server requests by 60-80% through intelligent caching and stale-while-revalidate
- **Speed**: Navigation between staff portal pages is now near-instant
- **Stability**: Scroll position is preserved when taking actions (approve, check-in, assign, etc.)
- **Stability**: No more page flickering or data disappearing during actions
- Real-time: Booking updates from other staff members appear automatically without manual refresh
- Real-time: WebSocket events now sync cached data across all open pages
- Staff Portal: All 12 admin tabs now use smart caching (Bookings, Financials, Directory, Events, Settings, Trackman, Data Integrity, Tiers, Team, Tours, Cafe, Facility Notices)
- Member Pages: Dashboard, Book Golf, Events, Profile, and History pages all use smart caching
- **Technical**: Migrated to React Query for enterprise-grade data management

## [6.0.5] - 2026-02-01

### Financials Page Navigation Fix
- **Fixed**: Navigating away from Financials page now works correctly even if data is still loading
- **Fixed**: All async data fetches in Financials tab now properly cancel when navigating away
- **Improved**: Navigation between staff portal pages is now more responsive

## [6.0.4] - 2026-02-01

### Staff Navigation Fix
- **Fixed**: Rapid navigation between staff portal pages now works correctly
- **Fixed**: Clicking a new page before the current one finishes loading no longer causes the page to get stuck

## [6.0.3] - 2026-02-01

### iOS Safari Translucent Toolbar
- iOS Safari: Removed theme-color meta tag to enable translucent bottom toolbar (frosted glass effect)
- iOS Safari: Green header now extends behind the status bar at top of screen
- iOS Safari: Added bottom padding so page content scrolls behind frosted toolbar
- **PWA**: No changes - installed app continues to show solid green status bar via manifest

## [6.0.2] - 2026-01-31

### URL Routing Cleanup
- **Fixed**: All backend notification URLs now use correct BrowserRouter paths (removed hash router pattern)
- **Fixed**: Push notifications for bookings, wellness, events, and tours now link correctly
- **Fixed**: Stripe redirect URLs (billing portal, checkout, day passes) now use proper routes
- **Fixed**: Staff command center WebSocket status indicator now shows 'Live' correctly
- **Fixed**: Staff notification click-throughs now navigate to correct admin pages

## [6.0.1] - 2026-01-31

### Staff FAB Quick Actions Stay In-Place
- **Fixed**: New Announcement and New Notice quick actions now open drawers directly on the command console instead of navigating away
- **Improved**: Quick actions are faster with simpler forms - just title, description, and notification toggle
- **Note**: For advanced notice options (booking blocks, affected areas), use the full Facility Notices page

## [6.0.0] - 2026-01-31

### Major UX Overhaul: Mobile-First Navigation & Drawers
- **Routing**: Admin navigation now uses proper URL routes (/admin/bookings, /admin/directory, etc.) instead of query params
- **Routing**: Legacy ?tab= URLs automatically redirect to new routes for backward compatibility
- Staff FAB: Quick actions menu now uses slide-up drawer with 5 quick actions: New User, Announcement, Notice, Manual Booking, QR Scanner
- **Modals**: Converted 19+ modals to slide-up drawers with drag-to-dismiss gesture support
- **Modals**: Payment modals (Balance, Invoice, Member Payment, Guest Pass) now use mobile-friendly drawers
- **Modals**: Guest entry, player management, and form modals (HubSpot, Event Inquiry) now use drawers
- **Modals**: All admin modals (Notice, Event, Wellness, Announcement) now use drawers
- **Tables**: Trackman and Financials tables now show as cards on mobile, tables on desktop
- Inline Edits: TiersTab and BlocksTab inline editing now uses slide-up drawers for better mobile UX
- **Branding**: Renamed 'CLASS' to 'WELLNESS' throughout the app for accuracy
- **SEO**: Added sitemap.xml, robots.txt, and meta tags for public pages
- **UX**: Created ConfirmDialog component with Liquid Glass styling, replacing all browser confirm dialogs

## [5.9.3] - 2026-01-31

### SimulatorTab Cleanup
- **Cleanup**: Removed redundant Re-scan, Auto-Match, and Notes buttons from Simulator admin
- **Improved**: Cleaner toolbar with only essential actions

## [5.9.2] - 2026-01-31

### Trackman Admin Cleanup & Mobile UX
- **Cleanup**: Removed Matched Bookings section from Trackman admin (555 lines of code removed)
- **Cleanup**: Removed Potential Matches section - matching was often inaccurate
- **Cleanup**: Removed Re-scan button - redundant with calendar sync
- **Improved**: Create Manual Booking now uses slide-up drawer with sticky action button
- **Improved**: Trackman admin page is now significantly simpler and faster to load

## [5.9.1] - 2026-01-31

### Mobile UX: Slide-Up Drawers
- **Added**: SlideUpDrawer component - new mobile-optimized drawer with drag-to-dismiss gesture support
- **Improved**: Check-in billing modal now slides up from bottom on mobile with swipe-to-dismiss
- **Improved**: Trackman link modal now slides up from bottom on mobile with swipe-to-dismiss
- **Improved**: Complete roster modal now slides up from bottom on mobile with swipe-to-dismiss
- **Improved**: Waiver signing modal now slides up from bottom on mobile with swipe-to-dismiss
- **Improved**: All converted modals have sticky action buttons at the bottom for easier one-handed use
- **Improved**: iOS safe area handling prevents content from being hidden behind device notches/home bars

## [5.9.0] - 2026-01-31

### Staff Management & Private Event Linking
- **Added**: 'Assign to Staff' button in Trackman modal - quickly assign bookings to staff/instructors without creating visitor records
- **Added**: 'Team' tab in Directory page - view all staff with role badges (Instructor/Admin/Staff) and booking history
- **Added**: 'Link to Existing Notice' feature - when marking a booking as private event, choose to link to an existing calendar notice instead of creating duplicates
- **Added**: 'Generate Trackman Notes' tool - search members and copy formatted notes (M|email|first|last) for manual Trackman bookings
- **Improved**: Staff search now includes all staff_users records, not just those with specific users.role values
- **Improved**: Booking assignment validates archived members - prevents assigning to archived accounts
- **Improved**: Empty email handling - unmatched booking queries now check for both NULL and empty strings
- **Fixed**: Golf instructors no longer show as 'Visitor' in search results
- **Fixed**: 9 staff accounts corrected from non-member to proper staff status (Tim, Laily, Ryan, Mara, Adam, Nick, Sam, Alyssa, Members)
- **Fixed**: Team management page now restricted to admin-only access
- **Cleanup**: Removed duplicate unmatch button from booking details modal
- **Cleanup**: Deleted 25 incorrect 'Lesson: Tim Silverman' facility closure notices
- **Technical**: Added closure_id foreign key to booking_requests for notice linking

## [5.8.0] - 2026-01-31

### Eliminate Placeholder Email Generation
- **Refactored**: Trackman imports no longer create placeholder emails for unmatched bookings
- **Refactored**: Unmatched bookings now use null user_email instead of fake generated emails
- **Improved**: Auto-match system only links to existing real visitors, never creates fake ones
- **Improved**: Booking slots still block availability correctly without requiring a fake user
- **Added**: HubSpot sync now rejects placeholder emails to prevent contact pollution
- **Fixed**: TrackmanLinkModal hides placeholder emails, shows 'Unassigned' status cleanly
- **Fixed**: Staff 'unmatch booking' action now uses null email instead of generating placeholder
- **Fixed**: Unmatched booking queries updated to find both null emails and legacy placeholders
- **Cleanup**: Deleted 73 existing placeholder Stripe customers
- **Cleanup**: Archived 73 placeholder user records in database
- **Technical**: All booking detection logic updated to treat null/empty email as unmatched

## [5.7.10] - 2026-01-31

### Placeholder Account Cleanup Tool
- **Added**: New 'Placeholder Account Cleanup' section on Data Integrity page
- **Added**: Scan for placeholder emails in Stripe customers and HubSpot contacts
- **Added**: Bulk delete placeholder accounts with one click (golfnow-*, unmatched-*, @visitors.evenhouse.club, etc.)
- **Added**: Preview list shows all accounts before deletion with confirmation dialog
- **Fixed**: Placeholder emails are now blocked from creating Stripe customers across all payment flows
- **Technical**: Added safeguards to prevent fake/system emails from creating billing records

## [5.7.9] - 2026-01-30

### Auto-Cleanup Stale Billing Participants
- **Fixed**: Check-In & Billing modal now auto-cleans orphaned players when opened
- **Fixed**: Players removed from roster before the bug fix will now be properly removed from billing
- **Improved**: Fees recalculate automatically after stale participant cleanup

## [5.7.8] - 2026-01-30

### Bug Report Button Moved to Menu
- **Moved**: Report a Bug button relocated from Profile page to hamburger menu
- **Improved**: Bug reports can now be submitted from any page - just open the menu
- **Added**: Bug report button in Staff Portal sidebar for easy access

## [5.7.7] - 2026-01-30

### Fix Player Removal Not Updating Billing
- **Fixed**: Removing a player from a booking now properly deletes them from the billing participants list
- **Fixed**: Fee calculations update correctly after removing a player from the roster
- **Fixed**: Check-In & Billing modal now shows accurate player list after roster changes
- **Technical**: Unlink endpoint was comparing email to UUID column - now properly looks up user ID first

## [5.7.6] - 2026-01-30

### UI Polish - Smoother Animations & Visual Feedback
- **Added**: Sidebar sliding indicator animation that smoothly transitions between selected items (matching bottom nav style)
- **Improved**: Booking cards have smoother hover transitions with subtle scale and shadow depth effects
- **Improved**: Time slot grid now has visual separation between columns and alternating hour backgrounds for better readability
- **Improved**: All action buttons (Assign Member, Check In, etc.) now have smooth press feedback with active:scale-95
- **Improved**: Grid cells have faster transition animations (150ms) for more responsive feel
- **Improved**: Header rows in booking grid have subtle shadows for visual depth

## [5.7.5] - 2026-01-30

### Remove Duplicate Requires Review Section
- **Removed**: Duplicate 'Requires Review' section from Trackman page
- **Improved**: Unmatched Bookings section now handles all review cases including private events

## [5.7.4] - 2026-01-30

### Optimistic UI for Data Integrity Fixes
- **Improved**: Issue counts now update immediately when fixes are applied (no waiting for refresh)
- **Improved**: Total issues counter updates in real-time as fixes complete
- **Improved**: Check status changes to 'pass' when all issues are resolved

## [5.7.3] - 2026-01-30

### Clear Orphaned Stripe IDs Tool
- **Added**: 'Clear Orphaned IDs' button in Data Integrity to remove Stripe customer IDs that no longer exist in Stripe
- **Added**: Preview mode shows which orphaned IDs would be cleared before executing
- **Improved**: After clearing orphaned IDs, the Data Integrity page automatically refreshes

## [5.7.2] - 2026-01-30

### Prevent Placeholder Stripe Customers
- **Fixed**: Stripe customers are no longer created for placeholder visitor emails (GolfNow, ClassPass, anonymous imports)
- **Fixed**: Placeholder emails like 'golfnow-YYYYMMDD-HHMM@visitors.evenhouse.club' are now excluded from Stripe
- **Improved**: This prevents orphaned Stripe customers from being created for temporary booking placeholders

## [5.7.1] - 2026-01-30

### Orphaned Stripe Customer Detection
- **Improved**: Data integrity now properly identifies orphaned Stripe customers (IDs in database that no longer exist in Stripe)
- **Improved**: Cleaner error messages for orphaned customers instead of scary stack traces
- **Fixed**: Stripe subscription sync check now categorizes 'customer not found' as a data quality issue

## [5.7.0] - 2026-01-30

### Stripe Customer Email Linking
- **New**: Stripe customers are now tied to member emails including linked emails
- **New**: When creating a Stripe customer, system checks all linked emails to prevent duplicates
- **New**: Data integrity check 'Duplicate Stripe Customers' detects members sharing the same email with different Stripe customers
- **Improved**: Stripe customer metadata now includes primary email and linked emails for better tracking
- **Improved**: Fails fast on Stripe network/rate limit errors to prevent accidental duplicate creation
- **Improved**: Deterministic customer selection - prefers primary email match, then most recent

## [5.6.4] - 2026-01-30

### Stripe Error Handling Improvements
- **Fixed**: Stripe subscription lookups now gracefully handle customers that no longer exist in Stripe
- **Improved**: API returns proper 404 status when a Stripe customer is not found instead of 500 error
- **Improved**: Better error messages distinguish between 'customer not found' and other Stripe errors

## [5.6.3] - 2026-01-30

### Fix Tool Endpoint Corrections
- **Fixed**: 'Create Sessions' button now uses correct backfill endpoint to actually create billing sessions
- **Fixed**: Preview for Active Bookings now correctly shows how many will be fixed

## [5.6.2] - 2026-01-30

### Data Integrity Fix Tools
- **New**: Deal Stage Drift check now has 'Remediate Deal Stages' fix tool
- **New**: Active Bookings Without Sessions check shows 'Create Sessions' fix tool
- **Improved**: All fix tools appear directly above the issues list when clicking a check
- **Improved**: Check Results section now appears before Data Tools section for easier access

## [5.6.1] - 2026-01-30

### Data Integrity UX Improvements
- **Improved**: Preview buttons now clearly show 'Preview complete - no changes made' toast
- **Improved**: Fix tools now appear directly on each integrity check instead of separate section
- **Improved**: Preview results show blue styling vs green for executed actions
- **Improved**: Each result explicitly shows 'Preview Only - No Changes Made' label
- **Fixed**: Ghost booking preview now correctly shows total found instead of undefined
- **Fixed**: Fix tools now properly appear for Stripe Subscription Sync and Tier Reconciliation checks

## [5.6.0] - 2026-01-30

### Dynamic Tier Features Comparison System
- **New**: Flexible tier feature management - add, rename, or remove features that appear in membership comparison
- **New**: Features support different value types (yes/no checkmarks, numbers, text) for accurate display
- **New**: Admin can now edit feature labels inline and reorder features
- **New**: Public membership comparison table is now fully database-driven
- **Improved**: Features are automatically created for all tiers when added
- **Improved**: Admin tier editor has cleaner UI with dedicated feature management section

## [5.5.1] - 2026-01-30

### Webhook Security Hardening
- **Fixed**: Failed membership payments now immediately set status to 'past due' (prevents continued booking access)
- **Fixed**: Cancelled/terminated members can no longer be accidentally reactivated by delayed Stripe webhooks
- **Fixed**: Payment failure handler now only processes once per member (prevents duplicate notifications)
- **Improved**: Staff booking modal now validates duration range (30-240 minutes)

## [5.5.0] - 2026-01-30

### Infrastructure Reliability & Data Protection Audit
- **Fixed**: Cancelled membership webhooks can no longer accidentally reactivate cancelled users (subscription event ordering)
- **Fixed**: Guest pass deductions are now atomic - prevents double-charging on simultaneous bookings
- **Fixed**: Trackman import cancellations now validate date ranges to prevent accidental data loss
- **Fixed**: User merge now checks for active sessions before proceeding (prevents mid-session data corruption)
- **Fixed**: Webhook duplicate processing prevented with idempotency guard (new trackman_webhook_dedup table)
- **Fixed**: Visitor email collisions prevented with random suffix generation
- **Fixed**: Member search now excludes auto-generated visitors (directory_hidden users)
- **Fixed**: Webhook time matching tolerance reduced from 30 to 10 minutes for more accurate booking links
- **Fixed**: Guest pass reset scheduler now uses slot claiming to prevent double runs on restarts
- **Improved**: Stripe reconciliation failures now alert staff (no silent failures)
- **Improved**: HubSpot queue dead jobs now notify staff for manual intervention
- **Improved**: HubSpot queue recovers jobs stuck in 'processing' state after server crashes
- **Improved**: User merge now properly updates guest 'created_by' references

## [5.4.1] - 2026-01-29

### Zombie User Fix & Lesson Cleanup Tool
- **Fixed**: Auto-matching no longer links new bookings to archived/merged user profiles
- **Fixed**: ClassPass bookings now get proper fallback handling (same as GolfNow)
- **New**: Lesson cleanup tool to retroactively convert historical lesson bookings to availability blocks
- **New**: Staff Manual Booking modal now has 'Lesson / Staff Block' tab with streamlined workflow
- **Improved**: Lesson cleanup tool validates bay numbers and prevents duplicate block creation

## [5.4.0] - 2026-01-29

### Comprehensive System Reliability Improvements
- **Fixed**: Database constraint errors now return proper error messages instead of crashing
- **Fixed**: Booking conflicts during busy periods now handled gracefully with retry guidance
- **Fixed**: Payment processing now uses unique identifiers to prevent duplicate charges
- **Fixed**: Stripe payment failures now trigger staff alerts for immediate visibility
- **Fixed**: Email matching is now consistent across login, member lookup, and tier checks
- **Fixed**: Usage tracking now prevents duplicate entries even if recorded multiple times
- **Improved**: Database connection pool increased from 8 to 20 for better handling of busy periods
- **Improved**: Error logging now includes detailed database information for faster debugging
- **Improved**: All payment operations alert staff if they fail (no more silent failures)
- **Improved**: Member access no longer blocked due to minor email formatting differences

## [5.3.15] - 2026-01-29

### Staff Lesson Auto-Conversion
- **New**: Trackman imports now auto-detect lesson bookings and convert them to availability blocks
- **New**: Staff emails (tim@, rebecca@evenhouse.club) are automatically recognized as instructors
- **New**: 'Lesson' keywords in booking notes trigger automatic block conversion
- **New**: Admin cleanup tool to retroactively convert historical lesson bookings to blocks
- **Improved**: Lessons no longer appear in member booking history or financial reports
- **Improved**: Clean separation between member bookings and staff-led instruction time

## [5.3.14] - 2026-01-29

### Critical Bug Fixes - Data Integrity & User Management
- **Fixed**: CSV imports no longer wipe out future bookings - cancellations now scoped to the date range in the uploaded file
- **Fixed**: Merging user profiles now properly transfers Stripe and HubSpot IDs from secondary to primary account
- **Fixed**: Archived/merged users no longer appear in member searches or auto-matching systems
- **Fixed**: Trackman bookings that conflict with private events now go to pending status for staff review
- **Fixed**: Day pass purchases now correctly match to walk-in bookings with proper redemption tracking
- **Fixed**: Merged user emails are now released for re-registration instead of blocking future signups
- **Improved**: Day pass matching only triggers for explicit day-pass bookings to prevent false matches
- **Improved**: Audit trail for day pass redemptions with trackman booking ID linkage

## [5.3.13] - 2026-01-29

### Simplified Safari Toolbar Colors
- **Simplified**: All public pages now use light bone toolbar color (#F2F2EC)
- **Simplified**: Member/staff portal toolbar matches device theme (dark/light)
- **Removed**: Complex scroll-based toolbar color detection on landing page

## [5.3.12] - 2026-01-29

### Safari Toolbar Color Enhancement
- **Improved**: Added fixed element extending into safe area for better Safari color detection
- **Improved**: Multiple theme-color meta tags with light/dark mode media queries
- **Fixed**: Safari bottom toolbar should now properly detect page background color
- **Fixed**: Public pages, member portal, and staff portal all use correct toolbar colors

## [5.3.11] - 2026-01-29

### Safari Translucent Toolbar Fix
- **Fixed**: Safari bottom toolbar now shows proper translucent effect with correct tint
- **Fixed**: Public pages use light theme color for Safari toolbar
- **Fixed**: Member/staff dark mode pages use dark theme color for Safari toolbar
- **Fixed**: Initial page load now sets correct Safari theme immediately
- **Improved**: CSS-based backgrounds for better Safari translucency support

## [5.3.10] - 2026-01-29

### Safari Browser Theme Improvements
- **Improved**: Safari toolbar now matches page background colors correctly
- **Fixed**: Landing page toolbar transitions from dark hero to light content when scrolling
- **Fixed**: Member and staff pages in dark mode now show proper dark toolbar color
- **Fixed**: Removed conflicting theme-color logic for consistent Safari experience

## [5.3.9] - 2026-01-29

### Smart Queue Resolution
- **Improved**: ClassPass and GolfNow bookings now auto-create visitor records instead of staying in queue
- **Improved**: Birthday parties, events, and group bookings automatically resolve as private events
- **Improved**: Auto-matching now handles walk-ins, lessons, and anonymous bookings more intelligently
- **Reduced**: Trackman queue clutter with smarter auto-resolution of common booking types

## [5.3.8] - 2026-01-29

### Tag Display Crash Fix
- **Fixed**: Member profile drawer, Dashboard, and Profile pages no longer crash when viewing merged members
- **Fixed**: View As mode now works correctly for all members
- **Fixed**: Tag display across all member views now properly filters merge records

## [5.3.7] - 2026-01-29

### Private Event from Unmatched Bookings
- **Fixed**: Can now mark unmatched Trackman bookings as private events directly
- **Fixed**: 'Booking not found' error when converting Trackman imports that are still in review queue
- **Improved**: Private events created from unmatched bookings automatically resolve those entries

## [5.3.6] - 2026-01-29

### Staff Portal Directory Fix
- **Fixed**: Directory tab in Staff Portal now loads correctly
- **Fixed**: Member merge records no longer cause display errors in tag filters
- **Technical**: Added filtering for non-string entries in member tags array

## [5.3.5] - 2026-01-29

### Private Event Toast Fix
- **Fixed**: Marking booking as private event no longer shows duplicate toast notifications
- **Fixed**: 'Trackman booking linked to member' toast no longer appears when marking as private event

## [5.3.4] - 2026-01-29

### Complete User Merge Coverage
- **New**: Merge now covers ALL 19 user-related data tables
- **New**: Includes booking participants, day passes, legacy purchases
- **New**: Includes group memberships, push subscriptions, dismissed notices
- **New**: Includes billing groups (primary payer transfer)
- **New**: Includes bug reports, data export requests
- **New**: Includes HubSpot deals, Stripe payment intents
- **Improved**: Merge preview shows counts for all data types being transferred

## [5.3.3] - 2026-01-29

### Expanded User Merge Coverage
- **New**: Merge now includes booking participants in multi-member bookings
- **New**: Merge now includes day pass purchases
- **New**: Merge now includes legacy purchases
- **New**: Merge now includes group/corporate memberships
- **New**: Merge now includes push notification subscriptions
- **New**: Merge now includes dismissed notice preferences
- **Improved**: Merge preview shows counts for all 14 data types being transferred

## [5.3.2] - 2026-01-29

### Member Portal Navigation Menu
- **New**: Hamburger menu in member portal header (replaces mascot)
- **New**: Slide-out navigation with all member pages and nested tabs
- **New**: Liquid glass selection effect highlights current page
- **New**: Mascot logo in menu sidebar links back to landing page
- **Improved**: Member navigation matches public pages sidebar design

## [5.3.1] - 2026-01-29

### Complete Duplicate Prevention Coverage
- **New**: Remember Email checkbox in Manage Players modal (admin booking editor)
- **New**: Visitor Type dropdown required in Add User modal (staff command center)
- **New**: Duplicate name warning in Add User modal with clickable options to use existing record
- **Fixed**: Selecting an existing duplicate now properly uses that record instead of creating new one
- **Improved**: All member/visitor creation points now have duplicate prevention

## [5.3.0] - 2026-01-29

### User Merge & Duplicate Prevention
- **New**: Merge Users feature - combine duplicate member/visitor records safely
- **New**: Merge button in member profile opens search and preview modal
- **New**: Preview shows all records that will be transferred (bookings, visits, fees, etc.)
- **New**: Transaction-safe merge consolidates all data and soft-deletes merged account
- **New**: Remember Email checkbox in Assign Players to link alternate emails for future auto-matching
- **New**: Duplicate name warning when creating new visitors shows existing matches
- **New**: Visitor Type is now required when creating new visitors
- **Improved**: Merge actions logged to Staff Activity for audit trail
- **Improved**: Merged users tagged for 30-day recovery if needed

## [5.2.1] - 2026-01-29

### Duplicate Visitor Cleanup & Queue Stats Layout
- **Fixed**: Merged 139 duplicate visitor records (same name, multiple date-based emails)
- **Fixed**: Reassigned 157 bookings from duplicate visitors to primary records
- **Fixed**: Queue stats text (pending, unassigned, need review) now appears below header instead of inline
- **Improved**: Queue header row is cleaner with just title and action buttons

## [5.2.0] - 2026-01-29

### Auto-Match Visitors from MindBody
- **New**: Auto-Match Visitors button in Queue auto-assigns unmatched bookings to visitors
- **New**: Matching uses MindBody purchase history (date + time + purchase type)
- **New**: ClassPass, Day Pass, Private Lesson bookings auto-linked to visitor records
- **New**: After-hours bookings (10 PM - 6 AM) auto-marked as Private Events
- **New**: Unmatched GolfNow bookings create new visitors with GolfNow type
- **New**: All auto-matches logged to Staff Activity for audit trail
- **Improved**: Visitor types now include 'golfnow' and 'private_event'

## [5.1.0] - 2026-01-29

### Unified Queue with Requires Review
- **Added**: 'Requires Review' bookings (partial name matches) now appear in Queue
- **Added**: Orange-styled cards for bookings needing name verification
- **Added**: 'Re-scan for Matches' button in Queue header to retry member matching
- **Added**: Queue now shows 3 item types: pending requests, unassigned bookings, needs review
- **Improved**: All Trackman import management consolidated into Simulator page
- **Fixed**: Legacy review items can be resolved directly from Queue

## [5.0.3] - 2026-01-29

### Queue Shows Booking Details
- **Added**: Queue cards now show original name and email from Trackman import
- **Added**: Assign Player modal now shows Notes from Import with original booking details
- **Fixed**: Queue items now pass all booking details (date, time, notes) to assignment modal
- **Improved**: Staff can see who made the booking at a glance without opening modal

## [5.0.2] - 2026-01-29

### Complete Duplicate Prevention Coverage
- **Fixed**: Legacy booking resolution now handles race conditions with ON CONFLICT
- **Fixed**: Webhook reprocess endpoint now handles concurrent requests safely
- **Fixed**: Member assignment from unmatched bookings handles duplicates gracefully
- **Fixed**: Rescan function uses ON CONFLICT for atomic insert safety
- **Improved**: All 12 booking creation paths now have duplicate prevention

## [5.0.1] - 2026-01-29

### Import Duplicate Prevention & Queue Tab
- **Added**: Unassigned webhook bookings now appear in the Queue tab alongside pending requests
- **Added**: Queue tab shows combined count of pending requests and unassigned bookings
- **Fixed**: CSV import now gracefully handles race conditions with webhooks (duplicate key handling)
- **Improved**: Staff can see chronological view of all items needing attention in one place
- **Improved**: Clicking unassigned booking in queue opens the member assignment modal

## [5.0.0] - 2026-01-29

### TrackMan Import & Email Learning System
- **Added**: Email learning system - when staff links an unmatched booking, system remembers email for future auto-matching
- **Added**: CSV import now backfills webhook-created bookings instead of creating duplicates
- **Added**: Automatic email association learning when import matches unmatched bookings
- **Fixed**: Legacy unmatched bookings table no longer causes skipped imports
- **Fixed**: Auto-resolves legacy entries when booking exists in main system
- **Improved**: TrackMan import loads learned emails from user_linked_emails table
- **Improved**: Staff can choose 'Remember this email' when resolving unmatched bookings

## [4.9.7] - 2026-01-29

### Booking Availability Fix
- **Fixed**: Members not seeing available time slots due to stale/duplicate TrackMan data
- **Fixed**: Resolved 78 duplicate unmatched booking entries that were blocking availability
- **Fixed**: Cleaned up 5 past booking entries from availability checks
- **Improved**: Availability system now correctly shows open slots

## [4.9.6] - 2026-01-29

### UI/UX & Accessibility Improvements
- **Added**: Global keyboard focus indicators for all buttons, links, and inputs (WCAG 2.4.7 compliance)
- **Added**: Darker lavender color variant for better text contrast on light backgrounds
- **Fixed**: Touch targets on icon buttons now meet 44x44px minimum (WCAG accessibility)
- **Fixed**: Missing screen reader labels on 6 icon-only buttons (notes, delete, edit, pin actions)
- **Fixed**: Notices tab header spacing - added breathing room between filters, legend, and sections
- **Fixed**: TrackMan webhook error messages now wrap properly instead of breaking card layouts

## [4.9.5] - 2026-01-29

### Staff Notification Coverage
- **Added**: Staff notifications for all TrackMan unmatched bookings (no customer email, unmapped bay)
- **Added**: Staff notifications when members cancel their subscription
- **Added**: Staff notifications when subscriptions go past due or unpaid/suspended
- **Added**: Staff notifications when member payment cards are expiring soon
- **Added**: Staff notifications when day passes are purchased
- **Fixed**: Added missing notification types to type system (day_pass, trackman_booking, etc.)
- **Improved**: Complete staff visibility into booking and billing events requiring attention

## [4.9.4] - 2026-01-29

### Staff Activity Human-Readable Details
- **Fixed**: Staff Activity now displays human-readable text instead of raw JSON
- **Improved**: Universal field extraction for email, amount, description, counts
- **Fixed**: Record Charge shows email and formatted dollar amount
- **Fixed**: Detect Duplicates shows App and HubSpot counts
- **Fixed**: Fix Ghost Bookings shows number of bookings found

## [4.9.3] - 2026-01-29

### Complete Human-Readable Activity Details
- **Improved**: All Staff Activity cards now show human-readable details instead of raw JSON
- **Added**: Formatting for 40+ action types including Stripe events, invoices, day passes, waivers, and bulk actions
- **Added**: Icons and labels for subscription, invoice, visitor, and TrackMan sync events
- **Added**: Proper detail formatting for member actions, booking status changes, and data migrations

## [4.9.2] - 2026-01-29

### Complete Activity Logging Coverage
- **Added**: Member booking cancellations via resources endpoint now logged to Staff Activity
- **Added**: Wellness class enrollment cancellations now logged to Staff Activity
- **Added**: Event RSVP cancellations now logged to Staff Activity
- **Fixed**: Staff cancellations via booking approval workflow now properly logged
- **Improved**: All member-initiated cancellations show with Member badge in activity feed

## [4.9.1] - 2026-01-29

### Dashboard Today's Bookings Filter
- **Improved**: Staff dashboard now shows only today's bookings instead of all future dates
- **Improved**: Card renamed from 'Upcoming Bookings' to 'Today's Bookings' for clarity
- **Note**: Staff can click 'View all' to see the complete booking list including future dates

## [4.9.0] - 2026-01-29

### Comprehensive Activity Logging & Staff Notifications
- **Added**: Real-time notifications for all booking cancellations (from TrackMan, members, or staff)
- **Added**: System and member action logging to the Staff Activity tab
- **Added**: Actor badges showing who performed each action (Staff/Member/System)
- **Added**: Source filter to view activity by actor type
- **Added**: Human-readable activity descriptions with refund amounts and booking details
- **Added**: Stripe payment event logging (refunds, successful payments, failed payments)
- **Added**: TrackMan webhook cancellation logging with pass refund tracking

## [4.8.1] - 2026-01-28

### Calendar Quick Booking
- **Added**: Click empty calendar cells to open booking form with bay and time pre-filled
- **Improved**: Queue card now matches calendar height with scrollable content
- **Improved**: Floating action button positioned correctly on desktop view

## [4.8.0] - 2026-01-28

### Staff Manual Booking Tool
- **Added**: Staff can now create bookings for members directly from the Bookings page
- **Added**: Floating action button on Bookings page to open the manual booking form
- **Added**: Bay, date, time, duration, and player count selection
- **Added**: Dynamic participant slots with member/guest selection using unified member search
- **Added**: Automatic generation of Trackman notes text with copy button
- **Added**: External Trackman booking ID linking for webhook auto-confirmation
- **Added**: Pending bookings created by staff function identically to member requests

## [4.7.6] - 2026-01-28

### Same-Day Booking Fee Calculation Fix
- **Fixed**: Members with multiple bookings on the same day now correctly use their daily allowance on the earliest booking first
- **Fixed**: Later bookings on the same day now properly calculate overage fees based on remaining allowance
- **Improved**: Fee calculations now use start time ordering to ensure fair allocation of daily included minutes

## [4.7.5] - 2026-01-28

### Member History Bug Fix
- **Fixed**: Member profile drawer now correctly loads booking history, event RSVPs, and wellness enrollments
- **Fixed**: Database query error that prevented staff from viewing member activity in the Directory

## [4.7.4] - 2026-01-28

### Staff PWA Menu Shortcuts
- **Updated**: PWA File menu now shows staff-relevant shortcuts (Dashboard, Bookings, Financials, Directory)
- **Fixed**: Menu shortcuts now link directly to Staff Portal pages

## [4.7.3] - 2026-01-28

### Calendar Refresh Button & Last Updated Time
- **Added**: Sync button now refreshes all calendar data (bookings, requests, closures)
- **Added**: Last updated timestamp shown next to sync button on desktop
- **Improved**: Visual feedback when calendar data is refreshed
- **Improved**: Auto-refresh from webhooks now updates the timestamp

## [4.7.2] - 2026-01-28

### Webhook Booking Link Fix
- **Fixed**: Webhook bookings now appear on calendar after linking to member
- **Fixed**: Linked bookings now show on member dashboard correctly
- **Fixed**: Booking status properly set to approved when staff assigns or changes owner
- **Fixed**: All four member assignment endpoints now correctly approve bookings

## [4.7.1] - 2026-01-28

### Complete Real-Time Billing Notifications
- **Added**: Real-time notification when invoice is created for member
- **Added**: Real-time notification when invoice is finalized and ready for payment
- **Added**: Real-time notification when invoice is voided
- **Added**: Real-time notification when overage payment is confirmed
- **Added**: Real-time notification when subscription is started
- **Added**: Real-time notification when subscription is cancelled
- **Improved**: All billing operations now trigger instant member notifications

## [4.7.0] - 2026-01-28

### Real-Time Notifications for Bookings & Billing
- **Added**: Real-time notification when booking is approved by staff
- **Added**: Real-time notification when booking is declined by staff
- **Added**: Real-time notification when payment is confirmed
- **Added**: Real-time notification when refund is processed
- **Added**: Real-time notification when invoice is paid
- **Fixed**: Book page now refreshes automatically when staff declines a pending booking
- **Improved**: Members receive instant updates for all booking and billing status changes

## [4.6.1] - 2026-01-28

### Wellness Tab Mobile Crash Fix
- **Fixed**: Wellness tab no longer crashes on mobile when viewing classes
- **Fixed**: Classes with missing date information are now handled gracefully

## [4.6.0] - 2026-01-28

### Production Readiness Improvements
- **Added**: Global error handlers to catch and log unexpected crashes gracefully
- **Added**: Clean shutdown system - server closes connections properly on restart
- **Added**: Monitoring and alerting system for payment failures and critical events
- **Added**: Startup health tracking with categorized warnings and critical failures
- **Added**: Enhanced health check endpoint with uptime and alert status for staff
- **Improved**: Server stability with automatic error recovery
- **Improved**: WebSocket connection security with origin validation

## [4.5.3] - 2026-01-28

### Stripe Webhook Fix
- **Fixed**: Add Funds payments now properly credit account balance
- **Fixed**: Removed duplicate Stripe webhook endpoint that was causing signature verification failures
- **Improved**: Stripe webhook reliability - all checkout session events now process correctly

## [4.5.2] - 2026-01-28

### Add Funds Balance Update Fix
- **Fixed**: Account balance now updates in real-time after adding funds via 'Add Funds' button
- **Fixed**: Balance notification now correctly targets the member who added funds
- **Added**: Profile page listens for billing updates to refresh balance automatically

## [4.5.1] - 2026-01-28

### Staff Profile Bottom Navigation Fix
- **Fixed**: Staff portal profile page no longer shows member bottom navigation on mobile
- **Improved**: Staff see clean profile page with 'Return to Staff Portal' button instead of member nav

## [4.5.0] - 2026-01-28

### Real-Time Updates & Optimistic UI
- **Added**: Real-time member profile updates - members see tier and guest pass changes instantly when staff makes edits
- **Added**: Real-time wellness class availability - class spots update live when other members book/cancel
- **Added**: Real-time invoice/payment history - members see payment and refund updates immediately
- **Added**: Real-time guest pass count - remaining passes update instantly when staff redeems a guest
- **Added**: Real-time tour scheduling - staff see tour updates from other staff members immediately
- **Added**: Real-time balance display - member balance updates instantly after payment collection
- **Added**: Optimistic UI for fee collection - 'Paid' status shows immediately while confirming with server
- **Improved**: All real-time updates use rollback on error to maintain data consistency

## [4.4.5] - 2026-01-28

### Subscription Date Display Fix
- **Fixed**: Membership renewal date no longer shows '1969' when subscription data is incomplete
- **Improved**: Invalid or missing renewal dates are now handled gracefully

## [4.4.4] - 2026-01-28

### Failed Payments Cleanup & Cancel Button
- **Added**: Cancel button on failed payments to dismiss them without going to Stripe
- **Fixed**: Already-canceled payments no longer appear in the Failed Payments list
- **Improved**: Failed Payments section now only shows actionable items (not resolved/canceled ones)
- **Added**: Staff activity logging when payments are canceled

## [4.4.3] - 2026-01-28

### Payment Webhook Database Fix
- **Fixed**: Critical bug in payment webhook that prevented payment status from updating correctly
- **Fixed**: Booking participants now properly marked as 'Paid' when Stripe payment succeeds
- **Fixed**: Fee snapshots correctly transition to 'completed' status after payment
- **Improved**: Simplified webhook queries for more reliable payment processing

## [4.4.2] - 2026-01-28

### Payment Status Display Fix
- **Fixed**: Collect Payment button now shows 'Paid' indicator when fees have already been collected
- **Fixed**: Financial summary now correctly excludes already-paid fees from the total
- **Improved**: Booking details accurately reflects payment status from Stripe

## [4.4.1] - 2026-01-28

### Tier Change Payment Fix
- **Fixed**: Tier changes now correctly charge the member's card instead of Stripe balance
- **Fixed**: Immediate tier changes properly use the customer's default payment method for proration invoices
- **Improved**: Payment method lookup tries subscription default, then customer default, then first attached card

## [4.4.0] - 2026-01-28

### Training Guide & Mobile Navigation Update
- **Updated**: Training Guide now reflects current app navigation and mobile hamburger menu
- **Updated**: All training sections updated to reference sidebar and hamburger menu instead of deprecated Employee Resources
- **Improved**: Removed redundant Employee Resources section from mobile dashboard - now accessible via hamburger menu
- **Added**: Hamburger menu on staff portal mobile for quick access to all navigation items
- **Added**: Mobile sidebar mirrors desktop sidebar with Dashboard, Bookings, Financials, Tours, Calendar, Facility, Updates, Directory, Resources, and Admin sections
- **Fixed**: Simulator Overage fee no longer appears on Day Passes purchase page
- **Fixed**: Landing page header now matches green status bar for unified appearance
- **Fixed**: Removed background transition that caused white flash when scrolling
- **Fixed**: Member profile drawer no longer shows gap on right side during slide-in animation

## [4.3.14] - 2026-01-28

### Member Profile Performance Optimization
- **Improved**: Member history loading is now 5-10x faster by batching database queries
- **Improved**: Member details page loads faster with parallel data fetching
- **Fixed**: Eliminated N+1 query pattern that caused slowdowns with large booking histories

## [4.3.13] - 2026-01-28

### Historical Session Backfill
- **Added**: Backfilled 1,089 billing sessions for historical Trackman bookings (June 2025 - January 2026)
- **Fixed**: Historical bookings now visible in member booking history and staff portals
- **Fixed**: All backfilled sessions marked as 'paid' since they occurred in the past
- **Improved**: Data integrity - cleaned up 7 orphan database records

## [4.3.12] - 2026-01-28

### Improved Potential Matches Display
- **Fixed**: Potential Matches section now shows full Trackman booking details (date, time, bay, players)
- **Added**: Clear visual badges show Trackman booking info vs matching app bookings
- **Improved**: Easier to understand why bookings are potential matches

## [4.3.11] - 2026-01-28

### Trackman Auto-Match Badge & Concurrency Guard
- **Added**: Auto-matched webhooks now show blue 'Automated' badge in Trackman synced section
- **Added**: Concurrency guard prevents race conditions when multiple processes try to link same booking
- **Changed**: Badge text updated from 'Auto-Linked' to 'Automated' for clarity

## [4.3.10] - 2026-01-28

### Trackman Webhook Auto-Match Improvements
- **Fixed**: Webhooks now auto-link to existing bookings by matching bay + date + time
- **Fixed**: Webhooks with externalBookingId now check trackman_external_id column for matching
- **Fixed**: 'Book on Trackman' modal now shows bay preference when bay not yet assigned
- **Improved**: Eliminated need for manual 'Auto Match' button in most webhook scenarios

## [4.3.9] - 2026-01-28

### Fix Double Push Notifications for Booking Requests
- **Fixed**: Staff no longer receive duplicate push notifications when members request bookings
- **Fixed**: Removed redundant push notification call that duplicated notifyAllStaff functionality

## [4.3.8] - 2026-01-28

### Coupon Selection for New Subscriptions
- **Added**: Staff can now apply coupons/discounts when creating new subscriptions
- **Added**: Coupon dropdown shows all active Stripe coupons with discount details
- **Added**: Supports percentage off and fixed amount discounts with duration info

## [4.3.7] - 2026-01-28

### Add Billing Source Dropdown & Fix Tier Clearing
- **Added**: Billing Source dropdown now visible when member has no active subscription
- **Added**: Billing Source dropdown visible in wallet-only mode for members billed elsewhere
- **Fixed**: Staff can now set member tier to 'No Tier' (previously rejected by API)
- **Fixed**: Tier clearing properly updates HubSpot and notifies member

## [4.3.6] - 2026-01-28

### Fix Trackman Webhook ON CONFLICT Syntax
- **Fixed**: ON CONFLICT clauses now correctly match partial unique index for booking_requests
- **Fixed**: ON CONFLICT for trackman_bay_slots now uses correct composite key
- **Fixed**: Trackman webhook booking creation/linking now works correctly in production

## [4.3.5] - 2026-01-28

### Atomic Duplicate Prevention for Trackman Webhooks
- **Fixed**: Trackman webhook now uses atomic INSERT ON CONFLICT to prevent duplicate bookings in real-time
- **Fixed**: Race condition eliminated - simultaneous webhooks now create exactly one booking
- **Added**: Unique constraint on Trackman booking ID enforced at database level
- **Added**: Automatic duplicate cleanup runs on server startup and daily at 4am Pacific
- **Added**: Admin endpoints to detect and clean up any legacy duplicates

## [4.3.4] - 2026-01-28

### Billing Security Hardening
- **Fixed**: Payment snapshots now scoped to booking ID, preventing cross-booking payment intent reuse
- **Fixed**: Payment endpoint validates booking status before processing (rejects cancelled/declined bookings)
- **Improved**: Fee display now shows 'Calculating...' indicator when fees are still being computed
- **Added**: Minutes used today and cached fee data now included in check-in context for accurate fee detection

## [4.3.3] - 2026-01-28

### Persistent Sync Timestamp
- Last sync time now persists across server restarts
- Directory page shows accurate 'Last synced' timestamp even after deployments
- Uses existing app_settings table for reliable storage

## [4.3.2] - 2026-01-28

### Background Sync Optimization
- Moved HubSpot member sync from every 5 minutes to once daily at 3am Pacific
- Prevents database connection pool exhaustion during peak hours
- Manual sync button still works instantly for on-demand syncing
- Added 'Last synced' timestamp next to the Sync button on Directory page
- Webhooks continue to handle real-time status/tier updates from HubSpot

## [4.3.1] - 2026-01-28

### Roster Placeholder Guest Replacement
- **Fixed**: Adding members to a booking now replaces placeholder guests (Guest 2, Guest 3, etc.)
- Previously, adding a named member would keep placeholder guests, causing inflated participant counts
- Members added to roster now automatically replace any 'Guest X' placeholders

## [4.3.0] - 2026-01-28

### HubSpot Billing Provider Sync
- **New**: billing_provider property syncs to HubSpot (Stripe/MindBody/Manual)
- **New**: membership_status now includes Trialing and Past Due options in HubSpot
- **New**: Centralized syncMemberToHubSpot function for consistent data sync
- **New**: Backfill endpoint to sync all existing contacts with billing data
- Stripe subscription webhooks now sync status, tier, and billing provider to HubSpot instantly
- Tier upgrades/downgrades now sync to HubSpot
- Subscription cancellations now sync cancelled status to HubSpot
- Manual billing provider changes by staff now sync to HubSpot
- Past due and suspended statuses now sync to HubSpot

## [4.2.2] - 2026-01-28

### Final Status Check Sweep
- Fixed push-db-tiers endpoint only syncing 'active' members to HubSpot
- Fixed billing classification script missing trialing/past_due members
- Fixed member search API missing trialing/past_due in all filter branches
- 25+ total status-related fixes across 13 files

## [4.2.1] - 2026-01-28

### HubSpot Webhook Instant Status Updates
- HubSpot webhook now instantly updates database when membership_status changes
- HubSpot webhook now instantly updates database when membership_tier changes
- MindBody billing status changes are now reflected immediately (was 5-minute delay)
- Members who pay through MindBody now get instant access updates

## [4.2.0] - 2026-01-28

### Deep Sweep - All Status Checks Fixed
- **CRITICAL**: Fixed staff billing member search only showing 'active' members (payments.ts)
- **CRITICAL**: Fixed waiver affected count only counting 'active' members
- **CRITICAL**: Fixed HubSpot deals analytics undercounting active members
- **CRITICAL**: Fixed member billing subscription fetch missing past_due subscriptions
- **CRITICAL**: Fixed Stripe reconciliation only checking 'active' subscriptions
- **CRITICAL**: Fixed Stripe subscription sync only fetching 'active' subscriptions
- All Stripe sync operations now include active, trialing, and past_due subscriptions
- Fixed member directory SQL filter including trialing/past_due in active members
- Fixed 'former members' filter no longer incorrectly including past_due members
- 22 total status-related fixes across 11 files

## [4.1.0] - 2026-01-27

### Comprehensive Status Fix - All Endpoints & UI
- **CRITICAL**: Fixed login flow blocking members with trialing/past_due status from logging in (3 auth paths)
- **CRITICAL**: Fixed HubSpot endpoints only recognizing 'active' status
- **CRITICAL**: Fixed Trackman webhook cancellations missing fee cleanup
- **CRITICAL**: Fixed individual booking payment endpoint hiding valid fees
- Fixed MemberProfileDrawer showing reactivation button for past_due members (they still have access)
- All cancellation paths now properly clear pending fees
- Added Bug Prevention Guidelines to project documentation

## [4.0.10] - 2026-01-27

### Critical Pacific Timezone Fix
- **CRITICAL**: Fixed all date comparisons to use Pacific time instead of UTC - bookings from today no longer incorrectly show as 'past' during evening hours
- Fixed 50 SQL queries across 8 files that were using server UTC time instead of club Pacific time
- Affects member profile, booking history, visit counts, last activity dates, and all date-sensitive features
- Evening users (5 PM - midnight Pacific) will now see correct 'today' vs 'past' booking status

## [4.0.9] - 2026-01-27

### Balance Display Fix - Show All Pending Fees
- **CRITICAL**: Fixed member balance hiding valid fees when fee snapshots were cancelled/paid
- Balance now correctly shows ALL pending fees (overage + guest fees) regardless of snapshot history
- Removed faulty filtering logic that was incorrectly treating fees as 'orphaned' when snapshots existed
- Cleaned up duplicate pending fee snapshots from database
- Fixed $175 in fees only showing as $50 due to incorrect snapshot filtering

## [4.0.8] - 2026-01-27

### Payment Modal Fix - Use Existing Payment Intent
- Fixed 'Failed to create payment' error - payment modals now correctly use the existing payment intent created by the API instead of trying to create a duplicate
- Added StripePaymentWithSecret component to accept pre-created payment intents for unified billing flow

## [4.0.7] - 2026-01-27

### Payment Modal Fix & Activity Tab
- Fixed 'Failed to create payment' error in both Pay Outstanding Balance and Pay Booking Fees modals
- Added Activity tab to member Updates page as the first/default tab - members can now view their notifications including booking confirmations, check-ins, and payment updates
- Activity tab shows unread count badge when there are unread notifications
- Added 'Mark all as read' button for quick notification management
- Notification icons and colors match notification type (booking, payment, check-in, etc.)
- Clicking a notification marks it as read and navigates to relevant booking if applicable

## [4.0.6] - 2026-01-28

### Member Balance & Payment Flow Fixes
- **CRITICAL**: Fixed member balance showing cancelled/orphaned fees from database instead of actual pending charges
- Balance calculation now checks Stripe fee snapshot status - only includes fees with 'pending' snapshots
- Fees from sessions with cancelled/paid/failed Stripe payment intents are now correctly excluded
- Fixed 'Pay Outstanding Balance' failing to create payment - now properly filters orphaned fees before creating Stripe payment intent
- Fixed individual booking payment to handle overage fees (was only looking for guest fees, causing 'No unpaid guest fees found' error)
- Renamed 'Pay Guest Fees' modal to 'Pay Booking Fees' to accurately reflect all fee types
- Ensures Stripe is the source of truth for billing - database cached fees are filtered by snapshot validity
- Added HubSpot sync when existing users purchase Stripe subscriptions (was only working for new users)

## [4.0.5] - 2026-01-27

### Trackman Webhook Count Display
- Webhook events section now always shows total count (e.g. '4 webhooks received') even when there's only one page
- Pagination controls (Previous/Next) still only appear when there are multiple pages of results

## [4.0.4] - 2026-01-27

### Simulator Tab Full Height Layout
- Removed internal scrolling from the Simulator tab queue and calendar panels
- Both the pending/scheduled queue and the day calendar now expand to their full content height
- Page now scrolls naturally as a whole, making it easier to access all bookings including Trackman synced cards at the bottom
- Fixed awkward scroll behavior where mouse had to be positioned outside card boundaries to scroll the page

## [4.0.3] - 2026-01-27

### Check-In Fee Detection Fix
- **CRITICAL**: Fixed check-in not detecting unpaid fees - was reading from legacy usage_ledger table instead of unified fee data
- **Fixed**: Check-in endpoint now reads fees from booking_participants.cached_fee_cents (the authoritative source)
- **Fixed**: Removed duplicate legacy overage check that was querying deprecated booking_requests.overage_fee_cents column
- Consolidated to single unified payment check that correctly filters by payment_status = 'pending'
- This ensures 'Charge $XX' button appears when members have unpaid fees, preventing uncollected overage charges

## [4.0.2] - 2026-01-27

### Fee Estimate Display Fix & Responsive Layout
- **CRITICAL**: Fixed fee estimate showing $0 for all bookings - was caused by incorrect database query (referencing non-existent column)
- **Fixed**: Session participant query now correctly joins booking_requests to booking_sessions
- **Fixed**: Fee snapshot reconciliation scheduler error (was referencing non-existent column)
- **Improved**: Estimated fees card now flexes to screen size on mobile, tablet, and desktop
- **Verified**: Fee calculation works correctly for all tiers (VIP, Social, Core, Premium, Corporate)

## [4.0.1] - 2026-01-27

### Fee Calculation Bug Fixes
- **CRITICAL**: Preview mode now counts ALL bookings where member is a participant (owned, booking_members, or booking_participants)
- **CRITICAL**: This prevents surprise overage charges at check-in when member was on another booking earlier that day
- **Fixed**: Preview usage now correctly calculates per-participant minutes (duration / player_count)
- **Fixed**: Double-counting prevented when member is both owner and participant by deduplicating on booking_id
- **Fixed**: Guest fee logic now consistent between feeCalculator and unifiedFeeService
- **Fixed**: Members mistakenly marked as guests no longer charged guest fees (checks for user_id presence)

## [4.0.0] - 2026-01-27

### Payment Cancellation and Refund System Overhaul
- **CRITICAL**: Fixed booking cancellations now properly refund paid payments (was trying to cancel succeeded payments which caused errors)
- **CRITICAL**: Cancellation now checks actual Stripe payment status before deciding to refund or cancel
- **NEW**: Centralized PaymentStatusService for atomic updates across all payment tables
- **NEW**: Stripe idempotency keys prevent duplicate payment intents from being created
- **NEW**: Fee snapshot reconciliation scheduler runs every 15 minutes to sync missed payments
- **Fixed**: All payment status changes now consistently update fee snapshots, participant statuses, and audit logs
- **Fixed**: Participant payment_status now includes paid_at timestamp and stripe_payment_intent_id when paid
- **Fixed**: Fee snapshot status now uses 'completed' to match webhook behavior
- **Improved**: Payment confirmation syncs from Stripe even without webhooks (development environment fix)

## [3.9.0] - 2026-01-27

### Booking Flow and Fee Calculation Fixes
- **Fixed**: Member booking requests no longer show duplicate confirmation messages
- **Fixed**: Confirmed bookings stay visible on calendar after Trackman webhook confirmation
- **Fixed**: Fee calculation now correctly uses staff-edited player count (was ignoring edits)
- **Fixed**: Daily usage tracking now correctly uses staff-edited player count for allowance calculations
- **Fixed**: Roster check during check-in now respects staff-edited player count
- **Fixed**: Empty player slots now created when player count is increased
- **CRITICAL**: Overage fees now properly saved to bookings during approval (was only storing in session)
- **CRITICAL**: All fee recalculation paths now sync to booking_requests (webhooks, approval, billing)
- **Improved**: Dev simulated webhook now generates realistic Trackman V2 format for testing

## [3.8.1] - 2026-01-27

### Editable Player Count for Staff
- Staff can now click the Players card in Booking Details to update the player count
- Player count changes automatically recalculate fees (fixes incorrect overage charges)
- Helpful for correcting bookings where Trackman imported wrong player count
- Maximum 4 players per booking enforced

## [3.8.0] - 2026-01-27

### Comprehensive Payment Intent Cancellation
- **CRITICAL**: All booking cancellation paths now cancel associated payment intents
- **Fixed**: Member-initiated cancellations properly cancel payment intents
- **Fixed**: Staff-initiated cancellations properly cancel payment intents
- **Fixed**: Reschedule approvals cancel payment intents for original booking
- **Fixed**: Trackman webhook cancellations cancel payment intents
- **Fixed**: Trackman CSV import cancellations cancel payment intents
- **Fixed**: Booking archive/soft-delete cancels payment intents via cascade function
- **Fixed**: 'Invalid Date' no longer appears in payment descriptions when date is missing
- **Added**: Staff cleanup endpoint to cancel stale payment intents from cancelled bookings

## [3.7.0] - 2026-01-27

### Critical Fee Estimate Display Fix
- **CRITICAL**: Fixed fee estimates not updating - was calling wrong method on API response
- **Fixed**: Overage fees now correctly display for Core members booking beyond their daily allowance
- **Fixed**: 120-minute Core bookings now show correct $50 overage instead of $0
- **Added**: Cache-control headers to fee estimate endpoints

## [3.6.3] - 2026-01-27

### Fee Estimate Caching Fix
- **Fixed**: Fee estimates now refresh properly instead of returning stale cached values
- **Fixed**: Browser caching no longer causes incorrect $0 fee display for overage bookings
- **Added**: Cache-control headers to fee estimate endpoints to prevent stale responses

## [3.6.2] - 2026-01-27

### Trackman V2 Webhook Complete Fix
- **Fixed**: V2 webhooks without customer email now create proper booking requests (appear on calendar)
- **Fixed**: V2 webhooks now correctly create Needs Assignment bookings for staff to assign
- **Fixed**: externalBookingId now included in normalized booking data for proper linking
- **Fixed**: Retry button now updates matched_booking_id after successful processing
- **Fixed**: Duplicate prevention when retrying webhooks - returns existing booking instead of creating duplicate

## [3.6.1] - 2026-01-27

### Trackman V2 Webhook Processing Fix
- **Fixed**: Trackman V2 webhooks now properly create booking requests when no externalBookingId match
- **Fixed**: V2 payload parsing now correctly handles start/end ISO datetime format
- **Fixed**: handleBookingUpdate detects V2 format and uses correct parser
- **Fixed**: Replayed webhooks from production now appear on booking calendar and queue
- **Fixed**: V2 webhooks fall through to standard processing for member matching and booking creation

## [3.6.0] - 2026-01-27

### Critical Fee Estimate Fix
- **CRITICAL**: Fee estimates now correctly show overage charges for new booking requests
- **Fixed**: Preview mode now queries booking_requests table instead of empty usage_ledger
- **Fixed**: Members see accurate fee estimates before submitting booking requests
- **Fixed**: Staff can preview fees for bookings without sessions (uses booking data directly)
- **Fixed**: Prevents unexpected charges at check-in by showing correct fees upfront

## [3.5.4] - 2026-01-27

### Billing Modal Session Fix
- **Fixed**: Check-In & Billing modal now creates sessions on-the-fly for bookings without sessions
- **Fixed**: Staff can now see and charge fees for orphaned bookings that failed to create sessions
- **Fixed**: Billing modal shows correct fees instead of 'Complete Check-In' for bookings with overage

## [3.5.3] - 2026-01-27

### Daily Usage & Notification Fixes
- **Fixed**: Daily usage now correctly includes 'attended' bookings (prevents unlimited bookings after check-in)
- **Fixed**: Check-in and no-show notifications use correct database schema (user_email column)
- **Fixed**: Simulated Trackman bookings now appear in Trackman Synced section
- **Fixed**: Fee estimates now correctly calculate overage when member has already attended bookings today

## [3.5.2] - 2026-01-27

### Comprehensive Fee Calculation Fix
- **Fixed**: Real Trackman webhook bookings now create booking_participants with cached fees
- **Fixed**: Linked pending bookings via Trackman webhook now create sessions and participants if missing
- **Fixed**: Assigning unmatched Trackman bookings to members now recalculates fees
- **Fixed**: Ghost booking auto-fix tool now creates participants and caches fees
- **Fixed**: Staff adding members/guests to bookings now triggers fee recalculation
- **Fixed**: Linking members to booking slots now recalculates session fees
- **Fixed**: 'Has Unpaid Fees' indicator now shows correctly across all booking creation flows

## [3.5.1] - 2026-01-27

### Overdue Payment Check-In Fix
- **Fixed**: Staff can now complete check-in for cancelled bookings that have pending payments (overdue payment recovery)
- **Fixed**: Resolves 'Cannot update booking with status: cancelled' error when marking overdue payments as paid
- **Fixed**: Simulated booking confirmations now calculate fees immediately after creating participants
- **Fixed**: Staff dashboard receives real-time notification when bookings are confirmed for instant UI refresh

## [3.5.0] - 2026-01-27

### Cross-Platform Sync Tools
- **Added**: Tier reconciliation check - compares member tier across HubSpot, Stripe, and app database with high-severity flagging for mismatches
- **Added**: Subscription status alignment tool - syncs membership_status from Stripe subscription states (active, canceled, past_due, etc.)
- **Added**: Stripe-HubSpot linking tool - creates missing HubSpot contacts for Stripe customers and vice versa
- **Added**: Payment status sync - updates HubSpot last_payment_status, last_payment_date, and last_payment_amount from Stripe invoices
- **Added**: Visit count sync - updates HubSpot total_visit_count from actual app check-in records
- **Added**: Trackman ghost booking auto-fix - creates missing billing sessions for orphaned Trackman bookings with idempotent protection
- **Added**: Email/contact deduplication detection - finds duplicate emails in app and HubSpot for manual review
- **UX**: New Cross-Platform Sync Tools section in Data Integrity with Preview/Execute pattern for all tools

## [3.4.5] - 2026-01-27

### Mind Body ID Data Integrity
- **Fixed**: HubSpot sync now clears stale Mind Body IDs not present in HubSpot (instead of preserving old values)
- **Fixed**: Member profile drawer only shows Mind Body ID when validated from HubSpot sync
- **Added**: Admin tool to create HubSpot contacts for members without one (Data Tools section)
- **Added**: Admin tool to cleanup stale Mind Body IDs by comparing against HubSpot
- **UX**: Both tools have Preview and Execute buttons in the Data Integrity admin page

## [3.4.4] - 2026-01-27

### Responsive Layout & Modal Fixes
- **UX**: Desktop layouts now use responsive grids (3-4 columns) that fill available space alongside sidebar
- **UX**: Dashboard, Events, Wellness grids scale from 1→2→3→4 columns across breakpoints
- **UX**: BookGolf time slots and resource cards use responsive grid layouts on larger screens
- **UX**: History page visits and payments display in 2-column grid on desktop
- **UX**: Increased bottom nav touch targets (48px min height) and improved icon/label sizing
- **UX**: Added responsive padding scaling (px-6 → lg:px-8 → xl:px-12) across member pages
- **Fixed**: Search dropdowns in modals now display properly without being cut off (ManagePlayersModal, StaffDirectAddModal, CompleteRosterModal)

## [3.4.3] - 2026-01-27

### Animation System Standardization
- **UX**: Replaced all hardcoded animation delays with dynamic stagger indices app-wide
- **UX**: MemberProfileDrawer uses spring physics for natural bounce on slide-in
- **UX**: Dashboard content crossfades from skeleton using SmoothReveal wrapper
- **UX**: Updated 20+ admin components (all tabs, GalleryAdmin, FaqsAdmin, AnnouncementManager, AvailabilityBlocksContent, ChangelogTab, DirectoryTab, DiscountsSubTab, UpdatesTab, BookingQueuesSection)
- **UX**: Updated member pages (Profile sections, BookGolf time slots/resources, Dashboard cards, History, GlassRow)
- **UX**: Updated public pages (Landing FeatureCards, PrivateHire SpaceCards, MenuOverlay navigation links)

## [3.4.2] - 2026-01-27

### Premium Motion & Interaction Polish
- **UX**: Added shimmer effect on interactive cards for premium glass feel
- **UX**: Improved stagger animations with smooth slide-up and spring physics
- **UX**: Added SmoothReveal component for smoother skeleton-to-content transitions
- **UX**: Enhanced tap feedback with consistent scaling across interactive elements

## [3.4.1] - 2026-01-27

### Data Integrity & Reconciliation Fixes
- **Fixed**: HubSpot sync check now uses random sampling to check all members over time
- **Fixed**: Resolve endpoint now corrects usage ownership when re-resolving to a different member
- **Fixed**: Reassign only updates owner entries in usage ledger (not guest entries)
- **Fixed**: Session creation uses stable IDs to prevent duplicates on re-resolve

## [3.4.0] - 2026-01-27

### Trackman Reconciliation & Admin UI Overhaul
- **Fixed**: Resolving unmatched bookings now creates proper billing sessions and ledger entries
- **Fixed**: Reassigning matched bookings now updates participants, ledger, and billing correctly
- **Fixed**: Auto-resolved bookings (same email) also get proper session creation
- **Added**: Ghost booking detection in Data Integrity (finds bookings missing billing sessions)
- **Redesigned**: Trackman admin tables now use dense data table layout for faster scanning
- **Redesigned**: Data Integrity page now uses master-detail split layout for easier navigation

## [3.3.1] - 2026-01-27

### Webhook Matching Safety Improvements
- **Fixed**: Back-to-back booking matching now validates end time to prevent matching the wrong slot
- **Fixed**: Pending request matching correctly handles two consecutive 30-minute bookings
- **Improved**: Pre-check availability before creating Trackman bookings for clearer conflict logging
- **Improved**: Cancelled booking linking also uses strict overlap validation

## [3.3.0] - 2026-01-27

### Production Readiness Improvements
- **Fixed**: Conflict detection time overlap logic now handles edge cases correctly
- **Fixed**: Trackman webhook matching now checks bay/resource to prevent back-to-back booking mismatches
- **Improved**: Webhook time tolerance tightened from 15 to 10 minutes for more precise matching
- **Improved**: Webhook matching prioritizes exact resource matches, with fallback for legacy bookings
- **Verified**: HubSpot syncs properly use queue system for resilient async processing

## [3.2.11] - 2026-01-27

### Improved Payment Descriptions
- **UX**: Payment descriptions now show readable dates (e.g., 'Jan 27, 2026' instead of '2026-01-27T08:00:00.000Z')
- **UX**: Time range displayed in 12-hour format (e.g., '8:30 AM - 12:30 PM')
- **Clarity**: Fee breakdown now shows what charges consist of (Overage, Guest fees) for Stripe and member visibility

## [3.2.10] - 2026-01-27

### Player Search Improvements
- **Fixed**: Player search in booking details now finds both members and past guests
- **UX**: Members appear with green badge showing their tier, guests show in gray
- **Workflow**: Selecting a member links them as a player, selecting a guest adds them as a guest

## [3.2.9] - 2026-01-27

### Check-In Page Architecture Fix
- **Fixed**: Viewing the check-in page no longer writes to the database (GET requests are now read-only)
- **Improvement**: Fees are now recalculated when staff takes a payment action, not when viewing
- **Performance**: Reduces unnecessary database writes and prevents potential race conditions

## [3.2.8] - 2026-01-26

### Session Backfill Payment Status Fix
- **Fixed**: Backfill tool now marks historical booking participants as 'paid' instead of 'pending'
- **Prevents**: Backfilled historical bookings no longer appear in Overdue Payments section
- **Data**: Uses 'external' payment method to indicate payment was handled outside the system

## [3.2.7] - 2026-01-26

### Auto-Open Billing After Assignment
- **UX**: Billing modal now opens automatically after assigning a member to a Trackman booking with fees
- **Improvement**: Staff can immediately mark payments as waived/paid externally for historical bookings
- **Workflow**: Prevents newly-assigned bookings from appearing as 'overdue' without review

## [3.2.6] - 2026-01-26

### Trackman Assignment Fee Recalculation
- **Fixed**: Billing fees are now recalculated when staff assigns a Trackman booking to a member
- **Fixed**: Member tier-based allowances now correctly applied after post-check-in assignment
- **Reliability**: Both 'Link to Member' and 'Assign Players' actions trigger fee recalculation
- **Audit**: Staff actions logged with fees_recalculated flag for tracking

## [3.2.5] - 2026-01-26

### Check-In & Refund Notifications
- **Added**: Members now receive notifications when checked in ('Check-In Complete')
- **Added**: Members receive notification if marked as no-show with instructions to contact staff
- **Added**: Automatic notification when booking payments are refunded
- **Added**: Database-level trigger prevents double-booking the same bay on new sessions
- **Reliability**: All notifications sent via both in-app and real-time WebSocket channels

## [3.2.4] - 2026-01-26

### Booking Cancellation Refunds
- **Added**: Guest fee payments are now automatically refunded when bookings are canceled
- **Added**: Works for both member-initiated and staff-initiated cancellations
- **Added**: Refund metadata tracks booking ID and participant for reconciliation
- **Reliability**: Non-blocking refund processing with error logging for manual follow-up

## [3.2.3] - 2026-01-26

### Safe Account Credit Integration
- **Improved**: Account credits now applied safely - no credit lost if card payment fails
- **Changed**: For partial credits, full amount is charged first, then credit portion refunded automatically
- **Added**: Webhook processes credit refunds with audit logging for failed refunds
- **UX**: Payment modals clearly explain that credits will be applied as a refund after payment

## [3.2.2] - 2026-01-26

### Account Credits Applied to Booking Payments
- **Added**: Account credits are now automatically applied when members pay guest fees or outstanding balances
- **Added**: Payment modals show how much account credit was applied vs. card charged
- **Added**: If account balance covers the full amount, no card payment is needed
- **Added**: Admin tool to backfill sessions for legacy Trackman-imported bookings
- **Reliability**: Members with account credits will see them automatically deducted from fees

## [3.2.1] - 2026-01-26

### Staff Subscription Management
- **Added**: Staff can now create new membership subscriptions directly from the member billing tab
- **Added**: 'Create Subscription' button appears when a member has Stripe set up but no active subscription
- **Added**: Modal to select membership tier when creating a new subscription
- **Added**: Stripe ID now displays in member header alongside Mindbody ID and HubSpot ID
- **Improved**: Create Subscription option now shows for Mindbody members to enable migration to Stripe billing

## [3.2.0] - 2026-01-26

### Double-Booking Protection & HubSpot Reliability
- **Architecture**: Added database-level constraint that makes double-booking the same bay physically impossible
- **Reliability**: HubSpot syncs now run in the background - member actions complete instantly even if HubSpot is slow
- **Added**: Background queue system processes HubSpot updates every 2 minutes with automatic retries
- Data cleanup: Resolved 8 overlapping Trackman phantom bookings from historical imports

## [3.1.2] - 2026-01-26

### Trackman Sync Improvements
- **Fixed**: Trackman Bookings Synced accordion now shows booking details and webhook data when expanded
- **Fixed**: Trackman webhook processing now supports all booking event types (created, updated, cancelled)
- **Added**: Linked member name and auto-link status now shown in Trackman sync cards

## [3.1.1] - 2026-01-26

### Performance & Safety Improvements
- **Performance**: Added database indexes for faster email lookups across all booking queries
- **Performance**: Fee calculations now batch database queries - reduced from ~12 queries to 3 per booking
- **Reliability**: Guest pass deductions now use transaction locking to prevent double-spending
- **Reliability**: Fee amounts are verified before payment completes - detects if fees changed after booking
- **Maintenance**: Created centralized pricing configuration - easier to update fees in the future
- **Fixed**: HubSpot contact sync now handles duplicate contacts more reliably
- **Fixed**: Staff check-in now uses shared tier rules - consistent guest validation

## [3.1.0] - 2026-01-26

### Unified Fee Service & System Reliability
- **Architecture**: Created Unified Fee Service - single authoritative source for all fee calculations across the app
- **Consistency**: All fee previews (booking, roster, approval, check-in, payments) now use the same calculation engine
- **Fixed**: Fee amounts now always match between what members see and what gets charged
- **Reliability**: Payment processing from Stripe now handles retries safely - no duplicate charges or emails
- **Concurrency**: Staff roster edits are now protected - simultaneous edits won't overwrite each other
- **Added**: 64 new automated tests covering fee calculations, payment safety, and roster protection

## [3.0.7] - 2026-01-26

### Roster Sync & Payment UX Improvements
- **Fixed**: Staff edits to booking roster now update fee estimates shown to members - adding/removing players recalculates time allocation correctly
- **Improved**: Pay Now option only appears after staff confirms booking - pending bookings show 'Pay online once confirmed, or at check-in'
- **Added**: Payment status badges on booking cards - shows 'Paid' (green) or amount due (amber) for confirmed bookings
- **Added**: Payment timing message on booking page - 'Pay online once booking is confirmed, or at check-in'
- **Fixed**: Time allocation now uses actual participant count when it exceeds declared count (e.g., 240min ÷ 5 players = 48min each)

## [3.0.6] - 2026-01-26

### Unified Fee Calculations
- **Unified**: Members and staff now see identical fee estimates - same server calculation for both
- **Added**: New /api/fee-estimate endpoint provides consistent fee previews across all booking flows
- **Improved**: Fee estimates update in real-time as booking details change
- **Fixed**: Eliminated calculation discrepancies between member booking and staff approval views

## [3.0.5] - 2026-01-26

### Booking Flow Audit Fixes
- **Added**: Fee estimate preview in staff approval modal - see estimated costs before approving
- **Added**: Guest search in booking management - staff can now search existing guests instead of re-entering info
- **Added**: Search/New toggle for guest entry with autocomplete and full email visibility
- **Fixed**: Staff member search now uses fresh API data instead of potentially stale cached data
- **Improved**: Staff see full email addresses in search results (not redacted)

## [3.0.4] - 2026-01-26

### Simplified Billing Model
- **Changed**: Owner now pays all fees (their overage + player fees + guest fees) in one charge
- **Improved**: Financial summary shows clear breakdown of owner overage, player fees, and guest fees
- **Improved**: Total displayed as 'Owner Pays' to clarify who is responsible for payment
- **Simplified**: No more separate 'Players Owe' section - everything rolls up to owner

## [3.0.3] - 2026-01-26

### Add Guest & Financial Summary Fixes
- **Fixed**: Add Guest button now works correctly in confirmed booking details
- **Fixed**: Financial summary now correctly shows Players Owe amounts for non-owner members
- **Fixed**: Social tier player fees now appear in financial breakdown instead of showing $0
- **Added**: Guest entry form accepts name and optional email for new guests
- **Added**: System detects if guest email belongs to existing member and offers to link them instead
- **Improved**: Unmatched/placeholder booking owners now get empty slots for staff assignment

## [3.0.2] - 2026-01-26

### Confirmed Booking Details Enhancement
- **Added**: Player roster management now shows in confirmed booking details modal
- **Added**: Staff can add/remove members and guests from confirmed bookings before check-in
- **Added**: Financial summary shows guest pass usage and estimated fees for confirmed bookings
- **Added**: Player slots are automatically created when viewing booking details
- **Improved**: Booking details modal now uses declared player count to create appropriate slots

## [3.0.1] - 2026-01-26

### Booking Request Error Fix
- **Fixed**: Booking requests now succeed without showing false error message
- **Fixed**: Date formatting for notifications now handles database Date objects correctly

## [3.0.0] - 2026-01-26

### Architecture & Performance Improvements
- **Performance**: All DataContext functions now memoized with useCallback to prevent unnecessary re-renders
- **Performance**: Context value wrapped in useMemo for stable references across renders
- **Architecture**: Backend startup tasks extracted to dedicated loader module for cleaner organization
- **Architecture**: Route registration extracted to separate loader module (server/loaders/routes.ts)
- **Architecture**: Added /api/ready endpoint for proper readiness probes (returns 503 until startup complete)
- **Reliability**: Added graceful shutdown handlers for SIGTERM/SIGINT signals
- **Reliability**: Server now properly closes connections and database pools on shutdown

## [2.9.6] - 2026-01-26

### Critical Booking Participant Data Fix
- **Fixed**: Directory-selected guests are now properly saved with booking requests (were previously lost)
- **Fixed**: Guest pass counting now correctly includes guests selected from visitor directory
- **Fixed**: Booking response now sent before notifications to prevent false error messages
- **Improved**: Participant data includes userId and name for visitors selected from directory

## [2.9.5] - 2026-01-26

### Guest Pass Pending Request Calculation
- **Fixed**: Guest pass estimate now accounts for pending booking requests (conservative calculation)
- **Fixed**: Booking request error handling improved - JSON parsing more resilient
- **Improved**: API returns both actual and conservative remaining passes for accurate estimates

## [2.9.4] - 2026-01-26

### Guest Pass Integration in Booking Fees
- **Improved**: Estimated fees now show guest pass usage when booking with guests
- **Improved**: Guest fees apply immediately when selecting Guest (not just when email is entered)
- **Improved**: Clear breakdown showing guests covered by passes ($0) vs charged guests ($25 each)
- **Improved**: Shows remaining guest passes after booking (e.g. '0 of 4')

## [2.9.3] - 2026-01-25

### Activity Tab & Lifetime Visits Improvements
- **Fixed**: Duplicate simulator bookings no longer appear in member Activity tab
- **Fixed**: Lifetime visits count now includes attended events and wellness classes (not just simulator bookings)
- **Fixed**: Member activity history displays correctly in staff directory profile drawer

## [2.9.2] - 2026-01-25

### Staff Directory Activity Tab Fix
- **Fixed**: Member activity history now displays correctly in staff directory profile drawer
- **Fixed**: Visit counts, booking history, event RSVPs, and wellness classes now show properly when viewing a member's profile
- **Note**: Previously the Activity tab showed 'No activity history found' due to a data formatting issue

## [2.9.1] - 2026-01-25

### Improved Player Selection for Booking Requests
- **New**: Search for club members when adding players to your booking - type a name to find them quickly
- **New**: Search the guest directory to add previous visitors without re-entering their information
- **New**: Guest fee now only applies when adding a non-member guest - adding club members is free
- **Improved**: Clear messaging when no matches found - for members, you'll see a helpful note; for guests, you can add them by email
- **Fixed**: Player information is now properly linked to member/visitor records for better tracking

## [2.9.0] - 2026-01-25

### Codebase Modernization & Maintainability
- **Improved**: Major backend code reorganization - large files split into focused modules for easier maintenance
- **Improved**: Stripe payment handling now organized by function (payments, subscriptions, invoices, coupons)
- **Improved**: Member management code organized by area (search, profiles, admin actions, notes)
- **Improved**: Booking system organized by function (resources, bookings, approvals, calendar)
- **Improved**: Trackman integration organized by function (webhooks, validation, billing, imports)
- **Technical**: Total of 15,535 lines of code reorganized into 34 focused modules

## [2.8.2] - 2026-01-25

### Transaction Safety & Data Integrity Improvements
- **Fixed**: Booking sessions, participants, and usage records are now saved together as one atomic operation - if any part fails, nothing is saved (prevents partial data)
- **Fixed**: Calendar sync now consistently uses Pacific timezone midnight to avoid potential date mismatches
- **Improved**: Email comparisons are now case-insensitive throughout the system for more reliable member matching
- **Improved**: Server error logging is now more consistent for easier troubleshooting

## [2.8.1] - 2026-01-25

### Booking Details Fee Calculation Fix
- **Fixed**: Empty player slots in Booking Details now show $25 pending fee until a member is assigned
- **Fixed**: Financial summary correctly calculates Total Due including all empty/pending slots
- **Improved**: Empty slots display 'Pending assignment - $25' fee note for staff clarity

## [2.8.0] - 2026-01-25

### Trackman Booking Assignment Overhaul
- **New**: Redesigned 'Assign Member to Booking' modal with 4 player slots for unmatched Trackman bookings
- **New**: Staff can add guest placeholders that count toward $25 fees immediately, with details added later
- **New**: 'Mark as Private Event' option removes event blocks from unmatched queue without requiring member assignment
- **New**: Member search in each slot with support for members, visitors, and guest placeholders
- **Improved**: Player count from member requests is now preserved when Trackman imports match bookings
- **Improved**: Trackman is source of truth for times/bay, app is source of truth for player count when request exists
- **Improved**: Player count mismatch detection flags when Trackman reports more players than the app request
- **Improved**: Merge logic preserves existing participants when webhook bookings link to member requests
- **Fixed**: Guest fee calculation now works correctly for guest placeholder slots ($25 per guest)

## [2.7.1] - 2026-01-25

### Membership Payment Labels
- **Improved**: Payment history now shows specific membership tier (e.g., 'Ace Membership' instead of generic 'Membership Payment')
- **Fixed**: Tier names are extracted from Stripe invoice descriptions for clearer billing history

## [2.7.0] - 2026-01-25

### Member Profile Drawer Redesign
- **New**: Consolidated member profile tabs from 11 down to 5 for improved usability
- **New**: Activity tab combines Bookings, Events, Wellness, and Visits in a unified timeline view
- **New**: Billing tab now includes guest passes, group billing, and purchase history
- **New**: Activity tab filter navigation lets you quickly filter by activity type
- **Improved**: Billing tab moved to 2nd position for faster staff access
- **Improved**: Notes tab moved earlier in tab order for quick access
- **Improved**: Cleaner navigation with fewer tabs and better information hierarchy

## [2.6.1] - 2026-01-25

### Billing UI Consolidation
- **New**: Billing Source dropdown now inside Subscription card for cleaner layout
- **New**: 'Sync' button moved into Subscription section next to 'Change Tier' button
- **New**: Status badge now appears inline with Subscription section title
- **New**: Single sync button performs metadata, tier, and transaction cache sync in one click
- **Fixed**: Stripe Customer ID and HubSpot ID now display in member profile header
- **Fixed**: Tier sync now correctly returns tier data for already-matching tiers
- **Improved**: Cleaner billing UI with fewer separate sections

## [2.6.0] - 2026-01-25

### Day Pass Management & UI Improvements
- **New**: Financials page now shows 'Recent Unredeemed Passes' section with all active day passes
- **New**: Each unredeemed pass displays holder name, pass type, remaining uses, and purchase date
- **New**: Quick 'Redeem' button on each pass card for streamlined check-in flow
- **New**: 'Refund' button with confirmation dialog for canceling unused day passes
- **New**: Real-time updates via WebSocket when day passes are purchased or redeemed
- **New**: Record Purchase search now includes visitors and former members alongside active members
- **New**: Search results show 'Visitor' badge to distinguish non-members
- **Fixed**: Join date now displays correctly for all users created via the app
- **Fixed**: Quick actions button now positions correctly at the bottom corner on desktop
- **Improved**: Optimistic UI for pass redemption provides instant visual feedback

## [2.5.0] - 2026-01-25

### New User Flow & Visitor Payment Links
- **New**: 'New User' modal replaces 'Invite New Member' - now creates visitor records without requiring immediate payment
- **New**: Staff can add users with just name, email, and optional phone - no tier selection required upfront
- **New**: Newly added users appear in Directory's Visitors tab with type 'New (Staff Added)'
- **New**: Visitor profile drawer now includes tier selection dropdown for sending payment links
- **New**: When visitors pay via payment link, they automatically become active members with Stripe billing
- **New**: Membership status syncs to HubSpot when subscription is activated
- **Improved**: Removed 'New Booking' from staff quick actions menu - all simulator bookings go through Trackman

## [2.4.0] - 2026-01-25

### Pre-Declare Players & Participant Notifications
- **New**: Members can now specify player emails when submitting a booking request (before staff approval)
- **New**: Player slot input fields appear when booking for 2+ players, with member/guest type toggles
- **New**: When a booking is confirmed, all declared participants are automatically added to the roster and notified
- **New**: Bookings now appear on each participant's dashboard when they're linked to the booking
- **Improved**: Pre-declared participant emails appear in Trackman notes with their type (M or G prefix)

## [2.3.7] - 2026-01-25

### Trackman Modal Fixes
- **Fixed**: 'Book on Trackman' modal now correctly shows declared player count instead of always showing 1 player
- **Fixed**: Clicking pending request cells in calendar now opens the Trackman booking modal instead of the decline modal
- **Improved**: Trackman notes now include placeholder lines for all declared players (e.g., G|none|Guest|2)

## [2.3.6] - 2026-01-25

### Bay Preference Display Fix
- **Fixed**: Pending booking requests now correctly show the member's selected bay instead of 'any bay available'
- **Fixed**: Simulate-confirm endpoint now creates proper session and participant records for testing

## [2.3.5] - 2026-01-25

### Trackman-Only Booking Workflow
- **Changed**: Removed manual booking button from staff Bookings page - all simulator bookings must now go through Trackman
- **Changed**: Empty calendar slots are no longer clickable - bookings are created via member requests and confirmed by Trackman webhooks
- **Note**: Staff can still reschedule existing bookings using the Reschedule button on each booking

## [2.3.4] - 2026-01-25

### Trackman Webhook Backfill
- **New**: CSV imports now backfill webhook-created bookings with missing data
- **New**: Player counts from import files update webhook bookings that have incomplete data
- **New**: Missing player slots are automatically created when importing Trackman files
- **New**: Notes from Trackman import are added to webhook bookings that were missing notes
- **New**: Sessions and billing records are backfilled for webhook bookings missing them
- **Improved**: Duplicate booking prevention - matching now strictly uses Trackman booking ID
- **Fixed**: Unmatched webhook bookings can now be linked to members during CSV import

## [2.3.3] - 2026-01-24

### Trackman Auto-Match Feature
- **New**: Auto Match button on unlinked Trackman webhook events
- **New**: Staff can now try to automatically match Trackman bookings to existing member requests by bay, date, and time
- **New**: Works for both pending requests (auto-approves) and already-approved bookings without Trackman ID
- **Improved**: Auto-match searches for bookings within 30 minutes of the Trackman booking time

## [2.3.2] - 2026-01-24

### Booking Management Improvements
- **Improved**: OTP code delivery is now faster - emails sent in the background after validation
- **Fixed**: Directory drawer close button no longer blocked by iOS status bar/notch
- **Fixed**: Booking resolution now works for legacy unmatched Trackman entries - creates proper booking records when resolving
- **Fixed**: Guest pass count display now shows accurate tier totals instead of confusing fallbacks
- **Improved**: Unified player management UI - Manage Players modal now shows booking context header with date, bay, duration and expected vs assigned player counts in one place

## [2.3.1] - 2026-01-24

### Enhanced Visitor Types
- **New**: Visitors tab now shows specific visitor types based on activity
- **New**: ClassPass visitors identified by their ClassPass purchases
- **New**: Sim Walk-In visitors identified by simulator walk-in purchases
- **New**: Private Lesson visitors identified by lesson purchases
- **New**: Guest visitors identified when they appear on member bookings
- **Improved**: Type detection is automatic based on most recent activity
- **Improved**: Filter dropdown includes all new visitor types

## [2.3.0] - 2026-01-24

### HubSpot → App Sync Improvements
- **New**: Member birthdays now sync from HubSpot - useful for birthday celebrations!
- **New**: Member addresses now sync from HubSpot (street, city, state, zip) - populated from Mindbody
- **New**: Notes from Mindbody now create dated entries when changed - preserves history instead of overwriting
- **Improved**: Billing source now respects billing_provider field first - fixes incorrect 'Stripe' labels for Mindbody members
- **Improved**: Active status for Mindbody members automatically syncs from HubSpot
- **Improved**: Contact info (phone, address) now flows from Mindbody → HubSpot → App consistently

## [2.2.1] - 2026-01-24

### Visitors Directory Improvements
- **New**: Search bar in Visitors tab - search by name, email, or phone
- **Improved**: Stripe now takes priority as billing source - visitors with Stripe accounts always show as 'Stripe' source
- **Improved**: Purchase counts and totals now combine data from both Stripe and Mindbody imports
- **Fixed**: Source filter now works correctly for MindBody, Stripe, and HubSpot contacts

## [2.2.0] - 2026-01-24

### Mindbody CSV Import
- **New**: Staff can upload Mindbody CSV exports directly in Data Integrity page
- **New**: First Visit Report helps match customers by email and phone before importing sales
- **New**: Enhanced matching logic - tries Mindbody ID, then email, then phone, then name
- **New**: Imported purchases appear in member billing history with Mindbody badge
- **New**: Import results show detailed stats on matched/unmatched records
- **Improved**: Duplicate detection prevents re-importing the same sales

## [2.1.1] - 2026-01-24

### Visitors Directory Pagination
- **Improved**: Visitors tab now shows total count of all visitors in the system
- **Improved**: Load More button to fetch additional visitors in batches of 100
- **Improved**: Better performance when browsing large visitor lists

## [2.1.0] - 2026-01-24

### Member Visits Tab
- **New**: History page now shows a unified Visits tab combining all your club activity
- **New**: See every booking you attended - whether as host, added player, or guest
- **New**: Guest visits show who invited you; player visits show who you played with
- **New**: Digital card lifetime visits now includes all visit types, not just bookings you created
- **Improved**: Simplified navigation - just Visits and Payments tabs
- **Improved**: Each visit shows a colored role badge for easy identification

## [2.0.4] - 2026-01-24

### Unified Visits System (Staff)
- **New**: Staff profile drawer Visits tab shows ALL member visits - as host, guest, player, wellness, events
- **New**: Each visit shows a role badge (Host, Player, Guest, Wellness, Event) for easy identification
- **New**: Guest visits show who invited them to the booking
- **Improved**: Lifetime visits count in directory now includes all visit types
- **Improved**: Last visit date in directory now reflects most recent activity across all visit types
- **Improved**: Directory now counts wellness class attendance toward lifetime visits

## [2.0.3] - 2026-01-24

### Visitor Deletion with External Data Cleanup
- **New**: Staff can now permanently delete visitors from the visitor profile drawer
- **New**: Optional Stripe customer deletion when removing a visitor
- **New**: Optional HubSpot contact archival when removing a visitor
- **Improved**: Delete modal shows checkboxes to choose which external systems to clean up
- **Safety**: Members cannot be accidentally deleted through the visitor deletion flow

## [2.0.2] - 2026-01-24

### Real-Time Visitor Type Updates
- **New**: Visitor TYPE is now updated automatically when a day pass is purchased
- **New**: Visitor TYPE is now updated automatically when someone is added as a guest to a booking
- **Technical**: Created reusable updateVisitorType utility with proper type hierarchy (day_pass > guest > lead)

## [2.0.1] - 2026-01-24

### Visitor Directory Enhancements
- **New**: Visitors now have stored TYPE (Day Pass, Guest, Lead) and SOURCE (HubSpot, Stripe, MindBody, App) fields
- **New**: Click any column header (Name, Type, Source, Last Activity) to sort the visitors list
- **New**: Last Activity column shows the most recent action date (day pass purchase or guest visit)
- **New**: Backfill endpoint populates visitor types from historical purchase and guest data
- **Improved**: Source priority logic: MindBody (for non-members with client ID) → Stripe → HubSpot → App
- **Improved**: Type priority: Day Pass (highest) → Guest → Lead (no activity)

## [2.0.0] - 2026-01-24

### Guest Pass Checkout Flow
- **New**: Members can now choose to use a guest pass (free) or pay the $25 fee when adding guests
- **New**: 'Add Guest' button is always enabled - no more blocked access when passes run out
- **New**: Payment choice modal shows clear options with guest pass balance and fee amount
- **New**: Stripe checkout integrated directly into the booking flow for instant payment
- **Improved**: Guest info modal now shows pass status and continues to payment choice
- **Improved**: Clear messaging when no passes remain ('No passes left — $25 guest fee applies')

## [1.9.1] - 2026-01-24

### Unified Visitor Profile Drawer
- **New**: Visitors now open in the full profile drawer (same as members) with Billing, Purchases, Visits tabs
- **New**: 'Send Membership Invite' button on visitor profiles to quickly convert visitors to members
- **Fixed**: Source priority now correctly shows HubSpot for contacts synced from HubSpot (was incorrectly showing MindBody)
- **Fixed**: Admin and Staff accounts no longer appear in the Visitors tab
- **Fixed**: Purchase history now displays correctly for all visitor profiles
- **Improved**: Visitor drawer shows only relevant tabs (Bookings, Visits, Billing, Purchases, Comms, Notes)

## [1.9.0] - 2026-01-24

### Expanded Visitors Tab & Smart Contact Management
- **New**: Visitors tab now shows all 2,375+ non-member contacts from HubSpot sync
- **New**: Type filter - filter contacts by 'Day Pass Buyers' or 'Leads'
- **New**: Source filter - filter by HubSpot, MindBody, or Stripe origin
- **New**: Smart visitor creation - when creating a visitor, system checks for existing email and links Stripe customer instead of duplicating
- **Fixed**: Former Members tab now includes 'declined' status (14 members were missing)
- **Improved**: Visitor cards now show type badge (Day Pass/Lead) and source badge (HubSpot/Stripe/MindBody)
- Foundation laid for guest pass checkout flow with Stripe product line items

## [1.8.5] - 2026-01-24

### Directory List Cleanup
- Removed the fade gradients at the top and bottom of the directory list
- The member list now scrolls cleanly without visual obstructions

## [1.8.4] - 2026-01-24

### Queue Card Border Fix
- **Fixed**: Booking queue card borders no longer get cut off at the corners
- The swipe gesture container now properly shows the full rounded border outline

## [1.8.3] - 2026-01-24

### Booking Information Consistency
- **New**: Assign Member modal now shows the imported name from Trackman at the top
- **New**: Notes from Trackman imports are now displayed in the Assign Member modal
- **New**: Resolve Booking modal also shows notes from imports for staff context
- Consistent information display: the same booking details now appear everywhere
- Staff can now see important context like 'walk in client - don't charge' across all modals

## [1.8.2] - 2026-01-24

### Streamlined Walk-In Visitor Flow
- **New**: Proactive visitor creation - staff can create visitors before they arrive
- After assigning a visitor to a Trackman booking, a 'Charge $X' button appears on the booking card
- Staff clicks 'Charge $X' when visitor actually arrives to open the billing modal
- Complete walk-in flow: Trackman booking → assign visitor → visitor arrives → charge/waive → booking ready
- **UI**: Removed card background from Directory search/filters for cleaner appearance

## [1.8.1] - 2026-01-24

### Account Balance & Instant Credits
- **New**: Account Balance section on Profile - add funds to your account for instant credits
- Members can add $25, $50, or $100 via Stripe checkout
- Balance is credited instantly upon successful payment
- Staff can view member account balance and apply credits in the Billing tab (e.g., for service recovery)
- All staff credit applications are now logged in the Staff Activity feed
- **Fixed**: Staff/admin logins no longer create Stripe customer accounts
- **Disabled**: Automatic payment reminder emails until billing system is finalized (staff send links manually)
- **Future**: Account balance can be used for guest fees, day passes, and service overages
- **Removed**: Guest Passes section (balance-based system replaces per-pass tracking)

## [1.8.0] - 2026-01-24

### Billing Integrity & Payment Protection
- **Critical**: Webhook deduplication window extended from 24 hours to 7 days - prevents late duplicate processing
- **Critical**: Payment confirmation now uses database transactions with row-level locking - prevents race conditions
- **Critical**: Refunds now sync to booking participants - refunded bookings correctly marked as 'refunded'
- **New**: Guest pass consumption has idempotency protection - prevents double-deduction on retries
- **New**: Guest pass refunds now use tier-specific fees instead of hardcoded $25
- **New**: Trackman booking ID added to day pass duplicate checks - prevents re-billing the same booking
- **New**: Tier change verification confirms database matches Stripe after changes
- **New**: Daily alert for unresolved Trackman bookings older than 24 hours
- **Fixed**: All refunds on a charge are now cached (was only caching the latest refund)

## [1.7.2] - 2026-01-24

### Facility Status Display Fix
- **Fixed**: Facility Status was incorrectly showing future bookings (e.g., Jan 28) as currently occupied
- Bays now only show as 'Booked' when there is an active booking for TODAY at the current time
- This was a display-only issue - member booking availability was not affected

## [1.7.1] - 2026-01-24

### Visitor Day Pass Billing & Payment Sync
- **New**: Day pass visitors ($50) are now automatically charged when linked to Trackman bookings
- Visitors with saved payment method are charged immediately; otherwise an invoice is sent
- Added booking_date tracking to prevent duplicate day pass charges for the same date
- **New**: Manual payment sync endpoint for staff to refresh a member's complete Stripe history
- Payment sync now supports full pagination for customers with 100+ transactions

## [1.7.0] - 2026-01-24

### Stripe & Trackman Billing Harmony
- **Critical**: Suspended/inactive members are now blocked from booking (membership_status enforcement)
- **Critical**: Trackman webhooks now use the billing engine - fees calculated correctly for all bookings
- **Critical**: Booking time changes from Trackman now trigger automatic fee recalculation
- **New**: Invoice lifecycle webhooks (created, finalized, voided, uncollectible) sync to transaction cache
- **New**: Cached payment history endpoint for faster member billing lookups
- **Fixed**: Failed payment intents and invoices now cached in transaction history
- **Fixed**: Stripe webhook errors now properly throw for retry handling

## [1.6.2] - 2026-01-24

### Stripe Webhook Reliability Fixes
- **Fixed**: Payment status now consistent between API and webhooks (was 'used' vs 'completed')
- **Fixed**: Failed webhook operations now trigger Stripe retry (was silently failing)
- Payments are now more reliable and won't get stuck in 'processing' state

## [1.6.1] - 2026-01-24

### Fix Trackman Resolve Booking
- **Fixed**: Resolve booking now works - was looking for wrong parameter name
- Staff can now successfully assign unmatched Trackman bookings to members or visitors

## [1.6.0] - 2026-01-24

### Create Visitor from Trackman Bookings
- **New**: Add Visitor button in Assign Member modal - replaces Cancel button
- Can search for existing visitors in the directory before creating new ones
- Create new visitors with first name, last name, email - automatically creates Stripe account
- New visitors appear in the Visitors directory and can be tracked for bookings and purchase history

## [1.5.3] - 2026-01-24

### Trackman Rescan & Member Search Fix
- Fixed Rescan button in Trackman tab - now properly attempts to auto-match unmatched bookings
- Fixed member search when resolving unmatched bookings - now finds both current and former members
- Search now queries the database in real-time for more accurate results

## [1.5.2] - 2026-01-24

### Unmatched Bookings List Restored
- Fixed unmatched bookings list showing 0 - now correctly displays CSV import bookings needing member assignment
- Unmatched bookings can be resolved directly from the import screen
- Original name and email from CSV now displayed for easier identification

## [1.5.1] - 2026-01-24

### Tappable Booking Cards & Timezone Fix
- Booking cards are now tappable - tap anywhere on the card to open booking details (no more separate Edit button)
- Fixed 'Last event' timestamp in Trackman sync section - now shows correct Pacific timezone

## [1.5.0] - 2026-01-24

### Trackman Data Sync Architecture
- **New**: CSV import and webhook now work together seamlessly with 1:1 data sync using Trackman booking ID as unique key
- **New**: Unmatched CSV bookings now block time slots to prevent double-booking (same as webhook behavior)
- **New**: Origin tracking - each booking shows whether it came from member request, staff creation, webhook, or import
- **New**: Last sync tracking - timestamps and source for when Trackman data was last synced
- **Improved**: CSV import updates existing bookings instead of duplicating them
- **Improved**: Field-level merge - import enriches missing data but preserves member linkage and staff edits

## [1.4.16] - 2026-01-24

### Staff Activity Filters & Player Roster
- Fixed staff activity filters - Bookings, Billing, Members and other category filters now work correctly
- Added missing audit actions: Change Booking Owner, Assign Member to Booking, Link Trackman to Member
- Removed 'Viewed Member' and 'Viewed Profile' noise from activity feed - now only actual changes are logged
- X/Y Players button now shows for all future bookings, not just today - staff can prep rosters in advance

## [1.4.15] - 2026-01-24

### Fixed Assign Member Button
- Fixed 'Assign Member' button not working - was incorrectly using HubSpot IDs instead of user IDs
- Member search input shows green border and checkmark when member is selected
- Success message displayed after successfully assigning a member to a booking
- Partial roster bookings now show 'X/Y Players' button on queue list instead of 'Check In'
- Calendar shows blue styling for bookings that need more players (dotted blue outline, blue background, blue text) to match Add Player button
- Conference rooms now display lavender 'Conf' badge correctly in all views
- Fixed Trackman webhook stats cards and event count not displaying due to database query error
- Fixed booking dates showing one day off in member profile (timezone display issue)
- Trackman bookings now auto-create billing sessions for seamless check-in
- Check-in now works even when billing session is pending sync

## [1.4.14] - 2026-01-23

### Cleaner Booking Queue Layout
- Unmatched bookings now show clean 'Needs Assignment' badge instead of 'Unknown (Trackman)' text
- Removed redundant 'CONF' badge from regular bookings - bay info already shown below
- Removed 'UNMATCHED' header badge - amber card styling makes them visible enough
- Bookings page now shows unified scheduled list with unmatched bookings mixed in
- Unknown Trackman bookings correctly show 'Assign Member' button instead of 'Check In'

## [1.4.13] - 2026-01-23

### Unified Booking Queue with Smart Actions
- Redesigned booking cards in Queue tab with detailed info: name, date/time, bay, and Trackman ID
- Smart action buttons adapt to booking state: Check In, X/Y Players, Charge $X, or Assign Member
- Clicking 'X/Y Players' now opens roster management modal to add players
- Unmatched Trackman bookings merged into scheduled list with amber styling for visibility
- Booking cards show status badges: Checked In (green), Confirmed (blue), Needs Assignment (amber)

## [1.4.12] - 2026-01-23

### Member Notifications & Improved Search
- Members now receive notifications when their booking is confirmed via Trackman
- Members notified when staff manually assigns them to a booking
- Fixed member search in 'Assign Member' modal - now shows names and tiers like Record Purchase
- Stats and event lists auto-refresh when a booking is linked (no page reload needed)
- Staff dashboard updates instantly after assigning members to bookings

## [1.4.11] - 2026-01-23

### Detailed Booking Stats Breakdown
- Stats widget now shows 4 categories: Auto Confirmed (blue), Manually Linked (green), Needs Linking (amber), Cancelled (red)
- Auto Confirmed: Bookings automatically matched to members via email
- Manually Linked: Bookings assigned by staff after initial webhook
- Clear visual distinction helps track staff workload for unmatched bookings

## [1.4.10] - 2026-01-23

### Accurate Trackman Booking Stats
- Fixed stats widget to show correct counts for auto-approved vs needs-linking bookings
- Added 'Needs Linking' count in amber to show bookings awaiting member assignment
- Auto-linked bookings (William, Greg) now correctly show blue button instead of green
- Future auto-matched webhooks will properly track was_auto_linked status

## [1.4.9] - 2026-01-23

### Streamlined Unmatched Booking Flow
- Clicking amber (unassigned) bookings on the calendar now opens 'Assign Member' directly
- Staff no longer need to go through Booking Details first to assign a member
- After assigning a member, the cell turns green and Booking Details becomes accessible

## [1.4.8] - 2026-01-23

### Unified Assign Member Experience
- Consolidated member assignment into a single modal for consistency across all screens
- Staff Dashboard, Booking Details, and Webhook Events now all use the same assignment flow
- Simplified codebase by removing duplicate modal components

## [1.4.7] - 2026-01-23

### Improved Trackman Booking Visibility
- Unassigned bookings now clearly show 'Unassigned' instead of confusing 'Unknown (Trackman)' placeholder
- Webhook events distinguish auto-linked (blue) vs manually-linked (green) bookings
- 'Linked' badge only appears for bookings with actual members assigned, not placeholder accounts
- Fixed member search showing names and emails correctly in dark mode
- Staff-only: full member emails now shown in search results for accurate linking

## [1.4.6] - 2026-01-23

### Change Booking Owner Feature
- Staff can now change the owner of any booking from the Booking Details modal
- Trackman webhook events show member name on green button - click to reassign to different member
- Unmatched Trackman bookings show amber 'Link to Member' button as before
- All owner changes are logged to staff activity with previous and new owner information
- Booking calendar cells now show amber color for unmatched bookings so staff can spot them easily

## [1.4.5] - 2026-01-23

### Trackman Webhook Booking Creation Fixed
- Fixed critical bug where Trackman webhooks were not creating bookings on the calendar
- All Trackman bookings now appear on the calendar immediately - time slots are blocked automatically
- Fixed 'Link to Member' search - member dropdown now shows results when searching by name
- Staff can now manually link any Trackman booking to a member using the Link to Member button
- Fixed internal references in link-to-member feature so it correctly finds webhook data

## [1.4.4] - 2026-01-23

### CSRF Protection Removed
- Removed CSRF token validation that was causing login and form submission failures
- Modern browser security (SameSite cookies, CORS) already provides this protection
- All 'CSRF failed' errors across the app are now permanently resolved

## [1.4.3] - 2026-01-23

### UI Polish: Dark Mode & Rounded Corners
- Fixed skeleton loaders showing light gray in dark mode - now properly shows dark colors
- Added rounded corners to Directory page search bar and table header for consistent look
- All loading states now automatically adapt to light and dark themes

## [1.4.2] - 2026-01-23

### Audit Fixes: Payments & Login
- Fixed production login issue where OTP requests could fail on first visit
- Added refund tracking - when refunds happen in Stripe, they now sync to the app automatically
- Revenue reports now accurately reflect partial and full refunds
- Installed missing payment processing component for server stability

## [1.4.1] - 2026-01-23

### Bug Fixes & Maintenance
- Fixed Trackman webhook crash when receiving unknown event types
- Improved WebSocket reconnection with exponential backoff to reduce network noise
- Added test account cleanup tooling for database hygiene
- Version number now displays dynamically from changelog in sidebar and mobile

## [1.4.0] - 2026-01-23

### Comprehensive Staff Activity Logging
- Staff Activity now tracks ALL staff actions across the entire platform
- New categories: Tours, Events, Wellness, Announcements, Closures, and Admin actions
- Tour status changes (check-in, completed, no-show, cancelled) now appear in activity feed
- Event management (create, update, delete, RSVP management) fully logged
- Wellness class management and enrollment tracking added
- Closure and announcement management now tracked
- Trackman imports and booking assignments logged for audit compliance
- Group billing member changes tracked
- Richer detail cards show context like dates, status changes, and member info
- Added new filter tabs: Tours, Events, Admin for focused views

## [1.3.1] - 2026-01-23

### Staff Activity Tracking
- New Staff Activity log tracks all staff actions including booking approvals, billing changes, and member updates
- Activity log is accessible from the Changelog page with a dedicated tab for admins
- Filter activity by category (Bookings, Billing, Members) or by staff member
- Each action shows who did it, when, and relevant details like amounts or member names
- Improved audit trail for better accountability and operational visibility

## [1.3.0] - 2026-01-22

### Stripe Transaction Cache & Sync
- Transaction history now loads instantly with local caching instead of slow Stripe API calls
- One-click backfill tool syncs all historical Stripe transactions to the cache
- Subscription pause lets staff temporarily suspend memberships for 1-4 weeks
- Resume subscription restores billing on the original schedule
- Tier changes now properly sync to Stripe customer metadata
- Fixed membership tag display to accurately reflect Stripe billing status
- Fixed last visit date showing invalid dates for some members

## [1.2.2] - 2026-01-21

### Relative Times & Bug Fixes
- Notifications now show relative times like '2h ago' or 'Yesterday' instead of dates
- Pending booking requests display how long they've been waiting for approval
- Fixed bug report submission - you can now successfully report issues from your profile
- Fixed QR code scanner for redeeming day passes on the Financials page
- Improved scanner reliability with better camera permission handling

## [1.2.1] - 2026-01-20

### MindBody-Stripe Integration
- Staff can now view and charge overage fees for MindBody members through Stripe
- Automatic Stripe customer creation for members without a Stripe account
- One-click manual linking for members who already have Stripe accounts
- Improved duplicate prevention when creating Stripe customers
- Direct charge capability for non-system users from the admin panel

## [1.2.0] - 2026-01-19

### Trackman Booking Sync
- Bookings now sync automatically with Trackman when staff creates them in the portal
- Member requests a time, staff sees request, books in Trackman, and our system auto-confirms
- Time matching updates our records to match Trackman's actual booking times
- Bay conflict detection warns staff of overlapping bookings
- Pending requests auto-expire after their scheduled time passes
- Staff receive toast notifications when bookings are auto-confirmed

## [1.1.6] - 2026-01-18

### Self-Service Billing Portal
- Members can now manage their own billing through Stripe's secure portal
- Update payment methods, view invoices, and manage subscription directly
- Pending booking requests show visual indicators on the calendar view
- Calendar improvements with sticky headers for easier navigation
- Security tokens added to payment collection for safer transactions

## [1.1.5] - 2026-01-17

### Calendar & Scheduler Improvements
- Background tasks reorganized into separate scheduler files for better reliability
- Conference room IDs now fetched dynamically instead of hardcoded values
- Booking requests use database transactions to prevent race conditions
- Fixed duplicate guest entries when adding members to bookings
- Improved pending authorization handling for incomplete payments

## [1.1.4] - 2026-01-16

### Mobile App & Privacy Compliance
- Mobile app foundation with API endpoints for iOS and Android development
- New privacy controls let members opt out of data sharing (CCPA/CPRA compliant)
- Request your data export directly from your profile's Privacy section
- Guardian consent required for members under 18 when making bookings
- Improved performance on the member directory with faster list scrolling
- Fixed join date display to show correct membership start dates

## [1.1.3] - 2026-01-13

### Billing & Payment Tracking
- Check-in screen now shows a clear fee breakdown with color-coded badges
- Orange badge for time overage fees, blue for guest fees, green when a guest pass is used
- See each person's tier and daily allowance right on the billing screen
- New Overdue Payments section helps staff follow up on unpaid past bookings
- Fixed an issue where guest fees were incorrectly counting toward the host's usage

## [1.1.2] - 2026-01-10

### Reliability & Token Refresh
- Fixed HubSpot and Google Calendar token expiration issues
- Tokens now refresh proactively before they expire
- Improved connection reliability for external integrations

## [1.1.1] - 2026-01-09

### Smoother Animations & Notifications
- New animations for page transitions and modal popups
- Toast notifications confirm your actions throughout the app
- Improved loading states with fade effects
- Better visual feedback when buttons are tapped

## [1.1.0] - 2026-01-08

### Multi-Member Bookings
- Invite other members to join your golf booking
- Add guests directly to your reservation using guest passes
- See who's accepted, pending, or declined at a glance
- Time is automatically split between all participants
- Invites expire automatically if not accepted in time
- Conflict detection prevents double-booking the same member
- Staff can reconcile declared vs actual player counts from Trackman

## [1.0.4] - 2026-01-06

### Availability Blocks & Calendar Status
- New Blocks tab in Calendar page lets staff block off times for maintenance, private events, or staff holds
- See which Google Calendars are connected at a glance with the Calendar Status panel
- One-click button to fill gaps when wellness classes are missing from Google Calendar
- Blocks are grouped by day with collapsible sections for easy browsing

## [1.0.3] - 2026-01-04

### Training Guide & Bug Fixes
- Training guide now stays in sync with feature changes automatically
- Added documentation for the Needs Review notice workflow
- Fixed database performance indexes not being created on startup
- Improved startup reliability with better error handling

## [1.0.2] - 2026-01-04

### Stability & Reliability
- Improved error handling during server restarts
- Better retry logic for API calls when connection is temporarily unavailable
- Admin dashboard components more resilient to loading states
- HubSpot API calls now gracefully fall back to cached data

## [1.0.1] - 2026-01-02

### Notice Categories & Calendar Sync
- Notices now have categories like Holiday, Maintenance, Private Event synced from Google Calendar
- Staff can choose a reason category when creating notices
- Member dashboard shows notice category and date/time at a glance
- Closures appear in red, informational notices in amber

## [1.0.0] - 2026-01-02

### Faster & More Responsive
- Buttons respond instantly when you tap them - no more waiting
- If something goes wrong, the app automatically undoes the action
- Staff can mark bookings as attended or no-show from member profiles
- Fixed various behind-the-scenes issues for a smoother experience

## [0.9.0] - 2026-01-02

### Trackman Import & Booking History
- Staff can import booking history from Trackman with automatic member matching
- When you resolve one unmatched booking, all similar ones get fixed automatically
- View and manage matched bookings with easy reassignment if needed
- Page navigation added for browsing large booking histories

## [0.8.0] - 2026-01-01

### Staff Command Center
- Redesigned staff home as a real-time command center
- See pending requests, facility status, and upcoming tours at a glance
- Quick actions for common tasks like new bookings and announcements
- Auto-refresh every 5 minutes with pull-to-refresh support

## [0.7.3] - 2026-01-01

### PWA & Performance
- Long-press the app icon for quick shortcuts to Book Golf, Events, and more
- App loads faster with optimized code splitting
- Better caching for images and static files
- Timezone fixes to ensure all times display correctly in California

## [0.7.2] - 2025-12-31

### Notices & Booking Improvements
- Closures renamed to Notices for clarity - some are informational only
- Notices with no affected areas no longer block bookings
- Conference room bookings sync from MindBody automatically
- Eventbrite attendees now sync directly into event RSVPs
- Improved accessibility with better contrast and touch targets

## [0.7.1] - 2025-12-30

### Member Dashboard & History
- New History page to view all your past bookings and experiences
- Redesigned dashboard with quick-access metrics
- You can reschedule bookings directly - old booking is cancelled automatically
- Core members can choose 30-minute or 60-minute sessions
- Staff can make extended bookings up to 5 hours for private events

## [0.7.0] - 2025-12-30

### Tier-Based Booking Limits
- Booking options now reflect your membership tier
- Premium and VIP members get access to longer sessions
- Staff notes field for internal comments on bookings
- New Closures tab with dedicated styling in Updates page

## [0.6.0] - 2025-12-29

### Unified Updates Page
- Announcements and closures combined into one Updates page
- Time slots grouped by hour in accordion layout
- Staff portal now respects your light/dark theme
- Optional image uploads for wellness classes

## [0.5.0] - 2025-12-28

### Pull to Refresh & Polish
- Pull down on any page to refresh your data
- Beautiful branded animation with animated mascot
- Reschedule bookings directly from the calendar
- 120-minute booking option for Premium and VIP members
- Bug report feature - report issues right from your Profile

## [0.4.0] - 2025-12-28

### Premium Feel
- Hero images have a subtle parallax depth effect as you scroll
- Booking confirmations play a satisfying notification sound
- Glassmorphism styling for a cohesive, premium look
- Team directory for staff to see colleague contact info

## [0.3.0] - 2025-12-26

### Staff Portal Redesign
- Reorganized Staff Portal with better navigation
- New Training Guide with images and step-by-step instructions
- Faster loading throughout the app
- In-app notifications for booking requests and updates

## [0.2.0] - 2025-12-20

### Staff Portal & Install as App
- New Staff Portal for managing the club
- Install the app on your phone's home screen
- Log in with a code sent to your email - no password needed
- Bookings sync to Google Calendar automatically
- Request bookings that staff approve - no more double-bookings

## [0.1.0] - 2025-12-16

### Launch Day
- The app is live! Built from the ground up for Ever Club members
- Book golf bays and conference rooms with real-time availability
- Membership tiers with guest passes and booking limits
- Connected to HubSpot so your membership info stays in sync

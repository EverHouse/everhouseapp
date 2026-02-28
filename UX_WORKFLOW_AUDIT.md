# UX & Workflow Audit Report

**Project:** Ever Club Members App
**Date:** February 28, 2026
**Scope:** Material Design 3 alignment, frontend-to-backend workflows (Supabase, state management, error handling)
**Status:** Analysis only — no code changes made

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Critical UX Issues](#1-critical-ux-issues)
3. [M3 Component Opportunities](#2-m3-component-opportunities)
4. [Workflow / Architecture Improvements](#3-workflow--architecture-improvements)
5. [What's Already Working Well](#4-whats-already-working-well)
6. [Priority Roadmap](#5-priority-roadmap)

---

## Executive Summary

The Ever Club codebase demonstrates a mature, well-architected application with a strong custom design system ("Liquid Glass"), thoughtful accessibility foundations, and robust data-fetching patterns. The custom "Luxury Editorial" typography system (Newsreader & Instrument Sans) is cohesive and well-integrated.

However, there are meaningful gaps between the current implementation and Material Design 3 best practices. These gaps fall into three categories:

- **Critical UX Issues** (8 findings): Accessibility failures, missing state coverage, and interaction gaps that directly affect usability.
- **M3 Component Opportunities** (7 findings): Places where adopting M3 component patterns would improve clarity, discoverability, and mobile ergonomics.
- **Workflow/Architecture Improvements** (8 findings): Frontend-to-backend workflow patterns that can be strengthened for resilience and responsiveness.

---

## 1. Critical UX Issues

### CUX-01: Accent Color (#CCB8E4) Fails Contrast on Light Backgrounds

| Attribute | Detail |
|:---|:---|
| **Severity** | Critical |
| **M3 Guideline** | Color System — Accessible Contrast |
| **WCAG Standard** | 2.1 AA (4.5:1 for normal text, 3:1 for large text) |

**Current State:**
- Accent Lavender (`#CCB8E4`) on Bone (`#F2F2EC`) produces a contrast ratio of only **1.7:1** — failing all WCAG levels.
- White (`#FFFFFF`) on Accent (`#CCB8E4`) produces **1.5:1** — also fails entirely.
- The Primary (`#293515`) on Bone (`#F2F2EC`) contrast is excellent at **11.4:1**.

**Risk:** Any instance where Lavender is used as text color on light surfaces (or white text on Lavender backgrounds) is inaccessible to users with low vision or color deficiency.

**Recommendation:**
1. Audit all uses of `accent`/`#CCB8E4` as a text color. Reserve it exclusively for: (a) decorative elements (borders, indicators, backgrounds behind dark text), or (b) backgrounds paired with `#293515` Primary text (6.6:1 — passes AA).
2. Introduce an `on-accent` semantic token (`#293515` or darker) for any text rendered on Lavender surfaces.
3. For dark mode, verify Lavender text on the dark green background (`#293515`) — this pair at 6.6:1 is acceptable for AA but borderline for body text at small sizes.

---

### CUX-02: Focus Indicator Suppression Risk

| Attribute | Detail |
|:---|:---|
| **Severity** | High |
| **M3 Guideline** | Interaction States — Focus |
| **WCAG Standard** | 2.4.7 Focus Visible (AA), 2.4.11 Focus Not Obscured (AAA) |

**Current State:**
- `src/index.css` contains a `.custom-focus:focus-visible { outline: none; }` rule that suppresses the browser's native focus indicator.
- While custom focus rings exist (`focus:ring-2 focus:ring-offset-1 focus:ring-accent`), any element using `.custom-focus` without an alternative visible indicator breaks keyboard navigation.
- M3 specifies that focus states should use a visible **3dp-width ring** or equivalent visual indicator.

**Recommendation:**
1. Audit every usage of `.custom-focus` to ensure each instance has a replacement visible focus indicator.
2. Replace `outline: none` with a consistent custom focus style (e.g., `outline: 2px solid var(--accent); outline-offset: 2px`) that satisfies both M3 and WCAG.
3. Ensure the focus indicator color meets contrast requirements against all surface colors it appears on.

---

### CUX-03: Inconsistent Form Validation Patterns

| Attribute | Detail |
|:---|:---|
| **Severity** | High |
| **M3 Guideline** | Text Fields — Error State |
| **Affected Areas** | Member application form, admin forms, booking forms |

**Current State:**
- The `Input.tsx` component has proper inline error support (`aria-invalid`, `aria-describedby`, error icon + message) — but uses `amber-400` for error borders instead of M3's error color role.
- `MembershipApply.tsx` uses a parallel, manually coded error system with `text-red-500` and no `aria-describedby` linkage.
- Admin forms (e.g., `AnnouncementFormDrawer.tsx`) skip inline errors entirely, relying only on Toast notifications — violating M3's principle that errors should appear at the point of input.
- No schema-based validation library (Zod is available on the backend but not consistently used for frontend form validation).

**Recommendation:**
1. Standardize on the `Input.tsx` error pattern app-wide. All forms should use inline error text at the field level, not Toast-only feedback.
2. Align error border color to a single semantic token (M3 recommends the `error` role color — typically a warm red, not amber).
3. Adopt Zod schemas shared between frontend and backend for validation parity. Use a form library like `react-hook-form` with `@hookform/resolvers/zod` to eliminate manual validation logic.
4. Add supporting text below fields (M3 "helper text") that transitions to error text when validation fails.

---

### CUX-04: Missing Dragged State on Gesture Components

| Attribute | Detail |
|:---|:---|
| **Severity** | Medium |
| **M3 Guideline** | Interaction States — Dragged |
| **Affected Components** | `SwipeableListItem.tsx`, `PullToRefresh.tsx`, `SlideUpDrawer.tsx` |

**Current State:**
- `SwipeableListItem` implements gesture physics (elastic resistance, direction locking, haptic feedback) — excellent.
- However, there is no visible **dragged state layer** per M3. M3 specifies that a dragged element should: (a) gain elevation/shadow, (b) show a state-layer overlay at the `dragged` opacity (16%), and (c) visually "lift" from the surface.
- The `SlideUpDrawer` has a drag handle but no visual feedback indicating the drawer is being actively dragged.

**Recommendation:**
1. When `SwipeableListItem` enters a drag state, apply: `box-shadow` elevation increase, subtle background state-layer (white/8% or black/8% depending on surface), and `scale(1.02)` lift.
2. Add a visual "active drag" state to the `SlideUpDrawer` handle (e.g., handle widens or changes color during active drag).

---

### CUX-05: Icon-Only Buttons Missing Accessible Labels

| Attribute | Detail |
|:---|:---|
| **Severity** | Medium |
| **M3 Guideline** | Icon Buttons — Accessibility |
| **WCAG Standard** | 1.1.1 Non-text Content, 4.1.2 Name, Role, Value |

**Current State:**
- Core UI components (`ModalShell.tsx`, `MemberBottomNav.tsx`) correctly include `aria-label` on icon buttons.
- However, icon-only buttons in admin panels and list action columns may not all have descriptive `aria-label` attributes. Material Symbols icons use `aria-hidden="true"` (correct), but this means the parent `<button>` must carry the label.

**Recommendation:**
1. Conduct a global audit: search for all `<button>` elements containing only a `<span className="material-symbols-outlined">` child and verify they have an `aria-label`.
2. Create a reusable `IconButton` component that enforces `aria-label` as a required prop.
3. Add an ESLint rule (`jsx-a11y/anchor-has-content` or equivalent) to catch unlabeled interactive elements.

---

### CUX-06: No Visible Loading Feedback on Inline Mutations

| Attribute | Detail |
|:---|:---|
| **Severity** | Medium |
| **M3 Guideline** | Progress Indicators — Determinate & Indeterminate |
| **Affected Areas** | Toggle switches, inline status changes, quick actions |

**Current State:**
- Page-level data fetching uses excellent skeleton loaders with crossfade transitions.
- Button submissions show spinner icons during mutations.
- However, lightweight inline mutations (e.g., toggling a notification preference, changing a booking status via dropdown, approving a request) may not have visible progress indicators between click and result.

**Recommendation:**
1. For toggle/switch mutations: show the toggle in an "indeterminate/pending" visual state (e.g., reduced opacity + subtle pulse) until the mutation resolves. Revert on error.
2. For dropdown status changes: show an inline circular progress indicator next to the changed value.
3. Adopt a `useMutationWithFeedback` wrapper hook that automatically applies loading states to the triggering element.

---

### CUX-07: Toast Positioning Not M3-Compliant for Mobile

| Attribute | Detail |
|:---|:---|
| **Severity** | Medium |
| **M3 Guideline** | Snackbar — Placement |
| **Affected Component** | `src/components/Toast.tsx` |

**Current State:**
- Toasts appear at the **top-right** of the screen.
- M3 specifies Snackbars should appear at the **bottom-center** of the viewport on mobile, above the bottom navigation bar, and at the **bottom-left** on desktop.
- Top-positioned toasts can conflict with header bars and may not be visible if the user's attention is on the bottom of the screen (where most mobile actions originate).

**Recommendation:**
1. Reposition toasts to bottom-center on mobile viewports, with `bottom` offset calculated to clear the bottom navigation bar height plus `env(safe-area-inset-bottom)`.
2. On desktop, position at bottom-left per M3.
3. Ensure toasts are dismissible via swipe (mobile) and include an optional action button (M3 Snackbar anatomy).

---

### CUX-08: Dark Mode Glassmorphism Readability

| Attribute | Detail |
|:---|:---|
| **Severity** | Medium |
| **M3 Guideline** | Color System — Surface Tones, Dark Theme |

**Current State:**
- The "Liquid Glass" system uses `backdrop-filter: blur(20px)` with translucent backgrounds. In dark mode, the background shifts to `#293515` (Primary Green).
- Glassmorphism over complex or varied backgrounds can cause text readability issues when the underlying content shifts opacity.
- The `prefers-reduced-transparency` media query overrides are in place (a strong positive), but the default glass surfaces may still have variable contrast depending on scroll position and background content.

**Recommendation:**
1. Increase the minimum background opacity of glass surfaces in dark mode to ensure a guaranteed contrast floor (e.g., `bg-black/60` minimum rather than `bg-black/40`).
2. Add a subtle solid fallback border on glass cards to provide edge definition independent of backdrop content.
3. Test key screens with the "High Contrast" accessibility setting enabled on iOS/Android to verify readability.

---

## 2. M3 Component Opportunities

### M3-01: Segmented Buttons for Filter/View Mode Switching

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Segmented Button |
| **Current Pattern** | `TabButton.tsx` in flex row |
| **Affected Areas** | Book Golf view modes, Admin table filters, date range selectors |

**Current State:**
- The app uses `TabButton` components arranged horizontally for view switching (e.g., grid vs. list, date ranges). These function correctly but lack M3 Segmented Button anatomy: connected segments with shared container, icon+label support, checkmark on selection.

**Recommendation:**
1. Create a `SegmentedButton` component with M3 anatomy: shared outlined container, dividers between segments, and animated selection indicator (filled segment).
2. Use for 2-5 option selections where options are peer choices (not hierarchical tabs).
3. Retain current `TabButton` for true content tabs with panel association.

---

### M3-02: Extended FAB for Primary Member Actions

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Extended Floating Action Button |
| **Current Pattern** | Standard circular FAB (`56x56px`) |
| **Affected Areas** | Member booking flow, staff quick actions |

**Current State:**
- `FloatingActionButton.tsx` is a standard circular FAB with dynamic positioning. It displays only an icon.
- M3's Extended FAB adds a text label alongside the icon, improving discoverability for primary actions (e.g., "Book Simulator" instead of just a "+" icon).

**Recommendation:**
1. Implement an Extended FAB variant that shows icon + label on initial load, then collapses to icon-only on scroll (M3 behavior).
2. Use for the member portal's primary CTA ("Book Now" / "New Booking").
3. Ensure the collapse/expand transition uses the existing spring physics easing.

---

### M3-03: Search Bar Component (M3 Search)

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Search Bar / Search View |
| **Current Pattern** | Standard text input with search icon |
| **Affected Areas** | Member directory, event search, admin lookups |

**Current State:**
- Search functionality uses standard `Input` components with a prepended search icon.
- M3 Search Bar provides: (a) a docked search bar that expands to a full-screen search view on mobile, (b) search suggestions/history, and (c) trailing action icons (filter, voice).

**Recommendation:**
1. Create an M3-style `SearchBar` component with a pill-shaped container, leading search icon, trailing filter icon, and elevation on focus.
2. On mobile, expand to full-viewport search view with recent searches and suggestions.
3. Integrate with existing data-fetching hooks for debounced search-as-you-type.

---

### M3-04: Bottom Sheets for Complex Mobile Flows

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Bottom Sheet (Standard & Modal) |
| **Current Pattern** | `SlideUpDrawer.tsx` |

**Current State:**
- `SlideUpDrawer` provides a bottom sheet pattern with drag handle and backdrop. This is functionally aligned with M3.
- However, M3 distinguishes between **Standard** bottom sheets (non-modal, page content remains interactive) and **Modal** bottom sheets (with scrim, page content blocked).
- The current implementation appears to always use a modal pattern.

**Recommendation:**
1. Add a `variant` prop to `SlideUpDrawer`: `"modal"` (with backdrop scrim, focus trap) and `"standard"` (no scrim, content behind remains scrollable and interactive).
2. Use Standard bottom sheets for supplementary info (filter panels, quick details).
3. Use Modal bottom sheets for actions requiring a decision (booking confirmation, payment).

---

### M3-05: Navigation Rail for Tablet/Desktop Staff Portal

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Navigation Rail |
| **Current Pattern** | Full sidebar + mobile bottom nav |
| **Affected Areas** | Staff/Admin portal on medium-width screens |

**Current State:**
- Staff portal uses a full `StaffSidebar` on desktop and switches to `StaffBottomNav` / `StaffMobileSidebar` on mobile.
- There is no intermediate layout for tablet-sized screens (768px-1024px), where M3 recommends a **Navigation Rail** — a narrow vertical strip with icons and optional labels.

**Recommendation:**
1. Implement a `NavigationRail` component for the `md` breakpoint range.
2. Show icon + short label vertically stacked per M3 spec.
3. This reduces the sidebar's width consumption on tablets while keeping navigation visible (unlike the hamburger pattern).

---

### M3-06: Chips for Filters and Selections

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Filter Chip, Input Chip, Suggestion Chip |
| **Current Pattern** | Tags with `rounded-[4px]`, custom buttons |
| **Affected Areas** | Booking filters, member tags, event categories |

**Current State:**
- Tags/badges use `rounded-[4px] w-fit px-2 uppercase tracking-widest` — these are purely display elements.
- M3 Chips are interactive: Filter Chips toggle on/off, Input Chips can be dismissed, and Assist Chips trigger actions.

**Recommendation:**
1. Create a `Chip` component family: `FilterChip` (toggleable, shows checkmark when selected), `InputChip` (deletable, with trailing X), `AssistChip` (action trigger with leading icon).
2. Use Filter Chips for booking status filters, event category filters, and member directory filters.
3. Use Input Chips for multi-select scenarios (e.g., adding participants to a booking).

---

### M3-07: Align Existing ConfirmDialog with M3 Dialog Anatomy

| Attribute | Detail |
|:---|:---|
| **M3 Component** | Dialog (Basic & Full-screen) |
| **Current Pattern** | `ConfirmDialog.tsx` (well-built, role="alertdialog", focus trapping, variant system) |

**Current State:**
- A robust `ConfirmDialog` component already exists (`src/components/ConfirmDialog.tsx`) with `role="alertdialog"`, `aria-modal`, focus trapping, stacked z-index management, loading state, and three variants (danger/warning/info). This is well-implemented.
- The component uses filled buttons for the confirm action — M3 recommends **text buttons** for dialog actions (not filled/tonal) to reduce visual weight.
- M3 also distinguishes Full-screen Dialogs for complex mobile forms, which is not yet a pattern.

**Recommendation:**
1. Consider aligning `ConfirmDialog` button styling closer to M3: use text/tonal buttons instead of filled buttons for dialog actions.
2. For mobile multi-step forms, create a Full-screen Dialog variant with a top app bar containing "Close" (left) and "Save" (right) actions.
3. The existing `useConfirmDialog()` hook with promise-based resolution is excellent — retain this pattern.

---

## 3. Workflow / Architecture Improvements

### WF-01: Expand Optimistic UI Coverage

| Attribute | Detail |
|:---|:---|
| **Category** | Data Responsiveness |
| **Current Coverage** | Staff Command Center, Participant RSVP, Navigation tabs |
| **Missing Coverage** | Profile updates, notification preferences, booking creation, fee acknowledgments |

**Current State:**
- Optimistic updates are implemented in the Staff Command Center (`optimisticUpdateRef`) and participant management (`optimisticParticipants`). These are well-done with proper rollback on failure.
- However, member-facing mutations (profile edits, notification toggles, adding calendar events) appear to wait for server confirmation before reflecting changes.

**Recommendation:**
1. Wrap all TanStack Query mutations in an `onMutate` → `onError` rollback pattern for actions where the success outcome is highly predictable.
2. Priority targets: profile field updates, notification preference toggles, booking request submission (show "Pending" card immediately).
3. For booking creation, show an optimistic "Request Submitted" card in the member's schedule with a "pending" badge, replacing it with the real data on server confirmation.

---

### WF-02: Standardize Error Recovery Patterns

| Attribute | Detail |
|:---|:---|
| **Category** | Error Handling |
| **Current State** | Three error boundary levels (Global, Page, Feature) |
| **Gap** | Inconsistent retry/recovery UX across levels |

**Current State:**
- The three-tier error boundary system (Global → Page → Feature) is architecturally sound. The Global boundary tracks reload counts in `sessionStorage` to prevent infinite loops — excellent.
- `PageErrorBoundary` auto-handles Chunk Load Errors and has auto-retry countdown — excellent.
- However, the recovery UX is inconsistent: some show "Try Again" buttons, some auto-retry, and the styling may not match the Liquid Glass design system.

**Recommendation:**
1. Standardize all error boundary UIs to use a single `ErrorFallback` component with variants: `"page"` (full-screen centered), `"card"` (inline within a card), and `"inline"` (single-line with retry icon).
2. All variants should include: (a) a human-readable error message (no technical details), (b) a "Try Again" action, (c) a "Contact Support" fallback link.
3. Apply the Liquid Glass styling to error states for visual consistency.

---

### WF-03: Skeleton Loader Gap Analysis

| Attribute | Detail |
|:---|:---|
| **Category** | Loading States |
| **Current Coverage** | Dashboard, Events, Bookings, Schedule cards |
| **Missing Coverage** | Admin data tables, profile detail views, invoice/payment screens |

**Current State:**
- Skeleton loaders with `SkeletonCrossfade` (250ms transition) are well-implemented for primary member-facing screens.
- Admin screens, particularly data tables (member directory, transaction lists, invoice details), may fall back to basic spinner or empty-state patterns during loading.

**Recommendation:**
1. Create `TableSkeleton`, `DetailViewSkeleton`, and `InvoiceSkeleton` components that match the structure of their loaded counterparts.
2. Use `SkeletonCrossfade` consistently across all data-fetching views, including admin panels.
3. For tables, render skeleton rows with shimmering cells to maintain the visual column structure during load.

---

### WF-04: Mutation Error Messages Need Context

| Attribute | Detail |
|:---|:---|
| **Category** | Error Communication |
| **Current Pattern** | Generic toast: "Failed to update profile" |

**Current State:**
- Mutation error callbacks typically show `err.message || 'Failed to [action]'`.
- Backend errors may return technical messages (database constraint violations, timeout errors) that leak through to the toast.
- M3 recommends error messages that: (a) describe what happened in user terms, (b) suggest what to try next.

**Recommendation:**
1. Create an error message mapping layer that translates backend error codes/messages into user-friendly strings. Example: `UNIQUE_CONSTRAINT` → "This email is already in use. Please try a different one."
2. For network errors, show: "We couldn't reach the server. Check your connection and try again."
3. For unknown errors, show: "Something unexpected happened. Please try again, or contact support if the issue persists." with a "Contact Support" action on the toast.

---

### WF-05: Form State Persistence on Navigation

| Attribute | Detail |
|:---|:---|
| **Category** | Form UX |
| **Affected Areas** | Multi-step membership application, booking configuration, profile edits |

**Current State:**
- The membership application is a multi-step form. If a user navigates away mid-flow (accidental back button, link click), all entered data is lost.
- No "unsaved changes" warning dialog is implemented.

**Recommendation:**
1. Implement `beforeunload` and React Router's navigation blocking (`useBlocker`) to warn users about unsaved form data.
2. For multi-step forms, persist intermediate state to `sessionStorage` so users can resume where they left off.
3. Show an M3-style Dialog: "You have unsaved changes. Discard changes?" with "Discard" and "Keep Editing" actions.

---

### WF-06: Extend Existing Prefetch System to Detail Views

| Attribute | Detail |
|:---|:---|
| **Category** | Perceived Performance |
| **Current Pattern** | Route-level prefetching exists (`src/lib/prefetch.ts`) for code-splitting and adjacent API calls |

**Current State:**
- A well-structured prefetch system already exists in `src/lib/prefetch.ts`. It handles: (a) route code-splitting prefetch via lazy imports, (b) adjacent API data prefetch (e.g., navigating to `/book` also fetches `/api/bays`), (c) idle-time prefetch of all nav routes via `requestIdleCallback`, and (d) separate staff portal prefetch routes.
- The Command Center uses `placeholderData: keepPreviousData` to prevent flicker during refetches.
- **Gap:** The prefetch system covers page-level navigation but not **detail-level** prefetching (e.g., hovering over a booking card to prefetch that booking's detail data, or prefetching the next page of a paginated list).

**Recommendation:**
1. Extend the existing prefetch architecture to support `queryClient.prefetchQuery()` on hover/focus for detail views (booking details, member profiles).
2. For paginated lists, prefetch the next page when the user scrolls near the bottom.
3. The existing `prefetchRoute` / `prefetchAdjacentRoutes` pattern is excellent — document it as a standard for new routes.

---

### WF-07: Extend Offline/Connection Indicator to Cover Realtime Drops

| Attribute | Detail |
|:---|:---|
| **Category** | Real-time Reliability |

**Current State:**
- Supabase Realtime subscriptions are used for `notifications`, `booking_sessions`, `announcements`, and `trackman_unmatched_bookings`.
- The system has `eventsPerSecond: 100` throttling and reconnect jitter — both excellent.
- An `OfflineBanner` component (`src/components/OfflineBanner.tsx`) already exists and monitors `navigator.onLine`, showing "You're offline. Showing your last available data." — good.
- **Gap:** The `OfflineBanner` only detects full network loss. It does not detect when the Supabase WebSocket connection specifically drops while the browser remains "online" (e.g., server restart, WebSocket timeout). Staff could be looking at stale data without knowing.

**Recommendation:**
1. Extend the `OfflineBanner` (or add a sibling `ConnectionStatusBanner`) to also monitor the Supabase Realtime channel state. When the channel enters `CHANNEL_ERROR` or `TIMED_OUT` status, show: "Live updates paused. Reconnecting..."
2. On reconnection, trigger a cache invalidation of all realtime-dependent queries to ensure data freshness.
3. Consider a subtle header dot indicator (green/amber) for staff portal to communicate connection health at a glance.

---

### WF-08: Unified Mutation Feedback Hook

| Attribute | Detail |
|:---|:---|
| **Category** | Developer Experience / Consistency |

**Current State:**
- Each mutation independently implements its own success/error toast, loading state management, and optimistic update logic. This leads to inconsistency (some mutations show toasts, some don't; some have loading indicators, some don't).

**Recommendation:**
1. Create a `useAppMutation` wrapper around `useMutation` that provides:
   - Automatic success toast with configurable message.
   - Automatic error toast with user-friendly error mapping (see WF-04).
   - Automatic loading state on the triggering element.
   - Optional optimistic update with rollback.
   - Optional haptic feedback on success/error.
2. Migrate all existing mutations to this wrapper for consistent behavior app-wide.
3. Example API:
   ```ts
   const mutation = useAppMutation({
     mutationFn: updateProfile,
     successMessage: "Profile updated",
     optimisticUpdate: { queryKey: ['profile'], updater: (old, vars) => ({...old, ...vars}) },
   });
   ```

---

## 4. What's Already Working Well

The audit identified numerous areas where the codebase exceeds typical standards:

| Area | Strength |
|:---|:---|
| **Skeleton Loaders** | Domain-specific skeletons with `SkeletonCrossfade` (250ms) — premium loading UX. |
| **Error Boundaries** | Three-tier system (Global/Page/Feature) with reload-loop protection and chunk-error auto-recovery. |
| **Touch Targets** | Consistently 44-48px minimum across all interactive elements. FAB at 56px. |
| **Haptic Feedback** | Integrated haptic utility with directional feedback on gestures. |
| **Accessibility Foundations** | `role="dialog"`, `aria-modal`, focus trapping, `aria-label` on nav elements, `prefers-reduced-transparency` overrides. |
| **Real-time Architecture** | WebSocket-driven cache invalidation (no polling), reconnect jitter, `eventsPerSecond` throttling. |
| **Gesture System** | `SwipeableListItem` with elastic resistance, direction locking, and threshold-based haptics. |
| **Empty States** | Dedicated `EmptyState` component with `default` and `compact` variants, animated entry, optional CTA. |
| **Spring Physics** | CSS-based spring easing (`cubic-bezier(0.34, 1.56, 0.64, 1)`) — performant, no JS runtime cost. |
| **Motion System** | Staggered list reveals, tab transitions, page animations — all CSS-driven for performance. |
| **Typography** | Cohesive 4-role token system (`display`, `headline`, `body`, `label`) with optical adjustments. |
| **Safe Areas** | Proper `env(safe-area-inset-*)` handling on all navigation elements. |
| **Optimistic Navigation** | Bottom nav and sidebar show active state immediately, before page loads. |
| **Route Prefetching** | Comprehensive `prefetch.ts` with route code-splitting, adjacent API prefetch, idle-time warming, and separate staff portal coverage. |
| **ConfirmDialog** | Promise-based `useConfirmDialog()` hook with `role="alertdialog"`, focus trapping, z-index stacking, loading state, and danger/warning/info variants. |
| **Offline Detection** | `OfflineBanner` monitors `navigator.onLine` and shows a clear banner when the network drops. |

---

## 5. Priority Roadmap

### Phase 1: Accessibility & Critical Fixes (1-2 Sprints)

| ID | Task | Impact |
|:---|:---|:---|
| CUX-01 | Fix Accent color contrast failures | Accessibility compliance |
| CUX-02 | Audit and fix focus indicator suppression | Keyboard navigation |
| CUX-03 | Standardize form validation (inline errors everywhere) | User trust, data quality |
| CUX-05 | Audit icon-only buttons for `aria-label` | Screen reader support |
| CUX-07 | Reposition toasts to bottom on mobile | Mobile usability |

### Phase 2: Interaction & Component Polish (2-3 Sprints)

| ID | Task | Impact |
|:---|:---|:---|
| CUX-04 | Add dragged state visuals to gesture components | Interaction clarity |
| CUX-06 | Add loading indicators to inline mutations | Perceived reliability |
| M3-01 | Build Segmented Button component | Filter UX |
| M3-06 | Build Chip component family | Selection and filter patterns |
| M3-07 | Align ConfirmDialog buttons to M3 text-button style | Dialog polish |
| WF-08 | Create `useAppMutation` unified hook | Developer consistency |
| WF-04 | Implement error message mapping layer | User-friendly errors |

### Phase 3: Architecture & Advanced Patterns (3-4 Sprints)

| ID | Task | Impact |
|:---|:---|:---|
| M3-02 | Extended FAB with scroll collapse | Primary action discoverability |
| M3-03 | M3 Search Bar with mobile expansion | Search experience |
| M3-04 | Bottom Sheet standard/modal variants | Mobile interaction depth |
| M3-05 | Navigation Rail for tablets | Tablet layout optimization |
| WF-01 | Expand optimistic UI coverage | Perceived performance |
| WF-02 | Standardize error recovery fallback UI | Visual consistency |
| WF-03 | Complete skeleton loader coverage for admin | Admin UX parity |
| WF-05 | Form state persistence + unsaved changes warning | Data loss prevention |
| WF-06 | Extend prefetch system to detail-level views | Navigation speed |
| WF-07 | Extend offline indicator to cover WebSocket drops | Staff data trust |
| CUX-08 | Dark mode glass readability improvements | Dark mode quality |

---

*End of Audit Report*

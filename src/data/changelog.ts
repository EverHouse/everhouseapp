export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  isMajor?: boolean;
  changes: string[];
}

export function getLatestVersion(): { version: string; date: string } {
  const latest = changelog[0];
  return { version: latest.version, date: latest.date };
}

export const changelog: ChangelogEntry[] = [
  {
    version: "69.21.0",
    date: "2026-02-04",
    title: "View-As Mode Dashboard Fix",
    changes: [
      "Fixed: Member dashboard now shows correct data when staff uses 'View as member' mode",
      "Fixed: Pending booking requests now visible in member portal when viewing as a specific member"
    ]
  },
  {
    version: "69.20.0",
    date: "2026-02-04",
    title: "Reschedule Feature Removal & Anti-Spam",
    changes: [
      "Removed: Staff reschedule functionality - all booking changes now done via cancel + create new",
      "Added: Members limited to 1 pending booking request per resource type (simulator or conference room)",
      "Added: Staff bypass this limit when creating bookings on behalf of members",
      "Cleanup: Removed unused reschedule code from booking endpoints"
    ]
  },
  {
    version: "69.18.0",
    date: "2026-02-04",
    title: "Notice Description Field",
    changes: [
      "Added: Description text field to Notice edit form for adding details about closures and announcements"
    ]
  },
  {
    version: "69.17.0",
    date: "2026-02-04",
    title: "Auto-Approve & Booking Query Fixes",
    changes: [
      "Fixed: Trackman auto-approve now correctly fetches all participants (guests were being dropped due to invalid SQL)",
      "Fixed: Member bookings list now correctly shows bookings where member is a participant (query was failing silently)"
    ]
  },
  {
    version: "69.16.0",
    date: "2026-02-04",
    title: "Security: XSS Prevention",
    changes: [
      "Security: Tour booking form inputs now sanitized before passing to HubSpot calendar (prevents XSS attacks)",
      "Security: External script URLs now use explicit HTTPS protocol (prevents potential MITM attacks)"
    ]
  },
  {
    version: "69.15.0",
    date: "2026-02-04",
    title: "Reschedule, Pause & Duplicate Guest Fixes",
    changes: [
      "Fixed: Rescheduling bookings no longer blocked by daily limit - original booking excluded from calculation",
      "Fixed: Paused Stripe subscriptions now properly update member status (closes free access loophole)",
      "Fixed: Duplicate guests in booking requests now deduplicated (prevents double guest fees)"
    ]
  },
  {
    version: "69.14.0",
    date: "2026-02-04",
    title: "Invoice Identity & Webhook Race Condition Fixes",
    changes: [
      "Fixed: Membership renewals now use Stripe customer ID (not email) to identify users - prevents renewal failures when members change their email",
      "Fixed: Trackman unmatched bookings now use atomic upsert to prevent duplicate records from simultaneous webhook retries"
    ]
  },
  {
    version: "69.13.0",
    date: "2026-02-04",
    title: "Tier Validation, Calendar Sync & Notification Reliability Fixes",
    changes: [
      "Fixed: Future bookings automatically cancelled when member downgrades to a tier with shorter booking window (closes tier exploit)",
      "Fixed: Failed calendar deletions now flag bookings with sync error so staff can clear 'zombie slots' on Google Calendar",
      "Fixed: Auto-match now tracks retry attempts - bookings that fail 5 times marked for manual review (prevents infinite retry loop)",
      "Fixed: Push notifications no longer sent if database insert fails (prevents 'ghost' notifications with no app record)"
    ]
  },
  {
    version: "69.12.0",
    date: "2026-02-04",
    title: "Anonymous Guest Fees, Auto-Approve & Conflict Detection Fixes",
    changes: [
      "Fixed: Anonymous guest fees now charged when declared player count exceeds identified participants (closes revenue loophole)",
      "Fixed: Auto-approve via Trackman now copies all guests from booking to session (guest fees properly generated)",
      "Fixed: Staff invite payment now immediately invalidates cache (member sees active status without delay)",
      "Fixed: Conflict detection now catches cross-midnight bookings from the previous day",
      "Improved: Data integrity checks now show sampling info (e.g., 'Checked 100 of 500 members')"
    ]
  },
  {
    version: "69.11.0",
    date: "2026-02-04",
    title: "Booking Visibility, Tier Sync & Pass Protection Fixes",
    changes: [
      "Fixed: Members added via Trackman or Session Manager now appear correctly in their booking dashboard (was invisible due to table migration)",
      "Fixed: Day passes no longer 'burned' if session creation fails - error thrown instead of silently consuming pass",
      "Fixed: Day pass matching now uses Pacific timezone for evening purchases (9PM Pacific = same day, not next day)",
      "Fixed: Membership tier downgrades now apply correctly - Stripe is source of truth (was keeping old tier due to COALESCE bug)"
    ]
  },
  {
    version: "69.10.0",
    date: "2026-02-04",
    title: "Guest Pass & Webhook Reliability Fixes",
    changes: [
      "Fixed: Guest pass holds now properly block bookings when passes are insufficient (closes 'pay later' loophole)",
      "Fixed: Live Trackman sessions stay 'approved' even when conflicts detected (prevents staff from accidentally declining active sessions)",
      "Fixed: Notification failures for unregistered emails now log warnings and attempt email fallback",
      "Improved: Conflict detection adds 'NEEDS REVIEW' flag instead of blocking live sessions"
    ]
  },
  {
    version: "69.9.0",
    date: "2026-02-04",
    title: "Booking & Billing Accuracy Fixes",
    changes: [
      "Fixed: Same-user split billing loophole - overage fees now calculated correctly when same user appears in multiple slots",
      "Fixed: Pre-paid session packs no longer count against daily minutes (prevents double-billing)",
      "Fixed: Group bookings now correctly calculate per-player minutes when checking daily limits",
      "Fixed: Trackman webhook now adopts existing unmatched bookings instead of creating duplicates",
      "Improved: Clearer error messages show per-player allocation for group bookings"
    ]
  },
  {
    version: "69.8.0",
    date: "2026-02-04",
    title: "Billing, Security & Data Integrity Fixes",
    changes: [
      "Fixed: Usage ledger now correctly records both guest fees AND usage minutes (prevents lost revenue)",
      "Fixed: Guest name matching no longer blocks guests with similar names to host (e.g., 'Johnson' vs 'John')",
      "Fixed: Deactivated staff no longer receive sensitive push notifications (security fix)",
      "Fixed: Late cancellations now properly charge the cancellation fee instead of releasing payment holds",
      "Improved: Better logging for late cancellation payment captures"
    ]
  },
  {
    version: "69.7.0",
    date: "2026-02-04",
    title: "Critical Stripe Webhook Security Fixes",
    changes: [
      "Fixed: Cancelling an add-on subscription (like locker rental) no longer cancels entire membership",
      "Fixed: Tier matching now uses exact product name matching instead of loose keyword matching (security improvement)",
      "Fixed: Booking button now waits for fee calculation to complete before enabling (prevents surprise billing)",
      "Fixed: Stripe invoice payments for add-ons no longer overwrite billing_provider for Mindbody members",
      "Improved: Better logging distinguishes membership vs add-on subscription events"
    ]
  },
  {
    version: "69.6.0",
    date: "2026-02-04",
    title: "Critical Bug Fixes: Cache, Refunds & UI",
    changes: [
      "Fixed: Member data cache now properly invalidates when Stripe webhooks update tier or membership status",
      "Fixed: Full refunds issued via Stripe Dashboard now automatically cancel the booking (prevents 'free play' loophole)",
      "Fixed: Switching between Simulator and Conference tabs now properly clears the selected time slot",
      "Improved: Refund notifications now clearly indicate if booking was cancelled due to full refund",
      "Improved: Booking sessions with all participants refunded are now automatically cancelled"
    ]
  },
  {
    version: "69.5.3",
    date: "2026-02-03",
    title: "Golf Bay Booking Touch Handling Fix",
    changes: [
      "Fixed: Time slot and accordion buttons now properly capture touch events to prevent accidental navigation",
      "Improved: Added touch event isolation to prevent taps from bubbling to bottom navigation",
      "Improved: Better iOS touch handling with manipulation mode and tap highlight removal"
    ]
  },
  {
    version: "69.5.2",
    date: "2026-02-03",
    title: "Golf Bay Booking Form Stability Fix",
    changes: [
      "Fixed: Booking form validation no longer locks the submit button if guest email is invalid",
      "Improved: Added explicit button types to all booking page buttons for better browser behavior",
      "Improved: Time slot, duration, and player count buttons now properly marked as type='button'"
    ]
  },
  {
    version: "69.5.1",
    date: "2026-02-03",
    title: "Data Integrity Check Reliability Improvement",
    changes: [
      "Fixed: One failing data integrity check no longer crashes all other checks",
      "New: Failed checks now show 'error' status with purple badge instead of crashing the page",
      "New: Staff receive alerts when integrity checks fail to run (database/API errors)",
      "Improved: Data Integrity page is more resilient to temporary connection issues"
    ]
  },
  {
    version: "69.5.0",
    date: "2026-02-03",
    title: "Notice Description Syncs to Google Calendar",
    changes: [
      "New: Description field in Edit Notice form now syncs to Google Calendar event",
      "New: Staff can add custom notes that appear below the auto-generated metadata",
      "Improved: Description field placeholder clarifies it shows on Internal Calendar"
    ]
  },
  {
    version: "69.4.0",
    date: "2026-02-03",
    title: "Conference Room Booking Improvements",
    changes: [
      "New: Conference room bookings now have dedicated confirmation flow",
      "New: Manual confirm button allows staff to approve without waiting for calendar sync",
      "New: Check Calendar button verifies if MindBody booking shows on Google Calendar",
      "Improved: Calendar events auto-link to existing confirmed bookings when sync runs"
    ]
  },
  {
    version: "69.3.7",
    date: "2026-02-03",
    title: "Assign Players Bug Fix",
    changes: [
      "Fixed: Assign players to booking feature now works correctly",
      "Fixed: SQL query generation issue when updating staff notes",
      "Improved: Better error logging for booking assignment failures"
    ]
  },
  {
    version: "69.3.6",
    date: "2026-02-03",
    title: "HubSpot Status Sync Fix",
    changes: [
      "Fixed: HubSpot membership status sync now uses valid status values",
      "Fixed: Statuses like 'Inactive' replaced with proper HubSpot options (Suspended, Expired, etc.)",
      "Improved: All app statuses now correctly map to HubSpot dropdown options"
    ]
  },
  {
    version: "69.3.5",
    date: "2026-02-03",
    title: "Orphaned Booking Participant Fix",
    changes: [
      "Fixed: Deleted 9 orphaned test booking participants referencing non-existent users",
      "Fixed: Member deletion now properly unlinks booking participants (marks as guests)",
      "Fixed: Member anonymization now also unlinks booking participants",
      "Improved: These orphan errors will no longer occur in production"
    ]
  },
  {
    version: "69.3.4",
    date: "2026-02-03",
    title: "MindBody Data Quality Check Improvement",
    changes: [
      "Fixed: MindBody Data Quality check now only flags active members missing a tier",
      "Fixed: Inactive members (terminated, expired, declined) no longer show in this check"
    ]
  },
  {
    version: "69.3.3",
    date: "2026-02-03",
    title: "HubSpot Billing Source Sync Improvement",
    changes: [
      "Fixed: When staff changes billing provider, membership status now syncs to HubSpot too",
      "Fixed: This ensures HubSpot reflects app's status even if MindBody shows cancelled"
    ]
  },
  {
    version: "69.3.2",
    date: "2026-02-03",
    title: "MindBody Member Billing Separation",
    changes: [
      "Changed: MindBody members can add a payment method for overage fees without requesting migration",
      "Changed: Only staff can migrate MindBody members to Stripe subscription billing",
      "Changed: Member billing messaging now focuses on overage fees, not migration"
    ]
  },
  {
    version: "69.3.1",
    date: "2026-02-03",
    title: "Account Balance in Profile Drawer",
    changes: [
      "Added: Staff can now see member account balance directly in the Directory profile drawer",
      "Added: Staff can apply credits to members from the profile drawer (no need to go to Billing tab)",
      "Fixed: HubSpot sync now sets lifecycle stage to 'member' for active members"
    ]
  },
  {
    version: "69.3.0",
    date: "2026-02-03",
    title: "Team Page Moved to Admin",
    changes: [
      "Changed: 'Team' renamed to 'Manage Team' and moved to Admin section",
      "Changed: Manage Team is now only visible to admins, not regular staff"
    ]
  },
  {
    version: "69.2.9",
    date: "2026-02-03",
    title: "MindBody Integrity Checks Added",
    changes: [
      "Added: MindBody Stale Sync check - finds active MindBody members with stale records (30+ days unchanged)",
      "Added: MindBody Data Quality check - finds members missing MindBody ID or tier",
      "Removed: Stale Past Tours check (not needed)",
      "Removed: Duplicate Tour Sources check (not needed)"
    ]
  },
  {
    version: "69.2.8",
    date: "2026-02-03",
    title: "Data Integrity Billing Provider Filters",
    changes: [
      "Fixed: Stripe Subscription Sync now correctly excludes MindBody/family/comped members",
      "Fixed: Tier Reconciliation check excludes non-Stripe-billed members",
      "Fixed: Stuck Transitional Members check excludes non-Stripe-billed members",
      "Fixed: Preview no longer shows 450 false mismatches for MindBody-billed members"
    ]
  },
  {
    version: "69.2.7",
    date: "2026-02-03",
    title: "Data Integrity Sync Fix",
    changes: [
      "Fixed: HubSpot sync push/pull now works correctly from Data Integrity page",
      "Fixed: 'issue_key is required' error no longer appears when syncing"
    ]
  },
  {
    version: "69.2.6",
    date: "2026-02-03",
    title: "Session Backfill Matches on Start Time",
    changes: [
      "Fixed: Backfill now matches sessions by start time only (not exact duration)",
      "Fixed: Bookings with different durations than actual sessions now link correctly",
      "Example: A 14:00-19:00 booking request now links to a 14:00-18:00 session"
    ]
  },
  {
    version: "69.2.5",
    date: "2026-02-03",
    title: "Session Backfill Links Existing Sessions",
    changes: [
      "Fixed: Bookings that match an existing session are now linked instead of failing",
      "Fixed: 'Double-booking' errors no longer occur - backfill finds and links to matching sessions",
      "Improved: Response shows count of newly created vs linked to existing sessions"
    ]
  },
  {
    version: "69.2.4",
    date: "2026-02-03",
    title: "Session Backfill Resilience",
    changes: [
      "Fixed: Session backfill now continues processing even when individual bookings fail",
      "Fixed: One problematic booking no longer stops the entire batch from being processed",
      "Fixed: Uses database savepoints to isolate failures and maximize successful session creation"
    ]
  },
  {
    version: "69.2.3",
    date: "2026-02-03",
    title: "Session Backfill Fix",
    changes: [
      "Fixed: 'Create Sessions' button now processes all bookings without sessions (was missing 'confirmed' status)",
      "Fixed: Session backfill now includes approved, attended, AND confirmed bookings",
      "Fixed: Preview count now matches actual bookings that will be processed"
    ]
  },
  {
    version: "69.2.2",
    date: "2026-02-03",
    title: "MindBody Member Credits Fix",
    changes: [
      "Fixed: Staff can now apply Stripe credits to MindBody-billed members",
      "Fixed: Credit application no longer restricted to Stripe-billing-only members",
      "Improved: Any member with a Stripe customer ID (or who can have one created) can now receive credits"
    ]
  },
  {
    version: "69.2.1",
    date: "2026-02-03",
    title: "Check-In Date Display Fix",
    changes: [
      "Fixed: 'Invalid Date' no longer appears in check-in billing modal for external bookings",
      "Fixed: Date formatting now properly handles ISO timestamps with timezone info",
      "Fixed: Same date parsing issue resolved across BookingMembersEditor, ManagePlayersModal, and CompleteRosterModal"
    ]
  },
  {
    version: "69.2.0",
    date: "2026-02-03",
    title: "Guest Pass Atomicity Hardening",
    changes: [
      "Fixed: Guest pass deduction now happens inside same database transaction as session creation",
      "Fixed: Both booking request flow (holds conversion) and staff/trackman flow (direct deduction) are now atomic",
      "Fixed: Passes now verified before deduction - insufficient passes fail the booking instead of allowing free sessions",
      "Technical: Uses FOR UPDATE row locking to prevent concurrent access issues"
    ]
  },
  {
    version: "69.1.0",
    date: "2026-02-03",
    title: "Critical Billing Accuracy Fixes",
    changes: [
      "Fixed: Fee estimates now match actual charges - declared player count used consistently in billing",
      "Fixed: All session minutes now billed correctly - remainder minutes distributed fairly instead of lost",
      "Fixed: Guest pass deduction now properly fails booking if passes unavailable (with automatic compensation on session creation failure)",
      "Fixed: Adding member to billing group now checks existing group membership - prevents silent removal from family plans"
    ]
  },
  {
    version: "69.0.0",
    date: "2026-02-03",
    title: "Security Hardening & Bug Fix Release",
    isMajor: true,
    changes: [
      "Removed: Reschedule feature - members now cancel and request new bookings (prevents limit bypass exploit)",
      "Security: Fixed OTP replay race condition - magic links can only be used once",
      "Security: Fixed guest pass double-spend - passes are now reserved atomically during booking",
      "Security: Added 1-hour cancellation policy - no refunds for late cancellations",
      "Fixed: Members added by email no longer charged as guests - system now looks up existing accounts",
      "Fixed: Event RSVPs now enforce capacity limits - no more overbooking",
      "Fixed: Wellness waitlist race condition - concurrent cancellations now promote correct users",
      "Fixed: Day pass refunds now actually refund money to customers (not just database status)",
      "Fixed: Failed subscription DB updates now roll back Stripe charges",
      "Fixed: Bulk tier updates now run in background - no more timeouts for large updates",
      "Fixed: Deleted members now have sessions cleared - no stale logins",
      "Fixed: Cross-midnight bookings handled correctly in Trackman webhooks",
      "Fixed: Event time updates are now atomic - no availability gaps",
      "Improved: Admin page subtabs now saved in URL - shareable links work correctly"
    ]
  },
  {
    version: "68.0.0",
    date: "2026-02-03",
    title: "Comprehensive Performance & Responsiveness Overhaul",
    isMajor: true,
    changes: [
      "Fixed: Wellness page crash/reload loop - now loads smoothly every time",
      "Fixed: Directory page slow loading - now uses incremental loading for large member lists",
      "Fixed: WebSocket reconnection loops during navigation - now maintains single connection per session",
      "Fixed: Navigation delays and blank screens - pages now render immediately with loading placeholders",
      "Fixed: All navigation (bottom nav, sidebar, mobile menu) now highlights immediately when tapped",
      "Added: Staff portal now prefetches adjacent pages for faster navigation",
      "Improved: Admin tabs (Tiers, Trackman, Tours, Events) now show skeleton placeholders instead of blocking spinners",
      "Improved: Public pages (Landing, Gallery) load faster with optimized images",
      "Removed: 133 lines of unused loading code from Gallery page"
    ]
  },
  {
    version: "67.10.0",
    date: "2026-02-03",
    title: "Cancellation Handling & Audit Trail",
    changes: [
      "New: Staff tier assignments now appear in Staff Activity feed (audit logging)",
      "New: When membership is cancelled, HubSpot deal moves from Won to Lost",
      "New: Cancelled members have deal line items removed from HubSpot",
      "Note: Works for both Stripe and MindBody-billed members"
    ]
  },
  {
    version: "67.9.0",
    date: "2026-02-03",
    title: "Stripe Subscription Tier Sync",
    changes: [
      "New: Stripe subscription changes now update HubSpot deal line items (Stripe-billed members only)",
      "New: Stripe webhook tier sync queues for retry on HubSpot failures (Stripe-billed only)",
      "Note: MindBody-billed members are unaffected - use staff tier assignment in member profile"
    ]
  },
  {
    version: "67.8.0",
    date: "2026-02-03",
    title: "Tier Sync Reliability",
    changes: [
      "Fixed: HubSpot sync failures now queue for automatic retry instead of being lost",
      "Fixed: First-time tier assignments correctly show 'None' as previous tier (not 'Social')",
      "Fixed: Rapid tier changes no longer get out of order - improved sync deduplication",
      "Improved: Auto-fix now prefers primary user's tier when copying from linked emails",
      "Improved: Falls back to most recently updated alternate email tier if no primary"
    ]
  },
  {
    version: "67.7.0",
    date: "2026-02-03",
    title: "Staff Tier Assignment",
    changes: [
      "New: Staff can now assign tiers directly in the app for MindBody-billed members without a tier",
      "New: Yellow warning appears on member profile when no tier is assigned",
      "Improved: App is source of truth for tiers - removed HubSpot pull, tier changes sync from app to HubSpot"
    ]
  },
  {
    version: "67.6.0",
    date: "2026-02-03",
    title: "Tier Data Automation",
    changes: [
      "New: Member creation now requires a valid tier - prevents members from being created without tier assignment",
      "New: Real-time HubSpot sync - tier changes now queue immediately to HubSpot instead of waiting for batch sync",
      "New: Scheduled auto-fix runs every 4 hours - automatically copies tiers from alternate emails (same HubSpot ID)",
      "Improved: Visitor records automatically upgrade to member when assigned a tier"
    ]
  },
  {
    version: "67.5.0",
    date: "2026-02-02",
    title: "Data Integrity Cleanup",
    changes: [
      "Fixed: 7 members missing tier now have tier copied from their alternate email or pulled from HubSpot",
      "Added: Script to safely pull missing tiers from HubSpot (skips unknown tiers to prevent data corruption)"
    ]
  },
  {
    version: "67.4.0",
    date: "2026-02-02",
    title: "HubSpot Tier Sync Safety",
    changes: [
      "Fixed: Unknown/unrecognized tiers now safely skip HubSpot updates instead of setting incorrect values",
      "Fixed: HubSpot contact/deal creation now builds properties conditionally to prevent empty tier fields",
      "Added: Group Lessons tier support for HubSpot sync",
      "Improved: Consistent null handling across all HubSpot tier sync points"
    ]
  },
  {
    version: "67.3.0",
    date: "2026-02-02",
    title: "HubSpot Tier Sync Improvements",
    changes: [
      "Improved: App is now source of truth for membership tiers - tier data pushed to HubSpot uses standardized format",
      "Improved: Tier names normalized when syncing to HubSpot (e.g., 'Core' becomes 'Core Membership', founding member variations simplified)",
      "Fixed: Removed orphaned Stripe customer IDs for deleted Stripe customers",
      "Fixed: Data integrity check now correctly excludes MindBody-billed members from Stripe sync warnings"
    ]
  },
  {
    version: "67.2.0",
    date: "2026-02-02",
    title: "Page Load Performance Boost",
    changes: [
      "Performance: Dashboard now loads all data in a single request instead of 9 separate calls - significantly faster initial load",
      "Performance: Dashboard data cached for 5 minutes - returning to the dashboard is now instant",
      "Performance: Navigation prefetching improved - data starts loading when you hover over menu items",
      "Fixed: Stripe subscription sync check now properly excludes MindBody-billed members"
    ]
  },
  {
    version: "67.1.0",
    date: "2026-02-02",
    title: "Accessibility & UX Improvements",
    changes: [
      "Accessibility: Added descriptive alt text to all images across the app (WCAG compliance)",
      "New: Unified Button component with primary, secondary, danger, and ghost variants",
      "New: Breadcrumb navigation component for improved admin page hierarchy",
      "Improved: Keyboard focus indicators added to TabButton and interactive elements",
      "Fixed: Modal content now properly visible on small mobile screens (was cut off)",
      "Improved: Theme color system expanded with primary and bone color variants"
    ]
  },
  {
    version: "67.0.0",
    date: "2026-02-02",
    title: "Security Hardening Update",
    isMajor: true,
    changes: [
      "Security: Added authorization checks to member profile endpoints - users can only view their own profile unless staff/admin",
      "Security: Implemented rate limiting on checkout and member lookup endpoints to prevent abuse",
      "Security: Added Zod input validation for checkout requests to prevent malformed data",
      "Security: Standardized session access patterns across all API routes for consistent authentication",
      "Security: Enhanced audit logging for corporate checkout pricing calculations",
      "Improved: All sensitive operations now log unauthorized access attempts for security monitoring"
    ]
  },
  {
    version: "66.4.0",
    date: "2026-02-02",
    title: "Safari Toolbar Color Fix",
    changes: [
      "Fixed: Safari toolbar now respects device theme mode (light bone in light mode, dark in dark mode)",
      "Preserved: Green loading screen with white mascot unchanged"
    ]
  },
  {
    version: "66.3.0",
    date: "2026-02-02",
    title: "Safari Toolbar Fix",
    changes: [
      "Fixed: Green loading screen no longer appears between page navigations (only shows on initial app startup)",
      "Fixed: Safari toolbar should no longer flash green when switching pages",
      "Improved: Page transitions are now instant without any loading overlay"
    ]
  },
  {
    version: "66.2.0",
    date: "2026-02-02",
    title: "Notification System Fixes",
    changes: [
      "Fixed: Notifications no longer reappear as unread after marking all as read and returning to the page",
      "Fixed: Wellness confirmation notifications are now automatically removed when you cancel your enrollment",
      "Improved: Cleaner notification history without stale or outdated entries"
    ]
  },
  {
    version: "66.1.0",
    date: "2026-02-02",
    title: "Member Navigation Polish",
    changes: [
      "Fixed: Removed jarring green loading screen flash when switching between tabs in member portal",
      "Improved: Bottom navigation now switches instantly between Home, Book, Wellness, Events, and History"
    ]
  },
  {
    version: "66.0.0",
    date: "2026-02-02",
    title: "Animation System Enhancements",
    isMajor: true,
    changes: [
      "New: Smooth tab transition animations when switching between admin tabs",
      "New: Animated success checkmark component for visual confirmation",
      "New: Notification badge now pulses to draw attention to unread items",
      "New: Animated counters for metrics - numbers animate when values change",
      "New: Card removal animations - items slide out smoothly when deleted",
      "New: Standardized skeleton loading shimmer effects across all pages",
      "New: Confetti celebration component for achievements and milestones"
    ]
  },
  {
    version: "65.0.0",
    date: "2026-02-02",
    title: "UX/UI Polish & Accessibility Improvements",
    isMajor: true,
    changes: [
      "Improved: Consistent empty state designs across all pages (no more plain 'No results found' text)",
      "Improved: All submit buttons now show loading spinners while processing",
      "Improved: Touch targets meet accessibility standards (minimum 44x44 pixels)",
      "Improved: Better confirmation feedback with toast notifications for key actions",
      "Improved: Form validation errors are now more visible with red borders and icons",
      "Improved: Staff modals show success/error toasts when adding players or creating bookings"
    ]
  },
  {
    version: "64.2.0",
    date: "2026-02-02",
    title: "Security & Data Integrity Improvements",
    changes: [
      "Security: Login rate limiting now blocks requests when the database is unavailable (prevents abuse during outages)",
      "Fixed: Roster changes (adding/removing players) now use proper database transactions to prevent partial updates",
      "Fixed: If something fails while adding a player, all changes are now properly rolled back",
      "Improved: Booking member records are now part of the same transaction as participant changes"
    ]
  },
  {
    version: "64.1.0",
    date: "2026-02-02",
    title: "Bug Fixes: Guest Passes, Notifications & Check-in",
    changes: [
      "Fixed: Guest pass lookups now work correctly regardless of email capitalization (e.g., John@Email.com vs john@email.com)",
      "Fixed: Staff can now mark individual notifications as read for members they're helping (consistent with bulk actions)",
      "Fixed: Check-in system no longer creates duplicate participant records if called multiple times",
      "Fixed: Guest pass refunds now correctly match records regardless of email case"
    ]
  },
  {
    version: "64.0.0",
    date: "2026-02-02",
    title: "Corporate Volume Pricing & 30-Day Cancellation Notice",
    isMajor: true,
    changes: [
      "New: Corporate memberships now use tiered volume pricing - larger teams get lower per-seat rates",
      "New: Volume tiers: $350/seat (1-4), $325/seat (5-9), $299/seat (10-19), $275/seat (20-49), $249/seat (50+)",
      "New: Subscription prices automatically adjust when employees are added or removed",
      "New: 30-day notice period for membership cancellations - cancellation takes effect 30 days after request or at billing period end (whichever is later)",
      "New: Members can request cancellation from their billing page with optional reason",
      "New: Staff are automatically notified when members request cancellation",
      "New: Staff can undo pending cancellations if members change their mind",
      "New: Cancellation status now visible in member billing info"
    ]
  },
  {
    version: "63.7.0",
    date: "2026-02-02",
    title: "Security & Error Recovery Improvements",
    changes: [
      "Security: Push notification routes now properly verify you're logged in before subscribing",
      "Security: Staff-only notification controls now require staff authentication",
      "Fixed: App no longer gets stuck in reload loops when errors occur - stops after 2 attempts and shows recovery options",
      "Improved: Error screens now show 'Clear Cache & Refresh' and 'Contact Support' options when something goes wrong"
    ]
  },
  {
    version: "63.6.0",
    date: "2026-02-02",
    title: "Real-Time Connection Stability Improvements",
    changes: [
      "Fixed: Staff dashboard no longer creates multiple simultaneous connections - now uses a single shared connection",
      "Fixed: Pages no longer crash with 'Failed to fetch' errors when loading before login is complete",
      "Improved: Data loading now waits until your session is verified, preventing errors during app startup",
      "Improved: Background syncing is more reliable and won't attempt updates before you're logged in"
    ]
  },
  {
    version: "63.5.0",
    date: "2026-02-02",
    title: "Private Events Display Fix",
    changes: [
      "Fixed: Private events on Updates page now show properly formatted titles instead of raw values like 'private_event'",
      "Fixed: Affected areas now display correctly (e.g., 'Bay 1, Bay 2') instead of showing raw JSON array format",
      "Improved: Snake_case notice titles are now automatically converted to Title Case for better readability"
    ]
  },
  {
    version: "63.4.0",
    date: "2026-02-01",
    title: "Directory Deletion Now Updates Immediately",
    changes: [
      "Fixed: Deleting a member or visitor from the directory now immediately refreshes the list",
      "Fixed: Previously, deleted members would still appear until page refresh - now they disappear right away"
    ]
  },
  {
    version: "63.3.0",
    date: "2026-02-01",
    title: "Member Profile Drawer UX Improvements",
    changes: [
      "Fixed: Billing tab now scrolls fully to bottom - added extra padding so all content is accessible",
      "Improved: Activity tab filters are now responsive - shows icons only on mobile, icons + text on larger screens",
      "Improved: Filter buttons have better touch targets and spacing on mobile devices"
    ]
  },
  {
    version: "63.2.0",
    date: "2026-02-01",
    title: "Billing Emails Now Handled by Stripe",
    changes: [
      "Changed: All billing-related emails (payment failures, renewal notices, grace period reminders) are now handled by Stripe instead of Resend",
      "Changed: Resend is now only used for login codes (OTP), welcome emails, and staff notifications",
      "Fixed: Development environment email guard added to prevent accidental emails to members",
      "Technical: Added BILLING_EMAILS_DISABLED flag to membershipEmails.ts and paymentEmails.ts"
    ]
  },
  {
    version: "63.1.0",
    date: "2026-02-01",
    title: "Resend Email Webhook Integration",
    changes: [
      "New: Resend webhook endpoint at /api/webhooks/resend for real-time email event tracking",
      "New: Automatic bounce detection - member accounts are flagged when their emails bounce",
      "New: Spam complaint handling - members who mark emails as spam are automatically unsubscribed from marketing",
      "New: Email delivery events are logged for debugging and analytics",
      "Technical: Added email_events table to track all email delivery status changes"
    ]
  },
  {
    version: "63.0.0",
    date: "2026-02-01",
    title: "System Health Monitoring & Error Resilience",
    isMajor: true,
    changes: [
      "New: System Health dashboard in Data Integrity page shows live status of all external services (Database, Stripe, HubSpot, Resend, Google Calendar)",
      "New: Each service displays connection status, response latency, and error details when issues occur",
      "New: Color-coded health indicators (green/yellow/red) for quick status assessment",
      "New: FeatureErrorBoundary component allows individual page sections to fail gracefully without crashing the entire page",
      "Improved: API errors now include request IDs for easier debugging and support",
      "Improved: Retry logic with exponential backoff added for HubSpot, Stripe, and database operations",
      "Technical: Added comprehensive health check API endpoint with parallel service verification",
      "Technical: Cleaned up unused date utility functions and dashboard imports"
    ]
  },
  {
    version: "62.3.0",
    date: "2026-02-01",
    title: "Directory Page Scroll Improvements",
    changes: [
      "Improved: Active and Former member tabs now use full-page scrolling instead of a contained scroll area",
      "Improved: The entire page scrolls naturally based on the number of members displayed"
    ]
  },
  {
    version: "62.2.0",
    date: "2026-02-01",
    title: "Navigation Bug Fix",
    changes: [
      "Fixed: Critical navigation issue where clicking sidebar buttons on the Financials page would change the URL but not update the page content",
      "Fixed: Resolved infinite render loop in member search component that was blocking page updates",
      "Improved: Member search now correctly handles filter changes without causing performance issues"
    ]
  },
  {
    version: "62.1.0",
    date: "2026-02-01",
    title: "Bug Fixes for New User Drawer",
    changes: [
      "Fixed: Membership tier dropdown now correctly shows subscription products from Stripe",
      "Fixed: Day pass product selection now updates the amount to charge when a product is selected",
      "Fixed: Day pass payment now works correctly with the selected product",
      "Improved: Staff navigation sidebar now always stays above page content"
    ]
  },
  {
    version: "62.0.0",
    date: "2026-02-01",
    title: "New User Drawer: Unified Member & Visitor Creation",
    isMajor: true,
    changes: [
      "New: Staff can now add both members and day pass visitors from a single, unified drawer interface",
      "New: Member creation includes tier selection, family groups with automatic discount calculation, and optional discount codes",
      "New: Member payment supports immediate card charging or sending an activation link via email",
      "New: Day pass visitor creation with integrated Stripe payment and automatic visitor record creation",
      "New: 'Book Now' handoff - after creating a visitor, staff can immediately book a session with one click",
      "Improved: Day passes are now properly tracked and redeemed when used for bookings",
      "Improved: Replaced scattered modals with consistent right-side drawer experience",
      "Technical: Added staff checkout endpoints for day pass purchases with transactional safety"
    ]
  },
  {
    version: "61.4.0",
    date: "2026-02-01",
    title: "Comprehensive Error Handling Improvements",
    changes: [
      "Improved: All billing operations now show clear, actionable error messages (session expired, too many requests, server issues, network problems)",
      "Improved: Check-in flow shows helpful error guidance instead of generic 'Failed' messages",
      "Improved: Booking player management has consistent error messaging across all operations",
      "Improved: Event management and class scheduling show specific error context",
      "Improved: Group billing, tier changes, and member creation all use standardized error handling",
      "Technical: Added shared error handling utility for consistent user experience across the app"
    ]
  },
  {
    version: "61.3.0",
    date: "2026-02-01",
    title: "Stability Improvements",
    changes: [
      "Fixed: Rate limiting no longer incorrectly blocks page navigation",
      "Fixed: Directory page virtualization disabled to prevent React Query compatibility errors",
      "Improved: Facility Blocks page shows specific error messages (session expired, server error, network issues)",
      "Improved: Facility Blocks page includes 'Try Again' and 'Clear Cache & Reload' recovery buttons when errors occur"
    ]
  },
  {
    version: "61.2.0",
    date: "2026-02-01",
    title: "Bug Fixes",
    changes: [
      "Fixed: Calendar closures now load correctly on booking pages (was showing 404 error)",
      "Fixed: Trackman imports no longer create fake placeholder email addresses for unmatched bookings"
    ]
  },
  {
    version: "61.1.0",
    date: "2026-02-01",
    title: "Member Profile Drawer Polish",
    changes: [
      "Style: Member profile drawer now matches the elegant public menu style",
      "Style: Drawer background extends beyond the screen edge for a premium feel",
      "Style: Added curved corner on the top-left for softer appearance",
      "Animation: Close button now rotates 90 degrees on hover for visual feedback"
    ]
  },
  {
    version: "61.0.0",
    date: "2026-02-01",
    title: "Smart Data Caching: Faster Navigation & Reduced Loading",
    isMajor: true,
    changes: [
      "Speed: Pages no longer reload from scratch when navigating - data stays cached and appears instantly",
      "Speed: Reduced server requests by 60-80% through intelligent caching and stale-while-revalidate",
      "Speed: Navigation between staff portal pages is now near-instant",
      "Stability: Scroll position is preserved when taking actions (approve, check-in, assign, etc.)",
      "Stability: No more page flickering or data disappearing during actions",
      "Real-time: Booking updates from other staff members appear automatically without manual refresh",
      "Real-time: WebSocket events now sync cached data across all open pages",
      "Staff Portal: All 12 admin tabs now use smart caching (Bookings, Financials, Directory, Events, Settings, Trackman, Data Integrity, Tiers, Team, Tours, Cafe, Facility Notices)",
      "Member Pages: Dashboard, Book Golf, Events, Profile, and History pages all use smart caching",
      "Technical: Migrated to React Query for enterprise-grade data management"
    ]
  },
  {
    version: "60.5.0",
    date: "2026-02-01",
    title: "Financials Page Navigation Fix",
    changes: [
      "Fixed: Navigating away from Financials page now works correctly even if data is still loading",
      "Fixed: All async data fetches in Financials tab now properly cancel when navigating away",
      "Improved: Navigation between staff portal pages is now more responsive"
    ]
  },
  {
    version: "60.4.0",
    date: "2026-02-01",
    title: "Staff Navigation Fix",
    changes: [
      "Fixed: Rapid navigation between staff portal pages now works correctly",
      "Fixed: Clicking a new page before the current one finishes loading no longer causes the page to get stuck"
    ]
  },
  {
    version: "60.3.0",
    date: "2026-02-01",
    title: "iOS Safari Translucent Toolbar",
    changes: [
      "iOS Safari: Removed theme-color meta tag to enable translucent bottom toolbar (frosted glass effect)",
      "iOS Safari: Green header now extends behind the status bar at top of screen",
      "iOS Safari: Added bottom padding so page content scrolls behind frosted toolbar",
      "PWA: No changes - installed app continues to show solid green status bar via manifest"
    ]
  },
  {
    version: "60.2.0",
    date: "2026-01-31",
    title: "URL Routing Cleanup",
    changes: [
      "Fixed: All backend notification URLs now use correct BrowserRouter paths (removed hash router pattern)",
      "Fixed: Push notifications for bookings, wellness, events, and tours now link correctly",
      "Fixed: Stripe redirect URLs (billing portal, checkout, day passes) now use proper routes",
      "Fixed: Staff command center WebSocket status indicator now shows 'Live' correctly",
      "Fixed: Staff notification click-throughs now navigate to correct admin pages"
    ]
  },
  {
    version: "60.1.0",
    date: "2026-01-31",
    title: "Staff FAB Quick Actions Stay In-Place",
    changes: [
      "Fixed: New Announcement and New Notice quick actions now open drawers directly on the command console instead of navigating away",
      "Improved: Quick actions are faster with simpler forms - just title, description, and notification toggle",
      "Note: For advanced notice options (booking blocks, affected areas), use the full Facility Notices page"
    ]
  },
  {
    version: "60.0.0",
    date: "2026-01-31",
    title: "Major UX Overhaul: Mobile-First Navigation & Drawers",
    isMajor: true,
    changes: [
      "Routing: Admin navigation now uses proper URL routes (/admin/bookings, /admin/directory, etc.) instead of query params",
      "Routing: Legacy ?tab= URLs automatically redirect to new routes for backward compatibility",
      "Staff FAB: Quick actions menu now uses slide-up drawer with 5 quick actions: New User, Announcement, Notice, Manual Booking, QR Scanner",
      "Modals: Converted 19+ modals to slide-up drawers with drag-to-dismiss gesture support",
      "Modals: Payment modals (Balance, Invoice, Member Payment, Guest Pass) now use mobile-friendly drawers",
      "Modals: Guest entry, player management, and form modals (HubSpot, Event Inquiry) now use drawers",
      "Modals: All admin modals (Notice, Event, Wellness, Announcement) now use drawers",
      "Tables: Trackman and Financials tables now show as cards on mobile, tables on desktop",
      "Inline Edits: TiersTab and BlocksTab inline editing now uses slide-up drawers for better mobile UX",
      "Branding: Renamed 'CLASS' to 'WELLNESS' throughout the app for accuracy",
      "SEO: Added sitemap.xml, robots.txt, and meta tags for public pages",
      "UX: Created ConfirmDialog component with Liquid Glass styling, replacing all browser confirm dialogs"
    ]
  },
  {
    version: "59.3.0",
    date: "2026-01-31",
    title: "SimulatorTab Cleanup",
    changes: [
      "Cleanup: Removed redundant Re-scan, Auto-Match, and Notes buttons from Simulator admin",
      "Improved: Cleaner toolbar with only essential actions"
    ]
  },
  {
    version: "59.2.0",
    date: "2026-01-31",
    title: "Trackman Admin Cleanup & Mobile UX",
    changes: [
      "Cleanup: Removed Matched Bookings section from Trackman admin (555 lines of code removed)",
      "Cleanup: Removed Potential Matches section - matching was often inaccurate",
      "Cleanup: Removed Re-scan button - redundant with calendar sync",
      "Improved: Create Manual Booking now uses slide-up drawer with sticky action button",
      "Improved: Trackman admin page is now significantly simpler and faster to load"
    ]
  },
  {
    version: "59.1.0",
    date: "2026-01-31",
    title: "Mobile UX: Slide-Up Drawers",
    changes: [
      "Added: SlideUpDrawer component - new mobile-optimized drawer with drag-to-dismiss gesture support",
      "Improved: Check-in billing modal now slides up from bottom on mobile with swipe-to-dismiss",
      "Improved: Trackman link modal now slides up from bottom on mobile with swipe-to-dismiss",
      "Improved: Complete roster modal now slides up from bottom on mobile with swipe-to-dismiss",
      "Improved: Waiver signing modal now slides up from bottom on mobile with swipe-to-dismiss",
      "Improved: All converted modals have sticky action buttons at the bottom for easier one-handed use",
      "Improved: iOS safe area handling prevents content from being hidden behind device notches/home bars"
    ]
  },
  {
    version: "59.0.0",
    date: "2026-01-31",
    title: "Staff Management & Private Event Linking",
    isMajor: true,
    changes: [
      "Added: 'Assign to Staff' button in Trackman modal - quickly assign bookings to staff/instructors without creating visitor records",
      "Added: 'Team' tab in Directory page - view all staff with role badges (Instructor/Admin/Staff) and booking history",
      "Added: 'Link to Existing Notice' feature - when marking a booking as private event, choose to link to an existing calendar notice instead of creating duplicates",
      "Added: 'Generate Trackman Notes' tool - search members and copy formatted notes (M|email|first|last) for manual Trackman bookings",
      "Improved: Staff search now includes all staff_users records, not just those with specific users.role values",
      "Improved: Booking assignment validates archived members - prevents assigning to archived accounts",
      "Improved: Empty email handling - unmatched booking queries now check for both NULL and empty strings",
      "Fixed: Golf instructors no longer show as 'Visitor' in search results",
      "Fixed: 9 staff accounts corrected from non-member to proper staff status (Tim, Laily, Ryan, Mara, Adam, Nick, Sam, Alyssa, Members)",
      "Fixed: Team management page now restricted to admin-only access",
      "Cleanup: Removed duplicate unmatch button from booking details modal",
      "Cleanup: Deleted 25 incorrect 'Lesson: Tim Silverman' facility closure notices",
      "Technical: Added closure_id foreign key to booking_requests for notice linking"
    ]
  },
  {
    version: "58.0.0",
    date: "2026-01-31",
    title: "Eliminate Placeholder Email Generation",
    isMajor: true,
    changes: [
      "Refactored: Trackman imports no longer create placeholder emails for unmatched bookings",
      "Refactored: Unmatched bookings now use null user_email instead of fake generated emails",
      "Improved: Auto-match system only links to existing real visitors, never creates fake ones",
      "Improved: Booking slots still block availability correctly without requiring a fake user",
      "Added: HubSpot sync now rejects placeholder emails to prevent contact pollution",
      "Fixed: TrackmanLinkModal hides placeholder emails, shows 'Unassigned' status cleanly",
      "Fixed: Staff 'unmatch booking' action now uses null email instead of generating placeholder",
      "Fixed: Unmatched booking queries updated to find both null emails and legacy placeholders",
      "Cleanup: Deleted 73 existing placeholder Stripe customers",
      "Cleanup: Archived 73 placeholder user records in database",
      "Technical: All booking detection logic updated to treat null/empty email as unmatched"
    ]
  },
  {
    version: "57.10.0",
    date: "2026-01-31",
    title: "Placeholder Account Cleanup Tool",
    changes: [
      "Added: New 'Placeholder Account Cleanup' section on Data Integrity page",
      "Added: Scan for placeholder emails in Stripe customers and HubSpot contacts",
      "Added: Bulk delete placeholder accounts with one click (golfnow-*, unmatched-*, @visitors.evenhouse.club, etc.)",
      "Added: Preview list shows all accounts before deletion with confirmation dialog",
      "Fixed: Placeholder emails are now blocked from creating Stripe customers across all payment flows",
      "Technical: Added safeguards to prevent fake/system emails from creating billing records"
    ]
  },
  {
    version: "57.9.0",
    date: "2026-01-30",
    title: "Auto-Cleanup Stale Billing Participants",
    changes: [
      "Fixed: Check-In & Billing modal now auto-cleans orphaned players when opened",
      "Fixed: Players removed from roster before the bug fix will now be properly removed from billing",
      "Improved: Fees recalculate automatically after stale participant cleanup"
    ]
  },
  {
    version: "57.8.0",
    date: "2026-01-30",
    title: "Bug Report Button Moved to Menu",
    changes: [
      "Moved: Report a Bug button relocated from Profile page to hamburger menu",
      "Improved: Bug reports can now be submitted from any page - just open the menu",
      "Added: Bug report button in Staff Portal sidebar for easy access"
    ]
  },
  {
    version: "57.7.0",
    date: "2026-01-30",
    title: "Fix Player Removal Not Updating Billing",
    changes: [
      "Fixed: Removing a player from a booking now properly deletes them from the billing participants list",
      "Fixed: Fee calculations update correctly after removing a player from the roster",
      "Fixed: Check-In & Billing modal now shows accurate player list after roster changes",
      "Technical: Unlink endpoint was comparing email to UUID column - now properly looks up user ID first"
    ]
  },
  {
    version: "57.6.0",
    date: "2026-01-30",
    title: "UI Polish - Smoother Animations & Visual Feedback",
    changes: [
      "Added: Sidebar sliding indicator animation that smoothly transitions between selected items (matching bottom nav style)",
      "Improved: Booking cards have smoother hover transitions with subtle scale and shadow depth effects",
      "Improved: Time slot grid now has visual separation between columns and alternating hour backgrounds for better readability",
      "Improved: All action buttons (Assign Member, Check In, etc.) now have smooth press feedback with active:scale-95",
      "Improved: Grid cells have faster transition animations (150ms) for more responsive feel",
      "Improved: Header rows in booking grid have subtle shadows for visual depth"
    ]
  },
  {
    version: "57.5.0",
    date: "2026-01-30",
    title: "Remove Duplicate Requires Review Section",
    changes: [
      "Removed: Duplicate 'Requires Review' section from Trackman page",
      "Improved: Unmatched Bookings section now handles all review cases including private events"
    ]
  },
  {
    version: "57.4.0",
    date: "2026-01-30",
    title: "Optimistic UI for Data Integrity Fixes",
    changes: [
      "Improved: Issue counts now update immediately when fixes are applied (no waiting for refresh)",
      "Improved: Total issues counter updates in real-time as fixes complete",
      "Improved: Check status changes to 'pass' when all issues are resolved"
    ]
  },
  {
    version: "57.3.0",
    date: "2026-01-30",
    title: "Clear Orphaned Stripe IDs Tool",
    changes: [
      "Added: 'Clear Orphaned IDs' button in Data Integrity to remove Stripe customer IDs that no longer exist in Stripe",
      "Added: Preview mode shows which orphaned IDs would be cleared before executing",
      "Improved: After clearing orphaned IDs, the Data Integrity page automatically refreshes"
    ]
  },
  {
    version: "57.2.0",
    date: "2026-01-30",
    title: "Prevent Placeholder Stripe Customers",
    changes: [
      "Fixed: Stripe customers are no longer created for placeholder visitor emails (GolfNow, ClassPass, anonymous imports)",
      "Fixed: Placeholder emails like 'golfnow-YYYYMMDD-HHMM@visitors.evenhouse.club' are now excluded from Stripe",
      "Improved: This prevents orphaned Stripe customers from being created for temporary booking placeholders"
    ]
  },
  {
    version: "57.1.0",
    date: "2026-01-30",
    title: "Orphaned Stripe Customer Detection",
    changes: [
      "Improved: Data integrity now properly identifies orphaned Stripe customers (IDs in database that no longer exist in Stripe)",
      "Improved: Cleaner error messages for orphaned customers instead of scary stack traces",
      "Fixed: Stripe subscription sync check now categorizes 'customer not found' as a data quality issue"
    ]
  },
  {
    version: "57.0.0",
    date: "2026-01-30",
    title: "Stripe Customer Email Linking",
    isMajor: true,
    changes: [
      "New: Stripe customers are now tied to member emails including linked emails",
      "New: When creating a Stripe customer, system checks all linked emails to prevent duplicates",
      "New: Data integrity check 'Duplicate Stripe Customers' detects members sharing the same email with different Stripe customers",
      "Improved: Stripe customer metadata now includes primary email and linked emails for better tracking",
      "Improved: Fails fast on Stripe network/rate limit errors to prevent accidental duplicate creation",
      "Improved: Deterministic customer selection - prefers primary email match, then most recent"
    ]
  },
  {
    version: "56.4.0",
    date: "2026-01-30",
    title: "Stripe Error Handling Improvements",
    changes: [
      "Fixed: Stripe subscription lookups now gracefully handle customers that no longer exist in Stripe",
      "Improved: API returns proper 404 status when a Stripe customer is not found instead of 500 error",
      "Improved: Better error messages distinguish between 'customer not found' and other Stripe errors"
    ]
  },
  {
    version: "56.3.0",
    date: "2026-01-30",
    title: "Fix Tool Endpoint Corrections",
    changes: [
      "Fixed: 'Create Sessions' button now uses correct backfill endpoint to actually create billing sessions",
      "Fixed: Preview for Active Bookings now correctly shows how many will be fixed"
    ]
  },
  {
    version: "56.2.0",
    date: "2026-01-30",
    title: "Data Integrity Fix Tools",
    changes: [
      "New: Deal Stage Drift check now has 'Remediate Deal Stages' fix tool",
      "New: Active Bookings Without Sessions check shows 'Create Sessions' fix tool",
      "Improved: All fix tools appear directly above the issues list when clicking a check",
      "Improved: Check Results section now appears before Data Tools section for easier access"
    ]
  },
  {
    version: "56.1.0",
    date: "2026-01-30",
    title: "Data Integrity UX Improvements",
    changes: [
      "Improved: Preview buttons now clearly show 'Preview complete - no changes made' toast",
      "Improved: Fix tools now appear directly on each integrity check instead of separate section",
      "Improved: Preview results show blue styling vs green for executed actions",
      "Improved: Each result explicitly shows 'Preview Only - No Changes Made' label",
      "Fixed: Ghost booking preview now correctly shows total found instead of undefined",
      "Fixed: Fix tools now properly appear for Stripe Subscription Sync and Tier Reconciliation checks"
    ]
  },
  {
    version: "56.0.0",
    date: "2026-01-30",
    title: "Dynamic Tier Features Comparison System",
    isMajor: true,
    changes: [
      "New: Flexible tier feature management - add, rename, or remove features that appear in membership comparison",
      "New: Features support different value types (yes/no checkmarks, numbers, text) for accurate display",
      "New: Admin can now edit feature labels inline and reorder features",
      "New: Public membership comparison table is now fully database-driven",
      "Improved: Features are automatically created for all tiers when added",
      "Improved: Admin tier editor has cleaner UI with dedicated feature management section"
    ]
  },
  {
    version: "55.1.0",
    date: "2026-01-30",
    title: "Webhook Security Hardening",
    changes: [
      "Fixed: Failed membership payments now immediately set status to 'past due' (prevents continued booking access)",
      "Fixed: Cancelled/terminated members can no longer be accidentally reactivated by delayed Stripe webhooks",
      "Fixed: Payment failure handler now only processes once per member (prevents duplicate notifications)",
      "Improved: Staff booking modal now validates duration range (30-240 minutes)"
    ]
  },
  {
    version: "55.0.0",
    date: "2026-01-30",
    title: "Infrastructure Reliability & Data Protection Audit",
    isMajor: true,
    changes: [
      "Fixed: Cancelled membership webhooks can no longer accidentally reactivate cancelled users (subscription event ordering)",
      "Fixed: Guest pass deductions are now atomic - prevents double-charging on simultaneous bookings",
      "Fixed: Trackman import cancellations now validate date ranges to prevent accidental data loss",
      "Fixed: User merge now checks for active sessions before proceeding (prevents mid-session data corruption)",
      "Fixed: Webhook duplicate processing prevented with idempotency guard (new trackman_webhook_dedup table)",
      "Fixed: Visitor email collisions prevented with random suffix generation",
      "Fixed: Member search now excludes auto-generated visitors (directory_hidden users)",
      "Fixed: Webhook time matching tolerance reduced from 30 to 10 minutes for more accurate booking links",
      "Fixed: Guest pass reset scheduler now uses slot claiming to prevent double runs on restarts",
      "Improved: Stripe reconciliation failures now alert staff (no silent failures)",
      "Improved: HubSpot queue dead jobs now notify staff for manual intervention",
      "Improved: HubSpot queue recovers jobs stuck in 'processing' state after server crashes",
      "Improved: User merge now properly updates guest 'created_by' references"
    ]
  },
  {
    version: "54.1.0",
    date: "2026-01-29",
    title: "Zombie User Fix & Lesson Cleanup Tool",
    changes: [
      "Fixed: Auto-matching no longer links new bookings to archived/merged user profiles",
      "Fixed: ClassPass bookings now get proper fallback handling (same as GolfNow)",
      "New: Lesson cleanup tool to retroactively convert historical lesson bookings to availability blocks",
      "New: Staff Manual Booking modal now has 'Lesson / Staff Block' tab with streamlined workflow",
      "Improved: Lesson cleanup tool validates bay numbers and prevents duplicate block creation"
    ]
  },
  {
    version: "54.0.0",
    date: "2026-01-29",
    title: "Comprehensive System Reliability Improvements",
    isMajor: true,
    changes: [
      "Fixed: Database constraint errors now return proper error messages instead of crashing",
      "Fixed: Booking conflicts during busy periods now handled gracefully with retry guidance",
      "Fixed: Payment processing now uses unique identifiers to prevent duplicate charges",
      "Fixed: Stripe payment failures now trigger staff alerts for immediate visibility",
      "Fixed: Email matching is now consistent across login, member lookup, and tier checks",
      "Fixed: Usage tracking now prevents duplicate entries even if recorded multiple times",
      "Improved: Database connection pool increased from 8 to 20 for better handling of busy periods",
      "Improved: Error logging now includes detailed database information for faster debugging",
      "Improved: All payment operations alert staff if they fail (no more silent failures)",
      "Improved: Member access no longer blocked due to minor email formatting differences"
    ]
  },
  {
    version: "53.15.0",
    date: "2026-01-29",
    title: "Staff Lesson Auto-Conversion",
    changes: [
      "New: Trackman imports now auto-detect lesson bookings and convert them to availability blocks",
      "New: Staff emails (tim@, rebecca@evenhouse.club) are automatically recognized as instructors",
      "New: 'Lesson' keywords in booking notes trigger automatic block conversion",
      "New: Admin cleanup tool to retroactively convert historical lesson bookings to blocks",
      "Improved: Lessons no longer appear in member booking history or financial reports",
      "Improved: Clean separation between member bookings and staff-led instruction time"
    ]
  },
  {
    version: "53.14.0",
    date: "2026-01-29",
    title: "Critical Bug Fixes - Data Integrity & User Management",
    changes: [
      "Fixed: CSV imports no longer wipe out future bookings - cancellations now scoped to the date range in the uploaded file",
      "Fixed: Merging user profiles now properly transfers Stripe and HubSpot IDs from secondary to primary account",
      "Fixed: Archived/merged users no longer appear in member searches or auto-matching systems",
      "Fixed: Trackman bookings that conflict with private events now go to pending status for staff review",
      "Fixed: Day pass purchases now correctly match to walk-in bookings with proper redemption tracking",
      "Fixed: Merged user emails are now released for re-registration instead of blocking future signups",
      "Improved: Day pass matching only triggers for explicit day-pass bookings to prevent false matches",
      "Improved: Audit trail for day pass redemptions with trackman booking ID linkage"
    ]
  },
  {
    version: "53.13.0",
    date: "2026-01-29",
    title: "Simplified Safari Toolbar Colors",
    changes: [
      "Simplified: All public pages now use light bone toolbar color (#F2F2EC)",
      "Simplified: Member/staff portal toolbar matches device theme (dark/light)",
      "Removed: Complex scroll-based toolbar color detection on landing page"
    ]
  },
  {
    version: "53.12.0",
    date: "2026-01-29",
    title: "Safari Toolbar Color Enhancement",
    changes: [
      "Improved: Added fixed element extending into safe area for better Safari color detection",
      "Improved: Multiple theme-color meta tags with light/dark mode media queries",
      "Fixed: Safari bottom toolbar should now properly detect page background color",
      "Fixed: Public pages, member portal, and staff portal all use correct toolbar colors"
    ]
  },
  {
    version: "53.11.0",
    date: "2026-01-29",
    title: "Safari Translucent Toolbar Fix",
    changes: [
      "Fixed: Safari bottom toolbar now shows proper translucent effect with correct tint",
      "Fixed: Public pages use light theme color for Safari toolbar",
      "Fixed: Member/staff dark mode pages use dark theme color for Safari toolbar",
      "Fixed: Initial page load now sets correct Safari theme immediately",
      "Improved: CSS-based backgrounds for better Safari translucency support"
    ]
  },
  {
    version: "53.10.0",
    date: "2026-01-29",
    title: "Safari Browser Theme Improvements",
    changes: [
      "Improved: Safari toolbar now matches page background colors correctly",
      "Fixed: Landing page toolbar transitions from dark hero to light content when scrolling",
      "Fixed: Member and staff pages in dark mode now show proper dark toolbar color",
      "Fixed: Removed conflicting theme-color logic for consistent Safari experience"
    ]
  },
  {
    version: "53.9.0",
    date: "2026-01-29",
    title: "Smart Queue Resolution",
    changes: [
      "Improved: ClassPass and GolfNow bookings now auto-create visitor records instead of staying in queue",
      "Improved: Birthday parties, events, and group bookings automatically resolve as private events",
      "Improved: Auto-matching now handles walk-ins, lessons, and anonymous bookings more intelligently",
      "Reduced: Trackman queue clutter with smarter auto-resolution of common booking types"
    ]
  },
  {
    version: "53.8.0",
    date: "2026-01-29",
    title: "Tag Display Crash Fix",
    changes: [
      "Fixed: Member profile drawer, Dashboard, and Profile pages no longer crash when viewing merged members",
      "Fixed: View As mode now works correctly for all members",
      "Fixed: Tag display across all member views now properly filters merge records"
    ]
  },
  {
    version: "53.7.0",
    date: "2026-01-29",
    title: "Private Event from Unmatched Bookings",
    changes: [
      "Fixed: Can now mark unmatched Trackman bookings as private events directly",
      "Fixed: 'Booking not found' error when converting Trackman imports that are still in review queue",
      "Improved: Private events created from unmatched bookings automatically resolve those entries"
    ]
  },
  {
    version: "53.6.0",
    date: "2026-01-29",
    title: "Staff Portal Directory Fix",
    changes: [
      "Fixed: Directory tab in Staff Portal now loads correctly",
      "Fixed: Member merge records no longer cause display errors in tag filters",
      "Technical: Added filtering for non-string entries in member tags array"
    ]
  },
  {
    version: "53.5.0",
    date: "2026-01-29",
    title: "Private Event Toast Fix",
    changes: [
      "Fixed: Marking booking as private event no longer shows duplicate toast notifications",
      "Fixed: 'Trackman booking linked to member' toast no longer appears when marking as private event"
    ]
  },
  {
    version: "53.4.0",
    date: "2026-01-29",
    title: "Complete User Merge Coverage",
    changes: [
      "New: Merge now covers ALL 19 user-related data tables",
      "New: Includes booking participants, day passes, legacy purchases",
      "New: Includes group memberships, push subscriptions, dismissed notices",
      "New: Includes billing groups (primary payer transfer)",
      "New: Includes bug reports, data export requests",
      "New: Includes HubSpot deals, Stripe payment intents",
      "Improved: Merge preview shows counts for all data types being transferred"
    ]
  },
  {
    version: "53.3.0",
    date: "2026-01-29",
    title: "Expanded User Merge Coverage",
    changes: [
      "New: Merge now includes booking participants in multi-member bookings",
      "New: Merge now includes day pass purchases",
      "New: Merge now includes legacy purchases",
      "New: Merge now includes group/corporate memberships",
      "New: Merge now includes push notification subscriptions",
      "New: Merge now includes dismissed notice preferences",
      "Improved: Merge preview shows counts for all 14 data types being transferred"
    ]
  },
  {
    version: "53.2.0",
    date: "2026-01-29",
    title: "Member Portal Navigation Menu",
    changes: [
      "New: Hamburger menu in member portal header (replaces mascot)",
      "New: Slide-out navigation with all member pages and nested tabs",
      "New: Liquid glass selection effect highlights current page",
      "New: Mascot logo in menu sidebar links back to landing page",
      "Improved: Member navigation matches public pages sidebar design"
    ]
  },
  {
    version: "53.1.0",
    date: "2026-01-29",
    title: "Complete Duplicate Prevention Coverage",
    changes: [
      "New: Remember Email checkbox in Manage Players modal (admin booking editor)",
      "New: Visitor Type dropdown required in Add User modal (staff command center)",
      "New: Duplicate name warning in Add User modal with clickable options to use existing record",
      "Fixed: Selecting an existing duplicate now properly uses that record instead of creating new one",
      "Improved: All member/visitor creation points now have duplicate prevention"
    ]
  },
  {
    version: "53.0.0",
    date: "2026-01-29",
    title: "User Merge & Duplicate Prevention",
    isMajor: true,
    changes: [
      "New: Merge Users feature - combine duplicate member/visitor records safely",
      "New: Merge button in member profile opens search and preview modal",
      "New: Preview shows all records that will be transferred (bookings, visits, fees, etc.)",
      "New: Transaction-safe merge consolidates all data and soft-deletes merged account",
      "New: Remember Email checkbox in Assign Players to link alternate emails for future auto-matching",
      "New: Duplicate name warning when creating new visitors shows existing matches",
      "New: Visitor Type is now required when creating new visitors",
      "Improved: Merge actions logged to Staff Activity for audit trail",
      "Improved: Merged users tagged for 30-day recovery if needed"
    ]
  },
  {
    version: "52.1.0",
    date: "2026-01-29",
    title: "Duplicate Visitor Cleanup & Queue Stats Layout",
    changes: [
      "Fixed: Merged 139 duplicate visitor records (same name, multiple date-based emails)",
      "Fixed: Reassigned 157 bookings from duplicate visitors to primary records",
      "Fixed: Queue stats text (pending, unassigned, need review) now appears below header instead of inline",
      "Improved: Queue header row is cleaner with just title and action buttons"
    ]
  },
  {
    version: "52.0.0",
    date: "2026-01-29",
    title: "Auto-Match Visitors from MindBody",
    isMajor: true,
    changes: [
      "New: Auto-Match Visitors button in Queue auto-assigns unmatched bookings to visitors",
      "New: Matching uses MindBody purchase history (date + time + purchase type)",
      "New: ClassPass, Day Pass, Private Lesson bookings auto-linked to visitor records",
      "New: After-hours bookings (10 PM - 6 AM) auto-marked as Private Events",
      "New: Unmatched GolfNow bookings create new visitors with GolfNow type",
      "New: All auto-matches logged to Staff Activity for audit trail",
      "Improved: Visitor types now include 'golfnow' and 'private_event'"
    ]
  },
  {
    version: "51.0.0",
    date: "2026-01-29",
    title: "Unified Queue with Requires Review",
    isMajor: true,
    changes: [
      "Added: 'Requires Review' bookings (partial name matches) now appear in Queue",
      "Added: Orange-styled cards for bookings needing name verification",
      "Added: 'Re-scan for Matches' button in Queue header to retry member matching",
      "Added: Queue now shows 3 item types: pending requests, unassigned bookings, needs review",
      "Improved: All Trackman import management consolidated into Simulator page",
      "Fixed: Legacy review items can be resolved directly from Queue"
    ]
  },
  {
    version: "50.3.0",
    date: "2026-01-29",
    title: "Queue Shows Booking Details",
    changes: [
      "Added: Queue cards now show original name and email from Trackman import",
      "Added: Assign Player modal now shows Notes from Import with original booking details",
      "Fixed: Queue items now pass all booking details (date, time, notes) to assignment modal",
      "Improved: Staff can see who made the booking at a glance without opening modal"
    ]
  },
  {
    version: "50.2.0",
    date: "2026-01-29",
    title: "Complete Duplicate Prevention Coverage",
    changes: [
      "Fixed: Legacy booking resolution now handles race conditions with ON CONFLICT",
      "Fixed: Webhook reprocess endpoint now handles concurrent requests safely",
      "Fixed: Member assignment from unmatched bookings handles duplicates gracefully",
      "Fixed: Rescan function uses ON CONFLICT for atomic insert safety",
      "Improved: All 12 booking creation paths now have duplicate prevention"
    ]
  },
  {
    version: "50.1.0",
    date: "2026-01-29",
    title: "Import Duplicate Prevention & Queue Tab",
    changes: [
      "Added: Unassigned webhook bookings now appear in the Queue tab alongside pending requests",
      "Added: Queue tab shows combined count of pending requests and unassigned bookings",
      "Fixed: CSV import now gracefully handles race conditions with webhooks (duplicate key handling)",
      "Improved: Staff can see chronological view of all items needing attention in one place",
      "Improved: Clicking unassigned booking in queue opens the member assignment modal"
    ]
  },
  {
    version: "50.0.0",
    date: "2026-01-29",
    title: "TrackMan Import & Email Learning System",
    isMajor: true,
    changes: [
      "Added: Email learning system - when staff links an unmatched booking, system remembers email for future auto-matching",
      "Added: CSV import now backfills webhook-created bookings instead of creating duplicates",
      "Added: Automatic email association learning when import matches unmatched bookings",
      "Fixed: Legacy unmatched bookings table no longer causes skipped imports",
      "Fixed: Auto-resolves legacy entries when booking exists in main system",
      "Improved: TrackMan import loads learned emails from user_linked_emails table",
      "Improved: Staff can choose 'Remember this email' when resolving unmatched bookings"
    ]
  },
  {
    version: "49.7.0",
    date: "2026-01-29",
    title: "Booking Availability Fix",
    changes: [
      "Fixed: Members not seeing available time slots due to stale/duplicate TrackMan data",
      "Fixed: Resolved 78 duplicate unmatched booking entries that were blocking availability",
      "Fixed: Cleaned up 5 past booking entries from availability checks",
      "Improved: Availability system now correctly shows open slots"
    ]
  },
  {
    version: "49.6.0",
    date: "2026-01-29",
    title: "UI/UX & Accessibility Improvements",
    changes: [
      "Added: Global keyboard focus indicators for all buttons, links, and inputs (WCAG 2.4.7 compliance)",
      "Added: Darker lavender color variant for better text contrast on light backgrounds",
      "Fixed: Touch targets on icon buttons now meet 44x44px minimum (WCAG accessibility)",
      "Fixed: Missing screen reader labels on 6 icon-only buttons (notes, delete, edit, pin actions)",
      "Fixed: Notices tab header spacing - added breathing room between filters, legend, and sections",
      "Fixed: TrackMan webhook error messages now wrap properly instead of breaking card layouts"
    ]
  },
  {
    version: "49.5.0",
    date: "2026-01-29",
    title: "Staff Notification Coverage",
    changes: [
      "Added: Staff notifications for all TrackMan unmatched bookings (no customer email, unmapped bay)",
      "Added: Staff notifications when members cancel their subscription",
      "Added: Staff notifications when subscriptions go past due or unpaid/suspended",
      "Added: Staff notifications when member payment cards are expiring soon",
      "Added: Staff notifications when day passes are purchased",
      "Fixed: Added missing notification types to type system (day_pass, trackman_booking, etc.)",
      "Improved: Complete staff visibility into booking and billing events requiring attention"
    ]
  },
  {
    version: "49.4.0",
    date: "2026-01-29",
    title: "Staff Activity Human-Readable Details",
    changes: [
      "Fixed: Staff Activity now displays human-readable text instead of raw JSON",
      "Improved: Universal field extraction for email, amount, description, counts",
      "Fixed: Record Charge shows email and formatted dollar amount",
      "Fixed: Detect Duplicates shows App and HubSpot counts",
      "Fixed: Fix Ghost Bookings shows number of bookings found"
    ]
  },
  {
    version: "49.3.0",
    date: "2026-01-29",
    title: "Complete Human-Readable Activity Details",
    changes: [
      "Improved: All Staff Activity cards now show human-readable details instead of raw JSON",
      "Added: Formatting for 40+ action types including Stripe events, invoices, day passes, waivers, and bulk actions",
      "Added: Icons and labels for subscription, invoice, visitor, and TrackMan sync events",
      "Added: Proper detail formatting for member actions, booking status changes, and data migrations"
    ]
  },
  {
    version: "49.2.0",
    date: "2026-01-29",
    title: "Complete Activity Logging Coverage",
    changes: [
      "Added: Member booking cancellations via resources endpoint now logged to Staff Activity",
      "Added: Wellness class enrollment cancellations now logged to Staff Activity",
      "Added: Event RSVP cancellations now logged to Staff Activity",
      "Fixed: Staff cancellations via booking approval workflow now properly logged",
      "Improved: All member-initiated cancellations show with Member badge in activity feed"
    ]
  },
  {
    version: "49.1.0",
    date: "2026-01-29",
    title: "Dashboard Today's Bookings Filter",
    changes: [
      "Improved: Staff dashboard now shows only today's bookings instead of all future dates",
      "Improved: Card renamed from 'Upcoming Bookings' to 'Today's Bookings' for clarity",
      "Note: Staff can click 'View all' to see the complete booking list including future dates"
    ]
  },
  {
    version: "49.0.0",
    date: "2026-01-29",
    title: "Comprehensive Activity Logging & Staff Notifications",
    isMajor: true,
    changes: [
      "Added: Real-time notifications for all booking cancellations (from TrackMan, members, or staff)",
      "Added: System and member action logging to the Staff Activity tab",
      "Added: Actor badges showing who performed each action (Staff/Member/System)",
      "Added: Source filter to view activity by actor type",
      "Added: Human-readable activity descriptions with refund amounts and booking details",
      "Added: Stripe payment event logging (refunds, successful payments, failed payments)",
      "Added: TrackMan webhook cancellation logging with pass refund tracking"
    ]
  },
  {
    version: "48.1.0",
    date: "2026-01-28",
    title: "Calendar Quick Booking",
    changes: [
      "Added: Click empty calendar cells to open booking form with bay and time pre-filled",
      "Improved: Queue card now matches calendar height with scrollable content",
      "Improved: Floating action button positioned correctly on desktop view"
    ]
  },
  {
    version: "48.0.0",
    date: "2026-01-28",
    title: "Staff Manual Booking Tool",
    isMajor: true,
    changes: [
      "Added: Staff can now create bookings for members directly from the Bookings page",
      "Added: Floating action button on Bookings page to open the manual booking form",
      "Added: Bay, date, time, duration, and player count selection",
      "Added: Dynamic participant slots with member/guest selection using unified member search",
      "Added: Automatic generation of Trackman notes text with copy button",
      "Added: External Trackman booking ID linking for webhook auto-confirmation",
      "Added: Pending bookings created by staff function identically to member requests"
    ]
  },
  {
    version: "47.6.0",
    date: "2026-01-28",
    title: "Same-Day Booking Fee Calculation Fix",
    changes: [
      "Fixed: Members with multiple bookings on the same day now correctly use their daily allowance on the earliest booking first",
      "Fixed: Later bookings on the same day now properly calculate overage fees based on remaining allowance",
      "Improved: Fee calculations now use start time ordering to ensure fair allocation of daily included minutes"
    ]
  },
  {
    version: "47.5.0",
    date: "2026-01-28",
    title: "Member History Bug Fix",
    changes: [
      "Fixed: Member profile drawer now correctly loads booking history, event RSVPs, and wellness enrollments",
      "Fixed: Database query error that prevented staff from viewing member activity in the Directory"
    ]
  },
  {
    version: "47.4.0",
    date: "2026-01-28",
    title: "Staff PWA Menu Shortcuts",
    changes: [
      "Updated: PWA File menu now shows staff-relevant shortcuts (Dashboard, Bookings, Financials, Directory)",
      "Fixed: Menu shortcuts now link directly to Staff Portal pages"
    ]
  },
  {
    version: "47.3.0",
    date: "2026-01-28",
    title: "Calendar Refresh Button & Last Updated Time",
    changes: [
      "Added: Sync button now refreshes all calendar data (bookings, requests, closures)",
      "Added: Last updated timestamp shown next to sync button on desktop",
      "Improved: Visual feedback when calendar data is refreshed",
      "Improved: Auto-refresh from webhooks now updates the timestamp"
    ]
  },
  {
    version: "47.2.0",
    date: "2026-01-28",
    title: "Webhook Booking Link Fix",
    changes: [
      "Fixed: Webhook bookings now appear on calendar after linking to member",
      "Fixed: Linked bookings now show on member dashboard correctly",
      "Fixed: Booking status properly set to approved when staff assigns or changes owner",
      "Fixed: All four member assignment endpoints now correctly approve bookings"
    ]
  },
  {
    version: "47.1.0",
    date: "2026-01-28",
    title: "Complete Real-Time Billing Notifications",
    changes: [
      "Added: Real-time notification when invoice is created for member",
      "Added: Real-time notification when invoice is finalized and ready for payment",
      "Added: Real-time notification when invoice is voided",
      "Added: Real-time notification when overage payment is confirmed",
      "Added: Real-time notification when subscription is started",
      "Added: Real-time notification when subscription is cancelled",
      "Improved: All billing operations now trigger instant member notifications"
    ]
  },
  {
    version: "47.0.0",
    date: "2026-01-28",
    title: "Real-Time Notifications for Bookings & Billing",
    isMajor: true,
    changes: [
      "Added: Real-time notification when booking is approved by staff",
      "Added: Real-time notification when booking is declined by staff",
      "Added: Real-time notification when payment is confirmed",
      "Added: Real-time notification when refund is processed",
      "Added: Real-time notification when invoice is paid",
      "Fixed: Book page now refreshes automatically when staff declines a pending booking",
      "Improved: Members receive instant updates for all booking and billing status changes"
    ]
  },
  {
    version: "46.1.0",
    date: "2026-01-28",
    title: "Wellness Tab Mobile Crash Fix",
    changes: [
      "Fixed: Wellness tab no longer crashes on mobile when viewing classes",
      "Fixed: Classes with missing date information are now handled gracefully"
    ]
  },
  {
    version: "46.0.0",
    date: "2026-01-28",
    title: "Production Readiness Improvements",
    isMajor: true,
    changes: [
      "Added: Global error handlers to catch and log unexpected crashes gracefully",
      "Added: Clean shutdown system - server closes connections properly on restart",
      "Added: Monitoring and alerting system for payment failures and critical events",
      "Added: Startup health tracking with categorized warnings and critical failures",
      "Added: Enhanced health check endpoint with uptime and alert status for staff",
      "Improved: Server stability with automatic error recovery",
      "Improved: WebSocket connection security with origin validation"
    ]
  },
  {
    version: "45.3.0",
    date: "2026-01-28",
    title: "Stripe Webhook Fix",
    changes: [
      "Fixed: Add Funds payments now properly credit account balance",
      "Fixed: Removed duplicate Stripe webhook endpoint that was causing signature verification failures",
      "Improved: Stripe webhook reliability - all checkout session events now process correctly"
    ]
  },
  {
    version: "45.2.0",
    date: "2026-01-28",
    title: "Add Funds Balance Update Fix",
    changes: [
      "Fixed: Account balance now updates in real-time after adding funds via 'Add Funds' button",
      "Fixed: Balance notification now correctly targets the member who added funds",
      "Added: Profile page listens for billing updates to refresh balance automatically"
    ]
  },
  {
    version: "45.1.0",
    date: "2026-01-28",
    title: "Staff Profile Bottom Navigation Fix",
    changes: [
      "Fixed: Staff portal profile page no longer shows member bottom navigation on mobile",
      "Improved: Staff see clean profile page with 'Return to Staff Portal' button instead of member nav"
    ]
  },
  {
    version: "45.0.0",
    date: "2026-01-28",
    title: "Real-Time Updates & Optimistic UI",
    isMajor: true,
    changes: [
      "Added: Real-time member profile updates - members see tier and guest pass changes instantly when staff makes edits",
      "Added: Real-time wellness class availability - class spots update live when other members book/cancel",
      "Added: Real-time invoice/payment history - members see payment and refund updates immediately",
      "Added: Real-time guest pass count - remaining passes update instantly when staff redeems a guest",
      "Added: Real-time tour scheduling - staff see tour updates from other staff members immediately",
      "Added: Real-time balance display - member balance updates instantly after payment collection",
      "Added: Optimistic UI for fee collection - 'Paid' status shows immediately while confirming with server",
      "Improved: All real-time updates use rollback on error to maintain data consistency"
    ]
  },
  {
    version: "44.5.0",
    date: "2026-01-28",
    title: "Subscription Date Display Fix",
    changes: [
      "Fixed: Membership renewal date no longer shows '1969' when subscription data is incomplete",
      "Improved: Invalid or missing renewal dates are now handled gracefully"
    ]
  },
  {
    version: "44.4.0",
    date: "2026-01-28",
    title: "Failed Payments Cleanup & Cancel Button",
    changes: [
      "Added: Cancel button on failed payments to dismiss them without going to Stripe",
      "Fixed: Already-canceled payments no longer appear in the Failed Payments list",
      "Improved: Failed Payments section now only shows actionable items (not resolved/canceled ones)",
      "Added: Staff activity logging when payments are canceled"
    ]
  },
  {
    version: "44.3.0",
    date: "2026-01-28",
    title: "Payment Webhook Database Fix",
    changes: [
      "Fixed: Critical bug in payment webhook that prevented payment status from updating correctly",
      "Fixed: Booking participants now properly marked as 'Paid' when Stripe payment succeeds",
      "Fixed: Fee snapshots correctly transition to 'completed' status after payment",
      "Improved: Simplified webhook queries for more reliable payment processing"
    ]
  },
  {
    version: "44.2.0",
    date: "2026-01-28",
    title: "Payment Status Display Fix",
    changes: [
      "Fixed: Collect Payment button now shows 'Paid' indicator when fees have already been collected",
      "Fixed: Financial summary now correctly excludes already-paid fees from the total",
      "Improved: Booking details accurately reflects payment status from Stripe"
    ]
  },
  {
    version: "44.1.0",
    date: "2026-01-28",
    title: "Tier Change Payment Fix",
    changes: [
      "Fixed: Tier changes now correctly charge the member's card instead of Stripe balance",
      "Fixed: Immediate tier changes properly use the customer's default payment method for proration invoices",
      "Improved: Payment method lookup tries subscription default, then customer default, then first attached card"
    ]
  },
  {
    version: "44.0.0",
    date: "2026-01-28",
    title: "Training Guide & Mobile Navigation Update",
    isMajor: true,
    changes: [
      "Updated: Training Guide now reflects current app navigation and mobile hamburger menu",
      "Updated: All training sections updated to reference sidebar and hamburger menu instead of deprecated Employee Resources",
      "Improved: Removed redundant Employee Resources section from mobile dashboard - now accessible via hamburger menu",
      "Added: Hamburger menu on staff portal mobile for quick access to all navigation items",
      "Added: Mobile sidebar mirrors desktop sidebar with Dashboard, Bookings, Financials, Tours, Calendar, Facility, Updates, Directory, Resources, and Admin sections",
      "Fixed: Simulator Overage fee no longer appears on Day Passes purchase page",
      "Fixed: Landing page header now matches green status bar for unified appearance",
      "Fixed: Removed background transition that caused white flash when scrolling",
      "Fixed: Member profile drawer no longer shows gap on right side during slide-in animation"
    ]
  },
  {
    version: "43.14.0",
    date: "2026-01-28",
    title: "Member Profile Performance Optimization",
    changes: [
      "Improved: Member history loading is now 5-10x faster by batching database queries",
      "Improved: Member details page loads faster with parallel data fetching",
      "Fixed: Eliminated N+1 query pattern that caused slowdowns with large booking histories"
    ]
  },
  {
    version: "43.13.0",
    date: "2026-01-28",
    title: "Historical Session Backfill",
    changes: [
      "Added: Backfilled 1,089 billing sessions for historical Trackman bookings (June 2025 - January 2026)",
      "Fixed: Historical bookings now visible in member booking history and staff portals",
      "Fixed: All backfilled sessions marked as 'paid' since they occurred in the past",
      "Improved: Data integrity - cleaned up 7 orphan database records"
    ]
  },
  {
    version: "43.12.0",
    date: "2026-01-28",
    title: "Improved Potential Matches Display",
    changes: [
      "Fixed: Potential Matches section now shows full Trackman booking details (date, time, bay, players)",
      "Added: Clear visual badges show Trackman booking info vs matching app bookings",
      "Improved: Easier to understand why bookings are potential matches"
    ]
  },
  {
    version: "43.11.0",
    date: "2026-01-28",
    title: "Trackman Auto-Match Badge & Concurrency Guard",
    changes: [
      "Added: Auto-matched webhooks now show blue 'Automated' badge in Trackman synced section",
      "Added: Concurrency guard prevents race conditions when multiple processes try to link same booking",
      "Changed: Badge text updated from 'Auto-Linked' to 'Automated' for clarity"
    ]
  },
  {
    version: "43.10.0",
    date: "2026-01-28",
    title: "Trackman Webhook Auto-Match Improvements",
    changes: [
      "Fixed: Webhooks now auto-link to existing bookings by matching bay + date + time",
      "Fixed: Webhooks with externalBookingId now check trackman_external_id column for matching",
      "Fixed: 'Book on Trackman' modal now shows bay preference when bay not yet assigned",
      "Improved: Eliminated need for manual 'Auto Match' button in most webhook scenarios"
    ]
  },
  {
    version: "43.9.0",
    date: "2026-01-28",
    title: "Fix Double Push Notifications for Booking Requests",
    changes: [
      "Fixed: Staff no longer receive duplicate push notifications when members request bookings",
      "Fixed: Removed redundant push notification call that duplicated notifyAllStaff functionality"
    ]
  },
  {
    version: "43.8.0",
    date: "2026-01-28",
    title: "Coupon Selection for New Subscriptions",
    changes: [
      "Added: Staff can now apply coupons/discounts when creating new subscriptions",
      "Added: Coupon dropdown shows all active Stripe coupons with discount details",
      "Added: Supports percentage off and fixed amount discounts with duration info"
    ]
  },
  {
    version: "43.7.0",
    date: "2026-01-28",
    title: "Add Billing Source Dropdown & Fix Tier Clearing",
    changes: [
      "Added: Billing Source dropdown now visible when member has no active subscription",
      "Added: Billing Source dropdown visible in wallet-only mode for members billed elsewhere",
      "Fixed: Staff can now set member tier to 'No Tier' (previously rejected by API)",
      "Fixed: Tier clearing properly updates HubSpot and notifies member"
    ]
  },
  {
    version: "43.6.0",
    date: "2026-01-28",
    title: "Fix Trackman Webhook ON CONFLICT Syntax",
    changes: [
      "Fixed: ON CONFLICT clauses now correctly match partial unique index for booking_requests",
      "Fixed: ON CONFLICT for trackman_bay_slots now uses correct composite key",
      "Fixed: Trackman webhook booking creation/linking now works correctly in production"
    ]
  },
  {
    version: "43.5.0",
    date: "2026-01-28",
    title: "Atomic Duplicate Prevention for Trackman Webhooks",
    changes: [
      "Fixed: Trackman webhook now uses atomic INSERT ON CONFLICT to prevent duplicate bookings in real-time",
      "Fixed: Race condition eliminated - simultaneous webhooks now create exactly one booking",
      "Added: Unique constraint on Trackman booking ID enforced at database level",
      "Added: Automatic duplicate cleanup runs on server startup and daily at 4am Pacific",
      "Added: Admin endpoints to detect and clean up any legacy duplicates"
    ]
  },
  {
    version: "43.4.0",
    date: "2026-01-28",
    title: "Billing Security Hardening",
    changes: [
      "Fixed: Payment snapshots now scoped to booking ID, preventing cross-booking payment intent reuse",
      "Fixed: Payment endpoint validates booking status before processing (rejects cancelled/declined bookings)",
      "Improved: Fee display now shows 'Calculating...' indicator when fees are still being computed",
      "Added: Minutes used today and cached fee data now included in check-in context for accurate fee detection"
    ]
  },
  {
    version: "43.3.0",
    date: "2026-01-28",
    title: "Persistent Sync Timestamp",
    changes: [
      "Last sync time now persists across server restarts",
      "Directory page shows accurate 'Last synced' timestamp even after deployments",
      "Uses existing app_settings table for reliable storage"
    ]
  },
  {
    version: "43.2.0",
    date: "2026-01-28",
    title: "Background Sync Optimization",
    changes: [
      "Moved HubSpot member sync from every 5 minutes to once daily at 3am Pacific",
      "Prevents database connection pool exhaustion during peak hours",
      "Manual sync button still works instantly for on-demand syncing",
      "Added 'Last synced' timestamp next to the Sync button on Directory page",
      "Webhooks continue to handle real-time status/tier updates from HubSpot"
    ]
  },
  {
    version: "43.1.0",
    date: "2026-01-28",
    title: "Roster Placeholder Guest Replacement",
    changes: [
      "Fixed: Adding members to a booking now replaces placeholder guests (Guest 2, Guest 3, etc.)",
      "Previously, adding a named member would keep placeholder guests, causing inflated participant counts",
      "Members added to roster now automatically replace any 'Guest X' placeholders"
    ]
  },
  {
    version: "43.0.0",
    date: "2026-01-28",
    title: "HubSpot Billing Provider Sync",
    isMajor: true,
    changes: [
      "New: billing_provider property syncs to HubSpot (Stripe/MindBody/Manual)",
      "New: membership_status now includes Trialing and Past Due options in HubSpot",
      "New: Centralized syncMemberToHubSpot function for consistent data sync",
      "New: Backfill endpoint to sync all existing contacts with billing data",
      "Stripe subscription webhooks now sync status, tier, and billing provider to HubSpot instantly",
      "Tier upgrades/downgrades now sync to HubSpot",
      "Subscription cancellations now sync cancelled status to HubSpot",
      "Manual billing provider changes by staff now sync to HubSpot",
      "Past due and suspended statuses now sync to HubSpot"
    ]
  },
  {
    version: "42.2.0",
    date: "2026-01-28",
    title: "Final Status Check Sweep",
    changes: [
      "Fixed push-db-tiers endpoint only syncing 'active' members to HubSpot",
      "Fixed billing classification script missing trialing/past_due members",
      "Fixed member search API missing trialing/past_due in all filter branches",
      "25+ total status-related fixes across 13 files"
    ]
  },
  {
    version: "42.1.0",
    date: "2026-01-28",
    title: "HubSpot Webhook Instant Status Updates",
    changes: [
      "HubSpot webhook now instantly updates database when membership_status changes",
      "HubSpot webhook now instantly updates database when membership_tier changes",
      "MindBody billing status changes are now reflected immediately (was 5-minute delay)",
      "Members who pay through MindBody now get instant access updates"
    ]
  },
  {
    version: "42.0.0",
    date: "2026-01-28",
    title: "Deep Sweep - All Status Checks Fixed",
    isMajor: true,
    changes: [
      "CRITICAL: Fixed staff billing member search only showing 'active' members (payments.ts)",
      "CRITICAL: Fixed waiver affected count only counting 'active' members",
      "CRITICAL: Fixed HubSpot deals analytics undercounting active members",
      "CRITICAL: Fixed member billing subscription fetch missing past_due subscriptions",
      "CRITICAL: Fixed Stripe reconciliation only checking 'active' subscriptions",
      "CRITICAL: Fixed Stripe subscription sync only fetching 'active' subscriptions",
      "All Stripe sync operations now include active, trialing, and past_due subscriptions",
      "Fixed member directory SQL filter including trialing/past_due in active members",
      "Fixed 'former members' filter no longer incorrectly including past_due members",
      "22 total status-related fixes across 11 files"
    ]
  },
  {
    version: "41.0.0",
    date: "2026-01-27",
    title: "Comprehensive Status Fix - All Endpoints & UI",
    isMajor: true,
    changes: [
      "CRITICAL: Fixed login flow blocking members with trialing/past_due status from logging in (3 auth paths)",
      "CRITICAL: Fixed HubSpot endpoints only recognizing 'active' status",
      "CRITICAL: Fixed Trackman webhook cancellations missing fee cleanup",
      "CRITICAL: Fixed individual booking payment endpoint hiding valid fees",
      "Fixed MemberProfileDrawer showing reactivation button for past_due members (they still have access)",
      "All cancellation paths now properly clear pending fees",
      "Added Bug Prevention Guidelines to project documentation"
    ]
  },
  {
    version: "40.10.0",
    date: "2026-01-27",
    title: "Critical Pacific Timezone Fix",
    changes: [
      "CRITICAL: Fixed all date comparisons to use Pacific time instead of UTC - bookings from today no longer incorrectly show as 'past' during evening hours",
      "Fixed 50 SQL queries across 8 files that were using server UTC time instead of club Pacific time",
      "Affects member profile, booking history, visit counts, last activity dates, and all date-sensitive features",
      "Evening users (5 PM - midnight Pacific) will now see correct 'today' vs 'past' booking status"
    ]
  },
  {
    version: "40.9.0",
    date: "2026-01-27",
    title: "Balance Display Fix - Show All Pending Fees",
    changes: [
      "CRITICAL: Fixed member balance hiding valid fees when fee snapshots were cancelled/paid",
      "Balance now correctly shows ALL pending fees (overage + guest fees) regardless of snapshot history",
      "Removed faulty filtering logic that was incorrectly treating fees as 'orphaned' when snapshots existed",
      "Cleaned up duplicate pending fee snapshots from database",
      "Fixed $175 in fees only showing as $50 due to incorrect snapshot filtering"
    ]
  },
  {
    version: "40.8.0",
    date: "2026-01-27",
    title: "Payment Modal Fix - Use Existing Payment Intent",
    changes: [
      "Fixed 'Failed to create payment' error - payment modals now correctly use the existing payment intent created by the API instead of trying to create a duplicate",
      "Added StripePaymentWithSecret component to accept pre-created payment intents for unified billing flow"
    ]
  },
  {
    version: "40.7.0",
    date: "2026-01-27",
    title: "Payment Modal Fix & Activity Tab",
    changes: [
      "Fixed 'Failed to create payment' error in both Pay Outstanding Balance and Pay Booking Fees modals",
      "Added Activity tab to member Updates page as the first/default tab - members can now view their notifications including booking confirmations, check-ins, and payment updates",
      "Activity tab shows unread count badge when there are unread notifications",
      "Added 'Mark all as read' button for quick notification management",
      "Notification icons and colors match notification type (booking, payment, check-in, etc.)",
      "Clicking a notification marks it as read and navigates to relevant booking if applicable"
    ]
  },
  {
    version: "40.6.0",
    date: "2026-01-28",
    title: "Member Balance & Payment Flow Fixes",
    changes: [
      "CRITICAL: Fixed member balance showing cancelled/orphaned fees from database instead of actual pending charges",
      "Balance calculation now checks Stripe fee snapshot status - only includes fees with 'pending' snapshots",
      "Fees from sessions with cancelled/paid/failed Stripe payment intents are now correctly excluded",
      "Fixed 'Pay Outstanding Balance' failing to create payment - now properly filters orphaned fees before creating Stripe payment intent",
      "Fixed individual booking payment to handle overage fees (was only looking for guest fees, causing 'No unpaid guest fees found' error)",
      "Renamed 'Pay Guest Fees' modal to 'Pay Booking Fees' to accurately reflect all fee types",
      "Ensures Stripe is the source of truth for billing - database cached fees are filtered by snapshot validity",
      "Added HubSpot sync when existing users purchase Stripe subscriptions (was only working for new users)"
    ]
  },
  {
    version: "40.5.0",
    date: "2026-01-27",
    title: "Trackman Webhook Count Display",
    changes: [
      "Webhook events section now always shows total count (e.g. '4 webhooks received') even when there's only one page",
      "Pagination controls (Previous/Next) still only appear when there are multiple pages of results"
    ]
  },
  {
    version: "40.4.0",
    date: "2026-01-27",
    title: "Simulator Tab Full Height Layout",
    changes: [
      "Removed internal scrolling from the Simulator tab queue and calendar panels",
      "Both the pending/scheduled queue and the day calendar now expand to their full content height",
      "Page now scrolls naturally as a whole, making it easier to access all bookings including Trackman synced cards at the bottom",
      "Fixed awkward scroll behavior where mouse had to be positioned outside card boundaries to scroll the page"
    ]
  },
  {
    version: "40.3.0",
    date: "2026-01-27",
    title: "Check-In Fee Detection Fix",
    changes: [
      "CRITICAL: Fixed check-in not detecting unpaid fees - was reading from legacy usage_ledger table instead of unified fee data",
      "Fixed: Check-in endpoint now reads fees from booking_participants.cached_fee_cents (the authoritative source)",
      "Fixed: Removed duplicate legacy overage check that was querying deprecated booking_requests.overage_fee_cents column",
      "Consolidated to single unified payment check that correctly filters by payment_status = 'pending'",
      "This ensures 'Charge $XX' button appears when members have unpaid fees, preventing uncollected overage charges"
    ]
  },
  {
    version: "40.2.0",
    date: "2026-01-27",
    title: "Fee Estimate Display Fix & Responsive Layout",
    changes: [
      "CRITICAL: Fixed fee estimate showing $0 for all bookings - was caused by incorrect database query (referencing non-existent column)",
      "Fixed: Session participant query now correctly joins booking_requests to booking_sessions",
      "Fixed: Fee snapshot reconciliation scheduler error (was referencing non-existent column)",
      "Improved: Estimated fees card now flexes to screen size on mobile, tablet, and desktop",
      "Verified: Fee calculation works correctly for all tiers (VIP, Social, Core, Premium, Corporate)"
    ]
  },
  {
    version: "40.1.0",
    date: "2026-01-27",
    title: "Fee Calculation Bug Fixes",
    changes: [
      "CRITICAL: Preview mode now counts ALL bookings where member is a participant (owned, booking_members, or booking_participants)",
      "CRITICAL: This prevents surprise overage charges at check-in when member was on another booking earlier that day",
      "Fixed: Preview usage now correctly calculates per-participant minutes (duration / player_count)",
      "Fixed: Double-counting prevented when member is both owner and participant by deduplicating on booking_id",
      "Fixed: Guest fee logic now consistent between feeCalculator and unifiedFeeService",
      "Fixed: Members mistakenly marked as guests no longer charged guest fees (checks for user_id presence)"
    ]
  },
  {
    version: "40.0.0",
    date: "2026-01-27",
    title: "Payment Cancellation and Refund System Overhaul",
    isMajor: true,
    changes: [
      "CRITICAL: Fixed booking cancellations now properly refund paid payments (was trying to cancel succeeded payments which caused errors)",
      "CRITICAL: Cancellation now checks actual Stripe payment status before deciding to refund or cancel",
      "NEW: Centralized PaymentStatusService for atomic updates across all payment tables",
      "NEW: Stripe idempotency keys prevent duplicate payment intents from being created",
      "NEW: Fee snapshot reconciliation scheduler runs every 15 minutes to sync missed payments",
      "Fixed: All payment status changes now consistently update fee snapshots, participant statuses, and audit logs",
      "Fixed: Participant payment_status now includes paid_at timestamp and stripe_payment_intent_id when paid",
      "Fixed: Fee snapshot status now uses 'completed' to match webhook behavior",
      "Improved: Payment confirmation syncs from Stripe even without webhooks (development environment fix)"
    ]
  },
  {
    version: "39.0.0",
    date: "2026-01-27",
    title: "Booking Flow and Fee Calculation Fixes",
    isMajor: true,
    changes: [
      "Fixed: Member booking requests no longer show duplicate confirmation messages",
      "Fixed: Confirmed bookings stay visible on calendar after Trackman webhook confirmation",
      "Fixed: Fee calculation now correctly uses staff-edited player count (was ignoring edits)",
      "Fixed: Daily usage tracking now correctly uses staff-edited player count for allowance calculations",
      "Fixed: Roster check during check-in now respects staff-edited player count",
      "Fixed: Empty player slots now created when player count is increased",
      "CRITICAL: Overage fees now properly saved to bookings during approval (was only storing in session)",
      "CRITICAL: All fee recalculation paths now sync to booking_requests (webhooks, approval, billing)",
      "Improved: Dev simulated webhook now generates realistic Trackman V2 format for testing"
    ]
  },
  {
    version: "38.1.0",
    date: "2026-01-27",
    title: "Editable Player Count for Staff",
    changes: [
      "Staff can now click the Players card in Booking Details to update the player count",
      "Player count changes automatically recalculate fees (fixes incorrect overage charges)",
      "Helpful for correcting bookings where Trackman imported wrong player count",
      "Maximum 4 players per booking enforced"
    ]
  },
  {
    version: "38.0.0",
    date: "2026-01-27",
    title: "Comprehensive Payment Intent Cancellation",
    isMajor: true,
    changes: [
      "CRITICAL: All booking cancellation paths now cancel associated payment intents",
      "Fixed: Member-initiated cancellations properly cancel payment intents",
      "Fixed: Staff-initiated cancellations properly cancel payment intents",
      "Fixed: Reschedule approvals cancel payment intents for original booking",
      "Fixed: Trackman webhook cancellations cancel payment intents",
      "Fixed: Trackman CSV import cancellations cancel payment intents",
      "Fixed: Booking archive/soft-delete cancels payment intents via cascade function",
      "Fixed: 'Invalid Date' no longer appears in payment descriptions when date is missing",
      "Added: Staff cleanup endpoint to cancel stale payment intents from cancelled bookings"
    ]
  },
  {
    version: "37.0.0",
    date: "2026-01-27",
    title: "Critical Fee Estimate Display Fix",
    isMajor: true,
    changes: [
      "CRITICAL: Fixed fee estimates not updating - was calling wrong method on API response",
      "Fixed: Overage fees now correctly display for Core members booking beyond their daily allowance",
      "Fixed: 120-minute Core bookings now show correct $50 overage instead of $0",
      "Added: Cache-control headers to fee estimate endpoints"
    ]
  },
  {
    version: "36.3.0",
    date: "2026-01-27",
    title: "Fee Estimate Caching Fix",
    changes: [
      "Fixed: Fee estimates now refresh properly instead of returning stale cached values",
      "Fixed: Browser caching no longer causes incorrect $0 fee display for overage bookings",
      "Added: Cache-control headers to fee estimate endpoints to prevent stale responses"
    ]
  },
  {
    version: "36.2.0",
    date: "2026-01-27",
    title: "Trackman V2 Webhook Complete Fix",
    changes: [
      "Fixed: V2 webhooks without customer email now create proper booking requests (appear on calendar)",
      "Fixed: V2 webhooks now correctly create Needs Assignment bookings for staff to assign",
      "Fixed: externalBookingId now included in normalized booking data for proper linking",
      "Fixed: Retry button now updates matched_booking_id after successful processing",
      "Fixed: Duplicate prevention when retrying webhooks - returns existing booking instead of creating duplicate"
    ]
  },
  {
    version: "36.1.0",
    date: "2026-01-27",
    title: "Trackman V2 Webhook Processing Fix",
    changes: [
      "Fixed: Trackman V2 webhooks now properly create booking requests when no externalBookingId match",
      "Fixed: V2 payload parsing now correctly handles start/end ISO datetime format",
      "Fixed: handleBookingUpdate detects V2 format and uses correct parser",
      "Fixed: Replayed webhooks from production now appear on booking calendar and queue",
      "Fixed: V2 webhooks fall through to standard processing for member matching and booking creation"
    ]
  },
  {
    version: "36.0.0",
    date: "2026-01-27",
    title: "Critical Fee Estimate Fix",
    isMajor: true,
    changes: [
      "CRITICAL: Fee estimates now correctly show overage charges for new booking requests",
      "Fixed: Preview mode now queries booking_requests table instead of empty usage_ledger",
      "Fixed: Members see accurate fee estimates before submitting booking requests",
      "Fixed: Staff can preview fees for bookings without sessions (uses booking data directly)",
      "Fixed: Prevents unexpected charges at check-in by showing correct fees upfront"
    ]
  },
  {
    version: "35.4.0",
    date: "2026-01-27",
    title: "Billing Modal Session Fix",
    changes: [
      "Fixed: Check-In & Billing modal now creates sessions on-the-fly for bookings without sessions",
      "Fixed: Staff can now see and charge fees for orphaned bookings that failed to create sessions",
      "Fixed: Billing modal shows correct fees instead of 'Complete Check-In' for bookings with overage"
    ]
  },
  {
    version: "35.3.0",
    date: "2026-01-27",
    title: "Daily Usage & Notification Fixes",
    changes: [
      "Fixed: Daily usage now correctly includes 'attended' bookings (prevents unlimited bookings after check-in)",
      "Fixed: Check-in and no-show notifications use correct database schema (user_email column)",
      "Fixed: Simulated Trackman bookings now appear in Trackman Synced section",
      "Fixed: Fee estimates now correctly calculate overage when member has already attended bookings today"
    ]
  },
  {
    version: "35.2.0",
    date: "2026-01-27",
    title: "Comprehensive Fee Calculation Fix",
    changes: [
      "Fixed: Real Trackman webhook bookings now create booking_participants with cached fees",
      "Fixed: Linked pending bookings via Trackman webhook now create sessions and participants if missing",
      "Fixed: Assigning unmatched Trackman bookings to members now recalculates fees",
      "Fixed: Ghost booking auto-fix tool now creates participants and caches fees",
      "Fixed: Staff adding members/guests to bookings now triggers fee recalculation",
      "Fixed: Linking members to booking slots now recalculates session fees",
      "Fixed: 'Has Unpaid Fees' indicator now shows correctly across all booking creation flows"
    ]
  },
  {
    version: "35.1.0",
    date: "2026-01-27",
    title: "Overdue Payment Check-In Fix",
    changes: [
      "Fixed: Staff can now complete check-in for cancelled bookings that have pending payments (overdue payment recovery)",
      "Fixed: Resolves 'Cannot update booking with status: cancelled' error when marking overdue payments as paid",
      "Fixed: Simulated booking confirmations now calculate fees immediately after creating participants",
      "Fixed: Staff dashboard receives real-time notification when bookings are confirmed for instant UI refresh"
    ]
  },
  {
    version: "35.0.0",
    date: "2026-01-27",
    title: "Cross-Platform Sync Tools",
    isMajor: true,
    changes: [
      "Added: Tier reconciliation check - compares member tier across HubSpot, Stripe, and app database with high-severity flagging for mismatches",
      "Added: Subscription status alignment tool - syncs membership_status from Stripe subscription states (active, canceled, past_due, etc.)",
      "Added: Stripe-HubSpot linking tool - creates missing HubSpot contacts for Stripe customers and vice versa",
      "Added: Payment status sync - updates HubSpot last_payment_status, last_payment_date, and last_payment_amount from Stripe invoices",
      "Added: Visit count sync - updates HubSpot total_visit_count from actual app check-in records",
      "Added: Trackman ghost booking auto-fix - creates missing billing sessions for orphaned Trackman bookings with idempotent protection",
      "Added: Email/contact deduplication detection - finds duplicate emails in app and HubSpot for manual review",
      "UX: New Cross-Platform Sync Tools section in Data Integrity with Preview/Execute pattern for all tools"
    ]
  },
  {
    version: "34.5.0",
    date: "2026-01-27",
    title: "Mind Body ID Data Integrity",
    changes: [
      "Fixed: HubSpot sync now clears stale Mind Body IDs not present in HubSpot (instead of preserving old values)",
      "Fixed: Member profile drawer only shows Mind Body ID when validated from HubSpot sync",
      "Added: Admin tool to create HubSpot contacts for members without one (Data Tools section)",
      "Added: Admin tool to cleanup stale Mind Body IDs by comparing against HubSpot",
      "UX: Both tools have Preview and Execute buttons in the Data Integrity admin page"
    ]
  },
  {
    version: "34.4.0",
    date: "2026-01-27",
    title: "Responsive Layout & Modal Fixes",
    changes: [
      "UX: Desktop layouts now use responsive grids (3-4 columns) that fill available space alongside sidebar",
      "UX: Dashboard, Events, Wellness grids scale from 1→2→3→4 columns across breakpoints",
      "UX: BookGolf time slots and resource cards use responsive grid layouts on larger screens",
      "UX: History page visits and payments display in 2-column grid on desktop",
      "UX: Increased bottom nav touch targets (48px min height) and improved icon/label sizing",
      "UX: Added responsive padding scaling (px-6 → lg:px-8 → xl:px-12) across member pages",
      "Fixed: Search dropdowns in modals now display properly without being cut off (ManagePlayersModal, StaffDirectAddModal, CompleteRosterModal)"
    ]
  },
  {
    version: "34.3.0",
    date: "2026-01-27",
    title: "Animation System Standardization",
    changes: [
      "UX: Replaced all hardcoded animation delays with dynamic stagger indices app-wide",
      "UX: MemberProfileDrawer uses spring physics for natural bounce on slide-in",
      "UX: Dashboard content crossfades from skeleton using SmoothReveal wrapper",
      "UX: Updated 20+ admin components (all tabs, GalleryAdmin, FaqsAdmin, AnnouncementManager, AvailabilityBlocksContent, ChangelogTab, DirectoryTab, DiscountsSubTab, UpdatesTab, BookingQueuesSection)",
      "UX: Updated member pages (Profile sections, BookGolf time slots/resources, Dashboard cards, History, GlassRow)",
      "UX: Updated public pages (Landing FeatureCards, PrivateHire SpaceCards, MenuOverlay navigation links)"
    ]
  },
  {
    version: "34.2.0",
    date: "2026-01-27",
    title: "Premium Motion & Interaction Polish",
    changes: [
      "UX: Added shimmer effect on interactive cards for premium glass feel",
      "UX: Improved stagger animations with smooth slide-up and spring physics",
      "UX: Added SmoothReveal component for smoother skeleton-to-content transitions",
      "UX: Enhanced tap feedback with consistent scaling across interactive elements"
    ]
  },
  {
    version: "34.1.0",
    date: "2026-01-27",
    title: "Data Integrity & Reconciliation Fixes",
    changes: [
      "Fixed: HubSpot sync check now uses random sampling to check all members over time",
      "Fixed: Resolve endpoint now corrects usage ownership when re-resolving to a different member",
      "Fixed: Reassign only updates owner entries in usage ledger (not guest entries)",
      "Fixed: Session creation uses stable IDs to prevent duplicates on re-resolve"
    ]
  },
  {
    version: "34.0.0",
    date: "2026-01-27",
    title: "Trackman Reconciliation & Admin UI Overhaul",
    isMajor: true,
    changes: [
      "Fixed: Resolving unmatched bookings now creates proper billing sessions and ledger entries",
      "Fixed: Reassigning matched bookings now updates participants, ledger, and billing correctly",
      "Fixed: Auto-resolved bookings (same email) also get proper session creation",
      "Added: Ghost booking detection in Data Integrity (finds bookings missing billing sessions)",
      "Redesigned: Trackman admin tables now use dense data table layout for faster scanning",
      "Redesigned: Data Integrity page now uses master-detail split layout for easier navigation"
    ]
  },
  {
    version: "33.1.0",
    date: "2026-01-27",
    title: "Webhook Matching Safety Improvements",
    changes: [
      "Fixed: Back-to-back booking matching now validates end time to prevent matching the wrong slot",
      "Fixed: Pending request matching correctly handles two consecutive 30-minute bookings",
      "Improved: Pre-check availability before creating Trackman bookings for clearer conflict logging",
      "Improved: Cancelled booking linking also uses strict overlap validation"
    ]
  },
  {
    version: "33.0.0",
    date: "2026-01-27",
    title: "Production Readiness Improvements",
    isMajor: true,
    changes: [
      "Fixed: Conflict detection time overlap logic now handles edge cases correctly",
      "Fixed: Trackman webhook matching now checks bay/resource to prevent back-to-back booking mismatches",
      "Improved: Webhook time tolerance tightened from 15 to 10 minutes for more precise matching",
      "Improved: Webhook matching prioritizes exact resource matches, with fallback for legacy bookings",
      "Verified: HubSpot syncs properly use queue system for resilient async processing"
    ]
  },
  {
    version: "32.11.0",
    date: "2026-01-27",
    title: "Improved Payment Descriptions",
    changes: [
      "UX: Payment descriptions now show readable dates (e.g., 'Jan 27, 2026' instead of '2026-01-27T08:00:00.000Z')",
      "UX: Time range displayed in 12-hour format (e.g., '8:30 AM - 12:30 PM')",
      "Clarity: Fee breakdown now shows what charges consist of (Overage, Guest fees) for Stripe and member visibility"
    ]
  },
  {
    version: "32.10.0",
    date: "2026-01-27",
    title: "Player Search Improvements",
    changes: [
      "Fixed: Player search in booking details now finds both members and past guests",
      "UX: Members appear with green badge showing their tier, guests show in gray",
      "Workflow: Selecting a member links them as a player, selecting a guest adds them as a guest"
    ]
  },
  {
    version: "32.9.0",
    date: "2026-01-27",
    title: "Check-In Page Architecture Fix",
    changes: [
      "Fixed: Viewing the check-in page no longer writes to the database (GET requests are now read-only)",
      "Improvement: Fees are now recalculated when staff takes a payment action, not when viewing",
      "Performance: Reduces unnecessary database writes and prevents potential race conditions"
    ]
  },
  {
    version: "32.8.0",
    date: "2026-01-26",
    title: "Session Backfill Payment Status Fix",
    changes: [
      "Fixed: Backfill tool now marks historical booking participants as 'paid' instead of 'pending'",
      "Prevents: Backfilled historical bookings no longer appear in Overdue Payments section",
      "Data: Uses 'external' payment method to indicate payment was handled outside the system"
    ]
  },
  {
    version: "32.7.0",
    date: "2026-01-26",
    title: "Auto-Open Billing After Assignment",
    changes: [
      "UX: Billing modal now opens automatically after assigning a member to a Trackman booking with fees",
      "Improvement: Staff can immediately mark payments as waived/paid externally for historical bookings",
      "Workflow: Prevents newly-assigned bookings from appearing as 'overdue' without review"
    ]
  },
  {
    version: "32.6.0",
    date: "2026-01-26",
    title: "Trackman Assignment Fee Recalculation",
    changes: [
      "Fixed: Billing fees are now recalculated when staff assigns a Trackman booking to a member",
      "Fixed: Member tier-based allowances now correctly applied after post-check-in assignment",
      "Reliability: Both 'Link to Member' and 'Assign Players' actions trigger fee recalculation",
      "Audit: Staff actions logged with fees_recalculated flag for tracking"
    ]
  },
  {
    version: "32.5.0",
    date: "2026-01-26",
    title: "Check-In & Refund Notifications",
    changes: [
      "Added: Members now receive notifications when checked in ('Check-In Complete')",
      "Added: Members receive notification if marked as no-show with instructions to contact staff",
      "Added: Automatic notification when booking payments are refunded",
      "Added: Database-level trigger prevents double-booking the same bay on new sessions",
      "Reliability: All notifications sent via both in-app and real-time WebSocket channels"
    ]
  },
  {
    version: "32.4.0",
    date: "2026-01-26",
    title: "Booking Cancellation Refunds",
    changes: [
      "Added: Guest fee payments are now automatically refunded when bookings are canceled",
      "Added: Works for both member-initiated and staff-initiated cancellations",
      "Added: Refund metadata tracks booking ID and participant for reconciliation",
      "Reliability: Non-blocking refund processing with error logging for manual follow-up"
    ]
  },
  {
    version: "32.3.0",
    date: "2026-01-26",
    title: "Safe Account Credit Integration",
    changes: [
      "Improved: Account credits now applied safely - no credit lost if card payment fails",
      "Changed: For partial credits, full amount is charged first, then credit portion refunded automatically",
      "Added: Webhook processes credit refunds with audit logging for failed refunds",
      "UX: Payment modals clearly explain that credits will be applied as a refund after payment"
    ]
  },
  {
    version: "32.2.0",
    date: "2026-01-26",
    title: "Account Credits Applied to Booking Payments",
    changes: [
      "Added: Account credits are now automatically applied when members pay guest fees or outstanding balances",
      "Added: Payment modals show how much account credit was applied vs. card charged",
      "Added: If account balance covers the full amount, no card payment is needed",
      "Added: Admin tool to backfill sessions for legacy Trackman-imported bookings",
      "Reliability: Members with account credits will see them automatically deducted from fees"
    ]
  },
  {
    version: "32.1.0",
    date: "2026-01-26",
    title: "Staff Subscription Management",
    changes: [
      "Added: Staff can now create new membership subscriptions directly from the member billing tab",
      "Added: 'Create Subscription' button appears when a member has Stripe set up but no active subscription",
      "Added: Modal to select membership tier when creating a new subscription",
      "Added: Stripe ID now displays in member header alongside Mindbody ID and HubSpot ID",
      "Improved: Create Subscription option now shows for Mindbody members to enable migration to Stripe billing"
    ]
  },
  {
    version: "32.0.0",
    date: "2026-01-26",
    title: "Double-Booking Protection & HubSpot Reliability",
    isMajor: true,
    changes: [
      "Architecture: Added database-level constraint that makes double-booking the same bay physically impossible",
      "Reliability: HubSpot syncs now run in the background - member actions complete instantly even if HubSpot is slow",
      "Added: Background queue system processes HubSpot updates every 2 minutes with automatic retries",
      "Data cleanup: Resolved 8 overlapping Trackman phantom bookings from historical imports"
    ]
  },
  {
    version: "31.2.0",
    date: "2026-01-26",
    title: "Trackman Sync Improvements",
    changes: [
      "Fixed: Trackman Bookings Synced accordion now shows booking details and webhook data when expanded",
      "Fixed: Trackman webhook processing now supports all booking event types (created, updated, cancelled)",
      "Added: Linked member name and auto-link status now shown in Trackman sync cards"
    ]
  },
  {
    version: "31.1.0",
    date: "2026-01-26",
    title: "Performance & Safety Improvements",
    changes: [
      "Performance: Added database indexes for faster email lookups across all booking queries",
      "Performance: Fee calculations now batch database queries - reduced from ~12 queries to 3 per booking",
      "Reliability: Guest pass deductions now use transaction locking to prevent double-spending",
      "Reliability: Fee amounts are verified before payment completes - detects if fees changed after booking",
      "Maintenance: Created centralized pricing configuration - easier to update fees in the future",
      "Fixed: HubSpot contact sync now handles duplicate contacts more reliably",
      "Fixed: Staff check-in now uses shared tier rules - consistent guest validation"
    ]
  },
  {
    version: "31.0.0",
    date: "2026-01-26",
    title: "Unified Fee Service & System Reliability",
    isMajor: true,
    changes: [
      "Architecture: Created Unified Fee Service - single authoritative source for all fee calculations across the app",
      "Consistency: All fee previews (booking, roster, approval, check-in, payments) now use the same calculation engine",
      "Fixed: Fee amounts now always match between what members see and what gets charged",
      "Reliability: Payment processing from Stripe now handles retries safely - no duplicate charges or emails",
      "Concurrency: Staff roster edits are now protected - simultaneous edits won't overwrite each other",
      "Added: 64 new automated tests covering fee calculations, payment safety, and roster protection"
    ]
  },
  {
    version: "30.7.0",
    date: "2026-01-26",
    title: "Roster Sync & Payment UX Improvements",
    changes: [
      "Fixed: Staff edits to booking roster now update fee estimates shown to members - adding/removing players recalculates time allocation correctly",
      "Improved: Pay Now option only appears after staff confirms booking - pending bookings show 'Pay online once confirmed, or at check-in'",
      "Added: Payment status badges on booking cards - shows 'Paid' (green) or amount due (amber) for confirmed bookings",
      "Added: Payment timing message on booking page - 'Pay online once booking is confirmed, or at check-in'",
      "Fixed: Time allocation now uses actual participant count when it exceeds declared count (e.g., 240min ÷ 5 players = 48min each)"
    ]
  },
  {
    version: "30.6.0",
    date: "2026-01-26",
    title: "Unified Fee Calculations",
    changes: [
      "Unified: Members and staff now see identical fee estimates - same server calculation for both",
      "Added: New /api/fee-estimate endpoint provides consistent fee previews across all booking flows",
      "Improved: Fee estimates update in real-time as booking details change",
      "Fixed: Eliminated calculation discrepancies between member booking and staff approval views"
    ]
  },
  {
    version: "30.5.0",
    date: "2026-01-26",
    title: "Booking Flow Audit Fixes",
    changes: [
      "Added: Fee estimate preview in staff approval modal - see estimated costs before approving",
      "Added: Guest search in booking management - staff can now search existing guests instead of re-entering info",
      "Added: Search/New toggle for guest entry with autocomplete and full email visibility",
      "Fixed: Staff member search now uses fresh API data instead of potentially stale cached data",
      "Improved: Staff see full email addresses in search results (not redacted)"
    ]
  },
  {
    version: "30.4.0",
    date: "2026-01-26",
    title: "Simplified Billing Model",
    changes: [
      "Changed: Owner now pays all fees (their overage + player fees + guest fees) in one charge",
      "Improved: Financial summary shows clear breakdown of owner overage, player fees, and guest fees",
      "Improved: Total displayed as 'Owner Pays' to clarify who is responsible for payment",
      "Simplified: No more separate 'Players Owe' section - everything rolls up to owner"
    ]
  },
  {
    version: "30.3.0",
    date: "2026-01-26",
    title: "Add Guest & Financial Summary Fixes",
    changes: [
      "Fixed: Add Guest button now works correctly in confirmed booking details",
      "Fixed: Financial summary now correctly shows Players Owe amounts for non-owner members",
      "Fixed: Social tier player fees now appear in financial breakdown instead of showing $0",
      "Added: Guest entry form accepts name and optional email for new guests",
      "Added: System detects if guest email belongs to existing member and offers to link them instead",
      "Improved: Unmatched/placeholder booking owners now get empty slots for staff assignment"
    ]
  },
  {
    version: "30.2.0",
    date: "2026-01-26",
    title: "Confirmed Booking Details Enhancement",
    changes: [
      "Added: Player roster management now shows in confirmed booking details modal",
      "Added: Staff can add/remove members and guests from confirmed bookings before check-in",
      "Added: Financial summary shows guest pass usage and estimated fees for confirmed bookings",
      "Added: Player slots are automatically created when viewing booking details",
      "Improved: Booking details modal now uses declared player count to create appropriate slots"
    ]
  },
  {
    version: "30.1.0",
    date: "2026-01-26",
    title: "Booking Request Error Fix",
    changes: [
      "Fixed: Booking requests now succeed without showing false error message",
      "Fixed: Date formatting for notifications now handles database Date objects correctly"
    ]
  },
  {
    version: "30.0.0",
    date: "2026-01-26",
    title: "Architecture & Performance Improvements",
    isMajor: true,
    changes: [
      "Performance: All DataContext functions now memoized with useCallback to prevent unnecessary re-renders",
      "Performance: Context value wrapped in useMemo for stable references across renders",
      "Architecture: Backend startup tasks extracted to dedicated loader module for cleaner organization",
      "Architecture: Route registration extracted to separate loader module (server/loaders/routes.ts)",
      "Architecture: Added /api/ready endpoint for proper readiness probes (returns 503 until startup complete)",
      "Reliability: Added graceful shutdown handlers for SIGTERM/SIGINT signals",
      "Reliability: Server now properly closes connections and database pools on shutdown"
    ]
  },
  {
    version: "29.6.0",
    date: "2026-01-26",
    title: "Critical Booking Participant Data Fix",
    changes: [
      "Fixed: Directory-selected guests are now properly saved with booking requests (were previously lost)",
      "Fixed: Guest pass counting now correctly includes guests selected from visitor directory",
      "Fixed: Booking response now sent before notifications to prevent false error messages",
      "Improved: Participant data includes userId and name for visitors selected from directory"
    ]
  },
  {
    version: "29.5.0",
    date: "2026-01-26",
    title: "Guest Pass Pending Request Calculation",
    changes: [
      "Fixed: Guest pass estimate now accounts for pending booking requests (conservative calculation)",
      "Fixed: Booking request error handling improved - JSON parsing more resilient",
      "Improved: API returns both actual and conservative remaining passes for accurate estimates"
    ]
  },
  {
    version: "29.4.0",
    date: "2026-01-26",
    title: "Guest Pass Integration in Booking Fees",
    changes: [
      "Improved: Estimated fees now show guest pass usage when booking with guests",
      "Improved: Guest fees apply immediately when selecting Guest (not just when email is entered)",
      "Improved: Clear breakdown showing guests covered by passes ($0) vs charged guests ($25 each)",
      "Improved: Shows remaining guest passes after booking (e.g. '0 of 4')"
    ]
  },
  {
    version: "29.3.0",
    date: "2026-01-25",
    title: "Activity Tab & Lifetime Visits Improvements",
    changes: [
      "Fixed: Duplicate simulator bookings no longer appear in member Activity tab",
      "Fixed: Lifetime visits count now includes attended events and wellness classes (not just simulator bookings)",
      "Fixed: Member activity history displays correctly in staff directory profile drawer"
    ]
  },
  {
    version: "29.2.0",
    date: "2026-01-25",
    title: "Staff Directory Activity Tab Fix",
    changes: [
      "Fixed: Member activity history now displays correctly in staff directory profile drawer",
      "Fixed: Visit counts, booking history, event RSVPs, and wellness classes now show properly when viewing a member's profile",
      "Note: Previously the Activity tab showed 'No activity history found' due to a data formatting issue"
    ]
  },
  {
    version: "29.1.0",
    date: "2026-01-25",
    title: "Improved Player Selection for Booking Requests",
    changes: [
      "New: Search for club members when adding players to your booking - type a name to find them quickly",
      "New: Search the guest directory to add previous visitors without re-entering their information",
      "New: Guest fee now only applies when adding a non-member guest - adding club members is free",
      "Improved: Clear messaging when no matches found - for members, you'll see a helpful note; for guests, you can add them by email",
      "Fixed: Player information is now properly linked to member/visitor records for better tracking"
    ]
  },
  {
    version: "29.0.0",
    date: "2026-01-25",
    title: "Codebase Modernization & Maintainability",
    isMajor: true,
    changes: [
      "Improved: Major backend code reorganization - large files split into focused modules for easier maintenance",
      "Improved: Stripe payment handling now organized by function (payments, subscriptions, invoices, coupons)",
      "Improved: Member management code organized by area (search, profiles, admin actions, notes)",
      "Improved: Booking system organized by function (resources, bookings, approvals, calendar)",
      "Improved: Trackman integration organized by function (webhooks, validation, billing, imports)",
      "Technical: Total of 15,535 lines of code reorganized into 34 focused modules"
    ]
  },
  {
    version: "28.2.0",
    date: "2026-01-25",
    title: "Transaction Safety & Data Integrity Improvements",
    changes: [
      "Fixed: Booking sessions, participants, and usage records are now saved together as one atomic operation - if any part fails, nothing is saved (prevents partial data)",
      "Fixed: Calendar sync now consistently uses Pacific timezone midnight to avoid potential date mismatches",
      "Improved: Email comparisons are now case-insensitive throughout the system for more reliable member matching",
      "Improved: Server error logging is now more consistent for easier troubleshooting"
    ]
  },
  {
    version: "28.1.0",
    date: "2026-01-25",
    title: "Booking Details Fee Calculation Fix",
    changes: [
      "Fixed: Empty player slots in Booking Details now show $25 pending fee until a member is assigned",
      "Fixed: Financial summary correctly calculates Total Due including all empty/pending slots",
      "Improved: Empty slots display 'Pending assignment - $25' fee note for staff clarity"
    ]
  },
  {
    version: "28.0.0",
    date: "2026-01-25",
    title: "Trackman Booking Assignment Overhaul",
    isMajor: true,
    changes: [
      "New: Redesigned 'Assign Member to Booking' modal with 4 player slots for unmatched Trackman bookings",
      "New: Staff can add guest placeholders that count toward $25 fees immediately, with details added later",
      "New: 'Mark as Private Event' option removes event blocks from unmatched queue without requiring member assignment",
      "New: Member search in each slot with support for members, visitors, and guest placeholders",
      "Improved: Player count from member requests is now preserved when Trackman imports match bookings",
      "Improved: Trackman is source of truth for times/bay, app is source of truth for player count when request exists",
      "Improved: Player count mismatch detection flags when Trackman reports more players than the app request",
      "Improved: Merge logic preserves existing participants when webhook bookings link to member requests",
      "Fixed: Guest fee calculation now works correctly for guest placeholder slots ($25 per guest)"
    ]
  },
  {
    version: "27.1.0",
    date: "2026-01-25",
    title: "Membership Payment Labels",
    changes: [
      "Improved: Payment history now shows specific membership tier (e.g., 'Ace Membership' instead of generic 'Membership Payment')",
      "Fixed: Tier names are extracted from Stripe invoice descriptions for clearer billing history"
    ]
  },
  {
    version: "27.0.0",
    date: "2026-01-25",
    title: "Member Profile Drawer Redesign",
    isMajor: true,
    changes: [
      "New: Consolidated member profile tabs from 11 down to 5 for improved usability",
      "New: Activity tab combines Bookings, Events, Wellness, and Visits in a unified timeline view",
      "New: Billing tab now includes guest passes, group billing, and purchase history",
      "New: Activity tab filter navigation lets you quickly filter by activity type",
      "Improved: Billing tab moved to 2nd position for faster staff access",
      "Improved: Notes tab moved earlier in tab order for quick access",
      "Improved: Cleaner navigation with fewer tabs and better information hierarchy"
    ]
  },
  {
    version: "26.1.0",
    date: "2026-01-25",
    title: "Billing UI Consolidation",
    changes: [
      "New: Billing Source dropdown now inside Subscription card for cleaner layout",
      "New: 'Sync' button moved into Subscription section next to 'Change Tier' button",
      "New: Status badge now appears inline with Subscription section title",
      "New: Single sync button performs metadata, tier, and transaction cache sync in one click",
      "Fixed: Stripe Customer ID and HubSpot ID now display in member profile header",
      "Fixed: Tier sync now correctly returns tier data for already-matching tiers",
      "Improved: Cleaner billing UI with fewer separate sections"
    ]
  },
  {
    version: "26.0.0",
    date: "2026-01-25",
    title: "Day Pass Management & UI Improvements",
    isMajor: true,
    changes: [
      "New: Financials page now shows 'Recent Unredeemed Passes' section with all active day passes",
      "New: Each unredeemed pass displays holder name, pass type, remaining uses, and purchase date",
      "New: Quick 'Redeem' button on each pass card for streamlined check-in flow",
      "New: 'Refund' button with confirmation dialog for canceling unused day passes",
      "New: Real-time updates via WebSocket when day passes are purchased or redeemed",
      "New: Record Purchase search now includes visitors and former members alongside active members",
      "New: Search results show 'Visitor' badge to distinguish non-members",
      "Fixed: Join date now displays correctly for all users created via the app",
      "Fixed: Quick actions button now positions correctly at the bottom corner on desktop",
      "Improved: Optimistic UI for pass redemption provides instant visual feedback"
    ]
  },
  {
    version: "25.0.0",
    date: "2026-01-25",
    title: "New User Flow & Visitor Payment Links",
    isMajor: true,
    changes: [
      "New: 'New User' modal replaces 'Invite New Member' - now creates visitor records without requiring immediate payment",
      "New: Staff can add users with just name, email, and optional phone - no tier selection required upfront",
      "New: Newly added users appear in Directory's Visitors tab with type 'New (Staff Added)'",
      "New: Visitor profile drawer now includes tier selection dropdown for sending payment links",
      "New: When visitors pay via payment link, they automatically become active members with Stripe billing",
      "New: Membership status syncs to HubSpot when subscription is activated",
      "Improved: Removed 'New Booking' from staff quick actions menu - all simulator bookings go through Trackman"
    ]
  },
  {
    version: "24.0.0",
    date: "2026-01-25",
    title: "Pre-Declare Players & Participant Notifications",
    isMajor: true,
    changes: [
      "New: Members can now specify player emails when submitting a booking request (before staff approval)",
      "New: Player slot input fields appear when booking for 2+ players, with member/guest type toggles",
      "New: When a booking is confirmed, all declared participants are automatically added to the roster and notified",
      "New: Bookings now appear on each participant's dashboard when they're linked to the booking",
      "Improved: Pre-declared participant emails appear in Trackman notes with their type (M or G prefix)"
    ]
  },
  {
    version: "23.7.0",
    date: "2026-01-25",
    title: "Trackman Modal Fixes",
    changes: [
      "Fixed: 'Book on Trackman' modal now correctly shows declared player count instead of always showing 1 player",
      "Fixed: Clicking pending request cells in calendar now opens the Trackman booking modal instead of the decline modal",
      "Improved: Trackman notes now include placeholder lines for all declared players (e.g., G|none|Guest|2)"
    ]
  },
  {
    version: "23.6.0",
    date: "2026-01-25",
    title: "Bay Preference Display Fix",
    changes: [
      "Fixed: Pending booking requests now correctly show the member's selected bay instead of 'any bay available'",
      "Fixed: Simulate-confirm endpoint now creates proper session and participant records for testing"
    ]
  },
  {
    version: "23.5.0",
    date: "2026-01-25",
    title: "Trackman-Only Booking Workflow",
    changes: [
      "Changed: Removed manual booking button from staff Bookings page - all simulator bookings must now go through Trackman",
      "Changed: Empty calendar slots are no longer clickable - bookings are created via member requests and confirmed by Trackman webhooks",
      "Note: Staff can still reschedule existing bookings using the Reschedule button on each booking"
    ]
  },
  {
    version: "23.4.0",
    date: "2026-01-25",
    title: "Trackman Webhook Backfill",
    changes: [
      "New: CSV imports now backfill webhook-created bookings with missing data",
      "New: Player counts from import files update webhook bookings that have incomplete data",
      "New: Missing player slots are automatically created when importing Trackman files",
      "New: Notes from Trackman import are added to webhook bookings that were missing notes",
      "New: Sessions and billing records are backfilled for webhook bookings missing them",
      "Improved: Duplicate booking prevention - matching now strictly uses Trackman booking ID",
      "Fixed: Unmatched webhook bookings can now be linked to members during CSV import"
    ]
  },
  {
    version: "23.3.0",
    date: "2026-01-24",
    title: "Trackman Auto-Match Feature",
    changes: [
      "New: Auto Match button on unlinked Trackman webhook events",
      "New: Staff can now try to automatically match Trackman bookings to existing member requests by bay, date, and time",
      "New: Works for both pending requests (auto-approves) and already-approved bookings without Trackman ID",
      "Improved: Auto-match searches for bookings within 30 minutes of the Trackman booking time"
    ]
  },
  {
    version: "23.2.0",
    date: "2026-01-24",
    title: "Booking Management Improvements",
    changes: [
      "Improved: OTP code delivery is now faster - emails sent in the background after validation",
      "Fixed: Directory drawer close button no longer blocked by iOS status bar/notch",
      "Fixed: Booking resolution now works for legacy unmatched Trackman entries - creates proper booking records when resolving",
      "Fixed: Guest pass count display now shows accurate tier totals instead of confusing fallbacks",
      "Improved: Unified player management UI - Manage Players modal now shows booking context header with date, bay, duration and expected vs assigned player counts in one place"
    ]
  },
  {
    version: "23.1.0",
    date: "2026-01-24",
    title: "Enhanced Visitor Types",
    changes: [
      "New: Visitors tab now shows specific visitor types based on activity",
      "New: ClassPass visitors identified by their ClassPass purchases",
      "New: Sim Walk-In visitors identified by simulator walk-in purchases",
      "New: Private Lesson visitors identified by lesson purchases",
      "New: Guest visitors identified when they appear on member bookings",
      "Improved: Type detection is automatic based on most recent activity",
      "Improved: Filter dropdown includes all new visitor types"
    ]
  },
  {
    version: "23.0.0",
    date: "2026-01-24",
    title: "HubSpot → App Sync Improvements",
    isMajor: true,
    changes: [
      "New: Member birthdays now sync from HubSpot - useful for birthday celebrations!",
      "New: Member addresses now sync from HubSpot (street, city, state, zip) - populated from Mindbody",
      "New: Notes from Mindbody now create dated entries when changed - preserves history instead of overwriting",
      "Improved: Billing source now respects billing_provider field first - fixes incorrect 'Stripe' labels for Mindbody members",
      "Improved: Active status for Mindbody members automatically syncs from HubSpot",
      "Improved: Contact info (phone, address) now flows from Mindbody → HubSpot → App consistently"
    ]
  },
  {
    version: "22.1.0",
    date: "2026-01-24",
    title: "Visitors Directory Improvements",
    changes: [
      "New: Search bar in Visitors tab - search by name, email, or phone",
      "Improved: Stripe now takes priority as billing source - visitors with Stripe accounts always show as 'Stripe' source",
      "Improved: Purchase counts and totals now combine data from both Stripe and Mindbody imports",
      "Fixed: Source filter now works correctly for MindBody, Stripe, and HubSpot contacts"
    ]
  },
  {
    version: "22.0.0",
    date: "2026-01-24",
    title: "Mindbody CSV Import",
    isMajor: true,
    changes: [
      "New: Staff can upload Mindbody CSV exports directly in Data Integrity page",
      "New: First Visit Report helps match customers by email and phone before importing sales",
      "New: Enhanced matching logic - tries Mindbody ID, then email, then phone, then name",
      "New: Imported purchases appear in member billing history with Mindbody badge",
      "New: Import results show detailed stats on matched/unmatched records",
      "Improved: Duplicate detection prevents re-importing the same sales"
    ]
  },
  {
    version: "21.1.0",
    date: "2026-01-24",
    title: "Visitors Directory Pagination",
    changes: [
      "Improved: Visitors tab now shows total count of all visitors in the system",
      "Improved: Load More button to fetch additional visitors in batches of 100",
      "Improved: Better performance when browsing large visitor lists"
    ]
  },
  {
    version: "21.0.0",
    date: "2026-01-24",
    title: "Member Visits Tab",
    isMajor: true,
    changes: [
      "New: History page now shows a unified Visits tab combining all your club activity",
      "New: See every booking you attended - whether as host, added player, or guest",
      "New: Guest visits show who invited you; player visits show who you played with",
      "New: Digital card lifetime visits now includes all visit types, not just bookings you created",
      "Improved: Simplified navigation - just Visits and Payments tabs",
      "Improved: Each visit shows a colored role badge for easy identification"
    ]
  },
  {
    version: "20.4.0",
    date: "2026-01-24",
    title: "Unified Visits System (Staff)",
    changes: [
      "New: Staff profile drawer Visits tab shows ALL member visits - as host, guest, player, wellness, events",
      "New: Each visit shows a role badge (Host, Player, Guest, Wellness, Event) for easy identification",
      "New: Guest visits show who invited them to the booking",
      "Improved: Lifetime visits count in directory now includes all visit types",
      "Improved: Last visit date in directory now reflects most recent activity across all visit types",
      "Improved: Directory now counts wellness class attendance toward lifetime visits"
    ]
  },
  {
    version: "20.3.0",
    date: "2026-01-24",
    title: "Visitor Deletion with External Data Cleanup",
    changes: [
      "New: Staff can now permanently delete visitors from the visitor profile drawer",
      "New: Optional Stripe customer deletion when removing a visitor",
      "New: Optional HubSpot contact archival when removing a visitor",
      "Improved: Delete modal shows checkboxes to choose which external systems to clean up",
      "Safety: Members cannot be accidentally deleted through the visitor deletion flow"
    ]
  },
  {
    version: "20.2.0",
    date: "2026-01-24",
    title: "Real-Time Visitor Type Updates",
    changes: [
      "New: Visitor TYPE is now updated automatically when a day pass is purchased",
      "New: Visitor TYPE is now updated automatically when someone is added as a guest to a booking",
      "Technical: Created reusable updateVisitorType utility with proper type hierarchy (day_pass > guest > lead)"
    ]
  },
  {
    version: "20.1.0",
    date: "2026-01-24",
    title: "Visitor Directory Enhancements",
    changes: [
      "New: Visitors now have stored TYPE (Day Pass, Guest, Lead) and SOURCE (HubSpot, Stripe, MindBody, App) fields",
      "New: Click any column header (Name, Type, Source, Last Activity) to sort the visitors list",
      "New: Last Activity column shows the most recent action date (day pass purchase or guest visit)",
      "New: Backfill endpoint populates visitor types from historical purchase and guest data",
      "Improved: Source priority logic: MindBody (for non-members with client ID) → Stripe → HubSpot → App",
      "Improved: Type priority: Day Pass (highest) → Guest → Lead (no activity)"
    ]
  },
  {
    version: "20.0.0",
    date: "2026-01-24",
    title: "Guest Pass Checkout Flow",
    isMajor: true,
    changes: [
      "New: Members can now choose to use a guest pass (free) or pay the $25 fee when adding guests",
      "New: 'Add Guest' button is always enabled - no more blocked access when passes run out",
      "New: Payment choice modal shows clear options with guest pass balance and fee amount",
      "New: Stripe checkout integrated directly into the booking flow for instant payment",
      "Improved: Guest info modal now shows pass status and continues to payment choice",
      "Improved: Clear messaging when no passes remain ('No passes left — $25 guest fee applies')"
    ]
  },
  {
    version: "19.1.0",
    date: "2026-01-24",
    title: "Unified Visitor Profile Drawer",
    changes: [
      "New: Visitors now open in the full profile drawer (same as members) with Billing, Purchases, Visits tabs",
      "New: 'Send Membership Invite' button on visitor profiles to quickly convert visitors to members",
      "Fixed: Source priority now correctly shows HubSpot for contacts synced from HubSpot (was incorrectly showing MindBody)",
      "Fixed: Admin and Staff accounts no longer appear in the Visitors tab",
      "Fixed: Purchase history now displays correctly for all visitor profiles",
      "Improved: Visitor drawer shows only relevant tabs (Bookings, Visits, Billing, Purchases, Comms, Notes)"
    ]
  },
  {
    version: "19.0.0",
    date: "2026-01-24",
    title: "Expanded Visitors Tab & Smart Contact Management",
    isMajor: true,
    changes: [
      "New: Visitors tab now shows all 2,375+ non-member contacts from HubSpot sync",
      "New: Type filter - filter contacts by 'Day Pass Buyers' or 'Leads'",
      "New: Source filter - filter by HubSpot, MindBody, or Stripe origin",
      "New: Smart visitor creation - when creating a visitor, system checks for existing email and links Stripe customer instead of duplicating",
      "Fixed: Former Members tab now includes 'declined' status (14 members were missing)",
      "Improved: Visitor cards now show type badge (Day Pass/Lead) and source badge (HubSpot/Stripe/MindBody)",
      "Foundation laid for guest pass checkout flow with Stripe product line items"
    ]
  },
  {
    version: "18.5.0",
    date: "2026-01-24",
    title: "Directory List Cleanup",
    changes: [
      "Removed the fade gradients at the top and bottom of the directory list",
      "The member list now scrolls cleanly without visual obstructions"
    ]
  },
  {
    version: "18.4.0",
    date: "2026-01-24",
    title: "Queue Card Border Fix",
    changes: [
      "Fixed: Booking queue card borders no longer get cut off at the corners",
      "The swipe gesture container now properly shows the full rounded border outline"
    ]
  },
  {
    version: "18.3.0",
    date: "2026-01-24",
    title: "Booking Information Consistency",
    changes: [
      "New: Assign Member modal now shows the imported name from Trackman at the top",
      "New: Notes from Trackman imports are now displayed in the Assign Member modal",
      "New: Resolve Booking modal also shows notes from imports for staff context",
      "Consistent information display: the same booking details now appear everywhere",
      "Staff can now see important context like 'walk in client - don't charge' across all modals"
    ]
  },
  {
    version: "18.2.0",
    date: "2026-01-24",
    title: "Streamlined Walk-In Visitor Flow",
    changes: [
      "New: Proactive visitor creation - staff can create visitors before they arrive",
      "After assigning a visitor to a Trackman booking, a 'Charge $X' button appears on the booking card",
      "Staff clicks 'Charge $X' when visitor actually arrives to open the billing modal",
      "Complete walk-in flow: Trackman booking → assign visitor → visitor arrives → charge/waive → booking ready",
      "UI: Removed card background from Directory search/filters for cleaner appearance"
    ]
  },
  {
    version: "18.1.0",
    date: "2026-01-24",
    title: "Account Balance & Instant Credits",
    changes: [
      "New: Account Balance section on Profile - add funds to your account for instant credits",
      "Members can add $25, $50, or $100 via Stripe checkout",
      "Balance is credited instantly upon successful payment",
      "Staff can view member account balance and apply credits in the Billing tab (e.g., for service recovery)",
      "All staff credit applications are now logged in the Staff Activity feed",
      "Fixed: Staff/admin logins no longer create Stripe customer accounts",
      "Disabled: Automatic payment reminder emails until billing system is finalized (staff send links manually)",
      "Future: Account balance can be used for guest fees, day passes, and service overages",
      "Removed: Guest Passes section (balance-based system replaces per-pass tracking)"
    ]
  },
  {
    version: "18.0.0",
    date: "2026-01-24",
    title: "Billing Integrity & Payment Protection",
    isMajor: true,
    changes: [
      "Critical: Webhook deduplication window extended from 24 hours to 7 days - prevents late duplicate processing",
      "Critical: Payment confirmation now uses database transactions with row-level locking - prevents race conditions",
      "Critical: Refunds now sync to booking participants - refunded bookings correctly marked as 'refunded'",
      "New: Guest pass consumption has idempotency protection - prevents double-deduction on retries",
      "New: Guest pass refunds now use tier-specific fees instead of hardcoded $25",
      "New: Trackman booking ID added to day pass duplicate checks - prevents re-billing the same booking",
      "New: Tier change verification confirms database matches Stripe after changes",
      "New: Daily alert for unresolved Trackman bookings older than 24 hours",
      "Fixed: All refunds on a charge are now cached (was only caching the latest refund)"
    ]
  },
  {
    version: "17.2.0",
    date: "2026-01-24",
    title: "Facility Status Display Fix",
    changes: [
      "Fixed: Facility Status was incorrectly showing future bookings (e.g., Jan 28) as currently occupied",
      "Bays now only show as 'Booked' when there is an active booking for TODAY at the current time",
      "This was a display-only issue - member booking availability was not affected"
    ]
  },
  {
    version: "17.1.0",
    date: "2026-01-24",
    title: "Visitor Day Pass Billing & Payment Sync",
    changes: [
      "New: Day pass visitors ($50) are now automatically charged when linked to Trackman bookings",
      "Visitors with saved payment method are charged immediately; otherwise an invoice is sent",
      "Added booking_date tracking to prevent duplicate day pass charges for the same date",
      "New: Manual payment sync endpoint for staff to refresh a member's complete Stripe history",
      "Payment sync now supports full pagination for customers with 100+ transactions"
    ]
  },
  {
    version: "17.0.0",
    date: "2026-01-24",
    title: "Stripe & Trackman Billing Harmony",
    isMajor: true,
    changes: [
      "Critical: Suspended/inactive members are now blocked from booking (membership_status enforcement)",
      "Critical: Trackman webhooks now use the billing engine - fees calculated correctly for all bookings",
      "Critical: Booking time changes from Trackman now trigger automatic fee recalculation",
      "New: Invoice lifecycle webhooks (created, finalized, voided, uncollectible) sync to transaction cache",
      "New: Cached payment history endpoint for faster member billing lookups",
      "Fixed: Failed payment intents and invoices now cached in transaction history",
      "Fixed: Stripe webhook errors now properly throw for retry handling"
    ]
  },
  {
    version: "16.2.0",
    date: "2026-01-24",
    title: "Stripe Webhook Reliability Fixes",
    changes: [
      "Fixed: Payment status now consistent between API and webhooks (was 'used' vs 'completed')",
      "Fixed: Failed webhook operations now trigger Stripe retry (was silently failing)",
      "Payments are now more reliable and won't get stuck in 'processing' state"
    ]
  },
  {
    version: "16.1.0",
    date: "2026-01-24",
    title: "Fix Trackman Resolve Booking",
    changes: [
      "Fixed: Resolve booking now works - was looking for wrong parameter name",
      "Staff can now successfully assign unmatched Trackman bookings to members or visitors"
    ]
  },
  {
    version: "16.0.0",
    date: "2026-01-24",
    title: "Create Visitor from Trackman Bookings",
    isMajor: true,
    changes: [
      "New: Add Visitor button in Assign Member modal - replaces Cancel button",
      "Can search for existing visitors in the directory before creating new ones",
      "Create new visitors with first name, last name, email - automatically creates Stripe account",
      "New visitors appear in the Visitors directory and can be tracked for bookings and purchase history"
    ]
  },
  {
    version: "15.3.0",
    date: "2026-01-24",
    title: "Trackman Rescan & Member Search Fix",
    changes: [
      "Fixed Rescan button in Trackman tab - now properly attempts to auto-match unmatched bookings",
      "Fixed member search when resolving unmatched bookings - now finds both current and former members",
      "Search now queries the database in real-time for more accurate results"
    ]
  },
  {
    version: "15.2.0",
    date: "2026-01-24",
    title: "Unmatched Bookings List Restored",
    changes: [
      "Fixed unmatched bookings list showing 0 - now correctly displays CSV import bookings needing member assignment",
      "Unmatched bookings can be resolved directly from the import screen",
      "Original name and email from CSV now displayed for easier identification"
    ]
  },
  {
    version: "15.1.0",
    date: "2026-01-24",
    title: "Tappable Booking Cards & Timezone Fix",
    changes: [
      "Booking cards are now tappable - tap anywhere on the card to open booking details (no more separate Edit button)",
      "Fixed 'Last event' timestamp in Trackman sync section - now shows correct Pacific timezone"
    ]
  },
  {
    version: "15.0.0",
    date: "2026-01-24",
    title: "Trackman Data Sync Architecture",
    isMajor: true,
    changes: [
      "New: CSV import and webhook now work together seamlessly with 1:1 data sync using Trackman booking ID as unique key",
      "New: Unmatched CSV bookings now block time slots to prevent double-booking (same as webhook behavior)",
      "New: Origin tracking - each booking shows whether it came from member request, staff creation, webhook, or import",
      "New: Last sync tracking - timestamps and source for when Trackman data was last synced",
      "Improved: CSV import updates existing bookings instead of duplicating them",
      "Improved: Field-level merge - import enriches missing data but preserves member linkage and staff edits"
    ]
  },
  {
    version: "14.16.0",
    date: "2026-01-24",
    title: "Staff Activity Filters & Player Roster",
    changes: [
      "Fixed staff activity filters - Bookings, Billing, Members and other category filters now work correctly",
      "Added missing audit actions: Change Booking Owner, Assign Member to Booking, Link Trackman to Member",
      "Removed 'Viewed Member' and 'Viewed Profile' noise from activity feed - now only actual changes are logged",
      "X/Y Players button now shows for all future bookings, not just today - staff can prep rosters in advance"
    ]
  },
  {
    version: "14.15.0",
    date: "2026-01-24",
    title: "Fixed Assign Member Button",
    changes: [
      "Fixed 'Assign Member' button not working - was incorrectly using HubSpot IDs instead of user IDs",
      "Member search input shows green border and checkmark when member is selected",
      "Success message displayed after successfully assigning a member to a booking",
      "Partial roster bookings now show 'X/Y Players' button on queue list instead of 'Check In'",
      "Calendar shows blue styling for bookings that need more players (dotted blue outline, blue background, blue text) to match Add Player button",
      "Conference rooms now display lavender 'Conf' badge correctly in all views",
      "Fixed Trackman webhook stats cards and event count not displaying due to database query error",
      "Fixed booking dates showing one day off in member profile (timezone display issue)",
      "Trackman bookings now auto-create billing sessions for seamless check-in",
      "Check-in now works even when billing session is pending sync"
    ]
  },
  {
    version: "14.14.0",
    date: "2026-01-23",
    title: "Cleaner Booking Queue Layout",
    changes: [
      "Unmatched bookings now show clean 'Needs Assignment' badge instead of 'Unknown (Trackman)' text",
      "Removed redundant 'CONF' badge from regular bookings - bay info already shown below",
      "Removed 'UNMATCHED' header badge - amber card styling makes them visible enough",
      "Bookings page now shows unified scheduled list with unmatched bookings mixed in",
      "Unknown Trackman bookings correctly show 'Assign Member' button instead of 'Check In'"
    ]
  },
  {
    version: "14.13.0",
    date: "2026-01-23",
    title: "Unified Booking Queue with Smart Actions",
    changes: [
      "Redesigned booking cards in Queue tab with detailed info: name, date/time, bay, and Trackman ID",
      "Smart action buttons adapt to booking state: Check In, X/Y Players, Charge $X, or Assign Member",
      "Clicking 'X/Y Players' now opens roster management modal to add players",
      "Unmatched Trackman bookings merged into scheduled list with amber styling for visibility",
      "Booking cards show status badges: Checked In (green), Confirmed (blue), Needs Assignment (amber)"
    ]
  },
  {
    version: "14.12.0",
    date: "2026-01-23",
    title: "Member Notifications & Improved Search",
    changes: [
      "Members now receive notifications when their booking is confirmed via Trackman",
      "Members notified when staff manually assigns them to a booking",
      "Fixed member search in 'Assign Member' modal - now shows names and tiers like Record Purchase",
      "Stats and event lists auto-refresh when a booking is linked (no page reload needed)",
      "Staff dashboard updates instantly after assigning members to bookings"
    ]
  },
  {
    version: "14.11.0",
    date: "2026-01-23",
    title: "Detailed Booking Stats Breakdown",
    changes: [
      "Stats widget now shows 4 categories: Auto Confirmed (blue), Manually Linked (green), Needs Linking (amber), Cancelled (red)",
      "Auto Confirmed: Bookings automatically matched to members via email",
      "Manually Linked: Bookings assigned by staff after initial webhook",
      "Clear visual distinction helps track staff workload for unmatched bookings"
    ]
  },
  {
    version: "14.10.0",
    date: "2026-01-23",
    title: "Accurate Trackman Booking Stats",
    changes: [
      "Fixed stats widget to show correct counts for auto-approved vs needs-linking bookings",
      "Added 'Needs Linking' count in amber to show bookings awaiting member assignment",
      "Auto-linked bookings (William, Greg) now correctly show blue button instead of green",
      "Future auto-matched webhooks will properly track was_auto_linked status"
    ]
  },
  {
    version: "14.9.0",
    date: "2026-01-23",
    title: "Streamlined Unmatched Booking Flow",
    changes: [
      "Clicking amber (unassigned) bookings on the calendar now opens 'Assign Member' directly",
      "Staff no longer need to go through Booking Details first to assign a member",
      "After assigning a member, the cell turns green and Booking Details becomes accessible"
    ]
  },
  {
    version: "14.8.0",
    date: "2026-01-23",
    title: "Unified Assign Member Experience",
    changes: [
      "Consolidated member assignment into a single modal for consistency across all screens",
      "Staff Dashboard, Booking Details, and Webhook Events now all use the same assignment flow",
      "Simplified codebase by removing duplicate modal components"
    ]
  },
  {
    version: "14.7.0",
    date: "2026-01-23",
    title: "Improved Trackman Booking Visibility",
    changes: [
      "Unassigned bookings now clearly show 'Unassigned' instead of confusing 'Unknown (Trackman)' placeholder",
      "Webhook events distinguish auto-linked (blue) vs manually-linked (green) bookings",
      "'Linked' badge only appears for bookings with actual members assigned, not placeholder accounts",
      "Fixed member search showing names and emails correctly in dark mode",
      "Staff-only: full member emails now shown in search results for accurate linking"
    ]
  },
  {
    version: "14.6.0",
    date: "2026-01-23",
    title: "Change Booking Owner Feature",
    changes: [
      "Staff can now change the owner of any booking from the Booking Details modal",
      "Trackman webhook events show member name on green button - click to reassign to different member",
      "Unmatched Trackman bookings show amber 'Link to Member' button as before",
      "All owner changes are logged to staff activity with previous and new owner information",
      "Booking calendar cells now show amber color for unmatched bookings so staff can spot them easily"
    ]
  },
  {
    version: "14.5.0",
    date: "2026-01-23",
    title: "Trackman Webhook Booking Creation Fixed",
    changes: [
      "Fixed critical bug where Trackman webhooks were not creating bookings on the calendar",
      "All Trackman bookings now appear on the calendar immediately - time slots are blocked automatically",
      "Fixed 'Link to Member' search - member dropdown now shows results when searching by name",
      "Staff can now manually link any Trackman booking to a member using the Link to Member button",
      "Fixed internal references in link-to-member feature so it correctly finds webhook data"
    ]
  },
  {
    version: "14.4.0",
    date: "2026-01-23",
    title: "CSRF Protection Removed",
    changes: [
      "Removed CSRF token validation that was causing login and form submission failures",
      "Modern browser security (SameSite cookies, CORS) already provides this protection",
      "All 'CSRF failed' errors across the app are now permanently resolved"
    ]
  },
  {
    version: "14.3.0",
    date: "2026-01-23",
    title: "UI Polish: Dark Mode & Rounded Corners",
    changes: [
      "Fixed skeleton loaders showing light gray in dark mode - now properly shows dark colors",
      "Added rounded corners to Directory page search bar and table header for consistent look",
      "All loading states now automatically adapt to light and dark themes"
    ]
  },
  {
    version: "14.2.0",
    date: "2026-01-23",
    title: "Audit Fixes: Payments & Login",
    changes: [
      "Fixed production login issue where OTP requests could fail on first visit",
      "Added refund tracking - when refunds happen in Stripe, they now sync to the app automatically",
      "Revenue reports now accurately reflect partial and full refunds",
      "Installed missing payment processing component for server stability"
    ]
  },
  {
    version: "14.1.0",
    date: "2026-01-23",
    title: "Bug Fixes & Maintenance",
    changes: [
      "Fixed Trackman webhook crash when receiving unknown event types",
      "Improved WebSocket reconnection with exponential backoff to reduce network noise",
      "Added test account cleanup tooling for database hygiene",
      "Version number now displays dynamically from changelog in sidebar and mobile"
    ]
  },
  {
    version: "14.0.0",
    date: "2026-01-23",
    title: "Comprehensive Staff Activity Logging",
    isMajor: true,
    changes: [
      "Staff Activity now tracks ALL staff actions across the entire platform",
      "New categories: Tours, Events, Wellness, Announcements, Closures, and Admin actions",
      "Tour status changes (check-in, completed, no-show, cancelled) now appear in activity feed",
      "Event management (create, update, delete, RSVP management) fully logged",
      "Wellness class management and enrollment tracking added",
      "Closure and announcement management now tracked",
      "Trackman imports and booking assignments logged for audit compliance",
      "Group billing member changes tracked",
      "Richer detail cards show context like dates, status changes, and member info",
      "Added new filter tabs: Tours, Events, Admin for focused views"
    ]
  },
  {
    version: "13.1.0",
    date: "2026-01-23",
    title: "Staff Activity Tracking",
    changes: [
      "New Staff Activity log tracks all staff actions including booking approvals, billing changes, and member updates",
      "Activity log is accessible from the Changelog page with a dedicated tab for admins",
      "Filter activity by category (Bookings, Billing, Members) or by staff member",
      "Each action shows who did it, when, and relevant details like amounts or member names",
      "Improved audit trail for better accountability and operational visibility"
    ]
  },
  {
    version: "13.0.0",
    date: "2026-01-22",
    title: "Stripe Transaction Cache & Sync",
    isMajor: true,
    changes: [
      "Transaction history now loads instantly with local caching instead of slow Stripe API calls",
      "One-click backfill tool syncs all historical Stripe transactions to the cache",
      "Subscription pause lets staff temporarily suspend memberships for 1-4 weeks",
      "Resume subscription restores billing on the original schedule",
      "Tier changes now properly sync to Stripe customer metadata",
      "Fixed membership tag display to accurately reflect Stripe billing status",
      "Fixed last visit date showing invalid dates for some members"
    ]
  },
  {
    version: "12.2.0",
    date: "2026-01-21",
    title: "Relative Times & Bug Fixes",
    changes: [
      "Notifications now show relative times like '2h ago' or 'Yesterday' instead of dates",
      "Pending booking requests display how long they've been waiting for approval",
      "Fixed bug report submission - you can now successfully report issues from your profile",
      "Fixed QR code scanner for redeeming day passes on the Financials page",
      "Improved scanner reliability with better camera permission handling"
    ]
  },
  {
    version: "12.1.0",
    date: "2026-01-20",
    title: "MindBody-Stripe Integration",
    changes: [
      "Staff can now view and charge overage fees for MindBody members through Stripe",
      "Automatic Stripe customer creation for members without a Stripe account",
      "One-click manual linking for members who already have Stripe accounts",
      "Improved duplicate prevention when creating Stripe customers",
      "Direct charge capability for non-system users from the admin panel"
    ]
  },
  {
    version: "12.0.0",
    date: "2026-01-19",
    title: "Trackman Booking Sync",
    isMajor: true,
    changes: [
      "Bookings now sync automatically with Trackman when staff creates them in the portal",
      "Member requests a time, staff sees request, books in Trackman, and our system auto-confirms",
      "Time matching updates our records to match Trackman's actual booking times",
      "Bay conflict detection warns staff of overlapping bookings",
      "Pending requests auto-expire after their scheduled time passes",
      "Staff receive toast notifications when bookings are auto-confirmed"
    ]
  },
  {
    version: "11.6.0",
    date: "2026-01-18",
    title: "Self-Service Billing Portal",
    changes: [
      "Members can now manage their own billing through Stripe's secure portal",
      "Update payment methods, view invoices, and manage subscription directly",
      "Pending booking requests show visual indicators on the calendar view",
      "Calendar improvements with sticky headers for easier navigation",
      "Security tokens added to payment collection for safer transactions"
    ]
  },
  {
    version: "11.5.0",
    date: "2026-01-17",
    title: "Calendar & Scheduler Improvements",
    changes: [
      "Background tasks reorganized into separate scheduler files for better reliability",
      "Conference room IDs now fetched dynamically instead of hardcoded values",
      "Booking requests use database transactions to prevent race conditions",
      "Fixed duplicate guest entries when adding members to bookings",
      "Improved pending authorization handling for incomplete payments"
    ]
  },
  {
    version: "11.4.0",
    date: "2026-01-16",
    title: "Mobile App & Privacy Compliance",
    changes: [
      "Mobile app foundation with API endpoints for iOS and Android development",
      "New privacy controls let members opt out of data sharing (CCPA/CPRA compliant)",
      "Request your data export directly from your profile's Privacy section",
      "Guardian consent required for members under 18 when making bookings",
      "Improved performance on the member directory with faster list scrolling",
      "Fixed join date display to show correct membership start dates"
    ]
  },
  {
    version: "11.3.0",
    date: "2026-01-13",
    title: "Billing & Payment Tracking",
    changes: [
      "Check-in screen now shows a clear fee breakdown with color-coded badges",
      "Orange badge for time overage fees, blue for guest fees, green when a guest pass is used",
      "See each person's tier and daily allowance right on the billing screen",
      "New Overdue Payments section helps staff follow up on unpaid past bookings",
      "Fixed an issue where guest fees were incorrectly counting toward the host's usage"
    ]
  },
  {
    version: "11.2.0",
    date: "2026-01-10",
    title: "Reliability & Token Refresh",
    changes: [
      "Fixed HubSpot and Google Calendar token expiration issues",
      "Tokens now refresh proactively before they expire",
      "Improved connection reliability for external integrations"
    ]
  },
  {
    version: "11.1.0",
    date: "2026-01-09",
    title: "Smoother Animations & Notifications",
    changes: [
      "New animations for page transitions and modal popups",
      "Toast notifications confirm your actions throughout the app",
      "Improved loading states with fade effects",
      "Better visual feedback when buttons are tapped"
    ]
  },
  {
    version: "11.0.0",
    date: "2026-01-08",
    title: "Multi-Member Bookings",
    isMajor: true,
    changes: [
      "Invite other members to join your golf booking",
      "Add guests directly to your reservation using guest passes",
      "See who's accepted, pending, or declined at a glance",
      "Time is automatically split between all participants",
      "Invites expire automatically if not accepted in time",
      "Conflict detection prevents double-booking the same member",
      "Staff can reconcile declared vs actual player counts from Trackman"
    ]
  },
  {
    version: "10.4.0",
    date: "2026-01-06",
    title: "Availability Blocks & Calendar Status",
    changes: [
      "New Blocks tab in Calendar page lets staff block off times for maintenance, private events, or staff holds",
      "See which Google Calendars are connected at a glance with the Calendar Status panel",
      "One-click button to fill gaps when wellness classes are missing from Google Calendar",
      "Blocks are grouped by day with collapsible sections for easy browsing"
    ]
  },
  {
    version: "10.3.0",
    date: "2026-01-04",
    title: "Training Guide & Bug Fixes",
    changes: [
      "Training guide now stays in sync with feature changes automatically",
      "Added documentation for the Needs Review notice workflow",
      "Fixed database performance indexes not being created on startup",
      "Improved startup reliability with better error handling"
    ]
  },
  {
    version: "10.2.0",
    date: "2026-01-04",
    title: "Stability & Reliability",
    changes: [
      "Improved error handling during server restarts",
      "Better retry logic for API calls when connection is temporarily unavailable",
      "Admin dashboard components more resilient to loading states",
      "HubSpot API calls now gracefully fall back to cached data"
    ]
  },
  {
    version: "10.1.0",
    date: "2026-01-02",
    title: "Notice Categories & Calendar Sync",
    changes: [
      "Notices now have categories like Holiday, Maintenance, Private Event synced from Google Calendar",
      "Staff can choose a reason category when creating notices",
      "Member dashboard shows notice category and date/time at a glance",
      "Closures appear in red, informational notices in amber"
    ]
  },
  {
    version: "10.0.0",
    date: "2026-01-02",
    title: "Faster & More Responsive",
    isMajor: true,
    changes: [
      "Buttons respond instantly when you tap them - no more waiting",
      "If something goes wrong, the app automatically undoes the action",
      "Staff can mark bookings as attended or no-show from member profiles",
      "Fixed various behind-the-scenes issues for a smoother experience"
    ]
  },
  {
    version: "9.0.0",
    date: "2026-01-02",
    title: "Trackman Import & Booking History",
    isMajor: true,
    changes: [
      "Staff can import booking history from Trackman with automatic member matching",
      "When you resolve one unmatched booking, all similar ones get fixed automatically",
      "View and manage matched bookings with easy reassignment if needed",
      "Page navigation added for browsing large booking histories"
    ]
  },
  {
    version: "8.0.0",
    date: "2026-01-01",
    title: "Staff Command Center",
    isMajor: true,
    changes: [
      "Redesigned staff home as a real-time command center",
      "See pending requests, facility status, and upcoming tours at a glance",
      "Quick actions for common tasks like new bookings and announcements",
      "Auto-refresh every 5 minutes with pull-to-refresh support"
    ]
  },
  {
    version: "7.3.0",
    date: "2026-01-01",
    title: "PWA & Performance",
    changes: [
      "Long-press the app icon for quick shortcuts to Book Golf, Events, and more",
      "App loads faster with optimized code splitting",
      "Better caching for images and static files",
      "Timezone fixes to ensure all times display correctly in California"
    ]
  },
  {
    version: "7.2.0",
    date: "2025-12-31",
    title: "Notices & Booking Improvements",
    changes: [
      "Closures renamed to Notices for clarity - some are informational only",
      "Notices with no affected areas no longer block bookings",
      "Conference room bookings sync from MindBody automatically",
      "Eventbrite attendees now sync directly into event RSVPs",
      "Improved accessibility with better contrast and touch targets"
    ]
  },
  {
    version: "7.1.0",
    date: "2025-12-30",
    title: "Member Dashboard & History",
    changes: [
      "New History page to view all your past bookings and experiences",
      "Redesigned dashboard with quick-access metrics",
      "You can reschedule bookings directly - old booking is cancelled automatically",
      "Core members can choose 30-minute or 60-minute sessions",
      "Staff can make extended bookings up to 5 hours for private events"
    ]
  },
  {
    version: "7.0.0",
    date: "2025-12-30",
    title: "Tier-Based Booking Limits",
    isMajor: true,
    changes: [
      "Booking options now reflect your membership tier",
      "Premium and VIP members get access to longer sessions",
      "Staff notes field for internal comments on bookings",
      "New Closures tab with dedicated styling in Updates page"
    ]
  },
  {
    version: "6.0.0",
    date: "2025-12-29",
    title: "Unified Updates Page",
    isMajor: true,
    changes: [
      "Announcements and closures combined into one Updates page",
      "Time slots grouped by hour in accordion layout",
      "Staff portal now respects your light/dark theme",
      "Optional image uploads for wellness classes"
    ]
  },
  {
    version: "5.0.0",
    date: "2025-12-28",
    title: "Pull to Refresh & Polish",
    isMajor: true,
    changes: [
      "Pull down on any page to refresh your data",
      "Beautiful branded animation with animated mascot",
      "Reschedule bookings directly from the calendar",
      "120-minute booking option for Premium and VIP members",
      "Bug report feature - report issues right from your Profile"
    ]
  },
  {
    version: "4.0.0",
    date: "2025-12-28",
    title: "Premium Feel",
    isMajor: true,
    changes: [
      "Hero images have a subtle parallax depth effect as you scroll",
      "Booking confirmations play a satisfying notification sound",
      "Glassmorphism styling for a cohesive, premium look",
      "Team directory for staff to see colleague contact info"
    ]
  },
  {
    version: "3.0.0",
    date: "2025-12-26",
    title: "Staff Portal Redesign",
    isMajor: true,
    changes: [
      "Reorganized Staff Portal with better navigation",
      "New Training Guide with images and step-by-step instructions",
      "Faster loading throughout the app",
      "In-app notifications for booking requests and updates"
    ]
  },
  {
    version: "2.0.0",
    date: "2025-12-20",
    title: "Staff Portal & Install as App",
    isMajor: true,
    changes: [
      "New Staff Portal for managing the club",
      "Install the app on your phone's home screen",
      "Log in with a code sent to your email - no password needed",
      "Bookings sync to Google Calendar automatically",
      "Request bookings that staff approve - no more double-bookings"
    ]
  },
  {
    version: "1.0.0",
    date: "2025-12-16",
    title: "Launch Day",
    isMajor: true,
    changes: [
      "The app is live! Built from the ground up for Even House members",
      "Book golf bays and conference rooms with real-time availability",
      "Membership tiers with guest passes and booking limits",
      "Connected to HubSpot so your membership info stays in sync"
    ]
  }
];

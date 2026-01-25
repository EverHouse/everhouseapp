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
    version: "9.24.1",
    date: "2026-01-25",
    title: "Booking Details Fee Calculation Fix",
    changes: [
      "Fixed: Empty player slots in Booking Details now show $25 pending fee until a member is assigned",
      "Fixed: Financial summary correctly calculates Total Due including all empty/pending slots",
      "Improved: Empty slots display 'Pending assignment - $25' fee note for staff clarity"
    ]
  },
  {
    version: "9.24.0",
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
    version: "9.23.1",
    date: "2026-01-25",
    title: "Membership Payment Labels",
    changes: [
      "Improved: Payment history now shows specific membership tier (e.g., 'Ace Membership' instead of generic 'Membership Payment')",
      "Fixed: Tier names are extracted from Stripe invoice descriptions for clearer billing history"
    ]
  },
  {
    version: "9.23.0",
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
    version: "9.22.0",
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
    version: "9.21.0",
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
    version: "9.20.0",
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
    version: "9.19.0",
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
    version: "9.18.3",
    date: "2026-01-25",
    title: "Trackman Modal Fixes",
    changes: [
      "Fixed: 'Book on Trackman' modal now correctly shows declared player count instead of always showing 1 player",
      "Fixed: Clicking pending request cells in calendar now opens the Trackman booking modal instead of the decline modal",
      "Improved: Trackman notes now include placeholder lines for all declared players (e.g., G|none|Guest|2)"
    ]
  },
  {
    version: "9.18.2",
    date: "2026-01-25",
    title: "Bay Preference Display Fix",
    changes: [
      "Fixed: Pending booking requests now correctly show the member's selected bay instead of 'any bay available'",
      "Fixed: Simulate-confirm endpoint now creates proper session and participant records for testing"
    ]
  },
  {
    version: "9.18.1",
    date: "2026-01-25",
    title: "Trackman-Only Booking Workflow",
    changes: [
      "Changed: Removed manual booking button from staff Bookings page - all simulator bookings must now go through Trackman",
      "Changed: Empty calendar slots are no longer clickable - bookings are created via member requests and confirmed by Trackman webhooks",
      "Note: Staff can still reschedule existing bookings using the Reschedule button on each booking"
    ]
  },
  {
    version: "9.18.0",
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
    version: "9.17.0",
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
    version: "9.16.0",
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
    version: "9.15.0",
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
    version: "9.14.0",
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
    version: "9.13.1",
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
    version: "9.13.0",
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
    version: "9.12.1",
    date: "2026-01-24",
    title: "Visitors Directory Pagination",
    changes: [
      "Improved: Visitors tab now shows total count of all visitors in the system",
      "Improved: Load More button to fetch additional visitors in batches of 100",
      "Improved: Better performance when browsing large visitor lists"
    ]
  },
  {
    version: "9.12.0",
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
    version: "9.11.0",
    date: "2026-01-24",
    title: "Unified Visits System (Staff)",
    isMajor: false,
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
    version: "9.10.2",
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
    version: "9.10.1",
    date: "2026-01-24",
    title: "Real-Time Visitor Type Updates",
    changes: [
      "New: Visitor TYPE is now updated automatically when a day pass is purchased",
      "New: Visitor TYPE is now updated automatically when someone is added as a guest to a booking",
      "Technical: Created reusable updateVisitorType utility with proper type hierarchy (day_pass > guest > lead)"
    ]
  },
  {
    version: "9.10.0",
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
    version: "9.9.0",
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
    version: "9.8.1",
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
    version: "9.8.0",
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
    version: "9.7.8",
    date: "2026-01-24",
    title: "Directory List Cleanup",
    changes: [
      "Removed the fade gradients at the top and bottom of the directory list",
      "The member list now scrolls cleanly without visual obstructions"
    ]
  },
  {
    version: "9.7.7",
    date: "2026-01-24",
    title: "Queue Card Border Fix",
    changes: [
      "Fixed: Booking queue card borders no longer get cut off at the corners",
      "The swipe gesture container now properly shows the full rounded border outline"
    ]
  },
  {
    version: "9.7.6",
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
    version: "9.7.5",
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
    version: "9.7.4",
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
    version: "9.7.3",
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
    version: "9.7.2",
    date: "2026-01-24",
    title: "Facility Status Display Fix",
    changes: [
      "Fixed: Facility Status was incorrectly showing future bookings (e.g., Jan 28) as currently occupied",
      "Bays now only show as 'Booked' when there is an active booking for TODAY at the current time",
      "This was a display-only issue - member booking availability was not affected"
    ]
  },
  {
    version: "9.7.1",
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
    version: "9.7.0",
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
    version: "9.6.2",
    date: "2026-01-24",
    title: "Stripe Webhook Reliability Fixes",
    changes: [
      "Fixed: Payment status now consistent between API and webhooks (was 'used' vs 'completed')",
      "Fixed: Failed webhook operations now trigger Stripe retry (was silently failing)",
      "Payments are now more reliable and won't get stuck in 'processing' state"
    ]
  },
  {
    version: "9.6.1",
    date: "2026-01-24",
    title: "Fix Trackman Resolve Booking",
    changes: [
      "Fixed: Resolve booking now works - was looking for wrong parameter name",
      "Staff can now successfully assign unmatched Trackman bookings to members or visitors"
    ]
  },
  {
    version: "9.6.0",
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
    version: "9.5.4",
    date: "2026-01-24",
    title: "Trackman Rescan & Member Search Fix",
    changes: [
      "Fixed Rescan button in Trackman tab - now properly attempts to auto-match unmatched bookings",
      "Fixed member search when resolving unmatched bookings - now finds both current and former members",
      "Search now queries the database in real-time for more accurate results"
    ]
  },
  {
    version: "9.5.2",
    date: "2026-01-24",
    title: "Unmatched Bookings List Restored",
    changes: [
      "Fixed unmatched bookings list showing 0 - now correctly displays CSV import bookings needing member assignment",
      "Unmatched bookings can be resolved directly from the import screen",
      "Original name and email from CSV now displayed for easier identification"
    ]
  },
  {
    version: "9.5.1",
    date: "2026-01-24",
    title: "Tappable Booking Cards & Timezone Fix",
    changes: [
      "Booking cards are now tappable - tap anywhere on the card to open booking details (no more separate Edit button)",
      "Fixed 'Last event' timestamp in Trackman sync section - now shows correct Pacific timezone"
    ]
  },
  {
    version: "9.5.0",
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
    version: "9.4.14",
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
    version: "9.4.13",
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
    version: "9.4.12",
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
    version: "9.4.11",
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
    version: "9.4.10",
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
    version: "9.4.9",
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
    version: "9.4.8",
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
    version: "9.4.7",
    date: "2026-01-23",
    title: "Streamlined Unmatched Booking Flow",
    changes: [
      "Clicking amber (unassigned) bookings on the calendar now opens 'Assign Member' directly",
      "Staff no longer need to go through Booking Details first to assign a member",
      "After assigning a member, the cell turns green and Booking Details becomes accessible"
    ]
  },
  {
    version: "9.4.6",
    date: "2026-01-23",
    title: "Unified Assign Member Experience",
    changes: [
      "Consolidated member assignment into a single modal for consistency across all screens",
      "Staff Dashboard, Booking Details, and Webhook Events now all use the same assignment flow",
      "Simplified codebase by removing duplicate modal components"
    ]
  },
  {
    version: "9.4.5",
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
    version: "9.4.4",
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
    version: "9.4.3",
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
    version: "9.4.2",
    date: "2026-01-23",
    title: "CSRF Protection Removed",
    changes: [
      "Removed CSRF token validation that was causing login and form submission failures",
      "Modern browser security (SameSite cookies, CORS) already provides this protection",
      "All 'CSRF failed' errors across the app are now permanently resolved"
    ]
  },
  {
    version: "9.4.1",
    date: "2026-01-23",
    title: "UI Polish: Dark Mode & Rounded Corners",
    changes: [
      "Fixed skeleton loaders showing light gray in dark mode - now properly shows dark colors",
      "Added rounded corners to Directory page search bar and table header for consistent look",
      "All loading states now automatically adapt to light and dark themes"
    ]
  },
  {
    version: "9.4",
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
    version: "9.3",
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
    version: "9.2",
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
    version: "9.1",
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
    version: "9.0",
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
    version: "8.12",
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
    version: "8.11",
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
    version: "8.10",
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
    version: "8.9",
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
    version: "8.8.1",
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
    version: "8.8",
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
    version: "8.7",
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
    version: "8.6",
    date: "2026-01-10",
    title: "Reliability & Token Refresh",
    changes: [
      "Fixed HubSpot and Google Calendar token expiration issues",
      "Tokens now refresh proactively before they expire",
      "Improved connection reliability for external integrations"
    ]
  },
  {
    version: "8.5.1",
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
    version: "8.5",
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
    version: "8.4",
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
    version: "8.3",
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
    version: "8.2",
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
    version: "8.1",
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
    version: "8.0",
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
    version: "7.5",
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
    version: "7.4",
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
    version: "7.3",
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
    version: "7.2",
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
    version: "7.1",
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
    version: "7.0",
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
    version: "6.0",
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
    version: "5.0",
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
    version: "4.0",
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
    version: "3.0",
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
    version: "2.0",
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
    version: "1.0",
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

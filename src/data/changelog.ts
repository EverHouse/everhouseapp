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
    version: "7.87.1",
    date: "2026-02-20",
    title: "Trackman Cancellation Webhook Fixes",
    changes: [
      "Fixed: Trackman cancellation webhooks now properly cancel bookings in the app — previously, cancellation events were silently ignored because the system treated them as duplicates of the original creation event",
      "Fixed: Members now receive a 'Booking Cancelled' notification when Trackman cancels their booking — previously, only member-requested cancellations triggered notifications",
      "Fixed: Calendar availability updates instantly when a Trackman cancellation comes in — previously, the freed-up slot wouldn't appear available until the next page refresh",
      "Fixed: V2 webhooks no longer send incorrect 'Booking Confirmed' notifications when the actual status is 'cancelled' — the notification now correctly reflects the booking's real status",
      "Fixed: Bookings matched via Trackman external ID now properly run the full cancellation process (refunds, notifications, availability updates) instead of silently marking the status as cancelled with no side effects",
      "Fixed: Removed duplicate availability broadcasts in V1 webhook handler — cancellations now broadcast exactly once",
      "Improved: Both 'cancelled' (British) and 'canceled' (American) spellings are now handled consistently across all Trackman webhook processing paths",
    ]
  },
  {
    version: "7.87",
    date: "2026-02-20",
    title: "Stripe Payment Integrity v2 — Phantom Charges & Terminal Traceability",
    isMajor: true,
    changes: [
      "Fixed: Terminal POS payments no longer create duplicate 'Out of Band' charges in Stripe — the invoice is now voided after the terminal payment succeeds instead of being fake-paid, eliminating phantom transactions",
      "Fixed: Subscription and invoice payments now cancel stale invoice-generated payment intents before reconciliation, reducing the chance of accidental double-charges",
      "Fixed: All reconciled invoices now include cross-reference metadata (reconciled_by_pi, reconciliation_source) linking them to the real payment for easy auditing",
      "Improved: All terminal card reader payments now include readerId and readerLabel in Stripe metadata — staff can trace exactly which card reader processed each payment",
      "Improved: Subscription terminal payments now show descriptive labels like 'Membership activation - VIP' instead of generic 'Subscription activation - Invoice inv_xxx' text",
      "Improved: New subscription payment intents now include the tier name in the description for better dashboard readability",
      "Fixed: Duplicate charge prevention for non-booking payments improved — the retry window is now 60 seconds (was effectively zero due to Date.now() precision), preventing accidental double charges on retry",
    ]
  },
  {
    version: "7.86.2",
    date: "2026-02-20",
    title: "Google Sign-In Fix & Staff Account Protection",
    changes: [
      "Fixed: Google Sign-In was not working for staff/admin users because their accounts were accidentally archived by the visitor cleanup tool on Feb 13 — all 4 affected accounts (Nick, Mara, Sarah, Alyssa) are now automatically restored on deploy",
      "Fixed: The 'Archive Stale Visitors' tool now explicitly skips all staff, admin, and instructor accounts — this prevents staff from ever being caught in visitor cleanup again",
    ]
  },
  {
    version: "7.86.1",
    date: "2026-02-20",
    title: "Unmatched Booking Conflict Handling & Fee Cleanup",
    changes: [
      "Fixed: Trackman webhook bookings that overlap with an existing booking on the same bay are now created as 'pending' instead of 'approved' — this prevents phantom 'Needs Assignment' cards from cluttering the dashboard when the time slot is already taken by a confirmed member",
      "Fixed: Trackman CSV imports now automatically mark past booking fees as 'paid' (settled externally) and waive ghost fees from unmatched bookings — this prevents old overage fees from showing as outstanding on member profiles",
      "New: Admin data tool to clean up ghost fees and past outstanding balances in one click (Data Tools > Cleanup Ghost Fees)",
      "Fixed: Cleaned up 2 existing unmatched bookings that were incorrectly showing as active despite conflicting with real sessions",
    ]
  },
  {
    version: "7.86",
    date: "2026-02-19",
    title: "Stripe Payment Integrity & Void Fees",
    isMajor: true,
    changes: [
      "New: 'Void / Cancel Fees' button in booking details — staff can now cancel outstanding Stripe payment intents directly from the app instead of going to the Stripe dashboard",
      "Fixed: Ghost transactions no longer created for Unknown Trackman bookings without valid owners — prepayment creation is blocked when the booking has no real email or is unmatched without an assigned member",
      "Improved: Stripe payment descriptions now show the Trackman booking ID (e.g., TM-12345) when available, making it easy to search and cross-reference in the Stripe dashboard",
      "Improved: All Stripe payment metadata now includes the Trackman booking ID for robust cross-referencing between the app and Trackman systems",
      "Technical: Voided fees mark participants as 'waived' and update internal payment intent records to 'cancelled' for consistency",
    ]
  },
  {
    version: "7.85.6",
    date: "2026-02-19",
    title: "Dashboard Booking Cards Layout Improvements",
    changes: [
      "Improved: Booking Requests and Today's Bookings cards on the dashboard now have better spacing — names show fully instead of truncating, and action buttons (Check In, Assign Member, etc.) sit on their own row instead of being crammed next to the booking info",
      "Improved: More breathing room between booking items across all screen sizes — mobile, tablet, and desktop",
    ]
  },
  {
    version: "7.85.5",
    date: "2026-02-19",
    title: "Unified Fee Estimate System",
    changes: [
      "Improved: All fee estimate displays (calendar cells, booking cards, and approval modal) now use a single shared system instead of three separate copies of the same code — this eliminates inconsistencies and makes fee amounts more reliable across the page",
      "Removed: Duplicate fee estimate server endpoint that was no longer needed",
    ]
  },
  {
    version: "7.85.4",
    date: "2026-02-19",
    title: "Fee Estimates Refresh on Calendar Sync & Booking Assignment",
    changes: [
      "Fixed: Fee estimates on calendar cells and booking cards now refresh when using the Sync Calendar button or after assigning/editing bookings — previously stale fee amounts stayed visible until leaving and returning to the page",
    ]
  },
  {
    version: "7.85.3",
    date: "2026-02-19",
    title: "Cancellation Requests Now Appear in Staff Queue",
    changes: [
      "Fixed: Member cancellation requests now properly appear in the staff bookings queue — previously they disappeared from the page entirely when a member requested cancellation",
      "Note: When staff cancel in Trackman, the app automatically completes the cancellation and notifies the member — no need to also confirm in the queue",
    ]
  },
  {
    version: "7.85.2",
    date: "2026-02-19",
    title: "Payment Status & Player Count Fixes for Unified Participant System",
    changes: [
      "Fixed: Booking cards and calendar cells now correctly show 'Paid' when all participants have paid — previously they ignored actual payment status and showed fees as 'Due' based on an independent estimate",
      "Fixed: Changing the player count on a booking no longer causes a 500 error — the system now correctly updates session-based bookings without touching legacy data tables",
      "Fixed: Members who are participants in a booking (not just the owner) now see those bookings on their dashboard",
      "Fixed: Booking cards no longer make unnecessary fee estimation calls when fees are already settled",
      "Improved: Player count changes for session-based bookings are now faster and more reliable",
    ]
  },
  {
    version: "7.85.1",
    date: "2026-02-19",
    title: "Critical Fixes: Guest Addition & Staff Booking Sheet Loading",
    changes: [
      "Fixed: Staff booking details sheet no longer gets stuck on a loading screen — added a 15-second safety timeout so it always recovers",
      "Fixed: Loading state properly resets when staff close and reopen the booking details sheet",
      "Fixed: Staff booking sheet always fetches fresh participant data instead of showing stale cached info",
      "Fixed: Adding a guest from the member side no longer shows a 'signal aborted' timeout error — the modal now closes instantly while the guest is saved in the background",
      "Fixed: If a background guest addition fails, members see a clear error message instead of a confusing timeout",
    ]
  },
  {
    version: "7.85.0",
    date: "2026-02-19",
    title: "Unified Participant Data: Staff & Member Views Now Read From One Source",
    isMajor: true,
    changes: [
      "Architecture: Staff booking views now read participant data from the same source as member views, billing, and check-in — eliminating data inconsistencies",
      "Fixed: Players added or removed by members now appear instantly in staff views without any sync delay",
      "Fixed: Staff and member views always show identical participant lists, names, and fee calculations",
      "Fixed: Check-in process no longer cross-references legacy tables for participant validation — uses the authoritative participant data directly",
      "Improved: Legacy slot-based tables preserved as fallback for older bookings and Trackman imports that don't yet have session data",
    ]
  },
  {
    version: "7.84.0",
    date: "2026-02-19",
    title: "Improved Add Guest Experience & Unified Member/Staff Views",
    changes: [
      "Improved: 'Add Guest' now shows the payment choice first — members pick 'Pay Guest Fee' or 'Use Guest Pass' before entering guest details",
      "Improved: 'Pay Guest Fee' works immediately with one tap — no need to enter guest name or email first",
      "Improved: 'Use Guest Pass' requires complete guest info before submitting, with the button disabled until all fields are filled",
      "Fixed: Guests added by members now appear correctly in the staff booking details view",
      "Fixed: When a guest is removed by a member, staff booking sheets update to reflect the removal",
      "Fixed: Member portal now shows your actual name in the Manage Players list and Time Allocation section — previously showed email addresses",
      "Fixed: New sessions always store the member's name (not email) as the display name, preventing the email-showing issue from recurring",
      "Fixed: Existing bookings with email-based names are automatically corrected when viewed — a self-healing fix",
    ]
  },
  {
    version: "7.83.0",
    date: "2026-02-19",
    title: "NFC Tap Check-In: Members Can Check In by Tapping Their Phone",
    isMajor: true,
    changes: [
      "Added: Members can now check in by tapping an NFC tag at the front desk with their phone — no need to show a QR code",
      "Added: NFC check-ins trigger the same real-time staff notification with sound and member details as QR code scanning",
      "Added: Staff see pinned notes and membership status for NFC check-ins, identical to the existing QR check-in experience",
      "Added: Walk-in check-in source tracking — each check-in now records whether it came from QR scan or NFC tap",
      "Improved: Check-in business logic consolidated into a shared service, ensuring QR and NFC flows stay perfectly in sync",
      "Added: Post-login redirect for NFC — if a member taps an NFC tag while logged out, they're redirected back to complete check-in after signing in",
    ]
  },
  {
    version: "7.82.1",
    date: "2026-02-19",
    title: "Staff Fee Exemption Fix: Golf Instructors No Longer Charged",
    changes: [
      "Fixed: Golf instructors were incorrectly being charged overage and guest fees for bookings — they are now properly treated as staff with $0 fees like all other staff and admin members",
      "Fixed: Staff, admin, and golf instructor members could have prepayment charges created for their bookings in edge cases — a safety check now blocks this at the payment level",
      "Fixed: Members with unlimited-access tiers are now also protected from accidental prepayment charges",
      "Improved: All three staff roles (staff, admin, golf instructor) are now consistently recognized across the fee calculation and prepayment systems",
    ]
  },
  {
    version: "7.82.0",
    date: "2026-02-19",
    title: "Complete Stripe Webhook Coverage: 47 Event Types Now Handled",
    isMajor: true,
    changes: [
      "Added: App now handles 47 Stripe event types — up from 35 — covering virtually all payment, billing, and customer activity",
      "Added: Customer lifecycle tracking — new Stripe customers are automatically linked to member accounts, and staff are alerted if a customer is deleted externally",
      "Added: Card removal detection — when a member's last payment method is removed, the system flags them for card update and notifies staff",
      "Added: Card auto-update tracking — when a bank automatically updates card details (new expiry, replacement card), the system clears any 'card update needed' flags",
      "Added: Card expiry warnings — members get notified when their card is expiring within 30 days",
      "Added: Dispute progress tracking — staff now see real-time updates when a dispute changes status (evidence submitted, under review, won, lost)",
      "Added: Expired checkout tracking — staff are notified when a signup link or day pass checkout times out, so they can send a new link",
      "Added: Async payment support — bank transfers and other delayed payment methods are now tracked through completion or failure",
      "Added: 3D Secure / SCA detection — when a payment requires extra authentication, the member is notified to complete it and staff are alerted",
      "Added: Overdue invoice alerts — members with overdue invoices get escalated notifications, and staff see urgent alerts",
      "Added: Payment method save tracking — successful and failed attempts to save payment methods for future use are now logged and notified",
    ]
  },
  {
    version: "7.81.0",
    date: "2026-02-19",
    title: "Stripe & HubSpot Cleanup: Deletion Actually Works Now",
    isMajor: true,
    changes: [
      "Fixed: Deleting a member now properly cancels their Stripe subscription and deletes their Stripe customer when the checkbox is checked — previously these operations could silently fail",
      "Fixed: Archiving a member now cancels Stripe subscriptions BEFORE updating the database, preventing partial failures that left subscriptions active",
      "Fixed: HubSpot contact archival now searches by email as a fallback when the HubSpot ID isn't stored locally — previously members without a synced HubSpot ID were silently skipped",
      "Fixed: Archiving a member now syncs 'archived' status to HubSpot — previously archive only updated local database",
      "Improved: Deletion and archive operations now return warnings when Stripe or HubSpot operations fail, instead of silently reporting success",
      "Improved: Archive operations now include staff activity logging for audit trail",
      "Added: Trial expiry warnings — members now get a notification when their trial is ending in 3 days, so they're never surprised by billing",
      "Added: Stripe email mismatch detection — if a customer's email changes in Stripe, staff are notified of the discrepancy",
      "Added: When a member adds a new payment method, the system automatically clears 'card update required' flags and retries any failed payments",
    ]
  },
  {
    version: "7.80.0",
    date: "2026-02-19",
    title: "Stripe Webhook: Auto-Activate New Members",
    changes: [
      "Fixed: New Stripe subscriptions now automatically create and activate members in the Directory — no more manual sync button clicks needed",
      "Fixed: Stripe webhook was only receiving customer and payment events, but not subscription, invoice, or checkout events — all 34 event types are now properly registered",
      "Improved: On every server start, the app checks that the Stripe webhook has all required event types and adds any missing ones automatically",
    ]
  },
  {
    version: "7.79.0",
    date: "2026-02-19",
    title: "Trackman CSV Import: No More Fake Outstanding Fees",
    changes: [
      "Fixed: Trackman CSV imports no longer create billing sessions — they only backfill Trackman data (names, emails, notes) to make assigning owners easier",
      "Fixed: Sessions are now created only when staff manually assigns an owner to a Trackman booking, not during CSV import",
      "Fixed: Cleaned up 47 fake outstanding fees ($2,300 total) from CSV-imported bookings — these were pre-Stripe sessions that were already settled",
    ]
  },
  {
    version: "7.78.0",
    date: "2026-02-19",
    title: "Atomic Roster Changes: No More Ghost Charges",
    changes: [
      "Fixed: Roster changes on the Booking Details sheet (adding/removing players, swapping guests for members) no longer trigger fees mid-edit — fees are recalculated once when you're done",
      "Fixed: Complex operations like swapping a guest for a member no longer create intermediate 'ghost charges' for removed participants",
      "Improved: 'Save Changes' button renamed to 'Recalculate Fees' — it now clearly shows what it does",
      "Improved: If you close the booking sheet without recalculating, fees are automatically updated so nothing gets stuck",
      "Fixed: Prepayment requests are now created/updated when fees are recalculated after roster changes",
    ]
  },
  {
    version: "7.77.0",
    date: "2026-02-19",
    title: "Trackman Billing Safety: No Session Without Owner",
    changes: [
      "Fixed: Trackman webhook bookings no longer create billing sessions when there's no member assigned — prevents fake 'Unknown (Trackman)' overdue payments from appearing on the financials page",
      "Fixed: When staff links a member to an unmatched Trackman booking, a billing session is now created at that point with correct fees calculated",
      "Fixed: CSV import backfill now recalculates fees when a member is matched to a webhook booking that already had a session",
      "Fixed: Cleaned up 11 orphaned billing sessions from previously unmatched webhook bookings",
    ]
  },
  {
    version: "7.76.0",
    date: "2026-02-19",
    title: "Data Integrity Resolve Actions",
    changes: [
      "Added: Delete button for 'Members Without Email' issues on the Data Integrity page — ghost member records can now be removed directly",
      "Added: 'Mark Completed' button for 'Active Bookings Without Sessions' issues — private events and resolved bookings can now be closed out",
      "Fixed: Private event bookings (private-event@resolved) are no longer flagged as missing sessions in the integrity check",
    ]
  },
  {
    version: "7.75.0",
    date: "2026-02-19",
    title: "Billing Accuracy & Fee Display Fixes",
    changes: [
      "Fixed: Booking cards no longer show '$0 Due' when the real-time fee calculation says $0 — now shows 'Check In' button correctly",
      "Fixed: Stale cached fee amounts are now auto-corrected when the live fee estimate detects they're outdated",
      "Fixed: Remainder minutes from uneven session splits (e.g., 65 min ÷ 3 players) are now properly assigned to the booking owner instead of being lost",
      "Fixed: Fee calculations no longer under-bill when session time doesn't divide evenly among players",
      "Improved: Error logging added to 10+ backend processes that previously failed silently",
      "Improved: Database query safety checks added to prevent crashes from missing data",
    ]
  },
  {
    version: "7.74.0",
    date: "2026-02-18",
    title: "Roster Code Cleanup & Type Safety",
    changes: [
      "Improved: Roster management code reorganized for better maintainability (route file reduced from 1,878 to 370 lines)",
      "Improved: All booking, billing, and roster code now uses strict type checking — eliminated 32 unsafe type patterns",
      "Technical: Business logic extracted into dedicated service layer for easier testing and debugging",
    ]
  },
  {
    version: "7.73.0",
    date: "2026-02-18",
    title: "Simplified Booking Player Flow",
    changes: [
      "Improved: Players added to bookings are now instantly confirmed — no more invite/accept/decline steps required",
      "Removed: Pending invites section from member dashboard (no longer needed)",
      "Removed: Invite accept and decline buttons from booking notifications",
      "Removed: Invite expiry countdown timer from roster manager",
      "Removed: Background invite auto-expiry scheduler (was running every 5 minutes unnecessarily)",
      "Changed: Added-player notifications now show as booking updates instead of invites",
    ]
  },
  {
    version: "7.72.0",
    date: "2026-02-18",
    title: "App-Wide Animation & Motion Polish",
    isMajor: true,
    changes: [
      "Added: Smooth list animations across 36 pages — items now slide in/out gracefully instead of snapping when lists change (dashboard, bookings, wellness classes, admin panels, etc.)",
      "Added: Tactile press feedback on 565+ buttons, cards, and rows throughout the app — elements respond to touch/click with subtle lift and press effects",
      "Improved: Replaced 12 large loading spinners with the branded walking golfer animation for a more polished loading experience",
      "Improved: Standardized all transition speeds across the app for consistent, snappy feel — no more sluggish or jarring animations",
      "Fixed: Wellness page crash caused by animation variable scope issue — page now loads correctly",
    ]
  },
  {
    version: "7.71.0",
    date: "2026-02-18",
    title: "Save Concierge Contact — Onboarding Step",
    changes: [
      "Added: 'Save concierge contact' step to the onboarding checklist — members can download the Ever Club Concierge contact card (VCF) directly to their phone",
      "Added: Concierge contact button in the first-login welcome modal, positioned after profile setup",
      "Added: Automatic step completion tracking when the contact file is downloaded",
    ]
  },
  {
    version: "7.70.0",
    date: "2026-02-18",
    title: "Discount Code Tracking & Directory Improvements",
    isMajor: true,
    changes: [
      "Added: Discount Code field on member records — tracks which Stripe coupon each member has (e.g. Family Member, Military, Trial Promo)",
      "Added: Discount filter on Member Directory — auto-populated from discount codes currently in use, updates dynamically as new codes are added",
      "Fixed: Add New User discount dropdown now shows coupon names (e.g. 'Family Member Discount (20% off)') instead of just the percentage",
      "Fixed: Discount selection when adding a new member now saves the coupon name to their member record",
      "Removed: Legacy tag badges (Founding Member, Investor, Referral) from Directory, Dashboard, and Member Profile — replaced by the more useful Discount filter",
      "Added: Backfill tool for staff to populate discount codes for existing members from their Stripe subscriptions",
      "Improved: Member sync from HubSpot now captures the discount reason field and saves it as the member's discount code",
    ]
  },
  {
    version: "7.69.0",
    date: "2026-02-18",
    title: "Directory Filter Redesign — Operational Filters",
    isMajor: true,
    changes: [
      "Redesigned: Active tab now uses membership status filter (Active, Grace Period, Past Due) instead of legacy HubSpot-based filters",
      "Added: 'Never Logged In' app usage filter on Active tab — quickly find members who signed up but haven't opened the app yet",
      "Added: Billing provider badge (Stripe, Mindbody, Comped, Family, Manual) next to each member's email for instant billing context",
      "Removed: Legacy HubSpot tag filter row — tags still display on member rows but no longer clutter the filter bar",
      "Added: 'Last Tier' column on Former tab — shows what tier a member had before they left",
      "Added: Reactivation indicator on Former tab — shows 'Send Link' (has Stripe account) or 'New Signup' (needs fresh registration)",
      "Improved: Former tab status badges now use consistent styling that works in both light and dark mode",
      "Data: Migrated 49 former members' tier data to preserve their previous membership level for future reference",
    ]
  },
  {
    version: "7.68.0",
    date: "2026-02-18",
    title: "Admin Email Change from Profile Drawer",
    changes: [
      "Added: Admin/staff can now change a member's email directly from the profile drawer (pencil icon next to email)",
      "Note: Email changes cascade across all systems — database, Stripe, and HubSpot are all updated automatically",
      "Security: Members cannot change their own email — only admin/staff have this capability",
    ]
  },
  {
    version: "7.67.5",
    date: "2026-02-18",
    title: "Complete Sync Audit — All Gaps Closed",
    changes: [
      "Fixed: Creating a new visitor from the booking Player Management modal now automatically creates a Stripe customer for billing",
      "Fixed: Linking an existing visitor as a player now creates a Stripe customer if they don't have one yet",
      "Added: Both new and linked visitors from the booking modal now sync to HubSpot as contacts with their name and phone",
      "Fixed: Stripe Subscription Sync tool now creates HubSpot contacts with proper first/last name (was creating contacts with empty names)",
      "Fixed: Stripe Reconciliation tool now creates HubSpot contacts with proper first/last name",
      "Fixed: Corrected HubSpot phone parameter format in visitor sync calls",
      "Fixed: Staff-created HubSpot-billed members now sync to HubSpot as contacts (was skipped because deal creation was disabled)",
      "Fixed: Visitor-to-member conversions via staff admin now sync to HubSpot with name, phone, and tier",
      "Fixed: Linked visitor Stripe customer ID now explicitly saved to member record (defense-in-depth)",
      "Fixed: Online day pass buyers now sync to HubSpot as contacts (was only happening for in-person purchases via POS/QuickCharge)",
      "Fixed: Day pass webhook recordings now sync buyers to HubSpot with name and phone",
      "Fixed: Returning visitors with updated contact info now sync changes to Stripe and HubSpot when their record is updated",
      "Fixed: Unarchived visitors now sync to HubSpot and Stripe when reactivated via day pass purchase",
      "Fixed: Admin email change now syncs the new email to Stripe customer and HubSpot contact (was only updating database tables)",
    ]
  },
  {
    version: "7.67.1",
    date: "2026-02-18",
    title: "Member Info Syncs Everywhere (Stripe & HubSpot)",
    changes: [
      "Fixed: When a member updates their name or phone number from their profile, the changes now automatically sync to Stripe and HubSpot in the background",
      "Fixed: Stripe customer records now include the member's phone number — previously only name and tier were synced",
      "Fixed: Creating a new Stripe subscription for a member now syncs their name and phone to HubSpot",
      "Fixed: Adding a family or corporate sub-member to a billing group now syncs their contact info to HubSpot",
      "Fixed: Resyncing member data from HubSpot (via Data Tools) now also updates their Stripe customer record",
      "Fixed: Data Integrity sync-pull now includes phone number and updates Stripe records to match",
      "Fixed: Payment confirmation (quick charge with member creation) now syncs new member to HubSpot",
      "Fixed: QuickCharge and Terminal day-pass visitor records now sync to HubSpot for CRM tracking",
      "Fixed: Staff-invite checkout webhook now fetches phone from Stripe customer and includes it in HubSpot sync",
      "Fixed: Activation-link checkout webhook now syncs member contact info (name/phone) to HubSpot — previously only synced status",
    ]
  },
  {
    version: "7.67.0",
    date: "2026-02-18",
    title: "Migrate Mindbody Members to Stripe",
    changes: [
      "Added: 'Migrate to Stripe' button in the Billing tab for Mindbody-billed members — staff can now create a Stripe subscription directly from the member profile drawer",
      "Improved: Migration uses the member's existing Stripe customer (if they have one), preserving any credits or payment methods already on file",
      "Improved: Stripe contact fields (customer ID, billing dates) are now protected from sandbox data leaking into production HubSpot",
    ]
  },
  {
    version: "7.66.2",
    date: "2026-02-17",
    title: "Fix 'No Tier' Save for Members",
    changes: [
      "Fixed: Setting a member's Membership Level to 'No Tier' now works correctly — previously the Save button did nothing when clearing someone's tier",
      "Improved: Clearing a member's tier also sets their membership status to 'non-member' automatically",
    ]
  },
  {
    version: "7.66.1",
    date: "2026-02-17",
    title: "Data Integrity Alert Rate Limiting",
    changes: [
      "Fixed: Data integrity alerts (Critical and High Priority) now use a 4-hour cooldown with content-aware deduplication — you'll only be re-notified if the issues actually change or 4 hours pass",
      "Fixed: Cleaned up 724 duplicate data integrity notifications that had accumulated in the Updates feed",
    ]
  },
  {
    version: "7.66.0",
    date: "2026-02-17",
    title: "Training Guide Audit & Update",
    changes: [
      "Updated: Bookings Guide now accurately describes the Queue + Calendar layout, unmatched Trackman cards, Scheduled section with date filters, and the Booking Sheet workflow",
      "Updated: Managing Players & Guests guide now covers owner reassignment, creating new visitors from the roster, and player count adjustment",
      "Updated: Check-In & Billing guide now explains the Financial Summary section, inline payment method options (Card Reader, Card on File, Online Card, Waive), and fee badges",
      "Updated: Tours guide now documents native tour scheduling at /tour, 2-step booking flow, Google Calendar integration, and confirmation emails",
      "New: Application Pipeline training guide — covers the full membership application workflow from submission through checkout invitation",
      "New: Email Templates training guide — explains how to preview all automated email templates by category",
      "Updated: Getting Started guide now lists all current navigation items including Applications and Email Templates",
    ]
  },
  {
    version: "7.65.3",
    date: "2026-02-17",
    title: "Guest Participant Sync Fix",
    changes: [
      "Fixed: Adding a guest to a booking now correctly creates the participant record in the session — resolves $25 fee showing on calendar while booking details showed $0",
      "Fixed: Guest count on booking records now updates when guests are added through the roster",
      "Fixed: Fee recalculation now runs automatically after adding a guest, ensuring guest passes are properly applied",
      "Improved: Staff activity log now captures when guests are added to bookings",
    ]
  },
  {
    version: "7.65.2",
    date: "2026-02-17",
    title: "Booking Owner Reassignment",
    changes: [
      "New: Staff can now reassign booking ownership directly from the booking detail modal — tap the swap icon next to the owner's name, search for a member, and the booking transfers instantly",
      "Improved: Reassigning an owner now updates the display name, recalculates fees based on the new owner's tier, and logs the change to the staff activity feed",
    ]
  },
  {
    version: "7.65.1",
    date: "2026-02-17",
    title: "Trackman Booking ID Verification",
    changes: [
      "New: Trackman Booking ID verification — the system now validates that pasted IDs are real Trackman numbers (not UUIDs or other formats) before saving",
      "New: Duplicate Trackman ID prevention — blocks linking the same Trackman booking to multiple app bookings",
      "Fixed: Bookings with invalid Trackman IDs (like UUIDs) can now be cancelled directly without getting stuck in 'awaiting Trackman cancellation' state",
    ]
  },
  {
    version: "7.65.0",
    date: "2026-02-17",
    title: "Data Integrity & Zombie Member Prevention",
    changes: [
      "New: Permanently deleted members are now blocked from being re-created by ALL 16 user creation paths — including HubSpot sync, HubSpot webhooks, Stripe webhooks, Stripe subscription sync, Stripe reconciliation, group billing, subscription checkout, activation links, payment confirmations, POS terminal, visitor creation, and visitor matching",
      "New: Automated data integrity checks run daily and auto-fix common issues (billing provider gaps, case-inconsistent statuses, staff role mismatches)",
      "New: Calendar sync retry logic — temporary failures retry once before alerting, reducing false alarm notifications",
      "Fixed: 3 zombie test members (nick+astoria, adam+core, jack+testcore) that kept reappearing have been permanently removed and blocked",
      "Fixed: Onboarding checklist now properly tracks waiver signing, first booking, and profile completion",
      "Improved: HubSpot form sync errors are now handled quietly when they're just permission issues",
      "Improved: Payment reconciliation now has timeout protection to prevent stuck processes",
    ]
  },
  {
    version: "7.64.0",
    date: "2026-02-17",
    title: "Member Onboarding Overhaul",
    isMajor: true,
    changes: [
      "New: Onboarding Checklist on the dashboard guides new members through 4 key steps — complete profile, sign waiver, book first session, and install the app",
      "New: First-login welcome modal greets new members with quick-start actions on their first sign-in",
      "New: Dashboard empty states now show helpful messages and action buttons instead of blank sections",
      "New: Automated email nudge sequence sends friendly reminders to members who haven't logged in (at 24 hours, 3 days, and 7 days)",
      "New: Application Pipeline admin view at /admin/applications lets staff track membership applications from inquiry through checkout invitation",
      "New: Staff can now send checkout invitations directly from the application pipeline with tier selection",
      "Improved: First login and first booking are now tracked automatically to measure member activation",
      "Improved: Waiver CTA in welcome modal now opens the waiver signing modal directly",
    ]
  },
  {
    version: "7.63.5",
    date: "2026-02-17",
    title: "Billing Security Audit — Final Hardening",
    changes: [
      "Fixed: Day pass billing no longer silently falls back to a hardcoded $50 price — now stops and logs an error if the price isn't properly configured",
      "Fixed: Corporate group billing no longer falls back to a hardcoded $350/seat price — now fails safely with a clear error if the Stripe subscription data is missing",
      "Fixed: Check-in fee snapshot recording now runs inside a database transaction — prevents duplicate or partial records if two staff members check in simultaneously",
    ]
  },
  {
    version: "7.63.4",
    date: "2026-02-17",
    title: "Complete Billing Idempotency Coverage",
    changes: [
      "Fixed: Subscription creation and its fallback payment intent now include idempotency keys — prevents duplicate subscriptions or charges during signup retries",
    ]
  },
  {
    version: "7.63.3",
    date: "2026-02-17",
    title: "Refund Safety & Complete Billing Hardening",
    changes: [
      "Fixed: All Stripe refund calls now include idempotency keys — prevents duplicate refunds from double-clicks or network retries across all cancellation and refund flows",
      "Fixed: Staff refund processing now wraps all database updates (payment status, participant records, usage ledger reversals, audit log) in a single transaction — partial failures no longer leave inconsistent data",
      "Fixed: Refund ledger reversal failures now properly roll back the entire refund record instead of silently continuing with partial data",
    ]
  },
  {
    version: "7.63.2",
    date: "2026-02-17",
    title: "Billing Idempotency & Transaction Safety",
    changes: [
      "Fixed: All Stripe payment intent creation calls now include idempotency keys — prevents accidental double charges from network retries or duplicate requests",
      "Fixed: Staff saved-card charge now wraps all database updates (participants, payment records, staff actions) in a single transaction — if any step fails, everything rolls back cleanly",
      "Fixed: POS saved-card charges now record in the payment intents table immediately — previously relied on webhook processing, which could leave a tracking gap",
      "Fixed: POS charge database writes (payment record + audit log) now wrapped in a transaction for consistency",
      "Improved: All Stripe API calls now use the managed client singleton — eliminated the last direct instantiation",
    ]
  },
  {
    version: "7.63.1",
    date: "2026-02-17",
    title: "Billing State Consistency Improvements",
    changes: [
      "New: Payment intents in 'processing' or 'requires action' states are now tracked in real-time — admin dashboards now accurately reflect payments waiting for 3D Secure authentication",
      "Fixed: When a payment fails, the associated fee snapshot is now immediately marked as failed — previously required the reconciliation scheduler to catch the inconsistency",
    ]
  },
  {
    version: "7.63.0",
    date: "2026-02-17",
    title: "Billing System Hardening",
    changes: [
      "New: Abandoned payment intents are now automatically cancelled after 2 hours — previously required manual Stripe dashboard visits or 7-day wait",
      "New: Payment modal now cleans up incomplete payments when closed or when the browser tab is closed — prevents orphaned charges",
      "New: Invoice PDF download links now appear alongside the 'View' button in the billing section",
      "New: Stripe credit notes are now processed via webhooks — members receive a notification when a credit is applied to their account",
      "Improved: Reconciliation scheduler now runs three cleanup passes every 15 minutes: fee snapshot sync, stale intent cleanup, and abandoned payment cancellation",
    ]
  },
  {
    version: "7.62.0",
    date: "2026-02-17",
    title: "Security Hardening & Bug Fixes",
    isMajor: true,
    changes: [
      "Fixed: Payment routes (overage, member payments, guest pass purchases, balance payments) now require proper authentication — previously accessible without login in edge cases",
      "Fixed: Conference room prepayment routes now require authentication middleware",
      "Fixed: Member dashboard data endpoint now requires authentication middleware",
      "Fixed: RSVP creation now requires authentication — previously could be submitted without a logged-in session",
      "Fixed: Guest pass routes now require authentication middleware for all operations",
      "Fixed: Day pass redemption timezone bug — 'already redeemed today' check now uses Pacific time instead of UTC, preventing potential double-use near midnight",
      "Fixed: HubSpot member sync dates now use Pacific timezone instead of UTC — join dates and close dates are now accurate for evening signups",
      "Fixed: Billing date displays (booking dates, cancellation effective dates) now use Pacific timezone throughout",
      "Fixed: Staff check-in booking descriptions now show Pacific-timezone dates",
      "Fixed: Member join dates calculated from Stripe/HubSpot now use Pacific timezone",
      "Fixed: WebSocket origin validation tightened — previously a permissive substring check could match unintended domains",
      "Fixed: Background notifications and broadcasts now properly handle errors instead of silently failing",
      "Fixed: Guest pass use and refund operations are now wrapped in database transactions — partial failures can no longer leave data in an inconsistent state",
      "Fixed: Booking cancellation database writes are now transactional — prevents partially-cancelled bookings if something goes wrong mid-process",
      "Fixed: Events, RSVPs, announcements, closures, tours, wellness reviews, and member history endpoints now have result limits to prevent performance issues with large datasets",
      "Fixed: All error handling across the entire backend now uses proper TypeScript type safety (150+ catch blocks updated)",
      "New: Stripe subscription pause and resume events are now handled — if a membership is paused via Stripe, the member's status updates to frozen and staff are notified; resuming restores active status",
      "New: Staff and admin user creation, modification, and deletion now logged in the Staff Activity feed",
      "New: Application settings changes (individual and bulk) now logged in the Staff Activity feed",
      "New: Stripe coupon creation, updates, and deletion now logged in the Staff Activity feed",
      "New: Member role changes now logged in the Staff Activity feed for full accountability",
      "Improved: Database queries optimized — batch operations replace individual queries in group billing, booking notifications, calendar sync, and availability checks for faster performance"
    ]
  },
  {
    version: "7.61.0",
    date: "2026-02-15",
    title: "Staff Notification Delivery Fix",
    changes: [
      "Fixed: All cancellation notifications now reach every staff member individually instead of going to a single shared address — no more missed alerts",
      "Fixed: Staff-initiated cancellations, Trackman cancellation reminders, and stuck cancellation alerts all deliver to each staff member's notification feed, push, and real-time channel",
      "Fixed: Cancellation requests from the member booking page now use the same improved delivery as the command center",
      "Fixed: Trackman webhook cancellations now create proper staff notifications (database + push + real-time) instead of push-only",
      "Fixed: Manual bookings, billing migration alerts, and membership cancellation requests now use full delivery (previously database-only, no push or real-time)",
      "Fixed: Membership cancellation notification was sending broken data — now sends proper notification type",
      "Improved: Stuck cancellation scheduler checks all staff notifications instead of a single address when detecting recently alerted bookings",
      "Improved: Consolidated all staff notifications through a single reliable delivery system across the entire app"
    ]
  },
  {
    version: "7.60.0",
    date: "2026-02-15",
    title: "Cancellation Request Visibility for Staff",
    changes: [
      "New: Cancellation requests now appear directly in the Pending Requests queue in the Staff Command Center — no more missed cancellations",
      "New: Cancellation requests show a red 'Cancellation' badge with Trackman info so staff can immediately see what needs to be cancelled",
      "New: 'Complete Cancellation' button lets staff mark a cancellation as done directly from the command center after handling it in Trackman",
      "Improved: Cancellation alerts in the notification feed now have a prominent red border so they stand out from routine notifications",
      "Improved: Staff Command Center live-updates when a member submits or completes a cancellation — no manual refresh needed"
    ]
  },
  {
    version: "7.59.0",
    date: "2026-02-13",
    title: "Public Pages CRO Optimization",
    isMajor: true,
    changes: [
      "New: Landing page hero rewritten with outcome-focused headline and flipped CTA hierarchy — tour booking is now the primary action",
      "New: Press/social proof bar added to landing page (Forbes, Hypebeast, etc.) and exclusivity signal with capped membership urgency",
      "New: Membership page now features Third Space positioning header, value-framing against country clubs ($20k+), and social proof section",
      "New: Book a Tour form enhanced with social proof, trust signals, and improved success screen with clear next steps",
      "New: Apply form updated with reassurance copy, privacy trust signal near submit, and enhanced confirmation screen linking to membership tiers",
      "New: Private Hire page CTA changed to 'Plan Your Event' with capacity signal (10–600+ guests), consent checkbox moved to final step per form best practices",
      "New: Gallery, What's On, Cafe, and FAQ pages now include conversion CTAs guiding visitors toward tour booking or membership",
      "New: FAQ page adds 'Is Ever Club just a simulator room?' as top objection-handling answer and a 'Still have questions?' CTA section",
      "New: Day Pass page now shows access details (wifi, cafe, lounge) and membership upsell path after purchase",
      "New: Contact page adds tour booking nudge at top and in success screen",
      "New: Phone number is now required on tour booking, membership application, and private hire inquiry forms",
      "New: Phone numbers auto-format as (xxx) xxx-xxxx across all forms for consistent data collection"
    ]
  },
  {
    version: "7.58.0",
    date: "2026-02-13",
    title: "Native Tour Scheduler",
    changes: [
      "New: Dedicated /tour page replaces the old external HubSpot meeting scheduler with a fully native booking experience built into the app",
      "New: 2-step flow — enter your info, then pick a date and time from real available slots pulled directly from the Tours Scheduled Google Calendar",
      "New: Booking creates a Google Calendar event on the Tours Scheduled calendar automatically",
      "New: Confirmation email sent to the guest with tour date, time, and club address",
      "New: Staff notifications for new tour bookings via in-app alerts and real-time updates",
      "New: Available time slots shown in 30-minute increments, 10am–5pm, filtered against existing calendar events and booked tours",
      "Removed: HubSpot meeting scheduler embed from landing page — 'Book a Tour' now links directly to /tour"
    ]
  },
  {
    version: "7.57.0",
    date: "2026-02-13",
    title: "HubSpot Integrity Sprint — Form Submission & Deal Enrichment",
    changes: [
      "Fixed: Form submissions no longer fail due to invalid contact properties being sent to HubSpot (event_date, event_time, additional_details, event_services, marketing_consent, topic were being rejected)",
      "Fixed: membership_interest casing mismatch — 'Not sure yet' now correctly maps to HubSpot's 'Not Sure Yet' dropdown value",
      "New: marketing_consent from forms now maps to eh_email_updates_opt_in contact property instead of being rejected",
      "New: Backend field filtering — only valid HubSpot contact properties are sent to the Form Submission API; all original fields still saved to local database",
      "New: Event deal enrichment — Private Hire and Event Inquiry forms now populate structured deal properties (event_date, event_time, event_type, expected_guest_count, event_services, additional_details) on the HubSpot deal record",
      "New: Created 3 custom HubSpot deal properties (event_time, event_services, additional_details) for structured event data",
      "New: Fire-and-forget deal enrichment finds the workflow-created deal and updates it with event details, or creates the deal directly if the workflow hasn't fired yet",
      "Impact: HubSpot workflows tied to form submissions (deal creation, follow-up emails) will now trigger reliably since form submissions no longer fail"
    ]
  },
  {
    version: "7.56.0",
    date: "2026-02-13",
    title: "Stripe Wins — Billing Provider Sync Hardening",
    isMajor: true,
    changes: [
      "New: 'Stripe Wins' guard in HubSpot member sync — when a member is billed through Stripe, their membership status and tier can no longer be overwritten by stale Mindbody data flowing through HubSpot",
      "New: Database CHECK constraint on billing_provider column — only valid values (stripe, mindbody, manual, comped, family_addon) can be stored, preventing data corruption",
      "New: Billing Provider Hybrid State integrity check — daily scan detects members with mismatched billing data (e.g., labeled as Mindbody but holding a Stripe subscription)",
      "New: Outbound HubSpot sync protection — membership status is no longer pushed back to HubSpot for Mindbody-billed members, preventing sync loops between HubSpot and the app",
      "New: billing_provider_changed audit action for tracking billing provider migrations",
      "Fixed: When a Mindbody member migrates to Stripe, their grace period flags are now automatically cleared",
      "Fixed: Both full and focused HubSpot sync functions now respect the Stripe Wins guard consistently",
      "Improved: Stripe subscription sync now clears grace period data when transitioning a member from Mindbody to Stripe billing",
      "Fixed: All Stripe webhook handlers (subscription updates, terminal payments, disputes) now reinforce billing_provider='stripe' on every status change — prevents edge cases where billing provider could be missing",
      "Fixed: Subscription payment confirmation and invoice charge endpoints now set billing_provider='stripe' alongside membership activation",
      "Fixed: Grace period scheduler now explicitly passes billingProvider when syncing terminated status to HubSpot",
      "New: Sub-member HubSpot sync — when a primary member's Stripe subscription changes (active, past due, suspended, cancelled), all family/corporate sub-members now get their updated status pushed to HubSpot in real-time",
      "New: Group billing cancellation now syncs cancelled sub-members to HubSpot — previously only the primary member's status was reflected in HubSpot"
    ]
  },
  {
    version: "7.55.0",
    date: "2026-02-13",
    title: "Tier Data Integrity Hardening",
    isMajor: true,
    changes: [
      "New: Database CHECK constraint on the tier column — only valid normalized tier values (Core, Premium, Social, VIP, Corporate, Staff, Group Lessons) can be stored, preventing data corruption at the source",
      "New: Database trigger auto-normalizes tier values on write — catches variants like 'Core Membership' and converts them to 'Core' before they reach the database",
      "Fixed: Data integrity reconciliation now normalizes HubSpot tier values before writing to the database instead of storing raw HubSpot format",
      "Fixed: All 3 HubSpot outbound push paths now consistently use denormalizeTierForHubSpot() instead of hardcoded mappings or raw values",
      "Fixed: Stripe webhook handlers now normalize tier metadata before database writes — covers subscription creation, checkout completion, group billing, and quick charge flows",
      "Fixed: Backfilled 465 membership_tier records to match canonical tier values, eliminating stale HubSpot-format values like 'Core Membership Founding Members'",
      "Fixed: Staff VIP enforcement on login now writes canonical 'VIP' to both tier and membership_tier instead of raw 'VIP Membership' format",
      "Fixed: Manual tier update tool now writes canonical tier names to database and maps legacy 'Founding' and 'Unlimited' to their correct tiers (Core and Premium)",
      "Fixed: HubSpot outbound pushes now skip unsupported tiers (like Staff) instead of sending raw values that HubSpot can't recognize",
      "Improved: membership_tier column now always derives from the canonical tier column — no more divergent values between the two columns"
    ]
  },
  {
    version: "7.54.2",
    date: "2026-02-13",
    title: "Unified Billing — Eliminate Duplicate Fee Logic",
    changes: [
      "Fixed: Booking detail panel now uses the same unified fee system as all other billing endpoints — eliminates ~120 lines of duplicate tier/overage/staff logic that could produce different results",
      "Fixed: Fee line items now correctly match to the right member in both new and existing bookings, preventing wrong fee assignments",
      "Fixed: All membership tiers (Social, Standard, Premium, VIP, Staff) now consistently go through the single source of truth for fee calculations",
      "Improved: Guest fee handling in booking details now uses the unified system's guest pass tracking instead of separate inline logic"
    ]
  },
  {
    version: "7.54.1",
    date: "2026-02-13",
    title: "Booking Fee Display Fix",
    changes: [
      "Fixed: Booking cards no longer show incorrect '$50 Due' for Premium members with unlimited access — the real-time fee calculation is now authoritative",
      "Fixed: Stale cached fee data no longer overrides fresh calculations, resolving mismatch between booking list and booking details",
      "Improved: Fee estimates for existing sessions now sync cached values to prevent future discrepancies"
    ]
  },
  {
    version: "7.54.0",
    date: "2026-02-13",
    title: "Full Frontend Audit — Dark Mode, Design Consistency & Performance Upgrades",
    isMajor: true,
    changes: [
      "New: Dark mode support added to all 14 public pages that were missing it — Login, Contact, Gallery, Membership, WhatsOn, PrivateHire, FAQ, Cafe, forms, and more",
      "New: Liquid Glass styling added to 5 admin tabs that were visually inconsistent (Cafe, Tours, Settings, Team, Events)",
      "Improved: 70+ hardcoded color values replaced with design system tokens across 16 pages for easier theming",
      "Improved: Modal close animation — modals now smoothly fade out instead of disappearing instantly",
      "Improved: Admin feedback — CafeTab and TiersTab now show toast messages instead of browser alert popups",
      "Improved: Monitoring panels stop polling when browser tab is in background — saves battery and bandwidth",
      "Improved: Stripe and HubSpot scripts now load lazily for faster page loads",
      "Improved: Large libraries (Stripe, TanStack) split into separate bundles for better caching",
      "Improved: Stripe DNS preconnect added for faster checkout",
      "Fixed: Accessibility — 25+ form labels properly linked to inputs for screen readers",
      "Fixed: Profile page delete account error now correctly shows error message instead of success",
      "Fixed: DirectoryTab filter pills now display correctly in dark mode",
      "Fixed: EventsTab dark mode coverage expanded",
      "Fixed: Reduced-motion preference now properly handles all animated elements — no more invisible content",
      "Fixed: Theme transition speed improved from 0.4s to 0.3s for snappier feel",
      "Fixed: Safari mobile top toolbar now properly shows green to match the header — restored theme-color with light/dark mode support",
      "Fixed: Splash screen background changed from green to cream/bone for faster perceived load",
      "Fixed: PWA install splash screen background updated to match light theme",
      "Fixed: Dark mode splash screen uses proper dark olive background",
      "Fixed: Theme color dynamically updates when switching between light and dark modes",
    ],
  },
  {
    version: "7.53.0",
    date: "2026-02-13",
    title: "Admin Monitoring Dashboard — See Everything Running Under the Hood",
    isMajor: true,
    changes: [
      "New: Email Templates page — preview all 18 email templates with sample data right from the admin sidebar, so you can see exactly what members receive",
      "New: Scheduled Tasks Monitor — see the health of all 25+ background jobs at a glance with green/yellow/red status lights, last run time, and run counts",
      "New: Webhook Event Viewer — browse incoming webhook events with type and status filtering, and click to expand full event details",
      "New: Job Queue Monitor — see pending, processing, completed, and failed background jobs with error details for failed ones",
      "New: HubSpot Sync Queue Status — monitor HubSpot sync queue depth, failed items, and average processing time",
      "New: System Alert History — timeline of all system alerts and notifications with severity colors and date range filtering",
      "Fixed: 10 scheduler error handlers that would crash instead of logging errors correctly",
      "Fixed: Security hardening on monitoring queries to prevent injection attacks",
    ],
  },
  {
    version: "7.52.0",
    date: "2026-02-12",
    title: "Data Tools: Full Audit & Optimization",
    isMajor: true,
    changes: [
      "Improved: Reconcile Group Billing now logs all activity to the staff activity feed",
      "Improved: Backfill Stripe Cache now logs activity to the staff activity feed",
      "Fixed: Detect Duplicates now checks ALL members instead of only the first 100/500 — no more hidden duplicates",
      "Improved: Detect Duplicates HubSpot checks run faster with larger batches and shorter delays",
      "Improved: Stripe Customer Cleanup pre-loads all active members in one query instead of checking the database for each customer individually — dramatically faster",
      "Improved: Stripe Customer Cleanup skips all Stripe API calls for known active members and adds rate limiting to prevent Stripe throttling",
      "Improved: Archive Stale Visitors now uses indexed email lookups (7 new database indexes) for faster scanning",
      "Improved: Archive Stale Visitors adds rate limiting between Stripe check batches",
      "Improved: Placeholder Cleanup scan now logs activity to staff activity feed",
      "Improved: Placeholder Cleanup uses HubSpot batch delete (100 at a time) instead of deleting contacts one-by-one",
    ],
  },
  {
    version: "7.51.0",
    date: "2026-02-12",
    title: "Data Integrity: Accuracy, Resilience & Performance",
    isMajor: true,
    changes: [
      "New: Each integrity check is now isolated — if one check fails (e.g., Stripe API is down), the rest continue running instead of the whole page crashing",
      "New: Per-check timing is now displayed so staff can see which checks are slow",
      "Fixed: Checks that failed due to API errors no longer silently report 'pass' — they now show a clear warning with the error details",
      "Fixed: Stripe Subscription Sync and Tier Reconciliation now check ALL members instead of a random sample of 100",
      "Improved: Tier Reconciliation now uses HubSpot batch API and caches Stripe products — dramatically fewer API calls",
      "Improved: Added 10 database indexes to speed up orphan record checks and foreign key lookups",
    ],
  },
  {
    version: "7.50.0",
    date: "2026-02-12",
    title: "Bulk HubSpot Push — End the Mismatch Cycle",
    isMajor: true,
    changes: [
      "New: 'Push All to HubSpot' now pushes tier, first name, and last name for ALL members to HubSpot at once — not just the random 100 shown in the integrity check",
      "Improved: Uses HubSpot batch API to update up to 100 contacts per call, dramatically faster than one-by-one syncing",
      "Improved: Only updates contacts that actually have mismatches, saving API calls and reducing rate limit risk",
      "Fixed: Churned and expired members now correctly have their HubSpot tier cleared to empty instead of leaving stale values",
    ],
  },
  {
    version: "7.49.0",
    date: "2026-02-12",
    title: "HubSpot Sync Accuracy & Auto-Merge",
    isMajor: true,
    changes: [
      "Fixed: HubSpot sync mismatch checks now compare the correct active membership tier instead of a stale legacy field, dramatically reducing false mismatch alerts",
      "Fixed: Terminated, expired, and non-member accounts no longer trigger false tier mismatches — their empty tier in HubSpot is now correctly recognized as expected",
      "Fixed: 'Sync to HubSpot' push now sends the properly mapped tier value and clears the tier for churned members instead of pushing stale data",
      "Fixed: 'Pull from HubSpot' now updates the active tier field in the app, not just a legacy column that the app doesn't use",
      "New: HubSpot ID Duplicate issues now have a one-click Merge button — when contacts are merged on HubSpot's side, you can merge the matching app accounts with a single click",
    ],
  },
  {
    version: "7.48.8",
    date: "2026-02-12",
    title: "Outstanding Balance Accuracy Fix",
    changes: [
      "Fixed: Outstanding fees now show accurately in member profile drawer by computing fees on-the-fly for sessions that hadn't been cached yet",
    ],
  },
  {
    version: "7.48.7",
    date: "2026-02-12",
    title: "Archive Stale Visitors Fix",
    changes: [
      "Fixed: Archive Stale Visitors tool was finding eligible visitors but failing to actually archive them due to a database query issue",
      "Improved: Archive scan now also checks the booking participants table, so visitors who have bookings through the current system won't be incorrectly flagged as stale",
    ],
  },
  {
    version: "7.48.6",
    date: "2026-02-12",
    title: "Trackman Import Merged Account Fix",
    changes: [
      "Fixed: Trackman bookings were incorrectly linking to old merged accounts instead of the active member account, causing false fees and a 'Merged' badge on bookings",
      "Fixed: Corrected 2 bookings for William Holder that were linked to his old merged account — fees zeroed and membership benefits now apply",
      "Improved: Trackman import now automatically skips merged accounts when matching members, preventing this issue from happening again",
    ],
  },
  {
    version: "7.48.5",
    date: "2026-02-12",
    title: "Outstanding Balance Relocated to Staff View",
    changes: [
      "Changed: Outstanding balance card removed from the member dashboard — members no longer see unfinalized fee amounts that could cause confusion",
      "Changed: Outstanding fees now appear in the staff member profile drawer under the Account Balance section, with total owed, item count, and expandable breakdown",
      "Improved: Staff still have full visibility into overage and guest fees pending collection for each member",
    ],
  },
  {
    version: "7.48.4",
    date: "2026-02-12",
    title: "Trackman Import Billing Accuracy Fix",
    changes: [
      "Fixed: Sessions imported from Trackman now correctly store billing amounts on each participant, so the Overdue Payments list shows accurate totals instead of incorrect charges",
      "Fixed: In multi-player sessions, each player is now correctly charged for their share of the time (e.g., 2 players in a 2-hour session each get 1 hour) instead of the booking owner being charged for the full session duration",
      "Fixed: $0 fees are no longer confused with 'not yet calculated' — members within their daily allowance correctly show $0 owed",
      "Fixed: Corrected billing data for 2 affected sessions that had incorrect charges from the previous import logic",
    ],
  },
  {
    version: "7.48.3",
    date: "2026-02-12",
    title: "Payment Failure Webhook Hardening",
    changes: [
      "Improved: Payment failure handling is now more resilient — the system validates the subscription status before putting a member into a grace period, so stale or already-canceled subscriptions don't accidentally trigger grace periods",
      "Fixed: HubSpot sync for failed payments now runs after the database save completes, preventing partial updates if something goes wrong mid-process",
      "Added: Staff now see the Stripe attempt count and specific decline codes (e.g., 'insufficient_funds') in payment failure alerts, making it faster to diagnose issues",
      "Added: Automatic error alerts are now sent for all payment failures, with escalating urgency for repeated failures",
      "Fixed: If a member's grace period was already started, duplicate payment failure events no longer send duplicate notifications",
      "Improved: Email matching for payment failures is now case-insensitive across all lookups, preventing missed notifications for members who signed up with mixed-case emails",
    ],
  },
  {
    version: "7.48.2",
    date: "2026-02-12",
    title: "Terminal Cancel & Payment Polling Improvements",
    changes: [
      "Fixed: Card reader payments no longer show 'Payment Failed' while the terminal is still waiting for the customer to tap — the system now correctly waits for the card instead of treating the waiting state as an error",
      "Improved: Cancel button now fully cancels both the reader action and the pending payment in Stripe, so no orphan charges are left behind",
      "Added: Cancel button shows a loading spinner while canceling to prevent double-clicks",
      "Added: If the card was already tapped right as you hit Cancel, the system detects this and treats it as a successful payment instead of erroring out",
      "Improved: Card decline messages now show the specific reason from Stripe (e.g., 'Card declined: insufficient funds') instead of a generic error",
    ],
  },
  {
    version: "7.48.0",
    date: "2026-02-12",
    title: "Create Member Flow Reliability Fix",
    changes: [
      "Fixed: 'Send Link' and 'Copy Link' buttons no longer error out on the first click — eliminated a race condition where the in-person payment setup would conflict with the link-sending process",
      "Fixed: 'Copy Link' now reliably copies the checkout URL to your clipboard — the link is fully generated before the copy happens",
      "Improved: Payment step now shows a clear choice between 'Collect Payment Now' (card/reader) and 'Send Payment Link' — prevents both flows from running at the same time",
      "Added: Double-click protection on Send/Copy Link buttons — prevents accidental duplicate submissions",
      "Improved: Better error messages — if a pending signup conflicts, you'll see a clear message instead of a generic error",
    ],
  },
  {
    version: "7.47.1",
    date: "2026-02-11",
    title: "POS Terminal Invoice Payment Fix",
    changes: [
      "Fixed: POS terminal payments with cart items now work reliably — the system creates a dedicated card-reader payment instead of relying on invoice auto-payment, which failed when customers had no card on file",
      "Fixed: Invoice is now automatically marked as paid once the card reader successfully processes the payment",
      "Improved: Terminal invoice flow properly handles the case where a new customer has never saved a card before",
    ],
  },
  {
    version: "7.47.0",
    date: "2026-02-11",
    title: "Staff Terminal UI & Card Management",
    changes: [
      "Added: 'Update Card via Reader' button on the member billing tab — staff can now update a member's payment method directly from their profile using the card reader, no charge required",
      "Added: When no card is on file, an 'Add Card via Reader' button appears so staff can add one right from the profile",
      "Improved: Card reader waiting screen now shows a clear 'Waiting for Reader...' display with pulsing animation, helpful instructions, and a prominent Cancel button",
      "Improved: Save-card mode shows a 'No charge — saving card only' notice so staff know no money is being taken",
      "Added: Auto-cancel notice on the waiting screen reminds staff the action will timeout after 2 minutes",
    ],
  },
  {
    version: "7.46.0",
    date: "2026-02-11",
    title: "Stripe Terminal & Wellness Improvements",
    changes: [
      "Fixed: Wellness class enrollment button no longer causes accidental cancellations from rapid double-taps — added cooldown protection and deferred UI updates",
      "Fixed: Terminal invoice payments now use the correct price format — resolves failed in-person invoice charges",
      "Added: Terminal subscription payments now automatically save the card for future recurring billing",
      "Added: Staff can now update a member's payment card on file via the card reader without charging them",
      "Added: Card reader interactions now have a 2-minute timeout — if the reader doesn't respond, the action is automatically canceled to prevent stuck states",
      "Fixed: Card save confirmation now properly verifies success before showing the 'saved' message — prevents false success reports",
    ],
  },
  {
    version: "7.45.0",
    date: "2026-02-11",
    title: "HubSpot Deal Creation Disabled & Cleanup",
    changes: [
      "Changed: HubSpot deal creation is now disabled — no new deals will be created until further notice",
      "Changed: All 2,703 existing HubSpot deals created by the app have been removed from HubSpot",
      "Changed: Local deal tracking tables cleared — HubSpot contacts and other syncing still work normally",
    ],
  },
  {
    version: "7.44.2",
    date: "2026-02-11",
    title: "New Member Signup & Reschedule Fixes",
    changes: [
      "Fixed: Adding a new member no longer blocks with 'incomplete signup' error — stale pending records are automatically cleaned up and reused",
      "Fixed: Rescheduling a conference room booking now shows conference rooms in the dropdown instead of simulator bays",
      "Fixed: Reschedule labels dynamically show 'Room' instead of 'Bay' for conference room bookings",
      "Fixed: Rescheduling a conference room no longer asks for a Trackman Booking ID — that only applies to simulator bookings",
    ],
  },
  {
    version: "7.44.0",
    date: "2026-02-11",
    title: "Conference Room Booking Fixes",
    changes: [
      "Fixed: Members can now book conference rooms even if they have a pending simulator request — these are separate systems",
      "Fixed: Having a simulator booking on the same date no longer blocks conference room bookings (and vice versa)",
      "Fixed: Conference room access is now correctly checked using the conference booking permission, not the simulator permission",
      "Fixed: Confirmed conference room bookings now properly count toward your daily allowance to prevent double-booking",
      "Fixed: Conference room access check on the booking page now uses the correct permission flag from your membership tier",
    ],
  },
  {
    version: "7.43.1",
    date: "2026-02-11",
    title: "Wellness External URL Data Fix",
    changes: [
      "Fixed: External URL for wellness classes was being dropped during data loading on the member page — 'Learn More' buttons now appear correctly",
      "Fixed: Data mapping now properly passes external_url from the API through to the wellness class cards",
    ],
  },
  {
    version: "7.43.0",
    date: "2026-02-11",
    title: "External Link Buttons for Events & Wellness",
    changes: [
      "New: Events and wellness classes with an external URL now show a 'Learn More' button that opens the link directly",
      "New: External link buttons work on the public What's On page too — replacing the greyed-out 'Members Only' placeholder",
      "New: Eventbrite events keep their existing 'Get Tickets' style; admin-set external links get the green 'Learn More' style",
      "Improved: Member events page now opens external links for all events with a URL, not just Eventbrite ones",
    ],
  },
  {
    version: "7.42.2",
    date: "2026-02-11",
    title: "Trackman Link & SQL Safety Fixes",
    changes: [
      "Fixed: Linking a Trackman booking to a member no longer fails due to a data type mismatch — user IDs are now properly stored as text",
      "Fixed: Staff notes on linked bookings now build correctly instead of using a raw database expression that could fail",
      "Fixed: Both 'update existing booking' and 'create new booking' paths in the Trackman link flow now handle user ID types consistently",
    ],
  },
  {
    version: "7.42.1",
    date: "2026-02-11",
    title: "Private Event Linking & Blocks Pagination",
    changes: [
      "Improved: 'Mark as Private Event' now always shows all same-day notices so staff can choose which one to link to, preventing duplicate blocks",
      "Improved: When no notices exist for the day, staff still sees the option to create a new one",
      "New: Blocks tab now shows 10 days at a time with a 'Load More' button at the bottom instead of the full list",
    ],
  },
  {
    version: "7.42.0",
    date: "2026-02-11",
    title: "Data Integrity Audit & Hardening",
    isMajor: true,
    changes: [
      "Fixed: Stripe subscription sync now checks a random sample of members each run instead of always checking the same 100",
      "Fixed: Removed duplicate 'Empty Booking Sessions' check that overlapped with 'Sessions Without Participants'",
      "Fixed: Severity map now correctly maps all 24 integrity checks — removed 3 phantom entries and added 4 missing ones",
      "Fixed: Pending user cleanup now safely removes all related records (bookings, notifications, fees, etc.) in a transaction before deleting the user",
      "New: Stale tours older than 7 days are automatically marked as 'no-show' during integrity checks",
      "New: Data cleanup runs automatically before scheduled integrity checks to resolve transient issues first",
      "New: Email normalization now covers 6 tables (added event RSVPs, wellness enrollments, guest passes)",
      "New: Orphaned fee snapshots (from deleted bookings) are automatically cleaned up during data maintenance",
      "Improved: Cleanup route response now reports orphaned fee snapshot removal count",
    ],
  },
  {
    version: "7.41.0",
    date: "2026-02-11",
    title: "Facility Page Redesign — Liquid Glass",
    isMajor: true,
    changes: [
      "New: Glass Segmented Control replaces bulky tab buttons — compact pill shape with a sliding white active indicator",
      "New: Unified Glass Toolbar consolidates filters, color legend, and Google Calendar sync status into one sticky row",
      "New: Glass Card layout for all notices — translucent cards with colored left border, hover lift effect, and shadow depth",
      "New: Edit buttons now fade in on hover (desktop) to reduce visual clutter, always visible on mobile",
      "New: Closure Reasons and Notice Types collapsed into compact pill badges instead of large grid sections",
      "Improved: Needs Review drafts use the same Glass Card treatment with cyan left border",
      "Improved: Past notices section uses glass styling with subtle opacity treatment",
    ],
  },
  {
    version: "7.40.3",
    date: "2026-02-11",
    title: "Calendar Grid Interaction Redesign",
    changes: [
      "New: Booked calendar slots now lift on hover with a smooth scale-up effect for better visual feedback",
      "New: Hover tooltip on booked slots shows member name, time, player count, fees owed, and status at a glance",
      "New: Empty calendar cells now display a subtle dot matrix texture instead of blank white space",
      "Improved: Tooltip adapts to light and dark themes with frosted glass styling",
    ],
  },
  {
    version: "7.40.2",
    date: "2026-02-11",
    title: "Toast Notification Redesign",
    changes: [
      "New: Redesigned toast notifications with Liquid Glass aesthetic — frosted glass strip with colored left border",
      "New: Spring-physics entrance animation slides toasts in from the top-right with a bouncy overshoot effect",
      "New: Progress bar countdown — a 1px bar at the bottom visually shrinks to show remaining auto-dismiss time",
      "New: Toast now displays a bold status title (Success, Error, Warning, Notice) above the message",
      "Improved: Toast styling adapts to light and dark themes with proper contrast",
    ],
  },
  {
    version: "7.40.1",
    date: "2026-02-11",
    title: "Training Guide Completeness Update",
    changes: [
      "New: Added POS Register training guide covering cart management, customer selection, and three payment methods",
      "New: Added Settings training guide covering club config, timezone, payment category labels, and alert toggles",
      "New: Added Discounts & Coupons training guide covering Stripe coupon creation, editing, and redemption tracking",
      "New: Added View As Member training guide explaining how staff can see the app from a member's perspective",
      "Fix: Corrected navigation icons for Facility, Directory, and Financials to match the actual sidebar",
    ],
  },
  {
    version: "7.40.0",
    date: "2026-02-11",
    title: "Training Guide Audit & Update",
    isMajor: true,
    changes: [
      "New: Added Conference Room Bookings training guide covering auto-confirmation, daily allowance, and overage prepayment",
      "New: Added Waiver Management training guide covering waiver signing, versions, and stale waiver reviews",
      "Fix: Updated Member Directory training to show correct profile drawer tabs (Overview, Billing, Activity, Notes, Communications)",
      "Fix: Updated Financials training to reflect correct Transactions sub-sections (Summary, Pending, Overdue, Failed, Refunds, Recent)",
      "Improved: Added training steps for directory sorting, billing filters, visitor source filters, and the pending booking limit rule",
      "Fix: Corrected navigation icons for Products & Pricing, Manage Team, and Data Integrity to match the actual sidebar",
      "Improved: Day pass training now mentions the POS Register as an alternative sales channel",
    ],
  },
  {
    version: "7.39.7",
    date: "2026-02-11",
    title: "Booking Confirmation Reliability Fix",
    changes: [
      "Fix: Booking requests now reliably show the success confirmation — previously a database cleanup error could cause the booking to save correctly but show an error message to the member instead of the success toast",
    ],
  },
  {
    version: "7.39.6",
    date: "2026-02-11",
    title: "Chronological Fee Ordering Fix",
    changes: [
      "Fix: When a member has multiple bookings on the same day, overage fees are now correctly assigned to the later booking — previously the earlier booking could be charged overage because the system counted the later booking's usage first, making it look like the daily allowance was already used up",
    ],
  },
  {
    version: "7.39.5",
    date: "2026-02-11",
    title: "Fee Display Accuracy Improvements",
    changes: [
      "Fix: Booking cards now show the correct total fee including empty slot guest fees — previously the card could show a lower amount than what the booking sheet displays when a booking has unfilled player slots",
      "Fix: Fee estimate no longer double-counts the booking's own usage against the daily allowance, so members within their limits no longer see incorrect overage charges",
    ],
  },
  {
    version: "7.39.4",
    date: "2026-02-11",
    title: "Fee Estimate Double-Count Fix",
    changes: [
      "Fix: Booking cards no longer show incorrect fees due — the fee estimate was counting the booking's own usage against the member's daily allowance, making it look like every booking had overage when members were actually within their limits",
    ],
  },
  {
    version: "7.39.3",
    date: "2026-02-11",
    title: "PWA Safari Polish",
    changes: [
      "Fix: Safari PWA status bar now matches the green header instead of showing a light-colored bar",
      "Fix: Eliminated white gaps at the bottom of modals and drawers on iOS PWA by replacing the scroll lock strategy — no longer forces the page position, which was conflicting with Safari's dynamic viewport",
      "Fix: All modal overlays (profile drawer, booking details, confirmations, welcome banner) now use dynamic viewport height so they correctly fill the screen on iOS devices",
    ],
  },
  {
    version: "7.39.2",
    date: "2026-02-11",
    title: "Booking Confirmation Toast",
    changes: [
      "Improvement: Members now see a clear toast notification confirming their booking request was sent — previously the only confirmation was a brief banner that could be easily missed",
    ],
  },
  {
    version: "7.39.1",
    date: "2026-02-11",
    title: "Guest Pass & Fee Estimate Fixes",
    changes: [
      "Fix: Guest passes now apply correctly for Corporate tier members — previously passes weren't being used during booking even when the guest had full name and email entered",
      "Fix: Fee estimate no longer double-charges when booking with other club members — additional members were incorrectly counted as empty guest slots, adding an extra $25 per member",
      "Fix: 'Passes remaining after booking' now shows the correct count (e.g. 14 of 15) instead of always showing 0",
      "Fix: Member emails are now passed to the fee estimate so the system knows about all players in the booking, preventing phantom empty slot charges",
      "Improvement: Guest pass eligibility check is now more resilient — if a tier has monthly guest passes allocated, they'll work even if the feature flag wasn't explicitly set",
      "Improvement: Staff queue list now shows accurate fee amounts using the same calculation members see — previously it used a simplified estimate that didn't account for guest passes or member participants",
      "Improvement: Calendar grid fee indicators (red dot with $X owed tooltip) now also use the same server-side calculation — all fee displays across the app are now unified",
    ],
  },
  {
    version: "7.39.0",
    date: "2026-02-11",
    title: "Stripe Sync + Billing Safety",
    changes: [
      "Feature: The Sync button on the Members page now syncs both HubSpot AND Stripe — if any webhooks were missed, one tap catches up all member statuses, subscriptions, and tiers",
      "Feature: Stripe sync checks each member's subscription against Stripe and fixes mismatches (status, tier, subscription link) — also finds and links subscriptions for members who have a Stripe customer but no subscription on file",
      "Fix: Billing recalculation now uses a database transaction — if something goes wrong mid-recalculation, the original billing records are preserved instead of being lost",
    ],
  },
  {
    version: "7.38.2",
    date: "2026-02-11",
    title: "Activation Link Fix + Charge Saved Card",
    changes: [
      "Fix: Members who completed payment through an activation link were stuck in 'pending' status and didn't appear in the directory — the system now automatically activates them and links their subscription when payment completes",
      "Fix: Subscription webhook now properly updates existing pending members with their subscription ID and active status, instead of only sending notifications without activating them",
      "Fix: Tier detection from subscription metadata now works for all checkout flows (activation links, staff invites, corporate) regardless of metadata key format",
      "Fix: Subscription webhook now properly links the Stripe customer ID when matching members by email, preventing future webhook lookup failures",
      "Feature: Staff can now send activation emails and copy activation links directly from a member's billing tab when their subscription is awaiting payment",
      "Feature: Collect Payment modal now offers two options — Card Reader (terminal) or Charge Saved Card — so staff can charge a member's card on file without needing the physical reader",
      "Improvement: Charge Saved Card shows the specific card that will be charged (brand, last 4 digits, expiry) before confirming",
      "Improvement: All charge-card actions are logged in the staff activity feed for audit purposes",
    ],
  },
  {
    version: "7.37.0",
    date: "2026-02-11",
    title: "Stripe Customer Cleanup & Lazy Customer Creation",
    changes: [
      "Improvement: Stripe customer cleanup tool now preserves active members — only removes non-active members and orphaned customers with zero transaction history",
      "Improvement: Cleanup preview now shows how many active members were skipped, so staff can see they're being protected",
      "Improvement: All fee-charging flows (overage fees, guest fees, prepayments, day passes) automatically create a Stripe customer if one doesn't exist yet — no manual setup needed",
      "Fix: Hard delete for unmatched bookings was failing because of an incorrect database table name — now works correctly",
    ],
  },
  {
    version: "7.36.0",
    date: "2026-02-11",
    title: "Trackman Import Fixes, Email Sender Name & Booking Deletion",
    changes: [
      "Fix: Trackman CSV imports no longer fail when a booking's updated time overlaps with another booking on the same bay — the system now skips the time change and still applies all other updates (member linking, notes, player count)",
      "Fix: Trackman imports now support sessions up to 6 hours (360 minutes) — previously only allowed up to 5 hours, causing some longer sessions to fail",
      "Fix: Trackman import error notifications now show the actual reason for failure instead of raw database query text",
      "Fix: Emails now display 'Ever Club' as the sender name instead of 'noreply'",
      "Fix: Resolved deal stage drift data integrity error for members with duplicate HubSpot deals",
      "Feature: Staff can now fully delete unmatched/unassigned Trackman bookings — the booking is completely removed from all database tables so the time slot opens back up for other members",
    ],
  },
  {
    version: "7.35.0",
    date: "2026-02-11",
    title: "Account Credits + Trackman Session Fix",
    changes: [
      "Fix: Trackman webhook bookings now correctly create sessions — previously, unmatched bookings from Trackman failed to create sessions due to an invalid source value, causing errors on every incoming webhook",
      "Improvement: Account credits now automatically apply to overage fee payments during check-in — if a member has enough credit, the overage is covered instantly without needing to enter a card",
      "Improvement: Account credits now apply to staff-initiated booking fee payments (guest fees, overage charges from the check-in flow)",
      "Improvement: Account credits now apply to booking prepayments created when a booking is approved",
      "Improvement: Account credits now apply to guest pass purchases from the member portal",
      "Improvement: Account credits now apply when members add guests to their bookings (guest fee checkout)",
      "Improvement: Account credits now apply when staff charge booking fees using a member's saved card",
      "Improvement: When credit fully covers a charge, the system skips the payment form entirely and shows a confirmation that credit was used",
      "Improvement: When credit partially covers a charge, only the remaining amount is charged to the member's card",
    ],
  },
  {
    version: "7.34.3",
    date: "2026-02-10",
    title: "Unmatched Trackman Bookings Now Visible on Calendar & Queue",
    changes: [
      "Fix: Unmatched Trackman bookings (ones without a matched member) were not appearing on the calendar table or queue list — staff couldn't see them or know which bays were occupied",
      "Fix: Trackman webhook was incorrectly storing confirmed bookings as 'pending' when session creation failed, even though the booking is real and confirmed on Trackman's side — now keeps them as 'approved' so they block availability on the calendar",
      "Fix: Updated all existing pending unmatched bookings to 'approved' status so they immediately appear on the calendar and in the queue for staff assignment",
      "Improvement: Calendar table and queue list now include a safety net to always show unmatched Trackman bookings even if a future edge case sets them to pending",
    ],
  },
  {
    version: "7.34.2",
    date: "2026-02-10",
    title: "Account Credit Consumption Fix",
    changes: [
      "CRITICAL FIX: When a member's account credit only partially covered a booking fee, the credit was never actually consumed — it stayed on the account and could be reused infinitely, giving unlimited discounts",
      "Fix: The system now charges only the remaining amount (after credit) on the member's card, and properly consumes the credit from their Stripe balance after the payment succeeds",
      "Improvement: Cleaner payment flow — members no longer see a full charge followed by a partial refund; they only see the net amount charged to their card",
      "Safety: Credit is only consumed after the card payment succeeds, so if the card is declined, the credit stays on the account",
    ],
  },
  {
    version: "7.34.1",
    date: "2026-02-10",
    title: "HubSpot Lifecycle Stage Fix",
    changes: [
      "Fix: HubSpot sync was failing for some contacts because the system tried to set lifecycle stage to 'member' which is not a valid HubSpot stage — now correctly uses 'customer' for active members and 'other' for inactive members",
      "Fix: Applied across all HubSpot sync paths (contact creation, member sync, and stage updates) so no contacts are missed",
    ],
  },
  {
    version: "7.34.0",
    date: "2026-02-10",
    title: "Payment Status Enforcement & Pending Badge System",
    isMajor: false,
    changes: [
      "CRITICAL FIX: Members are now correctly set to 'pending' status until their Stripe subscription payment actually succeeds — previously members were activated before payment completed, creating a critical billing gap",
      "Feature: Added 'Pending' badge that appears next to the tier badge (e.g., 'Premium' + 'Pending') in both the member profile drawer and the directory — staff can now clearly see when payment hasn't been completed yet",
      "Fix: Stripe webhook now properly maps all subscription statuses — incomplete subscriptions no longer trigger member activation",
      "Data Correction: Corrected 3 test members' status back to pending after recent billing changes",
    ],
  },
  {
    version: "7.33.3",
    date: "2026-02-10",
    title: "Activation Link Endpoint Fix",
    changes: [
      "Fix: Activation link endpoint now properly handles existing members — previously always failed with 'member already exists' error",
      "Improvement: If the member is fully active with a subscription, the endpoint gives a clear message that no link is needed",
      "Improvement: If the member exists but hasn't completed subscription setup (cancelled, terminated, etc.), the link can now be resent",
      "Improvement: Staff can now easily resend activation links when needed without hitting 'member already exists' errors",
    ],
  },
  {
    version: "7.33.2",
    date: "2026-02-10",
    title: "Trial Onboarding Email Flow",
    changes: [
      "Feature: First-visit confirmation email sent automatically when a trial member checks in via QR code for the first time",
      "Feature: Email includes step-by-step guide on how to use the app — booking golf simulators, browsing events, and exploring wellness services",
      "Fix: Paused members are now correctly blocked from logging in (account preserved for future renewal)",
      "Fix: Trialing members now correctly recognized in fee calculations and tier lookups — previously a typo ('trial' vs 'trialing') caused their membership tier to be ignored",
      "Fix: Trackman billing reconciliation now correctly identifies trialing members as active",
    ],
  },
  {
    version: "7.33.1",
    date: "2026-02-10",
    title: "Terminal Card Saving Gap Coverage",
    changes: [
      "Fix: Card now saves correctly even when membership is activated by a background process before staff confirms — previously the card save was skipped entirely in this scenario",
      "Fix: Subscription payment pending amount now correctly reflects any coupon or discount applied (was showing full price before)",
      "Fix: Receipt emails now included for terminal subscription payments collected from the billing tab",
      "Fix: Corrected internal data type for member ID in billing tab to prevent potential lookup mismatches",
    ],
  },
  {
    version: "7.33.0",
    date: "2026-02-10",
    title: "Terminal Card Saving & Billing Improvements",
    isMajor: true,
    changes: [
      "Feature: Terminal card payments now automatically save the card for future subscription renewals — no extra steps needed from the member",
      "Feature: 'Collect Payment' button in member billing tab for pending members with incomplete subscriptions — staff can complete activation via card reader",
      "Feature: Billing tab now shows 'Subscription payment pending' with amount due instead of misleading 'No outstanding fees' for incomplete subscriptions",
      "Feature: 'No card on file for renewals' warning in billing tab when active subscription has no saved payment method",
      "Fix: ID scan images now save correctly after terminal and inline card payments during signup",
      "Fix: Removed duplicate ID image save that fired twice during signup flows",
    ],
  },
  {
    version: "7.32.2",
    date: "2026-02-10",
    title: "HubSpot Form Submissions Sync",
    changes: [
      "Feature: Added automatic sync of HubSpot form submissions — inquiries submitted on the production app now appear in all environments",
      "Feature: Sync runs every 30 minutes and can also be triggered manually from the admin tools",
    ],
  },
  {
    version: "7.32.1",
    date: "2026-02-10",
    title: "Private Hire Page Updates",
    changes: [
      "Improvement: Updated venue capacities — Main Hall now shows 600 max, Private Dining Room shows 30 seated",
      "Improvement: Removed firepit and outdoor heating references from Terrace listing",
      "Feature: Added comprehensive services section to Private Hire page — Flexible Floorplans, Golf Facilities, Custom Décor, Live Music, Food & Beverage Programs, Advanced AV, and Parking details",
    ],
  },
  {
    version: "7.32.0",
    date: "2026-02-10",
    title: "Visitor Directory Cleanup & Archive System",
    isMajor: true,
    changes: [
      "Feature: Archived 2,308 non-transacting contacts (no Stripe customer or MindBody history) to declutter the visitors directory — down from ~2,800 contacts to ~470 active contacts with real transaction history",
      "Feature: Active/Archived toggle on visitors tab — staff can switch between viewing current active contacts and the archived list at any time",
      "Improvement: HubSpot sync now skips creating new local user records for contacts that have no membership status, no Stripe customer, and no MindBody client ID — prevents re-importing non-transacting contacts",
      "Improvement: Auto-unarchive — when an archived contact makes a purchase (day pass, terminal payment, etc.) and gets a Stripe customer record, they are automatically restored to the active directory",
      "Safety: Day pass purchases and visitor matching now correctly find and unarchive archived users instead of creating duplicates",
      "Safety: Creating a new membership for an archived contact now unarchives and reuses the existing record instead of blocking with 'already exists' error",
      "Safety: Subscription creation rollback safely re-archives reused records instead of deleting them",
      "Safety: Trackman import matching still searches all users including archived — historical booking data links are preserved",
      "Safety: 11 contacts with booking participation records were preserved even though they lacked Stripe/MindBody IDs",
    ],
  },
  {
    version: "7.31.8",
    date: "2026-02-10",
    title: "Trackman Import Matching & Unresolved Table Improvements",
    changes: [
      "Fix: Trackman CSV import now matches bookings to non-members and visitors from the local database — previously only HubSpot contacts were checked, so users with valid trackman_email mappings who weren't in HubSpot would fail to match",
      "Improvement: Unresolved Trackman bookings table now shows Booking ID column instead of redundant Status column — all rows are unmatched by definition, so the Trackman booking ID is more useful for reference",
    ],
  },
  {
    version: "7.31.7",
    date: "2026-02-10",
    title: "Outstanding Balance & Payment Receipt Details",
    changes: [
      "Feature: Staff can now see a member's outstanding balance in the Billing tab of the member profile drawer — shows total owed and itemized unpaid fees (date, time, bay, fee type, amount) without needing 'View As'",
      "Improvement: Stripe payment receipts now show per-participant fee breakdown — e.g. 'Guest: John Doe — $25.00, Overage — $25.00' instead of generic 'Booking Fees'",
      "Improvement: Staff-initiated saved-card charges also include per-participant breakdown in Stripe description and metadata",
      "Fix: Three remaining hardcoded $25 guest fee values now use dynamic pricing from Stripe (Trackman admin pending slots, overdue-payments endpoint)",
    ],
  },
  {
    version: "7.31.6",
    date: "2026-02-10",
    title: "Billing Audit — Dynamic Pricing & Hardcoded Fee Fixes",
    changes: [
      "Fix: Trackman admin pending-assignment slot fee now uses the real guest fee from Stripe instead of a hardcoded $25 — prevents drift if pricing changes",
      "Improvement: Staff simulator fee estimates now pull tier-specific daily minutes from the database instead of hardcoded values — tier limits (VIP, Premium, Corporate, Core, Base, Social) are fully dynamic",
      "Improvement: Pricing API now exposes tier included minutes alongside guest fee and overage rate — all three pricing dimensions sourced from database",
      "Safety: Frontend fee estimator retains hardcoded fallbacks if pricing API is unavailable — no regression on network failure",
    ],
  },
  {
    version: "7.31.5",
    date: "2026-02-10",
    title: "Booking Fee Display & Email Sender Fixes",
    changes: [
      "Fix: Booking card fee button now includes guest fees for unfilled player slots — previously only showed the owner's overage fee from the database, ignoring estimated fees for empty slots",
      "Fix: Calendar grid fee display also updated to include unfilled slot fees",
      "Improvement: All outgoing emails now consistently show 'Ever Club' as the sender name instead of 'noreply' or inconsistent variations",
    ],
  },
  {
    version: "7.31.4",
    date: "2026-02-10",
    title: "POS Receipt Line Items",
    changes: [
      "Improvement: POS purchases now show individual line items on Stripe receipts and dashboard — instead of a single lump sum with concatenated description",
      "Improvement: All three POS payment methods (card reader, online card, saved card) now create Stripe Invoices with itemized products",
      "Improvement: Stripe receipts now include per-item name, quantity, and price for cafe/POS purchases",
      "Safety: Invoice items are isolated per transaction — failed transactions cannot leak items into future charges",
      "Safety: Failed invoice creation automatically cleans up draft invoices before falling back to standard payment",
    ],
  },
  {
    version: "7.31.3",
    date: "2026-02-10",
    title: "Fee Display Fix & Code Cleanup",
    changes: [
      "Fix: My Balance card now includes expected guest fees for unfilled player slots — previously only showed owner's overage fee",
      "Fix: Booking card fee button now shows correct total ($125 instead of $75) — was ignoring database-computed fees when player slots were unfilled",
      "Fix: Fee estimate calculation no longer splits booking duration across players — owner uses full duration for overage (matches real billing engine)",
      "Improvement: Member 'Add Guest' form now uses separate First Name and Last Name fields (matching staff-side UX from v7.31.1)",
      "Cleanup: Removed 6 orphaned component files no longer used anywhere (~1,526 lines of dead code)",
      "Cleanup: Consolidated duplicate PlayerSlot type — single source of truth in shared PlayerSlotEditor, re-exported by bookGolfTypes",
      "Cleanup: Removed 9 unused imports across 5 files (unused React hooks, utility functions, type imports, components)",
      "Cleanup: Removed unused exported functions from shared utilities (closureUtils, statusColors) — kept only actively used exports",
      "Cleanup: Removed unused TrackmanNotesModal — manual bookings and pending requests already generate Trackman notes",
      "Fix: Corrected pre-existing SQL join error in Trackman needs-players endpoint (wrong column name)",
    ],
  },
  {
    version: "7.31.1",
    date: "2026-02-10",
    title: "Guest Booking UX Improvements",
    changes: [
      "Improvement: Split single 'Guest name' field into separate 'First name' and 'Last name' fields — guest passes now collect proper names for identification",
      "Fix: Fee estimate no longer shows confusing '0 of 15' passes remaining when guest details haven't been entered — now shows helpful 'Enter guest details above to use passes' message",
      "Improvement: Guest pass eligibility now requires first name, last name, AND email — per-slot indicator updated to show exactly what's needed",
      "Improvement: Info banner updated to clearly state 'first name, last name, and email' requirement for guest pass usage",
    ],
  },
  {
    version: "7.31.0",
    date: "2026-02-10",
    title: "Major Code Organization Refactoring",
    isMajor: true,
    changes: [
      "Improvement: Split 6 large files (2,000-3,500 lines each) into modular subdirectories — EventsTab (94% smaller), NewUserDrawer (85% smaller), MemberProfileDrawer (29% smaller), BookGolf (23% smaller), SimulatorTab (50% smaller), DataIntegrityTab (45% smaller)",
      "New: Shared FeeBreakdownCard component — reusable fee display for both member and staff booking interfaces, showing overage, guest fees, and pass usage in one consistent layout",
      "New: Shared PlayerSlotEditor component — unified player/guest management with per-slot member search (privacy-safe redacted emails for members), guest name + email fields, clear guest pass eligibility messaging, and per-slot status indicators (green 'Pass eligible' vs amber 'Guest fee applies')",
      "Improvement: Consolidated duplicate status badge functions across 3 billing files into shared statusColors utility with new getSubscriptionStatusBadge, getInvoiceStatusBadge, and getBillingStatusBadge functions",
      "Improvement: Extracted shared closure display utilities (getNoticeTypeLabel, formatAffectedAreas, isBlockingClosure) — replaced duplicate logic in 3 files (Updates page, ClosureAlert, ResourcesSection)",
      "Improvement: No visual or behavioral changes — all refactoring is internal code organization for better maintainability",
    ],
  },
  {
    version: "7.30.2",
    date: "2026-02-10",
    title: "Timezone & Reliability Fixes",
    changes: [
      "Fix: Future bookings query now uses Pacific time instead of server time — no more wrong bookings showing near midnight",
      "Fix: User merge safety check now uses Pacific time — correctly detects active sessions regardless of server timezone",
      "Fix: Removed dead duplicate billing portal route that could cause confusion during maintenance",
      "Fix: Trackman auto-session failure notes now log a warning if the note itself can't be saved, so staff isn't left in the dark",
      "Fix: Payment confirmation now gracefully handles corrupted fee data instead of crashing mid-transaction",
    ],
  },
  {
    version: "7.30.1",
    date: "2026-02-10",
    title: "Bug Fixes & Performance",
    changes: [
      "Fix: Closure sync no longer re-processes ~60 already-deactivated closures every cycle — only checks active ones, reducing unnecessary database work",
      "Fix: HubSpot products page now shows a clear 'missing permissions' message instead of crashing when the API key doesn't have the right access",
      "Fix: Viewing a member profile who doesn't have a billing subscription no longer triggers false alarm warnings in the logs",
    ],
  },
  {
    version: "7.30.0",
    date: "2026-02-10",
    title: "Calendar Sync Improvements",
    changes: [
      "Fix: Events created in the production app and synced to Google Calendar no longer show up as drafts/needs review in dev — the sync now recognizes app-created events and trusts they were already reviewed",
      "Fix: Deleted or cancelled Google Calendar events are now properly removed from the database during sync (previously, cancelled events could linger)",
      "Improvement: Events synced from Google Calendar now default to the club address (15771 Red Hill Ave, Ste 500, Tustin, CA 92780) when no location is set, so staff don't have to enter it manually every time",
      "Improvement: When an event has a bracket prefix like [Social] in its Google Calendar title, the category tag is now included in the description for better visibility",
      "Fix: Session creation failure messages no longer dump raw database errors into Staff Notes — replaced with short, readable notes",
    ],
  },
  {
    version: "7.29.0",
    date: "2026-02-10",
    title: "Unified Booking Sheet & Fee Button Fix",
    changes: [
      "Fix: The '$X Due' fee button on booking cards now opens the Unified Booking Sheet instead of the old separate billing sheet — one consistent experience for managing bookings and payments",
      "Fix: Fee button now shows the full estimated total (owner overage + guest fees) instead of just the owner's cached fee, matching what the Unified Booking Sheet shows",
      "Fix: Check-in payment flow now opens the Unified Booking Sheet when payment is required, instead of the old billing modal",
      "Fix: 'Mark Paid (Cash/External)' button now works inline within the Unified Booking Sheet instead of opening a separate modal",
      "Fix: Overdue Payments now opens the Unified Booking Sheet instead of the old billing modal — consistent across Transactions tab and Staff Command Center",
      "Fix: Overdue payment amounts now include estimated guest fees for unfilled roster slots, matching the Unified Booking Sheet total",
      "Improvement: Overdue Payments section moved to the top of the right column on desktop Transactions tab — immediately visible without scrolling",
      "Improvement: Transactions tab now shows a red badge with the overdue payment count so staff can see at a glance if there are unpaid fees",
      "Layout: Pending Authorizations and Future Bookings moved to left column; Overdue Payments, Failed Payments, and Refunds grouped in right column",
    ],
  },
  {
    version: "7.28.0",
    date: "2026-02-10",
    title: "Data Integrity Fix Actions",
    changes: [
      "Feature: HubSpot duplicate contacts now have 'Unlink' buttons — choose which user to disconnect from a shared HubSpot contact when they're genuinely different people",
      "Feature: Orphaned guest passes (test/example.com records) can now be deleted directly from the Data Integrity page",
      "Feature: Orphaned fee snapshots referencing deleted bookings can now be cleaned up with one click",
      "Feature: Orphaned booking participants with no valid session can now be removed directly",
      "Fix: Data integrity checks no longer crash — corrected column name in session participant check",
      "Fix: Stripe Customer Cleanup tool now visible in the Data Tools section instead of buried in a check category",
    ],
  },
  {
    version: "7.27.0",
    date: "2026-02-10",
    title: "Stripe Customer Cleanup & Prevention",
    isMajor: true,
    changes: [
      "Feature: New admin tool to scan and delete Stripe customers with zero transactions — preview before deleting to review the full list",
      "Prevention: Day pass checkout no longer creates a Stripe customer before payment — customers are only created when payment actually completes",
      "Prevention: Visitor creation no longer auto-creates Stripe customers — only happens when a visitor makes a real purchase",
      "Prevention: Bulk sync, CSV import, and visitor matching no longer create premature Stripe customers",
      "Improvement: Existing Stripe customers now get their metadata updated (name, tier, firstName, lastName) when accessed",
      "Improvement: All metadata sync functions now include firstName and lastName fields",
    ],
  },
  {
    version: "7.26.1",
    date: "2026-02-10",
    title: "Session Backfill & Roster Reliability",
    changes: [
      "Fix: Session backfill now uses overlap detection to find existing sessions with different Trackman IDs but overlapping time ranges — prevents 'No bookings could be resolved' errors",
      "Fix: Backfill endpoint properly handles session creation failures — rolls back savepoint instead of attempting release on error state",
      "Fix: Transaction-aware retry logic — when called within a transaction, session creation throws immediately instead of retrying on an aborted PostgreSQL transaction",
    ],
  },
  {
    version: "7.26.0",
    date: "2026-02-10",
    title: "Silent Failure Audit & Data Safety Net",
    isMajor: true,
    changes: [
      "Feature: New 'safeDbOperation' wrapper for critical database writes — automatically logs failures and alerts staff, preventing silent errors",
      "Feature: New 'safeDbTransaction' wrapper — provides automatic transaction management with rollback on failure and staff notifications",
      "Fix: Eliminated all 7 empty catch blocks across billing webhooks, bookings, manual bookings, member sync, and bay helpers — errors are now always logged",
      "Integrity: Added 4 new nightly data integrity checks — orphaned fee snapshots, sessions without participants, orphaned payment intents, and guest passes for non-existent members",
      "Safety: Wrapped 3 critical member management endpoints (tier change, suspend, and archive) in database transactions to prevent half-finished data",
      "Prevention: All critical database operations now use proper error handling — no error can go unnoticed",
    ],
  },
  {
    version: "7.25.1",
    date: "2026-02-10",
    title: "Booking Spam Prevention",
    changes: [
      "Feature: Members are now limited to one pending booking request at a time — additional requests are blocked until the first is approved or denied",
      "Queue Management: Prevents members from stacking multiple pending requests and holding too many potential slots",
      "Staff Exemption: Staff and admin users can still create multiple bookings as needed for manual scheduling",
    ],
  },
  {
    version: "7.25.0",
    date: "2026-02-10",
    title: "Staff = VIP Rule — Automatic Tier Enforcement",
    isMajor: true,
    changes: [
      "Feature: All staff, admin, and golf instructor users are now automatically treated as VIP members — no manual tier assignment needed",
      "Auth Enforcement: Every login path (OTP, Google sign-in, verification) now sets staff tier to VIP and membership status to active automatically",
      "Database Sync: Staff user records are auto-corrected to VIP tier and active status on every login, ensuring data never drifts",
      "Booking Safety Net: Fee calculation now checks the staff directory before computing fees — staff always get $0 with 'Staff — included' note",
      "Inactive Warning: Staff booking owners no longer show the 'Inactive Member' warning banner",
      "Tier Dropdown Cleanup: Removed 'Founding' and 'Unlimited' from the membership tier dropdown since they're not valid tiers",
    ],
  },
  {
    version: "7.24.2",
    date: "2026-02-10",
    title: "Revenue Protection — Inactive Owner Fee Enforcement",
    changes: [
      "CRITICAL FIX: Non-member and inactive booking owners were getting free bookings ($0) because the system checked 'is owner' before checking membership status — now status is checked FIRST",
      "Revenue Protection: Inactive/non-member owners are now charged the full session fee with no membership benefits — e.g., $50 for a 60-minute session instead of $0",
      "Logic Reorder: New order of operations — (1) check membership status, (2) if active apply tier benefits, (3) if inactive charge full overage rate regardless of role",
      "Coverage: Fix applies to all 3 fee paths — session-based, non-session with guest passes, and non-session without guest passes",
      "Active members with no tier assigned now also get charged (previously $0 due to missing else clause)",
    ],
  },
  {
    version: "7.24.1",
    date: "2026-02-10",
    title: "Inactive Member Handling & Dead Code Cleanup",
    changes: [
      "Feature: Inactive/suspended members now show a red uppercase status badge (e.g., SUSPENDED, CANCELLED) instead of their tier name in the booking roster",
      "Feature: Inactive member fees are automatically redirected to the booking owner (host) since inactive members cannot log in to pay — fee notes explain the charge transfer",
      "Feature: Backend roster API now includes membership_status for each player, enabling proper status-aware UI rendering across all booking views",
      "Cleanup: Removed dead useOptimisticBookings.ts file (209 lines, not imported anywhere in the app)",
      "Fix: Restored forward optimistic bay-status update in StaffCommandCenter check-in flow for immediate UI feedback",
    ],
  },
  {
    version: "7.24.0",
    date: "2026-02-10",
    title: "Single Source of Truth — Unified Booking Actions",
    isMajor: true,
    changes: [
      "Architecture: Created useBookingActions hook — a single source of truth for check-in, card charging, and staff cancel actions across the entire app",
      "Refactor: Consolidated 9 separate check-in implementations into one shared function with consistent 402 payment-required handling, billing sync retry logic, and error messaging",
      "Refactor: Consolidated 2 separate charge-saved-card implementations into one shared function with consistent card-declined, no-card, and verification-required handling",
      "Refactor: StaffCommandCenter now uses useBookingActions for check-in — local optimistic UI updates preserved, API logic delegated",
      "Refactor: SimulatorTab now uses useBookingActions for both its main check-in flow and the booking sheet's check-in callback — removed duplicate retry logic",
      "Refactor: CompleteRosterModal, MemberProfileDrawer, and CheckinBillingModal all now use useBookingActions instead of inline fetch calls",
      "Refactor: useUnifiedBookingLogic now delegates check-in and charge-card calls to useBookingActions instead of raw fetch",
      "Cleanup: Removed unused useUpdateBookingStatus and useCancelBookingWithOptimistic imports from SimulatorTab",
      "Cleanup: Identified useOptimisticBookings.ts as dead code (not imported anywhere in the app)",
      "Impact: Business rule changes (e.g. 'Staff are free', 'Skip billing for certain tiers') now only need to be updated in one place and automatically apply to Dashboard, Calendar, Mobile, and all modals",
    ],
  },
  {
    version: "7.23.0",
    date: "2026-02-10",
    title: "Deep Logic Extraction — Booking Sheet Under 400 Lines",
    isMajor: true,
    changes: [
      "Refactor: Created useUnifiedBookingLogic custom hook (1,312 lines) — ALL state management, data fetching, and handler functions moved out of the booking sheet component",
      "Refactor: Created AssignModeSlots component — player slot rendering, member search, visitor creation, and guest placeholder UI extracted into its own module",
      "Refactor: Created ManageModeRoster component — manage mode slot rendering with member linking, guest forms, and member match resolution extracted",
      "Refactor: Created AssignModeFooter component — fee estimation display, event marking with notice selection, and staff assignment list extracted",
      "Achievement: UnifiedBookingSheet.tsx reduced from 2,245 lines to 371 lines (83% reduction) — now a pure view layer that calls one hook and assembles sub-components",
      "Architecture: Booking sheet now follows hooks + view pattern — all business logic lives in the hook, all rendering is handled by focused sub-components",
    ],
  },
  {
    version: "7.22.0",
    date: "2026-02-10",
    title: "Codebase Cleanup & Booking Sheet Modularization",
    isMajor: true,
    changes: [
      "Cleanup: Removed deprecated ManagePlayersModal, BookingDetailsModal, and TrackmanLinkModal components — all booking interactions now route exclusively through the unified booking sheet",
      "Cleanup: Removed all references to the old long-form Trackman UUID (trackman_external_id) from the staff interface — staff now only sees the short booking number",
      "Cleanup: Renamed misleading 'trackmanLinkModal' state variables to 'bookingSheet' across SimulatorTab, DataIntegrityTab, StaffCommandCenter, and TrackmanTab for code clarity",
      "Refactor: Broke down the 2,790-line booking sheet into focused sub-components — SheetHeader (booking info), PaymentSection (financial summary and payment collection), and BookingActions (check-in, reschedule, cancel)",
      "Refactor: Shared type definitions moved to a dedicated types module, reducing duplication across components",
      "Reliability: Payment and roster sections are now wrapped in error boundaries — if a Stripe glitch occurs, it won't crash the entire booking sheet; staff can close and reopen to recover",
    ],
  },
  {
    version: "7.21.0",
    date: "2026-02-10",
    title: "Stripe Clarity & Trackman Import Intelligence",
    isMajor: true,
    changes: [
      "Feature: Stripe Dashboard now shows the booking number in every charge description (e.g. '#19607382 - Simulator Bay 2') so you can instantly see which booking a payment belongs to without clicking into metadata",
      "Feature: Overage payment intents are now reused — if an overage charge already exists for a booking, the system returns the same payment link instead of creating a duplicate 'Incomplete' charge",
      "Feature: Overage payment intents are now automatically cancelled when staff closes or backs out of the payment flow, preventing orphaned 'Incomplete' charges in Stripe",
      "Feature: Trackman webhook matching now also searches by the short booking number, making automatic linking more reliable",
      "Feature: CSV import now detects existing ghost bookings by their Trackman booking number and updates them in place instead of creating duplicates",
      "Improvement: Conference room and ad-hoc bookings (without a standard booking ID) now skip the duplicate payment check and are tagged with 'conference_booking' metadata in Stripe for easy identification",
      "Improvement: Member-facing payment descriptions now show the booking number prefix for guest fees, overage fees, and combined charges",
    ],
  },
  {
    version: "7.20.4",
    date: "2026-02-10",
    title: "Terminal Payment Reconciliation & Trackman Import Fix",
    changes: [
      "Fix: Terminal card reader payments now correctly mark all participants as 'paid' — previously Stripe showed 'Succeeded' but the booking still displayed 'Collect $25' because the payment status wasn't synced back",
      "Fix: Trackman-imported bookings (like Mark Mikami's) no longer show an infinite loading spinner when opening payment options — the system now finds the member's account even when the import didn't link the user ID",
      "Fix: Pay with Card form now loads for Trackman-imported members who have an email on file but were missing an internal user link",
      "Fix: Orphaned payment intents no longer pile up in Stripe — if staff opens 'Pay with Card' but then cancels or switches to a different payment method (like card reader), the original payment intent is now automatically cancelled instead of being left as 'Incomplete'",
      "Fix: Guest fees no longer appear for fully-assigned bookings — when all player slots are filled with members, the system correctly shows $0 instead of charging for orphaned extra slots that were left over from player count changes",
      "Improvement: Payment processing now resolves member identity by email when user ID isn't available, preventing payment failures for imported bookings",
    ],
  },
  {
    version: "7.20.3",
    date: "2026-02-10",
    title: "Card Terminal Reader & Payment Reliability",
    changes: [
      "Feature: Card terminal reader option is back in the booking sheet — staff can now tap 'Card Reader' to process payments using the physical Stripe terminal, right alongside online card payment and cash options",
      "Fix: 'Missing required fields' error when clicking 'Pay with Card' is resolved — the payment form now waits for member data to fully load before creating the payment session, with a clear message if data can't be found",
      "Fix: Stale Stripe customer IDs (from test environments) are now auto-cleared across all lookup paths — linked email and HubSpot matches are validated against Stripe before use",
      "Improvement: Payment options now show a loading state while member info loads, preventing premature payment attempts with incomplete data",
    ],
  },
  {
    version: "7.20.2",
    date: "2026-02-10",
    title: "Booking Sheet Reliability & Stale Stripe Customer Fix",
    changes: [
      "Fix: Opening a booking via the '1/4 Players' button now fully loads all booking details (owner, bay, time) even when limited info is passed — payment, check-in, and card-on-file features all work correctly",
      "Fix: Charge Card on File and Pay with Card buttons now find the correct member email through multiple fallback sources, preventing 'missing required fields' errors",
      "Fix: Stale Stripe customer IDs (from test environments) are now detected and auto-cleared when creating payment intents — instead of crashing, the system creates a fresh Stripe customer and proceeds normally",
      "Fix: Saved card check now triggers correctly when booking context is loaded asynchronously, so staff see the 'Charge Card on File' option without needing to reopen the sheet",
    ],
  },
  {
    version: "7.20.1",
    date: "2026-02-10",
    title: "Critical Bug Fixes & Stability Improvements",
    changes: [
      "Fix: Resolved crash on Bookings, Data Integrity, and Dashboard pages caused by a function ordering error in the booking sheet component",
      "Fix: Fee estimate calculations no longer fail when opening a booking — now defaults to today's date (Pacific) when a date isn't provided",
      "Fix: Stripe 'customer not found' errors for stale test accounts are now handled gracefully instead of filling server logs with noisy stack traces",
      "Fix: Added missing 'Needs Players' API endpoint for the Trackman tab — shows bookings that still need player assignments",
      "Improvement: Added automatic error reporting — page crashes now send details to the server for faster diagnosis",
    ],
  },
  {
    version: "7.20.0",
    date: "2026-02-10",
    title: "Trackman Booking ID Standardization & Payment Safety",
    isMajor: true,
    changes: [
      "Major: Staff now paste the short Trackman Booking ID (the number you see in the portal, like 19510379) instead of the long UUID — simpler, faster, less error-prone",
      "Feature: 'Book on Trackman' modal and 'Manual Booking' flow both updated with new labels, shorter ID placeholder, and relaxed validation for the numeric format",
      "Feature: Stripe payment idempotency — if a payment session already exists for a booking, the system reuses it instead of creating a duplicate charge",
      "Feature: Saved card charges now check for already-collected payments to prevent accidental double-charges",
      "Feature: Conference room prepayments detect existing payments and return them instead of creating duplicates, with 'conference_booking' metadata for tracking",
      "Improvement: CSV import backfill already matches webhook-created bookings by Trackman Booking ID and fills in member data without creating duplicates or touching payment links",
    ],
  },
  {
    version: "7.19.0",
    date: "2026-02-10",
    title: "Inline Payment Flow & Smart Notes Deduplication",
    isMajor: true,
    changes: [
      "Major: Payment collection now happens directly inside the booking sheet — no more separate billing popup with inconsistent fee amounts",
      "Feature: Four payment options available inline — Charge Card on File, Pay with Card (Stripe), Mark Paid (Cash/External), and Waive All Fees with reason",
      "Feature: After successful payment, a green confirmation message appears inline and the Check In button becomes enabled — all without closing the sheet",
      "Feature: Smart notes deduplication — when Booking Notes and Trackman Notes contain the same text (or one contains the other), only one block is shown to avoid wasted space",
      "Improvement: Payment amounts in the booking sheet are always consistent — the Collect button uses the exact total calculated from the roster's financial summary",
    ],
  },
  {
    version: "7.18.3",
    date: "2026-02-10",
    title: "Complete Notes Display, Inactive Member Warning & Payment-Gated Check-In",
    changes: [
      "Feature: All three types of booking notes now display in the booking sheet — amber for the member's request notes, blue for Trackman customer notes (imported from CSV), and purple for internal staff notes",
      "Feature: Trackman customer notes are now included in both assign mode and manage mode, so staff can see imported notes when matching unmatched bookings",
      "Feature: Inactive member warning — a red banner appears at the top of the booking sheet when the booking owner's membership is not active",
      "Feature: Check In button is disabled until all fees are collected — a clear message explains that payment must be processed first",
      "Improvement: Check In, Reschedule, and Cancel buttons now appear below the Financial Summary and Collect button, so the payment flow comes first naturally",
    ],
  },
  {
    version: "7.18.0",
    date: "2026-02-10",
    title: "Complete Booking Sheet — One Place for Everything",
    isMajor: true,
    changes: [
      "Major: The Unified Booking Sheet is now the ONLY place for all booking operations — the old 'Booking Details' popup has been completely removed",
      "Feature: Booking context header — date, time, bay, duration, Trackman ID, and status badge are shown prominently at the top of every booking",
      "Feature: Action buttons — Check In, Reschedule, and Cancel Booking are now built into the booking sheet, with smart visibility based on booking status",
      "Fix: Player count sync — changing player count from 4 to 2 now immediately hides slots 3 & 4 from the UI instead of leaving them visible",
      "Cleanup: Deleted the old TrackmanLinkModal.tsx and the 520-line Booking Details modal block — zero dead code remaining",
      "Cleanup: Removed 5 dead state variables (selectedCalendarBooking, editingTrackmanId, trackmanIdDraft, savingTrackmanId, isCancellingFromModal)",
    ],
  },
  {
    version: "7.17.0",
    date: "2026-02-10",
    title: "Unified Booking Sheet & Staff Fee Exemption",
    isMajor: true,
    changes: [
      "Major: Replaced the old Trackman Link Modal with a brand-new Unified Booking Sheet that handles all booking operations — assigning members, managing rosters, and reviewing fees — in one place",
      "Feature: Staff members are now fully exempt from all fees (overage, guest, and session fees) with a clear 'Staff — included' label shown in blue",
      "Feature: Staff users display a blue 'Staff' badge instead of the default tier badge throughout booking management",
      "Feature: Booking type detection — conference room bookings automatically hide Trackman, roster, and financial sections; lesson and staff block bookings show only the owner slot",
      "Feature: Dual-mode operation — 'assign' mode for linking members to bookings and 'manage' mode for editing rosters and reviewing financials",
      "Improvement: All four entry points (Simulator tab, Trackman tab, Staff Command Center, Data Integrity) now use the unified component for consistent behavior everywhere",
      "Improvement: Tapping a booking on the calendar grid now opens the Unified Booking Sheet directly — no more intermediate 'Booking Details' popup to click through",
      "Fix: Financial summary was showing fees at 1/100th their actual value — now displays correct dollar amounts",
    ],
  },
  {
    version: "7.16.1",
    date: "2026-02-10",
    title: "Financial Summary Fee Display Fix",
    changes: [
      "Fix: Financial summary in the Manage Players modal was showing fees at 1/100th their actual value (e.g., $0.75 instead of $75.00) — fees now display correctly in dollars",
      "Fix: Per-player fee display in roster slots also corrected to show proper dollar amounts",
    ],
  },
  {
    version: "7.16.0",
    date: "2026-02-10",
    title: "Unified Player Management Modal",
    isMajor: true,
    changes: [
      "Major: All player and roster management is now handled by a single unified modal instead of three separate ones — no more confusion about which modal to use",
      "Feature: 'Manage Players' button in booking details opens the unified modal with the current roster pre-loaded, showing all assigned members, guests, fees, and guest passes",
      "Feature: Player count can be edited directly from the modal (1-4 players) with real-time roster updates",
      "Feature: Financial summary section shows owner overage, guest fees, guest pass usage, and total amount due — with a 'Collect Payment' button when there's an unpaid balance",
      "Feature: Guest pass tracking shows remaining passes and which guests used them (green badge for free passes)",
      "Feature: New Guest form with member match detection — if a guest's email matches an existing member, staff gets a warning with option to add as member instead",
      "Feature: Optimistic unlink/remove with rollback on failure for instant-feeling slot management",
      "Improvement: Unified modal works from all entry points: booking detail drawer, calendar grid 'Players' button, check-in error handler, Trackman tab, and Staff Command Center",
      "Cleanup: Deprecated BookingMembersEditor and CompleteRosterModal — all call sites now route through the unified modal",
    ],
  },
  {
    version: "7.15.4",
    date: "2026-02-10",
    title: "Unified Player Count Editing",
    changes: [
      "Improvement: Player count in booking details now scrolls to the roster editor below instead of having its own separate dropdown — one place to manage players instead of two",
      "Improvement: Roster editor now always shows the player count with an edit button, so staff can change it directly from the players list in both the booking details modal and the check-in flow",
      "Cleanup: Removed duplicate player count editing state from the booking details modal",
    ],
  },
  {
    version: "7.15.3",
    date: "2026-02-09",
    title: "Guest Pass Badge Display Fix",
    changes: [
      "Fix: Guest roster slots no longer show the green 'Guest Pass Used' badge when the guest actually has a $25 fee — the badge now only appears when a pass was truly applied and the fee is $0",
      "Fix: When a billing session exists, guest fee data from the session now properly overrides speculative calculations, preventing stale 'Guest Pass Used' labels on guests who were charged",
      "Fix: Financial Summary and individual guest slot displays are now always in sync — no more showing $0 per guest while the summary correctly shows $75 total",
    ],
  },
  {
    version: "7.15.2",
    date: "2026-02-09",
    title: "Unmatched Booking Resolution & Import Completeness",
    changes: [
      "Fix: Imports now match members via M: tag emails in notes when the CSV email field is empty — previously these bookings stayed as 'Unknown (Trackman)' even when member info existed in notes",
      "Fix: Bookings from Trackman webhooks now get their name updated from CSV data even when no member email match is found, replacing 'Unknown (Trackman)' with the actual name",
      "Fix: Guest name slots are now populated in all import paths (linked bookings and time-tolerance matches), not just new and updated bookings",
      "Fix: Guest emails no longer incorrectly placed in member slots during imports, preventing double-counting of players and incorrect fee calculations",
      "Improvement: Added database constraint to prevent duplicate guest entries on re-imports",
    ],
  },
  {
    version: "7.15.1",
    date: "2026-02-09",
    title: "Booking Roster Population Fix",
    changes: [
      "Fix: Imported bookings now correctly show all players in the roster instead of showing 0 players",
      "Fix: Guest names from inline tags (e.g., 'G: Chris G: Alex G: Dalton') are now properly parsed and added to the roster",
      "Fix: Guest name parsing no longer accidentally captures text from the next guest tag when multiple guests are listed on one line",
      "Improvement: Diagnostic logging added to track participant creation during imports for easier troubleshooting",
    ],
  },
  {
    version: "7.15.0",
    date: "2026-02-09",
    title: "Trackman CSV Import Accuracy Overhaul",
    isMajor: true,
    changes: [
      "New: CSV import now merges with webhook-created placeholder bookings — no more duplicate 'Unknown (Trackman)' entries alongside real member bookings",
      "New: When a CSV row matches a simulator and time slot that has a placeholder/ghost booking, the system updates the existing record instead of creating a new one",
      "Improvement: Member matching is now strict email-only — removed name-based fallback matching that caused incorrect member links when multiple people share similar names",
      "Improvement: CSV-imported bookings linked to a member are now always set to 'Approved' status instead of staying 'Pending'",
      "New: Post-import cleanup auto-approves any remaining pending bookings that were successfully linked to a member",
      "Fix: Billing sessions are now created immediately after merging CSV data into placeholder bookings",
      "Fix: Time matching uses ±2 minute tolerance to handle rounding differences between Trackman and the app",
    ],
  },
  {
    version: "7.14.0",
    date: "2026-02-09",
    title: "Proper Trackman Cancellation Flow",
    isMajor: true,
    changes: [
      "New: Approved simulator bookings linked to Trackman now go through a proper cancellation process instead of instant cancel",
      "New: When a member or staff cancels a Trackman-linked booking, it enters 'Cancellation Pending' status and staff are notified to cancel in Trackman first",
      "New: Once staff cancels in Trackman and the webhook confirms it, the system automatically refunds charges, clears billing, and notifies the member",
      "New: Staff can manually complete a pending cancellation via a 'Complete Cancellation' button if the Trackman webhook doesn't arrive",
      "New: Scheduled safety net checks every 2 hours for cancellations stuck for 4+ hours and escalates to staff",
      "New: Members see 'Cancellation Pending' status with messaging that their request is being processed",
      "New: Staff see 'Cancellation Pending' badge with instructions to cancel in Trackman and a manual completion option",
      "Improvement: Time slot stays reserved during pending cancellation — no double-booking risk",
      "Improvement: Non-Trackman bookings (conference rooms, etc.) keep the existing instant cancel behavior",
      "Fix: Updated 40+ booking queries across the codebase to properly handle the new cancellation_pending status",
    ],
  },
  {
    version: "7.13.0",
    date: "2026-02-09",
    title: "Complete Session Creation Safety Coverage",
    isMajor: true,
    changes: [
      "Fix: ALL session creation paths now go through ensureSessionForBooking — a single hardened function with automatic retry and staff-note flagging on failure",
      "Fix: Staff check-in (2 paths) — check-in context and add-participant now use hardened session creation instead of raw database inserts",
      "Fix: Booking approval check-in and dev_confirm paths now use hardened session creation with retry safety",
      "Fix: Trackman webhook billing (2 paths) — pending booking link and new booking creation now retry on failure instead of silently failing",
      "Fix: Trackman webhook simulate-confirm and reprocess-backfill now use hardened session creation — eliminated a completely silent empty catch block in reprocess",
      "Fix: Trackman admin resolve (visitor + member) and backfill tool now use hardened session creation with retry",
      "Fix: Visitor auto-match (2 paths) — both transactional and non-transactional auto-match session creation now use hardened path",
      "Fix: Ghost booking fix tool now uses hardened session creation instead of raw database insert",
      "Improvement: ensureSessionForBooking now checks for existing sessions by Trackman booking ID in addition to resource/date/time — prevents duplicate session conflicts",
      "Improvement: ensureSessionForBooking INSERT now uses ON CONFLICT for Trackman booking ID dedup — handles race conditions atomically",
      "Result: Zero raw INSERT INTO booking_sessions in the codebase outside of ensureSessionForBooking — every session creation path has retry + staff-note safety",
    ],
  },
  {
    version: "7.12.0",
    date: "2026-02-09",
    title: "Session Reliability & Data Integrity Hardening",
    changes: [
      "Fix: Session creation now retries automatically and flags bookings with a staff note if it ultimately fails — no more silent billing gaps",
      "Fix: Roster confirmation and guest fee checkout now use the hardened session creation path with retry and staff-note safety",
      "Fix: Conference room auto-confirm no longer silently swallows session creation failures — staff notes are written if something goes wrong",
      "Fix: Trackman CSV import falls back to a minimal owner-only session on failure instead of silently skipping billing",
      "Fix: Google Calendar conference room sync now creates billing sessions for approved bookings",
      "Fix: Delete user now properly cleans up booking participants and removes empty sessions to prevent orphaned data",
      "Fix: Guest pass deduction in Trackman imports only applies when guests have identifying info (name or email); unidentified guests always get a fee charged",
      "Fix: Cleaned up orphaned test data (2 orphaned participants, 7 empty sessions)",
      "Removed: Deleted unused GuestEntryModal component (dead code cleanup)",
    ],
  },
  {
    version: "7.11.7",
    date: "2026-02-09",
    title: "Fix False Positives in Session Integrity Check",
    changes: [
      "Fix: 'Active Bookings Without Sessions' data integrity check no longer counts unmatched Trackman walk-in bookings — only real member bookings are flagged",
      "Fix: Backfill Sessions tool now skips unmatched Trackman bookings that have no member to bill",
      "Result: Count drops from ~38 to ~8 — only genuine missing sessions remain",
    ],
  },
  {
    version: "7.11.6",
    date: "2026-02-09",
    title: "Bulk Waiver Review",
    changes: [
      "New: Staff can now bulk-review all stale waivers at once from the Overdue Payments panel or Command Center",
      "New: Stale waivers API endpoint for listing all unreviewed fee waivers older than 12 hours",
      "Improvement: 'Review All Waivers' button appears when unreviewed waivers exist, with confirmation before approving",
    ],
  },
  {
    version: "7.11.5",
    date: "2026-02-09",
    title: "Fix Unknown Trackman Bookings in Request Queue",
    changes: [
      "Fix: Unmatched Trackman webhook bookings no longer appear as pending requests in the Bookings page — they belong only in the Trackman Needs Assignment area",
      "Fix: Command Center pending count and today's bookings no longer include unmatched Trackman entries",
      "Fix: Calendar approved bookings view no longer shows unmatched Trackman bookings",
    ],
  },
  {
    version: "7.11.4",
    date: "2026-02-09",
    title: "Past Events & Wellness Hidden by Default",
    changes: [
      "Improvement: Past events and past wellness classes are now collapsed by default — tap the 'Past' header to reveal them",
      "Improvement: Past events also load in batches of 20 with a 'Show more' button, matching the wellness tab behavior",
    ],
  },
  {
    version: "7.11.3",
    date: "2026-02-09",
    title: "Wellness Tab Mobile Fix",
    changes: [
      "Fix: Wellness tab on the Calendar page no longer crashes on mobile — classes now load in batches of 20 with a 'Show more' button instead of rendering all 370+ at once",
    ],
  },
  {
    version: "7.11.2",
    date: "2026-02-09",
    title: "Better Trackman Notification Messages",
    changes: [
      "Improvement: Trackman booking notifications now show bay number, day of week, 12-hour time, and duration instead of raw dates and 'Unknown'",
      "Improvement: Unmatched booking alerts lead with the bay info so you can quickly tell which booking came through",
    ],
  },
  {
    version: "7.11.1",
    date: "2026-02-09",
    title: "Notification Click Navigation",
    changes: [
      "Fix: Clicking notifications now takes you to the relevant page — Unmatched Trackman alerts go to Trackman, payment alerts go to Financials, member alerts go to Directory, system alerts go to Data Integrity, and so on",
      "Fix: Marking individual notifications as read no longer fails with a server error",
    ],
  },
  {
    version: "7.11.0",
    date: "2026-02-09",
    title: "Booking Session Integrity Hardening",
    isMajor: true,
    changes: [
      "Fix: Created centralized session-creation helper used across all booking status paths — ensures every approved/confirmed booking always gets a billing session",
      "Fix: Closed 5 code paths where bookings could become approved without billing sessions — Trackman auto-match (2 paths), resource confirmation, conference room auto-confirm, and staff day pass bookings",
      "Fix: Upgraded 2 Trackman webhook paths that silently ignored session creation failures — bookings now revert to pending instead of staying approved without a session",
      "Fix: All 7 hardened paths use dedup logic so existing sessions are reused instead of creating duplicates",
      "Improvement: Eliminated root cause of 'active bookings without sessions' data integrity issue that was blocking revenue tracking",
    ],
  },
  {
    version: "7.10.16",
    date: "2026-02-08",
    title: "Guest Pass: Only Apply When Guest Info Entered",
    changes: [
      "Fix: Guest passes now only apply to guests where the member has actually entered information (name or email) — empty guest slots are always charged $25",
      "Fix: Fee estimate preview updates in real-time as member fills in guest details — passes show as applied only after entering guest info",
      "Fix: Strengthened guest pass protection — passes require either a real guest record or a non-placeholder name across all fee calculation paths",
      "Fix: Added placeholder guard to guest pass consumption and API endpoints for defense-in-depth",
    ],
  },
  {
    version: "7.10.12",
    date: "2026-02-08",
    title: "Guest Pass Business Rule Correction",
    changes: [
      "Fix: Guest passes now only apply to actual named guests/visitors — empty or unfilled player slots always charge $25 regardless of available passes",
      "Fix: Corrected fee calculation across all booking flows (member booking preview, staff financial summary, Trackman sync, check-in, player count edits) so empty slots never consume guest passes",
      "Fix: Reverted incorrect logic that was allowing guest passes to cover empty slots in the booking details financial summary",
    ],
  },
  {
    version: "7.10.10",
    date: "2026-02-08",
    title: "Empty Slot UI Improvements",
    changes: [
      "Improvement: The 'Find member' button on empty player slots now says 'Search' to reflect that it finds both members and visitors",
      "Improvement: The 'Add Guest' button is now labeled 'New Guest' and goes directly to a new visitor form with First Name, Last Name, Email, and Phone fields — removed the Search/New toggle since the main search already finds existing people",
      "Improvement: Empty player slots now display the $25 guest fee badge so staff can see the cost at a glance",
      "Improvement: The search bar is now dismissable — staff can close it to get back to the default slot view with the New Guest button",
      "Improvement: Empty slot warning text now says 'assign players' instead of 'link members' since guests can also fill slots",
    ],
  },
  {
    version: "7.10.9",
    date: "2026-02-08",
    title: "Guest Slot Display & Owner Overage Calculation",
    changes: [
      "Fix: Guests now appear directly in their assigned player slot instead of showing separately below the roster — makes it clearer who's occupying each position in the booking",
      "Fix: Booking owner is now correctly charged overage fees for time used by guests and empty slots. When a guest (like Nolan) occupies a slot, that time counts toward the owner's daily usage for overage purposes. Member slots are not affected — members handle their own overage independently.",
    ],
  },
  {
    version: "7.10.8",
    date: "2026-02-08",
    title: "Guest Fee & Removal Improvements",
    changes: [
      "Fix: Guest fee double-counting resolved — when a booking had both a guest participant (like Nolan) AND an empty member slot, the system was charging $25 for the guest AND another $25 for the empty slot, resulting in $50 instead of the correct $25. The financial summary now correctly accounts for guests that already fill empty slots.",
      "New: Staff can now remove guests from bookings using a remove button (X) next to each guest in the Booking Details modal — previously there was no way to remove a guest once added.",
    ],
  },
  {
    version: "7.10.7",
    date: "2026-02-08",
    title: "Empty Slot Overage Fee Fix",
    changes: [
      "Fix: When a booking has empty player slots, the owner is now correctly charged overage for the full booking duration. Previously, the owner was only charged for their split share (e.g., 60 min out of 120 min for a 2-player booking), even when the other slot was empty. Now the owner absorbs the empty slot time for overage purposes while the empty slot still generates the standard guest fee.",
    ],
  },
  {
    version: "7.10.6",
    date: "2026-02-08",
    title: "Billing & Payment Security Hardening",
    changes: [
      "Security: Staff charges over $500 on a member's saved card now require admin-level approval — prevents unauthorized large charges by non-admin staff",
      "Security: Stripe sync and backfill operations now have a 5-minute cooldown between triggers — prevents accidental repeated runs that could cause rate limit issues or data inconsistencies",
      "Security: Staff accessing another member's billing info (invoices, payments, balance, saved cards) is now logged in the audit trail — provides accountability for billing data access",
      "Security: Public day-pass checkout and all sync operations now have request rate limits — prevents abuse and protects against automated attacks",
      "Fix: Added missing audit action type for large charge approvals",
    ],
  },
  {
    version: "7.10.5",
    date: "2026-02-08",
    title: "Deep Security Audit: Booking, Billing, Members & Integrations",
    changes: [
      "Fix: Visitor search now uses parameterized database queries — previously used a fragile string escaping pattern that could potentially allow SQL injection in edge cases",
      "Fix: Resend email webhook verification is now mandatory in production — previously, if the webhook secret wasn't configured, all webhook events were accepted without verification, allowing potential forgery of email bounce/complaint events",
      "Fix: Guest check-in via HubSpot forms now requires staff authentication — previously the public form endpoint could be used to deplete any member's guest passes without logging in",
      "Verified: 85+ routes across booking system, member management, billing, admin tools, and integrations — all properly protected",
      "Verified: All Stripe payment routes use proper auth, transactions, and idempotency",
      "Verified: HubSpot webhook uses timing-safe signature verification with replay protection",
      "Verified: File uploads enforce 10MB size limits with image type validation",
      "Verified: Data export only returns the requesting member's own data, with sensitive fields excluded",
      "Verified: Member search redacts email addresses for non-staff users",
      "Verified: All data integrity and admin tools require admin-level access",
    ],
  },
  {
    version: "7.10.4",
    date: "2026-02-08",
    title: "Security Audit: Route Authorization Hardening",
    changes: [
      "Fix: Wellness class enrollment now verifies the logged-in member matches the request — previously accepted any email without checking the session",
      "Fix: Event RSVP creation now verifies the logged-in member matches the request — previously accepted any email without checking the session",
      "Fix: Event RSVP cancellation now verifies the logged-in member matches the request — previously accepted any email without checking the session",
      "Fix: Eventbrite sync endpoint now requires staff access — previously could be triggered without authentication",
      "Fix: Tour confirmation now only allows confirming tours that are in 'pending' status — prevents re-confirming already scheduled tours",
      "Fix: Updated the notification type constraint to include all 40+ notification types used across the system — previously only 19 types were allowed, causing Trackman and other notifications to silently fail",
      "Verified: All admin/staff mutation routes properly protected with role-based access control",
      "Verified: All member-facing routes enforce self-access-only (members can only modify their own data)",
      "Verified: Frontend auth guards properly redirect unauthenticated users and non-staff from admin pages",
      "Verified: Service worker properly handles cache versioning and old cache cleanup",
      "Verified: Announcements, gallery, settings, FAQs, bug reports, notices, cafe menu, and membership tier routes all properly protected",
    ],
  },
  {
    version: "7.10.3",
    date: "2026-02-08",
    title: "System Audit: Webhook & Job Queue Hardening",
    changes: [
      "Fix: Hardened a database query in the Stripe webhook cleanup to prevent potential issues with dynamic values in SQL",
      "Improvement: Old completed and failed background jobs are now automatically cleaned up during weekly maintenance (older than 7 days) — prevents database bloat from accumulated job records",
      "Verified: Stripe webhook system — transactional dedup, event ordering, deferred actions, and rollback all working correctly across 20+ event types",
      "Verified: Background job processor — claim locking, retry logic with exponential backoff, and stuck job recovery all working correctly",
      "Verified: Booking roster management — optimistic locking with version tracking and row-level locking prevents race conditions",
      "Verified: Prepayment system — duplicate prevention, refund handling, and fee calculation all working correctly",
      "Verified: Stripe Terminal integration — proper auth, audit logging, idempotency, and amount verification in place",
    ],
  },
  {
    version: "7.10.2",
    date: "2026-02-08",
    title: "Scheduler Timezone Fixes & Cleanup Improvements",
    changes: [
      "Fix: Daily reminder notifications now trigger at 6pm Pacific instead of 6pm UTC (was firing at 10am Pacific)",
      "Fix: Morning closure notifications now trigger at 8am Pacific instead of 8am UTC (was firing at midnight Pacific)",
      "Fix: Weekly cleanup now runs Sunday 3am Pacific instead of 3am UTC",
      "Fix: Daily reminders now correctly look up 'tomorrow's' bookings and events using Pacific time — previously could skip a day or show wrong day's reminders",
      "Fix: Session cleanup scheduler (2am) and webhook log cleanup scheduler (4am) now use the standard Pacific time utility — previously used a method that could misfire at midnight",
      "Fix: Hardened a database query in the payment reconciliation scheduler to prevent potential issues with dynamic values in SQL",
      "Improvement: Old calendar availability blocks (older than 30 days) are now automatically cleaned up during weekly maintenance — removed 72 accumulated blocks dating back to August 2025",
    ],
  },
  {
    version: "7.10.1",
    date: "2026-02-07",
    title: "ID Scan Address Auto-Fill",
    changes: [
      "Improvement: ID scanning now auto-fills address fields (street, city, state, zip) in addition to name and date of birth — for new members, visitors, and sub-members",
      "Improvement: Address data from scanned IDs is now saved to the member's record and syncs to HubSpot",
      "Improvement: All user creation flows (new member signup, day pass purchase, group member add, activation link) now pass address through to the database",
    ],
  },
  {
    version: "7.10.0",
    date: "2026-02-07",
    title: "ID & Driver's License Scanning",
    isMajor: true,
    changes: [
      "New: Staff can scan a member's driver's license or ID card during registration — the system uses AI to automatically read and fill in the name, date of birth, and address fields",
      "New: Live camera preview with a banking-app-style guide overlay helps staff position the ID correctly before capturing",
      "New: Image quality feedback — the system warns if the photo is too blurry, too dark, has glare, or is partially obscured, and suggests retaking",
      "New: File upload option — staff can also upload an existing photo of an ID instead of using the camera",
      "New: Scanned ID images are securely stored on the member's record for future reference",
      "New: 'ID on File' section in the member profile drawer — staff can view the stored ID image full-size, re-scan, or remove it",
      "New: ID scanning works for both new member and visitor registration flows",
    ],
  },
  {
    version: "7.9.1",
    date: "2026-02-07",
    title: "QR Check-In Refinements & Activity Feed",
    changes: [
      "New: Walk-in QR check-ins now appear in the staff dashboard's recent activity feed with a scanner icon and staff name",
      "Fix: Lifetime visit counts now include walk-in check-ins everywhere — membership card, staff profile drawer, member directory, and HubSpot contacts all previously missed walk-in visits",
      "Fix: MindBody imports can no longer overwrite visit counts — they now only increase the count, never decrease it, so walk-in check-ins and other locally-tracked visits are preserved",
      "Improvement: Check-in confirmation popup now shows amber warnings for cancelled, suspended, or inactive memberships — not just expired",
      "Fix: Member dashboard now refreshes visit count in real-time after a walk-in check-in",
      "Improvement: Duplicate QR scan within 2 minutes shows a friendly 'already checked in' message instead of an error",
    ],
  },
  {
    version: "7.9.0",
    date: "2026-02-07",
    title: "QR Check-In & Membership Card Improvements",
    changes: [
      "New: Walk-in QR check-in — staff can scan a member's QR code to record a visit even without a booking, with automatic visit count tracking and HubSpot sync",
      "New: Staff check-in confirmation popup — after scanning a member's QR code, a brief modal shows the member's name, tier, and any pinned staff notes, then auto-dismisses after a few seconds",
      "New: QR code added to the membership card popup on the dashboard — members can now tap their card and show the QR code at the front desk for quick check-in",
      "Improvement: Removed the separate 'Digital Access Card' section from the profile page since the QR code now lives on the membership card popup",
      "Improvement: Removed the redundant 'Membership' section from the bottom of the profile page — the same info is already on the membership card popup",
    ],
  },
  {
    version: "7.8.1",
    date: "2026-02-07",
    title: "Google Sign-In Fix & Quieter Error Alerts",
    changes: [
      "Fix: Google Sign-In was returning 'Not found' in production — caused by a route registration order conflict where the test auth middleware intercepted Google auth requests before they could reach the proper handler",
      "Fix: Google Sign-In, Google account linking, and Google account status endpoints now all work correctly in production",
      "Improvement: Error alert emails reduced from up to 6/day to max 3/day, with 4-hour cooldown between similar alerts instead of 1 hour",
      "Improvement: Temporary network blips (timeouts, brief disconnections, rate limits) no longer trigger alert emails — only real, persistent issues send notifications",
      "Improvement: Alert system now remembers its limits across app restarts, so deploys no longer reset the daily email counter",
      "Improvement: 5-minute grace period after server start — no alert emails sent during the brief connection hiccups that naturally happen when the app restarts",
    ],
  },
  {
    version: "7.8.0",
    date: "2026-02-07",
    title: "Rebrand: Ever House → Ever Club",
    isMajor: true,
    changes: [
      "Rebrand: All references to 'Ever House' have been updated to 'Ever Club' across the entire app — pages, emails, notifications, and legal documents",
      "New: Updated logos throughout the app with the new EverClub script wordmark",
      "New: Legal name 'Ever Members Club' now appears in the footer, Terms of Service, and Privacy Policy",
      "Update: All email sender addresses updated from @everhouse.app to @everclub.app",
      "Update: Domain references updated from everhouse.app to everclub.app across all links, sitemap, and SEO metadata",
      "Update: PWA manifest and service worker updated with new branding",
    ],
  },
  {
    version: "7.7.0",
    date: "2026-02-07",
    title: "Sign in with Google — Link Your Google Account",
    isMajor: true,
    changes: [
      "New: 'Sign in with Google' button on the login page — members can now tap to sign in instantly with their Google account instead of waiting for an email code",
      "New: Connected Accounts section in profile settings — link or unlink your Google account anytime",
      "New: Apple account linking coming soon (placeholder in settings)",
      "Security: Google sign-in uses the same email matching system as OTP login — if your Google email is a known alternate, you'll be matched to your existing account automatically",
    ],
  },
  {
    version: "7.6.2",
    date: "2026-02-07",
    title: "Login & HubSpot Sync Deduplication — Final Gaps Closed",
    changes: [
      "Fix: Login flow now checks linked emails — if a member logs in with an alternate email we have on file, they're matched to their existing account instead of getting a new one",
      "Fix: HubSpot bulk sync now checks linked emails before creating or updating users — prevents duplicates when a HubSpot contact's email is a known alternate email in our system (both full sync and delta sync paths)",
    ],
  },
  {
    version: "7.6.1",
    date: "2026-02-07",
    title: "Deduplication Coverage Audit — 5 Additional Entry Points Secured",
    changes: [
      "Fix: New member signup (online checkout) now checks linked emails before creating a user — prevents duplicates when someone signs up with an alternate email we already know about",
      "Fix: Activation link member creation now checks linked emails before creating a user — same protection for staff-initiated signups",
      "Fix: HubSpot member creation (local) now checks linked emails before creating a user — prevents duplicates when staff adds members through HubSpot flow",
      "Fix: HubSpot member creation (with deal) now checks linked emails before creating a user — same protection for deal-based member creation",
      "Fix: Visitor creation now checks linked emails before creating a new visitor record — prevents duplicate visitors when someone uses an alternate email",
      "Fix: Group billing family path now always uses ID-based updates when a user is resolved (consistent with corporate path)",
      "Fix: resolveUserByEmail() now logs errors instead of silently swallowing them — database issues in linked-email checks will surface in logs immediately",
    ],
  },
  {
    version: "7.6.0",
    date: "2026-02-07",
    title: "Comprehensive Stripe & User Deduplication — All Entry Points Protected",
    isMajor: true,
    changes: [
      "New: Created resolveUserByEmail() helper that checks direct email, linked emails, and manually linked emails — used as the universal lookup before any Stripe customer or user creation",
      "Fix: Eliminated 10 direct Stripe customer creation calls that bypassed all dedup logic — billing portal, payment methods, setup intents, account balance, Stripe sync, credit application, quick charge, POS terminal, overage fallback, and MindBody sync now all route through the centralized getOrCreateStripeCustomer function",
      "Fix: Day pass checkout (public + staff-initiated) and 3 member-payment paths no longer pass email as user ID — they now resolve the real user first, enabling linked-email and HubSpot dedup checks",
      "Fix: 8 user creation paths (webhook subscription, webhook staff invite, Stripe sync, reconciliation, payment confirmation, POS visitor, and 2 group billing paths) now check linked emails before inserting new records — preventing duplicate users when someone uses a different email that we know belongs to them",
      "Fix: Active members purchasing day passes are now logged with a warning for staff visibility",
      "Verified: Zero direct stripe.customers.create() calls remain outside the centralized function",
    ],
  },
  {
    version: "7.5.0",
    date: "2026-02-07",
    title: "Cross-System Deduplication & Stripe Customer Consolidation",
    isMajor: true,
    changes: [
      "New: Merged 12 duplicate member accounts that existed across Stripe, HubSpot, and the database — consolidating bookings, visits, and payment history into one unified profile per person",
      "New: Stripe customer creation now cross-checks HubSpot contact IDs to prevent creating duplicate Stripe customers when the same person uses different emails",
      "New: HubSpot sync now detects when two database users share the same HubSpot contact and automatically links their emails to prevent future duplicates",
      "New: Data Integrity dashboard now includes a HubSpot ID duplicate check that surfaces suspected duplicate accounts for staff review",
      "Fix: Merge tool now consolidates Stripe customers when both accounts have one — keeps the customer with the active subscription and logs the orphaned one for audit",
    ],
  },
  {
    version: "7.4.3",
    date: "2026-02-07",
    title: "Complete Dynamic Pricing — All Prices From Stripe",
    changes: [
      "New: /api/pricing endpoint now also serves corporate volume tier pricing and day pass prices from Stripe",
      "New: Corporate volume discount tables on Membership page and Checkout page now pull prices dynamically from Stripe",
      "New: Day pass prices (Workspace and Golf Sim) on Membership page now pull from the database, synced with Stripe",
      "New: /api/pricing endpoint provides current guest fee and overage rate to all frontend components",
      "Fix: Guest payment choice modal now shows the real Stripe price instead of hardcoded $25",
      "Fix: Trackman link modal guest fee labels and Quick Add Guest button now show the real price",
      "Fix: Roster manager 'no passes left' messaging now shows the real guest fee",
      "Fix: Booking members editor guest add buttons and fee notices now show the real price",
      "Fix: Trackman admin fee notes (pending assignment, no passes) now use the real guest fee from Stripe",
      "Fix: Public membership page now shows the real guest fee in the '15 Annual Guest Passes' description",
      "Fix: Member dashboard overage dialog fallback now uses the real overage rate instead of hardcoded $25",
      "Fix: Staff training guide content now displays the real guest fee and overage rate from Stripe",
      "Fix: Staff check-in guest addition now uses the real guest fee from Stripe instead of hardcoded $25",
      "Fix: Roster guest fee assignment now uses the real guest fee from Stripe config",
      "Fix: Guest fee payment recording now uses the actual Stripe payment amount instead of hardcoded $25",
      "Fix: Stripe payment helpers fallback now references the centralized pricing config",
      "Fix: Booking page guest fee and overage rate display fallbacks now use the real Stripe price instead of hardcoded $25",
      "Fix: Staff simulator tab guest fee display fallback now uses the real Stripe price instead of hardcoded $25",
      "Fix: Backend fee calculator overage and guest fee calculations now use the real Stripe price instead of hardcoded $25",
      "Fix: Trackman admin fee breakdown (overage and empty slot fees) now uses the real Stripe price for all 5 calculation paths",
      "Fix: Simulator tab tier-based fee estimator now passes real Stripe pricing instead of hardcoded $25",
      "Fix: Trackman link modal player slot guest count total now uses the real guest fee from Stripe",
      "Fix: E2E booking test fallback now uses the centralized pricing config",
      "Improvement: All components use a shared pricing hook with 5-minute caching for efficient updates"
    ]
  },
  {
    version: "7.4.1",
    date: "2026-02-07",
    title: "Dynamic Stripe-Sourced Pricing",
    changes: [
      "Improvement: Guest fee and overage rate are now pulled directly from their Stripe products at startup — if you change the price on the Guest Pass or Simulator Overage product in Stripe, the app automatically picks up the new price",
      "Improvement: When Stripe sends a price update notification (webhook), the app updates the in-memory price instantly — no server restart needed",
      "Fix: All fee displays (booking page, member dashboard, staff simulator tab, overage payment dialog) now show the actual Stripe product price instead of a hardcoded $25",
      "Technical: The only hardcoded logic is the business rules — empty slots = guest fee, 30-minute overage blocks, guest pass usage — the dollar amounts always come from Stripe"
    ]
  },
  {
    version: "7.4.0",
    date: "2026-02-07",
    title: "Critical Billing & Payment Safety Fixes",
    isMajor: true,
    changes: [
      "Fix: Core members were being incorrectly charged $50 overage fees on bookings within their included 60-minute daily allowance — affected 9 bookings across Feb 5–8 (root cause: the system was accidentally counting a booking's own time as 'prior usage,' doubling the total and triggering a false overage)",
      "Fix: All 9 affected bookings have been recalculated to the correct $0 fee. Nicholas Sherry's incorrectly collected $50 has been flagged for refund.",
      "Fix: If a member modifies their booking after starting payment (e.g., adds guests), the system now detects the amount changed and creates a fresh payment request instead of reusing the old one with the wrong amount",
      "Fix: Free guest passes are now only counted when actually used — previously, paying cash for a guest still counted against the member's monthly free pass allowance",
      "Fix: When updating corporate group billing in Stripe, if part of the update fails mid-way, the system now properly rolls back Stripe charges to prevent double-billing",
      "Fix: New membership subscriptions created in Stripe are no longer accidentally skipped if Stripe sends status updates out of order",
      "Safety: The 'Pull from Stripe' sync now refuses to overwrite tier limits (like daily simulator minutes) with zero if the current value is positive — prevents accidental billing breakage from missing Stripe feature keys",
      "Fix: If a member cancels and immediately resubscribes, the old cancellation notice from Stripe no longer accidentally locks out their new subscription",
      "Fix: Members who upgrade their tier now immediately get access to their new guest pass allowance — previously the old pass count stayed locked at the previous tier's limit",
      "Fix: At check-in, if a member upgraded their tier since booking, the system now charges the lower fee instead of the old higher one from booking time",
      "Fix: Bookings with empty player slots (e.g., 4-player booking with only 1 member assigned) now correctly show the $25/slot guest fee for unfilled positions — previously showed 'No fees due'",
      "Fix: Fee calculations now use the longer of the Trackman session time vs. the booking time — when staff extend a booking (e.g., from 4 hours to 5 hours), the financial summary now matches the displayed booking duration instead of using the shorter original session time"
    ]
  },
  {
    version: "7.3.5",
    date: "2026-02-06",
    title: "Directory Sync Speed Improvement",
    changes: [
      "Improvement: Sync button on Directory page now runs much faster — only syncs members with active statuses or recent changes from HubSpot, instead of re-processing all 2,000+ contacts",
      "Improvement: Removed redundant Stripe sync from the manual sync button — Stripe updates already arrive instantly through webhooks",
      "New: Sync button now also pushes your app's membership status and tier data back out to HubSpot for all active members, so HubSpot always matches what the app shows"
    ]
  },
  {
    version: "7.3.4",
    date: "2026-02-06",
    title: "Family Group Signup & Terminal Cleanup",
    changes: [
      "Fix: When staff signs up a new member with family sub-members, the family billing group and sub-member accounts are now actually created after payment — previously only the primary member was created and sub-member data was lost",
      "Fix: Family sub-member creation works for both online card and Card Reader payment methods",
      "Fix: If a Card Reader payment is cancelled during new member signup, the pending account and Stripe subscription are now automatically cleaned up instead of being left behind"
    ]
  },
  {
    version: "7.3.3",
    date: "2026-02-06",
    title: "Checkout Customer Fix & Corporate Billing Safety",
    changes: [
      "Fix: Members who re-sign up through the public checkout page now keep their existing Stripe account instead of getting a duplicate — preserves saved cards and payment history",
      "Fix: Adding and removing corporate group members at the same time can no longer cause the billing count to get out of sync with Stripe"
    ]
  },
  {
    version: "7.3.2",
    date: "2026-02-06",
    title: "Phone Formatting, Terminal Signup Fix & Auto-Close",
    changes: [
      "New: Phone number fields now auto-format as (XXX) XXX-XXXX while you type",
      "Fix: Card Reader payment during new member signup now correctly links to the subscription and customer instead of creating a standalone charge",
      "Fix: If the signup has an error (like an existing pending account), the Card Reader tab now shows the error and prevents an accidental unlinked charge",
      "Fix: After a successful Card Reader payment, the success screen auto-closes after a brief moment instead of staying open",
      "Fix: Card Reader now works correctly for group/family add-on signups — previously it would fail because it tried to confirm a subscription that didn't exist",
      "Fix: New members now appear immediately in the Active tab of the Directory after signup from staff quick actions",
      "Removed: Guest Pass removed from the POS product list — it's only charged automatically through the booking fee system"
    ]
  },
  {
    version: "7.3.1",
    date: "2026-02-06",
    title: "Terminal Card Reader: Default for Staff Billing & Reuse Existing Charges",
    changes: [
      "Improvement: Card Reader is now the default payment method in the staff check-in billing screen — no more switching from Online Card each time",
      "New: When a member started an online overage payment but didn't finish, staff can now collect that same charge on the card reader instead of creating a duplicate",
      "Fix: Incomplete overage charges in Stripe are now reused rather than orphaned — cleaner transaction history for members",
      "Fix: Corporate group billing error recovery now properly references subscription data when rolling back Stripe changes",
      "Fix: Refund calculations use precise math to prevent tiny rounding differences over many transactions",
      "Fix: Day pass visitors who sign up for membership now properly get upgraded to member status automatically"
    ]
  },
  {
    version: "7.3.0",
    date: "2026-02-06",
    title: "Announcements Export & Google Sheets Sync",
    isMajor: true,
    changes: [
      "New: Export all announcements as a CSV file from the Announcements admin tab",
      "New: Two-way Google Sheets sync for announcements — create a linked spreadsheet, add or edit rows in Google Sheets, and pull changes into the app",
      "New: Auto-sync — when you create, edit, or delete an announcement in the app, changes are automatically pushed to the linked Google Sheet",
      "New: 'Pull from Sheet' button imports new and updated announcements from the Google Sheet",
      "New: 'Push to Sheet' button sends all current announcements to the linked Google Sheet",
      "New: Connect/disconnect Google Sheet controls with link to open the sheet directly"
    ]
  },
  {
    version: "7.2.3",
    date: "2026-02-06",
    title: "Smart Login Redirect",
    changes: [
      "Fix: Logged-in users visiting the home page are now instantly taken to their dashboard — staff and admins go to the Staff Portal, members go to their Member Dashboard",
      "Fix: Logged-in users visiting the login page are now redirected to their dashboard instead of seeing the login form again",
      "Improvement: Redirect uses fast client-side navigation instead of full page reloads for a smoother experience"
    ]
  },
  {
    version: "7.2.2",
    date: "2026-02-06",
    title: "Reschedule Hardening: Full Gap Audit",
    changes: [
      "Fix: Reschedule now checks for facility closures and availability blocks before confirming — previously it only checked for conflicting bookings, so a reschedule could land on a closed time slot",
      "Fix: Reschedule confirm now runs inside a database transaction — if the session update fails, the booking update is rolled back too, preventing data mismatches",
      "New: Members receive a branded email when their booking is rescheduled — shows the new date, time, and bay name",
      "New: Members receive a push notification when their booking is rescheduled — works even if the app isn't open",
      "Improvement: In-app reschedule notification is now generated on the server instead of the browser — more reliable delivery"
    ]
  },
  {
    version: "7.2.1",
    date: "2026-02-06",
    title: "Reschedule Safety Fixes",
    changes: [
      "Fix: Original booking date is now preserved when rescheduling — previously only bay, start time, and end time were saved, so a date change lost the original date",
      "Fix: Reschedule confirm now verifies the booking is actually in reschedule mode — prevents accidental confirms without starting the reschedule first",
      "Fix: Any unpaid prepayment charges are automatically voided after a reschedule — prevents members from being billed at the old rate"
    ]
  },
  {
    version: "7.2.0",
    date: "2026-02-06",
    title: "Booking Reschedule: Move Bookings to Any Bay & Time",
    isMajor: true,
    changes: [
      "New: Staff can reschedule any upcoming booking to a different bay and/or time slot — the member, player roster, guest passes, and all booking details stay intact",
      "New: Reschedule button appears in the Booking Details modal for all future simulator bookings",
      "New: Two-step reschedule flow — first pick the new bay/date/time, then create the booking on Trackman, delete the old one, and paste the new Trackman ID to confirm",
      "New: While a reschedule is in progress, the booking is protected from accidental cancellation — if the old Trackman booking's deletion webhook arrives, the system skips all fee adjustments and member notifications",
      "New: Members receive a 'Booking Rescheduled' notification with the new bay, date, and time — no confusing cancellation notice",
      "New: If a reschedule is started but never completed, the system auto-clears the hold after 30 minutes so the booking doesn't get stuck",
      "New: Duration change warning — if the new time slot has a different duration, staff see a notice that fees may need recalculation"
    ]
  },
  {
    version: "7.1.4",
    date: "2026-02-06",
    title: "Trackman Webhook Log on Import Page",
    changes: [
      "New: Trackman Import page now shows a live feed of all webhooks received from Trackman — including whether each booking was created, changed, or deleted, and whether it was auto-linked or manually resolved"
    ]
  },
  {
    version: "7.1.3",
    date: "2026-02-06",
    title: "Booking Duration Options: More Flexibility for Groups",
    changes: [
      "New: 3-player bookings now offer 5 duration options — 90m (30 each), 120m (40 each), 150m (50 each), 180m (60 each), and 270m (90 each) — filling the gap between short and long sessions",
      "New: 4-player bookings now include a 180m option (45 each) alongside 120m and 240m, giving groups a middle-ground choice that matches common Trackman session lengths",
      "Improved: Duration options are now consistent between the member booking page and staff manual booking form"
    ]
  },
  {
    version: "7.1.2",
    date: "2026-02-06",
    title: "Billing Safety: Race Condition & Revenue Leak Fixes",
    changes: [
      "Fixed: Guest pass race condition — two simultaneous check-in requests could both consume the same remaining pass, allowing more uses than the member's limit. Row locking now prevents double-consumption.",
      "Fixed: Zombie subscription risk — if a new member signup failed partway through, the system could delete the member's account while Stripe kept billing them. Now the account is preserved so staff can investigate and refund.",
      "Fixed: Overage fee calculation gap — during a brief window between check-in and fee processing, a booking's usage minutes could temporarily disappear from the daily total, potentially undercharging overage fees."
    ]
  },
  {
    version: "7.1.1",
    date: "2026-02-06",
    title: "POS Checkout: Card-Only Payments & Card on File",
    changes: [
      "New: 'Card on File' payment option — when a customer has a saved card in Stripe, staff can charge it instantly with one tap from the POS checkout",
      "New: POS automatically checks if the selected customer has a saved card and shows their card details (brand + last 4 digits) as a payment option",
      "Improved: POS checkout now offers only Stripe-backed payment methods — Online Card, Card Reader (terminal), and Card on File — cash/check option removed",
      "Improved: Redeem Day Pass section no longer overflows on smaller screens",
      "Improved: Financials tab bar and product category tabs now scroll horizontally on mobile instead of text getting cut off"
    ]
  },
  {
    version: "7.1.0",
    date: "2026-02-06",
    title: "Financials Redesign: POS Cash Register & Transactions Tab",
    isMajor: true,
    changes: [
      "New: POS tab redesigned as a full cash register — products organized into Passes, Cafe, and Merch categories with a product grid, shopping cart, and checkout in one view",
      "New: Cafe menu items now appear directly in the POS register — all 33 items across 6 categories (Breakfast, Lunch, Dessert, Kids, Shareables, Sides) pulled live from the database",
      "New: Desktop POS layout — product grid on the left (2/3 width) with category tabs, customer search + cart + checkout on the right (1/3 width)",
      "New: Mobile POS layout — product grid with sticky bottom bar showing cart total and quick checkout access",
      "New: Transactions tab — all reporting and audit tools (Daily Summary, Recent Transactions, Pending Authorizations, Future Bookings, Overdue Payments, Failed Payments, Refunds) moved to their own dedicated tab",
      "New: Day Pass redemption scanner now built into the POS tab below the cart for quick access",
      "Improved: Financials page tabs reorganized from old layout to POS | Transactions | Subscriptions | Invoices — selling stuff is now clearly separated from reviewing what happened",
      "Improved: FinancialsTab code reduced from 2,200+ lines to ~880 lines by extracting components into dedicated files"
    ]
  },
  {
    version: "7.0.9",
    date: "2026-02-06",
    title: "Automatic Stripe Environment Validation & Fee Product Auto-Creation",
    isMajor: true,
    changes: [
      "New: Server startup now validates every stored Stripe ID (products, prices, subscriptions) against the connected Stripe environment — stale IDs from the wrong environment are automatically cleared so the system can rebuild them cleanly",
      "New: Guest Pass ($25), Day Pass - Coworking ($35), and Day Pass - Golf Sim ($50) products are now auto-created on startup — they'll always exist in whatever Stripe account the server connects to, no manual setup needed",
      "New: Simulator Overage and Corporate Volume Pricing auto-creation now works correctly after environment changes — the validation clears stale IDs first so the auto-creators detect they need to rebuild",
      "New: Transaction cache is automatically cleared when an environment change is detected, preventing test data from mixing with live data",
      "New: Clear startup warnings tell staff exactly what needs manual attention — which subscription tiers and cafe items need 'Sync to Stripe' before member signups or cafe operations will work",
      "Improved: Error messages across 9 checkout and payment endpoints now give clear, actionable instructions — subscription tiers say 'Run Sync to Stripe from Products & Pricing' and auto-created products say 'This usually resolves on server restart'",
      "Improved: Stale user subscription IDs are cleared to prevent false alarms in data integrity checks"
    ]
  },
  {
    version: "7.0.8",
    date: "2026-02-06",
    title: "Stripe Deployment Safety & Environment Indicator",
    changes: [
      "New: 'Stripe Live' or 'Stripe Test' badge now shows next to the sync buttons on the Products & Pricing page — staff can always see which Stripe environment is active",
      "New: 'Pull from Stripe' now has safety guards — if no tiers are linked to Stripe products or Stripe returns zero cafe products but your database has existing data, the pull is skipped to prevent accidental data wipe on a fresh/misconfigured Stripe account",
      "New: Server startup now checks for Stripe environment mismatches — warns if production is using test keys or development is using live keys",
      "New: Server startup checks if live Stripe account has zero products and suggests running 'Sync to Stripe' first"
    ]
  },
  {
    version: "7.0.7",
    date: "2026-02-06",
    title: "Instant Staff Notifications for Member Status Changes",
    changes: [
      "New: Staff now receive instant push + in-app notifications when a new member joins via Stripe checkout — includes member name, email, and plan",
      "New: Staff now receive instant push + in-app notifications when a new member is activated via MindBody/HubSpot — includes member name, email, and tier",
      "New: Staff now receive instant push + in-app notifications when a member's status changes to inactive (expired, cancelled, etc.) via MindBody/HubSpot",
      "New: Staff now receive instant push + in-app notifications when a member drops to non-member via MindBody — only fires for actual downgrades, not default contacts",
      "New: Staff now receive instant push + in-app notifications when a previously inactive member reactivates their Stripe subscription",
      "Improved: 'New Subscription Created' notification upgraded from in-app only to full push notification with direct link to member list"
    ]
  },
  {
    version: "7.0.61",
    date: "2026-02-06",
    title: "Smarter Product Editing & Stripe Category Tagging",
    changes: [
      "New: Stripe products now include an app_category metadata key (membership, fee, cafe, config) — enables future auto-routing of new Stripe products to the correct admin tab",
      "Improved: Editing a fee or pass product (Simulator Overage, Guest Pass, Day Passes) now shows only relevant fields — no more confusing booking limits, access permissions, or compare table sections",
      "Improved: Section title changes from 'Membership Page Card' to 'Product Details' when editing non-membership products"
    ]
  },
  {
    version: "7.0.6",
    date: "2026-02-06",
    title: "Admin Tier Editor Overhaul & Dynamic Membership Page",
    isMajor: true,
    changes: [
      "New: Tier edit modal reorganized into 3 clear sections — Membership Page Card, Stripe-Managed Settings, and Compare Table — each with descriptive helper text so staff know exactly what they're editing",
      "New: 'Show on Membership Page' toggle — control which tiers display as cards on the public membership page without changing any code",
      "New: Membership page now renders cards dynamically from the database instead of being locked to 4 hardcoded tiers — add, remove, or reorder cards from admin",
      "New: Card features (highlighted bullet points) now sync from Stripe's Marketing Feature list — edit them in Stripe Dashboard → Products → Marketing Features and they appear on the cards automatically",
      "New: Card features section shows 'Managed by Stripe' label when tier is linked, with read-only display of the actual feature text from Stripe",
      "New: Stripe customer metadata sync merged into the 'Sync to Stripe' button on Products & Pricing — no more separate button on Data Integrity page",
      "New: Reverse sync now pulls Marketing Features from Stripe products into the app's highlighted features (previously only pushed, never pulled)",
      "New: Product.updated webhook now syncs Marketing Features back immediately when edited in Stripe Dashboard",
      "Fixed: Highlighted features in the edit modal were showing internal permission labels (e.g. 'Can Book Simulators') instead of the actual customer-facing text from Stripe (e.g. 'Cafe, Bar & Patio Dining')",
      "Removed: 'Sync Stripe Metadata' button from Data Integrity page (functionality consolidated into Sync to Stripe)"
    ]
  },
  {
    version: "7.0.5",
    date: "2026-02-06",
    title: "Stripe-Managed Corporate Pricing & Family Discount",
    isMajor: true,
    changes: [
      "New: Corporate volume pricing tiers ($249–$350/seat) are now stored as Stripe product metadata — edit them in Stripe Dashboard and they sync automatically",
      "New: Family discount percentage is now read directly from the FAMILY20 Stripe coupon instead of being hardcoded — change it in Stripe and it flows to the app",
      "New: Webhook handlers for coupon updates keep the family discount in sync in real-time",
      "New: Corporate volume pricing refreshes automatically when its Stripe product metadata is updated"
    ]
  },
  {
    version: "7.0.42",
    date: "2026-02-06",
    title: "Stripe Sync Gap Fixes (Round 2)",
    changes: [
      "Fixed: Tier cache now clears immediately after syncing from Stripe — booking limits, guest pass counts, and fee calculations reflect changes instantly instead of up to 5 minutes later",
      "Fixed: Overage fee rate now uses a single centralized source — Trackman reconciliation and Stripe product setup no longer have independent copies of the $25 rate",
      "Fixed: Tier cache clears when a Stripe tier product is deleted or price changes via webhook"
    ]
  },
  {
    version: "7.0.41",
    date: "2026-02-06",
    title: "Stripe Sync Gap Fixes",
    changes: [
      "Fixed: Cafe item name, price, and category fields are now properly locked (read-only) when editing Stripe-managed items",
      "Fixed: Backend API now prevents overwriting Stripe-managed cafe fields (name, price, category) via direct API calls",
      "Fixed: Deleting Stripe-managed cafe items is now blocked — archive in Stripe Dashboard instead",
      "Fixed: Tier subscription price changes in Stripe Dashboard now automatically sync back to the app",
      "Fixed: Deleting a tier product in Stripe Dashboard now properly unlocks the tier for local editing again"
    ]
  },
  {
    version: "7.0.4",
    date: "2026-02-06",
    title: "Stripe-Driven Product Management (Reverse Sync)",
    changes: [
      "Added: 'Pull from Stripe' button on Products & Pricing page — refreshes tier permissions and cafe items from Stripe Product Catalog",
      "Added: Booking Limits and Access Permissions now show 'Managed by Stripe' labels when a tier is linked to a Stripe product",
      "Added: Booking limit fields (daily sim minutes, guest passes, booking window, conf room minutes) become read-only when managed by Stripe",
      "Added: Access permission toggles become read-only when managed by Stripe — edit in Stripe Dashboard to update",
      "Added: Cafe Menu items now show 'Managed by Stripe' notice — prices and items sync from Stripe Product Catalog",
      "Added: Automatic webhook sync — changes made in Stripe Dashboard (product updates, price changes) automatically sync to the app",
      "Added: Product.updated, product.created, product.deleted, price.updated, price.created webhook handlers for real-time Stripe sync",
      "Foundation: Stripe Product Catalog is now the source of truth for membership permissions, booking limits, and cafe items"
    ]
  },
  {
    version: "7.0.3",
    date: "2026-02-06",
    title: "Admin Navigation Consolidation",
    changes: [
      "Moved: Cafe Menu management into Products & Pricing page as a new tab — all Stripe-synced products now managed from one place",
      "Renamed: 'Stripe Config' page is now 'Products & Pricing' for clarity",
      "Moved: Training Guide from Resources section to main navigation under Directory",
      "Removed: Resources sidebar section (no longer needed)"
    ]
  },
  {
    version: "7.0.2",
    date: "2026-02-06",
    title: "Stripe Sync — Product Features & Cafe Menu",
    changes: [
      "Added: Sync to Stripe button now syncs tier permission features to Stripe Product Catalog automatically",
      "Added: Sync to Stripe button now creates cafe menu items as Stripe one-time products with prices and category metadata",
      "Added: Tier features sync creates/removes Stripe Features dynamically based on current tier permissions — no code changes needed when permissions change",
      "Added: Cafe items sync handles price changes by archiving old prices and creating new ones",
      "Added: stripeProductId and stripePriceId columns on cafe items for Stripe product tracking",
      "Foundation: Stripe becoming source of truth for product catalog — future phases will drive POS and menus from Stripe"
    ]
  },
  {
    version: "7.0.1",
    date: "2026-02-06",
    title: "Stripe Product Catalog Features Setup",
    changes: [
      "Added: 22 Stripe Product Catalog Features mirroring all membership tier permissions and limits",
      "Added: Access permission features — Can Book Simulators, Can Book Conference Room, Can Book Wellness",
      "Added: Tier benefit features — Group Lessons, Extended Sessions, Private Lessons, Simulator Guest Passes, Discounted Merch, Unlimited Access",
      "Added: Numeric limit features — Daily Sim Minutes (60/90/Unlimited), Guest Passes (4/8/15/Unlimited), Booking Window (7/10/14 days), Conference Room (60/90/Unlimited min/day)",
      "Added: All features attached to correct Stripe products — Social, Core, Premium, Corporate, VIP, Base",
      "Note: Features are informational in Stripe only — app logic unchanged, no member-facing impact"
    ]
  },
  {
    version: "7.0.0",
    date: "2026-02-06",
    title: "Record Purchase Redesign — Point-of-Sale Experience",
    isMajor: true,
    changes: [
      "Redesigned: Record Purchase card completely restructured as a point-of-sale system",
      "Added: Product selection via tappable buttons instead of dropdown — Day Pass Coworking, Day Pass Golf Sim, Guest Pass",
      "Added: Cart system with quantity controls — add multiple products and see line items with running total",
      "Added: Price is now locked to product × quantity — no manual editing of amounts",
      "Removed: Simulator Overage from purchase options (only used by fee calculator)",
      "Added: Review & Charge drawer — see all line items, subtotal, and total before charging",
      "Added: Payment method selection inside review drawer — Online Card, Card Reader (Terminal), or Cash/Check",
      "Added: Email Receipt button after successful payment — sends branded receipt with line items to the customer",
      "Improved: Layout reordered to Products → Amount → Description → Customer → Review for faster checkout flow"
    ]
  },
  {
    version: "6.9.19",
    date: "2026-02-06",
    title: "Calendar & Queue Improvements for Inactive Members",
    changes: [
      "Improved: Removed redundant amber dot from calendar cells — amber dotted outline already shows inactive membership status",
      "Fixed: Booking queue card now shows 'Charge' button with amount due instead of 'Checked In' when a checked-in booking has unpaid fees",
      "Added: 'Payment Due' status badge on queue cards for checked-in bookings that still need payment"
    ]
  },
  {
    version: "6.9.18",
    date: "2026-02-06",
    title: "Fee Calculation Fix for Non-Active Members",
    changes: [
      "Fixed: Terminated and pending members were incorrectly getting their old tier's daily allowance, showing $0.00 fees when they should be charged the full overage rate",
      "Fixed: Fee calculations now check membership status — only active, trial, and past-due members get tier benefits"
    ]
  },
  {
    version: "6.9.17",
    date: "2026-02-06",
    title: "Card Reader for Booking Payments",
    isMajor: false,
    changes: [
      "Added: Staff can now collect booking fees (overage, guest fees) using the physical card reader during check-in",
      "Added: Payment method toggle — choose between 'Online Card' or 'Card Reader' when charging booking fees",
      "Added: Card reader also works for simulator overage fee collection at check-in"
    ]
  },
  {
    version: "6.9.16",
    date: "2026-02-06",
    title: "Stripe Customer Auto-Recovery & Terminal Simulated Reader Fix",
    changes: [
      "Fixed: Payments no longer fail when a member's Stripe customer record was deleted — the system now automatically detects invalid customer IDs and creates a fresh one",
      "Fixed: Both 'Pay with Card' and 'Charge' buttons for overage fees now recover gracefully from stale Stripe data",
      "Fixed: Simulated card reader now works for testing — payments no longer fail with 'declined or canceled' because the system now auto-presents a test card on simulated readers"
    ]
  },
  {
    version: "6.9.15",
    date: "2026-02-05",
    title: "Next Payment Date Tracking & Billing Safety",
    changes: [
      "Added: Next payment date now tracked automatically from Stripe — synced from subscription creation, renewal, and updates",
      "Added: Next payment date visible in the member directory for staff",
      "Fixed: Staff can now charge booking overage fees (was blocked by an incorrect permission check)",
      "Fixed: 'Pay with Card' for booking fees (overage and guest fees) was crashing due to an undefined variable — now works correctly",
      "Fixed: Member deletion now works for all members regardless of ID format",
      "Fixed: If a system error occurs while saving a new member's subscription, the Stripe subscription is now automatically cancelled to prevent orphaned charges"
    ]
  },
  {
    version: "6.9.14",
    date: "2026-02-05",
    title: "Billing Safety & Access Control Fixes",
    isMajor: true,
    changes: [
      "Fixed: Corporate groups can now fill all purchased seats (previously the last seat was incorrectly blocked)",
      "Fixed: When a corporate group subscription is cancelled, all sub-members are properly deactivated (status set to cancelled, tier cleared) — previously they kept permanent free access",
      "Fixed: Quick Charge one-time payments no longer grant permanent active membership status — prevents users from staying active forever without a subscription",
      "Added: Archiving (removing) a member from the directory now automatically cancels their Stripe subscription so they stop being charged",
      "Improved: Permanent member deletion always cancels active subscriptions automatically (previously required a manual flag)"
    ]
  },
  {
    version: "6.9.13",
    date: "2026-02-05",
    title: "Comprehensive Member Deletion",
    changes: [
      "Fixed: Delete button now cleans ALL user data across 35+ database tables (previously only ~10)",
      "Fixed: Stripe subscriptions are now canceled before deleting the customer account",
      "Fixed: Stripe subscription pagination handles customers with many subscriptions",
      "Added: Email matching uses case-insensitive comparison on all tables",
      "Added: Cleanup covers notifications, terminal payments, billing logs, push subscriptions, linked emails, fee snapshots, and more",
      "Added: Billing groups are safely deactivated (not deleted) to protect other group members",
      "Added: Visitor deletion also comprehensively cleans all related records",
      "Added: Staff audit log entry recorded for every member/visitor deletion"
    ]
  },
  {
    version: "6.9.123",
    date: "2026-02-05",
    title: "Terminal Payment Integrity - Complete Coverage",
    changes: [
      "Added: Handler for abandoned/canceled Terminal payments with staff notification",
      "Added: Dispute resolution handling - membership reactivated when disputes are won",
      "Fixed: Payment record always created before checking if membership already active",
      "Fixed: Amount verification now validates against invoices whether paid or unpaid",
      "Fixed: Full refunds now processed correctly after partial refunds",
      "Fixed: Dispute events resilient to out-of-order webhook delivery"
    ]
  },
  {
    version: "6.9.12",
    date: "2026-02-05",
    title: "Terminal Payment Integrity & Reconciliation",
    changes: [
      "Added: Internal payment record table linking Terminal payments to subscriptions",
      "Added: Webhook handling for Terminal payment refunds - membership suspended automatically",
      "Added: Webhook handling for payment disputes - membership suspended with staff alert",
      "Added: Staff notifications when Terminal payments are refunded or disputed",
      "Enhanced: Full audit trail from payment to membership activation",
      "Security: Improved reconciliation between Stripe and internal records"
    ]
  },
  {
    version: "6.9.11",
    date: "2026-02-05",
    title: "Stripe Terminal Card Reader Support",
    isMajor: true,
    changes: [
      "Added: Card Reader payment option for in-person membership signup",
      "Staff can now tap/swipe member cards using Stripe Terminal readers",
      "Toggle between 'Enter Card' (manual) and 'Card Reader' (terminal) in payment step",
      "Create simulated readers for testing without physical hardware",
      "Full backend support: connection tokens, reader discovery, payment processing",
      "Terminal payments automatically activate membership and sync to HubSpot"
    ]
  },
  {
    version: "6.9.105",
    date: "2026-02-05",
    title: "Copy Activation Link Feature",
    changes: [
      "Added: 'Copy Link' button next to 'Send Link' when creating new members",
      "Staff can now copy activation links to clipboard for manual sharing or testing"
    ]
  },
  {
    version: "6.9.104",
    date: "2026-02-05",
    title: "Fix In-Person Payment Form for New Members",
    changes: [
      "Fixed: Inline card payment form now appears when creating new members in person",
      "Fixed: Stripe subscription creation now explicitly uses card payment collection",
      "Root cause: Stripe wasn't generating payment intent for the card form"
    ]
  },
  {
    version: "6.9.103",
    date: "2026-02-05",
    title: "Member Checkout & Activation Link Fixes",
    changes: [
      "Fixed: Activation link expiry now 23 hours (was incorrectly set to 7 days, exceeding Stripe's 24h limit)",
      "Fixed: Better error handling when payment form fails to initialize",
      "Added: Clear error message when Stripe doesn't return payment session"
    ]
  },
  {
    version: "6.9.102",
    date: "2026-02-05",
    title: "Complete Money-Flow Audit & Fixes",
    changes: [
      "Audited: 261 database queries across all Stripe/billing code paths",
      "Audited: All webhook handlers, subscription management, refund logic",
      "Verified: Dual subscription prevention in family and corporate member addition",
      "Verified: Transaction rollback on database failures",
      "Verified: Idempotency keys for payment intents prevent duplicate charges",
      "Verified: Row-level locking prevents race conditions in fee snapshots",
      "Fixed: Payment record audit logging now correctly logs member email"
    ]
  },
  {
    version: "6.9.101",
    date: "2026-02-05",
    title: "Comprehensive Audit Logging Fixes",
    changes: [
      "Fixed: 20+ broken audit log calls missing resourceName parameter across billing, bookings, wellness, events",
      "Fixed: Subscription pause/resume/cancel actions now properly recorded in Staff Activity",
      "Fixed: Booking approval and cancellation actions now properly logged",
      "Fixed: Data sync tools (HubSpot, Stripe, duplicates) now properly log all actions",
      "Added: add_corporate_member action type for group billing"
    ]
  },
  {
    version: "6.9.10",
    date: "2026-02-05",
    title: "Critical Bug Fixes",
    changes: [
      "Fixed: Stripe customer lookup query referencing non-existent column",
      "Fixed: Audit logging now works with both object and positional parameter patterns",
      "Added: Missing audit action types for subscription creation and activation links"
    ],
    isMajor: true
  },
  {
    version: "6.9.99",
    date: "2026-02-05",
    title: "Incomplete Signup Cleanup",
    changes: [
      "Fixed: Ghost 'pending' users no longer block email reuse - now shows cleanup option",
      "Added: Automatic cleanup of abandoned signups older than 24 hours (runs every 6 hours)",
      "Added: Staff can clean up incomplete signups directly from the error message",
      "Improved: Error messages now explain when an email has an incomplete signup vs an active member"
    ]
  },
  {
    version: "6.9.98",
    date: "2026-02-05",
    title: "Family Billing Data Completeness Fix",
    changes: [
      "Fixed: Family member profile info (name, phone, birthday) now properly sent when adding to family plans",
      "Fixed: addFamilyMember wrapper function now passes all profile fields correctly"
    ]
  },
  {
    version: "6.9.97",
    date: "2026-02-05",
    title: "Family Billing & Subscription Safety Fixes",
    changes: [
      "Fixed: Family members added to billing groups now automatically get user accounts created",
      "Fixed: Family billing now matches corporate billing behavior for user account creation",
      "Added: Dual subscription prevention - users with active individual subscriptions cannot be added to family/corporate plans",
      "Added: Clear error messages when attempting to add a member who already has their own subscription",
      "Verified: Past-due status already propagates correctly to sub-members when primary account fails payment"
    ]
  },
  {
    version: "6.9.96",
    date: "2026-02-05",
    title: "Notice to Members Field",
    changes: [
      "Added: Dedicated 'Note to Members' field for notices, separate from Google Calendar sync",
      "Added: 'Note to Members' text area in notice form for staff to write member-facing messages",
      "Fixed: Notice cards now display the dedicated member notice instead of raw HTML from calendar",
      "Fixed: Google Calendar descriptions now sync to Staff Notes only, not member-facing content",
      "Improved: Clear labels distinguishing member-visible content from internal staff notes"
    ]
  },
  {
    version: "6.9.95",
    date: "2026-02-05",
    title: "Comprehensive Database Column Fixes",
    changes: [
      "Fixed: 'column user_id does not exist' error when adding new members",
      "Fixed: Linked email lookups now use correct column name (primary_email instead of user_id)",
      "Fixed: All email linking operations in Trackman, staff assignment, and member creation flows",
      "Fixed: Test account cleanup now correctly references linked emails table",
      "Fixed: Stripe webhook now uses correct 'membership_status' column instead of 'status'",
      "Fixed: Notification inserts now use correct 'user_email' column instead of 'user_id'",
      "Fixed: Booking confirmation notifications in Trackman webhook and resource assignment flows"
    ]
  },
  {
    version: "6.9.94",
    date: "2026-02-05",
    title: "Database Column Fix for New Members",
    changes: [
      "Fixed: 'column dob does not exist' error when adding new members",
      "Fixed: Date of birth field now uses correct database column name in all member creation flows"
    ]
  },
  {
    version: "6.9.93",
    date: "2026-02-05",
    title: "Corporate Checkout Field Fixes",
    changes: [
      "Fixed: Last name now properly saved when purchasing corporate volume subscription",
      "Fixed: Phone number now properly saved when purchasing corporate volume subscription",
      "Fixed: HubSpot now correctly sets lifecycle stage to 'member' for new corporate subscriptions",
      "Fixed: HubSpot now correctly sets membership status to 'Active' for new corporate subscriptions"
    ]
  },
  {
    version: "6.9.92",
    date: "2026-02-05",
    title: "Corporate & Family Billing Status Propagation",
    changes: [
      "Fixed: Corporate billing reconciliation now correctly skips quantity-based groups",
      "Fixed: Past-due and unpaid statuses now propagate to all family/corporate sub-members",
      "Fixed: Sub-members are automatically reactivated when primary subscription becomes active",
      "Fixed: Metadata is now preserved when corporate subscription items are replaced during price tier changes",
      "Added: Sub-members receive notifications when group billing status changes"
    ]
  },
  {
    version: "6.9.91",
    date: "2026-02-05",
    title: "Future Bookings Visibility on Financials",
    changes: [
      "Added: 'Future Bookings' card on Financials page shows upcoming approved bookings with expected fees",
      "Added: Track guest fees and estimated charges before payment intents are created",
      "Added: Visual indicators for member tier, guest count, and payment status on each booking"
    ]
  },
  {
    version: "6.9.9",
    date: "2026-02-05",
    title: "Activation Link for New Members",
    isMajor: true,
    changes: [
      "Added: Staff can now send new members a payment setup link instead of charging them directly",
      "Added: New members receive a branded email with a secure Stripe checkout link",
      "Added: Links are valid for 7 days and guide members to set up their own payment method",
      "Added: Automatic member activation when payment is completed via activation link",
      "Fixed: Notification system now handles null values correctly for data integrity alerts",
      "Fixed: Corporate billing webhook now properly updates member tier and billing provider",
      "Fixed: HubSpot sync no longer overwrites membership status to 'non-member' for users with active Stripe subscriptions",
      "Fixed: Members with Stripe subscriptions now correctly appear only in Active tab, not Visitors",
      "Fixed: Cancelled bookings now properly clear pending fees (no more phantom charges after cancellation)"
    ]
  },
  {
    version: "6.9.83",
    date: "2026-02-05",
    title: "Staff Manual Booking Improvements",
    changes: [
      "Fixed: Duration options now adjust based on player count in staff manual booking modal",
      "Fixed: Clicking a conference room cell now opens the modal to the Conference Room tab",
      "Fixed: Conference room time slot now pre-selects based on the clicked cell",
      "Improved: Reordered fields so Player Count appears before Duration for better UX"
    ]
  },
  {
    version: "6.9.82",
    date: "2026-02-05",
    title: "Enhanced Animations & UI Polish",
    changes: [
      "Added: Touch feedback animations on booking cards, event cards, and member rows",
      "Added: Springy bounce animation when staff action button appears",
      "Added: Staggered entry animations in member profile drawer for all tabs",
      "Added: Staggered list animations on Events page and Staff Command Center",
      "Added: Smooth loading spinner transition effects for buttons",
      "Fixed: Stripe Config tab text no longer overflows on mobile screens",
      "Improved: Overall app feels more fluid and responsive to touch"
    ]
  },
  {
    version: "6.9.81",
    date: "2026-02-05",
    title: "Changelog Performance Optimization",
    changes: [
      "Improved: App Updates tab now loads 25 entries at a time instead of all at once",
      "Added: 'Load More Updates' button to progressively load older changelog entries",
      "Fixed: Changelog page performance issues caused by rendering 100+ entries simultaneously"
    ]
  },
  {
    version: "6.9.8",
    date: "2026-02-05",
    title: "Optimistic UI & Dark Mode Improvements",
    isMajor: true,
    changes: [
      "Added: Instant visual feedback when booking, cancelling, or updating throughout the app",
      "Added: Spinners and status badges show immediately when taking actions instead of waiting for server",
      "Added: Member Wellness page now shows instant feedback for class enrollment, cancellation, and waitlist operations",
      "Added: Member Events page now shows instant feedback for event RSVPs and cancellations",
      "Added: Member Dashboard now shows instant feedback for booking cancellations and invite handling",
      "Added: Staff Simulator tab now shows instant feedback for booking creation and status updates",
      "Added: Staff Events tab now shows instant feedback for event creation, updates, and RSVP management",
      "Added: Staff Directory tab now shows instant feedback for member tier updates",
      "Added: Staff Trackman tab now shows instant feedback for booking linking and unlinking",
      "Fixed: Payment forms (Stripe) now properly display in dark mode with readable labels and inputs",
      "Fixed: All payment modals (guest passes, invoices, bookings) now use consistent dark mode styling",
      "Fixed: Update notification popup now appears below the header instead of being hidden behind it",
      "Improved: Error handling now properly reverts UI state when actions fail"
    ]
  },
  {
    version: "6.9.74",
    date: "2026-02-05",
    title: "Staff Training Guide Accuracy Update",
    changes: [
      "Updated: Training guide now accurately reflects current app navigation and feature locations",
      "Fixed: Bottom navigation description corrected (Home, Bookings, Financials, Calendar, Directory)",
      "Fixed: Payment button labels now match actual UI (Charge Card on File, Pay with Card, Mark Paid)",
      "Fixed: Updates page tabs renamed to Alerts and Announce to match actual labels",
      "Fixed: Directory now correctly documented as having 4 tabs including Team",
      "Added: POS Refunds section documentation in Financials training",
      "Added: Closure Reasons subtab and member visibility toggle documentation",
      "Updated: Tour sources now correctly list website widget, HubSpot, and Google Calendar",
      "Updated: All admin section navigation paths corrected to use sidebar/hamburger menu"
    ]
  },
  {
    version: "6.9.73",
    date: "2026-02-05",
    title: "Profile Page Navigation Improvement",
    changes: [
      "Improved: Profile page now shows hamburger menu instead of back arrow for consistent navigation",
      "Improved: Staff see their Staff Portal sidebar when tapping hamburger on Profile",
      "Improved: Members see their Member Portal sidebar when tapping hamburger on Profile"
    ]
  },
  {
    version: "6.9.72",
    date: "2026-02-05",
    title: "Staff Notes for Closures & Notices",
    changes: [
      "Added: Notes field for closures and notices that syncs bidirectionally with Google Calendar event descriptions",
      "Added: Notes appear after metadata brackets in calendar events for easy reading",
      "Added: Notes display on notice cards in the Blocks tab with expandable details",
      "Improved: Notice editing now shows and preserves existing notes from calendar sync",
      "Fixed: HTML formatting from calendar descriptions is now converted to plain text"
    ]
  },
  {
    version: "6.9.71",
    date: "2026-02-05",
    title: "Improved: Staff Booking Modal Animations",
    changes: [
      "Added: Smooth horizontal slide animation when switching between Member Booking, Lesson/Staff Block, and Conference Room tabs",
      "Added: Modal height now animates smoothly when tab content changes size instead of snapping",
      "Improved: Member search dropdown now auto-scrolls into view when results appear"
    ]
  },
  {
    version: "6.9.7",
    date: "2026-02-05",
    title: "Staff Conference Room Booking",
    changes: [
      "Added: New 'Conference Room' tab in staff manual booking modal for creating conference room bookings on behalf of members",
      "Added: Date, duration (30-240 min), and available time slot selection with conflict checking",
      "Added: Real-time overage fee estimation based on member's tier and daily allowance",
      "Added: Members receive notification when staff creates a booking for them",
      "Improved: Conference Room removed from Bay dropdown in Member Booking tab to prevent confusion"
    ],
    isMajor: true
  },
  {
    version: "6.9.65",
    date: "2026-02-05",
    title: "Fixed: Admin View As Mode",
    changes: [
      "Fixed: 'View As' mode now shows the actual member's dashboard data including their bookings and schedule",
      "Fixed: 'View As' mode now shows the member's outstanding fees and balance correctly",
      "Fixed: Balance card and payment modal now work correctly when admin is viewing as a member",
      "Improved: Admins can now accurately verify what members see on their dashboards"
    ]
  },
  {
    version: "6.9.64",
    date: "2026-02-05",
    title: "Fixed: Notification Timestamps & Participant Alerts",
    changes: [
      "Fixed: Notification timestamps now correctly display in Pacific time instead of showing 8 hours ahead",
      "Fixed: Staff calendar no longer shows false '$50 owed' indicators for complete rosters",
      "Fixed: Staff calendar now correctly shows actual participant count (e.g., '3/3 slots filled') instead of erroneous estimates",
      "Added: Participants now receive 'Added to Booking' notifications when they are added to approved bookings",
      "Improved: Fee estimation now only shows for incomplete rosters; complete rosters use actual database values"
    ]
  },
  {
    version: "6.9.63",
    date: "2026-02-04",
    title: "Fixed: Booking Participant Tracking",
    changes: [
      "Fixed: Members added to booking requests from directory now properly appear on their dashboards after confirmation",
      "Fixed: Trackman notes now display actual participant names instead of placeholder text",
      "Fixed: Player slots now correctly show requested participants after booking confirmation",
      "Improved: Participant email resolution from member directory selection during booking creation"
    ]
  },
  {
    version: "6.9.62",
    date: "2026-02-04",
    title: "Improved: Corporate Checkout Contact Fields",
    changes: [
      "Added: First Name, Last Name, Email, and Phone Number fields to corporate checkout",
      "Added: All new contact fields are required before proceeding to payment",
      "Added: Email validation to ensure proper format",
      "Added: Contact info now stored in Stripe metadata for corporate memberships"
    ]
  },
  {
    version: "6.9.61",
    date: "2026-02-04",
    title: "Fixed: Corporate Membership Navigation",
    changes: [
      "Fixed: Corporate 'View Details' button now correctly navigates to the Corporate Membership page",
      "Fixed: Route ordering issue that prevented nested membership routes from rendering"
    ]
  },
  {
    version: "6.9.6",
    date: "2026-02-04",
    title: "New: Membership Application Landing Page",
    changes: [
      "Added: New standalone landing page at /membership/apply for membership applications",
      "Added: Custom-branded 2-step form with contact info and membership preferences",
      "Added: Submissions go to HubSpot and are saved locally for staff review",
      "Changed: All 'Apply' buttons on the Membership page now navigate to the new landing page",
      "Improved: Consistent design with the Private Hire inquiry page (glassmorphism, 2-step flow)"
    ]
  },
  {
    version: "6.9.5",
    date: "2026-02-04",
    title: "New: Private Hire Inquiry Landing Page",
    changes: [
      "Added: New standalone landing page at /private-hire/inquire for event inquiries",
      "Added: Custom-branded 2-step form matching HubSpot fields with updated Event Type options",
      "Added: Event types now include Private Event, Birthday, Corporate, Brand Activation, Other",
      "Added: Private Hire submissions now appear on Admin Inquiries page under 'Private Hire' tab",
      "Changed: Submit Inquiry button on Private Hire page now navigates to the new landing page",
      "Improved: Consent checkbox is now required before proceeding with the inquiry"
    ]
  },
  {
    version: "6.9.49",
    date: "2026-02-04",
    title: "Fixed: Prepayment Intents Now Created When Guests Added After Approval",
    changes: [
      "Fixed: Adding guests via roster or staff check-in now creates prepayment intent for member to pay online",
      "Fixed: Members can now prepay fees when guests are added after initial booking approval",
      "Fixed: All participant-add flows (roster, staff check-in) now trigger prepayment creation if fees exist",
      "Previously: Guests added after booking approval had fees calculated but no prepayment intent - blocking check-in with no way to pay online"
    ]
  },
  {
    version: "6.9.48",
    date: "2026-02-04",
    title: "Fixed: Booking Cards Now Show Correct Fee Estimates",
    isMajor: true,
    changes: [
      "Fixed: Booking card fee estimates now include guest fees ($25 per guest slot)",
      "Fixed: Fee estimates now correctly split time across all players (duration ÷ player count)",
      "Fixed: VIP with 1 guest now shows $25 (guest fee), not $0",
      "Fixed: Social with 1 guest (60 min) now shows $50 ($25 overage + $25 guest), not $50 (wrong calculation)",
      "Previously: Booking cards used a simplified estimate that ignored guests entirely - causing staff to see wrong amounts"
    ]
  },
  {
    version: "6.9.47",
    date: "2026-02-04",
    title: "Critical: Bookings No Longer Link to Wrong Sessions",
    isMajor: true,
    changes: [
      "Fixed: Bookings now NEVER link to sessions belonging to other members",
      "Fixed: Dev Confirm and Check-In now verify session owner matches booking member before linking",
      "Fixed: Removed dangerous 'overlapping session' matching that caused bookings to steal other members' sessions",
      "Fixed: Each booking now gets its own session with correct owner and participants",
      "Previously: A booking could link to any overlapping session on the same bay - even if owned by a different member!"
    ]
  },
  {
    version: "6.9.46",
    date: "2026-02-04",
    title: "Guest Slots Always Show $25 Fee",
    changes: [
      "Clarified: ALL guest slots show $25 fee (linked to Stripe guest fee product)",
      "Clarified: Only way to avoid $25 guest fee is: add a member with Core tier or higher, OR use a guest pass",
      "Clarified: Empty guest slots still incur fee - if you select 2 players, the second player slot is charged",
      "Business rule: Selecting 2 players = 1 guest = $25 charge regardless of whether info is filled in"
    ]
  },
  {
    version: "6.9.45",
    date: "2026-02-04",
    title: "Booking Cards Always Show Expected Fees",
    changes: [
      "Improved: Staff booking cards now always show expected fees based on member tier, even before session is created",
      "Improved: Social tier members show '~$50 Est' for 1-hour booking before session exists, then exact amount after check-in",
      "Improved: Calendar grid now shows fee indicator (red dot) for bookings where fees are expected based on tier",
      "Previously: Staff only saw 'Check In' button until session was created - now shows fees upfront"
    ]
  },
  {
    version: "6.9.44",
    date: "2026-02-04",
    title: "Dev Confirm Workflow Simplified",
    changes: [
      "Improved: Dev Confirm button now directly confirms bookings without simulating webhooks",
      "Improved: Confirmation creates session and participants directly - no fake Trackman IDs needed",
      "Technical: New clean endpoint preserves all booking details while bypassing webhook simulation"
    ]
  },
  {
    version: "6.9.43",
    date: "2026-02-04",
    title: "Fee Calculation & Check-In Stability",
    changes: [
      "Fixed: Fee calculation now uses session actual times instead of arbitrary booking durations when multiple bookings share a session",
      "Fixed: Check-in button consolidated to use single handler - eliminates conflicting success/failure messages",
      "Fixed: Check-in now properly refreshes booking lists after successful status change",
      "Improved: Data cleanup for bookings with mismatched duration values",
      "Technical: loadSessionData() now calculates duration from session start/end times with fallback to booking duration"
    ]
  },
  {
    version: "6.9.42",
    date: "2026-02-04",
    title: "Critical: Session Duration & Fee Calculation Fix",
    isMajor: true,
    changes: [
      "Fixed: Booking sessions now use EXACT time matching instead of overlap matching - prevents reusing sessions with wrong duration",
      "Fixed: Simulate confirmation now creates sessions with correct duration matching the booking request",
      "Fixed: Check-in and staff check-in contexts now use exact time matching for session lookup",
      "Fixed: Participant slot_duration now properly reflects actual booking length in ALL code paths",
      "Fixed: Staff-added participants (members and guests during check-in) now get correct slot_duration",
      "Fixed: Fee calculations now see the correct session duration for accurate overage charges",
      "Fixed: Corporate member 180-minute bookings now correctly show overage fees beyond 90-minute allowance",
      "Previously: 3-hour bookings could be linked to existing 90-minute sessions, causing $0 fee when fees should apply"
    ]
  },
  {
    version: "6.9.4",
    date: "2026-02-04",
    title: "Staff Can Charge Member's Card on File",
    isMajor: true,
    changes: [
      "New: Staff can now charge a member's saved card directly during check-in without requiring the member to enter their card",
      "New: 'Charge Card on File' button appears in check-in billing modal when member has a saved payment method",
      "New: Shows card brand and last 4 digits (e.g., 'Visa ****4242') so staff knows which card will be charged",
      "Improved: Staff can still use 'Pay with Different Card' if needed for a new payment method",
      "Technical: Uses off-session charging similar to day pass auto-charge for seamless processing"
    ]
  },
  {
    version: "6.9.39",
    date: "2026-02-04",
    title: "Critical: Booking Participants Now Saved at Approval",
    isMajor: true,
    changes: [
      "Fixed: Members and guests added during booking request are now properly converted to session participants at approval time",
      "Fixed: Booking workflow now works correctly: Member requests > adds players > staff approves > fees locked for all participants",
      "Fixed: Member participants added by email (without userId) are now properly resolved and linked",
      "Fixed: Guests who match existing member emails are automatically converted to member participants",
      "Improved: Duplicate participant detection prevents the same person being added twice",
      "Previously: Only the booking owner was created as a participant - additional players were lost at approval"
    ]
  },
  {
    version: "6.9.38",
    date: "2026-02-04",
    title: "Check-In & Fee Stability Fixes",
    changes: [
      "Fixed: Booking cancellation now properly refreshes the list instead of showing an error",
      "Fixed: Check-in button no longer shows conflicting success/failure messages",
      "Fixed: Fees are now locked in at approval time - members see the same price at check-in that they were quoted",
      "Improved: Added protection against accidental double check-ins",
      "Improved: Staff can now provide optional email when adding guests - if it matches a member, they're automatically added as a member instead"
    ]
  },
  {
    version: "6.9.37",
    date: "2026-02-03",
    title: "Assign Players Bug Fix",
    changes: [
      "Fixed: Assign players to booking feature now works correctly",
      "Fixed: SQL query generation issue when updating staff notes",
      "Improved: Better error logging for booking assignment failures"
    ]
  },
  {
    version: "6.9.36",
    date: "2026-02-03",
    title: "HubSpot Status Sync Fix",
    changes: [
      "Fixed: HubSpot membership status sync now uses valid status values",
      "Fixed: Statuses like 'Inactive' replaced with proper HubSpot options (Suspended, Expired, etc.)",
      "Improved: All app statuses now correctly map to HubSpot dropdown options"
    ]
  },
  {
    version: "6.9.35",
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
    version: "6.9.34",
    date: "2026-02-03",
    title: "MindBody Data Quality Check Improvement",
    changes: [
      "Fixed: MindBody Data Quality check now only flags active members missing a tier",
      "Fixed: Inactive members (terminated, expired, declined) no longer show in this check"
    ]
  },
  {
    version: "6.9.33",
    date: "2026-02-03",
    title: "HubSpot Billing Source Sync Improvement",
    changes: [
      "Fixed: When staff changes billing provider, membership status now syncs to HubSpot too",
      "Fixed: This ensures HubSpot reflects app's status even if MindBody shows cancelled"
    ]
  },
  {
    version: "6.9.32",
    date: "2026-02-03",
    title: "MindBody Member Billing Separation",
    changes: [
      "Changed: MindBody members can add a payment method for overage fees without requesting migration",
      "Changed: Only staff can migrate MindBody members to Stripe subscription billing",
      "Changed: Member billing messaging now focuses on overage fees, not migration"
    ]
  },
  {
    version: "6.9.31",
    date: "2026-02-03",
    title: "Account Balance in Profile Drawer",
    changes: [
      "Added: Staff can now see member account balance directly in the Directory profile drawer",
      "Added: Staff can apply credits to members from the profile drawer (no need to go to Billing tab)",
      "Fixed: HubSpot sync now sets lifecycle stage to 'member' for active members"
    ]
  },
  {
    version: "6.9.3",
    date: "2026-02-03",
    title: "Team Page Moved to Admin",
    changes: [
      "Changed: 'Team' renamed to 'Manage Team' and moved to Admin section",
      "Changed: Manage Team is now only visible to admins, not regular staff"
    ]
  },
  {
    version: "6.9.29",
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
    version: "6.9.28",
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
    version: "6.9.27",
    date: "2026-02-03",
    title: "Data Integrity Sync Fix",
    changes: [
      "Fixed: HubSpot sync push/pull now works correctly from Data Integrity page",
      "Fixed: 'issue_key is required' error no longer appears when syncing"
    ]
  },
  {
    version: "6.9.26",
    date: "2026-02-03",
    title: "Session Backfill Matches on Start Time",
    changes: [
      "Fixed: Backfill now matches sessions by start time only (not exact duration)",
      "Fixed: Bookings with different durations than actual sessions now link correctly",
      "Example: A 14:00-19:00 booking request now links to a 14:00-18:00 session"
    ]
  },
  {
    version: "6.9.25",
    date: "2026-02-03",
    title: "Session Backfill Links Existing Sessions",
    changes: [
      "Fixed: Bookings that match an existing session are now linked instead of failing",
      "Fixed: 'Double-booking' errors no longer occur - backfill finds and links to matching sessions",
      "Improved: Response shows count of newly created vs linked to existing sessions"
    ]
  },
  {
    version: "6.9.24",
    date: "2026-02-03",
    title: "Session Backfill Resilience",
    changes: [
      "Fixed: Session backfill now continues processing even when individual bookings fail",
      "Fixed: One problematic booking no longer stops the entire batch from being processed",
      "Fixed: Uses database savepoints to isolate failures and maximize successful session creation"
    ]
  },
  {
    version: "6.9.23",
    date: "2026-02-03",
    title: "Session Backfill Fix",
    changes: [
      "Fixed: 'Create Sessions' button now processes all bookings without sessions (was missing 'confirmed' status)",
      "Fixed: Session backfill now includes approved, attended, AND confirmed bookings",
      "Fixed: Preview count now matches actual bookings that will be processed"
    ]
  },
  {
    version: "6.9.22",
    date: "2026-02-03",
    title: "MindBody Member Credits Fix",
    changes: [
      "Fixed: Staff can now apply Stripe credits to MindBody-billed members",
      "Fixed: Credit application no longer restricted to Stripe-billing-only members",
      "Improved: Any member with a Stripe customer ID (or who can have one created) can now receive credits"
    ]
  },
  {
    version: "6.9.21",
    date: "2026-02-03",
    title: "Check-In Date Display Fix",
    changes: [
      "Fixed: 'Invalid Date' no longer appears in check-in billing modal for external bookings",
      "Fixed: Date formatting now properly handles ISO timestamps with timezone info",
      "Fixed: Same date parsing issue resolved across BookingMembersEditor, ManagePlayersModal, and CompleteRosterModal"
    ]
  },
  {
    version: "6.9.2",
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
    version: "6.9.1",
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
    version: "6.9.0",
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
    version: "6.8.0",
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
    version: "6.7.10",
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
    version: "6.7.9",
    date: "2026-02-03",
    title: "Stripe Subscription Tier Sync",
    changes: [
      "New: Stripe subscription changes now update HubSpot deal line items (Stripe-billed members only)",
      "New: Stripe webhook tier sync queues for retry on HubSpot failures (Stripe-billed only)",
      "Note: MindBody-billed members are unaffected - use staff tier assignment in member profile"
    ]
  },
  {
    version: "6.7.8",
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
    version: "6.7.7",
    date: "2026-02-03",
    title: "Staff Tier Assignment",
    changes: [
      "New: Staff can now assign tiers directly in the app for MindBody-billed members without a tier",
      "New: Yellow warning appears on member profile when no tier is assigned",
      "Improved: App is source of truth for tiers - removed HubSpot pull, tier changes sync from app to HubSpot"
    ]
  },
  {
    version: "6.7.6",
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
    version: "6.7.5",
    date: "2026-02-02",
    title: "Data Integrity Cleanup",
    changes: [
      "Fixed: 7 members missing tier now have tier copied from their alternate email or pulled from HubSpot",
      "Added: Script to safely pull missing tiers from HubSpot (skips unknown tiers to prevent data corruption)"
    ]
  },
  {
    version: "6.7.4",
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
    version: "6.7.3",
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
    version: "6.7.2",
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
    version: "6.7.1",
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
    version: "6.7.0",
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
    version: "6.6.4",
    date: "2026-02-02",
    title: "Safari Toolbar Color Fix",
    changes: [
      "Fixed: Safari toolbar now respects device theme mode (light bone in light mode, dark in dark mode)",
      "Preserved: Green loading screen with white mascot unchanged"
    ]
  },
  {
    version: "6.6.3",
    date: "2026-02-02",
    title: "Safari Toolbar Fix",
    changes: [
      "Fixed: Green loading screen no longer appears between page navigations (only shows on initial app startup)",
      "Fixed: Safari toolbar should no longer flash green when switching pages",
      "Improved: Page transitions are now instant without any loading overlay"
    ]
  },
  {
    version: "6.6.2",
    date: "2026-02-02",
    title: "Notification System Fixes",
    changes: [
      "Fixed: Notifications no longer reappear as unread after marking all as read and returning to the page",
      "Fixed: Wellness confirmation notifications are now automatically removed when you cancel your enrollment",
      "Improved: Cleaner notification history without stale or outdated entries"
    ]
  },
  {
    version: "6.6.1",
    date: "2026-02-02",
    title: "Member Navigation Polish",
    changes: [
      "Fixed: Removed jarring green loading screen flash when switching between tabs in member portal",
      "Improved: Bottom navigation now switches instantly between Home, Book, Wellness, Events, and History"
    ]
  },
  {
    version: "6.6.0",
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
    version: "6.5.0",
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
    version: "6.4.2",
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
    version: "6.4.1",
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
    version: "6.4.0",
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
    version: "6.3.7",
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
    version: "6.3.6",
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
    version: "6.3.5",
    date: "2026-02-02",
    title: "Private Events Display Fix",
    changes: [
      "Fixed: Private events on Updates page now show properly formatted titles instead of raw values like 'private_event'",
      "Fixed: Affected areas now display correctly (e.g., 'Bay 1, Bay 2') instead of showing raw JSON array format",
      "Improved: Snake_case notice titles are now automatically converted to Title Case for better readability"
    ]
  },
  {
    version: "6.3.4",
    date: "2026-02-01",
    title: "Directory Deletion Now Updates Immediately",
    changes: [
      "Fixed: Deleting a member or visitor from the directory now immediately refreshes the list",
      "Fixed: Previously, deleted members would still appear until page refresh - now they disappear right away"
    ]
  },
  {
    version: "6.3.3",
    date: "2026-02-01",
    title: "Member Profile Drawer UX Improvements",
    changes: [
      "Fixed: Billing tab now scrolls fully to bottom - added extra padding so all content is accessible",
      "Improved: Activity tab filters are now responsive - shows icons only on mobile, icons + text on larger screens",
      "Improved: Filter buttons have better touch targets and spacing on mobile devices"
    ]
  },
  {
    version: "6.3.2",
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
    version: "6.3.1",
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
    version: "6.3.0",
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
    version: "6.2.3",
    date: "2026-02-01",
    title: "Directory Page Scroll Improvements",
    changes: [
      "Improved: Active and Former member tabs now use full-page scrolling instead of a contained scroll area",
      "Improved: The entire page scrolls naturally based on the number of members displayed"
    ]
  },
  {
    version: "6.2.2",
    date: "2026-02-01",
    title: "Navigation Bug Fix",
    changes: [
      "Fixed: Critical navigation issue where clicking sidebar buttons on the Financials page would change the URL but not update the page content",
      "Fixed: Resolved infinite render loop in member search component that was blocking page updates",
      "Improved: Member search now correctly handles filter changes without causing performance issues"
    ]
  },
  {
    version: "6.2.1",
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
    version: "6.2.0",
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
    version: "6.1.4",
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
    version: "6.1.3",
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
    version: "6.1.2",
    date: "2026-02-01",
    title: "Bug Fixes",
    changes: [
      "Fixed: Calendar closures now load correctly on booking pages (was showing 404 error)",
      "Fixed: Trackman imports no longer create fake placeholder email addresses for unmatched bookings"
    ]
  },
  {
    version: "6.1.1",
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
    version: "6.1.0",
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
    version: "6.0.5",
    date: "2026-02-01",
    title: "Financials Page Navigation Fix",
    changes: [
      "Fixed: Navigating away from Financials page now works correctly even if data is still loading",
      "Fixed: All async data fetches in Financials tab now properly cancel when navigating away",
      "Improved: Navigation between staff portal pages is now more responsive"
    ]
  },
  {
    version: "6.0.4",
    date: "2026-02-01",
    title: "Staff Navigation Fix",
    changes: [
      "Fixed: Rapid navigation between staff portal pages now works correctly",
      "Fixed: Clicking a new page before the current one finishes loading no longer causes the page to get stuck"
    ]
  },
  {
    version: "6.0.3",
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
    version: "6.0.2",
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
    version: "6.0.1",
    date: "2026-01-31",
    title: "Staff FAB Quick Actions Stay In-Place",
    changes: [
      "Fixed: New Announcement and New Notice quick actions now open drawers directly on the command console instead of navigating away",
      "Improved: Quick actions are faster with simpler forms - just title, description, and notification toggle",
      "Note: For advanced notice options (booking blocks, affected areas), use the full Facility Notices page"
    ]
  },
  {
    version: "6.0.0",
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
    version: "5.9.3",
    date: "2026-01-31",
    title: "SimulatorTab Cleanup",
    changes: [
      "Cleanup: Removed redundant Re-scan, Auto-Match, and Notes buttons from Simulator admin",
      "Improved: Cleaner toolbar with only essential actions"
    ]
  },
  {
    version: "5.9.2",
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
    version: "5.9.1",
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
    version: "5.9.0",
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
    version: "5.8.0",
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
    version: "5.7.10",
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
    version: "5.7.9",
    date: "2026-01-30",
    title: "Auto-Cleanup Stale Billing Participants",
    changes: [
      "Fixed: Check-In & Billing modal now auto-cleans orphaned players when opened",
      "Fixed: Players removed from roster before the bug fix will now be properly removed from billing",
      "Improved: Fees recalculate automatically after stale participant cleanup"
    ]
  },
  {
    version: "5.7.8",
    date: "2026-01-30",
    title: "Bug Report Button Moved to Menu",
    changes: [
      "Moved: Report a Bug button relocated from Profile page to hamburger menu",
      "Improved: Bug reports can now be submitted from any page - just open the menu",
      "Added: Bug report button in Staff Portal sidebar for easy access"
    ]
  },
  {
    version: "5.7.7",
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
    version: "5.7.6",
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
    version: "5.7.5",
    date: "2026-01-30",
    title: "Remove Duplicate Requires Review Section",
    changes: [
      "Removed: Duplicate 'Requires Review' section from Trackman page",
      "Improved: Unmatched Bookings section now handles all review cases including private events"
    ]
  },
  {
    version: "5.7.4",
    date: "2026-01-30",
    title: "Optimistic UI for Data Integrity Fixes",
    changes: [
      "Improved: Issue counts now update immediately when fixes are applied (no waiting for refresh)",
      "Improved: Total issues counter updates in real-time as fixes complete",
      "Improved: Check status changes to 'pass' when all issues are resolved"
    ]
  },
  {
    version: "5.7.3",
    date: "2026-01-30",
    title: "Clear Orphaned Stripe IDs Tool",
    changes: [
      "Added: 'Clear Orphaned IDs' button in Data Integrity to remove Stripe customer IDs that no longer exist in Stripe",
      "Added: Preview mode shows which orphaned IDs would be cleared before executing",
      "Improved: After clearing orphaned IDs, the Data Integrity page automatically refreshes"
    ]
  },
  {
    version: "5.7.2",
    date: "2026-01-30",
    title: "Prevent Placeholder Stripe Customers",
    changes: [
      "Fixed: Stripe customers are no longer created for placeholder visitor emails (GolfNow, ClassPass, anonymous imports)",
      "Fixed: Placeholder emails like 'golfnow-YYYYMMDD-HHMM@visitors.evenhouse.club' are now excluded from Stripe",
      "Improved: This prevents orphaned Stripe customers from being created for temporary booking placeholders"
    ]
  },
  {
    version: "5.7.1",
    date: "2026-01-30",
    title: "Orphaned Stripe Customer Detection",
    changes: [
      "Improved: Data integrity now properly identifies orphaned Stripe customers (IDs in database that no longer exist in Stripe)",
      "Improved: Cleaner error messages for orphaned customers instead of scary stack traces",
      "Fixed: Stripe subscription sync check now categorizes 'customer not found' as a data quality issue"
    ]
  },
  {
    version: "5.7.0",
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
    version: "5.6.4",
    date: "2026-01-30",
    title: "Stripe Error Handling Improvements",
    changes: [
      "Fixed: Stripe subscription lookups now gracefully handle customers that no longer exist in Stripe",
      "Improved: API returns proper 404 status when a Stripe customer is not found instead of 500 error",
      "Improved: Better error messages distinguish between 'customer not found' and other Stripe errors"
    ]
  },
  {
    version: "5.6.3",
    date: "2026-01-30",
    title: "Fix Tool Endpoint Corrections",
    changes: [
      "Fixed: 'Create Sessions' button now uses correct backfill endpoint to actually create billing sessions",
      "Fixed: Preview for Active Bookings now correctly shows how many will be fixed"
    ]
  },
  {
    version: "5.6.2",
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
    version: "5.6.1",
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
    version: "5.6.0",
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
    version: "5.5.1",
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
    version: "5.5.0",
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
    version: "5.4.1",
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
    version: "5.4.0",
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
    version: "5.3.15",
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
    version: "5.3.14",
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
    version: "5.3.13",
    date: "2026-01-29",
    title: "Simplified Safari Toolbar Colors",
    changes: [
      "Simplified: All public pages now use light bone toolbar color (#F2F2EC)",
      "Simplified: Member/staff portal toolbar matches device theme (dark/light)",
      "Removed: Complex scroll-based toolbar color detection on landing page"
    ]
  },
  {
    version: "5.3.12",
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
    version: "5.3.11",
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
    version: "5.3.10",
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
    version: "5.3.9",
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
    version: "5.3.8",
    date: "2026-01-29",
    title: "Tag Display Crash Fix",
    changes: [
      "Fixed: Member profile drawer, Dashboard, and Profile pages no longer crash when viewing merged members",
      "Fixed: View As mode now works correctly for all members",
      "Fixed: Tag display across all member views now properly filters merge records"
    ]
  },
  {
    version: "5.3.7",
    date: "2026-01-29",
    title: "Private Event from Unmatched Bookings",
    changes: [
      "Fixed: Can now mark unmatched Trackman bookings as private events directly",
      "Fixed: 'Booking not found' error when converting Trackman imports that are still in review queue",
      "Improved: Private events created from unmatched bookings automatically resolve those entries"
    ]
  },
  {
    version: "5.3.6",
    date: "2026-01-29",
    title: "Staff Portal Directory Fix",
    changes: [
      "Fixed: Directory tab in Staff Portal now loads correctly",
      "Fixed: Member merge records no longer cause display errors in tag filters",
      "Technical: Added filtering for non-string entries in member tags array"
    ]
  },
  {
    version: "5.3.5",
    date: "2026-01-29",
    title: "Private Event Toast Fix",
    changes: [
      "Fixed: Marking booking as private event no longer shows duplicate toast notifications",
      "Fixed: 'Trackman booking linked to member' toast no longer appears when marking as private event"
    ]
  },
  {
    version: "5.3.4",
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
    version: "5.3.3",
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
    version: "5.3.2",
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
    version: "5.3.1",
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
    version: "5.3.0",
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
    version: "5.2.1",
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
    version: "5.2.0",
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
    version: "5.1.0",
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
    version: "5.0.3",
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
    version: "5.0.2",
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
    version: "5.0.1",
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
    version: "5.0.0",
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
    version: "4.9.7",
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
    version: "4.9.6",
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
    version: "4.9.5",
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
    version: "4.9.4",
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
    version: "4.9.3",
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
    version: "4.9.2",
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
    version: "4.9.1",
    date: "2026-01-29",
    title: "Dashboard Today's Bookings Filter",
    changes: [
      "Improved: Staff dashboard now shows only today's bookings instead of all future dates",
      "Improved: Card renamed from 'Upcoming Bookings' to 'Today's Bookings' for clarity",
      "Note: Staff can click 'View all' to see the complete booking list including future dates"
    ]
  },
  {
    version: "4.9.0",
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
    version: "4.8.1",
    date: "2026-01-28",
    title: "Calendar Quick Booking",
    changes: [
      "Added: Click empty calendar cells to open booking form with bay and time pre-filled",
      "Improved: Queue card now matches calendar height with scrollable content",
      "Improved: Floating action button positioned correctly on desktop view"
    ]
  },
  {
    version: "4.8.0",
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
    version: "4.7.6",
    date: "2026-01-28",
    title: "Same-Day Booking Fee Calculation Fix",
    changes: [
      "Fixed: Members with multiple bookings on the same day now correctly use their daily allowance on the earliest booking first",
      "Fixed: Later bookings on the same day now properly calculate overage fees based on remaining allowance",
      "Improved: Fee calculations now use start time ordering to ensure fair allocation of daily included minutes"
    ]
  },
  {
    version: "4.7.5",
    date: "2026-01-28",
    title: "Member History Bug Fix",
    changes: [
      "Fixed: Member profile drawer now correctly loads booking history, event RSVPs, and wellness enrollments",
      "Fixed: Database query error that prevented staff from viewing member activity in the Directory"
    ]
  },
  {
    version: "4.7.4",
    date: "2026-01-28",
    title: "Staff PWA Menu Shortcuts",
    changes: [
      "Updated: PWA File menu now shows staff-relevant shortcuts (Dashboard, Bookings, Financials, Directory)",
      "Fixed: Menu shortcuts now link directly to Staff Portal pages"
    ]
  },
  {
    version: "4.7.3",
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
    version: "4.7.2",
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
    version: "4.7.1",
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
    version: "4.7.0",
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
    version: "4.6.1",
    date: "2026-01-28",
    title: "Wellness Tab Mobile Crash Fix",
    changes: [
      "Fixed: Wellness tab no longer crashes on mobile when viewing classes",
      "Fixed: Classes with missing date information are now handled gracefully"
    ]
  },
  {
    version: "4.6.0",
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
    version: "4.5.3",
    date: "2026-01-28",
    title: "Stripe Webhook Fix",
    changes: [
      "Fixed: Add Funds payments now properly credit account balance",
      "Fixed: Removed duplicate Stripe webhook endpoint that was causing signature verification failures",
      "Improved: Stripe webhook reliability - all checkout session events now process correctly"
    ]
  },
  {
    version: "4.5.2",
    date: "2026-01-28",
    title: "Add Funds Balance Update Fix",
    changes: [
      "Fixed: Account balance now updates in real-time after adding funds via 'Add Funds' button",
      "Fixed: Balance notification now correctly targets the member who added funds",
      "Added: Profile page listens for billing updates to refresh balance automatically"
    ]
  },
  {
    version: "4.5.1",
    date: "2026-01-28",
    title: "Staff Profile Bottom Navigation Fix",
    changes: [
      "Fixed: Staff portal profile page no longer shows member bottom navigation on mobile",
      "Improved: Staff see clean profile page with 'Return to Staff Portal' button instead of member nav"
    ]
  },
  {
    version: "4.5.0",
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
    version: "4.4.5",
    date: "2026-01-28",
    title: "Subscription Date Display Fix",
    changes: [
      "Fixed: Membership renewal date no longer shows '1969' when subscription data is incomplete",
      "Improved: Invalid or missing renewal dates are now handled gracefully"
    ]
  },
  {
    version: "4.4.4",
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
    version: "4.4.3",
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
    version: "4.4.2",
    date: "2026-01-28",
    title: "Payment Status Display Fix",
    changes: [
      "Fixed: Collect Payment button now shows 'Paid' indicator when fees have already been collected",
      "Fixed: Financial summary now correctly excludes already-paid fees from the total",
      "Improved: Booking details accurately reflects payment status from Stripe"
    ]
  },
  {
    version: "4.4.1",
    date: "2026-01-28",
    title: "Tier Change Payment Fix",
    changes: [
      "Fixed: Tier changes now correctly charge the member's card instead of Stripe balance",
      "Fixed: Immediate tier changes properly use the customer's default payment method for proration invoices",
      "Improved: Payment method lookup tries subscription default, then customer default, then first attached card"
    ]
  },
  {
    version: "4.4.0",
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
    version: "4.3.14",
    date: "2026-01-28",
    title: "Member Profile Performance Optimization",
    changes: [
      "Improved: Member history loading is now 5-10x faster by batching database queries",
      "Improved: Member details page loads faster with parallel data fetching",
      "Fixed: Eliminated N+1 query pattern that caused slowdowns with large booking histories"
    ]
  },
  {
    version: "4.3.13",
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
    version: "4.3.12",
    date: "2026-01-28",
    title: "Improved Potential Matches Display",
    changes: [
      "Fixed: Potential Matches section now shows full Trackman booking details (date, time, bay, players)",
      "Added: Clear visual badges show Trackman booking info vs matching app bookings",
      "Improved: Easier to understand why bookings are potential matches"
    ]
  },
  {
    version: "4.3.11",
    date: "2026-01-28",
    title: "Trackman Auto-Match Badge & Concurrency Guard",
    changes: [
      "Added: Auto-matched webhooks now show blue 'Automated' badge in Trackman synced section",
      "Added: Concurrency guard prevents race conditions when multiple processes try to link same booking",
      "Changed: Badge text updated from 'Auto-Linked' to 'Automated' for clarity"
    ]
  },
  {
    version: "4.3.10",
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
    version: "4.3.9",
    date: "2026-01-28",
    title: "Fix Double Push Notifications for Booking Requests",
    changes: [
      "Fixed: Staff no longer receive duplicate push notifications when members request bookings",
      "Fixed: Removed redundant push notification call that duplicated notifyAllStaff functionality"
    ]
  },
  {
    version: "4.3.8",
    date: "2026-01-28",
    title: "Coupon Selection for New Subscriptions",
    changes: [
      "Added: Staff can now apply coupons/discounts when creating new subscriptions",
      "Added: Coupon dropdown shows all active Stripe coupons with discount details",
      "Added: Supports percentage off and fixed amount discounts with duration info"
    ]
  },
  {
    version: "4.3.7",
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
    version: "4.3.6",
    date: "2026-01-28",
    title: "Fix Trackman Webhook ON CONFLICT Syntax",
    changes: [
      "Fixed: ON CONFLICT clauses now correctly match partial unique index for booking_requests",
      "Fixed: ON CONFLICT for trackman_bay_slots now uses correct composite key",
      "Fixed: Trackman webhook booking creation/linking now works correctly in production"
    ]
  },
  {
    version: "4.3.5",
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
    version: "4.3.4",
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
    version: "4.3.3",
    date: "2026-01-28",
    title: "Persistent Sync Timestamp",
    changes: [
      "Last sync time now persists across server restarts",
      "Directory page shows accurate 'Last synced' timestamp even after deployments",
      "Uses existing app_settings table for reliable storage"
    ]
  },
  {
    version: "4.3.2",
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
    version: "4.3.1",
    date: "2026-01-28",
    title: "Roster Placeholder Guest Replacement",
    changes: [
      "Fixed: Adding members to a booking now replaces placeholder guests (Guest 2, Guest 3, etc.)",
      "Previously, adding a named member would keep placeholder guests, causing inflated participant counts",
      "Members added to roster now automatically replace any 'Guest X' placeholders"
    ]
  },
  {
    version: "4.3.0",
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
    version: "4.2.2",
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
    version: "4.2.1",
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
    version: "4.2.0",
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
    version: "4.1.0",
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
    version: "4.0.10",
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
    version: "4.0.9",
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
    version: "4.0.8",
    date: "2026-01-27",
    title: "Payment Modal Fix - Use Existing Payment Intent",
    changes: [
      "Fixed 'Failed to create payment' error - payment modals now correctly use the existing payment intent created by the API instead of trying to create a duplicate",
      "Added StripePaymentWithSecret component to accept pre-created payment intents for unified billing flow"
    ]
  },
  {
    version: "4.0.7",
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
    version: "4.0.6",
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
    version: "4.0.5",
    date: "2026-01-27",
    title: "Trackman Webhook Count Display",
    changes: [
      "Webhook events section now always shows total count (e.g. '4 webhooks received') even when there's only one page",
      "Pagination controls (Previous/Next) still only appear when there are multiple pages of results"
    ]
  },
  {
    version: "4.0.4",
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
    version: "4.0.3",
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
    version: "4.0.2",
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
    version: "4.0.1",
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
    version: "4.0.0",
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
    version: "3.9.0",
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
    version: "3.8.1",
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
    version: "3.8.0",
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
    version: "3.7.0",
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
    version: "3.6.3",
    date: "2026-01-27",
    title: "Fee Estimate Caching Fix",
    changes: [
      "Fixed: Fee estimates now refresh properly instead of returning stale cached values",
      "Fixed: Browser caching no longer causes incorrect $0 fee display for overage bookings",
      "Added: Cache-control headers to fee estimate endpoints to prevent stale responses"
    ]
  },
  {
    version: "3.6.2",
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
    version: "3.6.1",
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
    version: "3.6.0",
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
    version: "3.5.4",
    date: "2026-01-27",
    title: "Billing Modal Session Fix",
    changes: [
      "Fixed: Check-In & Billing modal now creates sessions on-the-fly for bookings without sessions",
      "Fixed: Staff can now see and charge fees for orphaned bookings that failed to create sessions",
      "Fixed: Billing modal shows correct fees instead of 'Complete Check-In' for bookings with overage"
    ]
  },
  {
    version: "3.5.3",
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
    version: "3.5.2",
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
    version: "3.5.1",
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
    version: "3.5.0",
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
    version: "3.4.5",
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
    version: "3.4.4",
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
    version: "3.4.3",
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
    version: "3.4.2",
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
    version: "3.4.1",
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
    version: "3.4.0",
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
    version: "3.3.1",
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
    version: "3.3.0",
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
    version: "3.2.11",
    date: "2026-01-27",
    title: "Improved Payment Descriptions",
    changes: [
      "UX: Payment descriptions now show readable dates (e.g., 'Jan 27, 2026' instead of '2026-01-27T08:00:00.000Z')",
      "UX: Time range displayed in 12-hour format (e.g., '8:30 AM - 12:30 PM')",
      "Clarity: Fee breakdown now shows what charges consist of (Overage, Guest fees) for Stripe and member visibility"
    ]
  },
  {
    version: "3.2.10",
    date: "2026-01-27",
    title: "Player Search Improvements",
    changes: [
      "Fixed: Player search in booking details now finds both members and past guests",
      "UX: Members appear with green badge showing their tier, guests show in gray",
      "Workflow: Selecting a member links them as a player, selecting a guest adds them as a guest"
    ]
  },
  {
    version: "3.2.9",
    date: "2026-01-27",
    title: "Check-In Page Architecture Fix",
    changes: [
      "Fixed: Viewing the check-in page no longer writes to the database (GET requests are now read-only)",
      "Improvement: Fees are now recalculated when staff takes a payment action, not when viewing",
      "Performance: Reduces unnecessary database writes and prevents potential race conditions"
    ]
  },
  {
    version: "3.2.8",
    date: "2026-01-26",
    title: "Session Backfill Payment Status Fix",
    changes: [
      "Fixed: Backfill tool now marks historical booking participants as 'paid' instead of 'pending'",
      "Prevents: Backfilled historical bookings no longer appear in Overdue Payments section",
      "Data: Uses 'external' payment method to indicate payment was handled outside the system"
    ]
  },
  {
    version: "3.2.7",
    date: "2026-01-26",
    title: "Auto-Open Billing After Assignment",
    changes: [
      "UX: Billing modal now opens automatically after assigning a member to a Trackman booking with fees",
      "Improvement: Staff can immediately mark payments as waived/paid externally for historical bookings",
      "Workflow: Prevents newly-assigned bookings from appearing as 'overdue' without review"
    ]
  },
  {
    version: "3.2.6",
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
    version: "3.2.5",
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
    version: "3.2.4",
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
    version: "3.2.3",
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
    version: "3.2.2",
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
    version: "3.2.1",
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
    version: "3.2.0",
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
    version: "3.1.2",
    date: "2026-01-26",
    title: "Trackman Sync Improvements",
    changes: [
      "Fixed: Trackman Bookings Synced accordion now shows booking details and webhook data when expanded",
      "Fixed: Trackman webhook processing now supports all booking event types (created, updated, cancelled)",
      "Added: Linked member name and auto-link status now shown in Trackman sync cards"
    ]
  },
  {
    version: "3.1.1",
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
    version: "3.1.0",
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
    version: "3.0.7",
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
    version: "3.0.6",
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
    version: "3.0.5",
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
    version: "3.0.4",
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
    version: "3.0.3",
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
    version: "3.0.2",
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
    version: "3.0.1",
    date: "2026-01-26",
    title: "Booking Request Error Fix",
    changes: [
      "Fixed: Booking requests now succeed without showing false error message",
      "Fixed: Date formatting for notifications now handles database Date objects correctly"
    ]
  },
  {
    version: "3.0.0",
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
    version: "2.9.6",
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
    version: "2.9.5",
    date: "2026-01-26",
    title: "Guest Pass Pending Request Calculation",
    changes: [
      "Fixed: Guest pass estimate now accounts for pending booking requests (conservative calculation)",
      "Fixed: Booking request error handling improved - JSON parsing more resilient",
      "Improved: API returns both actual and conservative remaining passes for accurate estimates"
    ]
  },
  {
    version: "2.9.4",
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
    version: "2.9.3",
    date: "2026-01-25",
    title: "Activity Tab & Lifetime Visits Improvements",
    changes: [
      "Fixed: Duplicate simulator bookings no longer appear in member Activity tab",
      "Fixed: Lifetime visits count now includes attended events and wellness classes (not just simulator bookings)",
      "Fixed: Member activity history displays correctly in staff directory profile drawer"
    ]
  },
  {
    version: "2.9.2",
    date: "2026-01-25",
    title: "Staff Directory Activity Tab Fix",
    changes: [
      "Fixed: Member activity history now displays correctly in staff directory profile drawer",
      "Fixed: Visit counts, booking history, event RSVPs, and wellness classes now show properly when viewing a member's profile",
      "Note: Previously the Activity tab showed 'No activity history found' due to a data formatting issue"
    ]
  },
  {
    version: "2.9.1",
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
    version: "2.9.0",
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
    version: "2.8.2",
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
    version: "2.8.1",
    date: "2026-01-25",
    title: "Booking Details Fee Calculation Fix",
    changes: [
      "Fixed: Empty player slots in Booking Details now show $25 pending fee until a member is assigned",
      "Fixed: Financial summary correctly calculates Total Due including all empty/pending slots",
      "Improved: Empty slots display 'Pending assignment - $25' fee note for staff clarity"
    ]
  },
  {
    version: "2.8.0",
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
    version: "2.7.1",
    date: "2026-01-25",
    title: "Membership Payment Labels",
    changes: [
      "Improved: Payment history now shows specific membership tier (e.g., 'Ace Membership' instead of generic 'Membership Payment')",
      "Fixed: Tier names are extracted from Stripe invoice descriptions for clearer billing history"
    ]
  },
  {
    version: "2.7.0",
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
    version: "2.6.1",
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
    version: "2.6.0",
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
    version: "2.5.0",
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
    version: "2.4.0",
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
    version: "2.3.7",
    date: "2026-01-25",
    title: "Trackman Modal Fixes",
    changes: [
      "Fixed: 'Book on Trackman' modal now correctly shows declared player count instead of always showing 1 player",
      "Fixed: Clicking pending request cells in calendar now opens the Trackman booking modal instead of the decline modal",
      "Improved: Trackman notes now include placeholder lines for all declared players (e.g., G|none|Guest|2)"
    ]
  },
  {
    version: "2.3.6",
    date: "2026-01-25",
    title: "Bay Preference Display Fix",
    changes: [
      "Fixed: Pending booking requests now correctly show the member's selected bay instead of 'any bay available'",
      "Fixed: Simulate-confirm endpoint now creates proper session and participant records for testing"
    ]
  },
  {
    version: "2.3.5",
    date: "2026-01-25",
    title: "Trackman-Only Booking Workflow",
    changes: [
      "Changed: Removed manual booking button from staff Bookings page - all simulator bookings must now go through Trackman",
      "Changed: Empty calendar slots are no longer clickable - bookings are created via member requests and confirmed by Trackman webhooks",
      "Note: Staff can still reschedule existing bookings using the Reschedule button on each booking"
    ]
  },
  {
    version: "2.3.4",
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
    version: "2.3.3",
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
    version: "2.3.2",
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
    version: "2.3.1",
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
    version: "2.3.0",
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
    version: "2.2.1",
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
    version: "2.2.0",
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
    version: "2.1.1",
    date: "2026-01-24",
    title: "Visitors Directory Pagination",
    changes: [
      "Improved: Visitors tab now shows total count of all visitors in the system",
      "Improved: Load More button to fetch additional visitors in batches of 100",
      "Improved: Better performance when browsing large visitor lists"
    ]
  },
  {
    version: "2.1.0",
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
    version: "2.0.4",
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
    version: "2.0.3",
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
    version: "2.0.2",
    date: "2026-01-24",
    title: "Real-Time Visitor Type Updates",
    changes: [
      "New: Visitor TYPE is now updated automatically when a day pass is purchased",
      "New: Visitor TYPE is now updated automatically when someone is added as a guest to a booking",
      "Technical: Created reusable updateVisitorType utility with proper type hierarchy (day_pass > guest > lead)"
    ]
  },
  {
    version: "2.0.1",
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
    version: "2.0.0",
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
    version: "1.9.1",
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
    version: "1.9.0",
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
    version: "1.8.5",
    date: "2026-01-24",
    title: "Directory List Cleanup",
    changes: [
      "Removed the fade gradients at the top and bottom of the directory list",
      "The member list now scrolls cleanly without visual obstructions"
    ]
  },
  {
    version: "1.8.4",
    date: "2026-01-24",
    title: "Queue Card Border Fix",
    changes: [
      "Fixed: Booking queue card borders no longer get cut off at the corners",
      "The swipe gesture container now properly shows the full rounded border outline"
    ]
  },
  {
    version: "1.8.3",
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
    version: "1.8.2",
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
    version: "1.8.1",
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
    version: "1.8.0",
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
    version: "1.7.2",
    date: "2026-01-24",
    title: "Facility Status Display Fix",
    changes: [
      "Fixed: Facility Status was incorrectly showing future bookings (e.g., Jan 28) as currently occupied",
      "Bays now only show as 'Booked' when there is an active booking for TODAY at the current time",
      "This was a display-only issue - member booking availability was not affected"
    ]
  },
  {
    version: "1.7.1",
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
    version: "1.7.0",
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
    version: "1.6.2",
    date: "2026-01-24",
    title: "Stripe Webhook Reliability Fixes",
    changes: [
      "Fixed: Payment status now consistent between API and webhooks (was 'used' vs 'completed')",
      "Fixed: Failed webhook operations now trigger Stripe retry (was silently failing)",
      "Payments are now more reliable and won't get stuck in 'processing' state"
    ]
  },
  {
    version: "1.6.1",
    date: "2026-01-24",
    title: "Fix Trackman Resolve Booking",
    changes: [
      "Fixed: Resolve booking now works - was looking for wrong parameter name",
      "Staff can now successfully assign unmatched Trackman bookings to members or visitors"
    ]
  },
  {
    version: "1.6.0",
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
    version: "1.5.3",
    date: "2026-01-24",
    title: "Trackman Rescan & Member Search Fix",
    changes: [
      "Fixed Rescan button in Trackman tab - now properly attempts to auto-match unmatched bookings",
      "Fixed member search when resolving unmatched bookings - now finds both current and former members",
      "Search now queries the database in real-time for more accurate results"
    ]
  },
  {
    version: "1.5.2",
    date: "2026-01-24",
    title: "Unmatched Bookings List Restored",
    changes: [
      "Fixed unmatched bookings list showing 0 - now correctly displays CSV import bookings needing member assignment",
      "Unmatched bookings can be resolved directly from the import screen",
      "Original name and email from CSV now displayed for easier identification"
    ]
  },
  {
    version: "1.5.1",
    date: "2026-01-24",
    title: "Tappable Booking Cards & Timezone Fix",
    changes: [
      "Booking cards are now tappable - tap anywhere on the card to open booking details (no more separate Edit button)",
      "Fixed 'Last event' timestamp in Trackman sync section - now shows correct Pacific timezone"
    ]
  },
  {
    version: "1.5.0",
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
    version: "1.4.16",
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
    version: "1.4.15",
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
    version: "1.4.14",
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
    version: "1.4.13",
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
    version: "1.4.12",
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
    version: "1.4.11",
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
    version: "1.4.10",
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
    version: "1.4.9",
    date: "2026-01-23",
    title: "Streamlined Unmatched Booking Flow",
    changes: [
      "Clicking amber (unassigned) bookings on the calendar now opens 'Assign Member' directly",
      "Staff no longer need to go through Booking Details first to assign a member",
      "After assigning a member, the cell turns green and Booking Details becomes accessible"
    ]
  },
  {
    version: "1.4.8",
    date: "2026-01-23",
    title: "Unified Assign Member Experience",
    changes: [
      "Consolidated member assignment into a single modal for consistency across all screens",
      "Staff Dashboard, Booking Details, and Webhook Events now all use the same assignment flow",
      "Simplified codebase by removing duplicate modal components"
    ]
  },
  {
    version: "1.4.7",
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
    version: "1.4.6",
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
    version: "1.4.5",
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
    version: "1.4.4",
    date: "2026-01-23",
    title: "CSRF Protection Removed",
    changes: [
      "Removed CSRF token validation that was causing login and form submission failures",
      "Modern browser security (SameSite cookies, CORS) already provides this protection",
      "All 'CSRF failed' errors across the app are now permanently resolved"
    ]
  },
  {
    version: "1.4.3",
    date: "2026-01-23",
    title: "UI Polish: Dark Mode & Rounded Corners",
    changes: [
      "Fixed skeleton loaders showing light gray in dark mode - now properly shows dark colors",
      "Added rounded corners to Directory page search bar and table header for consistent look",
      "All loading states now automatically adapt to light and dark themes"
    ]
  },
  {
    version: "1.4.2",
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
    version: "1.4.1",
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
    version: "1.4.0",
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
    version: "1.3.1",
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
    version: "1.3.0",
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
    version: "1.2.2",
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
    version: "1.2.1",
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
    version: "1.2.0",
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
    version: "1.1.6",
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
    version: "1.1.5",
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
    version: "1.1.4",
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
    version: "1.1.3",
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
    version: "1.1.2",
    date: "2026-01-10",
    title: "Reliability & Token Refresh",
    changes: [
      "Fixed HubSpot and Google Calendar token expiration issues",
      "Tokens now refresh proactively before they expire",
      "Improved connection reliability for external integrations"
    ]
  },
  {
    version: "1.1.1",
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
    version: "1.1.0",
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
    version: "1.0.4",
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
    version: "1.0.3",
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
    version: "1.0.2",
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
    version: "1.0.1",
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
    version: "1.0.0",
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
    version: "0.9.0",
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
    version: "0.8.0",
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
    version: "0.7.3",
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
    version: "0.7.2",
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
    version: "0.7.1",
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
    version: "0.7.0",
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
    version: "0.6.0",
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
    version: "0.5.0",
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
    version: "0.4.0",
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
    version: "0.3.0",
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
    version: "0.2.0",
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
    version: "0.1.0",
    date: "2025-12-16",
    title: "Launch Day",
    isMajor: true,
    changes: [
      "The app is live! Built from the ground up for Ever Club members",
      "Book golf bays and conference rooms with real-time availability",
      "Membership tiers with guest passes and booking limits",
      "Connected to HubSpot so your membership info stays in sync"
    ]
  }
];

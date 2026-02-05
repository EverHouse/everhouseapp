import { Router } from 'express';
import { db } from '../db';
import { trainingSections } from '../../shared/schema';
import { eq, asc, and } from 'drizzle-orm';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';

const router = Router();

interface TrainingStep {
  title: string;
  content: string;
  imageUrl?: string;
  pageIcon?: string;
}

// Seed data for training sections - guideId is a stable identifier for upsert logic
export const TRAINING_SEED_DATA = [
  {
    guideId: 'getting-started',
    icon: 'home',
    title: 'Getting Started',
    description: 'Learn how to navigate the Staff Portal',
    sortOrder: 1,
    isAdminOnly: false,
    steps: [
      { title: 'Access the Staff Portal', content: 'Log in with your staff credentials. After logging in, you will be automatically directed to the Staff Portal Command Center.', pageIcon: 'admin_panel_settings' },
      { title: 'Command Center Overview', content: 'The Home dashboard is your command center. It shows pending booking requests, today\'s schedule, facility status, upcoming tours, and recent activity at a glance.', pageIcon: 'home' },
      { title: 'Bottom Navigation', content: 'Use the bottom navigation bar to quickly access the main sections: Home, Bookings, Financials, Calendar, and Directory.', pageIcon: 'menu' },
      { title: 'Updates (Header Icon)', content: 'The megaphone/campaign icon in the header takes you to the Updates page where you can view your activity notifications and manage member announcements.', pageIcon: 'campaign' },
      { title: 'Mobile Hamburger Menu', content: 'On mobile, tap the hamburger menu (three lines) in the top left to access all navigation items including: Dashboard, Bookings, Financials, Tours, Calendar, Facility, Updates, Directory, Resources (Cafe, Training Guide), and Admin settings (Stripe Config, Manage Team, Gallery, FAQs, Inquiries, Bug Reports, Changelog, Data Integrity).', pageIcon: 'menu' },
      { title: 'Profile Access', content: 'Tap your avatar in the top right to access your profile, where you can manage push notifications and set up a password for faster login.', pageIcon: 'person' },
      { title: 'Sidebar Navigation', content: 'On larger screens (desktop/tablet), the sidebar provides quick access to all main sections plus Facility/Notices for managing closures and announcements.' },
    ]
  },
  {
    guideId: 'booking-requests',
    icon: 'event_note',
    title: 'Managing Booking Requests',
    description: 'Handle simulator and conference room bookings with Trackman integration',
    sortOrder: 2,
    isAdminOnly: false,
    steps: [
      { title: 'Booking Workflow Overview', content: 'Members submit booking requests (status: Pending). Staff reviews requests in the Bookings tab, books the slot in the Trackman portal, then Trackman webhooks automatically confirm and link the booking.', pageIcon: 'event_note' },
      { title: 'Pending Requests', content: 'The Bookings tab shows all pending requests at the top. Each card displays the member name, requested date, time, duration, and any notes they included.' },
      { title: 'Book in Trackman', content: 'After reviewing a request, go to the Trackman booking portal and create the booking there. Make sure the email and time match the request.' },
      { title: 'Automatic Confirmation', content: 'When you book in Trackman, a webhook is sent to the app which automatically confirms the booking and links it. The status changes from Pending (yellow) to Confirmed (blue).' },
      { title: 'Calendar Grid Colors', content: 'Yellow = Pending (awaiting confirmation). Blue = Approved/Confirmed (linked to Trackman). Green = Attended (checked in). Red = Declined/Cancelled. Orange = No Show. Gray = Expired.' },
      { title: 'Unmatched Bookings', content: 'When a Trackman webhook email doesn\'t match any member, the booking appears with a "Needs Assignment" badge in Today\'s Bookings. Tap "Assign Member" to search and connect it to the correct member.' },
      { title: 'Remember Email Feature', content: 'When linking an unmatched booking, check "Remember this email" to save the association. Future bookings from that email will auto-match to the member.' },
      { title: 'Manual Booking', content: 'The floating action button (+) lets you create a manual booking for walk-ins or phone reservations. Enter the member, bay, date, time, and booking source.' },
      { title: 'Decline with Notes', content: 'If you need to decline a request, add staff notes explaining why. The member will be notified and can see the reason.' },
      { title: 'Guardian Consent for Minors', content: 'When a member under 18 makes a booking, the system requires guardian consent. Staff will see a consent form that captures guardian name, relationship, and phone number before the booking can proceed.' },
    ]
  },
  {
    guideId: 'multi-member-bookings',
    icon: 'group_add',
    title: 'Managing Players & Guests',
    description: 'Add players and guests to bookings, manage the roster',
    sortOrder: 3,
    isAdminOnly: false,
    steps: [
      { title: 'Opening the Manage Players Modal', content: 'Look for the "X/Y Players" button on any booking card. This shows current players vs total slots. Tap it to open the Manage Players modal.', pageIcon: 'group_add' },
      { title: 'Booking Owner', content: 'The Owner (booking holder) appears at the top of the roster and cannot be removed. This is the member who made the booking.' },
      { title: 'Player Slots', content: 'Empty slots appear as dashed boxes with an "ADD Player" button. The number of slots is determined by the player count set when the booking was made.' },
      { title: 'Adding Members', content: 'Tap "ADD Player" to search for club members by name or email. When you select a member, they are immediately added to the booking.' },
      { title: 'Adding Guests', content: 'To add a non-member guest, use the guest option. You\'ll need to provide the guest\'s name and email (required for billing purposes).' },
      { title: 'Guest Pass Status', content: 'Green badge = Member has guest passes available, no fee charged. Blue badge = No passes remaining, $25 guest fee applies.' },
      { title: 'Roster Status Bar', content: 'Green status bar = all player slots are filled and ready. Amber status bar = slots still unfilled, needs attention before check-in.' },
      { title: 'Check-In Requirement', content: 'Check-in is disabled until all player slots are filled. This ensures accurate billing for all participants.' },
      { title: 'Removing Players', content: 'Tap the X button on any non-owner player to remove them from the booking. Guests can be removed the same way.' },
      { title: 'Time Split', content: 'Simulator time is divided equally among all participants. For example, a 60-minute booking with 3 players gives each person 20 minutes of allocated time.' },
    ]
  },
  {
    guideId: 'checkin-billing',
    icon: 'point_of_sale',
    title: 'Check-In & Billing',
    description: 'Check in bookings and handle payments',
    sortOrder: 4,
    isAdminOnly: false,
    steps: [
      { title: 'Starting Check-In', content: 'When a member arrives for their booking, tap the check-in button on the booking card. This opens the billing screen.', pageIcon: 'point_of_sale' },
      { title: 'Complete Roster First', content: 'Check-in is disabled until all player slots are filled. If the roster is incomplete, you\'ll see a prompt to add the remaining players before proceeding.' },
      { title: 'Understanding the Fee Breakdown', content: 'The billing screen shows each person on the booking with their individual fees. Color-coded badges help you quickly see what type of fee applies.' },
      { title: 'Orange Badge = Time Overage', content: 'An orange badge means the person exceeded their daily time allowance and owes an overage fee ($25 per extra 30-minute block).' },
      { title: 'Blue Badge = Guest Fee', content: 'A blue badge indicates a flat $25 guest fee for bringing a non-member who doesn\'t have a guest pass covering them.' },
      { title: 'Green Badge = Guest Pass Used', content: 'A green badge means the member used one of their monthly guest passes, so no guest fee is charged for that guest.' },
      { title: 'Tier & Allowance Info', content: 'Each person\'s row shows their membership tier and how much daily time they have left. This helps explain why overage fees apply.' },
      { title: 'Confirming Payments', content: 'You can mark individual payments as paid, or confirm all at once. Use "Waive" if a fee should be forgiven (you must enter a reason).' },
      { title: 'Payment Methods', content: 'Payment options include: "Charge Card on File" (use the member\'s saved card), "Pay with Card" (enter a new card), "Mark Paid (Cash/External)" (record cash or external payment), or "Waive All Fees" (forgive fees with a required reason). All payments are tracked for daily reconciliation.' },
      { title: 'Payment Audit Trail', content: 'All payment actions are logged with your name and timestamp for accountability.' },
    ]
  },
  {
    guideId: 'financials-page',
    icon: 'payments',
    title: 'Financials Page',
    description: 'Process payments, view subscriptions, and manage invoices',
    sortOrder: 5,
    isAdminOnly: false,
    steps: [
      { title: 'Access Financials', content: 'Go to the Financials tab from the bottom navigation. This is your hub for all payment-related activities.', pageIcon: 'payments' },
      { title: 'Three Main Tabs', content: 'The Financials page has three tabs: POS (Point of Sale for daily transactions including Record Purchase, Redeem Pass, Pending Authorizations, Overdue Payments, Failed Payments, Refunds, and Recent Transactions), Subscriptions (member billing), and Invoices (payment history).' },
      { title: 'POS: Record Purchase', content: 'Charge a member for merchandise, guest fees, or custom amounts. Search for the member, enter the amount and description, and select card or cash payment.' },
      { title: 'POS: Redeem Pass', content: 'Scan a QR code or manually enter a pass ID to redeem day passes. The system validates the pass and marks it as used.' },
      { title: 'POS: Overdue Payments', content: 'Shows bookings from the last 30 days with unpaid balances. Tap any item to open the check-in billing modal and collect the outstanding amount.' },
      { title: 'POS: Recent Transactions', content: 'A live feed of all recent payments showing member name, amount, type, and timestamp. Use this to verify transactions.' },
      { title: 'POS: Daily Summary', content: 'Shows today\'s totals broken down by payment type: guest fees, overage fees, merchandise, membership payments, cash collected, check payments, and other.' },
      { title: 'POS: Failed Payments', content: 'Payments that failed to process appear here. You can retry the charge or mark it as manually collected if the member paid another way.' },
      { title: 'POS: Pending Authorizations', content: 'Card holds that are awaiting capture. These are pre-authorized amounts that haven\'t been finalized yet.' },
      { title: 'POS: Refunds', content: 'Process full or partial refunds for payments made in the last 30 days. Select a payment, choose full or partial refund, enter amount (if partial), select a reason, and confirm.' },
      { title: 'Subscriptions Tab', content: 'View all active Stripe subscriptions. See member name, plan, amount, status, and next billing date. Filter by status: all, active, past_due, or canceled. You can also sync subscriptions from Stripe to update the local database.' },
      { title: 'Invoices Tab', content: 'View all Stripe invoices. Filter by status: all, paid, open, or uncollectible. You can also filter by date range. Download PDF receipts or open the Stripe-hosted invoice page.' },
      { title: 'Payment Failure Handling', content: 'When a membership payment fails, the system automatically sets the member to "past due" status, starts a grace period, and notifies both the member and staff. Members in past due status are flagged in their profile.' },
      { title: 'Grace Period', content: 'After a payment failure, members enter a 3-day grace period. During this time they can update their payment method. Staff are notified and can assist with payment recovery if needed.' },
    ]
  },
  {
    guideId: 'billing-providers',
    icon: 'account_balance',
    title: 'Billing Providers',
    description: 'Understand member billing sources and how to manage them',
    sortOrder: 6,
    isAdminOnly: false,
    steps: [
      { title: 'What is a Billing Provider?', content: 'Each member has a billing provider that determines how their subscription and payments are managed. This is shown in the member\'s Billing tab.', pageIcon: 'account_balance' },
      { title: 'Stripe (Primary)', content: 'Stripe is our primary billing system. Members with Stripe billing have their subscriptions, payments, and invoices fully managed in the app. You can pause, cancel, or change their tier directly.' },
      { title: 'MindBody (Legacy)', content: 'Some legacy members have billing managed externally through MindBody. The app only handles one-off charges like guest fees. Subscription changes must be made in MindBody.' },
      { title: 'Family Add-on', content: 'Members who are part of a family or corporate group are billed under the primary payer\'s subscription. Their individual billing tab shows who the primary payer is.' },
      { title: 'Comped', content: 'Complimentary members have full access but are not billed. This is used for staff, VIP guests, or promotional memberships.' },
      { title: 'Viewing Billing Provider', content: 'Open a member\'s profile from the Directory, then go to the Billing tab. The billing provider is shown at the top with a badge.' },
      { title: 'Changing Billing Provider', content: 'Admins can change a member\'s billing provider from the Billing tab. Be careful: switching providers doesn\'t automatically migrate subscription data.' },
      { title: 'Stripe Member Controls', content: 'For Stripe members, you can: view subscription details, pause billing, apply discounts, change membership tier, cancel subscription, and apply account credits.' },
      { title: 'MindBody Member View', content: 'For MindBody members, billing information is read-only. You\'ll see a note indicating billing is managed externally.' },
    ]
  },
  {
    guideId: 'tours',
    icon: 'directions_walk',
    title: 'Tours',
    description: 'View and manage scheduled facility tours',
    sortOrder: 7,
    isAdminOnly: false,
    steps: [
      { title: 'Access Tours', content: 'Go to the Tours tab from the sidebar or hamburger menu to view all scheduled facility tours.', pageIcon: 'directions_walk' },
      { title: 'Today\'s Tours', content: 'The top section shows tours scheduled for today with the guest name, scheduled time, and current status.' },
      { title: 'Upcoming Tours', content: 'Below today\'s tours, you can see all upcoming scheduled tours organized by date.' },
      { title: 'Tour Sources', content: 'Tours come from multiple sources: the booking widget on the website, HubSpot meeting scheduler, and Google Calendar sync (Tours Scheduled calendar).' },
      { title: 'Past Tours', content: 'Use the "Show Past" toggle at the top to view past tours for reference and follow-up.' },
      { title: 'Tour Status', content: 'Update the tour status as needed: Scheduled (upcoming), Pending, Checked In, Completed (attended), Cancelled, or No Show.' },
      { title: 'Tour Notifications', content: 'Staff receive notifications when new tours are scheduled. Daily reminder emails are sent at 6pm for the next day\'s tours.' },
    ]
  },
  {
    guideId: 'facility-closures',
    icon: 'notifications',
    title: 'Notices (Facility)',
    description: 'Schedule notices and facility closures',
    sortOrder: 8,
    isAdminOnly: false,
    steps: [
      { title: 'Access Notices', content: 'Go to Facility from the sidebar or hamburger menu to manage facility notices and closures.', pageIcon: 'notifications' },
      { title: 'Three Subtabs', content: 'The Notices page has three subtabs: Closures (for blocking booking availability), Closure Reasons (predefined reasons for closures), and Notices (informational announcements).' },
      { title: 'Card Colors Explained', content: 'RED cards are closures that block bookings. CYAN cards are closure drafts that need review. AMBER cards are informational notices that don\'t affect booking availability.' },
      { title: 'Needs Review Section', content: 'Closures synced from Google Calendar without complete configuration show with a cyan border and "Needs Review" status. Tap to configure which resources are blocked.' },
      { title: 'Configuring Draft Notices', content: 'Tap a notice in "Needs Review" to configure which resources are blocked: specific Bays, Conference Room, Entire Facility, or None (informational only).' },
      { title: 'Informational Only', content: 'Setting visibility to "Informational Only" makes the notice amber. It shows up for members but doesn\'t block any bookings.' },
      { title: 'Blocking Resources', content: 'Selecting specific bays, conference room, or entire facility turns the card red and prevents members from booking those resources during the notice period.' },
      { title: 'Create a Notice', content: 'Click the + button to create a new notice. Fill in the title, dates, times (optional), and select which areas are affected.' },
      { title: 'Accordion View', content: 'Each notice displays as an expandable card. Tap to expand and see affected resources and internal notes. Use the edit button to make changes.' },
      { title: 'Color Updates Instantly', content: 'The card color changes immediately when you modify affected areas. Red means booking restrictions are active.' },
      { title: 'Automatic Sync', content: 'Notices sync to the internal Google Calendar. Blocked areas automatically prevent member bookings during the specified times.' },
      { title: 'Filter & Search', content: 'Use the filter dropdown to view specific areas, date picker to find notices for a date, and "Show Past" toggle to see historical notices.' },
      { title: 'Member Visibility', content: 'Toggle "Member Visibility" when creating notices to control whether members see the notice in their app or if it\'s internal staff-only.' },
    ]
  },
  {
    guideId: 'events-wellness',
    icon: 'calendar_month',
    title: 'Events, Wellness & Blocks',
    description: 'Manage events, wellness classes, and availability blocks',
    sortOrder: 9,
    isAdminOnly: false,
    steps: [
      { title: 'Access the Calendar', content: 'Go to the Calendar tab to view and manage events, wellness classes, and availability blocks.', pageIcon: 'calendar_month' },
      { title: 'Three Main Tabs', content: 'Use the tabs to switch between Events (member events), Wellness (classes like yoga, pilates), and Blocks (resource availability).' },
      { title: 'Calendar Status', content: 'At the top of the page, tap "Calendar Status" to see which Google Calendars are connected and their sync status.' },
      { title: 'Needs Review Items', content: 'Events or classes synced from Google Calendar may show a "Needs Review" flag. This happens when instructor is missing, category is unclear, or conflicts are detected.' },
      { title: 'Resolving Needs Review', content: 'Tap any item marked "Needs Review" to fill in missing info like instructor name, category, or spots available. You can also dismiss the review or apply the fix to all similar items.' },
      { title: 'Sync with Eventbrite', content: 'Click the Eventbrite sync button to pull in member events from your Eventbrite organization.' },
      { title: 'Sync with Google Calendar', content: 'Click the Google Calendar sync button to sync events and wellness classes with the designated calendars.' },
      { title: 'Create Manual Events', content: 'Use the + button to add a new event, wellness class, or availability block. Fill in title, date, time, location, and description.' },
      { title: 'View RSVPs & Enrollments', content: 'Click on an event or class to see who has RSVP\'d or enrolled. You can also manually add attendees.' },
      { title: 'Availability Blocks', content: 'In the Blocks tab, create time blocks to mark resources as unavailable. Choose types: Maintenance, Private Event, Staff Hold, Wellness, or Other.' },
      { title: 'Blocks by Day', content: 'Blocks are grouped by date. Tap a day header to expand and see all blocks for that day. Each block shows the resource, time range, and type.' },
    ]
  },
  {
    guideId: 'updates-announcements',
    icon: 'campaign',
    title: 'Updates & Announcements',
    description: 'Create announcements and view activity',
    sortOrder: 10,
    isAdminOnly: false,
    steps: [
      { title: 'Access Updates', content: 'Click the megaphone/campaign icon in the header to go to the Updates page.', pageIcon: 'campaign' },
      { title: 'Alerts Tab', content: 'The Alerts tab shows your staff notifications - new booking requests, check-in reminders, system alerts, and other activity relevant to your role.' },
      { title: 'Mark as Read', content: 'Click "Mark all as read" to clear unread notifications, or tap individual notifications to mark them read. Use "Dismiss all" to permanently remove all notifications.' },
      { title: 'Announce Tab', content: 'Switch to the Announce tab to create and manage announcements that members will see in their feed.' },
      { title: 'Create an Announcement', content: 'Click the + button to create a new announcement. Enter a title and description for your message.' },
      { title: 'Push Notification Toggle', content: 'Toggle "Send push notification to all members" to send an instant alert to everyone. Use sparingly for important club-wide announcements.' },
      { title: 'Homepage Banner', content: 'Toggle "Show as Homepage Banner" to display the announcement prominently on the member dashboard. Great for promotions or urgent notices.' },
      { title: 'Scheduled Visibility', content: 'Set start and end dates to control when announcements are visible. Use this to pre-schedule announcements for future events or promotions.' },
      { title: 'Link Destination', content: 'Add a link to direct members to a specific page: Events, Wellness, Book Golf, or an External URL. This helps drive member action.' },
      { title: 'Edit or Delete', content: 'Tap any existing announcement to edit it. Use the trash icon to delete outdated notices.' },
    ]
  },
  {
    guideId: 'member-directory',
    icon: 'groups',
    title: 'Member Directory',
    description: 'Search and view member and visitor profiles',
    sortOrder: 11,
    isAdminOnly: false,
    steps: [
      { title: 'Access Directory', content: 'Go to Directory from the bottom navigation, sidebar, or the hamburger menu on mobile.', pageIcon: 'groups' },
      { title: 'Four Directory Tabs', content: 'The directory has four tabs: Active (current paying members), Former (cancelled or expired memberships), Visitors (non-members), and Team (staff and admin accounts).' },
      { title: 'Active Members', content: 'The Active tab shows all current members with active subscriptions. These are your paying club members.' },
      { title: 'Former Members', content: 'The Former tab shows members who have cancelled or whose memberships have expired. Useful for win-back outreach.' },
      { title: 'Visitors Tab', content: 'Visitors are non-members who have interacted with the club. Types include: ClassPass users, Sim Walk-Ins, Private Lesson attendees, Day Pass buyers, Guests, and Leads.' },
      { title: 'Search', content: 'Use the search bar to find people by name, email, phone, or tier. Type "founding" to find founding members.' },
      { title: 'Filter by Tier', content: 'Use the tier filter buttons (All, Social, Core, Premium, Corporate, VIP, etc.) to narrow down the list.' },
      { title: 'Member Profile Drawer', content: 'Tap a member to open their profile drawer with tabs for: Overview (contact info, tier, tags), History (bookings, events, wellness), Billing, and Staff Notes.' },
      { title: 'Billing Tab', content: 'The Billing tab shows the member\'s billing provider and subscription details. For Stripe members, you can pause, apply discounts, change tier, or cancel the subscription.' },
      { title: 'Booking History', content: 'In the History tab, view all member bookings and mark them as Attended or No Show directly from the profile.' },
      { title: 'View As Member (Admin Only)', content: 'Admins can tap "View As" to see the app from a member\'s perspective. A banner shows when viewing as another member. Exit by tapping the banner.' },
      { title: 'Privacy Controls', content: 'Members can access Privacy settings from their Profile. This includes options to opt out of data sharing (CCPA compliant) and request a data export.' },
    ]
  },
  {
    guideId: 'inquiries',
    icon: 'mail',
    title: 'Inquiries',
    description: 'Manage form submissions (Admin only)',
    sortOrder: 12,
    isAdminOnly: true,
    steps: [
      { title: 'Access Inquiries', content: 'Go to Inquiries from the Admin section of the sidebar or hamburger menu.', pageIcon: 'mail' },
      { title: 'Filter by Type', content: 'Use the filter buttons to view specific form types: Contact, Tour Request, Membership Inquiry, Private Hire, or Guest Check-in.' },
      { title: 'Filter by Status', content: 'Filter by status: New (unread), Read, Replied, or Archived.' },
      { title: 'View Submission Details', content: 'Tap an inquiry to expand and see the full submission details including contact info and message.' },
      { title: 'Add Staff Notes', content: 'Add internal notes to track follow-up actions or important details about the inquiry.' },
      { title: 'Update Status', content: 'Mark inquiries as Read, Replied, or Archived to keep track of which ones need attention.' },
    ]
  },
  {
    guideId: 'cafe-menu',
    icon: 'local_cafe',
    title: 'Cafe Menu',
    description: 'Update menu items and prices',
    sortOrder: 13,
    isAdminOnly: false,
    steps: [
      { title: 'Access Cafe Menu', content: 'Go to Cafe Menu from the Resources section of the sidebar or hamburger menu.', pageIcon: 'local_cafe' },
      { title: 'Add Menu Items', content: 'Tap "Add Item" to create a new menu item. Fill in the name, description, price, and category.' },
      { title: 'Categories', content: 'Organize items into categories like Drinks, Bites, Cocktails, etc. for easy browsing by members.' },
      { title: 'Upload Images', content: 'Add images to menu items by tapping the image upload button. Images are automatically optimized for web.' },
      { title: 'Edit or Remove', content: 'Tap the edit icon to update an item, or the delete icon to remove it from the menu.' },
    ]
  },
  {
    guideId: 'gallery',
    icon: 'photo_library',
    title: 'Gallery',
    description: 'Manage venue photos (Admin only)',
    sortOrder: 14,
    isAdminOnly: true,
    steps: [
      { title: 'Access Gallery', content: 'Go to Gallery from the Admin section of the sidebar or hamburger menu.', pageIcon: 'photo_library' },
      { title: 'Add Photos', content: 'Tap "Add Photo" and upload an image. Images are automatically converted to WebP format and optimized for web.' },
      { title: 'Set Category', content: 'Assign photos to categories (e.g., Interior, Events, Golf Bays) for organization on the public gallery.' },
      { title: 'Reorder Photos', content: 'Use the sort order field to control the display order of photos within each category.' },
      { title: 'Activate/Deactivate', content: 'Toggle photos active or inactive to show or hide them from the public gallery without deleting.' },
    ]
  },
  {
    guideId: 'faqs',
    icon: 'help_outline',
    title: 'FAQs',
    description: 'Edit frequently asked questions (Admin only)',
    sortOrder: 15,
    isAdminOnly: true,
    steps: [
      { title: 'Access FAQs', content: 'Go to FAQs from the Admin section of the sidebar or hamburger menu.', pageIcon: 'help_outline' },
      { title: 'Add New FAQ', content: 'Tap "Add FAQ" to create a new question and answer for the public FAQ page.' },
      { title: 'Edit Existing', content: 'Tap the edit button on any FAQ to update the question or answer text.' },
      { title: 'Reorder', content: 'Adjust the sort order to control which FAQs appear first on the public page.' },
      { title: 'Delete', content: 'Remove outdated FAQs by tapping the delete button.' },
    ]
  },
  {
    guideId: 'team-access',
    icon: 'shield_person',
    title: 'Manage Team',
    description: 'Manage staff and admin accounts',
    sortOrder: 16,
    isAdminOnly: true,
    steps: [
      { title: 'Access Manage Team', content: 'Go to Manage Team from the Admin section of the sidebar or hamburger menu. This is admin-only.', pageIcon: 'shield_person' },
      { title: 'Staff vs Admins', content: 'Use the tabs to switch between managing Staff accounts and Admin accounts.' },
      { title: 'Add Team Member', content: 'Click "Add" and enter their email, name, and job title. They will receive a login email.' },
      { title: 'Activate/Deactivate', content: 'Toggle accounts active or inactive to grant or revoke access without deleting the account.' },
      { title: 'Edit Details', content: 'Update team member information like name, phone, or job title as needed.' },
    ]
  },
  {
    guideId: 'membership-tiers',
    icon: 'loyalty',
    title: 'Membership Tiers',
    description: 'Configure tier settings and permissions',
    sortOrder: 17,
    isAdminOnly: true,
    steps: [
      { title: 'Access Stripe Config', content: 'Go to Stripe Config from the Admin section of the sidebar or hamburger menu. This controls membership tier settings and Stripe integration.', pageIcon: 'loyalty' },
      { title: 'Edit Tier Settings', content: 'Click on a tier to edit its name, description, price, and marketing copy. Changes take effect immediately for all members on that tier.' },
      { title: 'Booking Limits', content: 'Set daily simulator minutes, conference room minutes, and advance booking window for each tier. Members cannot exceed these limits.' },
      { title: 'Guest Passes', content: 'Configure how many guest passes members receive per month for each tier. Passes reset on the 1st of each month.' },
      { title: 'Access Permissions', content: 'Toggle which features each tier can access: simulator booking, conference room, extended sessions, events, and more. Denied access hides those options from members.' },
      { title: 'Highlighted Features', content: 'Edit the bullet points that appear on the membership comparison page. These are shown to prospective members during signup.' },
      { title: 'Test with View As', content: 'After changing tier settings, use View As Member in the Directory to verify the member experience. This confirms booking limits and access permissions work as expected.' },
    ]
  },
  {
    guideId: 'team-directory',
    icon: 'badge',
    title: 'Team Directory',
    description: 'View staff and admin contact info',
    sortOrder: 18,
    isAdminOnly: false,
    steps: [
      { title: 'Access Team Directory', content: 'Go to the Directory from the bottom navigation, then tap the Team tab to view staff and admin contacts.', pageIcon: 'badge' },
      { title: 'View Team Members', content: 'See all active staff and admin team members with their names, job titles, and profile photos.' },
      { title: 'Contact Information', content: 'Tap a team member to view their phone number and email for quick contact.' },
      { title: 'Different from Manage Team', content: 'This directory is read-only for viewing contact info. Admins who need to manage accounts should use Manage Team in Admin Settings.' },
    ]
  },
  {
    guideId: 'trackman-import',
    icon: 'upload_file',
    title: 'Trackman Import',
    description: 'Import historical booking data (Admin only)',
    sortOrder: 19,
    isAdminOnly: true,
    steps: [
      { title: 'Access Trackman Import', content: 'Trackman Import is accessed from the Bookings tab. Look for the import/upload section when managing bookings. This is admin-only.', pageIcon: 'upload_file' },
      { title: 'Upload CSV File', content: 'Upload the Trackman booking export CSV file. The system will parse dates, times, durations, and email addresses.' },
      { title: 'Automatic Matching', content: 'The system automatically matches Trackman emails to existing members. If an email doesn\'t match, it\'s added to the Unmatched list.' },
      { title: 'Resolve Unmatched', content: 'For unmatched bookings, search and select the correct member. The system learns this mapping for future imports.' },
      { title: 'Batch Resolution', content: 'When you resolve one unmatched booking, all other bookings with the same email are automatically matched.' },
      { title: 'Review Matched', content: 'Use the Matched Bookings section to review and correct any incorrectly matched bookings. You can reassign to a different member if needed.' },
    ]
  },
  {
    guideId: 'bug-reports',
    icon: 'bug_report',
    title: 'Bug Reports',
    description: 'View and manage reported issues (Admin only)',
    sortOrder: 20,
    isAdminOnly: true,
    steps: [
      { title: 'Access Bug Reports', content: 'Go to Bug Reports from the Admin section of the sidebar or hamburger menu.', pageIcon: 'bug_report' },
      { title: 'View Reports', content: 'See all bug reports submitted by members and staff, including screenshots if attached.' },
      { title: 'Report Details', content: 'Each report shows the description, reporter, date submitted, and current status (Open, In Progress, Resolved).' },
      { title: 'Update Status', content: 'Change the status as you work on issues. Mark as "In Progress" when investigating, and "Resolved" when fixed.' },
      { title: 'Member Visibility', content: 'Members can see the status of their own reports from their Profile page, so keep statuses updated.' },
    ]
  },
  {
    guideId: 'changelog',
    icon: 'history',
    title: 'Changelog',
    description: 'View app updates and changes (Admin only)',
    sortOrder: 21,
    isAdminOnly: true,
    steps: [
      { title: 'Access Changelog', content: 'Go to the Changelog from the sidebar/hamburger menu under Admin settings to view all app updates.', pageIcon: 'history' },
      { title: 'View Updates', content: 'See a chronological list of all app updates, newest first. Major releases are highlighted.' },
      { title: 'What\'s Included', content: 'Each version shows the date, a title summarizing the update, and a list of changes in plain language.' },
      { title: 'Staff Activity Feed', content: 'Below the changelog, you can see a live feed of staff activity including booking actions, payment processing, and member updates.' },
      { title: 'Share with Staff', content: 'Use this to stay informed about new features and share updates with your team during meetings.' },
    ]
  },
];

// Function to seed training sections with upsert logic (exported for use in startup)
// Updates existing guides by guideId, inserts new ones, preserves custom guides
// Also handles migration of old records without guideIds by matching title
export async function seedTrainingSections() {
  const existing = await db.select().from(trainingSections);
  
  // Build maps for matching: by guideId (preferred) and by title (fallback for migration)
  const existingByGuideId = new Map(
    existing.filter(s => s.guideId).map(s => [s.guideId, s])
  );
  const existingByTitle = new Map(
    existing.filter(s => !s.guideId).map(s => [s.title, s])
  );
  
  let updated = 0;
  let inserted = 0;
  let migrated = 0;
  
  for (const seedData of TRAINING_SEED_DATA) {
    // First try to find by guideId
    let existingSection = existingByGuideId.get(seedData.guideId);
    
    // Fallback: if no guideId match, try matching by title (for migration)
    if (!existingSection) {
      existingSection = existingByTitle.get(seedData.title);
    }
    
    if (existingSection) {
      // Check if we need to add guideId (migration case)
      const needsGuideId = !existingSection.guideId;
      
      // Check if content differs
      const needsContentUpdate = 
        existingSection.icon !== seedData.icon ||
        existingSection.title !== seedData.title ||
        existingSection.description !== seedData.description ||
        existingSection.sortOrder !== seedData.sortOrder ||
        existingSection.isAdminOnly !== seedData.isAdminOnly ||
        JSON.stringify(existingSection.steps) !== JSON.stringify(seedData.steps);
      
      if (needsGuideId || needsContentUpdate) {
        await db.update(trainingSections)
          .set({
            guideId: seedData.guideId,
            icon: seedData.icon,
            title: seedData.title,
            description: seedData.description,
            steps: seedData.steps,
            sortOrder: seedData.sortOrder,
            isAdminOnly: seedData.isAdminOnly,
            updatedAt: new Date(),
          })
          .where(eq(trainingSections.id, existingSection.id));
        if (needsGuideId) migrated++;
        else updated++;
      }
    } else {
      // Insert new section
      await db.insert(trainingSections).values(seedData);
      inserted++;
    }
  }
  
  console.log(`[Training] Seed complete: ${updated} updated, ${inserted} inserted, ${migrated} migrated`);
}

router.get('/api/training-sections', isStaffOrAdmin, async (req, res) => {
  try {
    const userRole = getSessionUser(req)?.role;
    const isAdminUser = userRole === 'admin';
    
    let result;
    if (isAdminUser) {
      result = await db.select().from(trainingSections)
        .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
    } else {
      result = await db.select().from(trainingSections)
        .where(eq(trainingSections.isAdminOnly, false))
        .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
    }
    
    // Auto-seed if empty (handles production where auto-seed doesn't run)
    if (result.length === 0) {
      console.log('[Training] No sections found, auto-seeding...');
      try {
        await seedTrainingSections();
        // Re-fetch after seeding
        if (isAdminUser) {
          result = await db.select().from(trainingSections)
            .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
        } else {
          result = await db.select().from(trainingSections)
            .where(eq(trainingSections.isAdminOnly, false))
            .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
        }
        console.log(`[Training] Auto-seeded ${result.length} sections`);
      } catch (seedError) {
        console.error('[Training] Auto-seed failed:', seedError);
      }
    }
    
    res.json(result);
  } catch (error: any) {
    console.error('Training sections fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch training sections' });
  }
});

router.post('/api/admin/training-sections', isAdmin, async (req, res) => {
  try {
    const { icon, title, description, steps, isAdminOnly, sortOrder } = req.body;
    
    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }
    
    const [newSection] = await db.insert(trainingSections).values({
      icon: icon || 'help_outline',
      title,
      description,
      steps: steps || [],
      isAdminOnly: isAdminOnly ?? false,
      sortOrder: sortOrder ?? 0,
    }).returning();
    
    res.status(201).json(newSection);
  } catch (error: any) {
    console.error('Training section creation error:', error);
    res.status(500).json({ error: 'Failed to create training section' });
  }
});

router.put('/api/admin/training-sections/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { icon, title, description, steps, isAdminOnly, sortOrder } = req.body;
    
    const [updated] = await db.update(trainingSections)
      .set({
        ...(icon !== undefined && { icon }),
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(steps !== undefined && { steps }),
        ...(isAdminOnly !== undefined && { isAdminOnly }),
        ...(sortOrder !== undefined && { sortOrder }),
        updatedAt: new Date(),
      })
      .where(eq(trainingSections.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Training section not found' });
    }
    
    res.json(updated);
  } catch (error: any) {
    console.error('Training section update error:', error);
    res.status(500).json({ error: 'Failed to update training section' });
  }
});

router.delete('/api/admin/training-sections/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [deleted] = await db.delete(trainingSections)
      .where(eq(trainingSections.id, parseInt(id)))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Training section not found' });
    }
    
    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error('Training section deletion error:', error);
    res.status(500).json({ error: 'Failed to delete training section' });
  }
});

// Seed training content (uses shared TRAINING_SEED_DATA constant)
router.post('/api/admin/training-sections/seed', isAdmin, async (req, res) => {
  try {
    await seedTrainingSections();
    
    const insertedSections = await db.select().from(trainingSections)
      .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
    
    res.status(201).json({ 
      success: true, 
      message: `Seeded ${insertedSections.length} training sections`,
      sections: insertedSections 
    });
  } catch (error: any) {
    console.error('Training seed error:', error);
    res.status(500).json({ error: 'Failed to seed training sections' });
  }
});

export default router;

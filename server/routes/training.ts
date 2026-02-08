import { Router } from 'express';
import { db } from '../db';
import { trainingSections } from '../../shared/schema';
import { eq, asc, and, max } from 'drizzle-orm';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { PRICING } from '../core/billing/pricingConfig';

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
      { title: 'Mobile Hamburger Menu', content: 'On mobile, tap the hamburger menu (three lines) in the top left to access all navigation items including: Dashboard, Bookings, Financials, Tours, Calendar, Facility, Updates, Directory, Training Guide, and Admin settings (Products & Pricing, Manage Team, Gallery, FAQs, Inquiries, Bug Reports, Changelog, Data Integrity).', pageIcon: 'menu' },
      { title: 'Profile Access', content: 'Tap your avatar in the top right to access your profile, where you can manage push notifications and set up a password for faster login.', pageIcon: 'person' },
      { title: 'Sidebar Navigation', content: 'On larger screens (desktop/tablet), the sidebar provides quick access to all main sections plus Facility/Notices for managing closures and announcements.' },
      { title: 'Google Sign-In', content: 'Members can sign in with their Google account instead of waiting for an email code. If their Google email matches a known member email (including alternate emails), they are automatically connected to their existing account.', pageIcon: 'login' },
      { title: 'Linking Google Account', content: 'Members can link or unlink their Google account from Profile > Connected Accounts. This lets them use Google Sign-In for faster access in the future.', pageIcon: 'link' },
    ]
  },
  {
    guideId: 'staff-fab',
    icon: 'add_circle',
    title: 'Staff Quick Actions (FAB)',
    description: 'Use the floating action button for common staff tasks',
    sortOrder: 2,
    isAdminOnly: false,
    steps: [
      { title: 'Floating Action Button', content: 'The floating action button (+) in the bottom-right corner of the screen gives you quick access to the most common staff actions. Tap it to see five options.', pageIcon: 'add_circle' },
      { title: 'New User', content: 'Opens the registration drawer where you can add a new member, visitor, or sub-member. Fill in their details (or scan their ID to auto-fill) and submit.', pageIcon: 'person_add' },
      { title: 'Announcement', content: 'Quick-create an announcement for all members. Enter a title and message, optionally send a push notification or set it as a homepage banner.', pageIcon: 'campaign' },
      { title: 'New Notice', content: 'Create a facility notice or closure directly from the FAB. Set the title, dates, affected areas, and member visibility without navigating to the Facility page.', pageIcon: 'notifications' },
      { title: 'Manual Booking', content: 'Create a manual booking for walk-ins or phone reservations. Select the member, choose a bay, pick the date and time, and set the booking source.', pageIcon: 'edit_calendar' },
      { title: 'QR Scanner', content: 'Scan a member\'s QR code to record a walk-in check-in. This logs a visit without needing a booking — useful for members who just drop in to use the facility.', pageIcon: 'qr_code_scanner' },
    ]
  },
  {
    guideId: 'id-scanning',
    icon: 'badge',
    title: 'ID & License Scanning',
    description: 'Scan IDs to auto-fill member registration and verify identity',
    sortOrder: 3,
    isAdminOnly: false,
    steps: [
      { title: 'Where to Find It', content: 'ID scanning is available from the New User drawer when registering members, visitors, or sub-members. It is also available in the POS Register when adding a new customer, and from the member profile drawer if you need to re-scan or update an ID on file.', pageIcon: 'badge' },
      { title: 'How to Scan', content: 'Tap "Scan ID" to open the camera. A guide overlay (similar to a banking app) helps you position the ID correctly within the frame. Hold the ID steady and tap capture.', pageIcon: 'photo_camera' },
      { title: 'File Upload Option', content: 'If the camera is not working or you already have a photo of the ID, tap "Upload Photo" instead. You can select an existing image from your device.', pageIcon: 'upload_file' },
      { title: 'AI Auto-Fill', content: 'After capturing the image, the system uses AI to read the ID and automatically fills in the person\'s name, date of birth, and address (street, city, state, zip). This saves time and reduces manual entry errors.', pageIcon: 'auto_fix_high' },
      { title: 'Quality Feedback', content: 'If the image is blurry, too dark, has glare, or is partially obscured, you will see a warning with suggestions for improvement. You can retake the photo to get a better result.', pageIcon: 'warning' },
      { title: 'Review & Confirm', content: 'After scanning, review the extracted information before tapping "Use This Info" to fill the form. You can always edit the fields manually afterward if anything needs correction.', pageIcon: 'fact_check' },
      { title: 'ID Image Storage', content: 'The scanned ID image is saved on the member\'s record for future reference. Staff can view it later from the member profile drawer in the Directory.', pageIcon: 'save' },
      { title: 'Viewing Stored IDs', content: 'In the member profile drawer (Directory), staff can see the "ID on File" section. From there you can view the ID image full-size, re-scan with a new ID, or remove the image.', pageIcon: 'visibility' },
      { title: 'POS Register', content: 'When processing a new customer at the register, tap "Scan ID" to quickly fill in their info before checkout. This works the same way as scanning during registration.', pageIcon: 'point_of_sale' },
    ]
  },
  {
    guideId: 'qr-checkin',
    icon: 'qr_code_scanner',
    title: 'QR Code Check-In',
    description: 'Scan member QR codes for booking and walk-in check-ins',
    sortOrder: 4,
    isAdminOnly: false,
    steps: [
      { title: 'Two Types of QR Check-In', content: 'There are two ways to use QR check-in: Booking check-in (checking in a member at a scheduled session) and Walk-in check-in (no booking needed, just records a visit to the facility).', pageIcon: 'qr_code_scanner' },
      { title: 'Walk-In QR Check-In', content: 'Open the QR scanner from the floating action button (+). Scan the member\'s QR code. A confirmation popup shows the member\'s name, tier, status, and any pinned staff notes. The visit is automatically recorded in the system.', pageIcon: 'login' },
      { title: 'Where Members Find Their QR Code', content: 'Members tap their membership card on the dashboard to show their QR code. They can present it at the front desk for quick check-in.', pageIcon: 'credit_card' },
      { title: 'Confirmation Popup', content: 'After scanning, a brief modal shows the member\'s name, tier, and any pinned staff notes. It auto-dismisses after a few seconds. Status warnings appear in amber for cancelled, suspended, or inactive members.', pageIcon: 'check_circle' },
      { title: 'Duplicate Scan Protection', content: 'If the same member is scanned twice within 2 minutes, you will see a friendly "already checked in" message instead of an error. This prevents accidental duplicate check-ins.', pageIcon: 'shield' },
      { title: 'Visit Tracking', content: 'Walk-in check-ins automatically count toward the member\'s lifetime visits. Visit counts are displayed on the membership card, in the staff profile drawer, and in the member directory. Visits also sync to HubSpot.', pageIcon: 'trending_up' },
    ]
  },
  {
    guideId: 'booking-requests',
    icon: 'event_note',
    title: 'Managing Booking Requests',
    description: 'Handle simulator and conference room bookings with Trackman integration',
    sortOrder: 5,
    isAdminOnly: false,
    steps: [
      { title: 'Booking Workflow Overview', content: 'Members submit booking requests (status: Pending). Staff reviews requests in the Bookings tab, books the slot in the Trackman portal, then Trackman webhooks automatically confirm and link the booking.', pageIcon: 'event_note' },
      { title: 'Pending Requests', content: 'The Bookings tab shows all pending requests at the top. Each card displays the member name, requested date, time, duration, and any notes they included.' },
      { title: 'Book in Trackman', content: 'After reviewing a request, go to the Trackman booking portal and create the booking there. Make sure the email and time match the request.' },
      { title: 'Automatic Confirmation', content: 'When you book in Trackman, a webhook is sent to the app which automatically confirms the booking and links it. The status changes from Pending (yellow) to Confirmed (green).' },
      { title: 'Booking Status Colors', content: 'Yellow = Pending (awaiting confirmation). Green = Approved, Confirmed, or Attended (linked to Trackman or checked in). Red = Declined, Cancelled, or No Show. Gray = Expired.' },
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
    sortOrder: 6,
    isAdminOnly: false,
    steps: [
      { title: 'Opening the Manage Players Modal', content: 'Look for the "X/Y Players" button on any booking card. This shows current players vs total slots. Tap it to open the Manage Players modal.', pageIcon: 'group_add' },
      { title: 'Booking Owner', content: 'The Owner (booking holder) appears at the top of the roster and cannot be removed. This is the member who made the booking.' },
      { title: 'Player Slots', content: 'Empty slots appear as dashed boxes with an "ADD Player" button. The number of slots is determined by the player count set when the booking was made.' },
      { title: 'Adding Members', content: 'Tap "ADD Player" to search for club members by name or email. When you select a member, they are immediately added to the booking.' },
      { title: 'Adding Guests', content: 'To add a non-member guest, use the guest option. You\'ll need to provide the guest\'s name and email (required for billing purposes).' },
      { title: 'Guest Pass Status', content: `Green badge = Member has guest passes available, no fee charged. Blue badge = No passes remaining, $${PRICING.GUEST_FEE_DOLLARS} guest fee applies.` },
      { title: 'Roster Status Bar', content: 'Green status bar = all player slots are filled and ready. Amber status bar = slots still unfilled, needs attention before check-in.' },
      { title: 'Check-In Requirement', content: 'Check-in is disabled until all player slots are filled. This ensures accurate billing for all participants.' },
      { title: 'Removing Players', content: 'Tap the X button on any non-owner player to remove them from the booking. Guests can be removed the same way.' },
      { title: 'Time Split', content: 'Simulator time is divided equally among all participants. For example, a 60-minute booking with 3 players gives each person 20 minutes of allocated time.' },
    ]
  },
  {
    guideId: 'booking-reschedule',
    icon: 'event_repeat',
    title: 'Booking Reschedule',
    description: 'Move bookings to a different bay or time slot',
    sortOrder: 7,
    isAdminOnly: false,
    steps: [
      { title: 'When to Reschedule', content: 'Use reschedule when a member needs to move their booking to a different bay, date, or time. The member\'s roster, guest passes, and booking details stay intact.', pageIcon: 'event_repeat' },
      { title: 'Start Reschedule', content: 'Open the booking details modal for any upcoming simulator booking. Tap the "Reschedule" button to begin.', pageIcon: 'edit_calendar' },
      { title: 'Pick New Slot', content: 'Select the new bay, date, and time for the booking. The system checks for conflicts and shows a warning if the new slot has a different duration (which may affect fees).', pageIcon: 'calendar_month' },
      { title: 'Create in Trackman', content: 'After picking the new slot, go to the Trackman portal and create the booking there. Then delete the old Trackman booking. Paste the new Trackman booking ID to confirm the reschedule.', pageIcon: 'link' },
      { title: 'Automatic Notifications', content: 'The member receives a "Booking Rescheduled" notification and email with the new bay, date, and time. They will not see a confusing cancellation notice.', pageIcon: 'notifications' },
      { title: 'Fee Handling', content: 'Any unpaid prepayment charges from the original booking are automatically voided after the reschedule. New fees will be calculated based on the updated time slot.', pageIcon: 'payments' },
      { title: 'Auto-Clear Hold', content: 'If a reschedule is started but never completed (for example, you get interrupted), the system automatically clears the hold after 30 minutes so the booking does not get stuck.', pageIcon: 'timer' },
    ]
  },
  {
    guideId: 'checkin-billing',
    icon: 'point_of_sale',
    title: 'Check-In & Billing',
    description: 'Check in bookings and handle payments',
    sortOrder: 8,
    isAdminOnly: false,
    steps: [
      { title: 'Starting Check-In', content: 'When a member arrives for their booking, tap the check-in button on the booking card. This opens the billing screen.', pageIcon: 'point_of_sale' },
      { title: 'Complete Roster First', content: 'Check-in is disabled until all player slots are filled. If the roster is incomplete, you\'ll see a prompt to add the remaining players before proceeding.' },
      { title: 'Understanding the Fee Breakdown', content: 'The billing screen shows each person on the booking with their individual fees. Color-coded badges help you quickly see what type of fee applies.' },
      { title: 'Orange Badge = Time Overage', content: `An orange badge means the person exceeded their daily time allowance and owes an overage fee ($${PRICING.OVERAGE_RATE_DOLLARS} per extra ${PRICING.OVERAGE_BLOCK_MINUTES}-minute block).` },
      { title: 'Blue Badge = Guest Fee', content: `A blue badge indicates a flat $${PRICING.GUEST_FEE_DOLLARS} guest fee for bringing a non-member who doesn't have a guest pass covering them.` },
      { title: 'Green Badge = Guest Pass Used', content: 'A green badge means the member used one of their monthly guest passes, so no guest fee is charged for that guest.' },
      { title: 'Tier & Allowance Info', content: 'Each person\'s row shows their membership tier and how much daily time they have left. This helps explain why overage fees apply.' },
      { title: 'Confirming Payments', content: 'You can mark individual payments as paid, or confirm all at once. Use "Waive" if a fee should be forgiven (you must enter a reason).' },
      { title: 'Payment Methods', content: 'Payment options include: "Charge Card on File" (use the member\'s saved card), "Pay with Card" (enter a new card), "Mark Paid (Cash/External)" (record cash or external payment), or "Waive All Fees" (forgive fees with a required reason). All payments are tracked for daily reconciliation.' },
      { title: 'Payment Audit Trail', content: 'All payment actions are logged with your name and timestamp for accountability.' },
      { title: 'Prepayment', content: 'After a booking is approved or linked to Trackman, the member receives a prepayment request for expected fees (overage, guests). Members can pay from their dashboard. Check-in is blocked until fees are paid. If the booking is cancelled, any prepayment is automatically refunded.', pageIcon: 'payment' },
    ]
  },
  {
    guideId: 'card-reader',
    icon: 'contactless',
    title: 'Card Reader (Stripe Terminal)',
    description: 'Accept in-person card payments with a physical reader',
    sortOrder: 9,
    isAdminOnly: false,
    steps: [
      { title: 'What is the Card Reader?', content: 'The card reader is a physical device (WisePOS E or S700) that lets staff accept tap, swipe, or chip payments in person. It connects to Stripe Terminal for secure processing.', pageIcon: 'contactless' },
      { title: 'Where It\'s Used', content: 'Card reader payments are available during: new member signup (as an alternative to online card entry), booking check-in (to collect overage or guest fees), and POS register checkout.', pageIcon: 'point_of_sale' },
      { title: 'How to Use', content: 'When you see a payment screen, look for the "Card Reader" option (sometimes shown as a toggle between "Online Card" and "Card Reader"). Select it, and the reader will activate and prompt the customer to tap, insert, or swipe their card.', pageIcon: 'credit_card' },
      { title: 'Default at Check-In', content: 'Card Reader is the default payment method in the booking check-in billing screen. You can switch to online card if needed.', pageIcon: 'toggle_on' },
      { title: 'Card on File', content: 'If a customer has a saved card in Stripe, you will also see a "Card on File" option showing their card brand and last 4 digits. Tap it to charge instantly without needing the reader.', pageIcon: 'credit_card' },
      { title: 'Reusing Incomplete Charges', content: 'If a member started an online payment but did not finish, you can collect that same charge on the card reader instead of creating a duplicate. The system detects and reuses the pending charge.', pageIcon: 'sync' },
    ]
  },
  {
    guideId: 'financials-page',
    icon: 'payments',
    title: 'Financials Page',
    description: 'Process payments, view subscriptions, and manage invoices',
    sortOrder: 10,
    isAdminOnly: false,
    steps: [
      { title: 'Access Financials', content: 'Go to the Financials tab from the bottom navigation. This is your hub for all payment-related activities.', pageIcon: 'payments' },
      { title: 'Four Main Tabs', content: 'The Financials page has four tabs: POS (Point of Sale for the register, cart checkout, and pass redemption), Transactions (recent payments, daily summary, overdue payments, failed payments, pending authorizations, and refunds), Subscriptions (member billing), and Invoices (payment history).' },
      { title: 'POS: Record Purchase', content: 'Charge a member for merchandise, guest fees, or custom amounts. Search for the member, enter the amount and description, and select card or cash payment.' },
      { title: 'POS: Redeem Pass', content: 'Scan a QR code or manually enter a pass ID to redeem day passes. The system validates the pass and marks it as used.' },
      { title: 'POS: Register (New Customer)', content: 'Staff can process new walk-in customers at the register. Tap "Add Customer" to fill in their details, or tap "Scan ID" to auto-fill from a driver\'s license. Complete the purchase with card payment.', pageIcon: 'person_add' },
      { title: 'Transactions: Recent Payments', content: 'The Transactions tab shows a live feed of all recent payments (member name, amount, type, and timestamp) plus a daily summary broken down by payment type: guest fees, overage fees, merchandise, membership payments, cash collected, check payments, and other.' },
      { title: 'Transactions: Overdue Payments', content: 'Shows bookings from the last 30 days with unpaid balances. Tap any item to open the check-in billing modal and collect the outstanding amount.' },
      { title: 'Transactions: Failed Payments', content: 'Payments that failed to process appear here. You can retry the charge or mark it as manually collected if the member paid another way.' },
      { title: 'Transactions: Pending Authorizations', content: 'Card holds that are awaiting capture. These are pre-authorized amounts that haven\'t been finalized yet.' },
      { title: 'Transactions: Refunds', content: 'Process full or partial refunds for payments made in the last 30 days. Select a payment, choose full or partial refund, enter amount (if partial), select a reason, and confirm.' },
      { title: 'Dynamic Pricing', content: 'All prices (guest fees, overage rates, day pass prices) come directly from Stripe. If prices change in Stripe, they update automatically in the app. There is no need to update prices manually in the staff portal.', pageIcon: 'sync' },
      { title: 'Subscriptions Tab', content: 'View all active Stripe subscriptions. See member name, plan, amount, status, and next billing date. Filter by status: all, active, past_due, or canceled. You can also sync subscriptions from Stripe to update the local database.' },
      { title: 'Invoices Tab', content: 'View all Stripe invoices. Filter by status: all, paid, open, or uncollectible. You can also filter by date range. Download PDF receipts or open the Stripe-hosted invoice page.' },
      { title: 'Payment Failure Handling', content: 'When a membership payment fails, the system automatically sets the member to "past due" status, starts a grace period, and notifies both the member and staff. Members in past due status are flagged in their profile.' },
      { title: 'Grace Period', content: 'After a payment failure, members enter a 3-day grace period. During this time they can update their payment method. Staff are notified and can assist with payment recovery if needed.' },
    ]
  },
  {
    guideId: 'day-passes',
    icon: 'confirmation_number',
    title: 'Day Pass Sales',
    description: 'Sell and redeem one-time access passes for non-members',
    sortOrder: 11,
    isAdminOnly: false,
    steps: [
      { title: 'What Are Day Passes?', content: 'Day passes are one-time access passes for non-members. There are two types: Golf Sim day passes and Coworking day passes. They allow visitors to use the facility for a single day without a membership.', pageIcon: 'confirmation_number' },
      { title: 'Selling a Day Pass (Staff)', content: 'From the New User drawer (via the floating action button), select "Visitor" mode. Choose the day pass product (Golf Sim or Coworking), fill in the visitor\'s info (or scan their ID to auto-fill), and complete the payment.', pageIcon: 'sell' },
      { title: 'QR Code Delivery', content: 'After purchase, the visitor receives a QR code via email that can be redeemed at the front desk. The email includes the pass details and instructions for redemption.', pageIcon: 'qr_code' },
      { title: 'Redeeming at POS', content: 'Go to Financials > POS > Redeem Pass. Scan the visitor\'s QR code or enter the pass ID manually. The system validates the pass and marks it as redeemed.', pageIcon: 'redeem' },
      { title: 'Pricing', content: 'Day pass prices are managed in Stripe and update automatically in the app. If prices change in Stripe, the new prices are reflected everywhere without any manual updates needed.', pageIcon: 'attach_money' },
    ]
  },
  {
    guideId: 'billing-providers',
    icon: 'account_balance',
    title: 'Billing Providers',
    description: 'Understand member billing sources and how to manage them',
    sortOrder: 12,
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
    guideId: 'group-billing',
    icon: 'family_restroom',
    title: 'Family & Corporate Groups',
    description: 'Manage group memberships with unified billing',
    sortOrder: 13,
    isAdminOnly: false,
    steps: [
      { title: 'Two Group Types', content: 'There are two types of group memberships: Family groups (a primary member adds family members at a discounted rate) and Corporate groups (a company purchases multiple seats with volume pricing).', pageIcon: 'family_restroom' },
      { title: 'Family Groups', content: 'The primary family member pays for everyone. Sub-members (spouse, kids) are added at a discounted rate pulled from Stripe. Each sub-member gets their own login and booking access.', pageIcon: 'group' },
      { title: 'Corporate Groups', content: 'Companies purchase a set number of seats with volume pricing (the more seats, the lower the per-seat cost). The corporate admin manages who fills each seat.', pageIcon: 'business' },
      { title: 'Adding Group Members', content: 'From the member profile drawer, go to the Billing tab. For family groups, use "Add Family Member." For corporate groups, use "Add Seat." Fill in the sub-member\'s details (or scan their ID to auto-fill).', pageIcon: 'person_add' },
      { title: 'Removing Group Members', content: 'Remove a sub-member from the Billing tab. Their access is deactivated immediately and the billing adjusts on the next cycle.', pageIcon: 'person_remove' },
      { title: 'Individual Tracking', content: 'Even though billing is unified under the primary payer, each group member\'s bookings, visits, and usage are tracked individually.', pageIcon: 'bar_chart' },
    ]
  },
  {
    guideId: 'tours',
    icon: 'directions_walk',
    title: 'Tours',
    description: 'View and manage scheduled facility tours',
    sortOrder: 14,
    isAdminOnly: false,
    steps: [
      { title: 'Access Tours', content: 'Go to the Tours tab from the sidebar or hamburger menu to view all scheduled facility tours.', pageIcon: 'directions_walk' },
      { title: 'Today\'s Tours', content: 'The top section shows tours scheduled for today with the guest name, scheduled time, and current status.' },
      { title: 'Upcoming Tours', content: 'Below today\'s tours, you can see all upcoming scheduled tours organized by date.' },
      { title: 'Tour Sources', content: 'Tours come from multiple sources: the booking widget on the website, HubSpot meeting scheduler, and Google Calendar sync (Tours Scheduled calendar).' },
      { title: 'Past Tours', content: 'Past tours automatically appear in a "Past Tours" section at the bottom of the page for reference and follow-up.' },
      { title: 'Tour Status', content: 'Update the tour status as needed: Scheduled (upcoming), Pending, Checked In, Completed (attended), Cancelled, or No Show.' },
      { title: 'Tour Notifications', content: 'Staff receive notifications when new tours are scheduled. Daily reminder emails are sent at 6pm for the next day\'s tours.' },
    ]
  },
  {
    guideId: 'facility-closures',
    icon: 'notifications',
    title: 'Notices (Facility)',
    description: 'Schedule notices and facility closures',
    sortOrder: 15,
    isAdminOnly: false,
    steps: [
      { title: 'Access Notices', content: 'Go to Facility from the sidebar or hamburger menu to manage facility notices and closures.', pageIcon: 'notifications' },
      { title: 'Two Tabs', content: 'The Facility page has two tabs: Notices (closures and informational announcements) and Blocks (resource availability blocks like maintenance holds or private events).' },
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
    title: 'Events & Wellness',
    description: 'Manage events and wellness classes',
    sortOrder: 16,
    isAdminOnly: false,
    steps: [
      { title: 'Access the Calendar', content: 'Go to the Calendar tab to view and manage events and wellness classes.', pageIcon: 'calendar_month' },
      { title: 'Two Main Tabs', content: 'Use the tabs to switch between Events (member events) and Wellness (classes like yoga, pilates).' },
      { title: 'Calendar Status', content: 'To check which Google Calendars are connected and their sync status, go to the Data Integrity page in Admin settings. The Calendar Status section shows each calendar and whether it is connected.' },
      { title: 'Needs Review Items', content: 'Events or classes synced from Google Calendar may show a "Needs Review" flag. This happens when instructor is missing, category is unclear, or conflicts are detected.' },
      { title: 'Resolving Needs Review', content: 'Tap any item marked "Needs Review" to fill in missing info like instructor name, category, or spots available. You can also dismiss the review or apply the fix to all similar items.' },
      { title: 'Sync with Eventbrite', content: 'Click the Eventbrite sync button to pull in member events from your Eventbrite organization.' },
      { title: 'Sync with Google Calendar', content: 'Click the Google Calendar sync button to sync events and wellness classes with the designated calendars.' },
      { title: 'Create Manual Events', content: 'Use the + button to add a new event or wellness class. Fill in title, date, time, location, and description.' },
      { title: 'View RSVPs & Enrollments', content: 'Click on an event or class to see who has RSVP\'d or enrolled. You can also manually add attendees.' },
    ]
  },
  {
    guideId: 'updates-announcements',
    icon: 'campaign',
    title: 'Updates & Announcements',
    description: 'Create announcements and view activity',
    sortOrder: 17,
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
      { title: 'Export Announcements', content: 'Admins can export all announcements as a CSV file from the Announce tab. This is useful for record-keeping or sharing with other teams.', pageIcon: 'download' },
      { title: 'Google Sheets Sync', content: 'Connect a Google Sheet to sync announcements in both directions. Create a linked sheet, and changes made in either the app or Google Sheets will stay in sync.', pageIcon: 'table_chart' },
      { title: 'Pull from Sheet', content: 'Tap "Pull from Sheet" to import new and updated announcements from the linked Google Sheet into the app.', pageIcon: 'cloud_download' },
      { title: 'Push to Sheet', content: 'Tap "Push to Sheet" to send all current announcements from the app to the linked Google Sheet.', pageIcon: 'cloud_upload' },
    ]
  },
  {
    guideId: 'member-directory',
    icon: 'groups',
    title: 'Member Directory',
    description: 'Search and view member and visitor profiles',
    sortOrder: 18,
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
      { title: 'ID on File', content: 'In the member profile drawer, staff can view a stored ID image if one was scanned during registration. Options include viewing the ID full-size, re-scanning with a new ID, or removing the image from the record.', pageIcon: 'badge' },
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
    sortOrder: 19,
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
    description: 'View cafe menu items synced from Stripe',
    sortOrder: 20,
    isAdminOnly: false,
    steps: [
      { title: 'Cafe Menu Overview', content: 'Cafe menu items are managed through Stripe and synced to the app automatically. The menu is organized into categories like Breakfast, Lunch, Dessert, Kids, Shareables, and Sides.', pageIcon: 'local_cafe' },
      { title: 'Prices from Stripe', content: 'All cafe item names, prices, and categories are pulled from the Stripe Product Catalog. To change a price or add a new item, update it in the Stripe Dashboard and it will sync to the app automatically.', pageIcon: 'sync' },
      { title: 'View in POS', content: 'Cafe items appear in the POS Register under the Cafe category tab. Staff can add items to a customer\'s cart and check out from there.', pageIcon: 'point_of_sale' },
      { title: 'Managed by Stripe Label', content: 'When viewing cafe items in the app, you will see a "Managed by Stripe" label. This means the item cannot be edited directly in the app — make changes in Stripe Dashboard instead.', pageIcon: 'lock' },
    ]
  },
  {
    guideId: 'gallery',
    icon: 'photo_library',
    title: 'Gallery',
    description: 'Manage venue photos (Admin only)',
    sortOrder: 21,
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
    sortOrder: 22,
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
    sortOrder: 23,
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
    sortOrder: 24,
    isAdminOnly: true,
    steps: [
      { title: 'Access Products & Pricing', content: 'Go to Products & Pricing from the Admin section of the sidebar or hamburger menu. This controls membership tier settings and Stripe integration.', pageIcon: 'loyalty' },
      { title: 'Edit Tier Settings', content: 'Click on a tier to edit its name, description, price, and marketing copy. Changes take effect immediately for all members on that tier.' },
      { title: 'Booking Limits', content: 'Set daily simulator minutes, conference room minutes, and advance booking window for each tier. Members cannot exceed these limits.' },
      { title: 'Guest Passes', content: 'Configure how many guest passes members receive per month for each tier. Passes reset on the 1st of each month.' },
      { title: 'Access Permissions', content: 'Toggle which features each tier can access: simulator booking, conference room, extended sessions, events, and more. Denied access hides those options from members.' },
      { title: 'Highlighted Features', content: 'Edit the bullet points that appear on the membership comparison page. These are shown to prospective members during signup.' },
      { title: 'Show on Membership Page', content: 'Use the "Show on Membership Page" toggle to control whether a tier appears on the public membership comparison page. Hidden tiers are still available for existing members but won\'t be shown to new signups.', pageIcon: 'visibility' },
      { title: 'Managed by Stripe Labels', content: 'Some fields like booking limits and access permissions show a "Managed by Stripe" label. These values are synced from Stripe and cannot be edited directly in the app. Make changes in the Stripe Dashboard instead.', pageIcon: 'lock' },
      { title: 'Sync to Stripe', content: 'Use the "Sync to Stripe" button to push tier data, permissions, and features to Stripe. Use "Pull from Stripe" to refresh tier data from the Stripe Product Catalog.', pageIcon: 'sync' },
      { title: 'Test with View As', content: 'After changing tier settings, use View As Member in the Directory to verify the member experience. This confirms booking limits and access permissions work as expected.' },
    ]
  },
  {
    guideId: 'team-directory',
    icon: 'badge',
    title: 'Team Directory',
    description: 'View staff and admin contact info',
    sortOrder: 25,
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
    sortOrder: 26,
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
    sortOrder: 27,
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
    sortOrder: 28,
    isAdminOnly: true,
    steps: [
      { title: 'Access Changelog', content: 'Go to the Changelog from the sidebar/hamburger menu under Admin settings to view all app updates.', pageIcon: 'history' },
      { title: 'View Updates', content: 'See a chronological list of all app updates, newest first. Major releases are highlighted.' },
      { title: 'What\'s Included', content: 'Each version shows the date, a title summarizing the update, and a list of changes in plain language.' },
      { title: 'Staff Activity Feed', content: 'Below the changelog, you can see a live feed of staff activity including booking actions, payment processing, and member updates.' },
      { title: 'Share with Staff', content: 'Use this to stay informed about new features and share updates with your team during meetings.' },
    ]
  },
  {
    guideId: 'data-integrity',
    icon: 'verified',
    title: 'Data Integrity',
    description: 'Monitor data consistency across Stripe, HubSpot, and the app',
    sortOrder: 29,
    isAdminOnly: true,
    steps: [
      { title: 'What is Data Integrity?', content: 'The Data Integrity dashboard runs automated checks to make sure member data is consistent across the app, Stripe, and HubSpot. It catches things like mismatched tiers, missing Stripe customers, or stale subscription data.', pageIcon: 'verified' },
      { title: 'Running a Check', content: 'Go to Data Integrity from the Admin section. Tap "Run Integrity Check" to scan all member records. Results are grouped by severity: Critical, High, Medium, and Low.', pageIcon: 'play_arrow' },
      { title: 'Issue Categories', content: 'Common issues include: members with no Stripe customer, Stripe subscription status mismatches, tier mismatches between app and Stripe, missing HubSpot contacts, and duplicate accounts.', pageIcon: 'category' },
      { title: 'Resolving Issues', content: 'Each issue includes a description and suggested action. Some can be auto-fixed (like syncing a tier to Stripe), while others may require manual review.', pageIcon: 'build' },
      { title: 'Check History', content: 'The dashboard shows a history of past integrity checks with issue counts over time, so you can track whether data quality is improving.', pageIcon: 'history' },
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
    
    if (result.length === 0) {
      console.log('[Training] No sections found, auto-seeding...');
      try {
        await seedTrainingSections();
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
    
    const [{ lastUpdated }] = await db
      .select({ lastUpdated: max(trainingSections.updatedAt) })
      .from(trainingSections);
    
    res.json({ sections: result, lastUpdated: lastUpdated?.toISOString() ?? null });
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

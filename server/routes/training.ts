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
      { title: 'Command Center Overview', content: 'The Home dashboard shows pending booking requests, today\'s schedule, facility status, and upcoming tours/wellness classes at a glance.', pageIcon: 'home' },
      { title: 'Bottom Navigation', content: 'Use the bottom navigation bar to quickly access: Home, Bookings, Tours, Calendar, and Directory.', pageIcon: 'menu' },
      { title: 'Employee Resources', content: 'Find quick links to Member Directory, Team, Cafe Menu, and Training Guide in the Employee Resources section on the Home tab.' },
      { title: 'Header Navigation', content: 'The campaign icon in the header takes you to the Updates page where you can view your activity notifications and manage member announcements.', pageIcon: 'campaign' },
      { title: 'Profile Access', content: 'Tap your avatar in the top right to access your profile, where you can manage push notifications and set up a password for faster login.', pageIcon: 'person' },
    ]
  },
  {
    guideId: 'booking-requests',
    icon: 'event_note',
    title: 'Managing Booking Requests',
    description: 'Approve, decline, or manage simulator and conference room bookings',
    sortOrder: 2,
    isAdminOnly: false,
    steps: [
      { title: 'Access Bookings', content: 'Go to the Bookings tab from the bottom nav or dashboard. You will see pending requests that need action.', pageIcon: 'event_note' },
      { title: 'Review Pending Requests', content: 'Each request card shows the member name, requested date, time, duration, and any notes they included.' },
      { title: 'Assign a Bay', content: 'Before approving a simulator booking, select which bay (1, 2, 3, or 4) to assign. The system will check for conflicts automatically.' },
      { title: 'Check for Conflicts', content: 'Green checkmark means the slot is available. Red warning indicates a conflict with another booking or closure.' },
      { title: 'Approve or Decline', content: 'Click Approve to confirm the booking (this syncs to Google Calendar) or Decline to reject it. You can add staff notes with either action.' },
      { title: 'Calendar View', content: 'Switch to Calendar view to see all approved bookings for a selected date. Closures appear as red "CLOSED" blocks.', pageIcon: 'calendar_month' },
      { title: 'Quick Actions (FAB)', content: 'The floating action button (+) in the bottom right provides quick access to create a manual booking for walk-in members or phone reservations.' },
    ]
  },
  {
    guideId: 'multi-member-bookings',
    icon: 'group_add',
    title: 'Multi-Member Bookings',
    description: 'Invite members and add guests to golf bookings',
    sortOrder: 3,
    isAdminOnly: false,
    steps: [
      { title: 'What are Multi-Member Bookings?', content: 'Members can invite other members or add guests to share their golf simulator booking. Time is automatically split between all participants.', pageIcon: 'group_add' },
      { title: 'Viewing the Roster', content: 'When viewing a booking (approved or pending), the Roster section shows who is currently on the booking: the owner, any invited members, and any guests.' },
      { title: 'Invite Status', content: 'Member invites show their status: Pending (waiting for response), Accepted (confirmed), Declined (rejected), or Expired (timed out). Expired invites can be re-sent.' },
      { title: 'Adding Members', content: 'The booking owner can tap "Add Member" to search for and invite other club members. The invited member receives a notification and must accept within the time limit.' },
      { title: 'Adding Guests', content: 'Tap "Add Guest" to add a non-member. This uses one of the owner\'s monthly guest passes. Enter the guest\'s name and optional email.' },
      { title: 'Automatic Time Split', content: 'Time is divided equally among all participants. For example, a 60-minute booking with 3 players gives each person 20 minutes of allocated time.' },
      { title: 'Conflict Detection', content: 'The system prevents inviting members who already have a booking during the same time slot. A warning appears if a conflict is detected.' },
      { title: 'Invite Expiration', content: 'Pending invites expire automatically (typically after 24 hours for future bookings, or 2 hours for same-day bookings). Staff can see expired invites and the owner can re-invite.' },
      { title: 'Staff View', content: 'Staff can view and manage the roster for any booking. Staff can add or remove participants on behalf of members when needed.' },
      { title: 'Player Count Reconciliation', content: 'After a session, staff can compare the declared player count with actual Trackman data to ensure accurate tracking.' },
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
      { title: 'Understanding the Fee Breakdown', content: 'The billing screen shows each person on the booking with their individual fees. Color-coded badges help you quickly see what type of fee applies.' },
      { title: 'Orange Badge = Time Overage', content: 'An orange badge means the person exceeded their daily time allowance and owes an overage fee ($25 per extra 30-minute block).' },
      { title: 'Blue Badge = Guest Fee', content: 'A blue badge indicates a flat $25 guest fee for bringing a non-member.' },
      { title: 'Green Badge = Guest Pass Used', content: 'A green badge means the member used one of their monthly guest passes, so no guest fee is charged.' },
      { title: 'Tier & Allowance Info', content: 'Each person\'s row shows their membership tier and how much daily time they have left. This helps explain why overage fees apply.' },
      { title: 'Confirming Payments', content: 'You can mark individual payments as paid, or confirm all at once. Use "Waive" if a fee should be forgiven (you must enter a reason).' },
      { title: 'Payment Audit Trail', content: 'All payment actions are logged with your name and timestamp for accountability.' },
      { title: 'Overdue Payments', content: 'The Overdue Payments section on the Home tab shows past bookings from the last 30 days with unpaid balances. Use this to follow up with members.' },
    ]
  },
  {
    guideId: 'tours',
    icon: 'directions_walk',
    title: 'Tours',
    description: 'View and manage scheduled facility tours',
    sortOrder: 5,
    isAdminOnly: false,
    steps: [
      { title: 'Access Tours', content: 'Go to the Tours tab from the bottom nav or dashboard to view scheduled tours.', pageIcon: 'directions_walk' },
      { title: 'Today\'s Tours', content: 'The top section shows tours scheduled for today with guest name, time, and status.' },
      { title: 'Upcoming Tours', content: 'Below today\'s tours, you can see all upcoming scheduled tours.' },
      { title: 'Tour Sources', content: 'Tours come from: the booking widget on the website, or directly synced from the HubSpot scheduler.' },
      { title: 'Needs Review', content: 'HubSpot meetings that didn\'t auto-match appear in the "Needs Review" section at the top. You can link them to existing tours, create new ones, or dismiss.' },
      { title: 'Tour Notifications', content: 'Staff receive notifications when new tours are scheduled. Daily reminders are sent at 6pm for the next day\'s tours.' },
    ]
  },
  {
    guideId: 'facility-closures',
    icon: 'notifications',
    title: 'Notices',
    description: 'Schedule notices and facility closures',
    sortOrder: 6,
    isAdminOnly: false,
    steps: [
      { title: 'Access Notices', content: 'Go to Notices from the bottom navigation bar to manage facility notices and closures.', pageIcon: 'notifications' },
      { title: 'Card Colors', content: 'RED cards block bookings for the selected areas. AMBER cards are informational announcements only and don\'t affect booking availability.' },
      { title: 'Needs Review Section', content: 'Notices synced from the Internal Calendar without bracket prefixes (e.g., [Closure]) appear in the "Needs Review" section at the top. Tap to configure which areas are affected before they become active closures.' },
      { title: 'Accordion View', content: 'Each notice displays as an expandable card. Tap to expand and see affected resources and internal notes. Use the edit button to make changes.' },
      { title: 'Create a Notice', content: 'Click the + button to create a new notice. Fill in the title, dates, times (optional), and select which areas are affected.' },
      { title: 'Affected Areas', content: 'Select "None" for informational notices (amber). Select specific bays, Conference Room, or Entire Facility to block bookings (red).' },
      { title: 'Color Updates Instantly', content: 'The card color changes immediately when you modify affected areas. Red means booking restrictions, amber means no restrictions.' },
      { title: 'Automatic Sync', content: 'Notices sync to the internal Google Calendar. Blocked areas automatically prevent member bookings during the specified times.' },
      { title: 'Filter & Search', content: 'Use the filter dropdown to view specific areas, date picker to find notices for a date, and "Show past" to see historical notices.' },
    ]
  },
  {
    guideId: 'events-wellness',
    icon: 'calendar_month',
    title: 'Events, Wellness & Blocks',
    description: 'Manage events, wellness classes, and availability blocks',
    sortOrder: 7,
    isAdminOnly: false,
    steps: [
      { title: 'Access the Calendar', content: 'Go to the Calendar tab to view and manage events, wellness classes, and availability blocks.', pageIcon: 'calendar_month' },
      { title: 'Calendar Status', content: 'At the top of the page, tap "Calendar Status" to see which Google Calendars are connected. Use "Fill Calendar Gaps" if wellness classes are missing from Google Calendar.' },
      { title: 'Toggle Events/Wellness/Blocks', content: 'Use the three tabs to switch between Events, Wellness, and Blocks views.' },
      { title: 'Sync with Eventbrite', content: 'Click the Eventbrite sync button to pull in member events from your Eventbrite organization.' },
      { title: 'Sync with Google Calendar', content: 'Click the Google Calendar sync button to sync events and wellness classes with the designated calendars.' },
      { title: 'Create Manual Events', content: 'Use the + button to add a new event, wellness class, or availability block. Fill in title, date, time, location, and description.' },
      { title: 'View RSVPs & Enrollments', content: 'Click on an event or class to see who has RSVP\'d or enrolled.' },
      { title: 'Availability Blocks', content: 'In the Blocks tab, create time blocks to mark resources as unavailable. Choose types: Maintenance, Private Event, Staff Hold, Wellness, or Other.' },
      { title: 'Blocks by Day', content: 'Blocks are grouped by date. Tap a day header to expand and see all blocks for that day. Each block shows the resource, time range, and type.' },
    ]
  },
  {
    guideId: 'updates-announcements',
    icon: 'campaign',
    title: 'Updates & Announcements',
    description: 'Create announcements and view activity',
    sortOrder: 8,
    isAdminOnly: false,
    steps: [
      { title: 'Access Updates', content: 'Click the campaign icon in the header or go to Updates from the dashboard.', pageIcon: 'campaign' },
      { title: 'Activity Tab', content: 'The Activity tab shows your staff notifications - new booking requests, system alerts, and other activity relevant to your role.' },
      { title: 'Mark as Read', content: 'Click "Mark all as read" to clear unread notifications, or tap individual notifications to mark them read. Use "Dismiss all" to permanently remove all notifications.' },
      { title: 'Announcements Tab', content: 'Switch to the Announcements tab to create and manage announcements that members will see.' },
      { title: 'Create an Announcement', content: 'Click "Create" and fill in the title, content, and priority level. High priority announcements appear more prominently.' },
      { title: 'Edit or Delete', content: 'Use the edit and delete buttons on existing announcements to update or remove them.' },
    ]
  },
  {
    guideId: 'member-directory',
    icon: 'groups',
    title: 'Member Directory',
    description: 'Search and view member profiles',
    sortOrder: 9,
    isAdminOnly: false,
    steps: [
      { title: 'Access Directory', content: 'Go to the Home tab and tap "Member Directory" in the Employee Resources section.', pageIcon: 'groups' },
      { title: 'Search Members', content: 'Use the search bar to find members by name, email, phone, or tier. Type "founding" to find founding members.' },
      { title: 'Filter by Tier', content: 'Use the tier filter buttons (All, Social, Core, Premium, Corporate, VIP) to narrow down the list.' },
      { title: 'Member Profile Drawer', content: 'Tap a member to open their profile drawer with tabs for: Overview (contact info, tier, tags), History (bookings, events, wellness, visits), Communications, and Staff Notes.' },
      { title: 'Booking History', content: 'In the History tab, view all member bookings and mark them as Attended or No Show directly from the profile.' },
      { title: 'View As Member (Admin Only)', content: 'Admins can tap "View As" to see the app from a member\'s perspective. A banner shows when viewing as another member. Exit by tapping the banner.' },
    ]
  },
  {
    guideId: 'inquiries',
    icon: 'mail',
    title: 'Inquiries',
    description: 'Manage form submissions (Admin only)',
    sortOrder: 10,
    isAdminOnly: true,
    steps: [
      { title: 'Access Inquiries', content: 'Go to the Home tab and tap "Inquiries" in the Admin Settings section.', pageIcon: 'mail' },
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
    sortOrder: 11,
    isAdminOnly: false,
    steps: [
      { title: 'Access Cafe Menu', content: 'Go to the Home tab and tap "Cafe Menu" in the Employee Resources section.', pageIcon: 'local_cafe' },
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
    sortOrder: 12,
    isAdminOnly: true,
    steps: [
      { title: 'Access Gallery', content: 'Go to the Home tab and tap "Gallery" in the Admin Settings section.', pageIcon: 'photo_library' },
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
    sortOrder: 13,
    isAdminOnly: true,
    steps: [
      { title: 'Access FAQs', content: 'Go to the Home tab and tap "FAQs" in the Admin Settings section.', pageIcon: 'help_outline' },
      { title: 'Add New FAQ', content: 'Tap "Add FAQ" to create a new question and answer for the public FAQ page.' },
      { title: 'Edit Existing', content: 'Tap the edit button on any FAQ to update the question or answer text.' },
      { title: 'Reorder', content: 'Adjust the sort order to control which FAQs appear first on the public page.' },
      { title: 'Delete', content: 'Remove outdated FAQs by tapping the delete button.' },
    ]
  },
  {
    guideId: 'team-access',
    icon: 'shield_person',
    title: 'Team Access',
    description: 'Manage staff and admin accounts',
    sortOrder: 14,
    isAdminOnly: true,
    steps: [
      { title: 'Access Team Settings', content: 'Go to Team Access from the Admin Settings section of the dashboard. This is admin-only.', pageIcon: 'shield_person' },
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
    sortOrder: 15,
    isAdminOnly: true,
    steps: [
      { title: 'Access Tiers', content: 'Go to Manage Tiers from the Admin Settings section. This controls what each membership level can do.', pageIcon: 'loyalty' },
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
    sortOrder: 16,
    isAdminOnly: false,
    steps: [
      { title: 'Access Team Directory', content: 'Go to the Home tab and tap "Team" in the Employee Resources section.', pageIcon: 'badge' },
      { title: 'View Team Members', content: 'See all active staff and admin team members with their names, job titles, and profile photos.' },
      { title: 'Contact Information', content: 'Tap a team member to view their phone number and email for quick contact.' },
      { title: 'Different from Team Access', content: 'This directory is read-only for viewing contact info. Admins who need to manage accounts should use Team Access in Admin Settings.' },
    ]
  },
  {
    guideId: 'trackman-import',
    icon: 'upload_file',
    title: 'Trackman Import',
    description: 'Import historical booking data (Admin only)',
    sortOrder: 17,
    isAdminOnly: true,
    steps: [
      { title: 'Access Trackman Import', content: 'Go to the Home tab and tap "Trackman Import" in the Admin Settings section. This is admin-only.', pageIcon: 'upload_file' },
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
    sortOrder: 18,
    isAdminOnly: true,
    steps: [
      { title: 'Access Bug Reports', content: 'Go to the Home tab and tap "Bug Reports" in the Admin Settings section.', pageIcon: 'bug_report' },
      { title: 'View Reports', content: 'See all bug reports submitted by members and staff, including screenshots if attached.' },
      { title: 'Report Details', content: 'Each report shows the description, reporter, date submitted, and current status (Open, In Progress, Resolved).' },
      { title: 'Update Status', content: 'Change the status as you work on issues. Mark as "In Progress" when investigating, and "Resolved" when fixed.' },
      { title: 'Member Visibility', content: 'Members can see the status of their own reports from their Profile page, so keep statuses updated.' },
    ]
  },
  {
    guideId: 'version-history',
    icon: 'history',
    title: 'Version History',
    description: 'View app updates and changes (Admin only)',
    sortOrder: 19,
    isAdminOnly: true,
    steps: [
      { title: 'Access Version History', content: 'Go to the Home tab and tap "Version History" in the Admin Settings section.', pageIcon: 'history' },
      { title: 'View Updates', content: 'See a chronological list of all app updates, newest first. Major releases are highlighted.' },
      { title: 'What\'s Included', content: 'Each version shows the date, a title summarizing the update, and a list of changes in plain language.' },
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

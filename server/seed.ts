import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { normalizeTierName } from './utils/tierUtils';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows: Record<string, string>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

function parseJoinedOnDate(dateStr: string): Date {
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const month = parseInt(parts[0], 10) - 1;
    const day = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    return new Date(year, month, day);
  }
  return new Date();
}

function mapMembershipTier(csvTier: string): string {
  return normalizeTierName(csvTier);
}

function parseLinkedEmails(trackmanEmails: string): string[] {
  if (!trackmanEmails) return [];
  return trackmanEmails.split(',').map(e => e.trim()).filter(e => e.length > 0);
}

async function seed() {
  console.log('🌱 Seeding database...\n');

  try {
    // Seed Resources (4 simulator bays + 1 conference room)
    console.log('Creating resources...');
    const resources = [
      { name: 'Simulator Bay 1', type: 'simulator', description: 'TrackMan Simulator Bay 1', capacity: 6 },
      { name: 'Simulator Bay 2', type: 'simulator', description: 'TrackMan Simulator Bay 2', capacity: 6 },
      { name: 'Simulator Bay 3', type: 'simulator', description: 'TrackMan Simulator Bay 3', capacity: 6 },
      { name: 'Simulator Bay 4', type: 'simulator', description: 'TrackMan Simulator Bay 4', capacity: 6 },
      { name: 'Conference Room', type: 'conference_room', description: 'Main conference room with AV setup', capacity: 12 },
    ];

    for (const resource of resources) {
      await pool.query(
        `INSERT INTO resources (name, type, description, capacity) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (name) DO NOTHING`,
        [resource.name, resource.type, resource.description, resource.capacity]
      );
    }
    console.log('✓ Resources created\n');

    // Seed Admin Users
    console.log('Creating admin users...');
    const admins = [
      { email: 'adam@everclub.app', first_name: 'Adam', last_name: 'Ever Club', role: 'admin' },
      { email: 'nick@everclub.app', first_name: 'Nick', last_name: 'Luu', role: 'admin' },
    ];

    for (const admin of admins) {
      await pool.query(
        `INSERT INTO users (email, first_name, last_name, role) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (email) DO UPDATE SET role = $4`,
        [admin.email, admin.first_name, admin.last_name, admin.role]
      );
    }
    console.log('✓ Admin users created\n');

    // Seed Members from CSV
    console.log('Importing members from CSV...');
    const csvPath = path.join(process.cwd(), 'even_house_cleaned_member_data.csv');
    
    if (fs.existsSync(csvPath)) {
      const csvContent = fs.readFileSync(csvPath, 'utf-8');
      const members = parseCSV(csvContent);
      let imported = 0;
      let skipped = 0;

      for (const member of members) {
        const email = member.real_email?.trim();
        if (!email) {
          skipped++;
          continue;
        }

        const createdAt = parseJoinedOnDate(member.joined_on);
        const tier = mapMembershipTier(member.membership_tier);
        const linkedEmails = parseLinkedEmails(member.trackman_emails_linked);

        try {
          await pool.query(
            `INSERT INTO users (
              email, first_name, last_name, phone, tier, role,
              mindbody_client_id, linked_emails,
              membership_tier, joined_on, mindbody_id,
              created_at, data_source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (email) DO UPDATE SET
              first_name = COALESCE(EXCLUDED.first_name, users.first_name),
              last_name = COALESCE(EXCLUDED.last_name, users.last_name),
              phone = COALESCE(EXCLUDED.phone, users.phone),
              tier = COALESCE(EXCLUDED.tier, users.tier),
              mindbody_client_id = COALESCE(EXCLUDED.mindbody_client_id, users.mindbody_client_id),
              linked_emails = COALESCE(EXCLUDED.linked_emails, users.linked_emails),
              membership_tier = COALESCE(EXCLUDED.membership_tier, users.membership_tier),
              joined_on = COALESCE(EXCLUDED.joined_on, users.joined_on),
              mindbody_id = COALESCE(EXCLUDED.mindbody_id, users.mindbody_id),
              data_source = 'csv_import'`,
            [
              email,
              member.first_name?.trim() || null,
              member.last_name?.trim() || null,
              member.phone?.trim() || null,
              tier,
              'member',
              member.mindbody_id?.trim() || null,
              JSON.stringify(linkedEmails),
              member.membership_tier?.trim() || null,
              createdAt,
              parseInt(member.mindbody_id, 10) || null,
              createdAt,
              'csv_import'
            ]
          );
          imported++;
        } catch (err) {
          console.error(`  Failed to import ${email}:`, err);
          skipped++;
        }
      }
      console.log(`✓ Members imported: ${imported} imported, ${skipped} skipped\n`);
    } else {
      console.log('⚠ Member CSV file not found, skipping member import\n');
    }

    // Seed Cafe Menu Items - Real Ever Club Menu
    console.log('Creating cafe menu...');
    const cafeItems = [
      { category: 'Breakfast', name: 'Egg Toast', price: 14, description: 'Schaner Farm scrambled eggs, whipped ricotta, chives, micro greens, toasted country batard', icon: 'egg_alt', sort_order: 1 },
      { category: 'Breakfast', name: 'Avocado Toast', price: 16, description: 'Hass smashed avocado, radish, lemon, micro greens, dill, toasted country batard', icon: 'eco', sort_order: 2 },
      { category: 'Breakfast', name: 'Banana & Honey Toast', price: 14, description: 'Banana, whipped ricotta, Hapa Honey Farm local honey, toasted country batard', icon: 'bakery_dining', sort_order: 3 },
      { category: 'Breakfast', name: 'Smoked Salmon Toast', price: 20, description: 'Alaskan king smoked salmon, whipped cream cheese, dill, capers, lemon, micro greens, toasted country batard', icon: 'set_meal', sort_order: 4 },
      { category: 'Breakfast', name: 'Breakfast Croissant', price: 16, description: 'Schaner Farm eggs, New School american cheese, freshly baked croissant, choice of cured ham or applewood smoked bacon', icon: 'bakery_dining', sort_order: 5 },
      { category: 'Breakfast', name: 'French Omelette', price: 14, description: 'Schaner Farm eggs, cultured butter, fresh herbs, served with side of seasonal salad greens', icon: 'egg', sort_order: 6 },
      { category: 'Breakfast', name: 'Hanger Steak & Eggs', price: 24, description: 'Autonomy Farms Hanger steak, Schaner Farm eggs, cooked your way', icon: 'restaurant', sort_order: 7 },
      { category: 'Breakfast', name: 'Bacon & Eggs', price: 14, description: 'Applewood smoked bacon, Schaner Farm eggs, cooked your way', icon: 'egg_alt', sort_order: 8 },
      { category: 'Breakfast', name: 'Yogurt Parfait', price: 14, description: 'Yogurt, seasonal fruits, farmstead granola, Hapa Honey farm local honey', icon: 'icecream', sort_order: 9 },
      { category: 'Sides', name: 'Bacon, Two Slices', price: 6, description: 'Applewood smoked bacon', icon: 'restaurant', sort_order: 1 },
      { category: 'Sides', name: 'Eggs, Scrambled', price: 8, description: 'Schaner Farm scrambled eggs', icon: 'egg', sort_order: 2 },
      { category: 'Sides', name: 'Seasonal Fruit Bowl', price: 10, description: 'Fresh seasonal fruits', icon: 'nutrition', sort_order: 3 },
      { category: 'Sides', name: 'Smoked Salmon', price: 9, description: 'Alaskan king smoked salmon', icon: 'set_meal', sort_order: 4 },
      { category: 'Sides', name: 'Toast, Two Slices', price: 3, description: 'Toasted country batard', icon: 'bakery_dining', sort_order: 5 },
      { category: 'Sides', name: 'Sqirl Seasonal Jam', price: 3, description: 'Artisan seasonal jam', icon: 'local_florist', sort_order: 6 },
      { category: 'Sides', name: 'Pistachio Spread', price: 4, description: 'House-made pistachio spread', icon: 'spa', sort_order: 7 },
      { category: 'Lunch', name: 'Caesar Salad', price: 15, description: 'Romaine lettuce, homemade dressing, grated Reggiano. Add: roasted chicken $8, hanger steak 8oz $14', icon: 'local_florist', sort_order: 1 },
      { category: 'Lunch', name: 'Wedge Salad', price: 16, description: 'Iceberg lettuce, bacon, red onion, cherry tomatoes, Point Reyes bleu cheese, homemade dressing', icon: 'local_florist', sort_order: 2 },
      { category: 'Lunch', name: 'Chicken Salad Sandwich', price: 14, description: 'Autonomy Farms chicken, celery, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 3 },
      { category: 'Lunch', name: 'Tuna Salad Sandwich', price: 14, description: 'Wild, pole-caught albacore tuna, sprouts, club chimichurri, toasted pan loaf, served with olive oil potato chips', icon: 'set_meal', sort_order: 4 },
      { category: 'Lunch', name: 'Grilled Cheese', price: 12, description: 'New School american cheese, brioche pan loaf, served with olive oil potato chips. Add: short rib $6, roasted tomato soup cup $7', icon: 'lunch_dining', sort_order: 5 },
      { category: 'Lunch', name: 'Heirloom BLT', price: 18, description: 'Applewood smoked bacon, butter lettuce, heirloom tomatoes, olive oil mayo, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 6 },
      { category: 'Lunch', name: 'Bratwurst', price: 12, description: 'German bratwurst, sautéed onions & peppers, toasted brioche bun', icon: 'lunch_dining', sort_order: 7 },
      { category: 'Lunch', name: 'Bison Serrano Chili', price: 14, description: 'Pasture raised bison, serrano, anaheim, green bell peppers, mint, cilantro, cheddar cheese, sour cream, green onion, served with organic corn chips', icon: 'soup_kitchen', sort_order: 8 },
      { category: 'Kids', name: 'Kids Grilled Cheese', price: 6, description: 'Classic grilled cheese for little ones', icon: 'child_care', sort_order: 1 },
      { category: 'Kids', name: 'Kids Hot Dog', price: 8, description: 'All-beef hot dog', icon: 'child_care', sort_order: 2 },
      { category: 'Dessert', name: 'Vanilla Bean Gelato Sandwich', price: 6, description: 'Vanilla bean gelato with chocolate chip cookies', icon: 'icecream', sort_order: 1 },
      { category: 'Dessert', name: 'Sea Salt Caramel Gelato Sandwich', price: 6, description: 'Sea salt caramel gelato with snickerdoodle cookies', icon: 'icecream', sort_order: 2 },
      { category: 'Dessert', name: 'Seasonal Pie, Slice', price: 6, description: 'Daily seasonal pie with house made crème', icon: 'cake', sort_order: 3 },
      { category: 'Shareables', name: 'Club Charcuterie', price: 32, description: 'Selection of cured meats and artisan cheeses', icon: 'tapas', sort_order: 1 },
      { category: 'Shareables', name: 'Chips & Salsa', price: 10, description: 'House-made salsa with organic corn chips', icon: 'tapas', sort_order: 2 },
      { category: 'Shareables', name: 'Caviar Service', price: 0, description: 'Market price - ask your server', icon: 'dining', sort_order: 3 },
      { category: 'Shareables', name: 'Tinned Fish Tray', price: 47, description: 'Premium selection of tinned fish', icon: 'set_meal', sort_order: 4 },
    ];

    for (const item of cafeItems) {
      await pool.query(
        `INSERT INTO cafe_items (category, name, price, description, icon, is_active, sort_order) 
         VALUES ($1, $2, $3, $4, $5, true, $6) 
         ON CONFLICT (name, category) DO NOTHING`,
        [item.category, item.name, item.price, item.description, item.icon, item.sort_order]
      );
    }
    console.log('✓ Cafe menu created\n');

    // Seed Training Sections
    console.log('Creating training sections...');
    const trainingSections = [
      { icon: 'login', title: 'Getting Started', description: 'How to access and navigate the Staff Portal', is_admin_only: false, sort_order: 1, steps: JSON.stringify([
        { title: 'Logging In', content: 'Use your registered email to sign in via the magic link system. Check your email for the login link - no password needed. The link expires after 15 minutes for security.' },
        { title: 'Accessing the Staff Portal', content: 'After logging in, you\'ll be automatically redirected to the Staff Portal dashboard. If you end up on the member portal, tap the menu icon and select "Staff Portal".' },
        { title: 'Bottom Navigation', content: 'The bottom navigation bar has 5 tabs: Home (dashboard with quick access cards), Bookings (manage booking requests), Tours (view scheduled tours), Calendar (events and wellness classes), and Notices (manage notices and availability blocks).' },
        { title: 'Dashboard Cards', content: 'The Home dashboard shows quick access cards organized into sections: Operations (Bookings, Calendar, Notices, Updates, Tours, Inquiries), Employee Resources (Directory, Team, Training Guide, Version History), and Admin Settings (admin only).' },
        { title: 'Header Navigation', content: 'The campaign icon in the header takes you to the Updates page where you can view your activity notifications and manage member announcements. Tap your avatar to access your profile settings.' },
      ])},
      { icon: 'event_note', title: 'Managing Booking Requests', description: 'Approve, decline, or manage simulator and conference room bookings', is_admin_only: false, sort_order: 2, steps: JSON.stringify([
        { title: 'Accessing Bookings', content: 'Tap "Bookings" in the bottom nav or the Bookings card on the dashboard. A red badge shows the count of pending requests.' },
        { title: 'Request Details', content: 'Each request shows the member name, date/time requested, duration, and resource (which simulator bay or conference room).' },
        { title: 'Assign a Bay', content: 'Before approving a simulator booking, select which bay (1, 2, 3, or 4) to assign. The system will check for conflicts automatically.' },
        { title: 'Approving a Request', content: 'Tap a request to expand it, then tap "Approve". The system will check for conflicts with other approved bookings and facility closures. If there\'s a conflict, you\'ll see an error message explaining why.' },
        { title: 'Declining a Request', content: 'Tap "Decline" if you cannot accommodate the request. The member will be notified that their request was declined.' },
        { title: 'Calendar View', content: 'Switch to the Calendar view using the tabs at the top to see all approved bookings in a visual timeline. Red blocks indicate facility closures.' },
        { title: 'Rescheduling Bookings', content: 'From the calendar view, tap any booking to open details. Use the "Reschedule" option to move the booking to a new time. The old booking is automatically cancelled and the member is notified of the change.' },
      ])},
      { icon: 'directions_walk', title: 'Tours', description: 'View and manage scheduled facility tours', is_admin_only: false, sort_order: 3, steps: JSON.stringify([
        { title: 'Accessing Tours', content: 'Tap "Tours" in the bottom nav or the Tours card on the dashboard to view scheduled tours.' },
        { title: 'Today\'s Tours', content: 'The top section shows tours scheduled for today with guest name, time, and status.' },
        { title: 'Upcoming Tours', content: 'Below today\'s tours, you can see all upcoming scheduled tours.' },
        { title: 'Tour Sources', content: 'Tours come from: the booking widget on the website, or directly synced from the Google Calendar.' },
        { title: 'Tour Notifications', content: 'Staff receive notifications when new tours are scheduled. Daily reminders are sent at 6pm for the next day\'s tours.' },
      ])},
      { icon: 'calendar_month', title: 'Events & Wellness Calendar', description: 'Manage events and wellness classes', is_admin_only: false, sort_order: 4, steps: JSON.stringify([
        { title: 'Accessing the Calendar', content: 'Tap "Calendar" in the bottom nav or the Calendar card on the dashboard to view and manage events and wellness classes.' },
        { title: 'Toggle Events/Wellness', content: 'Use the tabs at the top to switch between Events and Wellness views.' },
        { title: 'Sync with Eventbrite', content: 'Click the Eventbrite sync button to pull in member events from your Eventbrite organization.' },
        { title: 'Sync with Google Calendar', content: 'Click the Google Calendar sync button to sync events and wellness classes with the designated calendars.' },
        { title: 'Create Manual Events', content: 'Use the "Create" button to add a new event or wellness class manually. Fill in title, date, time, location, and description.' },
        { title: 'View RSVPs & Enrollments', content: 'Click on an event or class to see who has RSVP\'d or enrolled.' },
      ])},
      { icon: 'notifications', title: 'Notices & Availability Blocks', description: 'Manage notices and block booking times for closures', is_admin_only: false, sort_order: 5, steps: JSON.stringify([
        { title: 'Accessing Notices', content: 'Tap "Notices" in the bottom nav or the Notices card on the dashboard to manage facility closures and availability blocks.' },
        { title: 'Creating a Closure', content: 'Tap "+" to create a closure. Set the date range, time range, affected areas (simulator bays, conference room, or whole facility), and reason.' },
        { title: 'Affected Areas', content: 'Choose which resources are affected: individual simulator bays (Bay 1, 2, 3, or 4), the conference room, or the entire facility.' },
        { title: 'Calendar Sync', content: 'Closures automatically sync to Google Calendar and appear as red "CLOSED" blocks in the staff calendar view.' },
        { title: 'Automatic Announcements', content: 'Creating a closure automatically generates an announcement for members with the closure details. When the closure is deleted, its announcement is also removed.' },
        { title: 'Booking Conflicts', content: 'The system prevents staff from approving bookings that conflict with closures. You\'ll see a clear error message if there\'s a conflict.' },
      ])},
      { icon: 'campaign', title: 'Updates & Announcements', description: 'View activity and manage member announcements', is_admin_only: false, sort_order: 6, steps: JSON.stringify([
        { title: 'Accessing Updates', content: 'Tap the campaign icon in the header or the Updates card on the dashboard.' },
        { title: 'Activity Tab', content: 'The Activity tab shows your staff notifications - new booking requests, system alerts, and other activity relevant to your role.' },
        { title: 'Mark as Read', content: 'Tap "Mark all as read" to clear unread notifications, or tap individual notifications to mark them read.' },
        { title: 'Announcements Tab', content: 'Switch to the Announcements tab to create and manage announcements that members will see.' },
        { title: 'Creating an Announcement', content: 'Tap "Create" and fill in the title, content, and priority level. High priority announcements appear more prominently to members.' },
      ])},
      { icon: 'groups', title: 'Member Directory', description: 'Search and view member information', is_admin_only: false, sort_order: 7, steps: JSON.stringify([
        { title: 'Accessing the Directory', content: 'From the Home dashboard, tap "Directory" in the Employee Resources section to open the member search.' },
        { title: 'Searching Members', content: 'Type a name, email, or phone number in the search bar. Results update as you type. Type "founding" to find founding members.' },
        { title: 'Filter by Tier', content: 'Use the tier filter buttons (All, Social, Core, Premium, Corporate, VIP) to narrow down the list.' },
        { title: 'Member Profiles', content: 'Tap a member to see their profile including membership tier, join date, contact info, and booking history.' },
        { title: 'View As Member', content: 'Admins can tap "View As" to see the app from a member\'s perspective. A banner shows when viewing as another member.' },
      ])},
      { icon: 'badge', title: 'Team Directory', description: 'View staff and admin contact information', is_admin_only: false, sort_order: 8, steps: JSON.stringify([
        { title: 'Accessing Team', content: 'From the Home dashboard, tap "Team" in the Employee Resources section.' },
        { title: 'Staff List', content: 'View all staff and admin team members with their job titles and contact information.' },
        { title: 'Contact Info', content: 'Tap on a team member to see their phone number and email for quick contact.' },
      ])},
      { icon: 'mail', title: 'Handling Inquiries', description: 'View and respond to form submissions', is_admin_only: false, sort_order: 9, steps: JSON.stringify([
        { title: 'Accessing Inquiries', content: 'From the Home dashboard, tap "Inquiries" in the Operations section to see all form submissions.' },
        { title: 'Inquiry Types', content: 'View contact forms, tour requests, membership applications, private hire inquiries, and guest check-ins.' },
        { title: 'Filtering', content: 'Use the filter buttons to view by type or status (New, Read, Replied, Archived).' },
        { title: 'Marking Status', content: 'Update the status as you handle each inquiry: mark as Read when reviewed, Replied when you\'ve responded, or Archived when complete.' },
        { title: 'Adding Notes', content: 'Add internal notes to inquiries for follow-up reminders or to share context with other staff members.' },
      ])},
      { icon: 'local_cafe', title: 'Cafe Menu Management', description: 'Update menu items and prices', is_admin_only: true, sort_order: 10, steps: JSON.stringify([
        { title: 'Accessing Cafe Menu', content: 'From the Home dashboard, tap "Cafe Menu" in the Admin Settings section (admin only).' },
        { title: 'Adding Items', content: 'Tap "+" to add a new menu item. Fill in the name, price, description, and category. You can also upload an image.' },
        { title: 'Editing Items', content: 'Tap the edit icon on any item to modify its details or mark it as unavailable.' },
        { title: 'Categories', content: 'Use the category filter tabs to quickly find items. Categories include Breakfast, Lunch, Sides, Kids, Dessert, and Shareables.' },
        { title: 'Image Upload', content: 'When uploading images, they\'re automatically optimized for web viewing (converted to WebP format) to ensure fast loading.' },
      ])},
      { icon: 'photo_library', title: 'Gallery Management', description: 'Upload and manage venue photos', is_admin_only: true, sort_order: 11, steps: JSON.stringify([
        { title: 'Accessing Gallery', content: 'From the Home dashboard, tap "Gallery" in the Admin Settings section (admin only).' },
        { title: 'Uploading Photos', content: 'Tap "+" to upload a new photo. Select an image, choose a category, and add an optional caption. Images are automatically optimized.' },
        { title: 'Organizing', content: 'Drag photos to reorder them, or use the sort options to arrange by date or category.' },
        { title: 'Removing Photos', content: 'Tap the delete icon to remove a photo. Toggle photos active or inactive to show or hide them from the public gallery.' },
      ])},
      { icon: 'help_outline', title: 'FAQ Management', description: 'Edit frequently asked questions shown on the public site', is_admin_only: true, sort_order: 12, steps: JSON.stringify([
        { title: 'Accessing FAQs', content: 'From the Home dashboard, tap "FAQs" in the Admin Settings section (admin only).' },
        { title: 'Adding FAQs', content: 'Tap "+" to add a new question. Enter the question and answer text. New FAQs appear immediately on the public site.' },
        { title: 'Editing FAQs', content: 'Tap the edit icon to modify any existing FAQ. Changes are reflected immediately on the public site.' },
        { title: 'Ordering', content: 'Adjust the sort order to control which FAQs appear first on the public FAQ page.' },
      ])},
      { icon: 'loyalty', title: 'Tier Configuration (Admin Only)', description: 'Configure membership tier settings and privileges', is_admin_only: true, sort_order: 13, steps: JSON.stringify([
        { title: 'Accessing Tiers', content: 'From the Home dashboard, tap "Manage Tiers" in the Admin Settings section (admin only).' },
        { title: 'Tier Settings', content: 'Each tier has configurable limits: daily simulator minutes, guest passes per month, booking window (how far ahead they can book), and access permissions.' },
        { title: 'Editing Privileges', content: 'Modify tier privileges to adjust what each membership level can access. Changes take effect immediately for all members of that tier.' },
        { title: 'Display Settings', content: 'Update the tier name, price display, and highlighted features shown on the public membership comparison page.' },
      ])},
      { icon: 'visibility', title: 'View As Member (Admin Only)', description: 'See the app from a member\'s perspective', is_admin_only: true, sort_order: 14, steps: JSON.stringify([
        { title: 'Starting View As Mode', content: 'In the member directory, find a member and tap "View As" to see the app exactly as they see it.' },
        { title: 'While Viewing', content: 'You\'ll see the member portal as that member sees it, including their bookings, events, and dashboard. A banner reminds you that you\'re in View As mode.' },
        { title: 'Taking Actions', content: 'If you try to book or RSVP while in View As mode, you\'ll see a confirmation asking if you want to do this on behalf of the member.' },
        { title: 'Exiting View As Mode', content: 'Tap the banner or use the profile menu to exit View As mode and return to your admin account.' },
      ])},
    ];

    let trainingSectionsInserted = 0;
    for (const section of trainingSections) {
      const result = await pool.query(
        `INSERT INTO training_sections (icon, title, description, steps, is_admin_only, sort_order) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         ON CONFLICT (title) DO NOTHING
         RETURNING id`,
        [section.icon, section.title, section.description, section.steps, section.is_admin_only, section.sort_order]
      );
      if (result.rowCount && result.rowCount > 0) trainingSectionsInserted++;
    }
    console.log(`✓ Training sections: ${trainingSectionsInserted} new (${trainingSections.length - trainingSectionsInserted} already existed)\n`);

    // Get member count
    const memberCount = await pool.query(`SELECT COUNT(*) as count FROM users WHERE role = 'member'`);
    const totalMembers = parseInt(memberCount.rows[0].count, 10);

    console.log('✅ Database seeded successfully!');
    console.log('\nSeeded:');
    console.log(`  • ${resources.length} bookable resources (4 simulators + 1 conference room)`);
    console.log(`  • ${admins.length} admin users`);
    console.log(`  • ${totalMembers} members from CSV`);
    console.log(`  • ${cafeItems.length} cafe menu items`);
    console.log(`  • ${trainingSectionsInserted} training sections`);
    console.log('\nNote: Events and wellness classes sync from Google Calendar.');

  } catch (error) {
    console.error('❌ Seed error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

seed();

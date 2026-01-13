export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  isMajor?: boolean;
  changes: string[];
}

export const changelog: ChangelogEntry[] = [
  {
    version: "8.8",
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
    version: "8.7",
    date: "2026-01-10",
    title: "Reliability & Token Refresh",
    changes: [
      "Fixed HubSpot and Google Calendar token expiration issues",
      "Tokens now refresh proactively before they expire",
      "Improved connection reliability for external integrations"
    ]
  },
  {
    version: "8.6",
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

export type { TabType, NavItemData } from '../../../lib/nav-constants';
export { tabToPath, pathToTab, getTabFromPathname } from '../../../lib/nav-constants';

export const NAV_ITEMS: import('../../../lib/nav-constants').NavItemData[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'simulator', icon: 'event_note', label: 'Bookings' },
  { id: 'financials', icon: 'point_of_sale', label: 'POS' },
  { id: 'events', icon: 'calendar_month', label: 'Calendar' },
  { id: 'directory', icon: 'groups', label: 'Directory' },
];

export const MAIN_NAV_ITEMS: import('../../../lib/nav-constants').NavItemData[] = [
  { id: 'home', icon: 'dashboard', label: 'Dashboard' },
  { id: 'simulator', icon: 'event_note', label: 'Bookings' },
  { id: 'financials', icon: 'point_of_sale', label: 'Financials' },
  { id: 'tours', icon: 'directions_walk', label: 'Tours' },
  { id: 'events', icon: 'calendar_month', label: 'Calendar' },
  { id: 'blocks', icon: 'domain', label: 'Facility' },
  { id: 'updates', icon: 'campaign', label: 'Updates' },
  { id: 'directory', icon: 'group', label: 'Directory' },
  { id: 'training', icon: 'school', label: 'Training' },
  { id: 'analytics', icon: 'analytics', label: 'Analytics' },
];

export const ADMIN_NAV_ITEMS: import('../../../lib/nav-constants').NavItemData[] = [
  { id: 'tiers', icon: 'storefront', label: 'Products', adminOnly: true },
  { id: 'team', icon: 'badge', label: 'Team', adminOnly: true },
  { id: 'gallery', icon: 'photo_library', label: 'Gallery', adminOnly: true },
  { id: 'faqs', icon: 'help_outline', label: 'FAQs', adminOnly: true },
  { id: 'inquiries', icon: 'mail', label: 'Inquiries', adminOnly: true },
  { id: 'applications', icon: 'how_to_reg', label: 'Applications', adminOnly: true },
  { id: 'bugs', icon: 'bug_report', label: 'Bugs', adminOnly: true },
  { id: 'email-templates', icon: 'forward_to_inbox', label: 'Emails', adminOnly: true },
  { id: 'changelog', icon: 'history', label: 'Changelog', adminOnly: true },
  { id: 'data-integrity', icon: 'fact_check', label: 'Integrity', adminOnly: true },
  { id: 'settings', icon: 'settings', label: 'Settings', adminOnly: true },
];

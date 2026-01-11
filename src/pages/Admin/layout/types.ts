export type TabType = 'home' | 'cafe' | 'events' | 'announcements' | 'directory' | 'simulator' | 'team' | 'faqs' | 'inquiries' | 'gallery' | 'tiers' | 'blocks' | 'changelog' | 'training' | 'updates' | 'tours' | 'bugs' | 'trackman' | 'data-integrity';

export interface NavItemData {
  id: TabType;
  icon: string;
  label: string;
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItemData[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'simulator', icon: 'event_note', label: 'Bookings' },
  { id: 'tours', icon: 'directions_walk', label: 'Tours' },
  { id: 'events', icon: 'calendar_month', label: 'Calendar' },
  { id: 'directory', icon: 'group', label: 'Directory' },
];

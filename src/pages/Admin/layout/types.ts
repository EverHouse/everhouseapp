export type TabType = 'home' | 'events' | 'announcements' | 'directory' | 'simulator' | 'team' | 'faqs' | 'inquiries' | 'gallery' | 'tiers' | 'blocks' | 'changelog' | 'training' | 'updates' | 'tours' | 'bugs' | 'trackman' | 'data-integrity' | 'settings' | 'financials';

export interface NavItemData {
  id: TabType;
  icon: string;
  label: string;
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItemData[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'simulator', icon: 'event_note', label: 'Bookings' },
  { id: 'financials', icon: 'point_of_sale', label: 'Financials' },
  { id: 'events', icon: 'calendar_month', label: 'Calendar' },
  { id: 'directory', icon: 'groups', label: 'Directory' },
];

export const tabToPath: Record<TabType, string> = {
  'home': '/admin',
  'simulator': '/admin/bookings',
  'directory': '/admin/directory',
  'events': '/admin/calendar',
  'blocks': '/admin/notices',
  'updates': '/admin/updates',
  'announcements': '/admin/news',
  'team': '/admin/team',
  'tiers': '/admin/tiers',
  'trackman': '/admin/trackman',
  'data-integrity': '/admin/data-integrity',
  'financials': '/admin/financials',
  'gallery': '/admin/gallery',
  'faqs': '/admin/faqs',
  'inquiries': '/admin/inquiries',
  'bugs': '/admin/bugs',
  'settings': '/admin/settings',
  'changelog': '/admin/changelog',
  'tours': '/admin/tours',
  'training': '/admin/training'
};

export const pathToTab: Record<string, TabType> = Object.entries(tabToPath).reduce(
  (acc, [tab, path]) => {
    acc[path] = tab as TabType;
    return acc;
  },
  {} as Record<string, TabType>
);

export function getTabFromPathname(pathname: string): TabType {
  if (pathToTab[pathname]) {
    return pathToTab[pathname];
  }
  if (pathname === '/admin' || pathname === '/admin/') {
    return 'home';
  }
  const pathWithoutTrailingSlash = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (pathToTab[pathWithoutTrailingSlash]) {
    return pathToTab[pathWithoutTrailingSlash];
  }
  return 'home';
}

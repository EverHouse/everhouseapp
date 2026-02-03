type LazyComponent = { prefetch?: () => Promise<any> };

const prefetchedPaths = new Set<string>();
const prefetchedAPIs = new Set<string>();

const routeImports: Record<string, () => Promise<any>> = {
  '/book': () => import('../pages/Member/BookGolf'),
  '/member-events': () => import('../pages/Member/Events'),
  '/member-wellness': () => import('../pages/Member/Wellness'),
  '/profile': () => import('../pages/Member/Profile'),
  '/dashboard': () => import('../pages/Member/Dashboard'),
  '/updates': () => import('../pages/Member/Updates'),
};

const routeAPIs: Record<string, string[]> = {
  '/book': ['/api/bays', '/api/approved-bookings'],
  '/member-events': ['/api/events'],
  '/member-wellness': ['/api/wellness-classes'],
  '/updates': ['/api/announcements', '/api/closures'],
  '/dashboard': ['/api/member/dashboard-data'],
};

export const prefetchRoute = (path: string) => {
  if (prefetchedPaths.has(path)) return;
  const importFn = routeImports[path];
  if (importFn) {
    prefetchedPaths.add(path);
    importFn();
  }
  const apis = routeAPIs[path];
  if (apis) {
    apis.forEach(api => {
      if (!prefetchedAPIs.has(api)) {
        prefetchedAPIs.add(api);
        fetch(api, { credentials: 'include' }).catch(() => {});
      }
    });
  }
};

export const prefetchAdjacentRoutes = (currentPath: string) => {
  const navOrder = ['/dashboard', '/book', '/member-wellness', '/member-events', '/updates'];
  const idx = navOrder.indexOf(currentPath);
  if (idx === -1) return;
  
  if (idx > 0) prefetchRoute(navOrder[idx - 1]);
  if (idx < navOrder.length - 1) prefetchRoute(navOrder[idx + 1]);
};

export const prefetchAllNavRoutes = () => {
  Object.keys(routeImports).forEach(prefetchRoute);
};

export const prefetchOnIdle = () => {
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => prefetchAllNavRoutes(), { timeout: 2000 });
  } else {
    setTimeout(prefetchAllNavRoutes, 100);
  }
};

// Staff portal prefetching
const staffRouteImports: Record<string, () => Promise<any>> = {
  '/admin': () => import('../pages/Admin/AdminDashboard'),
  '/admin/bookings': () => import('../pages/Admin/tabs/SimulatorTab'),
  '/admin/financials': () => import('../pages/Admin/tabs/FinancialsTab'),
  '/admin/directory': () => import('../pages/Admin/tabs/DirectoryTab'),
  '/admin/calendar': () => import('../pages/Admin/tabs/EventsTab'),
  '/admin/notices': () => import('../pages/Admin/tabs/BlocksTab'),
  '/admin/updates': () => import('../pages/Admin/tabs/UpdatesTab'),
  '/admin/tours': () => import('../pages/Admin/tabs/ToursTab'),
  '/admin/cafe': () => import('../pages/Admin/tabs/CafeTab'),
  '/admin/team': () => import('../pages/Admin/tabs/TeamTab'),
  '/admin/tiers': () => import('../pages/Admin/tabs/TiersTab'),
  '/admin/changelog': () => import('../pages/Admin/tabs/ChangelogTab'),
};

const staffRouteAPIs: Record<string, string[]> = {
  '/admin': ['/api/admin/dashboard-summary'],
  '/admin/bookings': ['/api/approved-bookings', '/api/booking-requests'],
  '/admin/directory': ['/api/members/directory'],
  '/admin/financials': ['/api/admin/financials/summary'],
};

export const prefetchStaffRoute = (path: string) => {
  if (prefetchedPaths.has(path)) return;
  const importFn = staffRouteImports[path];
  if (importFn) {
    prefetchedPaths.add(path);
    importFn();
  }
  const apis = staffRouteAPIs[path];
  if (apis) {
    apis.forEach(api => {
      if (!prefetchedAPIs.has(api)) {
        prefetchedAPIs.add(api);
        fetch(api, { credentials: 'include' }).catch(() => {});
      }
    });
  }
};

export const prefetchAdjacentStaffRoutes = (currentPath: string) => {
  const navOrder = ['/admin', '/admin/bookings', '/admin/financials', '/admin/tours', '/admin/calendar', '/admin/notices', '/admin/updates', '/admin/directory'];
  const idx = navOrder.indexOf(currentPath);
  if (idx === -1) return;
  
  if (idx > 0) prefetchStaffRoute(navOrder[idx - 1]);
  if (idx < navOrder.length - 1) prefetchStaffRoute(navOrder[idx + 1]);
};

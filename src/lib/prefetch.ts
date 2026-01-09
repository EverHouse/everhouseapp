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
  '/dashboard': ['/api/events', '/api/announcements'],
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

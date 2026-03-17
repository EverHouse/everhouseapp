import { fetchWithCredentials } from '../hooks/queries/useFetch';

type RouteImportMap = Record<string, () => Promise<unknown>>;
type RouteAPIMap = Record<string, string[]>;

const prefetchedPaths = new Set<string>();
const prefetchedAPIs = new Set<string>();

let memberRouteImports: RouteImportMap = {};
let memberRouteAPIs: RouteAPIMap = {};
let staffRouteImports: RouteImportMap = {};
let staffRouteAPIs: RouteAPIMap = {};

export const registerMemberRoutes = (imports: RouteImportMap, apis: RouteAPIMap) => {
  memberRouteImports = imports;
  memberRouteAPIs = apis;
};

export const registerStaffRoutes = (imports: RouteImportMap, apis: RouteAPIMap) => {
  staffRouteImports = imports;
  staffRouteAPIs = apis;
};

export const resetPrefetchState = () => {
  prefetchedAPIs.clear();
};

const doPrefetch = (path: string, imports: RouteImportMap, apis: RouteAPIMap) => {
  if (!prefetchedPaths.has(path)) {
    const importFn = imports[path];
    if (importFn) {
      prefetchedPaths.add(path);
      importFn();
    }
  }
  const apiList = apis[path];
  if (apiList) {
    apiList.forEach(api => {
      if (!prefetchedAPIs.has(api)) {
        prefetchedAPIs.add(api);
        fetch(api, { credentials: 'include' }).catch((err) => console.warn('[prefetch] API prefetch failed:', api, err));
      }
    });
  }
};

export const prefetchRoute = (path: string) => {
  doPrefetch(path, memberRouteImports, memberRouteAPIs);
};

export const prefetchAdjacentRoutes = (currentPath: string) => {
  const navOrder = ['/dashboard', '/book', '/wellness', '/events', '/updates'];
  const idx = navOrder.indexOf(currentPath);
  if (idx === -1) return;
  if (idx > 0) prefetchRoute(navOrder[idx - 1]);
  if (idx < navOrder.length - 1) prefetchRoute(navOrder[idx + 1]);
};

export const prefetchAllNavRoutes = () => {
  Object.keys(memberRouteImports).forEach(prefetchRoute);
};

export const prefetchOnIdle = (): (() => void) => {
  if ('requestIdleCallback' in window) {
    const win = window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback: (id: number) => void };
    const id = win.requestIdleCallback(() => prefetchAllNavRoutes(), { timeout: 2000 });
    return () => win.cancelIdleCallback(id);
  }
  const id = setTimeout(prefetchAllNavRoutes, 100);
  return () => clearTimeout(id);
};

export const prefetchStaffRoute = (path: string) => {
  doPrefetch(path, staffRouteImports, staffRouteAPIs);
};

export const prefetchAdjacentStaffRoutes = (currentPath: string) => {
  const navOrder = ['/admin', '/admin/bookings', '/admin/financials', '/admin/tours', '/admin/calendar', '/admin/notices', '/admin/updates', '/admin/directory'];
  const idx = navOrder.indexOf(currentPath);
  if (idx === -1) return;
  if (idx > 0) prefetchStaffRoute(navOrder[idx - 1]);
  if (idx < navOrder.length - 1) prefetchStaffRoute(navOrder[idx + 1]);
};

export const prefetchMemberProfile = (email: string) => {
  const key = `member-profile:${email}`;
  if (prefetchedAPIs.has(key)) return;
  prefetchedAPIs.add(key);
  const encoded = encodeURIComponent(email);
  fetchWithCredentials(`/api/members/${encoded}/history`).catch((err) => console.warn('[prefetch] Member history prefetch failed:', err));
  fetchWithCredentials(`/api/members/${encoded}/notes`).catch((err) => console.warn('[prefetch] Member notes prefetch failed:', err));
};

export const prefetchBookingDetail = (bookingId: number | string) => {
  const key = `booking-detail:${bookingId}`;
  if (prefetchedAPIs.has(key)) return;
  prefetchedAPIs.add(key);
  fetchWithCredentials(`/api/admin/booking/${bookingId}/members`).catch((err) => console.warn('[prefetch] Booking detail prefetch failed:', err));
};

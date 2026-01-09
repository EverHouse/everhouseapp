import { getGoogleCalendarClient } from '../integrations';
import { CALENDAR_CONFIG } from './config';

const calendarIdCache: Record<string, string> = {};
let cacheLastRefreshed: number = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

let calendarDiscoveryLogged = false;

export function clearCalendarCache(): void {
  Object.keys(calendarIdCache).forEach(key => delete calendarIdCache[key]);
  cacheLastRefreshed = 0;
  calendarDiscoveryLogged = false;
}

function isCacheValid(): boolean {
  const hasItems = Object.keys(calendarIdCache).length > 0;
  const isNotExpired = cacheLastRefreshed > 0 && (Date.now() - cacheLastRefreshed <= CACHE_TTL_MS);
  return hasItems && isNotExpired;
}

export async function discoverCalendarIds(forceRefresh: boolean = false): Promise<void> {
  if (!forceRefresh && isCacheValid()) {
    return;
  }
  
  try {
    const calendar = await getGoogleCalendarClient();
    const response = await calendar.calendarList.list();
    const calendars = response.data.items || [];
    
    Object.keys(calendarIdCache).forEach(key => delete calendarIdCache[key]);
    
    for (const cal of calendars) {
      if (cal.summary && cal.id) {
        calendarIdCache[cal.summary] = cal.id;
      }
    }
    
    cacheLastRefreshed = Date.now();
    
    if (!calendarDiscoveryLogged) {
      console.log(`[Calendar] Discovered ${calendars.length} calendars`);
      calendarDiscoveryLogged = true;
    }
  } catch (error) {
    console.error('[Calendar] Error discovering calendars:', error);
  }
}

export async function getCalendarIdByName(name: string): Promise<string | null> {
  if (calendarIdCache[name] && isCacheValid()) {
    return calendarIdCache[name];
  }
  
  await discoverCalendarIds();
  return calendarIdCache[name] || null;
}

export async function getCalendarStatus(): Promise<{
  configured: { key: string; name: string; calendarId: string | null; status: 'connected' | 'not_found' }[];
  discovered: { name: string; calendarId: string }[];
}> {
  await discoverCalendarIds();
  
  const DEPRECATED_CALENDARS = ['golf'];
  
  const configured = Object.entries(CALENDAR_CONFIG)
    .filter(([key]) => !DEPRECATED_CALENDARS.includes(key))
    .map(([key, config]) => {
      const calendarId = calendarIdCache[config.name] || null;
      return {
        key,
        name: config.name,
        calendarId,
        status: calendarId ? 'connected' as const : 'not_found' as const
      };
    });
  
  const discovered = Object.entries(calendarIdCache).map(([name, calendarId]) => ({
    name,
    calendarId
  }));
  
  return { configured, discovered };
}

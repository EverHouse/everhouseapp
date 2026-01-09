import { apiRequest } from '../lib/apiRequest';
import { normalizeTierName } from '../../shared/constants/tiers';

export interface TierLimits {
  name: string;
  slug?: string;
  daily_sim_minutes: number;
  guest_passes_per_month: number;
  booking_window_days: number;
  daily_conf_room_minutes: number;
  can_book_simulators: boolean;
  can_book_conference: boolean;
  can_book_wellness: boolean;
  has_group_lessons: boolean;
  has_extended_sessions: boolean;
  has_private_lesson: boolean;
  has_simulator_guest_passes: boolean;
  has_discounted_merch: boolean;
  unlimited_access: boolean;
}

export interface TierPermissions {
  canBookSimulators: boolean;
  canBookWellness: boolean;
  advanceBookingDays: number;
  guestPassesPerMonth: number;
  dailySimulatorMinutes: number;
  dailyConfRoomMinutes: number;
  hasGroupLessons: boolean;
  hasExtendedSessions: boolean;
  hasPrivateLesson: boolean;
  hasSimulatorGuestPasses: boolean;
  hasDiscountedMerch: boolean;
  unlimitedAccess: boolean;
}

const DEFAULT_PERMISSIONS: TierPermissions = {
  canBookSimulators: false,
  canBookWellness: true,
  advanceBookingDays: 7,
  guestPassesPerMonth: 0,
  dailySimulatorMinutes: 0,
  dailyConfRoomMinutes: 0,
  hasGroupLessons: false,
  hasExtendedSessions: false,
  hasPrivateLesson: false,
  hasSimulatorGuestPasses: false,
  hasDiscountedMerch: false,
  unlimitedAccess: false,
};

interface CacheEntry {
  data: TierPermissions;
  expiry: number;
}

const tierCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const pendingRequests = new Map<string, Promise<TierPermissions>>();

function transformToPermissions(limits: TierLimits): TierPermissions {
  return {
    canBookSimulators: limits.can_book_simulators,
    canBookWellness: limits.can_book_wellness,
    advanceBookingDays: limits.booking_window_days,
    guestPassesPerMonth: limits.guest_passes_per_month,
    dailySimulatorMinutes: limits.daily_sim_minutes,
    dailyConfRoomMinutes: limits.daily_conf_room_minutes,
    hasGroupLessons: limits.has_group_lessons,
    hasExtendedSessions: limits.has_extended_sessions,
    hasPrivateLesson: limits.has_private_lesson,
    hasSimulatorGuestPasses: limits.has_simulator_guest_passes,
    hasDiscountedMerch: limits.has_discounted_merch,
    unlimitedAccess: limits.unlimited_access,
  };
}

function getBaseTierName(tierString: string): string {
  return normalizeTierName(tierString).toLowerCase();
}

export async function fetchTierPermissions(tierName: string): Promise<TierPermissions> {
  const baseTier = getBaseTierName(tierName);
  const cacheKey = baseTier;
  
  const cached = tierCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  
  const pending = pendingRequests.get(cacheKey);
  if (pending) {
    return pending;
  }
  
  const request = (async () => {
    try {
      const { ok, data } = await apiRequest<TierLimits>(
        `/api/membership-tiers/limits/${encodeURIComponent(baseTier)}`
      );
      
      if (ok && data) {
        const permissions = transformToPermissions(data);
        tierCache.set(cacheKey, { data: permissions, expiry: Date.now() + CACHE_TTL_MS });
        return permissions;
      }
      
      return DEFAULT_PERMISSIONS;
    } catch (error) {
      console.error('[tierService] Error fetching tier permissions:', error);
      return DEFAULT_PERMISSIONS;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();
  
  pendingRequests.set(cacheKey, request);
  return request;
}

export function getCachedTierPermissions(tierName: string): TierPermissions | null {
  const baseTier = getBaseTierName(tierName);
  const cached = tierCache.get(baseTier);
  
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  
  return null;
}

export function clearTierCache(): void {
  tierCache.clear();
}

export function invalidateTierCache(tierName: string): void {
  const baseTier = getBaseTierName(tierName);
  tierCache.delete(baseTier);
}

export function canAccessResource(permissions: TierPermissions, resourceType: string): boolean {
  if (permissions.unlimitedAccess) {
    return true;
  }
  
  if (resourceType === 'simulator') {
    return permissions.canBookSimulators;
  }
  
  if (resourceType === 'conference') {
    return permissions.dailyConfRoomMinutes > 0;
  }
  
  return true;
}

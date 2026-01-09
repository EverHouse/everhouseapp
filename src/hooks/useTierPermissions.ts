import { useState, useEffect } from 'react';
import { TierPermissions, fetchTierPermissions, getCachedTierPermissions } from '../services/tierService';

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

export function useTierPermissions(tierName: string | undefined): {
  permissions: TierPermissions;
  loading: boolean;
} {
  const [permissions, setPermissions] = useState<TierPermissions>(() => {
    const cached = tierName ? getCachedTierPermissions(tierName) : null;
    return cached || DEFAULT_PERMISSIONS;
  });
  const [loading, setLoading] = useState(!getCachedTierPermissions(tierName || ''));

  useEffect(() => {
    if (!tierName) {
      setPermissions(DEFAULT_PERMISSIONS);
      setLoading(false);
      return;
    }

    const cached = getCachedTierPermissions(tierName);
    if (cached) {
      setPermissions(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchTierPermissions(tierName)
      .then(data => {
        setPermissions(data);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [tierName]);

  return { permissions, loading };
}

/**
 * @deprecated Golf calendar sync is no longer used - bookings are done in-app only.
 * This module is kept for backward compatibility but all functions return immediately
 * without performing any sync operations.
 */

export async function syncBookedGolfCalendarToBookings(options?: { monthsBack?: number }): Promise<{ synced: number; linked: number; created: number; skipped: number; error?: string }> {
  console.log('[Booked Golf Sync] DEPRECATED - Golf calendar sync is disabled. Bookings are now done in-app only.');
  return { synced: 0, linked: 0, created: 0, skipped: 0, error: 'Golf calendar sync is deprecated and disabled' };
}

import { db } from '../../db';
import { resources } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { CALENDAR_CONFIG } from '../../core/calendar/index';
import { bookingEvents } from '../../core/bookingEvents';
import { logger } from '../../core/logger';

export async function getCalendarNameForBayAsync(bayId: number | null): Promise<string | null> {
  if (!bayId) return null;
  
  try {
    const result = await db.select({ name: resources.name, type: resources.type }).from(resources).where(eq(resources.id, bayId));
    const resourceType = result[0]?.type?.toLowerCase() || '';
    const resourceName = result[0]?.name?.toLowerCase() || '';
    if (resourceType === 'conference_room' || resourceName.includes('conference')) {
      return CALENDAR_CONFIG.conference.name;
    }
  } catch (e: unknown) {
    logger.error('[Bays] Failed to get calendar name for bay', { extra: { error: e } });
  }
  
  return null;
}

export function getCalendarNameForBay(bayId: number | null): string | null {
  return null;
}

export async function dismissStaffNotificationsForBooking(bookingId: number): Promise<void> {
  try {
    await bookingEvents.cleanupNotificationsForBooking(bookingId, { markRead: true });
  } catch (error: unknown) {
    logger.error('Failed to dismiss staff notifications', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}

export async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../../replit_integrations/auth/replitAuth');
  const isAdmin = await isAdminEmail(email);
  if (isAdmin) return true;
  
  const pool = getAuthPool();
  if (!pool) return false;
  
  try {
    const result = await queryWithRetry(
      pool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.length > 0;
  } catch (error: unknown) {
    return false;
  }
}

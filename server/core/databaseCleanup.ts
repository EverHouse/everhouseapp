import { db } from '../db';
import { bookingRequests, notifications, users, eventRsvps } from '../../shared/schema';
import { sql, eq, like, or, and, lt, inArray } from 'drizzle-orm';
import { logger } from './logger';

interface CleanupResult {
  testNotifications: number;
  testBookings: number;
  testUsers: number;
  testRsvps: number;
  oldCancelledBookings: number;
}

const TEST_EMAIL_PATTERNS = [
  'test-member@example.com',
  'test-staff@example.com',
  'notif-test-member@example.com',
  'notif-test-staff@example.com',
  'booking-test-%',
  'calendar-test-%',
  '%@test.example.com'
];

const TEST_NAME_PATTERNS = [
  'Test Member',
  'Test Staff',
  'Test User'
];

export async function cleanupTestData(): Promise<CleanupResult> {
  const result: CleanupResult = {
    testNotifications: 0,
    testBookings: 0,
    testUsers: 0,
    testRsvps: 0,
    oldCancelledBookings: 0
  };
  
  try {
    const testNotifications = await db
      .delete(notifications)
      .where(
        or(
          like(notifications.userEmail, 'test-%@example.com'),
          like(notifications.userEmail, 'notif-test-%'),
          like(notifications.userEmail, '%@test.example.com'),
          sql`${notifications.title} LIKE '%Test Member%'`,
          sql`${notifications.message} LIKE '%Test Member%'`
        )
      )
      .returning({ id: notifications.id });
    
    result.testNotifications = testNotifications.length;
    
    const testBookings = await db
      .delete(bookingRequests)
      .where(
        or(
          like(bookingRequests.userEmail, 'test-%@example.com'),
          like(bookingRequests.userEmail, 'notif-test-%'),
          like(bookingRequests.userEmail, '%@test.example.com'),
          like(bookingRequests.userName, 'Test %')
        )
      )
      .returning({ id: bookingRequests.id });
    
    result.testBookings = testBookings.length;
    
    const testRsvps = await db
      .delete(eventRsvps)
      .where(
        or(
          like(eventRsvps.userEmail, 'test-%@example.com'),
          like(eventRsvps.userEmail, 'notif-test-%'),
          like(eventRsvps.userEmail, '%@test.example.com')
        )
      )
      .returning({ id: eventRsvps.id });
    
    result.testRsvps = testRsvps.length;
    
    const testUsers = await db
      .delete(users)
      .where(
        or(
          like(users.email, 'test-%@example.com'),
          like(users.email, 'notif-test-%'),
          like(users.email, '%@test.example.com'),
          like(users.email, 'booking-test-%'),
          like(users.email, 'calendar-test-%')
        )
      )
      .returning({ id: users.id });
    
    result.testUsers = testUsers.length;
    
    logger.info('[Cleanup] Test data cleanup completed', {
      extra: { 
        event: 'cleanup.test_data',
        ...result
      }
    });
    
    return result;
  } catch (error: unknown) {
    logger.error('[Cleanup] Test data cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.test_data_failed' }
    });
    throw error;
  }
}

export async function cleanupOldBookings(daysOld: number = 90): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    
    const oldBookings = await db
      .delete(bookingRequests)
      .where(
        and(
          inArray(bookingRequests.status, ['cancelled', 'declined']),
          sql`${bookingRequests.requestDate} < ${cutoffDateStr}`
        )
      )
      .returning({ id: bookingRequests.id });
    
    logger.info(`[Cleanup] Removed ${oldBookings.length} old cancelled/declined bookings`, {
      extra: { 
        event: 'cleanup.old_bookings',
        count: oldBookings.length,
        daysOld,
        cutoffDate: cutoffDateStr
      }
    });
    
    return oldBookings.length;
  } catch (error: unknown) {
    logger.error('[Cleanup] Old bookings cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.old_bookings_failed' }
    });
    throw error;
  }
}

export async function cleanupOldNotifications(daysOld: number = 90): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    const oldNotifications = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.isRead, true),
          sql`${notifications.createdAt} < ${cutoffDate.toISOString()}`
        )
      )
      .returning({ id: notifications.id });
    
    logger.info(`[Cleanup] Removed ${oldNotifications.length} old read notifications`, {
      extra: { 
        event: 'cleanup.old_notifications',
        count: oldNotifications.length,
        daysOld
      }
    });
    
    return oldNotifications.length;
  } catch (error: unknown) {
    logger.error('[Cleanup] Old notifications cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.old_notifications_failed' }
    });
    throw error;
  }
}

export async function cleanupOldUnreadNotifications(daysOld: number = 60): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    const oldNotifications = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.isRead, false),
          sql`${notifications.createdAt} < ${cutoffDate.toISOString()}`
        )
      )
      .returning({ id: notifications.id });
    
    logger.info(`[Cleanup] Removed ${oldNotifications.length} old unread notifications (>${daysOld} days)`, {
      extra: { 
        event: 'cleanup.old_unread_notifications',
        count: oldNotifications.length,
        daysOld
      }
    });
    
    return oldNotifications.length;
  } catch (error: unknown) {
    logger.error('[Cleanup] Old unread notifications cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.old_unread_notifications_failed' }
    });
    throw error;
  }
}

export async function cleanupOldAvailabilityBlocks(daysOld: number = 30): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM availability_blocks 
      WHERE block_date < CURRENT_DATE - ${daysOld} * INTERVAL '1 day'
    `);
    
    const count = Number((result as Record<string, unknown>).rowCount || ((result as Record<string, unknown>).rows as unknown[] | undefined)?.length || 0);
    
    if (count > 0) {
      logger.info(`[Cleanup] Removed ${count} old availability blocks (>${daysOld} days)`, {
        extra: { event: 'cleanup.old_availability_blocks', count, daysOld }
      });
    }
    
    return count;
  } catch (error: unknown) {
    logger.error('[Cleanup] Old availability blocks cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.old_availability_blocks_failed' }
    });
    throw error;
  }
}

export async function cleanupOldJobs(daysToKeep: number = 7): Promise<number> {
  try {
    const { cleanupOldJobs: cleanupJobs } = await import('../core/jobQueue');
    const count = await cleanupJobs(daysToKeep);
    return count;
  } catch (error: unknown) {
    logger.error('[Cleanup] Old jobs cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.old_jobs_failed' }
    });
    return 0;
  }
}

export async function runScheduledCleanup(): Promise<void> {
  logger.info('[Cleanup] Starting scheduled cleanup', {
    extra: { event: 'cleanup.scheduled_start' }
  });
  
  try {
    await cleanupTestData();
    await cleanupOldBookings(90);
    await cleanupOldNotifications(90);
    await cleanupOldUnreadNotifications(60);
    await cleanupOldAvailabilityBlocks(30);
    await cleanupOldJobs(7);
    
    logger.info('[Cleanup] Scheduled cleanup completed', {
      extra: { event: 'cleanup.scheduled_complete' }
    });
  } catch (error: unknown) {
    logger.error('[Cleanup] Scheduled cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'cleanup.scheduled_failed' }
    });
  }
}

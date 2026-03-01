import { logger } from '../core/logger';
import { Router } from 'express';
import webpush from 'web-push';
import { isProduction } from '../core/db';
import { db } from '../db';
import { pushSubscriptions, users, notifications, events, eventRsvps, bookingRequests, wellnessClasses, wellnessEnrollments, facilityClosures } from '../../shared/schema';
import { eq, inArray, and, sql, or, isNull } from 'drizzle-orm';
import { formatTime12Hour, getTodayPacific, getTomorrowPacific } from '../utils/dateUtils';
import { sendNotificationToUser } from '../core/websocket';
import { isAuthenticated, isStaffOrAdmin } from '../core/middleware';
import { getErrorMessage, getErrorStatusCode } from '../utils/errorUtils';

const router = Router();

// Push notification configuration status
const vapidConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

if (vapidConfigured) {
  webpush.setVapidDetails(
    'mailto:hello@everclub.app',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  logger.info('[Push] VAPID keys configured - push notifications enabled');
} else {
  logger.warn('[Push] VAPID keys not configured - push notifications will be skipped');
}

export function isPushNotificationsEnabled(): boolean {
  return vapidConfigured;
}

export async function sendPushNotification(userEmail: string, payload: { title: string; body: string; url?: string; tag?: string }): Promise<{ sent: boolean; reason?: string }> {
  if (!vapidConfigured) {
    return { sent: false, reason: 'VAPID not configured' };
  }
  
  try {
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userEmail, userEmail));
    
    if (subs.length === 0) {
      return { sent: false, reason: 'No push subscriptions' };
    }
    
    const notifications = subs.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };
      
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
      } catch (err: unknown) {
        if (getErrorStatusCode(err) === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        }
      }
    });
    
    await Promise.all(notifications);
    return { sent: true };
  } catch (error: unknown) {
    logger.error('Failed to send push notification', { error: error instanceof Error ? error : new Error(String(error)) });
    return { sent: false, reason: 'Error sending push' };
  }
}

export async function sendPushNotificationToStaff(payload: { title: string; body: string; url?: string; tag?: string }): Promise<{ sent: boolean; count: number; reason?: string }> {
  if (!vapidConfigured) {
    return { sent: false, count: 0, reason: 'VAPID not configured' };
  }
  
  try {
    const staffSubscriptions = await db
      .selectDistinct({
        id: pushSubscriptions.id,
        userEmail: pushSubscriptions.userEmail,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userEmail, users.email))
      .where(inArray(users.role, ['admin', 'staff']));
    
    if (staffSubscriptions.length === 0) {
      return { sent: false, count: 0, reason: 'No staff subscriptions' };
    }
    
    const notifications = staffSubscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };
      
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
      } catch (err: unknown) {
        if (getErrorStatusCode(err) === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        }
      }
    });
    
    await Promise.all(notifications);
    return { sent: true, count: staffSubscriptions.length };
  } catch (error: unknown) {
    logger.error('Failed to send push notification to staff', { error: error instanceof Error ? error : new Error(String(error)) });
    return { sent: false, count: 0, reason: 'Error sending push' };
  }
}

export async function sendPushNotificationToAllMembers(payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  if (!vapidConfigured) {
    logger.info('[Push to Members] Skipped - VAPID not configured');
    return 0;
  }
  
  const results = { sent: 0, pushFailed: 0 };
  
  try {
    const allMembers = await db
      .select({ email: users.email })
      .from(users)
      .where(or(eq(users.role, 'member'), isNull(users.role)));
    
    if (allMembers.length === 0) {
      logger.info('[Push to Members] No members found');
      return 0;
    }
    
    const memberSubscriptions = await db
      .select({
        userEmail: pushSubscriptions.userEmail,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userEmail, users.email))
      .where(or(eq(users.role, 'member'), isNull(users.role)));
    
    const notificationValues = allMembers.map(member => ({
      userEmail: member.email,
      title: payload.title,
      message: payload.body,
      type: 'announcement' as const,
      relatedType: 'announcement' as const
    }));
    
    try {
      await db.insert(notifications).values(notificationValues);
      results.sent = notificationValues.length;
    } catch (err: unknown) {
      logger.error('[Push to Members] Failed to insert in-app notifications', { extra: { err: getErrorMessage(err) } });
    }
    
    for (const sub of memberSubscriptions) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
      } catch (err: unknown) {
        if (getErrorStatusCode(err) === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        }
        results.pushFailed++;
      }
    }
    
    logger.info('[Push to Members] Sent in-app notifications, push notifications. Failures', { extra: { resultsSent: results.sent, memberSubscriptionsLength_resultsPushFailed: memberSubscriptions.length - results.pushFailed, resultsPushFailed: results.pushFailed } });
    
    return results.sent;
  } catch (error: unknown) {
    logger.error('Failed to send push notification to members', { error: error instanceof Error ? error : new Error(String(error)) });
    return 0;
  }
}

router.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/api/push/subscribe', isAuthenticated, async (req, res) => {
  try {
    const { subscription } = req.body;
    const userEmail = req.session?.user?.email;
    
    if (!subscription) {
      return res.status(400).json({ error: 'subscription is required' });
    }
    
    const { endpoint, keys } = subscription;
    
    await db
      .insert(pushSubscriptions)
      .values({
        userEmail,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userEmail,
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
      });
    
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Push subscription error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/api/push/unsubscribe', isAuthenticated, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userEmail = req.session?.user?.email;
    
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }
    
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userEmail, userEmail)));
    
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Push unsubscribe error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

router.post('/api/push/test', isAuthenticated, async (req, res) => {
  try {
    const userEmail = req.session?.user?.email;
    
    await sendPushNotification(userEmail, {
      title: 'Test Notification',
      body: 'This is a test push notification from Ever Club!',
      url: '/profile'
    });
    
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Test push error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

export async function sendDailyReminders() {
  const results = { events: 0, bookings: 0, wellness: 0, pushFailed: 0, errors: [] as string[] };
  
  const tomorrowStr = getTomorrowPacific();
    
    const eventReminders = await db.select({
      userEmail: eventRsvps.userEmail,
      eventId: events.id,
      title: events.title,
      eventDate: events.eventDate,
      startTime: events.startTime,
      location: events.location
    })
    .from(eventRsvps)
    .innerJoin(events, eq(eventRsvps.eventId, events.id))
    .where(and(
      eq(eventRsvps.status, 'confirmed'),
      sql`DATE(${events.eventDate}) = ${tomorrowStr}`
    ));
    
    if (eventReminders.length > 0) {
      const eventNotifications = eventReminders.map(evt => ({
        userEmail: evt.userEmail,
        title: 'Event Tomorrow',
        message: `Reminder: ${evt.title} is tomorrow${evt.startTime ? ` at ${formatTime12Hour(evt.startTime)}` : ''}${evt.location ? ` - ${evt.location}` : ''}.`,
        type: 'event_reminder' as const,
        relatedId: evt.eventId,
        relatedType: 'event' as const
      }));
      
      try {
        await db.insert(notifications).values(eventNotifications);
        results.events = eventNotifications.length;
      } catch (err: unknown) {
        results.errors.push(`Event batch insert: ${getErrorMessage(err)}`);
      }
      
      for (const evt of eventReminders) {
        const message = `Reminder: ${evt.title} is tomorrow${evt.startTime ? ` at ${formatTime12Hour(evt.startTime)}` : ''}${evt.location ? ` - ${evt.location}` : ''}.`;
        sendPushNotification(evt.userEmail, { title: 'Event Tomorrow', body: message, url: '/events' })
          .catch((err) => {
            results.pushFailed++;
            logger.warn('[push] Push reminder delivery failed', {
              error: err instanceof Error ? err : new Error(String(err))
            });
          });
        // Send WebSocket notification for real-time updates
        sendNotificationToUser(evt.userEmail, {
          type: 'event_reminder',
          title: 'Event Tomorrow',
          message: message
        });
      }
    }
    
    const bookingReminders = await db.select({
      userEmail: bookingRequests.userEmail,
      id: bookingRequests.id,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      resourceId: bookingRequests.resourceId
    })
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.status, 'approved'),
      sql`DATE(${bookingRequests.requestDate}) = ${tomorrowStr}`
    ));
    
    if (bookingReminders.length > 0) {
      const bookingNotifications = bookingReminders.map(booking => ({
        userEmail: booking.userEmail,
        title: 'Booking Tomorrow',
        message: `Reminder: Your simulator booking is tomorrow at ${formatTime12Hour(booking.startTime)}${booking.resourceId ? ` on Bay ${booking.resourceId}` : ''}.`,
        type: 'booking_reminder' as const,
        relatedId: booking.id,
        relatedType: 'booking_request' as const
      }));
      
      try {
        await db.insert(notifications).values(bookingNotifications);
        results.bookings = bookingNotifications.length;
      } catch (err: unknown) {
        results.errors.push(`Booking batch insert: ${getErrorMessage(err)}`);
      }
      
      for (const booking of bookingReminders) {
        const message = `Reminder: Your simulator booking is tomorrow at ${formatTime12Hour(booking.startTime)}${booking.resourceId ? ` on Bay ${booking.resourceId}` : ''}.`;
        sendPushNotification(booking.userEmail, { title: 'Booking Tomorrow', body: message, url: '/sims' })
          .catch((err) => {
            results.pushFailed++;
            logger.warn('[push] Push reminder delivery failed', {
              error: err instanceof Error ? err : new Error(String(err))
            });
          });
        // Send WebSocket notification for real-time updates
        sendNotificationToUser(booking.userEmail, {
          type: 'booking_reminder',
          title: 'Booking Tomorrow',
          message: message
        });
      }
    }
    
    const wellnessReminders = await db.select({
      userEmail: wellnessEnrollments.userEmail,
      classId: wellnessClasses.id,
      title: wellnessClasses.title,
      date: wellnessClasses.date,
      time: wellnessClasses.time,
      instructor: wellnessClasses.instructor
    })
    .from(wellnessEnrollments)
    .innerJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
    .where(and(
      eq(wellnessEnrollments.status, 'confirmed'),
      sql`DATE(${wellnessClasses.date}) = ${tomorrowStr}`
    ));
    
    if (wellnessReminders.length > 0) {
      const wellnessNotifications = wellnessReminders.map(cls => ({
        userEmail: cls.userEmail,
        title: 'Wellness Class Tomorrow',
        message: `Reminder: ${cls.title} with ${cls.instructor} is tomorrow at ${cls.time}.`,
        type: 'wellness_reminder' as const,
        relatedId: cls.classId,
        relatedType: 'wellness_class' as const
      }));
      
      try {
        await db.insert(notifications).values(wellnessNotifications);
        results.wellness = wellnessNotifications.length;
      } catch (err: unknown) {
        results.errors.push(`Wellness batch insert: ${getErrorMessage(err)}`);
      }
      
      for (const cls of wellnessReminders) {
        const message = `Reminder: ${cls.title} with ${cls.instructor} is tomorrow at ${cls.time}.`;
        sendPushNotification(cls.userEmail, { title: 'Class Tomorrow', body: message, url: '/wellness' })
          .catch((err) => {
            results.pushFailed++;
            logger.warn('[push] Push reminder delivery failed', {
              error: err instanceof Error ? err : new Error(String(err))
            });
          });
        // Send WebSocket notification for real-time updates
        sendNotificationToUser(cls.userEmail, {
          type: 'wellness_reminder',
          title: 'Class Tomorrow',
          message: message
        });
      }
    }
    
  logger.info('[Daily Reminders] Sent event, booking, wellness reminders. Push failures', { extra: { resultsEvents: results.events, resultsBookings: results.bookings, resultsWellness: results.wellness, resultsPushFailed: results.pushFailed } });
  
  return {
    success: true,
    message: `Sent ${results.events} event, ${results.bookings} booking, and ${results.wellness} wellness reminders`,
    ...results
  };
}

router.post('/api/push/send-daily-reminders', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await sendDailyReminders();
    res.json(result);
  } catch (error: unknown) {
    logger.error('Daily reminders error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send daily reminders' });
  }
});

// Send morning notifications for closures/notices starting today
export async function sendMorningClosureNotifications() {
  const results = { closures: 0, skipped: 0, pushFailed: 0, errors: [] as string[] };
  
  try {
    const todayStr = getTodayPacific();
    
    // Find closures that:
    // 1. Start today
    // 2. Are published (needsReview = false)
    // 3. Are active
    // 4. Affect booking availability (affectedAreas != 'none')
    const todayClosures = await db
      .select({
        id: facilityClosures.id,
        title: facilityClosures.title,
        reason: facilityClosures.reason,
        noticeType: facilityClosures.noticeType,
        startDate: facilityClosures.startDate,
        startTime: facilityClosures.startTime,
        endTime: facilityClosures.endTime,
        affectedAreas: facilityClosures.affectedAreas
      })
      .from(facilityClosures)
      .where(and(
        sql`DATE(${facilityClosures.startDate}) = ${todayStr}`,
        eq(facilityClosures.isActive, true),
        eq(facilityClosures.needsReview, false),
        sql`${facilityClosures.affectedAreas} IS NOT NULL AND ${facilityClosures.affectedAreas} != 'none'`
      ));
    
    if (todayClosures.length === 0) {
      logger.info('[Morning Notifications] No closures starting today');
      return { success: true, message: 'No closures starting today', ...results };
    }
    
    // Check which closures have already been notified (idempotency check)
    // Look for existing closure_today notifications for these closure IDs
    const closureIds = todayClosures.map(c => c.id);
    const existingNotifications = await db
      .select({
        relatedId: notifications.relatedId
      })
      .from(notifications)
      .where(and(
        eq(notifications.type, 'closure_today'),
        eq(notifications.relatedType, 'closure'),
        inArray(notifications.relatedId, closureIds)
      ))
      .groupBy(notifications.relatedId);
    
    const alreadyNotifiedIds = new Set(existingNotifications.map(n => n.relatedId));
    const closuresToNotify = todayClosures.filter(c => !alreadyNotifiedIds.has(c.id));
    
    if (closuresToNotify.length === 0) {
      const skippedCount = todayClosures.length;
      logger.info('[Morning Notifications] All closures already notified today', { extra: { skippedCount } });
      return { success: true, message: `All ${skippedCount} closures already notified`, ...results, skipped: skippedCount };
    }
    
    results.skipped = todayClosures.length - closuresToNotify.length;
    
    // Get all member emails
    const allMembers = await db
      .select({ email: users.email })
      .from(users)
      .where(or(eq(users.role, 'member'), isNull(users.role)));
    
    if (allMembers.length === 0) {
      logger.info('[Morning Notifications] No members to notify');
      return { success: true, message: 'No members to notify', ...results };
    }
    
    // Get all member push subscriptions
    const memberSubscriptions = await db
      .select({
        userEmail: pushSubscriptions.userEmail,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userEmail, users.email))
      .where(or(eq(users.role, 'member'), isNull(users.role)));
    
    for (const closure of closuresToNotify) {
      const title = closure.noticeType || closure.title || 'Notice';
      const timeInfo = closure.startTime && closure.endTime 
        ? ` (${formatTime12Hour(closure.startTime)} - ${formatTime12Hour(closure.endTime)})`
        : '';
      const message = closure.reason 
        ? `${closure.reason}${timeInfo}`
        : `${title}${timeInfo}`;
      
      // Create in-app notifications for all members
      const notificationValues = allMembers.map(member => ({
        userEmail: member.email,
        title: `Today: ${title}`,
        message: message,
        type: 'closure_today' as const,
        relatedId: closure.id,
        relatedType: 'closure' as const
      }));
      
      try {
        await db.insert(notifications).values(notificationValues);
        results.closures++;
      } catch (err: unknown) {
        results.errors.push(`Closure notification insert: ${getErrorMessage(err)}`);
      }
      
      // Send push notifications
      for (const sub of memberSubscriptions) {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        
        try {
          await webpush.sendNotification(pushSubscription, JSON.stringify({
            title: `Today: ${title}`,
            body: message,
            url: '/updates?tab=notices'
          }));
        } catch (err: unknown) {
          if (getErrorStatusCode(err) === 410) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
          }
          results.pushFailed++;
        }
      }
    }
    
    logger.info('[Morning Notifications] Sent closure notifications, skipped (already notified). Push failures', { extra: { resultsClosures: results.closures, resultsSkipped: results.skipped, resultsPushFailed: results.pushFailed } });
    
    return {
      success: true,
      message: `Sent notifications for ${results.closures} closures starting today (${results.skipped} already notified)`,
      ...results
    };
  } catch (error: unknown) {
    logger.error('[Morning Notifications] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    results.errors.push(getErrorMessage(error));
    return { success: false, message: 'Failed to send morning notifications', ...results };
  }
}

router.post('/api/push/send-morning-closure-notifications', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await sendMorningClosureNotifications();
    res.json(result);
  } catch (error: unknown) {
    logger.error('Morning closure notifications error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send morning closure notifications' });
  }
});

export default router;

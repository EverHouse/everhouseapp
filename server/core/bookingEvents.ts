import { db } from '../db';
import { notifications, staffUsers, bookingRequests } from '../../shared/schema';
import { eq, and, or } from 'drizzle-orm';
import { sendNotificationToUser, broadcastToStaff, broadcastBookingEvent } from './websocket';
import { sendPushNotification, sendPushNotificationToStaff } from '../routes/push';
import { formatTime12Hour, formatDateDisplayWithDay } from '../utils/dateUtils';

export type BookingEventType = 
  | 'booking_created'
  | 'booking_approved'
  | 'booking_declined'
  | 'booking_cancelled'
  | 'booking_rescheduled'
  | 'booking_checked_in';

export interface BookingEventData {
  bookingId: number;
  memberEmail: string;
  memberName?: string;
  resourceId?: number;
  resourceName?: string;
  resourceType?: string;
  bookingDate: string;
  startTime: string;
  endTime?: string;
  status: string;
  previousStatus?: string;
  actionBy?: 'member' | 'staff';
  staffEmail?: string;
  isTrackmanImport?: boolean;
  isManualBooking?: boolean;
}

interface PublishOptions {
  notifyMember?: boolean;
  notifyStaff?: boolean;
  cleanupNotifications?: boolean;
  memberNotification?: {
    title: string;
    message: string;
    type: string;
  };
  staffNotification?: {
    title: string;
    message: string;
  };
}

function formatBookingDateTime(date: string, time: string): string {
  const formattedDate = formatDateDisplayWithDay(date);
  const formattedTime = formatTime12Hour(time);
  return `${formattedDate} at ${formattedTime}`;
}

export async function cleanupNotificationsForBooking(
  bookingId: number,
  options: { delete?: boolean; markRead?: boolean } = { delete: false, markRead: true }
): Promise<number> {
  try {
    if (options.delete) {
      const result = await db.delete(notifications)
        .where(and(
          eq(notifications.relatedId, bookingId),
          or(
            eq(notifications.relatedType, 'booking'),
            eq(notifications.relatedType, 'booking_request')
          )
        ))
        .returning({ id: notifications.id });
      
      if (result.length > 0) {
        console.log(`[BookingEvents] Deleted ${result.length} notifications for booking ${bookingId}`);
      }
      return result.length;
    } else if (options.markRead) {
      const result = await db.update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.relatedId, bookingId),
          or(
            eq(notifications.relatedType, 'booking'),
            eq(notifications.relatedType, 'booking_request')
          )
        ))
        .returning({ id: notifications.id });
      
      if (result.length > 0) {
        console.log(`[BookingEvents] Marked ${result.length} notifications as read for booking ${bookingId}`);
      }
      return result.length;
    }
    return 0;
  } catch (error) {
    console.error('[BookingEvents] Failed to cleanup notifications:', error);
    return 0;
  }
}

export async function validateBookingStatus(
  bookingId: number,
  allowedStatuses: string[]
): Promise<{ valid: boolean; currentStatus?: string; booking?: any }> {
  try {
    const [booking] = await db.select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId))
      .limit(1);
    
    if (!booking) {
      return { valid: false, currentStatus: undefined };
    }
    
    const isValid = allowedStatuses.includes(booking.status);
    return { valid: isValid, currentStatus: booking.status, booking };
  } catch (error) {
    console.error('[BookingEvents] Failed to validate booking status:', error);
    return { valid: false };
  }
}

export async function publish(
  eventType: BookingEventType,
  data: BookingEventData,
  options: PublishOptions = {}
): Promise<void> {
  const {
    notifyMember = true,
    notifyStaff = true,
    cleanupNotifications = false,
    memberNotification,
    staffNotification
  } = options;

  const friendlyDateTime = formatBookingDateTime(data.bookingDate, data.startTime);
  const resourceLabel = data.resourceType === 'conference_room' ? 'conference room' : 'golf simulator';

  console.log(`[BookingEvents] Publishing ${eventType} for booking ${data.bookingId}`);

  try {
    if (cleanupNotifications) {
      const shouldDelete = eventType === 'booking_cancelled' || eventType === 'booking_declined';
      await cleanupNotificationsForBooking(data.bookingId, { 
        delete: shouldDelete, 
        markRead: !shouldDelete 
      });
    }

    if (notifyMember && memberNotification) {
      try {
        await db.insert(notifications).values({
          userEmail: data.memberEmail,
          title: memberNotification.title,
          message: memberNotification.message,
          type: memberNotification.type,
          relatedId: data.bookingId,
          relatedType: 'booking'
        });
      } catch (err) {
        console.error('[BookingEvents] Failed to create member notification:', err);
      }

      sendNotificationToUser(data.memberEmail, {
        type: 'notification',
        title: memberNotification.title,
        message: memberNotification.message,
        data: { bookingId: data.bookingId, eventType }
      }, { action: eventType, bookingId: data.bookingId, resourceType: data.resourceType, triggerSource: 'bookingEvents.ts' });

      sendPushNotification(data.memberEmail, {
        title: memberNotification.title,
        body: memberNotification.message,
        url: '/dashboard'
      }).catch(err => console.error('[BookingEvents] Push notification failed:', err));
    }

    if (notifyStaff) {
      const staffEvent = {
        eventType,
        bookingId: data.bookingId,
        memberEmail: data.memberEmail,
        memberName: data.memberName,
        resourceId: data.resourceId,
        resourceName: data.resourceName,
        resourceType: data.resourceType,
        bookingDate: data.bookingDate,
        startTime: data.startTime,
        endTime: data.endTime,
        status: data.status,
        actionBy: data.actionBy,
        timestamp: new Date().toISOString()
      };

      broadcastBookingEvent(staffEvent);

      if (staffNotification) {
        const staffEmails = await getStaffEmails();
        for (const email of staffEmails) {
          try {
            await db.insert(notifications).values({
              userEmail: email,
              title: staffNotification.title,
              message: staffNotification.message,
              type: 'booking',
              relatedId: data.bookingId,
              relatedType: 'booking_request'
            });
          } catch (err) {
            console.error(`[BookingEvents] Failed to create staff notification for ${email}:`, err);
          }
        }

        sendPushNotificationToStaff({
          title: staffNotification.title,
          body: staffNotification.message,
          url: '/admin'
        }).catch(err => console.error('[BookingEvents] Staff push notification failed:', err));
      }
    }

    console.log(`[BookingEvents] Successfully published ${eventType}`);
  } catch (error) {
    console.error(`[BookingEvents] Failed to publish ${eventType}:`, error);
  }
}

async function getStaffEmails(): Promise<string[]> {
  try {
    const staff = await db.select({ email: staffUsers.email })
      .from(staffUsers)
      .where(eq(staffUsers.isActive, true));
    return staff.map(s => s.email.toLowerCase());
  } catch (error) {
    console.error('[BookingEvents] Failed to get staff emails:', error);
    return [];
  }
}

export const bookingEvents = {
  publish,
  cleanupNotificationsForBooking,
  validateBookingStatus,
  formatBookingDateTime
};

export default bookingEvents;

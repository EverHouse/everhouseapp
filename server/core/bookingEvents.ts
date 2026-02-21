import { db } from '../db';
import { notifications, staffUsers, bookingRequests, bookingParticipants, users } from '../../shared/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { sendNotificationToUser, broadcastToStaff, broadcastBookingEvent } from './websocket';
import { sendPushNotification, sendPushNotificationToStaff } from '../routes/push';
import { formatTime12Hour, formatDateDisplayWithDay } from '../utils/dateUtils';

import { logger } from './logger';
interface RequestParticipant {
  email: string;
  type: 'member' | 'guest';
}

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
  durationMinutes?: number;
  playerCount?: number;
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
        logger.info(`[BookingEvents] Deleted ${result.length} notifications for booking ${bookingId}`);
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
        logger.info(`[BookingEvents] Marked ${result.length} notifications as read for booking ${bookingId}`);
      }
      return result.length;
    }
    return 0;
  } catch (error: unknown) {
    logger.error('[BookingEvents] Failed to cleanup notifications:', { error: error });
    return 0;
  }
}

export async function validateBookingStatus(
  bookingId: number,
  allowedStatuses: string[]
): Promise<{ valid: boolean; currentStatus?: string; booking?: Record<string, unknown> }> {
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
  } catch (error: unknown) {
    logger.error('[BookingEvents] Failed to validate booking status:', { error: error });
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

  logger.info(`[BookingEvents] Publishing ${eventType} for booking ${data.bookingId}`);

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
      } catch (err: unknown) {
        logger.error('[BookingEvents] Failed to create member notification:', { error: err });
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
      }).catch(err => logger.error('[BookingEvents] Push notification failed:', { error: err }));
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
        durationMinutes: data.durationMinutes,
        playerCount: data.playerCount,
        status: data.status,
        actionBy: data.actionBy,
        timestamp: new Date().toISOString()
      };

      broadcastBookingEvent(staffEvent);

      if (staffNotification) {
        const staffEmails = await getStaffEmails();
        if (staffEmails.length > 0) {
          try {
            await db.insert(notifications).values(
              staffEmails.map(email => ({
                userEmail: email,
                title: staffNotification.title,
                message: staffNotification.message,
                type: 'booking',
                relatedId: data.bookingId,
                relatedType: 'booking_request'
              }))
            );
          } catch (err: unknown) {
            logger.error('[BookingEvents] Failed to create staff notifications:', { error: err });
          }
        }

        sendPushNotificationToStaff({
          title: staffNotification.title,
          body: staffNotification.message,
          url: '/admin'
        }).catch(err => logger.error('[BookingEvents] Staff push notification failed:', { error: err }));
      }
    }

    logger.info(`[BookingEvents] Successfully published ${eventType}`);
  } catch (error: unknown) {
    logger.error(`[BookingEvents] Failed to publish ${eventType}:`, { error: error });
  }
}

async function getStaffEmails(): Promise<string[]> {
  try {
    const staff = await db.select({ email: staffUsers.email })
      .from(staffUsers)
      .where(eq(staffUsers.isActive, true));
    return staff.map(s => s.email.toLowerCase());
  } catch (error: unknown) {
    logger.error('[BookingEvents] Failed to get staff emails:', { error: error });
    return [];
  }
}

export async function linkAndNotifyParticipants(
  bookingId: number,
  options?: {
    skipPrimaryMember?: boolean;
    trackmanBookingId?: string;
    linkedBy?: string;
    bayName?: string;
  }
): Promise<{ linkedMembers: number; linkedGuests: number; notified: number }> {
  const result = { linkedMembers: 0, linkedGuests: 0, notified: 0 };
  
  try {
    const [booking] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      requestParticipants: bookingRequests.requestParticipants,
      declaredPlayerCount: bookingRequests.declaredPlayerCount,
      trackmanBookingId: bookingRequests.trackmanBookingId
    })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      logger.warn(`[BookingEvents] Booking ${bookingId} not found`);
      return result;
    }
    
    const participants = (booking.requestParticipants || []) as RequestParticipant[];
    if (participants.length === 0) {
      return result;
    }
    
    const ownerEmail = booking.userEmail?.toLowerCase()?.trim();
    
    const bookingForSession = await db.select({ sessionId: bookingRequests.sessionId })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId))
      .limit(1);
    const bpSessionId = bookingForSession[0]?.sessionId;

    let existingEmails = new Set<string>();
    let existingGuestEmails = new Set<string>();

    if (bpSessionId) {
      const existingParticipants = await db.select({
        email: users.email,
        participantType: bookingParticipants.participantType,
        guestEmail: sql<string | null>`(SELECT g.email FROM guests g WHERE g.id = ${bookingParticipants.guestId})`
      })
        .from(bookingParticipants)
        .leftJoin(users, eq(bookingParticipants.userId, users.id))
        .where(eq(bookingParticipants.sessionId, bpSessionId));

      existingEmails = new Set(
        existingParticipants
          .filter(p => p.participantType !== 'guest' && p.email)
          .map(p => p.email!.toLowerCase())
      );
      existingGuestEmails = new Set(
        existingParticipants
          .filter(p => p.participantType === 'guest' && p.guestEmail)
          .map(p => p.guestEmail!.toLowerCase())
      );
    }
    
    const processedEmails = new Set<string>([...existingEmails, ...existingGuestEmails]);
    if (ownerEmail) {
      processedEmails.add(ownerEmail);
    }
    
    let nextSlot = 2;
    if (bpSessionId) {
      const participantCountResult = await db.select({ count: sql<number>`COUNT(*)` })
        .from(bookingParticipants)
        .where(eq(bookingParticipants.sessionId, bpSessionId));
      nextSlot = (participantCountResult[0]?.count || 1) + 1;
    }
    
    const linkedBy = options?.linkedBy || 'auto_link';
    const bayName = options?.bayName || 'Bay';
    const bookingDateStr = typeof booking.requestDate === 'string' 
      ? booking.requestDate 
      : (booking.requestDate as Date).toISOString().split('T')[0];
    const startTimeStr = booking.startTime?.substring(0, 5) || '';
    
    for (const participant of participants) {
      const email = participant.email?.toLowerCase()?.trim();
      if (!email) continue;
      
      if (processedEmails.has(email)) continue;
      processedEmails.add(email);
      
      if (participant.type === 'member') {
        if (existingEmails.has(email)) continue;
        
        const [member] = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(sql`LOWER(${users.email}) = ${email}`);
        
        existingEmails.add(email);

        if (bpSessionId && member?.id) {
          try {
            await db.insert(bookingParticipants).values({
              sessionId: bpSessionId,
              userId: member.id,
              participantType: 'member',
              displayName: `${member.firstName || ''} ${member.lastName || ''}`.trim() || email,
              inviteStatus: 'accepted',
              createdAt: new Date()
            }).onConflictDoNothing();
          } catch (insertErr: unknown) {
            logger.error('[BookingEvents] Failed to insert member participant', { error: insertErr });
          }
        }

        result.linkedMembers++;
        
        try {
          const notificationMsg = `You have been added to a simulator booking on ${bookingDateStr} at ${startTimeStr} (${bayName}).`;
          await db.insert(notifications).values({
            userEmail: email,
            title: 'Added to Booking',
            message: notificationMsg,
            type: 'booking',
            relatedId: bookingId,
            relatedType: 'booking'
          });
          
          sendNotificationToUser(email, {
            type: 'booking_participant_added',
            title: 'Added to Booking',
            message: notificationMsg,
            data: { bookingId }
          });
          
          result.notified++;
        } catch (notifErr: unknown) {
          logger.error(`[BookingEvents] Failed to notify participant ${email}:`, { error: notifErr });
        }
      } else if (participant.type === 'guest') {
        if (existingGuestEmails.has(email)) continue;
        
        existingGuestEmails.add(email);

        if (bpSessionId) {
          try {
            await db.insert(bookingParticipants).values({
              sessionId: bpSessionId,
              userId: null,
              participantType: 'guest',
              displayName: participant.name || email,
              inviteStatus: 'accepted',
              createdAt: new Date()
            });
          } catch (insertErr: unknown) {
            logger.error('[BookingEvents] Failed to insert guest participant', { error: insertErr });
          }
        }

        result.linkedGuests++;
      }
    }
    
    logger.info(`[BookingEvents] Linked ${result.linkedMembers} members and ${result.linkedGuests} guests to booking ${bookingId}, notified ${result.notified}`);
    return result;
  } catch (error: unknown) {
    logger.error(`[BookingEvents] Failed to link participants for booking ${bookingId}:`, { error: error });
    return result;
  }
}

export const bookingEvents = {
  publish,
  cleanupNotificationsForBooking,
  validateBookingStatus,
  formatBookingDateTime,
  linkAndNotifyParticipants
};

export default bookingEvents;

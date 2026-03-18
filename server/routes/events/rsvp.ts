import { Router } from 'express';
import { isAuthenticated, isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { events, eventRsvps, users, notifications } from '../../../shared/schema';
import { eq, and, or, sql, gte, desc } from 'drizzle-orm';
import { sendPushNotification } from '../push';
import { notifyAllStaff, notifyMember } from '../../core/notificationService';
import { formatDateDisplayWithDay, getTodayPacific } from '../../utils/dateUtils';
import { sendNotificationToUser, broadcastToStaff } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../core/logger';
import { getMemberDisplayName } from './shared';

const router = Router();

router.get('/api/rsvps', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { user_email: rawEmail } = req.query;
    const user_email = rawEmail ? decodeURIComponent(rawEmail as string) : null;
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    
    if (user_email && user_email.toLowerCase() !== sessionEmail) {
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const result = await queryWithRetry(
              pool,
              'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
              [sessionEmail]
            );
            isStaff = (result as unknown as { rows: Array<Record<string, unknown>> }).rows.length > 0;
          } catch (error: unknown) {
            logger.warn('[events] Staff check query failed', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only view your own RSVPs' });
        }
      }
    }
    
    const { include_past } = req.query;
    
    const conditions = [
      eq(eventRsvps.status, 'confirmed'),
    ];
    
    if (include_past !== 'true') {
      conditions.push(gte(events.eventDate, getTodayPacific()));
    }
    
    if (user_email) {
      const userLookup = await db.select({ id: users.id })
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${user_email})`)
        .limit(1);
      
      if (userLookup.length > 0) {
        conditions.push(
          or(
            eq(eventRsvps.userEmail, user_email),
            eq(eventRsvps.matchedUserId, userLookup[0].id)
          )!
        );
      } else {
        conditions.push(eq(eventRsvps.userEmail, user_email));
      }
    }
    
    const result = await db.select({
      id: eventRsvps.id,
      event_id: eventRsvps.eventId,
      user_email: eventRsvps.userEmail,
      status: eventRsvps.status,
      created_at: eventRsvps.createdAt,
      order_date: eventRsvps.orderDate,
      title: events.title,
      event_date: events.eventDate,
      start_time: events.startTime,
      end_time: events.endTime,
      location: events.location,
      category: events.category,
      image_url: events.imageUrl,
    })
    .from(eventRsvps)
    .innerJoin(events, eq(eventRsvps.eventId, events.id))
    .where(and(...conditions))
    .orderBy(events.eventDate, events.startTime)
    .limit(500);
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/api/rsvps', isAuthenticated, async (req, res) => {
  try {
    const { event_id, user_email: raw_user_email } = req.body;
    const user_email = raw_user_email?.trim()?.toLowerCase();
    
    if (!event_id || !user_email) {
      return res.status(400).json({ error: 'Missing event_id or user_email' });
    }
    
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const isOwnAction = sessionEmail === user_email.toLowerCase();
    const isAdminOrStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    if (!isOwnAction && !isAdminOrStaff) {
      return res.status(403).json({ error: 'You can only perform this action for yourself' });
    }
    
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate,
      startTime: events.startTime,
      location: events.location,
      maxAttendees: events.maxAttendees
    }).from(events).where(eq(events.id, event_id));
    
    if (eventData.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const evt = eventData[0];
    const formattedDate = formatDateDisplayWithDay(evt.eventDate);
    const formattedTime = evt.startTime?.substring(0, 5) || '';
    const memberMessage = `You're confirmed for ${evt.title} on ${formattedDate}${formattedTime ? ` at ${formattedTime}` : ''}${evt.location ? ` - ${evt.location}` : ''}.`;
    const memberName = await getMemberDisplayName(user_email);
    const staffMessage = `${memberName} RSVP'd for ${evt.title} on ${formattedDate}`;
    
    const result = await db.transaction(async (tx) => {
      if (evt.maxAttendees && evt.maxAttendees > 0) {
        await tx.execute(sql`SELECT id FROM events WHERE id = ${event_id} FOR UPDATE`);
        const rsvpCountResult = await tx.select({ count: sql<number>`count(*)::int` })
          .from(eventRsvps)
          .where(and(eq(eventRsvps.eventId, event_id), eq(eventRsvps.status, 'confirmed')));
        
        const rsvpCount = rsvpCountResult[0]?.count || 0;
        
        if (rsvpCount >= evt.maxAttendees) {
          throw new Error('Event is at capacity');
        }
      }
      
      const rsvpResult = await tx.insert(eventRsvps).values({
        eventId: event_id,
        userEmail: user_email,
        checkedIn: true,
      }).onConflictDoUpdate({
        target: [eventRsvps.eventId, eventRsvps.userEmail],
        set: { status: 'confirmed', checkedIn: true },
      }).returning();
      
      await tx.insert(notifications).values({
        userEmail: user_email,
        title: 'Event RSVP Confirmed',
        message: memberMessage,
        type: 'event_rsvp',
        relatedId: event_id,
        relatedType: 'event'
      });
      
      return rsvpResult[0];
    });
    
    notifyAllStaff(
      'New Event RSVP',
      staffMessage,
      'event_rsvp',
      { relatedId: event_id, relatedType: 'event', url: '/admin/calendar' }
    ).catch((err: unknown) => logger.warn('Failed to notify staff of event RSVP', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
    
    sendPushNotification(user_email, {
      title: 'RSVP Confirmed!',
      body: memberMessage,
      url: '/events',
      tag: `event-rsvp-${event_id}`
    }).catch((err: unknown) => logger.error('Push notification failed', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
    
    sendNotificationToUser(user_email, {
      type: 'notification',
      title: 'Event RSVP Confirmed',
      message: memberMessage,
      data: { eventId: event_id, eventType: 'rsvp_created' }
    }, { action: 'rsvp_created', eventId: event_id, triggerSource: 'events.ts' });
    
    broadcastToStaff({
      type: 'rsvp_event',
      action: 'rsvp_created',
      eventId: event_id,
      memberEmail: user_email
    });
    
    res.status(201).json(result);
  } catch (error: unknown) {
    if (getErrorMessage(error) === 'Event is at capacity') {
      return res.status(400).json({ error: 'Event is at capacity' });
    }
    logger.error('RSVP creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create RSVP. Staff notification is required.' });
  }
});

router.delete('/api/rsvps/:event_id/:user_email', isAuthenticated, async (req, res) => {
  try {
    const { event_id, user_email: rawUserEmail } = req.params;
    const parsedEventId = parseInt(event_id as string, 10);
    if (isNaN(parsedEventId)) return res.status(400).json({ error: 'Invalid event ID' });
    const user_email = decodeURIComponent(rawUserEmail as string).trim().toLowerCase();
    
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const isOwnAction = sessionEmail === user_email;
    const isAdminOrStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    if (!isOwnAction && !isAdminOrStaff) {
      return res.status(403).json({ error: 'You can only perform this action for yourself' });
    }
    
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate,
    }).from(events).where(eq(events.id, parsedEventId));
    
    if (eventData.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const evt = eventData[0];
    const formattedDate = formatDateDisplayWithDay(evt.eventDate);
    const memberName = await getMemberDisplayName(user_email as string);
    const staffMessage = `${memberName} cancelled their RSVP for ${evt.title} on ${formattedDate}`;
    
    await db.transaction(async (tx) => {
      await tx.update(eventRsvps)
        .set({ status: 'cancelled' })
        .where(and(
          eq(eventRsvps.eventId, parsedEventId),
          eq(eventRsvps.userEmail, user_email as string)
        ));
    });
    
    notifyAllStaff(
      'Event RSVP Cancelled',
      staffMessage,
      'event_rsvp_cancelled',
      { relatedId: parsedEventId, relatedType: 'event', url: '/admin/calendar' }
    ).catch((err: unknown) => logger.warn('Failed to notify staff of RSVP cancellation', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
    
    notifyMember({
      userEmail: user_email as string,
      title: 'RSVP Cancelled',
      message: `Your RSVP for "${evt.title}" on ${formattedDate} has been cancelled`,
      type: 'event',
      relatedId: parsedEventId,
      relatedType: 'event',
      url: '/events'
    }).catch((err: unknown) => logger.warn('Failed to notify member of RSVP cancellation', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
    
    broadcastToStaff({
      type: 'rsvp_event',
      action: 'rsvp_cancelled',
      eventId: parsedEventId,
      memberEmail: user_email
    });
    
    logFromRequest(req, 'cancel_event_rsvp', 'event', event_id as string, undefined, {
      member_email: user_email,
      event_title: evt.title,
      event_date: evt.eventDate
    });
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('RSVP cancellation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cancel RSVP. Staff notification is required.' });
  }
});

router.get('/api/events/:id/rsvps', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
    const result = await db.select({
      id: eventRsvps.id,
      userEmail: eventRsvps.userEmail,
      status: eventRsvps.status,
      source: eventRsvps.source,
      attendeeName: eventRsvps.attendeeName,
      ticketClass: eventRsvps.ticketClass,
      checkedIn: eventRsvps.checkedIn,
      matchedUserId: eventRsvps.matchedUserId,
      guestCount: eventRsvps.guestCount,
      orderDate: eventRsvps.orderDate,
      createdAt: eventRsvps.createdAt,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
    })
    .from(eventRsvps)
    .leftJoin(users, or(
      eq(eventRsvps.userEmail, users.email),
      eq(eventRsvps.matchedUserId, users.id)
    ))
    .where(and(
      eq(eventRsvps.eventId, eventId),
      eq(eventRsvps.status, 'confirmed')
    ))
    .orderBy(desc(eventRsvps.createdAt));
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch RSVPs' });
  }
});

router.delete('/api/events/:eventId/rsvps/:rsvpId', isStaffOrAdmin, async (req, res) => {
  try {
    const { eventId, rsvpId } = req.params;
    const parsedEventId = parseInt(eventId as string, 10);
    const parsedRsvpId = parseInt(rsvpId as string, 10);
    if (isNaN(parsedEventId) || isNaN(parsedRsvpId)) return res.status(400).json({ error: 'Invalid event or RSVP ID' });
    
    const existingRsvp = await db.select()
      .from(eventRsvps)
      .where(and(
        eq(eventRsvps.id, parsedRsvpId),
        eq(eventRsvps.eventId, parsedEventId)
      ))
      .limit(1);
    
    if (existingRsvp.length === 0) {
      return res.status(404).json({ error: 'RSVP not found' });
    }
    
    const rsvp = existingRsvp[0];
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate
    }).from(events).where(eq(events.id, parsedEventId));
    
    await db.delete(eventRsvps)
      .where(eq(eventRsvps.id, parsedRsvpId));
    
    const event = eventData[0] || { title: 'Unknown', eventDate: '' };
    logFromRequest(req, 'remove_rsvp', 'event', eventId as string, event.title, {
      rsvp_email: rsvp.userEmail,
      attendee_name: rsvp.attendeeName,
      event_date: event.eventDate
    });
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('RSVP deletion error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete RSVP' });
  }
});

router.post('/api/events/:id/rsvps/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const parsedEventId = parseInt(id as string, 10);
    if (isNaN(parsedEventId)) return res.status(400).json({ error: 'Invalid event ID' });
    const { email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existingRsvp = await db.select()
      .from(eventRsvps)
      .where(and(
        eq(eventRsvps.eventId, parsedEventId),
        eq(eventRsvps.userEmail, email),
        eq(eventRsvps.status, 'confirmed')
      ))
      .limit(1);
    
    if (existingRsvp.length > 0) {
      return res.status(400).json({ error: 'This email is already registered for this event' });
    }

    await db.insert(eventRsvps).values({
      eventId: parsedEventId,
      userEmail: email,
      status: 'confirmed',
      checkedIn: true,
    });
    
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate
    }).from(events).where(eq(events.id, parsedEventId));
    
    const event = eventData[0] || { title: 'Unknown', eventDate: '' };
    logFromRequest(req, 'manual_rsvp', 'event', id as string, event.title, {
      attendee_email: email,
      event_date: event.eventDate
    });
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Manual RSVP error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add RSVP' });
  }
});

export default router;

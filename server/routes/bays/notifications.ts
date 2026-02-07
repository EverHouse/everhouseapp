import { Router } from 'express';
import { db } from '../../db';
import { bookingRequests, resources } from '../../../shared/schema';
import { eq, or, gte, desc } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { formatTime12Hour } from '../../utils/dateUtils';
import { logAndRespond } from '../../core/logger';
import { getSessionUser } from '../../types/session';

const router = Router();

router.get('/api/recent-activity', isStaffOrAdmin, async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activities: Array<{
      id: string;
      type: 'booking_created' | 'booking_approved' | 'check_in' | 'cancellation' | 'tour' | 'notification';
      timestamp: string;
      primary_text: string;
      secondary_text: string;
      icon: string;
    }> = [];
    
    const userEmail = getSessionUser(req)?.email;
    if (userEmail) {
      const { notifications } = await import('../../../shared/models/auth');
      const notificationResults = await db.select()
        .from(notifications)
        .where(
          or(
            eq(notifications.userEmail, userEmail),
            gte(notifications.createdAt, twentyFourHoursAgo)
          )!
        )
        .orderBy(desc(notifications.createdAt))
        .limit(10);
      
      for (const notif of notificationResults) {
        let icon = 'notifications';
        if (notif.type === 'booking' || notif.relatedType === 'booking_request') {
          icon = 'calendar_month';
        } else if (notif.type === 'tour' || notif.relatedType === 'tour') {
          icon = 'directions_walk';
        } else if (notif.type === 'booking_cancelled') {
          icon = 'event_busy';
        }
        
        activities.push({
          id: `notification_${notif.id}`,
          type: 'notification',
          timestamp: notif.createdAt?.toISOString() || new Date().toISOString(),
          primary_text: notif.title,
          secondary_text: notif.message.length > 50 ? notif.message.substring(0, 50) + '...' : notif.message,
          icon
        });
      }
    }

    const bookingResults = await db.select({
      id: bookingRequests.id,
      userName: bookingRequests.userName,
      userEmail: bookingRequests.userEmail,
      status: bookingRequests.status,
      resourceId: bookingRequests.resourceId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      createdAt: bookingRequests.createdAt,
      updatedAt: bookingRequests.updatedAt,
      resourceName: resources.name
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .where(
      or(
        gte(bookingRequests.createdAt, twentyFourHoursAgo),
        gte(bookingRequests.updatedAt, twentyFourHoursAgo)
      )
    )
    .orderBy(desc(bookingRequests.updatedAt));

    for (const booking of bookingResults) {
      const name = booking.userName || booking.userEmail || 'Unknown';
      const bayName = booking.resourceName || 'Simulator';
      const timeStr = booking.startTime ? formatTime12Hour(booking.startTime) : '';
      
      let bookingDateTime: Date | null = null;
      if (booking.requestDate && booking.startTime) {
        const [year, month, day] = booking.requestDate.split('-').map(Number);
        const [hour, minute] = booking.startTime.split(':').map(Number);
        const localDate = new Date(year, month - 1, day, hour, minute, 0);
        const pacificOffset = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles',
          timeZoneName: 'shortOffset'
        }).formatToParts(localDate).find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
        const offsetHours = parseInt(pacificOffset.replace('GMT', '')) || -8;
        const offsetStr = offsetHours >= 0 ? `+${String(offsetHours).padStart(2, '0')}:00` : `${String(offsetHours).padStart(3, '0')}:00`;
        bookingDateTime = new Date(`${booking.requestDate}T${booking.startTime}:00${offsetStr}`);
      }
      const now = new Date();
      const isBookingInPast = bookingDateTime && bookingDateTime < now;
      
      const getActivityTimestamp = (recordTimestamp: Date | null): string => {
        if (isBookingInPast && bookingDateTime) {
          return bookingDateTime.toISOString();
        }
        return recordTimestamp?.toISOString() || new Date().toISOString();
      };
      
      if (booking.status === 'pending' || booking.status === 'pending_approval') {
        activities.push({
          id: `booking_created_${booking.id}`,
          type: 'booking_created',
          timestamp: getActivityTimestamp(booking.createdAt),
          primary_text: name,
          secondary_text: `${bayName} at ${timeStr}`,
          icon: 'calendar_add_on'
        });
      } else if (booking.status === 'approved') {
        if (booking.updatedAt && booking.updatedAt >= twentyFourHoursAgo) {
          activities.push({
            id: `booking_approved_${booking.id}`,
            type: 'booking_approved',
            timestamp: getActivityTimestamp(booking.updatedAt),
            primary_text: name,
            secondary_text: `${bayName} at ${timeStr}`,
            icon: 'check_circle'
          });
        }
      } else if (booking.status === 'attended') {
        if (booking.updatedAt && booking.updatedAt >= twentyFourHoursAgo) {
          activities.push({
            id: `check_in_${booking.id}`,
            type: 'check_in',
            timestamp: getActivityTimestamp(booking.updatedAt),
            primary_text: name,
            secondary_text: bayName,
            icon: 'login'
          });
        }
      } else if (booking.status === 'cancelled' || booking.status === 'declined') {
        if (booking.updatedAt && booking.updatedAt >= twentyFourHoursAgo) {
          activities.push({
            id: `cancellation_${booking.id}`,
            type: 'cancellation',
            timestamp: getActivityTimestamp(booking.updatedAt),
            primary_text: name,
            secondary_text: `${bayName} cancelled`,
            icon: 'event_busy'
          });
        }
      }
    }

    // Walk-in check-ins
    const { pool } = await import('../../core/db');
    const walkInResult = await pool.query(`
      SELECT w.id, w.member_email, w.checked_in_by_name, w.created_at,
             u.first_name, u.last_name, u.name
      FROM walk_in_visits w
      LEFT JOIN users u ON u.id = w.member_id
      WHERE w.created_at >= $1
      ORDER BY w.created_at DESC
    `, [twentyFourHoursAgo]);

    for (const visit of walkInResult.rows) {
      const name = visit.name || [visit.first_name, visit.last_name].filter(Boolean).join(' ') || visit.member_email;
      activities.push({
        id: `walkin_${visit.id}`,
        type: 'check_in',
        timestamp: visit.created_at.toISOString ? visit.created_at.toISOString() : new Date(visit.created_at).toISOString(),
        primary_text: name,
        secondary_text: `Walk-in check-in${visit.checked_in_by_name ? ` by ${visit.checked_in_by_name}` : ''}`,
        icon: 'qr_code_scanner'
      });
    }

    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json(activities.slice(0, 20));
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch recent activity', error);
  }
});

export default router;

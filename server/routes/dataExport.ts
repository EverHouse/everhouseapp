import { Router, Request, Response } from 'express';
import { pool } from '../core/db';
import { db } from '../db';
import { dataExportRequests } from '../../shared/schema';
import { eq, desc } from 'drizzle-orm';
import { logFromRequest } from '../core/auditLog';
import { isAuthenticated } from '../core/middleware';

const router = Router();

interface MemberDataExport {
  exportDate: string;
  profile: any;
  bookings: any[];
  linkedBookings: any[];
  notifications: any[];
  guestPasses: any;
  eventRsvps: any[];
  memberNotes: any[];
  communicationLogs: any[];
  billingHistory: any[];
  bookingMemberships: any[];
  guestCheckIns: any[];
  wellnessEnrollments: any[];
  preferences: any;
}

router.get('/api/account/my-data', isAuthenticated, async (req: any, res: Response) => {
  const userEmail = req.session?.user?.email;

  try {
    const exportData = await gatherMemberData(userEmail);
    
    await db.insert(dataExportRequests).values({
      userEmail,
      status: 'completed',
      completedAt: new Date(),
    });
    
    logFromRequest(req, 'export_member_data', 'member', userEmail, undefined, { self_export: true });
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="my-data-${new Date().toISOString().split('T')[0]}.json"`);
    
    return res.json(exportData);
  } catch (error) {
    console.error('[DataExport] Error exporting member data:', error);
    return res.status(500).json({ error: 'Failed to export data' });
  }
});

router.get('/api/account/my-data/preview', isAuthenticated, async (req: any, res: Response) => {
  const userEmail = req.session?.user?.email;

  try {
    const exportData = await gatherMemberData(userEmail);
    
    const preview = {
      profile: exportData.profile ? 'Included' : 'Not found',
      bookingsCount: exportData.bookings.length,
      linkedBookingsCount: exportData.linkedBookings.length,
      notificationsCount: exportData.notifications.length,
      guestPasses: exportData.guestPasses ? 'Included' : 'None',
      eventRsvpsCount: exportData.eventRsvps.length,
      memberNotesCount: exportData.memberNotes.length,
      communicationLogsCount: exportData.communicationLogs.length,
      billingHistoryCount: exportData.billingHistory.length,
      guestCheckInsCount: exportData.guestCheckIns.length,
      wellnessEnrollmentsCount: exportData.wellnessEnrollments.length,
      preferencesIncluded: !!exportData.preferences,
    };
    
    return res.json({
      summary: preview,
      message: 'Use GET /api/account/my-data to download your complete data export'
    });
  } catch (error) {
    console.error('[DataExport] Error previewing member data:', error);
    return res.status(500).json({ error: 'Failed to preview data' });
  }
});

router.get('/api/account/export-history', isAuthenticated, async (req: any, res: Response) => {
  const userEmail = req.session?.user?.email;

  try {
    const history = await db.select()
      .from(dataExportRequests)
      .where(eq(dataExportRequests.userEmail, userEmail))
      .orderBy(desc(dataExportRequests.requestedAt))
      .limit(10);
    
    return res.json({ exports: history });
  } catch (error) {
    console.error('[DataExport] Error fetching export history:', error);
    return res.status(500).json({ error: 'Failed to fetch export history' });
  }
});

async function gatherMemberData(email: string): Promise<MemberDataExport> {
  const normalizedEmail = email.toLowerCase().trim();
  
  const profileResult = await pool.query(`
    SELECT 
      email, first_name, last_name, phone, tier, 
      membership_status, role, join_date, 
      email_notifications_enabled, sms_notifications_enabled,
      booking_reminders_enabled, marketing_emails_enabled,
      created_at, updated_at
    FROM users 
    WHERE LOWER(email) = $1
  `, [normalizedEmail]);
  
  const bookingsResult = await pool.query(`
    SELECT 
      id, bay_id, request_date, start_time, end_time, 
      duration_minutes, status, notes, created_at
    FROM booking_requests 
    WHERE LOWER(user_email) = $1
    ORDER BY request_date DESC
  `, [normalizedEmail]);
  
  const linkedBookingsResult = await pool.query(`
    SELECT 
      br.id, br.request_date, br.start_time, br.end_time, 
      br.duration_minutes, br.status, br.notes, br.created_at,
      r.name as resource_name, r.type as resource_type,
      bm.is_primary, bm.status as member_status, bm.added_at
    FROM booking_members bm
    JOIN booking_requests br ON bm.booking_id = br.id
    LEFT JOIN resources r ON br.resource_id = r.id
    WHERE LOWER(bm.user_email) = $1
      AND LOWER(br.user_email) != $1
    ORDER BY br.request_date DESC
  `, [normalizedEmail]);
  
  const notificationsResult = await pool.query(`
    SELECT 
      id, title, message, type, is_read, created_at
    FROM notifications 
    WHERE LOWER(user_email) = $1
    ORDER BY created_at DESC
    LIMIT 500
  `, [normalizedEmail]);
  
  const guestPassesResult = await pool.query(`
    SELECT passes_used, passes_total, last_reset_date
    FROM guest_passes 
    WHERE LOWER(member_email) = $1
  `, [normalizedEmail]);
  
  const eventRsvpsResult = await pool.query(`
    SELECT event_id, status, created_at, updated_at
    FROM event_rsvps 
    WHERE LOWER(user_email) = $1
  `, [normalizedEmail]);
  
  const memberNotesResult = await pool.query(`
    SELECT content, created_by_name, created_at
    FROM member_notes 
    WHERE LOWER(member_email) = $1
    ORDER BY created_at DESC
  `, [normalizedEmail]);
  
  const communicationLogsResult = await pool.query(`
    SELECT type, direction, subject, occurred_at
    FROM communication_logs 
    WHERE LOWER(member_email) = $1
    ORDER BY occurred_at DESC
    LIMIT 200
  `, [normalizedEmail]);
  
  const billingResult = await pool.query(`
    SELECT action_type, action_details, new_value, created_at
    FROM billing_audit_log 
    WHERE LOWER(member_email) = $1
    ORDER BY created_at DESC
    LIMIT 100
  `, [normalizedEmail]);
  
  const bookingMembershipsResult = await pool.query(`
    SELECT booking_id, is_primary, status, added_at, updated_at
    FROM booking_members 
    WHERE LOWER(user_email) = $1
    ORDER BY added_at DESC
  `, [normalizedEmail]);
  
  const guestCheckInsResult = await pool.query(`
    SELECT guest_name, guest_email, check_in_date, check_in_notes, created_at
    FROM guest_check_ins 
    WHERE LOWER(member_email) = $1
    ORDER BY check_in_date DESC
  `, [normalizedEmail]);
  
  const wellnessEnrollmentsResult = await pool.query(`
    SELECT class_id, status, created_at, updated_at
    FROM wellness_enrollments 
    WHERE LOWER(user_email) = $1
    ORDER BY created_at DESC
  `, [normalizedEmail]);
  
  const profile = profileResult.rows[0] || null;
  
  return {
    exportDate: new Date().toISOString(),
    profile: profile ? {
      email: profile.email,
      firstName: profile.first_name,
      lastName: profile.last_name,
      phone: profile.phone,
      tier: profile.tier,
      membershipStatus: profile.membership_status,
      joinDate: profile.join_date,
      createdAt: profile.created_at,
    } : null,
    bookings: bookingsResult.rows.map(b => ({
      id: b.id,
      bayId: b.bay_id,
      date: b.request_date,
      startTime: b.start_time,
      endTime: b.end_time,
      duration: b.duration_minutes,
      status: b.status,
      notes: b.notes,
      createdAt: b.created_at,
    })),
    linkedBookings: linkedBookingsResult.rows.map(lb => ({
      bookingId: lb.id,
      date: lb.request_date,
      startTime: lb.start_time,
      endTime: lb.end_time,
      duration: lb.duration_minutes,
      status: lb.status,
      resourceName: lb.resource_name,
      resourceType: lb.resource_type,
      isPrimary: lb.is_primary,
      memberStatus: lb.member_status,
      addedAt: lb.added_at,
    })),
    notifications: notificationsResult.rows.map(n => ({
      title: n.title,
      message: n.message,
      type: n.type,
      isRead: n.is_read,
      createdAt: n.created_at,
    })),
    guestPasses: guestPassesResult.rows[0] ? {
      used: guestPassesResult.rows[0].passes_used,
      total: guestPassesResult.rows[0].passes_total,
      lastReset: guestPassesResult.rows[0].last_reset_date,
    } : null,
    eventRsvps: eventRsvpsResult.rows.map(r => ({
      eventId: r.event_id,
      status: r.status,
      createdAt: r.created_at,
    })),
    memberNotes: memberNotesResult.rows.map(n => ({
      content: n.content,
      createdBy: n.created_by_name,
      createdAt: n.created_at,
    })),
    communicationLogs: communicationLogsResult.rows.map(c => ({
      type: c.type,
      direction: c.direction,
      subject: c.subject,
      occurredAt: c.occurred_at,
    })),
    billingHistory: billingResult.rows.map(b => ({
      action: b.action_type,
      details: b.action_details,
      value: b.new_value,
      createdAt: b.created_at,
    })),
    bookingMemberships: bookingMembershipsResult.rows.map(bm => ({
      bookingId: bm.booking_id,
      isPrimary: bm.is_primary,
      status: bm.status,
      addedAt: bm.added_at,
    })),
    guestCheckIns: guestCheckInsResult.rows.map(g => ({
      guestName: g.guest_name,
      guestEmail: g.guest_email,
      checkInDate: g.check_in_date,
      notes: g.check_in_notes,
      createdAt: g.created_at,
    })),
    wellnessEnrollments: wellnessEnrollmentsResult.rows.map(w => ({
      classId: w.class_id,
      status: w.status,
      createdAt: w.created_at,
    })),
    preferences: profile ? {
      emailNotifications: profile.email_notifications_enabled,
      smsNotifications: profile.sms_notifications_enabled,
      bookingReminders: profile.booking_reminders_enabled,
      marketingEmails: profile.marketing_emails_enabled,
    } : null,
  };
}

export default router;

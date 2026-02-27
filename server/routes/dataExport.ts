import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dataExportRequests } from '../../shared/schema';
import { sql, eq, desc } from 'drizzle-orm';
import { logFromRequest } from '../core/auditLog';
import { isAuthenticated } from '../core/middleware';
import { logger } from '../core/logger';

const router = Router();

interface MemberDataExport {
  exportDate: string;
  profile: Record<string, unknown> | null;
  bookings: Record<string, unknown>[];
  linkedBookings: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  guestPasses: Record<string, unknown> | null;
  eventRsvps: Record<string, unknown>[];
  memberNotes: Record<string, unknown>[];
  communicationLogs: Record<string, unknown>[];
  billingHistory: Record<string, unknown>[];
  bookingMemberships: Record<string, unknown>[];
  guestCheckIns: Record<string, unknown>[];
  wellnessEnrollments: Record<string, unknown>[];
  preferences: Record<string, unknown> | null;
}

router.get('/api/account/my-data', isAuthenticated, async (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    logger.error('[DataExport] Error exporting member data', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to export data' });
  }
});

router.get('/api/account/my-data/preview', isAuthenticated, async (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    logger.error('[DataExport] Error previewing member data', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to preview data' });
  }
});

router.get('/api/account/export-history', isAuthenticated, async (req: Request, res: Response) => {
  const userEmail = req.session?.user?.email;

  try {
    const history = await db.select()
      .from(dataExportRequests)
      .where(eq(dataExportRequests.userEmail, userEmail))
      .orderBy(desc(dataExportRequests.requestedAt))
      .limit(10);
    
    return res.json({ exports: history });
  } catch (error: unknown) {
    logger.error('[DataExport] Error fetching export history', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to fetch export history' });
  }
});

async function gatherMemberData(email: string): Promise<MemberDataExport> {
  const normalizedEmail = email.toLowerCase().trim();
  
  const profileResult = await db.execute(sql`
    SELECT 
      email, first_name, last_name, phone, tier, 
      membership_status, role, join_date, 
      email_notifications_enabled, sms_notifications_enabled,
      booking_reminders_enabled, marketing_emails_enabled,
      id_image_url,
      created_at, updated_at
    FROM users 
    WHERE LOWER(email) = ${normalizedEmail}
  `);
  
  const bookingsResult = await db.execute(sql`
    SELECT 
      id, bay_id, request_date, start_time, end_time, 
      duration_minutes, status, notes, created_at
    FROM booking_requests 
    WHERE LOWER(user_email) = ${normalizedEmail}
    ORDER BY request_date DESC
  `);
  
  const linkedBookingsResult = await db.execute(sql`
    SELECT 
      br.id, br.request_date, br.start_time, br.end_time, 
      br.duration_minutes, br.status, br.notes, br.created_at,
      r.name as resource_name, r.type as resource_type,
      CASE WHEN bp.participant_type = 'owner' THEN true ELSE false END as is_primary,
      bp.invite_status as member_status, bp.created_at as added_at
    FROM booking_participants bp
    JOIN booking_sessions bs ON bp.session_id = bs.id
    JOIN booking_requests br ON br.session_id = bs.id
    JOIN users u_bp ON bp.user_id = u_bp.id
    LEFT JOIN resources r ON br.resource_id = r.id
    WHERE LOWER(u_bp.email) = ${normalizedEmail}
      AND LOWER(br.user_email) != ${normalizedEmail}
    ORDER BY br.request_date DESC
  `);
  
  const notificationsResult = await db.execute(sql`
    SELECT 
      id, title, message, type, is_read, created_at
    FROM notifications 
    WHERE LOWER(user_email) = ${normalizedEmail}
    ORDER BY created_at DESC
    LIMIT 500
  `);
  
  const guestPassesResult = await db.execute(sql`
    SELECT passes_used, passes_total, last_reset_date
    FROM guest_passes 
    WHERE LOWER(member_email) = ${normalizedEmail}
  `);
  
  const eventRsvpsResult = await db.execute(sql`
    SELECT event_id, status, created_at, updated_at
    FROM event_rsvps 
    WHERE LOWER(user_email) = ${normalizedEmail}
  `);
  
  const memberNotesResult = await db.execute(sql`
    SELECT content, created_by_name, created_at
    FROM member_notes 
    WHERE LOWER(member_email) = ${normalizedEmail}
    ORDER BY created_at DESC
  `);
  
  const communicationLogsResult = await db.execute(sql`
    SELECT type, direction, subject, occurred_at
    FROM communication_logs 
    WHERE LOWER(member_email) = ${normalizedEmail}
    ORDER BY occurred_at DESC
    LIMIT 200
  `);
  
  const billingResult = await db.execute(sql`
    SELECT action as action_type, details as action_details, details->>'newValue' as new_value, created_at
    FROM admin_audit_log 
    WHERE resource_type = 'billing'
    AND LOWER(resource_id) = ${normalizedEmail}
    ORDER BY created_at DESC
    LIMIT 100
  `);
  
  const bookingMembershipsResult = await db.execute(sql`
    SELECT br.id as booking_id, 
      CASE WHEN bp.participant_type = 'owner' THEN true ELSE false END as is_primary, 
      bp.invite_status as status, bp.created_at as added_at, bp.created_at as updated_at
    FROM booking_participants bp
    JOIN booking_sessions bs ON bp.session_id = bs.id
    JOIN booking_requests br ON br.session_id = bs.id
    JOIN users u_bp ON bp.user_id = u_bp.id
    WHERE LOWER(u_bp.email) = ${normalizedEmail}
    ORDER BY bp.created_at DESC
  `);
  
  const guestCheckInsResult = await db.execute(sql`
    SELECT guest_name, guest_email, check_in_date, check_in_notes, created_at
    FROM guest_check_ins 
    WHERE LOWER(member_email) = ${normalizedEmail}
    ORDER BY check_in_date DESC
  `);
  
  const wellnessEnrollmentsResult = await db.execute(sql`
    SELECT class_id, status, created_at, updated_at
    FROM wellness_enrollments 
    WHERE LOWER(user_email) = ${normalizedEmail}
    ORDER BY created_at DESC
  `);
  
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
    bookings: bookingsResult.rows.map((b: Record<string, unknown>) => ({
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
    linkedBookings: linkedBookingsResult.rows.map((lb: Record<string, unknown>) => ({
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
    notifications: notificationsResult.rows.map((n: Record<string, unknown>) => ({
      title: n.title,
      message: n.message,
      type: n.type,
      isRead: n.is_read,
      createdAt: n.created_at,
    })),
    guestPasses: guestPassesResult.rows[0] ? {
      used: (guestPassesResult.rows[0] as Record<string, unknown>).passes_used,
      total: (guestPassesResult.rows[0] as Record<string, unknown>).passes_total,
      lastReset: (guestPassesResult.rows[0] as Record<string, unknown>).last_reset_date,
    } : null,
    eventRsvps: eventRsvpsResult.rows.map((r: Record<string, unknown>) => ({
      eventId: r.event_id,
      status: r.status,
      createdAt: r.created_at,
    })),
    memberNotes: memberNotesResult.rows.map((n: Record<string, unknown>) => ({
      content: n.content,
      createdBy: n.created_by_name,
      createdAt: n.created_at,
    })),
    communicationLogs: communicationLogsResult.rows.map((c: Record<string, unknown>) => ({
      type: c.type,
      direction: c.direction,
      subject: c.subject,
      occurredAt: c.occurred_at,
    })),
    billingHistory: billingResult.rows.map((b: Record<string, unknown>) => ({
      action: b.action_type,
      details: b.action_details,
      value: b.new_value,
      createdAt: b.created_at,
    })),
    bookingMemberships: bookingMembershipsResult.rows.map((bm: Record<string, unknown>) => ({
      bookingId: bm.booking_id,
      isPrimary: bm.is_primary,
      status: bm.status,
      addedAt: bm.added_at,
    })),
    guestCheckIns: guestCheckInsResult.rows.map((g: Record<string, unknown>) => ({
      guestName: g.guest_name,
      guestEmail: g.guest_email,
      checkInDate: g.check_in_date,
      notes: g.check_in_notes,
      createdAt: g.created_at,
    })),
    wellnessEnrollments: wellnessEnrollmentsResult.rows.map((w: Record<string, unknown>) => ({
      classId: w.class_id,
      status: w.status,
      createdAt: w.created_at,
    })),
    preferences: profile ? {
      emailNotifications: (profile as Record<string, unknown>).email_notifications_enabled,
      smsNotifications: (profile as Record<string, unknown>).sms_notifications_enabled,
      bookingReminders: (profile as Record<string, unknown>).booking_reminders_enabled,
      marketingEmails: (profile as Record<string, unknown>).marketing_emails_enabled,
    } : null,
  };
}

export default router;

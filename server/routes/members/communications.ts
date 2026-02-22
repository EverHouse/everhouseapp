import { logger } from '../../core/logger';
import { Router } from 'express';
import { eq, sql, desc, and } from 'drizzle-orm';
import { db } from '../../db';
import { users, communicationLogs, staffUsers } from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { isStaffOrAdmin, isAuthenticated } from '../../core/middleware';
import { getSessionUser } from '../../types/session';
import { updateHubSpotContactPreferences } from '../../core/memberSync';
import { getResendClient } from '../../utils/resend';
import { withResendRetry } from '../../core/retryUtils';
import { logFromRequest } from '../../core/auditLog';

const router = Router();

router.get('/api/members/:email/communications', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).trim().toLowerCase();
    
    const logs = await db.select()
      .from(communicationLogs)
      .where(sql`LOWER(${communicationLogs.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(communicationLogs.occurredAt));
    
    res.json(logs);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Communication logs error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch communication logs' });
  }
});

router.post('/api/members/:email/communications', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { type, direction, subject, body, status, occurredAt } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!type) {
      return res.status(400).json({ error: 'Communication type is required' });
    }
    
    const normalizedEmail = decodeURIComponent(email as string).trim().toLowerCase();
    
    const result = await db.insert(communicationLogs)
      .values({
        memberEmail: normalizedEmail,
        type,
        direction: direction || 'outbound',
        subject: subject || null,
        body: body || null,
        status: status || 'sent',
        loggedBy: sessionUser?.email || 'unknown',
        loggedByName: sessionUser?.firstName 
          ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
          : sessionUser?.email?.split('@')[0] || 'Staff',
        occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
      })
      .returning();
    
    logFromRequest(req, 'create_communication', 'communication', String(result[0].id), normalizedEmail);
    res.status(201).json(result[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Create communication log error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create communication log' });
  }
});

router.delete('/api/members/:email/communications/:logId', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, logId } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).trim().toLowerCase();
    
    const result = await db.delete(communicationLogs)
      .where(and(
        eq(communicationLogs.id, parseInt(logId as string)),
        sql`LOWER(${communicationLogs.memberEmail}) = ${normalizedEmail}`
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Communication log not found for this member' });
    }
    
    logFromRequest(req, 'delete_communication', 'communication', logId as string, normalizedEmail);
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Delete communication log error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete communication log' });
  }
});

router.patch('/api/members/me/preferences', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { emailOptIn, smsOptIn, doNotSellMyInfo } = req.body;
    
    if (emailOptIn === undefined && smsOptIn === undefined && doNotSellMyInfo === undefined) {
      return res.status(400).json({ error: 'No preferences provided' });
    }
    
    const requestedEmail = (req.query.user_email as string | undefined)?.trim()?.toLowerCase();
    let targetEmail = sessionUser.email;
    
    if (requestedEmail && requestedEmail !== sessionUser.email.toLowerCase()) {
      if (sessionUser.role === 'admin' || sessionUser.role === 'staff') {
        targetEmail = requestedEmail;
      }
    }
    
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (emailOptIn !== undefined) updateData.emailOptIn = emailOptIn;
    if (smsOptIn !== undefined) updateData.smsOptIn = smsOptIn;
    if (doNotSellMyInfo !== undefined) updateData.doNotSellMyInfo = doNotSellMyInfo;
    
    const result = await db.update(users)
      .set(updateData)
      .where(eq(users.email, targetEmail.toLowerCase()))
      .returning({ 
        emailOptIn: users.emailOptIn, 
        smsOptIn: users.smsOptIn,
        doNotSellMyInfo: users.doNotSellMyInfo,
        hubspotId: users.hubspotId 
      });
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const updated = result[0];
    if (updated.hubspotId) {
      updateHubSpotContactPreferences(updated.hubspotId, { 
        emailOptIn: emailOptIn !== undefined ? emailOptIn : undefined,
        smsOptIn: smsOptIn !== undefined ? smsOptIn : undefined
      }).catch(err => logger.error('[Members] Failed to sync preferences to HubSpot:', { extra: { err } }));
    }
    
    res.json({ 
      emailOptIn: updated.emailOptIn, 
      smsOptIn: updated.smsOptIn,
      doNotSellMyInfo: updated.doNotSellMyInfo
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

router.get('/api/members/me/preferences', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const requestedEmail = (req.query.user_email as string | undefined)?.trim()?.toLowerCase();
    let targetEmail = sessionUser.email;
    
    if (requestedEmail && requestedEmail !== sessionUser.email.toLowerCase()) {
      if (sessionUser.role === 'admin' || sessionUser.role === 'staff') {
        targetEmail = requestedEmail;
      }
    }
    
    const result = await db.select({ 
      emailOptIn: users.emailOptIn, 
      smsOptIn: users.smsOptIn,
      smsPromoOptIn: users.smsPromoOptIn,
      smsTransactionalOptIn: users.smsTransactionalOptIn,
      smsRemindersOptIn: users.smsRemindersOptIn,
      doNotSellMyInfo: users.doNotSellMyInfo,
      dataExportRequestedAt: users.dataExportRequestedAt
    })
      .from(users)
      .where(eq(users.email, targetEmail.toLowerCase()));
    
    if (result.length === 0) {
      return res.json({ emailOptIn: null, smsOptIn: null, smsPromoOptIn: null, smsTransactionalOptIn: null, smsRemindersOptIn: null, doNotSellMyInfo: false, dataExportRequestedAt: null });
    }
    
    res.json(result[0]);
  } catch (error: unknown) {
    if (!isProduction) logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.get('/api/my-visits', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const requestedEmail = (req.query.user_email as string | undefined)?.trim()?.toLowerCase();
    let targetEmail = sessionUser.email.toLowerCase();
    
    if (requestedEmail && requestedEmail !== sessionUser.email.toLowerCase()) {
      if (sessionUser.role === 'admin' || sessionUser.role === 'staff') {
        targetEmail = requestedEmail;
      }
    }
    
    const unifiedVisitsResult = await db.execute(sql`
      SELECT DISTINCT ON (visit_type, visit_id) * FROM (
        SELECT 
          br.id as visit_id,
          'booking' as visit_type,
          'Host' as role,
          br.request_date::text as date,
          br.start_time::text as start_time,
          br.end_time::text as end_time,
          COALESCE(r.name, br.resource_preference, 'Simulator') as resource_name,
          NULL as location,
          CASE WHEN r.type = 'conference_room' OR LOWER(r.name) LIKE '%conference%' THEN 'Conference Room' ELSE 'Golf Simulator' END as category,
          NULL as invited_by
        FROM booking_requests br
        LEFT JOIN resources r ON br.resource_id = r.id
        WHERE LOWER(br.user_email) = ${targetEmail}
          AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
        
        UNION ALL
        
        SELECT 
          br.id as visit_id,
          'booking' as visit_type,
          CASE WHEN bp.participant_type = 'guest' THEN 'Guest' ELSE 'Player' END as role,
          br.request_date::text as date,
          br.start_time::text as start_time,
          br.end_time::text as end_time,
          COALESCE(r.name, br.resource_preference, 'Simulator') as resource_name,
          NULL as location,
          CASE WHEN r.type = 'conference_room' OR LOWER(r.name) LIKE '%conference%' THEN 'Conference Room' ELSE 'Golf Simulator' END as category,
          COALESCE(host_user.first_name || ' ' || host_user.last_name, br.user_name) as invited_by
        FROM booking_requests br
        JOIN booking_sessions bs ON br.session_id = bs.id
        JOIN booking_participants bp ON bp.session_id = bs.id
        LEFT JOIN users bp_user ON bp.user_id = bp_user.id
        LEFT JOIN guests bp_guest ON bp.guest_id = bp_guest.id
        LEFT JOIN resources r ON br.resource_id = r.id
        LEFT JOIN users host_user ON LOWER(br.user_email) = LOWER(host_user.email)
        WHERE (
          (bp.participant_type IN ('member', 'guest') AND LOWER(COALESCE(bp_user.email, bp_guest.email, '')) = ${targetEmail})
        )
          AND bp.participant_type != 'owner'
          AND LOWER(br.user_email) != ${targetEmail}
          AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
        
        UNION ALL
        
        SELECT 
          we.id as visit_id,
          'wellness' as visit_type,
          'Wellness' as role,
          wc.date::text as date,
          wc.time::text as start_time,
          NULL as end_time,
          wc.title as resource_name,
          NULL as location,
          wc.category as category,
          wc.instructor as invited_by
        FROM wellness_enrollments we
        JOIN wellness_classes wc ON we.class_id = wc.id
        WHERE LOWER(we.user_email) = ${targetEmail}
          AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND we.status NOT IN ('cancelled')
        
        UNION ALL
        
        SELECT 
          er.id as visit_id,
          'event' as visit_type,
          'Event' as role,
          e.event_date::text as date,
          e.start_time::text as start_time,
          e.end_time::text as end_time,
          e.title as resource_name,
          e.location as location,
          e.category as category,
          NULL as invited_by
        FROM event_rsvps er
        JOIN events e ON er.event_id = e.id
        WHERE LOWER(er.user_email) = ${targetEmail}
          AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND er.status NOT IN ('cancelled')
      ) all_visits
      ORDER BY visit_type, visit_id, date DESC
    `);
    
    const rows = (unifiedVisitsResult.rows as Record<string, unknown>[]) || [];
    
    const visits = rows
      .map((row: Record<string, unknown>) => ({
        id: row.visit_id,
        type: row.visit_type,
        role: row.role,
        date: row.date,
        startTime: row.start_time,
        endTime: row.end_time,
        resourceName: row.resource_name,
        location: row.location || undefined,
        category: row.category || undefined,
        invitedBy: row.invited_by || undefined,
      }))
      .sort((a: any, b: any) => (b.date as string).localeCompare(a.date as string));
    
    res.json(visits);
  } catch (error: unknown) {
    if (!isProduction) logger.error('API error fetching my-visits', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch visits' });
  }
});

router.post('/api/members/me/data-export-request', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const result = await db.update(users)
      .set({ 
        dataExportRequestedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(users.email, sessionUser.email.toLowerCase()))
      .returning({ 
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        dataExportRequestedAt: users.dataExportRequestedAt
      });
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = result[0];
    const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || 'Member';
    logger.info('[Privacy] Data export requested by at', { extra: { memberEmail: member.email, memberDataExportRequestedAt: member.dataExportRequestedAt } });
    
    try {
      const adminStaff = await db.select({ email: staffUsers.email, name: staffUsers.name })
        .from(staffUsers)
        .where(and(eq(staffUsers.role, 'admin'), eq(staffUsers.isActive, true)));
      
      if (adminStaff.length > 0) {
        const { client: resendClient, fromEmail } = await getResendClient();
        const adminEmails = adminStaff.map(s => s.email);
        
        await withResendRetry(() => resendClient.emails.send({
          from: fromEmail as string,
          to: adminEmails as string[],
          subject: `[Action Required] CCPA Data Export Request from ${memberName}`,
          html: `
            <h2>Data Export Request</h2>
            <p>A member has requested a copy of their personal data under CCPA/CPRA.</p>
            <p><strong>Member:</strong> ${memberName}</p>
            <p><strong>Email:</strong> ${member.email}</p>
            <p><strong>Requested At:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</p>
            <hr/>
            <p><em>Under California law, you must respond within 45 days.</em></p>
            <p>Please prepare and send the member's data export.</p>
          `
        }));
        logger.info('[Privacy] Data export notification sent to admin(s)', { extra: { adminEmailsLength: adminEmails.length } });
      }
    } catch (emailError) {
      logger.error('[Privacy] Failed to send data export notification email', { extra: { emailError } });
    }
    
    res.json({ 
      success: true, 
      message: 'Data export request submitted successfully',
      requestedAt: member.dataExportRequestedAt
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Data export request error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to submit data export request' });
  }
});

export default router;

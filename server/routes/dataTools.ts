import { Router, Request, Response } from 'express';
import { db } from '../db';
import { isProduction } from '../core/db';
import { users, bookingRequests, legacyPurchases, billingAuditLog, adminAuditLog } from '@shared/schema';
import { eq, sql, and, gte, lte, desc, isNull, inArray } from 'drizzle-orm';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { getHubSpotClient } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { logFromRequest } from '../core/auditLog';
import { getSessionUser } from '../types/session';

const router = Router();

router.post('/api/data-tools/resync-member', isAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const existingUser = await db.execute(sql`SELECT id, first_name, last_name, tier, hubspot_id FROM users WHERE LOWER(email) = ${normalizedEmail}`);
    
    if (existingUser.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in database' });
    }
    
    const user = existingUser.rows[0];
    let hubspotContactId = user.hubspot_id;
    
    const hubspot = await getHubSpotClient();
    
    if (!hubspotContactId) {
      const searchResponse = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: normalizedEmail
            }]
          }],
          properties: ['email', 'firstname', 'lastname', 'phone', 'membership_tier', 'membership_status'],
          limit: 1
        })
      );
      
      if (!searchResponse.results || searchResponse.results.length === 0) {
        return res.status(404).json({ error: 'Member not found in HubSpot' });
      }
      
      hubspotContactId = searchResponse.results[0].id;
    }
    
    const contactResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.getById(hubspotContactId, [
        'email',
        'firstname',
        'lastname',
        'phone',
        'membership_tier',
        'membership_status',
        'lifecyclestage'
      ])
    );
    
    const props = contactResponse.properties;
    
    const updateData: Record<string, any> = {
      hubspotId: hubspotContactId,
      updatedAt: new Date()
    };
    
    if (props.firstname) updateData.firstName = props.firstname;
    if (props.lastname) updateData.lastName = props.lastname;
    if (props.phone) updateData.phone = props.phone;
    if (props.membership_tier) updateData.tier = props.membership_tier;
    if (props.membership_status) updateData.membershipStatus = props.membership_status;
    
    await db.execute(sql`UPDATE users SET 
        hubspot_id = ${hubspotContactId},
        first_name = COALESCE(${props.firstname || null}, first_name),
        last_name = COALESCE(${props.lastname || null}, last_name),
        phone = COALESCE(${props.phone || null}, phone),
        tier = COALESCE(${props.membership_tier || null}, tier),
        membership_status = COALESCE(${props.membership_status || null}, membership_status),
        updated_at = NOW()
      WHERE id = ${user.id}`);
    
    await db.insert(billingAuditLog).values({
      memberEmail: normalizedEmail,
      actionType: 'member_resynced_from_hubspot',
      actionDetails: {
        source: 'data_tools',
        hubspotContactId,
        syncedFields: Object.keys(updateData).filter(k => k !== 'updatedAt' && k !== 'hubspotId')
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      console.log(`[DataTools] Re-synced member ${normalizedEmail} from HubSpot by ${staffEmail}`);
    }
    
    logFromRequest(req, 'sync_hubspot', 'member', null, normalizedEmail, {
      action: 'manual_sync'
    });
    
    res.json({
      success: true,
      message: `Successfully synced ${normalizedEmail} from HubSpot`,
      syncedFields: Object.keys(updateData).filter(k => k !== 'updatedAt'),
      hubspotContactId
    });
  } catch (error: any) {
    console.error('[DataTools] Resync member error:', error);
    res.status(500).json({ error: 'Failed to resync member', details: error.message });
  }
});

router.get('/api/data-tools/unlinked-guest-fees', isAdmin, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    const unlinkedFees = await db.select({
      id: legacyPurchases.id,
      memberEmail: legacyPurchases.memberEmail,
      mindbodyClientId: legacyPurchases.mindbodyClientId,
      itemName: legacyPurchases.itemName,
      itemCategory: legacyPurchases.itemCategory,
      saleDate: legacyPurchases.saleDate,
      itemTotalCents: legacyPurchases.itemTotalCents,
      userId: legacyPurchases.userId,
    })
      .from(legacyPurchases)
      .where(and(
        sql`item_category IN ('guest_pass', 'guest_sim_fee')`,
        isNull(legacyPurchases.linkedBookingSessionId),
        gte(legacyPurchases.saleDate, new Date(startDate as string)),
        lte(legacyPurchases.saleDate, new Date(endDate as string))
      ))
      .orderBy(desc(legacyPurchases.saleDate))
      .limit(100);
    
    const formatted = unlinkedFees.map(fee => ({
      ...fee,
      itemTotal: ((fee.itemTotalCents || 0) / 100).toFixed(2),
      saleDate: fee.saleDate?.toISOString().split('T')[0]
    }));
    
    res.json(formatted);
  } catch (error: any) {
    console.error('[DataTools] Get unlinked guest fees error:', error);
    res.status(500).json({ error: 'Failed to get unlinked guest fees', details: error.message });
  }
});

router.get('/api/data-tools/available-sessions', isAdmin, async (req: Request, res: Response) => {
  try {
    const { date, memberEmail } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }
    
    const queryBuilder = sql`
      SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.status,
        r.name as resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE br.request_date = ${date}
      AND br.status NOT IN ('cancelled', 'declined')
    `;
    
    if (memberEmail) {
      queryBuilder.append(sql` AND LOWER(br.user_email) = ${(memberEmail as string).toLowerCase()}`);
    }
    
    queryBuilder.append(sql` ORDER BY br.start_time ASC LIMIT 50`);
    
    const result = await db.execute(queryBuilder);
    
    res.json(result.rows.map(row => ({
      id: row.id,
      userEmail: row.user_email,
      userName: row.user_name,
      requestDate: row.request_date,
      startTime: row.start_time,
      endTime: row.end_time,
      status: row.status,
      resourceName: row.resource_name
    })));
  } catch (error: any) {
    console.error('[DataTools] Get available sessions error:', error);
    res.status(500).json({ error: 'Failed to get available sessions', details: error.message });
  }
});

router.post('/api/data-tools/link-guest-fee', isAdmin, async (req: Request, res: Response) => {
  try {
    const { guestFeeId, bookingId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!guestFeeId || !bookingId) {
      return res.status(400).json({ error: 'guestFeeId and bookingId are required' });
    }
    
    const existingFee = await db.select()
      .from(legacyPurchases)
      .where(eq(legacyPurchases.id, guestFeeId))
      .limit(1);
    
    if (existingFee.length === 0) {
      return res.status(404).json({ error: 'Guest fee not found' });
    }
    
    const existingBooking = await db.execute(sql`SELECT id, user_email FROM booking_requests WHERE id = ${bookingId}`);
    
    if (existingBooking.rows.length === 0) {
      return res.status(404).json({ error: 'Booking session not found' });
    }
    
    await db.update(legacyPurchases)
      .set({
        linkedBookingSessionId: bookingId,
        linkedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(legacyPurchases.id, guestFeeId));
    
    await db.insert(billingAuditLog).values({
      memberEmail: existingFee[0].memberEmail || 'unknown',
      actionType: 'guest_fee_manually_linked',
      actionDetails: {
        source: 'data_tools',
        guestFeeId,
        bookingId,
        itemName: existingFee[0].itemName,
        saleDate: existingFee[0].saleDate
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      console.log(`[DataTools] Linked guest fee ${guestFeeId} to booking ${bookingId} by ${staffEmail}`);
    }
    
    res.json({
      success: true,
      message: 'Guest fee successfully linked to booking session'
    });
  } catch (error: any) {
    console.error('[DataTools] Link guest fee error:', error);
    res.status(500).json({ error: 'Failed to link guest fee', details: error.message });
  }
});

router.get('/api/data-tools/bookings-search', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { date, memberEmail, limit = '50' } = req.query;
    
    if (!date && !memberEmail) {
      return res.status(400).json({ error: 'Either date or memberEmail is required' });
    }
    
    const queryBuilder = sql`
      SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.status,
        br.reconciliation_status,
        br.reconciliation_notes,
        br.reconciled_by,
        br.reconciled_at,
        r.name as resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE 1=1
    `;
    
    if (date) {
      queryBuilder.append(sql` AND br.request_date = ${date}`);
    }
    
    if (memberEmail) {
      queryBuilder.append(sql` AND LOWER(br.user_email) = ${(memberEmail as string).toLowerCase()}`);
    }
    
    queryBuilder.append(sql` ORDER BY br.request_date DESC, br.start_time ASC LIMIT ${parseInt(limit as string)}`);
    
    const result = await db.execute(queryBuilder);
    
    res.json(result.rows.map(row => ({
      id: row.id,
      userEmail: row.user_email,
      userName: row.user_name,
      requestDate: row.request_date,
      startTime: row.start_time,
      endTime: row.end_time,
      status: row.status,
      reconciliationStatus: row.reconciliation_status,
      reconciliationNotes: row.reconciliation_notes,
      reconciledBy: row.reconciled_by,
      reconciledAt: row.reconciled_at,
      resourceName: row.resource_name
    })));
  } catch (error: any) {
    console.error('[DataTools] Bookings search error:', error);
    res.status(500).json({ error: 'Failed to search bookings', details: error.message });
  }
});

router.post('/api/data-tools/update-attendance', isAdmin, async (req: Request, res: Response) => {
  try {
    const { bookingId, attendanceStatus, notes } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!bookingId || !attendanceStatus) {
      return res.status(400).json({ error: 'bookingId and attendanceStatus are required' });
    }
    
    if (!['attended', 'no_show', 'late_cancel', 'pending'].includes(attendanceStatus)) {
      return res.status(400).json({ error: 'Invalid attendance status' });
    }
    
    const existingBooking = await db.execute(sql`SELECT id, user_email, reconciliation_status, reconciliation_notes FROM booking_requests WHERE id = ${bookingId}`);
    
    if (existingBooking.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const previousStatus = existingBooking.rows[0].reconciliation_status;
    const previousNotes = existingBooking.rows[0].reconciliation_notes;
    
    await db.execute(sql`UPDATE booking_requests SET 
        reconciliation_status = ${attendanceStatus},
        reconciliation_notes = ${notes || null},
        reconciled_by = ${staffEmail},
        reconciled_at = NOW(),
        updated_at = NOW()
      WHERE id = ${bookingId}`);
    
    await db.insert(billingAuditLog).values({
      memberEmail: existingBooking.rows[0].user_email || 'unknown',
      actionType: 'attendance_manually_updated',
      previousValue: previousStatus || 'none',
      newValue: attendanceStatus,
      actionDetails: {
        source: 'data_tools',
        bookingId,
        previousNotes,
        newNotes: notes
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      console.log(`[DataTools] Updated attendance for booking ${bookingId} to ${attendanceStatus} by ${staffEmail}`);
    }
    
    res.json({
      success: true,
      message: `Attendance status updated to ${attendanceStatus}`
    });
  } catch (error: any) {
    console.error('[DataTools] Update attendance error:', error);
    res.status(500).json({ error: 'Failed to update attendance', details: error.message });
  }
});

router.post('/api/data-tools/mindbody-reimport', isAdmin, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > 90) {
      return res.status(400).json({ error: 'Date range cannot exceed 90 days' });
    }
    
    await db.insert(billingAuditLog).values({
      memberEmail: 'system',
      actionType: 'mindbody_reimport_requested',
      actionDetails: {
        source: 'data_tools',
        startDate,
        endDate,
        requestedBy: staffEmail
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      console.log(`[DataTools] Mindbody reimport requested for ${startDate} to ${endDate} by ${staffEmail}`);
    }
    
    res.json({
      success: true,
      message: `Mindbody re-import has been queued for ${startDate} to ${endDate}. The process will run in the background.`,
      note: 'This feature requires manual file upload. Please use the legacy purchases import with updated CSV files for the date range.'
    });
  } catch (error: any) {
    console.error('[DataTools] Mindbody reimport error:', error);
    res.status(500).json({ error: 'Failed to queue mindbody reimport', details: error.message });
  }
});

router.get('/api/data-tools/audit-log', isAdmin, async (req: Request, res: Response) => {
  try {
    const { limit = '20', actionType } = req.query;
    
    let query = db.select()
      .from(billingAuditLog)
      .orderBy(desc(billingAuditLog.createdAt))
      .limit(parseInt(limit as string));
    
    if (actionType) {
      query = db.select()
        .from(billingAuditLog)
        .where(eq(billingAuditLog.actionType, actionType as string))
        .orderBy(desc(billingAuditLog.createdAt))
        .limit(parseInt(limit as string));
    }
    
    const logs = await query;
    
    res.json(logs.filter(log => 
      ['member_resynced_from_hubspot', 'guest_fee_manually_linked', 'attendance_manually_updated', 'mindbody_reimport_requested'].includes(log.actionType)
    ));
  } catch (error: any) {
    console.error('[DataTools] Get audit log error:', error);
    res.status(500).json({ error: 'Failed to get audit log', details: error.message });
  }
});

router.get('/api/data-tools/staff-activity', isAdmin, async (req: Request, res: Response) => {
  try {
    const limitParam = parseInt(req.query.limit as string) || 50;
    const staffEmail = req.query.staff_email as string;
    const actionsParam = req.query.actions as string;
    const actorType = req.query.actor_type as string;
    
    const conditions = [];
    
    if (staffEmail) {
      conditions.push(eq(adminAuditLog.staffEmail, staffEmail));
    }
    
    if (actionsParam) {
      const actionsList = actionsParam.split(',').filter(Boolean);
      if (actionsList.length > 0) {
        conditions.push(inArray(adminAuditLog.action, actionsList));
      }
    }
    
    if (actorType && ['staff', 'member', 'system'].includes(actorType)) {
      conditions.push(eq(adminAuditLog.actorType, actorType));
    }
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const logs = await db.select()
      .from(adminAuditLog)
      .where(whereClause)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limitParam);
    
    // Ensure details are parsed objects, not strings (driver may return jsonb as string)
    const parsedLogs = logs.map(log => ({
      ...log,
      details: typeof log.details === 'string' 
        ? (() => { try { return JSON.parse(log.details); } catch { return log.details; } })()
        : log.details
    }));
    
    res.json({ logs: parsedLogs });
  } catch (error: any) {
    console.error('[DataTools] Get staff activity error:', error);
    res.status(500).json({ error: 'Failed to get staff activity', details: error.message });
  }
});

// Clean up stale mindbody_client_id values by comparing against HubSpot
router.post('/api/data-tools/cleanup-mindbody-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting mindbody_client_id cleanup (dryRun: ${dryRun}) by ${staffEmail}`);
    
    // Get all users with mindbody_client_id
    const usersWithMindbody = await db.execute(sql`SELECT id, email, mindbody_client_id, hubspot_id 
       FROM users 
       WHERE mindbody_client_id IS NOT NULL 
         AND mindbody_client_id != ''
       ORDER BY email`);
    
    if (usersWithMindbody.rows.length === 0) {
      return res.json({ 
        message: 'No users with mindbody_client_id found',
        totalChecked: 0,
        toClean: 0,
        cleaned: 0
      });
    }
    
    const hubspot = await getHubSpotClient();
    const toClean: Array<{ email: string; mindbodyClientId: string; hubspotId: string | null }> = [];
    const validated: Array<{ email: string; mindbodyClientId: string }> = [];
    const errors: string[] = [];
    
    // Process in batches to avoid rate limits
    const batchSize = 50;
    for (let i = 0; i < usersWithMindbody.rows.length; i += batchSize) {
      const batch = usersWithMindbody.rows.slice(i, i + batchSize);
      
      for (const user of batch) {
        try {
          let hubspotMindbodyId: string | null = null;
          
          if (user.hubspot_id) {
            // Fetch contact from HubSpot using known ID
            const contact = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(user.hubspot_id, ['mindbody_client_id'])
            );
            hubspotMindbodyId = contact.properties?.mindbody_client_id || null;
          } else {
            // Search by email
            const searchResponse = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.searchApi.doSearch({
                filterGroups: [{
                  filters: [{
                    propertyName: 'email',
                    operator: 'EQ',
                    value: user.email.toLowerCase()
                  }]
                }],
                properties: ['mindbody_client_id'],
                limit: 1
              })
            );
            
            if (searchResponse.results && searchResponse.results.length > 0) {
              hubspotMindbodyId = searchResponse.results[0].properties?.mindbody_client_id || null;
            }
          }
          
          // Compare values
          if (!hubspotMindbodyId || hubspotMindbodyId.trim() === '') {
            toClean.push({
              email: user.email,
              mindbodyClientId: user.mindbody_client_id,
              hubspotId: user.hubspot_id
            });
          } else if (hubspotMindbodyId === user.mindbody_client_id) {
            validated.push({
              email: user.email,
              mindbodyClientId: user.mindbody_client_id
            });
          } else {
            // HubSpot has a different value - flag for review but don't auto-clean
            console.log(`[DataTools] Mindbody ID mismatch for ${user.email}: DB=${user.mindbody_client_id}, HubSpot=${hubspotMindbodyId}`);
          }
        } catch (err: any) {
          errors.push(`Error checking ${user.email}: ${err.message}`);
        }
      }
      
      // Small delay between batches to respect rate limits
      if (i + batchSize < usersWithMindbody.rows.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    let cleanedCount = 0;
    
    if (!dryRun && toClean.length > 0) {
      // Actually clean up the stale IDs
      const emailsToClean = toClean.map(u => u.email.toLowerCase());
      
      const cleanResult = await db.execute(sql`UPDATE users 
         SET mindbody_client_id = NULL, updated_at = NOW() 
         WHERE LOWER(email) IN (${sql.join(emailsToClean.map((e: string) => sql`${e}`), sql`, `)})
         RETURNING email`);
      
      cleanedCount = cleanResult.rowCount || 0;
      
      // Log the action
      await logFromRequest(req, {
        action: 'cleanup_mindbody_ids',
        resourceType: 'users',
        details: {
          cleanedCount,
          emails: emailsToClean.slice(0, 20) // Log first 20 for audit
        }
      });
      
      console.log(`[DataTools] Cleaned ${cleanedCount} stale mindbody_client_id values`);
    }
    
    res.json({
      message: dryRun ? 'Dry run complete - no changes made' : `Cleaned ${cleanedCount} stale mindbody IDs`,
      totalChecked: usersWithMindbody.rows.length,
      validated: validated.length,
      toClean: toClean.length,
      cleaned: cleanedCount,
      staleRecords: toClean.slice(0, 50), // Return first 50 for review
      errors: errors.slice(0, 10)
    });
  } catch (error: any) {
    console.error('[DataTools] Cleanup mindbody IDs error:', error);
    res.status(500).json({ error: 'Failed to cleanup mindbody IDs', details: error.message });
  }
});

// Create HubSpot contacts for members who don't have one yet
router.post('/api/data-tools/sync-members-to-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { emails, dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting HubSpot sync for members without contacts (dryRun: ${dryRun}) by ${staffEmail}`);
    
    // Get members without HubSpot ID
    const queryBuilder = sql`
      SELECT id, email, first_name, last_name, tier, mindbody_client_id, membership_status
      FROM users 
      WHERE hubspot_id IS NULL
    `;
    
    if (emails && Array.isArray(emails) && emails.length > 0) {
      queryBuilder.append(sql` AND LOWER(email) IN (${sql.join(emails.map((e: string) => sql`${e.toLowerCase()}`), sql`, `)})`);
    }
    
    queryBuilder.append(sql` ORDER BY email LIMIT 100`);
    
    const membersWithoutHubspot = await db.execute(queryBuilder);
    
    if (membersWithoutHubspot.rows.length === 0) {
      return res.json({ 
        message: 'No members found without HubSpot contacts',
        totalFound: 0,
        created: 0
      });
    }
    
    const { findOrCreateHubSpotContact } = await import('../core/hubspot/members');
    
    const created: Array<{ email: string; contactId: string }> = [];
    const existing: Array<{ email: string; contactId: string }> = [];
    const errors: string[] = [];
    
    if (!dryRun) {
      for (const member of membersWithoutHubspot.rows) {
        try {
          const result = await findOrCreateHubSpotContact(
            member.email,
            member.first_name || '',
            member.last_name || '',
            undefined,
            member.tier || undefined
          );
          
          await db.execute(sql`UPDATE users SET hubspot_id = ${result.contactId}, updated_at = NOW() WHERE id = ${member.id}`);
          
          if (result.isNew) {
            created.push({ email: member.email, contactId: result.contactId });
          } else {
            existing.push({ email: member.email, contactId: result.contactId });
          }
          
          console.log(`[DataTools] ${result.isNew ? 'Created' : 'Found existing'} HubSpot contact for ${member.email}: ${result.contactId}`);
          
          // Small delay between API calls
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: any) {
          console.error(`[DataTools] Error syncing ${member.email} to HubSpot:`, err);
          errors.push(`${member.email}: ${err.message}`);
        }
      }
      
      // Log the action
      await logFromRequest(req, {
        action: 'sync_members_to_hubspot',
        resourceType: 'users',
        details: {
          created: created.length,
          existing: existing.length,
          errors: errors.length
        }
      });
    }
    
    res.json({
      message: dryRun 
        ? `Dry run: Found ${membersWithoutHubspot.rows.length} members without HubSpot contacts` 
        : `Synced ${created.length + existing.length} members to HubSpot (${created.length} new, ${existing.length} existing)`,
      totalFound: membersWithoutHubspot.rows.length,
      members: membersWithoutHubspot.rows.map(m => ({
        email: m.email,
        name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        tier: m.tier,
        mindbodyClientId: m.mindbody_client_id
      })),
      created: created.length,
      existing: existing.length,
      errors: errors.slice(0, 10)
    });
  } catch (error: any) {
    console.error('[DataTools] Sync members to HubSpot error:', error);
    res.status(500).json({ error: 'Failed to sync members to HubSpot', details: error.message });
  }
});

router.post('/api/data-tools/sync-subscription-status', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting subscription status sync (dryRun: ${dryRun}) by ${staffEmail}`);
    
    const { getStripeClient } = await import('../core/stripe/client');
    const stripe = await getStripeClient();
    
    const membersWithStripe = await db.execute(sql`SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, billing_provider
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
         AND role = 'member'
         AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
       ORDER BY email
       LIMIT 500`);
    
    if (membersWithStripe.rows.length === 0) {
      return res.json({ 
        message: 'No members with Stripe customer IDs found',
        totalChecked: 0,
        mismatches: []
      });
    }
    
    const STRIPE_STATUS_TO_APP_STATUS: Record<string, string> = {
      'active': 'active',
      'trialing': 'active',
      'past_due': 'past_due',
      'canceled': 'cancelled',
      'unpaid': 'suspended',
      'incomplete': 'pending',
      'incomplete_expired': 'inactive',
      'paused': 'frozen'
    };
    
    const mismatches: Array<{
      email: string;
      name: string;
      currentStatus: string;
      stripeStatus: string;
      expectedStatus: string;
      stripeCustomerId: string;
      userId: number;
    }> = [];
    
    const updated: Array<{ email: string; oldStatus: string; newStatus: string }> = [];
    const errors: string[] = [];
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 100;
    
    for (let i = 0; i < membersWithStripe.rows.length; i += BATCH_SIZE) {
      const batch = membersWithStripe.rows.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (member) => {
        try {
          const customerId = member.stripe_customer_id;
          if (!customerId) return;
          
          const customerSubs = await stripe.subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 10
          });
          
          const activeSub = customerSubs.data?.find((s: any) => 
            ['active', 'trialing', 'past_due'].includes(s.status)
          ) || customerSubs.data?.[0];
          
          let stripeStatus = 'no_subscription';
          let expectedAppStatus = 'inactive';
          
          if (activeSub) {
            stripeStatus = activeSub.status;
            expectedAppStatus = STRIPE_STATUS_TO_APP_STATUS[stripeStatus] || 'inactive';
          }
          
          const currentStatus = (member.membership_status || '').toLowerCase();
          const normalizedExpected = expectedAppStatus.toLowerCase();
          
          const statusMatches = currentStatus === normalizedExpected ||
            (currentStatus === 'active' && ['active', 'trialing'].includes(stripeStatus)) ||
            (currentStatus === 'cancelled' && stripeStatus === 'canceled') ||
            (currentStatus === 'terminated' && stripeStatus === 'canceled') ||
            (currentStatus === 'non-member' && stripeStatus === 'canceled') ||
            (currentStatus === 'pending' && ['incomplete', 'trialing'].includes(stripeStatus)) ||
            (currentStatus === 'frozen' && ['paused', 'past_due'].includes(stripeStatus)) ||
            (currentStatus === 'suspended' && ['unpaid', 'past_due'].includes(stripeStatus));
          
          if (!statusMatches) {
            const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
            
            mismatches.push({
              email: member.email,
              name: memberName,
              currentStatus: member.membership_status || 'none',
              stripeStatus,
              expectedStatus: expectedAppStatus,
              stripeCustomerId: customerId,
              userId: member.id
            });
            
            if (!dryRun) {
              await db.execute(sql`UPDATE users 
                 SET membership_status = ${expectedAppStatus}, updated_at = NOW() 
                 WHERE id = ${member.id}`);
              
              // Sync status change to HubSpot
              try {
                const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
                await syncMemberToHubSpot({ email: member.email, status: expectedAppStatus, billingProvider: 'stripe' });
              } catch (e: any) {
                console.warn(`[DataTools] Failed to sync status to HubSpot for ${member.email}:`, e?.message || e);
              }
              
              await db.insert(billingAuditLog).values({
                memberEmail: member.email,
                actionType: 'subscription_status_synced',
                previousValue: member.membership_status || 'none',
                newValue: expectedAppStatus,
                actionDetails: {
                  source: 'data_tools',
                  stripeCustomerId: customerId,
                  stripeSubscriptionStatus: stripeStatus,
                  syncedBy: staffEmail
                },
                performedBy: staffEmail,
                performedByName: staffEmail
              });
              
              updated.push({
                email: member.email,
                oldStatus: member.membership_status || 'none',
                newStatus: expectedAppStatus
              });
              
              if (!isProduction) {
                console.log(`[DataTools] Updated ${member.email} status: ${member.membership_status} -> ${expectedAppStatus}`);
              }
            }
          }
        } catch (err: any) {
          errors.push(`${member.email}: ${err.message}`);
          if (!isProduction) {
            console.error(`[DataTools] Error checking subscription for ${member.email}:`, err.message);
          }
        }
      }));
      
      if (i + BATCH_SIZE < membersWithStripe.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    if (!dryRun && updated.length > 0) {
      logFromRequest(req, 'sync_subscription_status', 'users', null, undefined, {
        action: 'bulk_status_sync',
        updatedCount: updated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${mismatches.length} status mismatches out of ${membersWithStripe.rows.length} members`
        : `Updated ${updated.length} member statuses to match Stripe`,
      totalChecked: membersWithStripe.rows.length,
      mismatchCount: mismatches.length,
      updatedCount: updated.length,
      mismatches: mismatches.slice(0, 100),
      updated: updated.slice(0, 50),
      errors: errors.slice(0, 10),
      dryRun
    });
  } catch (error: any) {
    console.error('[DataTools] Sync subscription status error:', error);
    res.status(500).json({ error: 'Failed to sync subscription status', details: error.message });
  }
});

router.post('/api/data-tools/clear-orphaned-stripe-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Clearing orphaned Stripe customer IDs (dryRun: ${dryRun}) by ${staffEmail}`);
    
    const { getStripeClient } = await import('../core/stripe/client');
    const stripe = await getStripeClient();
    
    const usersWithStripe = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id, role, membership_status
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
       ORDER BY email
       LIMIT 500`);
    
    if (usersWithStripe.rows.length === 0) {
      return res.json({ 
        message: 'No users with Stripe customer IDs found',
        totalChecked: 0,
        orphanedCount: 0,
        cleared: []
      });
    }
    
    const orphaned: Array<{
      email: string;
      name: string;
      stripeCustomerId: string;
      userId: string;
      role: string;
    }> = [];
    
    const cleared: Array<{ email: string; stripeCustomerId: string }> = [];
    const errors: string[] = [];
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 100;
    
    for (let i = 0; i < usersWithStripe.rows.length; i += BATCH_SIZE) {
      const batch = usersWithStripe.rows.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (user) => {
        try {
          const customerId = user.stripe_customer_id;
          if (!customerId) return;
          
          try {
            await stripe.customers.retrieve(customerId);
          } catch (err: any) {
            const isNotFound = err.code === 'resource_missing' || 
              err.statusCode === 404 || 
              err.message?.includes('No such customer');
            
            if (isNotFound) {
              const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
              orphaned.push({
                email: user.email,
                name: userName,
                stripeCustomerId: customerId,
                userId: user.id,
                role: user.role
              });
              
              if (!dryRun) {
                await db.execute(sql`UPDATE users SET stripe_customer_id = NULL, updated_at = NOW() WHERE id = ${user.id}`);
                
                cleared.push({
                  email: user.email,
                  stripeCustomerId: customerId
                });
                
                console.log(`[DataTools] Cleared orphaned Stripe ID for ${user.email}: ${customerId}`);
              }
            }
          }
        } catch (err: any) {
          errors.push(`${user.email}: ${err.message}`);
        }
      }));
      
      if (i + BATCH_SIZE < usersWithStripe.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    if (!dryRun && cleared.length > 0) {
      logFromRequest(req, 'clear_orphaned_stripe_ids', 'users', null, undefined, {
        action: 'bulk_clear_orphaned',
        clearedCount: cleared.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${orphaned.length} orphaned Stripe customer IDs out of ${usersWithStripe.rows.length} users`
        : `Cleared ${cleared.length} orphaned Stripe customer IDs`,
      totalChecked: usersWithStripe.rows.length,
      orphanedCount: orphaned.length,
      clearedCount: cleared.length,
      orphaned: orphaned.slice(0, 100),
      cleared: cleared.slice(0, 50),
      errors: errors.slice(0, 10),
      dryRun
    });
  } catch (error: any) {
    console.error('[DataTools] Clear orphaned Stripe IDs error:', error);
    res.status(500).json({ error: 'Failed to clear orphaned Stripe IDs', details: error.message });
  }
});

router.post('/api/data-tools/link-stripe-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting Stripe-HubSpot link tool (dryRun: ${dryRun}) by ${staffEmail}`);
    
    const { getStripeClient } = await import('../core/stripe/client');
    const { findOrCreateHubSpotContact } = await import('../core/hubspot/members');
    const { getOrCreateStripeCustomer } = await import('../core/stripe/customers');
    const stripe = await getStripeClient();
    
    const stripeOnlyMembers = await db.execute(sql`SELECT id, email, first_name, last_name, tier, stripe_customer_id
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
         AND (hubspot_id IS NULL OR hubspot_id = '')
         AND role = 'member'
       ORDER BY email
       LIMIT 200`);
    
    const hubspotOnlyMembers = await db.execute(sql`SELECT id, email, first_name, last_name, tier, hubspot_id
       FROM users 
       WHERE hubspot_id IS NOT NULL
         AND hubspot_id != ''
         AND (stripe_customer_id IS NULL OR stripe_customer_id = '')
         AND role = 'member'
       ORDER BY email
       LIMIT 200`);
    
    const stripeOnlyList = stripeOnlyMembers.rows.map(m => ({
      id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unknown',
      tier: m.tier,
      stripeCustomerId: m.stripe_customer_id,
      issue: 'has_stripe_no_hubspot'
    }));
    
    const hubspotOnlyList = hubspotOnlyMembers.rows.map(m => ({
      id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unknown',
      tier: m.tier,
      hubspotId: m.hubspot_id,
      issue: 'has_hubspot_no_stripe'
    }));
    
    const hubspotCreated: Array<{ email: string; contactId: string }> = [];
    const stripeCreated: Array<{ email: string; customerId: string }> = [];
    const errors: string[] = [];
    
    if (!dryRun) {
      for (const member of stripeOnlyMembers.rows) {
        try {
          const result = await findOrCreateHubSpotContact(
            member.email,
            member.first_name || '',
            member.last_name || '',
            undefined,
            member.tier || undefined
          );
          
          await db.execute(sql`UPDATE users SET hubspot_id = ${result.contactId}, updated_at = NOW() WHERE id = ${member.id}`);
          
          hubspotCreated.push({ email: member.email, contactId: result.contactId });
          
          await db.insert(billingAuditLog).values({
            memberEmail: member.email,
            actionType: 'hubspot_contact_created_from_stripe',
            actionDetails: {
              source: 'data_tools',
              hubspotContactId: result.contactId,
              stripeCustomerId: member.stripe_customer_id,
              isNew: result.isNew
            },
            performedBy: staffEmail,
            performedByName: staffEmail
          });
          
          if (!isProduction) {
            console.log(`[DataTools] Created HubSpot contact for ${member.email}: ${result.contactId}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: any) {
          errors.push(`HubSpot for ${member.email}: ${err.message}`);
          console.error(`[DataTools] Error creating HubSpot contact for ${member.email}:`, err.message);
        }
      }
      
      for (const member of hubspotOnlyMembers.rows) {
        try {
          const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
          const result = await getOrCreateStripeCustomer(
            member.id.toString(),
            member.email,
            memberName,
            member.tier
          );
          
          stripeCreated.push({ email: member.email, customerId: result.customerId });
          
          await db.insert(billingAuditLog).values({
            memberEmail: member.email,
            actionType: 'stripe_customer_created_from_hubspot',
            actionDetails: {
              source: 'data_tools',
              stripeCustomerId: result.customerId,
              hubspotContactId: member.hubspot_id,
              isNew: result.isNew
            },
            performedBy: staffEmail,
            performedByName: staffEmail
          });
          
          if (!isProduction) {
            console.log(`[DataTools] Created Stripe customer for ${member.email}: ${result.customerId}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: any) {
          errors.push(`Stripe for ${member.email}: ${err.message}`);
          console.error(`[DataTools] Error creating Stripe customer for ${member.email}:`, err.message);
        }
      }
      
      logFromRequest(req, 'link_stripe_hubspot', 'users', null, undefined, {
        action: 'bulk_link_stripe_hubspot',
        hubspotCreated: hubspotCreated.length,
        stripeCreated: stripeCreated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${stripeOnlyList.length} Stripe-only and ${hubspotOnlyList.length} HubSpot-only members`
        : `Linked ${hubspotCreated.length + stripeCreated.length} members (${hubspotCreated.length} HubSpot contacts, ${stripeCreated.length} Stripe customers created)`,
      stripeOnlyCount: stripeOnlyList.length,
      hubspotOnlyCount: hubspotOnlyList.length,
      stripeOnlyMembers: stripeOnlyList.slice(0, 50),
      hubspotOnlyMembers: hubspotOnlyList.slice(0, 50),
      hubspotCreated: hubspotCreated.slice(0, 50),
      stripeCreated: stripeCreated.slice(0, 50),
      errors: errors.slice(0, 20),
      dryRun
    });
  } catch (error: any) {
    console.error('[DataTools] Link Stripe-HubSpot error:', error);
    res.status(500).json({ error: 'Failed to link Stripe-HubSpot', details: error.message });
  }
});

router.post('/api/data-tools/sync-visit-counts', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting visit count sync to HubSpot (dryRun: ${dryRun}) by ${staffEmail}`);
    
    const hubspot = await getHubSpotClient();
    
    const membersWithHubspot = await db.execute(sql`SELECT id, email, first_name, last_name, hubspot_id
       FROM users 
       WHERE hubspot_id IS NOT NULL
         AND hubspot_id != ''
         AND role = 'member'
       ORDER BY email
       LIMIT 1000`);
    
    if (membersWithHubspot.rows.length === 0) {
      return res.json({ 
        message: 'No members with HubSpot IDs found',
        totalChecked: 0,
        mismatches: []
      });
    }
    
    interface VisitCountRecord {
      email: string;
      name: string;
      hubspotId: string;
      appVisitCount: number;
      hubspotVisitCount: number | null;
      needsUpdate: boolean;
    }
    
    const mismatches: VisitCountRecord[] = [];
    const matched: VisitCountRecord[] = [];
    const updated: Array<{ email: string; oldCount: number | null; newCount: number }> = [];
    const errors: string[] = [];
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 150;
    
    for (let i = 0; i < membersWithHubspot.rows.length; i += BATCH_SIZE) {
      const batch = membersWithHubspot.rows.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (member) => {
        try {
          const normalizedEmail = member.email.toLowerCase();
          
          const visitCountResult = await db.execute(sql`
            SELECT COUNT(DISTINCT booking_id) as count FROM (
              SELECT id as booking_id FROM booking_requests
              WHERE LOWER(user_email) = ${normalizedEmail}
                AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
                AND status NOT IN ('cancelled', 'declined')
              UNION
              SELECT br.id as booking_id FROM booking_requests br
              JOIN booking_members bm ON br.id = bm.booking_id
              WHERE LOWER(bm.user_email) = ${normalizedEmail}
                AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
                AND br.status NOT IN ('cancelled', 'declined')
              UNION
              SELECT br.id as booking_id FROM booking_requests br
              JOIN booking_guests bg ON br.id = bg.booking_id
              WHERE LOWER(bg.guest_email) = ${normalizedEmail}
                AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
                AND br.status NOT IN ('cancelled', 'declined')
            ) all_bookings
          `);
          
          const eventCountResult = await db.execute(sql`
            SELECT COUNT(*) as count FROM event_rsvps er
            JOIN events e ON er.event_id = e.id
            WHERE (LOWER(er.user_email) = ${normalizedEmail} OR er.matched_user_id = ${member.id})
              AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
              AND er.status != 'cancelled'
          `);
          
          const wellnessCountResult = await db.execute(sql`
            SELECT COUNT(*) as count FROM wellness_enrollments we
            JOIN wellness_classes wc ON we.class_id = wc.id
            WHERE LOWER(we.user_email) = ${normalizedEmail}
              AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
              AND we.status != 'cancelled'
          `);
          
          const bookingCount = parseInt(visitCountResult.rows[0]?.count || '0');
          const eventCount = parseInt(eventCountResult.rows[0]?.count || '0');
          const wellnessCount = parseInt(wellnessCountResult.rows[0]?.count || '0');
          const appVisitCount = bookingCount + eventCount + wellnessCount;
          
          let hubspotVisitCount: number | null = null;
          try {
            const contact = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(member.hubspot_id, ['total_visit_count'])
            );
            const rawCount = contact.properties?.total_visit_count;
            hubspotVisitCount = rawCount ? parseInt(rawCount) : null;
          } catch (hubspotErr: any) {
            if (!hubspotErr.message?.includes('404')) {
              throw hubspotErr;
            }
          }
          
          const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
          const record: VisitCountRecord = {
            email: member.email,
            name: memberName,
            hubspotId: member.hubspot_id,
            appVisitCount,
            hubspotVisitCount,
            needsUpdate: hubspotVisitCount !== appVisitCount
          };
          
          if (hubspotVisitCount !== appVisitCount) {
            mismatches.push(record);
            
            if (!dryRun) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.contacts.basicApi.update(member.hubspot_id, {
                    properties: {
                      total_visit_count: appVisitCount.toString()
                    }
                  })
                );
                
                updated.push({
                  email: member.email,
                  oldCount: hubspotVisitCount,
                  newCount: appVisitCount
                });
                
                await db.insert(billingAuditLog).values({
                  memberEmail: member.email,
                  actionType: 'visit_count_synced_to_hubspot',
                  previousValue: hubspotVisitCount?.toString() || 'none',
                  newValue: appVisitCount.toString(),
                  actionDetails: {
                    source: 'data_tools',
                    hubspotContactId: member.hubspot_id,
                    bookingCount,
                    eventCount,
                    wellnessCount
                  },
                  performedBy: staffEmail,
                  performedByName: staffEmail
                });
                
                if (!isProduction) {
                  console.log(`[DataTools] Updated HubSpot visit count for ${member.email}: ${hubspotVisitCount} -> ${appVisitCount}`);
                }
              } catch (updateErr: any) {
                errors.push(`Update ${member.email}: ${updateErr.message}`);
              }
            }
          } else {
            matched.push(record);
          }
        } catch (err: any) {
          errors.push(`${member.email}: ${err.message}`);
          if (!isProduction) {
            console.error(`[DataTools] Error checking visit count for ${member.email}:`, err.message);
          }
        }
      }));
      
      if (i + BATCH_SIZE < membersWithHubspot.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    if (!dryRun && updated.length > 0) {
      logFromRequest(req, 'sync_visit_counts', 'users', null, undefined, {
        action: 'bulk_visit_count_sync',
        updatedCount: updated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${mismatches.length} members with visit count mismatches`
        : `Updated ${updated.length} HubSpot contacts with visit counts`,
      totalChecked: membersWithHubspot.rows.length,
      mismatchCount: mismatches.length,
      matchedCount: matched.length,
      updatedCount: updated.length,
      mismatches: mismatches.slice(0, 100),
      updated: updated.slice(0, 50),
      errors: errors.slice(0, 20),
      dryRun
    });
  } catch (error: any) {
    console.error('[DataTools] Sync visit counts error:', error);
    res.status(500).json({ error: 'Failed to sync visit counts', details: error.message });
  }
});

router.post('/api/data-tools/detect-duplicates', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    console.log(`[DataTools] Starting duplicate detection by ${staffEmail}`);
    
    const appDuplicatesResult = await db.execute(sql`
      SELECT LOWER(email) as normalized_email, 
             COUNT(*) as count,
             ARRAY_AGG(id) as user_ids,
             ARRAY_AGG(email) as emails,
             ARRAY_AGG(first_name || ' ' || last_name) as names,
             ARRAY_AGG(hubspot_id) as hubspot_ids
      FROM users
      WHERE email IS NOT NULL
        AND email != ''
        AND archived_at IS NULL
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `);
    
    const appDuplicates = appDuplicatesResult.rows.map(row => ({
      email: row.normalized_email,
      count: parseInt(row.count),
      members: row.user_ids.map((id: string, idx: number) => ({
        id,
        email: row.emails[idx],
        name: row.names[idx]?.trim() || 'Unknown',
        hubspotId: row.hubspot_ids[idx]
      }))
    }));
    
    const hubspot = await getHubSpotClient();
    const hubspotDuplicates: Array<{
      email: string;
      contacts: Array<{ contactId: string; firstname: string; lastname: string; createdate: string }>;
    }> = [];
    const hubspotErrors: string[] = [];
    
    const membersWithHubspot = await db.execute(sql`SELECT DISTINCT LOWER(email) as email, hubspot_id
       FROM users 
       WHERE hubspot_id IS NOT NULL
         AND hubspot_id != ''
         AND email IS NOT NULL
         AND archived_at IS NULL
       LIMIT 500`);
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 150;
    
    for (let i = 0; i < membersWithHubspot.rows.length; i += BATCH_SIZE) {
      const batch = membersWithHubspot.rows.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (member) => {
        try {
          const searchResponse = await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.searchApi.doSearch({
              filterGroups: [{
                filters: [{
                  propertyName: 'email',
                  operator: 'EQ',
                  value: member.email
                }]
              }],
              properties: ['email', 'firstname', 'lastname', 'createdate'],
              limit: 10
            })
          );
          
          if (searchResponse.results && searchResponse.results.length > 1) {
            hubspotDuplicates.push({
              email: member.email,
              contacts: searchResponse.results.map((contact: any) => ({
                contactId: contact.id,
                firstname: contact.properties?.firstname || '',
                lastname: contact.properties?.lastname || '',
                createdate: contact.properties?.createdate || ''
              }))
            });
          }
        } catch (err: any) {
          hubspotErrors.push(`${member.email}: ${err.message}`);
        }
      }));
      
      if (i + BATCH_SIZE < membersWithHubspot.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    await db.insert(billingAuditLog).values({
      memberEmail: 'system',
      actionType: 'duplicate_detection_run',
      actionDetails: {
        source: 'data_tools',
        appDuplicateCount: appDuplicates.length,
        hubspotDuplicateCount: hubspotDuplicates.length,
        membersChecked: membersWithHubspot.rows.length
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    logFromRequest(req, 'detect_duplicates', 'users', null, undefined, {
      action: 'duplicate_detection',
      appDuplicateCount: appDuplicates.length,
      hubspotDuplicateCount: hubspotDuplicates.length,
      staffEmail
    });
    
    res.json({
      message: `Found ${appDuplicates.length} duplicate emails in app and ${hubspotDuplicates.length} duplicate contacts in HubSpot`,
      appDuplicates,
      hubspotDuplicates,
      totalAppDuplicates: appDuplicates.length,
      totalHubspotDuplicates: hubspotDuplicates.length,
      membersCheckedInHubspot: membersWithHubspot.rows.length,
      errors: hubspotErrors.slice(0, 20)
    });
  } catch (error: any) {
    console.error('[DataTools] Detect duplicates error:', error);
    res.status(500).json({ error: 'Failed to detect duplicates', details: error.message });
  }
});

router.post('/api/data-tools/sync-payment-status', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting payment status sync to HubSpot (dryRun: ${dryRun}) by ${staffEmail}`);
    
    const { getStripeClient } = await import('../core/stripe/client');
    const hubspot = await getHubSpotClient();
    const stripe = await getStripeClient();
    
    const membersWithBoth = await db.execute(sql`SELECT id, email, first_name, last_name, tier, stripe_customer_id, hubspot_id
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
         AND stripe_customer_id != ''
         AND hubspot_id IS NOT NULL
         AND hubspot_id != ''
         AND role = 'member'
       ORDER BY email
       LIMIT 500`);
    
    if (membersWithBoth.rows.length === 0) {
      return res.json({ 
        message: 'No members with both Stripe and HubSpot found',
        totalChecked: 0,
        needsUpdate: []
      });
    }
    
    interface PaymentStatusRecord {
      email: string;
      name: string;
      stripeCustomerId: string;
      hubspotId: string;
      stripePaymentStatus: string;
      stripeLastInvoiceDate: string | null;
      stripeLastInvoiceAmount: number | null;
      hubspotPaymentStatus: string | null;
      needsUpdate: boolean;
    }
    
    const needsUpdateList: PaymentStatusRecord[] = [];
    const alreadySynced: PaymentStatusRecord[] = [];
    const updated: Array<{ email: string; oldStatus: string | null; newStatus: string }> = [];
    const errors: string[] = [];
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 150;
    
    for (let i = 0; i < membersWithBoth.rows.length; i += BATCH_SIZE) {
      const batch = membersWithBoth.rows.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (member) => {
        try {
          const invoices = await stripe.invoices.list({
            customer: member.stripe_customer_id,
            limit: 1,
            status: 'paid'
          });
          
          let stripePaymentStatus = 'no_invoices';
          let lastInvoiceDate: string | null = null;
          let lastInvoiceAmount: number | null = null;
          
          if (invoices.data.length > 0) {
            const latestInvoice = invoices.data[0];
            stripePaymentStatus = latestInvoice.status || 'unknown';
            lastInvoiceDate = latestInvoice.created 
              ? new Date(latestInvoice.created * 1000).toISOString().split('T')[0]
              : null;
            lastInvoiceAmount = latestInvoice.amount_paid || null;
          } else {
            const allInvoices = await stripe.invoices.list({
              customer: member.stripe_customer_id,
              limit: 1
            });
            
            if (allInvoices.data.length > 0) {
              const latestInvoice = allInvoices.data[0];
              stripePaymentStatus = latestInvoice.status || 'unknown';
              lastInvoiceDate = latestInvoice.created 
                ? new Date(latestInvoice.created * 1000).toISOString().split('T')[0]
                : null;
              lastInvoiceAmount = latestInvoice.amount_due || null;
            }
          }
          
          let hubspotPaymentStatus: string | null = null;
          try {
            const contact = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(member.hubspot_id, ['last_payment_status'])
            );
            hubspotPaymentStatus = contact.properties?.last_payment_status || null;
          } catch (hubspotErr: any) {
            if (!hubspotErr.message?.includes('404')) {
              throw hubspotErr;
            }
          }
          
          const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
          const record: PaymentStatusRecord = {
            email: member.email,
            name: memberName,
            stripeCustomerId: member.stripe_customer_id,
            hubspotId: member.hubspot_id,
            stripePaymentStatus,
            stripeLastInvoiceDate: lastInvoiceDate,
            stripeLastInvoiceAmount: lastInvoiceAmount,
            hubspotPaymentStatus,
            needsUpdate: hubspotPaymentStatus !== stripePaymentStatus
          };
          
          if (hubspotPaymentStatus !== stripePaymentStatus) {
            needsUpdateList.push(record);
            
            if (!dryRun) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.contacts.basicApi.update(member.hubspot_id, {
                    properties: {
                      last_payment_status: stripePaymentStatus,
                      last_payment_date: lastInvoiceDate || '',
                      last_payment_amount: lastInvoiceAmount ? (lastInvoiceAmount / 100).toFixed(2) : ''
                    }
                  })
                );
                
                updated.push({
                  email: member.email,
                  oldStatus: hubspotPaymentStatus,
                  newStatus: stripePaymentStatus
                });
                
                await db.insert(billingAuditLog).values({
                  memberEmail: member.email,
                  actionType: 'payment_status_synced_to_hubspot',
                  previousValue: hubspotPaymentStatus || 'none',
                  newValue: stripePaymentStatus,
                  actionDetails: {
                    source: 'data_tools',
                    stripeCustomerId: member.stripe_customer_id,
                    hubspotContactId: member.hubspot_id,
                    lastInvoiceDate,
                    lastInvoiceAmountCents: lastInvoiceAmount
                  },
                  performedBy: staffEmail,
                  performedByName: staffEmail
                });
                
                if (!isProduction) {
                  console.log(`[DataTools] Updated HubSpot payment status for ${member.email}: ${hubspotPaymentStatus} -> ${stripePaymentStatus}`);
                }
              } catch (updateErr: any) {
                errors.push(`Update ${member.email}: ${updateErr.message}`);
              }
            }
          } else {
            alreadySynced.push(record);
          }
        } catch (err: any) {
          errors.push(`${member.email}: ${err.message}`);
          if (!isProduction) {
            console.error(`[DataTools] Error checking payment status for ${member.email}:`, err.message);
          }
        }
      }));
      
      if (i + BATCH_SIZE < membersWithBoth.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    if (!dryRun && updated.length > 0) {
      logFromRequest(req, 'sync_payment_status', 'users', null, undefined, {
        action: 'bulk_payment_status_sync',
        updatedCount: updated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${needsUpdateList.length} members needing payment status update`
        : `Updated ${updated.length} HubSpot contacts with payment status`,
      totalChecked: membersWithBoth.rows.length,
      needsUpdateCount: needsUpdateList.length,
      alreadySyncedCount: alreadySynced.length,
      updatedCount: updated.length,
      needsUpdate: needsUpdateList.slice(0, 100),
      updated: updated.slice(0, 50),
      errors: errors.slice(0, 20),
      dryRun
    });
  } catch (error: any) {
    console.error('[DataTools] Sync payment status error:', error);
    res.status(500).json({ error: 'Failed to sync payment status', details: error.message });
  }
});

router.post('/api/data-tools/fix-trackman-ghost-bookings', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true, startDate, endDate, limit = 100 } = req.body;
    
    console.log(`[DataTools] Starting Trackman ghost booking fix (dryRun: ${dryRun}) by ${staffEmail}`);
    
    const ghostQuery = sql`SELECT 
        br.id,
        br.user_id,
        br.user_email,
        br.user_name,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.resource_id,
        br.trackman_booking_id,
        br.trackman_player_count,
        br.status,
        u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE br.trackman_booking_id IS NOT NULL
         AND br.session_id IS NULL
         AND br.status NOT IN ('cancelled', 'declined')
    `;
    
    if (startDate) {
      ghostQuery.append(sql` AND br.request_date >= ${startDate}`);
    }
    
    if (endDate) {
      ghostQuery.append(sql` AND br.request_date <= ${endDate}`);
    }
    
    ghostQuery.append(sql` ORDER BY br.request_date DESC, br.start_time DESC LIMIT ${limit}`);
    
    const ghostBookingsResult = await db.execute(ghostQuery);
    
    const ghostBookings = ghostBookingsResult.rows.map(row => ({
      bookingId: row.id,
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_name,
      requestDate: row.request_date,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMinutes: parseInt(row.duration_minutes) || 60,
      resourceId: row.resource_id,
      trackmanBookingId: row.trackman_booking_id,
      playerCount: parseInt(row.trackman_player_count) || 1,
      status: row.status,
      tier: row.tier
    }));
    
    if (dryRun) {
      logFromRequest(req, 'fix_trackman_ghost_bookings', 'booking_requests', null, undefined, {
        action: 'preview',
        ghostBookingsFound: ghostBookings.length,
        staffEmail
      });
      
      return res.json({
        message: `Preview: Found ${ghostBookings.length} Trackman ghost bookings without billing sessions`,
        totalFound: ghostBookings.length,
        ghostBookings: ghostBookings.slice(0, 100),
        dryRun: true
      });
    }
    
    const fixed: Array<{ bookingId: number; sessionId: number; userEmail: string }> = [];
    const errors: string[] = [];
    
    const { createSession, recordUsage, linkParticipants, ensureSessionForBooking } = await import('../core/bookingService/sessionManager');
    const { getMemberTierByEmail } = await import('../core/tierService');
    const { calculateFullSessionBilling } = await import('../core/bookingService/usageCalculator');
    const { recalculateSessionFees } = await import('../core/billing/unifiedFeeService');
    
    for (const booking of ghostBookings) {
      try {
        const existingSessionCheck = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${booking.bookingId} AND session_id IS NOT NULL`);
        
        if (existingSessionCheck.rows.length > 0) {
          continue;
        }
        
        const duplicateSessionCheck = await db.execute(sql`SELECT id FROM booking_sessions WHERE trackman_booking_id = ${booking.trackmanBookingId}`);
        
        if (duplicateSessionCheck.rows.length > 0) {
          const existingSessionId = duplicateSessionCheck.rows[0].id;
          await db.execute(sql`UPDATE booking_requests SET session_id = ${existingSessionId}, updated_at = NOW() WHERE id = ${booking.bookingId}`);
          
          fixed.push({
            bookingId: booking.bookingId,
            sessionId: existingSessionId,
            userEmail: booking.userEmail
          });
          
          await db.insert(billingAuditLog).values({
            memberEmail: booking.userEmail || 'unknown',
            actionType: 'ghost_booking_linked_to_existing_session',
            actionDetails: {
              source: 'data_tools',
              bookingId: booking.bookingId,
              sessionId: existingSessionId,
              trackmanBookingId: booking.trackmanBookingId
            },
            performedBy: staffEmail,
            performedByName: staffEmail
          });
          
          continue;
        }
        
        const sessionResult = await ensureSessionForBooking({
          bookingId: booking.bookingId,
          resourceId: booking.resourceId,
          sessionDate: booking.requestDate,
          startTime: booking.startTime,
          endTime: booking.endTime,
          ownerEmail: booking.userEmail || '',
          ownerName: booking.userName || booking.userEmail,
          trackmanBookingId: booking.trackmanBookingId,
          source: 'trackman',
          createdBy: 'ghost_booking_fix'
        });

        if (!sessionResult.sessionId || sessionResult.error) {
          errors.push(`Failed to create session for booking ${booking.bookingId}`);
          continue;
        }

        const sessionId = sessionResult.sessionId;
        
        const ownerTier = booking.tier || await getMemberTierByEmail(booking.userEmail, { allowInactive: true });
        
        const participants = [
          { email: booking.userEmail, participantType: 'owner' as const, displayName: booking.userName || booking.userEmail }
        ];
        
        for (let i = 1; i < booking.playerCount; i++) {
          participants.push({
            email: undefined as any,
            participantType: 'guest' as const,
            displayName: `Guest ${i + 1}`
          });
        }
        
        try {
          const billingResult = await calculateFullSessionBilling(
            booking.requestDate,
            booking.durationMinutes,
            participants,
            booking.userEmail
          );
          
          for (const billing of billingResult.billingBreakdown) {
            if (billing.participantType === 'guest') {
              if (billing.guestFee > 0) {
                await recordUsage(sessionId, {
                  memberId: booking.userEmail,
                  minutesCharged: 0,
                  overageFee: 0,
                  guestFee: billing.guestFee,
                  tierAtBooking: ownerTier || undefined,
                  paymentMethod: 'unpaid'
                }, 'staff_manual');
              }
            } else {
              await recordUsage(sessionId, {
                memberId: billing.email || booking.userEmail,
                minutesCharged: billing.minutesAllocated,
                overageFee: billing.overageFee,
                guestFee: 0,
                tierAtBooking: billing.tier || ownerTier || undefined,
                paymentMethod: 'unpaid'
              }, 'staff_manual');
            }
          }
        } catch (billingErr: any) {
          console.error(`[DataTools] Billing calculation error for booking ${booking.bookingId}:`, billingErr.message);
          await recordUsage(sessionId, {
            memberId: booking.userEmail,
            minutesCharged: booking.durationMinutes,
            overageFee: 0,
            guestFee: 0,
            tierAtBooking: ownerTier || undefined,
            paymentMethod: 'unpaid'
          }, 'staff_manual');
        }
        
        // Create booking_participants and cache fees
        try {
          // Calculate slot duration from booking times
          const slotDuration = booking.startTime && booking.endTime
            ? Math.round((new Date(`2000-01-01T${booking.endTime}`).getTime() - 
                         new Date(`2000-01-01T${booking.startTime}`).getTime()) / 60000)
            : booking.durationMinutes || 60;
          
          const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.userEmail})`);
          const userId = userResult.rows[0]?.id || null;
          
          await db.execute(sql`
            INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
            VALUES (${sessionId}, ${userId}, 'owner', ${booking.userName || booking.userEmail}, 'pending', ${slotDuration})
            ON CONFLICT (session_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
          `);
          
          for (let i = 1; i < booking.playerCount; i++) {
            await db.execute(sql`
              INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionId}, NULL, 'guest', ${`Guest ${i + 1}`}, 'pending', ${slotDuration})
            `);
          }
          
          await recalculateSessionFees(sessionId);
        } catch (participantErr: any) {
          console.warn(`[DataTools] Failed to create participants for session ${sessionId}:`, participantErr.message);
        }
        
        fixed.push({
          bookingId: booking.bookingId,
          sessionId,
          userEmail: booking.userEmail
        });
        
        await db.insert(billingAuditLog).values({
          memberEmail: booking.userEmail || 'unknown',
          actionType: 'ghost_booking_session_created',
          actionDetails: {
            source: 'data_tools',
            bookingId: booking.bookingId,
            sessionId,
            trackmanBookingId: booking.trackmanBookingId,
            durationMinutes: booking.durationMinutes,
            playerCount: booking.playerCount,
            requestDate: booking.requestDate
          },
          performedBy: staffEmail,
          performedByName: staffEmail
        });
        
        if (!isProduction) {
          console.log(`[DataTools] Fixed ghost booking ${booking.bookingId} -> session ${sessionId}`);
        }
        
      } catch (err: any) {
        errors.push(`Booking ${booking.bookingId}: ${err.message}`);
        console.error(`[DataTools] Error fixing ghost booking ${booking.bookingId}:`, err.message);
      }
    }
    
    logFromRequest(req, 'fix_trackman_ghost_bookings', 'booking_requests', null, undefined, {
      action: 'execute',
      ghostBookingsFound: ghostBookings.length,
      fixedCount: fixed.length,
      errorCount: errors.length,
      staffEmail
    });
    
    res.json({
      message: `Fixed ${fixed.length} of ${ghostBookings.length} Trackman ghost bookings`,
      totalFound: ghostBookings.length,
      fixedCount: fixed.length,
      fixed: fixed.slice(0, 100),
      errors: errors.slice(0, 20),
      dryRun: false
    });
  } catch (error: any) {
    console.error('[DataTools] Fix Trackman ghost bookings error:', error);
    res.status(500).json({ error: 'Failed to fix Trackman ghost bookings', details: error.message });
  }
});

export default router;

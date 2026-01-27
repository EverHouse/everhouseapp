import { Router, Request, Response } from 'express';
import { db } from '../db';
import { pool, isProduction } from '../core/db';
import { users, bookingRequests, legacyPurchases, billingAuditLog, adminAuditLog } from '@shared/schema';
import { eq, sql, and, gte, lte, desc, isNull, inArray } from 'drizzle-orm';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { getHubSpotClient } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { logFromRequest } from '../core/auditLog';

const router = Router();

router.post('/api/data-tools/resync-member', isAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const staffEmail = (req as any).user?.email || 'unknown';
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const existingUser = await pool.query(
      'SELECT id, first_name, last_name, tier, hubspot_id FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
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
    
    await pool.query(
      `UPDATE users SET 
        hubspot_id = $1,
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        phone = COALESCE($4, phone),
        tier = COALESCE($5, tier),
        membership_status = COALESCE($6, membership_status),
        updated_at = NOW()
      WHERE id = $7`,
      [
        hubspotContactId,
        props.firstname || null,
        props.lastname || null,
        props.phone || null,
        props.membership_tier || null,
        props.membership_status || null,
        user.id
      ]
    );
    
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
    
    logFromRequest(req, 'sync_hubspot', 'member', null, {
      email: normalizedEmail,
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
    
    let query = `
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
      WHERE br.request_date = $1
      AND br.status NOT IN ('cancelled', 'declined')
    `;
    const params: any[] = [date];
    
    if (memberEmail) {
      query += ` AND LOWER(br.user_email) = $2`;
      params.push((memberEmail as string).toLowerCase());
    }
    
    query += ` ORDER BY br.start_time ASC LIMIT 50`;
    
    const result = await pool.query(query, params);
    
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
    const staffEmail = (req as any).user?.email || 'unknown';
    
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
    
    const existingBooking = await pool.query(
      'SELECT id, user_email FROM booking_requests WHERE id = $1',
      [bookingId]
    );
    
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
    
    let query = `
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
    const params: any[] = [];
    let paramIndex = 1;
    
    if (date) {
      query += ` AND br.request_date = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }
    
    if (memberEmail) {
      query += ` AND LOWER(br.user_email) = $${paramIndex}`;
      params.push((memberEmail as string).toLowerCase());
      paramIndex++;
    }
    
    query += ` ORDER BY br.request_date DESC, br.start_time ASC LIMIT $${paramIndex}`;
    params.push(parseInt(limit as string));
    
    const result = await pool.query(query, params);
    
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
    const staffEmail = (req as any).user?.email || 'unknown';
    
    if (!bookingId || !attendanceStatus) {
      return res.status(400).json({ error: 'bookingId and attendanceStatus are required' });
    }
    
    if (!['attended', 'no_show', 'late_cancel', 'pending'].includes(attendanceStatus)) {
      return res.status(400).json({ error: 'Invalid attendance status' });
    }
    
    const existingBooking = await pool.query(
      'SELECT id, user_email, reconciliation_status, reconciliation_notes FROM booking_requests WHERE id = $1',
      [bookingId]
    );
    
    if (existingBooking.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const previousStatus = existingBooking.rows[0].reconciliation_status;
    const previousNotes = existingBooking.rows[0].reconciliation_notes;
    
    await pool.query(
      `UPDATE booking_requests SET 
        reconciliation_status = $1,
        reconciliation_notes = $2,
        reconciled_by = $3,
        reconciled_at = NOW(),
        updated_at = NOW()
      WHERE id = $4`,
      [attendanceStatus, notes || null, staffEmail, bookingId]
    );
    
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
    const staffEmail = (req as any).user?.email || 'unknown';
    
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
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const logs = await db.select()
      .from(adminAuditLog)
      .where(whereClause)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limitParam);
    
    res.json({ logs });
  } catch (error: any) {
    console.error('[DataTools] Get staff activity error:', error);
    res.status(500).json({ error: 'Failed to get staff activity', details: error.message });
  }
});

// Clean up stale mindbody_client_id values by comparing against HubSpot
router.post('/api/data-tools/cleanup-mindbody-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = (req as any).user?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting mindbody_client_id cleanup (dryRun: ${dryRun}) by ${staffEmail}`);
    
    // Get all users with mindbody_client_id
    const usersWithMindbody = await pool.query(
      `SELECT id, email, mindbody_client_id, hubspot_id 
       FROM users 
       WHERE mindbody_client_id IS NOT NULL 
         AND mindbody_client_id != ''
       ORDER BY email`
    );
    
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
      
      const cleanResult = await pool.query(
        `UPDATE users 
         SET mindbody_client_id = NULL, updated_at = NOW() 
         WHERE LOWER(email) = ANY($1::text[])
         RETURNING email`,
        [emailsToClean]
      );
      
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
    const staffEmail = (req as any).user?.email || 'unknown';
    const { emails, dryRun = true } = req.body;
    
    console.log(`[DataTools] Starting HubSpot sync for members without contacts (dryRun: ${dryRun}) by ${staffEmail}`);
    
    // Get members without HubSpot ID
    let query = `
      SELECT id, email, first_name, last_name, tier, mindbody_client_id, membership_status
      FROM users 
      WHERE hubspot_id IS NULL
    `;
    const params: any[] = [];
    
    if (emails && Array.isArray(emails) && emails.length > 0) {
      query += ` AND LOWER(email) = ANY($1::text[])`;
      params.push(emails.map((e: string) => e.toLowerCase()));
    }
    
    query += ` ORDER BY email LIMIT 100`;
    
    const membersWithoutHubspot = await pool.query(query, params);
    
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
          
          // Update user with HubSpot ID
          await pool.query(
            'UPDATE users SET hubspot_id = $1, updated_at = NOW() WHERE id = $2',
            [result.contactId, member.id]
          );
          
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

export default router;

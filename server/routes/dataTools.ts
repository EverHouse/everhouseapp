import { logger } from '../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { isProduction } from '../core/db';
import { users, bookingRequests, legacyPurchases, adminAuditLog } from '@shared/schema';
import { eq, sql, and, gte, lte, desc, isNull, inArray } from 'drizzle-orm';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { getHubSpotClient } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { logFromRequest, logBillingAudit } from '../core/auditLog';
import { getSessionUser } from '../types/session';
import { broadcastToStaff } from '../core/websocket';
import { getErrorMessage, getErrorCode, getErrorStatusCode, safeErrorDetail } from '../utils/errorUtils';
import { getTodayPacific } from '../utils/dateUtils';
import { getStripeClient } from '../core/stripe/client';
import { syncCustomerMetadataToStripe } from '../core/stripe/customers';
import { bulkPushToHubSpot } from '../core/dataIntegrity';
import { normalizeTierName } from '@shared/constants/tiers';
import Stripe from 'stripe';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';

interface DbUserRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  tier: string | null;
  hubspot_id: string | null;
  stripe_customer_id: string | null;
  membership_status: string | null;
  mindbody_client_id: string | null;
  role: string;
  billing_provider: string | null;
}

interface DbBookingSearchRow {
  id: number;
  user_email: string;
  user_name: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  status: string;
  resource_name: string | null;
  reconciliation_status: string | null;
  reconciliation_notes: string | null;
  reconciled_by: string | null;
  reconciled_at: string | null;
}

interface DbCountRow {
  count: string;
}

interface DbDuplicateRow {
  normalized_email: string;
  count: string;
  user_ids: string[];
  emails: string[];
  names: string[];
  hubspot_ids: (string | null)[];
}

interface DbGhostBookingRow {
  id: number;
  user_id: number | null;
  user_email: string;
  user_name: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: string;
  resource_id: number;
  trackman_booking_id: string;
  trackman_player_count: string;
  status: string;
  tier: string | null;
}

interface StripeCleanupJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  dryRun: boolean;
  startedAt: Date;
  completedAt?: Date;
  progress: {
    phase: 'fetching' | 'checking' | 'deleting' | 'done';
    totalCustomers: number;
    checked: number;
    emptyFound: number;
    skippedActiveCount: number;
    deleted: number;
    errors: number;
  };
  result?: Record<string, unknown>;
  error?: string;
}

let activeCleanupJob: StripeCleanupJob | null = null;

interface VisitorArchiveJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  dryRun: boolean;
  startedAt: Date;
  completedAt?: Date;
  progress: {
    phase: 'scanning' | 'checking_stripe' | 'archiving' | 'done';
    totalVisitors: number;
    checked: number;
    eligibleCount: number;
    keptCount: number;
    archived: number;
    errors: number;
  };
  result?: Record<string, unknown>;
  error?: string;
}

let activeVisitorArchiveJob: VisitorArchiveJob | null = null;

const router = Router();

router.post('/api/data-tools/resync-member', isAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const existingUser = await db.execute(sql`SELECT id, first_name, last_name, tier, hubspot_id FROM users WHERE LOWER(email) = ${normalizedEmail}`);
    
    if (existingUser.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in database' });
    }
    
    const user = existingUser.rows[0] as unknown as DbUserRow;
    let hubspotContactId = user.hubspot_id;
    
    const hubspot = await getHubSpotClient();
    
    if (!hubspotContactId) {
      const searchResponse = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: FilterOperatorEnum.Eq,
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
    
    let contactResponse;
    try {
      contactResponse = await retryableHubSpotRequest(() =>
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
    } catch (getByIdError: unknown) {
      const statusCode = getErrorStatusCode(getByIdError);
      if (statusCode === 404) {
        const searchResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{
                propertyName: 'email',
                operator: FilterOperatorEnum.Eq,
                value: normalizedEmail
              }]
            }],
            properties: ['email', 'firstname', 'lastname', 'phone', 'membership_tier', 'membership_status', 'lifecyclestage'],
            limit: 1
          })
        );

        if (!searchResponse.results || searchResponse.results.length === 0) {
          return res.status(404).json({
            error: 'Contact not found in HubSpot. The stored HubSpot ID may be stale (contact was deleted or merged in HubSpot).',
            staleHubspotId: hubspotContactId
          });
        }

        hubspotContactId = searchResponse.results[0].id;
        contactResponse = searchResponse.results[0];

        await db.execute(sql`UPDATE users SET hubspot_id = ${hubspotContactId}, updated_at = NOW() WHERE id = ${user.id}`);
      } else {
        throw getByIdError;
      }
    }
    
    const props = contactResponse.properties;
    
    const updateData: Record<string, unknown> = {
      hubspotId: hubspotContactId,
      updatedAt: new Date()
    };
    
    if (props.firstname) updateData.firstName = props.firstname;
    if (props.lastname) updateData.lastName = props.lastname;
    if (props.phone) updateData.phone = props.phone;
    const normalizedTier = props.membership_tier ? normalizeTierName(props.membership_tier) : null;
    if (normalizedTier) updateData.tier = normalizedTier;
    if (props.membership_status) updateData.membershipStatus = props.membership_status;
    
    await db.execute(sql`UPDATE users SET 
        hubspot_id = ${hubspotContactId},
        first_name = COALESCE(${props.firstname || null}, first_name),
        last_name = COALESCE(${props.lastname || null}, last_name),
        phone = COALESCE(${props.phone || null}, phone),
        tier = COALESCE(${normalizedTier}, tier),
        membership_status = COALESCE(${props.membership_status || null}, membership_status),
        updated_at = NOW()
      WHERE id = ${user.id}`);
    
    syncCustomerMetadataToStripe(normalizedEmail).catch((err) => {
      logger.error('[DataTools] Background Stripe sync after HubSpot resync failed:', { error: err });
    });
    
    await logBillingAudit({
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
      logger.info('[DataTools] Re-synced member from HubSpot by', { extra: { normalizedEmail, staffEmail } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Resync member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to resync member', details: safeErrorDetail(error) });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Get unlinked guest fees error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get unlinked guest fees', details: safeErrorDetail(error) });
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
      AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
    `;
    
    if (memberEmail) {
      queryBuilder.append(sql` AND LOWER(br.user_email) = ${(memberEmail as string).trim().toLowerCase()}`);
    }
    
    queryBuilder.append(sql` ORDER BY br.start_time ASC LIMIT 50`);
    
    const result = await db.execute(queryBuilder);
    
    res.json(result.rows.map((row) => {
      const r = row as unknown as DbBookingSearchRow;
      return {
        id: r.id,
        userEmail: r.user_email,
        userName: r.user_name,
        requestDate: r.request_date,
        startTime: r.start_time,
        endTime: r.end_time,
        status: r.status,
        resourceName: r.resource_name
      };
    }));
  } catch (error: unknown) {
    logger.error('[DataTools] Get available sessions error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get available sessions', details: safeErrorDetail(error) });
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
    
    await logBillingAudit({
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
      logger.info('[DataTools] Linked guest fee to booking by', { extra: { guestFeeId, bookingId, staffEmail } });
    }
    
    res.json({
      success: true,
      message: 'Guest fee successfully linked to booking session'
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Link guest fee error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link guest fee', details: safeErrorDetail(error) });
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
      queryBuilder.append(sql` AND LOWER(br.user_email) = ${(memberEmail as string).trim().toLowerCase()}`);
    }
    
    queryBuilder.append(sql` ORDER BY br.request_date DESC, br.start_time ASC LIMIT ${parseInt(limit as string) || 50}`);
    
    const result = await db.execute(queryBuilder);
    
    res.json(result.rows.map((row) => {
      const r = row as unknown as DbBookingSearchRow;
      return {
        id: r.id,
        userEmail: r.user_email,
        userName: r.user_name,
        requestDate: r.request_date,
        startTime: r.start_time,
        endTime: r.end_time,
        status: r.status,
        reconciliationStatus: r.reconciliation_status,
        reconciliationNotes: r.reconciliation_notes,
        reconciledBy: r.reconciled_by,
        reconciledAt: r.reconciled_at,
        resourceName: r.resource_name
      };
    }));
  } catch (error: unknown) {
    logger.error('[DataTools] Bookings search error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to search bookings', details: safeErrorDetail(error) });
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
    
    const bookingRow = existingBooking.rows[0] as Record<string, unknown>;
    const previousStatus = bookingRow.reconciliation_status as string | null;
    const previousNotes = bookingRow.reconciliation_notes as string | null;
    
    await db.execute(sql`UPDATE booking_requests SET 
        reconciliation_status = ${attendanceStatus},
        reconciliation_notes = ${notes || null},
        reconciled_by = ${staffEmail},
        reconciled_at = NOW(),
        updated_at = NOW()
      WHERE id = ${bookingId}`);
    
    await logBillingAudit({
      memberEmail: (bookingRow.user_email as string) || 'unknown',
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
      logger.info('[DataTools] Updated attendance for booking to by', { extra: { bookingId, attendanceStatus, staffEmail } });
    }
    
    res.json({
      success: true,
      message: `Attendance status updated to ${attendanceStatus}`
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Update attendance error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update attendance', details: safeErrorDetail(error) });
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
    
    await logBillingAudit({
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
      logger.info('[DataTools] Mindbody reimport requested for to by', { extra: { startDate, endDate, staffEmail } });
    }
    
    res.json({
      success: true,
      message: `Mindbody re-import has been queued for ${startDate} to ${endDate}. The process will run in the background.`,
      note: 'This feature requires manual file upload. Please use the legacy purchases import with updated CSV files for the date range.'
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Mindbody reimport error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to queue mindbody reimport', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/audit-log', isAdmin, async (req: Request, res: Response) => {
  try {
    const { limit = '20', actionType } = req.query;
    
    const logs = actionType
      ? await db.select()
          .from(adminAuditLog)
          .where(and(eq(adminAuditLog.resourceType, 'billing'), eq(adminAuditLog.action, actionType as string)))
          .orderBy(desc(adminAuditLog.createdAt))
          .limit(parseInt(limit as string))
      : await db.select()
          .from(adminAuditLog)
          .where(eq(adminAuditLog.resourceType, 'billing'))
          .orderBy(desc(adminAuditLog.createdAt))
          .limit(parseInt(limit as string));
    
    res.json(logs.filter(log => 
      ['member_resynced_from_hubspot', 'guest_fee_manually_linked', 'attendance_manually_updated', 'mindbody_reimport_requested'].includes(log.action)
    ));
  } catch (error: unknown) {
    logger.error('[DataTools] Get audit log error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get audit log', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/staff-activity', isAdmin, async (req: Request, res: Response) => {
  try {
    const limitParam = parseInt(req.query.limit as string) || 50;
    const staffEmail = (req.query.staff_email as string)?.trim()?.toLowerCase();
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
        ? (() => { try { return JSON.parse(log.details); } catch (err) { logger.debug('Failed to parse log details as JSON'); return log.details; } })()
        : log.details
    }));
    
    res.json({ logs: parsedLogs });
  } catch (error: unknown) {
    logger.error('[DataTools] Get staff activity error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get staff activity', details: safeErrorDetail(error) });
  }
});

// Clean up stale mindbody_client_id values by comparing against HubSpot
router.post('/api/data-tools/cleanup-mindbody-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting mindbody_client_id cleanup (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
      const batch = usersWithMindbody.rows.slice(i, i + batchSize) as unknown as DbUserRow[];
      
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
                    operator: FilterOperatorEnum.Eq,
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
            logger.info('[DataTools] Mindbody ID mismatch for : DB=, HubSpot=', { extra: { userEmail: user.email, userMindbody_client_id: user.mindbody_client_id, hubspotMindbodyId } });
          }
        } catch (err: unknown) {
          errors.push(`Error checking ${user.email}: ${getErrorMessage(err)}`);
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
      
      logger.info('[DataTools] Cleaned stale mindbody_client_id values', { extra: { cleanedCount } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Cleanup mindbody IDs error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup mindbody IDs', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/bulk-push-to-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const { dryRun = true } = req.body;
    const result = await bulkPushToHubSpot(dryRun);
    if (!dryRun) {
      logFromRequest(req, 'bulk_action', 'member', null, 'bulk-hubspot-push', {
        totalChecked: result.totalChecked,
        totalMismatched: result.totalMismatched,
        totalSynced: result.totalSynced
      });
    }
    res.json(result);
  } catch (error: unknown) {
    logger.error('[DataTools] Bulk push to HubSpot error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to bulk push to HubSpot', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-members-to-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { emails: rawEmails, dryRun = true } = req.body;
    const emails = Array.isArray(rawEmails) ? rawEmails.map((e: string) => e?.trim()?.toLowerCase()).filter(Boolean) : rawEmails;
    
    logger.info('[DataTools] Starting HubSpot sync for members without contacts (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    // Get members without HubSpot ID
    const queryBuilder = sql`
      SELECT id, email, first_name, last_name, tier, mindbody_client_id, membership_status, role
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
      for (const member of membersWithoutHubspot.rows as unknown as DbUserRow[]) {
        try {
          const result = await findOrCreateHubSpotContact(
            member.email,
            member.first_name || '',
            member.last_name || '',
            undefined,
            member.tier || undefined,
            { role: member.role }
          );
          
          await db.execute(sql`UPDATE users SET hubspot_id = ${result.contactId}, updated_at = NOW() WHERE id = ${member.id}`);
          
          if (result.isNew) {
            created.push({ email: member.email, contactId: result.contactId });
          } else {
            existing.push({ email: member.email, contactId: result.contactId });
          }
          
          logger.info('[DataTools] HubSpot contact for', { extra: { resultIsNew_Created_Found_existing: result.isNew ? 'Created' : 'Found existing', memberEmail: member.email, resultContactId: result.contactId } });
          
          // Small delay between API calls
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: unknown) {
          logger.error('[DataTools] Error syncing  to HubSpot', { extra: { email: member.email, err } });
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
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
      members: (membersWithoutHubspot.rows as unknown as DbUserRow[]).map((m) => ({
        email: m.email,
        name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        tier: m.tier,
        mindbodyClientId: m.mindbody_client_id
      })),
      created: created.length,
      existing: existing.length,
      errors: errors.slice(0, 10)
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Sync members to HubSpot error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync members to HubSpot', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-subscription-status', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting subscription status sync (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
      const batch = membersWithStripe.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (member) => {
        try {
          const customerId = member.stripe_customer_id;
          if (!customerId) return;
          
          const customerSubs = await stripe.subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 10
          });
          
          const activeSub = customerSubs.data?.find((s: Stripe.Subscription) => 
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
                 SET membership_status = ${expectedAppStatus}, billing_provider = 'stripe', updated_at = NOW() 
                 WHERE id = ${member.id}`);
              
              // Sync status change to HubSpot
              try {
                const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
                await syncMemberToHubSpot({ email: member.email, status: expectedAppStatus, billingProvider: 'stripe' });
              } catch (e: unknown) {
                logger.warn('[DataTools] Failed to sync status to HubSpot for', { extra: { email: member.email, e_as_any_e: (e as Error)?.message || e } });
              }
              
              await logBillingAudit({
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
                logger.info('[DataTools] Updated status: ->', { extra: { memberEmail: member.email, memberMembership_status: member.membership_status, expectedAppStatus } });
              }
            }
          }
        } catch (err: unknown) {
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
          if (!isProduction) {
            logger.error('[DataTools] Error checking subscription for', { extra: { email: member.email, error: getErrorMessage(err) } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Sync subscription status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync subscription status', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/clear-orphaned-stripe-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Clearing orphaned Stripe customer IDs (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
      const batch = usersWithStripe.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (user) => {
        try {
          const customerId = user.stripe_customer_id;
          if (!customerId) return;
          
          try {
            await stripe.customers.retrieve(customerId);
          } catch (err: unknown) {
            const isNotFound = getErrorCode(err) === 'resource_missing' || 
              getErrorStatusCode(err) === 404 || 
              getErrorMessage(err)?.includes('No such customer');
            
            if (isNotFound) {
              const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
              orphaned.push({
                email: user.email as string,
                name: userName,
                stripeCustomerId: customerId as string,
                userId: user.id as unknown as string,
                role: user.role as string
              });
              
              if (!dryRun) {
                await db.execute(sql`UPDATE users SET stripe_customer_id = NULL, updated_at = NOW() WHERE id = ${user.id}`);
                
                cleared.push({
                  email: user.email,
                  stripeCustomerId: customerId
                });
                
                logger.info('[DataTools] Cleared orphaned Stripe ID for', { extra: { userEmail: user.email, customerId } });
              }
            }
          }
        } catch (err: unknown) {
          errors.push(`${user.email}: ${getErrorMessage(err)}`);
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
  } catch (error: unknown) {
    logger.error('[DataTools] Clear orphaned Stripe IDs error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to clear orphaned Stripe IDs', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/link-stripe-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting Stripe-HubSpot link tool (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
    
    const stripeOnlyList = (stripeOnlyMembers.rows as unknown as DbUserRow[]).map((m) => ({
      id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unknown',
      tier: m.tier,
      stripeCustomerId: m.stripe_customer_id,
      issue: 'has_stripe_no_hubspot'
    }));
    
    const hubspotOnlyList = (hubspotOnlyMembers.rows as unknown as DbUserRow[]).map((m) => ({
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
      for (const member of stripeOnlyMembers.rows as unknown as DbUserRow[]) {
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
          
          await logBillingAudit({
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
            logger.info('[DataTools] Created HubSpot contact for', { extra: { memberEmail: member.email, resultContactId: result.contactId } });
          }
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: unknown) {
          errors.push(`HubSpot for ${member.email}: ${getErrorMessage(err)}`);
          logger.error('[DataTools] Error creating HubSpot contact for', { extra: { email: member.email, error: getErrorMessage(err) } });
        }
      }
      
      for (const member of hubspotOnlyMembers.rows as unknown as DbUserRow[]) {
        try {
          const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
          const result = await getOrCreateStripeCustomer(
            member.id.toString(),
            member.email,
            memberName,
            member.tier
          );
          
          stripeCreated.push({ email: member.email, customerId: result.customerId });
          
          await logBillingAudit({
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
            logger.info('[DataTools] Created Stripe customer for', { extra: { memberEmail: member.email, resultCustomerId: result.customerId } });
          }
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: unknown) {
          errors.push(`Stripe for ${member.email}: ${getErrorMessage(err)}`);
          logger.error('[DataTools] Error creating Stripe customer for', { extra: { email: member.email, error: getErrorMessage(err) } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Link Stripe-HubSpot error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link Stripe-HubSpot', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-visit-counts', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting visit count sync to HubSpot (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
      const batch = membersWithHubspot.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (member) => {
        try {
          const normalizedEmail = member.email.toLowerCase();
          
          const visitCountResult = await db.execute(sql`
            SELECT COUNT(DISTINCT booking_id) as count FROM (
              SELECT id as booking_id FROM booking_requests
              WHERE LOWER(user_email) = ${normalizedEmail}
                AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
                AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
              UNION
              SELECT br.id as booking_id FROM booking_requests br
              JOIN booking_participants bp ON bp.session_id = br.session_id
              JOIN users u ON bp.user_id = u.id
              WHERE LOWER(u.email) = ${normalizedEmail}
                AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
                AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
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
          
          const bookingCount = parseInt((visitCountResult.rows[0] as unknown as DbCountRow)?.count || '0');
          const eventCount = parseInt((eventCountResult.rows[0] as unknown as DbCountRow)?.count || '0');
          const wellnessCount = parseInt((wellnessCountResult.rows[0] as unknown as DbCountRow)?.count || '0');
          const appVisitCount = bookingCount + eventCount + wellnessCount;
          
          let hubspotVisitCount: number | null = null;
          try {
            const contact = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(member.hubspot_id, ['total_visit_count'])
            );
            const rawCount = contact.properties?.total_visit_count;
            hubspotVisitCount = rawCount ? parseInt(rawCount) : null;
          } catch (hubspotErr: unknown) {
            if (!getErrorMessage(hubspotErr)?.includes('404')) {
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
                
                await logBillingAudit({
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
                  logger.info('[DataTools] Updated HubSpot visit count for : ->', { extra: { memberEmail: member.email, hubspotVisitCount, appVisitCount } });
                }
              } catch (updateErr: unknown) {
                errors.push(`Update ${member.email}: ${getErrorMessage(updateErr)}`);
              }
            }
          } else {
            matched.push(record);
          }
        } catch (err: unknown) {
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
          if (!isProduction) {
            logger.error('[DataTools] Error checking visit count for', { extra: { email: member.email, error: getErrorMessage(err) } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Sync visit counts error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync visit counts', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/detect-duplicates', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    logFromRequest(req, 'detect_duplicates', 'users', null, undefined, {
      action: 'started',
      staffEmail
    });
    
    logger.info('[DataTools] Starting duplicate detection by', { extra: { staffEmail } });
    
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
    `);
    
    const appDuplicates = (appDuplicatesResult.rows as unknown as DbDuplicateRow[]).map((row) => ({
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
         AND archived_at IS NULL`);
    
    const BATCH_SIZE = 25;
    const BATCH_DELAY_MS = 50;
    
    for (let i = 0; i < membersWithHubspot.rows.length; i += BATCH_SIZE) {
      const batch = membersWithHubspot.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (member) => {
        try {
          const searchResponse = await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.searchApi.doSearch({
              filterGroups: [{
                filters: [{
                  propertyName: 'email',
                  operator: FilterOperatorEnum.Eq,
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
              contacts: searchResponse.results.map((contact) => ({
                contactId: contact.id,
                firstname: contact.properties?.firstname || '',
                lastname: contact.properties?.lastname || '',
                createdate: contact.properties?.createdate || ''
              }))
            });
          }
        } catch (err: unknown) {
          hubspotErrors.push(`${member.email}: ${getErrorMessage(err)}`);
        }
      }));
      
      if (i + BATCH_SIZE < membersWithHubspot.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    await logBillingAudit({
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
  } catch (error: unknown) {
    logger.error('[DataTools] Detect duplicates error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to detect duplicates', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-payment-status', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting payment status sync to HubSpot (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
      const batch = membersWithBoth.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (member) => {
        try {
          const invoices = await stripe.invoices.list({
            customer: member.stripe_customer_id!,
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
              customer: member.stripe_customer_id as string,
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
          } catch (hubspotErr: unknown) {
            if (!getErrorMessage(hubspotErr)?.includes('404')) {
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
                
                await logBillingAudit({
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
                  logger.info('[DataTools] Updated HubSpot payment status for : ->', { extra: { memberEmail: member.email, hubspotPaymentStatus, stripePaymentStatus } });
                }
              } catch (updateErr: unknown) {
                errors.push(`Update ${member.email}: ${getErrorMessage(updateErr)}`);
              }
            }
          } else {
            alreadySynced.push(record);
          }
        } catch (err: unknown) {
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
          if (!isProduction) {
            logger.error('[DataTools] Error checking payment status for', { extra: { email: member.email, error: getErrorMessage(err) } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Sync payment status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync payment status', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/fix-trackman-ghost-bookings', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true, startDate, endDate, limit = 100 } = req.body;
    
    logger.info('[DataTools] Starting Trackman ghost booking fix (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
         AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
    `;
    
    if (startDate) {
      ghostQuery.append(sql` AND br.request_date >= ${startDate}`);
    }
    
    if (endDate) {
      ghostQuery.append(sql` AND br.request_date <= ${endDate}`);
    }
    
    ghostQuery.append(sql` ORDER BY br.request_date DESC, br.start_time DESC LIMIT ${limit}`);
    
    const ghostBookingsResult = await db.execute(ghostQuery);
    
    const ghostBookings = (ghostBookingsResult.rows as unknown as DbGhostBookingRow[]).map((row) => ({
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
          const existingSessionId = (duplicateSessionCheck.rows[0] as Record<string, unknown>).id as number;
          await db.execute(sql`UPDATE booking_requests SET session_id = ${existingSessionId}, updated_at = NOW() WHERE id = ${booking.bookingId}`);
          
          fixed.push({
            bookingId: booking.bookingId,
            sessionId: existingSessionId,
            userEmail: booking.userEmail
          });
          
          await logBillingAudit({
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
          source: 'trackman_import',
          createdBy: 'ghost_booking_fix'
        });

        if (!sessionResult.sessionId || sessionResult.error) {
          errors.push(`Failed to create session for booking ${booking.bookingId}`);
          continue;
        }

        const sessionId = sessionResult.sessionId;
        
        const ownerTier = booking.tier || await getMemberTierByEmail(booking.userEmail, { allowInactive: true });
        
        const resourceResult = await db.execute(sql`SELECT type FROM resources WHERE id = ${booking.resourceId}`);
        const resourceType = (resourceResult.rows[0] as Record<string, unknown>)?.type as string || 'simulator';
        
        const participants = [
          { email: booking.userEmail, participantType: 'owner' as const, displayName: booking.userName || booking.userEmail }
        ];
        
        for (let i = 1; i < booking.playerCount; i++) {
          participants.push({
            email: undefined as unknown as string,
            participantType: 'guest' as 'owner',
            displayName: `Guest ${i + 1}`
          });
        }
        
        try {
          const billingResult = await calculateFullSessionBilling(
            booking.requestDate,
            booking.durationMinutes,
            participants,
            booking.userEmail,
            booking.playerCount || 1,
            { resourceType }
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
                tierAtBooking: (billing as unknown as Record<string, unknown>).tier as string || ownerTier || undefined,
                paymentMethod: 'unpaid'
              }, 'staff_manual');
            }
          }
        } catch (billingErr: unknown) {
          logger.error('[DataTools] Billing calculation error for booking', { extra: { bookingId: booking.bookingId, error: getErrorMessage(billingErr) } });
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
          const userId = (userResult.rows[0] as Record<string, unknown>)?.id as number || null;
          
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
          
          await recalculateSessionFees(sessionId, 'staff_action');
          
          const todayPacific = getTodayPacific();
          const isPastBooking = booking.requestDate < todayPacific;
          if (isPastBooking) {
            await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid', paid_at = NOW() WHERE session_id = ${sessionId} AND payment_status = 'pending'`);
          }
        } catch (participantErr: unknown) {
          logger.warn('[DataTools] Failed to create participants for session', { extra: { sessionId, error: getErrorMessage(participantErr) } });
        }
        
        fixed.push({
          bookingId: booking.bookingId,
          sessionId,
          userEmail: booking.userEmail
        });
        
        await logBillingAudit({
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
          logger.info('[DataTools] Fixed ghost booking -> session', { extra: { bookingBookingId: booking.bookingId, sessionId } });
        }
        
      } catch (err: unknown) {
        errors.push(`Booking ${booking.bookingId}: ${getErrorMessage(err)}`);
        logger.error('[DataTools] Error fixing ghost booking', { extra: { bookingId: booking.bookingId, error: getErrorMessage(err) } });
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
  } catch (error: unknown) {
    logger.error('[DataTools] Fix Trackman ghost bookings error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fix Trackman ghost bookings', details: safeErrorDetail(error) });
  }
});

async function runCleanupInBackground(dryRun: boolean, staffEmail: string, req: Request) {
  try {
    const { getStripeClient } = await import('../core/stripe/client');
    const stripe = await getStripeClient();
    
    activeCleanupJob!.progress.phase = 'fetching';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
    
    const allCustomers: Array<{ id: string; email: string | null; name: string | null; created: number }> = [];
    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const params: Stripe.CustomerListParams = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      const batch = await stripe.customers.list(params);
      
      for (const cust of batch.data) {
        if (!(cust as Stripe.Customer & { deleted?: boolean }).deleted) {
          allCustomers.push({
            id: cust.id,
            email: cust.email,
            name: cust.name,
            created: cust.created
          });
        }
      }
      
      hasMore = batch.has_more;
      if (batch.data.length > 0) {
        startingAfter = batch.data[batch.data.length - 1].id;
      }
    }
    
    logger.info('[DataTools] Found total Stripe customers', { extra: { allCustomersLength: allCustomers.length } });
    activeCleanupJob!.progress.totalCustomers = allCustomers.length;
    activeCleanupJob!.progress.phase = 'checking';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
    
    const activeUsersResult = await db.execute(sql`
      SELECT stripe_customer_id FROM users 
      WHERE stripe_customer_id IS NOT NULL 
        AND membership_status = 'active'
    `);
    const activeStripeIds = new Set(activeUsersResult.rows.map((r) => (r as Record<string, unknown>).stripe_customer_id as string));
    
    const emptyCustomers: typeof allCustomers = [];
    let skippedActiveCount = 0;
    
    for (const customer of allCustomers) {
      try {
        if (activeStripeIds.has(customer.id)) {
          skippedActiveCount++;
          activeCleanupJob!.progress.skippedActiveCount = skippedActiveCount;
          activeCleanupJob!.progress.checked++;
          if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
          continue;
        }
        
        const charges = await stripe.charges.list({ customer: customer.id, limit: 1 });
        if (charges.data.length > 0) { activeCleanupJob!.progress.checked++; if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress }); continue; }
        
        const subscriptions = await stripe.subscriptions.list({ customer: customer.id, limit: 1, status: 'all' });
        if (subscriptions.data.length > 0) { activeCleanupJob!.progress.checked++; if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress }); continue; }
        
        const invoices = await stripe.invoices.list({ customer: customer.id, limit: 1 });
        if (invoices.data.length > 0) { activeCleanupJob!.progress.checked++; if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress }); continue; }
        
        const paymentIntents = await stripe.paymentIntents.list({ customer: customer.id, limit: 1 });
        if (paymentIntents.data.length > 0) { activeCleanupJob!.progress.checked++; if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress }); continue; }
        
        emptyCustomers.push(customer);
        activeCleanupJob!.progress.emptyFound = emptyCustomers.length;
        activeCleanupJob!.progress.checked++;
        if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
      } catch (err: unknown) {
        logger.error('[DataTools] Error checking customer', { extra: { id: customer.id, error: getErrorMessage(err) } });
        activeCleanupJob!.progress.errors++;
        activeCleanupJob!.progress.checked++;
        if (activeCleanupJob!.progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
      }
      
      if (activeCleanupJob!.progress.checked % 25 === 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
    
    logger.info('[DataTools] Found customers with zero transactions out of total', { extra: { emptyCustomersLength: emptyCustomers.length, allCustomersLength: allCustomers.length } });
    logger.info('[DataTools] Skipping active members with zero transactions (keeping for future charges)', { extra: { skippedActiveCount } });
    
    if (dryRun) {
      logFromRequest(req, 'cleanup_stripe_customers', 'stripe', null, undefined, {
        action: 'preview',
        totalCustomers: allCustomers.length,
        emptyFound: emptyCustomers.length,
        skippedActiveCount,
        staffEmail
      });
      
      const result = {
        success: true,
        dryRun: true,
        message: `Found ${emptyCustomers.length} Stripe customers with zero transactions (out of ${allCustomers.length} total). Skipped ${skippedActiveCount} active members.`,
        totalCustomers: allCustomers.length,
        emptyCount: emptyCustomers.length,
        skippedActiveCount,
        customers: emptyCustomers.map(c => ({
          id: c.id,
          email: c.email,
          name: c.name,
          created: new Date(c.created * 1000).toISOString()
        }))
      };
      
      activeCleanupJob!.status = 'completed';
      activeCleanupJob!.completedAt = new Date();
      activeCleanupJob!.result = result;
      activeCleanupJob!.progress.phase = 'done';
      broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress, result });
      return;
    }
    
    activeCleanupJob!.progress.phase = 'deleting';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
    
    let deleted = 0;
    let errors: string[] = [];
    const deletedList: Array<{ id: string; email: string | null }> = [];
    
    for (const customer of emptyCustomers) {
      try {
        await stripe.customers.del(customer.id);
        
        await db.execute(sql`
          UPDATE users SET stripe_customer_id = NULL, updated_at = NOW()
          WHERE stripe_customer_id = ${customer.id}
        `);
        
        deletedList.push({ id: customer.id, email: customer.email });
        deleted++;
        activeCleanupJob!.progress.deleted = deleted;
        if (deleted % 10 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress });
      } catch (err: unknown) {
        errors.push(`${customer.id} (${customer.email}): ${getErrorMessage(err)}`);
        activeCleanupJob!.progress.errors++;
        logger.error('[DataTools] Failed to delete customer', { extra: { id: customer.id, error: getErrorMessage(err) } });
      }
    }
    
    logFromRequest(req, 'cleanup_stripe_customers', 'stripe', null, undefined, {
      action: 'execute',
      totalCustomers: allCustomers.length,
      emptyFound: emptyCustomers.length,
      skippedActiveCount,
      deleted,
      errorCount: errors.length,
      staffEmail
    });
    
    logger.info('[DataTools] Stripe customer cleanup complete: deleted, errors', { extra: { deleted, errorsLength: errors.length } });
    
    const result = {
      success: true,
      dryRun: false,
      message: `Deleted ${deleted} of ${emptyCustomers.length} empty Stripe customers. Skipped ${skippedActiveCount} active members.`,
      totalCustomers: allCustomers.length,
      emptyCount: emptyCustomers.length,
      skippedActiveCount,
      deleted: deletedList,
      deletedCount: deleted,
      errors: errors.slice(0, 20)
    };
    
    activeCleanupJob!.status = 'completed';
    activeCleanupJob!.completedAt = new Date();
    activeCleanupJob!.result = result;
    activeCleanupJob!.progress.phase = 'done';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress, result });
  } catch (error: unknown) {
    logger.error('[DataTools] Stripe customer cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    activeCleanupJob!.status = 'failed';
    activeCleanupJob!.completedAt = new Date();
    activeCleanupJob!.error = getErrorMessage(error);
    activeCleanupJob!.progress.phase = 'done';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: activeCleanupJob!.progress, error: getErrorMessage(error) });
  }
}

router.post('/api/data-tools/cleanup-stripe-customers', isAdmin, async (req: Request, res: Response) => {
  try {
    if (activeCleanupJob?.status === 'running') {
      return res.status(409).json({ error: 'A cleanup job is already running', jobId: activeCleanupJob.id });
    }
    
    const dryRun = req.body.dryRun !== false;
    const staffEmail = getSessionUser(req)?.email || 'admin';
    
    logger.info('[DataTools] Stripe customer cleanup initiated by (dryRun: )', { extra: { staffEmail, dryRun } });
    
    const jobId = Date.now().toString(36);
    activeCleanupJob = {
      id: jobId,
      status: 'running',
      dryRun,
      startedAt: new Date(),
      progress: {
        phase: 'fetching',
        totalCustomers: 0,
        checked: 0,
        emptyFound: 0,
        skippedActiveCount: 0,
        deleted: 0,
        errors: 0
      }
    };
    
    runCleanupInBackground(dryRun, staffEmail, req);
    
    res.json({ success: true, jobId, message: 'Cleanup job started' });
  } catch (error: unknown) {
    logger.error('[DataTools] Stripe customer cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to start cleanup job', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/cleanup-stripe-customers/status', isAdmin, async (req: Request, res: Response) => {
  if (!activeCleanupJob) {
    return res.json({ hasJob: false });
  }
  res.json({ hasJob: true, job: activeCleanupJob });
});

router.post('/api/data-tools/archive-stale-visitors', isAdmin, async (req: Request, res: Response) => {
  try {
    if (activeVisitorArchiveJob?.status === 'running') {
      return res.status(409).json({ error: 'A visitor archive job is already running', jobId: activeVisitorArchiveJob.id });
    }

    const dryRun = req.body.dryRun !== false;
    const staffEmail = getSessionUser(req)?.email || 'admin';

    logger.info('[DataTools] Visitor archive initiated by (dryRun: )', { extra: { staffEmail, dryRun } });

    const jobId = Date.now().toString(36);
    activeVisitorArchiveJob = {
      id: jobId,
      status: 'running',
      dryRun,
      startedAt: new Date(),
      progress: {
        phase: 'scanning',
        totalVisitors: 0,
        checked: 0,
        eligibleCount: 0,
        keptCount: 0,
        archived: 0,
        errors: 0
      }
    };

    runVisitorArchiveInBackground(dryRun, staffEmail, req);

    res.json({ success: true, jobId, message: 'Archive job started' });
  } catch (error: unknown) {
    logger.error('[DataTools] Visitor archive error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to start archive job', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/archive-stale-visitors/status', isAdmin, async (req: Request, res: Response) => {
  if (!activeVisitorArchiveJob) {
    return res.json({ hasJob: false });
  }
  res.json({ hasJob: true, job: activeVisitorArchiveJob });
});

async function runVisitorArchiveInBackground(dryRun: boolean, staffEmail: string, req: Request) {
  try {
    activeVisitorArchiveJob!.progress.phase = 'scanning';
    broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });

    const candidatesResult = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.stripe_customer_id, u.membership_status
      FROM users u
      WHERE u.membership_status IN ('non-member', 'visitor')
        AND u.archived_at IS NULL
        AND u.role NOT IN ('admin', 'staff', 'golf_instructor')
        AND NOT EXISTS (SELECT 1 FROM staff_users su WHERE LOWER(su.email) = LOWER(u.email) AND su.is_active = true)
        AND NOT EXISTS (SELECT 1 FROM booking_requests br WHERE LOWER(br.user_email) = LOWER(u.email))
        AND NOT EXISTS (SELECT 1 FROM booking_participants bp WHERE bp.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM walk_in_visits w WHERE LOWER(w.member_email) = LOWER(u.email))
        AND NOT EXISTS (SELECT 1 FROM event_rsvps er WHERE LOWER(er.user_email) = LOWER(u.email))
        AND NOT EXISTS (SELECT 1 FROM legacy_purchases lp WHERE LOWER(lp.member_email) = LOWER(u.email))
        AND NOT EXISTS (SELECT 1 FROM day_pass_purchases dp WHERE LOWER(dp.purchaser_email) = LOWER(u.email))
    `);

    const candidates = candidatesResult.rows;
    activeVisitorArchiveJob!.progress.totalVisitors = candidates.length;
    broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });

    logger.info('[DataTools] Found visitor/non-member candidates with no local activity', { extra: { candidatesLength: candidates.length } });

    activeVisitorArchiveJob!.progress.phase = 'checking_stripe';
    broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });

    const visitorsWithStripe = candidates.filter(c => c.stripe_customer_id);
    const visitorsWithoutStripe = candidates.filter(c => !c.stripe_customer_id);

    const eligible: typeof candidates = [...visitorsWithoutStripe];
    let keptCount = 0;

    if (visitorsWithStripe.length > 0) {
      const stripe = await getStripeClient();

      const BATCH_SIZE = 25;
      for (let i = 0; i < visitorsWithStripe.length; i += BATCH_SIZE) {
        const batch = visitorsWithStripe.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (visitor) => {
          try {
            const charges = await stripe.charges.list({ customer: visitor.stripe_customer_id as string, limit: 1 });
            if (charges.data.length > 0) { keptCount++; return; }

            const invoices = await stripe.invoices.list({ customer: visitor.stripe_customer_id as string, limit: 1 });
            if (invoices.data.length > 0) { keptCount++; return; }

            const paymentIntents = await stripe.paymentIntents.list({ customer: visitor.stripe_customer_id as string, limit: 1 });
            if (paymentIntents.data.length > 0) { keptCount++; return; }

            eligible.push(visitor);
          } catch (err: unknown) {
            logger.error('[DataTools] Error checking Stripe transactions for', { extra: { email: visitor.email, error: getErrorMessage(err) } });
            keptCount++;
            activeVisitorArchiveJob!.progress.errors++;
          }
        }));

        activeVisitorArchiveJob!.progress.checked = Math.min(i + BATCH_SIZE, visitorsWithStripe.length);
        activeVisitorArchiveJob!.progress.keptCount = keptCount;
        activeVisitorArchiveJob!.progress.eligibleCount = eligible.length;
        broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });

        if (i + BATCH_SIZE < visitorsWithStripe.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }

    activeVisitorArchiveJob!.progress.eligibleCount = eligible.length;
    activeVisitorArchiveJob!.progress.keptCount = keptCount;
    activeVisitorArchiveJob!.progress.checked = visitorsWithStripe.length;
    broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });

    logger.info('[DataTools] eligible for archive, kept (has Stripe charges)', { extra: { eligibleLength: eligible.length, keptCount } });

    const sampleArchived = eligible.slice(0, 20).map(v => ({
      name: [v.first_name, v.last_name].filter(Boolean).join(' ') || 'Unknown',
      email: v.email
    }));

    let archivedCount = 0;

    if (!dryRun && eligible.length > 0) {
      activeVisitorArchiveJob!.progress.phase = 'archiving';
      broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });

      const ARCHIVE_BATCH_SIZE = 100;
      for (let i = 0; i < eligible.length; i += ARCHIVE_BATCH_SIZE) {
        const batch = eligible.slice(i, i + ARCHIVE_BATCH_SIZE);
        const ids = batch.map(v => v.id);

        try {
          await db.update(users)
            .set({ archivedAt: sql`NOW()`, archivedBy: 'system-cleanup' })
            .where(inArray(users.id, ids as string[]));
          archivedCount += batch.length;
        } catch (err: unknown) {
          logger.error('[DataTools] Error archiving batch ( ids)', { extra: { length: ids.length, error: getErrorMessage(err) } });
          activeVisitorArchiveJob!.progress.errors++;
        }

        activeVisitorArchiveJob!.progress.archived = archivedCount;
        broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress });
      }
    }

    const result = {
      success: true,
      message: dryRun
        ? `Preview: Found ${eligible.length} stale visitors eligible for archiving (out of ${candidates.length} scanned). ${keptCount} kept (has Stripe charges).`
        : `Archived ${archivedCount} stale visitors. ${keptCount} kept (has Stripe charges).`,
      dryRun,
      totalScanned: candidates.length,
      eligibleCount: eligible.length,
      keptCount,
      archivedCount,
      sampleArchived
    };

    logFromRequest(req, 'archive_stale_visitors', 'users', null, undefined, {
      action: dryRun ? 'preview' : 'execute',
      totalScanned: candidates.length,
      eligibleCount: eligible.length,
      keptCount,
      archivedCount,
      staffEmail
    });

    activeVisitorArchiveJob!.status = 'completed';
    activeVisitorArchiveJob!.completedAt = new Date();
    activeVisitorArchiveJob!.result = result;
    activeVisitorArchiveJob!.progress.phase = 'done';
    broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress, result });
  } catch (error: unknown) {
    logger.error('[DataTools] Visitor archive error', { error: error instanceof Error ? error : new Error(String(error)) });
    activeVisitorArchiveJob!.status = 'failed';
    activeVisitorArchiveJob!.completedAt = new Date();
    activeVisitorArchiveJob!.error = getErrorMessage(error);
    activeVisitorArchiveJob!.progress.phase = 'done';
    broadcastToStaff({ type: 'visitor_archive_progress', data: activeVisitorArchiveJob!.progress, error: getErrorMessage(error) });
  }
}

router.post('/api/data-tools/cleanup-ghost-fees', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;

    const ghostResult = await db.execute(sql`
      SELECT bp.id, bp.display_name, bp.cached_fee_cents, bs.trackman_booking_id, bs.session_date
      FROM booking_participants bp
      JOIN booking_sessions bs ON bs.id = bp.session_id
      WHERE bp.payment_status = 'pending'
        AND COALESCE(bp.cached_fee_cents, 0) > 0
        AND bp.user_id IS NULL
        AND bp.display_name LIKE '%Unknown%'
    `);

    const pastPendingResult = await db.execute(sql`
      SELECT bp.id, bp.display_name, bp.cached_fee_cents, bs.trackman_booking_id, bs.session_date
      FROM booking_participants bp
      JOIN booking_sessions bs ON bs.id = bp.session_id
      WHERE bp.payment_status = 'pending'
        AND COALESCE(bp.cached_fee_cents, 0) > 0
        AND bs.session_date < CURRENT_DATE
        AND bp.user_id IS NOT NULL
    `);

    if (!dryRun) {
      await db.execute(sql`
        UPDATE booking_participants bp
        SET payment_status = 'waived'
        FROM booking_sessions bs
        WHERE bp.session_id = bs.id
          AND bp.payment_status = 'pending'
          AND COALESCE(bp.cached_fee_cents, 0) > 0
          AND bp.user_id IS NULL
          AND bp.display_name LIKE '%Unknown%'
      `);

      await db.execute(sql`
        UPDATE booking_participants bp
        SET payment_status = 'paid', paid_at = NOW()
        FROM booking_sessions bs
        WHERE bp.session_id = bs.id
          AND bp.payment_status = 'pending'
          AND COALESCE(bp.cached_fee_cents, 0) > 0
          AND bs.session_date < CURRENT_DATE
          AND bp.user_id IS NOT NULL
      `);

      logFromRequest(req, {
        action: 'cleanup_ghost_fees',
        resourceType: 'booking_participants',
        details: { summary: `Waived ${ghostResult.rows.length} ghost fees, marked ${pastPendingResult.rows.length} past fees as paid` }
      });
    }

    const ghostTotal = ghostResult.rows.reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.cached_fee_cents) || 0), 0);
    const pastTotal = pastPendingResult.rows.reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.cached_fee_cents) || 0), 0);

    res.json({
      dryRun,
      ghostFees: {
        count: ghostResult.rows.length,
        totalDollars: ghostTotal / 100,
        action: dryRun ? 'would waive' : 'waived',
      },
      pastMemberFees: {
        count: pastPendingResult.rows.length,
        totalDollars: pastTotal / 100,
        action: dryRun ? 'would mark paid' : 'marked paid',
      },
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Ghost fee cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to clean up ghost fees' });
  }
});

export default router;

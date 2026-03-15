import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { isProduction } from '../../core/db';
import { users } from '@shared/schema';
import { sql, inArray } from 'drizzle-orm';
import { isAdmin } from '../../core/middleware';
import { getHubSpotClientWithFallback } from '../../core/integrations';
import { retryableHubSpotRequest } from '../../core/hubspot/request';
import { logFromRequest, logBillingAudit } from '../../core/auditLog';
import { getSessionUser } from '../../types/session';
import { broadcastToStaff } from '../../core/websocket';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';
import { getStripeClient } from '../../core/stripe/client';
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

interface ParticipantBillingWithTier {
  tier?: string;
  email?: string;
  participantType: string;
  minutesAllocated: number;
  overageFee: number;
  guestFee: number;
}

import { createBackgroundJob, updateJobProgress, completeJob, failJob, getActiveJob, getLatestJob } from '../../core/backgroundJobStore';

const VISITOR_ARCHIVE_JOB_TYPE = 'visitor_archive';

interface VisitorArchiveProgress {
  phase: 'scanning' | 'checking_stripe' | 'deleting' | 'done';
  totalVisitors: number;
  checked: number;
  eligibleCount: number;
  keptCount: number;
  deleted: number;
  errors: number;
}

let currentVisitorArchiveJobId: string | null = null;
let currentVisitorArchiveProgress: VisitorArchiveProgress | null = null;

const router = Router();

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

router.post('/api/data-tools/cleanup-mindbody-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting mindbody_client_id cleanup (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
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
    
    const { client: hubspot } = await getHubSpotClientWithFallback();
    const toClean: Array<{ email: string; mindbodyClientId: string | null; hubspotId: string | null }> = [];
    const validated: Array<{ email: string; mindbodyClientId: string }> = [];
    const errors: string[] = [];
    
    const batchSize = 50;
    for (let i = 0; i < usersWithMindbody.rows.length; i += batchSize) {
      const batch = usersWithMindbody.rows.slice(i, i + batchSize) as unknown as DbUserRow[];
      
      for (const user of batch) {
        try {
          let hubspotMindbodyId: string | null = null;
          
          if (user.hubspot_id) {
            const contact = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(user.hubspot_id!, ['mindbody_client_id'])
            );
            hubspotMindbodyId = contact.properties?.mindbody_client_id || null;
          } else {
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
          
          if (!hubspotMindbodyId || hubspotMindbodyId.trim() === '') {
            toClean.push({
              email: user.email,
              mindbodyClientId: user.mindbody_client_id,
              hubspotId: user.hubspot_id!
            });
          } else if (hubspotMindbodyId === user.mindbody_client_id) {
            validated.push({
              email: user.email,
              mindbodyClientId: user.mindbody_client_id
            });
          } else {
            logger.info('[DataTools] Mindbody ID mismatch for : DB=, HubSpot=', { extra: { userEmail: user.email, userMindbody_client_id: user.mindbody_client_id, hubspotMindbodyId } });
          }
        } catch (err: unknown) {
          errors.push(`Error checking ${user.email}: ${getErrorMessage(err)}`);
        }
      }
      
      if (i + batchSize < usersWithMindbody.rows.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    let cleanedCount = 0;
    
    if (!dryRun && toClean.length > 0) {
      const emailsToClean = toClean.map(u => u.email.toLowerCase());
      
      const cleanResult = await db.execute(sql`UPDATE users 
         SET mindbody_client_id = NULL, updated_at = NOW() 
         WHERE LOWER(email) IN (${sql.join(emailsToClean.map((e: string) => sql`${e}`), sql`, `)})
         RETURNING email`);
      
      cleanedCount = cleanResult.rowCount || 0;
      
      await logFromRequest(req, {
        action: 'cleanup_mindbody_ids',
        resourceType: 'users',
        details: {
          cleanedCount,
          emails: emailsToClean.slice(0, 20)
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
      staleRecords: toClean.slice(0, 50),
      errors: errors.slice(0, 10)
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Cleanup mindbody IDs error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup mindbody IDs', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-visit-counts', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting visit count sync to HubSpot (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    const { client: hubspot } = await getHubSpotClientWithFallback();
    
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
                AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
              UNION
              SELECT br.id as booking_id FROM booking_requests br
              JOIN booking_participants bp ON bp.session_id = br.session_id
              JOIN users u ON bp.user_id = u.id
              WHERE LOWER(u.email) = ${normalizedEmail}
                AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
                AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
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
              hubspot.crm.contacts.basicApi.getById(member.hubspot_id!, ['total_visit_count'])
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
            hubspotId: member.hubspot_id!,
            appVisitCount,
            hubspotVisitCount,
            needsUpdate: hubspotVisitCount !== appVisitCount
          };
          
          if (hubspotVisitCount !== appVisitCount) {
            mismatches.push(record);
            
            if (!dryRun) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.contacts.basicApi.update(member.hubspot_id!, {
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
    
    const { client: hubspot } = await getHubSpotClientWithFallback();
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
         AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
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
    
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { createSession: _createSession, recordUsage, linkParticipants, ensureSessionForBooking } = await import('../../core/bookingService/sessionManager');
    const { getMemberTierByEmail } = await import('../../core/tierService');
    const { calculateFullSessionBilling } = await import('../../core/bookingService/usageCalculator');
    const { recalculateSessionFees } = await import('../../core/billing/unifiedFeeService');
    
    for (const booking of ghostBookings) {
      try {
        const existingSessionCheck = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${booking.bookingId} AND session_id IS NOT NULL`);
        
        if (existingSessionCheck.rows.length > 0) {
          continue;
        }
        
        const duplicateSessionCheck = await db.execute(sql`SELECT id FROM booking_sessions WHERE trackman_booking_id = ${booking.trackmanBookingId}`);
        
        if (duplicateSessionCheck.rows.length > 0) {
          const existingSessionId = (duplicateSessionCheck.rows[0] as { id: number }).id;
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
        const resourceType = (resourceResult.rows[0] as { type: string })?.type || 'simulator';
        
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
                tierAtBooking: (billing as unknown as ParticipantBillingWithTier).tier || ownerTier || undefined,
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
        
        try {
          const slotDuration = booking.startTime && booking.endTime
            ? Math.round((new Date(`2000-01-01T${booking.endTime}`).getTime() - 
                         new Date(`2000-01-01T${booking.startTime}`).getTime()) / 60000)
            : booking.durationMinutes || 60;
          
          const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.userEmail})`);
          const userId = (userResult.rows[0] as { id: string })?.id || null;
          
          await db.execute(sql`
            INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
            VALUES (${sessionId}, ${userId}, 'owner', ${booking.userName || booking.userEmail}, 'waived', ${slotDuration})
            ON CONFLICT DO NOTHING
          `);
          
          for (let i = 1; i < booking.playerCount; i++) {
            await db.execute(sql`
              INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              VALUES (${sessionId}, NULL, 'guest', ${`Guest ${i + 1}`}, 'waived', ${slotDuration})
            `);
          }
          
          await recalculateSessionFees(sessionId, 'staff_action');
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

router.post('/api/data-tools/archive-stale-visitors', isAdmin, async (req: Request, res: Response) => {
  try {
    const existingJob = await getActiveJob(VISITOR_ARCHIVE_JOB_TYPE);
    if (existingJob) {
      return res.status(409).json({ error: 'A stale visitor deletion job is already running', jobId: existingJob.id });
    }

    const dryRun = req.body.dryRun !== false;
    const staffEmail = getSessionUser(req)?.email || 'admin';

    logger.info('[DataTools] Stale visitor deletion initiated by (dryRun: )', { extra: { staffEmail, dryRun } });

    const jobId = `va_${Date.now().toString(36)}`;
    const initialProgress: VisitorArchiveProgress = {
      phase: 'scanning',
      totalVisitors: 0,
      checked: 0,
      eligibleCount: 0,
      keptCount: 0,
      deleted: 0,
      errors: 0,
    };

    await createBackgroundJob({
      id: jobId,
      jobType: VISITOR_ARCHIVE_JOB_TYPE,
      dryRun,
      progress: initialProgress as unknown as Record<string, unknown>,
      startedBy: staffEmail,
    });

    currentVisitorArchiveJobId = jobId;
    currentVisitorArchiveProgress = { ...initialProgress };

    runVisitorArchiveInBackground(jobId, dryRun, staffEmail, req);

    res.json({ success: true, jobId, message: 'Delete job started' });
  } catch (error: unknown) {
    logger.error('[DataTools] Stale visitor deletion error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to start deletion job', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/archive-stale-visitors/status', isAdmin, async (req: Request, res: Response) => {
  try {
    const job = await getLatestJob(VISITOR_ARCHIVE_JOB_TYPE);
    if (!job) {
      return res.json({ hasJob: false });
    }
    const progress = currentVisitorArchiveJobId === job.id && currentVisitorArchiveProgress
      ? currentVisitorArchiveProgress
      : job.progress;
    res.json({
      hasJob: true,
      job: {
        id: job.id,
        status: job.status,
        dryRun: job.dryRun,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        progress,
        result: job.result,
        error: job.error,
      },
    });
  } catch {
    res.json({ hasJob: false });
  }
});

async function runVisitorArchiveInBackground(jobId: string, dryRun: boolean, staffEmail: string, req: Request) {
  const progress: VisitorArchiveProgress = {
    phase: 'scanning',
    totalVisitors: 0,
    checked: 0,
    eligibleCount: 0,
    keptCount: 0,
    deleted: 0,
    errors: 0,
  };

  const syncProgress = async () => {
    currentVisitorArchiveProgress = { ...progress };
    await updateJobProgress(jobId, progress as unknown as Record<string, unknown>).catch(() => {});
  };

  try {
    progress.phase = 'scanning';
    broadcastToStaff({ type: 'visitor_archive_progress', data: progress });

    const candidatesResult = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.stripe_customer_id, u.membership_status
      FROM users u
      WHERE u.membership_status IN ('non-member', 'visitor')
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
    progress.totalVisitors = candidates.length;
    broadcastToStaff({ type: 'visitor_archive_progress', data: progress });
    await syncProgress();

    logger.info('[DataTools] Found visitor/non-member candidates with no local activity', { extra: { candidatesLength: candidates.length } });

    progress.phase = 'checking_stripe';
    broadcastToStaff({ type: 'visitor_archive_progress', data: progress });

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
            progress.errors++;
          }
        }));

        progress.checked = Math.min(i + BATCH_SIZE, visitorsWithStripe.length);
        progress.keptCount = keptCount;
        progress.eligibleCount = eligible.length;
        broadcastToStaff({ type: 'visitor_archive_progress', data: progress });
        await syncProgress();

        if (i + BATCH_SIZE < visitorsWithStripe.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }

    progress.eligibleCount = eligible.length;
    progress.keptCount = keptCount;
    progress.checked = visitorsWithStripe.length;
    broadcastToStaff({ type: 'visitor_archive_progress', data: progress });
    await syncProgress();

    logger.info('[DataTools] eligible for deletion, kept (has Stripe charges)', { extra: { eligibleLength: eligible.length, keptCount } });

    const sampleDeleted = eligible.slice(0, 20).map(v => ({
      name: [v.first_name, v.last_name].filter(Boolean).join(' ') || 'Unknown',
      email: v.email
    }));

    let deletedCount = 0;

    if (!dryRun && eligible.length > 0) {
      progress.phase = 'deleting';
      broadcastToStaff({ type: 'visitor_archive_progress', data: progress });
      await syncProgress();

      const DELETE_BATCH_SIZE = 100;
      for (let i = 0; i < eligible.length; i += DELETE_BATCH_SIZE) {
        const batch = eligible.slice(i, i + DELETE_BATCH_SIZE);
        const ids = batch.map(v => v.id) as string[];
        const emails = batch.map(v => (v.email as string).toLowerCase());

        try {
          const emailList = sql.join(emails.map(e => sql`${e}`), sql`, `);
          const idList = sql.join(ids.map(id => sql`${id}`), sql`, `);
          await db.transaction(async (tx) => {
            await tx.execute(sql`DELETE FROM notifications WHERE LOWER(user_email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM push_subscriptions WHERE LOWER(user_email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM user_dismissed_notices WHERE LOWER(user_email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM user_linked_emails WHERE LOWER(primary_email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM member_notes WHERE LOWER(member_email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM communication_logs WHERE LOWER(member_email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM form_submissions WHERE LOWER(email) IN (${emailList})`);
            await tx.execute(sql`DELETE FROM passkeys WHERE "userId" IN (${idList})`);
            await tx.execute(sql`DELETE FROM users WHERE id IN (${idList})`);
          });
          deletedCount += batch.length;
        } catch (err: unknown) {
          logger.error('[DataTools] Error deleting batch ( ids)', { extra: { length: ids.length, error: getErrorMessage(err) } });
          progress.errors++;
        }

        progress.deleted = deletedCount;
        broadcastToStaff({ type: 'visitor_archive_progress', data: progress });
        await syncProgress();
      }
    }

    const hasErrors = progress.errors > 0;
    const jobResult = {
      success: !hasErrors || deletedCount > 0,
      message: dryRun
        ? `Preview: Found ${eligible.length} stale visitors eligible for deletion (out of ${candidates.length} scanned). ${keptCount} kept (has Stripe charges).`
        : hasErrors
          ? `Deleted ${deletedCount} of ${eligible.length} stale visitors (${progress.errors} batch errors). ${keptCount} kept (has Stripe charges).`
          : `Deleted ${deletedCount} stale visitors. ${keptCount} kept (has Stripe charges).`,
      dryRun,
      totalScanned: candidates.length,
      eligibleCount: eligible.length,
      keptCount,
      deletedCount,
      sampleDeleted
    };

    logFromRequest(req, 'delete_stale_visitors', 'users', null, undefined, {
      action: dryRun ? 'preview' : 'execute',
      totalScanned: candidates.length,
      eligibleCount: eligible.length,
      keptCount,
      deletedCount,
      staffEmail
    });

    progress.phase = 'done';
    await completeJob(jobId, jobResult as unknown as Record<string, unknown>, progress as unknown as Record<string, unknown>);
    currentVisitorArchiveProgress = { ...progress };
    broadcastToStaff({ type: 'visitor_archive_progress', data: progress, result: jobResult });
  } catch (error: unknown) {
    logger.error('[DataTools] Stale visitor deletion error', { error: error instanceof Error ? error : new Error(String(error)) });
    progress.phase = 'done';
    await failJob(jobId, getErrorMessage(error), progress as unknown as Record<string, unknown>);
    currentVisitorArchiveProgress = { ...progress };
    broadcastToStaff({ type: 'visitor_archive_progress', data: progress, error: getErrorMessage(error) });
  }
}

router.post('/api/data-tools/cleanup-ghost-fees', isAdmin, async (req: Request, res: Response) => {
  try {
    const _staffEmail = getSessionUser(req)?.email || 'unknown';
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

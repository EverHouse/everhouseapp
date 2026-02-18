import { logger } from '../core/logger';
import { Router } from 'express';
import { isAdmin } from '../core/middleware';
import { runAllIntegrityChecks, getIntegritySummary, getIntegrityHistory, resolveIssue, getAuditLog, syncPush, syncPull, createIgnoreRule, createBulkIgnoreRules, removeIgnoreRule, getIgnoredIssues, getCachedIntegrityResults, runDataCleanup } from '../core/dataIntegrity';
import { isProduction, pool } from '../core/db';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { broadcastDataIntegrityUpdate } from '../core/websocket';
import { syncAllCustomerMetadata, isPlaceholderEmail } from '../core/stripe/customers';
import { getStripeClient } from '../core/stripe/client';
import { getHubSpotClientWithFallback } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { logFromRequest, type ResourceType } from '../core/auditLog';
import { getSystemHealth } from '../core/healthCheck';
import { getSessionUser } from '../types/session';
import type { Request } from 'express';
import { getErrorMessage } from '../utils/errorUtils';

const router = Router();

router.get('/api/data-integrity/cached', isAdmin, async (req, res) => {
  try {
    const cached = await getCachedIntegrityResults();
    if (!cached) {
      return res.json({ 
        success: false, 
        hasCached: false,
        message: 'No cached results available. Run checks to generate initial results.' 
      });
    }
    res.json({
      success: true,
      hasCached: true,
      results: cached.results,
      meta: cached.meta
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Cached results error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get cached results', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/run', isAdmin, async (req, res) => {
  try {
    const results = await runAllIntegrityChecks('manual');
    res.json({
      success: true,
      results,
      meta: {
        totalChecks: results.length,
        passed: results.filter(r => r.status === 'pass').length,
        warnings: results.filter(r => r.status === 'warning').length,
        failed: results.filter(r => r.status === 'fail').length,
        totalIssues: results.reduce((sum, r) => sum + r.issueCount, 0),
        lastRun: new Date()
      }
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Run error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run integrity checks', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/summary', isAdmin, async (req, res) => {
  try {
    const summary = await getIntegritySummary();
    res.json(summary);
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Summary error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get integrity summary', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/history', isAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const historyData = await getIntegrityHistory(days);
    res.json(historyData);
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] History error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get integrity history', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/resolve', isAdmin, async (req: Request, res) => {
  try {
    const { issue_key, resolution_method, notes, action } = req.body;
    
    if (!issue_key) {
      return res.status(400).json({ error: 'issue_key is required' });
    }
    
    const actionType = action || 'resolved';
    if (!['resolved', 'ignored', 'reopened'].includes(actionType)) {
      return res.status(400).json({ error: 'Invalid action type' });
    }
    
    if (actionType === 'resolved' && !resolution_method) {
      return res.status(400).json({ error: 'resolution_method is required for resolved action' });
    }
    
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    const result = await resolveIssue({
      issueKey: issue_key,
      action: actionType,
      actionBy: staffEmail,
      resolutionMethod: resolution_method,
      notes: notes
    });
    
    res.json({ success: true, auditLogId: result.auditLogId });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Resolve error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to resolve issue', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/audit-log', isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const auditEntries = await getAuditLog(limit);
    res.json(auditEntries);
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Audit log error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get audit log', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/sync-push', isAdmin, async (req: Request, res) => {
  try {
    // Accept both camelCase and snake_case parameter names
    const issue_key = req.body.issue_key || req.body.issueKey;
    const target = req.body.target;
    const user_id = req.body.user_id || req.body.userId;
    const hubspot_contact_id = req.body.hubspot_contact_id || req.body.hubspotContactId;
    
    if (!issue_key) {
      return res.status(400).json({ error: 'issue_key is required' });
    }
    
    if (!target || !['hubspot', 'calendar'].includes(target)) {
      return res.status(400).json({ error: 'Valid target (hubspot or calendar) is required' });
    }
    
    const result = await syncPush({
      issueKey: issue_key,
      target,
      userId: user_id,
      hubspotContactId: hubspot_contact_id
    });
    
    // Broadcast update so other staff dashboards refresh
    broadcastDataIntegrityUpdate('data_changed', { source: `sync_push_${target}` });
    
    res.json(result);
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Sync push error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to push sync', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/sync-pull', isAdmin, async (req: Request, res) => {
  try {
    // Accept both camelCase and snake_case parameter names
    const issue_key = req.body.issue_key || req.body.issueKey;
    const target = req.body.target;
    const user_id = req.body.user_id || req.body.userId;
    const hubspot_contact_id = req.body.hubspot_contact_id || req.body.hubspotContactId;
    
    if (!issue_key) {
      return res.status(400).json({ error: 'issue_key is required' });
    }
    
    if (!target || !['hubspot', 'calendar'].includes(target)) {
      return res.status(400).json({ error: 'Valid target (hubspot or calendar) is required' });
    }
    
    const result = await syncPull({
      issueKey: issue_key,
      target,
      userId: user_id,
      hubspotContactId: hubspot_contact_id
    });
    
    // Broadcast update so other staff dashboards refresh
    broadcastDataIntegrityUpdate('data_changed', { source: `sync_pull_${target}` });
    
    res.json(result);
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Sync pull error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to pull sync', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/ignores', isAdmin, async (req, res) => {
  try {
    const ignores = await getIgnoredIssues();
    res.json(ignores);
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Get ignores error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get ignored issues', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/ignore', isAdmin, async (req: Request, res) => {
  try {
    const { issue_key, duration, reason } = req.body;
    
    if (!issue_key) {
      return res.status(400).json({ error: 'issue_key is required' });
    }
    
    if (!duration || !['24h', '1w', '30d'].includes(duration)) {
      return res.status(400).json({ error: 'Valid duration (24h, 1w, 30d) is required' });
    }
    
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'reason is required' });
    }
    
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    const result = await createIgnoreRule({
      issueKey: issue_key,
      duration,
      reason: reason.trim(),
      ignoredBy: staffEmail
    });
    
    res.json({ success: true, ignore: result });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Create ignore error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create ignore rule', details: getErrorMessage(error) });
  }
});

router.delete('/api/data-integrity/ignore/:issueKey', isAdmin, async (req: Request, res) => {
  try {
    const { issueKey } = req.params;
    
    if (!issueKey) {
      return res.status(400).json({ error: 'issueKey is required' });
    }
    
    const result = await removeIgnoreRule(issueKey as string);
    
    if (!result.removed) {
      return res.status(404).json({ error: 'Ignore rule not found' });
    }
    
    res.json({ success: true, message: 'Ignore rule removed' });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Remove ignore error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove ignore rule', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/ignore-bulk', isAdmin, async (req: Request, res) => {
  try {
    const { issue_keys, duration, reason } = req.body;
    
    if (!issue_keys || !Array.isArray(issue_keys) || issue_keys.length === 0) {
      return res.status(400).json({ error: 'issue_keys array is required' });
    }
    
    if (issue_keys.length > 5000) {
      return res.status(400).json({ error: 'Maximum 5000 issues can be excluded at once' });
    }
    
    if (!duration || !['24h', '1w', '30d'].includes(duration)) {
      return res.status(400).json({ error: 'Valid duration (24h, 1w, 30d) is required' });
    }
    
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'reason is required' });
    }
    
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    const result = await createBulkIgnoreRules({
      issueKeys: issue_keys,
      duration,
      reason: reason.trim(),
      ignoredBy: staffEmail
    });
    
    res.json({ 
      success: true, 
      created: result.created,
      updated: result.updated,
      total: result.created + result.updated
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Bulk ignore error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create bulk ignore rules', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/sync-stripe-metadata', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Starting Stripe customer metadata sync...');
    const result = await syncAllCustomerMetadata();
    
    res.json({ 
      success: true, 
      message: `Synced ${result.synced} customers to Stripe. ${result.failed} failed.`,
      synced: result.synced,
      failed: result.failed
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Stripe metadata sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync Stripe metadata', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/cleanup', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Starting data cleanup...');
    const result = await runDataCleanup();
    
    res.json({ 
      success: true, 
      message: `Cleanup complete: Removed ${result.orphanedNotifications} orphaned notifications, ${result.orphanedFeeSnapshots} orphaned fee snapshots, marked ${result.orphanedBookings} orphaned bookings, normalized ${result.normalizedEmails} emails.`,
      ...result
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Data cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run data cleanup', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/placeholder-accounts', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Scanning for placeholder accounts...');
    
    const stripeCustomers: { id: string; email: string; name: string | null; created: number }[] = [];
    const hubspotContacts: { id: string; email: string; name: string }[] = [];
    const localDatabaseUsers: { id: string; email: string; name: string; status: string; createdAt: string }[] = [];
    
    // Scan local database for placeholder accounts
    try {
      const localResult = await db.execute(sql`
        SELECT id, email, first_name, last_name, membership_status, created_at
        FROM users 
        WHERE email LIKE '%@visitors.evenhouse.club%'
           OR email LIKE '%@trackman.local%'
           OR email LIKE '%@trackman.import%'
           OR email LIKE 'unmatched-%'
           OR email LIKE 'unmatched@%'
           OR email LIKE 'golfnow-%'
           OR email LIKE 'classpass-%'
           OR email LIKE 'lesson-%'
           OR email LIKE 'anonymous-%'
           OR email LIKE 'private-event@%'
           OR email LIKE '%@resolved%'
           OR email LIKE '%@placeholder.%'
           OR email LIKE '%@test.local%'
           OR email LIKE '%@example.com%'
        ORDER BY created_at DESC
      `);
      
      for (const row of localResult.rows) {
        localDatabaseUsers.push({
          id: row.id as string,
          email: row.email as string,
          name: [row.first_name as string, row.last_name as string].filter(Boolean).join(' ') || row.email as string,
          status: row.membership_status as string,
          createdAt: (row.created_at as Date)?.toISOString() || '',
        });
      }
    } catch (dbError: unknown) {
      logger.warn('[DataIntegrity] Local database scan failed', { extra: { dbError: getErrorMessage(dbError) } });
    }
    
    const stripe = await getStripeClient();
    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const customers = await stripe.customers.list({
        limit: 100,
        starting_after: startingAfter,
      });
      
      for (const customer of customers.data) {
        if (customer.email && isPlaceholderEmail(customer.email)) {
          stripeCustomers.push({
            id: customer.id,
            email: customer.email,
            name: customer.name ?? null,
            created: customer.created,
          });
        }
      }
      
      hasMore = customers.has_more;
      if (customers.data.length > 0) {
        startingAfter = customers.data[customers.data.length - 1].id;
      }
    }
    
    try {
      const { client: hubspot } = await getHubSpotClientWithFallback();
      let after: string | undefined;
      let hsHasMore = true;
      
      while (hsHasMore) {
        const contactsResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.getPage(100, after, ['email', 'firstname', 'lastname'])
        );
        
        for (const contact of contactsResponse.results) {
          const email = contact.properties.email;
          if (email && isPlaceholderEmail(email)) {
            const firstName = contact.properties.firstname || '';
            const lastName = contact.properties.lastname || '';
            hubspotContacts.push({
              id: contact.id,
              email,
              name: [firstName, lastName].filter(Boolean).join(' ') || email,
            });
          }
        }
        
        after = contactsResponse.paging?.next?.after;
        hsHasMore = !!after;
      }
    } catch (hubspotError: unknown) {
      logger.warn('[DataIntegrity] HubSpot scan failed', { extra: { hubspotError: getErrorMessage(hubspotError) } });
    }
    
    logFromRequest(req, 'placeholder_scan', 'system', undefined, undefined, {
      action: 'scan',
      stripeCount: stripeCustomers.length,
      hubspotCount: hubspotContacts.length,
      localDbCount: localDatabaseUsers.length,
    });

    res.json({
      success: true,
      stripeCustomers,
      hubspotContacts,
      localDatabaseUsers,
      totals: {
        stripe: stripeCustomers.length,
        hubspot: hubspotContacts.length,
        localDatabase: localDatabaseUsers.length,
        total: stripeCustomers.length + hubspotContacts.length + localDatabaseUsers.length,
      },
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Placeholder scan error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to scan for placeholder accounts', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/placeholder-accounts/delete', isAdmin, async (req: Request, res) => {
  try {
    const { stripeCustomerIds, hubspotContactIds, localDatabaseUserIds } = req.body;
    
    if (!Array.isArray(stripeCustomerIds) && !Array.isArray(hubspotContactIds) && !Array.isArray(localDatabaseUserIds)) {
      return res.status(400).json({ error: 'Must provide stripeCustomerIds, hubspotContactIds, or localDatabaseUserIds arrays' });
    }
    
    logger.info('[DataIntegrity] Deleting Stripe customers, HubSpot contacts, and local database users...', { extra: { stripeCustomerIds: stripeCustomerIds?.length || 0, hubspotContactIds: hubspotContactIds?.length || 0, localDatabaseUserIds: localDatabaseUserIds?.length || 0 } });
    
    const results = {
      stripeDeleted: 0,
      stripeFailed: 0,
      stripeErrors: [] as string[],
      hubspotDeleted: 0,
      hubspotFailed: 0,
      hubspotErrors: [] as string[],
      localDatabaseDeleted: 0,
      localDatabaseFailed: 0,
      localDatabaseErrors: [] as string[],
    };
    
    if (stripeCustomerIds?.length > 0) {
      const stripe = await getStripeClient();
      
      for (const customerId of stripeCustomerIds) {
        try {
          await stripe.customers.del(customerId);
          results.stripeDeleted++;
        } catch (error: unknown) {
          results.stripeFailed++;
          results.stripeErrors.push(`${customerId}: ${getErrorMessage(error)}`);
        }
      }
    }
    
    if (hubspotContactIds?.length > 0) {
      try {
        const { client: hubspot } = await getHubSpotClientWithFallback();
        
        const HUBSPOT_BATCH_SIZE = 100;
        for (let i = 0; i < hubspotContactIds.length; i += HUBSPOT_BATCH_SIZE) {
          const batch = hubspotContactIds.slice(i, i + HUBSPOT_BATCH_SIZE);
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.batchApi.archive({ inputs: batch.map((id: string) => ({ id })) })
            );
            results.hubspotDeleted += batch.length;
          } catch (batchErr: unknown) {
            for (const contactId of batch) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.contacts.basicApi.archive(contactId)
                );
                results.hubspotDeleted++;
              } catch (error: unknown) {
                results.hubspotFailed++;
                results.hubspotErrors.push(`${contactId}: ${getErrorMessage(error)}`);
              }
            }
          }
        }
      } catch (hubspotError: unknown) {
        logger.error('[DataIntegrity] HubSpot client failed', { extra: { hubspotError: getErrorMessage(hubspotError) } });
        results.hubspotErrors.push(`HubSpot connection failed: ${getErrorMessage(hubspotError)}`);
      }
    }
    
    // Delete local database placeholder users and their related data
    if (localDatabaseUserIds?.length > 0) {
      for (const odUserId of localDatabaseUserIds) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          
          // First get the user's email for cleaning up related records
          const userResult = await client.query(
            'SELECT id, email FROM users WHERE id = $1',
            [odUserId]
          );
          
          if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            results.localDatabaseFailed++;
            results.localDatabaseErrors.push(`${odUserId}: User not found`);
            continue;
          }
          
          const userId = userResult.rows[0].id;
          const userEmail = userResult.rows[0].email;
          
          // Delete notifications for this user
          await client.query(
            'DELETE FROM notifications WHERE user_id = $1',
            [userId]
          );
          
          // Delete booking sessions for this user
          await client.query(
            'DELETE FROM booking_sessions WHERE user_id = $1',
            [userId]
          );
          
          // Delete booking guests where this user is the guest
          await client.query(
            'DELETE FROM booking_guests WHERE LOWER(guest_email) = LOWER($1)',
            [userEmail]
          );
          
          // Delete related bookings for this placeholder user (by email and user_id)
          await client.query(
            'DELETE FROM booking_requests WHERE LOWER(user_email) = LOWER($1) OR user_id = $2',
            [userEmail, userId]
          );
          
          // Delete booking members entries
          await client.query(
            'DELETE FROM booking_members WHERE LOWER(user_email) = LOWER($1)',
            [userEmail]
          );
          
          // Delete event RSVPs
          await client.query(
            'DELETE FROM event_rsvps WHERE LOWER(user_email) = LOWER($1)',
            [userEmail]
          );
          
          // Delete wellness enrollments
          await client.query(
            'DELETE FROM wellness_enrollments WHERE LOWER(user_email) = LOWER($1)',
            [userEmail]
          );
          
          // Delete pending fees
          await client.query(
            'DELETE FROM pending_fees WHERE user_id = $1',
            [userId]
          );
          
          // Delete user notes
          await client.query(
            'DELETE FROM user_notes WHERE user_id = $1',
            [userId]
          );
          
          // Now delete the user
          const deleteResult = await client.query(
            'DELETE FROM users WHERE id = $1 RETURNING email',
            [userId]
          );
          
          await client.query('COMMIT');
          
          if (deleteResult.rowCount && deleteResult.rowCount > 0) {
            results.localDatabaseDeleted++;
            logger.info('[DataIntegrity] Deleted placeholder user and all related records', { extra: { userEmail } });
          } else {
            results.localDatabaseFailed++;
            results.localDatabaseErrors.push(`${odUserId}: Failed to delete user`);
          }
        } catch (error: unknown) {
          await client.query('ROLLBACK');
          results.localDatabaseFailed++;
          results.localDatabaseErrors.push(`${odUserId}: ${getErrorMessage(error)}`);
        } finally {
          client.release();
        }
      }
    }
    
    logFromRequest(
      req,
      'placeholder_accounts_deleted',
      'system',
      undefined,
      'Placeholder Accounts Cleanup',
      {
        stripeDeleted: results.stripeDeleted,
        stripeFailed: results.stripeFailed,
        hubspotDeleted: results.hubspotDeleted,
        hubspotFailed: results.hubspotFailed,
        localDatabaseDeleted: results.localDatabaseDeleted,
        localDatabaseFailed: results.localDatabaseFailed,
      }
    );
    
    const totalDeleted = results.stripeDeleted + results.hubspotDeleted + results.localDatabaseDeleted;
    const totalFailed = results.stripeFailed + results.hubspotFailed + results.localDatabaseFailed;
    
    res.json({
      success: true,
      message: `Deleted ${totalDeleted} placeholder accounts. ${totalFailed > 0 ? `${totalFailed} failed.` : ''}`,
      ...results,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Placeholder delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete placeholder accounts', details: getErrorMessage(error) });
  }
});

router.get('/api/data-integrity/health', isAdmin, async (req, res) => {
  try {
    const health = await getSystemHealth();
    
    logFromRequest(
      req,
      'health_check_viewed',
      'system',
      undefined,
      'System Health Check',
      { overall: health.overall }
    );
    
    res.json({ success: true, health });
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Health check error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check system health', details: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/unlink-hubspot', isAdmin, async (req: Request, res) => {
  try {
    const { userId, hubspotContactId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
    
    await db.execute(sql`UPDATE users SET hubspot_id = NULL, updated_at = NOW() WHERE id = ${userId}`);
    
    logFromRequest(req, 'unlink_hubspot_contact', 'user', userId, undefined, {
      hubspotContactId,
      unlinkedUserId: userId
    });
    
    res.json({ success: true, message: `Unlinked HubSpot contact from user ${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Unlink HubSpot error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/merge-hubspot-duplicates', isAdmin, async (req: Request, res) => {
  try {
    const { primaryUserId, secondaryUserId, hubspotContactId } = req.body;
    if (!primaryUserId || !secondaryUserId) {
      return res.status(400).json({ success: false, message: 'primaryUserId and secondaryUserId are required' });
    }
    
    const sessionUser = getSessionUser(req);
    const { executeMerge } = await import('../core/userMerge');
    
    const result = await executeMerge(primaryUserId, secondaryUserId, sessionUser?.email || 'admin');
    
    logFromRequest(req, 'merge_hubspot_duplicates', 'user', primaryUserId, undefined, {
      secondary_user_id: secondaryUserId,
      hubspot_contact_id: hubspotContactId,
      records_merged: result.recordsMerged,
      merged_lifetime_visits: result.mergedLifetimeVisits,
      trigger: 'hubspot_id_duplicate_fix'
    });
    
    res.json({ 
      success: true, 
      message: `Merged user into primary account. ${result.mergedLifetimeVisits} lifetime visits combined.`,
      result 
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Merge HubSpot duplicates error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/delete-guest-pass', isAdmin, async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'recordId is required' });
    
    await db.execute(sql`DELETE FROM guest_passes WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_guest_pass', 'guest_passes', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned guest pass ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete guest pass error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/delete-fee-snapshot', isAdmin, async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'recordId is required' });
    
    await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_fee_snapshot', 'booking_fee_snapshots', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned fee snapshot ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete fee snapshot error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/dismiss-trackman-unmatched', isAdmin, async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'recordId is required' });
    
    const staffEmail = getSessionUser(req)?.email || 'admin';
    
    await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_by = ${staffEmail} WHERE id = ${recordId} AND resolved_at IS NULL`);
    
    logFromRequest(req, 'dismiss', 'trackman_unmatched', undefined, 'Trackman unmatched #' + recordId, { action: 'dismiss_from_integrity' });
    
    res.json({ success: true, message: 'Unmatched booking dismissed' });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Dismiss trackman unmatched error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/delete-booking-participant', isAdmin, async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'recordId is required' });
    
    await db.execute(sql`DELETE FROM booking_participants WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_booking_participant', 'booking_participants', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned booking participant ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete booking participant error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/fix-orphaned-participants', isAdmin, async (req: Request, res) => {
  try {
    const { dryRun = true } = req.body;
    
    const invalidParticipants = await db.execute(sql`
      SELECT bp.id, bp.user_id, bp.display_name, bp.participant_type, bp.session_id
      FROM booking_participants bp
      LEFT JOIN users u ON bp.user_id = u.id
      WHERE bp.user_id IS NOT NULL AND bp.user_id != '' AND u.id IS NULL
    `);
    
    const rows = invalidParticipants.rows as Record<string, unknown>[];
    
    if (rows.length === 0) {
      return res.json({ success: true, message: 'No orphaned participants found', relinked: 0, converted: 0, total: 0, dryRun });
    }
    
    const relinked: Array<{ id: number; displayName: string; oldUserId: string; newUserId: string; email: string }> = [];
    const toConvert: Array<{ id: number; displayName: string; userId: string }> = [];
    
    for (const row of rows) {
      const emailMatch = await db.execute(sql`
        SELECT id, email FROM users WHERE LOWER(email) = LOWER(${row.user_id}) LIMIT 1
      `);
      
      if (emailMatch.rows.length > 0) {
        const matchedUser = emailMatch.rows[0] as Record<string, unknown>;
        relinked.push({
          id: row.id as number,
          displayName: row.display_name as string,
          oldUserId: row.user_id as string,
          newUserId: matchedUser.id as string,
          email: matchedUser.email as string
        });
      } else {
        toConvert.push({
          id: row.id as number,
          displayName: row.display_name as string,
          userId: row.user_id as string
        });
      }
    }
    
    if (!dryRun) {
      for (const item of relinked) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET user_id = ${item.newUserId}
          WHERE id = ${item.id}
        `);
      }
      
      for (const item of toConvert) {
        await db.execute(sql`
          UPDATE booking_participants 
          SET user_id = NULL, participant_type = 'guest'
          WHERE id = ${item.id}
        `);
      }
      
      logFromRequest(req, 'fix_orphaned_participants', 'booking_participants', undefined, undefined, {
        relinkedCount: relinked.length,
        convertedCount: toConvert.length,
        totalFixed: rows.length,
        relinkedIds: relinked.map(r => r.id),
        convertedIds: toConvert.map(c => c.id)
      });
      
      logger.info('[DataIntegrity] Fixed orphaned participants', { extra: { relinked: relinked.length, converted: toConvert.length, total: rows.length } });
    }
    
    res.json({
      success: true,
      message: dryRun
        ? `Found ${rows.length} orphaned participants: ${relinked.length} can be re-linked to existing members, ${toConvert.length} will be converted to guests`
        : `Fixed ${rows.length} orphaned participants: ${relinked.length} re-linked, ${toConvert.length} converted to guests`,
      relinked: relinked.length,
      converted: toConvert.length,
      total: rows.length,
      dryRun,
      relinkedDetails: relinked.slice(0, 20),
      convertedDetails: toConvert.slice(0, 20)
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Fix orphaned participants error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/convert-participant-to-guest', isAdmin, async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'recordId is required' });
    
    await db.execute(sql`
      UPDATE booking_participants 
      SET user_id = NULL, participant_type = 'guest'
      WHERE id = ${recordId}
    `);
    
    logFromRequest(req, 'convert_participant_to_guest', 'booking_participants', recordId, undefined, { convertedId: recordId });
    
    res.json({ success: true, message: `Converted participant ${recordId} to guest` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Convert participant to guest error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/approve-review-item', isAdmin, async (req: Request, res) => {
  try {
    const { recordId, table } = req.body;
    if (!recordId || !table) return res.status(400).json({ success: false, message: 'recordId and table are required' });
    
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    if (table === 'wellness_classes') {
      await db.execute(sql`UPDATE wellness_classes 
        SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false, locally_edited = true, app_last_modified_at = NOW()
        WHERE id = ${recordId}`);
    } else if (table === 'events') {
      await db.execute(sql`UPDATE events SET needs_review = false WHERE id = ${recordId}`);
    } else {
      return res.status(400).json({ success: false, message: `Unsupported table: ${table}` });
    }
    
    logFromRequest(req, 'approve_review_item', table as ResourceType, recordId, undefined, { table, reviewedBy });
    
    res.json({ success: true, message: `Approved ${table === 'wellness_classes' ? 'wellness class' : 'event'} #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Approve review item error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/delete-review-item', isAdmin, async (req: Request, res) => {
  try {
    const { recordId, table } = req.body;
    if (!recordId || !table) return res.status(400).json({ success: false, message: 'recordId and table are required' });
    
    if (table === 'wellness_classes') {
      await db.execute(sql`UPDATE wellness_classes SET is_active = false, updated_at = NOW() WHERE id = ${recordId}`);
    } else if (table === 'events') {
      await db.execute(sql`DELETE FROM events WHERE id = ${recordId}`);
    } else {
      return res.status(400).json({ success: false, message: `Unsupported table: ${table}` });
    }
    
    logFromRequest(req, 'delete_review_item', table as ResourceType, recordId, undefined, { table });
    
    res.json({ success: true, message: `Removed ${table === 'wellness_classes' ? 'wellness class' : 'event'} #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete review item error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/approve-all-review-items', isAdmin, async (req: Request, res) => {
  try {
    const { dryRun = true } = req.body;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const wellnessCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM wellness_classes WHERE needs_review = true AND is_active = true`);
    const eventCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM events WHERE needs_review = true`);
    
    const wCount = (wellnessCount.rows[0] as Record<string, unknown>)?.count || 0;
    const eCount = (eventCount.rows[0] as Record<string, unknown>)?.count || 0;
    const total = wCount + eCount;
    
    if (!dryRun) {
      if (wCount > 0) {
        await db.execute(sql`UPDATE wellness_classes 
          SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false, locally_edited = true, app_last_modified_at = NOW()
          WHERE needs_review = true AND is_active = true`);
      }
      if (eCount > 0) {
        await db.execute(sql`UPDATE events SET needs_review = false WHERE needs_review = true`);
      }
      
      logFromRequest(req, 'approve_all_review_items', 'wellness_classes', undefined, undefined, { wellnessApproved: wCount, eventsApproved: eCount, total, reviewedBy });
    }
    
    res.json({
      success: true,
      message: dryRun
        ? `Found ${total} items needing review: ${wCount} wellness classes, ${eCount} events`
        : `Approved ${total} items: ${wCount} wellness classes, ${eCount} events`,
      wellnessCount: wCount,
      eventCount: eCount,
      total,
      dryRun
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Approve all review items error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/delete-empty-session', isAdmin, async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'recordId is required' });

    await client.query('BEGIN');

    // Verify session exists and has no participants
    const sessionCheck = await client.query(
      'SELECT bs.id FROM booking_sessions bs LEFT JOIN booking_participants bp ON bp.session_id = bs.id WHERE bs.id = $1 GROUP BY bs.id HAVING COUNT(bp.id) = 0',
      [recordId]
    );

    if (sessionCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Session not found or has participants' });
    }

    // Unlink booking requests
    await client.query('UPDATE booking_requests SET session_id = NULL WHERE session_id = $1', [recordId]);

    // Delete the session
    const deleteResult = await client.query('DELETE FROM booking_sessions WHERE id = $1', [recordId]);

    // Verify deletion was successful
    if (deleteResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Session not found or already deleted' });
    }

    await client.query('COMMIT');

    logFromRequest(req, 'delete', 'booking_session', recordId.toString(), 'Deleted empty session', {});

    res.json({ success: true, message: `Deleted empty session #${recordId}` });
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    logger.error('[DataIntegrity] Delete empty session error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  } finally {
    client.release();
  }
});

router.post('/api/data-integrity/fix/merge-stripe-customers', isAdmin, async (req: Request, res) => {
  try {
    const { email, keepCustomerId, removeCustomerId } = req.body;
    if (!email || !keepCustomerId || !removeCustomerId) {
      return res.status(400).json({ success: false, message: 'email, keepCustomerId, and removeCustomerId are required' });
    }

    const result = await db.execute(sql`
      UPDATE users 
      SET stripe_customer_id = ${keepCustomerId}, updated_at = NOW() 
      WHERE LOWER(email) = LOWER(${email}) AND stripe_customer_id = ${removeCustomerId}
    `);

    logFromRequest(req, 'merge_stripe_customers', 'user', undefined, `Merged Stripe customers for ${email}`, {
      email,
      keepCustomerId,
      removeCustomerId,
      rowsUpdated: result.rowCount
    });

    res.json({ success: true, message: `Merged Stripe customer for ${email}: kept ${keepCustomerId}, removed ${removeCustomerId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Merge Stripe customers error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/deactivate-stale-member', isAdmin, async (req: Request, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

    const result = await db.execute(sql`
      UPDATE users 
      SET membership_status = 'inactive', updated_at = NOW() 
      WHERE id = ${userId} AND billing_provider = 'mindbody'
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: `User ${userId} not found or not a MindBody user` });
    }

    logFromRequest(req, 'deactivate_stale_member', 'user', userId.toString(), 'Deactivated stale MindBody member', { userId });

    res.json({ success: true, message: `Deactivated MindBody member #${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Deactivate stale member error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

router.post('/api/data-integrity/fix/change-billing-provider', isAdmin, async (req: Request, res) => {
  try {
    const { userId, newProvider } = req.body;
    if (!userId || !newProvider) return res.status(400).json({ success: false, message: 'userId and newProvider are required' });

    const validProviders = ['stripe', 'manual', 'comped'];
    if (!validProviders.includes(newProvider)) {
      return res.status(400).json({ success: false, message: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }

    const result = await db.execute(sql`
      UPDATE users 
      SET billing_provider = ${newProvider}, updated_at = NOW() 
      WHERE id = ${userId}
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: `User ${userId} not found` });
    }

    logFromRequest(req, 'change_billing_provider', 'user', userId.toString(), `Changed billing provider to ${newProvider}`, { userId, newProvider });

    res.json({ success: true, message: `Changed billing provider to ${newProvider} for user #${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Change billing provider error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

export default router;

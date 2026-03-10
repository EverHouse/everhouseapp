import { logger } from '../core/logger';
import { Router } from 'express';
import { isAdmin } from '../core/middleware';
import { runAllIntegrityChecks, getIntegritySummary, getIntegrityHistory, resolveIssue, getAuditLog, syncPush, syncPull, createIgnoreRule, createBulkIgnoreRules, removeIgnoreRule, getIgnoredIssues, getCachedIntegrityResults, runDataCleanup } from '../core/dataIntegrity';
import { pool, safeRelease } from '../core/db';
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
import { getErrorMessage, safeErrorDetail } from '../utils/errorUtils';
import { validateBody } from '../middleware/validate';
import { resolveIssueSchema, syncPushPullSchema, ignoreIssueSchema, bulkIgnoreSchema, placeholderDeleteSchema, recordIdSchema, userIdSchema, unlinkHubspotSchema, mergeHubspotSchema, mergeStripeSchema, changeBillingProviderSchema, acceptTierSchema, reviewItemSchema, assignSessionOwnerSchema, cancelOrphanedPiSchema, dryRunSchema, updateTourStatusSchema, clearStripeIdSchema, deleteOrphanByEmailSchema } from '../../shared/validators/dataIntegrity';
import { queueIntegrityFixSync } from '../core/hubspot/queueHelpers';

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
    logger.error('[DataIntegrity] Cached results error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get cached results', details: safeErrorDetail(error) });
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
    logger.error('[DataIntegrity] Run error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run integrity checks', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-integrity/summary', isAdmin, async (req, res) => {
  try {
    const summary = await getIntegritySummary();
    res.json(summary);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Summary error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get integrity summary', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-integrity/history', isAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const historyData = await getIntegrityHistory(days);
    res.json(historyData);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] History error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get integrity history', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/resolve', isAdmin, validateBody(resolveIssueSchema), async (req: Request, res) => {
  try {
    const { issue_key, resolution_method, notes, action } = req.body;
    
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    const result = await resolveIssue({
      issueKey: issue_key,
      action,
      actionBy: staffEmail,
      resolutionMethod: resolution_method,
      notes: notes
    });
    
    res.json({ success: true, auditLogId: result.auditLogId });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Resolve error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to resolve issue', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-integrity/audit-log', isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const auditEntries = await getAuditLog(limit);
    res.json(auditEntries);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Audit log error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get audit log', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/sync-push', isAdmin, validateBody(syncPushPullSchema), async (req: Request, res) => {
  try {
    const { issue_key, target, user_id, hubspot_contact_id, stripe_customer_id } = req.body;
    
    const result = await syncPush({
      issueKey: issue_key,
      target,
      userId: user_id,
      hubspotContactId: hubspot_contact_id,
      stripeCustomerId: stripe_customer_id
    });
    
    // Broadcast update so other staff dashboards refresh
    broadcastDataIntegrityUpdate('data_changed', { source: `sync_push_${target}` });
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Sync push error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to push sync', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/sync-pull', isAdmin, validateBody(syncPushPullSchema), async (req: Request, res) => {
  try {
    const { issue_key, target, user_id, hubspot_contact_id, stripe_customer_id } = req.body;
    
    const result = await syncPull({
      issueKey: issue_key,
      target,
      userId: user_id,
      hubspotContactId: hubspot_contact_id,
      stripeCustomerId: stripe_customer_id
    });
    
    // Broadcast update so other staff dashboards refresh
    broadcastDataIntegrityUpdate('data_changed', { source: `sync_pull_${target}` });
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Sync pull error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to pull sync', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-integrity/ignores', isAdmin, async (req, res) => {
  try {
    const ignores = await getIgnoredIssues();
    res.json(ignores);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Get ignores error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get ignored issues', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/ignore', isAdmin, validateBody(ignoreIssueSchema), async (req: Request, res) => {
  try {
    const { issue_key, duration, reason } = req.body;
    
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    const result = await createIgnoreRule({
      issueKey: issue_key,
      duration,
      reason: reason.trim(),
      ignoredBy: staffEmail
    });
    
    res.json({ success: true, ignore: result });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Create ignore error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create ignore rule', details: safeErrorDetail(error) });
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
    logger.error('[DataIntegrity] Remove ignore error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove ignore rule', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/ignore-bulk', isAdmin, validateBody(bulkIgnoreSchema), async (req: Request, res) => {
  try {
    const { issue_keys, duration, reason } = req.body;
    
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
    logger.error('[DataIntegrity] Bulk ignore error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create bulk ignore rules', details: safeErrorDetail(error) });
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
    logger.error('[DataIntegrity] Stripe metadata sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync Stripe metadata', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/cleanup', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Starting data cleanup...');
    const result = await runDataCleanup();
    
    res.json({ 
      success: true, 
      message: `Cleanup complete: Removed ${result.orphanedNotifications} orphaned notifications, marked ${result.orphanedBookings} orphaned bookings, normalized ${result.normalizedEmails} emails, removed ${result.expiredHolds} expired guest pass holds.`,
      ...result
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Data cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run data cleanup', details: safeErrorDetail(error) });
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
           OR email LIKE 'anonymous@%'
           OR email LIKE 'private-event@%'
           OR email LIKE '%@resolved%'
           OR email LIKE '%@placeholder.%'
           OR email LIKE '%@test.local%'
           OR email LIKE '%@example.com%'
           OR email LIKE 'placeholder@%'
           OR email LIKE 'test@%'
           OR email LIKE 'test-admin%'
           OR email LIKE 'test-member%'
           OR email LIKE 'test-staff%'
           OR email LIKE 'testaccount@%'
           OR email LIKE 'testguest@%'
           OR email LIKE 'notif-test-%'
           OR email LIKE 'notification-test-%'
           OR email LIKE '%+test%@%'
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
    logger.error('[DataIntegrity] Placeholder scan error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to scan for placeholder accounts', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/placeholder-accounts/delete', isAdmin, validateBody(placeholderDeleteSchema), async (req: Request, res) => {
  try {
    const { stripeCustomerIds, hubspotContactIds, localDatabaseUserIds } = req.body;
    
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
          
          // Delete related bookings for this placeholder user (by email and user_id)
          await client.query(
            'DELETE FROM booking_requests WHERE LOWER(user_email) = LOWER($1) OR user_id = $2',
            [userEmail, userId]
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
          safeRelease(client);
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
    logger.error('[DataIntegrity] Placeholder delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete placeholder accounts', details: safeErrorDetail(error) });
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
    logger.error('[DataIntegrity] Health check error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check system health', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/unlink-hubspot', isAdmin, validateBody(unlinkHubspotSchema), async (req: Request, res) => {
  try {
    const { userId, hubspotContactId } = req.body;
    
    await db.execute(sql`UPDATE users SET hubspot_id = NULL, updated_at = NOW() WHERE id = ${userId}`);
    
    logFromRequest(req, 'unlink_hubspot_contact', 'user', userId, undefined, {
      hubspotContactId,
      unlinkedUserId: userId
    });
    
    res.json({ success: true, message: `Unlinked HubSpot contact from user ${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Unlink HubSpot error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/merge-hubspot-duplicates', isAdmin, validateBody(mergeHubspotSchema), async (req: Request, res) => {
  try {
    const { primaryUserId, secondaryUserId, hubspotContactId } = req.body;
    
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
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-guest-pass', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`DELETE FROM guest_passes WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_guest_pass', 'guest_passes', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned guest pass ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete guest pass error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-fee-snapshot', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_fee_snapshot', 'booking_fee_snapshots', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned fee snapshot ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete fee snapshot error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/dismiss-trackman-unmatched', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    const staffEmail = getSessionUser(req)?.email || 'admin';
    
    await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_by = ${staffEmail} WHERE id = ${recordId} AND resolved_at IS NULL`);
    
    logFromRequest(req, 'dismiss', 'trackman_unmatched', undefined, 'Trackman unmatched #' + recordId, { action: 'dismiss_from_integrity' });
    
    res.json({ success: true, message: 'Unmatched booking dismissed' });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Dismiss trackman unmatched error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-booking-participant', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`DELETE FROM booking_participants WHERE id = ${recordId}`);
    
    logFromRequest(req, 'delete_orphan_booking_participant', 'booking_participants', recordId, undefined, { deletedId: recordId });
    
    res.json({ success: true, message: `Deleted orphaned booking participant ${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete booking participant error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/fix-orphaned-participants', isAdmin, validateBody(dryRunSchema), async (req: Request, res) => {
  try {
    const { dryRun } = req.body;
    
    const invalidParticipants = await db.execute(sql`
      SELECT bp.id, bp.user_id, bp.display_name, bp.participant_type, bp.session_id
      FROM booking_participants bp
      LEFT JOIN users u ON bp.user_id = u.id
      WHERE bp.user_id IS NOT NULL AND bp.user_id != '' AND u.id IS NULL
    `);
    
    interface OrphanedParticipantRow { id: number; user_id: string; display_name: string; participant_type: string; session_id: number }
    const rows = invalidParticipants.rows as unknown as OrphanedParticipantRow[];
    
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
        const matchedUser = emailMatch.rows[0] as { id: string; email: string };
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
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/convert-participant-to-guest', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;
    
    await db.execute(sql`
      UPDATE booking_participants 
      SET user_id = NULL, participant_type = 'guest'
      WHERE id = ${recordId}
    `);
    
    logFromRequest(req, 'convert_participant_to_guest', 'booking_participants', recordId, undefined, { convertedId: recordId });
    
    res.json({ success: true, message: `Converted participant ${recordId} to guest` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Convert participant to guest error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/approve-review-item', isAdmin, validateBody(reviewItemSchema), async (req: Request, res) => {
  try {
    const { recordId, table } = req.body;
    
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    if (table === 'wellness_classes') {
      await db.execute(sql`UPDATE wellness_classes 
        SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false, locally_edited = true, app_last_modified_at = NOW()
        WHERE id = ${recordId}`);
    } else if (table === 'events') {
      await db.execute(sql`UPDATE events SET needs_review = false WHERE id = ${recordId}`);
    }
    
    logFromRequest(req, 'approve_review_item', table as ResourceType, recordId, undefined, { table, reviewedBy });
    
    res.json({ success: true, message: `Approved ${table === 'wellness_classes' ? 'wellness class' : 'event'} #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Approve review item error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-review-item', isAdmin, validateBody(reviewItemSchema), async (req: Request, res) => {
  try {
    const { recordId, table } = req.body;
    
    if (table === 'wellness_classes') {
      await db.execute(sql`UPDATE wellness_classes SET is_active = false, updated_at = NOW() WHERE id = ${recordId}`);
    } else if (table === 'events') {
      await db.execute(sql`DELETE FROM events WHERE id = ${recordId}`);
    }
    
    logFromRequest(req, 'delete_review_item', table as ResourceType, recordId, undefined, { table });
    
    res.json({ success: true, message: `Removed ${table === 'wellness_classes' ? 'wellness class' : 'event'} #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete review item error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/approve-all-review-items', isAdmin, validateBody(dryRunSchema), async (req: Request, res) => {
  try {
    const { dryRun } = req.body;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const wellnessCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM wellness_classes WHERE needs_review = true AND is_active = true`);
    const eventCount = await db.execute(sql`SELECT COUNT(*)::int as count FROM events WHERE needs_review = true`);
    
    const wCount = (wellnessCount.rows[0] as { count: number })?.count || 0;
    const eCount = (eventCount.rows[0] as { count: number })?.count || 0;
    const total = Number(wCount) + Number(eCount);
    
    if (!dryRun) {
      if (Number(wCount) > 0) {
        await db.execute(sql`UPDATE wellness_classes 
          SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false, locally_edited = true, app_last_modified_at = NOW()
          WHERE needs_review = true AND is_active = true`);
      }
      if (Number(eCount) > 0) {
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
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-empty-session', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { recordId } = req.body;

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
    } catch (rollbackErr) { logger.warn('[DB] Rollback failed:', rollbackErr); }
    logger.error('[DataIntegrity] Delete empty session error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/assign-session-owner', isAdmin, validateBody(assignSessionOwnerSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { sessionId, ownerEmail, additional_players } = req.body;

    const session = await client.query(
      `SELECT bs.id, bs.resource_id, bs.session_date, bs.start_time, bs.end_time, r.name as resource_name
       FROM booking_sessions bs
       LEFT JOIN resources r ON bs.resource_id = r.id
       WHERE bs.id = $1`,
      [sessionId]
    );
    if (!session.rows.length) return res.status(404).json({ success: false, message: 'Session not found' });

    const user = await client.query(
      `SELECT id, email, first_name, last_name, membership_tier FROM users WHERE LOWER(email) = LOWER($1)`,
      [ownerEmail]
    );
    if (!user.rows.length) return res.status(404).json({ success: false, message: 'Member not found' });

    const member = user.rows[0];
    const sess = session.rows[0];

    await client.query('BEGIN');

    const existingParticipant = await client.query(
      `SELECT id FROM booking_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, member.id]
    );

    if (existingParticipant.rows.length === 0) {
      await client.query(
        `INSERT INTO booking_participants (session_id, user_id, display_name, participant_type, created_at)
         VALUES ($1, $2, $3, 'member', NOW())`,
        [sessionId, member.id, [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email]
      );
    }

    let bookingId: number | null = null;
    const linkedBooking = await client.query(
      `SELECT id FROM booking_requests WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );
    if (linkedBooking.rows.length > 0) {
      bookingId = linkedBooking.rows[0].id;
      await client.query(
        `UPDATE booking_requests SET user_id = $1, user_email = $2, user_name = $3 WHERE id = $4 AND (user_email IS NULL OR user_email = '')`,
        [member.id, member.email, [member.first_name, member.last_name].filter(Boolean).join(' '), bookingId]
      );
    }

    if (Array.isArray(additional_players) && additional_players.length > 0) {
      const rpEntries = additional_players.map((p: { type: string; email?: string; name?: string; userId?: string; guest_name?: string }) => {
        if (p.type === 'guest_placeholder') {
          return { type: 'guest', name: p.guest_name || p.name || 'Guest' };
        }
        return { type: p.type === 'visitor' ? 'visitor' : 'member', email: p.email, name: p.name, userId: p.userId };
      });

      for (const rp of rpEntries) {
        if (rp.type === 'guest') {
          await client.query(
            `INSERT INTO booking_participants (session_id, display_name, participant_type, created_at)
             VALUES ($1, $2, 'guest', NOW())`,
            [sessionId, rp.name || 'Guest']
          );
        } else if (rp.email) {
          const playerUser = await client.query(
            `SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
            [rp.email]
          );
          if (playerUser.rows.length > 0) {
            const pu = playerUser.rows[0];
            await client.query(
              `INSERT INTO booking_participants (session_id, user_id, display_name, participant_type, created_at)
               VALUES ($1, $2, $3, 'member', NOW())
               ON CONFLICT DO NOTHING`,
              [sessionId, pu.id, [pu.first_name, pu.last_name].filter(Boolean).join(' ') || pu.email]
            );
          }
        }
      }

      if (bookingId) {
        await client.query(
          `UPDATE booking_requests SET request_participants = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(rpEntries), bookingId]
        );
      }

      logger.info('[DataIntegrity] Saved additional players for session owner assignment', {
        extra: { sessionId, bookingId, playerCount: rpEntries.length }
      });
    }

    await client.query('COMMIT');

    const displayName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;
    logFromRequest(req, 'assign_session', 'booking_session', String(sessionId),
      `Assigned ${displayName} as owner of session #${sessionId} on ${sess.session_date} (${sess.resource_name})`,
      { memberEmail: member.email, sessionDate: sess.session_date }
    );

    res.json({ success: true, message: `Assigned ${displayName} to session on ${sess.session_date} at ${sess.resource_name}` });
  } catch (error: unknown) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr: unknown) { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); }
    logger.error('[DataIntegrity] Assign session owner error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/merge-stripe-customers', isAdmin, validateBody(mergeStripeSchema), async (req: Request, res) => {
  try {
    const { keepCustomerId, removeCustomerId } = req.body;
    const email = req.body.email.trim().toLowerCase();

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
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/deactivate-stale-member', isAdmin, validateBody(userIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET membership_status = 'inactive', updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $2
       WHERE id = $1 AND billing_provider = 'mindbody'
       RETURNING email, tier`,
      [userId, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `User ${userId} not found or not a MindBody user` });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, status: 'inactive', tier: result.rows[0]?.tier || '', fixAction: 'deactivate_stale', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'deactivate_stale_member', 'user', userId.toString(), 'Deactivated stale MindBody member', { userId });

    res.json({ success: true, message: `Deactivated MindBody member #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Deactivate stale member error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/change-billing-provider', isAdmin, validateBody(changeBillingProviderSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId, newProvider } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET billing_provider = $2, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $3
       WHERE id = $1
       RETURNING email, tier, membership_status`,
      [userId, newProvider, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: `User ${userId} not found` });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, billingProvider: newProvider, tier: result.rows[0]?.tier || '', status: result.rows[0]?.membership_status || '', fixAction: 'change_billing_provider', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'change_billing_provider', 'user', userId.toString(), `Changed billing provider to ${newProvider}`, { userId, newProvider });

    res.json({ success: true, message: `Changed billing provider to ${newProvider} for user #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Change billing provider error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/delete-member-no-email', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    // Safety check: only delete if the member truly has no email
    const member = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE id = ${recordId}`);
    if (!member.rows.length) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const user = member.rows[0] as { id: string; email: string | null; first_name: string | null; last_name: string | null };
    if (user.email && String(user.email).trim() !== '') {
      return res.status(400).json({ success: false, message: 'This member has an email address. Cannot delete via this endpoint.' });
    }

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';

    const cleanups = [
      sql`DELETE FROM booking_participants WHERE user_id = ${recordId}`,
      sql`DELETE FROM notifications WHERE user_id = ${recordId}`,
      sql`DELETE FROM guest_passes WHERE user_id = ${recordId}`,
      sql`UPDATE event_rsvps SET matched_user_id = NULL WHERE matched_user_id = ${recordId}`,
      sql`UPDATE booking_requests SET user_id = NULL WHERE user_id = ${recordId}`,
      sql`DELETE FROM wellness_enrollments WHERE user_id = ${recordId}`,
      sql`DELETE FROM booking_fee_snapshots WHERE user_id = ${recordId}`,
      sql`DELETE FROM day_pass_purchases WHERE user_id = ${recordId}`,
      sql`DELETE FROM terminal_payments WHERE user_id = ${recordId}`,
      sql`DELETE FROM push_subscriptions WHERE user_id = ${recordId}`,
      sql`DELETE FROM stripe_payment_intents WHERE user_id = ${recordId}`,
    ];

    for (const query of cleanups) {
      try { await db.execute(query); } catch (e) {
        logger.warn('[DataIntegrity] Non-critical cleanup step failed during member delete', { extra: { recordId, error: getErrorMessage(e as Error) } });
      }
    }

    await db.execute(sql`DELETE FROM users WHERE id = ${recordId} AND (email IS NULL OR email = '')`);

    logFromRequest(req, 'delete_member', 'user', String(recordId), `Deleted member without email: "${name}" (id: ${recordId})`, { memberName: name });

    res.json({ success: true, message: `Deleted member "${name}" (id: ${recordId})` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete member without email error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/complete-booking', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`
      UPDATE booking_requests 
      SET status = 'attended', updated_at = NOW() 
      WHERE id = ${recordId} AND status IN ('pending', 'approved', 'confirmed')
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found or not in pending/approved/confirmed status' });
    }

    logFromRequest(req, 'complete_booking', 'booking_request', String(recordId), `Marked booking #${recordId} as attended via data integrity`, { bookingId: recordId });

    res.json({ success: true, message: `Booking #${recordId} marked as attended` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Complete booking error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/cancel-stale-booking', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`
      UPDATE booking_requests 
      SET status = 'cancelled', cancellation_reason = 'Auto-cancelled: stale booking past start time', updated_at = NOW()
      WHERE id = ${recordId} AND status IN ('pending', 'approved')
      RETURNING stripe_invoice_id
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found or not in pending/approved status' });
    }

    const invoiceId = (result.rows[0] as { stripe_invoice_id: string | null })?.stripe_invoice_id;
    if (invoiceId) {
      try {
        const { voidBookingInvoice } = await import('../core/billing/bookingInvoiceService');
        await voidBookingInvoice(recordId);
      } catch (voidErr: unknown) {
        logger.warn('[DataIntegrity] Failed to void invoice for cancelled stale booking', {
          extra: { bookingId: recordId, invoiceId, error: getErrorMessage(voidErr) }
        });
      }
    }

    logFromRequest(req, 'cancel_stale_booking', 'booking_request', String(recordId), `Cancelled stale booking #${recordId} via data integrity`, { bookingId: recordId });

    res.json({ success: true, message: `Stale booking #${recordId} cancelled` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Cancel stale booking error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/bulk-cancel-stale-bookings', isAdmin, async (req: Request, res) => {
  try {
    const result = await db.execute(sql`
      UPDATE booking_requests
      SET status = 'cancelled', cancellation_reason = 'Bulk auto-cancelled: stale booking past start time', updated_at = NOW()
      WHERE status IN ('pending', 'approved')
        AND (request_date + start_time::time) < ((NOW() AT TIME ZONE 'America/Los_Angeles') - INTERVAL '24 hours')
        AND request_date >= CURRENT_DATE - INTERVAL '7 days'
        AND user_email NOT LIKE '%@trackman.local'
      RETURNING id, stripe_invoice_id
    `);

    const count = result.rowCount || 0;

    const invoiceRows = (result.rows as { id: number; stripe_invoice_id: string | null }[]).filter(r => r.stripe_invoice_id);

    logFromRequest(req, 'bulk_cancel_stale_bookings', 'booking_request', undefined, `Bulk cancelled ${count} stale bookings via data integrity`, { cancelledCount: count, invoicesToVoid: invoiceRows.length });

    res.json({ success: true, message: `Cancelled ${count} stale bookings (${invoiceRows.length} invoices voiding in background)`, cancelledCount: count });

    if (invoiceRows.length > 0) {
      const { voidBookingInvoice } = await import('../core/billing/bookingInvoiceService');
      let voided = 0;
      for (const row of invoiceRows) {
        try {
          await voidBookingInvoice(row.id);
          voided++;
        } catch (voidErr: unknown) {
          logger.warn('[DataIntegrity] Failed to void invoice during bulk stale cancel', {
            extra: { bookingId: row.id, invoiceId: row.stripe_invoice_id, error: getErrorMessage(voidErr) }
          });
        }
      }
      logger.info(`[DataIntegrity] Bulk stale cancel invoice cleanup complete: ${voided}/${invoiceRows.length} voided`);
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Bulk cancel stale bookings error', { extra: { error: getErrorMessage(error) } });
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
    }
  }
});

router.post('/api/data-integrity/fix/bulk-attend-stale-bookings', isAdmin, async (req: Request, res) => {
  try {
    const result = await db.execute(sql`
      UPDATE booking_requests
      SET status = 'attended', updated_at = NOW()
      WHERE status IN ('pending', 'approved')
        AND (request_date + start_time::time) < ((NOW() AT TIME ZONE 'America/Los_Angeles') - INTERVAL '24 hours')
        AND request_date >= CURRENT_DATE - INTERVAL '7 days'
        AND user_email NOT LIKE '%@trackman.local'
      RETURNING id
    `);

    const count = result.rowCount || 0;

    logFromRequest(req, 'bulk_attend_stale_bookings', 'booking_request', undefined, `Bulk marked ${count} stale bookings as attended via data integrity`, { attendedCount: count });

    res.json({ success: true, message: `Marked ${count} stale bookings as attended`, attendedCount: count });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Bulk attend stale bookings error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/activate-stuck-member', isAdmin, validateBody(userIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET membership_status = 'active', updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $2
       WHERE id = $1 AND membership_status IN ('pending', 'non-member')
       RETURNING email, tier`,
      [userId, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found or not in pending/non-member status' });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, status: 'active', tier: result.rows[0]?.tier || '', fixAction: 'activate_stuck', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'activate_stuck_member', 'user', String(userId), `Activated stuck member #${userId} via data integrity`, { userId });

    res.json({ success: true, message: `Activated stuck member #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Activate stuck member error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/recalculate-guest-passes', isAdmin, validateBody(userIdSchema), async (req: Request, res) => {
  try {
    const { userId } = req.body;

    await db.execute(sql`
      UPDATE guest_passes gp
      SET passes_used = COALESCE((
        SELECT COUNT(*)
        FROM booking_participants bp
        JOIN booking_sessions bs ON bp.session_id = bs.id
        JOIN booking_requests br ON br.session_id = bs.id
        WHERE bp.guest_pass_id = gp.id
          AND bp.used_guest_pass = true
          AND br.status NOT IN ('cancelled', 'rejected', 'deleted')
      ), 0)
      WHERE gp.user_id = ${userId}
    `);

    logFromRequest(req, 'recalculate_guest_passes', 'guest_pass', String(userId), `Recalculated guest passes for user #${userId} via data integrity`, { userId });

    res.json({ success: true, message: `Recalculated guest passes for user #${userId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Recalculate guest passes error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/release-guest-pass-hold', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`DELETE FROM guest_pass_holds WHERE id = ${recordId}`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Guest pass hold not found' });
    }

    logFromRequest(req, 'release_guest_pass_hold', 'guest_pass', String(recordId), `Released guest pass hold #${recordId} via data integrity`, { holdId: recordId });

    res.json({ success: true, message: `Released guest pass hold #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Release guest pass hold error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/cancel-orphaned-pi', isAdmin, validateBody(cancelOrphanedPiSchema), async (req: Request, res) => {
  try {
    const { paymentIntentId } = req.body;

    const stripe = await getStripeClient();
    try {
      await stripe.paymentIntents.cancel(paymentIntentId);
    } catch (stripeError: unknown) {
      const msg = getErrorMessage(stripeError);
      if (msg.includes('already been canceled') || msg.includes('already_canceled') || msg.includes('cannot be canceled')) {
        logFromRequest(req, 'cancel_orphaned_pi', 'payment_intent', paymentIntentId, `Payment intent ${paymentIntentId} was already cancelled`, { paymentIntentId, alreadyCancelled: true });
      } else {
        throw stripeError;
      }
    }

    const snapshotResult = await db.execute(sql`
      UPDATE booking_fee_snapshots 
      SET status = 'cancelled', updated_at = NOW()
      WHERE stripe_payment_intent_id = ${paymentIntentId}
        AND status IN ('pending', 'requires_action')
      RETURNING id
    `);
    const updatedCount = snapshotResult.rows.length;

    logFromRequest(req, 'cancel_orphaned_pi', 'payment_intent', paymentIntentId, `Cancelled orphaned payment intent ${paymentIntentId} and updated ${updatedCount} fee snapshot(s)`, { paymentIntentId, updatedSnapshots: updatedCount });

    res.json({ success: true, message: `Cancelled payment intent ${paymentIntentId} and updated ${updatedCount} fee snapshot(s)` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Cancel orphaned PI error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-orphan-enrollment', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`DELETE FROM wellness_enrollments WHERE id = ${recordId}`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Wellness enrollment not found' });
    }

    logFromRequest(req, 'delete_orphan_enrollment', 'wellness_enrollment', String(recordId), `Deleted orphaned wellness enrollment #${recordId} via data integrity`, { enrollmentId: recordId });

    res.json({ success: true, message: `Deleted orphaned wellness enrollment #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete orphan enrollment error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-orphan-rsvp', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(sql`DELETE FROM event_rsvps WHERE id = ${recordId}`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Event RSVP not found' });
    }

    logFromRequest(req, 'delete_orphan_rsvp', 'event_rsvp', String(recordId), `Deleted orphaned event RSVP #${recordId} via data integrity`, { rsvpId: recordId });

    res.json({ success: true, message: `Deleted orphaned event RSVP #${recordId}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete orphan RSVP error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/delete-orphan-records-by-email', isAdmin, validateBody(deleteOrphanByEmailSchema), async (req: Request, res) => {
  try {
    const { table, email } = req.body;

    const columnMap: Record<string, string> = {
      notifications: 'user_email',
      push_subscriptions: 'user_email',
      user_dismissed_notices: 'user_email',
    };
    const emailColumn = columnMap[table];

    const result = await pool.query(
      `DELETE FROM ${table} WHERE LOWER(${emailColumn}) = LOWER($1) AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER($1))`,
      [email]
    );

    const deleted = result.rowCount || 0;
    logFromRequest(req, 'delete_orphan_records', table, email, `Deleted ${deleted} orphaned ${table} records for email ${email} via data integrity`, { email, table, deleted });

    res.json({ success: true, message: `Deleted ${deleted} orphaned record(s) from ${table}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Delete orphan records by email error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/mark-waiver-signed', isAdmin, validateBody(recordIdSchema), async (req: Request, res) => {
  try {
    const { recordId } = req.body;

    const result = await db.execute(
      sql`UPDATE users SET waiver_signed_at = NOW(), waiver_version = 'staff_marked', updated_at = NOW() WHERE id = ${recordId} AND membership_status = 'active'`
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Active member not found' });
    }

    logFromRequest(req, 'mark_waiver_signed', 'user', String(recordId), `Marked waiver as signed for member ${recordId} via data integrity`, { userId: recordId });

    res.json({ success: true, message: 'Waiver marked as signed' });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Mark waiver signed error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/mark-all-waivers-signed', isAdmin, async (req: Request, res) => {
  try {
    const result = await db.execute(
      sql`UPDATE users SET waiver_signed_at = NOW(), waiver_version = 'staff_marked', updated_at = NOW() WHERE membership_status = 'active' AND role = 'member' AND (waiver_signed_at IS NULL AND waiver_version IS NULL) AND created_at < NOW() - INTERVAL '7 days'`
    );

    const count = result.rowCount || 0;
    logFromRequest(req, 'mark_all_waivers_signed', 'user', 'bulk', `Marked ${count} active members as waiver signed via data integrity bulk action`, { count });

    res.json({ success: true, message: `Marked ${count} member${count === 1 ? '' : 's'} as waiver signed`, count });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Mark all waivers signed error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/accept-tier', isAdmin, validateBody(acceptTierSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId, acceptedTier, source } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET tier = $2, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $3
       WHERE id = $1
       RETURNING email, membership_status`,
      [userId, acceptedTier, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await client.query('COMMIT');

    const userEmail = result.rows[0]?.email;
    if (userEmail) {
      queueIntegrityFixSync({ email: userEmail, tier: acceptedTier, status: result.rows[0]?.membership_status || '', fixAction: 'accept_tier', performedBy: staffEmail }).catch(err => logger.warn('[DataIntegrity] HubSpot sync queue failed', { extra: { error: getErrorMessage(err) } }));
    }

    logFromRequest(req, 'accept_tier', 'user', String(userId), `Accepted tier "${acceptedTier}" from ${source} for user #${userId} via data integrity`, { userId, acceptedTier, source });

    res.json({ success: true, message: `Accepted tier "${acceptedTier}" from ${source} for user #${userId}` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Accept tier error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

router.post('/api/data-integrity/fix/update-tour-status', isAdmin, validateBody(updateTourStatusSchema), async (req: Request, res) => {
  try {
    const { recordId, newStatus } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    const result = await db.execute(sql`
      UPDATE tours 
      SET status = ${newStatus}, updated_at = NOW()
      WHERE id = ${Number(recordId)}
      RETURNING id, title, guest_name
    `);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Tour not found' });
    }

    const tour = result.rows[0] as { id: number; title: string; guest_name: string };
    logFromRequest(req, 'update_tour_status', 'tour', String(recordId), `Updated tour #${recordId} "${tour.title}" to "${newStatus}" via data integrity`, { recordId, newStatus });

    res.json({ success: true, message: `Tour "${tour.title}" marked as ${newStatus.replace('_', ' ')}` });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Update tour status error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-integrity/fix/clear-stripe-customer-id', isAdmin, validateBody(clearStripeIdSchema), async (req: Request, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [userId]);

    const result = await client.query(
      `UPDATE users 
       SET stripe_customer_id = NULL, updated_at = NOW(),
           last_manual_fix_at = NOW(), last_manual_fix_by = $2
       WHERE id = $1
       RETURNING email, first_name, last_name`,
      [userId, staffEmail]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await client.query('COMMIT');

    const user = result.rows[0];
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
    logFromRequest(req, 'clear_stripe_customer_id', 'user', String(userId), `Cleared orphaned Stripe customer ID for "${memberName}" via data integrity`, { userId });

    res.json({ success: true, message: `Cleared Stripe customer ID for "${memberName}"` });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => { logger.warn('[DataIntegrity] Rollback failed', { error: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)) }); });
    logger.error('[DataIntegrity] Clear Stripe customer ID error', { extra: { error: getErrorMessage(error) } });
    res.status(500).json({ success: false, message: 'Operation failed', details: safeErrorDetail(error) });
  } finally {
    safeRelease(client);
  }
});

export default router;

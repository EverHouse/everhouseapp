import { Router } from 'express';
import { isAdmin } from '../core/middleware';
import { runAllIntegrityChecks, getIntegritySummary, getIntegrityHistory, resolveIssue, getAuditLog, syncPush, syncPull, createIgnoreRule, createBulkIgnoreRules, removeIgnoreRule, getIgnoredIssues, getCachedIntegrityResults, runDataCleanup } from '../core/dataIntegrity';
import { isProduction, pool } from '../core/db';
import { broadcastDataIntegrityUpdate } from '../core/websocket';
import { syncAllCustomerMetadata, isPlaceholderEmail } from '../core/stripe/customers';
import { getStripeClient } from '../core/stripe/client';
import { getHubSpotClientWithFallback } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { logFromRequest } from '../core/auditLog';
import { getSystemHealth } from '../core/healthCheck';
import { getSessionUser } from '../types/session';
import type { Request } from 'express';

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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Cached results error:', error);
    res.status(500).json({ error: 'Failed to get cached results', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Run error:', error);
    res.status(500).json({ error: 'Failed to run integrity checks', details: error.message });
  }
});

router.get('/api/data-integrity/summary', isAdmin, async (req, res) => {
  try {
    const summary = await getIntegritySummary();
    res.json(summary);
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Summary error:', error);
    res.status(500).json({ error: 'Failed to get integrity summary', details: error.message });
  }
});

router.get('/api/data-integrity/history', isAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const historyData = await getIntegrityHistory(days);
    res.json(historyData);
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] History error:', error);
    res.status(500).json({ error: 'Failed to get integrity history', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve issue', details: error.message });
  }
});

router.get('/api/data-integrity/audit-log', isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const auditEntries = await getAuditLog(limit);
    res.json(auditEntries);
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Audit log error:', error);
    res.status(500).json({ error: 'Failed to get audit log', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Sync push error:', error);
    res.status(500).json({ error: 'Failed to push sync', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Sync pull error:', error);
    res.status(500).json({ error: 'Failed to pull sync', details: error.message });
  }
});

router.get('/api/data-integrity/ignores', isAdmin, async (req, res) => {
  try {
    const ignores = await getIgnoredIssues();
    res.json(ignores);
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Get ignores error:', error);
    res.status(500).json({ error: 'Failed to get ignored issues', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Create ignore error:', error);
    res.status(500).json({ error: 'Failed to create ignore rule', details: error.message });
  }
});

router.delete('/api/data-integrity/ignore/:issueKey', isAdmin, async (req: Request, res) => {
  try {
    const { issueKey } = req.params;
    
    if (!issueKey) {
      return res.status(400).json({ error: 'issueKey is required' });
    }
    
    const result = await removeIgnoreRule(issueKey);
    
    if (!result.removed) {
      return res.status(404).json({ error: 'Ignore rule not found' });
    }
    
    res.json({ success: true, message: 'Ignore rule removed' });
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Remove ignore error:', error);
    res.status(500).json({ error: 'Failed to remove ignore rule', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Bulk ignore error:', error);
    res.status(500).json({ error: 'Failed to create bulk ignore rules', details: error.message });
  }
});

router.post('/api/data-integrity/sync-stripe-metadata', isAdmin, async (req, res) => {
  try {
    console.log('[DataIntegrity] Starting Stripe customer metadata sync...');
    const result = await syncAllCustomerMetadata();
    
    res.json({ 
      success: true, 
      message: `Synced ${result.synced} customers to Stripe. ${result.failed} failed.`,
      synced: result.synced,
      failed: result.failed
    });
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Stripe metadata sync error:', error);
    res.status(500).json({ error: 'Failed to sync Stripe metadata', details: error.message });
  }
});

router.post('/api/data-integrity/cleanup', isAdmin, async (req, res) => {
  try {
    console.log('[DataIntegrity] Starting data cleanup...');
    const result = await runDataCleanup();
    
    res.json({ 
      success: true, 
      message: `Cleanup complete: Removed ${result.orphanedNotifications} orphaned notifications, marked ${result.orphanedBookings} orphaned bookings, normalized ${result.normalizedEmails} emails.`,
      ...result
    });
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Data cleanup error:', error);
    res.status(500).json({ error: 'Failed to run data cleanup', details: error.message });
  }
});

router.get('/api/data-integrity/placeholder-accounts', isAdmin, async (req, res) => {
  try {
    console.log('[DataIntegrity] Scanning for placeholder accounts...');
    
    const stripeCustomers: { id: string; email: string; name: string | null; created: number }[] = [];
    const hubspotContacts: { id: string; email: string; name: string }[] = [];
    const localDatabaseUsers: { id: string; email: string; name: string; status: string; createdAt: string }[] = [];
    
    // Scan local database for placeholder accounts
    try {
      const localResult = await pool.query(`
        SELECT id, email, first_name, last_name, membership_status, created_at
        FROM users 
        WHERE email LIKE '%@visitors.evenhouse.club%'
           OR email LIKE '%@trackman.local%'
           OR email LIKE 'unmatched-%'
           OR email LIKE 'golfnow-%'
           OR email LIKE 'classpass-%'
           OR email LIKE 'lesson-%'
           OR email LIKE 'anonymous-%'
           OR email LIKE '%@placeholder.%'
           OR email LIKE '%@test.local%'
        ORDER BY created_at DESC
      `);
      
      for (const row of localResult.rows) {
        localDatabaseUsers.push({
          id: row.id,
          email: row.email,
          name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email,
          status: row.membership_status,
          createdAt: row.created_at?.toISOString() || '',
        });
      }
    } catch (dbError: any) {
      console.warn('[DataIntegrity] Local database scan failed:', dbError.message);
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
            name: customer.name,
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
    } catch (hubspotError: any) {
      console.warn('[DataIntegrity] HubSpot scan failed:', hubspotError.message);
    }
    
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Placeholder scan error:', error);
    res.status(500).json({ error: 'Failed to scan for placeholder accounts', details: error.message });
  }
});

router.post('/api/data-integrity/placeholder-accounts/delete', isAdmin, async (req: Request, res) => {
  try {
    const { stripeCustomerIds, hubspotContactIds, localDatabaseUserIds } = req.body;
    
    if (!Array.isArray(stripeCustomerIds) && !Array.isArray(hubspotContactIds) && !Array.isArray(localDatabaseUserIds)) {
      return res.status(400).json({ error: 'Must provide stripeCustomerIds, hubspotContactIds, or localDatabaseUserIds arrays' });
    }
    
    console.log(`[DataIntegrity] Deleting ${stripeCustomerIds?.length || 0} Stripe customers, ${hubspotContactIds?.length || 0} HubSpot contacts, and ${localDatabaseUserIds?.length || 0} local database users...`);
    
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
        } catch (error: any) {
          results.stripeFailed++;
          results.stripeErrors.push(`${customerId}: ${error.message}`);
        }
      }
    }
    
    if (hubspotContactIds?.length > 0) {
      try {
        const { client: hubspot } = await getHubSpotClientWithFallback();
        
        for (const contactId of hubspotContactIds) {
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.archive(contactId)
            );
            results.hubspotDeleted++;
          } catch (error: any) {
            results.hubspotFailed++;
            results.hubspotErrors.push(`${contactId}: ${error.message}`);
          }
        }
      } catch (hubspotError: any) {
        console.error('[DataIntegrity] HubSpot client failed:', hubspotError.message);
        results.hubspotErrors.push(`HubSpot connection failed: ${hubspotError.message}`);
      }
    }
    
    // Delete local database placeholder users
    if (localDatabaseUserIds?.length > 0) {
      for (const userId of localDatabaseUserIds) {
        try {
          const deleteResult = await pool.query(
            'DELETE FROM users WHERE id = $1 RETURNING email',
            [userId]
          );
          if (deleteResult.rowCount && deleteResult.rowCount > 0) {
            results.localDatabaseDeleted++;
          } else {
            results.localDatabaseFailed++;
            results.localDatabaseErrors.push(`${userId}: User not found`);
          }
        } catch (error: any) {
          results.localDatabaseFailed++;
          results.localDatabaseErrors.push(`${userId}: ${error.message}`);
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Placeholder delete error:', error);
    res.status(500).json({ error: 'Failed to delete placeholder accounts', details: error.message });
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
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Health check error:', error);
    res.status(500).json({ error: 'Failed to check system health', details: error.message });
  }
});

export default router;

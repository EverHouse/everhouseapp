import { Router } from 'express';
import { isAdmin } from '../core/middleware';
import { runAllIntegrityChecks, getIntegritySummary, getIntegrityHistory, resolveIssue, getAuditLog, syncPush, syncPull, createIgnoreRule, removeIgnoreRule, getIgnoredIssues } from '../core/dataIntegrity';
import { isProduction } from '../core/db';
import type { Request } from 'express';

const router = Router();

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
    
    const staffEmail = (req as any).user?.email || 'unknown';
    
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
    const { issue_key, target, user_id, hubspot_contact_id } = req.body;
    
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
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Sync push error:', error);
    res.status(500).json({ error: 'Failed to push sync', details: error.message });
  }
});

router.post('/api/data-integrity/sync-pull', isAdmin, async (req: Request, res) => {
  try {
    const { issue_key, target, user_id, hubspot_contact_id } = req.body;
    
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
    
    const staffEmail = (req as any).user?.email || 'unknown';
    
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

export default router;

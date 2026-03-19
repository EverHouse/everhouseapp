import { Router } from 'express';
import { z } from 'zod';
import { runAllIntegrityChecks, getIntegritySummary, getIntegrityHistory, resolveIssue, getAuditLog, createIgnoreRule, createBulkIgnoreRules, removeIgnoreRule, getIgnoredIssues, getCachedIntegrityResults } from '../../core/dataIntegrity';
import { logger, isAdmin, validateQuery, validateBody, sendFixError, getSessionUser } from './shared';
import type { Request } from 'express';
import { resolveIssueSchema, ignoreIssueSchema, bulkIgnoreSchema } from '../../../shared/validators/dataIntegrity';

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
    sendFixError(res, error);
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
    sendFixError(res, error);
  }
});

router.get('/api/data-integrity/summary', isAdmin, async (req, res) => {
  try {
    const summary = await getIntegritySummary();
    res.json(summary);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Summary error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error);
  }
});

const historyQuerySchema = z.object({ days: z.string().regex(/^\d+$/).optional() }).passthrough();

router.get('/api/data-integrity/history', isAdmin, validateQuery(historyQuerySchema), async (req, res) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof historyQuerySchema> }).validatedQuery;
    const days = parseInt(vq.days || '', 10) || 30;
    const historyData = await getIntegrityHistory(days);
    res.json(historyData);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] History error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error);
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
    sendFixError(res, error);
  }
});

const auditLogQuerySchema = z.object({ limit: z.string().regex(/^\d+$/).optional() }).passthrough();

router.get('/api/data-integrity/audit-log', isAdmin, validateQuery(auditLogQuerySchema), async (req, res) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof auditLogQuerySchema> }).validatedQuery;
    const limit = parseInt(vq.limit || '', 10) || 10;
    const auditEntries = await getAuditLog(limit);
    res.json(auditEntries);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Audit log error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error);
  }
});

router.get('/api/data-integrity/ignores', isAdmin, async (req, res) => {
  try {
    const ignores = await getIgnoredIssues();
    res.json(ignores);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Get ignores error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
  }
});

export default router;

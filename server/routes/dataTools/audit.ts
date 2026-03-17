import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { adminAuditLog } from '@shared/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { isAdmin } from '../../core/middleware';
import { safeErrorDetail } from '../../utils/errorUtils';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';

const router = Router();

const auditLogQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  actionType: z.string().optional(),
}).passthrough();

router.get('/api/data-tools/audit-log', isAdmin, validateQuery(auditLogQuerySchema), async (req: Request, res: Response) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof auditLogQuerySchema> }).validatedQuery;
    const limitNum = parseInt(vq.limit || '20', 10);
    const actionType = vq.actionType;
    
    const logs = actionType
      ? await db.select()
          .from(adminAuditLog)
          .where(and(eq(adminAuditLog.resourceType, 'billing'), eq(adminAuditLog.action, actionType)))
          .orderBy(desc(adminAuditLog.createdAt))
          .limit(limitNum)
      : await db.select()
          .from(adminAuditLog)
          .where(eq(adminAuditLog.resourceType, 'billing'))
          .orderBy(desc(adminAuditLog.createdAt))
          .limit(limitNum);
    
    res.json(logs.filter(log => 
      ['member_resynced_from_hubspot', 'guest_fee_manually_linked', 'attendance_manually_updated', 'mindbody_reimport_requested'].includes(log.action)
    ));
  } catch (error: unknown) {
    logger.error('[DataTools] Get audit log error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get audit log', details: safeErrorDetail(error) });
  }
});

const staffActivityQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  staff_email: z.string().optional(),
  actions: z.string().optional(),
  actor_type: z.string().optional(),
}).passthrough();

router.get('/api/data-tools/staff-activity', isAdmin, validateQuery(staffActivityQuerySchema), async (req: Request, res: Response) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof staffActivityQuerySchema> }).validatedQuery;
    const limitParam = parseInt(vq.limit || '', 10) || 50;
    const staffEmail = vq.staff_email?.trim()?.toLowerCase();
    const actionsParam = vq.actions;
    const actorType = vq.actor_type;
    
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
    
    const parsedLogs = logs.map(log => ({
      ...log,
      details: typeof log.details === 'string' 
        ? (() => { try { return JSON.parse(log.details); } catch (_err) { logger.debug('Failed to parse log details as JSON'); return log.details; } })()
        : log.details
    }));
    
    res.json({ logs: parsedLogs });
  } catch (error: unknown) {
    logger.error('[DataTools] Get staff activity error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get staff activity', details: safeErrorDetail(error) });
  }
});

export default router;

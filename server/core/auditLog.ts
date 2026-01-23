import { db } from '../db';
import { adminAuditLog, InsertAdminAuditLog } from '../../shared/schema';
import { Request } from 'express';
import { desc, eq, and, gte, lte } from 'drizzle-orm';

export type AuditAction = 
  | 'view_member'
  | 'view_member_profile'
  | 'view_member_billing'
  | 'update_member'
  | 'delete_member'
  | 'archive_member'
  | 'export_member_data'
  | 'view_booking'
  | 'update_booking'
  | 'cancel_booking'
  | 'view_payment'
  | 'process_refund'
  | 'change_tier'
  | 'view_directory'
  | 'export_directory'
  | 'view_report'
  | 'export_report'
  | 'login_as_staff'
  | 'update_settings'
  | 'bulk_action';

export type ResourceType = 
  | 'member'
  | 'booking'
  | 'payment'
  | 'report'
  | 'settings'
  | 'directory'
  | 'billing';

interface AuditLogParams {
  staffEmail: string;
  staffName?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, any>;
  req?: Request;
}

export async function logAdminAction(params: AuditLogParams): Promise<void> {
  const { staffEmail, staffName, action, resourceType, resourceId, resourceName, details, req } = params;
  
  try {
    const entry: InsertAdminAuditLog = {
      staffEmail,
      staffName: staffName || null,
      action,
      resourceType,
      resourceId: resourceId || null,
      resourceName: resourceName || null,
      details: details || null,
      ipAddress: req ? getClientIp(req) : null,
      userAgent: req?.get('user-agent') || null,
    };
    
    await db.insert(adminAuditLog).values(entry);
  } catch (error) {
    console.error('[AuditLog] Failed to log admin action:', error);
  }
}

export function logFromRequest(req: Request, action: AuditAction, resourceType: ResourceType, resourceId?: string, resourceName?: string, details?: Record<string, any>): void {
  const staffEmail = req.session?.user?.email;
  const staffName = req.session?.user?.name;
  
  if (!staffEmail) return;
  
  logAdminAction({
    staffEmail,
    staffName,
    action,
    resourceType,
    resourceId,
    resourceName,
    details,
    req
  }).catch(() => {});
}

function getClientIp(req: Request): string | null {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || null;
}

export async function getAuditLogs(params: {
  staffEmail?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ logs: any[]; total: number }> {
  const { staffEmail, action, resourceType, resourceId, startDate, endDate, limit = 100, offset = 0 } = params;
  
  try {
    const conditions = [];
    
    if (staffEmail) {
      conditions.push(eq(adminAuditLog.staffEmail, staffEmail));
    }
    if (action) {
      conditions.push(eq(adminAuditLog.action, action));
    }
    if (resourceType) {
      conditions.push(eq(adminAuditLog.resourceType, resourceType));
    }
    if (resourceId) {
      conditions.push(eq(adminAuditLog.resourceId, resourceId));
    }
    if (startDate) {
      conditions.push(gte(adminAuditLog.createdAt, startDate));
    }
    if (endDate) {
      conditions.push(lte(adminAuditLog.createdAt, endDate));
    }
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const logs = await db.select()
      .from(adminAuditLog)
      .where(whereClause)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limit)
      .offset(offset);
    
    return { logs, total: logs.length };
  } catch (error) {
    console.error('[AuditLog] Failed to fetch audit logs:', error);
    return { logs: [], total: 0 };
  }
}

export async function cleanupOldAuditLogs(daysToKeep: number = 365): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    const deleted = await db.delete(adminAuditLog)
      .where(lte(adminAuditLog.createdAt, cutoffDate))
      .returning({ id: adminAuditLog.id });
    
    console.log(`[AuditLog] Cleaned up ${deleted.length} old audit log entries`);
    return deleted.length;
  } catch (error) {
    console.error('[AuditLog] Failed to cleanup old audit logs:', error);
    return 0;
  }
}

import { db } from '../db';
import { adminAuditLog, InsertAdminAuditLog } from '../../shared/schema';
import { Request } from 'express';
import { desc, eq, and, gte, lte } from 'drizzle-orm';

import { logger } from './logger';
export type AuditAction = 
  // Member actions
  | 'view_member'
  | 'view_member_profile'
  | 'view_member_billing'
  | 'update_member'
  | 'delete_member'
  | 'delete_visitor'
  | 'archive_member'
  | 'export_member_data'
  | 'create_member'
  | 'invite_member'
  | 'cleanup_pending_user'
  | 'update_member_notes'
  | 'link_stripe_customer'
  | 'sync_hubspot'
  | 'change_tier'
  // Booking actions
  | 'view_booking'
  | 'update_booking'
  | 'cancel_booking'
  | 'approve_booking'
  | 'decline_booking'
  | 'create_booking'
  | 'reschedule_booking'
  | 'booking_rescheduled'
  | 'mark_no_show'
  | 'mark_attended'
  | 'add_guest_to_booking'
  | 'remove_guest_from_booking'
  | 'link_member_to_booking'
  | 'unlink_member_from_booking'
  | 'change_booking_owner'
  | 'assign_member_to_booking'
  | 'link_trackman_to_member'
  | 'booking_cancelled_webhook'
  | 'booking_cancelled_member'
  // Billing actions
  | 'view_payment'
  | 'process_refund'
  | 'cancel_subscription'
  | 'pause_subscription'
  | 'resume_subscription'
  | 'record_charge'
  | 'send_payment_link'
  | 'update_payment_status'
  | 'apply_credit'
  | 'payment_refunded'
  | 'payment_refund_partial'
  | 'payment_failed'
  | 'payment_succeeded'
  | 'subscription_created'
  | 'new_member_subscription_created'
  | 'activation_link_sent'
  // Tour actions
  | 'tour_checkin'
  | 'tour_completed'
  | 'tour_no_show'
  | 'tour_cancelled'
  | 'tour_status_changed'
  // Event actions
  | 'create_event'
  | 'update_event'
  | 'delete_event'
  | 'sync_events'
  | 'add_rsvp'
  | 'remove_rsvp'
  | 'manual_rsvp'
  // Wellness actions
  | 'create_wellness_class'
  | 'update_wellness_class'
  | 'delete_wellness_class'
  | 'sync_wellness'
  | 'manual_enrollment'
  // Announcement actions
  | 'create_announcement'
  | 'update_announcement'
  | 'delete_announcement'
  // Closure actions
  | 'create_closure'
  | 'update_closure'
  | 'delete_closure'
  | 'sync_closures'
  // Trackman/Import actions
  | 'import_trackman'
  | 'reassign_booking'
  | 'unmatch_booking'
  | 'reset_trackman_data'
  // Group billing actions
  | 'add_group_member'
  | 'add_corporate_member'
  | 'remove_group_member'
  | 'link_group_subscription'
  // Staff checkin actions
  | 'review_waiver'
  | 'direct_add_participant'
  | 'qr_walkin_checkin'
  | 'nfc_walkin_checkin'
  | 'scan_id'
  | 'save_id_image'
  | 'delete_id_image'
  // Settings/Admin actions
  | 'view_directory'
  | 'export_directory'
  | 'view_report'
  | 'export_report'
  | 'login_as_staff'
  | 'update_settings'
  | 'bulk_action'
  // Data cleanup actions
  | 'placeholder_accounts_deleted'
  // Health check actions
  | 'health_check_viewed'
  // Checkout/pricing security actions
  | 'checkout_pricing_calculated'
  | 'unauthorized_access_attempt'
  | 'send_receipt'
  | 'initiate_charge'
  | 'pull_from_stripe'
  | 'staff_view_member_billing'
  | 'staff_view_member_payments'
  | 'staff_view_member_balance'
  | 'staff_view_member_card_info'
  | 'large_charge_approved'
  | 'cancellation_requested'
  | 'complete_cancellation'
  | 'replay_webhook'
  | 'charge_subscription_invoice'
  | 'stripe_member_sync'
  | 'billing_provider_changed'
  | 'terminal_payment_initiated'
  | 'terminal_payment_canceled'
  | 'terminal_payment_refunded'
  | 'terminal_payment_disputed'
  | 'terminal_dispute_closed'
  | 'booking_dev_confirm'
  | 'unlink_hubspot_contact'
  | 'merge_hubspot_duplicates'
  | 'delete_orphan_guest_pass'
  | 'delete_orphan_fee_snapshot'
  | 'dismiss'
  | 'delete_orphan_booking_participant'
  | 'cleanup_mindbody_ids'
  | 'sync_members_to_hubspot'
  | 'sync_subscription_status'
  | 'clear_orphaned_stripe_ids'
  | 'link_stripe_hubspot'
  | 'sync_visit_counts'
  | 'detect_duplicates'
  | 'sync_payment_status'
  | 'fix_trackman_ghost_bookings'
  | 'cleanup_stripe_customers'
  | 'archive_stale_visitors'
  | 'charge_saved_card'
  | 'cancel_payment'
  | 'subscription_payment_collected'
  | 'create_staff_user'
  | 'update_staff_user'
  | 'delete_staff_user'
  | 'create_admin_user'
  | 'update_admin_user'
  | 'delete_admin_user'
  | 'update_setting'
  | 'update_settings_bulk'
  | 'create_coupon'
  | 'update_coupon'
  | 'delete_coupon'
  | 'change_member_role'
  | 'visitor_linked'
  | 'visitor_created'
  | 'data_migration'
  | 'placeholder_scan'
  | 'fix_orphaned_participants'
  | 'convert_participant_to_guest'
  | 'approve_review_item'
  | 'delete_review_item'
  | 'approve_all_review_items'
  | 'delete'
  | 'merge_stripe_customers'
  | 'deactivate_stale_member'
  | 'change_billing_provider'
  | 'delete_empty_session'
  | 'terminal_reader_created'
  | 'terminal_subscription_activated'
  | 'terminal_existing_payment_routed'
  | 'terminal_save_card_initiated'
  | 'terminal_card_saved'
  | 'inline_payment_confirmed'
  | 'activation_link_resent'
  | 'undo_cancel_subscription'
  | 'create_tier_feature'
  | 'update_tier_feature'
  | 'delete_tier_feature'
  | 'update_tier_feature_value'
  | 'mindbody_csv_import'
  | 'export_announcements'
  | 'merge_users'
  | 'cancel_event_rsvp'
  | 'backfill_stripe_cache'
  | 'create_notice_type'
  | 'update_notice_type'
  | 'delete_notice_type'
  | 'create_closure_reason'
  | 'update_closure_reason'
  | 'delete_closure_reason'
  | 'trackman_rescan'
  | 'create_availability_block'
  | 'update_availability_block'
  | 'delete_availability_block'
  | 'create_communication'
  | 'delete_communication'
  | 'create_faq'
  | 'update_faq'
  | 'delete_faq'
  | 'reorder_faqs'
  | 'seed_faqs'
  | 'create_cafe_item'
  | 'update_cafe_item'
  | 'delete_cafe_item'
  | 'seed_cafe'
  | 'create_gallery_item'
  | 'update_gallery_item'
  | 'delete_gallery_item'
  | 'reorder_gallery'
  | 'create_training'
  | 'update_training'
  | 'delete_training'
  | 'seed_training'
  | 'create_note'
  | 'update_note'
  | 'delete_note'
  | 'update_guest_passes'
  | 'update_bug_report'
  | 'delete_bug_report'
  | 'update_waiver_version'
  | 'redeem_pass'
  | 'refund_pass'
  | 'update_inquiry'
  | 'delete_inquiry'
  | 'reconcile_group_billing'
  | 'tour_scheduled'
  | 'view_email_template'
  | 'line_item_added'
  | 'line_item_removed'
  | 'discount_applied'
  | 'discount_overridden'
  | 'stage_changed'
  | 'payment_confirmed'
  | 'payment_waived'
  | 'tier_override'
  | 'staff_direct_add'
  | 'checkin_guard_triggered'
  | 'reconciliation_adjusted'
  | 'ignore_issue'
  | 'resolve_issue'
  | 'deal_stage_updated'
  | 'deal_created'
  | 'deal_line_item_synced'
  | 'contact_synced'
  | 'mindbody_import'
  | 'email_change'
  | 'subscription_sync'
  | 'create_day_pass'
  | 'confirm_day_pass_payment'
  | 'create_conference_prepayment'
  | 'confirm_conference_prepayment'
  | 'checkout_session_expired'
  | 'initiate_billing_migration'
  | 'cancel_billing_migration';

export type ActorType = 'staff' | 'member' | 'system';

export type ResourceType = 
  | 'member'
  | 'booking'
  | 'payment'
  | 'report'
  | 'settings'
  | 'directory'
  | 'billing'
  | 'subscription'
  | 'tour'
  | 'event'
  | 'wellness'
  | 'announcement'
  | 'closure'
  | 'trackman'
  | 'group'
  | 'waiver'
  | 'system'
  | 'checkout'
  | 'authorization'
  | 'user'
  | 'invoices'
  | 'payments'
  | 'balance'
  | 'payment_method'
  | 'users'
  | 'stripe'
  | 'billing_groups'
  | 'legacy_purchase'
  | 'bulk_waiver'
  | 'terminal_reader'
  | 'tier_feature'
  | 'setup_intent'
  | 'trackman_booking'
  | 'staff_user'
  | 'setting'
  | 'coupon'
  | 'booking_requests'
  | 'guest_passes'
  | 'booking_fee_snapshots'
  | 'trackman_unmatched'
  | 'booking_participants'
  | 'booking_session'
  | 'wellness_classes'
  | 'events'
  | 'notice_type'
  | 'closure_reason'
  | 'availability'
  | 'communication'
  | 'faq'
  | 'cafe'
  | 'gallery'
  | 'training'
  | 'note'
  | 'bug_report'
  | 'day_pass'
  | 'inquiry'
  | 'guest_pass';

interface AuditLogParams {
  staffEmail: string;
  staffName?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  req?: Request;
  actorType?: ActorType;
  actorEmail?: string;
}

export async function logAdminAction(params: AuditLogParams): Promise<void> {
  const { staffEmail, staffName, action, resourceType, resourceId, resourceName, details, req, actorType = 'staff', actorEmail } = params;
  
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
      actorType,
      actorEmail: actorEmail || null,
    };
    
    await db.insert(adminAuditLog).values(entry);
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to log admin action:', { error: error });
  }
}

interface SystemActionParams {
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
}

export async function logSystemAction(params: SystemActionParams): Promise<void> {
  const { action, resourceType, resourceId, resourceName, details } = params;
  
  try {
    const entry: InsertAdminAuditLog = {
      staffEmail: 'system',
      staffName: null,
      action,
      resourceType,
      resourceId: resourceId || null,
      resourceName: resourceName || null,
      details: details || null,
      ipAddress: null,
      userAgent: null,
      actorType: 'system',
      actorEmail: null,
    };
    
    await db.insert(adminAuditLog).values(entry);
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to log system action:', { error: error });
  }
}

interface MemberActionParams {
  memberEmail: string;
  memberName?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  req?: Request;
}

export async function logMemberAction(params: MemberActionParams): Promise<void> {
  const { memberEmail, memberName, action, resourceType, resourceId, resourceName, details, req } = params;
  
  try {
    const entry: InsertAdminAuditLog = {
      staffEmail: 'member',
      staffName: memberName || null,
      action,
      resourceType,
      resourceId: resourceId || null,
      resourceName: resourceName || null,
      details: details || null,
      ipAddress: req ? getClientIp(req) : null,
      userAgent: req?.get('user-agent') || null,
      actorType: 'member',
      actorEmail: memberEmail,
    };
    
    await db.insert(adminAuditLog).values(entry);
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to log member action:', { error: error });
  }
}

interface BillingAuditParams {
  memberEmail: string;
  hubspotDealId?: string | null;
  actionType: string;
  actionDetails?: Record<string, unknown> | null;
  previousValue?: string | null;
  newValue?: string | null;
  performedBy: string;
  performedByName?: string | null;
}

export async function logBillingAudit(params: BillingAuditParams): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      staffEmail: params.performedBy,
      staffName: params.performedByName || null,
      action: params.actionType,
      resourceType: 'billing',
      resourceId: params.memberEmail,
      resourceName: params.memberEmail,
      details: {
        hubspotDealId: params.hubspotDealId,
        previousValue: params.previousValue,
        newValue: params.newValue,
        ...((params.actionDetails as Record<string, unknown>) || {}),
      },
      actorType: 'staff',
    });
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to log billing audit:', { error });
  }
}

interface PaymentAuditParams {
  bookingId: number;
  sessionId?: number | null;
  participantId?: number | null;
  action: string;
  staffEmail: string;
  staffName?: string | null;
  reason?: string | null;
  amountAffected?: string | number | null;
  previousStatus?: string | null;
  newStatus?: string | null;
  paymentMethod?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function logPaymentAudit(params: PaymentAuditParams): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      staffEmail: params.staffEmail,
      staffName: params.staffName || null,
      action: params.action,
      resourceType: 'payment',
      resourceId: String(params.bookingId),
      details: {
        bookingId: params.bookingId,
        sessionId: params.sessionId,
        participantId: params.participantId,
        reason: params.reason,
        amountAffected: params.amountAffected,
        previousStatus: params.previousStatus,
        newStatus: params.newStatus,
        paymentMethod: params.paymentMethod,
        ...((params.metadata as Record<string, unknown>) || {}),
      },
      actorType: 'staff',
    });
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to log payment audit:', { error });
  }
}

interface IntegrityAuditParams {
  issueKey: string;
  action: string;
  actionBy: string;
  resolutionMethod?: string | null;
  notes?: string | null;
}

export async function logIntegrityAudit(params: IntegrityAuditParams): Promise<number> {
  try {
    const [result] = await db.insert(adminAuditLog).values({
      staffEmail: params.actionBy,
      action: params.action,
      resourceType: 'system',
      resourceId: params.issueKey,
      details: {
        issueKey: params.issueKey,
        resolutionMethod: params.resolutionMethod,
        notes: params.notes,
      },
      actorType: 'staff',
    }).returning({ id: adminAuditLog.id });
    return result?.id ?? 0;
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to log integrity audit:', { error });
    return 0;
  }
}

interface LogFromRequestParams {
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
}

export function logFromRequest(
  req: Request, 
  actionOrParams: AuditAction | LogFromRequestParams, 
  resourceType?: ResourceType, 
  resourceId?: string, 
  resourceName?: string, 
  details?: Record<string, unknown>
): void {
  const staffEmail = req.session?.user?.email;
  const staffName = req.session?.user?.name;
  
  if (!staffEmail) return;
  
  let finalAction: AuditAction;
  let finalResourceType: ResourceType;
  let finalResourceId: string | undefined;
  let finalResourceName: string | undefined;
  let finalDetails: Record<string, unknown> | undefined;
  
  if (typeof actionOrParams === 'object' && actionOrParams !== null && 'action' in actionOrParams) {
    finalAction = actionOrParams.action;
    finalResourceType = actionOrParams.resourceType;
    finalResourceId = actionOrParams.resourceId;
    finalResourceName = actionOrParams.resourceName;
    finalDetails = actionOrParams.details;
  } else {
    finalAction = actionOrParams as AuditAction;
    finalResourceType = resourceType!;
    finalResourceId = resourceId;
    finalResourceName = resourceName;
    finalDetails = details;
  }
  
  logAdminAction({
    staffEmail,
    staffName,
    action: finalAction,
    resourceType: finalResourceType,
    resourceId: finalResourceId,
    resourceName: finalResourceName,
    details: finalDetails,
    req
  }).catch((err) => {
    console.error('[auditLog] Failed to log admin action:', err);
  });
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
}): Promise<{ logs: Record<string, unknown>[]; total: number }> {
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
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to fetch audit logs:', { error: error });
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
    
    logger.info(`[AuditLog] Cleaned up ${deleted.length} old audit log entries`);
    return deleted.length;
  } catch (error: unknown) {
    logger.error('[AuditLog] Failed to cleanup old audit logs:', { error: error });
    return 0;
  }
}

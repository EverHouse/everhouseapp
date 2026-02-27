import { eq, inArray, and, sql } from 'drizzle-orm';
import { getErrorMessage, getErrorStatusCode } from '../utils/errorUtils';
import webpush from 'web-push';
import { db } from '../db';
import { notifications, staffUsers, pushSubscriptions, users } from '../../shared/schema';
import { sendNotificationToUser, broadcastToStaff } from './websocket';
import { logger } from './logger';
import { getResendClient } from '../utils/resend';

export type NotificationType = 
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'system'
  | 'booking'
  | 'booking_approved'
  | 'booking_declined'
  | 'booking_reminder'
  | 'booking_cancelled'
  | 'booking_cancelled_by_staff'
  | 'booking_cancelled_via_trackman'
  | 'booking_invite'
  | 'booking_update'
  | 'booking_updated'
  | 'booking_confirmed'
  | 'booking_auto_confirmed'
  | 'booking_checked_in'
  | 'booking_created'
  | 'booking_participant_added'
  | 'booking_request'
  | 'closure'
  | 'closure_today'
  | 'closure_created'
  | 'wellness_booking'
  | 'wellness_enrollment'
  | 'wellness_cancellation'
  | 'wellness_reminder'
  | 'wellness_class'
  | 'guest_pass'
  | 'event'
  | 'event_rsvp'
  | 'event_rsvp_cancelled'
  | 'event_reminder'
  | 'tour'
  | 'tour_scheduled'
  | 'tour_reminder'
  | 'trackman_booking'
  | 'trackman_unmatched'
  | 'trackman_cancelled_link'
  | 'announcement'
  | 'payment_method_update'
  | 'payment_success'
  | 'payment_failed'
  | 'payment_receipt'
  | 'payment_error'
  | 'outstanding_balance'
  | 'fee_waived'
  | 'membership_renewed'
  | 'membership_failed'
  | 'membership_past_due'
  | 'membership_cancelled'
  | 'membership_terminated'
  | 'billing'
  | 'billing_alert'
  | 'billing_migration'
  | 'day_pass'
  | 'new_member'
  | 'member_status_change'
  | 'card_expiring'
  | 'staff_note'
  | 'account_deletion'
  | 'terminal_refund'
  | 'terminal_dispute'
  | 'terminal_dispute_closed'
  | 'terminal_payment_canceled'
  | 'funds_added'
  | 'trial_expired'
  | 'waiver_review'
  | 'cancellation_pending'
  | 'cancellation_stuck'
  | 'membership_cancellation'
  | 'bug_report'
  | 'import_failure'
  | 'integration_error'
  | 'attendance'
  | 'wellness'
  | 'trial_ending';

export interface NotificationPayload {
  userEmail: string;
  title: string;
  message: string;
  type: NotificationType;
  relatedId?: number;
  relatedType?: string;
  url?: string;
}

export interface DeliveryResult {
  channel: 'database' | 'websocket' | 'push' | 'email';
  success: boolean;
  error?: string;
  details?: Record<string, any>;
}

export interface NotificationResult {
  notificationId?: number;
  deliveryResults: DeliveryResult[];
  allSucceeded: boolean;
}

async function insertNotificationToDatabase(payload: NotificationPayload): Promise<{ id: number } | null> {
  if (!payload?.userEmail || !payload?.title || !payload?.message || !payload?.type) {
    logger.error('[Notification] Cannot insert notification - missing required fields', {
      extra: {
        event: 'notification.insert_missing_fields',
        hasUserEmail: !!payload?.userEmail,
        hasTitle: !!payload?.title,
        hasMessage: !!payload?.message,
        hasType: !!payload?.type
      }
    });
    return null;
  }
  
  try {
    // Defensive handling: ensure relatedId is a valid number or null
    const safeRelatedId = typeof payload.relatedId === 'number' ? payload.relatedId : null;
    const safeRelatedType = payload.relatedType && typeof payload.relatedType === 'string' ? payload.relatedType : null;
    
    const [result] = await db.insert(notifications).values({
      userEmail: payload.userEmail,
      title: payload.title,
      message: payload.message,
      type: payload.type,
      relatedId: safeRelatedId,
      relatedType: safeRelatedType,
    }).returning({ id: notifications.id });
    
    return result;
  } catch (error: unknown) {
    logger.error(`[Notification] Database insert failed for ${payload.userEmail}`, {
      userEmail: payload.userEmail,
      error: getErrorMessage(error),
      extra: { event: 'notification.database_insert_failed', type: payload.type }
    });
    return null;
  }
}

async function deliverViaWebSocket(payload: NotificationPayload): Promise<DeliveryResult> {
  try {
    const result = sendNotificationToUser(payload.userEmail, {
      type: 'notification',
      title: payload.title,
      message: payload.message,
      data: {
        notificationType: payload.type,
        relatedId: payload.relatedId,
        relatedType: payload.relatedType
      }
    });
    
    const success = result.sentCount > 0;
    
    logger.info(`[Notification] WebSocket delivery to ${payload.userEmail}: ${success ? 'success' : 'no active connection'}`, {
      userEmail: payload.userEmail,
      extra: {
        event: success ? 'notification.websocket_delivered' : 'notification.websocket_no_connection',
        type: payload.type,
        connectionCount: result.connectionCount,
        sentCount: result.sentCount,
        hasActiveSocket: result.hasActiveSocket
      }
    });
    
    return {
      channel: 'websocket',
      success,
      details: { connectionsSent: result.sentCount }
    };
  } catch (error: unknown) {
    logger.error(`[Notification] WebSocket delivery failed for ${payload.userEmail}`, {
      userEmail: payload.userEmail,
      error: getErrorMessage(error),
      extra: { event: 'notification.websocket_failed', type: payload.type }
    });
    
    return {
      channel: 'websocket',
      success: false,
      error: getErrorMessage(error)
    };
  }
}

async function deliverViaPush(userEmail: string, payload: { title: string; body: string; url?: string; tag?: string }): Promise<DeliveryResult> {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return {
      channel: 'push',
      success: false,
      error: 'VAPID keys not configured'
    };
  }
  
  try {
    const subscriptions = await db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userEmail, userEmail));
    
    if (subscriptions.length === 0) {
      logger.info(`[Notification] No push subscriptions for ${userEmail}`, {
        userEmail,
        extra: { event: 'notification.push_no_subscription' }
      });
      
      return {
        channel: 'push',
        success: true,
        details: { reason: 'no_subscriptions', count: 0 }
      };
    }
    
    let successCount = 0;
    let failCount = 0;
    const staleEndpoints: string[] = [];
    
    await Promise.all(subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
        successCount++;
      } catch (err: unknown) {
        failCount++;
        if (getErrorStatusCode(err) === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          logger.warn(`[Notification] Push subscription delivery failed`, {
            userEmail,
            error: getErrorMessage(err) || String(err),
            extra: { 
              event: 'notification.push_subscription_failed', 
              statusCode: getErrorStatusCode(err),
              endpointPrefix: sub.endpoint.substring(0, 60)
            }
          });
        }
      }
    }));
    
    if (staleEndpoints.length > 0) {
      await db
        .delete(pushSubscriptions)
        .where(inArray(pushSubscriptions.endpoint, staleEndpoints));
      
      logger.info(`[Notification] Removed ${staleEndpoints.length} stale push subscriptions`, {
        userEmail,
        extra: { event: 'notification.push_stale_removed', count: staleEndpoints.length }
      });
    }
    
    const allFailed = successCount === 0 && subscriptions.length > 0;
    
    logger.info(`[Notification] Push delivery to ${userEmail}: ${successCount}/${subscriptions.length} succeeded`, {
      userEmail,
      extra: {
        event: allFailed ? 'notification.push_all_failed' : 'notification.push_delivered',
        successCount,
        failCount,
        totalSubscriptions: subscriptions.length
      }
    });
    
    return {
      channel: 'push',
      success: !allFailed,
      details: { successCount, failCount, totalSubscriptions: subscriptions.length }
    };
  } catch (error: unknown) {
    logger.error(`[Notification] Push delivery failed for ${userEmail}`, {
      userEmail,
      error: getErrorMessage(error),
      extra: { event: 'notification.push_failed' }
    });
    
    return {
      channel: 'push',
      success: false,
      error: getErrorMessage(error)
    };
  }
}

async function deliverViaEmail(to: string, subject: string, html: string): Promise<DeliveryResult> {
  try {
    const { client, fromEmail } = await getResendClient();
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to,
      subject,
      html
    });
    
    logger.info(`[Notification] Email delivered to ${to}`, {
      userEmail: to,
      extra: {
        event: 'notification.email_delivered',
        subject
      }
    });
    
    return {
      channel: 'email',
      success: true,
      details: { to, subject }
    };
  } catch (error: unknown) {
    logger.error(`[Notification] Email delivery failed for ${to}`, {
      userEmail: to,
      error: getErrorMessage(error),
      extra: { event: 'notification.email_failed', subject }
    });
    
    return {
      channel: 'email',
      success: false,
      error: getErrorMessage(error)
    };
  }
}

export async function notifyMember(
  payload: NotificationPayload,
  options: { sendPush?: boolean; sendWebSocket?: boolean; sendEmail?: boolean; emailSubject?: string; emailHtml?: string } = {}
): Promise<NotificationResult> {
  if (!payload?.userEmail || !payload?.title || !payload?.message || !payload?.type) {
    logger.error('[Notification] Invalid payload - missing required fields', {
      extra: {
        event: 'notification.invalid_payload',
        hasUserEmail: !!payload?.userEmail,
        hasTitle: !!payload?.title,
        hasMessage: !!payload?.message,
        hasType: !!payload?.type
      }
    });
    return {
      notificationId: undefined,
      deliveryResults: [{ channel: 'database', success: false, error: 'Invalid payload - missing required fields' }],
      allSucceeded: false
    };
  }
  
  const { sendPush = true, sendWebSocket = true, sendEmail = false, emailSubject, emailHtml } = options;
  const deliveryResults: DeliveryResult[] = [];
  
  if (payload.relatedId && payload.relatedType) {
    try {
      const [dupCheck] = await db.select({ id: notifications.id })
        .from(notifications)
        .where(and(
          eq(notifications.userEmail, payload.userEmail),
          eq(notifications.title, payload.title),
          eq(notifications.relatedId, payload.relatedId),
          eq(notifications.relatedType, payload.relatedType),
          sql`${notifications.createdAt} > NOW() - INTERVAL '60 seconds'`
        ))
        .limit(1);
      
      if (dupCheck) {
        logger.warn(`[Notification] Duplicate suppressed: "${payload.title}" for ${payload.userEmail} (relatedId=${payload.relatedId})`, {
          extra: { event: 'notification.duplicate_suppressed', type: payload.type, existingId: dupCheck.id }
        });
        return {
          notificationId: undefined,
          deliveryResults: [{ channel: 'database', success: true, details: { skipped: 'duplicate', existingId: dupCheck.id } }],
          allSucceeded: true
        };
      }
    } catch (dupErr: unknown) {
      logger.warn('[Notification] Duplicate check failed, proceeding with insert', { extra: { error: getErrorMessage(dupErr) } });
    }
  }
  
  const dbResult = await insertNotificationToDatabase(payload);
  deliveryResults.push({
    channel: 'database',
    success: dbResult !== null,
    details: dbResult ? { notificationId: dbResult.id } : undefined
  });
  
  if (sendWebSocket) {
    const wsResult = await deliverViaWebSocket(payload);
    deliveryResults.push(wsResult);
  }
  
  if (sendPush) {
    const pushResult = await deliverViaPush(payload.userEmail, {
      title: payload.title,
      body: payload.message,
      url: payload.url,
      tag: payload.type
    });
    deliveryResults.push(pushResult);
  }
  
  if (sendEmail && emailSubject && emailHtml) {
    const emailResult = await deliverViaEmail(payload.userEmail, emailSubject, emailHtml);
    deliveryResults.push(emailResult);
  }
  
  const allSucceeded = deliveryResults.every(r => r.success);
  
  logger.info(`[Notification] Member notification complete: ${payload.userEmail} (${payload.type})`, {
    userEmail: payload.userEmail,
    extra: {
      event: 'notification.member_complete',
      type: payload.type,
      notificationId: dbResult?.id,
      allSucceeded,
      channels: deliveryResults.map(r => ({ channel: r.channel, success: r.success }))
    }
  });
  
  return {
    notificationId: dbResult?.id,
    deliveryResults,
    allSucceeded
  };
}

export async function notifyAllStaff(
  title: string,
  message: string,
  type: NotificationType,
  options: {
    relatedId?: number;
    relatedType?: string;
    sendPush?: boolean;
    sendWebSocket?: boolean;
    url?: string;
  } = {}
): Promise<{ staffCount: number; deliveryResults: DeliveryResult[] }> {
  if (!title || !message || !type) {
    logger.error('[Notification] Invalid staff notification - missing required fields', {
      extra: {
        event: 'notification.invalid_staff_payload',
        hasTitle: !!title,
        hasMessage: !!message,
        hasType: !!type
      }
    });
    return { 
      staffCount: 0, 
      deliveryResults: [{ channel: 'database', success: false, error: 'Invalid payload - missing required fields' }] 
    };
  }
  
  const { sendPush = true, sendWebSocket = true } = options;
  const deliveryResults: DeliveryResult[] = [];
  
  try {
    const staffEmails = await db.select({ email: staffUsers.email })
      .from(staffUsers)
      .where(eq(staffUsers.isActive, true));
    
    if (staffEmails.length === 0) {
      logger.warn(`[Notification] No active staff found for notification`, {
        extra: { event: 'notification.staff_none_found', type }
      });
      
      return { staffCount: 0, deliveryResults };
    }
    
    // Defensive handling: ensure relatedId is a valid number or null
    // relatedId is an integer column, so empty strings/undefined must become null
    const safeRelatedId = typeof options.relatedId === 'number' ? options.relatedId : null;
    const safeRelatedType = options.relatedType && typeof options.relatedType === 'string' ? options.relatedType : null;
    
    const notificationValues = staffEmails.map(({ email }) => ({
      userEmail: email,
      title,
      message,
      type,
      relatedId: safeRelatedId,
      relatedType: safeRelatedType,
    }));
    
    await db.insert(notifications).values(notificationValues);
    
    deliveryResults.push({
      channel: 'database',
      success: true,
      details: { staffCount: staffEmails.length }
    });
    
    if (sendWebSocket) {
      try {
        const sent = broadcastToStaff({
          type: 'notification',
          title,
          message,
          data: { notificationType: type, relatedId: options.relatedId, relatedType: options.relatedType }
        });
        
        deliveryResults.push({
          channel: 'websocket',
          success: true,
          details: { connectionsSent: sent }
        });
      } catch (error: unknown) {
        deliveryResults.push({
          channel: 'websocket',
          success: false,
          error: getErrorMessage(error)
        });
      }
    }
    
    if (sendPush) {
      const pushResult = await deliverPushToStaff({
        title,
        body: message,
        url: options.url,
        tag: type
      });
      deliveryResults.push(pushResult);
    }
    
    logger.info(`[Notification] Staff notification complete: ${staffEmails.length} staff (${type})`, {
      extra: {
        event: 'notification.staff_complete',
        type,
        staffCount: staffEmails.length,
        channels: deliveryResults.map(r => ({ channel: r.channel, success: r.success }))
      }
    });
    
    return { staffCount: staffEmails.length, deliveryResults };
  } catch (error: unknown) {
    logger.error(`[Notification] Staff notification failed`, {
      error: getErrorMessage(error),
      cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
      extra: { event: 'notification.staff_failed', type }
    });
    
    deliveryResults.push({
      channel: 'database',
      success: false,
      error: getErrorMessage(error)
    });
    
    return { staffCount: 0, deliveryResults };
  }
}

async function deliverPushToStaff(payload: { title: string; body: string; url?: string; tag?: string }): Promise<DeliveryResult> {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return {
      channel: 'push',
      success: false,
      error: 'VAPID keys not configured'
    };
  }
  
  try {
    const staffSubscriptions = await db
      .selectDistinct({
        userEmail: pushSubscriptions.userEmail,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userEmail, users.email))
      .where(inArray(users.role, ['admin', 'staff']));
    
    if (staffSubscriptions.length === 0) {
      return {
        channel: 'push',
        success: true,
        details: { reason: 'no_staff_subscriptions', count: 0 }
      };
    }
    
    let successCount = 0;
    let failCount = 0;
    const staleEndpoints: string[] = [];
    
    await Promise.all(staffSubscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
        successCount++;
      } catch (err: unknown) {
        failCount++;
        if (getErrorStatusCode(err) === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          logger.warn(`[Notification] Staff push subscription failed`, {
            userEmail: sub.userEmail,
            error: getErrorMessage(err) || String(err),
            extra: { 
              event: 'notification.staff_push_subscription_failed', 
              statusCode: getErrorStatusCode(err),
              endpointPrefix: sub.endpoint.substring(0, 60)
            }
          });
        }
      }
    }));
    
    if (staleEndpoints.length > 0) {
      await db
        .delete(pushSubscriptions)
        .where(inArray(pushSubscriptions.endpoint, staleEndpoints));
      
      logger.info(`[Notification] Removed ${staleEndpoints.length} stale staff push subscriptions`, {
        extra: { event: 'notification.staff_push_stale_removed', count: staleEndpoints.length }
      });
    }
    
    logger.info(`[Notification] Staff push delivery: ${successCount}/${staffSubscriptions.length} succeeded`, {
      extra: {
        event: 'notification.staff_push_delivered',
        successCount,
        failCount,
        totalSubscriptions: staffSubscriptions.length
      }
    });
    
    return {
      channel: 'push',
      success: successCount > 0 || staffSubscriptions.length === 0,
      details: { successCount, failCount, totalSubscriptions: staffSubscriptions.length }
    };
  } catch (error: unknown) {
    logger.error(`[Notification] Staff push delivery failed`, {
      error: getErrorMessage(error),
      extra: { event: 'notification.staff_push_failed' }
    });
    
    return {
      channel: 'push',
      success: false,
      error: getErrorMessage(error)
    };
  }
}

export { deliverViaPush as sendPushToUser, deliverPushToStaff as sendPushToAllStaff };

export async function notifyPaymentSuccess(
  userEmail: string,
  amountDollars: number,
  description: string,
  options?: { sendEmail?: boolean; bookingId?: number }
): Promise<NotificationResult> {
  const formattedAmount = `$${amountDollars.toFixed(2)}`;
  
  return notifyMember(
    {
      userEmail,
      title: 'Payment Successful',
      message: `Your payment of ${formattedAmount} for ${description} was successful.`,
      type: 'payment_success',
      relatedId: options?.bookingId,
      relatedType: options?.bookingId ? 'booking' : undefined
    },
    {
      sendEmail: options?.sendEmail,
      emailSubject: 'Payment Confirmation - Ever Club',
      emailHtml: `
        <h2>Payment Successful</h2>
        <p>Your payment of <strong>${formattedAmount}</strong> for ${description} has been processed successfully.</p>
        <p>Thank you for your payment.</p>
      `
    }
  );
}

export async function notifyPaymentFailed(
  userEmail: string,
  amountDollars: number,
  reason: string,
  options?: { sendEmail?: boolean; bookingId?: number }
): Promise<NotificationResult> {
  const formattedAmount = `$${amountDollars.toFixed(2)}`;
  
  return notifyMember(
    {
      userEmail,
      title: 'Payment Failed',
      message: `Your payment of ${formattedAmount} could not be processed. Reason: ${reason}`,
      type: 'payment_failed',
      relatedId: options?.bookingId,
      relatedType: options?.bookingId ? 'booking' : undefined
    },
    {
      sendEmail: options?.sendEmail,
      emailSubject: 'Payment Failed - Ever Club',
      emailHtml: `
        <h2>Payment Failed</h2>
        <p>We were unable to process your payment of <strong>${formattedAmount}</strong>.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Please update your payment method or contact us for assistance.</p>
      `
    }
  );
}

export async function notifyFeeWaived(
  userEmail: string,
  amountDollars: number,
  reason: string,
  bookingId?: number
): Promise<NotificationResult> {
  const formattedAmount = `$${amountDollars.toFixed(2)}`;
  
  return notifyMember(
    {
      userEmail,
      title: 'Fee Waived',
      message: `A fee of ${formattedAmount} has been waived. Reason: ${reason}`,
      type: 'fee_waived',
      relatedId: bookingId,
      relatedType: bookingId ? 'booking' : undefined
    },
    {
      sendPush: true,
      sendWebSocket: true
    }
  );
}

export async function notifyOutstandingBalance(
  userEmail: string,
  amountDollars: number,
  description: string,
  options?: { sendEmail?: boolean; sendPush?: boolean }
): Promise<NotificationResult> {
  const formattedAmount = `$${amountDollars.toFixed(2)}`;
  
  return notifyMember(
    {
      userEmail,
      title: 'Outstanding Balance',
      message: `You have an outstanding balance of ${formattedAmount} for ${description}.`,
      type: 'outstanding_balance'
    },
    {
      sendPush: options?.sendPush ?? true,
      sendEmail: options?.sendEmail,
      emailSubject: 'Outstanding Balance - Ever Club',
      emailHtml: `
        <h2>Outstanding Balance</h2>
        <p>You have an outstanding balance of <strong>${formattedAmount}</strong> for ${description}.</p>
        <p>Please settle this balance at your earliest convenience.</p>
      `
    }
  );
}

export async function notifyStaffPaymentFailed(
  memberEmail: string,
  memberName: string,
  amountDollars: number,
  reason: string
): Promise<{ staffCount: number; deliveryResults: DeliveryResult[] }> {
  const formattedAmount = `$${amountDollars.toFixed(2)}`;
  
  return notifyAllStaff(
    'Member Payment Failed',
    `Payment of ${formattedAmount} failed for ${memberName} (${memberEmail}). Reason: ${reason}`,
    'payment_failed',
    {
      sendPush: true,
      sendWebSocket: true
    }
  );
}

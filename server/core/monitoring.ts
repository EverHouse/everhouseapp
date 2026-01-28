import { pool } from './db';
import { logger } from './logger';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertCategory = 'payment' | 'webhook' | 'system' | 'security';

interface AlertEvent {
  severity: AlertSeverity;
  category: AlertCategory;
  message: string;
  details?: Record<string, any>;
  userEmail?: string;
  timestamp: Date;
}

const recentAlerts: AlertEvent[] = [];
const MAX_RECENT_ALERTS = 100;

export async function logAlert(event: Omit<AlertEvent, 'timestamp'>): Promise<void> {
  const alertEvent: AlertEvent = {
    ...event,
    timestamp: new Date()
  };
  
  recentAlerts.unshift(alertEvent);
  if (recentAlerts.length > MAX_RECENT_ALERTS) {
    recentAlerts.pop();
  }
  
  const logLevel = event.severity === 'critical' ? 'error' : 
                   event.severity === 'warning' ? 'warn' : 'info';
  
  logger[logLevel](`[Alert:${event.category}] ${event.message}`, {
    extra: {
      alertSeverity: event.severity,
      alertCategory: event.category,
      ...event.details
    },
    userEmail: event.userEmail
  });
  
  if (event.severity === 'critical') {
    console.error(`[CRITICAL ALERT] [${event.category}] ${event.message}`, event.details);
  }
  
  try {
    await pool.query(`
      INSERT INTO system_alerts (severity, category, message, details, user_email, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT DO NOTHING
    `, [event.severity, event.category, event.message, JSON.stringify(event.details || {}), event.userEmail || null])
    .catch(() => {
      // Table might not exist yet - that's ok
    });
  } catch {
    // Silently fail if table doesn't exist
  }
}

export function logPaymentFailure(params: {
  paymentIntentId?: string;
  customerId?: string;
  userEmail?: string;
  amountCents?: number;
  errorMessage: string;
  errorCode?: string;
}): void {
  logAlert({
    severity: 'critical',
    category: 'payment',
    message: `Payment failed: ${params.errorMessage}`,
    details: {
      paymentIntentId: params.paymentIntentId,
      customerId: params.customerId,
      amountCents: params.amountCents,
      errorCode: params.errorCode
    },
    userEmail: params.userEmail
  });
}

export function logWebhookFailure(params: {
  eventId: string;
  eventType: string;
  errorMessage: string;
  payload?: any;
}): void {
  logAlert({
    severity: 'warning',
    category: 'webhook',
    message: `Webhook processing failed: ${params.eventType} - ${params.errorMessage}`,
    details: {
      eventId: params.eventId,
      eventType: params.eventType,
      errorDetails: params.errorMessage
    }
  });
}

export function logSecurityEvent(params: {
  event: string;
  userEmail?: string;
  ipAddress?: string;
  details?: Record<string, any>;
}): void {
  logAlert({
    severity: 'warning',
    category: 'security',
    message: params.event,
    details: {
      ipAddress: params.ipAddress,
      ...params.details
    },
    userEmail: params.userEmail
  });
}

export function getRecentAlerts(options?: {
  severity?: AlertSeverity;
  category?: AlertCategory;
  limit?: number;
}): AlertEvent[] {
  let filtered = [...recentAlerts];
  
  if (options?.severity) {
    filtered = filtered.filter(a => a.severity === options.severity);
  }
  if (options?.category) {
    filtered = filtered.filter(a => a.category === options.category);
  }
  
  return filtered.slice(0, options?.limit || 50);
}

export function getAlertCounts(): Record<AlertSeverity, number> {
  const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = recentAlerts.filter(a => a.timestamp > last24Hours);
  
  return {
    critical: recent.filter(a => a.severity === 'critical').length,
    warning: recent.filter(a => a.severity === 'warning').length,
    info: recent.filter(a => a.severity === 'info').length
  };
}

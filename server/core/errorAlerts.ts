import { getResendClient } from '../utils/resend';
import { logger } from './logger';
import { pool } from './db';

const ALERT_EMAIL = process.env.ALERT_EMAIL || 'nick@evenhouse.club';
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between same-type alerts
const MAX_ALERTS_PER_DAY = 3; // Strict daily limit
const STARTUP_GRACE_PERIOD_MS = 5 * 60 * 1000; // No alerts for first 5 minutes after startup
const serverStartTime = Date.now();

const TRANSIENT_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
  /network.*(timeout|error)/i,
  /fetch failed/i,
  /aborted/i,
  /EHOSTUNREACH/i,
  /EAI_AGAIN/i,
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /503.*service unavailable/i,
  /502.*bad gateway/i,
];

function isTransientError(message: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

function isInStartupGracePeriod(): boolean {
  return (Date.now() - serverStartTime) < STARTUP_GRACE_PERIOD_MS;
}

interface DailyState {
  alertsToday: number;
  dayStart: number;
  keyLastSent: Record<string, number>;
}

let dailyState: DailyState = {
  alertsToday: 0,
  dayStart: Date.now(),
  keyLastSent: {},
};

let dbLoadAttempted = false;
let dbAvailable = false;

async function loadDailyStateFromDb(): Promise<void> {
  if (dbLoadAttempted) return;
  dbLoadAttempted = true;
  try {
    const result = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'alert_rate_limits'`
    );
    dbAvailable = true;
    if (result.rows.length > 0 && result.rows[0].value) {
      const saved = JSON.parse(result.rows[0].value);
      const now = Date.now();
      if (now - (saved.dayStart || 0) < 24 * 60 * 60 * 1000) {
        dailyState = {
          alertsToday: saved.alertsToday || 0,
          dayStart: saved.dayStart || now,
          keyLastSent: saved.keyLastSent || {},
        };
        logger.info('[ErrorAlert] Loaded rate limit state from database', {
          extra: { alertsToday: dailyState.alertsToday }
        });
      }
    }
  } catch (err) {
    logger.warn('[ErrorAlert] Could not load rate limits from database, using in-memory only');
    dbAvailable = false;
  }
}

async function saveDailyStateToDb(): Promise<void> {
  if (!dbAvailable) return;
  try {
    const exists = await pool.query(
      `SELECT 1 FROM app_settings WHERE key = 'alert_rate_limits'`
    );
    if (exists.rows.length > 0) {
      await pool.query(
        `UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = 'alert_rate_limits'`,
        [JSON.stringify(dailyState)]
      );
    } else {
      await pool.query(
        `INSERT INTO app_settings (key, value, category, updated_at) VALUES ('alert_rate_limits', $1, 'system', NOW())`,
        [JSON.stringify(dailyState)]
      );
    }
  } catch {
    logger.warn('[ErrorAlert] Could not persist rate limits to database');
  }
}

function getAlertKey(type: string, context?: string): string {
  if (type === 'server_error') return 'server_error';
  if (type === 'external_service_error') return `ext:${context || 'general'}`;
  return type;
}

function canSendAlert(key: string): boolean {
  const now = Date.now();

  if (now - dailyState.dayStart > 24 * 60 * 60 * 1000) {
    dailyState.dayStart = now;
    dailyState.alertsToday = 0;
    dailyState.keyLastSent = {};
  }

  if (dailyState.alertsToday >= MAX_ALERTS_PER_DAY) {
    return false;
  }

  const lastSent = dailyState.keyLastSent[key];
  if (lastSent && (now - lastSent) < ALERT_COOLDOWN_MS) {
    return false;
  }

  return true;
}

function recordAlertSent(key: string): void {
  dailyState.keyLastSent[key] = Date.now();
  dailyState.alertsToday++;
  saveDailyStateToDb();
}

export type AlertType = 
  | 'server_error'
  | 'database_error'
  | 'external_service_error'
  | 'booking_failure'
  | 'payment_failure'
  | 'security_alert';

function getFriendlyTypeName(type: AlertType): string {
  switch (type) {
    case 'server_error': return 'App Issue';
    case 'database_error': return 'Database Issue';
    case 'external_service_error': return 'Connection Issue';
    case 'booking_failure': return 'Booking Issue';
    case 'payment_failure': return 'Payment Issue';
    case 'security_alert': return 'Security Notice';
    default: return 'System Issue';
  }
}

function getFriendlyAreaName(path?: string): string {
  if (!path) return 'the app';
  
  if (path.includes('/booking') || path.includes('/bays')) return 'Golf Simulator Bookings';
  if (path.includes('/notification')) return 'Notifications';
  if (path.includes('/event')) return 'Events';
  if (path.includes('/wellness')) return 'Wellness Classes';
  if (path.includes('/member') || path.includes('/hubspot')) return 'Member Directory';
  if (path.includes('/auth')) return 'Login System';
  if (path.includes('/calendar')) return 'Calendar Sync';
  if (path.includes('/push')) return 'Push Notifications';
  if (path.includes('/admin')) return 'Admin Dashboard';
  if (path.includes('Stripe') || path.includes('stripe')) return 'Stripe Payments';
  if (path.includes('HubSpot') || path.includes('hubspot')) return 'HubSpot (member data)';
  if (path.includes('Google') || path.includes('google')) return 'Google Calendar';
  
  return 'the app';
}

function translateErrorToPlainLanguage(message: string, path?: string): string {
  const area = getFriendlyAreaName(path);
  
  if (message.includes('Cannot destructure') || message.includes('undefined')) {
    return `Something went wrong in ${area}. A member tried to use a feature but the app didn't receive all the information it needed. This might have caused their action to fail.`;
  }
  if (message.includes('timeout') || message.includes('Timeout')) {
    return `${area} took too long to respond. This could be a temporary slowdown. If members report issues, they can try again.`;
  }
  if (message.includes('connection') || message.includes('ECONNREFUSED')) {
    return `The app had trouble connecting to ${area}. This might affect some features temporarily.`;
  }
  if (message.includes('401') || message.includes('Unauthorized')) {
    return `A login or access issue occurred in ${area}. A member may have been logged out unexpectedly.`;
  }
  if (message.includes('403') || message.includes('Forbidden')) {
    return `Someone tried to access something in ${area} they don't have permission for. This might be a normal access attempt or could indicate a configuration issue.`;
  }
  if (message.includes('404') || message.includes('Not found')) {
    return `Something was requested in ${area} that doesn't exist. This could be a deleted item or a broken link.`;
  }
  if (message.includes('database') || message.includes('SQL') || message.includes('query')) {
    return `There was a database issue in ${area}. Some data might not have saved correctly.`;
  }
  if (message.includes('rate limit') || message.includes('too many')) {
    return `${area} received too many requests too quickly. The system is protecting itself from overload.`;
  }
  
  return `An issue occurred in ${area}. The app encountered an unexpected situation while processing a request.`;
}

interface AlertOptions {
  type: AlertType;
  title: string;
  message: string;
  context?: string;
  details?: Record<string, any>;
  userEmail?: string;
  requestId?: string;
}

export async function sendErrorAlert(options: AlertOptions): Promise<boolean> {
  const { type, title, message, context, details, userEmail, requestId } = options;

  if (isInStartupGracePeriod()) {
    logger.info('[ErrorAlert] Skipping alert during startup grace period', {
      extra: { event: 'error_alert.startup_grace', type, context }
    });
    return false;
  }

  if (type !== 'payment_failure' && type !== 'security_alert' && isTransientError(message)) {
    logger.info('[ErrorAlert] Skipping transient error alert', {
      extra: { event: 'error_alert.transient_skip', type, context, message: message.substring(0, 100) }
    });
    return false;
  }

  await loadDailyStateFromDb();

  const key = getAlertKey(type, context);
  
  if (!canSendAlert(key)) {
    logger.info('[ErrorAlert] Alert rate-limited', {
      extra: { event: 'error_alert.rate_limited', type, context, alertsToday: dailyState.alertsToday }
    });
    return false;
  }
  
  try {
    const { client, fromEmail } = await getResendClient();
    
    const timestamp = new Date().toLocaleString('en-US', { 
      timeZone: 'America/Los_Angeles',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    
    const friendlyType = getFriendlyTypeName(type);
    const friendlyMessage = translateErrorToPlainLanguage(message, details?.path || context);
    const area = getFriendlyAreaName(details?.path || context);
    
    let contextInfo = '';
    if (userEmail) {
      const userName = userEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      contextInfo += `<p style="margin: 8px 0;"><strong>Who was affected:</strong> ${userName} (${userEmail})</p>`;
    }
    if (area !== 'the app') {
      contextInfo += `<p style="margin: 8px 0;"><strong>Where it happened:</strong> ${area}</p>`;
    }
    
    let suggestedAction = '';
    switch (type) {
      case 'server_error':
        suggestedAction = 'If members report issues, ask them to try again. If this keeps happening, the development team should investigate.';
        break;
      case 'database_error':
        suggestedAction = 'Check if the affected data was saved correctly. If not, the member may need to re-enter their information.';
        break;
      case 'external_service_error':
        suggestedAction = 'This might resolve on its own. If it persists, there may be an issue with an external service like HubSpot or Google Calendar.';
        break;
      case 'booking_failure':
        suggestedAction = 'Check the booking queue to make sure the member\'s request was received. They may need to submit again.';
        break;
      case 'payment_failure':
        suggestedAction = 'Follow up with the member about their payment. They may need to try a different payment method.';
        break;
      case 'security_alert':
        suggestedAction = 'Review the access logs for any suspicious activity. Consider if any action is needed to protect member data.';
        break;
      default:
        suggestedAction = 'Monitor for recurring issues. If this happens frequently, it may need technical attention.';
    }
    
    const remainingToday = MAX_ALERTS_PER_DAY - dailyState.alertsToday - 1;
    
    await client.emails.send({
      from: fromEmail || 'Ever Club <noreply@everclub.app>',
      to: ALERT_EMAIL,
      subject: `${friendlyType}: ${area}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            
            <div style="text-align: center; margin-bottom: 24px;">
              <div style="display: inline-block; background: #fef2f2; border-radius: 50%; padding: 16px; margin-bottom: 16px;">
                <span style="font-size: 32px;">⚠️</span>
              </div>
              <h1 style="margin: 0; color: #1f2937; font-size: 24px; font-weight: 600;">${friendlyType}</h1>
              <p style="margin: 8px 0 0 0; color: #6b7280; font-size: 14px;">${timestamp} PT</p>
            </div>
            
            <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
              <h2 style="margin: 0 0 12px 0; color: #374151; font-size: 16px; font-weight: 600;">What happened</h2>
              <p style="margin: 0; color: #4b5563; line-height: 1.6; font-size: 15px;">${friendlyMessage}</p>
            </div>
            
            ${contextInfo ? `
            <div style="margin-bottom: 24px;">
              <h2 style="margin: 0 0 12px 0; color: #374151; font-size: 16px; font-weight: 600;">Details</h2>
              <div style="color: #4b5563; font-size: 15px;">
                ${contextInfo}
              </div>
            </div>
            ` : ''}
            
            <div style="background: #f0fdf4; border-radius: 8px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #22c55e;">
              <h2 style="margin: 0 0 12px 0; color: #166534; font-size: 16px; font-weight: 600;">What to do</h2>
              <p style="margin: 0; color: #15803d; line-height: 1.6; font-size: 15px;">${suggestedAction}</p>
            </div>
            
            <div style="text-align: center; padding-top: 16px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                This is an automated alert from the Ever Club app.<br>
                ${remainingToday > 0 ? `You may receive up to ${remainingToday} more alert${remainingToday === 1 ? '' : 's'} today.` : 'This is your last alert for today.'}
              </p>
            </div>
            
          </div>
        </body>
        </html>
      `
    });
    
    recordAlertSent(key);
    
    logger.info('[ErrorAlert] Alert sent successfully', {
      extra: { event: 'error_alert.sent', type, title, alertsToday: dailyState.alertsToday }
    });
    
    return true;
  } catch (error) {
    logger.error('[ErrorAlert] Failed to send alert email', {
      error: error instanceof Error ? error.message : String(error),
      extra: { event: 'error_alert.failed', type }
    });
    return false;
  }
}

export async function alertOnServerError(
  error: Error,
  context: { 
    path?: string; 
    method?: string; 
    userEmail?: string; 
    requestId?: string;
    dbErrorCode?: string;
    dbErrorDetail?: string;
    dbErrorTable?: string;
    dbErrorConstraint?: string;
  }
): Promise<void> {
  await sendErrorAlert({
    type: 'server_error',
    title: 'Server Error',
    message: error.message,
    context: context.path,
    details: {
      path: context.path,
      method: context.method,
      dbErrorCode: context.dbErrorCode,
      dbErrorDetail: context.dbErrorDetail,
      dbErrorTable: context.dbErrorTable,
      dbErrorConstraint: context.dbErrorConstraint
    },
    userEmail: context.userEmail,
    requestId: context.requestId
  });
}

export async function alertOnExternalServiceError(
  service: string,
  error: Error,
  operation?: string
): Promise<void> {
  if (isTransientError(error.message)) {
    logger.info('[ErrorAlert] Skipping transient external service error', {
      extra: { event: 'error_alert.transient_ext_skip', service, operation, error: error.message.substring(0, 100) }
    });
    return;
  }

  const friendlyServiceName = service === 'HubSpot' ? 'HubSpot (member data)' 
    : service === 'Google' ? 'Google Calendar' 
    : service === 'Resend' ? 'Email Service'
    : service;
    
  await sendErrorAlert({
    type: 'external_service_error',
    title: `${friendlyServiceName} Connection Issue`,
    message: `The app couldn't connect to ${friendlyServiceName}${operation ? ` while trying to ${operation}` : ''}.`,
    context: service,
    details: {
      service: friendlyServiceName,
      operation
    }
  });
}

export async function alertOnBookingFailure(
  userEmail: string,
  reason: string,
  bookingDetails?: Record<string, any>
): Promise<void> {
  await sendErrorAlert({
    type: 'booking_failure',
    title: 'Booking Issue',
    message: reason,
    context: 'booking',
    details: bookingDetails,
    userEmail
  });
}

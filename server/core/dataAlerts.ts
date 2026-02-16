import { notifyAllStaff } from './notificationService';
import { isProduction } from './db';
import { getTodayPacific } from '../utils/dateUtils';

export type DataAlertType = 
  | 'import_failure'
  | 'low_match_rate'
  | 'data_integrity_critical'
  | 'sync_failure'
  | 'scheduled_task_failure';

// Rate limiting for alerts to prevent duplicate notifications
const alertCooldowns: Map<string, number> = new Map();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between same-type alerts

function canSendAlert(alertKey: string): boolean {
  const now = Date.now();
  const lastSent = alertCooldowns.get(alertKey);
  
  if (lastSent && (now - lastSent) < ALERT_COOLDOWN_MS) {
    if (!isProduction) {
      console.log(`[DataAlerts] Alert rate-limited: ${alertKey} (${Math.round((ALERT_COOLDOWN_MS - (now - lastSent)) / 60000)} min remaining)`);
    }
    return false;
  }
  
  return true;
}

function recordAlertSent(alertKey: string): void {
  alertCooldowns.set(alertKey, Date.now());
}

interface ImportResult {
  total: number;
  matched?: number;
  updated?: number;
  imported?: number;
  skipped?: number;
  linked?: number;
  errors: string[];
}

export async function alertOnImportFailure(
  importType: 'members' | 'sales' | 'attendance',
  result: ImportResult
): Promise<void> {
  if (result.errors.length === 0) return;

  const title = `Mindbody ${importType.charAt(0).toUpperCase() + importType.slice(1)} Import Issues`;
  const errorSummary = result.errors.slice(0, 5).join('; ');
  const moreErrors = result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : '';
  
  const message = `Import completed with ${result.errors.length} error(s). ` +
    `Total: ${result.total}, ` +
    (result.imported !== undefined ? `Imported: ${result.imported}, ` : '') +
    (result.matched !== undefined ? `Matched: ${result.matched}, ` : '') +
    (result.updated !== undefined ? `Updated: ${result.updated}, ` : '') +
    `Skipped: ${result.skipped || 0}. ` +
    `Issues: ${errorSummary}${moreErrors}`;

  if (!isProduction) {
    console.log(`[DataAlerts] Creating import failure alert: ${title}`);
  }

  await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
}

export async function alertOnLowMatchRate(
  importType: 'members' | 'sales' | 'attendance',
  result: ImportResult,
  threshold: number = 95
): Promise<void> {
  if (result.total === 0) return;

  const matchedCount = result.matched ?? result.imported ?? result.updated ?? 0;
  const matchRate = (matchedCount / result.total) * 100;

  if (matchRate >= threshold) return;

  const unmatchedCount = result.total - matchedCount;
  const title = `Low Match Rate: ${importType.charAt(0).toUpperCase() + importType.slice(1)} Import`;
  const message = `Match rate is ${matchRate.toFixed(1)}% (below ${threshold}% threshold). ` +
    `${unmatchedCount} of ${result.total} records could not be matched. ` +
    `Consider reviewing the source data or updating member records.`;

  if (!isProduction) {
    console.log(`[DataAlerts] Creating low match rate alert: ${matchRate.toFixed(1)}%`);
  }

  await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
}

export interface IntegrityCheckSummary {
  checkName: string;
  status: 'pass' | 'warning' | 'fail';
  issueCount: number;
  severity?: 'critical' | 'high' | 'medium' | 'low';
}

export async function alertOnCriticalIntegrityIssues(
  checks: IntegrityCheckSummary[],
  severityMap: Record<string, 'critical' | 'high' | 'medium' | 'low'>
): Promise<void> {
  const criticalChecks = checks.filter(check => {
    const severity = severityMap[check.checkName] || 'medium';
    return severity === 'critical' && check.status === 'fail' && check.issueCount > 0;
  });

  if (criticalChecks.length === 0) return;

  const totalCriticalIssues = criticalChecks.reduce((sum, c) => sum + c.issueCount, 0);
  const checkNames = criticalChecks.map(c => `${c.checkName} (${c.issueCount})`).join(', ');

  const title = `Critical Data Integrity Issues Detected`;
  const message = `${totalCriticalIssues} critical issue(s) found across ${criticalChecks.length} check(s): ${checkNames}. ` +
    `Please review the Data Integrity tab in the admin panel.`;

  if (!isProduction) {
    console.log(`[DataAlerts] Creating critical integrity alert: ${totalCriticalIssues} issues`);
  }

  await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
}

export async function alertOnHighIntegrityIssues(
  checks: IntegrityCheckSummary[],
  severityMap: Record<string, 'critical' | 'high' | 'medium' | 'low'>,
  threshold: number = 10
): Promise<void> {
  const highChecks = checks.filter(check => {
    const severity = severityMap[check.checkName] || 'medium';
    return severity === 'high' && check.status === 'fail' && check.issueCount >= threshold;
  });

  if (highChecks.length === 0) return;

  const totalHighIssues = highChecks.reduce((sum, c) => sum + c.issueCount, 0);
  const checkNames = highChecks.map(c => `${c.checkName} (${c.issueCount})`).join(', ');

  const title = `High Priority Data Issues Detected`;
  const message = `${totalHighIssues} high-priority issue(s) found: ${checkNames}. ` +
    `Review the Data Integrity tab in the admin panel.`;

  if (!isProduction) {
    console.log(`[DataAlerts] Creating high priority integrity alert: ${totalHighIssues} issues`);
  }

  await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
}

export async function alertOnSyncFailure(
  service: 'hubspot' | 'calendar' | 'mindbody',
  operation: string,
  error: Error | string,
  details?: { synced?: number; errors?: number; total?: number; calendarName?: string }
): Promise<void> {
  const alertKey = `sync_failure:${service}:${operation}`;
  
  if (!canSendAlert(alertKey)) {
    return;
  }
  
  const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
  let title = `${serviceName} Sync Failed`;
  
  // Include calendar name if provided
  if (details?.calendarName) {
    title = `${serviceName} Sync Failed: ${details.calendarName}`;
  }
  
  const errorMessage = error instanceof Error ? error.message : error;
  let message = `${operation} failed: ${errorMessage}`;
  
  if (details) {
    if (details.errors && details.errors > 0) {
      message += ` (${details.errors} errors`;
      if (details.synced !== undefined) {
        message += `, ${details.synced} synced`;
      }
      if (details.total !== undefined) {
        message += ` out of ${details.total}`;
      }
      message += ')';
    }
  }

  if (!isProduction) {
    console.log(`[DataAlerts] Creating sync failure alert: ${service} - ${operation}`);
  }

  await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
  recordAlertSent(alertKey);
}

export async function alertOnHubSpotSyncComplete(
  synced: number,
  errors: number,
  total: number
): Promise<void> {
  if (errors === 0) return;

  const errorRate = (errors / total) * 100;
  
  if (errors > 5 || errorRate > 5) {
    const alertKey = 'hubspot_sync_errors';
    
    if (!canSendAlert(alertKey)) {
      return;
    }
    
    const title = `HubSpot Sync Completed with Errors`;
    const message = `Sync completed: ${synced} synced, ${errors} failed out of ${total} contacts (${errorRate.toFixed(1)}% error rate). ` +
      `Review member data for potential issues.`;

    if (!isProduction) {
      console.log(`[DataAlerts] Creating HubSpot sync error alert: ${errors} errors`);
    }

    await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
    recordAlertSent(alertKey);
  }
}

export async function alertOnScheduledTaskFailure(
  taskName: string,
  error: Error | string,
  details?: { context?: string }
): Promise<void> {
  const alertKey = `scheduled_task:${taskName}`;
  
  if (!canSendAlert(alertKey)) {
    return;
  }
  
  const errorMessage = error instanceof Error ? error.message : error;
  const title = `Scheduled Task Failed: ${taskName}`;
  let message = `The ${taskName} scheduled task failed: ${errorMessage}`;
  
  if (details?.context) {
    message += ` (${details.context})`;
  }
  
  if (!isProduction) {
    console.log(`[DataAlerts] Creating scheduled task failure alert: ${taskName}`);
  }
  
  await notifyAllStaff(title, message, 'system', { url: '/admin/data-integrity' });
  recordAlertSent(alertKey);
}

/**
 * Alert staff on Trackman import issues (errors or low match rate)
 */
export interface TrackmanImportResult {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  skippedRows: number;
  errors: string[];
}

export async function alertOnTrackmanImportIssues(result: TrackmanImportResult): Promise<void> {
  // Check for errors
  if (result.errors.length > 0) {
    const alertKey = `trackman_import_errors_${getTodayKey()}`;
    if (canSendAlert(alertKey)) {
      const title = `Trackman Import Issues`;
      const errorSummary = result.errors.slice(0, 5).join('; ');
      const moreErrors = result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : '';
      
      const message = `Import completed with ${result.errors.length} error(s). ` +
        `Total: ${result.totalRows}, Matched: ${result.matchedRows}, Unmatched: ${result.unmatchedRows}, ` +
        `Skipped: ${result.skippedRows}. Issues: ${errorSummary}${moreErrors}`;
      
      if (!isProduction) {
        console.log(`[DataAlerts] Creating Trackman import error alert: ${result.errors.length} errors`);
      }
      
      await notifyAllStaff(title, message, 'system', { url: '/admin/trackman' });
      recordAlertSent(alertKey);
    }
  }
  
  // Check for low match rate (only if we have rows to compare)
  if (result.totalRows > 0) {
    const matchRate = (result.matchedRows / result.totalRows) * 100;
    const MATCH_THRESHOLD = 80; // Lower threshold than MindBody since Trackman has more unmatched scenarios
    
    if (matchRate < MATCH_THRESHOLD) {
      const alertKey = `trackman_low_match_${getTodayKey()}`;
      if (canSendAlert(alertKey)) {
        const title = `Low Trackman Match Rate`;
        const message = `Match rate is ${matchRate.toFixed(1)}% (below ${MATCH_THRESHOLD}% threshold). ` +
          `${result.unmatchedRows} of ${result.totalRows} bookings could not be matched to members. ` +
          `Please review unmatched bookings in the Trackman tab.`;
        
        if (!isProduction) {
          console.log(`[DataAlerts] Creating Trackman low match rate alert: ${matchRate.toFixed(1)}%`);
        }
        
        await notifyAllStaff(title, message, 'system', { url: '/admin/trackman' });
        recordAlertSent(alertKey);
      }
    }
  }
}

function getTodayKey(): string {
  return getTodayPacific();
}

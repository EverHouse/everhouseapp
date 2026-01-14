import { notifyAllStaff } from './staffNotifications';
import { isProduction } from './db';

export type DataAlertType = 
  | 'import_failure'
  | 'low_match_rate'
  | 'data_integrity_critical'
  | 'sync_failure';

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

  await notifyAllStaff(title, message, 'data_alert');
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

  await notifyAllStaff(title, message, 'data_alert');
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

  await notifyAllStaff(title, message, 'data_alert');
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

  await notifyAllStaff(title, message, 'data_alert');
}

export async function alertOnSyncFailure(
  service: 'hubspot' | 'calendar' | 'mindbody',
  operation: string,
  error: Error | string,
  details?: { synced?: number; errors?: number; total?: number }
): Promise<void> {
  const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
  const title = `${serviceName} Sync Failed`;
  
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

  await notifyAllStaff(title, message, 'data_alert');
}

export async function alertOnHubSpotSyncComplete(
  synced: number,
  errors: number,
  total: number
): Promise<void> {
  if (errors === 0) return;

  const errorRate = (errors / total) * 100;
  
  if (errors > 5 || errorRate > 5) {
    const title = `HubSpot Sync Completed with Errors`;
    const message = `Sync completed: ${synced} synced, ${errors} failed out of ${total} contacts (${errorRate.toFixed(1)}% error rate). ` +
      `Review member data for potential issues.`;

    if (!isProduction) {
      console.log(`[DataAlerts] Creating HubSpot sync error alert: ${errors} errors`);
    }

    await notifyAllStaff(title, message, 'data_alert');
  }
}

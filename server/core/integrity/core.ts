import { db } from '../../db';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import {
  integrityCheckHistory,
  integrityIssuesTracking,
  integrityIgnores
} from '../../../shared/schema';
import { eq, isNull, and, gt, gte, desc } from 'drizzle-orm';
import { isProduction } from '../db';
import { alertOnCriticalIntegrityIssues, alertOnHighIntegrityIssues, type IntegrityCheckSummary } from '../dataAlerts';

export interface HubSpotBatchReadResult {
  results: Array<{ id: string; properties?: Record<string, string> }>;
}

export interface MemberRow {
  email: string;
  first_name?: string;
  last_name?: string;
  tier?: string;
  membership_status?: string;
  stripe_customer_id?: string;
  hubspot_id?: string;
  billing_provider?: string;
  mindbody_client_id?: string;
  role?: string;
  id?: number;
  [key: string]: unknown;
}

export interface CountRow {
  count: number | string;
}

export interface UnmatchedBookingRow {
  id: string | number;
  trackman_booking_id: string;
  user_name: string;
  original_email: string;
  booking_date: string;
  bay_number: string | number;
  start_time: string;
  end_time: string;
  notes: string;
}

export interface ParticipantUserRow {
  id: string | number;
  user_id: string;
  display_name: string;
  session_id: number;
  session_date: string;
  start_time: string;
  resource_name: string;
}

export interface ReviewItemRow {
  id: string | number;
  title: string;
  event_date?: string;
  date?: string;
  start_time: string;
  instructor?: string;
}

export interface InvalidBookingRow {
  id: string | number;
  user_email: string;
  user_name: string;
  request_date: string;
  start_time: string;
  end_time: string;
  resource_name: string;
}

export interface InvalidSessionRow {
  id: string | number;
  session_date: string;
  start_time: string;
  end_time: string;
  resource_name: string;
}

export interface StaleTourRow {
  id: string | number;
  title: string;
  tour_date: string;
  status: string;
  guest_name: string;
  guest_email: string;
  start_time: string;
}

export interface NoEmailMemberRow {
  id: string | number;
  first_name: string;
  last_name: string;
  hubspot_id: string;
  membership_tier: string;
}



export interface StuckMemberRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  tier: string;
  membership_status: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  updated_at: string;
}

export interface GhostBookingRow {
  id: string | number;
  user_email: string;
  request_date: string;
  status: string;
  trackman_booking_id: string;
  resource_id: number;
  start_time: string;
  end_time: string;
  notes: string;
  resource_name: string;
  first_name: string;
  last_name: string;
}

export interface DuplicateStripeRow {
  normalized_email: string;
  customer_count: number;
  customer_ids: string[];
  member_emails: string[];
}

export interface SharedCustomerRow {
  stripe_customer_id: string;
  user_count: number;
  emails: string[];
}

export interface StaleMindBodyRow {
  id: string | number;
  email: string;
  first_name: string;
  last_name: string;
  tier: string;
  membership_status: string;
  updated_at: string;
  mindbody_client_id: string;
}

export interface MindBodyMismatchRow {
  id: string | number;
  email: string;
  first_name: string;
  last_name: string;
  tier: string;
  membership_status: string;
  billing_provider: string;
  mindbody_client_id: string;
}

export interface HubSpotDuplicateRow {
  hubspot_id: string;
  emails: string[];
  user_ids: number[];
  statuses: string[];
  tiers: string[];
  user_count: number;
}

export interface LinkedCountRow {
  linked_count: string;
}

export interface EmptySessionRow {
  id: number;
  session_date: string;
  resource_id: number;
  start_time: string;
  end_time: string;
  created_at: string;
  trackman_booking_id: string;
  resource_name: string;
  linked_booking_id: number;
  booking_trackman_id: string;
}

export interface OrphanPaymentIntentRow {
  id: string | number;
  booking_id: number;
  stripe_payment_intent_id: string;
  total_cents: number;
  status: string;
  created_at: string;
}

export interface OrphanGuestPassRow {
  id: string | number;
  member_email: string;
  passes_used: number;
  passes_total: number;
}

export interface HybridBillingRow {
  id: string | number;
  email: string;
  first_name: string;
  last_name: string;
  tier: string;
  membership_status: string;
  billing_provider: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  mindbody_client_id: string;
}

export interface DuplicateInvoiceRow {
  stripe_invoice_id: string;
  booking_count: number;
  booking_ids: number[];
}

export interface MissingInvoiceRow {
  id: string | number;
  user_email: string;
  request_date: string;
  status: string;
  total_unpaid_cents: number;
}

export interface OverlapRow {
  session1_id: number;
  session2_id: number;
  resource_id: number;
  session_date: string;
  start_time: string;
  end_time: string;
  overlap_start: string;
  overlap_end: string;
  booking1_id: number;
  booking1_status: string;
  booking2_id: number;
  booking2_status: string;
  member1_email: string;
  member1_first: string;
  member1_last: string;
  member2_email: string;
  member2_first: string;
  member2_last: string;
  resource_name: string;
}

export interface GuestPassOverUsedRow {
  id: string | number;
  member_email: string;
  passes_used: number;
  passes_total: number;
}

export interface OrphanHoldRow {
  id: string | number;
  member_email: string;
  booking_id: number;
  passes_held: number;
}

export interface ExpiredHoldRow {
  id: string | number;
  member_email: string;
  booking_id: number;
  passes_held: number;
  expires_at: string;
}

export interface StaleBookingRow {
  id: string | number;
  user_email: string;
  request_date: string;
  start_time: string;
  status: string;
  resource_id: number;
}

export interface AuditLogDetailsRow {
  issueKey?: string;
  resolutionMethod?: string;
  notes?: string;
}

export interface SyncPushUserRow {
  first_name: string;
  last_name: string;
  email: string;
  membership_tier: string;
  tier: string;
  membership_status: string;
}

export interface TotalRow {
  total: number | string;
}

export interface EmailRow {
  email: string;
}

export interface CaseNormRow {
  id: number;
  email: string;
  membership_status: string;
}

export interface HubSpotTierCandidateRow {
  id: number;
  user_email: string;
  hubspot_id: string;
  alt_email: string;
  suggested_tier: string;
}

export interface RemainingMemberRow {
  email: string;
  first_name: string;
  last_name: string;
  stripe_customer_id: string;
  mindbody_client_id: string;
}

export interface StaffSyncRow {
  email: string;
  new_role: string;
}

export interface SyncComparisonData {
  field: string;
  appValue: string | number | null;
  externalValue: string | number | null;
}

export interface IssueContext {
  memberName?: string;
  memberEmail?: string;
  memberTier?: string;
  bookingDate?: string;
  resourceName?: string;
  resourceId?: number;
  sessionId?: number;
  startTime?: string;
  endTime?: string;
  className?: string;
  classDate?: string;
  instructor?: string;
  eventTitle?: string;
  eventDate?: string;
  tourDate?: string;
  guestName?: string;
  linkedBookingId?: number;
  syncType?: 'hubspot' | 'calendar' | 'stripe';
  syncComparison?: SyncComparisonData[];
  hubspotContactId?: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  userId?: number;
  issueType?: string;
  sourceTable?: string;
  count?: number;
  duplicateUsers?: Array<{ userId: number; email: string; status: string; tier: string }>;
  trackmanBookingId?: string;
  userName?: string;
  userEmail?: string;
  bayNumber?: string | number;
  importedName?: string;
  notes?: string;
  originalEmail?: string;
  status?: string;
  errorType?: string;
  email?: string;
  memberEmails?: string | string[];
  lastUpdate?: string;
  memberStatus?: string;
  mindbodyClientId?: string;
  billingProvider?: string;
  stripeSubscriptionId?: string;
  stripeCustomerIds?: string[];
  booking1Id?: number;
  booking1Status?: string;
  member1Email?: string;
  member1Name?: string;
  booking2Id?: number;
  booking2Status?: string;
  member2Email?: string;
  member2Name?: string;
  bookingIds?: number[];
}

export interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality' | 'system_error' | 'billing_issue' | 'booking_issue';
  severity: 'error' | 'warning' | 'info';
  table: string;
  recordId: number | string;
  description: string;
  suggestion?: string;
  context?: IssueContext;
  ignored?: boolean;
  ignoreInfo?: {
    ignoredBy: string;
    ignoredAt: Date;
    expiresAt: Date;
    reason: string;
  };
}

export interface IntegrityCheckResult {
  checkName: string;
  status: 'pass' | 'warning' | 'fail' | 'info';
  issueCount: number;
  issues: IntegrityIssue[];
  lastRun: Date;
  durationMs?: number;
}

export interface IntegritySummary {
  totalChecks: number;
  passed: number;
  warnings: number;
  failed: number;
  totalIssues: number;
  lastRun: Date;
  checks: Array<{
    checkName: string;
    status: 'pass' | 'warning' | 'fail';
    issueCount: number;
  }>;
}

export interface CachedIntegrityResults {
  results: IntegrityCheckResult[];
  meta: {
    totalChecks: number;
    passed: number;
    warnings: number;
    failed: number;
    totalIssues: number;
    lastRun: Date;
    isCached: boolean;
  };
}

export const CHURNED_STATUSES = ['terminated', 'cancelled', 'non-member', 'deleted', 'former_member'];
export const NO_TIER_STATUSES = ['terminated', 'cancelled', 'non-member', 'deleted', 'former_member', 'expired', 'pending'];

export const severityMap: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  'HubSpot Sync Mismatch': 'critical',
  'Stripe Subscription Sync': 'critical',
  'Stuck Transitional Members': 'critical',
  'Active Bookings Without Sessions': 'critical',
  'Participant User Relationships': 'high',
  'Booking Time Validity': 'high',
  'Members Without Email': 'high',
  'Tier Reconciliation': 'high',
  'Duplicate Stripe Customers': 'high',
  'MindBody Stale Sync': 'medium',
  'MindBody Data Quality': 'medium',
  'Items Needing Review': 'low',
  'Stale Past Tours': 'low',
  'Unmatched Trackman Bookings': 'medium',
  'HubSpot ID Duplicates': 'high',
  'Sessions Without Participants': 'low',
  'Orphaned Payment Intents': 'critical',
  'Guest Passes Without Members': 'medium',
  'Billing Provider Hybrid State': 'critical',
  'Invoice-Booking Reconciliation': 'critical',
  'Overlapping Bookings': 'critical',
  'Guest Pass Accounting Drift': 'high',
  'Stale Pending Bookings': 'high',
  'Archived Member Lingering Data': 'high',
  'Active Members Without Waivers': 'medium',
  'Email Cascade Orphans': 'medium',
};

export function getCheckSeverity(checkName: string): 'critical' | 'high' | 'medium' | 'low' {
  return severityMap[checkName] || 'medium';
}

export function generateIssueKey(issue: IntegrityIssue): string {
  return `${issue.table}_${issue.recordId}`;
}

export async function safeCheck(
  checkFn: () => Promise<IntegrityCheckResult>,
  checkName: string
): Promise<IntegrityCheckResult> {
  const startTime = Date.now();
  try {
    const result = await checkFn();
    result.durationMs = Date.now() - startTime;
    return result;
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    return {
      checkName,
      status: 'warning',
      issueCount: 1,
      issues: [{
        category: 'system_error',
        severity: 'error',
        table: 'system',
        recordId: 'check_error',
        description: `Check "${checkName}" failed to complete: ${getErrorMessage(error)}`,
        suggestion: 'Review server logs for details and retry'
      }],
      lastRun: new Date(),
      durationMs
    };
  }
}

export async function storeCheckHistory(results: IntegrityCheckResult[], triggeredBy: 'manual' | 'scheduled' = 'manual'): Promise<void> {
  const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const result of results) {
    const severity = getCheckSeverity(result.checkName);
    if (severity === 'critical') criticalCount += result.issueCount;
    else if (severity === 'high') highCount += result.issueCount;
    else if (severity === 'medium') mediumCount += result.issueCount;
    else lowCount += result.issueCount;
  }

  await db.insert(integrityCheckHistory).values({
    totalIssues,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    resultsJson: results,
    triggeredBy
  });
}

export async function updateIssueTracking(results: IntegrityCheckResult[]): Promise<void> {
  const now = new Date();
  const currentIssueKeys = new Set<string>();

  for (const result of results) {
    const severity = getCheckSeverity(result.checkName);

    for (const issue of result.issues) {
      const issueKey = generateIssueKey(issue);
      currentIssueKeys.add(issueKey);

      const existing = await db.select()
        .from(integrityIssuesTracking)
        .where(eq(integrityIssuesTracking.issueKey, issueKey))
        .limit(1);

      if (existing.length > 0) {
        await db.update(integrityIssuesTracking)
          .set({
            lastSeenAt: now,
            resolvedAt: null,
            severity,
            description: issue.description
          })
          .where(eq(integrityIssuesTracking.issueKey, issueKey));
      } else {
        await db.insert(integrityIssuesTracking).values({
          issueKey,
          firstDetectedAt: now,
          lastSeenAt: now,
          checkName: result.checkName,
          severity,
          description: issue.description
        });
      }
    }
  }

  const allActive = await db.select()
    .from(integrityIssuesTracking)
    .where(isNull(integrityIssuesTracking.resolvedAt));

  for (const tracked of allActive) {
    if (!currentIssueKeys.has(tracked.issueKey)) {
      await db.update(integrityIssuesTracking)
        .set({ resolvedAt: now })
        .where(eq(integrityIssuesTracking.id, tracked.id));
    }
  }
}

export async function getCachedIntegrityResults(): Promise<CachedIntegrityResults | null> {
  const [latestRun] = await db.select()
    .from(integrityCheckHistory)
    .orderBy(desc(integrityCheckHistory.runAt))
    .limit(1);

  if (!latestRun || !latestRun.resultsJson) {
    return null;
  }

  const results: IntegrityCheckResult[] = JSON.parse(JSON.stringify(latestRun.resultsJson));

  const activeIgnores = await db.select()
    .from(integrityIgnores)
    .where(and(
      eq(integrityIgnores.isActive, true),
      gt(integrityIgnores.expiresAt, new Date())
    ));

  const ignoreMap = new Map(activeIgnores.map(i => [i.issueKey, i]));

  for (const check of results) {
    for (const issue of check.issues) {
      issue.recordId = String(issue.recordId);
      const issueKey = generateIssueKey(issue);
      const ignoreRule = ignoreMap.get(issueKey);
      if (ignoreRule) {
        issue.ignored = true;
        issue.ignoreInfo = {
          ignoredBy: ignoreRule.ignoredBy,
          ignoredAt: new Date(ignoreRule.ignoredAt),
          expiresAt: new Date(ignoreRule.expiresAt),
          reason: ignoreRule.reason
        };
      } else {
        issue.ignored = false;
        delete issue.ignoreInfo;
      }
    }
  }

  return {
    results,
    meta: {
      totalChecks: results.length,
      passed: results.filter(r => r.status === 'pass').length,
      warnings: results.filter(r => r.status === 'warning').length,
      failed: results.filter(r => r.status === 'fail').length,
      totalIssues: results.reduce((sum, r) => sum + r.issueCount, 0),
      lastRun: latestRun.runAt,
      isCached: true
    }
  };
}

export async function getIntegrityHistory(days: number = 30): Promise<{
  history: Array<{
    id: number;
    runAt: Date;
    totalIssues: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    triggeredBy: string;
  }>;
  trend: 'increasing' | 'decreasing' | 'stable';
  activeIssues: Array<{
    issueKey: string;
    checkName: string;
    severity: string;
    description: string;
    firstDetectedAt: Date;
    lastSeenAt: Date;
    daysUnresolved: number;
  }>;
}> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const history = await db.select({
    id: integrityCheckHistory.id,
    runAt: integrityCheckHistory.runAt,
    totalIssues: integrityCheckHistory.totalIssues,
    criticalCount: integrityCheckHistory.criticalCount,
    highCount: integrityCheckHistory.highCount,
    mediumCount: integrityCheckHistory.mediumCount,
    lowCount: integrityCheckHistory.lowCount,
    triggeredBy: integrityCheckHistory.triggeredBy
  })
    .from(integrityCheckHistory)
    .where(gte(integrityCheckHistory.runAt, cutoff))
    .orderBy(desc(integrityCheckHistory.runAt))
    .limit(100);

  let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (history.length >= 2) {
    const recent = history.slice(0, Math.min(5, history.length));
    const older = history.slice(Math.max(0, history.length - 5));
    const recentAvg = recent.reduce((sum, h) => sum + h.totalIssues, 0) / recent.length;
    const olderAvg = older.reduce((sum, h) => sum + h.totalIssues, 0) / older.length;

    if (recentAvg > olderAvg * 1.1) trend = 'increasing';
    else if (recentAvg < olderAvg * 0.9) trend = 'decreasing';
  }

  const activeIssues = await db.select()
    .from(integrityIssuesTracking)
    .where(isNull(integrityIssuesTracking.resolvedAt))
    .orderBy(desc(integrityIssuesTracking.firstDetectedAt));

  const now = new Date();
  const formattedIssues = activeIssues.map(issue => ({
    issueKey: issue.issueKey,
    checkName: issue.checkName,
    severity: issue.severity,
    description: issue.description,
    firstDetectedAt: issue.firstDetectedAt,
    lastSeenAt: issue.lastSeenAt,
    daysUnresolved: Math.floor((now.getTime() - issue.firstDetectedAt.getTime()) / (1000 * 60 * 60 * 24))
  }));

  return { history, trend, activeIssues: formattedIssues };
}

export async function getIntegritySummary(): Promise<IntegritySummary> {
  const { runAllIntegrityChecks } = await import('./index');
  const results = await runAllIntegrityChecks();

  const summary: IntegritySummary = {
    totalChecks: results.length,
    passed: results.filter(r => r.status === 'pass').length,
    warnings: results.filter(r => r.status === 'warning').length,
    failed: results.filter(r => r.status === 'fail').length,
    totalIssues: results.reduce((sum, r) => sum + r.issueCount, 0),
    lastRun: new Date(),
    checks: results.map(r => ({
      checkName: r.checkName,
      status: r.status as 'pass' | 'warning' | 'fail',
      issueCount: r.issueCount
    }))
  };

  return summary;
}

export async function runAllIntegrityChecks(triggeredBy: 'manual' | 'scheduled' = 'manual'): Promise<IntegrityCheckResult[]> {
  const { checkUnmatchedTrackmanBookings, checkParticipantUserRelationships, checkNeedsReviewItems, checkBookingTimeValidity, checkStalePastTours, checkBookingsWithoutSessions, checkOverlappingBookings, checkSessionsWithoutParticipants, checkGuestPassAccountingDrift, checkStalePendingBookings } = await import('./bookingChecks');
  const { checkHubSpotSyncMismatch, checkHubSpotIdDuplicates } = await import('./hubspotChecks');
  const { checkStripeSubscriptionSync, checkDuplicateStripeCustomers, checkOrphanedPaymentIntents, checkBillingProviderHybridState, checkInvoiceBookingReconciliation } = await import('./stripeChecks');
  const { checkMembersWithoutEmail, checkStuckTransitionalMembers, checkTierReconciliation, checkMindBodyStaleSyncMembers, checkMindBodyStatusMismatch, checkGuestPassesForNonExistentMembers, checkArchivedMemberLingeringData, checkActiveMembersWithoutWaivers, checkEmailOrphans } = await import('./memberChecks');

  const checks = await Promise.all([
    safeCheck(checkUnmatchedTrackmanBookings, 'Unmatched Trackman Bookings'),
    safeCheck(checkParticipantUserRelationships, 'Participant User Relationships'),
    safeCheck(checkHubSpotSyncMismatch, 'HubSpot Sync Mismatch'),
    safeCheck(checkNeedsReviewItems, 'Items Needing Review'),
    safeCheck(checkBookingTimeValidity, 'Booking Time Validity'),
    safeCheck(checkMembersWithoutEmail, 'Members Without Email'),
    safeCheck(checkStripeSubscriptionSync, 'Stripe Subscription Sync'),
    safeCheck(checkStuckTransitionalMembers, 'Stuck Transitional Members'),
    safeCheck(checkTierReconciliation, 'Tier Reconciliation'),
    safeCheck(checkBookingsWithoutSessions, 'Active Bookings Without Sessions'),
    safeCheck(checkDuplicateStripeCustomers, 'Duplicate Stripe Customers'),
    safeCheck(checkMindBodyStaleSyncMembers, 'MindBody Stale Sync'),
    safeCheck(checkMindBodyStatusMismatch, 'MindBody Data Quality'),
    safeCheck(checkHubSpotIdDuplicates, 'HubSpot ID Duplicates'),
    safeCheck(checkSessionsWithoutParticipants, 'Sessions Without Participants'),
    safeCheck(checkOrphanedPaymentIntents, 'Orphaned Payment Intents'),
    safeCheck(checkGuestPassesForNonExistentMembers, 'Guest Passes Without Members'),
    safeCheck(checkBillingProviderHybridState, 'Billing Provider Hybrid State'),
    safeCheck(checkInvoiceBookingReconciliation, 'Invoice-Booking Reconciliation'),
    safeCheck(checkOverlappingBookings, 'Overlapping Bookings'),
    safeCheck(checkGuestPassAccountingDrift, 'Guest Pass Accounting Drift'),
    safeCheck(checkStalePendingBookings, 'Stale Pending Bookings'),
    safeCheck(checkStalePastTours, 'Stale Past Tours'),
    safeCheck(checkArchivedMemberLingeringData, 'Archived Member Lingering Data'),
    safeCheck(checkActiveMembersWithoutWaivers, 'Active Members Without Waivers'),
    safeCheck(checkEmailOrphans, 'Email Cascade Orphans'),
  ]);

  const now = new Date();
  const activeIgnores = await db.select()
    .from(integrityIgnores)
    .where(and(
      eq(integrityIgnores.isActive, true),
      gt(integrityIgnores.expiresAt, now)
    ));

  const ignoreMap = new Map(activeIgnores.map(i => [i.issueKey, i]));

  for (const check of checks) {
    for (const issue of check.issues) {
      const issueKey = generateIssueKey(issue);
      const ignoreRule = ignoreMap.get(issueKey);
      if (ignoreRule) {
        issue.ignored = true;
        issue.ignoreInfo = {
          ignoredBy: ignoreRule.ignoredBy,
          ignoredAt: ignoreRule.ignoredAt,
          expiresAt: ignoreRule.expiresAt,
          reason: ignoreRule.reason
        };
      }
    }
  }

  try {
    await storeCheckHistory(checks, triggeredBy);
    await updateIssueTracking(checks);

    const checkSummaries = checks.map(c => ({
      checkName: c.checkName,
      status: c.status,
      issueCount: c.issueCount
    }));
    await alertOnCriticalIntegrityIssues(checkSummaries as IntegrityCheckSummary[], severityMap);
    await alertOnHighIntegrityIssues(checkSummaries as IntegrityCheckSummary[], severityMap);
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Failed to store history:', { error: err });
  }

  return checks;
}

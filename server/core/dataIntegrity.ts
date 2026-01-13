import { db } from '../db';
import { 
  bookingParticipants, 
  bookingSessions, 
  bookingRequests,
  wellnessEnrollments,
  wellnessClasses,
  eventRsvps,
  events,
  resources,
  users,
  tours,
  integrityCheckHistory,
  integrityIssuesTracking,
  integrityAuditLog,
  integrityIgnores
} from '../../shared/schema';
import { sql, eq, isNull, lt, and, or, gte, desc, isNotNull, gt } from 'drizzle-orm';
import { getHubSpotClient } from './integrations';
import { isProduction } from './db';
import { getTodayPacific } from '../utils/dateUtils';

const severityMap: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  'HubSpot Sync Status': 'critical',
  'HubSpot Sync Mismatch': 'critical',
  'Calendar Sync Mismatches': 'high',
  'Participant User Relationships': 'high',
  'Booking Request Integrity': 'high',
  'Booking Resource Relationships': 'high',
  'Booking Time Validity': 'high',
  'Members Without Email': 'high',
  'Orphan Booking Participants': 'medium',
  'Orphan Wellness Enrollments': 'medium',
  'Orphan Event RSVPs': 'medium',
  'Empty Booking Sessions': 'low',
  'Duplicate Tour Sources': 'low',
  'Items Needing Review': 'low',
  'Stale Past Tours': 'low'
};

function getCheckSeverity(checkName: string): 'critical' | 'high' | 'medium' | 'low' {
  return severityMap[checkName] || 'medium';
}

function generateIssueKey(issue: IntegrityIssue): string {
  return `${issue.table}_${issue.recordId}`;
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
  startTime?: string;
  endTime?: string;
  className?: string;
  classDate?: string;
  instructor?: string;
  eventTitle?: string;
  eventDate?: string;
  tourDate?: string;
  guestName?: string;
  syncType?: 'hubspot' | 'calendar';
  syncComparison?: SyncComparisonData[];
  hubspotContactId?: string;
  userId?: number;
}

export interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality';
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
  status: 'pass' | 'warning' | 'fail';
  issueCount: number;
  issues: IntegrityIssue[];
  lastRun: Date;
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

async function checkOrphanBookingParticipants(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const orphans = await db.execute(sql`
    SELECT bp.id, bp.session_id, bp.display_name, bp.participant_type
    FROM booking_participants bp
    LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
    WHERE bs.id IS NULL
  `);
  
  for (const row of orphans.rows as any[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'booking_participants',
      recordId: row.id,
      description: `Participant "${row.display_name}" (session_id: ${row.session_id}) has no valid booking session`,
      suggestion: 'Delete orphan participant record or recreate the booking session',
      context: {
        memberName: row.display_name || undefined
      }
    });
  }
  
  return {
    checkName: 'Orphan Booking Participants',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkEmptyBookingSessions(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const emptySessions = await db.execute(sql`
    SELECT bs.id, bs.session_date, bs.start_time, bs.end_time, bs.resource_id, r.name as resource_name
    FROM booking_sessions bs
    LEFT JOIN booking_participants bp ON bs.id = bp.session_id
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bp.id IS NULL
  `);
  
  for (const row of emptySessions.rows as any[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'warning',
      table: 'booking_sessions',
      recordId: row.id,
      description: `Booking session on ${row.session_date} at ${row.start_time} has no participants`,
      suggestion: 'Add participants or delete the empty session',
      context: {
        bookingDate: row.session_date || undefined,
        startTime: row.start_time || undefined,
        endTime: row.end_time || undefined,
        resourceName: row.resource_name || undefined
      }
    });
  }
  
  return {
    checkName: 'Empty Booking Sessions',
    status: issues.length === 0 ? 'pass' : issues.length > 5 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkOrphanWellnessEnrollments(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const orphans = await db.execute(sql`
    SELECT we.id, we.class_id, we.user_email
    FROM wellness_enrollments we
    LEFT JOIN wellness_classes wc ON we.class_id = wc.id
    WHERE wc.id IS NULL
  `);
  
  for (const row of orphans.rows as any[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'wellness_enrollments',
      recordId: row.id,
      description: `Enrollment for ${row.user_email} references non-existent class (class_id: ${row.class_id})`,
      suggestion: 'Delete orphan enrollment record',
      context: {
        memberEmail: row.user_email || undefined
      }
    });
  }
  
  return {
    checkName: 'Orphan Wellness Enrollments',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkOrphanEventRsvps(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const orphans = await db.execute(sql`
    SELECT er.id, er.event_id, er.user_email, er.attendee_name
    FROM event_rsvps er
    LEFT JOIN events e ON er.event_id = e.id
    WHERE e.id IS NULL
  `);
  
  for (const row of orphans.rows as any[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'event_rsvps',
      recordId: row.id,
      description: `RSVP for ${row.user_email} references non-existent event (event_id: ${row.event_id})`,
      suggestion: 'Delete orphan RSVP record',
      context: {
        memberName: row.attendee_name || undefined,
        memberEmail: row.user_email || undefined
      }
    });
  }
  
  return {
    checkName: 'Orphan Event RSVPs',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkBookingResourceRelationships(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const invalidResources = await db.execute(sql`
    SELECT br.id, br.resource_id, br.user_email, br.user_name, br.request_date, br.start_time, br.end_time
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    WHERE br.resource_id IS NOT NULL AND r.id IS NULL
  `);
  
  for (const row of invalidResources.rows as any[]) {
    issues.push({
      category: 'missing_relationship',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id,
      description: `Booking by ${row.user_email} on ${row.request_date} references non-existent resource (resource_id: ${row.resource_id})`,
      suggestion: 'Update booking to use a valid resource or delete the booking',
      context: {
        memberName: row.user_name || undefined,
        memberEmail: row.user_email || undefined,
        bookingDate: row.request_date || undefined,
        startTime: row.start_time || undefined,
        endTime: row.end_time || undefined
      }
    });
  }
  
  return {
    checkName: 'Booking Resource Relationships',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkParticipantUserRelationships(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const invalidUsers = await db.execute(sql`
    SELECT bp.id, bp.user_id, bp.display_name, bp.session_id,
           bs.session_date, bs.start_time, r.name as resource_name
    FROM booking_participants bp
    LEFT JOIN users u ON bp.user_id = u.id
    LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bp.user_id IS NOT NULL AND u.id IS NULL
  `);
  
  for (const row of invalidUsers.rows as any[]) {
    issues.push({
      category: 'missing_relationship',
      severity: 'warning',
      table: 'booking_participants',
      recordId: row.id,
      description: `Participant "${row.display_name}" references non-existent user (user_id: ${row.user_id})`,
      suggestion: 'Update participant to reference a valid user or mark as guest',
      context: {
        memberName: row.display_name || undefined,
        bookingDate: row.session_date || undefined,
        startTime: row.start_time || undefined,
        resourceName: row.resource_name || undefined
      }
    });
  }
  
  return {
    checkName: 'Participant User Relationships',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkHubSpotSyncMismatch(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  let hubspot: any;
  try {
    hubspot = await getHubSpotClient();
  } catch (err) {
    if (!isProduction) console.error('[DataIntegrity] HubSpot API error:', err);
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'hubspot_sync',
      recordId: 'hubspot_api',
      description: 'Unable to connect to HubSpot - API may be unavailable',
      suggestion: 'Check HubSpot integration connection'
    });
    
    return {
      checkName: 'HubSpot Sync Mismatch',
      status: 'warning',
      issueCount: issues.length,
      issues,
      lastRun: new Date()
    };
  }
  
  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, membership_tier, hubspot_id
    FROM users 
    WHERE hubspot_id IS NOT NULL
    LIMIT 100
  `);
  const appMembers = appMembersResult.rows as any[];
  
  for (const member of appMembers) {
    if (!member.hubspot_id) continue;
    
    try {
      const hubspotContact = await hubspot.crm.contacts.basicApi.getById(
        member.hubspot_id,
        ['firstname', 'lastname', 'email', 'membership_tier']
      );
      
      const props = hubspotContact.properties || {};
      const comparisons: SyncComparisonData[] = [];
      
      const appFirstName = (member.first_name || '').trim().toLowerCase();
      const hsFirstName = (props.firstname || '').trim().toLowerCase();
      if (appFirstName !== hsFirstName) {
        comparisons.push({
          field: 'First Name',
          appValue: member.first_name || null,
          externalValue: props.firstname || null
        });
      }
      
      const appLastName = (member.last_name || '').trim().toLowerCase();
      const hsLastName = (props.lastname || '').trim().toLowerCase();
      if (appLastName !== hsLastName) {
        comparisons.push({
          field: 'Last Name',
          appValue: member.last_name || null,
          externalValue: props.lastname || null
        });
      }
      
      const appTier = (member.membership_tier || '').trim().toLowerCase();
      const hsTier = (props.membership_tier || '').trim().toLowerCase();
      if (appTier !== hsTier) {
        comparisons.push({
          field: 'Membership Tier',
          appValue: member.membership_tier || null,
          externalValue: props.membership_tier || null
        });
      }
      
      if (comparisons.length > 0) {
        const fieldList = comparisons.map(c => c.field).join(', ');
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id,
          description: `Member "${member.first_name} ${member.last_name}" has mismatched data: ${fieldList}`,
          suggestion: 'Sync data between app and HubSpot',
          context: {
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || undefined,
            memberEmail: member.email || undefined,
            memberTier: member.membership_tier || undefined,
            syncType: 'hubspot',
            syncComparison: comparisons,
            hubspotContactId: member.hubspot_id,
            userId: member.id
          }
        });
      }
    } catch (err: any) {
      if (err?.response?.status === 404) {
        issues.push({
          category: 'sync_mismatch',
          severity: 'error',
          table: 'users',
          recordId: member.id,
          description: `Member "${member.first_name} ${member.last_name}" (hubspot_id: ${member.hubspot_id}) not found in HubSpot`,
          suggestion: 'Remove stale HubSpot ID or re-sync member',
          context: {
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || undefined,
            memberEmail: member.email || undefined,
            syncType: 'hubspot',
            hubspotContactId: member.hubspot_id,
            userId: member.id
          }
        });
      }
    }
  }
  
  return {
    checkName: 'HubSpot Sync Mismatch',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkDuplicateTourSources(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const duplicates = await db.select()
    .from(tours)
    .where(
      and(
        sql`${tours.googleCalendarId} IS NOT NULL`,
        sql`${tours.hubspotMeetingId} IS NOT NULL`
      )
    );
  
  for (const tour of duplicates) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'warning',
      table: 'tours',
      recordId: tour.id,
      description: `Tour "${tour.title}" on ${tour.tourDate} has both Google Calendar ID and HubSpot Meeting ID (potential duplicate sync)`,
      suggestion: 'Review and remove duplicate source link',
      context: {
        tourDate: tour.tourDate || undefined,
        guestName: tour.guestName || undefined,
        startTime: tour.startTime || undefined
      }
    });
  }
  
  return {
    checkName: 'Duplicate Tour Sources',
    status: issues.length === 0 ? 'pass' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkNeedsReviewItems(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const eventsNeedingReview = await db.execute(sql`
    SELECT id, title, event_date, start_time FROM events WHERE needs_review = true
  `);
  
  const wellnessNeedingReview = await db.execute(sql`
    SELECT id, title, date, instructor, time AS start_time FROM wellness_classes WHERE needs_review = true
  `);
  
  for (const row of eventsNeedingReview.rows as any[]) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'events',
      recordId: row.id,
      description: `Event "${row.title}" on ${row.event_date} needs review`,
      suggestion: 'Review and approve the event in admin panel',
      context: {
        eventTitle: row.title || undefined,
        eventDate: row.event_date || undefined,
        startTime: row.start_time || undefined
      }
    });
  }
  
  for (const row of wellnessNeedingReview.rows as any[]) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'wellness_classes',
      recordId: row.id,
      description: `Wellness class "${row.title}" on ${row.date} needs review`,
      suggestion: 'Review and approve the class in admin panel',
      context: {
        className: row.title || undefined,
        classDate: row.date || undefined,
        instructor: row.instructor || undefined,
        startTime: row.start_time || undefined
      }
    });
  }
  
  return {
    checkName: 'Items Needing Review',
    status: issues.length === 0 ? 'pass' : 'info' as any,
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkBookingTimeValidity(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const invalidBookings = await db.execute(sql`
    SELECT br.id, br.user_email, br.user_name, br.request_date, br.start_time, br.end_time, r.name as resource_name
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    WHERE br.end_time < br.start_time
  `);
  
  for (const row of invalidBookings.rows as any[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id,
      description: `Booking by ${row.user_email} on ${row.request_date} has end_time (${row.end_time}) before start_time (${row.start_time})`,
      suggestion: 'Fix the booking times or delete the invalid booking',
      context: {
        memberName: row.user_name || undefined,
        memberEmail: row.user_email || undefined,
        bookingDate: row.request_date || undefined,
        startTime: row.start_time || undefined,
        endTime: row.end_time || undefined,
        resourceName: row.resource_name || undefined
      }
    });
  }
  
  const invalidSessions = await db.execute(sql`
    SELECT bs.id, bs.session_date, bs.start_time, bs.end_time, r.name as resource_name
    FROM booking_sessions bs
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bs.end_time < bs.start_time
  `);
  
  for (const row of invalidSessions.rows as any[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_sessions',
      recordId: row.id,
      description: `Booking session on ${row.session_date} has end_time (${row.end_time}) before start_time (${row.start_time})`,
      suggestion: 'Fix the session times or delete the invalid session',
      context: {
        bookingDate: row.session_date || undefined,
        startTime: row.start_time || undefined,
        endTime: row.end_time || undefined,
        resourceName: row.resource_name || undefined
      }
    });
  }
  
  return {
    checkName: 'Booking Time Validity',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkStalePastTours(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  const today = getTodayPacific();
  
  const staleTours = await db.execute(sql`
    SELECT id, title, tour_date, status, guest_name, guest_email, start_time
    FROM tours
    WHERE tour_date < ${today}
    AND status IN ('pending', 'scheduled')
  `);
  
  for (const row of staleTours.rows as any[]) {
    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'tours',
      recordId: row.id,
      description: `Tour "${row.title}" for ${row.guest_name || 'unknown guest'} on ${row.tour_date} is in the past but still marked as "${row.status}"`,
      suggestion: 'Update tour status to completed, no-show, or cancelled',
      context: {
        guestName: row.guest_name || undefined,
        memberEmail: row.guest_email || undefined,
        tourDate: row.tour_date || undefined,
        startTime: row.start_time || undefined
      }
    });
  }
  
  return {
    checkName: 'Stale Past Tours',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkMembersWithoutEmail(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const noEmailMembers = await db.execute(sql`
    SELECT id, first_name, last_name, hubspot_id, membership_tier
    FROM users
    WHERE email IS NULL OR email = ''
  `);
  
  for (const row of noEmailMembers.rows as any[]) {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'users',
      recordId: row.id,
      description: `Member "${name}" (id: ${row.id}) has no email address`,
      suggestion: 'Add an email address for this member or merge with existing record',
      context: {
        memberName: name,
        memberTier: row.membership_tier || undefined
      }
    });
  }
  
  return {
    checkName: 'Members Without Email',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function storeCheckHistory(results: IntegrityCheckResult[], triggeredBy: 'manual' | 'scheduled' = 'manual'): Promise<void> {
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

async function updateIssueTracking(results: IntegrityCheckResult[]): Promise<void> {
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

export async function runAllIntegrityChecks(triggeredBy: 'manual' | 'scheduled' = 'manual'): Promise<IntegrityCheckResult[]> {
  const checks = await Promise.all([
    checkOrphanBookingParticipants(),
    checkEmptyBookingSessions(),
    checkOrphanWellnessEnrollments(),
    checkOrphanEventRsvps(),
    checkBookingResourceRelationships(),
    checkParticipantUserRelationships(),
    checkHubSpotSyncMismatch(),
    checkDuplicateTourSources(),
    checkNeedsReviewItems(),
    checkBookingTimeValidity(),
    checkStalePastTours(),
    checkMembersWithoutEmail()
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
  } catch (err) {
    if (!isProduction) console.error('[DataIntegrity] Failed to store history:', err);
  }
  
  return checks;
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
      status: r.status,
      issueCount: r.issueCount
    }))
  };
  
  return summary;
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

export interface ResolveIssueParams {
  issueKey: string;
  action: 'resolved' | 'ignored' | 'reopened';
  actionBy: string;
  resolutionMethod?: string;
  notes?: string;
}

export async function resolveIssue(params: ResolveIssueParams): Promise<{ auditLogId: number }> {
  const { issueKey, action, actionBy, resolutionMethod, notes } = params;
  
  const [auditEntry] = await db.insert(integrityAuditLog).values({
    issueKey,
    action,
    actionBy,
    resolutionMethod: resolutionMethod || null,
    notes: notes || null
  }).returning({ id: integrityAuditLog.id });
  
  if (action === 'resolved' || action === 'ignored') {
    await db.update(integrityIssuesTracking)
      .set({ resolvedAt: new Date() })
      .where(eq(integrityIssuesTracking.issueKey, issueKey));
  } else if (action === 'reopened') {
    await db.update(integrityIssuesTracking)
      .set({ resolvedAt: null })
      .where(eq(integrityIssuesTracking.issueKey, issueKey));
  }
  
  return { auditLogId: auditEntry.id };
}

export async function getAuditLog(limit: number = 10): Promise<Array<{
  id: number;
  issueKey: string;
  action: string;
  actionBy: string;
  actionAt: Date;
  resolutionMethod: string | null;
  notes: string | null;
}>> {
  const entries = await db.select()
    .from(integrityAuditLog)
    .orderBy(desc(integrityAuditLog.actionAt))
    .limit(limit);
  
  return entries;
}

export interface SyncPushParams {
  issueKey: string;
  target: 'hubspot' | 'calendar';
  userId?: number;
  hubspotContactId?: string;
}

export interface SyncPullParams {
  issueKey: string;
  target: 'hubspot' | 'calendar';
  userId?: number;
  hubspotContactId?: string;
}

export async function syncPush(params: SyncPushParams): Promise<{ success: boolean; message: string }> {
  const { target, userId, hubspotContactId } = params;
  
  if (target === 'hubspot') {
    if (!userId || !hubspotContactId) {
      throw new Error('userId and hubspotContactId are required for HubSpot push');
    }
    
    const userResult = await db.execute(sql`
      SELECT first_name, last_name, email, membership_tier
      FROM users WHERE id = ${userId}
    `);
    
    if (userResult.rows.length === 0) {
      throw new Error(`User with id ${userId} not found`);
    }
    
    const user = userResult.rows[0] as any;
    
    const hubspot = await getHubSpotClient();
    
    await hubspot.crm.contacts.basicApi.update(hubspotContactId, {
      properties: {
        firstname: user.first_name || '',
        lastname: user.last_name || '',
        membership_tier: user.membership_tier || ''
      }
    });
    
    return { 
      success: true, 
      message: `Pushed app data to HubSpot contact ${hubspotContactId}` 
    };
  }
  
  throw new Error(`Unsupported sync target: ${target}`);
}

export async function syncPull(params: SyncPullParams): Promise<{ success: boolean; message: string }> {
  const { target, userId, hubspotContactId } = params;
  
  if (target === 'hubspot') {
    if (!userId || !hubspotContactId) {
      throw new Error('userId and hubspotContactId are required for HubSpot pull');
    }
    
    const hubspot = await getHubSpotClient();
    
    const contact = await hubspot.crm.contacts.basicApi.getById(
      hubspotContactId,
      ['firstname', 'lastname', 'email', 'membership_tier']
    );
    
    const props = contact.properties || {};
    
    await db.execute(sql`
      UPDATE users SET
        first_name = ${props.firstname || null},
        last_name = ${props.lastname || null},
        membership_tier = ${props.membership_tier || null}
      WHERE id = ${userId}
    `);
    
    return { 
      success: true, 
      message: `Pulled HubSpot data to app user ${userId}` 
    };
  }
  
  throw new Error(`Unsupported sync target: ${target}`);
}

export interface CreateIgnoreParams {
  issueKey: string;
  duration: '24h' | '1w' | '30d';
  reason: string;
  ignoredBy: string;
}

export async function createIgnoreRule(params: CreateIgnoreParams): Promise<{
  id: number;
  issueKey: string;
  expiresAt: Date;
}> {
  const { issueKey, duration, reason, ignoredBy } = params;
  
  const now = new Date();
  let expiresAt: Date;
  
  switch (duration) {
    case '24h':
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      break;
    case '1w':
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      throw new Error(`Invalid duration: ${duration}`);
  }
  
  const existing = await db.select()
    .from(integrityIgnores)
    .where(eq(integrityIgnores.issueKey, issueKey))
    .limit(1);
  
  if (existing.length > 0) {
    const [updated] = await db.update(integrityIgnores)
      .set({
        ignoredBy,
        ignoredAt: now,
        expiresAt,
        reason,
        isActive: true
      })
      .where(eq(integrityIgnores.issueKey, issueKey))
      .returning({ id: integrityIgnores.id });
    
    return { id: updated.id, issueKey, expiresAt };
  }
  
  const [inserted] = await db.insert(integrityIgnores)
    .values({
      issueKey,
      ignoredBy,
      ignoredAt: now,
      expiresAt,
      reason,
      isActive: true
    })
    .returning({ id: integrityIgnores.id });
  
  return { id: inserted.id, issueKey, expiresAt };
}

export async function removeIgnoreRule(issueKey: string): Promise<{ removed: boolean }> {
  const result = await db.update(integrityIgnores)
    .set({ isActive: false })
    .where(eq(integrityIgnores.issueKey, issueKey));
  
  return { removed: true };
}

export interface IgnoredIssue {
  id: number;
  issueKey: string;
  ignoredBy: string;
  ignoredAt: Date;
  expiresAt: Date;
  reason: string;
  isActive: boolean;
  isExpired: boolean;
}

export async function getIgnoredIssues(): Promise<IgnoredIssue[]> {
  const now = new Date();
  
  const ignores = await db.select()
    .from(integrityIgnores)
    .where(eq(integrityIgnores.isActive, true))
    .orderBy(desc(integrityIgnores.ignoredAt));
  
  return ignores.map(ignore => ({
    ...ignore,
    isExpired: ignore.expiresAt < now
  }));
}

export async function getActiveIgnoreKeys(): Promise<Set<string>> {
  const now = new Date();
  
  const activeIgnores = await db.select({ issueKey: integrityIgnores.issueKey })
    .from(integrityIgnores)
    .where(and(
      eq(integrityIgnores.isActive, true),
      gt(integrityIgnores.expiresAt, now)
    ));
  
  return new Set(activeIgnores.map(i => i.issueKey));
}

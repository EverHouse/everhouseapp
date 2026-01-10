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
  tours
} from '../../shared/schema';
import { sql, eq, isNull, lt, and, or } from 'drizzle-orm';
import { getHubSpotClient } from './integrations';
import { isProduction } from './db';
import { getTodayPacific } from '../utils/dateUtils';

export interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality';
  severity: 'error' | 'warning' | 'info';
  table: string;
  recordId: number | string;
  description: string;
  suggestion?: string;
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
    SELECT bp.id, bp.session_id, bp.display_name
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
      suggestion: 'Delete orphan participant record or recreate the booking session'
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
    SELECT bs.id, bs.session_date, bs.start_time, bs.resource_id
    FROM booking_sessions bs
    LEFT JOIN booking_participants bp ON bs.id = bp.session_id
    WHERE bp.id IS NULL
  `);
  
  for (const row of emptySessions.rows as any[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'warning',
      table: 'booking_sessions',
      recordId: row.id,
      description: `Booking session on ${row.session_date} at ${row.start_time} has no participants`,
      suggestion: 'Add participants or delete the empty session'
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
      suggestion: 'Delete orphan enrollment record'
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
    SELECT er.id, er.event_id, er.user_email
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
      suggestion: 'Delete orphan RSVP record'
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
    SELECT br.id, br.resource_id, br.user_email, br.request_date
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
      suggestion: 'Update booking to use a valid resource or delete the booking'
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
    SELECT bp.id, bp.user_id, bp.display_name, bp.session_id
    FROM booking_participants bp
    LEFT JOIN users u ON bp.user_id = u.id
    WHERE bp.user_id IS NOT NULL AND u.id IS NULL
  `);
  
  for (const row of invalidUsers.rows as any[]) {
    issues.push({
      category: 'missing_relationship',
      severity: 'warning',
      table: 'booking_participants',
      recordId: row.id,
      description: `Participant "${row.display_name}" references non-existent user (user_id: ${row.user_id})`,
      suggestion: 'Update participant to reference a valid user or mark as guest'
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
  
  const appMembersResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM users WHERE hubspot_id IS NOT NULL
  `);
  const appMemberCount = parseInt((appMembersResult.rows[0] as any).count || '0');
  
  let hubspotContactCount = 0;
  try {
    const hubspot = await getHubSpotClient();
    const response = await hubspot.crm.contacts.basicApi.getPage(1, undefined, []);
    hubspotContactCount = response.total || 0;
  } catch (err) {
    if (!isProduction) console.error('[DataIntegrity] HubSpot API error:', err);
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'hubspot_sync',
      recordId: 'hubspot_api',
      description: 'Unable to fetch HubSpot contact count - API may be unavailable',
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
  
  const difference = Math.abs(hubspotContactCount - appMemberCount);
  const percentDiff = hubspotContactCount > 0 ? (difference / hubspotContactCount) * 100 : 0;
  
  if (difference > 10 || percentDiff > 5) {
    issues.push({
      category: 'sync_mismatch',
      severity: percentDiff > 20 ? 'error' : 'warning',
      table: 'users',
      recordId: 'hubspot_sync',
      description: `App has ${appMemberCount} synced members, HubSpot has ${hubspotContactCount} contacts (difference: ${difference})`,
      suggestion: 'Run a full member sync from HubSpot'
    });
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
      suggestion: 'Review and remove duplicate source link'
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
    SELECT id, title, event_date FROM events WHERE needs_review = true
  `);
  
  const wellnessNeedingReview = await db.execute(sql`
    SELECT id, title, date FROM wellness_classes WHERE needs_review = true
  `);
  
  for (const row of eventsNeedingReview.rows as any[]) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'events',
      recordId: row.id,
      description: `Event "${row.title}" on ${row.event_date} needs review`,
      suggestion: 'Review and approve the event in admin panel'
    });
  }
  
  for (const row of wellnessNeedingReview.rows as any[]) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'wellness_classes',
      recordId: row.id,
      description: `Wellness class "${row.title}" on ${row.date} needs review`,
      suggestion: 'Review and approve the class in admin panel'
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
    SELECT id, user_email, request_date, start_time, end_time
    FROM booking_requests
    WHERE end_time < start_time
  `);
  
  for (const row of invalidBookings.rows as any[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id,
      description: `Booking by ${row.user_email} on ${row.request_date} has end_time (${row.end_time}) before start_time (${row.start_time})`,
      suggestion: 'Fix the booking times or delete the invalid booking'
    });
  }
  
  const invalidSessions = await db.execute(sql`
    SELECT id, session_date, start_time, end_time
    FROM booking_sessions
    WHERE end_time < start_time
  `);
  
  for (const row of invalidSessions.rows as any[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_sessions',
      recordId: row.id,
      description: `Booking session on ${row.session_date} has end_time (${row.end_time}) before start_time (${row.start_time})`,
      suggestion: 'Fix the session times or delete the invalid session'
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
    SELECT id, title, tour_date, status, guest_name
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
      suggestion: 'Update tour status to completed, no-show, or cancelled'
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
    SELECT id, first_name, last_name, hubspot_id
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
      suggestion: 'Add an email address for this member or merge with existing record'
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

export async function runAllIntegrityChecks(): Promise<IntegrityCheckResult[]> {
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
  
  return checks;
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

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
import { getStripeClient } from './stripe/client';
import { alertOnCriticalIntegrityIssues, alertOnHighIntegrityIssues } from './dataAlerts';

const severityMap: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  'HubSpot Sync Status': 'critical',
  'HubSpot Sync Mismatch': 'critical',
  'Deal Stage Drift': 'critical',
  'Stripe Subscription Sync': 'critical',
  'Stuck Transitional Members': 'critical',
  'Calendar Sync Mismatches': 'high',
  'Participant User Relationships': 'high',
  'Booking Request Integrity': 'high',
  'Booking Resource Relationships': 'high',
  'Booking Time Validity': 'high',
  'Members Without Email': 'high',
  'Deals Without Line Items': 'high',
  'Tier Reconciliation': 'high',
  'Orphan Booking Participants': 'medium',
  'Orphan Wellness Enrollments': 'medium',
  'Orphan Event RSVPs': 'medium',
  'Empty Booking Sessions': 'low',
  'Duplicate Tour Sources': 'low',
  'Items Needing Review': 'low',
  'Stale Past Tours': 'low',
  'Unmatched Trackman Bookings': 'medium'
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
  syncType?: 'hubspot' | 'calendar' | 'stripe';
  syncComparison?: SyncComparisonData[];
  hubspotContactId?: string;
  stripeCustomerId?: string;
  userId?: number;
  trackmanBookingId?: string;
  userName?: string;
  userEmail?: string;
  bayNumber?: string | number;
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

async function checkUnmatchedTrackmanBookings(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  try {
    const unmatchedBookings = await db.execute(sql`
      SELECT tub.id, tub.trackman_booking_id, tub.user_name, tub.user_email, tub.booking_date, tub.bay_number, tub.start_time, tub.end_time
      FROM trackman_unmatched_bookings tub
      WHERE tub.resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM booking_requests br 
          WHERE br.trackman_booking_id = tub.trackman_booking_id::text
        )
      ORDER BY tub.booking_date DESC
      LIMIT 100
    `);
    
    const totalCount = await db.execute(sql`
      SELECT COUNT(*)::int as count 
      FROM trackman_unmatched_bookings tub
      WHERE tub.resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM booking_requests br 
          WHERE br.trackman_booking_id = tub.trackman_booking_id::text
        )
    `);
    const total = (totalCount.rows[0] as any)?.count || 0;
    
    for (const row of unmatchedBookings.rows as any[]) {
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'trackman_unmatched_bookings',
        recordId: row.id,
        description: `Trackman booking for "${row.user_name || 'Unknown'}" (${row.user_email || 'no email'}) on ${row.booking_date} has no matching member`,
        suggestion: 'Use the Trackman Unmatched Bookings section to link this booking to a member or create a visitor record',
        context: {
          trackmanBookingId: row.trackman_booking_id || undefined,
          userName: row.user_name || undefined,
          userEmail: row.user_email || undefined,
          bookingDate: row.booking_date || undefined,
          bayNumber: row.bay_number || undefined,
          startTime: row.start_time || undefined,
          endTime: row.end_time || undefined
        }
      });
    }
    
    return {
      checkName: 'Unmatched Trackman Bookings',
      status: total === 0 ? 'pass' : total > 50 ? 'fail' : 'warning',
      issueCount: total,
      issues,
      lastRun: new Date()
    };
  } catch (error: any) {
    console.error('[DataIntegrity] Error checking unmatched Trackman bookings:', error.message);
    return {
      checkName: 'Unmatched Trackman Bookings',
      status: 'pass',
      issueCount: 0,
      issues: [],
      lastRun: new Date()
    };
  }
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
  
  // Note: booking_participants.user_id stores user UUIDs that should match users.id
  const invalidUsers = await db.execute(sql`
    SELECT bp.id, bp.user_id, bp.display_name, bp.session_id,
           bs.session_date, bs.start_time, r.name as resource_name
    FROM booking_participants bp
    LEFT JOIN users u ON bp.user_id = u.id
    LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bp.user_id IS NOT NULL AND bp.user_id != '' AND u.id IS NULL
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
  
  // FIX: Use ORDER BY RANDOM() to ensure all members are eventually checked over time
  // Previously, LIMIT 100 without ordering always checked the same 100 members
  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, membership_tier, hubspot_id
    FROM users 
    WHERE hubspot_id IS NOT NULL
    ORDER BY RANDOM()
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
  
  // Exclude cross-midnight bookings (e.g., 23:00-01:00) which are valid late-night events
  const invalidBookings = await db.execute(sql`
    SELECT br.id, br.user_email, br.user_name, br.request_date, br.start_time, br.end_time, r.name as resource_name
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    WHERE br.end_time < br.start_time
    AND NOT (br.start_time >= '20:00:00' AND br.end_time <= '06:00:00')
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
  
  // Exclude cross-midnight sessions (e.g., 23:00-01:00) which are valid late-night events
  const invalidSessions = await db.execute(sql`
    SELECT bs.id, bs.session_date, bs.start_time, bs.end_time, r.name as resource_name
    FROM booking_sessions bs
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bs.end_time < bs.start_time
    AND NOT (bs.start_time >= '20:00:00' AND bs.end_time <= '06:00:00')
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

async function checkDealsWithoutLineItems(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  // Exclude legacy deals - these predate line item tracking and are expected to have no products
  const dealsWithoutLineItems = await db.execute(sql`
    SELECT hd.id, hd.member_email, hd.hubspot_deal_id, hd.deal_name, hd.pipeline_stage
    FROM hubspot_deals hd
    LEFT JOIN hubspot_line_items hli ON hd.hubspot_deal_id = hli.hubspot_deal_id
    WHERE hli.id IS NULL
      AND hd.deal_name NOT LIKE '%(Legacy)%'
  `);
  
  for (const row of dealsWithoutLineItems.rows as any[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'hubspot_deals',
      recordId: row.id,
      description: `Deal "${row.deal_name || 'Unnamed'}" for ${row.member_email} has no product line items`,
      suggestion: 'Add product line items to this deal in the billing section or HubSpot',
      context: {
        memberEmail: row.member_email || undefined
      }
    });
  }
  
  return {
    checkName: 'Deals Without Line Items',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkDealStageDrift(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const STAGE_MAPPING: Record<string, string> = {
    'active': 'closedwon',
    'pending': '2825519820',
    'declined': '2825519820',
    'suspended': '2825519820',
    'expired': '2825519820',
    'froze': '2825519820',
    'frozen': '2825519820',
    'past_due': '2825519820',
    'pastdue': '2825519820',
    'paymentfailed': '2825519820',
    'terminated': 'closedlost',
    'cancelled': 'closedlost',
    'non-member': 'closedlost',
    'nonmember': 'closedlost'
  };
  
  const STAGE_NAMES: Record<string, string> = {
    'closedwon': 'Active Members',
    '2825519820': 'Payment Declined',
    'closedlost': 'Closed Lost'
  };
  
  const driftingDeals = await db.execute(sql`
    SELECT 
      hd.id,
      hd.member_email,
      hd.hubspot_deal_id,
      hd.deal_name,
      hd.pipeline_stage as current_stage,
      u.membership_status,
      u.first_name,
      u.last_name,
      u.tier
    FROM hubspot_deals hd
    JOIN users u ON LOWER(u.email) = LOWER(hd.member_email)
    WHERE u.role = 'member'
      AND hd.pipeline_stage IS NOT NULL
      AND u.membership_status IS NOT NULL
  `);
  
  for (const row of driftingDeals.rows as any[]) {
    const membershipStatus = (row.membership_status || 'non-member').toLowerCase();
    const expectedStage = STAGE_MAPPING[membershipStatus] || 'closedlost';
    const currentStage = row.current_stage;
    
    if (currentStage !== expectedStage) {
      const memberName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
      const expectedStageName = STAGE_NAMES[expectedStage] || expectedStage;
      const currentStageName = STAGE_NAMES[currentStage] || currentStage;
      
      issues.push({
        category: 'sync_mismatch',
        severity: 'error',
        table: 'hubspot_deals',
        recordId: row.id,
        description: `Deal for ${row.member_email} is in "${currentStageName}" but membership status is "${membershipStatus}" (should be in "${expectedStageName}")`,
        suggestion: `Update deal stage to match membership status or correct membership status in HubSpot`,
        context: {
          memberName,
          memberEmail: row.member_email,
          memberTier: row.tier || undefined,
          syncType: 'hubspot',
          syncComparison: [
            { field: 'Deal Stage', appValue: currentStageName, externalValue: expectedStageName },
            { field: 'Membership Status', appValue: membershipStatus, externalValue: null }
          ]
        }
      });
    }
  }
  
  return {
    checkName: 'Deal Stage Drift',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkStripeSubscriptionSync(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  let stripe: any;
  try {
    stripe = await getStripeClient();
  } catch (err) {
    if (!isProduction) console.error('[DataIntegrity] Stripe API error:', err);
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'stripe_sync',
      recordId: 'stripe_api',
      description: 'Unable to connect to Stripe - API may be unavailable',
      suggestion: 'Check Stripe integration connection'
    });
    
    return {
      checkName: 'Stripe Subscription Sync',
      status: 'warning',
      issueCount: issues.length,
      issues,
      lastRun: new Date()
    };
  }
  
  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, billing_provider
    FROM users 
    WHERE stripe_customer_id IS NOT NULL
      AND membership_status IS NOT NULL
      AND role = 'member'
      AND (billing_provider IS NULL OR billing_provider != 'mindbody')
    LIMIT 100
  `);
  const appMembers = appMembersResult.rows as any[];
  
  if (appMembers.length === 0) {
    return {
      checkName: 'Stripe Subscription Sync',
      status: 'pass',
      issueCount: 0,
      issues: [],
      lastRun: new Date()
    };
  }
  
  const STATUS_MAPPING: Record<string, string[]> = {
    'active': ['active', 'trialing'],
    'pending': ['incomplete', 'incomplete_expired', 'past_due'],
    'past_due': ['past_due'],
    'suspended': ['past_due', 'unpaid'],
    'frozen': ['past_due', 'unpaid'],
    'cancelled': ['canceled'],
    'terminated': ['canceled'],
    'inactive': ['canceled', 'unpaid', 'incomplete_expired']
  };
  
  const STRIPE_STATUS_TO_EXPECTED_DB: Record<string, string[]> = {
    'active': ['active'],
    'trialing': ['active', 'pending'],
    'past_due': ['active', 'past_due', 'pending', 'suspended', 'frozen'],
    'canceled': ['cancelled', 'terminated', 'inactive', 'non-member'],
    'unpaid': ['suspended', 'frozen', 'inactive'],
    'incomplete': ['pending'],
    'incomplete_expired': ['pending', 'inactive']
  };
  
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 100;
  
  const processMember = async (member: any): Promise<void> => {
    const customerId = member.stripe_customer_id;
    if (!customerId) return;
    
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const dbStatus = (member.membership_status || '').toLowerCase();
    const dbTier = (member.tier || '').toLowerCase();
    
    try {
      const customerSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10,
        expand: ['data.items.data.price']
      });
      
      if (!customerSubs.data || customerSubs.data.length === 0) {
        if (dbStatus === 'active') {
          issues.push({
            category: 'sync_mismatch',
            severity: 'error',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" shows as active in database but has no Stripe subscription (billing via Stripe)`,
            suggestion: 'Verify member payment status or update membership status. Note: MindBody-billed members are excluded from this check.',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: member.id,
              syncComparison: [
                { field: 'Subscription', appValue: dbStatus, externalValue: 'no subscription' }
              ]
            }
          });
        }
        return;
      }
      
      const activeSub = customerSubs.data.find(s => 
        ['active', 'trialing', 'past_due'].includes(s.status)
      ) || customerSubs.data[0];
      
      const stripeStatus = activeSub.status;
      const comparisons: SyncComparisonData[] = [];
      
      const expectedDbStatuses = STRIPE_STATUS_TO_EXPECTED_DB[stripeStatus] || [];
      const statusMatches = expectedDbStatuses.includes(dbStatus);
      
      if (!statusMatches) {
        const isStatusMismatch = 
          (dbStatus === 'active' && ['canceled', 'unpaid', 'incomplete_expired'].includes(stripeStatus)) ||
          (['cancelled', 'terminated', 'inactive'].includes(dbStatus) && ['active', 'trialing'].includes(stripeStatus));
        
        comparisons.push({
          field: 'Membership Status',
          appValue: member.membership_status || null,
          externalValue: stripeStatus
        });
        
        if (isStatusMismatch) {
          issues.push({
            category: 'sync_mismatch',
            severity: 'error',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" has status mismatch: DB shows "${member.membership_status}" but Stripe subscription is "${stripeStatus}"`,
            suggestion: 'Sync membership status with Stripe subscription state',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: member.id,
              syncComparison: comparisons
            }
          });
          return;
        }
      }
      
      const item = activeSub.items?.data?.[0];
      const price = item?.price;
      const product = typeof price?.product === 'object' ? price.product : null;
      
      if (product && dbTier) {
        const productTier = (product.metadata?.tier || product.name || '').toLowerCase();
        const productName = (product.name || '').toLowerCase();
        
        const tierMatches = 
          productTier.includes(dbTier) || 
          dbTier.includes(productTier) ||
          productName.includes(dbTier) ||
          dbTier.includes(productName);
        
        if (!tierMatches && productTier) {
          comparisons.push({
            field: 'Membership Tier',
            appValue: member.tier || null,
            externalValue: product.metadata?.tier || product.name || null
          });
          
          issues.push({
            category: 'sync_mismatch',
            severity: 'warning',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" has tier mismatch: DB tier is "${member.tier}" but Stripe product is "${product.name}"`,
            suggestion: 'Update database tier to match Stripe subscription product',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: member.id,
              syncComparison: comparisons
            }
          });
        }
      }
    } catch (err: any) {
      const isCustomerNotFound = err?.type === 'StripeInvalidRequestError' && 
        (err?.code === 'resource_missing' || err?.message?.includes('No such customer'));
      
      if (isCustomerNotFound) {
        issues.push({
          category: 'data_quality',
          severity: 'error',
          table: 'users',
          recordId: member.id,
          description: `Member "${memberName}" has orphaned Stripe customer ID (${customerId}) - customer no longer exists in Stripe`,
          suggestion: 'Clear the stripe_customer_id field or run Stripe cleanup to remove orphaned references',
          context: {
            memberName,
            memberEmail: member.email || undefined,
            stripeCustomerId: customerId,
            userId: member.id,
            errorType: 'orphaned_stripe_customer'
          }
        });
      } else {
        if (!isProduction) console.warn(`[DataIntegrity] Stripe API error for ${customerId}:`, err.message);
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id,
          description: `Error fetching Stripe subscriptions for "${memberName}": ${err.message}`,
          suggestion: 'Check Stripe customer ID validity'
        });
      }
    }
  };
  
  for (let i = 0; i < appMembers.length; i += BATCH_SIZE) {
    const batch = appMembers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processMember));
    
    if (i + BATCH_SIZE < appMembers.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
  
  return {
    checkName: 'Stripe Subscription Sync',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkStuckTransitionalMembers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const stuckMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_subscription_id, updated_at
    FROM users 
    WHERE stripe_subscription_id IS NOT NULL
      AND membership_status IN ('pending', 'non-member')
      AND updated_at < NOW() - INTERVAL '24 hours'
      AND role = 'member'
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  const stuckMembers = stuckMembersResult.rows as any[];
  
  for (const member of stuckMembers) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const hoursStuck = Math.round((Date.now() - new Date(member.updated_at).getTime()) / (1000 * 60 * 60));
    
    issues.push({
      category: 'sync_mismatch',
      severity: 'error',
      table: 'users',
      recordId: member.id,
      description: `Member "${memberName}" has Stripe subscription but is stuck in '${member.membership_status}' status for ${hoursStuck} hours`,
      suggestion: 'Check Stripe webhook delivery or manually sync membership status',
      context: {
        memberName,
        memberEmail: member.email,
        memberTier: member.tier,
        stripeCustomerId: member.stripe_subscription_id,
        userId: member.id
      }
    });
  }
  
  return {
    checkName: 'Stuck Transitional Members',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkTierReconciliation(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  let stripe: any;
  try {
    stripe = await getStripeClient();
  } catch (err) {
    if (!isProduction) console.error('[DataIntegrity] Stripe API error for tier reconciliation:', err);
    return {
      checkName: 'Tier Reconciliation',
      status: 'warning',
      issueCount: 0,
      issues: [{
        category: 'sync_mismatch',
        severity: 'info',
        table: 'stripe_sync',
        recordId: 'stripe_api',
        description: 'Unable to connect to Stripe for tier reconciliation',
        suggestion: 'Check Stripe integration connection'
      }],
      lastRun: new Date()
    };
  }
  
  let hubspot: any;
  try {
    hubspot = await getHubSpotClient();
  } catch (err) {
    if (!isProduction) console.error('[DataIntegrity] HubSpot API error for tier reconciliation:', err);
  }
  
  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, hubspot_id
    FROM users 
    WHERE stripe_customer_id IS NOT NULL
      AND role = 'member'
    ORDER BY RANDOM()
    LIMIT 100
  `);
  const appMembers = appMembersResult.rows as any[];
  
  if (appMembers.length === 0) {
    return {
      checkName: 'Tier Reconciliation',
      status: 'pass',
      issueCount: 0,
      issues: [],
      lastRun: new Date()
    };
  }
  
  const productMap = new Map<string, { name: string; tier: string }>();
  
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 100;
  
  const processMember = async (member: any): Promise<void> => {
    const customerId = member.stripe_customer_id;
    if (!customerId) return;
    
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const appTier = (member.tier || '').toLowerCase().trim();
    
    try {
      const customerSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10,
        expand: ['data.items.data.price']
      });
      
      const activeSub = customerSubs.data?.find((s: any) => 
        ['active', 'trialing', 'past_due'].includes(s.status)
      );
      
      if (!activeSub) return;
      
      const item = activeSub.items?.data?.[0];
      const price = item?.price;
      const productId = typeof price?.product === 'string' ? price.product : price?.product?.id;
      
      if (!productId) return;
      
      const product = await stripe.products.retrieve(productId);
      
      const stripeTier = (product.metadata?.tier || '').toLowerCase().trim();
      const productName = (product.name || '').toLowerCase().trim();
      const stripeEffectiveTier = stripeTier || productName;
      
      let hubspotTier: string | null = null;
      if (hubspot && member.hubspot_id) {
        try {
          const contact = await hubspot.crm.contacts.basicApi.getById(
            member.hubspot_id,
            ['membership_tier']
          );
          hubspotTier = (contact.properties?.membership_tier || '').toLowerCase().trim();
        } catch (err: any) {
          if (err?.response?.status !== 404) {
            if (!isProduction) console.error(`[DataIntegrity] HubSpot tier lookup failed for ${member.email}:`, err.message);
          }
        }
      }
      
      const tierMismatches: SyncComparisonData[] = [];
      
      const tierMatches = (tier1: string, tier2: string): boolean => {
        if (!tier1 || !tier2) return true;
        return tier1.includes(tier2) || tier2.includes(tier1) || tier1 === tier2;
      };
      
      const appVsStripe = tierMatches(appTier, stripeEffectiveTier);
      const appVsHubspot = !hubspotTier || tierMatches(appTier, hubspotTier);
      const stripeVsHubspot = !hubspotTier || tierMatches(stripeEffectiveTier, hubspotTier);
      
      if (!appVsStripe) {
        tierMismatches.push({
          field: 'App Tier vs Stripe Product',
          appValue: member.tier || null,
          externalValue: product.metadata?.tier || product.name || null
        });
      }
      
      if (!appVsHubspot && hubspotTier) {
        tierMismatches.push({
          field: 'App Tier vs HubSpot',
          appValue: member.tier || null,
          externalValue: hubspotTier
        });
      }
      
      if (!stripeVsHubspot && hubspotTier) {
        tierMismatches.push({
          field: 'Stripe Product vs HubSpot',
          appValue: product.metadata?.tier || product.name || null,
          externalValue: hubspotTier
        });
      }
      
      if (tierMismatches.length > 0) {
        const mismatchDesc = tierMismatches.map(m => m.field).join(', ');
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id,
          description: `Member "${memberName}" has tier mismatch: ${mismatchDesc}. App: "${member.tier || 'none'}", Stripe: "${product.name || 'unknown'}", HubSpot: "${hubspotTier || 'not set'}"`,
          suggestion: 'Align tier across all systems using the Tier Change Wizard or manual sync',
          context: {
            memberName,
            memberEmail: member.email || undefined,
            memberTier: member.tier || undefined,
            syncType: 'stripe',
            stripeCustomerId: customerId,
            hubspotContactId: member.hubspot_id || undefined,
            userId: member.id,
            syncComparison: tierMismatches
          }
        });
      }
    } catch (err: any) {
      if (!isProduction) console.error(`[DataIntegrity] Error checking tier reconciliation for ${member.email}:`, err.message);
    }
  };
  
  for (let i = 0; i < appMembers.length; i += BATCH_SIZE) {
    const batch = appMembers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processMember));
    
    if (i + BATCH_SIZE < appMembers.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
  
  return {
    checkName: 'Tier Reconciliation',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkBookingsWithoutSessions(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  // Find approved/attended/confirmed bookings that are NOT linked to a session
  // These are "Ghost Bookings" that bypass billing - critical revenue issue
  const ghostsResult = await db.execute(sql`
    SELECT br.id, br.user_email, br.request_date, br.status, br.trackman_booking_id, br.resource_id
    FROM booking_requests br
    LEFT JOIN booking_sessions bs ON br.session_id = bs.id
    WHERE br.status IN ('approved', 'attended', 'confirmed')
      AND (br.session_id IS NULL OR bs.id IS NULL)
    ORDER BY br.request_date DESC
    LIMIT 100
  `);
  const ghosts = ghostsResult.rows as any[];
  
  for (const row of ghosts) {
    const dateStr = row.request_date ? new Date(row.request_date).toISOString().split('T')[0] : 'unknown';
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id,
      description: `Active booking #${row.id} (${row.status}) for ${row.user_email} on ${dateStr} has NO SESSION. Billing is not being tracked.`,
      suggestion: 'Run "Backfill Sessions" tool in Admin -> Data Tools, or manually create a session for this booking.',
      context: {
        bookingDate: dateStr,
        memberEmail: row.user_email,
        trackmanBookingId: row.trackman_booking_id,
        resourceId: row.resource_id,
        status: row.status
      }
    });
  }

  return {
    checkName: 'Active Bookings Without Sessions',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkDuplicateStripeCustomers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const duplicatesResult = await db.execute(sql`
    WITH users_with_stripe AS (
      SELECT id, email, stripe_customer_id, LOWER(email) as normalized_email
      FROM users
      WHERE stripe_customer_id IS NOT NULL
    ),
    linked_with_stripe AS (
      SELECT u.id as user_id, u.email as primary_email, u.stripe_customer_id, 
             LOWER(ule.linked_email) as normalized_email
      FROM users u
      JOIN user_linked_emails ule ON LOWER(ule.primary_email) = LOWER(u.email)
      WHERE u.stripe_customer_id IS NOT NULL
    ),
    all_email_mappings AS (
      SELECT id as user_id, email as primary_email, stripe_customer_id, normalized_email
      FROM users_with_stripe
      UNION ALL
      SELECT user_id, primary_email, stripe_customer_id, normalized_email
      FROM linked_with_stripe
    ),
    email_customer_counts AS (
      SELECT 
        normalized_email,
        COUNT(DISTINCT stripe_customer_id) as customer_count,
        ARRAY_AGG(DISTINCT stripe_customer_id) as customer_ids,
        ARRAY_AGG(DISTINCT primary_email) as member_emails
      FROM all_email_mappings
      GROUP BY normalized_email
      HAVING COUNT(DISTINCT stripe_customer_id) > 1
    )
    SELECT * FROM email_customer_counts
    ORDER BY customer_count DESC
    LIMIT 25
  `);
  
  const duplicates = duplicatesResult.rows as any[];
  
  for (const dup of duplicates) {
    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'users',
      recordId: dup.normalized_email,
      description: `Email "${dup.normalized_email}" has ${dup.customer_count} different Stripe customers: ${(dup.customer_ids as string[]).join(', ')}`,
      suggestion: 'Consolidate to a single Stripe customer to prevent billing issues and duplicate charges.',
      context: {
        email: dup.normalized_email,
        stripeCustomerIds: dup.customer_ids,
        memberEmails: dup.member_emails
      }
    });
  }

  const sharedCustomersResult = await db.execute(sql`
    SELECT 
      stripe_customer_id,
      COUNT(*) as user_count,
      ARRAY_AGG(email ORDER BY created_at DESC) as emails
    FROM users
    WHERE stripe_customer_id IS NOT NULL
    GROUP BY stripe_customer_id
    HAVING COUNT(*) > 1
    LIMIT 25
  `);
  
  const sharedCustomers = sharedCustomersResult.rows as any[];
  
  for (const shared of sharedCustomers) {
    const emails = shared.emails as string[];
    if (emails.length <= 2) {
      continue;
    }
    
    issues.push({
      category: 'data_quality',
      severity: 'info',
      table: 'users',
      recordId: shared.stripe_customer_id,
      description: `Stripe customer ${shared.stripe_customer_id} is shared by ${shared.user_count} members: ${emails.slice(0, 5).join(', ')}${emails.length > 5 ? '...' : ''}`,
      suggestion: 'This may be intentional for billing groups. Review if these should be separate customers.',
      context: {
        stripeCustomerId: shared.stripe_customer_id,
        memberEmails: emails
      }
    });
  }

  return {
    checkName: 'Duplicate Stripe Customers',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'warning') ? 'warning' : 'info',
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
    checkUnmatchedTrackmanBookings(),
    checkOrphanWellnessEnrollments(),
    checkOrphanEventRsvps(),
    checkBookingResourceRelationships(),
    checkParticipantUserRelationships(),
    checkHubSpotSyncMismatch(),
    checkDuplicateTourSources(),
    checkNeedsReviewItems(),
    checkBookingTimeValidity(),
    checkStalePastTours(),
    checkMembersWithoutEmail(),
    checkDealsWithoutLineItems(),
    checkDealStageDrift(),
    checkStripeSubscriptionSync(),
    checkStuckTransitionalMembers(),
    checkTierReconciliation(),
    checkBookingsWithoutSessions(),
    checkDuplicateStripeCustomers()
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
    await alertOnCriticalIntegrityIssues(checkSummaries, severityMap);
    await alertOnHighIntegrityIssues(checkSummaries, severityMap);
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

export interface CreateBulkIgnoreParams {
  issueKeys: string[];
  duration: '24h' | '1w' | '30d';
  reason: string;
  ignoredBy: string;
}

export async function createBulkIgnoreRules(params: CreateBulkIgnoreParams): Promise<{
  created: number;
  updated: number;
}> {
  const { issueKeys, duration, reason, ignoredBy } = params;
  
  if (issueKeys.length === 0) {
    return { created: 0, updated: 0 };
  }
  
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
  
  let created = 0;
  let updated = 0;
  
  const BATCH_SIZE = 50;
  for (let i = 0; i < issueKeys.length; i += BATCH_SIZE) {
    const batch = issueKeys.slice(i, i + BATCH_SIZE);
    
    for (const issueKey of batch) {
      const existing = await db.select()
        .from(integrityIgnores)
        .where(eq(integrityIgnores.issueKey, issueKey))
        .limit(1);
      
      if (existing.length > 0) {
        await db.update(integrityIgnores)
          .set({
            ignoredBy,
            ignoredAt: now,
            expiresAt,
            reason,
            isActive: true
          })
          .where(eq(integrityIgnores.issueKey, issueKey));
        updated++;
      } else {
        await db.insert(integrityIgnores)
          .values({
            issueKey,
            ignoredBy,
            ignoredAt: now,
            expiresAt,
            reason,
            isActive: true
          });
        created++;
      }
    }
  }
  
  return { created, updated };
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

export async function runDataCleanup(): Promise<{
  orphanedNotifications: number;
  orphanedBookings: number;
  normalizedEmails: number;
}> {
  let orphanedNotifications = 0;
  let orphanedBookings = 0;
  let normalizedEmails = 0;

  try {
    const notifResult = await db.execute(sql`
      DELETE FROM notifications n
      WHERE n.user_email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(n.user_email))
        AND n.created_at < NOW() - INTERVAL '30 days'
      RETURNING id
    `);
    orphanedNotifications = notifResult.rows.length;

    const bookingResult = await db.execute(sql`
      UPDATE booking_requests
      SET notes = COALESCE(notes, '') || ' [Orphaned - no matching user]'
      WHERE user_email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(user_email))
        AND notes NOT LIKE '%[Orphaned%'
        AND status IN ('cancelled', 'declined', 'no_show')
        AND request_date < NOW() - INTERVAL '90 days'
      RETURNING id
    `);
    orphanedBookings = bookingResult.rows.length;

    const emailResult = await db.execute(sql`
      WITH 
        users_updated AS (
          UPDATE users SET email = LOWER(TRIM(email))
          WHERE email != LOWER(TRIM(email))
          RETURNING 1
        ),
        bookings_updated AS (
          UPDATE booking_requests SET user_email = LOWER(TRIM(user_email))
          WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
          RETURNING 1
        ),
        notifs_updated AS (
          UPDATE notifications SET user_email = LOWER(TRIM(user_email))
          WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
          RETURNING 1
        )
      SELECT 
        (SELECT COUNT(*) FROM users_updated) +
        (SELECT COUNT(*) FROM bookings_updated) +
        (SELECT COUNT(*) FROM notifs_updated) as total
    `);
    normalizedEmails = (emailResult.rows[0] as any)?.total || 0;

    console.log(`[DataCleanup] Removed ${orphanedNotifications} orphaned notifications, marked ${orphanedBookings} orphaned bookings, normalized ${normalizedEmails} emails`);
  } catch (error: any) {
    console.error('[DataCleanup] Error during cleanup:', error.message);
    throw error;
  }

  return { orphanedNotifications, orphanedBookings, normalizedEmails };
}

import { db } from '../db';
import { getErrorMessage, getErrorCode, getErrorStatusCode, isStripeError } from '../utils/errorUtils';
import { logger } from './logger';
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
  adminAuditLog,
  integrityIgnores
} from '../../shared/schema';
import { sql, eq, isNull, lt, and, or, gte, desc, isNotNull, gt } from 'drizzle-orm';
import { Client } from '@hubspot/api-client';
import Stripe from 'stripe';
import { getHubSpotClient } from './integrations';
import { isProduction } from './db';
import { getTodayPacific } from '../utils/dateUtils';
import { getStripeClient } from './stripe/client';

interface MemberRow {
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
import { syncCustomerMetadataToStripe } from './stripe/customers';
import { alertOnCriticalIntegrityIssues, alertOnHighIntegrityIssues } from './dataAlerts';
import { logIntegrityAudit } from './auditLog';
import { denormalizeTierForHubSpot } from '../utils/tierUtils';
import { retryableHubSpotRequest } from './hubspot/request';

const CHURNED_STATUSES = ['terminated', 'cancelled', 'non-member', 'deleted', 'former_member'];
const NO_TIER_STATUSES = ['terminated', 'cancelled', 'non-member', 'deleted', 'former_member', 'expired', 'pending'];

const severityMap: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  'HubSpot Sync Mismatch': 'critical',
  'Deal Stage Drift': 'critical',
  'Stripe Subscription Sync': 'critical',
  'Stuck Transitional Members': 'critical',
  'Active Bookings Without Sessions': 'medium',
  'Participant User Relationships': 'high',
  'Booking Resource Relationships': 'high',
  'Booking Time Validity': 'high',
  'Members Without Email': 'high',
  'Deals Without Line Items': 'high',
  'Tier Reconciliation': 'high',
  'Duplicate Stripe Customers': 'high',
  'Orphan Booking Participants': 'medium',
  'Orphan Wellness Enrollments': 'medium',
  'Orphan Event RSVPs': 'medium',
  'MindBody Stale Sync': 'medium',
  'MindBody Data Quality': 'medium',
  'Duplicate Tour Sources': 'low',
  'Items Needing Review': 'low',
  'Stale Past Tours': 'low',
  'Unmatched Trackman Bookings': 'medium',
  'HubSpot ID Duplicates': 'high',
  'Orphaned Fee Snapshots': 'critical',
  'Sessions Without Participants': 'low',
  'Orphaned Payment Intents': 'critical',
  'Guest Passes Without Members': 'medium',
  'Billing Provider Hybrid State': 'critical'
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
  resourceId?: number;
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
}

export interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality' | 'system_error';
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

async function safeCheck(
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

async function checkOrphanBookingParticipants(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  const orphans = await db.execute(sql`
    SELECT bp.id, bp.session_id, bp.display_name, bp.participant_type
    FROM booking_participants bp
    LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
    WHERE bs.id IS NULL
  `);
  
  for (const row of orphans.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'booking_participants',
      recordId: row.id as string | number,
      description: `Participant "${row.display_name}" (session_id: ${row.session_id}) has no valid booking session`,
      suggestion: 'Delete orphan participant record or recreate the booking session',
      context: {
        memberName: (row.display_name as string) || undefined
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

async function checkUnmatchedTrackmanBookings(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  try {
    const unmatchedBookings = await db.execute(sql`
      SELECT tub.id, tub.trackman_booking_id, tub.user_name, tub.original_email, tub.booking_date, tub.bay_number, tub.start_time, tub.end_time, tub.notes
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
    const total = (totalCount.rows[0] as Record<string, unknown>)?.count || 0;
    
    for (const row of unmatchedBookings.rows as Record<string, unknown>[]) {
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'trackman_unmatched_bookings',
        recordId: row.id as string | number,
        description: `Trackman booking for "${row.user_name || 'Unknown'}" (${row.original_email || 'no email'}) on ${row.booking_date} has no matching member`,
        suggestion: 'Use the Trackman Unmatched Bookings section to link this booking to a member or create a visitor record',
        context: {
          trackmanBookingId: (row.trackman_booking_id as string) || undefined,
          userName: (row.user_name as string) || undefined,
          userEmail: (row.original_email as string) || undefined,
          bookingDate: (row.booking_date as string) || undefined,
          bayNumber: row.bay_number as string | number || undefined,
          startTime: (row.start_time as string) || undefined,
          endTime: (row.end_time as string) || undefined,
          importedName: (row.user_name as string) || undefined,
          notes: (row.notes as string) || undefined,
          originalEmail: (row.original_email as string) || undefined
        }
      });
    }
    
    return {
      checkName: 'Unmatched Trackman Bookings',
      status: Number(total) === 0 ? 'pass' : Number(total) > 50 ? 'fail' : 'warning',
      issueCount: Number(total),
      issues,
      lastRun: new Date()
    };
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking unmatched Trackman bookings:', { extra: { detail: getErrorMessage(error) } });
    return {
      checkName: 'Unmatched Trackman Bookings',
      status: 'warning',
      issueCount: 1,
      issues: [{
        category: 'system_error',
        severity: 'error',
        table: 'trackman_unmatched_bookings',
        recordId: 'check_error',
        description: `Failed to check unmatched Trackman bookings: ${getErrorMessage(error)}`,
        suggestion: 'Review server logs for details and retry'
      }],
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
  
  for (const row of orphans.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'wellness_enrollments',
      recordId: row.id as string | number,
      description: `Enrollment for ${row.user_email} references non-existent class (class_id: ${row.class_id})`,
      suggestion: 'Delete orphan enrollment record',
      context: {
        memberEmail: (row.user_email as string) || undefined
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
  
  for (const row of orphans.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'event_rsvps',
      recordId: row.id as string | number,
      description: `RSVP for ${row.user_email} references non-existent event (event_id: ${row.event_id})`,
      suggestion: 'Delete orphan RSVP record',
      context: {
        memberName: (row.attendee_name as string) || undefined,
        memberEmail: (row.user_email as string) || undefined
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
  
  for (const row of invalidResources.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'missing_relationship',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id as string | number,
      description: `Booking by ${row.user_email} on ${row.request_date} references non-existent resource (resource_id: ${row.resource_id})`,
      suggestion: 'Update booking to use a valid resource or delete the booking',
      context: {
        memberName: (row.user_name as string) || undefined,
        memberEmail: (row.user_email as string) || undefined,
        bookingDate: (row.request_date as string) || undefined,
        startTime: (row.start_time as string) || undefined,
        endTime: (row.end_time as string) || undefined
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
  
  for (const row of invalidUsers.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'missing_relationship',
      severity: 'warning',
      table: 'booking_participants',
      recordId: row.id as string | number,
      description: `Participant "${row.display_name}" references non-existent user (user_id: ${row.user_id})`,
      suggestion: 'Update participant to reference a valid user or mark as guest',
      context: {
        memberName: (row.display_name as string) || undefined,
        bookingDate: (row.session_date as string) || undefined,
        startTime: (row.start_time as string) || undefined,
        resourceName: (row.resource_name as string) || undefined
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
  
  let hubspot: Client;
  try {
    hubspot = await getHubSpotClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] HubSpot API error:', { error: err });
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
    SELECT id, email, first_name, last_name, membership_tier, hubspot_id, tier, membership_status
    FROM users 
    WHERE hubspot_id IS NOT NULL
      AND archived_at IS NULL
      AND membership_status != 'merged'
    ORDER BY RANDOM()
    LIMIT 100
  `);
  const appMembers = appMembersResult.rows as Record<string, unknown>[];
  
  for (const member of appMembers) {
    if (!member.hubspot_id) continue;
    
    try {
      const hubspotContact = await hubspot.crm.contacts.basicApi.getById(
        String(member.hubspot_id),
        ['firstname', 'lastname', 'email', 'membership_tier']
      );
      
      const props = hubspotContact.properties || {};
      const comparisons: SyncComparisonData[] = [];
      
      const appFirstName = String(member.first_name || '').trim().toLowerCase();
      const hsFirstName = (props.firstname || '').trim().toLowerCase();
      if (appFirstName !== hsFirstName) {
        comparisons.push({
          field: 'First Name',
          appValue: (member.first_name as string) || null,
          externalValue: props.firstname || null
        });
      }
      
      const appLastName = String(member.last_name || '').trim().toLowerCase();
      const hsLastName = (props.lastname || '').trim().toLowerCase();
      if (appLastName !== hsLastName) {
        comparisons.push({
          field: 'Last Name',
          appValue: (member.last_name as string) || null,
          externalValue: props.lastname || null
        });
      }
      
      const memberStatus = String(member.membership_status || '').toLowerCase();
      const isChurned = CHURNED_STATUSES.includes(memberStatus);
      const isNoTierStatus = NO_TIER_STATUSES.includes(memberStatus);
      const expectedHubSpotTier = (isChurned || isNoTierStatus || !member.tier)
        ? null
        : denormalizeTierForHubSpot(String(member.tier));
      const hsTierRaw = props.membership_tier || null;
      const expectedNorm = (expectedHubSpotTier || '').trim().toLowerCase();
      const hsNorm = (hsTierRaw || '').trim().toLowerCase();
      if (!expectedNorm && !hsNorm) {
        // Both empty/null — not a mismatch, skip
      } else if (expectedNorm !== hsNorm) {
        comparisons.push({
          field: 'Membership Tier',
          appValue: expectedHubSpotTier || null,
          externalValue: hsTierRaw
        });
      }
      
      if (comparisons.length > 0) {
        const fieldList = comparisons.map(c => c.field).join(', ');
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id as string | number,
          description: `Member "${member.first_name} ${member.last_name}" has mismatched data: ${fieldList}`,
          suggestion: 'Sync data between app and HubSpot',
          context: {
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || undefined,
            memberEmail: (member.email as string) || undefined,
            memberTier: (member.tier as string) || undefined,
            syncType: 'hubspot',
            syncComparison: comparisons,
            hubspotContactId: member.hubspot_id as string,
            userId: Number(member.id)
          }
        });
      }
    } catch (err: unknown) {
      if (getErrorStatusCode(err) === 404) {
        issues.push({
          category: 'sync_mismatch',
          severity: 'error',
          table: 'users',
          recordId: member.id as string | number,
          description: `Member "${member.first_name} ${member.last_name}" (hubspot_id: ${member.hubspot_id}) not found in HubSpot`,
          suggestion: 'Remove stale HubSpot ID or re-sync member',
          context: {
            memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || undefined,
            memberEmail: (member.email as string) || undefined,
            syncType: 'hubspot',
            hubspotContactId: member.hubspot_id as string,
            userId: Number(member.id)
          }
        });
      }
    }
  }
  
  const staleHubSpotIssues = issues.filter(i => i.description.includes('not found in HubSpot'));
  if (staleHubSpotIssues.length > 0) {
    for (const issue of staleHubSpotIssues) {
      const userId = issue.recordId;
      await db.execute(sql`UPDATE users SET hubspot_id = NULL, updated_at = NOW() WHERE id = ${userId}`);
      logger.info(`[AutoFix] Cleared stale HubSpot ID for user ${issue.context?.memberEmail}`);
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
  
  for (const row of eventsNeedingReview.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'events',
      recordId: row.id as string | number,
      description: `Event "${row.title}" on ${row.event_date} needs review`,
      suggestion: 'Review and approve the event in admin panel',
      context: {
        eventTitle: (row.title as string) || undefined,
        eventDate: (row.event_date as string) || undefined,
        startTime: (row.start_time as string) || undefined
      }
    });
  }
  
  for (const row of wellnessNeedingReview.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'wellness_classes',
      recordId: row.id as string | number,
      description: `Wellness class "${row.title}" on ${row.date} needs review`,
      suggestion: 'Review and approve the class in admin panel',
      context: {
        className: (row.title as string) || undefined,
        classDate: (row.date as string) || undefined,
        instructor: (row.instructor as string) || undefined,
        startTime: (row.start_time as string) || undefined
      }
    });
  }
  
  return {
    checkName: 'Items Needing Review',
    status: issues.length === 0 ? 'pass' : 'info',
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
  
  for (const row of invalidBookings.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id as string | number,
      description: `Booking by ${row.user_email} on ${row.request_date} has end_time (${row.end_time}) before start_time (${row.start_time})`,
      suggestion: 'Fix the booking times or delete the invalid booking',
      context: {
        memberName: (row.user_name as string) || undefined,
        memberEmail: (row.user_email as string) || undefined,
        bookingDate: (row.request_date as string) || undefined,
        startTime: (row.start_time as string) || undefined,
        endTime: (row.end_time as string) || undefined,
        resourceName: (row.resource_name as string) || undefined
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
  
  for (const row of invalidSessions.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_sessions',
      recordId: row.id as string | number,
      description: `Booking session on ${row.session_date} has end_time (${row.end_time}) before start_time (${row.start_time})`,
      suggestion: 'Fix the session times or delete the invalid session',
      context: {
        bookingDate: (row.session_date as string) || undefined,
        startTime: (row.start_time as string) || undefined,
        endTime: (row.end_time as string) || undefined,
        resourceName: (row.resource_name as string) || undefined
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
  
  const autoFixResult = await db.execute(sql`
    UPDATE tours 
    SET status = 'no_show', updated_at = NOW()
    WHERE tour_date < ${today}::date - INTERVAL '7 days'
    AND status IN ('pending', 'scheduled')
    RETURNING id
  `);
  
  if (autoFixResult.rows.length > 0) {
    logger.info(`[DataIntegrity] Auto-fixed ${autoFixResult.rows.length} stale tours older than 7 days to 'no_show'`);
  }
  
  const staleTours = await db.execute(sql`
    SELECT id, title, tour_date, status, guest_name, guest_email, start_time
    FROM tours
    WHERE tour_date < ${today}
    AND status IN ('pending', 'scheduled')
  `);
  
  for (const row of staleTours.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'tours',
      recordId: row.id as string | number,
      description: `Tour "${row.title}" for ${row.guest_name || 'unknown guest'} on ${row.tour_date} is in the past but still marked as "${row.status}"`,
      suggestion: 'Update tour status to completed, no-show, or cancelled',
      context: {
        guestName: (row.guest_name as string) || undefined,
        memberEmail: (row.guest_email as string) || undefined,
        tourDate: (row.tour_date as string) || undefined,
        startTime: (row.start_time as string) || undefined
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
  
  for (const row of noEmailMembers.rows as Record<string, unknown>[]) {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'users',
      recordId: row.id as string | number,
      description: `Member "${name}" (id: ${row.id}) has no email address`,
      suggestion: 'Add an email address for this member or merge with existing record',
      context: {
        memberName: name,
        memberTier: (row.membership_tier as string) || undefined
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
  
  for (const row of dealsWithoutLineItems.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'hubspot_deals',
      recordId: row.id as string | number,
      description: `Deal "${row.deal_name || 'Unnamed'}" for ${row.member_email} has no product line items`,
      suggestion: 'Add product line items to this deal in the billing section or HubSpot',
      context: {
        memberEmail: (row.member_email as string) || undefined
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
  
  for (const row of driftingDeals.rows as Record<string, unknown>[]) {
    const membershipStatus = String(row.membership_status || 'non-member').toLowerCase();
    const expectedStage = STAGE_MAPPING[membershipStatus] || 'closedlost';
    const currentStage = row.current_stage;
    
    if (currentStage !== expectedStage) {
      const memberName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
      const expectedStageName = STAGE_NAMES[expectedStage] || expectedStage;
      const currentStageName = STAGE_NAMES[currentStage as string] || currentStage;
      
      issues.push({
        category: 'sync_mismatch',
        severity: 'error',
        table: 'hubspot_deals',
        recordId: row.id as string | number,
        description: `Deal for ${row.member_email} is in "${currentStageName}" but membership status is "${membershipStatus}" (should be in "${expectedStageName}")`,
        suggestion: `Update deal stage to match membership status or correct membership status in HubSpot`,
        context: {
          memberName,
          memberEmail: row.member_email as string,
          memberTier: (row.tier as string) || undefined,
          syncType: 'hubspot',
          syncComparison: [
            { field: 'Deal Stage', appValue: currentStageName as string, externalValue: expectedStageName as string },
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
  
  let stripe: Stripe;
  try {
    stripe = await getStripeClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Stripe API error:', { error: err });
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
      AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    ORDER BY id
  `);
  const appMembers = appMembersResult.rows as Record<string, unknown>[];
  
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
  
  const processMember = async (member: MemberRow): Promise<void> => {
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
              userId: Number(member.id),
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
              userId: Number(member.id),
              syncComparison: comparisons
            }
          });
          return;
        }
      }
      
      const item = activeSub.items?.data?.[0];
      const price = item?.price;
      const product = typeof price?.product === 'object' ? price.product : null;
      
      const activeProduct = product && !('deleted' in product && product.deleted) ? product as Stripe.Product : null;
      if (activeProduct && dbTier) {
        const productTier = (activeProduct.metadata?.tier || activeProduct.name || '').toLowerCase();
        const productName = (activeProduct.name || '').toLowerCase();
        
        const tierMatches = 
          productTier.includes(dbTier) || 
          dbTier.includes(productTier) ||
          productName.includes(dbTier) ||
          dbTier.includes(productName);
        
        if (!tierMatches && productTier) {
          comparisons.push({
            field: 'Membership Tier',
            appValue: member.tier || null,
            externalValue: activeProduct.metadata?.tier || activeProduct.name || null
          });
          
          issues.push({
            category: 'sync_mismatch',
            severity: 'warning',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" has tier mismatch: DB tier is "${member.tier}" but Stripe product is "${activeProduct.name}"`,
            suggestion: 'Update database tier to match Stripe subscription product',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: Number(member.id),
              syncComparison: comparisons
            }
          });
        }
      }
    } catch (err: unknown) {
      const isCustomerNotFound = isStripeError(err) && 
        (getErrorCode(err) === 'resource_missing' || getErrorMessage(err)?.includes('No such customer'));
      
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
            userId: Number(member.id),
            errorType: 'orphaned_stripe_customer'
          }
        });
      } else {
        if (!isProduction) logger.warn(`[DataIntegrity] Stripe API error for ${customerId}:`, { extra: { detail: getErrorMessage(err) } });
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id,
          description: `Error fetching Stripe subscriptions for "${memberName}": ${getErrorMessage(err)}`,
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
      AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  const stuckMembers = stuckMembersResult.rows as Record<string, unknown>[];
  
  for (const member of stuckMembers) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const hoursStuck = Math.round((Date.now() - new Date(member.updated_at as string).getTime()) / (1000 * 60 * 60));
    
    issues.push({
      category: 'sync_mismatch',
      severity: 'error',
      table: 'users',
      recordId: member.id as string | number,
      description: `Member "${memberName}" has Stripe subscription but is stuck in '${member.membership_status}' status for ${hoursStuck} hours`,
      suggestion: 'Check Stripe webhook delivery or manually sync membership status',
      context: {
        memberName,
        memberEmail: member.email as string,
        memberTier: member.tier as string,
        stripeCustomerId: member.stripe_subscription_id as string,
        userId: Number(member.id)
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
  
  let stripe: Stripe;
  try {
    stripe = await getStripeClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Stripe API error for tier reconciliation:', { error: err });
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
  
  let hubspot: Client | undefined;
  try {
    hubspot = await getHubSpotClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] HubSpot API error for tier reconciliation:', { error: err });
  }
  
  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, hubspot_id, billing_provider
    FROM users 
    WHERE stripe_customer_id IS NOT NULL
      AND role = 'member'
      AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    ORDER BY id
  `);
  const appMembers = appMembersResult.rows as Record<string, unknown>[];
  
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
  
  const hubspotTierMap = new Map<string, string>();
  if (hubspot) {
    const membersWithHubspot = appMembers.filter((m: MemberRow) => m.hubspot_id);
    for (let h = 0; h < membersWithHubspot.length; h += 100) {
      const hsBatch = membersWithHubspot.slice(h, h + 100);
      try {
        const readResult = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.batchApi.read({
            inputs: hsBatch.map((m: MemberRow) => ({ id: m.hubspot_id as string })),
            properties: ['membership_tier']
          } as any)
        );
        for (const contact of ((readResult as unknown as Record<string, unknown>).results as Array<{ id: string; properties?: Record<string, string> }> || [])) {
          hubspotTierMap.set(contact.id, (contact.properties?.membership_tier || '').toLowerCase().trim());
        }
      } catch (batchErr: unknown) {
        logger.warn('[DataIntegrity] HubSpot batch tier read failed:', { error: batchErr });
      }
    }
  }
  
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 100;
  
  const processMember = async (member: MemberRow): Promise<void> => {
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
      
      const activeSub = customerSubs.data?.find((s: Stripe.Subscription) => 
        ['active', 'trialing', 'past_due'].includes(s.status)
      );
      
      if (!activeSub) return;
      
      const item = activeSub.items?.data?.[0];
      const price = item?.price;
      const productId = typeof price?.product === 'string' ? price.product : price?.product?.id;
      
      if (!productId) return;
      
      let cached = productMap.get(productId);
      if (!cached) {
        const product = await stripe.products.retrieve(productId);
        cached = { name: product.name || '', tier: product.metadata?.tier || '' };
        productMap.set(productId, cached);
      }
      
      const stripeTier = (cached.tier).toLowerCase().trim();
      const productName = (cached.name).toLowerCase().trim();
      const stripeEffectiveTier = stripeTier || productName;
      
      let hubspotTier: string | null = null;
      if (member.hubspot_id && hubspotTierMap.has(member.hubspot_id)) {
        hubspotTier = hubspotTierMap.get(member.hubspot_id) || null;
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
          externalValue: cached.tier || cached.name || null
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
          appValue: cached.tier || cached.name || null,
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
          description: `Member "${memberName}" has tier mismatch: ${mismatchDesc}. App: "${member.tier || 'none'}", Stripe: "${cached.name || 'unknown'}", HubSpot: "${hubspotTier || 'not set'}"`,
          suggestion: 'Align tier across all systems using the Tier Change Wizard or manual sync',
          context: {
            memberName,
            memberEmail: member.email || undefined,
            memberTier: member.tier || undefined,
            syncType: 'stripe',
            stripeCustomerId: customerId,
            hubspotContactId: member.hubspot_id || undefined,
            userId: Number(member.id),
            syncComparison: tierMismatches
          }
        });
      }
    } catch (err: unknown) {
      if (!isProduction) logger.error(`[DataIntegrity] Error checking tier reconciliation for ${member.email}:`, { extra: { detail: getErrorMessage(err) } });
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
    SELECT br.id, br.user_email, br.request_date, br.status, br.trackman_booking_id, br.resource_id,
           br.start_time, br.end_time, br.notes,
           r.name as resource_name,
           u.first_name, u.last_name
    FROM booking_requests br
    LEFT JOIN booking_sessions bs ON br.session_id = bs.id
    LEFT JOIN resources r ON br.resource_id = r.id
    LEFT JOIN users u ON br.user_id = u.id
    WHERE br.status IN ('approved', 'attended', 'confirmed')
      AND (br.session_id IS NULL OR bs.id IS NULL)
      AND (br.is_unmatched = false OR br.is_unmatched IS NULL)
      AND br.user_email NOT IN ('private-event@resolved', 'private-event@club')
    ORDER BY br.request_date DESC
    LIMIT 100
  `);
  const ghosts = ghostsResult.rows as Record<string, unknown>[];
  
  for (const row of ghosts) {
    const dateStr = row.request_date ? new Date(row.request_date as string).toISOString().split('T')[0] : 'unknown';
    const memberName = row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : undefined;
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_requests',
      recordId: row.id as string | number,
      description: `Active booking #${row.id} (${row.status}) for ${row.user_email} on ${dateStr} has NO SESSION. Billing is not being tracked.`,
      suggestion: 'Run "Backfill Sessions" tool in Admin -> Data Tools, or manually create a session for this booking.',
      context: {
        bookingDate: dateStr,
        memberEmail: row.user_email as string,
        memberName: memberName,
        trackmanBookingId: row.trackman_booking_id as string,
        resourceId: Number(row.resource_id),
        resourceName: row.resource_name as string,
        startTime: row.start_time as string,
        endTime: row.end_time as string,
        notes: row.notes as string,
        importedName: memberName || String(row.user_email || '').split('@')[0],
        status: row.status as string
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
  
  const duplicates = duplicatesResult.rows as Record<string, unknown>[];
  
  for (const dup of duplicates) {
    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'users',
      recordId: dup.normalized_email as string | number,
      description: `Email "${dup.normalized_email}" has ${dup.customer_count} different Stripe customers: ${(dup.customer_ids as string[]).join(', ')}`,
      suggestion: 'Consolidate to a single Stripe customer to prevent billing issues and duplicate charges.',
      context: {
        email: dup.normalized_email as string,
        stripeCustomerIds: dup.customer_ids as string[],
        memberEmails: dup.member_emails as string | string[]
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
  
  const sharedCustomers = sharedCustomersResult.rows as Record<string, unknown>[];
  
  for (const shared of sharedCustomers) {
    const emails = shared.emails as string[];
    if (emails.length <= 2) {
      continue;
    }
    
    issues.push({
      category: 'data_quality',
      severity: 'info',
      table: 'users',
      recordId: shared.stripe_customer_id as string,
      description: `Stripe customer ${shared.stripe_customer_id} is shared by ${shared.user_count} members: ${emails.slice(0, 5).join(', ')}${emails.length > 5 ? '...' : ''}`,
      suggestion: 'This may be intentional for billing groups. Review if these should be separate customers.',
      context: {
        stripeCustomerId: shared.stripe_customer_id as string,
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

async function checkMindBodyStaleSyncMembers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  // Find active MindBody-billed members whose records haven't been updated in 30+ days
  // This may indicate stale data that needs verification
  const staleSyncResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, updated_at, mindbody_client_id
    FROM users 
    WHERE billing_provider = 'mindbody'
      AND membership_status = 'active'
      AND role = 'member'
      AND updated_at < NOW() - INTERVAL '30 days'
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  const staleMembers = staleSyncResult.rows as Record<string, unknown>[];
  
  for (const member of staleMembers) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const lastUpdate = member.updated_at 
      ? new Date(member.updated_at as string).toLocaleDateString()
      : 'unknown';
    
    issues.push({
      category: 'sync_mismatch',
      severity: 'warning',
      table: 'users',
      recordId: member.id as string | number,
      description: `MindBody member "${memberName}" shows as active but record unchanged since ${lastUpdate}`,
      suggestion: 'Verify member is still active in MindBody or update their record',
      context: {
        memberName,
        memberEmail: member.email as string,
        memberTier: member.tier as string,
        lastUpdate: (member.updated_at as string) || undefined,
        mindbodyClientId: (member.mindbody_client_id as string) || undefined,
        userId: Number(member.id)
      }
    });
  }
  
  return {
    checkName: 'MindBody Stale Sync',
    status: issues.length === 0 ? 'pass' : issues.length > 10 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkMindBodyStatusMismatch(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  // Find MindBody-billed members with potential data issues:
  // 1. Active status but no MindBody client ID
  // 2. Has MindBody client ID but no tier assigned
  const mismatchResult = await db.execute(sql`
    SELECT u.id, u.email, u.first_name, u.last_name, u.tier, u.membership_status, 
           u.billing_provider, u.mindbody_client_id
    FROM users u
    WHERE u.billing_provider = 'mindbody'
      AND u.role = 'member'
      AND (
        -- Active member without MindBody client ID
        (u.membership_status = 'active' AND (u.mindbody_client_id IS NULL OR u.mindbody_client_id = ''))
        OR
        -- Active member with MindBody ID but no tier (data incomplete)
        (u.membership_status = 'active' AND u.mindbody_client_id IS NOT NULL AND u.mindbody_client_id != '' AND (u.tier IS NULL OR u.tier = ''))
      )
    ORDER BY u.updated_at DESC
    LIMIT 50
  `);
  const mismatches = mismatchResult.rows as Record<string, unknown>[];
  
  for (const member of mismatches) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const hasMindBodyId = member.mindbody_client_id && member.mindbody_client_id !== '';
    const hasTier = member.tier && member.tier !== '';
    
    let description: string;
    let suggestion: string;
    
    if (!hasMindBodyId && member.membership_status === 'active') {
      description = `MindBody member "${memberName}" is active but has no MindBody Client ID`;
      suggestion = 'Add MindBody Client ID or verify billing provider is correct';
    } else {
      description = `MindBody member "${memberName}" has MindBody ID but no tier assigned`;
      suggestion = 'Assign a membership tier to this member';
    }
    
    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'users',
      recordId: member.id as string | number,
      description,
      suggestion,
      context: {
        memberName,
        memberEmail: member.email as string,
        memberTier: (member.tier as string) || 'none',
        memberStatus: member.membership_status as string,
        mindbodyClientId: (member.mindbody_client_id as string) || 'none',
        userId: Number(member.id)
      }
    });
  }
  
  return {
    checkName: 'MindBody Data Quality',
    status: issues.length === 0 ? 'pass' : issues.length > 5 ? 'fail' : 'warning',
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

async function checkHubSpotIdDuplicates(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  try {
    const duplicatesResult = await db.execute(sql`
      SELECT 
        u.hubspot_id,
        ARRAY_AGG(u.email ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as emails,
        ARRAY_AGG(u.id ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as user_ids,
        ARRAY_AGG(COALESCE(u.membership_status, 'unknown') ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as statuses,
        ARRAY_AGG(COALESCE(u.tier, 'none') ORDER BY u.membership_status = 'active' DESC, u.lifetime_visits DESC) as tiers,
        COUNT(*) as user_count
      FROM users u
      WHERE u.hubspot_id IS NOT NULL
        AND u.archived_at IS NULL
        AND u.membership_status != 'merged'
      GROUP BY u.hubspot_id
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `);
    
    const duplicates = duplicatesResult.rows as Record<string, unknown>[];
    
    for (const dup of duplicates) {
      const emails = dup.emails as string[];
      const statuses = dup.statuses as string[];
      const tiers = dup.tiers as string[];
      
      const remainingEmails = emails.slice(1);
      let alreadyLinked = false;
      if (remainingEmails.length > 0) {
        const linkedCheck = await db.execute(sql`
          SELECT COUNT(*) as linked_count 
          FROM user_linked_emails 
          WHERE LOWER(primary_email) = LOWER(${emails[0]}) 
            AND LOWER(linked_email) IN (${sql.join(remainingEmails.map((e: string) => sql`${e.toLowerCase()}`), sql`, `)})
        `);
        alreadyLinked = parseInt((linkedCheck.rows[0] as Record<string, unknown>)?.linked_count as string || '0') > 0;
      }
      
      const userDetails = emails.map((email: string, idx: number) => 
        `${email} (${statuses[idx]}, ${tiers[idx]})`
      ).join(', ');
      
      issues.push({
        category: 'data_quality',
        severity: alreadyLinked ? 'info' : 'warning',
        table: 'users',
        recordId: dup.hubspot_id as string | number,
        description: `HubSpot contact ${dup.hubspot_id} is shared by ${dup.user_count} users: ${userDetails}${alreadyLinked ? ' (emails already linked)' : ''}`,
        suggestion: alreadyLinked 
          ? 'Emails are linked. Consider merging these users if they are the same person.'
          : 'Link these emails or merge users if they represent the same person.',
        context: {
          hubspotContactId: dup.hubspot_id as string,
          memberEmail: emails[0],
          duplicateUsers: emails.map((email: string, idx: number) => ({
            userId: (dup.user_ids as number[])[idx],
            email,
            status: statuses[idx],
            tier: tiers[idx]
          }))
        }
      });
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking HubSpot ID duplicates:', { extra: { detail: getErrorMessage(error) } });
  }
  
  return {
    checkName: 'HubSpot ID Duplicates',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'warning') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkOrphanedFeeSnapshots(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const orphans = await db.execute(sql`
    SELECT bfs.id, bfs.booking_id, bfs.total_cents, bfs.status, bfs.created_at
    FROM booking_fee_snapshots bfs
    LEFT JOIN booking_requests br ON bfs.booking_id = br.id
    WHERE br.id IS NULL
    LIMIT 100
  `);

  for (const row of orphans.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'error',
      table: 'booking_fee_snapshots',
      recordId: row.id as string | number,
      description: `Fee snapshot (booking_id: ${row.booking_id}) references a deleted booking — ${row.total_cents} cents, status: ${row.status}`,
      suggestion: 'Delete orphaned fee snapshot or investigate missing booking',
      context: {
        status: (row.status as string) || undefined
      }
    });
  }

  return {
    checkName: 'Orphaned Fee Snapshots',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkSessionsWithoutParticipants(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const emptySessions = await db.execute(sql`
    SELECT bs.id, bs.session_date, bs.resource_id, bs.start_time, bs.end_time, bs.created_at,
           r.name as resource_name
    FROM booking_sessions bs
    LEFT JOIN booking_participants bp ON bp.session_id = bs.id
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bp.id IS NULL
      AND bs.session_date >= CURRENT_DATE - INTERVAL '30 days'
    LIMIT 100
  `);

  for (const row of emptySessions.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'warning',
      table: 'booking_sessions',
      recordId: row.id as string | number,
      description: `Session on ${row.session_date} at ${row.start_time}–${row.end_time} (${row.resource_name || 'unknown resource'}) has zero participants`,
      suggestion: 'Review session and add participants or remove empty session',
      context: {
        bookingDate: (row.session_date as string) || undefined,
        startTime: (row.start_time as string) || undefined,
        endTime: (row.end_time as string) || undefined,
        resourceName: (row.resource_name as string) || undefined,
        resourceId: (row.resource_id as number) || undefined
      }
    });
  }

  return {
    checkName: 'Sessions Without Participants',
    status: issues.length === 0 ? 'pass' : issues.length > 5 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkOrphanedPaymentIntents(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const orphans = await db.execute(sql`
    SELECT bfs.id, bfs.booking_id, bfs.stripe_payment_intent_id, bfs.total_cents, bfs.status, bfs.created_at
    FROM booking_fee_snapshots bfs
    LEFT JOIN booking_requests br ON bfs.booking_id = br.id
    WHERE bfs.stripe_payment_intent_id IS NOT NULL
      AND bfs.status IN ('pending', 'requires_action')
      AND (br.id IS NULL OR br.status IN ('cancelled', 'denied', 'expired'))
    LIMIT 100
  `);

  for (const row of orphans.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_fee_snapshots',
      recordId: row.id as string | number,
      description: `Payment intent ${row.stripe_payment_intent_id} (${row.total_cents} cents, status: ${row.status}) references a deleted or cancelled booking (booking_id: ${row.booking_id})`,
      suggestion: 'Cancel the Stripe payment intent and clean up the fee snapshot',
      context: {
        stripeCustomerId: (row.stripe_payment_intent_id as string) || undefined,
        status: (row.status as string) || undefined
      }
    });
  }

  return {
    checkName: 'Orphaned Payment Intents',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkGuestPassesForNonExistentMembers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const orphans = await db.execute(sql`
    SELECT gp.id, gp.member_email, gp.passes_used, gp.passes_total
    FROM guest_passes gp
    LEFT JOIN users u ON LOWER(gp.member_email) = LOWER(u.email)
    WHERE u.id IS NULL
    LIMIT 100
  `);

  for (const row of orphans.rows as Record<string, unknown>[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'warning',
      table: 'guest_passes',
      recordId: row.id as string | number,
      description: `Guest pass for "${row.member_email}" (${row.passes_used}/${row.passes_total} used) references a non-existent member`,
      suggestion: 'Delete orphaned guest pass record or verify the member email',
      context: {
        memberEmail: (row.member_email as string) || undefined
      }
    });
  }

  return {
    checkName: 'Guest Passes Without Members',
    status: issues.length === 0 ? 'pass' : issues.length > 5 ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

async function checkBillingProviderHybridState(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];
  
  // Find members with billing_provider mismatch:
  // 1. billing_provider='mindbody' but has a Stripe subscription (should be 'stripe')
  // 2. billing_provider IS NULL but has active membership (should be classified)
  // 3. billing_provider='stripe' but no stripe_subscription_id (data inconsistency)
  const hybridResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, 
           billing_provider, stripe_subscription_id, stripe_customer_id, mindbody_client_id
    FROM users 
    WHERE role = 'member'
      AND archived_at IS NULL
      AND (
        -- Mindbody member with active Stripe subscription (needs migration)
        (billing_provider = 'mindbody' AND stripe_subscription_id IS NOT NULL AND stripe_subscription_id != '')
        OR
        -- No billing provider but active member (needs classification)
        (billing_provider IS NULL AND membership_status = 'active')
        OR
        -- Stripe billing provider but no subscription ID (data gap)
        (billing_provider = 'stripe' AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '') AND membership_status = 'active')
      )
    ORDER BY membership_status, email
    LIMIT 50
  `);
  const hybrids = hybridResult.rows as Record<string, unknown>[];
  
  for (const member of hybrids) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    
    let description: string;
    let suggestion: string;
    let severity: 'error' | 'warning' = 'warning';
    
    if (member.billing_provider === 'mindbody' && member.stripe_subscription_id) {
      description = `Member "${memberName}" has billing_provider='mindbody' but has Stripe subscription ${member.stripe_subscription_id} — billing provider should be 'stripe'`;
      suggestion = 'Update billing_provider to stripe — this member has migrated from Mindbody';
      severity = 'error';
    } else if (!member.billing_provider && member.membership_status === 'active') {
      description = `Active member "${memberName}" has no billing provider set — unable to determine billing source`;
      suggestion = 'Classify billing provider as stripe, mindbody, manual, or comped';
    } else {
      description = `Member "${memberName}" has billing_provider='stripe' but no Stripe subscription ID`;
      suggestion = 'Verify Stripe subscription exists or update billing provider';
    }
    
    issues.push({
      category: 'sync_mismatch',
      severity,
      table: 'users',
      recordId: member.id as string | number,
      description,
      suggestion,
      context: {
        memberName,
        memberEmail: member.email as string,
        memberTier: (member.tier as string) || 'none',
        memberStatus: member.membership_status as string,
        billingProvider: (member.billing_provider as string) || 'none',
        stripeSubscriptionId: (member.stripe_subscription_id as string) || 'none',
        stripeCustomerId: (member.stripe_customer_id as string) || 'none',
        mindbodyClientId: (member.mindbody_client_id as string) || 'none',
        userId: Number(member.id)
      }
    });
  }
  
  return {
    checkName: 'Billing Provider Hybrid State',
    status: issues.length > 0 ? (issues.some(i => i.severity === 'error') ? 'fail' : 'warning') : 'pass',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function runAllIntegrityChecks(triggeredBy: 'manual' | 'scheduled' = 'manual'): Promise<IntegrityCheckResult[]> {
  const checks = await Promise.all([
    safeCheck(checkOrphanBookingParticipants, 'Orphan Booking Participants'),
    safeCheck(checkUnmatchedTrackmanBookings, 'Unmatched Trackman Bookings'),
    safeCheck(checkOrphanWellnessEnrollments, 'Orphan Wellness Enrollments'),
    safeCheck(checkOrphanEventRsvps, 'Orphan Event RSVPs'),
    safeCheck(checkBookingResourceRelationships, 'Booking Resource Relationships'),
    safeCheck(checkParticipantUserRelationships, 'Participant User Relationships'),
    safeCheck(checkHubSpotSyncMismatch, 'HubSpot Sync Mismatch'),
    safeCheck(checkNeedsReviewItems, 'Items Needing Review'),
    safeCheck(checkBookingTimeValidity, 'Booking Time Validity'),
    safeCheck(checkMembersWithoutEmail, 'Members Without Email'),
    safeCheck(checkDealsWithoutLineItems, 'Deals Without Line Items'),
    safeCheck(checkDealStageDrift, 'Deal Stage Drift'),
    safeCheck(checkStripeSubscriptionSync, 'Stripe Subscription Sync'),
    safeCheck(checkStuckTransitionalMembers, 'Stuck Transitional Members'),
    safeCheck(checkTierReconciliation, 'Tier Reconciliation'),
    safeCheck(checkBookingsWithoutSessions, 'Active Bookings Without Sessions'),
    safeCheck(checkDuplicateStripeCustomers, 'Duplicate Stripe Customers'),
    safeCheck(checkMindBodyStaleSyncMembers, 'MindBody Stale Sync'),
    safeCheck(checkMindBodyStatusMismatch, 'MindBody Data Quality'),
    safeCheck(checkHubSpotIdDuplicates, 'HubSpot ID Duplicates'),
    safeCheck(checkOrphanedFeeSnapshots, 'Orphaned Fee Snapshots'),
    safeCheck(checkSessionsWithoutParticipants, 'Sessions Without Participants'),
    safeCheck(checkOrphanedPaymentIntents, 'Orphaned Payment Intents'),
    safeCheck(checkGuestPassesForNonExistentMembers, 'Guest Passes Without Members'),
    safeCheck(checkBillingProviderHybridState, 'Billing Provider Hybrid State'),
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
    await alertOnCriticalIntegrityIssues(checkSummaries as any, severityMap);
    await alertOnHighIntegrityIssues(checkSummaries as any, severityMap);
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Failed to store history:', { error: err });
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
      status: r.status as 'pass' | 'warning' | 'fail',
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
  
  const auditLogId = await logIntegrityAudit({
    issueKey,
    action,
    actionBy,
    resolutionMethod: resolutionMethod || null,
    notes: notes || null
  });
  
  if (action === 'resolved' || action === 'ignored') {
    await db.update(integrityIssuesTracking)
      .set({ resolvedAt: new Date() })
      .where(eq(integrityIssuesTracking.issueKey, issueKey));
  } else if (action === 'reopened') {
    await db.update(integrityIssuesTracking)
      .set({ resolvedAt: null })
      .where(eq(integrityIssuesTracking.issueKey, issueKey));
  }
  
  return { auditLogId };
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
    .from(adminAuditLog)
    .where(eq(adminAuditLog.resourceType, 'system'))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);
  
  return entries.map(entry => {
    const details = (entry.details || {}) as Record<string, unknown>;
    return {
      id: entry.id,
      issueKey: (details.issueKey as string) || entry.resourceId || '',
      action: entry.action,
      actionBy: entry.staffEmail,
      actionAt: entry.createdAt,
      resolutionMethod: (details.resolutionMethod as string) || null,
      notes: (details.notes as string) || null,
    };
  });
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
      SELECT first_name, last_name, email, membership_tier, tier, membership_status
      FROM users WHERE id = ${userId}
    `);
    
    if (userResult.rows.length === 0) {
      throw new Error(`User with id ${userId} not found`);
    }
    
    const user = userResult.rows[0] as Record<string, unknown>;
    
    const hubspot = await getHubSpotClient();
    
    const isChurned = ['terminated', 'cancelled', 'non-member', 'deleted', 'former_member', 'expired'].includes(String(user.membership_status || '').toLowerCase());
    const mappedTier = isChurned ? '' : (denormalizeTierForHubSpot(String(user.tier)) || '');
    
    await hubspot.crm.contacts.basicApi.update(hubspotContactId, {
      properties: {
        firstname: (user.first_name as string) || '',
        lastname: (user.last_name as string) || '',
        membership_tier: mappedTier
      }
    });
    
    return { 
      success: true, 
      message: `Pushed app data to HubSpot contact ${hubspotContactId}` 
    };
  }
  
  throw new Error(`Unsupported sync target: ${target}`);
}

export async function bulkPushToHubSpot(dryRun: boolean = true): Promise<{
  success: boolean;
  message: string;
  totalChecked: number;
  totalMismatched: number;
  totalSynced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let totalChecked = 0;
  let totalMismatched = 0;
  let totalSynced = 0;

  const hubspot = await getHubSpotClient();

  const allMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, membership_tier, hubspot_id, tier, membership_status
    FROM users
    WHERE hubspot_id IS NOT NULL
    ORDER BY id
  `);
  const allMembers = allMembersResult.rows as Record<string, unknown>[];

  const batchSize = 100;

  for (let i = 0; i < allMembers.length; i += batchSize) {
    const batch = allMembers.slice(i, i + batchSize);
    totalChecked += batch.length;

    let hsContactMap: Record<string, Record<string, string>> = {};
    try {
      const readInput = {
        inputs: batch.map((m: MemberRow) => ({ id: m.hubspot_id as string })),
        properties: ['firstname', 'lastname', 'email', 'membership_tier']
      };
      const readResult = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.batchApi.read(readInput as any)
      );
      for (const contact of ((readResult as unknown as Record<string, unknown>).results as Array<{ id: string; properties?: Record<string, string> }> || [])) {
        hsContactMap[contact.id] = contact.properties || {};
      }
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error);
      if (errMsg.includes('404') || getErrorStatusCode(error) === 404) {
        for (const member of batch) {
          try {
            const singleRead = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(String(member.hubspot_id), ['firstname', 'lastname', 'email', 'membership_tier'])
            );
            hsContactMap[member.hubspot_id as string] = singleRead.properties || {};
          } catch (singleErr: unknown) {
            if (getErrorStatusCode(singleErr) === 404) {
              continue;
            }
            errors.push(`Read error for ${member.email}: ${getErrorMessage(singleErr)}`);
          }
        }
      } else {
        errors.push(`Batch read error: ${errMsg}`);
        continue;
      }
    }

    const updateInputs: Array<{ id: string; properties: Record<string, string> }> = [];

    for (const member of batch) {
      const hsProps = hsContactMap[member.hubspot_id as string];
      if (!hsProps) continue;

      const memberStatus = String(member.membership_status || '').toLowerCase();
      const isChurned = CHURNED_STATUSES.includes(memberStatus);
      const isNoTierStatus = NO_TIER_STATUSES.includes(memberStatus);
      const expectedTier = (isChurned || isNoTierStatus || !member.tier)
        ? ''
        : (denormalizeTierForHubSpot(String(member.tier)) || '');

      const appFirstName = String(member.first_name || '').trim().toLowerCase();
      const hsFirstName = (hsProps.firstname || '').trim().toLowerCase();
      const appLastName = String(member.last_name || '').trim().toLowerCase();
      const hsLastName = (hsProps.lastname || '').trim().toLowerCase();
      const expectedNorm = expectedTier.trim().toLowerCase();
      const hsNorm = (hsProps.membership_tier || '').trim().toLowerCase();

      let hasMismatch = false;
      if (appFirstName !== hsFirstName) hasMismatch = true;
      if (appLastName !== hsLastName) hasMismatch = true;
      if (expectedNorm !== hsNorm) {
        if (expectedNorm || hsNorm) {
          hasMismatch = true;
        }
      }

      if (hasMismatch) {
        totalMismatched++;
        updateInputs.push({
          id: member.hubspot_id as string,
          properties: {
            firstname: (member.first_name as string) || '',
            lastname: (member.last_name as string) || '',
            membership_tier: expectedTier
          }
        });
      }
    }

    if (!dryRun && updateInputs.length > 0) {
      for (let j = 0; j < updateInputs.length; j += batchSize) {
        const updateBatch = updateInputs.slice(j, j + batchSize);
        try {
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.batchApi.update({ inputs: updateBatch })
          );
          totalSynced += updateBatch.length;
        } catch (batchError: unknown) {
          logger.warn('[bulkPushToHubSpot] Batch update failed, falling back to individual pushes', {
            extra: { batchSize: updateBatch.length, batchError: getErrorMessage(batchError) }
          });
          for (const individual of updateBatch) {
            try {
              await retryableHubSpotRequest(() =>
                hubspot.crm.contacts.batchApi.update({ inputs: [individual] })
              );
              totalSynced += 1;
            } catch (individualError: unknown) {
              errors.push(`Individual sync failed for contact ${individual.id}: ${getErrorMessage(individualError)}`);
            }
          }
        }
      }
    }

    if (i + batchSize < allMembers.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const message = dryRun
    ? `Dry run complete: checked ${totalChecked} members, found ${totalMismatched} mismatches`
    : `Pushed ${totalSynced} of ${totalMismatched} mismatched members to HubSpot (${totalChecked} total checked)`;

  return {
    success: true,
    message,
    totalChecked,
    totalMismatched,
    totalSynced,
    errors
  };
}

function hubspotTierToAppTier(hsTier: string | null): string | null {
  if (!hsTier) return null;
  const HUBSPOT_TO_APP_TIER: Record<string, string> = {
    'core membership': 'Core',
    'core membership founding members': 'Core',
    'premium membership': 'Premium',
    'premium membership founding members': 'Premium',
    'social membership': 'Social',
    'social membership founding members': 'Social',
    'vip membership': 'VIP',
    'corporate membership': 'Corporate',
    'group lessons membership': 'Group Lessons',
  };
  const match = HUBSPOT_TO_APP_TIER[hsTier.trim().toLowerCase()];
  return match || null;
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
      ['firstname', 'lastname', 'email', 'phone', 'membership_tier']
    );
    
    const props = contact.properties || {};
    const hsTierValue = props.membership_tier || null;
    const appTier = hubspotTierToAppTier(hsTierValue);
    
    // Get user email for Stripe sync
    const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${userId}`);
    const userEmail = userResult.rows[0]?.email;
    
    await db.execute(sql`
      UPDATE users SET
        first_name = ${props.firstname || null},
        last_name = ${props.lastname || null},
        phone = ${props.phone || null},
        membership_tier = ${appTier},
        tier = ${appTier},
        updated_at = NOW()
      WHERE id = ${userId}
    `);
    
    if (userEmail) {
      syncCustomerMetadataToStripe(String(userEmail)).catch((err) => { logger.error('[Integrity] Stripe metadata sync failed:', err); });
    }
    
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
  orphanedFeeSnapshots: number;
}> {
  let orphanedNotifications = 0;
  let orphanedBookings = 0;
  let normalizedEmails = 0;
  let orphanedFeeSnapshots = 0;

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
        ),
        event_rsvps_updated AS (
          UPDATE event_rsvps SET user_email = LOWER(TRIM(user_email))
          WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
          RETURNING 1
        ),
        wellness_updated AS (
          UPDATE wellness_enrollments SET user_email = LOWER(TRIM(user_email))
          WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
          RETURNING 1
        ),
        guest_passes_updated AS (
          UPDATE guest_passes SET member_email = LOWER(TRIM(member_email))
          WHERE member_email IS NOT NULL AND member_email != LOWER(TRIM(member_email))
          RETURNING 1
        )
      SELECT 
        (SELECT COUNT(*) FROM users_updated) +
        (SELECT COUNT(*) FROM bookings_updated) +
        (SELECT COUNT(*) FROM notifs_updated) +
        (SELECT COUNT(*) FROM event_rsvps_updated) +
        (SELECT COUNT(*) FROM wellness_updated) +
        (SELECT COUNT(*) FROM guest_passes_updated) as total
    `);
    normalizedEmails = Number((emailResult.rows[0] as Record<string, unknown>)?.total || 0);

    const feeSnapshotResult = await db.execute(sql`
      DELETE FROM booking_fee_snapshots bfs
      WHERE NOT EXISTS (SELECT 1 FROM booking_requests br WHERE br.id = bfs.booking_id)
        AND bfs.status NOT IN ('paid', 'captured')
      RETURNING id
    `);
    orphanedFeeSnapshots = feeSnapshotResult.rows.length;

    if (orphanedFeeSnapshots > 0) {
      logger.info(`[DataCleanup] Removed ${orphanedFeeSnapshots} orphaned fee snapshots`);
    }

    logger.info(`[DataCleanup] Removed ${orphanedNotifications} orphaned notifications, marked ${orphanedBookings} orphaned bookings, normalized ${normalizedEmails} emails, removed ${orphanedFeeSnapshots} orphaned fee snapshots`);
  } catch (error: unknown) {
    logger.error('[DataCleanup] Error during cleanup:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }

  return { orphanedNotifications, orphanedBookings, normalizedEmails, orphanedFeeSnapshots };
}

export async function autoFixMissingTiers(): Promise<{
  fixedBillingProvider: number;
  fixedFromAlternateEmail: number;
  remainingWithoutTier: number;
  normalizedStatusCase: number;
  syncedStaffRoles: number;
}> {
  let fixedBillingProvider = 0;
  let fixedFromAlternateEmail = 0;
  let normalizedStatusCase = 0;
  let syncedStaffRoles = 0;
  
  try {
    const caseNormResult = await db.execute(sql`
      UPDATE users SET membership_status = LOWER(membership_status), updated_at = NOW()
      WHERE membership_status != LOWER(membership_status)
      RETURNING id, email, membership_status
    `);
    normalizedStatusCase = caseNormResult.rows.length;
    if (normalizedStatusCase > 0) {
      const details = (caseNormResult.rows as Record<string, unknown>[]).map(r => `${r.email} -> ${r.membership_status}`).join(', ');
      logger.info(`[AutoFix] Normalized membership_status case for ${normalizedStatusCase} members: ${details}`);
    }

    const billingProviderResult = await db.execute(sql`
      UPDATE users SET billing_provider = 'mindbody', updated_at = NOW()
      WHERE membership_status = 'active'
        AND billing_provider IS NULL
        AND mindbody_client_id IS NOT NULL
        AND mindbody_client_id != ''
        AND role != 'visitor'
        AND email NOT LIKE '%test%'
        AND email NOT LIKE '%example.com'
      RETURNING email
    `);
    fixedBillingProvider = billingProviderResult.rows.length;
    if (fixedBillingProvider > 0) {
      const emails = (billingProviderResult.rows as Record<string, unknown>[]).map(r => r.email).join(', ');
      logger.info(`[AutoFix] Set billing_provider='mindbody' for ${fixedBillingProvider} members with MindBody IDs: ${emails}`);
    }

    const fixResult = await db.execute(sql`
      WITH tier_fixes AS (
        SELECT DISTINCT ON (u1.id)
          u1.id as id_to_fix,
          u1.email as email_to_fix,
          primary_user.tier as tier_to_copy
        FROM users u1
        JOIN user_linked_emails ule ON LOWER(ule.linked_email) = LOWER(u1.email)
        JOIN users primary_user ON LOWER(primary_user.email) = LOWER(ule.primary_email) 
          AND primary_user.tier IS NOT NULL
        WHERE u1.role = 'member' 
          AND u1.membership_status = 'active' 
          AND u1.tier IS NULL
          AND u1.email NOT LIKE '%test%'
          AND u1.email NOT LIKE '%example.com'
        ORDER BY u1.id, primary_user.updated_at DESC NULLS LAST
      )
      UPDATE users u
      SET tier = tf.tier_to_copy, updated_at = NOW()
      FROM tier_fixes tf
      WHERE u.id = tf.id_to_fix
      RETURNING u.email, u.tier
    `);
    
    fixedFromAlternateEmail = (fixResult as { rowCount?: number }).rowCount || 0;
    
    if (fixedFromAlternateEmail > 0) {
      logger.info(`[AutoFix] Fixed ${fixedFromAlternateEmail} members missing tier by copying from verified linked email`);
    }

    const hubspotTierCandidates = await db.execute(sql`
      SELECT DISTINCT ON (u1.id)
        u1.id, u1.email as user_email, u1.hubspot_id,
        alt_user.email as alt_email, alt_user.tier as suggested_tier
      FROM users u1
      JOIN users alt_user ON u1.hubspot_id IS NOT NULL 
        AND alt_user.hubspot_id = u1.hubspot_id 
        AND alt_user.email != u1.email 
        AND alt_user.tier IS NOT NULL
      WHERE u1.role = 'member' 
        AND u1.membership_status = 'active' 
        AND u1.tier IS NULL
        AND u1.email NOT LIKE '%test%'
        AND u1.email NOT LIKE '%example.com'
      ORDER BY u1.id, alt_user.updated_at DESC NULLS LAST
    `);

    if (hubspotTierCandidates.rows.length > 0) {
      const candidates = hubspotTierCandidates.rows as Record<string, unknown>[];
      logger.warn(`[AutoFix] ${candidates.length} members have potential tier from shared HubSpot ID — flagged for manual review (not auto-applied)`, {
        extra: { candidates: candidates.map(c => ({ email: c.user_email, altEmail: c.alt_email, suggestedTier: c.suggested_tier, hubspotId: c.hubspot_id })) }
      });
    }
    
    const remainingResult = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM users 
      WHERE role = 'member' 
        AND membership_status = 'active' 
        AND tier IS NULL
        AND email NOT LIKE '%test%'
        AND email NOT LIKE '%example.com'
    `);
    
    const remainingWithoutTier = parseInt((remainingResult.rows[0] as Record<string, unknown>)?.count as string || '0', 10);
    
    if (remainingWithoutTier > 0) {
      const emailsResult = await db.execute(sql`
        SELECT email, first_name, last_name, stripe_customer_id, mindbody_client_id
        FROM users 
        WHERE role = 'member' 
          AND membership_status = 'active' 
          AND tier IS NULL
          AND email NOT LIKE '%test%'
          AND email NOT LIKE '%example.com'
        ORDER BY created_at DESC
        LIMIT 20
      `);
      const emails = (emailsResult.rows as Record<string, unknown>[]).map(r => `${r.first_name || ''} ${r.last_name || ''} <${r.email}>${r.mindbody_client_id ? ` (MindBody: ${r.mindbody_client_id})` : ''}`).join(', ');
      logger.info(`[AutoFix] ${remainingWithoutTier} active members still without tier (cannot auto-determine): ${emails}`);
    }

    const staffSyncResult = await db.execute(sql`
      UPDATE users u
      SET role = su.role,
          tier = 'VIP',
          membership_status = 'active',
          updated_at = NOW()
      FROM staff_users su
      WHERE LOWER(u.email) = LOWER(su.email)
        AND su.is_active = true
        AND u.role NOT IN ('admin', 'staff', 'golf_instructor')
      RETURNING u.id, u.email, su.role as new_role
    `);
    syncedStaffRoles = staffSyncResult.rows.length;
    if (syncedStaffRoles > 0) {
      const details = (staffSyncResult.rows as Record<string, unknown>[]).map(r => `${r.email} -> role=${r.new_role}, tier=VIP, status=active`).join(', ');
      logger.info(`[AutoFix] Synced staff role for ${syncedStaffRoles} users: ${details}`);
    }
    
    return { fixedBillingProvider, fixedFromAlternateEmail, remainingWithoutTier, normalizedStatusCase, syncedStaffRoles };
  } catch (error: unknown) {
    logger.error('[AutoFix] Error in periodic auto-fixes:', { extra: { detail: getErrorMessage(error) } });
    return { fixedBillingProvider: 0, fixedFromAlternateEmail: 0, remainingWithoutTier: -1, normalizedStatusCase: 0, syncedStaffRoles: 0 };
  }
}

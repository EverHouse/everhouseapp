import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import { getTodayPacific } from '../../utils/dateUtils';
import type {
  IntegrityCheckResult,
  IntegrityIssue,
  UnmatchedBookingRow,
  CountRow,
  ParticipantUserRow,
  ReviewItemRow,
  InvalidBookingRow,
  InvalidSessionRow,
  StaleTourRow,
  GhostBookingRow,
  EmptySessionRow,
  OverlapRow,
  GuestPassOverUsedRow,
  OrphanHoldRow,
  ExpiredHoldRow,
  StaleBookingRow,
} from './core';

export async function checkUnmatchedTrackmanBookings(): Promise<IntegrityCheckResult> {
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
    const total = (totalCount.rows[0] as unknown as CountRow)?.count || 0;

    for (const row of unmatchedBookings.rows as unknown as UnmatchedBookingRow[]) {
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'trackman_unmatched_bookings',
        recordId: row.id,
        description: `Trackman booking for "${row.user_name || 'Unknown'}" (${row.original_email || 'no email'}) on ${row.booking_date} has no matching member`,
        suggestion: 'Use the Trackman Unmatched Bookings section to link this booking to a member or create a visitor record',
        context: {
          trackmanBookingId: row.trackman_booking_id || undefined,
          userName: row.user_name || undefined,
          userEmail: row.original_email || undefined,
          bookingDate: row.booking_date || undefined,
          bayNumber: row.bay_number || undefined,
          startTime: row.start_time || undefined,
          endTime: row.end_time || undefined,
          importedName: row.user_name || undefined,
          notes: row.notes || undefined,
          originalEmail: row.original_email || undefined
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

export async function checkParticipantUserRelationships(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const invalidUsers = await db.execute(sql`
    SELECT bp.id, bp.user_id, bp.display_name, bp.session_id,
           bs.session_date, bs.start_time, r.name as resource_name
    FROM booking_participants bp
    LEFT JOIN users u ON bp.user_id = u.id
    LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
    LEFT JOIN resources r ON bs.resource_id = r.id
    WHERE bp.user_id IS NOT NULL AND bp.user_id != '' AND u.id IS NULL
  `);

  for (const row of invalidUsers.rows as unknown as ParticipantUserRow[]) {
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

export async function checkNeedsReviewItems(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const eventsNeedingReview = await db.execute(sql`
    SELECT id, title, event_date, start_time FROM events WHERE needs_review = true
  `);

  const wellnessNeedingReview = await db.execute(sql`
    SELECT id, title, date, instructor, time AS start_time FROM wellness_classes WHERE needs_review = true
  `);

  for (const row of eventsNeedingReview.rows as unknown as ReviewItemRow[]) {
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

  for (const row of wellnessNeedingReview.rows as unknown as ReviewItemRow[]) {
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
    status: issues.length === 0 ? 'pass' : 'info',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkBookingTimeValidity(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const invalidBookings = await db.execute(sql`
    SELECT br.id, br.user_email, br.user_name, br.request_date, br.start_time, br.end_time, r.name as resource_name
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    WHERE br.end_time < br.start_time
    AND NOT (br.start_time >= '20:00:00' AND br.end_time <= '06:00:00')
  `);

  for (const row of invalidBookings.rows as unknown as InvalidBookingRow[]) {
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
    AND NOT (bs.start_time >= '20:00:00' AND bs.end_time <= '06:00:00')
  `);

  for (const row of invalidSessions.rows as unknown as InvalidSessionRow[]) {
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

export async function checkStalePastTours(): Promise<IntegrityCheckResult> {
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

  for (const row of staleTours.rows as unknown as StaleTourRow[]) {
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

export async function checkBookingsWithoutSessions(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

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
      AND br.user_email IS NOT NULL AND br.user_email != ''
      AND br.user_email NOT LIKE 'private-event@%'
      AND br.is_event IS NOT TRUE
      AND (
        br.status = 'attended'
        OR br.request_date < CURRENT_DATE
      )
    ORDER BY br.request_date DESC
    LIMIT 100
  `);
  const ghosts = ghostsResult.rows as unknown as GhostBookingRow[];

  for (const row of ghosts) {
    const dateStr = row.request_date ? new Date(row.request_date).toISOString().split('T')[0] : 'unknown';
    const memberName = row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : undefined;
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
        memberName: memberName,
        trackmanBookingId: row.trackman_booking_id,
        resourceId: Number(row.resource_id),
        resourceName: row.resource_name,
        startTime: row.start_time,
        endTime: row.end_time,
        notes: row.notes,
        importedName: memberName || String(row.user_email || '').split('@')[0],
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

export async function checkSessionsWithoutParticipants(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const emptySessions = await db.execute(sql`
    SELECT bs.id, bs.session_date, bs.resource_id, bs.start_time, bs.end_time, bs.created_at,
           bs.trackman_booking_id,
           r.name as resource_name,
           br.id as linked_booking_id,
           br.trackman_booking_id as booking_trackman_id
    FROM booking_sessions bs
    LEFT JOIN booking_participants bp ON bp.session_id = bs.id
    LEFT JOIN resources r ON bs.resource_id = r.id
    LEFT JOIN booking_requests br ON br.session_id = bs.id
    WHERE bp.id IS NULL
      AND bs.session_date >= CURRENT_DATE - INTERVAL '30 days'
    LIMIT 100
  `);

  for (const row of emptySessions.rows as unknown as EmptySessionRow[]) {
    issues.push({
      category: 'orphan_record',
      severity: 'warning',
      table: 'booking_sessions',
      recordId: row.id,
      description: `Session on ${row.session_date} at ${row.start_time}–${row.end_time} (${row.resource_name || 'unknown resource'}) has zero participants`,
      suggestion: 'Review session and add participants or remove empty session',
      context: {
        sessionId: row.id || undefined,
        bookingDate: row.session_date || undefined,
        startTime: row.start_time || undefined,
        endTime: row.end_time || undefined,
        resourceName: row.resource_name || undefined,
        resourceId: row.resource_id || undefined,
        linkedBookingId: row.linked_booking_id || undefined,
        trackmanBookingId: row.trackman_booking_id || row.booking_trackman_id || undefined
      }
    });
  }

  return {
    checkName: 'Sessions Without Participants',
    status: issues.length === 0 ? 'pass' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkOverlappingBookings(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  try {
    const overlapsResult = await db.execute(sql`
      SELECT bs1.id as session1_id, bs2.id as session2_id, bs1.resource_id, bs1.session_date,
             bs1.start_time, bs1.end_time, bs2.start_time as overlap_start, bs2.end_time as overlap_end,
             br1.id as booking1_id, br1.status as booking1_status,
             br2.id as booking2_id, br2.status as booking2_status,
             u1.email as member1_email, u1.first_name as member1_first, u1.last_name as member1_last,
             u2.email as member2_email, u2.first_name as member2_first, u2.last_name as member2_last,
             r.name as resource_name
      FROM booking_sessions bs1
      JOIN booking_sessions bs2 ON bs1.resource_id = bs2.resource_id
        AND bs1.session_date = bs2.session_date
        AND bs1.id < bs2.id
        AND bs1.start_time < bs2.end_time
        AND bs2.start_time < bs1.end_time
      JOIN booking_requests br1 ON br1.session_id = bs1.id AND br1.status IN ('approved', 'confirmed', 'attended')
      JOIN booking_requests br2 ON br2.session_id = bs2.id AND br2.status IN ('approved', 'confirmed', 'attended')
      LEFT JOIN users u1 ON br1.user_id = u1.id
      LEFT JOIN users u2 ON br2.user_id = u2.id
      LEFT JOIN resources r ON bs1.resource_id = r.id
      WHERE bs1.session_date >= CURRENT_DATE - INTERVAL '30 days'
    `);

    for (const row of overlapsResult.rows as unknown as OverlapRow[]) {
      issues.push({
        category: 'booking_issue',
        severity: 'warning',
        table: 'booking_sessions',
        recordId: `${row.session1_id}-${row.session2_id}`,
        description: `Sessions #${row.session1_id} and #${row.session2_id} overlap on resource ${row.resource_id} on ${row.session_date} (${row.start_time}-${row.end_time} vs ${row.overlap_start}-${row.overlap_end})`,
        suggestion: 'Informational: DB trigger prevents new overlaps. This may be a legacy overlap or an edge case that slipped through.',
        context: {
          resourceId: Number(row.resource_id),
          resourceName: row.resource_name || undefined,
          startTime: row.start_time || undefined,
          endTime: row.end_time || undefined,
          bookingDate: row.session_date || undefined,
          booking1Id: Number(row.booking1_id),
          booking1Status: row.booking1_status || undefined,
          member1Email: row.member1_email || undefined,
          member1Name: [row.member1_first, row.member1_last].filter(Boolean).join(' ') || undefined,
          booking2Id: Number(row.booking2_id),
          booking2Status: row.booking2_status || undefined,
          member2Email: row.member2_email || undefined,
          member2Name: [row.member2_first, row.member2_last].filter(Boolean).join(' ') || undefined,
        }
      });
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking overlapping bookings:', { extra: { detail: getErrorMessage(error) } });
    return {
      checkName: 'Overlapping Bookings',
      status: 'warning',
      issueCount: 1,
      issues: [{
        category: 'system_error',
        severity: 'error',
        table: 'booking_sessions',
        recordId: 'check_error',
        description: `Failed to check overlapping bookings: ${getErrorMessage(error)}`,
        suggestion: 'Review server logs for details and retry'
      }],
      lastRun: new Date()
    };
  }

  return {
    checkName: 'Overlapping Bookings',
    status: issues.length === 0 ? 'pass' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkGuestPassAccountingDrift(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  try {
    const overUsedResult = await db.execute(sql`
      SELECT id, member_email, passes_used, passes_total
      FROM guest_passes
      WHERE passes_used > passes_total
    `);

    for (const row of overUsedResult.rows as unknown as GuestPassOverUsedRow[]) {
      issues.push({
        category: 'billing_issue',
        severity: 'error',
        table: 'guest_passes',
        recordId: row.id,
        description: `Guest pass #${row.id} for ${row.member_email} has passes_used (${row.passes_used}) > passes_total (${row.passes_total})`,
        suggestion: 'Guest pass usage exceeds total allocation. Review and correct the pass balance.',
        context: {
          memberEmail: row.member_email || undefined
        }
      });
    }

    const orphanHoldsResult = await db.execute(sql`
      SELECT gph.id, gph.member_email, gph.booking_id, gph.passes_held
      FROM guest_pass_holds gph
      WHERE NOT EXISTS (SELECT 1 FROM booking_requests br WHERE br.id = gph.booking_id)
    `);

    for (const row of orphanHoldsResult.rows as unknown as OrphanHoldRow[]) {
      issues.push({
        category: 'orphan_record',
        severity: 'warning',
        table: 'guest_pass_holds',
        recordId: row.id,
        description: `Guest pass hold #${row.id} for ${row.member_email} references non-existent booking #${row.booking_id} (${row.passes_held} passes held)`,
        suggestion: 'Release the held passes and delete the orphan hold record.',
        context: {
          memberEmail: row.member_email || undefined
        }
      });
    }

    const expiredHoldsResult = await db.execute(sql`
      SELECT id, member_email, booking_id, passes_held, expires_at
      FROM guest_pass_holds
      WHERE expires_at < NOW()
    `);

    for (const row of expiredHoldsResult.rows as unknown as ExpiredHoldRow[]) {
      issues.push({
        category: 'orphan_record',
        severity: 'warning',
        table: 'guest_pass_holds',
        recordId: row.id,
        description: `Guest pass hold #${row.id} for ${row.member_email} expired at ${row.expires_at} but was not cleaned up (${row.passes_held} passes still held)`,
        suggestion: 'Release expired hold and return passes to the member balance.',
        context: {
          memberEmail: row.member_email || undefined
        }
      });
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking guest pass accounting drift:', { extra: { detail: getErrorMessage(error) } });
    return {
      checkName: 'Guest Pass Accounting Drift',
      status: 'warning',
      issueCount: 1,
      issues: [{
        category: 'system_error',
        severity: 'error',
        table: 'guest_passes',
        recordId: 'check_error',
        description: `Failed to check guest pass accounting drift: ${getErrorMessage(error)}`,
        suggestion: 'Review server logs for details and retry'
      }],
      lastRun: new Date()
    };
  }

  return {
    checkName: 'Guest Pass Accounting Drift',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkStalePendingBookings(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  try {
    const staleResult = await db.execute(sql`
      SELECT br.id, br.user_email, br.request_date, br.start_time, br.status, br.resource_id
      FROM booking_requests br
      WHERE br.status IN ('pending', 'approved')
        AND (br.request_date + br.start_time::time) < ((NOW() AT TIME ZONE 'America/Los_Angeles') - INTERVAL '24 hours')
        AND br.request_date >= CURRENT_DATE - INTERVAL '7 days'
        AND br.user_email NOT LIKE '%@trackman.local'
      ORDER BY br.request_date DESC
    `);

    const totalStale = staleResult.rows.length;
    const maxDetailedIssues = 25;

    for (const row of (staleResult.rows as unknown as StaleBookingRow[]).slice(0, maxDetailedIssues)) {
      issues.push({
        category: 'booking_issue',
        severity: 'warning',
        table: 'booking_requests',
        recordId: row.id,
        description: `Booking #${row.id} for ${row.user_email} on ${row.request_date} at ${row.start_time} is still "${row.status}" but past its start time`,
        suggestion: 'This booking is past its start time but still in pending/approved status. It should be confirmed, cancelled, or marked as no-show.',
        context: {
          memberEmail: row.user_email || undefined,
          bookingDate: row.request_date || undefined,
          startTime: row.start_time || undefined,
          status: row.status || undefined,
          resourceId: row.resource_id ? Number(row.resource_id) : undefined
        }
      });
    }

    if (totalStale > maxDetailedIssues) {
      issues.push({
        category: 'booking_issue',
        severity: 'info',
        table: 'booking_requests',
        recordId: 'stale_summary',
        description: `${totalStale - maxDetailedIssues} additional stale bookings not shown. Total: ${totalStale} bookings in pending/approved status past their start time in the last 7 days.`,
        suggestion: 'Consider bulk-cancelling old approved bookings or implementing auto-no-show after 24 hours.'
      });
    }

    return {
      checkName: 'Stale Pending Bookings',
      status: issues.length === 0 ? 'pass' : 'warning',
      issueCount: totalStale,
      issues,
      lastRun: new Date()
    };
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking stale pending bookings:', { extra: { detail: getErrorMessage(error) } });
    return {
      checkName: 'Stale Pending Bookings',
      status: 'warning',
      issueCount: 1,
      issues: [{
        category: 'system_error',
        severity: 'error',
        table: 'booking_requests',
        recordId: 'check_error',
        description: `Failed to check stale pending bookings: ${getErrorMessage(error)}`,
        suggestion: 'Review server logs for details and retry'
      }],
      lastRun: new Date()
    };
  }
}

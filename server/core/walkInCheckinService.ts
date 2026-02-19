import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from './logger';
import { broadcastMemberStatsUpdated, broadcastToStaff } from './websocket';
import { notifyMember } from './notificationService';
import { updateHubSpotContactVisitCount } from './memberSync';
import { sendFirstVisitConfirmationEmail } from '../emails/firstVisitEmail';
import { getErrorMessage } from '../utils/errorUtils';

export interface WalkInCheckinParams {
  memberId: string;
  checkedInBy: string;
  checkedInByName: string | null;
  source: 'qr' | 'nfc';
}

export interface WalkInCheckinResult {
  success: boolean;
  memberName: string;
  memberEmail: string;
  tier: string | null;
  lifetimeVisits: number;
  pinnedNotes: Array<{ content: string; createdBy: string }>;
  membershipStatus: string | null;
  alreadyCheckedIn?: boolean;
  error?: string;
}

export async function processWalkInCheckin(params: WalkInCheckinParams): Promise<WalkInCheckinResult> {
  try {
    const memberResult = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.membership_status, u.tier, u.hubspot_id, u.lifetime_visits
      FROM users u
      WHERE u.id = ${params.memberId}
      LIMIT 1
    `);

    if (memberResult.rows.length === 0) {
      return { success: false, memberName: '', memberEmail: '', tier: null, lifetimeVisits: 0, pinnedNotes: [], membershipStatus: null, error: 'Member not found' };
    }

    const member = memberResult.rows[0];
    const displayName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email.split('@')[0];

    const recentCheckin = await db.execute(sql`SELECT id, created_at FROM walk_in_visits WHERE member_email = ${member.email} AND created_at > NOW() - INTERVAL '2 minutes' LIMIT 1`);
    if (recentCheckin.rows.length > 0) {
      return { success: false, memberName: displayName, memberEmail: member.email, tier: member.tier, lifetimeVisits: member.lifetime_visits || 0, pinnedNotes: [], membershipStatus: member.membership_status, alreadyCheckedIn: true, error: 'This member was already checked in less than 2 minutes ago' };
    }

    const updateResult = await db.execute(sql`UPDATE users SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 WHERE id = ${params.memberId} RETURNING lifetime_visits`);
    const newVisitCount = updateResult.rows[0]?.lifetime_visits || 1;

    if (member.hubspot_id) {
      updateHubSpotContactVisitCount(member.hubspot_id, newVisitCount)
        .catch(err => logger.error(`[WalkInCheckin] Failed to sync visit count to HubSpot:`, { extra: { err } }));
    }

    try { broadcastMemberStatsUpdated(member.email, { lifetimeVisits: newVisitCount }); } catch (err: unknown) {logger.error('[Broadcast] Stats update error:', err); }

    notifyMember({
      userEmail: member.email,
      title: 'Check-In Complete',
      message: "Welcome back! You've been checked in by staff.",
      type: 'booking',
      relatedType: 'booking'
    }).catch(err => logger.error(`[WalkInCheckin] Failed to send notification:`, { extra: { err } }));

    await db.execute(sql`INSERT INTO walk_in_visits (member_email, checked_in_by, checked_in_by_name, source, created_at)
       VALUES (${member.email}, ${params.checkedInBy}, ${params.checkedInByName}, ${params.source}, NOW())`);

    if (newVisitCount === 1 && member.membership_status?.toLowerCase() === 'trialing') {
      sendFirstVisitConfirmationEmail(member.email, { firstName: member.first_name || undefined })
        .then(() => logger.info(`[WalkInCheckin] Sent first visit confirmation email to trial member:`, { extra: { email: member.email } }))
        .catch(err => logger.error(`[WalkInCheckin] Failed to send first visit confirmation email:`, { extra: { err } }));
    }

    const pinnedNotesResult = await db.execute(sql`SELECT content, created_by_name FROM member_notes WHERE member_email = ${member.email} AND is_pinned = true ORDER BY created_at DESC`);
    const pinnedNotes = pinnedNotesResult.rows.map(n => ({
      content: n.content,
      createdBy: n.created_by_name || 'Staff'
    }));

    broadcastToStaff({
      type: 'walkin_checkin',
      data: {
        memberName: displayName,
        memberEmail: member.email,
        tier: member.tier,
        lifetimeVisits: newVisitCount,
        pinnedNotes,
        membershipStatus: member.membership_status,
        source: params.source
      }
    });

    logger.info(`[WalkInCheckin] Walk-in check-in: ${displayName} by ${params.checkedInBy}. Visit #${newVisitCount}`, { extra: { displayName, memberEmail: member.email, checkedInBy: params.checkedInBy, newVisitCount, source: params.source } });

    return {
      success: true,
      memberName: displayName,
      memberEmail: member.email,
      tier: member.tier,
      lifetimeVisits: newVisitCount,
      pinnedNotes,
      membershipStatus: member.membership_status
    };
  } catch (error: unknown) {
    logger.error(`[WalkInCheckin] Failed to process walk-in check-in:`, { error: error instanceof Error ? error : new Error(String(error)), extra: { memberId: params.memberId, source: params.source } });
    return { success: false, memberName: '', memberEmail: '', tier: null, lifetimeVisits: 0, pinnedNotes: [], membershipStatus: null, error: getErrorMessage(error) };
  }
}

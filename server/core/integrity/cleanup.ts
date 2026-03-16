import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import type {
  CountRow,
  HubSpotTierCandidateRow,
  RemainingMemberRow,
} from './core';

export async function runDataCleanup(): Promise<{
  orphanedNotifications: number;
  orphanedBookings: number;
  expiredHolds: number;
}> {
  let orphanedNotifications = 0;
  let orphanedBookings = 0;
  let expiredHolds = 0;

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

    const holdResult = await db.execute(sql`
      DELETE FROM guest_pass_holds gph
      WHERE gph.expires_at < NOW()
      RETURNING id
    `);
    expiredHolds = holdResult.rows.length;

    logger.info(`[DataCleanup] Removed ${orphanedNotifications} orphaned notifications, marked ${orphanedBookings} orphaned bookings, removed ${expiredHolds} expired guest pass holds`);
  } catch (error: unknown) {
    logger.error('[DataCleanup] Error during cleanup:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }

  return { orphanedNotifications, orphanedBookings, expiredHolds };
}

export async function autoFixMissingTiers(): Promise<{
  fixedFromAlternateEmail: number;
  remainingWithoutTier: number;
}> {
  let fixedFromAlternateEmail = 0;

  try {
    await db.execute(sql`
      DELETE FROM user_linked_emails
      WHERE LOWER(primary_email) = LOWER(linked_email)
    `);

    await db.execute(sql`
      DELETE FROM user_linked_emails ule
      WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE LOWER(u.email) = LOWER(ule.primary_email)
          AND u.archived_at IS NULL
          AND u.membership_status != 'merged'
      )
    `);

    const clearedLinkedTiers = await db.execute(sql`
      UPDATE users u
      SET tier = NULL, membership_status = 'inactive', last_modified_at = CASE WHEN membership_status IS DISTINCT FROM 'inactive' THEN NOW() ELSE last_modified_at END, updated_at = NOW()
      FROM user_linked_emails ule
      WHERE LOWER(ule.linked_email) = LOWER(u.email)
        AND LOWER(ule.primary_email) != LOWER(ule.linked_email)
        AND u.role = 'member'
        AND (u.tier IS NOT NULL OR u.membership_status = 'active')
        AND u.email NOT LIKE '%test%'
        AND u.email NOT LIKE '%example.com'
        AND (u.last_manual_fix_at IS NULL OR u.last_manual_fix_at < NOW() - INTERVAL '1 hour')
        AND EXISTS (
          SELECT 1 FROM users p
          WHERE LOWER(p.email) = LOWER(ule.primary_email)
            AND p.archived_at IS NULL
            AND p.membership_status != 'merged'
        )
      RETURNING u.email, u.tier
    `);

    fixedFromAlternateEmail = (clearedLinkedTiers as { rowCount?: number }).rowCount || 0;

    if (fixedFromAlternateEmail > 0) {
      const emails = (clearedLinkedTiers.rows as unknown as { email: string }[]).slice(0, 10).map(r => r.email).join(', ');
      logger.info(`[AutoFix] Cleared tier/status for ${fixedFromAlternateEmail} linked user records (data belongs to primary): ${emails}`);
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
      const candidates = hubspotTierCandidates.rows as unknown as HubSpotTierCandidateRow[];
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

    const remainingWithoutTier = parseInt((remainingResult.rows[0] as unknown as CountRow)?.count as string || '0', 10);

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
      const emails = (emailsResult.rows as unknown as RemainingMemberRow[]).map(r => `${r.first_name || ''} ${r.last_name || ''} <${r.email}>${r.mindbody_client_id ? ` (MindBody: ${r.mindbody_client_id})` : ''}`).join(', ');
      logger.info(`[AutoFix] ${remainingWithoutTier} active members still without tier (cannot auto-determine): ${emails}`);
    }

    return { fixedFromAlternateEmail, remainingWithoutTier };
  } catch (error: unknown) {
    logger.error('[AutoFix] Error in periodic auto-fixes:', { extra: { detail: getErrorMessage(error) } });
    return { fixedFromAlternateEmail: 0, remainingWithoutTier: -1 };
  }
}

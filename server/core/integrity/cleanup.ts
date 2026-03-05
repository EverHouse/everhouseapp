import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import type {
  TotalRow,
  CountRow,
  EmailRow,
  CaseNormRow,
  HubSpotTierCandidateRow,
  RemainingMemberRow,
  StaffSyncRow,
} from './core';

export async function runDataCleanup(): Promise<{
  orphanedNotifications: number;
  orphanedBookings: number;
  normalizedEmails: number;
  expiredHolds: number;
}> {
  let orphanedNotifications = 0;
  let orphanedBookings = 0;
  let normalizedEmails = 0;
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
    normalizedEmails = Number((emailResult.rows[0] as unknown as TotalRow)?.total || 0);

    const holdResult = await db.execute(sql`
      DELETE FROM guest_pass_holds gph
      WHERE gph.expires_at < NOW()
      RETURNING id
    `);
    expiredHolds = holdResult.rows.length;

    logger.info(`[DataCleanup] Removed ${orphanedNotifications} orphaned notifications, marked ${orphanedBookings} orphaned bookings, normalized ${normalizedEmails} emails, removed ${expiredHolds} expired guest pass holds`);
  } catch (error: unknown) {
    logger.error('[DataCleanup] Error during cleanup:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }

  return { orphanedNotifications, orphanedBookings, normalizedEmails, expiredHolds };
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
      const details = (caseNormResult.rows as unknown as CaseNormRow[]).map(r => `${r.email} -> ${r.membership_status}`).join(', ');
      logger.info(`[AutoFix] Normalized membership_status case for ${normalizedStatusCase} members: ${details}`);
    }

    // Safety net — primary enforcement via trg_auto_billing_provider trigger
    const stripeProviderResult = await db.execute(sql`
      UPDATE users SET billing_provider = 'stripe', updated_at = NOW()
      WHERE membership_status = 'active'
        AND (billing_provider IS NULL OR billing_provider = '')
        AND stripe_subscription_id IS NOT NULL
        AND stripe_subscription_id != ''
        AND role != 'visitor'
        AND email NOT LIKE '%test%'
        AND email NOT LIKE '%example.com'
      RETURNING email
    `);
    const fixedStripeProvider = stripeProviderResult.rows.length;
    if (fixedStripeProvider > 0) {
      const emails = (stripeProviderResult.rows as unknown as EmailRow[]).map(r => r.email).join(', ');
      logger.info(`[AutoFix] Set billing_provider='stripe' for ${fixedStripeProvider} members with Stripe subscriptions: ${emails}`);
    }

    const billingProviderResult = await db.execute(sql`
      UPDATE users SET billing_provider = 'mindbody', updated_at = NOW()
      WHERE membership_status = 'active'
        AND (billing_provider IS NULL OR billing_provider = '')
        AND mindbody_client_id IS NOT NULL
        AND mindbody_client_id != ''
        AND stripe_subscription_id IS NULL
        AND role != 'visitor'
        AND email NOT LIKE '%test%'
        AND email NOT LIKE '%example.com'
      RETURNING email
    `);
    fixedBillingProvider = billingProviderResult.rows.length + fixedStripeProvider;
    if (billingProviderResult.rows.length > 0) {
      const emails = (billingProviderResult.rows as unknown as EmailRow[]).map(r => r.email).join(', ');
      logger.info(`[AutoFix] Set billing_provider='mindbody' for ${billingProviderResult.rows.length} members with MindBody IDs: ${emails}`);
    }

    // Safety net — primary enforcement via trg_copy_tier_on_link trigger
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

    // Safety net — primary enforcement via trg_sync_staff_role trigger
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
      const details = (staffSyncResult.rows as unknown as StaffSyncRow[]).map(r => `${r.email} -> role=${r.new_role}, tier=VIP, status=active`).join(', ');
      logger.info(`[AutoFix] Synced staff role for ${syncedStaffRoles} users: ${details}`);
    }

    // Safety net — primary enforcement via trg_link_participant_user_id trigger
    const ownerUserIdFix = await db.execute(sql`
      UPDATE booking_participants bp
      SET user_id = u.id
      FROM booking_requests br
      JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE bp.session_id = br.session_id
        AND bp.participant_type = 'owner'
        AND bp.user_id IS NULL
        AND br.request_date >= CURRENT_DATE - INTERVAL '90 days'
      RETURNING bp.id, br.user_email
    `);
    if (ownerUserIdFix.rows.length > 0) {
      logger.info(`[AutoFix] Fixed ${ownerUserIdFix.rows.length} owner participants with missing user_id`);
    }

    return { fixedBillingProvider, fixedFromAlternateEmail, remainingWithoutTier, normalizedStatusCase, syncedStaffRoles };
  } catch (error: unknown) {
    logger.error('[AutoFix] Error in periodic auto-fixes:', { extra: { detail: getErrorMessage(error) } });
    return { fixedBillingProvider: 0, fixedFromAlternateEmail: 0, remainingWithoutTier: -1, normalizedStatusCase: 0, syncedStaffRoles: 0 };
  }
}

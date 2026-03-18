import { logger } from '../../core/logger';
import { Router } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { notifyAllStaff } from '../../core/notificationService';
import { isStaffOrAdmin } from '../../core/middleware';
import { normalizeTierName } from '../../../shared/constants/tiers';
import { invalidateCache } from '../../core/queryCache';
import { broadcastDirectoryUpdate } from '../../core/websocket';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  validateHubSpotWebhookSignature,
  retryableHubSpotRequest,
  invalidateAllContactsCacheTimestamp,
} from './shared';
import { getHubSpotClient } from '../../core/integrations';

const router = Router();

router.post('/api/hubspot/webhooks', async (req, res) => {
  try {
  if (!validateHubSpotWebhookSignature(req)) {
    logger.warn('[HubSpot Webhook] Signature validation failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  const events = Array.isArray(req.body) ? req.body : [req.body];
  
  try {
    for (const event of events) {
      const { subscriptionType, objectId, propertyName, propertyValue } = event as { subscriptionType: string; objectId: string; propertyName: string; propertyValue: string | null };
      
      logger.info('[HubSpot Webhook] Received: for object , =', { extra: { subscriptionType, objectId, propertyName, propertyValue } });
      
      if (subscriptionType === 'contact.propertyChange') {
        const PROFILE_PROPERTIES = new Set([
          'firstname', 'lastname', 'email', 'phone', 'company',
          'address', 'city', 'state', 'zip',
          'date_of_birth', 'mindbody_client_id',
          'membership_discount_reason', 'membership_start_date',
          'eh_email_updates_opt_in', 'eh_sms_updates_opt_in',
          'hs_sms_promotional', 'hs_sms_customer_updates', 'hs_sms_reminders',
          'stripe_delinquent'
        ]);

        const isStatusOrTier = propertyName === 'membership_tier' || propertyName === 'membership_status';
        const isProfileProperty = PROFILE_PROPERTIES.has(propertyName);

        if (isStatusOrTier || isProfileProperty) {
          invalidateAllContactsCacheTimestamp();
          invalidateCache('members_directory');
          broadcastDirectoryUpdate('synced');
          logger.info('[HubSpot Webhook] Contact property changed', { extra: { objectId, propertyName, propertyValue } });

          try {
            const hubspot = await getHubSpotClient();
            const contact = await retryableHubSpotRequest(() => hubspot.crm.contacts.basicApi.getById(objectId, ['email', 'membership_status', 'membership_tier', 'mindbody_client_id']));
            const email = contact.properties.email?.toLowerCase();
            const hasMindbodyId = !!(contact.properties as Record<string, string | null>).mindbody_client_id;
            
            if (email) {
              const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${email}`);
              if (exclusionCheck.rows.length > 0) {
                logger.info('[HubSpot Webhook] Skipping excluded/deleted email', { extra: { email, propertyName, propertyValue } });
              } else {
                const userCheck = await db.execute(sql`SELECT role, billing_provider, stripe_subscription_id, membership_status, first_name, last_name, tier, data_source, visitor_type, archived_at, last_manual_fix_at FROM users WHERE LOWER(email) = ${email}`);
                const existingUser = userCheck.rows[0];

                if (!existingUser) {
                  logger.info('[HubSpot Webhook] No local user found for email, skipping', { extra: { email, propertyName } });
                } else if (existingUser.archived_at) {
                  logger.info('[HubSpot Webhook] Skipping archived user', { extra: { email, propertyName } });
                } else {
                  const isStripeProtected = existingUser.billing_provider === 'stripe';
                  const isVisitorProtected = existingUser.role === 'visitor';
                  const fixTime = existingUser.last_manual_fix_at instanceof Date
                    ? existingUser.last_manual_fix_at.getTime()
                    : new Date(existingUser.last_manual_fix_at as string).getTime();
                  const recentManualFix = existingUser.last_manual_fix_at &&
                    (Date.now() - fixTime) < 60 * 60 * 1000;

                  if (isStatusOrTier) {
                    if (isVisitorProtected) {
                      logger.info('[HubSpot Webhook] VISITOR PROTECTED: Skipping update for visitor', { extra: { email, propertyName, propertyValue } });
                    } else if (recentManualFix) {
                      logger.info('[HubSpot Webhook] MANUAL FIX PROTECTED: Skipping status/tier change — user was manually fixed recently', { extra: { email, propertyName, propertyValue, fixedAt: existingUser.last_manual_fix_at } });
                    } else if (propertyName === 'membership_status') {
                      const newStatus = (propertyValue || 'non-member').toLowerCase();

                      if (isStripeProtected) {
                        logger.info('[HubSpot Webhook] STRIPE WINS: Skipping status change for Stripe-billed member', { extra: { email, newStatus } });
                      } else if (newStatus === 'non-member' && existingUser.stripe_subscription_id) {
                        logger.info('[HubSpot Webhook] Skipping status change to \'non-member\' for - has active Stripe subscription', { extra: { email } });
                      } else {
                        const prevStatus = existingUser.membership_status as string | null;
                        const isMindBodyBilled = existingUser.billing_provider === 'mindbody';
                        const wasActive = (prevStatus || '').toLowerCase() === 'active';
                        const isMindBodyDeactivation = isMindBodyBilled && wasActive && newStatus !== 'active';

                        if (isMindBodyDeactivation) {
                          await db.execute(sql`UPDATE users SET membership_status = ${newStatus}, membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM ${newStatus} THEN NOW() ELSE membership_status_changed_at END, tier = NULL, tier_id = NULL, last_tier = COALESCE(tier, last_tier), billing_provider = 'stripe', updated_at = NOW() WHERE LOWER(email) = ${email}`);
                          logger.info('[HubSpot Webhook] MINDBODY DEACTIVATION CASCADE for', { extra: { email, newStatus, prevTier: existingUser.tier } });
                        } else {
                          await db.execute(sql`UPDATE users SET membership_status = ${newStatus}, membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM ${newStatus} THEN NOW() ELSE membership_status_changed_at END, updated_at = NOW() WHERE LOWER(email) = ${email}`);

                        }
                        logger.info('[HubSpot Webhook] Updated DB membership_status for to', { extra: { email, newStatus } });

                        const activeStatuses = ['active', 'trialing', 'past_due'];
                        const inactiveStatuses = ['expired', 'terminated', 'cancelled', 'canceled', 'inactive', 'churned', 'declined', 'suspended', 'frozen', 'non-member'];
                        const hubspotMemberName = `${existingUser.first_name || ''} ${existingUser.last_name || ''}`.trim() || email;
                        const memberTier = existingUser.tier || 'Unknown';

                        const nonNotifiableStatuses = ['non-member', 'visitor', 'lead'];
                        const billingProvider = existingUser.billing_provider;
                        const dataSource = existingUser.data_source;
                        const visitorType = existingUser.visitor_type;
                        const changeSource = hasMindbodyId || billingProvider === 'mindbody'
                          ? 'via MindBody'
                          : billingProvider === 'stripe' || isStripeProtected
                            ? 'via Stripe'
                            : visitorType === 'day_pass'
                              ? 'via Quick Guest Checkout'
                              : dataSource === 'APP'
                                ? 'via App'
                                : 'via HubSpot sync';
                        if (prevStatus && typeof prevStatus === 'string' && !nonNotifiableStatuses.includes(prevStatus) && newStatus === 'non-member') {
                          await notifyAllStaff(
                            'Member Status Changed',
                            `${hubspotMemberName} (${email}) status changed to non-member ${changeSource} (was ${prevStatus}).`,
                            'member_status_change',
                            { sendPush: true, url: '/admin/members' }
                          );
                        } else if (activeStatuses.includes(newStatus) && !activeStatuses.includes((prevStatus || '') as string)) {
                          await notifyAllStaff(
                            '🎉 New Member Activated',
                            `${hubspotMemberName} (${email}) is now active ${changeSource} (${memberTier} tier).`,
                            'new_member',
                            { sendPush: true, url: '/admin/members' }
                          );
                        } else if (inactiveStatuses.includes(newStatus) && !inactiveStatuses.includes((prevStatus || '') as string)) {
                          await notifyAllStaff(
                            'Member Status Changed',
                            `${hubspotMemberName} (${email}) status changed to ${newStatus} ${changeSource}.`,
                            'member_status_change',
                            { sendPush: true, url: '/admin/members' }
                          );
                        }
                      }
                    } else if (propertyName === 'membership_tier') {
                      if (isStripeProtected) {
                        logger.info('[HubSpot Webhook] STRIPE WINS: Skipping tier change for Stripe-billed member', { extra: { email, propertyValue } });
                      } else {
                        const visitorCheck = await db.execute(sql`SELECT role FROM users WHERE LOWER(email) = ${email} LIMIT 1`);
                        const isVisitor = (visitorCheck.rows as Array<{ role: string | null }>)[0]?.role === 'visitor';
                        if (isVisitor) {
                          logger.info('[HubSpot Webhook] Skipping tier change for visitor', { extra: { email, propertyValue } });
                        } else {
                          const normalizedTier = normalizeTierName(propertyValue || '');
                          if (normalizedTier) {
                            await db.execute(sql`UPDATE users SET tier = ${normalizedTier}, tier_id = COALESCE((SELECT id FROM membership_tiers WHERE LOWER(name) = LOWER(${normalizedTier}) LIMIT 1), tier_id), updated_at = NOW() WHERE LOWER(email) = ${email}`);
                            logger.info('[HubSpot Webhook] Updated DB tier for', { extra: { email, normalizedTier } });
                          }
                        }
                      }
                    }
                  } else if (isProfileProperty) {
                    const val = propertyValue || '';
                    const parseOptIn = (v: string): boolean | null => {
                      if (!v) return null;
                      const lower = v.toLowerCase();
                      return lower === 'true' || lower === 'yes' || lower === '1';
                    };

                    const COALESCE_MAP: Record<string, string> = {
                      firstname: 'first_name',
                      lastname: 'last_name',
                      phone: 'phone',
                      address: 'street_address',
                      city: 'city',
                      state: 'state',
                      zip: 'zip_code',
                      mindbody_client_id: 'mindbody_client_id',
                    };

                    const DATE_COALESCE_MAP: Record<string, string> = {
                      date_of_birth: 'date_of_birth',
                    };

                    const OVERWRITE_MAP: Record<string, string> = {
                      membership_discount_reason: 'discount_code',
                    };

                    const JOIN_DATE_PROP = 'membership_start_date';

                    const OPT_IN_MAP: Record<string, string> = {
                      eh_email_updates_opt_in: 'email_opt_in',
                      eh_sms_updates_opt_in: 'sms_opt_in',
                      hs_sms_promotional: 'sms_promo_opt_in',
                      hs_sms_customer_updates: 'sms_transactional_opt_in',
                      hs_sms_reminders: 'sms_reminders_opt_in',
                      stripe_delinquent: 'stripe_delinquent',
                    };

                    const ALLOWED_USER_COLUMNS = new Set([
                      ...Object.values(COALESCE_MAP),
                      ...Object.values(DATE_COALESCE_MAP),
                      ...Object.values(OVERWRITE_MAP),
                      ...Object.values(OPT_IN_MAP),
                    ]);

                    let updated = false;

                    const normalizeDate = (v: string): string | null => {
                      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
                      const ms = Number(v);
                      if (!isNaN(ms) && ms > 0) return new Date(ms).toISOString().split('T')[0];
                      const d = new Date(v);
                      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
                      return null;
                    };

                    if (COALESCE_MAP[propertyName] && val) {
                      const dbCol = COALESCE_MAP[propertyName];
                      if (!ALLOWED_USER_COLUMNS.has(dbCol)) throw new Error(`Invalid column: ${dbCol}`);
                      const result = await db.execute(sql`UPDATE users SET ${sql.raw(dbCol)} = ${val}, updated_at = NOW() WHERE LOWER(email) = ${email} AND (${sql.raw(dbCol)} IS NULL OR ${sql.raw(dbCol)} = '')`);
                      updated = (result.rowCount ?? 0) > 0;
                    } else if (DATE_COALESCE_MAP[propertyName] && val) {
                      const dbCol = DATE_COALESCE_MAP[propertyName];
                      if (!ALLOWED_USER_COLUMNS.has(dbCol)) throw new Error(`Invalid column: ${dbCol}`);
                      const dateVal = normalizeDate(val);
                      if (dateVal) {
                        const result = await db.execute(sql`UPDATE users SET ${sql.raw(dbCol)} = ${dateVal}::date, updated_at = NOW() WHERE LOWER(email) = ${email} AND ${sql.raw(dbCol)} IS NULL`);
                        updated = (result.rowCount ?? 0) > 0;
                      }
                    } else if (OVERWRITE_MAP[propertyName]) {
                      const dbCol = OVERWRITE_MAP[propertyName];
                      if (!ALLOWED_USER_COLUMNS.has(dbCol)) throw new Error(`Invalid column: ${dbCol}`);
                      await db.execute(sql`UPDATE users SET ${sql.raw(dbCol)} = ${val || null}, updated_at = NOW() WHERE LOWER(email) = ${email}`);
                      updated = true;
                    } else if (propertyName === JOIN_DATE_PROP && val) {
                      const dateVal = normalizeDate(val);
                      const result = dateVal
                        ? await db.execute(sql`UPDATE users SET join_date = ${dateVal}::date, updated_at = NOW() WHERE LOWER(email) = ${email} AND join_date IS NULL`)
                        : { rowCount: 0 };
                      updated = (result.rowCount ?? 0) > 0;
                    } else if (OPT_IN_MAP[propertyName]) {
                      const dbCol = OPT_IN_MAP[propertyName];
                      if (!ALLOWED_USER_COLUMNS.has(dbCol)) throw new Error(`Invalid column: ${dbCol}`);
                      const boolVal = parseOptIn(val);
                      if (boolVal !== null) {
                        await db.execute(sql`UPDATE users SET ${sql.raw(dbCol)} = ${boolVal}, updated_at = NOW() WHERE LOWER(email) = ${email}`);
                        updated = true;
                      }
                    }

                    if (updated) {
                      logger.info('[HubSpot Webhook] Updated profile property', { extra: { email, propertyName, propertyValue: val } });
                    }
                  }
                }
              }
            }
          } catch (updateError: unknown) {
            logger.error('[HubSpot Webhook] Failed to update DB for contact', { extra: { objectId, error: getErrorMessage(updateError) } });
            throw updateError;
          }
        }
      } else if (subscriptionType === 'deal.propertyChange') {
        logger.info('[HubSpot Webhook] Deal changed to', { extra: { objectId, propertyName, propertyValue } });
      } else if (subscriptionType === 'deal.creation') {
        logger.info('[HubSpot Webhook] New deal created', { extra: { objectId } });
      }
    }
  } catch (error: unknown) {
    logger.error('[HubSpot Webhook] Error processing event', { error: error instanceof Error ? error : new Error(String(error)) });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
    return;
  }

  res.status(200).send('OK');
  } catch (error: unknown) {
    logger.error('[HubSpot Webhook] Unhandled error', { error: error instanceof Error ? error : new Error(String(error)) });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
});

export default router;

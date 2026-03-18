import { logger } from '../core/logger';
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { users, magicLinks, staffUsers, membershipTiers, rateLimits } from '../../shared/schema';
import { isProduction } from '../core/db';
import { getHubSpotClient } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { normalizeTierName, DEFAULT_TIER } from '../../shared/constants/tiers';
import { getResendClient } from '../utils/resend';
import { withResendRetry } from '../core/retryUtils';
import { getSessionUser, SessionUser } from '../types/session';
import { sendWelcomeEmail } from '../emails/welcomeEmail';
import { getSupabaseAdmin, isSupabaseAvailable } from '../core/supabase/client';
import { normalizeEmail } from '../core/utils/emailNormalization';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { getErrorMessage } from '../utils/errorUtils';
import { getOtpEmailHtml } from '../emails/otpEmail';
import { authRateLimiter, authRateLimiterByIp } from '../middleware/rateLimiting';

interface StaffUserData {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  jobTitle: string;
  role: 'admin' | 'staff';
}

function normalizeRole(role: string | null | undefined): 'admin' | 'staff' {
  if (!role) return 'staff';
  const normalized = role.toLowerCase().trim();
  return normalized === 'admin' ? 'admin' : 'staff';
}

async function getStaffUserByEmail(email: string): Promise<StaffUserData | null> {
  if (!email) return null;
  try {
    const result = await db.select({
      id: staffUsers.id,
      firstName: staffUsers.firstName,
      lastName: staffUsers.lastName,
      phone: staffUsers.phone,
      jobTitle: staffUsers.jobTitle,
      role: staffUsers.role
    })
      .from(staffUsers)
      .where(and(
        sql`LOWER(${staffUsers.email}) = LOWER(${email})`,
        eq(staffUsers.isActive, true)
      ))
      .limit(1);
    
    if (result.length > 0) {
      return {
        id: result[0].id,
        firstName: result[0].firstName || '',
        lastName: result[0].lastName || '',
        phone: result[0].phone || '',
        jobTitle: result[0].jobTitle || '',
        role: normalizeRole(result[0].role)
      };
    }
    return null;
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching staff user', { error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

async function getUserRole(email: string): Promise<'admin' | 'staff' | 'member' | 'visitor'> {
  const normalized = normalizeEmail(email);
  const staffUser = await getStaffUserByEmail(normalized);
  if (staffUser) {
    return staffUser.role;
  }
  try {
    const result = await db.execute(
      sql`SELECT role FROM users WHERE LOWER(email) = LOWER(${normalized}) LIMIT 1`
    );
    const rows = result.rows as Array<{ role: string | null }>;
    if (rows.length > 0 && rows[0].role === 'visitor') {
      return 'visitor';
    }
  } catch (err: unknown) {
    logger.warn('[Auth] Failed to check visitor role', { extra: { error: getErrorMessage(err) } });
  }
  return 'member';
}

async function isStaffOrAdminEmail(email: string): Promise<boolean> {
  const staffUser = await getStaffUserByEmail(email);
  return staffUser !== null;
}

interface UpsertUserData {
  email: string;
  tierName: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  jobTitle?: string;
  mindbodyClientId?: string;
  tags?: string[];
  membershipStartDate?: string;
  role?: 'admin' | 'staff' | 'member' | 'visitor';
}

async function upsertUserWithTier(data: UpsertUserData): Promise<string | null> {
  try {
    const normalizedEmailValue = normalizeEmail(data.email);
    const isStaffOrAdmin = data.role === 'admin' || data.role === 'staff';
    const isVisitor = data.role === 'visitor';
    
    const normalizedTier = isVisitor ? null : (isStaffOrAdmin ? 'VIP' : normalizeTierName(data.tierName));
    let tierId: number | null = null;
    
    if (normalizedTier) {
      const tierResult = await db.select({ id: membershipTiers.id })
        .from(membershipTiers)
        .where(sql`LOWER(${membershipTiers.name}) = LOWER(${normalizedTier})`)
        .limit(1);
      tierId = tierResult.length > 0 ? tierResult[0].id : null;
    }
    
    const result = await db.insert(users)
      .values({
        id: crypto.randomUUID(),
        email: normalizedEmailValue,
        firstName: data.firstName || null,
        lastName: data.lastName || null,
        tier: normalizedTier,
        tierId: tierId,
        phone: data.phone || null,
        mindbodyClientId: isStaffOrAdmin ? null : (data.mindbodyClientId || null),
        tags: isStaffOrAdmin ? [] as string[] : (data.tags && data.tags.length > 0 ? data.tags : [] as string[]),
        role: data.role || 'member'
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          tier: normalizedTier,
          tierId: tierId,
          firstName: sql`COALESCE(${data.firstName || null}, ${users.firstName})`,
          lastName: sql`COALESCE(${data.lastName || null}, ${users.lastName})`,
          phone: sql`COALESCE(${data.phone || null}, ${users.phone})`,
          mindbodyClientId: isStaffOrAdmin ? null : sql`COALESCE(${data.mindbodyClientId || null}, ${users.mindbodyClientId})`,
          tags: isStaffOrAdmin ? [] as string[] : (data.tags && data.tags.length > 0 ? data.tags : [] as string[]),
          role: data.role || 'member',
          updatedAt: new Date()
        }
      })
      .returning({ id: users.id });
    
    if (isStaffOrAdmin) {
      await db.execute(sql`UPDATE users SET membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, tier = 'VIP', tier_id = COALESCE((SELECT id FROM membership_tiers WHERE LOWER(name) = 'vip' LIMIT 1), tier_id) WHERE LOWER(email) = LOWER(${normalizedEmailValue}) AND (membership_status IS NULL OR membership_status != 'active' OR tier IS NULL OR tier != 'VIP')`);
    }
    
    if (!isProduction) logger.info('[Auth] Updated user with role , tier', { extra: { normalizedEmailValue, dataRole: data.role, normalizedTier_none: normalizedTier || 'none' } });
    return result.length > 0 ? result[0].id : null;
  } catch (error: unknown) {
    logger.error('[Auth] Error upserting user tier', { error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

const SUPABASE_AUTH_TIMEOUT = 10000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${SUPABASE_AUTH_TIMEOUT / 1000}s`)), SUPABASE_AUTH_TIMEOUT)
    )
  ]);
}

export async function createSupabaseToken(user: { id: string, email: string, role: string, firstName?: string, lastName?: string }): Promise<string | null> {
  try {
    const available = await isSupabaseAvailable();
    if (!available) {
      return null;
    }
    
    const supabase = getSupabaseAdmin();
    
    await withTimeout(
      supabase.auth.admin.createUser({
        email: user.email,
        email_confirm: true,
        user_metadata: {
          first_name: user.firstName,
          last_name: user.lastName,
          app_role: user.role,
        }
      }),
      'Supabase createUser'
    ).catch((err) => { logger.warn('[Auth] Non-critical Supabase user creation failed:', err); });
    
    const { data: linkData, error: linkError } = await withTimeout(
      supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: user.email,
        options: {
          data: {
            first_name: user.firstName,
            last_name: user.lastName,
            app_role: user.role,
          }
        }
      }),
      'Supabase generateLink'
    );

    if (linkError) {
      if (!getErrorMessage(linkError)?.includes('fetch failed') && !getErrorMessage(linkError)?.includes('ENOTFOUND')) {
        logger.error('[Supabase] generateLink error', { extra: { linkError } });
      }
      return null;
    }
    
    if ((linkData?.properties as { access_token?: string })?.access_token) {
      return (linkData.properties as { access_token?: string }).access_token as string;
    }
    
    const hashedToken = linkData?.properties?.hashed_token;
    if (hashedToken) {
      const { data: otpData, error: otpError } = await withTimeout(
        supabase.auth.verifyOtp({
          token_hash: hashedToken,
          type: 'magiclink',
        }),
        'Supabase verifyOtp'
      );
      
      if (otpError) {
        if (!otpError.message?.includes('fetch failed') && !otpError.message?.includes('ENOTFOUND')) {
          logger.error('[Supabase] verifyOtp error', { extra: { otpError } });
        }
        return null;
      }
      
      if (otpData?.session?.access_token) {
        return otpData.session.access_token;
      }
    }
    
    return null;
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (!msg?.includes('fetch failed') && 
        !msg?.includes('ENOTFOUND') && 
        !msg?.includes('ECONNREFUSED') &&
        !msg?.includes('timed out')) {
      logger.error('[Supabase] Failed to generate token', { error: error instanceof Error ? error : new Error(msg) });
    }
    return null;
  }
}

const router = Router();

const OTP_REQUEST_LIMIT = 3;
const OTP_REQUEST_WINDOW = 15 * 60 * 1000;
const MAGIC_LINK_REQUEST_LIMIT = 3;
const MAGIC_LINK_REQUEST_WINDOW = 15 * 60 * 1000;
const OTP_VERIFY_MAX_ATTEMPTS = 5;
const OTP_VERIFY_LOCKOUT = 15 * 60 * 1000;
const OTP_VERIFY_EMAIL_MAX_ATTEMPTS = 20;

const checkOtpRequestLimit = async (email: string, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `otp_request:${email}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_REQUEST_WINDOW);
  
  try {
    const result = await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${key}, 'otp_request', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE 
           WHEN rate_limits.reset_at < NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_at = CASE 
           WHEN rate_limits.reset_at < NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count, reset_at`);
    
    const { count, reset_at } = result.rows[0] as { count: number; reset_at: Date };
    if (count > OTP_REQUEST_LIMIT) {
      const retryAfter = Math.ceil((new Date(reset_at).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    return { allowed: true };
  } catch (error: unknown) {
    // Fail-closed: deny requests when rate limiting is unavailable to prevent abuse
    logger.error('[RateLimit] Database error, denying request for safety', { error: error instanceof Error ? error : new Error(String(error)) });
    return { allowed: false, retryAfter: 60 };
  }
};

const _checkMagicLinkRequestLimit = async (email: string, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `magic_link:${email}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + MAGIC_LINK_REQUEST_WINDOW);
  
  try {
    const result = await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${key}, 'magic_link', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE 
           WHEN rate_limits.reset_at < NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_at = CASE 
           WHEN rate_limits.reset_at < NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count, reset_at`);
    
    const { count, reset_at } = result.rows[0] as { count: number; reset_at: Date };
    if (count > MAGIC_LINK_REQUEST_LIMIT) {
      const retryAfter = Math.ceil((new Date(reset_at).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    return { allowed: true };
  } catch (error: unknown) {
    // Fail-closed: deny requests when rate limiting is unavailable to prevent abuse
    logger.error('[RateLimit] Database error, denying request for safety', { error: error instanceof Error ? error : new Error(String(error)) });
    return { allowed: false, retryAfter: 60 };
  }
};

const checkOtpVerifyAttempts = async (email: string, ip?: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const effectiveIp = ip || 'unknown';
  const perIpKey = `otp_verify:${email}:${effectiveIp}`;
  const now = new Date();
  
  try {
    const result = await db.select({
      count: rateLimits.count,
      lockedUntil: rateLimits.lockedUntil,
    }).from(rateLimits).where(eq(rateLimits.key, perIpKey));
    
    if (result.length > 0) {
      const { lockedUntil: locked_until } = result[0];
      if (locked_until && new Date(locked_until) > now) {
        const retryAfter = Math.ceil((new Date(locked_until).getTime() - now.getTime()) / 1000);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
      }
      
      if (locked_until && new Date(locked_until) <= now) {
        db.delete(rateLimits).where(eq(rateLimits.key, perIpKey)).catch((err) => logger.warn('[RateLimit] Non-critical expired lock cleanup failed', { key: perIpKey, error: err }));
      }
    }

    const ipKey = `otp_verify_ip:${effectiveIp}`;
    const ipResult = await db.select({
      count: rateLimits.count,
      lockedUntil: rateLimits.lockedUntil,
    }).from(rateLimits).where(eq(rateLimits.key, ipKey));
    
    if (ipResult.length > 0) {
      const { lockedUntil: ipLocked } = ipResult[0];
      if (ipLocked && new Date(ipLocked) > now) {
        const retryAfter = Math.ceil((new Date(ipLocked).getTime() - now.getTime()) / 1000);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
      }
      if (ipLocked && new Date(ipLocked) <= now) {
        db.delete(rateLimits).where(eq(rateLimits.key, ipKey)).catch((err) => logger.warn('[RateLimit] Non-critical expired lock cleanup failed', { key: ipKey, error: err }));
      }
    }

    const emailKey = `otp_verify_email:${email}`;
    const emailResult = await db.select({
      count: rateLimits.count,
      lockedUntil: rateLimits.lockedUntil,
    }).from(rateLimits).where(eq(rateLimits.key, emailKey));
    
    if (emailResult.length > 0) {
      const { lockedUntil: emailLocked } = emailResult[0];
      if (emailLocked && new Date(emailLocked) > now) {
        const retryAfter = Math.ceil((new Date(emailLocked).getTime() - now.getTime()) / 1000);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
      }
      if (emailLocked && new Date(emailLocked) <= now) {
        db.delete(rateLimits).where(eq(rateLimits.key, emailKey)).catch((err) => logger.warn('[RateLimit] Non-critical expired lock cleanup failed', { key: emailKey, error: err }));
      }
    }
    
    return { allowed: true };
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error, denying request for safety', { error: error instanceof Error ? error : new Error(String(error)) });
    return { allowed: false, retryAfter: 60 };
  }
};

const OTP_VERIFY_IP_MAX_ATTEMPTS = 15;

const recordOtpVerifyFailure = async (email: string, ip?: string): Promise<void> => {
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_VERIFY_LOCKOUT);
  const lockedUntil = new Date(now.getTime() + OTP_VERIFY_LOCKOUT);
  const effectiveIp = ip || 'unknown';
  
  try {
    const perIpKey = `otp_verify:${email}:${effectiveIp}`;
    await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${perIpKey}, 'otp_verify', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         locked_until = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN NULL
           WHEN CASE WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1 ELSE rate_limits.count + 1 END >= ${OTP_VERIFY_MAX_ATTEMPTS} THEN ${lockedUntil}
           ELSE rate_limits.locked_until
         END,
         reset_at = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count`);

    const ipKey = `otp_verify_ip:${effectiveIp}`;
    await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${ipKey}, 'otp_verify_ip', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         locked_until = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN NULL
           WHEN CASE WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1 ELSE rate_limits.count + 1 END >= ${OTP_VERIFY_IP_MAX_ATTEMPTS} THEN ${lockedUntil}
           ELSE rate_limits.locked_until
         END,
         reset_at = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count`);

    const emailKey = `otp_verify_email:${email}`;
    await db.execute(sql`INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES (${emailKey}, 'otp_verify_email', 1, ${resetAt}, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         locked_until = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN NULL
           WHEN CASE WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN 1 ELSE rate_limits.count + 1 END >= ${OTP_VERIFY_EMAIL_MAX_ATTEMPTS} THEN ${lockedUntil}
           ELSE rate_limits.locked_until
         END,
         reset_at = CASE
           WHEN rate_limits.locked_until IS NOT NULL AND rate_limits.locked_until <= NOW() THEN ${resetAt}
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count`);
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error recording failure', { error: error instanceof Error ? error : new Error(String(error)) });
  }
};

const clearOtpVerifyAttempts = async (email: string, ip?: string): Promise<void> => {
  const effectiveIp = ip || 'unknown';
  const perIpKey = `otp_verify:${email}:${effectiveIp}`;
  const emailKey = `otp_verify_email:${email}`;
  try {
    await db.delete(rateLimits).where(eq(rateLimits.key, perIpKey));
    await db.delete(rateLimits).where(eq(rateLimits.key, emailKey));
  } catch (error: unknown) {
    logger.error('[RateLimit] Database error clearing attempts', { error: error instanceof Error ? error : new Error(String(error)) });
  }
};


router.post('/api/auth/verify-member', ...authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    
    // Check if this is a staff/admin user first
    const staffUserData = await getStaffUserByEmail(normalizedEmail);
    const isStaffOrAdmin = staffUserData !== null;
    
    // HYBRID APPROACH: Check database first for Stripe-billed members
    // Fall back to HubSpot only for Mindbody legacy members
    const dbUser = await db.select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phone: users.phone,
      tier: users.tier,
      tags: users.tags,
      membershipStatus: users.membershipStatus,
      stripeSubscriptionId: users.stripeSubscriptionId,
      stripeCustomerId: users.stripeCustomerId,
      mindbodyClientId: users.mindbodyClientId,
      hubspotId: users.hubspotId,
      role: users.role,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`)
      .limit(1);
    
    const hasDbUser = dbUser.length > 0;
    const isVisitorUser = hasDbUser && dbUser[0].role === 'visitor';
    const isStripeBilled = hasDbUser && (dbUser[0].stripeSubscriptionId || dbUser[0].stripeCustomerId);
    
    // For Stripe-billed members: verify with Stripe and auto-correct status if needed
    if (hasDbUser && isStripeBilled && !isStaffOrAdmin) {
      let dbMemberStatus = (dbUser[0].membershipStatus || '').toLowerCase();
      const activeStatuses = ['active', 'trialing', 'past_due'];
      
      // If database status doesn't match active statuses, verify with Stripe directly
      if (!activeStatuses.includes(dbMemberStatus) && dbUser[0].stripeSubscriptionId) {
        try {
          const { getStripeClient } = await import('../core/stripe/client');
          const stripe = await getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(dbUser[0].stripeSubscriptionId);
          
          const stripeActiveStatuses = ['active', 'trialing', 'past_due'];
          if (stripeActiveStatuses.includes(subscription.status)) {
            // Auto-fix the database - subscription is actually active
            await db.update(users).set({ membershipStatus: subscription.status, updatedAt: new Date() }).where(eq(users.id, dbUser[0].id));
            logger.info('[Auth] Auto-fixed membership_status for : ->', { extra: { normalizedEmail, dbMemberStatus, subscriptionStatus: subscription.status } });
            dbMemberStatus = subscription.status; // Update for session
            
            // Sync corrected status to HubSpot
            try {
              const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
              await syncMemberToHubSpot({ email: normalizedEmail, status: subscription.status, billingProvider: 'stripe' });
              logger.info('[Auth] Synced auto-fixed status to HubSpot for', { extra: { normalizedEmail } });
            } catch (hubspotError: unknown) {
              logger.error('[Auth] HubSpot sync failed for auto-fix', { error: hubspotError instanceof Error ? hubspotError : new Error(getErrorMessage(hubspotError)) });
            }
          } else {
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        } catch (stripeError: unknown) {
          logger.error('[Auth] Failed to verify Stripe subscription', { error: stripeError instanceof Error ? stripeError : new Error(getErrorMessage(stripeError)), extra: { email: normalizedEmail } });
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      } else if (!activeStatuses.includes(dbMemberStatus)) {
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
      
      // Return member data from database
      const statusMap: { [key: string]: string } = {
        'active': 'Active',
        'trialing': 'Trialing',
        'past_due': 'Past Due',
        'suspended': 'Suspended',
        'terminated': 'Terminated',
        'expired': 'Expired',
        'cancelled': 'Cancelled',
        'frozen': 'Frozen',
        'paused': 'Paused',
        'pending': 'Pending'
      };
      let memberFirstName = dbUser[0].firstName || '';
      let memberLastName = dbUser[0].lastName || '';

      if (!memberFirstName) {
        try {
          const hubspotClient = await getHubSpotClient();
          const hsSearch = await hubspotClient.crm.contacts.searchApi.doSearch({
            filterGroups: [{ filters: [{ propertyName: 'email', operator: FilterOperatorEnum.Eq, value: normalizedEmail }] }],
            properties: ['firstname', 'lastname'],
            limit: 1
          });
          const hsContact = hsSearch.results[0];
          if (hsContact?.properties?.firstname) {
            memberFirstName = hsContact.properties.firstname;
            memberLastName = memberLastName || hsContact.properties.lastname || '';
            await db.update(users).set({
              firstName: memberFirstName,
              lastName: memberLastName || undefined,
              updatedAt: new Date()
            }).where(eq(users.id, dbUser[0].id));
          }
        } catch (hsErr: unknown) {
          logger.warn('[Auth] HubSpot name backfill failed during verify-member', { error: hsErr instanceof Error ? hsErr : new Error(String(hsErr)) });
        }
      }

      const member = {
        id: dbUser[0].id,
        firstName: memberFirstName,
        lastName: memberLastName,
        email: dbUser[0].email || normalizedEmail,
        phone: dbUser[0].phone || '',
        jobTitle: '',
        tier: isVisitorUser ? null : normalizeTierName(dbUser[0].tier),
        tags: dbUser[0].tags || [],
        mindbodyClientId: dbUser[0].mindbodyClientId || '',
        status: statusMap[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
        role: (isVisitorUser ? 'visitor' : 'member') as 'member' | 'visitor'
      };
      
      return res.json({ success: true, member });
    }
    
    // For Mindbody legacy members or unknown users: check HubSpot
    const hubspot = await getHubSpotClient();
    
    const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: FilterOperatorEnum.Eq,
          value: normalizedEmail
        }]
      }],
      properties: [
        'firstname',
        'lastname',
        'email',
        'phone',
        'membership_tier',
        'membership_status',
        'membership_discount_reason',
        'mindbody_client_id'
      ],
      limit: 1
    }));
    
    const contact = searchResponse.results[0];
    
    // Staff/admin users can log in even without a HubSpot contact
    // Stripe-billed members can log in without HubSpot (database is source of truth)
    // Legacy Mindbody members MUST have HubSpot contact for status verification
    if (!contact && !isStaffOrAdmin) {
      // Stripe-billed members don't need HubSpot
      if (!isStripeBilled) {
        return res.status(404).json({ error: 'No member found with this email address' });
      }
    }
    
    // For non-Stripe (Mindbody legacy) users: HubSpot is source of truth for membership status
    // Include trialing and past_due as active - they still have membership access
    if (!isStaffOrAdmin && !isStripeBilled && contact) {
      const status = (contact.properties.membership_status || '').toLowerCase();
      const activeStatuses = ['active', 'trialing', 'past_due'];
      if (!activeStatuses.includes(status) && status !== '') {
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
    }
    
    const role = isStaffOrAdmin ? staffUserData!.role : (isVisitorUser ? 'visitor' : 'member');

    // Prefer database data, fall back to HubSpot
    let firstName = dbUser[0]?.firstName || contact?.properties?.firstname || '';
    let lastName = dbUser[0]?.lastName || contact?.properties?.lastname || '';
    let phone = dbUser[0]?.phone || contact?.properties?.phone || '';
    let jobTitle = '';

    if (hasDbUser && !dbUser[0]?.firstName && firstName) {
      try {
        await db.update(users).set({
          firstName: firstName,
          lastName: lastName || undefined,
          updatedAt: new Date()
        }).where(eq(users.id, dbUser[0].id));
      } catch (backfillErr: unknown) {
        logger.warn('[Auth] Name backfill from HubSpot failed during verify-member', { error: backfillErr instanceof Error ? backfillErr : new Error(String(backfillErr)) });
      }
    }

    // Use staff user data if available (overrides other data for staff/admin)
    if (isStaffOrAdmin && staffUserData) {
      firstName = staffUserData.firstName || firstName;
      lastName = staffUserData.lastName || lastName;
      phone = staffUserData.phone || phone;
      jobTitle = staffUserData.jobTitle || '';
    }

    const memberId = dbUser[0]?.id 
      || contact?.id 
      || (isStaffOrAdmin && staffUserData ? `staff-${staffUserData.id}` : crypto.randomUUID());
    
    const statusMap: { [key: string]: string } = {
      'active': 'Active',
      'trialing': 'Trialing',
      'past_due': 'Past Due',
      'suspended': 'Suspended',
      'terminated': 'Terminated',
      'expired': 'Expired',
      'cancelled': 'Cancelled',
      'frozen': 'Frozen',
      'paused': 'Paused',
      'pending': 'Pending'
    };
    const memberStatusStr = isStaffOrAdmin ? 'active' : ((dbUser[0]?.membershipStatus || contact?.properties?.membership_status || '').toLowerCase());
    
    const member = {
      id: memberId,
      firstName,
      lastName,
      email: dbUser[0]?.email || contact?.properties?.email || normalizedEmail,
      phone,
      jobTitle,
      tier: isVisitorUser ? null : (isStaffOrAdmin ? 'VIP' : normalizeTierName(dbUser[0]?.tier || contact?.properties?.membership_tier)),
      tags: dbUser[0]?.tags || [],
      mindbodyClientId: dbUser[0]?.mindbodyClientId || contact?.properties?.mindbody_client_id || '',
      status: statusMap[memberStatusStr] || (memberStatusStr ? memberStatusStr.charAt(0).toUpperCase() + memberStatusStr.slice(1) : 'Active'),
      role
    };
    
    res.json({ success: true, member });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Member verification error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to verify membership' });
  }
});


router.post('/api/auth/request-otp', ...authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    
    const rateCheck = await checkOtpRequestLimit(normalizedEmail, clientIp);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many code requests. Please try again in ${Math.ceil((rateCheck.retryAfter || 0) / 60)} minutes.` 
      });
    }
    
    const isStaffOrAdmin = await isStaffOrAdminEmail(normalizedEmail);
    
    // Check database first for Stripe-billed members
    const dbUser = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    const hasDbUser = dbUser.length > 0;
    const isStripeBilled = hasDbUser && (dbUser[0].stripeSubscriptionId || dbUser[0].stripeCustomerId);
    
    let firstName = isStaffOrAdmin ? 'Team Member' : 'Member';
    
    // For Stripe-billed members: verify with Stripe and auto-correct status if needed
    if (hasDbUser && isStripeBilled && !isStaffOrAdmin) {
      const dbMemberStatus = (dbUser[0].membershipStatus || '').toLowerCase();
      const activeStatuses = ['active', 'trialing', 'past_due'];
      
      // If database status doesn't match active statuses, verify with Stripe directly
      if (!activeStatuses.includes(dbMemberStatus) && dbUser[0].stripeSubscriptionId) {
        try {
          const { getStripeClient } = await import('../core/stripe/client');
          const stripe = await getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(dbUser[0].stripeSubscriptionId);
          
          // Map Stripe status to our status
          const stripeActiveStatuses = ['active', 'trialing', 'past_due'];
          if (stripeActiveStatuses.includes(subscription.status)) {
            // Auto-fix the database - subscription is actually active
            await db.update(users).set({ membershipStatus: subscription.status, updatedAt: new Date() }).where(eq(users.id, dbUser[0].id));
            logger.info('[Auth] Auto-fixed membership_status for : ->', { extra: { normalizedEmail, dbMemberStatus, subscriptionStatus: subscription.status } });
            
            // Sync corrected status to HubSpot
            try {
              const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
              await syncMemberToHubSpot({ email: normalizedEmail, status: subscription.status, billingProvider: 'stripe' });
              logger.info('[Auth] Synced auto-fixed status to HubSpot for', { extra: { normalizedEmail } });
            } catch (hubspotError: unknown) {
              logger.error('[Auth] HubSpot sync failed for auto-fix', { extra: { hubspotError } });
            }
            // Continue with login - subscription is valid
          } else {
            // Subscription is genuinely not active in Stripe
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        } catch (stripeError: unknown) {
          logger.error('[Auth] Failed to verify Stripe subscription', { error: stripeError instanceof Error ? stripeError : new Error(getErrorMessage(stripeError)), extra: { email: normalizedEmail } });
          // If we can't verify with Stripe, fall back to database status
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      } else if (!activeStatuses.includes(dbMemberStatus)) {
        // No subscription ID to verify, status is not active
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
      
      firstName = dbUser[0].firstName || firstName;
      // Stripe-billed member is valid, continue to send OTP
    } else {
      // For non-Stripe members or unknown users: check HubSpot
      const hubspot = await getHubSpotClient();
      
      const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: normalizedEmail
          }]
        }],
        properties: ['firstname', 'lastname', 'email', 'membership_status', 'membership_start_date'],
        limit: 1
      }));
      
      const contact = searchResponse.results[0];
      
      if (!contact && !isStaffOrAdmin) {
        return res.status(404).json({ error: 'No member found with this email address' });
      }
      
      if (contact) {
        const status = (contact.properties.membership_status || '').toLowerCase();
        firstName = contact.properties.firstname || firstName;
        
        // Include trialing and past_due as active - they still have membership access
        const activeStatuses = ['active', 'trialing', 'past_due'];
        if (!activeStatuses.includes(status) && status !== '' && !isStaffOrAdmin) {
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      }
    }
    
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    await db.insert(magicLinks).values({
      email: normalizedEmail,
      token: code,
      expiresAt
    });
    
    // Send email synchronously to ensure delivery before responding
    const logoUrl = 'https://everclub.app/images/everclub-logo-dark.png';
    const startTime = Date.now();
    logger.info('[OTP Email] Starting send to ***', { extra: { normalizedEmailSubstring_0_5: normalizedEmail.substring(0, 5) } });
    
    try {
      const { client: resendClient, fromEmail } = await getResendClient();
      logger.info('[OTP Email] Resend client ready in ms', { extra: { DateNow_startTime: Date.now() - startTime } });
      const emailResult = await withResendRetry(() => resendClient.emails.send({
          from: fromEmail || 'Ever Club <noreply@everclub.app>',
          to: normalizedEmail,
          subject: 'Your Ever Club Login Code',
          html: getOtpEmailHtml({ firstName, code, logoUrl })
        }));
        
      logger.info('[OTP Email] Sent successfully in ms', { extra: { now_startTime: Date.now() - startTime, emailResult: emailResult.data?.id } });
      
      if (emailResult.error) {
        logger.error('[OTP Email] Resend API error', { extra: { emailResult_error: emailResult.error } });
        return res.status(500).json({ error: 'Failed to send login code. Please try again.' });
      }
      
      return res.json({ success: true, message: 'Login code sent to your email' });
    } catch (emailError: unknown) {
      logger.error('[OTP Email] Error sending email', { extra: { error: getErrorMessage(emailError) } });
      return res.status(500).json({ error: 'Failed to send login code. Please try again.' });
    }
  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    if (!isProduction) logger.error('OTP request error', { extra: { error: errorMsg } });
    
    if (errorMsg.includes('HubSpot') || errorMsg.includes('hubspot')) {
      return res.status(500).json({ error: 'Unable to verify membership. Please try again later.' });
    }
    if (errorMsg.includes('Resend') || errorMsg.includes('email')) {
      return res.status(500).json({ error: 'Unable to send email. Please try again later.' });
    }
    
    res.status(500).json({ error: 'Failed to send login code. Please try again.' });
  }
});

router.post('/api/auth/verify-otp', ...authRateLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }
    
    let normalizedEmail = normalizeEmail(email);
    const normalizedCode = code.toString().trim();
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    
    const attemptCheck = await checkOtpVerifyAttempts(normalizedEmail, clientIp);
    if (!attemptCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many failed attempts. Please try again in ${Math.ceil((attemptCheck.retryAfter || 0) / 60)} minutes.` 
      });
    }
    
    const atomicResult = await db.execute(sql`WITH latest_token AS (
        SELECT id FROM magic_links
        WHERE email = ${normalizedEmail}
        AND token = ${normalizedCode}
        AND used = false
        AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      )
      UPDATE magic_links
      SET used = true
      WHERE id = (SELECT id FROM latest_token)
      RETURNING *`);
    
    if (atomicResult.rows.length === 0) {
      await recordOtpVerifyFailure(normalizedEmail, clientIp);
      return res.status(400).json({ 
        error: 'Invalid or expired code. Please try again or request a new code.'
      });
    }
    
    await clearOtpVerifyAttempts(normalizedEmail, clientIp);
    
    const _otpRecord = atomicResult.rows[0];
    
    const role = await getUserRole(normalizedEmail);
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    
    let member: SessionUser | undefined;
    let shouldSetupPassword = false;
    
    if (role === 'admin' || role === 'staff') {
      const staffUserData = await getStaffUserByEmail(normalizedEmail);
      
      if (!staffUserData) {
        return res.status(404).json({ error: 'Staff user not found' });
      }
      
      const pwCheck = await db.select({ passwordHash: staffUsers.passwordHash })
        .from(staffUsers)
        .where(and(
          sql`LOWER(${staffUsers.email}) = LOWER(${normalizedEmail})`,
          eq(staffUsers.isActive, true)
        ))
        .limit(1);
      
      shouldSetupPassword = pwCheck.length > 0 && !pwCheck[0].passwordHash;
      
      member = {
        id: `staff-${staffUserData.id}`,
        firstName: staffUserData.firstName,
        lastName: staffUserData.lastName,
        email: normalizedEmail,
        phone: staffUserData.phone,
        tier: 'VIP',
        tags: [],
        mindbodyClientId: '',
        status: 'Active',
        role,
        expires_at: Date.now() + sessionTtl
      };
    } else {
      // HYBRID APPROACH: Check database first for Stripe-billed members
      // Fall back to HubSpot only for Mindbody legacy members
      const { resolveUserByEmail } = await import('../core/stripe/customers');
      const resolvedLogin = await resolveUserByEmail(normalizedEmail);
      if (resolvedLogin && resolvedLogin.matchType !== 'direct') {
        logger.info('[Auth] Login email resolved to existing user via', { extra: { normalizedEmail, resolvedLoginPrimaryEmail: resolvedLogin.primaryEmail, resolvedLoginMatchType: resolvedLogin.matchType } });
        normalizedEmail = resolvedLogin.primaryEmail.toLowerCase();
      }

      const dbUser = await db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        phone: users.phone,
        tier: users.tier,
        tags: users.tags,
        membershipStatus: users.membershipStatus,
        stripeSubscriptionId: users.stripeSubscriptionId,
        stripeCustomerId: users.stripeCustomerId,
        mindbodyClientId: users.mindbodyClientId,
        joinDate: users.joinDate,
        dateOfBirth: users.dateOfBirth,
      })
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`)
        .limit(1);
      
      const hasDbUser = dbUser.length > 0;
      const isStripeBilled = hasDbUser && (dbUser[0].stripeSubscriptionId || dbUser[0].stripeCustomerId);
      
      // For Stripe-billed members: use database as source of truth
      if (hasDbUser && isStripeBilled) {
        const dbMemberStatus = (dbUser[0].membershipStatus || '').toLowerCase();
        const activeStatuses = ['active', 'trialing', 'past_due'];
        
        if (!activeStatuses.includes(dbMemberStatus)) {
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
        
        const statusMap: { [key: string]: string } = {
          'active': 'Active',
          'trialing': 'Trialing',
          'past_due': 'Past Due',
          'suspended': 'Suspended',
          'terminated': 'Terminated',
          'expired': 'Expired',
          'cancelled': 'Cancelled',
          'frozen': 'Frozen',
          'paused': 'Paused',
          'pending': 'Pending'
        };
        member = {
          id: dbUser[0].id,
          firstName: dbUser[0].firstName || '',
          lastName: dbUser[0].lastName || '',
          email: dbUser[0].email || normalizedEmail,
          phone: dbUser[0].phone || '',
          tier: role === 'visitor' ? undefined : normalizeTierName(dbUser[0].tier) || undefined,
          tags: (dbUser[0].tags || []) as string[],
          mindbodyClientId: dbUser[0].mindbodyClientId || '',
          status: statusMap[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
          role,
          expires_at: Date.now() + sessionTtl,
          dateOfBirth: dbUser[0].dateOfBirth || null
        };
      } else {
        // For Mindbody legacy members or unknown users: check HubSpot
        const hubspot = await getHubSpotClient();
        
        const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: FilterOperatorEnum.Eq,
              value: normalizedEmail
            }]
          }],
          properties: ['firstname', 'lastname', 'email', 'phone', 'membership_tier', 'membership_status', 'membership_discount_reason', 'mindbody_client_id', 'membership_start_date', 'date_of_birth'],
          limit: 1
        }));
        
        const contact = searchResponse.results[0];
        
        // Stripe-billed members can log in without HubSpot (database is source of truth)
        // Legacy Mindbody members MUST have HubSpot contact for status verification
        if (!contact) {
          if (!isStripeBilled) {
            return res.status(404).json({ error: 'Member not found' });
          }
        }
        
        // For non-Stripe (Mindbody legacy) members: HubSpot is source of truth
        // Include trialing and past_due as active - they still have membership access
        if (!isStripeBilled && contact) {
          const hubspotStatus = (contact.properties.membership_status || '').toLowerCase();
          const activeStatuses = ['active', 'trialing', 'past_due'];
          if (!activeStatuses.includes(hubspotStatus) && hubspotStatus !== '') {
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        }
        
        // Prefer database data, fall back to HubSpot
        const tags = hasDbUser ? (dbUser[0].tags || []) : [];
        
        const statusMap: { [key: string]: string } = {
          'active': 'Active',
          'trialing': 'Trialing',
          'past_due': 'Past Due',
          'suspended': 'Suspended',
          'terminated': 'Terminated',
          'expired': 'Expired',
          'cancelled': 'Cancelled',
          'frozen': 'Frozen',
          'paused': 'Paused',
          'pending': 'Pending'
        };
        const memberStatusStr = (hasDbUser ? dbUser[0].membershipStatus : contact?.properties?.membership_status || '' as string | null)?.toLowerCase() || '';
        
        member = {
          id: hasDbUser ? dbUser[0].id : (contact?.id || crypto.randomUUID()),
          firstName: (hasDbUser ? dbUser[0].firstName : contact?.properties?.firstname) || '',
          lastName: (hasDbUser ? dbUser[0].lastName : contact?.properties?.lastname) || '',
          email: (hasDbUser ? dbUser[0].email : contact?.properties?.email) || normalizedEmail,
          phone: (hasDbUser ? dbUser[0].phone : contact?.properties?.phone) || '',
          tier: role === 'visitor' ? undefined : normalizeTierName(hasDbUser ? dbUser[0].tier : contact?.properties?.membership_tier) || undefined,
          tags: tags as string[],
          mindbodyClientId: (hasDbUser ? dbUser[0].mindbodyClientId : contact?.properties?.mindbody_client_id) || '',
          status: statusMap[memberStatusStr] || (memberStatusStr ? memberStatusStr.charAt(0).toUpperCase() + memberStatusStr.slice(1) : 'Active'),
          role,
          expires_at: Date.now() + sessionTtl,
          dateOfBirth: (hasDbUser ? dbUser[0].dateOfBirth : contact?.properties?.date_of_birth) || null,
          membershipStartDate: (hasDbUser ? dbUser[0].joinDate : contact?.properties?.membership_start_date) || ''
        };
      }
    }
    
    if (!member) {
      return res.status(500).json({ error: 'Failed to resolve member identity' });
    }

    req.session.user = member;

    const supabaseToken = await createSupabaseToken(member as unknown as { id: string; email: string; role: string; firstName?: string; lastName?: string });
    
    const dbUserId = await upsertUserWithTier({
      email: member.email,
      tierName: member.tier ?? '',
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone,
      mindbodyClientId: member.mindbodyClientId,
      tags: member.tags || [],
      membershipStartDate: member.membershipStartDate || '',
      role
    });
    
    if (dbUserId && dbUserId !== member.id) {
      member.id = dbUserId;
      req.session.user = member;
    }
    
    // Track first login for onboarding (async, non-blocking)
    db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${member.email}) AND first_login_at IS NULL`).catch((err) => logger.warn('[Auth] Non-critical first_login_at update failed:', err));

    // Send welcome email on first login (async, non-blocking, atomic claim)
    (async () => {
      try {
        if (member.role === 'member') {
          const claimed = await db.execute(sql`
            UPDATE users
            SET welcome_email_sent = true, welcome_email_sent_at = NOW(), updated_at = NOW()
            WHERE LOWER(email) = LOWER(${member.email})
              AND (welcome_email_sent IS NULL OR welcome_email_sent = false)
            RETURNING id
          `);
          if (claimed.rows.length > 0) {
            const result = await sendWelcomeEmail(member.email, member.firstName);
            if (!result.success) {
              await db.execute(sql`
                UPDATE users SET welcome_email_sent = false, welcome_email_sent_at = NULL, updated_at = NOW()
                WHERE LOWER(email) = LOWER(${member.email})
              `);
              logger.warn('[Welcome Email] Send failed, reset flag for retry', { email: member.email });
            }
          }
        }
      } catch (error: unknown) {
        logger.error('[Welcome Email] Error checking/sending', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
      }
    })().catch(err => logger.error('[Welcome Email] Unhandled async error', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
    
    req.session.save((err) => {
      if (err) {
        if (!isProduction) logger.error('Session save error', { extra: { err } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, shouldSetupPassword, supabaseToken });
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('OTP verification error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      if (!isProduction) logger.error('Session destroy error', { extra: { err } });
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

router.get('/api/auth/session', async (req, res) => {
  const sessionUser = getSessionUser(req);
  
  if (!sessionUser?.email) {
    return res.status(401).json({ error: 'No active session', authenticated: false });
  }
  
  if (sessionUser.expires_at && Date.now() > sessionUser.expires_at) {
    return res.status(401).json({ error: 'Session expired', authenticated: false });
  }
  
  const freshRole = await getUserRole(sessionUser.email);
  let sessionDirty = false;
  if (freshRole !== sessionUser.role) {
    sessionUser.role = freshRole;
    sessionDirty = true;
  }

  let lifetimeVisits = 0;
  let freshStatus = sessionUser.status || 'Active';
  try {
    const userResult = await db.execute(
      sql`SELECT lifetime_visits, membership_status FROM users WHERE LOWER(email) = LOWER(${sessionUser.email}) LIMIT 1`
    );
    const rows = userResult.rows as Record<string, unknown>[];
    if (rows.length > 0) {
      if (rows[0].lifetime_visits != null) {
        lifetimeVisits = Number(rows[0].lifetime_visits);
      }
      if (rows[0].membership_status != null) {
        const dbStatusStr = String(rows[0].membership_status).toLowerCase();
        const statusMap: { [key: string]: string } = {
          'active': 'Active',
          'trialing': 'Trialing',
          'past_due': 'Past Due',
          'suspended': 'Suspended',
          'terminated': 'Terminated',
          'expired': 'Expired',
          'cancelled': 'Cancelled',
          'frozen': 'Frozen',
          'paused': 'Paused',
          'pending': 'Pending'
        };
        freshStatus = statusMap[dbStatusStr] || (dbStatusStr ? dbStatusStr.charAt(0).toUpperCase() + dbStatusStr.slice(1) : 'Active');
        if (freshStatus !== sessionUser.status) {
          sessionUser.status = freshStatus;
          sessionDirty = true;
        }
      }
    }
  } catch {
    logger.debug('[Auth] Failed to fetch user data for session enrichment');
  }

  if (sessionDirty) {
    req.session.save((err) => {
      if (err) logger.warn('[Auth] Failed to persist session update', { error: err });
    });
  }

  res.json({
    authenticated: true,
    member: {
      id: sessionUser.id,
      firstName: sessionUser.firstName || '',
      lastName: sessionUser.lastName || '',
      email: sessionUser.email,
      phone: sessionUser.phone || '',
      tier: sessionUser.role === 'visitor' ? null : (sessionUser.tier || 'Social'),
      tags: sessionUser.tags || [],
      mindbodyClientId: sessionUser.mindbodyClientId || '',
      status: freshStatus,
      role: freshRole,
      dateOfBirth: sessionUser.dateOfBirth || null,
      lifetimeVisits
    }
  });
});

router.get('/api/auth/check-staff-admin', authRateLimiterByIp, async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    
    const staffResult = await db.select({
      id: staffUsers.id,
      role: staffUsers.role,
      hasPassword: isNotNull(staffUsers.passwordHash)
    })
      .from(staffUsers)
      .where(and(
        eq(staffUsers.email, normalizedEmail),
        eq(staffUsers.isActive, true)
      ));
    
    if (staffResult.length > 0) {
      const userRole = staffResult[0].role === 'admin' ? 'admin' : 'staff';
      return res.json({ 
        isStaffOrAdmin: true, 
        role: userRole,
        hasPassword: staffResult[0].hasPassword 
      });
    }
    
    res.json({ isStaffOrAdmin: false, role: null, hasPassword: false });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Check staff/admin error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check user status' });
  }
});

router.post('/api/auth/password-login', ...authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    
    let userRecord: { id: number; email: string; name: string | null; passwordHash: string | null; role: string | null } | null = null;
    let userRole: 'admin' | 'staff' | 'member' = 'member';
    
    const staffResult = await db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      name: staffUsers.name,
      passwordHash: staffUsers.passwordHash,
      role: staffUsers.role
    })
      .from(staffUsers)
      .where(and(
        eq(staffUsers.email, normalizedEmail),
        eq(staffUsers.isActive, true)
      ));
    
    if (staffResult.length > 0) {
      userRecord = staffResult[0];
      userRole = staffResult[0].role === 'admin' ? 'admin' : 'staff';
    }
    
    if (!userRecord) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    if (!userRecord.passwordHash) {
      return res.status(400).json({ error: 'Password not set. Please use magic link or contact an admin.' });
    }
    
    const isValid = await bcrypt.compare(password, userRecord.passwordHash);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const hubspot = await getHubSpotClient();
    let memberData = null;
    
    try {
      const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: normalizedEmail
          }]
        }],
        properties: ['firstname', 'lastname', 'email', 'phone', 'membership_tier', 'membership_status', 'membership_discount_reason', 'mindbody_client_id', 'membership_start_date', 'date_of_birth'],
        limit: 1
      }));
      
      if (searchResponse.results.length > 0) {
        const contact = searchResponse.results[0];
        memberData = {
          id: contact.id,
          firstName: contact.properties.firstname || userRecord.name?.split(' ')[0] || '',
          lastName: contact.properties.lastname || userRecord.name?.split(' ').slice(1).join(' ') || '',
          email: normalizedEmail,
          phone: contact.properties.phone || '',
          tier: normalizeTierName(contact.properties.membership_tier),
          tags: [],
          mindbodyClientId: contact.properties.mindbody_client_id || '',
          membershipStartDate: contact.properties.membership_start_date || '',
        };
      }
    } catch (hubspotError: unknown) {
      if (!isProduction) logger.error('HubSpot lookup failed', { error: hubspotError instanceof Error ? hubspotError : new Error(getErrorMessage(hubspotError)) });
    }
    
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    const member = {
      id: memberData?.id || userRecord.id.toString(),
      firstName: memberData?.firstName || userRecord.name?.split(' ')[0] || '',
      lastName: memberData?.lastName || userRecord.name?.split(' ').slice(1).join(' ') || '',
      email: normalizedEmail,
      phone: memberData?.phone || '',
      tier: userRole === 'member' ? (memberData?.tier || DEFAULT_TIER) : undefined,
      tags: memberData?.tags || [],
      mindbodyClientId: memberData?.mindbodyClientId || '',
      membershipStartDate: memberData?.membershipStartDate || '',
      status: 'Active',
      role: userRole,
      expires_at: Date.now() + sessionTtl
    };
    
    req.session.user = member;

    const supabaseToken = await createSupabaseToken(member);
    
    const dbUserId2 = await upsertUserWithTier({
      email: member.email,
      tierName: member.tier ?? '',
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone,
      mindbodyClientId: member.mindbodyClientId,
      tags: member.tags,
      membershipStartDate: member.membershipStartDate,
      role: userRole
    });
    
    if (dbUserId2 && dbUserId2 !== member.id) {
      member.id = dbUserId2;
      req.session.user = member;
    }
    
    // Track first login for onboarding (async, non-blocking)
    db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${member.email}) AND first_login_at IS NULL`).catch((err) => logger.warn('[Auth] Non-critical first_login_at update failed:', err));

    req.session.save((err) => {
      if (err) {
        if (!isProduction) logger.error('Session save error', { extra: { err } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, supabaseToken });
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Password login error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

router.post('/api/auth/set-password', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'You must be logged in to set a password' });
    }
    
    const { password, currentPassword } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const normalizedEmail = sessionUser.email.toLowerCase();
    
    const staffRecord = await db.select({ id: staffUsers.id, passwordHash: staffUsers.passwordHash })
      .from(staffUsers)
      .where(and(
        eq(staffUsers.email, normalizedEmail),
        eq(staffUsers.isActive, true)
      ))
      .limit(1);
    
    if (staffRecord.length > 0) {
      if (staffRecord[0].passwordHash) {
        if (!currentPassword) {
          return res.status(400).json({ error: 'Current password is required' });
        }
        const isValid = await bcrypt.compare(currentPassword, staffRecord[0].passwordHash);
        if (!isValid) {
          return res.status(400).json({ error: 'Current password is incorrect' });
        }
      }
      
      const passwordHash = await bcrypt.hash(password, 10);
      await db.update(staffUsers)
        .set({ passwordHash })
        .where(eq(staffUsers.id, staffRecord[0].id));
      
      return res.json({ success: true, message: 'Password set successfully' });
    }
    
    res.status(403).json({ error: 'Password can only be set for staff or admin accounts' });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Set password error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to set password' });
  }
});

router.post('/api/auth/dev-login', async (req, res) => {
  if (isProduction) {
    return res.status(403).json({ error: 'Dev login not available in production' });
  }
  
  if (process.env.DEV_LOGIN_ENABLED !== 'true') {
    return res.status(403).json({ error: 'Dev login not enabled' });
  }
  
  try {
    const devEmail = req.body.email || 'nick@evenhouse.club';
    
    const existingUser = await db.select()
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${devEmail})`);
    
    if (existingUser.length === 0) {
      return res.status(404).json({ error: 'Dev user not found' });
    }
    
    const user = existingUser[0];
    
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    const member = {
      id: user.id,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || devEmail,
      phone: user.phone || '',
      tier: user.tier || undefined,
      role: user.role || 'member',
      expires_at: Date.now() + sessionTtl
    };
    
    req.session.user = member as SessionUser;

    const supabaseToken = await createSupabaseToken({ ...member, email: member.email as string });
    
    // Track first login for onboarding (async, non-blocking)
    db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${member.email}) AND first_login_at IS NULL`).catch((err) => logger.warn('[Auth] Non-critical first_login_at update failed:', err));

    req.session.save((err) => {
      if (err) {
        if (!isProduction) logger.error('Session save error', { extra: { err } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, supabaseToken });
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Dev login error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Dev login failed' });
  }
});

// Test endpoint to send welcome email (admin only)
router.post('/api/auth/test-welcome-email', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser || sessionUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const { email, firstName } = req.body;
    const targetEmail = email || sessionUser.email;
    const targetFirstName = firstName || sessionUser.firstName;
    
    const result = await sendWelcomeEmail(targetEmail, targetFirstName);
    
    if (result.success) {
      res.json({ success: true, message: `Welcome email sent to ${targetEmail}` });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send welcome email' });
    }
  } catch (error: unknown) {
    logger.error('Test welcome email error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

export default router;

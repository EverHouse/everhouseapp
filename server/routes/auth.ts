import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { eq, and, sql, gt, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { users, magicLinks, staffUsers, membershipTiers } from '../../shared/schema';
import { isProduction, pool } from '../core/db';
import { getHubSpotClient } from '../core/integrations';
import { normalizeTierName, extractTierTags, DEFAULT_TIER } from '../../shared/constants/tiers';
import { getResendClient } from '../utils/resend';
import { triggerMemberSync } from '../core/memberSync';
import { withResendRetry } from '../core/retryUtils';
import { getSessionUser } from '../types/session';
import { sendWelcomeEmail } from '../emails/welcomeEmail';
import { getSupabaseAdmin, isSupabaseAvailable } from '../core/supabase/client';
import { normalizeEmail } from '../core/utils/emailNormalization';

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
  } catch (error) {
    if (!isProduction) console.error('Error fetching staff user:', error);
    return null;
  }
}

async function getUserRole(email: string): Promise<'admin' | 'staff' | 'member'> {
  const normalized = normalizeEmail(email);
  const staffUser = await getStaffUserByEmail(normalized);
  if (staffUser) {
    return staffUser.role;
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
  role?: 'admin' | 'staff' | 'member';
}

async function upsertUserWithTier(data: UpsertUserData): Promise<void> {
  try {
    const normalizedEmailValue = normalizeEmail(data.email);
    const isStaffOrAdmin = data.role === 'admin' || data.role === 'staff';
    
    // Staff/admin users don't have membership tiers
    const normalizedTier = isStaffOrAdmin ? null : normalizeTierName(data.tierName);
    let tierId: number | null = null;
    
    if (!isStaffOrAdmin && normalizedTier) {
      const tierResult = await db.select({ id: membershipTiers.id })
        .from(membershipTiers)
        .where(sql`LOWER(${membershipTiers.name}) = LOWER(${normalizedTier})`)
        .limit(1);
      tierId = tierResult.length > 0 ? tierResult[0].id : null;
    }
    
    await db.insert(users)
      .values({
        id: crypto.randomUUID(),
        email: normalizedEmailValue,
        firstName: data.firstName || null,
        lastName: data.lastName || null,
        tier: normalizedTier,
        tierId: tierId,
        phone: data.phone || null,
        mindbodyClientId: isStaffOrAdmin ? null : (data.mindbodyClientId || null),
        tags: isStaffOrAdmin ? [] : (data.tags && data.tags.length > 0 ? data.tags : []),
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
          tags: isStaffOrAdmin ? [] : (data.tags && data.tags.length > 0 ? data.tags : []),
          role: data.role || 'member',
          updatedAt: new Date()
        }
      });
    
    if (!isProduction) console.log(`[Auth] Updated user ${normalizedEmailValue} with role ${data.role}, tier ${normalizedTier || 'none'}`);
  } catch (error) {
    console.error('[Auth] Error upserting user tier:', error);
  }
}

async function createSupabaseToken(user: { id: string, email: string, role: string, firstName?: string, lastName?: string }): Promise<string | null> {
  try {
    // Check if Supabase is available before attempting to call it
    const available = await isSupabaseAvailable();
    if (!available) {
      // Silently skip - Supabase features disabled
      return null;
    }
    
    const supabase = getSupabaseAdmin();
    
    await supabase.auth.admin.createUser({
      email: user.email,
      email_confirm: true,
      user_metadata: {
        first_name: user.firstName,
        last_name: user.lastName,
        app_role: user.role,
      }
    }).catch(() => {});
    
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
      options: {
        data: {
          first_name: user.firstName,
          last_name: user.lastName,
          app_role: user.role,
        }
      }
    });

    if (linkError) {
      // Only log non-network errors
      if (!linkError.message?.includes('fetch failed') && !linkError.message?.includes('ENOTFOUND')) {
        console.error('[Supabase] generateLink error:', linkError);
      }
      return null;
    }
    
    if (linkData?.properties?.access_token) {
      return linkData.properties.access_token;
    }
    
    const hashedToken = linkData?.properties?.hashed_token;
    if (hashedToken) {
      const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
        token_hash: hashedToken,
        type: 'magiclink',
      });
      
      if (otpError) {
        if (!otpError.message?.includes('fetch failed') && !otpError.message?.includes('ENOTFOUND')) {
          console.error('[Supabase] verifyOtp error:', otpError);
        }
        return null;
      }
      
      if (otpData?.session?.access_token) {
        return otpData.session.access_token;
      }
    }
    
    return null;
  } catch (e: any) {
    // Suppress network-related errors since we already logged the availability status
    if (!e.message?.includes('fetch failed') && 
        !e.message?.includes('ENOTFOUND') && 
        !e.message?.includes('ECONNREFUSED')) {
      console.error('[Supabase] Failed to generate token:', e);
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

const checkOtpRequestLimit = async (email: string, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `otp_request:${email}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_REQUEST_WINDOW);
  
  try {
    const result = await pool.query(
      `INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES ($1, 'otp_request', 1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE 
           WHEN rate_limits.reset_at < NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_at = CASE 
           WHEN rate_limits.reset_at < NOW() THEN $2
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count, reset_at`,
      [key, resetAt]
    );
    
    const { count, reset_at } = result.rows[0];
    if (count > OTP_REQUEST_LIMIT) {
      const retryAfter = Math.ceil((new Date(reset_at).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    return { allowed: true };
  } catch (error) {
    // Fail-closed: deny requests when rate limiting is unavailable to prevent abuse
    console.error('[RateLimit] Database error, denying request for safety:', error);
    return { allowed: false, retryAfter: 60 };
  }
};

const checkMagicLinkRequestLimit = async (email: string, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `magic_link:${email}:${ip}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + MAGIC_LINK_REQUEST_WINDOW);
  
  try {
    const result = await pool.query(
      `INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES ($1, 'magic_link', 1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE 
           WHEN rate_limits.reset_at < NOW() THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_at = CASE 
           WHEN rate_limits.reset_at < NOW() THEN $2
           ELSE rate_limits.reset_at
         END,
         updated_at = NOW()
       RETURNING count, reset_at`,
      [key, resetAt]
    );
    
    const { count, reset_at } = result.rows[0];
    if (count > MAGIC_LINK_REQUEST_LIMIT) {
      const retryAfter = Math.ceil((new Date(reset_at).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    return { allowed: true };
  } catch (error) {
    // Fail-closed: deny requests when rate limiting is unavailable to prevent abuse
    console.error('[RateLimit] Database error, denying request for safety:', error);
    return { allowed: false, retryAfter: 60 };
  }
};

const checkOtpVerifyAttempts = async (email: string): Promise<{ allowed: boolean; retryAfter?: number }> => {
  const key = `otp_verify:${email}`;
  const now = new Date();
  
  try {
    const result = await pool.query(
      `SELECT count, locked_until FROM rate_limits WHERE key = $1`,
      [key]
    );
    
    if (result.rows.length === 0) {
      return { allowed: true };
    }
    
    const { locked_until } = result.rows[0];
    if (locked_until && new Date(locked_until) > now) {
      const retryAfter = Math.ceil((new Date(locked_until).getTime() - now.getTime()) / 1000);
      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }
    
    if (locked_until && new Date(locked_until) <= now) {
      await pool.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
    }
    
    return { allowed: true };
  } catch (error) {
    // Fail-closed: deny requests when rate limiting is unavailable to prevent abuse
    console.error('[RateLimit] Database error, denying request for safety:', error);
    return { allowed: false, retryAfter: 60 };
  }
};

const recordOtpVerifyFailure = async (email: string): Promise<void> => {
  const key = `otp_verify:${email}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_VERIFY_LOCKOUT);
  const lockedUntil = new Date(now.getTime() + OTP_VERIFY_LOCKOUT);
  
  try {
    const result = await pool.query(
      `INSERT INTO rate_limits (key, limit_type, count, reset_at, updated_at)
       VALUES ($1, 'otp_verify', 1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = rate_limits.count + 1,
         locked_until = CASE 
           WHEN rate_limits.count + 1 >= $3 THEN $4
           ELSE rate_limits.locked_until
         END,
         updated_at = NOW()
       RETURNING count`,
      [key, resetAt, OTP_VERIFY_MAX_ATTEMPTS, lockedUntil]
    );
  } catch (error) {
    console.error('[RateLimit] Database error recording failure:', error);
  }
};

const clearOtpVerifyAttempts = async (email: string): Promise<void> => {
  const key = `otp_verify:${email}`;
  try {
    await pool.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
  } catch (error) {
    console.error('[RateLimit] Database error clearing attempts:', error);
  }
};


router.post('/api/auth/verify-member', async (req, res) => {
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
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`)
      .limit(1);
    
    const hasDbUser = dbUser.length > 0;
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
            await pool.query(
              `UPDATE users SET membership_status = $1, updated_at = NOW() WHERE id = $2`,
              [subscription.status, dbUser[0].id]
            );
            console.log(`[Auth] Auto-fixed membership_status for ${normalizedEmail}: ${dbMemberStatus} -> ${subscription.status}`);
            dbMemberStatus = subscription.status; // Update for session
            
            // Sync corrected status to HubSpot
            try {
              const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
              await syncMemberToHubSpot({ email: normalizedEmail, status: subscription.status, billingProvider: 'stripe' });
              console.log(`[Auth] Synced auto-fixed status to HubSpot for ${normalizedEmail}`);
            } catch (hubspotError) {
              console.error('[Auth] HubSpot sync failed for auto-fix:', hubspotError);
            }
          } else {
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        } catch (stripeError: any) {
          console.error(`[Auth] Failed to verify Stripe subscription for ${normalizedEmail}:`, stripeError.message);
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      } else if (!activeStatuses.includes(dbMemberStatus)) {
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
      
      // Return member data from database
      const member = {
        id: dbUser[0].id,
        firstName: dbUser[0].firstName || '',
        lastName: dbUser[0].lastName || '',
        email: dbUser[0].email || normalizedEmail,
        phone: dbUser[0].phone || '',
        jobTitle: '',
        tier: normalizeTierName(dbUser[0].tier),
        tags: dbUser[0].tags || [],
        mindbodyClientId: dbUser[0].mindbodyClientId || '',
        status: 'Active',
        role: 'member' as const
      };
      
      return res.json({ success: true, member });
    }
    
    // For Mindbody legacy members or unknown users: check HubSpot
    const hubspot = await getHubSpotClient();
    
    const searchResponse = await hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ' as any,
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
    });
    
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
    
    const role = isStaffOrAdmin ? staffUserData!.role : 'member';

    // Prefer database data, fall back to HubSpot
    let firstName = dbUser[0]?.firstName || contact?.properties.firstname || '';
    let lastName = dbUser[0]?.lastName || contact?.properties.lastname || '';
    let phone = dbUser[0]?.phone || contact?.properties.phone || '';
    let jobTitle = '';

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
    
    const member = {
      id: memberId,
      firstName,
      lastName,
      email: dbUser[0]?.email || contact?.properties.email || normalizedEmail,
      phone,
      jobTitle,
      tier: isStaffOrAdmin ? null : normalizeTierName(dbUser[0]?.tier || contact?.properties.membership_tier),
      tags: isStaffOrAdmin ? [] : (dbUser[0]?.tags || extractTierTags(contact?.properties.membership_tier, contact?.properties.membership_discount_reason)),
      mindbodyClientId: dbUser[0]?.mindbodyClientId || contact?.properties.mindbody_client_id || '',
      status: 'Active',
      role
    };
    
    res.json({ success: true, member });
  } catch (error: any) {
    if (!isProduction) console.error('Member verification error:', error);
    res.status(500).json({ error: 'Failed to verify membership' });
  }
});


router.post('/api/auth/request-otp', async (req, res) => {
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
            await pool.query(
              `UPDATE users SET membership_status = $1, updated_at = NOW() WHERE id = $2`,
              [subscription.status, dbUser[0].id]
            );
            console.log(`[Auth] Auto-fixed membership_status for ${normalizedEmail}: ${dbMemberStatus} -> ${subscription.status}`);
            
            // Sync corrected status to HubSpot
            try {
              const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
              await syncMemberToHubSpot({ email: normalizedEmail, status: subscription.status, billingProvider: 'stripe' });
              console.log(`[Auth] Synced auto-fixed status to HubSpot for ${normalizedEmail}`);
            } catch (hubspotError) {
              console.error('[Auth] HubSpot sync failed for auto-fix:', hubspotError);
            }
            // Continue with login - subscription is valid
          } else {
            // Subscription is genuinely not active in Stripe
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        } catch (stripeError: any) {
          console.error(`[Auth] Failed to verify Stripe subscription for ${normalizedEmail}:`, stripeError.message);
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
      
      const searchResponse = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ' as any,
            value: normalizedEmail
          }]
        }],
        properties: ['firstname', 'lastname', 'email', 'membership_status', 'membership_start_date'],
        limit: 1
      });
      
      let contact = searchResponse.results[0];
      
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
    const logoUrl = 'https://everhouse.app/assets/logos/monogram-dark.webp';
    const startTime = Date.now();
    console.log(`[OTP Email] Starting send to ${normalizedEmail.substring(0, 5)}***`);
    
    try {
      const { client: resendClient, fromEmail } = await getResendClient();
      console.log(`[OTP Email] Resend client ready in ${Date.now() - startTime}ms`);
      const emailResult = await withResendRetry(() => resendClient.emails.send({
          from: fromEmail || 'Ever House Members Club <noreply@everhouse.app>',
          to: normalizedEmail,
          subject: 'Your Ever House Login Code',
          html: `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="margin: 0; padding: 0; background-color: #F2F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F2F2EC;">
                <tr>
                  <td align="center" style="padding: 40px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px rgba(41, 53, 21, 0.08);">
                      <tr>
                        <td style="padding: 48px 40px 32px 40px; text-align: center;">
                          <!--[if mso]>
                          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" style="height:72px;width:72px;v-text-anchor:middle;" arcsize="50%" fillcolor="#293515">
                            <w:anchorlock/>
                            <center style="color:#ffffff;font-size:28px;font-weight:600;font-family:Georgia,serif;">EH</center>
                          </v:roundrect>
                          <![endif]-->
                          <!--[if !mso]><!-->
                          <img src="${logoUrl}" alt="EH" width="72" height="72" style="display: block; margin: 0 auto 24px auto; border-radius: 50%; border: 0;">
                          <!--<![endif]-->
                          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 600; color: #293515; font-family: 'Georgia', serif;">Hi ${firstName},</h1>
                          <p style="margin: 0; font-size: 16px; color: #666666; line-height: 1.5;">
                            Enter this code in the Ever House app to sign in:
                          </p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 0 40px 12px 40px; text-align: center;">
                          <div style="background: linear-gradient(135deg, #293515 0%, #3d4f22 100%); padding: 24px 32px; border-radius: 12px; display: inline-block; cursor: pointer;">
                            <span style="font-size: 36px; font-weight: 700; letter-spacing: 10px; color: #ffffff; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; user-select: all;">${code}</span>
                          </div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 0 40px 8px 40px; text-align: center;">
                          <p style="margin: 0; font-size: 13px; color: #888888;">
                            Tap the code above to select, then copy
                          </p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 0 40px 40px 40px; text-align: center;">
                          <p style="margin: 0 0 24px 0; font-size: 14px; color: #888888;">
                            This code expires in <strong style="color: #293515;">15 minutes</strong>
                          </p>
                          <p style="margin: 0; font-size: 13px; color: #aaaaaa; line-height: 1.5;">
                            If you didn't request this code, you can safely ignore this email.
                          </p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 24px 40px; background-color: #f8f8f6; border-radius: 0 0 16px 16px; text-align: center;">
                          <p style="margin: 0; font-size: 12px; color: #999999;">
                            Ever House Members Club<br>
                            <span style="color: #CCB8E4;">Golf & Wellness</span>
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </body>
            </html>
          `
        }));
        
      console.log(`[OTP Email] Sent successfully in ${Date.now() - startTime}ms`, emailResult.data?.id);
      
      if (emailResult.error) {
        console.error('[OTP Email] Resend API error:', emailResult.error);
        return res.status(500).json({ error: 'Failed to send login code. Please try again.' });
      }
      
      return res.json({ success: true, message: 'Login code sent to your email' });
    } catch (emailError: any) {
      console.error('[OTP Email] Error sending email:', emailError?.message || emailError);
      return res.status(500).json({ error: 'Failed to send login code. Please try again.' });
    }
  } catch (error: any) {
    if (!isProduction) console.error('OTP request error:', error?.message || error);
    
    if (error?.message?.includes('HubSpot') || error?.message?.includes('hubspot')) {
      return res.status(500).json({ error: 'Unable to verify membership. Please try again later.' });
    }
    if (error?.message?.includes('Resend') || error?.message?.includes('email')) {
      return res.status(500).json({ error: 'Unable to send email. Please try again later.' });
    }
    
    res.status(500).json({ error: 'Failed to send login code. Please try again.' });
  }
});

router.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }
    
    let normalizedEmail = normalizeEmail(email);
    const normalizedCode = code.toString().trim();
    
    const attemptCheck = await checkOtpVerifyAttempts(normalizedEmail);
    if (!attemptCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many failed attempts. Please try again in ${Math.ceil((attemptCheck.retryAfter || 0) / 60)} minutes.` 
      });
    }
    
    // SECURITY FIX: Use atomic UPDATE with CTE to prevent OTP replay race condition
    // This preserves the "latest token" semantics while preventing concurrent requests
    // from both succeeding with the same code
    const atomicResult = await pool.query(
      `WITH latest_token AS (
        SELECT id FROM magic_links
        WHERE email = $1
        AND token = $2
        AND used = false
        AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE magic_links
      SET used = true
      WHERE id = (SELECT id FROM latest_token)
      RETURNING *`,
      [normalizedEmail, normalizedCode]
    );
    
    if (atomicResult.rows.length === 0) {
      await recordOtpVerifyFailure(normalizedEmail);
      return res.status(400).json({ 
        error: 'Invalid or expired code. Please try again or request a new code.'
      });
    }
    
    await clearOtpVerifyAttempts(normalizedEmail);
    
    const otpRecord = atomicResult.rows[0];
    
    const role = await getUserRole(normalizedEmail);
    const sessionTtl = 7 * 24 * 60 * 60 * 1000;
    
    let member: any;
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
        jobTitle: staffUserData.jobTitle,
        tier: null,
        tags: [],
        mindbodyClientId: '',
        membershipStartDate: '',
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
        console.log(`[Auth] Login email ${normalizedEmail} resolved to existing user ${resolvedLogin.primaryEmail} via ${resolvedLogin.matchType}`);
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
        const activeStatuses = ['active', 'trialing', 'past_due']; // past_due still has access while retrying payment
        
        if (!activeStatuses.includes(dbMemberStatus)) {
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
        
        member = {
          id: dbUser[0].id,
          firstName: dbUser[0].firstName || '',
          lastName: dbUser[0].lastName || '',
          email: dbUser[0].email || normalizedEmail,
          phone: dbUser[0].phone || '',
          tier: normalizeTierName(dbUser[0].tier),
          tags: dbUser[0].tags || [],
          mindbodyClientId: dbUser[0].mindbodyClientId || '',
          membershipStartDate: dbUser[0].joinDate ? new Date(dbUser[0].joinDate).toISOString().split('T')[0] : '',
          status: 'Active',
          role,
          expires_at: Date.now() + sessionTtl,
          dateOfBirth: dbUser[0].dateOfBirth || null
        };
      } else {
        // For Mindbody legacy members or unknown users: check HubSpot
        const hubspot = await getHubSpotClient();
        
        const searchResponse = await hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ' as any,
              value: normalizedEmail
            }]
          }],
          properties: ['firstname', 'lastname', 'email', 'phone', 'membership_tier', 'membership_status', 'membership_discount_reason', 'mindbody_client_id', 'membership_start_date', 'date_of_birth'],
          limit: 1
        });
        
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
        const tags = hasDbUser ? (dbUser[0].tags || []) : extractTierTags(contact?.properties.membership_tier, contact?.properties.membership_discount_reason);
        
        member = {
          id: hasDbUser ? dbUser[0].id : (contact?.id || crypto.randomUUID()),
          firstName: (hasDbUser ? dbUser[0].firstName : contact?.properties.firstname) || '',
          lastName: (hasDbUser ? dbUser[0].lastName : contact?.properties.lastname) || '',
          email: (hasDbUser ? dbUser[0].email : contact?.properties.email) || normalizedEmail,
          phone: (hasDbUser ? dbUser[0].phone : contact?.properties.phone) || '',
          tier: normalizeTierName(hasDbUser ? dbUser[0].tier : contact?.properties.membership_tier),
          tags,
          mindbodyClientId: (hasDbUser ? dbUser[0].mindbodyClientId : contact?.properties.mindbody_client_id) || '',
          membershipStartDate: (hasDbUser && dbUser[0].joinDate) 
            ? new Date(dbUser[0].joinDate).toISOString().split('T')[0] 
            : (contact?.properties.membership_start_date || ''),
          status: 'Active',
          role,
          expires_at: Date.now() + sessionTtl,
          dateOfBirth: (hasDbUser ? dbUser[0].dateOfBirth : contact?.properties.date_of_birth) || null
        };
      }
    }
    
    req.session.user = member;

    const supabaseToken = await createSupabaseToken(member);
    
    await upsertUserWithTier({
      email: member.email,
      tierName: member.tier || '',
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone,
      mindbodyClientId: member.mindbodyClientId,
      tags: member.tags || [],
      membershipStartDate: member.membershipStartDate,
      role
    });
    
    // Send welcome email on first login (async, non-blocking)
    (async () => {
      try {
        const [user] = await db.select({ welcomeEmailSent: users.welcomeEmailSent })
          .from(users)
          .where(sql`LOWER(${users.email}) = LOWER(${member.email})`)
          .limit(1);
        
        if (user && !user.welcomeEmailSent && member.role === 'member') {
          const result = await sendWelcomeEmail(member.email, member.firstName);
          if (result.success) {
            await db.update(users)
              .set({ welcomeEmailSent: true, welcomeEmailSentAt: new Date() })
              .where(sql`LOWER(${users.email}) = LOWER(${member.email})`);
          }
        }
      } catch (e) {
        console.error('[Welcome Email] Error checking/sending:', e);
      }
    })();
    
    req.session.save((err) => {
      if (err) {
        if (!isProduction) console.error('Session save error:', err);
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, shouldSetupPassword, supabaseToken });
    });
  } catch (error: any) {
    if (!isProduction) console.error('OTP verification error:', error);
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      if (!isProduction) console.error('Session destroy error:', err);
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

router.get('/api/auth/session', (req, res) => {
  const sessionUser = getSessionUser(req);
  
  if (!sessionUser?.email) {
    return res.status(401).json({ error: 'No active session', authenticated: false });
  }
  
  if (sessionUser.expires_at && Date.now() > sessionUser.expires_at) {
    return res.status(401).json({ error: 'Session expired', authenticated: false });
  }
  
  res.json({
    authenticated: true,
    member: {
      id: sessionUser.id,
      firstName: sessionUser.firstName || '',
      lastName: sessionUser.lastName || '',
      email: sessionUser.email,
      phone: sessionUser.phone || '',
      tier: sessionUser.tier || 'Social',
      tags: sessionUser.tags || [],
      mindbodyClientId: sessionUser.mindbodyClientId || '',
      status: sessionUser.status || 'Active',
      role: sessionUser.role || 'member',
      dateOfBirth: sessionUser.dateOfBirth || null
    }
  });
});

router.get('/api/auth/check-staff-admin', async (req, res) => {
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
  } catch (error: any) {
    if (!isProduction) console.error('Check staff/admin error:', error);
    res.status(500).json({ error: 'Failed to check user status' });
  }
});

router.post('/api/auth/password-login', async (req, res) => {
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
      const searchResponse = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ' as any,
            value: normalizedEmail
          }]
        }],
        properties: ['firstname', 'lastname', 'email', 'phone', 'membership_tier', 'membership_status', 'membership_discount_reason', 'mindbody_client_id', 'membership_start_date', 'date_of_birth'],
        limit: 1
      });
      
      if (searchResponse.results.length > 0) {
        const contact = searchResponse.results[0];
        memberData = {
          id: contact.id,
          firstName: contact.properties.firstname || userRecord.name?.split(' ')[0] || '',
          lastName: contact.properties.lastname || userRecord.name?.split(' ').slice(1).join(' ') || '',
          email: normalizedEmail,
          phone: contact.properties.phone || '',
          tier: normalizeTierName(contact.properties.membership_tier),
          tags: extractTierTags(contact.properties.membership_tier, contact.properties.membership_discount_reason),
          mindbodyClientId: contact.properties.mindbody_client_id || '',
          membershipStartDate: contact.properties.membership_start_date || '',
        };
      }
    } catch (hubspotError) {
      if (!isProduction) console.error('HubSpot lookup failed:', hubspotError);
    }
    
    const sessionTtl = 7 * 24 * 60 * 60 * 1000;
    const member = {
      id: memberData?.id || userRecord.id.toString(),
      firstName: memberData?.firstName || userRecord.name?.split(' ')[0] || '',
      lastName: memberData?.lastName || userRecord.name?.split(' ').slice(1).join(' ') || '',
      email: normalizedEmail,
      phone: memberData?.phone || '',
      tier: memberData?.tier || DEFAULT_TIER,
      tags: memberData?.tags || [],
      mindbodyClientId: memberData?.mindbodyClientId || '',
      membershipStartDate: memberData?.membershipStartDate || '',
      status: 'Active',
      role: userRole,
      expires_at: Date.now() + sessionTtl
    };
    
    req.session.user = member;

    const supabaseToken = await createSupabaseToken(member);
    
    await upsertUserWithTier({
      email: member.email,
      tierName: member.tier,
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone,
      mindbodyClientId: member.mindbodyClientId,
      tags: member.tags,
      membershipStartDate: member.membershipStartDate,
      role: userRole
    });
    
    req.session.save((err) => {
      if (err) {
        if (!isProduction) console.error('Session save error:', err);
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, supabaseToken });
    });
  } catch (error: any) {
    if (!isProduction) console.error('Password login error:', error);
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
  } catch (error: any) {
    if (!isProduction) console.error('Set password error:', error);
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
    
    const sessionTtl = 7 * 24 * 60 * 60 * 1000;
    const member = {
      id: user.id,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email,
      phone: user.phone || '',
      tier: user.tier || null,
      role: user.role || 'member',
      expires_at: Date.now() + sessionTtl
    };
    
    req.session.user = member;

    const supabaseToken = await createSupabaseToken(member);
    
    req.session.save((err) => {
      if (err) {
        if (!isProduction) console.error('Session save error:', err);
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, supabaseToken });
    });
  } catch (error: any) {
    if (!isProduction) console.error('Dev login error:', error);
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
  } catch (error: any) {
    console.error('Test welcome email error:', error);
    res.status(500).json({ error: error.message || 'Failed to send test email' });
  }
});

export default router;

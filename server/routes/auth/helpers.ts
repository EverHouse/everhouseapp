import { logger } from '../../core/logger';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, staffUsers, membershipTiers } from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { normalizeTierName } from '../../../shared/constants/tiers';
import { getSupabaseAdmin, isSupabaseAvailable } from '../../core/supabase/client';
import { normalizeEmail } from '../../core/utils/emailNormalization';
import { getErrorMessage } from '../../utils/errorUtils';
import crypto from 'crypto';

export interface StaffUserData {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  jobTitle: string;
  role: 'admin' | 'staff';
}

export function normalizeRole(role: string | null | undefined): 'admin' | 'staff' {
  if (!role) return 'staff';
  const normalized = role.toLowerCase().trim();
  return normalized === 'admin' ? 'admin' : 'staff';
}

export async function getStaffUserByEmail(email: string): Promise<StaffUserData | null> {
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
    logger.error('Error fetching staff user', { error: getErrorMessage(error) });
    return null;
  }
}

export async function getUserRole(email: string): Promise<'admin' | 'staff' | 'member' | 'visitor'> {
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

export async function isStaffOrAdminEmail(email: string): Promise<boolean> {
  const staffUser = await getStaffUserByEmail(email);
  return staffUser !== null;
}

export interface UpsertUserData {
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

export async function upsertUserWithTier(data: UpsertUserData): Promise<string | null> {
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
    
    const hasTierData = normalizedTier !== null;
    
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
          tier: hasTierData ? normalizedTier : sql`COALESCE(${users.tier}, NULL)`,
          tierId: hasTierData ? tierId : sql`COALESCE(${users.tierId}, NULL)`,
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
    logger.error('[Auth] Error upserting user tier', { error: getErrorMessage(error) });
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
      logger.error('[Supabase] Failed to generate token', { error: getErrorMessage(error) });
    }
    return null;
  }
}

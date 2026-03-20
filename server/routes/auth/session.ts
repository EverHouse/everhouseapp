import { logger } from '../../core/logger';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import { db } from '../../db';
import { users, staffUsers } from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { getHubSpotClient } from '../../core/integrations';
import { retryableHubSpotRequest } from '../../core/hubspot/request';
import { normalizeTierName } from '../../../shared/constants/tiers';
import { getSessionUser, SessionUser } from '../../types/session';
import { sendWelcomeEmail } from '../../emails/welcomeEmail';
import { normalizeEmail, getAlternateDomainEmail } from '../../core/utils/emailNormalization';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { getErrorMessage } from '../../utils/errorUtils';
import { authRateLimiterByIp } from '../../middleware/rateLimiting';
import {
  getStaffUserByEmail,
  getUserRole,
  upsertUserWithTier,
  createSupabaseToken,
} from './helpers';

export const sessionRouter = Router();

// PUBLIC ROUTE - destroy session (no auth check, harmless if called unauthenticated)
sessionRouter.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Session destroy error', { extra: { error: getErrorMessage(err) } });
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// PUBLIC ROUTE - get current session info (returns 401 if unauthenticated, no middleware required)
sessionRouter.get('/api/auth/session', async (req, res) => {
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
      tier: sessionUser.role === 'visitor' ? null : (sessionUser.tier || null),
      tags: sessionUser.tags || [],
      mindbodyClientId: sessionUser.mindbodyClientId || '',
      status: freshStatus,
      role: freshRole,
      dateOfBirth: sessionUser.dateOfBirth || null,
      lifetimeVisits
    }
  });
});

sessionRouter.post('/api/auth/ws-token', authRateLimiterByIp, async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const { createWsAuthToken } = await import('../../core/websocket');
    const token = createWsAuthToken(sessionUser.email, sessionUser.role || 'member');
    return res.json({ token });
  } catch (err) {
    logger.error('[Auth] Failed to create WS auth token', { error: getErrorMessage(err) });
    return res.status(500).json({ error: 'Failed to create token' });
  }
});

// PUBLIC ROUTE - check if email is staff/admin (public query endpoint, rate-limited)
sessionRouter.get('/api/auth/check-staff-admin', authRateLimiterByIp, async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    
    const alternateEmail = getAlternateDomainEmail(normalizedEmail);
    const emailsToCheck = alternateEmail ? [normalizedEmail, alternateEmail] : [normalizedEmail];
    const staffResult = await db.select({
      id: staffUsers.id,
      role: staffUsers.role,
      hasPassword: isNotNull(staffUsers.passwordHash)
    })
      .from(staffUsers)
      .where(and(
        sql`LOWER(${staffUsers.email}) IN (${sql.join(emailsToCheck.map(e => sql`LOWER(${e})`), sql`, `)})`,
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
    logger.error('Check staff/admin error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to check user status' });
  }
});

// PUBLIC ROUTE - login with email and password (no auth required)
sessionRouter.post('/api/auth/password-login', authRateLimiterByIp, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    
    let userRecord: { id: number; email: string; name: string | null; passwordHash: string | null; role: string | null } | null = null;
    let userRole: 'admin' | 'staff' | 'member' = 'member';
    
    const altEmailPw = getAlternateDomainEmail(normalizedEmail);
    const emailsToCheckPw = altEmailPw ? [normalizedEmail, altEmailPw] : [normalizedEmail];
    const staffResult = await db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      name: staffUsers.name,
      passwordHash: staffUsers.passwordHash,
      role: staffUsers.role
    })
      .from(staffUsers)
      .where(and(
        sql`LOWER(${staffUsers.email}) IN (${sql.join(emailsToCheckPw.map(e => sql`LOWER(${e})`), sql`, `)})`,
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
      logger.error('HubSpot lookup failed', { error: getErrorMessage(hubspotError) });
    }
    
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    const member = {
      id: memberData?.id || userRecord.id.toString(),
      firstName: memberData?.firstName || userRecord.name?.split(' ')[0] || '',
      lastName: memberData?.lastName || userRecord.name?.split(' ').slice(1).join(' ') || '',
      email: userRecord.email,
      phone: memberData?.phone || '',
      tier: userRole === 'member' ? (memberData?.tier || null) : undefined,
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
    
    db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${member.email}) AND first_login_at IS NULL`).catch((err) => logger.warn('[Auth] Non-critical first_login_at update failed:', { extra: { error: getErrorMessage(err) } }));

    req.session.save((err) => {
      if (err) {
        logger.error('Session save error', { extra: { error: getErrorMessage(err) } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, supabaseToken });
    });
  } catch (error: unknown) {
    logger.error('Password login error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

sessionRouter.post('/api/auth/set-password', authRateLimiterByIp, async (req, res) => {
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
    
    const altEmailSetPw = getAlternateDomainEmail(normalizedEmail);
    const emailsSetPw = altEmailSetPw ? [normalizedEmail, altEmailSetPw] : [normalizedEmail];
    const staffRecord = await db.select({ id: staffUsers.id, passwordHash: staffUsers.passwordHash })
      .from(staffUsers)
      .where(and(
        sql`LOWER(${staffUsers.email}) IN (${sql.join(emailsSetPw.map(e => sql`LOWER(${e})`), sql`, `)})`,
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
    logger.error('Set password error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// DEV ROUTE - bypass login for development (blocked in production)
sessionRouter.post('/api/auth/dev-login', async (req, res) => {
  if (isProduction) {
    return res.status(403).json({ error: 'Dev login not available in production' });
  }
  
  if (process.env.DEV_LOGIN_ENABLED !== 'true') {
    return res.status(403).json({ error: 'Dev login not enabled' });
  }
  
  try {
    const devEmail = req.body.email || 'nick@everclub.co';
    
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
    
    db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${member.email}) AND first_login_at IS NULL`).catch((err) => logger.warn('[Auth] Non-critical first_login_at update failed:', { extra: { error: getErrorMessage(err) } }));

    req.session.save((err) => {
      if (err) {
        logger.error('Session save error', { extra: { error: getErrorMessage(err) } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, supabaseToken });
    });
  } catch (error: unknown) {
    logger.error('Dev login error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Dev login failed' });
  }
});

// DEV ROUTE - send welcome email for testing (blocked in production, admin role required)
sessionRouter.post('/api/auth/test-welcome-email', async (req, res) => {
  if (isProduction) {
    return res.status(404).json({ error: 'Not found' });
  }
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
    logger.error('Test welcome email error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

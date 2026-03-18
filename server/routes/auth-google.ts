import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../../shared/models/auth-session';
import { normalizeTierName } from '../../shared/constants/tiers';
import { normalizeEmail } from '../core/utils/emailNormalization';
import { logMemberAction } from '../core/auditLog';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';
import { authRateLimiterByIp } from '../middleware/rateLimiting';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID) {
  logger.warn('GOOGLE_CLIENT_ID is not set — Google auth routes will return 503');
}

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function requireGoogleConfig(_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google authentication is not configured' });
  }
  next();
}

async function verifyGoogleToken(credential: string) {
  const ticket = await oauthClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error('Invalid Google token payload');
  }
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name || '',
    firstName: payload.given_name || '',
    lastName: payload.family_name || '',
  };
}

router.post('/api/auth/google/verify', requireGoogleConfig, authRateLimiterByIp, async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    const googleUser = await verifyGoogleToken(credential);

    const userSelectFields = {
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
      role: users.role,
      googleId: users.googleId,
    };

    let dbUser = await db.select(userSelectFields)
      .from(users)
      .where(sql`${users.googleId} = ${googleUser.sub} AND ${users.archivedAt} IS NULL`)
      .limit(1);

    if (dbUser.length === 0) {
      dbUser = await db.select(userSelectFields)
        .from(users)
        .where(sql`LOWER(${users.googleEmail}) = LOWER(${googleUser.email}) AND ${users.archivedAt} IS NULL`)
        .limit(1);
    }

    if (dbUser.length === 0) {
      const { resolveUserByEmail } = await import('../core/stripe/customers');
      const resolved = await resolveUserByEmail(googleUser.email);

      if (resolved) {
        const primaryEmail = normalizeEmail(resolved.primaryEmail);
        dbUser = await db.select(userSelectFields)
          .from(users)
          .where(sql`LOWER(${users.email}) = LOWER(${primaryEmail}) AND ${users.archivedAt} IS NULL`)
          .limit(1);
      }
    }

    if (dbUser.length === 0) {
      return res.status(404).json({ error: 'No membership found for this email. Please sign up or use the email associated with your membership.' });
    }

    const user = dbUser[0];

    const dbMemberStatus = (user.membershipStatus || '').toLowerCase();
    const rawRole = (user.role || 'member').toLowerCase();
    const role: 'admin' | 'staff' | 'member' | 'visitor' = rawRole === 'admin' || rawRole === 'staff' ? rawRole : (rawRole === 'visitor' ? 'visitor' : 'member');
    const activeStatuses = ['active', 'trialing', 'past_due'];

    if (role === 'member' && !activeStatuses.includes(dbMemberStatus)) {
      return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
    }

    const statusMap: { [key: string]: string } = {
      'active': 'Active', 'trialing': 'Trialing', 'past_due': 'Past Due',
      'suspended': 'Suspended', 'terminated': 'Terminated', 'expired': 'Expired',
      'cancelled': 'Cancelled', 'frozen': 'Frozen', 'paused': 'Paused', 'pending': 'Pending'
    };
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    const member = {
      id: user.id,
      firstName: user.firstName || googleUser.firstName || '',
      lastName: user.lastName || googleUser.lastName || '',
      email: user.email || googleUser.email,
      phone: user.phone || '',
      tier: role === 'visitor' ? null : normalizeTierName(user.tier),
      tags: user.tags || [],
      mindbodyClientId: user.mindbodyClientId || '',
      status: statusMap[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
      role,
      expires_at: Date.now() + sessionTtl,
      dateOfBirth: user.dateOfBirth || null,
    };

    req.session.user = member as unknown as typeof req.session.user;

    if (!user.googleId || user.googleId !== googleUser.sub) {
      const existingGoogleLink = await db.select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.googleId, googleUser.sub))
        .limit(1);

      if (existingGoogleLink.length > 0 && existingGoogleLink[0].id !== user.id) {
        logger.warn('[Google Auth] Google account already linked to another user, not auto-linking', { extra: { googleSub: googleUser.sub, existingEmail: existingGoogleLink[0].email, targetEmail: user.email } });
      } else {
        const updateData: Record<string, unknown> = {
            googleId: googleUser.sub,
            googleEmail: googleUser.email,
            googleLinkedAt: new Date(),
            updatedAt: new Date(),
        };
        if (!user.firstName && googleUser.firstName) updateData.firstName = googleUser.firstName;
        if (!user.lastName && googleUser.lastName) updateData.lastName = googleUser.lastName;
        const autoLinked = await db.update(users)
          .set(updateData)
          .where(eq(users.id, user.id))
          .returning({ id: users.id });
        if (autoLinked.length === 0) {
          logger.error('[Google Auth] Auto-link update affected 0 rows', { extra: { userId: user.id, userEmail: user.email, googleSub: googleUser.sub } });
        }
      }
    } else if (!user.firstName && googleUser.firstName) {
      const nameBackfill: Record<string, unknown> = { updatedAt: new Date() };
      nameBackfill.firstName = googleUser.firstName;
      if (!user.lastName && googleUser.lastName) nameBackfill.lastName = googleUser.lastName;
      await db.update(users).set(nameBackfill).where(eq(users.id, user.id));
    }

    req.session.save((err) => {
      if (err) {
        logger.error('[Google Auth] Session save error', { extra: { error: err } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member });
    });
  } catch (error: unknown) {
    logger.error('[Google Auth] Verify error', { error: error instanceof Error ? error : new Error(String(error)) });
    if (getErrorMessage(error)?.includes('Token used too late') || getErrorMessage(error)?.includes('Invalid token')) {
      return res.status(401).json({ error: 'Google sign-in expired. Please try again.' });
    }
    res.status(500).json({ error: 'Failed to verify Google sign-in' });
  }
});

router.post('/api/auth/google/callback', requireGoogleConfig, async (req, res) => {
  try {
    const credential = req.body?.credential;
    if (!credential) {
      return res.redirect('/login?error=missing_credential');
    }

    const googleUser = await verifyGoogleToken(credential);

    const userSelectFields = {
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
      role: users.role,
      googleId: users.googleId,
    };

    let dbUser = await db.select(userSelectFields)
      .from(users)
      .where(sql`${users.googleId} = ${googleUser.sub} AND ${users.archivedAt} IS NULL`)
      .limit(1);

    if (dbUser.length === 0) {
      dbUser = await db.select(userSelectFields)
        .from(users)
        .where(sql`LOWER(${users.googleEmail}) = LOWER(${googleUser.email}) AND ${users.archivedAt} IS NULL`)
        .limit(1);
    }

    if (dbUser.length === 0) {
      const { resolveUserByEmail } = await import('../core/stripe/customers');
      const resolved = await resolveUserByEmail(googleUser.email);

      if (resolved) {
        const primaryEmail = normalizeEmail(resolved.primaryEmail);
        dbUser = await db.select(userSelectFields)
          .from(users)
          .where(sql`LOWER(${users.email}) = LOWER(${primaryEmail}) AND ${users.archivedAt} IS NULL`)
          .limit(1);
      }
    }

    if (dbUser.length === 0) {
      return res.redirect('/login?error=no_membership');
    }

    const user = dbUser[0];
    const dbMemberStatus = (user.membershipStatus || '').toLowerCase();
    const rawRole2 = (user.role || 'member').toLowerCase();
    const role: 'admin' | 'staff' | 'member' | 'visitor' = rawRole2 === 'admin' || rawRole2 === 'staff' ? rawRole2 : (rawRole2 === 'visitor' ? 'visitor' : 'member');
    const activeStatuses = ['active', 'trialing', 'past_due'];

    if (role === 'member' && !activeStatuses.includes(dbMemberStatus)) {
      return res.redirect('/login?error=inactive_membership');
    }

    const statusMap2: { [key: string]: string } = {
      'active': 'Active', 'trialing': 'Trialing', 'past_due': 'Past Due',
      'suspended': 'Suspended', 'terminated': 'Terminated', 'expired': 'Expired',
      'cancelled': 'Cancelled', 'frozen': 'Frozen', 'paused': 'Paused', 'pending': 'Pending'
    };
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    const member = {
      id: user.id,
      firstName: user.firstName || googleUser.firstName || '',
      lastName: user.lastName || googleUser.lastName || '',
      email: user.email || googleUser.email,
      phone: user.phone || '',
      tier: role === 'visitor' ? null : normalizeTierName(user.tier),
      tags: user.tags || [],
      mindbodyClientId: user.mindbodyClientId || '',
      status: statusMap2[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
      role,
      expires_at: Date.now() + sessionTtl,
      dateOfBirth: user.dateOfBirth || null,
    };

    req.session.user = member as unknown as typeof req.session.user;

    if (!user.googleId || user.googleId !== googleUser.sub) {
      const existingGoogleLink = await db.select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.googleId, googleUser.sub))
        .limit(1);

      if (existingGoogleLink.length > 0 && existingGoogleLink[0].id !== user.id) {
        logger.warn('[Google Auth Callback] Google account already linked to another user, not auto-linking', { extra: { googleSub: googleUser.sub, existingEmail: existingGoogleLink[0].email, targetEmail: user.email } });
      } else {
        const updateData: Record<string, unknown> = {
            googleId: googleUser.sub,
            googleEmail: googleUser.email,
            googleLinkedAt: new Date(),
            updatedAt: new Date(),
        };
        if (!user.firstName && googleUser.firstName) updateData.firstName = googleUser.firstName;
        if (!user.lastName && googleUser.lastName) updateData.lastName = googleUser.lastName;
        const autoLinked = await db.update(users)
          .set(updateData)
          .where(eq(users.id, user.id))
          .returning({ id: users.id });
        if (autoLinked.length === 0) {
          logger.error('[Google Auth Callback] Auto-link update affected 0 rows', { extra: { userId: user.id, userEmail: user.email, googleSub: googleUser.sub } });
        }
      }
    } else if (!user.firstName && googleUser.firstName) {
      const nameBackfill: Record<string, unknown> = { updatedAt: new Date() };
      nameBackfill.firstName = googleUser.firstName;
      if (!user.lastName && googleUser.lastName) nameBackfill.lastName = googleUser.lastName;
      await db.update(users).set(nameBackfill).where(eq(users.id, user.id));
    }

    req.session.save((err) => {
      if (err) {
        logger.error('[Google Auth Callback] Session save error', { extra: { error: err } });
        return res.redirect('/login?error=session_failed');
      }
      const destination = (role === 'admin' || role === 'staff') ? '/admin' : '/dashboard';
      res.redirect(destination);
    });
  } catch (error: unknown) {
    logger.error('[Google Auth Callback] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.redirect('/login?error=google_failed');
  }
});

async function resolveDbUserId(sessionUser: { id?: string; email: string }): Promise<string | null> {
  let dbUser = await db.select({ id: users.id })
    .from(users)
    .where(sql`${users.id} = ${sessionUser.id!} AND ${users.archivedAt} IS NULL`)
    .limit(1);

  if (dbUser.length > 0) return dbUser[0].id;

  const normalizedEmail = normalizeEmail(sessionUser.email);
  dbUser = await db.select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail}) AND ${users.archivedAt} IS NULL`)
    .limit(1);

  if (dbUser.length > 0) {
    logger.info('[Google Auth] Resolved user by email fallback', { extra: { sessionId: sessionUser.id, dbId: dbUser[0].id, email: sessionUser.email } });
    return dbUser[0].id;
  }

  return null;
}

router.post('/api/auth/google/link', requireGoogleConfig, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id || !sessionUser?.email) {
      return res.status(401).json({ error: 'You must be logged in to link a Google account' });
    }

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    const googleUser = await verifyGoogleToken(credential);

    const dbUserId = await resolveDbUserId(sessionUser);
    if (!dbUserId) {
      logger.error('[Google Auth] Link: user not found by id or email', { extra: { sessionUserId: sessionUser.id, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    const existing = await db.select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.googleId, googleUser.sub))
      .limit(1);

    if (existing.length > 0 && existing[0].id !== dbUserId) {
      return res.status(409).json({ error: 'This Google account is already linked to a different member account.' });
    }

    const updated = await db.update(users)
      .set({
        googleId: googleUser.sub,
        googleEmail: googleUser.email,
        googleLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, dbUserId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      logger.error('[Google Auth] Link update affected 0 rows', { extra: { dbUserId, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    logMemberAction({
      memberEmail: sessionUser.email,
      memberName: `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim(),
      action: 'update_member',
      resourceType: 'user',
      resourceId: dbUserId,
      details: { action: 'google_link', googleEmail: googleUser.email },
      req,
    }).catch(err => logger.error('[Google Auth] Failed to log google_link action', { error: err instanceof Error ? err : new Error(String(err)) }));

    res.json({ success: true, googleEmail: googleUser.email });
  } catch (error: unknown) {
    const dbError = error as { code?: string };
    if (dbError.code === '23505') {
      return res.status(409).json({ error: 'This Google account is already linked to another member.' });
    }
    logger.error('[Google Auth] Link error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link Google account' });
  }
});

router.post('/api/auth/google/unlink', requireGoogleConfig, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id || !sessionUser?.email) {
      return res.status(401).json({ error: 'You must be logged in to unlink a Google account' });
    }

    const dbUserId = await resolveDbUserId(sessionUser);
    if (!dbUserId) {
      logger.error('[Google Auth] Unlink: user not found by id or email', { extra: { sessionUserId: sessionUser.id, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    const updated = await db.update(users)
      .set({
        googleId: null,
        googleEmail: null,
        googleLinkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, dbUserId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      logger.error('[Google Auth] Unlink update affected 0 rows', { extra: { dbUserId, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    logMemberAction({
      memberEmail: sessionUser.email,
      memberName: `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim(),
      action: 'update_member',
      resourceType: 'user',
      resourceId: dbUserId,
      details: { action: 'google_unlink' },
      req,
    }).catch(err => logger.error('[Google Auth] Failed to log google_unlink action', { error: err instanceof Error ? err : new Error(String(err)) }));

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Google Auth] Unlink error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to unlink Google account' });
  }
});

router.get('/api/auth/google/status', requireGoogleConfig, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) {
      return res.status(401).json({ error: 'You must be logged in to check Google link status' });
    }

    const dbUserId = await resolveDbUserId({ id: sessionUser.id, email: sessionUser.email || '' });

    const result = await db.select({
      googleId: users.googleId,
      googleEmail: users.googleEmail,
      googleLinkedAt: users.googleLinkedAt,
    })
      .from(users)
      .where(eq(users.id, dbUserId || sessionUser.id))
      .limit(1);

    if (result.length === 0) {
      return res.json({ linked: false, googleEmail: null, linkedAt: null });
    }

    const { googleId, googleEmail, googleLinkedAt } = result[0];
    res.json({
      linked: !!googleId,
      googleEmail: googleEmail || null,
      linkedAt: googleLinkedAt ? googleLinkedAt.toISOString() : null,
    });
  } catch (error: unknown) {
    logger.error('[Google Auth] Status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check Google link status' });
  }
});

export default router;

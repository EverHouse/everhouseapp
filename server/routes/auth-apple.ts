import { Router } from 'express';
import * as jose from 'jose';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../../shared/models/auth-session';
import { normalizeTierName } from '../../shared/constants/tiers';
import { normalizeEmail } from '../core/utils/emailNormalization';
import { logMemberAction } from '../core/auditLog';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';
import { authRateLimiterByIp } from '../middleware/rateLimiting';

const router = Router();

const APPLE_CLIENT_ID = process.env.APPLE_SERVICE_ID;

if (!APPLE_CLIENT_ID) {
  logger.warn('APPLE_SERVICE_ID is not set — Apple auth routes will return 503');
}

function requireAppleConfig(_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  if (!APPLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Apple authentication is not configured' });
  }
  next();
}

type JWKSFunction = ReturnType<typeof jose.createRemoteJWKSet>;
let applePublicKeys: JWKSFunction | null = null;
let appleKeysLastFetched = 0;
const APPLE_KEYS_TTL = 60 * 60 * 1000;

async function getApplePublicKeys(): Promise<JWKSFunction> {
  const now = Date.now();
  if (applePublicKeys && now - appleKeysLastFetched < APPLE_KEYS_TTL) {
    return applePublicKeys;
  }

  const JWKS = jose.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
  applePublicKeys = JWKS;
  appleKeysLastFetched = now;
  return JWKS;
}

async function verifyAppleToken(identityToken: string) {
  const keys = await getApplePublicKeys();

  const { payload } = await jose.jwtVerify(identityToken, keys, {
    issuer: 'https://appleid.apple.com',
    audience: APPLE_CLIENT_ID,
  });

  if (!payload.sub) {
    throw new Error('Invalid Apple token: missing subject');
  }

  const email = (payload.email as string | undefined)?.toLowerCase();

  return {
    sub: payload.sub,
    email: email || null,
    emailVerified: payload.email_verified as boolean | undefined,
    isPrivateEmail: (payload as Record<string, unknown>).is_private_email as boolean | undefined,
  };
}

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
  appleId: users.appleId,
};

// PUBLIC ROUTE - Apple Sign-In token verification (login flow, no auth required)
router.post('/api/auth/apple/verify', requireAppleConfig, authRateLimiterByIp, async (req, res) => {
  try {
    const { identityToken, user: appleUser } = req.body;
    if (!identityToken) {
      return res.status(400).json({ error: 'Apple identity token is required' });
    }

    const appleData = await verifyAppleToken(identityToken);

    let dbUser = await db.select(userSelectFields)
      .from(users)
      .where(sql`${users.appleId} = ${appleData.sub} AND ${users.archivedAt} IS NULL`)
      .limit(1);

    if (dbUser.length === 0 && appleData.email) {
      dbUser = await db.select(userSelectFields)
        .from(users)
        .where(sql`LOWER(${users.appleEmail}) = LOWER(${appleData.email}) AND ${users.archivedAt} IS NULL`)
        .limit(1);
    }

    if (dbUser.length === 0 && appleData.email) {
      const { resolveUserByEmail } = await import('../core/stripe/customers');
      const resolved = await resolveUserByEmail(appleData.email);

      if (resolved) {
        const primaryEmail = normalizeEmail(resolved.primaryEmail);
        dbUser = await db.select(userSelectFields)
          .from(users)
          .where(sql`LOWER(${users.email}) = LOWER(${primaryEmail}) AND ${users.archivedAt} IS NULL`)
          .limit(1);
      }
    }

    if (dbUser.length === 0 && appleData.email) {
      dbUser = await db.select(userSelectFields)
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${appleData.email}) AND ${users.archivedAt} IS NULL`)
        .limit(1);
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
      firstName: user.firstName || (appleUser?.name?.firstName) || '',
      lastName: user.lastName || (appleUser?.name?.lastName) || '',
      email: user.email || appleData.email,
      phone: user.phone || '',
      tier: role === 'visitor' ? null : (normalizeTierName(user.tier) || null),
      tags: user.tags || [],
      mindbodyClientId: user.mindbodyClientId || '',
      status: statusMap[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
      role,
      expires_at: Date.now() + sessionTtl,
      dateOfBirth: user.dateOfBirth || null,
    };

    req.session.user = member as unknown as typeof req.session.user;

    const appleFirstName = appleUser?.name?.firstName;
    const appleLastName = appleUser?.name?.lastName;

    if (!user.appleId || user.appleId !== appleData.sub) {
      const existingAppleLink = await db.select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.appleId, appleData.sub), isNull(users.archivedAt)))
        .limit(1);

      if (existingAppleLink.length > 0 && existingAppleLink[0].id !== user.id) {
        logger.warn('[Apple Auth] Apple account already linked to another user, not auto-linking', { extra: { appleSub: appleData.sub, existingEmail: existingAppleLink[0].email, targetEmail: user.email } });
      } else {
        const updateData: Record<string, unknown> = {
            appleId: appleData.sub,
            appleEmail: appleData.email || undefined,
            appleLinkedAt: new Date(),
            updatedAt: new Date(),
        };
        if (!user.firstName && appleFirstName) updateData.firstName = appleFirstName;
        if (!user.lastName && appleLastName) updateData.lastName = appleLastName;
        const autoLinked = await db.update(users)
          .set(updateData)
          .where(eq(users.id, user.id))
          .returning({ id: users.id });
        if (autoLinked.length === 0) {
          logger.error('[Apple Auth] Auto-link update affected 0 rows', { extra: { userId: user.id, userEmail: user.email, appleSub: appleData.sub } });
        }
      }
    } else if (!user.firstName && appleFirstName) {
      const nameBackfill: Record<string, unknown> = { updatedAt: new Date() };
      nameBackfill.firstName = appleFirstName;
      if (!user.lastName && appleLastName) nameBackfill.lastName = appleLastName;
      await db.update(users).set(nameBackfill).where(eq(users.id, user.id));
    }

    req.session.save((err) => {
      if (err) {
        logger.error('[Apple Auth] Session save error', { extra: { error: err } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member });
    });
  } catch (error: unknown) {
    logger.error('[Apple Auth] Verify error', { error: new Error(getErrorMessage(error)) });
    const msg = getErrorMessage(error);
    if (msg?.includes('expired') || msg?.includes('invalid')) {
      return res.status(401).json({ error: 'Apple sign-in expired. Please try again.' });
    }
    res.status(500).json({ error: 'Failed to verify Apple sign-in' });
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
    logger.info('[Apple Auth] Resolved user by email fallback', { extra: { sessionId: sessionUser.id, dbId: dbUser[0].id, email: sessionUser.email } });
    return dbUser[0].id;
  }

  return null;
}

router.post('/api/auth/apple/link', requireAppleConfig, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id || !sessionUser?.email) {
      return res.status(401).json({ error: 'You must be logged in to link an Apple account' });
    }

    const { identityToken } = req.body;
    if (!identityToken) {
      return res.status(400).json({ error: 'Apple identity token is required' });
    }

    const appleData = await verifyAppleToken(identityToken);

    const dbUserId = await resolveDbUserId(sessionUser);
    if (!dbUserId) {
      logger.error('[Apple Auth] Link: user not found by id or email', { extra: { sessionUserId: sessionUser.id, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    const existing = await db.select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.appleId, appleData.sub), isNull(users.archivedAt)))
      .limit(1);

    if (existing.length > 0 && existing[0].id !== dbUserId) {
      return res.status(409).json({ error: 'This Apple account is already linked to a different member account.' });
    }

    const updated = await db.update(users)
      .set({
        appleId: appleData.sub,
        appleEmail: appleData.email || undefined,
        appleLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, dbUserId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      logger.error('[Apple Auth] Link update affected 0 rows', { extra: { dbUserId, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    logMemberAction({
      memberEmail: sessionUser.email,
      memberName: `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim(),
      action: 'update_member',
      resourceType: 'user',
      resourceId: dbUserId,
      details: { action: 'apple_link', appleEmail: appleData.email },
      req,
    }).catch(err => logger.error('[Apple Auth] Failed to log apple_link action', { error: new Error(getErrorMessage(err)) }));

    res.json({ success: true, appleEmail: appleData.email });
  } catch (error: unknown) {
    const dbError = error as { code?: string };
    if (dbError.code === '23505') {
      return res.status(409).json({ error: 'This Apple account is already linked to another member.' });
    }
    logger.error('[Apple Auth] Link error', { error: new Error(getErrorMessage(error)) });
    res.status(500).json({ error: 'Failed to link Apple account' });
  }
});

router.post('/api/auth/apple/unlink', requireAppleConfig, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id || !sessionUser?.email) {
      return res.status(401).json({ error: 'You must be logged in to unlink an Apple account' });
    }

    const dbUserId = await resolveDbUserId(sessionUser);
    if (!dbUserId) {
      logger.error('[Apple Auth] Unlink: user not found by id or email', { extra: { sessionUserId: sessionUser.id, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    const updated = await db.update(users)
      .set({
        appleId: null,
        appleEmail: null,
        appleLinkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, dbUserId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      logger.error('[Apple Auth] Unlink update affected 0 rows', { extra: { dbUserId, sessionEmail: sessionUser.email } });
      return res.status(404).json({ error: 'User account not found. Please log out and log in again.' });
    }

    logMemberAction({
      memberEmail: sessionUser.email,
      memberName: `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim(),
      action: 'update_member',
      resourceType: 'user',
      resourceId: dbUserId,
      details: { action: 'apple_unlink' },
      req,
    }).catch(err => logger.error('[Apple Auth] Failed to log apple_unlink action', { error: new Error(getErrorMessage(err)) }));

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Apple Auth] Unlink error', { error: new Error(getErrorMessage(error)) });
    res.status(500).json({ error: 'Failed to unlink Apple account' });
  }
});

router.get('/api/auth/apple/status', requireAppleConfig, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) {
      return res.status(401).json({ error: 'You must be logged in to check Apple link status' });
    }

    const dbUserId = await resolveDbUserId({ id: sessionUser.id, email: sessionUser.email || '' });

    const result = await db.select({
      appleId: users.appleId,
      appleEmail: users.appleEmail,
      appleLinkedAt: users.appleLinkedAt,
    })
      .from(users)
      .where(eq(users.id, dbUserId || sessionUser.id))
      .limit(1);

    if (result.length === 0) {
      return res.json({ linked: false, appleEmail: null, linkedAt: null });
    }

    const { appleId, appleEmail, appleLinkedAt } = result[0];
    res.json({
      linked: !!appleId,
      appleEmail: appleEmail || null,
      linkedAt: appleLinkedAt ? appleLinkedAt.toISOString() : null,
    });
  } catch (error: unknown) {
    logger.error('[Apple Auth] Status error', { error: new Error(getErrorMessage(error)) });
    res.status(500).json({ error: 'Failed to check Apple link status' });
  }
});

export default router;

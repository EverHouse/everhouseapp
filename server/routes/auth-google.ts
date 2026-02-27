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

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

router.post('/api/auth/google/verify', async (req, res) => {
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
    const role = (user.role || 'member') as 'admin' | 'staff' | 'member';
    const activeStatuses = ['active', 'trialing', 'past_due'];

    if (role === 'member' && !activeStatuses.includes(dbMemberStatus)) {
      return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
    }

    const sessionTtl = 7 * 24 * 60 * 60 * 1000;
    const member = {
      id: user.id,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || googleUser.email,
      phone: user.phone || '',
      tier: normalizeTierName(user.tier),
      tags: user.tags || [],
      mindbodyClientId: user.mindbodyClientId || '',
      status: 'Active',
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
        await db.update(users)
          .set({
            googleId: googleUser.sub,
            googleEmail: googleUser.email,
            googleLinkedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
      }
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

router.post('/api/auth/google/callback', async (req, res) => {
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
    const role = (user.role || 'member') as 'admin' | 'staff' | 'member';
    const activeStatuses = ['active', 'trialing', 'past_due'];

    if (role === 'member' && !activeStatuses.includes(dbMemberStatus)) {
      return res.redirect('/login?error=inactive_membership');
    }

    const sessionTtl = 7 * 24 * 60 * 60 * 1000;
    const member = {
      id: user.id,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || googleUser.email,
      phone: user.phone || '',
      tier: normalizeTierName(user.tier),
      tags: user.tags || [],
      mindbodyClientId: user.mindbodyClientId || '',
      status: 'Active',
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
        await db.update(users)
          .set({
            googleId: googleUser.sub,
            googleEmail: googleUser.email,
            googleLinkedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
      }
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

router.post('/api/auth/google/link', async (req, res) => {
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

    const existing = await db.select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.googleId, googleUser.sub))
      .limit(1);

    if (existing.length > 0 && existing[0].id !== sessionUser.id) {
      return res.status(409).json({ error: 'This Google account is already linked to a different member account.' });
    }

    await db.update(users)
      .set({
        googleId: googleUser.sub,
        googleEmail: googleUser.email,
        googleLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, sessionUser.id));

    logMemberAction({
      memberEmail: sessionUser.email,
      memberName: `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim(),
      action: 'update_member',
      resourceType: 'user',
      resourceId: sessionUser.id,
      details: { action: 'google_link', googleEmail: googleUser.email },
      req,
    });

    res.json({ success: true, googleEmail: googleUser.email });
  } catch (error: unknown) {
    logger.error('[Google Auth] Link error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link Google account' });
  }
});

router.post('/api/auth/google/unlink', async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id || !sessionUser?.email) {
      return res.status(401).json({ error: 'You must be logged in to unlink a Google account' });
    }

    await db.update(users)
      .set({
        googleId: null,
        googleEmail: null,
        googleLinkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, sessionUser.id));

    logMemberAction({
      memberEmail: sessionUser.email,
      memberName: `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim(),
      action: 'update_member',
      resourceType: 'user',
      resourceId: sessionUser.id,
      details: { action: 'google_unlink' },
      req,
    });

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Google Auth] Unlink error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to unlink Google account' });
  }
});

router.get('/api/auth/google/status', async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) {
      return res.status(401).json({ error: 'You must be logged in to check Google link status' });
    }

    const result = await db.select({
      googleId: users.googleId,
      googleEmail: users.googleEmail,
      googleLinkedAt: users.googleLinkedAt,
    })
      .from(users)
      .where(eq(users.id, sessionUser.id))
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

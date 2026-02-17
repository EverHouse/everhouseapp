import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, systemSettings } from '../../shared/schema';
import { isAuthenticated, isStaffOrAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { isProduction } from '../core/db';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';

const router = Router();

router.get('/api/waivers/status', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const currentVersionResult = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);
    
    const currentVersion = currentVersionResult[0]?.value || '1.0';

    const userResult = await db.select({
      waiverVersion: users.waiverVersion,
      waiverSignedAt: users.waiverSignedAt,
      role: users.role,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${sessionUser.email.toLowerCase()}`)
      .limit(1);

    const user = userResult[0];
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'staff' || user.role === 'admin') {
      return res.json({
        needsWaiverUpdate: false,
        currentVersion,
        userVersion: user.waiverVersion,
        signedAt: user.waiverSignedAt,
      });
    }

    const needsWaiverUpdate = !user.waiverVersion || user.waiverVersion !== currentVersion;

    res.json({
      needsWaiverUpdate,
      currentVersion,
      userVersion: user.waiverVersion,
      signedAt: user.waiverSignedAt,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error checking waiver status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check waiver status' });
  }
});

router.post('/api/waivers/sign', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const currentVersionResult = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);
    
    const currentVersion = currentVersionResult[0]?.value || '1.0';

    await db.update(users)
      .set({
        waiverVersion: currentVersion,
        waiverSignedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(sql`LOWER(${users.email}) = ${sessionUser.email.toLowerCase()}`);

    db.execute(sql`UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() 
      WHERE LOWER(email) = ${sessionUser.email.toLowerCase()} 
      AND onboarding_completed_at IS NULL 
      AND first_name IS NOT NULL AND last_name IS NOT NULL AND phone IS NOT NULL
      AND first_booking_at IS NOT NULL AND app_installed_at IS NOT NULL`).catch(() => {});

    res.json({
      success: true,
      version: currentVersion,
      signedAt: new Date(),
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error signing waiver', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sign waiver' });
  }
});

router.get('/api/waivers/current-version', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.select({ value: systemSettings.value, updatedAt: systemSettings.updatedAt })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'current_waiver_version'))
      .limit(1);
    
    res.json({
      version: result[0]?.value || '1.0',
      updatedAt: result[0]?.updatedAt,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error fetching waiver version', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch waiver version' });
  }
});

router.post('/api/waivers/update-version', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (sessionUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update waiver version' });
    }

    const { version } = req.body;
    
    if (!version || typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version format. Use format like "1.0", "1.1", "2.0"' });
    }

    await db.insert(systemSettings)
      .values({
        key: 'current_waiver_version',
        value: version,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: version,
          updatedAt: new Date(),
        },
      });

    // Include trialing and past_due as active - they still have membership access
    const affectedUsersResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM users 
      WHERE (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)
      AND archived_at IS NULL 
      AND role = 'member'
      AND (waiver_version IS NULL OR waiver_version != ${version})
    `);
    
    const affectedCount = Number((affectedUsersResult as any).rows?.[0]?.count || 0);

    logFromRequest(req, 'update_waiver_version' as any, 'waiver', undefined, undefined, { version, affectedMembers: affectedCount });
    res.json({
      success: true,
      version,
      affectedMembers: affectedCount,
      message: `Waiver version updated to ${version}. ${affectedCount} members will need to re-sign.`,
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Error updating waiver version', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update waiver version' });
  }
});

export default router;

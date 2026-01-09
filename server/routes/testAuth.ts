import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { isProduction } from '../core/db';
import { db } from '../db';
import { users, staffUsers, membershipTiers, notifications, bookingRequests } from '../../shared/schema';
import { sql, eq, and, like, or } from 'drizzle-orm';
import { normalizeTierName, DEFAULT_TIER } from '../../shared/constants/tiers';
import '../types/session';

const router = Router();

const ENABLE_TEST_LOGIN = process.env.ENABLE_TEST_LOGIN === 'true';

router.use((req: Request, res: Response, next) => {
  if (isProduction || !ENABLE_TEST_LOGIN) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

interface TestLoginRequest {
  email: string;
  role: 'member' | 'staff' | 'admin';
  tier?: string;
  firstName?: string;
  lastName?: string;
}

async function getOrCreateTestUser(data: TestLoginRequest): Promise<{
  email: string;
  role: 'member' | 'staff' | 'admin';
  tier: string | null;
  tierId: number | null;
  firstName: string | null;
  lastName: string | null;
}> {
  const normalizedEmail = data.email.toLowerCase();
  const isStaffOrAdmin = data.role === 'staff' || data.role === 'admin';
  
  let tierId: number | null = null;
  let tierName: string | null = null;
  
  if (!isStaffOrAdmin) {
    tierName = normalizeTierName(data.tier || DEFAULT_TIER);
    const tierResult = await db.select({ id: membershipTiers.id })
      .from(membershipTiers)
      .where(sql`LOWER(${membershipTiers.name}) = LOWER(${tierName})`)
      .limit(1);
    tierId = tierResult.length > 0 ? tierResult[0].id : null;
  }

  const existingUser = await db.select()
    .from(users)
    .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`)
    .limit(1);

  if (existingUser.length > 0) {
    if (!isStaffOrAdmin && data.tier && tierName && tierId) {
      await db.update(users)
        .set({ tier: tierName, tierId: tierId })
        .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`);
      
      return {
        email: existingUser[0].email,
        role: data.role,
        tier: tierName,
        tierId: tierId,
        firstName: existingUser[0].firstName,
        lastName: existingUser[0].lastName
      };
    }
    
    return {
      email: existingUser[0].email,
      role: data.role,
      tier: existingUser[0].tier,
      tierId: existingUser[0].tierId,
      firstName: existingUser[0].firstName,
      lastName: existingUser[0].lastName
    };
  }

  await db.insert(users)
    .values({
      id: crypto.randomUUID(),
      email: normalizedEmail,
      firstName: data.firstName || 'Test',
      lastName: data.lastName || 'User',
      tier: tierName,
      tierId: tierId,
      role: data.role,
      tags: []
    })
    .onConflictDoNothing();

  if (isStaffOrAdmin) {
    await db.insert(staffUsers)
      .values({
        email: normalizedEmail,
        firstName: data.firstName || 'Test',
        lastName: data.lastName || 'User',
        phone: '',
        passwordHash: '',
        role: data.role,
        isActive: true,
        jobTitle: data.role === 'admin' ? 'Test Admin' : 'Test Staff'
      })
      .onConflictDoNothing();
  }

  return {
    email: normalizedEmail,
    role: data.role,
    tier: tierName,
    tierId: tierId,
    firstName: data.firstName || 'Test',
    lastName: data.lastName || 'User'
  };
}

router.post('/test-login', async (req: Request, res: Response) => {
  try {
    const { email, role, tier, firstName, lastName } = req.body as TestLoginRequest;
    
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }
    
    if (!['member', 'staff', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'role must be member, staff, or admin' });
    }

    const user = await getOrCreateTestUser({ email, role, tier, firstName, lastName });

    req.session.regenerate((err) => {
      if (err) {
        console.error('[TestAuth] Session regeneration error:', err);
        return res.status(500).json({ error: 'Session error' });
      }

      req.session.user = {
        email: user.email,
        role: user.role,
        tier: user.tier,
        tierId: user.tierId,
        firstName: user.firstName,
        lastName: user.lastName,
        isTestUser: true
      };

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[TestAuth] Session save error:', saveErr);
          return res.status(500).json({ error: 'Session save error' });
        }

        console.log(`[TestAuth] Test login successful: ${user.email} as ${user.role}`);
        
        res.json({
          success: true,
          user: {
            email: user.email,
            role: user.role,
            tier: user.tier,
            firstName: user.firstName,
            lastName: user.lastName
          }
        });
      });
    });
  } catch (error) {
    console.error('[TestAuth] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/test-logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

router.post('/test-cleanup', async (req: Request, res: Response) => {
  try {
    const { patterns = [] } = req.body;
    
    const defaultPatterns = [
      'test-member@example.com',
      'test-staff@example.com',
      'notif-test-member@example.com',
      'notif-test-staff@example.com'
    ];
    
    const allPatterns = [...new Set([...defaultPatterns, ...patterns])];
    
    let notificationsDeleted = 0;
    let bookingsDeleted = 0;
    
    for (const pattern of allPatterns) {
      const notifResult = await db
        .delete(notifications)
        .where(eq(notifications.userEmail, pattern))
        .returning({ id: notifications.id });
      notificationsDeleted += notifResult.length;
      
      const bookingResult = await db
        .delete(bookingRequests)
        .where(eq(bookingRequests.userEmail, pattern))
        .returning({ id: bookingRequests.id });
      bookingsDeleted += bookingResult.length;
    }
    
    const testMemberNotifs = await db
      .delete(notifications)
      .where(
        or(
          like(notifications.title, '%Test Member%'),
          like(notifications.message, '%Test Member%')
        )
      )
      .returning({ id: notifications.id });
    notificationsDeleted += testMemberNotifs.length;
    
    console.log(`[TestCleanup] Cleaned ${notificationsDeleted} notifications, ${bookingsDeleted} bookings`);
    
    res.json({
      success: true,
      deleted: {
        notifications: notificationsDeleted,
        bookings: bookingsDeleted
      }
    });
  } catch (error) {
    console.error('[TestCleanup] Error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

export default router;

import { Router } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { logger } from '../../core/logger';

const router = Router();

router.get('/api/member/onboarding', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ error: 'Authentication required' });
    
    const email = sessionUser.email?.toLowerCase();
    if (!email) return res.status(400).json({ error: 'User email required' });

    const result = await db.execute(sql`
      SELECT 
        first_name, last_name, phone, tier,
        waiver_version, waiver_signed_at,
        onboarding_completed_at, onboarding_dismissed_at,
        first_login_at, first_booking_at, profile_completed_at, app_installed_at,
        id_image_url, join_date, created_at
      FROM users 
      WHERE LOWER(email) = ${email}
      LIMIT 1
    `);

    const user = (result as any).rows?.[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const hasProfile = !!(user.first_name && user.last_name && user.phone);
    const hasWaiver = !!user.waiver_signed_at;
    const hasFirstBooking = !!user.first_booking_at;
    const hasAppInstalled = !!user.app_installed_at;
    
    const steps = [
      { key: 'profile', label: 'Complete your profile', description: 'Add your name, phone, and photo', completed: hasProfile, completedAt: user.profile_completed_at },
      { key: 'waiver', label: 'Sign the club waiver', description: 'Required before your first visit', completed: hasWaiver, completedAt: user.waiver_signed_at },
      { key: 'booking', label: 'Book your first session', description: 'Reserve a golf simulator', completed: hasFirstBooking, completedAt: user.first_booking_at },
      { key: 'app', label: 'Install the app', description: 'Add to your home screen for quick access', completed: hasAppInstalled, completedAt: user.app_installed_at },
    ];

    const completedCount = steps.filter(s => s.completed).length;
    const isComplete = completedCount === steps.length;
    const isDismissed = !!user.onboarding_dismissed_at;

    res.json({
      steps,
      completedCount,
      totalSteps: steps.length,
      isComplete,
      isDismissed,
      onboardingCompletedAt: user.onboarding_completed_at,
    });
  } catch (error: unknown) {
    logger.error('[onboarding] Failed to get onboarding status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get onboarding status' });
  }
});

router.post('/api/member/onboarding/complete-step', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ error: 'Authentication required' });
    
    const email = sessionUser.email?.toLowerCase();
    if (!email) return res.status(400).json({ error: 'User email required' });

    const { step } = req.body;
    const validSteps = ['profile', 'app', 'first_login'];
    
    if (!step || !validSteps.includes(step)) {
      return res.status(400).json({ error: 'Invalid step' });
    }

    if (step === 'profile') {
      await db.execute(sql`UPDATE users SET profile_completed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND profile_completed_at IS NULL`);
    } else if (step === 'app') {
      await db.execute(sql`UPDATE users SET app_installed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND app_installed_at IS NULL`);
    } else if (step === 'first_login') {
      await db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND first_login_at IS NULL`);
    }
    
    const checkResult = await db.execute(sql`
      SELECT 
        CASE WHEN first_name IS NOT NULL AND last_name IS NOT NULL AND phone IS NOT NULL THEN true ELSE false END as has_profile,
        CASE WHEN waiver_signed_at IS NOT NULL THEN true ELSE false END as has_waiver,
        CASE WHEN first_booking_at IS NOT NULL THEN true ELSE false END as has_booking,
        CASE WHEN app_installed_at IS NOT NULL THEN true ELSE false END as has_app
      FROM users WHERE LOWER(email) = ${email}
    `);

    const check = (checkResult as any).rows?.[0];
    if (check?.has_profile && check?.has_waiver && check?.has_booking && check?.has_app) {
      await db.execute(sql`UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND onboarding_completed_at IS NULL`);
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[onboarding] Failed to complete step', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to complete step' });
  }
});

router.post('/api/member/onboarding/dismiss', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ error: 'Authentication required' });
    
    const email = sessionUser.email?.toLowerCase();
    if (!email) return res.status(400).json({ error: 'User email required' });

    await db.execute(sql`UPDATE users SET onboarding_dismissed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email}`);
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[onboarding] Failed to dismiss', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to dismiss onboarding' });
  }
});

export default router;

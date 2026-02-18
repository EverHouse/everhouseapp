import { Router } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { logger } from '../../core/logger';
import { z } from 'zod';
import { getHubSpotClient } from '../../core/integrations';
import { retryableHubSpotRequest } from '../../core/hubspot/request';

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
        concierge_saved_at,
        id_image_url, join_date, created_at
      FROM users 
      WHERE LOWER(email) = ${email}
      LIMIT 1
    `);

    const user = (result.rows as Record<string, unknown>[])?.[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const hasProfile = !!(user.first_name && user.last_name && user.phone);
    const hasWaiver = !!user.waiver_signed_at;
    const hasFirstBooking = !!user.first_booking_at;
    const hasAppInstalled = !!user.app_installed_at;
    const hasConcierge = !!user.concierge_saved_at;

    let needsRefresh = false;
    if (hasProfile && !user.profile_completed_at) {
      await db.execute(sql`UPDATE users SET profile_completed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND profile_completed_at IS NULL`);
      needsRefresh = true;
    }

    const allComplete = hasProfile && hasWaiver && hasFirstBooking && hasAppInstalled && hasConcierge;
    if (allComplete && !user.onboarding_completed_at) {
      await db.execute(sql`UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND onboarding_completed_at IS NULL`);
      needsRefresh = true;
    }

    let finalUser = user;
    if (needsRefresh) {
      const refreshResult = await db.execute(sql`
        SELECT profile_completed_at, onboarding_completed_at
        FROM users WHERE LOWER(email) = ${email} LIMIT 1
      `);
      const refreshed = (refreshResult.rows as Record<string, unknown>[])?.[0];
      if (refreshed) {
        finalUser = { ...user, ...refreshed };
      }
    }

    const steps = [
      { key: 'profile', label: 'Complete your profile', description: 'Add your name, phone, and photo', completed: hasProfile, completedAt: finalUser.profile_completed_at },
      { key: 'concierge', label: 'Save concierge contact', description: 'Add Ever Club to your phone contacts', completed: hasConcierge, completedAt: finalUser.concierge_saved_at },
      { key: 'waiver', label: 'Sign the club waiver', description: 'Required before your first visit', completed: hasWaiver, completedAt: finalUser.waiver_signed_at },
      { key: 'booking', label: 'Book your first session', description: 'Reserve a golf simulator', completed: hasFirstBooking, completedAt: finalUser.first_booking_at },
      { key: 'app', label: 'Install the app', description: 'Add to your home screen for quick access', completed: hasAppInstalled, completedAt: finalUser.app_installed_at },
    ];

    const completedCount = steps.filter(s => s.completed).length;
    const isComplete = completedCount === steps.length;
    const isDismissed = !!finalUser.onboarding_dismissed_at;

    res.json({
      steps,
      completedCount,
      totalSteps: steps.length,
      isComplete,
      isDismissed,
      onboardingCompletedAt: finalUser.onboarding_completed_at,
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
    const validSteps = ['profile', 'app', 'first_login', 'concierge'];
    
    if (!step || !validSteps.includes(step)) {
      return res.status(400).json({ error: 'Invalid step' });
    }

    if (step === 'profile') {
      await db.execute(sql`UPDATE users SET profile_completed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND profile_completed_at IS NULL`);
    } else if (step === 'app') {
      await db.execute(sql`UPDATE users SET app_installed_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND app_installed_at IS NULL`);
    } else if (step === 'first_login') {
      await db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND first_login_at IS NULL`);
    } else if (step === 'concierge') {
      await db.execute(sql`UPDATE users SET concierge_saved_at = NOW(), updated_at = NOW() WHERE LOWER(email) = ${email} AND concierge_saved_at IS NULL`);
    }
    
    const checkResult = await db.execute(sql`
      SELECT 
        CASE WHEN first_name IS NOT NULL AND last_name IS NOT NULL AND phone IS NOT NULL THEN true ELSE false END as has_profile,
        CASE WHEN waiver_signed_at IS NOT NULL THEN true ELSE false END as has_waiver,
        CASE WHEN first_booking_at IS NOT NULL THEN true ELSE false END as has_booking,
        CASE WHEN app_installed_at IS NOT NULL THEN true ELSE false END as has_app,
        CASE WHEN concierge_saved_at IS NOT NULL THEN true ELSE false END as has_concierge
      FROM users WHERE LOWER(email) = ${email}
    `);

    const check = (checkResult.rows as Record<string, unknown>[])?.[0];
    if (check?.has_profile && check?.has_waiver && check?.has_booking && check?.has_app && check?.has_concierge) {
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

const profileUpdateSchema = z.object({
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
  phone: z.string().min(1).max(30).trim(),
});

router.put('/api/member/profile', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ error: 'Authentication required' });
    
    const email = sessionUser.email?.toLowerCase();
    if (!email) return res.status(400).json({ error: 'User email required' });

    const parseResult = profileUpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid profile data. First name, last name, and phone are required.' });
    }

    const { firstName, lastName, phone } = parseResult.data;

    const result = await db.execute(sql`
      UPDATE users 
      SET first_name = ${firstName}, last_name = ${lastName}, phone = ${phone},
          profile_completed_at = COALESCE(profile_completed_at, NOW()),
          updated_at = NOW()
      WHERE LOWER(email) = ${email}
      RETURNING first_name, last_name, phone, profile_completed_at
    `);

    const updated = (result.rows as Record<string, unknown>[])?.[0];
    if (!updated) return res.status(404).json({ error: 'User not found' });

    db.execute(sql`UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() 
      WHERE LOWER(email) = ${email} 
      AND onboarding_completed_at IS NULL 
      AND first_name IS NOT NULL AND last_name IS NOT NULL AND phone IS NOT NULL
      AND waiver_signed_at IS NOT NULL AND first_booking_at IS NOT NULL AND app_installed_at IS NOT NULL AND concierge_saved_at IS NOT NULL`).catch(() => {});

    syncProfileToExternalServices(email, firstName, lastName, phone).catch((err) => {
      logger.error('[onboarding] Background sync to Stripe/HubSpot failed', { error: err instanceof Error ? err : new Error(String(err)) });
    });

    res.json({
      success: true,
      firstName: updated.first_name,
      lastName: updated.last_name,
      phone: updated.phone,
    });
  } catch (error: unknown) {
    logger.error('[onboarding] Failed to update profile', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

async function syncProfileToExternalServices(
  email: string,
  firstName: string,
  lastName: string,
  phone: string
): Promise<void> {
  try {
    const userResult = await db.execute(sql`
      SELECT stripe_customer_id, hubspot_id, tier, id FROM users WHERE LOWER(email) = ${email.toLowerCase()}
    `);
    const user = (userResult.rows as Record<string, unknown>[])?.[0];

    if (user?.stripe_customer_id) {
      const { getStripeClient } = await import('../../core/stripe/client');
      const stripe = await getStripeClient();
      const fullName = [firstName, lastName].filter(Boolean).join(' ');
      const metadata: Record<string, string> = {
        userId: user.id,
        source: 'even_house_app',
      };
      if (user.tier) metadata.tier = user.tier;
      if (firstName) metadata.firstName = firstName;
      if (lastName) metadata.lastName = lastName;

      await stripe.customers.update(user.stripe_customer_id, {
        name: fullName || undefined,
        phone: phone || undefined,
        metadata,
      });
      logger.info('[ProfileSync] Updated Stripe customer name/phone', { extra: { email } });
    }

    if (user?.hubspot_id) {
      const hubspot = await getHubSpotClient();
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(user.hubspot_id, {
          properties: {
            firstname: firstName,
            lastname: lastName,
            phone: phone || '',
          },
        })
      );
      logger.info('[ProfileSync] Updated HubSpot contact name/phone', { extra: { email } });
    } else {
      const hubspot = await getHubSpotClient();
      const searchResponse = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: email.toLowerCase(),
            }],
          }],
          properties: ['email'],
          limit: 1,
        })
      );
      if (searchResponse.results && searchResponse.results.length > 0) {
        const contactId = searchResponse.results[0].id;
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(contactId, {
            properties: {
              firstname: firstName,
              lastname: lastName,
              phone: phone || '',
            },
          })
        );
        logger.info('[ProfileSync] Updated HubSpot contact (by email search) name/phone', { extra: { email } });
      }
    }
  } catch (error: unknown) {
    logger.error('[ProfileSync] Error syncing to external services', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}

export default router;

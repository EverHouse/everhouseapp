import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from './client';
import { getOrCreateStripeCustomer } from './customers';
import { alertOnExternalServiceError } from '../errorAlerts';
import { notifyMember, notifyAllStaff } from '../notificationService';
import { logSystemAction } from '../auditLog';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';

interface MigrationUser {
  id: string;
  email: string;
  tier: string | null;
  membership_status: string | null;
  billing_provider: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  first_name: string | null;
  last_name: string | null;
  migration_status: string | null;
  migration_billing_start_date: Date | null;
  migration_requested_by: string | null;
  migration_tier_snapshot: string | null;
}

export async function executePendingMigration(userId: string, email: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const prefix = `[BillingMigration]`;

  try {
    const userResult = await db.execute(sql`
      SELECT id, email, tier, membership_status, billing_provider,
             stripe_customer_id, stripe_subscription_id,
             first_name, last_name,
             migration_status, migration_billing_start_date,
             migration_requested_by, migration_tier_snapshot
      FROM users WHERE id = ${userId} AND LOWER(email) = LOWER(${email})
    `);

    if (userResult.rows.length === 0) {
      logger.error(`${prefix} User not found: ${email} (${userId})`);
      return { success: false, error: 'User not found' };
    }

    const user = userResult.rows[0] as unknown as MigrationUser;

    if (user.migration_status !== 'pending' && user.migration_status !== 'processing') {
      logger.warn(`${prefix} Migration not pending/processing for ${email}, status: ${user.migration_status}`);
      return { success: false, error: `Migration status is '${user.migration_status}', expected 'pending' or 'processing'` };
    }

    if (user.membership_status !== 'active') {
      logger.warn(`${prefix} Member ${email} is no longer active (status: ${user.membership_status}), failing migration`);
      await db.execute(sql`
        UPDATE users SET migration_status = 'failed', updated_at = NOW()
        WHERE id = ${userId}
      `);
      await notifyAllStaff(
        'Migration Failed — Member No Longer Active',
        `Billing migration failed for ${email}: membership status is '${user.membership_status}'. The member may have been cancelled by staff.`,
        'billing_migration'
      );
      return { success: false, error: `Member is no longer active (status: ${user.membership_status})` };
    }

    const stripe = await getStripeClient();

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customerResult = await getOrCreateStripeCustomer(
        userId,
        email,
        [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined,
        user.tier || user.migration_tier_snapshot || undefined
      );
      customerId = customerResult.customerId;
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    });

    if (paymentMethods.data.length === 0) {
      logger.error(`${prefix} No card on file for ${email} (customer: ${customerId})`);
      await db.execute(sql`
        UPDATE users SET migration_status = 'failed', updated_at = NOW()
        WHERE id = ${userId}
      `);
      await notifyAllStaff(
        'Migration Failed — No Card on File',
        `Billing migration failed for ${user.first_name || ''} ${user.last_name || ''} (${email}): No card on file.`,
        'billing_migration'
      );
      return { success: false, error: 'No card on file' };
    }

    const defaultPaymentMethod = paymentMethods.data[0].id;

    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      limit: 10,
    });
    const activeSubscription = existingSubscriptions.data.find(s =>
      ['active', 'trialing', 'past_due'].includes(s.status)
    );
    if (activeSubscription) {
      logger.warn(`${prefix} Member ${email} already has active subscription ${activeSubscription.id}, aborting migration to prevent double billing`);
      await db.execute(sql`
        UPDATE users SET migration_status = 'completed',
          stripe_subscription_id = ${activeSubscription.id},
          billing_provider = 'stripe',
          updated_at = NOW()
        WHERE id = ${userId}
      `);
      await notifyAllStaff(
        'Migration Skipped — Existing Subscription',
        `${email} already has active Stripe subscription ${activeSubscription.id}. Migration marked as completed without creating a new subscription.`,
        'billing_migration'
      );
      return { success: true };
    }

    const tierSlug = user.tier || user.migration_tier_snapshot;
    if (!tierSlug) {
      logger.error(`${prefix} No tier found for ${email}`);
      await db.execute(sql`
        UPDATE users SET migration_status = 'failed', updated_at = NOW()
        WHERE id = ${userId}
      `);
      await notifyAllStaff(
        'Migration Failed — No Tier',
        `Billing migration failed for ${email}: No membership tier found.`,
        'billing_migration'
      );
      return { success: false, error: 'No membership tier found' };
    }

    const tierResult = await db.execute(sql`
      SELECT stripe_price_id, name FROM membership_tiers
      WHERE LOWER(slug) = LOWER(${tierSlug}) AND stripe_price_id IS NOT NULL
      LIMIT 1
    `);

    if (tierResult.rows.length === 0) {
      logger.error(`${prefix} No Stripe price ID for tier '${tierSlug}' for ${email}`);
      await db.execute(sql`
        UPDATE users SET migration_status = 'failed', updated_at = NOW()
        WHERE id = ${userId}
      `);
      await notifyAllStaff(
        'Migration Failed — No Stripe Price',
        `Billing migration failed for ${email}: Tier '${tierSlug}' has no Stripe price configured.`,
        'billing_migration'
      );
      return { success: false, error: `No Stripe price for tier '${tierSlug}'` };
    }

    const stripePriceId = tierResult.rows[0].stripe_price_id as string;
    const tierName = tierResult.rows[0].name as string;

    await db.execute(sql`
      UPDATE users SET billing_provider = 'stripe', updated_at = NOW()
      WHERE id = ${userId}
    `);

    try {
      const now = new Date();
      const billingStartDate = user.migration_billing_start_date;
      const isFuture = billingStartDate && (billingStartDate.getTime() - now.getTime() > 48 * 60 * 60 * 1000);

      const subscriptionParams: Record<string, unknown> = {
        customer: customerId,
        items: [{ price: stripePriceId }],
        default_payment_method: defaultPaymentMethod,
        metadata: {
          tier_slug: tierSlug,
          tier_name: tierName,
          migration: 'true',
          source: 'even_house_app',
          userId: userId,
          memberEmail: email,
        },
      };

      if (isFuture) {
        subscriptionParams.trial_end = Math.floor(billingStartDate!.getTime() / 1000);
        logger.info(`${prefix} Creating subscription with trial_end for ${email}, billing starts: ${billingStartDate!.toISOString()}`);
      } else {
        logger.info(`${prefix} Creating subscription with immediate billing for ${email}`);
      }

      const subscription = await stripe.subscriptions.create(subscriptionParams as Parameters<typeof stripe.subscriptions.create>[0]);

      logger.info(`${prefix} Subscription created: ${subscription.id} for ${email} (status: ${subscription.status})`);

      await db.execute(sql`
        UPDATE users SET migration_status = 'completed',
          stripe_subscription_id = ${subscription.id},
          updated_at = NOW()
        WHERE id = ${userId}
      `);

      const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || email;
      const cardLast4 = paymentMethods.data[0].card?.last4 || '****';

      await notifyMember({
        userEmail: email,
        title: 'Billing System Updated',
        message: `Your billing is now active on our new system. Your card ending in ••••${cardLast4} will be used for future charges.`,
        type: 'billing_migration',
      });

      await notifyAllStaff(
        'Migration Completed',
        `Billing migration completed for ${memberName} (${email}) — Subscription ${subscription.id} created.`,
        'billing_migration'
      );

      await logSystemAction({
        action: 'billing_provider_changed',
        resourceType: 'billing',
        resourceId: email,
        resourceName: memberName,
        details: {
          previousProvider: 'mindbody',
          newProvider: 'stripe',
          subscriptionId: subscription.id,
          priceId: stripePriceId,
          tierSlug,
          migration: true,
          billingStartDate: billingStartDate?.toISOString(),
          trialEnd: isFuture ? billingStartDate!.toISOString() : null,
        },
      });

      return { success: true };
    } catch (stripeError: unknown) {
      logger.error(`${prefix} Stripe subscription creation failed for ${email}:`, { error: stripeError });

      await db.execute(sql`
        UPDATE users SET billing_provider = 'mindbody', migration_status = 'failed', updated_at = NOW()
        WHERE id = ${userId}
      `);

      const errorMsg = getErrorMessage(stripeError);

      await notifyAllStaff(
        'Migration Failed — Stripe Error',
        `Billing migration failed for ${email}: ${errorMsg}`,
        'billing_migration'
      );

      await alertOnExternalServiceError('Stripe', stripeError as Error, `billing migration for ${email}`);

      return { success: false, error: errorMsg };
    }
  } catch (error: unknown) {
    logger.error(`${prefix} Unexpected error during migration for ${email}:`, { error });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function processPendingMigrations(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  staleCount: number;
}> {
  const prefix = `[BillingMigration]`;
  const result = { processed: 0, succeeded: 0, failed: 0, skipped: 0, staleCount: 0 };

  try {
    const pendingResult = await db.execute(sql`
      SELECT id, email, tier, membership_status, billing_provider,
             stripe_customer_id, stripe_subscription_id,
             first_name, last_name,
             migration_status, migration_billing_start_date,
             migration_requested_by, migration_tier_snapshot,
             billing_migration_requested_at
      FROM users
      WHERE migration_status = 'pending'
      ORDER BY billing_migration_requested_at ASC
    `);

    if (pendingResult.rows.length === 0) {
      logger.info(`${prefix} No pending migrations found`);
      return result;
    }

    logger.info(`${prefix} Found ${pendingResult.rows.length} pending migration(s)`);

    const now = new Date();
    const staleCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const staleMigrations: string[] = [];

    for (const row of pendingResult.rows) {
      const user = row as unknown as MigrationUser & { billing_migration_requested_at: Date | null };

      const membershipNoLongerActive = user.membership_status !== 'active';
      const providerNoLongerMindbody = user.billing_provider !== 'mindbody';
      const mindbodyCancellationDetected = membershipNoLongerActive || providerNoLongerMindbody;

      const billingDateArrived = user.migration_billing_start_date
        ? user.migration_billing_start_date.getTime() <= now.getTime()
        : true;

      if (user.billing_migration_requested_at && new Date(user.billing_migration_requested_at as unknown as string).getTime() <= staleCutoff.getTime()) {
        staleMigrations.push(user.email);
      }

      if (!mindbodyCancellationDetected) {
        logger.info(`${prefix} Skipping ${user.email} — MindBody still active (status: ${user.membership_status}, provider: ${user.billing_provider})`);
        result.skipped++;
        continue;
      }

      if (!billingDateArrived) {
        logger.info(`${prefix} Skipping ${user.email} — billing start date not yet arrived (${user.migration_billing_start_date?.toISOString()})`);
        result.skipped++;
        continue;
      }

      logger.info(`${prefix} Processing migration for ${user.email} (MindBody cancelled: ${mindbodyCancellationDetected}, billing date arrived: ${billingDateArrived})`);
      result.processed++;

      await db.execute(sql`UPDATE users SET migration_status = 'processing' WHERE id = ${user.id} AND migration_status = 'pending'`);

      const migrationResult = await executePendingMigration(user.id, user.email);

      if (migrationResult.success) {
        result.succeeded++;
      } else {
        result.failed++;
      }
    }

    if (staleMigrations.length > 0) {
      result.staleCount = staleMigrations.length;
      logger.warn(`${prefix} ${staleMigrations.length} stale migration(s) pending > 14 days: ${staleMigrations.join(', ')}`);

      await notifyAllStaff(
        'Stale Billing Migrations',
        `${staleMigrations.length} migration(s) have been pending for over 14 days: ${staleMigrations.join(', ')}. Please check if MindBody memberships have been cancelled.`,
        'billing_migration'
      );
    }

    logger.info(`${prefix} Migration processing complete: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`);

    return result;
  } catch (error: unknown) {
    logger.error(`${prefix} Error processing pending migrations:`, { error });
    return result;
  }
}

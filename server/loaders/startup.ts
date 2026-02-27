import { ensureDatabaseConstraints, seedDefaultNoticeTypes, createStripeTransactionCache, createSyncExclusionsTable, setupEmailNormalization, normalizeExistingEmails, cleanupOrphanedRecords, seedTierFeatures, fixFunctionSearchPaths, validateTierHierarchy } from '../db-init';
import { seedTrainingSections } from '../routes/training';
import { getStripeSync } from '../core/stripe';
import { getStripeEnvironmentInfo, getStripeClient } from '../core/stripe/client';
import { runMigrations } from 'stripe-replit-sync';
import type Stripe from 'stripe';
import { enableRealtimeForTable } from '../core/supabase/client';
import { initMemberSyncSettings } from '../core/memberSync';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';
import { db } from '../db';
import { sql } from 'drizzle-orm';

async function retryWithBackoff<T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      logger.info(`[Startup] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('unreachable');
}

interface StartupHealth {
  database: 'ok' | 'failed' | 'pending';
  stripe: 'ok' | 'failed' | 'pending';
  realtime: 'ok' | 'failed' | 'pending';
  criticalFailures: string[];
  warnings: string[];
  startedAt: string;
  completedAt?: string;
}

const startupHealth: StartupHealth = {
  database: 'pending',
  stripe: 'pending',
  realtime: 'pending',
  criticalFailures: [],
  warnings: [],
  startedAt: new Date().toISOString()
};

export function getStartupHealth(): StartupHealth {
  return { ...startupHealth };
}

export async function runStartupTasks(): Promise<void> {
  logger.info('[Startup] Running deferred database initialization...');
  
  try {
    await ensureDatabaseConstraints();
    logger.info('[Startup] Database constraints initialized successfully');
    startupHealth.database = 'ok';
  } catch (err: unknown) {
    logger.error('[Startup] Database constraints failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.database = 'failed';
    startupHealth.criticalFailures.push(`Database constraints: ${getErrorMessage(err)}`);
  }

  try {
    await setupEmailNormalization();
    const { updated } = await normalizeExistingEmails();
    if (updated > 0) {
      logger.info(`[Startup] Normalized ${updated} existing email records`, { extra: { updated } });
    }
  } catch (err: unknown) {
    logger.error('[Startup] Email normalization failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Email normalization: ${getErrorMessage(err)}`);
  }

  try {
    await fixFunctionSearchPaths();
  } catch (err: unknown) {
    logger.warn(`[Startup] Function search_path fix failed (non-critical): ${getErrorMessage(err)}`);
  }
  
  try {
    await seedDefaultNoticeTypes();
  } catch (err: unknown) {
    logger.error('[Startup] Seeding notice types failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Notice types: ${getErrorMessage(err)}`);
  }

  try {
    await seedTierFeatures();
  } catch (err: unknown) {
    logger.error('[Startup] Seeding tier features failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Tier features: ${getErrorMessage(err)}`);
  }

  try {
    await validateTierHierarchy();
  } catch (err: unknown) {
    logger.error('[Startup] Tier hierarchy validation failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Tier validation: ${getErrorMessage(err)}`);
  }

  try {
    await initMemberSyncSettings();
  } catch (err: unknown) {
    logger.error('[Startup] Member sync settings init failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Member sync settings: ${getErrorMessage(err)}`);
  }

  try {
    await seedTrainingSections();
    logger.info('[Startup] Training sections synced');
  } catch (err: unknown) {
    logger.error('[Startup] Seeding training sections failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Training sections: ${getErrorMessage(err)}`);
  }

  try {
    await createSyncExclusionsTable();
  } catch (err: unknown) {
    logger.error('[Startup] Creating sync exclusions table failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Sync exclusions table: ${getErrorMessage(err)}`);
  }

  try {
    await createStripeTransactionCache();
  } catch (err: unknown) {
    logger.error('[Startup] Creating stripe transaction cache failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.warnings.push(`Stripe transaction cache: ${getErrorMessage(err)}`);
  }

  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
      logger.info('[Stripe] Initializing Stripe schema...');
      await retryWithBackoff(() => runMigrations({ databaseUrl, schema: 'stripe' } as unknown as Parameters<typeof runMigrations>[0]), 'Stripe schema migration');
      logger.info('[Stripe] Schema ready');

      const stripeSync = await retryWithBackoff(() => getStripeSync(), 'Stripe sync init');
      
      const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
      if (replitDomains) {
        const webhookUrl = `https://${replitDomains}/api/stripe/webhook`;
        logger.info('[Stripe] Setting up managed webhook...');
        const result = await retryWithBackoff(() => (stripeSync as unknown as { findOrCreateManagedWebhook: (url: string) => Promise<unknown> }).findOrCreateManagedWebhook(webhookUrl), 'Stripe webhook setup');
        logger.info('[Stripe] Webhook configured');

        const requiredEvents = [
          'customer.created',
          'customer.updated',
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
          'customer.subscription.paused',
          'customer.subscription.resumed',
          'payment_intent.created',
          'payment_intent.succeeded',
          'payment_intent.payment_failed',
          'payment_intent.canceled',
          'payment_intent.processing',
          'payment_intent.requires_action',
          'invoice.payment_succeeded',
          'invoice.payment_failed',
          'invoice.created',
          'invoice.finalized',
          'invoice.updated',
          'invoice.voided',
          'invoice.marked_uncollectible',
          'checkout.session.completed',
          'charge.refunded',
          'charge.dispute.created',
          'charge.dispute.closed',
          'product.created',
          'product.updated',
          'product.deleted',
          'price.created',
          'price.updated',
          'coupon.created',
          'coupon.updated',
          'coupon.deleted',
          'credit_note.created',
          'customer.subscription.trial_will_end',
          'customer.deleted',
          'payment_method.attached',
          'payment_method.detached',
          'payment_method.updated',
          'payment_method.automatically_updated',
          'charge.dispute.updated',
          'checkout.session.expired',
          'checkout.session.async_payment_failed',
          'checkout.session.async_payment_succeeded',
          'invoice.payment_action_required',
          'invoice.overdue',
          'setup_intent.succeeded',
          'setup_intent.setup_failed',
        ];

        try {
          const webhookObj = ((result as Record<string, unknown>)?.webhook || result) as Record<string, unknown>;
          if (webhookObj?.id) {
            const currentEvents = (webhookObj.enabled_events || []) as string[];
            const missingEvents = requiredEvents.filter(
              (e: string) => !currentEvents.includes(e) && !currentEvents.includes('*')
            );
            if (missingEvents.length > 0) {
              logger.info(`[Stripe] Webhook missing ${missingEvents.length} event types, updating...`, { extra: { missingEvents } });
              const { getStripeClient } = await import('../core/stripe/client');
              const stripe = await getStripeClient();
              await stripe.webhookEndpoints.update(String(webhookObj.id), {
                enabled_events: requiredEvents as unknown as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
              });
              logger.info('[Stripe] Webhook events updated successfully');
            } else {
              logger.info('[Stripe] Webhook already has all required events');
            }
          }
        } catch (webhookUpdateErr: unknown) {
          logger.error('[Stripe] Failed to update webhook events (non-fatal)', { error: webhookUpdateErr instanceof Error ? webhookUpdateErr : new Error(String(webhookUpdateErr)) });
        }
      }
      
      startupHealth.stripe = 'ok';

      try {
        const { validateStripeEnvironmentIds } = await import('../core/stripe/environmentValidation');
        await validateStripeEnvironmentIds();
      } catch (err: unknown) {
        logger.error('[Stripe Env] Validation failed', { error: err instanceof Error ? err : new Error(String(err)) });
      }

      (stripeSync as unknown as { syncBackfill: () => Promise<void> }).syncBackfill()
        .then(() => logger.info('[Stripe] Data sync complete'))
        .catch((err: unknown) => {
          logger.error('[Stripe] Data sync error', { error: err instanceof Error ? err : new Error(String(err)) });
          startupHealth.warnings.push(`Stripe backfill: ${getErrorMessage(err)}`);
        });
      
      import('../core/stripe/groupBilling.js')
        .then(({ getOrCreateFamilyCoupon }) => getOrCreateFamilyCoupon())
        .then(() => logger.info('[Stripe] FAMILY20 coupon ready'))
        .catch((err: unknown) => logger.error('[Stripe] FAMILY20 coupon setup failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/products.js')
        .then(({ ensureSimulatorOverageProduct }) => ensureSimulatorOverageProduct())
        .then((result) => logger.info(`[Stripe] Simulator Overage product ${result.action}`, { extra: { action: result.action } }))
        .catch((err: unknown) => logger.error('[Stripe] Simulator Overage setup failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/products.js')
        .then(({ ensureGuestPassProduct }) => ensureGuestPassProduct())
        .then((result) => logger.info(`[Stripe] Guest Pass product ${result.action}`, { extra: { action: result.action } }))
        .catch((err: unknown) => logger.error('[Stripe] Guest Pass setup failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/products.js')
        .then(({ ensureDayPassCoworkingProduct }) => ensureDayPassCoworkingProduct())
        .then((result) => logger.info(`[Stripe] Day Pass Coworking product ${result.action}`, { extra: { action: result.action } }))
        .catch((err: unknown) => logger.error('[Stripe] Day Pass Coworking setup failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/products.js')
        .then(({ ensureDayPassGolfSimProduct }) => ensureDayPassGolfSimProduct())
        .then((result) => logger.info(`[Stripe] Day Pass Golf Sim product ${result.action}`, { extra: { action: result.action } }))
        .catch((err: unknown) => logger.error('[Stripe] Day Pass Golf Sim setup failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/products.js')
        .then(({ ensureCorporateVolumePricingProduct }) => ensureCorporateVolumePricingProduct())
        .then((result) => logger.info(`[Stripe] Corporate Volume Pricing product ${result.action}`, { extra: { action: result.action } }))
        .catch((err: unknown) => logger.error('[Stripe] Corporate Volume Pricing setup failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/products.js')
        .then(({ pullCorporateVolumePricingFromStripe }) => pullCorporateVolumePricingFromStripe())
        .then((pulled) => logger.info(`[Stripe] Corporate pricing ${pulled ? 'pulled from Stripe' : 'using defaults'}`, { extra: { pulled } }))
        .catch((err: unknown) => logger.error('[Stripe] Corporate pricing pull failed', { error: err instanceof Error ? err : new Error(String(err)) }));
      
      import('../core/stripe/customerSync.js')
        .then(({ syncStripeCustomersForMindBodyMembers }) => syncStripeCustomersForMindBodyMembers())
        .then((result) => {
          if (result.updated > 0 || result.cleared > 0) {
            logger.info('[Stripe] Customer sync complete', { extra: { updated: result.updated, cleared: result.cleared } });
          }
        })
        .catch((err: unknown) => logger.error('[Stripe] Customer sync failed', { error: err instanceof Error ? err : new Error(String(err)) }));
    }
  } catch (err: unknown) {
    logger.error('[Stripe] Initialization failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.stripe = 'failed';
    startupHealth.criticalFailures.push(`Stripe initialization: ${getErrorMessage(err)}`);
  }

  try {
    logger.info('[Supabase] Enabling realtime for tables...');
    const realtimeResults = await Promise.all([
      enableRealtimeForTable('notifications'),
      enableRealtimeForTable('booking_sessions'),
      enableRealtimeForTable('announcements'),
      enableRealtimeForTable('trackman_unmatched_bookings')
    ]);
    const successCount = realtimeResults.filter(Boolean).length;
    if (successCount === realtimeResults.length) {
      logger.info('[Supabase] Realtime enabled for notifications, booking_sessions, announcements, trackman_unmatched_bookings');
      startupHealth.realtime = 'ok';
    } else if (successCount > 0) {
      logger.warn(`[Supabase] Realtime partially enabled (${successCount}/${realtimeResults.length} tables)`, { extra: { successCount, total: realtimeResults.length } });
      startupHealth.realtime = 'ok';
      startupHealth.warnings.push(`Supabase realtime: only ${successCount}/${realtimeResults.length} tables enabled`);
    } else {
      logger.warn('[Supabase] Realtime not enabled for any tables - check Supabase configuration');
      startupHealth.realtime = 'failed';
      startupHealth.warnings.push('Supabase realtime: no tables enabled - check configuration');
    }
  } catch (err: unknown) {
    logger.error('[Supabase] Realtime setup failed', { error: err instanceof Error ? err : new Error(String(err)) });
    startupHealth.realtime = 'failed';
    startupHealth.warnings.push(`Supabase realtime: ${getErrorMessage(err)}`);
  }
  
  try {
    const { isLive, mode, isProduction } = await getStripeEnvironmentInfo();
    if (isProduction && !isLive) {
      logger.warn('[STARTUP WARNING] ⚠️ PRODUCTION DEPLOYMENT IS USING STRIPE TEST KEYS! Payments will NOT be processed with real money. Configure live Stripe keys in deployment settings.');
    } else if (!isProduction && isLive) {
      logger.warn('[STARTUP WARNING] ⚠️ Development environment is using Stripe LIVE keys. Be careful — real charges will be processed!');
    } else {
      logger.info(`[Startup] Stripe environment: ${mode} mode${isProduction ? ' (production)' : ' (development)'}`, { extra: { mode, isProduction } });
    }

    try {
      const stripe = await getStripeClient();
      const products = await stripe.products.list({ limit: 1, active: true });
      if (products.data.length === 0 && isProduction) {
        logger.warn('[STARTUP WARNING] ⚠️ Stripe live account has ZERO products. Run "Sync to Stripe" from the admin panel to push your tier and product data.');
      }
    } catch (productErr: unknown) {
      logger.warn('[Startup] Could not check Stripe products', { error: productErr instanceof Error ? productErr : new Error(String(productErr)) });
    }
  } catch (err: unknown) {
    logger.warn('[Startup] Could not check Stripe environment', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  try {
    const backfillResult = await db.execute(sql`
      UPDATE users u
      SET first_login_at = sub.first_booking,
          updated_at = NOW()
      FROM (
        SELECT br.user_id, MIN(br.created_at) as first_booking
        FROM booking_requests br
        WHERE br.user_id IS NOT NULL
          AND br.origin IS NULL
        GROUP BY br.user_id
      ) sub
      WHERE u.id = sub.user_id
        AND u.first_login_at IS NULL
    `);
    const count = (backfillResult as { rowCount?: number })?.rowCount || 0;
    if (count > 0) {
      logger.info(`[Startup] Backfilled first_login_at for ${count} members from self-requested booking history`);
    }
  } catch (err: unknown) {
    logger.warn('[Startup] first_login_at backfill failed (non-critical)', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  try {
    const tierBackfill = await db.execute(sql`
      UPDATE users
      SET last_tier = tier, updated_at = NOW()
      WHERE membership_status IN ('cancelled', 'expired', 'paused', 'inactive', 'terminated', 'suspended', 'frozen', 'declined', 'churned', 'former_member')
        AND tier IS NOT NULL AND tier != ''
        AND (last_tier IS NULL OR last_tier = '')
    `);
    const count = (tierBackfill as { rowCount?: number })?.rowCount || 0;
    if (count > 0) {
      logger.info(`[Startup] Backfilled last_tier for ${count} former members`);
    }
  } catch (err: unknown) {
    logger.warn('[Startup] last_tier backfill failed (non-critical)', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  startupHealth.completedAt = new Date().toISOString();
  
  if (startupHealth.criticalFailures.length > 0) {
    logger.error('[Startup] CRITICAL FAILURES', { extra: { failures: startupHealth.criticalFailures } });
  }
  if (startupHealth.warnings.length > 0) {
    logger.warn('[Startup] Warnings', { extra: { warnings: startupHealth.warnings } });
  }
}

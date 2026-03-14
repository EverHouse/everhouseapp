import { ensureDatabaseConstraints, seedDefaultNoticeTypes, createStripeTransactionCache, createSyncExclusionsTable, setupEmailNormalization, normalizeExistingEmails, seedTierFeatures, fixFunctionSearchPaths, validateTierHierarchy, setupInstantDataTriggers } from '../db-init';
import { seedTrainingSections } from '../routes/training';
import { getStripeSync } from '../core/stripe';
import { getStripeEnvironmentInfo, getStripeClient } from '../core/stripe/client';
import { runMigrations } from 'stripe-replit-sync';
import type Stripe from 'stripe';
import { enableRealtimeWithRetry } from '../core/supabase/client';
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

  const parallelDbTasks = [
    (async () => {
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
    })(),
    (async () => {
      try {
        await setupInstantDataTriggers();
      } catch (err: unknown) {
        logger.error('[Startup] Instant data triggers failed', { error: err instanceof Error ? err : new Error(String(err)) });
        startupHealth.warnings.push(`Instant data triggers: ${getErrorMessage(err)}`);
      }
    })(),
    (async () => {
      try {
        await fixFunctionSearchPaths();
      } catch (err: unknown) {
        logger.warn(`[Startup] Function search_path fix failed (non-critical): ${getErrorMessage(err)}`);
      }
    })(),
    (async () => {
      try {
        await seedDefaultNoticeTypes();
      } catch (err: unknown) {
        logger.error('[Startup] Seeding notice types failed', { error: err instanceof Error ? err : new Error(String(err)) });
        startupHealth.warnings.push(`Notice types: ${getErrorMessage(err)}`);
      }
    })(),
    (async () => {
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
    })(),
    (async () => {
      try {
        await initMemberSyncSettings();
      } catch (err: unknown) {
        logger.error('[Startup] Member sync settings init failed', { error: err instanceof Error ? err : new Error(String(err)) });
        startupHealth.warnings.push(`Member sync settings: ${getErrorMessage(err)}`);
      }
    })(),
    (async () => {
      try {
        await seedTrainingSections();
        logger.info('[Startup] Training sections synced');
      } catch (err: unknown) {
        logger.error('[Startup] Seeding training sections failed', { error: err instanceof Error ? err : new Error(String(err)) });
        startupHealth.warnings.push(`Training sections: ${getErrorMessage(err)}`);
      }
    })(),
    (async () => {
      try {
        await createSyncExclusionsTable();
      } catch (err: unknown) {
        logger.error('[Startup] Creating sync exclusions table failed', { error: err instanceof Error ? err : new Error(String(err)) });
        startupHealth.warnings.push(`Sync exclusions table: ${getErrorMessage(err)}`);
      }
    })(),
    (async () => {
      try {
        await createStripeTransactionCache();
      } catch (err: unknown) {
        logger.error('[Startup] Creating stripe transaction cache failed', { error: err instanceof Error ? err : new Error(String(err)) });
        startupHealth.warnings.push(`Stripe transaction cache: ${getErrorMessage(err)}`);
      }
    })(),
  ];

  await Promise.allSettled(parallelDbTasks);
  logger.info('[Startup] Parallel DB initialization tasks complete');

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
          const webhookObj = ((result as { webhook?: { id?: string; enabled_events?: string[] } })?.webhook || result) as { id?: string; enabled_events?: string[] };
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
      
      const productInitPromises: Promise<void>[] = [];

      productInitPromises.push(
        import('../core/stripe/products.js')
          .then(({ ensureSimulatorOverageProduct }) => retryWithBackoff(async () => {
            const r = await ensureSimulatorOverageProduct();
            if (r.action === 'error') throw new Error(`Simulator Overage product initialization failed (${r.action})`);
            return r;
          }, 'Simulator Overage product'))
          .then((result) => { logger.info(`[Stripe] Simulator Overage product ${result.action}`, { extra: { action: result.action } }); })
          .catch((err: unknown) => {
            logger.error('[Stripe] Simulator Overage setup failed', { error: err instanceof Error ? err : new Error(String(err)) });
            startupHealth.warnings.push(`Stripe product init: Simulator Overage - ${getErrorMessage(err)}`);
          })
      );

      productInitPromises.push(
        import('../core/stripe/products.js')
          .then(({ ensureGuestPassProduct }) => retryWithBackoff(async () => {
            const r = await ensureGuestPassProduct();
            if (r.action === 'error') throw new Error(`Guest Pass product initialization failed (${r.action})`);
            return r;
          }, 'Guest Pass product'))
          .then((result) => { logger.info(`[Stripe] Guest Pass product ${result.action}`, { extra: { action: result.action } }); })
          .catch((err: unknown) => {
            logger.error('[Stripe] Guest Pass setup failed', { error: err instanceof Error ? err : new Error(String(err)) });
            startupHealth.warnings.push(`Stripe product init: Guest Pass - ${getErrorMessage(err)}`);
          })
      );

      productInitPromises.push(
        import('../core/stripe/products.js')
          .then(({ ensureDayPassCoworkingProduct }) => retryWithBackoff(async () => {
            const r = await ensureDayPassCoworkingProduct();
            if (r.action === 'error') throw new Error(`Day Pass Coworking product initialization failed (${r.action})`);
            return r;
          }, 'Day Pass Coworking product'))
          .then((result) => { logger.info(`[Stripe] Day Pass Coworking product ${result.action}`, { extra: { action: result.action } }); })
          .catch((err: unknown) => {
            logger.error('[Stripe] Day Pass Coworking setup failed', { error: err instanceof Error ? err : new Error(String(err)) });
            startupHealth.warnings.push(`Stripe product init: Day Pass Coworking - ${getErrorMessage(err)}`);
          })
      );

      productInitPromises.push(
        import('../core/stripe/products.js')
          .then(({ ensureDayPassGolfSimProduct }) => retryWithBackoff(async () => {
            const r = await ensureDayPassGolfSimProduct();
            if (r.action === 'error') throw new Error(`Day Pass Golf Sim product initialization failed (${r.action})`);
            return r;
          }, 'Day Pass Golf Sim product'))
          .then((result) => { logger.info(`[Stripe] Day Pass Golf Sim product ${result.action}`, { extra: { action: result.action } }); })
          .catch((err: unknown) => {
            logger.error('[Stripe] Day Pass Golf Sim setup failed', { error: err instanceof Error ? err : new Error(String(err)) });
            startupHealth.warnings.push(`Stripe product init: Day Pass Golf Sim - ${getErrorMessage(err)}`);
          })
      );

      productInitPromises.push(
        import('../core/stripe/products.js')
          .then(({ ensureCorporateVolumePricingProduct }) => retryWithBackoff(async () => {
            const r = await ensureCorporateVolumePricingProduct();
            if (r.action === 'error') throw new Error(`Corporate Volume Pricing product initialization failed (${r.action})`);
            return r;
          }, 'Corporate Volume Pricing product'))
          .then((result) => { logger.info(`[Stripe] Corporate Volume Pricing product ${result.action}`, { extra: { action: result.action } }); })
          .catch((err: unknown) => {
            logger.error('[Stripe] Corporate Volume Pricing setup failed', { error: err instanceof Error ? err : new Error(String(err)) });
            startupHealth.warnings.push(`Stripe product init: Corporate Volume Pricing - ${getErrorMessage(err)}`);
          })
      );
      
      import('../core/stripe/products.js')
        .then(({ pullCorporateVolumePricingFromStripe }) => retryWithBackoff(() => pullCorporateVolumePricingFromStripe(), 'Corporate pricing pull'))
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
    const { successCount, total } = await enableRealtimeWithRetry();
    if (successCount === total) {
      startupHealth.realtime = 'ok';
    } else if (successCount > 0) {
      startupHealth.realtime = 'ok';
      startupHealth.warnings.push(`Supabase realtime: only ${successCount}/${total} tables enabled`);
    } else {
      startupHealth.realtime = 'failed';
      startupHealth.warnings.push('Supabase realtime: no tables enabled - recovery scheduled');
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

  try {
    const mismatchedSessions = await db.execute(sql`
      SELECT active_br.session_id,
             active_br.user_id AS correct_user_id,
             active_br.user_name AS correct_user_name,
             active_br.user_email AS correct_user_email,
             active_br.request_participants,
             active_br.start_time,
             active_br.end_time
      FROM booking_requests active_br
      JOIN booking_participants bp
        ON bp.session_id = active_br.session_id
        AND bp.participant_type = 'owner'
      WHERE active_br.status NOT IN ('cancelled', 'deleted', 'declined')
        AND bp.user_id IS DISTINCT FROM active_br.user_id
        AND active_br.user_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM booking_requests cancelled_br
          WHERE cancelled_br.session_id = active_br.session_id
            AND cancelled_br.status IN ('cancelled', 'deleted', 'declined')
            AND cancelled_br.id != active_br.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM booking_requests other_active
          WHERE other_active.session_id = active_br.session_id
            AND other_active.status NOT IN ('cancelled', 'deleted', 'declined')
            AND other_active.id != active_br.id
        )
    `);

    const rows = mismatchedSessions.rows as Array<{
      session_id: number;
      correct_user_id: string;
      correct_user_name: string;
      correct_user_email: string;
      request_participants: Array<{ email?: string; type?: string; name?: string; userId?: string }> | null;
      start_time: string;
      end_time: string;
    }>;

    if (rows.length > 0) {
      let fixedCount = 0;
      for (const row of rows) {
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql`DELETE FROM booking_participants WHERE session_id = ${row.session_id}`);

            let slotDuration = 60;
            try {
              const [sH, sM] = row.start_time.split(':').map(Number);
              const [eH, eM] = row.end_time.split(':').map(Number);
              slotDuration = (eH * 60 + eM) - (sH * 60 + sM);
              if (slotDuration <= 0) slotDuration = 60;
            } catch (_) { /* ignored */ }

            await tx.execute(sql`
              INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, slot_duration, payment_status, invited_at)
              VALUES (${row.session_id}, ${row.correct_user_id}, 'owner', ${row.correct_user_name || row.correct_user_email}, ${slotDuration}, 'pending', NOW())
            `);

            const requestParticipants = row.request_participants;
            if (requestParticipants && Array.isArray(requestParticipants)) {
              const ownerEmail = row.correct_user_email?.toLowerCase();
              for (const rp of requestParticipants) {
                if (!rp || typeof rp !== 'object') continue;
                const rpEmail = rp.email?.toLowerCase()?.trim() || '';
                if (rpEmail && rpEmail === ownerEmail) continue;
                if (rp.userId && rp.userId === row.correct_user_id) continue;

                let resolvedUserId: string | null = rp.userId || null;
                let resolvedName = rp.name || rpEmail || 'Participant';
                let participantType = rp.type === 'member' ? 'member' : 'guest';

                if (!resolvedUserId && rpEmail) {
                  const userLookup = await tx.execute(sql`
                    SELECT id, first_name, last_name FROM users WHERE LOWER(email) = ${rpEmail} LIMIT 1
                  `);
                  const found = (userLookup.rows as Array<{ id: string; first_name?: string; last_name?: string }>)[0];
                  if (found) {
                    resolvedUserId = found.id;
                    participantType = 'member';
                    const fullName = [found.first_name, found.last_name].filter(Boolean).join(' ');
                    if (fullName) resolvedName = fullName;
                  }
                }

                await tx.execute(sql`
                  INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, slot_duration, payment_status, invited_at)
                  VALUES (${row.session_id}, ${resolvedUserId}, ${participantType}, ${resolvedName}, ${slotDuration}, 'pending', NOW())
                `);
              }
            }
          });
          fixedCount++;
          logger.info(`[Startup] Rebuilt participants for session ${row.session_id} (owner: ${row.correct_user_name})`);
        } catch (sessionErr: unknown) {
          logger.warn(`[Startup] Failed to rebuild participants for session ${row.session_id} (non-critical)`, { error: sessionErr instanceof Error ? sessionErr : new Error(String(sessionErr)) });
        }
      }
      if (fixedCount > 0) {
        logger.info(`[Startup] Fixed ${fixedCount} session(s) with mismatched owners from cancelled booking reuse`);
      }
    }
  } catch (err: unknown) {
    logger.warn('[Startup] Session owner mismatch fix failed (non-critical)', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  try {
    const { cleanupLessonClosures } = await import('../core/databaseCleanup');
    const deactivated = await cleanupLessonClosures();
    if (deactivated > 0) {
      logger.info(`[Startup] Deactivated ${deactivated} past lesson closures`);
    }
  } catch (err: unknown) {
    logger.warn('[Startup] Lesson closures cleanup failed (non-critical)', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  try {
    const deadItems = await db.execute(sql`
      SELECT id, payload FROM hubspot_sync_queue
      WHERE status = 'dead' AND operation = 'sync_tier'
        AND last_error LIKE '%was not one of the allowed options%'
    `);
    const rows = (deadItems as unknown as { rows: Array<{ id: number; payload: string }> }).rows;
    if (rows.length > 0) {
      const { enqueueHubSpotSync } = await import('../core/hubspot/queue');
      for (const row of rows) {
        try {
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          if (!payload?.email || typeof payload.email !== 'string') {
            logger.warn(`[Startup] Dead HubSpot job #${row.id} has no valid email in payload, skipping`);
            continue;
          }
          const emailKey = (payload.email as string).toLowerCase();
          const newJobId = await enqueueHubSpotSync('sync_tier', payload, {
            priority: 2,
            idempotencyKey: `requeue_dead_tier_sync_${emailKey}_${row.id}`,
            maxRetries: 5
          });
          if (newJobId !== null) {
            await db.execute(sql`UPDATE hubspot_sync_queue SET status = 'superseded', completed_at = NOW() WHERE id = ${row.id}`);
            logger.info(`[Startup] Re-queued dead HubSpot sync_tier job #${row.id} as #${newJobId} for ${emailKey}`);
          } else {
            logger.info(`[Startup] Dead HubSpot sync_tier job #${row.id} already re-queued, marking superseded`);
            await db.execute(sql`UPDATE hubspot_sync_queue SET status = 'superseded', completed_at = NOW() WHERE id = ${row.id}`);
          }
        } catch (rowErr: unknown) {
          logger.warn(`[Startup] Failed to re-queue dead HubSpot job #${row.id}, leaving as dead for manual review`, { error: rowErr instanceof Error ? rowErr : new Error(String(rowErr)) });
        }
      }
    }
  } catch (err: unknown) {
    logger.warn('[Startup] HubSpot dead queue re-queue failed (non-critical)', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  try {
    const linkedResult = await db.execute(sql`
      UPDATE booking_requests br
      SET 
        user_email = u.email,
        user_id = u.id,
        updated_at = NOW()
      FROM user_linked_emails ule
      JOIN users u ON LOWER(u.email) = LOWER(ule.primary_email) AND u.archived_at IS NULL
      WHERE LOWER(br.user_email) = LOWER(ule.linked_email)
        AND LOWER(br.user_email) != LOWER(u.email)
      RETURNING br.id, br.user_email AS new_email, ule.linked_email AS old_email
    `);
    const manualResult = await db.execute(sql`
      UPDATE booking_requests br
      SET
        user_email = u.email,
        user_id = u.id,
        updated_at = NOW()
      FROM users u
      WHERE u.archived_at IS NULL
        AND u.manually_linked_emails IS NOT NULL
        AND u.manually_linked_emails @> to_jsonb(LOWER(br.user_email))
        AND LOWER(br.user_email) != LOWER(u.email)
      RETURNING br.id, br.user_email AS new_email
    `);
    const totalFixed = (linkedResult.rows?.length || 0) + (manualResult.rows?.length || 0);
    if (totalFixed > 0) {
      logger.info(`[Startup] Repaired ${totalFixed} bookings stored under linked emails`, { extra: { linkedFixed: linkedResult.rows?.length || 0, manualFixed: manualResult.rows?.length || 0 } });
    }
  } catch (err: unknown) {
    logger.warn('[Startup] Linked email booking repair failed (non-critical)', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  startupHealth.completedAt = new Date().toISOString();
  
  if (startupHealth.criticalFailures.length > 0) {
    logger.error('[Startup] CRITICAL FAILURES', { extra: { failures: startupHealth.criticalFailures } });
  }
  if (startupHealth.warnings.length > 0) {
    logger.warn('[Startup] Warnings', { extra: { warnings: startupHealth.warnings } });
  }
}

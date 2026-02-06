import { ensureDatabaseConstraints, seedDefaultNoticeTypes, createStripeTransactionCache, setupEmailNormalization, normalizeExistingEmails, cleanupOrphanedRecords, seedTierFeatures } from '../db-init';
import { seedTrainingSections } from '../routes/training';
import { getStripeSync } from '../core/stripe';
import { runMigrations } from 'stripe-replit-sync';
import { enableRealtimeForTable } from '../core/supabase/client';
import { initMemberSyncSettings } from '../core/memberSync';

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
  console.log('[Startup] Running deferred database initialization...');
  
  try {
    await ensureDatabaseConstraints();
    console.log('[Startup] Database constraints initialized successfully');
    startupHealth.database = 'ok';
  } catch (err: any) {
    console.error('[Startup] Database constraints failed:', err);
    startupHealth.database = 'failed';
    startupHealth.criticalFailures.push(`Database constraints: ${err.message}`);
  }

  try {
    await setupEmailNormalization();
    const { updated } = await normalizeExistingEmails();
    if (updated > 0) {
      console.log(`[Startup] Normalized ${updated} existing email records`);
    }
  } catch (err: any) {
    console.error('[Startup] Email normalization failed:', err);
    startupHealth.warnings.push(`Email normalization: ${err.message}`);
  }
  
  try {
    await seedDefaultNoticeTypes();
  } catch (err: any) {
    console.error('[Startup] Seeding notice types failed:', err);
    startupHealth.warnings.push(`Notice types: ${err.message}`);
  }

  try {
    await seedTierFeatures();
  } catch (err: any) {
    console.error('[Startup] Seeding tier features failed:', err);
    startupHealth.warnings.push(`Tier features: ${err.message}`);
  }

  try {
    await initMemberSyncSettings();
  } catch (err: any) {
    console.error('[Startup] Member sync settings init failed:', err);
    startupHealth.warnings.push(`Member sync settings: ${err.message}`);
  }

  try {
    await seedTrainingSections();
    console.log('[Startup] Training sections synced');
  } catch (err: any) {
    console.error('[Startup] Seeding training sections failed:', err);
    startupHealth.warnings.push(`Training sections: ${err.message}`);
  }

  try {
    await createStripeTransactionCache();
  } catch (err: any) {
    console.error('[Startup] Creating stripe transaction cache failed:', err);
    startupHealth.warnings.push(`Stripe transaction cache: ${err.message}`);
  }

  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
      console.log('[Stripe] Initializing Stripe schema...');
      await runMigrations({ databaseUrl, schema: 'stripe' });
      console.log('[Stripe] Schema ready');

      const stripeSync = await getStripeSync();
      
      const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
      if (replitDomains) {
        const webhookUrl = `https://${replitDomains}/api/stripe/webhook`;
        console.log('[Stripe] Setting up managed webhook...');
        await stripeSync.findOrCreateManagedWebhook(webhookUrl);
        console.log('[Stripe] Webhook configured');
      }
      
      startupHealth.stripe = 'ok';

      stripeSync.syncBackfill()
        .then(() => console.log('[Stripe] Data sync complete'))
        .catch((err: any) => {
          console.error('[Stripe] Data sync error:', err.message);
          startupHealth.warnings.push(`Stripe backfill: ${err.message}`);
        });
      
      import('../core/stripe/groupBilling.js')
        .then(({ getOrCreateFamilyCoupon }) => getOrCreateFamilyCoupon())
        .then(() => console.log('[Stripe] FAMILY20 coupon ready'))
        .catch((err: any) => console.error('[Stripe] FAMILY20 coupon setup failed:', err.message));
      
      import('../core/stripe/products.js')
        .then(({ ensureSimulatorOverageProduct }) => ensureSimulatorOverageProduct())
        .then((result) => console.log(`[Stripe] Simulator Overage product ${result.action}`))
        .catch((err: any) => console.error('[Stripe] Simulator Overage setup failed:', err.message));
      
      import('../core/stripe/products.js')
        .then(({ ensureCorporateVolumePricingProduct }) => ensureCorporateVolumePricingProduct())
        .then((result) => console.log(`[Stripe] Corporate Volume Pricing product ${result.action}`))
        .catch((err: any) => console.error('[Stripe] Corporate Volume Pricing setup failed:', err.message));
      
      import('../core/stripe/products.js')
        .then(({ pullCorporateVolumePricingFromStripe }) => pullCorporateVolumePricingFromStripe())
        .then((pulled) => console.log(`[Stripe] Corporate pricing ${pulled ? 'pulled from Stripe' : 'using defaults'}`))
        .catch((err: any) => console.error('[Stripe] Corporate pricing pull failed:', err.message));
      
      import('../core/stripe/customerSync.js')
        .then(({ syncStripeCustomersForMindBodyMembers }) => syncStripeCustomersForMindBodyMembers())
        .then((result) => {
          if (result.created > 0 || result.linked > 0) {
            console.log(`[Stripe] Customer sync: created=${result.created}, linked=${result.linked}`);
          }
        })
        .catch((err: any) => console.error('[Stripe] Customer sync failed:', err.message));
    }
  } catch (err: any) {
    console.error('[Stripe] Initialization failed:', err.message);
    startupHealth.stripe = 'failed';
    startupHealth.criticalFailures.push(`Stripe initialization: ${err.message}`);
  }

  try {
    console.log('[Supabase] Enabling realtime for tables...');
    const realtimeResults = await Promise.all([
      enableRealtimeForTable('notifications'),
      enableRealtimeForTable('booking_sessions'),
      enableRealtimeForTable('announcements')
    ]);
    const successCount = realtimeResults.filter(Boolean).length;
    if (successCount === realtimeResults.length) {
      console.log('[Supabase] Realtime enabled for notifications, booking_sessions, announcements');
      startupHealth.realtime = 'ok';
    } else if (successCount > 0) {
      console.warn(`[Supabase] Realtime partially enabled (${successCount}/${realtimeResults.length} tables)`);
      startupHealth.realtime = 'ok';
      startupHealth.warnings.push(`Supabase realtime: only ${successCount}/${realtimeResults.length} tables enabled`);
    } else {
      console.warn('[Supabase] Realtime not enabled for any tables - check Supabase configuration');
      startupHealth.realtime = 'failed';
      startupHealth.warnings.push('Supabase realtime: no tables enabled - check configuration');
    }
  } catch (err: any) {
    console.error('[Supabase] Realtime setup failed:', err.message);
    startupHealth.realtime = 'failed';
    startupHealth.warnings.push(`Supabase realtime: ${err.message}`);
  }
  
  startupHealth.completedAt = new Date().toISOString();
  
  if (startupHealth.criticalFailures.length > 0) {
    console.error('[Startup] CRITICAL FAILURES:', startupHealth.criticalFailures);
  }
  if (startupHealth.warnings.length > 0) {
    console.warn('[Startup] Warnings:', startupHealth.warnings);
  }
}

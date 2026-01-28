import { ensureDatabaseConstraints, seedDefaultNoticeTypes, createStripeTransactionCache } from '../db-init';
import { seedTrainingSections } from '../routes/training';
import { getStripeSync } from '../core/stripe';
import { runMigrations } from 'stripe-replit-sync';
import { enableRealtimeForTable } from '../core/supabase/client';
import { initMemberSyncSettings } from '../core/memberSync';

export async function runStartupTasks(): Promise<void> {
  console.log('[Startup] Running deferred database initialization...');
  
  try {
    await ensureDatabaseConstraints();
    console.log('[Startup] Database constraints initialized successfully');
  } catch (err) {
    console.error('[Startup] Database constraints failed (non-fatal):', err);
  }
  
  try {
    await seedDefaultNoticeTypes();
  } catch (err) {
    console.error('[Startup] Seeding notice types failed (non-fatal):', err);
  }

  try {
    await initMemberSyncSettings();
  } catch (err) {
    console.error('[Startup] Member sync settings init failed (non-fatal):', err);
  }

  try {
    await seedTrainingSections();
    console.log('[Startup] Training sections synced');
  } catch (err) {
    console.error('[Startup] Seeding training sections failed (non-fatal):', err);
  }

  try {
    await createStripeTransactionCache();
  } catch (err) {
    console.error('[Startup] Creating stripe transaction cache failed (non-fatal):', err);
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

      stripeSync.syncBackfill()
        .then(() => console.log('[Stripe] Data sync complete'))
        .catch((err: any) => console.error('[Stripe] Data sync error:', err.message));
      
      import('../core/stripe/groupBilling.js')
        .then(({ getOrCreateFamilyCoupon }) => getOrCreateFamilyCoupon())
        .then(() => console.log('[Stripe] FAMILY20 coupon ready'))
        .catch((err: any) => console.error('[Stripe] FAMILY20 coupon setup failed:', err.message));
      
      import('../core/stripe/products.js')
        .then(({ ensureSimulatorOverageProduct }) => ensureSimulatorOverageProduct())
        .then((result) => console.log(`[Stripe] Simulator Overage product ${result.action}`))
        .catch((err: any) => console.error('[Stripe] Simulator Overage setup failed:', err.message));
      
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
    console.error('[Stripe] Initialization failed (non-fatal):', err.message);
  }

  try {
    console.log('[Supabase] Enabling realtime for tables...');
    await enableRealtimeForTable('notifications');
    await enableRealtimeForTable('booking_sessions');
    await enableRealtimeForTable('announcements');
    console.log('[Supabase] Realtime enabled for notifications, booking_sessions, announcements');
  } catch (err: any) {
    console.error('[Supabase] Realtime setup failed (non-fatal):', err.message);
  }
}

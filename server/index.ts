process.env.TZ = 'America/Los_Angeles';

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import expressStaticGzip from 'express-static-gzip';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
// CSRF protection removed - SameSite cookies + CORS provide sufficient protection for SPA
import { globalRateLimiter } from './middleware/rateLimiting';
import { getSession, registerAuthRoutes } from './replit_integrations/auth';
import { setupSupabaseAuthRoutes } from './supabase/auth';
import { isProduction, pool } from './core/db';
import { requestIdMiddleware, logRequest } from './core/logger';
import { db } from './db';

import resourcesRouter from './routes/resources';
import calendarRouter from './routes/calendar';
import eventsRouter from './routes/events';
import authRouter from './routes/auth';
import hubspotRouter from './routes/hubspot';
import hubspotDealsRouter from './routes/hubspotDeals';
import membersRouter from './routes/members';
import usersRouter from './routes/users';
import wellnessRouter from './routes/wellness';
import guestPassesRouter from './routes/guestPasses';
import passesRouter from './routes/passes';
import baysRouter from './routes/bays';
import notificationsRouter from './routes/notifications';
import pushRouter from './routes/push';
import availabilityRouter from './routes/availability';
import cafeRouter from './routes/cafe';
import galleryRouter from './routes/gallery';
import announcementsRouter from './routes/announcements';
import faqsRouter from './routes/faqs';
import inquiriesRouter from './routes/inquiries';
import imageUploadRouter from './routes/imageUpload';
import closuresRouter from './routes/closures';
import membershipTiersRouter from './routes/membershipTiers';
import trainingRouter, { seedTrainingSections } from './routes/training';
import toursRouter from './routes/tours';
import bugReportsRouter from './routes/bugReports';
import trackmanRouter from './routes/trackman';
import trackmanWebhookRouter from './routes/trackmanWebhook';
import noticesRouter from './routes/notices';
import testAuthRouter from './routes/testAuth';
import rosterRouter from './routes/roster';
import staffCheckinRouter from './routes/staffCheckin';
import dataIntegrityRouter from './routes/dataIntegrity';
import dataToolsRouter from './routes/dataTools';
import legacyPurchasesRouter from './routes/legacyPurchases';
import mindbodyRouter from './routes/mindbody';
import settingsRouter from './routes/settings';
import stripeRouter from './routes/stripe';
import waiversRouter from './routes/waivers';
import groupBillingRouter from './routes/groupBilling';
import memberBillingRouter from './routes/memberBilling';
import myBillingRouter from './routes/myBilling';
import checkoutRouter from './routes/checkout';
import dayPassesRouter from './routes/dayPasses';
import financialsRouter from './routes/financials';
import accountRouter from './routes/account';
import dataExportRouter from './routes/dataExport';
import { registerObjectStorageRoutes } from './replit_integrations/object_storage';
import { ensureDatabaseConstraints, seedDefaultNoticeTypes, createStripeTransactionCache } from './db-init';
import { initWebSocketServer } from './core/websocket';
import { startIntegrityScheduler } from './schedulers/integrityScheduler';
import { startWaiverReviewScheduler } from './schedulers/waiverReviewScheduler';
import { startStripeReconciliationScheduler } from './schedulers/stripeReconciliationScheduler';
import { startGracePeriodScheduler } from './schedulers/gracePeriodScheduler';
import { startBookingExpiryScheduler } from './schedulers/bookingExpiryScheduler';
import { startBackgroundSyncScheduler } from './schedulers/backgroundSyncScheduler';
import { startDailyReminderScheduler } from './schedulers/dailyReminderScheduler';
import { startMorningClosureScheduler } from './schedulers/morningClosureScheduler';
import { startWeeklyCleanupScheduler } from './schedulers/weeklyCleanupScheduler';
import { startInviteExpiryScheduler } from './schedulers/inviteExpiryScheduler';
import { startCommunicationLogsScheduler } from './schedulers/communicationLogsScheduler';
import { startWebhookLogCleanupScheduler } from './schedulers/webhookLogCleanupScheduler';
import { startSessionCleanupScheduler } from './schedulers/sessionCleanupScheduler';
import { startUnresolvedTrackmanScheduler } from './schedulers/unresolvedTrackmanScheduler';
import { processStripeWebhook, getStripeSync } from './core/stripe';
import { runMigrations } from 'stripe-replit-sync';
import { enableRealtimeForTable } from './core/supabase/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Health check MUST be first, before any middleware, for fast deployment health checks
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Fast root endpoint for health checks in production (before static middleware)
// Only return JSON for explicit health check probes, not browser requests
app.get('/', (req, res, next) => {
  if (!isProduction) {
    return next();
  }
  
  const acceptHeader = req.get('Accept') || '';
  const userAgent = req.get('User-Agent') || '';
  
  // Check if this looks like a browser request
  const wantsHtml = acceptHeader.includes('text/html');
  const acceptsAnything = acceptHeader.includes('*/*');
  const hasBrowserUserAgent = userAgent.includes('Mozilla') || 
                               userAgent.includes('Safari') || 
                               userAgent.includes('Chrome') ||
                               userAgent.includes('Edge') ||
                               userAgent.includes('Firefox');
  
  // Serve SPA if: explicitly wants HTML, accepts anything, or has browser user agent
  // Only return health check JSON for automated probes (no browser UA, no Accept header)
  if (wantsHtml || acceptsAnything || hasBrowserUserAgent) {
    return next();
  }
  
  // Automated health check probe - return quick JSON
  return res.status(200).json({ status: 'ok', service: 'even-house-staff-portal' });
});

app.set('trust proxy', 1);

type CorsCallback = (err: Error | null, allow?: boolean) => void;
type CorsOriginFunction = (origin: string | undefined, callback: CorsCallback) => void;

const getAllowedOrigins = (): string[] | boolean | CorsOriginFunction => {
  if (!isProduction) {
    return true;
  }
  const origins = process.env.ALLOWED_ORIGINS;
  if (origins && origins.trim()) {
    return origins.split(',').map(o => o.trim()).filter(Boolean);
  }
  const replitDomain = process.env.REPLIT_DEV_DOMAIN;
  if (replitDomain) {
    return [`https://${replitDomain}`, `https://${replitDomain.replace('-00-', '-')}`];
  }
  // In production, frontend and API are same-origin (served from same Express server)
  // Return function to dynamically check origin - allow same-origin, Replit domains, and mobile apps
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (same-origin, server-to-server, mobile apps)
    if (!origin) {
      callback(null, true);
      return;
    }
    
    // Allow Expo Go app (exp:// protocol)
    if (origin.startsWith('exp://')) {
      callback(null, true);
      return;
    }
    
    try {
      const url = new URL(origin);
      const hostname = url.hostname;
      // Allow Replit deployment domains (strict hostname suffix matching)
      if (hostname.endsWith('.replit.app') || hostname.endsWith('.replit.dev') || hostname.endsWith('.repl.co')) {
        callback(null, true);
        return;
      }
      // Allow localhost for testing (including Expo dev server on port 8081)
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        callback(null, true);
        return;
      }
    } catch {
      // Invalid URL (like exp://), already handled above
    }
    callback(new Error('Not allowed by CORS'));
  };
};

const corsOptions = {
  origin: getAllowedOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Extend Express Request to include rawBody for webhook signature validation
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

app.use(requestIdMiddleware);
app.use(logRequest);
app.use(cors(corsOptions));
app.use(compression());

// STRIPE WEBHOOK - Must be registered BEFORE express.json() to receive raw Buffer
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature' });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error('[Stripe Webhook] req.body is not a Buffer - express.json() may have run first');
        return res.status(500).json({ error: 'Webhook processing error' });
      }

      await processStripeWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error('[Stripe Webhook] Error:', error.message);
      
      if (error.message?.includes('signature') || error.message?.includes('payload') || error.type === 'StripeSignatureVerificationError') {
        return res.status(400).json({ error: 'Invalid request' });
      }
      
      res.status(500).json({ error: 'Server processing error' });
    }
  }
);

// Capture raw body for HubSpot webhook signature validation
app.use(express.json({ 
  limit: '1mb',
  verify: (req: any, res, buf) => {
    // Only store raw body for webhook endpoints that need signature validation
    if (req.originalUrl?.includes('/webhooks') || req.url?.includes('/webhooks')) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(express.urlencoded({ limit: '1mb' }));
app.use(getSession());
app.use(globalRateLimiter);
// CSRF middleware removed - SameSite cookies + CORS provide sufficient protection for SPA

app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time');
    const isAuthenticated = req.session?.user?.isStaff === true;
    
    const baseResponse = {
      status: 'ok',
      database: 'connected',
      timestamp: dbResult.rows[0].time
    };
    
    if (isAuthenticated) {
      const resourceCount = await pool.query('SELECT COUNT(*) as count FROM resources');
      const resourceTypes = await pool.query('SELECT type, COUNT(*) as count FROM resources GROUP BY type');
      res.json({
        ...baseResponse,
        environment: isProduction ? 'production' : 'development',
        resourceCount: parseInt(resourceCount.rows[0].count),
        resourcesByType: resourceTypes.rows,
        databaseUrl: process.env.DATABASE_URL ? 'configured' : 'missing'
      });
    } else {
      res.json(baseResponse);
    }
  } catch (error: any) {
    const isAuthenticated = req.session?.user?.isStaff === true;
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      ...(isAuthenticated && { error: error.message })
    });
  }
});

if (isProduction) {
  app.use(expressStaticGzip(path.join(__dirname, '../dist'), {
    enableBrotli: true,
    orderPreference: ['br', 'gz'],
    serveStatic: {
      maxAge: '1y',
      immutable: true,
      etag: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      }
    }
  }));
} else {
  // In development, redirect root to Vite dev server (port 5000) for mobile preview
  app.get('/', (req, res) => {
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    if (devDomain) {
      // Redirect to Vite dev server via Replit proxy
      res.redirect(`https://${devDomain}`);
    } else {
      res.send('API Server running. Frontend is at port 5000.');
    }
  });
}

// Rate limiting for login endpoint (strict - protects against brute-force attacks)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP
  message: { error: 'Too many login attempts, please try again later' }
});
app.use('/api/auth/login', loginLimiter);

// Rate limiting for general API (broader protection)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300 // 300 requests per 15 min
});
app.use('/api/', apiLimiter);

app.use(resourcesRouter);
app.use(calendarRouter);
app.use(eventsRouter);
app.use(authRouter);
app.use('/api/auth', testAuthRouter);
app.use(hubspotRouter);
app.use(hubspotDealsRouter);
app.use(accountRouter);
app.use(dataExportRouter);
app.use(membersRouter);
app.use(usersRouter);
app.use(wellnessRouter);
app.use(guestPassesRouter);
app.use(passesRouter);
app.use(baysRouter);
app.use(notificationsRouter);
app.use(pushRouter);
app.use(availabilityRouter);
app.use(cafeRouter);
app.use(galleryRouter);
app.use(announcementsRouter);
app.use(faqsRouter);
app.use(inquiriesRouter);
app.use(imageUploadRouter);
app.use(closuresRouter);
app.use(membershipTiersRouter);
app.use(trainingRouter);
app.use(toursRouter);
app.use(bugReportsRouter);
app.use(trackmanRouter);
app.use(trackmanWebhookRouter);
app.use(noticesRouter);
app.use(rosterRouter);
app.use(staffCheckinRouter);
app.use(dataIntegrityRouter);
app.use(dataToolsRouter);
app.use(legacyPurchasesRouter);
app.use(mindbodyRouter);
app.use(settingsRouter);
app.use(stripeRouter);
app.use(waiversRouter);
app.use(groupBillingRouter);
app.use(memberBillingRouter);
app.use(myBillingRouter);
app.use(checkoutRouter);
app.use(dayPassesRouter);
app.use(financialsRouter);
registerObjectStorageRoutes(app);

// SPA catch-all using middleware (avoids Express 5 path-to-regexp issues)
if (isProduction) {
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/healthz')) {
      return res.sendFile(path.join(__dirname, '../dist/index.html'));
    }
    next();
  });
}

async function autoSeedResources() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM resources');
    const count = parseInt(result.rows[0].count);
    
    if (count === 0) {
      if (!isProduction) console.log('Auto-seeding resources...');
      const resources = [
        { name: 'Simulator Bay 1', type: 'simulator', description: 'TrackMan Simulator Bay 1', capacity: 6 },
        { name: 'Simulator Bay 2', type: 'simulator', description: 'TrackMan Simulator Bay 2', capacity: 6 },
        { name: 'Simulator Bay 3', type: 'simulator', description: 'TrackMan Simulator Bay 3', capacity: 6 },
        { name: 'Simulator Bay 4', type: 'simulator', description: 'TrackMan Simulator Bay 4', capacity: 6 },
        { name: 'Conference Room', type: 'conference_room', description: 'Main conference room with AV setup', capacity: 12 },
      ];

      for (const resource of resources) {
        await pool.query(
          `INSERT INTO resources (name, type, description, capacity) 
           VALUES ($1, $2, $3, $4) 
           ON CONFLICT DO NOTHING`,
          [resource.name, resource.type, resource.description, resource.capacity]
        );
      }
      if (!isProduction) console.log(`Auto-seeded ${resources.length} resources`);
    }
  } catch (error) {
    if (!isProduction) console.log('Resources table may not exist yet, skipping auto-seed');
  }
}

async function autoSeedCafeMenu() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM cafe_items');
    const count = parseInt(result.rows[0].count);
    
    if (count === 0) {
      if (!isProduction) console.log('Auto-seeding cafe menu...');
      const cafeItems = [
        // Breakfast - House Toasts
        { category: 'Breakfast', name: 'Egg Toast', price: 14, description: 'Schaner Farm scrambled eggs, whipped ricotta, chives, micro greens, toasted country batard', icon: 'egg_alt', sort_order: 1 },
        { category: 'Breakfast', name: 'Avocado Toast', price: 16, description: 'Hass smashed avocado, radish, lemon, micro greens, dill, toasted country batard', icon: 'eco', sort_order: 2 },
        { category: 'Breakfast', name: 'Banana & Honey Toast', price: 14, description: 'Banana, whipped ricotta, Hapa Honey Farm local honey, toasted country batard', icon: 'bakery_dining', sort_order: 3 },
        { category: 'Breakfast', name: 'Smoked Salmon Toast', price: 20, description: 'Alaskan king smoked salmon, whipped cream cheese, dill, capers, lemon, micro greens, toasted country batard', icon: 'set_meal', sort_order: 4 },
        { category: 'Breakfast', name: 'Breakfast Croissant', price: 16, description: 'Schaner Farm eggs, New School american cheese, freshly baked croissant, choice of cured ham or applewood smoked bacon', icon: 'bakery_dining', sort_order: 5 },
        { category: 'Breakfast', name: 'French Omelette', price: 14, description: 'Schaner Farm eggs, cultured butter, fresh herbs, served with side of seasonal salad greens', icon: 'egg', sort_order: 6 },
        { category: 'Breakfast', name: 'Hanger Steak & Eggs', price: 24, description: 'Autonomy Farms Hanger steak, Schaner Farm eggs, cooked your way', icon: 'restaurant', sort_order: 7 },
        { category: 'Breakfast', name: 'Bacon & Eggs', price: 14, description: 'Applewood smoked bacon, Schaner Farm eggs, cooked your way', icon: 'egg_alt', sort_order: 8 },
        { category: 'Breakfast', name: 'Yogurt Parfait', price: 14, description: 'Yogurt, seasonal fruits, farmstead granola, Hapa Honey farm local honey', icon: 'icecream', sort_order: 9 },
        // Sides
        { category: 'Sides', name: 'Bacon, Two Slices', price: 6, description: 'Applewood smoked bacon', icon: 'restaurant', sort_order: 1 },
        { category: 'Sides', name: 'Eggs, Scrambled', price: 8, description: 'Schaner Farm scrambled eggs', icon: 'egg', sort_order: 2 },
        { category: 'Sides', name: 'Seasonal Fruit Bowl', price: 10, description: 'Fresh seasonal fruits', icon: 'nutrition', sort_order: 3 },
        { category: 'Sides', name: 'Smoked Salmon', price: 9, description: 'Alaskan king smoked salmon', icon: 'set_meal', sort_order: 4 },
        { category: 'Sides', name: 'Toast, Two Slices', price: 3, description: 'Toasted country batard', icon: 'bakery_dining', sort_order: 5 },
        { category: 'Sides', name: 'Sqirl Seasonal Jam', price: 3, description: 'Artisan seasonal jam', icon: 'local_florist', sort_order: 6 },
        { category: 'Sides', name: 'Pistachio Spread', price: 4, description: 'House-made pistachio spread', icon: 'spa', sort_order: 7 },
        // Lunch
        { category: 'Lunch', name: 'Caesar Salad', price: 15, description: 'Romaine lettuce, homemade dressing, grated Reggiano. Add: roasted chicken $8, hanger steak 8oz $14', icon: 'local_florist', sort_order: 1 },
        { category: 'Lunch', name: 'Wedge Salad', price: 16, description: 'Iceberg lettuce, bacon, red onion, cherry tomatoes, Point Reyes bleu cheese, homemade dressing', icon: 'local_florist', sort_order: 2 },
        { category: 'Lunch', name: 'Chicken Salad Sandwich', price: 14, description: 'Autonomy Farms chicken, celery, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 3 },
        { category: 'Lunch', name: 'Tuna Salad Sandwich', price: 14, description: 'Wild, pole-caught albacore tuna, sprouts, club chimichurri, toasted pan loaf, served with olive oil potato chips', icon: 'set_meal', sort_order: 4 },
        { category: 'Lunch', name: 'Grilled Cheese', price: 12, description: 'New School american cheese, brioche pan loaf, served with olive oil potato chips. Add: short rib $6, roasted tomato soup cup $7', icon: 'lunch_dining', sort_order: 5 },
        { category: 'Lunch', name: 'Heirloom BLT', price: 18, description: 'Applewood smoked bacon, butter lettuce, heirloom tomatoes, olive oil mayo, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 6 },
        { category: 'Lunch', name: 'Bratwurst', price: 12, description: 'German bratwurst, sautéed onions & peppers, toasted brioche bun', icon: 'lunch_dining', sort_order: 7 },
        { category: 'Lunch', name: 'Bison Serrano Chili', price: 14, description: 'Pasture raised bison, serrano, anaheim, green bell peppers, mint, cilantro, cheddar cheese, sour cream, green onion, served with organic corn chips', icon: 'soup_kitchen', sort_order: 8 },
        // Kids
        { category: 'Kids', name: 'Kids Grilled Cheese', price: 6, description: 'Classic grilled cheese for little ones', icon: 'child_care', sort_order: 1 },
        { category: 'Kids', name: 'Kids Hot Dog', price: 8, description: 'All-beef hot dog', icon: 'child_care', sort_order: 2 },
        // Dessert
        { category: 'Dessert', name: 'Vanilla Bean Gelato Sandwich', price: 6, description: 'Vanilla bean gelato with chocolate chip cookies', icon: 'icecream', sort_order: 1 },
        { category: 'Dessert', name: 'Sea Salt Caramel Gelato Sandwich', price: 6, description: 'Sea salt caramel gelato with snickerdoodle cookies', icon: 'icecream', sort_order: 2 },
        { category: 'Dessert', name: 'Seasonal Pie, Slice', price: 6, description: 'Daily seasonal pie with house made crème', icon: 'cake', sort_order: 3 },
        // Shareables
        { category: 'Shareables', name: 'Club Charcuterie', price: 32, description: 'Selection of cured meats and artisan cheeses', icon: 'tapas', sort_order: 1 },
        { category: 'Shareables', name: 'Chips & Salsa', price: 10, description: 'House-made salsa with organic corn chips', icon: 'tapas', sort_order: 2 },
        { category: 'Shareables', name: 'Caviar Service', price: 0, description: 'Market price - ask your server', icon: 'dining', sort_order: 3 },
        { category: 'Shareables', name: 'Tinned Fish Tray', price: 47, description: 'Premium selection of tinned fish', icon: 'set_meal', sort_order: 4 },
      ];

      for (const item of cafeItems) {
        await pool.query(
          `INSERT INTO cafe_items (category, name, price, description, icon, is_active, sort_order) 
           VALUES ($1, $2, $3, $4, $5, true, $6) 
           ON CONFLICT DO NOTHING`,
          [item.category, item.name, item.price, item.description, item.icon, item.sort_order]
        );
      }
      if (!isProduction) console.log(`Auto-seeded ${cafeItems.length} cafe menu items`);
    }
  } catch (error) {
    if (!isProduction) console.log('Cafe menu table may not exist yet, skipping auto-seed');
  }
}


async function startServer() {
  console.log(`[Startup] Environment: ${isProduction ? 'production' : 'development'}`);
  console.log(`[Startup] DATABASE_URL: ${process.env.DATABASE_URL ? 'configured' : 'MISSING'}`);
  console.log(`[Startup] PORT env: ${process.env.PORT || 'not set'}`);
  
  // Auth routes setup (synchronous, needed before server starts)
  try {
    setupSupabaseAuthRoutes(app);
    registerAuthRoutes(app);
  } catch (err) {
    console.error('[Startup] FATAL: Auth routes setup failed:', err);
    process.exit(1);
  }

  // For Autoscale: use PORT env directly in production (no fallback)
  // In development: fallback to 3001
  const PORT = isProduction 
    ? Number(process.env.PORT) 
    : (Number(process.env.PORT) || 3001);
  
  if (isProduction && !process.env.PORT) {
    console.error('[Startup] FATAL: PORT environment variable required in production');
    process.exit(1);
  }
  
  // START SERVER FIRST - critical for deployment health checks
  // Health check routes (/healthz and /) are already registered at the top of the file
  // and will respond immediately before any heavy operations
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Startup] API Server running on port ${PORT}`);
    console.log(`[Startup] Health check ready - heavy startup tasks will run in 5 seconds`);
  });

  initWebSocketServer(server);

  server.on('error', (err: any) => {
    console.error(`[Startup] Server failed to start:`, err);
    process.exit(1);
  });

  // HEAVY STARTUP TASKS - delayed 5 seconds to ensure health checks pass
  // This ensures the deployment health check can succeed before any database operations
  setTimeout(async () => {
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

    // Initialize Stripe schema and sync
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

        // Sync backfill in background
        stripeSync.syncBackfill()
          .then(() => console.log('[Stripe] Data sync complete'))
          .catch((err: any) => console.error('[Stripe] Data sync error:', err.message));
        
        // Ensure FAMILY20 coupon exists for family billing
        import('./core/stripe/groupBilling.js')
          .then(({ getOrCreateFamilyCoupon }) => getOrCreateFamilyCoupon())
          .then(() => console.log('[Stripe] FAMILY20 coupon ready'))
          .catch((err: any) => console.error('[Stripe] FAMILY20 coupon setup failed:', err.message));
        
        // Ensure Simulator Overage product exists
        import('./core/stripe/products.js')
          .then(({ ensureSimulatorOverageProduct }) => ensureSimulatorOverageProduct())
          .then((result) => console.log(`[Stripe] Simulator Overage product ${result.action}`))
          .catch((err: any) => console.error('[Stripe] Simulator Overage setup failed:', err.message));
        
        // Pre-create Stripe customers for MindBody members (runs in background)
        // This ONLY creates customer records - no subscriptions or billing
        import('./core/stripe/customerSync.js')
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

    // Enable Supabase Realtime for tables that need real-time updates
    try {
      console.log('[Supabase] Enabling realtime for tables...');
      await enableRealtimeForTable('notifications');
      await enableRealtimeForTable('booking_sessions');
      await enableRealtimeForTable('announcements');
      console.log('[Supabase] Realtime enabled for notifications, booking_sessions, announcements');
    } catch (err: any) {
      console.error('[Supabase] Realtime setup failed (non-fatal):', err.message);
    }
  }, 5000);

  // 1. Development-only auto-seeding (resources and cafe menu only)
  // Delayed 30 seconds to ensure server is fully ready
  if (!isProduction) {
    setTimeout(async () => {
      try {
        await autoSeedResources();
      } catch (err) {
        console.error('[Startup] Auto-seed resources failed:', err);
      }
      
      try {
        await autoSeedCafeMenu();
      } catch (err) {
        console.error('[Startup] Auto-seed cafe menu failed:', err);
      }
    }, 30000);
  }

  // Start all schedulers
  startBackgroundSyncScheduler();
  startDailyReminderScheduler();
  startMorningClosureScheduler();
  startWeeklyCleanupScheduler();
  startInviteExpiryScheduler();
  startIntegrityScheduler();
  startWaiverReviewScheduler();
  startStripeReconciliationScheduler();
  startGracePeriodScheduler();
  startBookingExpiryScheduler();
  startCommunicationLogsScheduler();
  startWebhookLogCleanupScheduler();
  startSessionCleanupScheduler();
  startUnresolvedTrackmanScheduler();
}

startServer().catch((err) => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});

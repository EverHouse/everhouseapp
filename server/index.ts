process.env.TZ = 'America/Los_Angeles';

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import expressStaticGzip from 'express-static-gzip';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Server } from 'http';
import { globalRateLimiter } from './middleware/rateLimiting';
import { getSession, registerAuthRoutes } from './replit_integrations/auth';
import { setupSupabaseAuthRoutes } from './supabase/auth';
import { isProduction, pool } from './core/db';
import { requestIdMiddleware, logRequest, logger } from './core/logger';
import { registerRoutes } from './loaders/routes';
import { runStartupTasks, getStartupHealth } from './loaders/startup';
import { initWebSocketServer, closeWebSocketServer } from './core/websocket';

let isShuttingDown = false;

process.on('uncaughtException', (error) => {
  logger.error('[Process] Uncaught Exception:', { error: error.message, stack: error.stack });
  console.error('[Process] Uncaught Exception:', error);
  if (!isShuttingDown) {
    gracefulShutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : undefined;
  logger.error('[Process] Unhandled Rejection:', { error: errorMessage, stack: errorStack });
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', () => {
  console.log('[Process] Received SIGTERM signal');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('[Process] Received SIGINT signal');
  gracefulShutdown('SIGINT');
});
import { startIntegrityScheduler } from './schedulers/integrityScheduler';
import { startWaiverReviewScheduler } from './schedulers/waiverReviewScheduler';
import { startStripeReconciliationScheduler } from './schedulers/stripeReconciliationScheduler';
import { startFeeSnapshotReconciliationScheduler } from './schedulers/feeSnapshotReconciliationScheduler';
import { startGracePeriodScheduler } from './schedulers/gracePeriodScheduler';
import { startBookingExpiryScheduler } from './schedulers/bookingExpiryScheduler';
import { startBackgroundSyncScheduler } from './schedulers/backgroundSyncScheduler';
import { startDailyReminderScheduler } from './schedulers/dailyReminderScheduler';
import { startMorningClosureScheduler } from './schedulers/morningClosureScheduler';
import { startWeeklyCleanupScheduler } from './schedulers/weeklyCleanupScheduler';
import { startInviteExpiryScheduler } from './schedulers/inviteExpiryScheduler';
import { startCommunicationLogsScheduler } from './schedulers/communicationLogsScheduler';
import { startWebhookLogCleanupScheduler } from './schedulers/webhookLogCleanupScheduler';
import { startHubSpotQueueScheduler } from './schedulers/hubspotQueueScheduler';
import { startSessionCleanupScheduler } from './schedulers/sessionCleanupScheduler';
import { startUnresolvedTrackmanScheduler } from './schedulers/unresolvedTrackmanScheduler';
import { startGuestPassResetScheduler } from './schedulers/guestPassResetScheduler';
import { startMemberSyncScheduler } from './schedulers/memberSyncScheduler';
import { startDuplicateCleanupScheduler } from './schedulers/duplicateCleanupScheduler';
import { processStripeWebhook } from './core/stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isReady = false;
let httpServer: Server | null = null;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Shutdown] Already shutting down...');
    return;
  }
  isShuttingDown = true;
  isReady = false;
  
  console.log(`[Shutdown] Starting graceful shutdown (${signal})...`);
  
  const shutdownTimeout = setTimeout(() => {
    console.error('[Shutdown] Timeout exceeded, forcing exit');
    process.exit(1);
  }, 30000);
  
  try {
    closeWebSocketServer();
    console.log('[Shutdown] WebSocket server closed');
    
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => {
          if (err) {
            console.error('[Shutdown] HTTP server close error:', err);
            reject(err);
          } else {
            console.log('[Shutdown] HTTP server closed');
            resolve();
          }
        });
      });
    }
    
    await pool.end();
    console.log('[Shutdown] Database pool closed');
    
    clearTimeout(shutdownTimeout);
    console.log('[Shutdown] Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Shutdown] Error during shutdown:', error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

const app = express();

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/ready', async (req, res) => {
  const startupHealth = getStartupHealth();
  
  if (isShuttingDown) {
    return res.status(503).json({ ready: false, reason: 'shutting_down' });
  }
  
  if (!isReady) {
    return res.status(503).json({ ready: false, reason: 'starting_up', startupHealth });
  }
  
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ 
      ready: true, 
      startupHealth,
      uptime: process.uptime()
    });
  } catch (dbError) {
    res.status(503).json({ 
      ready: false, 
      reason: 'database_unavailable',
      startupHealth
    });
  }
});

app.get('/', (req, res, next) => {
  if (!isProduction) {
    return next();
  }
  
  const acceptHeader = req.get('Accept') || '';
  const userAgent = req.get('User-Agent') || '';
  
  const wantsHtml = acceptHeader.includes('text/html');
  const acceptsAnything = acceptHeader.includes('*/*');
  const hasBrowserUserAgent = userAgent.includes('Mozilla') || 
                               userAgent.includes('Safari') || 
                               userAgent.includes('Chrome') ||
                               userAgent.includes('Edge') ||
                               userAgent.includes('Firefox');
  
  if (wantsHtml || acceptsAnything || hasBrowserUserAgent) {
    return next();
  }
  
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
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    
    if (origin.startsWith('exp://')) {
      callback(null, true);
      return;
    }
    
    try {
      const url = new URL(origin);
      const hostname = url.hostname;
      if (hostname.endsWith('.replit.app') || hostname.endsWith('.replit.dev') || hostname.endsWith('.repl.co')) {
        callback(null, true);
        return;
      }
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        callback(null, true);
        return;
      }
    } catch {
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

app.use(express.json({ 
  limit: '1mb',
  verify: (req: any, res, buf) => {
    if (req.originalUrl?.includes('/webhooks') || req.url?.includes('/webhooks')) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(express.urlencoded({ limit: '1mb' }));
app.use(getSession());
app.use(globalRateLimiter);

app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time');
    const isAuthenticated = req.session?.user?.isStaff === true;
    const startupHealth = getStartupHealth();
    
    const baseResponse = {
      status: 'ok',
      database: 'connected',
      timestamp: dbResult.rows[0].time,
      uptime: process.uptime()
    };
    
    if (isAuthenticated) {
      const { getAlertCounts, getRecentAlerts } = await import('./core/monitoring');
      const alertCounts = getAlertCounts();
      const recentCritical = getRecentAlerts({ severity: 'critical', limit: 5 });
      
      const resourceCount = await pool.query('SELECT COUNT(*) as count FROM resources');
      const resourceTypes = await pool.query('SELECT type, COUNT(*) as count FROM resources GROUP BY type');
      
      res.json({
        ...baseResponse,
        environment: isProduction ? 'production' : 'development',
        resourceCount: parseInt(resourceCount.rows[0].count),
        resourcesByType: resourceTypes.rows,
        databaseUrl: process.env.DATABASE_URL ? 'configured' : 'missing',
        startupHealth,
        alerts: {
          counts: alertCounts,
          recentCritical: recentCritical.map(a => ({
            message: a.message,
            category: a.category,
            timestamp: a.timestamp
          }))
        }
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
  app.get('/', (req, res) => {
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    if (devDomain) {
      res.redirect(`https://${devDomain}`);
    } else {
      res.send('API Server running. Frontend is at port 5000.');
    }
  });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' }
});
app.use('/api/auth/login', loginLimiter);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300
});
app.use('/api/', apiLimiter);

registerRoutes(app);

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
        { category: 'Breakfast', name: 'Egg Toast', price: 14, description: 'Schaner Farm scrambled eggs, whipped ricotta, chives, micro greens, toasted country batard', icon: 'egg_alt', sort_order: 1 },
        { category: 'Breakfast', name: 'Avocado Toast', price: 16, description: 'Hass smashed avocado, radish, lemon, micro greens, dill, toasted country batard', icon: 'eco', sort_order: 2 },
        { category: 'Breakfast', name: 'Banana & Honey Toast', price: 14, description: 'Banana, whipped ricotta, Hapa Honey Farm local honey, toasted country batard', icon: 'bakery_dining', sort_order: 3 },
        { category: 'Breakfast', name: 'Smoked Salmon Toast', price: 20, description: 'Alaskan king smoked salmon, whipped cream cheese, dill, capers, lemon, micro greens, toasted country batard', icon: 'set_meal', sort_order: 4 },
        { category: 'Breakfast', name: 'Breakfast Croissant', price: 16, description: 'Schaner Farm eggs, New School american cheese, freshly baked croissant, choice of cured ham or applewood smoked bacon', icon: 'bakery_dining', sort_order: 5 },
        { category: 'Breakfast', name: 'French Omelette', price: 14, description: 'Schaner Farm eggs, cultured butter, fresh herbs, served with side of seasonal salad greens', icon: 'egg', sort_order: 6 },
        { category: 'Breakfast', name: 'Hanger Steak & Eggs', price: 24, description: 'Autonomy Farms Hanger steak, Schaner Farm eggs, cooked your way', icon: 'restaurant', sort_order: 7 },
        { category: 'Breakfast', name: 'Bacon & Eggs', price: 14, description: 'Applewood smoked bacon, Schaner Farm eggs, cooked your way', icon: 'egg_alt', sort_order: 8 },
        { category: 'Breakfast', name: 'Yogurt Parfait', price: 14, description: 'Yogurt, seasonal fruits, farmstead granola, Hapa Honey farm local honey', icon: 'icecream', sort_order: 9 },
        { category: 'Sides', name: 'Bacon, Two Slices', price: 6, description: 'Applewood smoked bacon', icon: 'restaurant', sort_order: 1 },
        { category: 'Sides', name: 'Eggs, Scrambled', price: 8, description: 'Schaner Farm scrambled eggs', icon: 'egg', sort_order: 2 },
        { category: 'Sides', name: 'Seasonal Fruit Bowl', price: 10, description: 'Fresh seasonal fruits', icon: 'nutrition', sort_order: 3 },
        { category: 'Sides', name: 'Smoked Salmon', price: 9, description: 'Alaskan king smoked salmon', icon: 'set_meal', sort_order: 4 },
        { category: 'Sides', name: 'Toast, Two Slices', price: 3, description: 'Toasted country batard', icon: 'bakery_dining', sort_order: 5 },
        { category: 'Sides', name: 'Sqirl Seasonal Jam', price: 3, description: 'Artisan seasonal jam', icon: 'local_florist', sort_order: 6 },
        { category: 'Sides', name: 'Pistachio Spread', price: 4, description: 'House-made pistachio spread', icon: 'spa', sort_order: 7 },
        { category: 'Lunch', name: 'Caesar Salad', price: 15, description: 'Romaine lettuce, homemade dressing, grated Reggiano. Add: roasted chicken $8, hanger steak 8oz $14', icon: 'local_florist', sort_order: 1 },
        { category: 'Lunch', name: 'Wedge Salad', price: 16, description: 'Iceberg lettuce, bacon, red onion, cherry tomatoes, Point Reyes bleu cheese, homemade dressing', icon: 'local_florist', sort_order: 2 },
        { category: 'Lunch', name: 'Chicken Salad Sandwich', price: 14, description: 'Autonomy Farms chicken, celery, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 3 },
        { category: 'Lunch', name: 'Tuna Salad Sandwich', price: 14, description: 'Wild, pole-caught albacore tuna, sprouts, club chimichurri, toasted pan loaf, served with olive oil potato chips', icon: 'set_meal', sort_order: 4 },
        { category: 'Lunch', name: 'Grilled Cheese', price: 12, description: 'New School american cheese, brioche pan loaf, served with olive oil potato chips. Add: short rib $6, roasted tomato soup cup $7', icon: 'lunch_dining', sort_order: 5 },
        { category: 'Lunch', name: 'Heirloom BLT', price: 18, description: 'Applewood smoked bacon, butter lettuce, heirloom tomatoes, olive oil mayo, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sort_order: 6 },
        { category: 'Lunch', name: 'Bratwurst', price: 12, description: 'German bratwurst, sautéed onions & peppers, toasted brioche bun', icon: 'lunch_dining', sort_order: 7 },
        { category: 'Lunch', name: 'Bison Serrano Chili', price: 14, description: 'Pasture raised bison, serrano, anaheim, green bell peppers, mint, cilantro, cheddar cheese, sour cream, green onion, served with organic corn chips', icon: 'soup_kitchen', sort_order: 8 },
        { category: 'Kids', name: 'Kids Grilled Cheese', price: 6, description: 'Classic grilled cheese for little ones', icon: 'child_care', sort_order: 1 },
        { category: 'Kids', name: 'Kids Hot Dog', price: 8, description: 'All-beef hot dog', icon: 'child_care', sort_order: 2 },
        { category: 'Dessert', name: 'Vanilla Bean Gelato Sandwich', price: 6, description: 'Vanilla bean gelato with chocolate chip cookies', icon: 'icecream', sort_order: 1 },
        { category: 'Dessert', name: 'Sea Salt Caramel Gelato Sandwich', price: 6, description: 'Sea salt caramel gelato with snickerdoodle cookies', icon: 'icecream', sort_order: 2 },
        { category: 'Dessert', name: 'Seasonal Pie, Slice', price: 6, description: 'Daily seasonal pie with house made crème', icon: 'cake', sort_order: 3 },
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
  
  try {
    setupSupabaseAuthRoutes(app);
    registerAuthRoutes(app);
  } catch (err) {
    console.error('[Startup] FATAL: Auth routes setup failed:', err);
    process.exit(1);
  }

  const PORT = isProduction 
    ? Number(process.env.PORT) 
    : (Number(process.env.PORT) || 3001);
  
  if (isProduction && !process.env.PORT) {
    console.error('[Startup] FATAL: PORT environment variable required in production');
    process.exit(1);
  }
  
  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Startup] API Server running on port ${PORT}`);
    console.log(`[Startup] Health check ready - startup tasks will run after server is listening`);
  });

  initWebSocketServer(httpServer);

  httpServer.on('error', (err: any) => {
    console.error(`[Startup] Server failed to start:`, err);
    process.exit(1);
  });

  try {
    await runStartupTasks();
    isReady = true;
    console.log('[Startup] Startup tasks complete - server is ready');
  } catch (err) {
    console.error('[Startup] Startup tasks failed (server still running):', err);
    isReady = true;
  }

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

  startBackgroundSyncScheduler();
  startDailyReminderScheduler();
  startMorningClosureScheduler();
  startWeeklyCleanupScheduler();
  startInviteExpiryScheduler();
  startIntegrityScheduler();
  startWaiverReviewScheduler();
  startStripeReconciliationScheduler();
  startFeeSnapshotReconciliationScheduler();
  startGracePeriodScheduler();
  startBookingExpiryScheduler();
  startCommunicationLogsScheduler();
  startWebhookLogCleanupScheduler();
  startSessionCleanupScheduler();
  startUnresolvedTrackmanScheduler();
  startHubSpotQueueScheduler();
  startMemberSyncScheduler();
  startDuplicateCleanupScheduler();
  startGuestPassResetScheduler();
}

startServer().catch((err) => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});

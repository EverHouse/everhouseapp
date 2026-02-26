process.env.TZ = 'America/Los_Angeles';

import http from 'http';
import type { Server } from 'http';
import { getErrorMessage } from './utils/errorUtils';
import { logger } from './core/logger';
import { usingPooler } from './core/db';

let isShuttingDown = false;
let isReady = false;
let httpServer: Server | null = null;
let schedulersInitialized = false;
let websocketInitialized = false;
let expressApp: any = null;
let cachedIndexHtml: string | null = null;

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

process.on('uncaughtException', (error) => {
  logger.error('[Process] Uncaught Exception - shutting down:', { error: error as Error });
  setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason, promise) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  logger.error('[Process] Unhandled Rejection:', { extra: { errorMessage } });
});

process.on('SIGTERM', () => {
  logger.info('[Process] Received SIGTERM signal');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  logger.info('[Process] Received SIGINT signal');
  gracefulShutdown('SIGINT');
});

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  isReady = false;
  logger.info(`[Shutdown] Starting graceful shutdown (${signal})...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error('[Shutdown] Timeout exceeded, forcing exit');
    process.exit(1);
  }, 30000);

  try {
    if (schedulersInitialized) {
      try {
        const { stopSchedulers } = await import('./schedulers');
        stopSchedulers();
      } catch (err) { logger.warn('[Shutdown] Failed to stop schedulers:', err); }
    }
    if (websocketInitialized) {
      try {
        const { closeWebSocketServer } = await import('./core/websocket');
        closeWebSocketServer();
      } catch (err) { logger.warn('[Shutdown] Failed to close WebSocket server:', err); }
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
        setTimeout(resolve, 5000);
      });
    }

    try {
      const { pool } = await import('./core/db');
      await pool.end();
    } catch (err) { logger.warn('[Shutdown] Failed to close database pool:', err); }

    clearTimeout(shutdownTimeout);
    logger.info('[Shutdown] Complete');
    process.exit(0);
  } catch (error: unknown) {
    logger.error('[Shutdown] Error:', { error: error as Error });
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || (isProduction ? 5001 : 3001);

httpServer = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET' && !expressApp) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (req.url === '/healthz' || req.url === '/_health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (expressApp) {
    expressApp(req, res);
    return;
  }

  if (req.url?.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: false, reason: 'starting_up' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

httpServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`[Startup] HTTP server listening on port ${PORT} - health check ready`);

  initializeApp().catch((err) => {
    logger.error('[Startup] Express initialization failed:', { error: err as Error });
  });
});

httpServer.on('error', (err: unknown) => {
  logger.error(`[Startup] Server failed to start:`, { error: err as Error });
  process.exit(1);
});

async function initializeApp() {
  const { default: express } = await import('express');
  const { default: cors } = await import('cors');
  const { default: compression } = await import('compression');
  const { default: expressStaticGzip } = await import('express-static-gzip');
  const { default: rateLimit } = await import('express-rate-limit');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const { globalRateLimiter } = await import('./middleware/rateLimiting');
  const { getSession, registerAuthRoutes } = await import('./replit_integrations/auth');
  const { setupSupabaseAuthRoutes } = await import('./supabase/auth');
  const { isProduction, pool } = await import('./core/db');
  const { db } = await import('./db');
  const { sql } = await import('drizzle-orm');
  const { resources, cafeItems } = await import('../shared/schema');
  const { requestIdMiddleware, logRequest } = await import('./core/logger');
  const { registerRoutes } = await import('./loaders/routes');
  const { runStartupTasks, getStartupHealth } = await import('./loaders/startup');
  const { initWebSocketServer, closeWebSocketServer } = await import('./core/websocket');
  const { initSchedulers, stopSchedulers } = await import('./schedulers');
  const { processStripeWebhook } = await import('./core/stripe');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  logger.info(`[Startup] Environment: ${isProduction ? 'production' : 'development'}`);
  logger.info(`[Startup] DATABASE_URL: ${process.env.DATABASE_URL ? 'configured' : 'MISSING'}`);
  logger.info(`[Startup] DATABASE_POOLER_URL: ${usingPooler ? 'configured (session pooler active)' : process.env.DATABASE_POOLER_URL ? 'set but disabled (ENABLE_PGBOUNCER != true)' : 'not set (using direct connection)'}`);

  const app = express();

  app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
  });
  app.get('/_health', (req, res) => {
    res.status(200).send('OK');
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
      await db.execute(sql`SELECT 1`);
      res.status(200).json({
        ready: true,
        startupHealth,
        uptime: process.uptime()
      });
    } catch (dbError: unknown) {
      res.status(503).json({
        ready: false,
        reason: 'database_unavailable',
        startupHealth
      });
    }
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
        if (hostname === 'everclub.app' ||
            hostname.endsWith('.everclub.app')) {
          callback(null, true);
          return;
        }
      } catch (err) {
        logger.debug('CORS origin parsing failed', { error: err });
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

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://accounts.google.com https://*.hs-scripts.com https://*.hsforms.net https://*.hscollectedforms.net https://*.hs-banner.com https://*.hs-analytics.net https://*.hsadspixel.net https://*.hubspot.com https://*.usemessages.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com https://*.hsforms.net",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://api.stripe.com https://accounts.google.com https://*.hubspot.com https://*.hubapi.com https://*.hscollectedforms.net https://*.hsforms.net https://*.hs-analytics.net wss: ws:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://accounts.google.com https://www.google.com https://my.matterport.com https://app.hubspot.com",
      "frame-ancestors 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join('; '));
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    next();
  });

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
          logger.error('[Stripe Webhook] req.body is not a Buffer - express.json() may have run first');
          return res.status(500).json({ error: 'Webhook processing error' });
        }

        await processStripeWebhook(req.body as Buffer, sig);
        res.status(200).json({ received: true });
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        logger.error('[Stripe Webhook] Error:', { extra: { errorMsg } });

        if (errorMsg.includes('signature') || errorMsg.includes('payload') || (error && typeof error === 'object' && 'type' in error && (error as { type: unknown }).type === 'StripeSignatureVerificationError')) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        res.status(500).json({ error: 'Server processing error' });
      }
    }
  );

  const LARGE_BODY_PATHS = ['/api/admin/scan-id', '/api/admin/save-id-image'];
  app.use((req, res, next) => {
    if (LARGE_BODY_PATHS.includes(req.path)) {
      return next();
    }
    express.json({
      limit: '1mb',
      verify: (req: any, _res: any, buf: Buffer) => {
        if (req.originalUrl?.includes('/webhooks') || req.url?.includes('/webhooks')) {
          req.rawBody = buf.toString('utf8');
        }
      }
    })(req, res, next);
  });
  app.use(express.urlencoded({ limit: '1mb' }));
  app.use(getSession());
  app.use(globalRateLimiter);

  app.get('/api/health', async (req, res) => {
    try {
      const dbResult = await db.execute(sql`SELECT NOW() as time`);
      const isAuthenticated = req.session?.user?.isStaff === true;
      const startupHealth = getStartupHealth();

      const baseResponse = {
        status: 'ok',
        database: 'connected',
        timestamp: dbResult.rows[0]?.time,
        uptime: process.uptime()
      };

      if (isAuthenticated) {
        const { getAlertCounts, getRecentAlerts } = await import('./core/monitoring');
        const alertCounts = getAlertCounts();
        const recentCritical = getRecentAlerts({ severity: 'critical', limit: 5 });

        const resourceCountResult = await db.select({ count: sql<number>`count(*)` }).from(resources);
        const resourceTypes = await db.execute(sql`SELECT type, COUNT(*) as count FROM resources GROUP BY type`);

        res.json({
          ...baseResponse,
          environment: isProduction ? 'production' : 'development',
          resourceCount: Number(resourceCountResult[0]?.count ?? 0),
          resourcesByType: resourceTypes.rows,
          databaseUrl: process.env.DATABASE_URL ? 'configured' : 'missing',
          databasePooler: usingPooler ? 'session_pooler' : 'direct',
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
    } catch (error: unknown) {
      const isAuthenticated = req.session?.user?.isStaff === true;
      res.status(500).json({
        status: 'error',
        database: 'disconnected',
        ...(isAuthenticated && { error: getErrorMessage(error) })
      });
    }
  });

  const siteOrigin = isProduction
    ? 'https://everclub.app'
    : `https://${process.env.REPLIT_DEV_DOMAIN || 'localhost:5000'}`;

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send([
      'User-agent: *',
      'Disallow: /admin',
      'Disallow: /dashboard',
      'Disallow: /api/',
      'Disallow: /login',
      'Disallow: /checkout',
      'Disallow: /profile',
      'Disallow: /book',
      'Disallow: /member-events',
      'Disallow: /member-wellness',
      'Disallow: /updates',
      'Disallow: /history',
      'Disallow: /auth/',
      'Disallow: /reset-password',
      'Disallow: /nfc-checkin',
      'Disallow: /dev-preview/',
      'Disallow: /_health',
      'Disallow: /healthz',
      'Allow: /',
      '',
      `Sitemap: ${siteOrigin}/sitemap.xml`,
    ].join('\n') + '\n');
  });

  app.get('/sitemap.xml', (req, res) => {
    const publicPages = [
      { path: '/', priority: '1.0', changefreq: 'weekly' },
      { path: '/membership', priority: '0.9', changefreq: 'monthly' },
      { path: '/membership/apply', priority: '0.8', changefreq: 'monthly' },
      { path: '/about', priority: '0.8', changefreq: 'monthly' },
      { path: '/contact', priority: '0.8', changefreq: 'monthly' },
      { path: '/gallery', priority: '0.7', changefreq: 'weekly' },
      { path: '/whats-on', priority: '0.7', changefreq: 'weekly' },
      { path: '/private-hire', priority: '0.7', changefreq: 'monthly' },
      { path: '/private-hire/inquire', priority: '0.6', changefreq: 'monthly' },
      { path: '/menu', priority: '0.6', changefreq: 'monthly' },
      { path: '/tour', priority: '0.8', changefreq: 'monthly' },
      { path: '/day-pass', priority: '0.7', changefreq: 'monthly' },
      { path: '/faq', priority: '0.5', changefreq: 'monthly' },
      { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
      { path: '/terms', priority: '0.3', changefreq: 'yearly' },
    ];

    const today = new Date().toISOString().split('T')[0];
    const urls = publicPages.map(p =>
      `  <url>\n    <loc>${siteOrigin}${p.path}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ).join('\n');

    res.type('application/xml');
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
    );
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
          } else if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          } else if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        }
      }
    }));

    app.use('/assets/', async (req, res, next) => {
      if (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.js.br') || req.path.endsWith('.css.br')) {
        const fs = await import('fs');
        const filePath = path.join(__dirname, '../dist/assets', req.path);
        if (!fs.existsSync(filePath)) {
          logger.info(`[Stale Asset] 404 for /assets${req.path} - sending reload response`);
          if (req.path.endsWith('.css') || req.path.endsWith('.css.br')) {
            res.status(200).setHeader('Content-Type', 'text/css').send(
              '/* stale asset - page will reload */ body { display: none !important; }'
            );
          } else {
            res.status(200).setHeader('Content-Type', 'application/javascript').send(
              'window.location.reload(true);'
            );
          }
          return;
        }
      }
      next();
    });
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
    windowMs: 60 * 1000,
    max: 600,
    keyGenerator: (req) => {
      const userId = req.session?.user?.id;
      return userId ? `api:${userId}` : `api:${req.ip || 'unknown'}`;
    },
    validate: false,
  });
  app.use('/api/', apiLimiter);

  const clientErrorLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: 'Too many error reports, please try again later' }
  });

  app.post('/api/client-error', clientErrorLimiter, (req, res) => {
    const { page, error, stack, componentStack } = req.body || {};
    logger.error(`[CLIENT ERROR] Page: ${page}, Error: ${error}`);
    if (stack) logger.error(`[CLIENT ERROR] Stack: ${stack}`);
    if (componentStack) logger.error(`[CLIENT ERROR] Component: ${componentStack}`);
    res.json({ ok: true });
  });

  try {
    setupSupabaseAuthRoutes(app);
    registerAuthRoutes(app);
  } catch (err: unknown) {
    logger.error('[Startup] Auth routes setup failed:', { error: err as Error });
  }

  registerRoutes(app);

  if (isProduction) {
    const SEO_META: Record<string, { title: string; description: string }> = {
      '/': {
        title: 'Ever Club | Indoor Golf & Social Club in Tustin, OC',
        description: 'Orange County\'s premier indoor golf & social club, formerly Even House. Trackman simulators, coworking, café & wellness in Tustin. Book a tour today.',
      },
      '/membership': {
        title: 'Membership Plans & Pricing | Ever Club — Tustin, OC',
        description: 'Explore membership tiers at Ever Club in OC. Social, Core, Premium & Corporate plans with Trackman access, coworking, wellness & exclusive events.',
      },
      '/membership/apply': {
        title: 'Apply for Membership | Ever Club — OC Golf Club',
        description: 'Join OC\'s premier indoor golf & social club. Apply for membership at Ever Club in Tustin — Trackman simulators, workspace, wellness & community.',
      },
      '/private-hire': {
        title: 'Private Events & Venue Hire | Ever Club, Tustin',
        description: 'Host private events, corporate gatherings & celebrations at Ever Club in Tustin. Trackman simulator bays, conference rooms & event spaces in OC.',
      },
      '/whats-on': {
        title: 'Events & Happenings in OC | Ever Club',
        description: 'Discover golf tournaments, social nights, wellness classes & curated events at Ever Club in Tustin, OC. See what\'s on and RSVP.',
      },
      '/menu': {
        title: 'Café Menu | Ever Club — Tustin, OC',
        description: 'Explore the Ever Club café menu. Farm-to-table breakfast, artisan lunch, craft coffee & curated beverages at OC\'s premier indoor golf & social club.',
      },
      '/gallery': {
        title: 'Gallery & Photos | Ever Club — Golf Club in OC',
        description: 'See inside Ever Club in Tustin. Photos of Trackman golf simulators, lounge, café, coworking spaces & member events at OC\'s private social club.',
      },
      '/contact': {
        title: 'Contact Us | Ever Club — Tustin, OC',
        description: 'Contact Ever Club at 15771 Red Hill Ave, Ste 500, Tustin, CA 92780. Membership inquiries, private events, tours & questions. (949) 545-5855.',
      },
      '/tours': {
        title: 'Book a Tour | Ever Club — Golf & Social Club, OC',
        description: 'Schedule a free 30-min tour of Ever Club in Tustin. See Trackman simulators, coworking, café & wellness at OC\'s top private club.',
      },
      '/day-pass': {
        title: 'Day Pass — Golf Simulator & Coworking | Ever Club',
        description: 'No membership needed. Buy a day pass for Trackman golf simulators or coworking at Ever Club in Tustin, OC. Walk in & experience the club.',
      },
      '/faq': {
        title: 'FAQ — Frequently Asked Questions | Ever Club',
        description: 'Got questions about Ever Club? Find answers about memberships, Trackman golf simulators, events, hours, day passes & more at our Tustin, OC location.',
      },
      '/privacy': {
        title: 'Privacy Policy | Ever Members Club',
        description: 'Ever Members Club privacy policy. How we collect, use, and protect your personal information.',
      },
      '/terms': {
        title: 'Terms of Service | Ever Members Club',
        description: 'Ever Members Club terms of service. Membership agreement, usage policies, and club rules.',
      },
      '/private-hire/inquire': {
        title: 'Private Event Inquiry | Ever Club — OC Venue',
        description: 'Submit an inquiry for private events at Ever Club in Tustin, OC. Golf simulator parties, corporate events, celebrations & more.',
      },
      '/about': {
        title: 'About Ever Club | Indoor Golf & Social Club in Tustin',
        description: 'Learn about Ever Club, Orange County\'s premier indoor golf & social club in Tustin. Trackman simulators, coworking, café, events & wellness.',
      },
    };

    const BASE_JSON_LD = {
      "@type": ["SportsActivityLocation", "LocalBusiness"],
      "name": "Ever Members Club",
      "alternateName": ["Ever Club", "Even House"],
      "description": "Orange County's premier private indoor golf & social club featuring Trackman simulators, premium coworking, wellness programs, and curated events.",
      "url": "https://everclub.app",
      "telephone": "+19495455855",
      "email": "info@joinever.club",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "15771 Red Hill Ave, Ste 500",
        "addressLocality": "Tustin",
        "addressRegion": "CA",
        "postalCode": "92780",
        "addressCountry": "US"
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": 33.709,
        "longitude": -117.8272
      },
      "areaServed": {
        "@type": "GeoCircle",
        "geoMidpoint": {
          "@type": "GeoCoordinates",
          "latitude": 33.709,
          "longitude": -117.8272
        },
        "geoRadius": "30 mi"
      },
      "priceRange": "$$$",
      "openingHoursSpecification": [
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          "opens": "07:00",
          "closes": "22:00"
        },
        {
          "@type": "OpeningHoursSpecification",
          "dayOfWeek": ["Saturday", "Sunday"],
          "opens": "08:00",
          "closes": "22:00"
        }
      ],
      "sameAs": ["https://www.instagram.com/everhouse.app/"],
      "image": "https://everclub.app/images/hero-lounge-optimized.webp",
      "amenityFeature": [
        {"@type": "LocationFeatureSpecification", "name": "Trackman Golf Simulators", "value": true},
        {"@type": "LocationFeatureSpecification", "name": "Premium Coworking Space", "value": true},
        {"@type": "LocationFeatureSpecification", "name": "Café & Bar", "value": true},
        {"@type": "LocationFeatureSpecification", "name": "Private Event Space", "value": true},
        {"@type": "LocationFeatureSpecification", "name": "Wellness Programs", "value": true}
      ],
      "hasOfferCatalog": {
        "@type": "OfferCatalog",
        "name": "Membership Plans",
        "itemListElement": [
          {"@type": "Offer", "name": "Social Membership", "description": "Access to social events and café"},
          {"@type": "Offer", "name": "Core Membership", "description": "Golf simulator access, coworking, and events"},
          {"@type": "Offer", "name": "Premium Membership", "description": "Full access including priority booking and wellness"},
          {"@type": "Offer", "name": "Day Pass", "description": "Single-day access to golf simulators or coworking"}
        ]
      }
    };

    const FAQ_JSON_LD = {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is Ever Members Club?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Ever Members Club is Orange County's premier private indoor golf and social club, located in Tustin, CA. We combine Trackman golf simulators, premium coworking spaces, a café, wellness programs, and curated social events under one roof."
          }
        },
        {
          "@type": "Question",
          "name": "Where is Ever Members Club located?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "We're located at 15771 Red Hill Ave, Ste 500, Tustin, CA 92780, in the heart of Orange County."
          }
        },
        {
          "@type": "Question",
          "name": "What golf simulators do you use?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "We use Trackman golf simulators, the industry-leading technology used by PGA Tour professionals for practice, play, and entertainment."
          }
        },
        {
          "@type": "Question",
          "name": "Do I need a membership to visit?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "You can experience the club with a Day Pass for golf simulators or coworking, or book a private tour to see the full facility before joining."
          }
        },
        {
          "@type": "Question",
          "name": "What membership options are available?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "We offer Social, Core, Premium, and Corporate membership tiers, each with different levels of access to golf simulators, coworking, events, and wellness programs."
          }
        },
        {
          "@type": "Question",
          "name": "Can I host a private event at Ever Club?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes! We offer private event spaces including golf simulator bays and conference rooms for corporate events, celebrations, and social gatherings."
          }
        }
      ]
    };

    const TOURS_JSON_LD = {
      "@type": "TouristAttraction",
      "name": "Ever Members Club",
      "description": "Schedule a free 30-minute tour of Orange County's premier indoor golf & social club featuring Trackman simulators, premium coworking, café & wellness facilities.",
      "url": "https://everclub.app/tours",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "15771 Red Hill Ave, Ste 500",
        "addressLocality": "Tustin",
        "addressRegion": "CA",
        "postalCode": "92780",
        "addressCountry": "US"
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": 33.709,
        "longitude": -117.8272
      },
      "touristType": ["Golf Enthusiasts", "Professionals", "Social Groups"]
    };

    const EVENT_VENUE_JSON_LD = {
      "@type": "EventVenue",
      "name": "Ever Members Club — Private Event Venue",
      "description": "Host private events, corporate gatherings & celebrations at Ever Members Club in Tustin. Trackman golf simulator bays, conference rooms & elegant event spaces in Orange County.",
      "url": "https://everclub.app/private-hire",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "15771 Red Hill Ave, Ste 500",
        "addressLocality": "Tustin",
        "addressRegion": "CA",
        "postalCode": "92780",
        "addressCountry": "US"
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": 33.709,
        "longitude": -117.8272
      },
      "maximumAttendeeCapacity": 100,
      "telephone": "+19495455855"
    };

    const GEO_META_TAGS = `<meta name="geo.region" content="US-CA" />\n<meta name="geo.placename" content="Tustin, California" />\n<meta name="geo.position" content="33.709;-117.8272" />\n<meta name="ICBM" content="33.709, -117.8272" />`;

    function getBreadcrumbs(routePath: string): object {
      const items: { name: string; item: string }[] = [
        { name: "Home", item: "https://everclub.app" }
      ];

      const breadcrumbMap: Record<string, { name: string; item: string }[]> = {
        '/membership': [{ name: "Membership", item: "https://everclub.app/membership" }],
        '/membership/apply': [
          { name: "Membership", item: "https://everclub.app/membership" },
          { name: "Apply", item: "https://everclub.app/membership/apply" }
        ],
        '/tours': [{ name: "Book a Tour", item: "https://everclub.app/tours" }],
        '/private-hire': [{ name: "Private Events", item: "https://everclub.app/private-hire" }],
        '/private-hire/inquire': [
          { name: "Private Events", item: "https://everclub.app/private-hire" },
          { name: "Inquire", item: "https://everclub.app/private-hire/inquire" }
        ],
        '/whats-on': [{ name: "Events", item: "https://everclub.app/whats-on" }],
        '/menu': [{ name: "Café Menu", item: "https://everclub.app/menu" }],
        '/gallery': [{ name: "Gallery", item: "https://everclub.app/gallery" }],
        '/contact': [{ name: "Contact", item: "https://everclub.app/contact" }],
        '/day-pass': [{ name: "Day Pass", item: "https://everclub.app/day-pass" }],
        '/faq': [{ name: "FAQ", item: "https://everclub.app/faq" }],
        '/about': [{ name: "About", item: "https://everclub.app/about" }],
      };

      const additionalItems = breadcrumbMap[routePath] || [];
      const allItems = [...items, ...additionalItems];

      return {
        "@type": "BreadcrumbList",
        "itemListElement": allItems.map((item, index) => ({
          "@type": "ListItem",
          "position": index + 1,
          "name": item.name,
          "item": item.item
        }))
      };
    }

    function getJsonLdScripts(routePath: string): string {
      const graphItems: object[] = [
        {
          "@type": "Organization",
          "@id": "https://everclub.app/#organization",
          "name": "Ever Members Club",
          "alternateName": ["Ever Club", "Even House"],
          "url": "https://everclub.app",
          "logo": "https://everclub.app/images/everclub-logo-dark.webp",
          "sameAs": [
            "https://www.instagram.com/everclub/",
            "https://evenhouse.club",
            "https://www.linkedin.com/company/ever-club",
            "https://www.tiktok.com/@everclub"
          ],
          "address": {
            "@type": "PostalAddress",
            "streetAddress": "15771 Red Hill Ave, Ste 500",
            "addressLocality": "Tustin",
            "addressRegion": "CA",
            "postalCode": "92780",
            "addressCountry": "US"
          },
          "contactPoint": {
            "@type": "ContactPoint",
            "telephone": "+19495455855",
            "contactType": "customer service",
            "email": "info@joinever.club"
          }
        },
        {
          "@type": "WebSite",
          "@id": "https://everclub.app/#website",
          "url": "https://everclub.app",
          "name": "Ever Members Club",
          "publisher": { "@id": "https://everclub.app/#organization" },
          "potentialAction": {
            "@type": "SearchAction",
            "target": "https://everclub.app/faq?q={search_term_string}",
            "query-input": "required name=search_term_string"
          }
        },
        { ...BASE_JSON_LD, "@id": "https://everclub.app/#localbusiness" }
      ];

      if (routePath === '/faq') {
        graphItems.push(FAQ_JSON_LD);
      }
      if (routePath === '/tours') {
        graphItems.push(TOURS_JSON_LD);
      }
      if (routePath === '/private-hire') {
        graphItems.push(EVENT_VENUE_JSON_LD);
      }
      if (routePath === '/about') {
        graphItems.push({
          "@type": "AboutPage",
          "name": "About Ever Club",
          "description": "Learn about Ever Club, Orange County's premier indoor golf & social club in Tustin.",
          "url": "https://everclub.app/about",
          "mainEntity": {
            "@type": "Organization",
            "name": "Ever Members Club"
          }
        });
      }

      if (routePath !== '/') {
        graphItems.push(getBreadcrumbs(routePath));
      }

      return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graphItems })}</script>`;
    }

    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/assets/') && req.path !== '/healthz' && req.path !== '/_health') {
        if (!cachedIndexHtml) {
          return res.sendFile(path.join(__dirname, '../dist/index.html'));
        }

        const routePath = req.path.replace(/\/+$/, '') || '/';
        const meta = SEO_META[routePath];

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Link', '</images/hero-lounge-optimized.webp>; rel=preload; as=image; type=image/webp');

        if (meta) {
          const ogUrl = `https://everclub.app${routePath === '/' ? '' : routePath}`;
          let html = cachedIndexHtml;
          html = html.replace(/<title>[^<]*<\/title>/, `<title>${meta.title}</title>`);
          html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${meta.description}" />`);
          html = html.replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${meta.title}" />`);
          html = html.replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${meta.description}" />`);
          html = html.replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${ogUrl}" />`);
          html = html.replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${meta.title}" />`);
          html = html.replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${meta.description}" />`);
          html = html.replace('</head>', `<link rel="canonical" href="${ogUrl}" />\n${GEO_META_TAGS}\n${getJsonLdScripts(routePath)}\n</head>`);
          return res.send(html);
        }

        let html = cachedIndexHtml;
        const fallbackUrl = `https://everclub.app${routePath === '/' ? '' : routePath}`;
        html = html.replace('</head>', `<link rel="canonical" href="${fallbackUrl}" />\n${GEO_META_TAGS}\n${getJsonLdScripts(routePath)}\n</head>`);
        return res.send(html);
      }
      next();
    });
  }

  expressApp = app;
  isReady = true;
  logger.info('[Startup] Express app fully initialized and accepting requests');

  if (isProduction) {
    try {
      const indexPath = path.join(__dirname, '../dist/index.html');
      const fs = await import('fs');
      cachedIndexHtml = fs.readFileSync(indexPath, 'utf8');
      logger.info('[Startup] Cached index.html for fast serving');
    } catch (err: unknown) {
      logger.error('[Startup] Failed to cache index.html:', { error: err as Error });
    }
  }

  const heavyTaskDelay = isProduction ? 10000 : 500;
  logger.info(`[Startup] Scheduling heavy background tasks in ${heavyTaskDelay / 1000}s...`);

  setTimeout(() => {
    logger.info('[Startup] Starting heavy background tasks...');

    try {
      initWebSocketServer(httpServer!);
      websocketInitialized = true;
    } catch (err: unknown) {
      logger.error('[Startup] WebSocket initialization failed:', { error: err as Error });
    }

    (async () => {
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await db.execute(sql`
            UPDATE users SET archived_at = NULL, archived_by = NULL, updated_at = NOW()
            WHERE archived_by = 'system-cleanup'
              AND archived_at IS NOT NULL
              AND (
                role IN ('admin', 'staff', 'golf_instructor')
                OR EXISTS (SELECT 1 FROM staff_users su WHERE LOWER(su.email) = LOWER(users.email) AND su.is_active = true)
              )
            RETURNING email, role
          `);
          if (result.rows.length > 0) {
            logger.info('[Startup] Restored incorrectly archived staff accounts', { extra: { restored: result.rows.map((r: any) => r.email) } });
          }
          break;
        } catch (err) {
          const isTimeout = String((err as Error).message || '').includes('timeout');
          if (attempt < maxRetries && isTimeout) {
            logger.warn(`[Startup] Archived staff check attempt ${attempt}/${maxRetries} timed out, retrying in ${attempt * 5}s...`);
            await new Promise(r => setTimeout(r, attempt * 5000));
          } else {
            logger.error('[Startup] Failed to check archived staff accounts:', { error: err as Error });
          }
        }
      }
    })().catch(err => logger.error('[Startup] Unhandled error in archived staff check:', { error: err as Error }));

    (async () => {
      try {
        const cleanupResult = await db.execute(sql`
          UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL, updated_at = NOW()
          WHERE email LIKE '%.merged.%' AND (stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL)
          RETURNING email, stripe_customer_id
        `);
        if (cleanupResult.rows.length > 0) {
          logger.info('[Startup] Cleared Stripe IDs from merged/archived users', { extra: { count: cleanupResult.rows.length, users: cleanupResult.rows.map((r: any) => r.email) } });
        }
      } catch (err) {
        logger.warn('[Startup] Failed to cleanup merged user Stripe IDs:', { error: err as Error });
      }
    })().catch(err => logger.error('[Startup] Unhandled error in Stripe ID cleanup:', { error: err as Error }));

    runStartupTasks()
      .then(() => {
        const startupHealth = getStartupHealth();
        if (startupHealth.criticalFailures.length > 0) {
          logger.error('[Startup] Critical failures detected:', { extra: { criticalFailures: startupHealth.criticalFailures } });
        } else {
          logger.info('[Startup] All startup tasks complete');
          if (startupHealth.warnings.length > 0) {
            logger.warn('[Startup] Startup completed with warnings:', { extra: { warnings: startupHealth.warnings } });
          }
        }
      })
      .catch((err) => {
        logger.error('[Startup] Startup tasks failed unexpectedly:', { error: err as Error });
      });

    if (!isProduction) {
      setTimeout(async () => {
        try {
          await autoSeedResources(db, sql, resources, isProduction);
        } catch (err: unknown) {
          logger.error('[Startup] Auto-seed resources failed:', { error: err as Error });
        }
        try {
          await autoSeedCafeMenu(db, sql, cafeItems, isProduction);
        } catch (err: unknown) {
          logger.error('[Startup] Auto-seed cafe menu failed:', { error: err as Error });
        }
      }, 30000);
    }

    try {
      initSchedulers();
      schedulersInitialized = true;
    } catch (err: unknown) {
      logger.error('[Startup] Scheduler initialization failed:', { error: err as Error });
    }
  }, heavyTaskDelay);
}

async function autoSeedResources(db: any, sql: any, resourcesTable: any, isProduction: boolean) {
  try {
    const result = await db.select({ count: sql<number>`count(*)` }).from(resourcesTable);
    const count = Number(result[0]?.count ?? 0);

    if (count === 0) {
      if (!isProduction) logger.info('Auto-seeding resources...');
      const seedResources = [
        { name: 'Simulator Bay 1', type: 'simulator', description: 'TrackMan Simulator Bay 1', capacity: 6 },
        { name: 'Simulator Bay 2', type: 'simulator', description: 'TrackMan Simulator Bay 2', capacity: 6 },
        { name: 'Simulator Bay 3', type: 'simulator', description: 'TrackMan Simulator Bay 3', capacity: 6 },
        { name: 'Simulator Bay 4', type: 'simulator', description: 'TrackMan Simulator Bay 4', capacity: 6 },
        { name: 'Conference Room', type: 'conference_room', description: 'Main conference room with AV setup', capacity: 12 },
      ];

      for (const resource of seedResources) {
        await db.insert(resourcesTable).values(resource).onConflictDoNothing();
      }
      if (!isProduction) logger.info(`Auto-seeded ${seedResources.length} resources`);
    }
  } catch (error: unknown) {
    if (!isProduction) logger.info('Resources table may not exist yet, skipping auto-seed');
  }
}

async function autoSeedCafeMenu(db: any, sql: any, cafeItemsTable: any, isProduction: boolean) {
  try {
    const result = await db.select({ count: sql<number>`count(*)` }).from(cafeItemsTable);
    const count = Number(result[0]?.count ?? 0);

    if (count === 0) {
      if (!isProduction) logger.info('Auto-seeding cafe menu...');
      const seedCafeItems = [
        { category: 'Breakfast', name: 'Egg Toast', price: '14', description: 'Schaner Farm scrambled eggs, whipped ricotta, chives, micro greens, toasted country batard', icon: 'egg_alt', sortOrder: 1 },
        { category: 'Breakfast', name: 'Avocado Toast', price: '16', description: 'Hass smashed avocado, radish, lemon, micro greens, dill, toasted country batard', icon: 'eco', sortOrder: 2 },
        { category: 'Breakfast', name: 'Banana & Honey Toast', price: '14', description: 'Banana, whipped ricotta, Hapa Honey Farm local honey, toasted country batard', icon: 'bakery_dining', sortOrder: 3 },
        { category: 'Breakfast', name: 'Smoked Salmon Toast', price: '20', description: 'Alaskan king smoked salmon, whipped cream cheese, dill, capers, lemon, micro greens, toasted country batard', icon: 'set_meal', sortOrder: 4 },
        { category: 'Breakfast', name: 'Breakfast Croissant', price: '16', description: 'Schaner Farm eggs, New School american cheese, freshly baked croissant, choice of cured ham or applewood smoked bacon', icon: 'bakery_dining', sortOrder: 5 },
        { category: 'Breakfast', name: 'French Omelette', price: '14', description: 'Schaner Farm eggs, cultured butter, fresh herbs, served with side of seasonal salad greens', icon: 'egg', sortOrder: 6 },
        { category: 'Breakfast', name: 'Hanger Steak & Eggs', price: '24', description: 'Autonomy Farms Hanger steak, Schaner Farm eggs, cooked your way', icon: 'restaurant', sortOrder: 7 },
        { category: 'Breakfast', name: 'Bacon & Eggs', price: '14', description: 'Applewood smoked bacon, Schaner Farm eggs, cooked your way', icon: 'egg_alt', sortOrder: 8 },
        { category: 'Breakfast', name: 'Yogurt Parfait', price: '14', description: 'Yogurt, seasonal fruits, farmstead granola, Hapa Honey farm local honey', icon: 'icecream', sortOrder: 9 },
        { category: 'Sides', name: 'Bacon, Two Slices', price: '6', description: 'Applewood smoked bacon', icon: 'restaurant', sortOrder: 1 },
        { category: 'Sides', name: 'Eggs, Scrambled', price: '8', description: 'Schaner Farm scrambled eggs', icon: 'egg', sortOrder: 2 },
        { category: 'Sides', name: 'Seasonal Fruit Bowl', price: '10', description: 'Fresh seasonal fruits', icon: 'nutrition', sortOrder: 3 },
        { category: 'Sides', name: 'Smoked Salmon', price: '9', description: 'Alaskan king smoked salmon', icon: 'set_meal', sortOrder: 4 },
        { category: 'Sides', name: 'Toast, Two Slices', price: '3', description: 'Toasted country batard', icon: 'bakery_dining', sortOrder: 5 },
        { category: 'Sides', name: 'Sqirl Seasonal Jam', price: '3', description: 'Artisan seasonal jam', icon: 'local_florist', sortOrder: 6 },
        { category: 'Sides', name: 'Pistachio Spread', price: '4', description: 'House-made pistachio spread', icon: 'spa', sortOrder: 7 },
        { category: 'Lunch', name: 'Caesar Salad', price: '15', description: 'Romaine lettuce, homemade dressing, grated Reggiano. Add: roasted chicken $8, hanger steak 8oz $14', icon: 'local_florist', sortOrder: 1 },
        { category: 'Lunch', name: 'Wedge Salad', price: '16', description: 'Iceberg lettuce, bacon, red onion, cherry tomatoes, Point Reyes bleu cheese, homemade dressing', icon: 'local_florist', sortOrder: 2 },
        { category: 'Lunch', name: 'Chicken Salad Sandwich', price: '14', description: 'Autonomy Farms chicken, celery, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sortOrder: 3 },
        { category: 'Lunch', name: 'Tuna Salad Sandwich', price: '14', description: 'Wild, pole-caught albacore tuna, sprouts, club chimichurri, toasted pan loaf, served with olive oil potato chips', icon: 'set_meal', sortOrder: 4 },
        { category: 'Lunch', name: 'Grilled Cheese', price: '12', description: 'New School american cheese, brioche pan loaf, served with olive oil potato chips. Add: short rib $6, roasted tomato soup cup $7', icon: 'lunch_dining', sortOrder: 5 },
        { category: 'Lunch', name: 'Heirloom BLT', price: '18', description: 'Applewood smoked bacon, butter lettuce, heirloom tomatoes, olive oil mayo, toasted pan loaf, served with olive oil potato chips', icon: 'lunch_dining', sortOrder: 6 },
        { category: 'Lunch', name: 'Bratwurst', price: '12', description: 'German bratwurst, sautéed onions & peppers, toasted brioche bun', icon: 'lunch_dining', sortOrder: 7 },
        { category: 'Lunch', name: 'Bison Serrano Chili', price: '14', description: 'Pasture raised bison, serrano, anaheim, green bell peppers, mint, cilantro, cheddar cheese, sour cream, green onion, served with organic corn chips', icon: 'soup_kitchen', sortOrder: 8 },
        { category: 'Kids', name: 'Kids Grilled Cheese', price: '6', description: 'Classic grilled cheese for little ones', icon: 'child_care', sortOrder: 1 },
        { category: 'Kids', name: 'Kids Hot Dog', price: '8', description: 'All-beef hot dog', icon: 'child_care', sortOrder: 2 },
        { category: 'Dessert', name: 'Vanilla Bean Gelato Sandwich', price: '6', description: 'Vanilla bean gelato with chocolate chip cookies', icon: 'icecream', sortOrder: 1 },
        { category: 'Dessert', name: 'Sea Salt Caramel Gelato Sandwich', price: '6', description: 'Sea salt caramel gelato with snickerdoodle cookies', icon: 'icecream', sortOrder: 2 },
        { category: 'Dessert', name: 'Seasonal Pie, Slice', price: '6', description: 'Daily seasonal pie with house made crème', icon: 'cake', sortOrder: 3 },
        { category: 'Shareables', name: 'Club Charcuterie', price: '32', description: 'Selection of cured meats and artisan cheeses', icon: 'tapas', sortOrder: 1 },
        { category: 'Shareables', name: 'Chips & Salsa', price: '10', description: 'House-made salsa with organic corn chips', icon: 'tapas', sortOrder: 2 },
        { category: 'Shareables', name: 'Caviar Service', price: '0', description: 'Market price - ask your server', icon: 'dining', sortOrder: 3 },
        { category: 'Shareables', name: 'Tinned Fish Tray', price: '47', description: 'Premium selection of tinned fish', icon: 'set_meal', sortOrder: 4 },
      ];

      for (const item of seedCafeItems) {
        await db.insert(cafeItemsTable).values(item).onConflictDoNothing();
      }
      if (!isProduction) logger.info(`Auto-seeded ${seedCafeItems.length} cafe menu items`);
    }
  } catch (error: unknown) {
    if (!isProduction) logger.info('Cafe menu table may not exist yet, skipping auto-seed');
  }
}

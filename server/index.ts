process.env.TZ = 'America/Los_Angeles';

import http from 'http';
import type { Server } from 'http';
import { getErrorMessage } from './utils/errorUtils';

let isShuttingDown = false;
let isReady = false;
let httpServer: Server | null = null;
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
  console.error('[Process] Uncaught Exception:', error);
  if (error.message?.includes('EADDRINUSE')) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  console.error('[Process] Unhandled Rejection:', errorMessage);
});

process.on('SIGTERM', () => {
  console.log('[Process] Received SIGTERM signal');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('[Process] Received SIGINT signal');
  gracefulShutdown('SIGINT');
});

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  isReady = false;
  console.log(`[Shutdown] Starting graceful shutdown (${signal})...`);

  const shutdownTimeout = setTimeout(() => {
    console.error('[Shutdown] Timeout exceeded, forcing exit');
    process.exit(1);
  }, 30000);

  try {
    try {
      const { stopSchedulers } = await import('./schedulers');
      stopSchedulers();
    } catch {}
    try {
      const { closeWebSocketServer } = await import('./core/websocket');
      closeWebSocketServer();
    } catch {}

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
        setTimeout(resolve, 5000);
      });
    }

    try {
      const { pool } = await import('./core/db');
      await pool.end();
    } catch {}

    clearTimeout(shutdownTimeout);
    console.log('[Shutdown] Complete');
    process.exit(0);
  } catch (error) {
    console.error('[Shutdown] Error:', error);
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

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Startup] HTTP server listening on port ${PORT} - health check ready`);
  isReady = true;

  initializeApp().catch((err) => {
    console.error('[Startup] Express initialization failed:', err);
  });
});

httpServer.on('error', (err: unknown) => {
  console.error(`[Startup] Server failed to start:`, err);
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
  const { requestIdMiddleware, logRequest, logger } = await import('./core/logger');
  const { registerRoutes } = await import('./loaders/routes');
  const { runStartupTasks, getStartupHealth } = await import('./loaders/startup');
  const { initWebSocketServer, closeWebSocketServer } = await import('./core/websocket');
  const { initSchedulers, stopSchedulers } = await import('./schedulers');
  const { processStripeWebhook } = await import('./core/stripe');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  console.log(`[Startup] Environment: ${isProduction ? 'production' : 'development'}`);
  console.log(`[Startup] DATABASE_URL: ${process.env.DATABASE_URL ? 'configured' : 'MISSING'}`);

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
        if (hostname === 'everclub.app' ||
            hostname.endsWith('.everclub.app')) {
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

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
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
          console.error('[Stripe Webhook] req.body is not a Buffer - express.json() may have run first');
          return res.status(500).json({ error: 'Webhook processing error' });
        }

        await processStripeWebhook(req.body as Buffer, sig);
        res.status(200).json({ received: true });
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        console.error('[Stripe Webhook] Error:', errorMsg);

        if (errorMsg.includes('signature') || errorMsg.includes('payload') || (error && typeof error === 'object' && 'type' in error && (error as { type: unknown }).type === 'StripeSignatureVerificationError')) {
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
    } catch (error: unknown) {
      const isAuthenticated = req.session?.user?.isStaff === true;
      res.status(500).json({
        status: 'error',
        database: 'disconnected',
        ...(isAuthenticated && { error: getErrorMessage(error) })
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
          } else if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
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
    windowMs: 60 * 1000,
    max: 600,
    keyGenerator: (req) => {
      const userId = req.session?.user?.id;
      return userId ? `api:${userId}` : `api:${req.ip || 'unknown'}`;
    },
    validate: false,
  });
  app.use('/api/', apiLimiter);

  app.post('/api/client-error', (req, res) => {
    const { page, error, stack, componentStack } = req.body || {};
    console.error(`[CLIENT ERROR] Page: ${page}, Error: ${error}`);
    if (stack) console.error(`[CLIENT ERROR] Stack: ${stack}`);
    if (componentStack) console.error(`[CLIENT ERROR] Component: ${componentStack}`);
    res.json({ ok: true });
  });

  try {
    setupSupabaseAuthRoutes(app);
    registerAuthRoutes(app);
  } catch (err) {
    console.error('[Startup] Auth routes setup failed:', err);
  }

  registerRoutes(app);

  if (isProduction) {
    const SEO_META: Record<string, { title: string; description: string }> = {
      '/': {
        title: 'Ever Members Club | Indoor Golf & Social Club in Tustin, Orange County',
        description: 'Orange County\'s premier private indoor golf & social club, formerly Even House. Trackman golf simulators, premium coworking, café, wellness & curated events. Visit us in Tustin — book a private tour today.',
      },
      '/membership': {
        title: 'Membership Plans & Pricing | Ever Members Club — Tustin, OC',
        description: 'Explore membership tiers at Ever Members Club in Orange County. Social, Core, Premium & Corporate plans with Trackman simulator access, coworking, wellness programs & exclusive member events.',
      },
      '/membership/apply': {
        title: 'Apply for Membership | Ever Members Club — Orange County Indoor Golf Club',
        description: 'Join Orange County\'s premier indoor golf & social club. Apply for membership at Ever Members Club in Tustin — Trackman simulators, premium workspace, wellness & a curated community.',
      },
      '/private-hire': {
        title: 'Private Events & Venue Hire in Orange County | Ever Members Club',
        description: 'Host private events, corporate gatherings & celebrations at Ever Members Club in Tustin. Trackman golf simulator bays, conference rooms & elegant event spaces in Orange County.',
      },
      '/whats-on': {
        title: 'Events & Happenings in Orange County | Ever Members Club',
        description: 'Discover golf tournaments, social nights, wellness classes & curated events at Ever Members Club in Tustin, Orange County. See what\'s on and RSVP.',
      },
      '/menu': {
        title: 'Café Menu | Ever Members Club — Tustin, Orange County',
        description: 'Explore the Ever Members Club café menu. Farm-to-table breakfast, artisan lunch, craft coffee & curated beverages inside Orange County\'s premier indoor golf & social club.',
      },
      '/gallery': {
        title: 'Gallery & Photos | Ever Members Club — Indoor Golf Club in Orange County',
        description: 'See inside Ever Members Club in Tustin. Photos of Trackman golf simulators, lounge, café, coworking spaces & member events at Orange County\'s private social club.',
      },
      '/contact': {
        title: 'Contact Us | Ever Members Club — Tustin, Orange County',
        description: 'Get in touch with Ever Members Club at 15771 Red Hill Ave, Ste 500, Tustin, CA 92780. Membership inquiries, private events, tours & general questions. Call (949) 545-5855.',
      },
      '/tours': {
        title: 'Book a Private Tour | Ever Members Club — Indoor Golf & Social Club, OC',
        description: 'Schedule a free 30-minute tour of Ever Members Club in Tustin. See Trackman simulators, premium coworking, café & wellness facilities at Orange County\'s top private club.',
      },
      '/day-pass': {
        title: 'Day Pass — Golf Simulator & Coworking | Ever Members Club, Orange County',
        description: 'No membership needed. Purchase a day pass for Trackman golf simulators or premium coworking at Ever Members Club in Tustin, Orange County. Walk in & experience the club.',
      },
      '/faq': {
        title: 'FAQ — Frequently Asked Questions | Ever Members Club, Orange County',
        description: 'Got questions about Ever Members Club? Find answers about memberships, Trackman golf simulators, events, hours, day passes & more at our Tustin, OC location.',
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
        title: 'Private Event Inquiry | Ever Members Club — Orange County Venue',
        description: 'Submit an inquiry for private events at Ever Members Club in Tustin, OC. Golf simulator parties, corporate events, celebrations & more at Orange County\'s premier venue.',
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
      "maximumAttendeeCapacity": 100
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
            "https://www.instagram.com/everhouse.app/",
            "https://evenhouse.club"
          ],
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
          "publisher": { "@id": "https://everclub.app/#organization" }
        },
        { ...BASE_JSON_LD, "@id": "https://everclub.app/#organization" }
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

      if (routePath !== '/') {
        graphItems.push(getBreadcrumbs(routePath));
      }

      return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graphItems })}</script>`;
    }

    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/') && req.path !== '/healthz' && req.path !== '/_health') {
        if (!cachedIndexHtml) {
          return res.sendFile(path.join(__dirname, '../dist/index.html'));
        }

        const routePath = req.path.replace(/\/+$/, '') || '/';
        const meta = SEO_META[routePath];

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
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Cache-Control', 'no-cache');
          return res.send(html);
        }

        let html = cachedIndexHtml;
        const fallbackUrl = `https://everclub.app${routePath === '/' ? '' : routePath}`;
        html = html.replace('</head>', `<link rel="canonical" href="${fallbackUrl}" />\n${GEO_META_TAGS}\n${getJsonLdScripts(routePath)}\n</head>`);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(html);
      }
      next();
    });
  }

  expressApp = app;
  console.log('[Startup] Express app fully initialized and accepting requests');

  if (isProduction) {
    try {
      const indexPath = path.join(__dirname, '../dist/index.html');
      const fs = await import('fs');
      cachedIndexHtml = fs.readFileSync(indexPath, 'utf8');
      console.log('[Startup] Cached index.html for fast serving');
    } catch (err) {
      console.error('[Startup] Failed to cache index.html:', err);
    }
  }

  const heavyTaskDelay = isProduction ? 10000 : 500;
  console.log(`[Startup] Scheduling heavy background tasks in ${heavyTaskDelay / 1000}s...`);

  setTimeout(() => {
    console.log('[Startup] Starting heavy background tasks...');

    try {
      initWebSocketServer(httpServer!);
    } catch (err) {
      console.error('[Startup] WebSocket initialization failed:', err);
    }

    runStartupTasks()
      .then(() => {
        const startupHealth = getStartupHealth();
        if (startupHealth.criticalFailures.length > 0) {
          console.error('[Startup] Critical failures detected:', startupHealth.criticalFailures);
        } else {
          console.log('[Startup] All startup tasks complete');
          if (startupHealth.warnings.length > 0) {
            console.warn('[Startup] Startup completed with warnings:', startupHealth.warnings);
          }
        }
      })
      .catch((err) => {
        console.error('[Startup] Startup tasks failed unexpectedly:', err);
      });

    if (!isProduction) {
      setTimeout(async () => {
        try {
          await autoSeedResources(pool, isProduction);
        } catch (err) {
          console.error('[Startup] Auto-seed resources failed:', err);
        }
        try {
          await autoSeedCafeMenu(pool, isProduction);
        } catch (err) {
          console.error('[Startup] Auto-seed cafe menu failed:', err);
        }
      }, 30000);
    }

    try {
      initSchedulers();
    } catch (err) {
      console.error('[Startup] Scheduler initialization failed:', err);
    }
  }, heavyTaskDelay);
}

async function autoSeedResources(pool: any, isProduction: boolean) {
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

async function autoSeedCafeMenu(pool: any, isProduction: boolean) {
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

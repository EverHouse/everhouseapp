import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from './logger';
import { getStripeClient } from './stripe/client';
import { getHubSpotPrivateAppClient, getHubSpotClient, getGoogleCalendarClient } from './integrations';

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  message?: string;
  lastChecked: string;
}

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    database: ServiceHealth;
    stripe: ServiceHealth;
    hubspot: ServiceHealth;
    resend: ServiceHealth;
    googleCalendar: ServiceHealth;
  };
  timestamp: string;
}

async function checkWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = 5000
): Promise<{ result: T | null; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);
    return { result, latencyMs: Date.now() - start };
  } catch (error: unknown) {
    return {
      result: null,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error) || 'Unknown error'
    };
  }
}

async function checkDatabase(): Promise<ServiceHealth> {
  const { result: _result, latencyMs, error } = await checkWithTimeout(
    () => db.execute(sql`SELECT 1`),
    3000
  );

  if (error) {
    return {
      status: 'unhealthy',
      latencyMs,
      message: error,
      lastChecked: new Date().toISOString()
    };
  }

  return {
    status: latencyMs > 1000 ? 'degraded' : 'healthy',
    latencyMs,
    lastChecked: new Date().toISOString()
  };
}

async function checkStripe(): Promise<ServiceHealth> {
  try {
    const stripe = await getStripeClient();
    if (!stripe) {
      return {
        status: 'unhealthy',
        message: 'Stripe not configured',
        lastChecked: new Date().toISOString()
      };
    }

    const { latencyMs, error } = await checkWithTimeout(
      () => stripe.balance.retrieve(),
      5000
    );

    if (error) {
      return {
        status: 'unhealthy',
        latencyMs,
        message: error,
        lastChecked: new Date().toISOString()
      };
    }

    return {
      status: latencyMs > 2000 ? 'degraded' : 'healthy',
      latencyMs,
      lastChecked: new Date().toISOString()
    };
  } catch (error: unknown) {
    return {
      status: 'unhealthy',
      message: getErrorMessage(error),
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkHubSpot(): Promise<ServiceHealth> {
  try {
    let hubspotClient;
    try {
      hubspotClient = await getHubSpotClient();
    } catch (err) {
      logger.debug('HubSpot OAuth client unavailable, trying private app client', { error: getErrorMessage(err) });
      const privateClient = await getHubSpotPrivateAppClient();
      if (!privateClient) {
        return {
          status: 'unhealthy',
          message: 'HubSpot not configured',
          lastChecked: new Date().toISOString()
        };
      }
      hubspotClient = privateClient;
    }

    const { latencyMs, error } = await checkWithTimeout(
      () => hubspotClient.crm.contacts.basicApi.getPage(1),
      5000
    );

    if (error) {
      return {
        status: 'unhealthy',
        latencyMs,
        message: error,
        lastChecked: new Date().toISOString()
      };
    }

    return {
      status: latencyMs > 2000 ? 'degraded' : 'healthy',
      latencyMs,
      lastChecked: new Date().toISOString()
    };
  } catch (error: unknown) {
    return {
      status: 'unhealthy',
      message: getErrorMessage(error),
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkResend(): Promise<ServiceHealth> {
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      return {
        status: 'unhealthy',
        message: 'Resend API key not configured',
        lastChecked: new Date().toISOString()
      };
    }

    const { latencyMs, error } = await checkWithTimeout(
      async () => {
        const response = await fetch('https://api.resend.com/api-keys', {
          headers: { Authorization: `Bearer ${resendApiKey}` }
        });
        if (response.status === 401) {
          throw new Error('API key invalid or expired');
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
      5000
    );

    if (error) {
      return {
        status: 'unhealthy',
        latencyMs,
        message: error,
        lastChecked: new Date().toISOString()
      };
    }

    return {
      status: latencyMs > 2000 ? 'degraded' : 'healthy',
      latencyMs,
      lastChecked: new Date().toISOString()
    };
  } catch (error: unknown) {
    return {
      status: 'unhealthy',
      message: getErrorMessage(error),
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkGoogleCalendar(): Promise<ServiceHealth> {
  try {
    const calendar = await getGoogleCalendarClient();
    
    if (!calendar) {
      return {
        status: 'unhealthy',
        message: 'Google Calendar not configured',
        lastChecked: new Date().toISOString()
      };
    }

    const { latencyMs, error } = await checkWithTimeout(
      () => calendar.calendarList.list({ maxResults: 1 }),
      5000
    );

    if (error) {
      return {
        status: 'unhealthy',
        latencyMs,
        message: error,
        lastChecked: new Date().toISOString()
      };
    }

    return {
      status: latencyMs > 2000 ? 'degraded' : 'healthy',
      latencyMs,
      lastChecked: new Date().toISOString()
    };
  } catch (error: unknown) {
    return {
      status: 'unhealthy',
      message: getErrorMessage(error),
      lastChecked: new Date().toISOString()
    };
  }
}

export interface ExternalSystemHealth extends SystemHealth {
  services: SystemHealth['services'] & {
    trackman: ServiceHealth;
  };
  calendarSync: Record<string, { lastSyncAt: string | null; success: boolean; consecutiveFailures: number; error?: string }> | null;
  emailHealth: {
    bounceRate7d: number | null;
    suppressedCount: number | null;
  } | null;
  dbPool: {
    totalConnections: number | null;
    idleConnections: number | null;
    activeConnections: number | null;
  } | null;
}

async function checkTrackman(): Promise<ServiceHealth> {
  const webhookSecret = process.env.TRACKMAN_WEBHOOK_SECRET;
  try {
    const { latencyMs, error } = await checkWithTimeout(
      () => db.execute(sql`
        SELECT COUNT(*) as cnt FROM trackman_webhook_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `),
      3000
    );

    if (error) {
      return { status: 'unhealthy', latencyMs, message: error, lastChecked: new Date().toISOString() };
    }

    return {
      status: 'healthy',
      latencyMs,
      message: webhookSecret ? 'Signature validation enabled' : 'Accepting all webhooks (no secret required)',
      lastChecked: new Date().toISOString()
    };
  } catch (error: unknown) {
    return { status: 'unhealthy', message: getErrorMessage(error), lastChecked: new Date().toISOString() };
  }
}

async function getDbPoolStats(): Promise<{ totalConnections: number | null; idleConnections: number | null; activeConnections: number | null }> {
  try {
    const result = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as total_connections,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') as idle_connections,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') as active_connections
    `);
    const row = result.rows[0] as Record<string, string> | undefined;
    return {
      totalConnections: row ? Number(row.total_connections) : null,
      idleConnections: row ? Number(row.idle_connections) : null,
      activeConnections: row ? Number(row.active_connections) : null,
    };
  } catch {
    return { totalConnections: null, idleConnections: null, activeConnections: null };
  }
}

async function getEmailHealthStats(): Promise<{ bounceRate7d: number | null; suppressedCount: number | null }> {
  try {
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND event_id LIKE 'local-%' AND created_at >= NOW() - INTERVAL '7 days') AS sent_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '7 days') AS bounced_7d
      FROM email_events
    `);
    const raw = result.rows[0] as Record<string, string> | undefined;
    const sent = Number(raw?.sent_7d) || 0;
    const bounced = Number(raw?.bounced_7d) || 0;
    const bounceRate = sent > 0 ? (bounced / sent) * 100 : 0;

    const suppressedResult = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM users WHERE email_delivery_status IN ('bounced', 'complained')
    `);
    const suppressedCount = Number((suppressedResult.rows[0] as Record<string, string>)?.cnt) || 0;

    return { bounceRate7d: Math.round(bounceRate * 100) / 100, suppressedCount };
  } catch {
    return { bounceRate7d: null, suppressedCount: null };
  }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const [database, stripe, hubspot, resend, googleCalendar] = await Promise.all([
    checkDatabase(),
    checkStripe(),
    checkHubSpot(),
    checkResend(),
    checkGoogleCalendar()
  ]);

  const services = { database, stripe, hubspot, resend, googleCalendar };
  
  const statuses = Object.values(services).map(s => s.status);
  let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  
  if (statuses.includes('unhealthy')) {
    overall = database.status === 'unhealthy' ? 'unhealthy' : 'degraded';
  } else if (statuses.includes('degraded')) {
    overall = 'degraded';
  }

  logger.info('Health check completed', {
    extra: {
      event: 'health_check',
      overall,
      services: Object.fromEntries(
        Object.entries(services).map(([k, v]) => [k, v.status])
      )
    }
  });

  return {
    overall,
    services,
    timestamp: new Date().toISOString()
  };
}

export async function getExternalSystemsHealth(): Promise<ExternalSystemHealth> {
  const [database, stripe, hubspot, resend, googleCalendar, trackman, dbPool, emailHealth] = await Promise.all([
    checkDatabase(),
    checkStripe(),
    checkHubSpot(),
    checkResend(),
    checkGoogleCalendar(),
    checkTrackman(),
    getDbPoolStats(),
    getEmailHealthStats(),
  ]);

  let calendarSync: ExternalSystemHealth['calendarSync'] = null;
  try {
    const { getCalendarSyncHealth } = await import('../schedulers/backgroundSyncScheduler');
    calendarSync = getCalendarSyncHealth();
  } catch {
    calendarSync = null;
  }

  const services = { database, stripe, hubspot, resend, googleCalendar, trackman };

  const statuses = Object.values(services).map(s => s.status);
  let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  if (statuses.includes('unhealthy')) {
    overall = database.status === 'unhealthy' ? 'unhealthy' : 'degraded';
  } else if (statuses.includes('degraded')) {
    overall = 'degraded';
  }

  return {
    overall,
    services,
    calendarSync,
    emailHealth,
    dbPool,
    timestamp: new Date().toISOString()
  };
}

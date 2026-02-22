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
  const { result, latencyMs, error } = await checkWithTimeout(
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
      logger.debug('HubSpot OAuth client unavailable, trying private app client', { error: err });
      const privateClient = getHubSpotPrivateAppClient();
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

import { pool } from './db';
import { logger } from './logger';

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
  } catch (error: any) {
    return {
      result: null,
      latencyMs: Date.now() - start,
      error: error.message || 'Unknown error'
    };
  }
}

async function checkDatabase(): Promise<ServiceHealth> {
  const { result, latencyMs, error } = await checkWithTimeout(
    () => pool.query('SELECT 1'),
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
    const stripe = (await import('../replit_integrations/stripe')).default;
    if (!stripe) {
      return {
        status: 'unhealthy',
        message: 'Stripe not configured',
        lastChecked: new Date().toISOString()
      };
    }

    const { result, latencyMs, error } = await checkWithTimeout(
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
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: error.message,
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkHubSpot(): Promise<ServiceHealth> {
  try {
    const { hubspotClient } = await import('../replit_integrations/hubspot');
    if (!hubspotClient) {
      return {
        status: 'unhealthy',
        message: 'HubSpot not configured',
        lastChecked: new Date().toISOString()
      };
    }

    const { result, latencyMs, error } = await checkWithTimeout(
      () => hubspotClient.crm.owners.ownersApi.getPage(),
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
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: error.message,
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

    const { result, latencyMs, error } = await checkWithTimeout(
      async () => {
        const response = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${resendApiKey}` }
        });
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
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: error.message,
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkGoogleCalendar(): Promise<ServiceHealth> {
  try {
    const { getCalendarClient } = await import('../replit_integrations/calendar');
    const calendar = getCalendarClient();
    
    if (!calendar) {
      return {
        status: 'unhealthy',
        message: 'Google Calendar not configured',
        lastChecked: new Date().toISOString()
      };
    }

    const { result, latencyMs, error } = await checkWithTimeout(
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
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: error.message,
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

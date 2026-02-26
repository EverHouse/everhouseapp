import Stripe from 'stripe';

let connectionSettings: Record<string, unknown> | undefined;

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  const connectorName = 'stripe';
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  const targetEnvironment = isProduction ? 'production' : 'development';

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set('include_secrets', 'true');
  url.searchParams.set('connector_names', connectorName);
  url.searchParams.set('environment', targetEnvironment);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X_REPLIT_TOKEN': xReplitToken
    }
  });

  const data = await response.json();
  
  connectionSettings = data.items?.[0];

  const settings = connectionSettings?.settings as Record<string, unknown> | undefined;
  if (!connectionSettings || !settings || (!settings.publishable || !settings.secret)) {
    throw new Error(`Stripe ${targetEnvironment} connection not found`);
  }

  return {
    publishableKey: settings.publishable as string,
    secretKey: settings.secret as string,
  };
}

export async function getStripeClient(): Promise<Stripe> {
  const { secretKey } = await getCredentials();

  return new Stripe(secretKey, {
    apiVersion: '2025-08-27.basil' as Stripe.LatestApiVersion,
  });
}

export async function getStripePublishableKey(): Promise<string> {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey(): Promise<string> {
  const { secretKey } = await getCredentials();
  return secretKey;
}

export async function getStripeEnvironmentInfo(): Promise<{ isLive: boolean; mode: 'live' | 'test'; isProduction: boolean }> {
  const { secretKey } = await getCredentials();
  const isLive = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  return { isLive, mode: isLive ? 'live' : 'test', isProduction };
}

let stripeSync: unknown = null;

export async function getStripeSync() {
  if (!stripeSync) {
    const { StripeSync } = await import('stripe-replit-sync');
    const secretKey = await getStripeSecretKey();

    const connectionString = process.env.DATABASE_POOLER_URL || process.env.DATABASE_URL || '';
    if (!connectionString) {
      throw new Error('[StripeSync] No DATABASE_URL or DATABASE_POOLER_URL configured');
    }
    const needsSsl = process.env.NODE_ENV === 'production' || !!process.env.DATABASE_POOLER_URL;
    stripeSync = new StripeSync({
      poolConfig: {
        connectionString,
        max: 2,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}

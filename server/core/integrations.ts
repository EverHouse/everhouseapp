import { Client } from '@hubspot/api-client';
import { google } from 'googleapis';

import { logger } from './logger';

interface OAuthCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number | string;
}

interface IntegrationSettings {
  access_token?: string;
  expires_at?: number | string;
  oauth?: {
    credentials?: OAuthCredentials;
  };
}

interface ConnectionItem {
  id?: string;
  settings?: IntegrationSettings;
}

interface ConnectorApiResponse {
  items?: ConnectionItem[];
  error?: string;
  message?: string;
}

let hubspotConnectionSettings: ConnectionItem | null = null;
let googleCalendarConnectionSettings: ConnectionItem | null = null;

let hubspotTokenRefreshPromise: Promise<string> | null = null;
let googleCalendarTokenRefreshPromise: Promise<string> | null = null;

export async function getHubSpotAccessToken() {
  const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
  
  if (hubspotConnectionSettings) {
    const hsSettings = hubspotConnectionSettings.settings;
    const hsOauth = hsSettings?.oauth?.credentials;
    const expiresAt = hsSettings?.expires_at || hsOauth?.expires_at;
    const cachedToken = hsSettings?.access_token || hsOauth?.access_token;
    
    if (expiresAt && cachedToken && new Date(expiresAt as string).getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken as string;
    }
  }

  if (hubspotTokenRefreshPromise) {
    return hubspotTokenRefreshPromise;
  }
  
  hubspotTokenRefreshPromise = fetchHubSpotToken();
  try {
    return await hubspotTokenRefreshPromise;
  } finally {
    hubspotTokenRefreshPromise = null;
  }
}

async function fetchHubSpotToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME || 'connectors.replit.com';
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    logger.error('[HubSpot] Connector auth failed - missing token', { extra: { REPL_IDENTITY: !!process.env.REPL_IDENTITY, WEB_REPL_RENEWAL: !!process.env.WEB_REPL_RENEWAL } });
    throw new Error('HubSpot connector not available - deployment token missing. Please ensure the HubSpot integration is enabled for this deployment.');
  }

  const response = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=hubspot',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    logger.error('[HubSpot] Connector API returned non-OK status', { extra: { status: response.status, body: errorText.substring(0, 200) } });
    throw new Error(`HubSpot connector API error (HTTP ${response.status})`);
  }
  
  const data: ConnectorApiResponse = await response.json();
  
  if (!data.items || data.items.length === 0) {
    logger.error('[HubSpot] Connector API response:', { extra: { detail: JSON.stringify({ 
      status: response.status,
      hasItems: !!data.items,
      itemCount: data.items?.length || 0,
      hostname,
      error: data.error || data.message || null
    }) } });
    throw new Error('HubSpot not connected - please add HubSpot from the Integrations panel (All Connectors tab)');
  }
  
  hubspotConnectionSettings = data.items[0];

  if (!hubspotConnectionSettings || !hubspotConnectionSettings.settings) {
    logger.error('[HubSpot] Connection found but missing settings:', { extra: { detail: JSON.stringify({
      hasConnection: !!hubspotConnectionSettings,
      hasSettings: !!hubspotConnectionSettings?.settings,
      connectionId: hubspotConnectionSettings?.id
    }) } });
    throw new Error('HubSpot connection found but not authenticated - please reconnect in Integrations panel');
  }
  
  const hsSettings2 = hubspotConnectionSettings.settings;
  const hsOauth2 = hsSettings2?.oauth?.credentials;
  const accessToken = hsSettings2?.access_token || hsOauth2?.access_token;

  if (!accessToken) {
    throw new Error('HubSpot not connected - no access token found');
  }
  return accessToken;
}

export async function getHubSpotClient() {
  const accessToken = await getHubSpotAccessToken();
  return new Client({ accessToken: accessToken as string });
}

export async function getHubSpotPrivateAppClient(): Promise<Client | null> {
  try {
    const { db } = await import('../db');
    const { systemSettings } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'hubspot_private_app_token'))
      .limit(1);
    if (rows.length > 0 && rows[0].value) {
      return new Client({ accessToken: rows[0].value });
    }
  } catch {
    logger.debug('[Integrations] Failed to read HubSpot private app token from settings');
  }
  return null;
}

export async function getHubSpotClientWithFallback(): Promise<{ client: Client; source: 'connector' | 'private_app' }> {
  const privateAppClient = await getHubSpotPrivateAppClient();
  if (privateAppClient) {
    return { client: privateAppClient, source: 'private_app' };
  }

  const accessToken = await getHubSpotAccessToken();
  return { client: new Client({ accessToken: accessToken as string }), source: 'connector' };
}

async function fetchGoogleCalendarToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME || 'connectors.replit.com';
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    logger.error('[Google Calendar] Connector auth failed - missing token', { extra: { REPL_IDENTITY: !!process.env.REPL_IDENTITY, WEB_REPL_RENEWAL: !!process.env.WEB_REPL_RENEWAL } });
    throw new Error('Google Calendar connector not available - deployment token missing. Please ensure the Google Calendar integration is enabled for this deployment.');
  }

  const connectorResponse = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-calendar',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  );

  if (!connectorResponse.ok) {
    const errorText = await connectorResponse.text().catch(() => 'unknown');
    logger.error('[Google Calendar] Connector API returned non-OK status', { extra: { status: connectorResponse.status, body: errorText.substring(0, 200) } });
    throw new Error(`Google Calendar connector API error (HTTP ${connectorResponse.status})`);
  }

  googleCalendarConnectionSettings = await connectorResponse.json().then((data: ConnectorApiResponse) => data.items?.[0] ?? null);

  const gcSettings2 = googleCalendarConnectionSettings?.settings;
  const gcOauth2 = gcSettings2?.oauth?.credentials;
  const accessToken = gcSettings2?.access_token || gcOauth2?.access_token;

  if (!googleCalendarConnectionSettings || !accessToken) {
    throw new Error('Google Calendar not connected');
  }
  return accessToken as string;
}

async function getGoogleCalendarAccessToken() {
  const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
  
  if (googleCalendarConnectionSettings) {
    const gcSettings = googleCalendarConnectionSettings.settings;
    const gcOauth = gcSettings?.oauth?.credentials;
    const expiresAt = gcSettings?.expires_at || gcOauth?.expires_at;
    const cachedToken = gcSettings?.access_token || gcOauth?.access_token;
    
    if (expiresAt && cachedToken && new Date(expiresAt as string).getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken as string;
    }
  }

  if (googleCalendarTokenRefreshPromise) {
    return googleCalendarTokenRefreshPromise;
  }

  googleCalendarTokenRefreshPromise = fetchGoogleCalendarToken();
  try {
    return await googleCalendarTokenRefreshPromise;
  } finally {
    googleCalendarTokenRefreshPromise = null;
  }
}

export async function getGoogleCalendarClient() {
  const accessToken = await getGoogleCalendarAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken as string });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

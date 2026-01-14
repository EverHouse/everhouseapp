import { Client } from '@hubspot/api-client';
import { google } from 'googleapis';

let hubspotConnectionSettings: any;
let googleCalendarConnectionSettings: any;

async function getHubSpotAccessToken() {
  const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  
  if (hubspotConnectionSettings) {
    const expiresAt = hubspotConnectionSettings.settings?.expires_at || 
                      hubspotConnectionSettings.settings?.oauth?.credentials?.expires_at;
    const cachedToken = hubspotConnectionSettings.settings?.access_token || 
                        hubspotConnectionSettings.settings?.oauth?.credentials?.access_token;
    
    if (expiresAt && cachedToken && new Date(expiresAt).getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken;
    }
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME || 'connectors.replit.com';
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    console.error('[HubSpot] Connector auth failed - missing token. REPL_IDENTITY:', !!process.env.REPL_IDENTITY, 'WEB_REPL_RENEWAL:', !!process.env.WEB_REPL_RENEWAL);
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
  
  const data = await response.json();
  
  // Debug logging to understand what's coming back
  if (!data.items || data.items.length === 0) {
    console.error('[HubSpot] Connector API response:', JSON.stringify({ 
      status: response.status,
      hasItems: !!data.items,
      itemCount: data.items?.length || 0,
      hostname,
      error: data.error || data.message || null
    }));
    throw new Error('HubSpot not connected - please add HubSpot from the Integrations panel (All Connectors tab)');
  }
  
  hubspotConnectionSettings = data.items[0];

  if (!hubspotConnectionSettings || !hubspotConnectionSettings.settings) {
    console.error('[HubSpot] Connection found but missing settings:', JSON.stringify({
      hasConnection: !!hubspotConnectionSettings,
      hasSettings: !!hubspotConnectionSettings?.settings,
      connectionId: hubspotConnectionSettings?.id
    }));
    throw new Error('HubSpot connection found but not authenticated - please reconnect in Integrations panel');
  }
  
  const accessToken = hubspotConnectionSettings.settings?.access_token || hubspotConnectionSettings.settings?.oauth?.credentials?.access_token;

  if (!accessToken) {
    throw new Error('HubSpot not connected - no access token found');
  }
  return accessToken;
}

export async function getHubSpotClient() {
  const accessToken = await getHubSpotAccessToken();
  return new Client({ accessToken });
}

async function getGoogleCalendarAccessToken() {
  const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  
  if (googleCalendarConnectionSettings) {
    const expiresAt = googleCalendarConnectionSettings.settings?.expires_at || 
                      googleCalendarConnectionSettings.settings?.oauth?.credentials?.expires_at;
    const cachedToken = googleCalendarConnectionSettings.settings?.access_token || 
                        googleCalendarConnectionSettings.settings?.oauth?.credentials?.access_token;
    
    if (expiresAt && cachedToken && new Date(expiresAt).getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken;
    }
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME || 'connectors.replit.com';
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    console.error('[Google Calendar] Connector auth failed - missing token. REPL_IDENTITY:', !!process.env.REPL_IDENTITY, 'WEB_REPL_RENEWAL:', !!process.env.WEB_REPL_RENEWAL);
    throw new Error('Google Calendar connector not available - deployment token missing. Please ensure the Google Calendar integration is enabled for this deployment.');
  }

  googleCalendarConnectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-calendar',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then((data: any) => data.items?.[0]);

  const accessToken = googleCalendarConnectionSettings?.settings?.access_token || googleCalendarConnectionSettings.settings?.oauth?.credentials?.access_token;

  if (!googleCalendarConnectionSettings || !accessToken) {
    throw new Error('Google Calendar not connected');
  }
  return accessToken;
}

export async function getGoogleCalendarClient() {
  const accessToken = await getGoogleCalendarAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

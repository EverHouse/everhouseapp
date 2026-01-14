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
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  hubspotConnectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=hubspot',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then((data: any) => data.items?.[0]);

  if (!hubspotConnectionSettings || !hubspotConnectionSettings.settings) {
    throw new Error('HubSpot not connected - no connection settings found');
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
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
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

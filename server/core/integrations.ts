import { Client } from '@hubspot/api-client';
import { google } from 'googleapis';

let hubspotConnectionSettings: any;
let googleCalendarConnectionSettings: any;

async function getHubSpotAccessToken() {
  if (hubspotConnectionSettings && hubspotConnectionSettings.settings.expires_at && new Date(hubspotConnectionSettings.settings.expires_at).getTime() > Date.now()) {
    return hubspotConnectionSettings.settings.access_token;
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

  const accessToken = hubspotConnectionSettings?.settings?.access_token || hubspotConnectionSettings.settings?.oauth?.credentials?.access_token;

  if (!hubspotConnectionSettings || !accessToken) {
    throw new Error('HubSpot not connected');
  }
  return accessToken;
}

export async function getHubSpotClient() {
  const accessToken = await getHubSpotAccessToken();
  return new Client({ accessToken });
}

async function getGoogleCalendarAccessToken() {
  if (googleCalendarConnectionSettings && googleCalendarConnectionSettings.settings.expires_at && new Date(googleCalendarConnectionSettings.settings.expires_at).getTime() > Date.now()) {
    return googleCalendarConnectionSettings.settings.access_token;
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

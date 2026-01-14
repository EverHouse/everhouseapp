import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { pool, isProduction } from '../core/db';
import { getHubSpotClient } from '../core/integrations';
import { db } from '../db';
import { formSubmissions, users } from '../../shared/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { notifyAllStaff } from '../core/staffNotifications';
import { isStaffOrAdmin } from '../core/middleware';
import { normalizeTierName, extractTierTags, TIER_NAMES } from '../../shared/constants/tiers';
import * as fs from 'fs';
import * as path from 'path';
import pRetry, { AbortError } from 'p-retry';
import { broadcastDirectoryUpdate } from '../core/websocket';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';

/**
 * Validate HubSpot webhook signature (v3 method)
 * See: https://developers.hubspot.com/docs/api/webhooks/validating-requests
 */
function validateHubSpotWebhookSignature(req: Request): boolean {
  const webhookSecret = process.env.HUBSPOT_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    if (isProduction) {
      console.warn('[HubSpot Webhook] No HUBSPOT_WEBHOOK_SECRET configured - rejecting in production');
      return false;
    }
    console.warn('[HubSpot Webhook] No HUBSPOT_WEBHOOK_SECRET configured - allowing in development');
    return true;
  }
  
  const signature = req.headers['x-hubspot-signature-v3'] as string | undefined;
  const timestamp = req.headers['x-hubspot-request-timestamp'] as string | undefined;
  
  if (!signature || !timestamp) {
    console.warn('[HubSpot Webhook] Missing signature headers');
    return false;
  }
  
  const currentTime = Date.now();
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(currentTime - requestTime) > 300000) {
    console.warn('[HubSpot Webhook] Request timestamp too old');
    return false;
  }
  
  const requestUrl = `https://${req.headers.host}${req.originalUrl}`;
  const rawBody = req.rawBody || '';
  const sourceString = `POST${requestUrl}${rawBody}${timestamp}`;
  
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(sourceString)
    .digest('base64');
  
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  
  if (signatureBuf.length !== expectedBuf.length) {
    console.warn('[HubSpot Webhook] Signature length mismatch');
    return false;
  }
  
  const isValid = crypto.timingSafeEqual(signatureBuf, expectedBuf);
  
  if (!isValid) {
    console.warn('[HubSpot Webhook] Invalid signature');
  }
  
  return isValid;
}

const router = Router();

// Shared cache for all HubSpot contacts (used by both active and former member views)
let allContactsCache: { data: any[] | null; timestamp: number; lastModifiedCheck: number } = { data: null, timestamp: 0, lastModifiedCheck: 0 };
const ALL_CONTACTS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes for full refresh
const INCREMENTAL_SYNC_INTERVAL = 5 * 60 * 1000; // Check for updates every 5 minutes

// Track if a background refresh is in progress
let backgroundRefreshInProgress = false;

/**
 * Check if an error is a HubSpot rate limit error (429)
 */
function isRateLimitError(error: any): boolean {
  const errorMsg = error instanceof Error ? error.message : String(error);
  // HubSpot SDK might wrap errors, so check status code if available
  const statusCode = error?.response?.statusCode || error?.status || error?.code;
  
  return (
    statusCode === 429 ||
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

/**
 * Generic HubSpot request wrapper with retry logic for rate limits
 */
async function retryableHubSpotRequest<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error: any) {
        if (isRateLimitError(error)) {
          if (!isProduction) console.warn('HubSpot Rate Limit hit, retrying...');
          throw error; // Trigger p-retry
        }
        // Non-rate-limit errors should abort immediately
        throw new AbortError(error);
      }
    },
    {
      retries: 5,
      minTimeout: 1000,
      maxTimeout: 30000,
      factor: 2
    }
  );
}

const HUBSPOT_CONTACT_PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'company',
  'hs_lead_status',
  'lifecyclestage',
  'createdate',
  'membership_tier',
  'membership_status',
  'membership_discount_reason',
  'lastmodifieddate'
];

/**
 * Transform a raw HubSpot contact into our normalized format
 */
function transformHubSpotContact(contact: any): any {
  const lifecycleStage = (contact.properties.lifecyclestage || '').toLowerCase();
  const membershipStatus = (contact.properties.membership_status || '').toLowerCase();
  
  const activeStatuses = ['active'];
  const formerStatuses = ['expired', 'terminated', 'former_member', 'cancelled', 'canceled', 'inactive', 'churned', 'declined', 'suspended', 'frozen', 'froze', 'pending', 'non-member'];
  
  const isActiveMember = activeStatuses.includes(membershipStatus);
  const isFormerMember = formerStatuses.includes(membershipStatus);
  
  const rawTierValue = contact.properties.membership_tier;
  
  return {
    id: contact.id,
    firstName: contact.properties.firstname || '',
    lastName: contact.properties.lastname || '',
    email: contact.properties.email || '',
    phone: contact.properties.phone || '',
    company: contact.properties.company || '',
    lifecycleStage,
    status: membershipStatus || (isActiveMember ? 'active' : ''),
    tier: normalizeTierName(rawTierValue),
    rawTier: rawTierValue && rawTierValue.trim() ? rawTierValue.trim() : null,
    tags: extractTierTags(contact.properties.membership_tier, contact.properties.membership_discount_reason),
    createdAt: contact.properties.createdate,
    lastModified: contact.properties.lastmodifieddate,
    isActiveMember,
    isFormerMember
  };
}

/**
 * Fetch only contacts modified since the given timestamp using HubSpot Search API
 * This is much more efficient than fetching all contacts when we only need updates
 */
async function fetchRecentlyModifiedContacts(sinceTimestamp: number): Promise<any[]> {
  const hubspot = await getHubSpotClient();
  
  let modifiedContacts: any[] = [];
  let after: string | undefined = undefined;
  
  do {
    const searchRequest = {
      filterGroups: [{
        filters: [{
          propertyName: 'lastmodifieddate',
          operator: FilterOperatorEnum.Gte,
          value: sinceTimestamp.toString()
        }]
      }],
      properties: HUBSPOT_CONTACT_PROPERTIES,
      limit: 100,
      after: after || '0'
    };
    
    const response = await retryableHubSpotRequest(() => 
      hubspot.crm.contacts.searchApi.doSearch(searchRequest)
    );
    
    modifiedContacts = modifiedContacts.concat(response.results);
    after = response.paging?.next?.after;
  } while (after);
  
  return modifiedContacts.map(transformHubSpotContact);
}

/**
 * Fetch and cache all HubSpot contacts with incremental sync support
 * - Full refresh: Every 30 minutes or on force refresh
 * - Incremental sync: Every 5 minutes, only fetches recently modified contacts
 */
async function fetchAllHubSpotContacts(forceRefresh: boolean = false): Promise<any[]> {
  const now = Date.now();
  
  // If we have cache and it's within TTL, check if we need incremental sync
  if (!forceRefresh && allContactsCache.data && (now - allContactsCache.timestamp) < ALL_CONTACTS_CACHE_TTL) {
    // Check if we should do an incremental sync
    if ((now - allContactsCache.lastModifiedCheck) > INCREMENTAL_SYNC_INTERVAL) {
      try {
        const modifiedContacts = await fetchRecentlyModifiedContacts(allContactsCache.lastModifiedCheck);
        
        if (modifiedContacts.length > 0) {
          // Enrich the modified contacts with DB data FIRST (before updating cache)
          const enrichedModified = await enrichContactsWithDbData(modifiedContacts);
          
          // Now merge enriched contacts into cache, preserving existing enriched data for unchanged contacts
          const contactMap = new Map(allContactsCache.data.map((c: any) => [c.id, c]));
          for (const contact of enrichedModified) {
            contactMap.set(contact.id, contact);
          }
          
          allContactsCache.data = Array.from(contactMap.values());
          if (!isProduction) console.log(`[HubSpot] Incremental sync: updated ${modifiedContacts.length} contacts`);
        }
        
        allContactsCache.lastModifiedCheck = now;
      } catch (err) {
        // Incremental sync failed, continue with cached data
        if (!isProduction) console.warn('[HubSpot] Incremental sync failed, using cached data:', err);
      }
    }
    
    return allContactsCache.data;
  }
  
  // Full refresh needed
  if (!isProduction) console.log('[HubSpot] Performing full contact sync...');
  
  const hubspot = await getHubSpotClient();
  
  let allContacts: any[] = [];
  let after: string | undefined = undefined;
  
  do {
    const response = await retryableHubSpotRequest(() => 
      hubspot.crm.contacts.basicApi.getPage(100, after, HUBSPOT_CONTACT_PROPERTIES)
    );
    allContacts = allContacts.concat(response.results);
    after = response.paging?.next?.after;
  } while (after);
  
  if (!isProduction) console.log(`[HubSpot] Full sync: fetched ${allContacts.length} contacts`);

  // Transform raw HubSpot data
  const hubspotContacts = allContacts.map(transformHubSpotContact);
  
  // Enrich with database data
  const enrichedContacts = await enrichContactsWithDbData(hubspotContacts);
  
  // Update cache with full refresh data
  allContactsCache = { data: enrichedContacts, timestamp: now, lastModifiedCheck: now };
  
  return enrichedContacts;
}

/**
 * Enrich contacts with additional data from the database (visits, join dates, etc.)
 */
async function enrichContactsWithDbData(contacts: any[]): Promise<any[]> {
  const emails = contacts.map((c: any) => c.email.toLowerCase()).filter(Boolean);
  
  if (emails.length === 0) return contacts;
  
  let dbUserMap: Record<string, any> = {};
  let lastActivityMap: Record<string, string> = {};
  let pastBookingsMap: Record<string, number> = {};
  let eventVisitsMap: Record<string, number> = {};
  let wellnessVisitsMap: Record<string, number> = {};
  
  // Get user data including id for matched_user_id joins
  const dbResult = await pool.query(
    `SELECT id, email, joined_on, mindbody_client_id, manually_linked_emails 
     FROM users WHERE LOWER(email) = ANY($1)`,
    [emails]
  );
  for (const row of dbResult.rows) {
    dbUserMap[row.email.toLowerCase()] = row;
  }
  
  // Get last visit date - most recent PAST date from bookings or experiences
  const lastActivityResult = await pool.query(
    `SELECT email, MAX(activity_date) as last_activity FROM (
      SELECT LOWER(user_email) as email, request_date as activity_date
      FROM booking_requests 
      WHERE LOWER(user_email) = ANY($1) AND request_date < CURRENT_DATE AND status NOT IN ('cancelled', 'declined')
      UNION ALL
      SELECT LOWER(er.user_email) as email, e.event_date as activity_date
      FROM event_rsvps er
      JOIN events e ON er.event_id = e.id
      WHERE LOWER(er.user_email) = ANY($1) AND e.event_date < CURRENT_DATE AND er.status != 'cancelled'
      UNION ALL
      SELECT LOWER(we.user_email) as email, wc.date as activity_date
      FROM wellness_enrollments we
      JOIN wellness_classes wc ON we.class_id = wc.id
      WHERE LOWER(we.user_email) = ANY($1) AND wc.date < CURRENT_DATE AND we.status != 'cancelled'
    ) combined
    GROUP BY email`,
    [emails]
  );
  for (const row of lastActivityResult.rows) {
    if (row.last_activity) {
      const date = row.last_activity instanceof Date ? row.last_activity : new Date(row.last_activity);
      lastActivityMap[row.email] = date.toISOString().split('T')[0];
    }
  }
  
  // Count past bookings (excluding cancelled/declined)
  const pastBookingsResult = await pool.query(
    `SELECT LOWER(user_email) as email, COUNT(*)::int as count
     FROM booking_requests
     WHERE LOWER(user_email) = ANY($1)
       AND request_date < CURRENT_DATE
       AND status NOT IN ('cancelled', 'declined')
     GROUP BY LOWER(user_email)`,
    [emails]
  );
  for (const row of pastBookingsResult.rows) {
    pastBookingsMap[row.email] = row.count;
  }
  
  // Count past event RSVPs (excluding cancelled) - include both email and matched_user_id
  const eventVisitsResult = await pool.query(
    `SELECT u.email, COUNT(DISTINCT er.id)::int as count
     FROM users u
     JOIN event_rsvps er ON (LOWER(er.user_email) = LOWER(u.email) OR er.matched_user_id = u.id)
     JOIN events e ON er.event_id = e.id
     WHERE LOWER(u.email) = ANY($1)
       AND er.status != 'cancelled'
       AND e.event_date < CURRENT_DATE
     GROUP BY u.email`,
    [emails]
  );
  for (const row of eventVisitsResult.rows) {
    eventVisitsMap[row.email.toLowerCase()] = row.count;
  }
  
  // Count past wellness enrollments (excluding cancelled)
  const wellnessVisitsResult = await pool.query(
    `SELECT LOWER(we.user_email) as email, COUNT(*)::int as count
     FROM wellness_enrollments we
     JOIN wellness_classes wc ON we.class_id = wc.id
     WHERE LOWER(we.user_email) = ANY($1)
       AND we.status != 'cancelled'
       AND wc.date < CURRENT_DATE
     GROUP BY LOWER(we.user_email)`,
    [emails]
  );
  for (const row of wellnessVisitsResult.rows) {
    wellnessVisitsMap[row.email] = row.count;
  }
  
  // Merge contact data with database data
  return contacts.map((contact: any) => {
    const emailLower = contact.email.toLowerCase();
    const dbUser = dbUserMap[emailLower];
    const pastBookings = pastBookingsMap[emailLower] || 0;
    const eventVisits = eventVisitsMap[emailLower] || 0;
    const wellnessVisits = wellnessVisitsMap[emailLower] || 0;
    return {
      ...contact,
      lifetimeVisits: pastBookings + eventVisits + wellnessVisits,
      joinDate: dbUser?.joined_on || null,
      mindbodyClientId: dbUser?.mindbody_client_id || null,
      manuallyLinkedEmails: dbUser?.manually_linked_emails || [],
      lastBookingDate: lastActivityMap[emailLower] || null
    };
  });
}

router.get('/api/hubspot/contacts', isStaffOrAdmin, async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  const statusFilter = (req.query.status as string)?.toLowerCase() || 'active';
  const now = Date.now();
  
  const filterContacts = (contacts: any[]) => {
    return contacts.filter((contact: any) => {
      if (statusFilter === 'active') return contact.isActiveMember;
      if (statusFilter === 'former') return contact.isFormerMember;
      return true;
    });
  };
  
  const buildResponse = (contacts: any[], stale: boolean, refreshing: boolean) => {
    return { contacts, stale, refreshing, count: contacts.length };
  };
  
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  
  const hasFreshCache = allContactsCache.data && (now - allContactsCache.timestamp) < ALL_CONTACTS_CACHE_TTL;
  
  if (hasFreshCache && !forceRefresh) {
    const needsIncrementalSync = (now - allContactsCache.lastModifiedCheck) > INCREMENTAL_SYNC_INTERVAL;
    
    if (needsIncrementalSync && !backgroundRefreshInProgress) {
      backgroundRefreshInProgress = true;
      fetchAllHubSpotContacts(false)
        .catch(err => {
          if (!isProduction) console.warn('[HubSpot] Background incremental sync failed:', err);
        })
        .finally(() => {
          backgroundRefreshInProgress = false;
        });
    }
    
    const filteredContacts = filterContacts(allContactsCache.data!);
    return res.json(buildResponse(filteredContacts, false, backgroundRefreshInProgress));
  }
  
  if (allContactsCache.data) {
    const filteredContacts = filterContacts(allContactsCache.data);
    const isStale = (now - allContactsCache.timestamp) >= ALL_CONTACTS_CACHE_TTL;
    
    if (!backgroundRefreshInProgress) {
      backgroundRefreshInProgress = true;
      fetchAllHubSpotContacts(forceRefresh)
        .catch(err => {
          if (!isProduction) console.warn('[HubSpot] Background full sync failed:', err);
        })
        .finally(() => {
          backgroundRefreshInProgress = false;
        });
    }
    
    return res.json(buildResponse(filteredContacts, isStale, true));
  }
  
  if (!backgroundRefreshInProgress) {
    backgroundRefreshInProgress = true;
    fetchAllHubSpotContacts(true)
      .then(contacts => {
        backgroundRefreshInProgress = false;
      })
      .catch(err => {
        if (!isProduction) console.warn('[HubSpot] Initial sync failed:', err);
        backgroundRefreshInProgress = false;
      });
  }
  
  return res.json(buildResponse([], true, true));
});

router.get('/api/hubspot/contacts/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const hubspot = await getHubSpotClient();
    const { id } = req.params;
    
    const contact = await retryableHubSpotRequest(() => 
      hubspot.crm.contacts.basicApi.getById(id, [
        'firstname',
        'lastname',
        'email',
        'phone',
        'company',
        'hs_lead_status',
        'createdate',
        'membership_tier',
        'membership_status',
        'membership_discount_reason'
      ])
    );

    res.json({
      id: contact.id,
      firstName: contact.properties.firstname || '',
      lastName: contact.properties.lastname || '',
      email: contact.properties.email || '',
      phone: contact.properties.phone || '',
      company: contact.properties.company || '',
      status: contact.properties.membership_status || contact.properties.hs_lead_status || 'Active',
      tier: normalizeTierName(contact.properties.membership_tier),
      tags: extractTierTags(contact.properties.membership_tier, contact.properties.membership_discount_reason),
      createdAt: contact.properties.createdate
    });
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Request failed' });
  }
});

const HUBSPOT_FORMS: Record<string, string> = {
  'tour-request': process.env.HUBSPOT_FORM_TOUR_REQUEST || '',
  'membership': process.env.HUBSPOT_FORM_MEMBERSHIP || '',
  'private-hire': process.env.HUBSPOT_FORM_PRIVATE_HIRE || '',
  'guest-checkin': process.env.HUBSPOT_FORM_GUEST_CHECKIN || '',
  'contact': process.env.HUBSPOT_FORM_CONTACT || ''
};

router.post('/api/hubspot/forms/:formType', async (req, res) => {
  try {
    const { formType } = req.params;
    const formId = HUBSPOT_FORMS[formType];
    const portalId = process.env.HUBSPOT_PORTAL_ID;
    
    if (!formId || !portalId) {
      return res.status(400).json({ error: 'Invalid form type or missing configuration' });
    }
    
    const { fields, context } = req.body;
    
    if (!Array.isArray(fields)) {
      return res.status(400).json({ error: 'Fields must be an array' });
    }
    
    for (const field of fields) {
      if (typeof field !== 'object' || field === null) {
        return res.status(400).json({ error: 'Each field must be an object' });
      }
      if (typeof field.name !== 'string' || field.name.length === 0 || field.name.length > 100) {
        return res.status(400).json({ error: 'Field name must be a non-empty string (max 100 chars)' });
      }
      if (typeof field.value !== 'string' || field.value.length > 5000) {
        return res.status(400).json({ error: 'Field value must be a string (max 5000 chars)' });
      }
    }
    
    if (context !== undefined && (typeof context !== 'object' || context === null)) {
      return res.status(400).json({ error: 'Context must be an object if provided' });
    }
    
    if (formType === 'guest-checkin') {
      const memberEmailField = fields.find((f: { name: string; value: string }) => f.name === 'member_email');
      if (!memberEmailField?.value) {
        return res.status(400).json({ error: 'Member email is required for guest check-in' });
      }
      
      const memberEmail = memberEmailField.value;
      
      const updateResult = await pool.query(
        `UPDATE guest_passes 
         SET passes_used = passes_used + 1 
         WHERE member_email = $1 AND passes_used < passes_total
         RETURNING passes_used, passes_total`,
        [memberEmail]
      );
      
      if (updateResult.rows.length === 0) {
        const passCheck = await pool.query(
          'SELECT passes_used, passes_total FROM guest_passes WHERE member_email = $1',
          [memberEmail]
        );
        
        if (passCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Guest pass record not found. Please contact staff.' });
        }
        
        return res.status(400).json({ error: 'No guest passes remaining. Please contact staff for assistance.' });
      }
    }
    
    const hubspotPayload = {
      fields: fields.map((f: { name: string; value: string }) => ({
        objectTypeId: '0-1',
        name: f.name,
        value: f.value
      })),
      context: {
        pageUri: context?.pageUri || '',
        pageName: context?.pageName || '',
        ...(context?.hutk && { hutk: context.hutk })
      }
    };
    
    const response = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hubspotPayload)
      }
    );
    
    if (!response.ok) {
      const errorData = await response.json();
      if (!isProduction) console.error('HubSpot form error:', errorData);
      return res.status(response.status).json({ error: 'Form submission failed' });
    }
    
    const result: any = await response.json();
    
    const getFieldValue = (name: string): string | undefined => {
      const field = fields.find((f: { name: string; value: string }) => f.name === name);
      return field?.value;
    };
    
    try {
      const metadata: Record<string, string> = {};
      for (const field of fields) {
        if (!['firstname', 'lastname', 'email', 'phone', 'message'].includes(field.name)) {
          metadata[field.name] = field.value;
        }
      }
      
      const insertResult = await db.insert(formSubmissions).values({
        formType,
        firstName: getFieldValue('firstname') || getFieldValue('first_name') || null,
        lastName: getFieldValue('lastname') || getFieldValue('last_name') || null,
        email: getFieldValue('email') || '',
        phone: getFieldValue('phone') || null,
        message: getFieldValue('message') || null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        status: 'new',
      }).returning();
      
      const formTypeLabels: Record<string, string> = {
        'tour-request': 'Tour Request',
        'membership': 'Membership Inquiry',
        'private-hire': 'Private Hire Inquiry',
        'guest-checkin': 'Guest Check-in',
        'contact': 'Contact Form'
      };
      const formLabel = formTypeLabels[formType] || 'Form Submission';
      const submitterName = [getFieldValue('firstname') || getFieldValue('first_name'), getFieldValue('lastname') || getFieldValue('last_name')].filter(Boolean).join(' ') || getFieldValue('email') || 'Someone';
      const staffMessage = `${submitterName} submitted a ${formLabel}`;
      
      notifyAllStaff(
        `New ${formLabel}`,
        staffMessage,
        'inquiry',
        insertResult[0]?.id ?? undefined,
        'form_submission'
      ).catch(err => console.error('Staff inquiry notification failed:', err));
    } catch (dbError: any) {
      console.error('Failed to save form submission locally:', dbError);
    }
    
    res.json({ success: true, message: result.inlineMessage || 'Form submitted successfully' });
  } catch (error: any) {
    if (!isProduction) console.error('HubSpot form submission error:', error);
    res.status(500).json({ error: 'Form submission failed' });
  }
});

// CSV parsing helper
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, string>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

// Sync membership tiers from CSV to HubSpot
router.post('/api/hubspot/sync-tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const hubspot = await getHubSpotClient();
    
    // Find the latest cleaned CSV file
    const assetsDir = path.join(process.cwd(), 'attached_assets');
    const files = fs.readdirSync(assetsDir)
      .filter(f => f.startsWith('even_house_cleaned_member_data') && f.endsWith('.csv'))
      .sort()
      .reverse();
    
    if (files.length === 0) {
      return res.status(404).json({ error: 'No cleaned member data CSV found' });
    }
    
    const csvPath = path.join(assetsDir, files[0]);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const csvRows = parseCSV(csvContent);
    
    console.log(`[Tier Sync] Loaded ${csvRows.length} rows from ${files[0]}`);
    
    // Build lookup map from CSV by email (normalized)
    const csvByEmail = new Map<string, { tier: string; mindbodyId: string; name: string }>();
    for (const row of csvRows) {
      const email = (row.real_email || '').toLowerCase().trim();
      if (email) {
        csvByEmail.set(email, {
          tier: row.membership_tier || '',
          mindbodyId: row.mindbody_id || '',
          name: `${row.first_name || ''} ${row.last_name || ''}`.trim()
        });
      }
    }
    
    // Fetch all HubSpot contacts
    const properties = ['firstname', 'lastname', 'email', 'membership_tier', 'mindbody_client_id'];
    let allContacts: any[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await retryableHubSpotRequest(() => 
        hubspot.crm.contacts.basicApi.getPage(100, after, properties)
      );
      allContacts = allContacts.concat(response.results);
      after = response.paging?.next?.after;
    } while (after);
    
    console.log(`[Tier Sync] Fetched ${allContacts.length} contacts from HubSpot`);
    
    // Match and prepare updates
    const results = {
      matched: 0,
      updated: 0,
      skipped: 0,
      notFound: 0,
      errors: [] as string[],
      updates: [] as { email: string; name: string; oldTier: string; newTier: string }[]
    };
    
    const updateBatch: { id: string; properties: { membership_tier: string } }[] = [];
    
    for (const contact of allContacts) {
      const hubspotEmail = (contact.properties.email || '').toLowerCase().trim();
      if (!hubspotEmail) continue;
      
      const csvData = csvByEmail.get(hubspotEmail);
      if (!csvData) {
        results.notFound++;
        continue;
      }
      
      results.matched++;
      const currentTier = contact.properties.membership_tier || '';
      const newTier = csvData.tier;
      
      // Skip if tiers match (case-insensitive comparison)
      if (currentTier.toLowerCase() === newTier.toLowerCase()) {
        results.skipped++;
        continue;
      }
      
      // Queue for update
      results.updates.push({
        email: hubspotEmail,
        name: csvData.name,
        oldTier: currentTier || '(empty)',
        newTier: newTier
      });
      
      updateBatch.push({
        id: contact.id,
        properties: { membership_tier: newTier }
      });
    }
    
    // Execute updates if not dry run
    if (!dryRun && updateBatch.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < updateBatch.length; i += batchSize) {
        const batch = updateBatch.slice(i, i + batchSize);
        try {
          await retryableHubSpotRequest(() => 
            hubspot.crm.contacts.batchApi.update({
              inputs: batch
            })
          );
          results.updated += batch.length;
          console.log(`[Tier Sync] Updated batch ${Math.floor(i / batchSize) + 1}: ${batch.length} contacts`);
        } catch (err: any) {
          results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`);
          console.error(`[Tier Sync] Batch update error:`, err);
        }
      }
    } else if (dryRun) {
      results.updated = 0;
    }
    
    console.log(`[Tier Sync] Complete - Matched: ${results.matched}, Updates: ${results.updates.length}, Errors: ${results.errors.length}`);
    
    if (!dryRun && results.updated > 0) {
      broadcastDirectoryUpdate('synced');
    }
    
    res.json({
      success: true,
      dryRun,
      csvFile: files[0],
      csvRowCount: csvRows.length,
      hubspotContactCount: allContacts.length,
      matched: results.matched,
      toUpdate: results.updates.length,
      updated: results.updated,
      skipped: results.skipped,
      notFoundInCSV: results.notFound,
      errors: results.errors,
      updates: results.updates.slice(0, 50) // Limit preview to first 50
    });
  } catch (error: any) {
    console.error('[Tier Sync] Error:', error);
    res.status(500).json({ error: 'Tier sync failed: ' + error.message });
  }
});

/**
 * Update a contact's membership tier in HubSpot
 * Staff/admin only with audit logging
 */
router.put('/contacts/:id/tier', isStaffOrAdmin, async (req, res) => {
  const { id } = req.params;
  const { tier } = req.body;
  const staffUser = (req as any).staffUser;
  
  if (!tier || typeof tier !== 'string') {
    return res.status(400).json({ error: 'Tier is required' });
  }
  
  const validTiers = [...TIER_NAMES, 'Founding', 'Unlimited'] as string[];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
  }
  
  try {
    const hubspot = await getHubSpotClient();
    
    // Get current contact to log the change
    const contact = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.getById(id, ['membership_tier', 'firstname', 'lastname', 'email'])
    );
    
    const oldTier = contact.properties.membership_tier || '(empty)';
    const contactName = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ');
    const contactEmail = contact.properties.email || '';
    
    // Update the tier in HubSpot
    await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.update(id, {
        properties: { membership_tier: tier }
      })
    );
    
    // Log the change for audit purposes
    console.log(`[Tier Update] Contact ${id} (${contactName}, ${contactEmail}): ${oldTier} -> ${tier} by staff ${staffUser?.name || 'Unknown'}`);
    
    // Invalidate cache to reflect the change
    allContactsCache.timestamp = 0;
    
    // Broadcast update to all connected clients
    broadcastDirectoryUpdate('synced');
    
    res.json({
      success: true,
      contactId: id,
      contactName,
      contactEmail,
      oldTier,
      newTier: tier,
      updatedBy: staffUser?.name || 'Unknown'
    });
  } catch (error: any) {
    console.error(`[Tier Update] Error updating contact ${id}:`, error);
    res.status(500).json({ error: 'Failed to update tier: ' + error.message });
  }
});

/**
 * HubSpot webhook receiver endpoint
 * Handles contact and deal property change events
 * Raw body is captured by express.json verify function in server/index.ts
 */
router.post('/webhooks', async (req, res) => {
  if (!validateHubSpotWebhookSignature(req)) {
    console.warn('[HubSpot Webhook] Signature validation failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Always respond quickly to HubSpot (they expect 200 within 5 seconds)
  res.status(200).send('OK');
  
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    
    for (const event of events) {
      const { subscriptionType, objectId, propertyName, propertyValue } = event;
      
      console.log(`[HubSpot Webhook] Received: ${subscriptionType} for object ${objectId}, ${propertyName}=${propertyValue}`);
      
      if (subscriptionType === 'contact.propertyChange') {
        // Handle contact property changes (tier, status)
        if (propertyName === 'membership_tier' || propertyName === 'membership_status') {
          // Invalidate cache to pick up the change on next fetch
          allContactsCache.timestamp = 0;
          
          // Broadcast to all connected clients
          broadcastDirectoryUpdate('synced');
          
          console.log(`[HubSpot Webhook] Contact ${objectId} ${propertyName} changed to: ${propertyValue}`);
        }
      } else if (subscriptionType === 'deal.propertyChange') {
        // Handle deal property changes (stage, amount)
        console.log(`[HubSpot Webhook] Deal ${objectId} ${propertyName} changed to: ${propertyValue}`);
        // Future: Update payment status, trigger notifications
      } else if (subscriptionType === 'deal.creation') {
        // Handle new deal creation
        console.log(`[HubSpot Webhook] New deal created: ${objectId}`);
        // Future: Link deal to member, set up billing
      }
    }
  } catch (error) {
    console.error('[HubSpot Webhook] Error processing event:', error);
  }
});

// Sync member tiers from database to HubSpot (push current tiers to HubSpot)
router.post('/api/hubspot/push-db-tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const hubspot = await getHubSpotClient();
    
    // Get all active members with hubspot_id
    const members = await db.select({
      email: users.email,
      tier: users.tier,
      hubspotId: users.hubspotId,
      firstName: users.firstName,
      lastName: users.lastName
    })
      .from(users)
      .where(and(
        isNotNull(users.hubspotId),
        eq(users.membershipStatus, 'active'),
        sql`${users.archivedAt} IS NULL`
      ));
    
    console.log(`[DB Tier Push] Found ${members.length} members with HubSpot IDs`);
    
    const results = {
      total: members.length,
      toUpdate: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
      updates: [] as { email: string; name: string; tier: string; hubspotId: string }[]
    };
    
    // Prepare batch updates
    const updateBatch: { id: string; properties: { membership_tier: string } }[] = [];
    
    for (const member of members) {
      if (!member.hubspotId || !member.tier) {
        results.skipped++;
        continue;
      }
      
      const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
      
      results.updates.push({
        email: member.email || '',
        name,
        tier: member.tier,
        hubspotId: member.hubspotId
      });
      
      updateBatch.push({
        id: member.hubspotId,
        properties: { membership_tier: member.tier }
      });
    }
    
    results.toUpdate = updateBatch.length;
    
    if (!dryRun && updateBatch.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < updateBatch.length; i += batchSize) {
        const batch = updateBatch.slice(i, i + batchSize);
        try {
          await retryableHubSpotRequest(() => 
            hubspot.crm.contacts.batchApi.update({ inputs: batch })
          );
          results.updated += batch.length;
          console.log(`[DB Tier Push] Updated batch ${Math.floor(i / batchSize) + 1}: ${batch.length} contacts`);
        } catch (err: any) {
          results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`);
          console.error(`[DB Tier Push] Batch update error:`, err);
        }
        
        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    if (!dryRun && results.updated > 0) {
      broadcastDirectoryUpdate('synced');
    }
    
    console.log(`[DB Tier Push] Complete - Total: ${results.total}, Updated: ${results.updated}, Errors: ${results.errors.length}`);
    
    res.json({
      success: true,
      dryRun,
      total: results.total,
      toUpdate: results.toUpdate,
      updated: results.updated,
      skipped: results.skipped,
      errors: results.errors,
      sampleUpdates: results.updates.slice(0, 20)
    });
  } catch (error: any) {
    console.error('[DB Tier Push] Error:', error);
    res.status(500).json({ error: 'DB tier push failed: ' + error.message });
  }
});

export default router;

import { logger } from '../../core/logger';
import { Request } from 'express';
import * as crypto from 'crypto';
import { isProduction } from '../../core/db';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { normalizeTierName } from '../../../shared/constants/tiers';
import pRetry, { AbortError } from 'p-retry';
import { getErrorMessage } from '../../utils/errorUtils';
import { getHubSpotClient } from '../../core/integrations';

export interface HubSpotApiObject {
  id: string;
  properties: Record<string, string>;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  [key: string]: unknown;
}

export interface HubSpotErrorObject {
  response?: { statusCode?: number; body?: { category?: string } };
  status?: number;
  code?: number;
  body?: { category?: string };
}

export interface EmailCountRow {
  email: string;
  count: number;
}

export interface DbUserRow {
  id: string;
  email: string;
  join_date: string | null;
  joined_on: string | null;
  mindbody_client_id: string | null;
  manually_linked_emails: string[] | null;
}

export interface LastActivityRow {
  email: string;
  last_activity: string | Date | null;
}

export interface BillingProviderMemberRow {
  email: string;
  membership_status: string | null;
  billing_provider: string | null;
  tier: string | null;
  hubspot_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface HubSpotContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  lifecycleStage: string;
  status: string;
  tier: string | null;
  rawTier: string | null;
  tags: string[];
  membershipStartDate: string | null;
  createdAt: string | undefined;
  lastModified: string | undefined;
  dateOfBirth: string | null;
  isActiveMember: boolean;
  isFormerMember: boolean;
  wasEverMember: boolean;
  isNonMemberLead: boolean;
  lifetimeVisits?: number;
  joinDate?: string | null;
  mindbodyClientId?: string | null;
  manuallyLinkedEmails?: string[] | null;
  lastBookingDate?: string | null;
}

const HUBSPOT_BATCH_IMPORT_CUTOFF = new Date('2025-11-12T00:00:00-08:00');

export function computeHubSpotJoinDate(
  contact: { membershipStartDate?: string | null; createdAt?: string | null },
  dbUser?: { join_date?: string | null; joined_on?: string | null } | null
): string | null {
  if (dbUser?.joined_on) return dbUser.joined_on;
  
  const createdAtStr = contact.createdAt;
  if (!createdAtStr) {
    return contact.membershipStartDate || dbUser?.join_date || null;
  }
  
  let createdDate: Date;
  if (/^\d+$/.test(createdAtStr)) {
    createdDate = new Date(parseInt(createdAtStr, 10));
  } else {
    createdDate = new Date(createdAtStr);
  }
  
  if (isNaN(createdDate.getTime())) {
    return contact.membershipStartDate || dbUser?.join_date || null;
  }
  
  if (createdDate <= HUBSPOT_BATCH_IMPORT_CUTOFF) {
    return contact.membershipStartDate || contact.createdAt || null;
  } else {
    return dbUser?.join_date || contact.createdAt || contact.membershipStartDate || null;
  }
}

export function normalizeDateToYYYYMMDD(dateInput: string | Date | null | undefined): string | null {
  if (!dateInput) return null;
  
  try {
    if (dateInput instanceof Date) {
      if (isNaN(dateInput.getTime())) return null;
      const year = dateInput.getUTCFullYear();
      const month = String(dateInput.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateInput.getUTCDate()).padStart(2, '0');
      if (year < 1990 || year > 2100) return null;
      return `${year}-${month}-${day}`;
    }
    
    const dateString = String(dateInput).trim();
    if (!dateString) return null;
    
    if (/^\d+$/.test(dateString)) {
      const timestamp = parseInt(dateString, 10);
      const date = new Date(timestamp);
      if (date.getFullYear() < 1990 || date.getFullYear() > 2100) {
        return null;
      }
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    
    const cleanDate = dateString.split('T')[0].split(' ')[0];
    
    const [year, month, day] = cleanDate.split('-').map(Number);
    if (!year || !month || month < 1 || month > 12 || !day || day < 1 || day > 31) {
      return null;
    }
    
    return cleanDate;
  } catch (err) {
    logger.debug('Failed to parse HubSpot date string', { error: err });
    return null;
  }
}

export function validateHubSpotWebhookSignature(req: Request): boolean {
  const webhookSecret = process.env.HUBSPOT_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    if (isProduction) {
      logger.warn('[HubSpot Webhook] No HUBSPOT_WEBHOOK_SECRET configured - rejecting in production');
      return false;
    }
    logger.warn('[HubSpot Webhook] No HUBSPOT_WEBHOOK_SECRET configured - allowing in development');
    return true;
  }
  
  const signature = req.headers['x-hubspot-signature-v3'] as string | undefined;
  const timestamp = req.headers['x-hubspot-request-timestamp'] as string | undefined;
  
  if (!signature || !timestamp) {
    logger.warn('[HubSpot Webhook] Missing signature headers');
    return false;
  }
  
  const currentTime = Date.now();
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(currentTime - requestTime) > 300000) {
    logger.warn('[HubSpot Webhook] Request timestamp too old');
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
    logger.warn('[HubSpot Webhook] Signature length mismatch');
    return false;
  }
  
  const isValid = crypto.timingSafeEqual(signatureBuf, expectedBuf);
  
  if (!isValid) {
    logger.warn('[HubSpot Webhook] Invalid signature');
  }
  
  return isValid;
}

export let allContactsCache: { data: HubSpotContact[] | null; timestamp: number; lastModifiedCheck: number } = { data: null, timestamp: 0, lastModifiedCheck: 0 };
export const ALL_CONTACTS_CACHE_TTL = 30 * 60 * 1000;

export let backgroundRefreshInProgress = false;
export let backgroundRefreshPromise: Promise<void> | null = null;

export function setBackgroundRefreshInProgress(val: boolean) {
  backgroundRefreshInProgress = val;
}

export function setBackgroundRefreshPromise(val: Promise<void> | null) {
  backgroundRefreshPromise = val;
}

export function resetAllContactsCache() {
  allContactsCache = { data: null, timestamp: 0, lastModifiedCheck: 0 };
}

export function invalidateAllContactsCacheTimestamp() {
  allContactsCache.timestamp = 0;
}

export function isRateLimitError(error: unknown): boolean {
  const errorMsg = error instanceof Error ? getErrorMessage(error) : String(error);
  const errObj = error as unknown as HubSpotErrorObject;
  const statusCode = errObj?.response?.statusCode || errObj?.status || errObj?.code;
  
  return (
    statusCode === 429 ||
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

export async function retryableHubSpotRequest<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error: unknown) {
        if (isRateLimitError(error)) {
          if (!isProduction) logger.warn('HubSpot Rate Limit hit, retrying...');
          throw error;
        }
        throw new AbortError(error instanceof Error ? error : String(error));
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

export const HUBSPOT_CONTACT_PROPERTIES = [
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
  'membership_start_date',
  'lastmodifieddate',
  'date_of_birth'
];

export function transformHubSpotContact(contact: HubSpotApiObject): HubSpotContact {
  const props = contact.properties as Record<string, string | null | undefined>;
  const lifecycleStage = (props.lifecyclestage || '').toLowerCase();
  const membershipStatus = (props.membership_status || '').toLowerCase();
  
  const activeStatuses = ['active', 'trialing', 'past_due'];
  const formerStatuses = ['expired', 'terminated', 'former_member', 'cancelled', 'canceled', 'inactive', 'churned', 'declined', 'suspended', 'frozen', 'froze', 'pending', 'non-member'];
  
  const isActiveMember = activeStatuses.includes(membershipStatus);
  
  const membershipStartDate = props.membership_start_date || null;
  const wasEverMember = membershipStartDate !== null && membershipStartDate.trim() !== '';
  
  const isFormerMember = formerStatuses.includes(membershipStatus) && wasEverMember;
  const isNonMemberLead = formerStatuses.includes(membershipStatus) && !wasEverMember;
  
  const rawTierValue = props.membership_tier;
  
  return {
    id: contact.id,
    firstName: props.firstname || '',
    lastName: props.lastname || '',
    email: props.email || '',
    phone: props.phone || '',
    company: props.company || '',
    lifecycleStage,
    status: membershipStatus || (isActiveMember ? 'active' : ''),
    tier: normalizeTierName(rawTierValue),
    rawTier: rawTierValue && rawTierValue.trim() ? rawTierValue.trim() : null,
    tags: [],
    membershipStartDate,
    createdAt: props.createdate ?? undefined,
    lastModified: props.lastmodifieddate ?? undefined,
    dateOfBirth: props.date_of_birth || null,
    isActiveMember,
    isFormerMember,
    wasEverMember,
    isNonMemberLead
  };
}

async function enrichContactsWithDbData(contacts: HubSpotContact[]): Promise<HubSpotContact[]> {
  const emails = contacts.map((c) => c.email.toLowerCase()).filter(Boolean);
  
  if (emails.length === 0) return contacts;
  
  const dbUserMap: Record<string, DbUserRow> = {};
  const lastActivityMap: Record<string, string> = {};
  const pastBookingsMap: Record<string, number> = {};
  const eventVisitsMap: Record<string, number> = {};
  const wellnessVisitsMap: Record<string, number> = {};
  
  const dbResult = await db.execute(sql`SELECT id, email, join_date, joined_on, mindbody_client_id, manually_linked_emails 
     FROM users WHERE LOWER(email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})`);
  for (const row of dbResult.rows) {
    const r = row as unknown as DbUserRow;
    dbUserMap[r.email.toLowerCase()] = r;
  }
  
  const lastActivityResult = await db.execute(sql`SELECT email, MAX(activity_date) as last_activity FROM (
      SELECT LOWER(user_email) as email, request_date as activity_date
      FROM booking_requests 
      WHERE LOWER(user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)}) AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
      UNION ALL
      SELECT LOWER(er.user_email) as email, e.event_date as activity_date
      FROM event_rsvps er
      JOIN events e ON er.event_id = e.id
      WHERE LOWER(er.user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)}) AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND er.status != 'cancelled'
      UNION ALL
      SELECT LOWER(we.user_email) as email, wc.date as activity_date
      FROM wellness_enrollments we
      JOIN wellness_classes wc ON we.class_id = wc.id
      WHERE LOWER(we.user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)}) AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND we.status != 'cancelled'
    ) combined
    GROUP BY email`);
  for (const row of lastActivityResult.rows) {
    const r = row as unknown as LastActivityRow;
    if (r.last_activity) {
      const date = r.last_activity instanceof Date ? r.last_activity : new Date(r.last_activity as string);
      lastActivityMap[r.email] = date.toISOString().split('T')[0];
    }
  }
  
  const pastBookingsResult = await db.execute(sql`SELECT LOWER(user_email) as email, COUNT(*)::int as count
     FROM booking_requests
     WHERE LOWER(user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})
       AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
       AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
     GROUP BY LOWER(user_email)`);
  for (const row of pastBookingsResult.rows) {
    const r = row as unknown as EmailCountRow;
    pastBookingsMap[r.email] = r.count;
  }
  
  const eventVisitsResult = await db.execute(sql`SELECT u.email, COUNT(DISTINCT er.id)::int as count
     FROM users u
     JOIN event_rsvps er ON (LOWER(er.user_email) = LOWER(u.email) OR er.matched_user_id = u.id)
     JOIN events e ON er.event_id = e.id
     WHERE LOWER(u.email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})
       AND er.status != 'cancelled'
       AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
     GROUP BY u.email`);
  for (const row of eventVisitsResult.rows) {
    const r = row as unknown as EmailCountRow;
    eventVisitsMap[r.email.toLowerCase()] = r.count;
  }
  
  const wellnessVisitsResult = await db.execute(sql`SELECT LOWER(we.user_email) as email, COUNT(*)::int as count
     FROM wellness_enrollments we
     JOIN wellness_classes wc ON we.class_id = wc.id
     WHERE LOWER(we.user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})
       AND we.status != 'cancelled'
       AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
     GROUP BY LOWER(we.user_email)`);
  for (const row of wellnessVisitsResult.rows) {
    const r = row as unknown as EmailCountRow;
    wellnessVisitsMap[r.email] = r.count;
  }
  
  const walkInCountResult = await db.execute(sql`
    SELECT LOWER(member_email) as email, COUNT(*)::int as count
    FROM walk_in_visits
    GROUP BY LOWER(member_email)
  `);
  const walkInCounts: Record<string, number> = {};
  for (const row of walkInCountResult.rows) {
    const r = row as unknown as EmailCountRow;
    walkInCounts[r.email] = r.count;
  }

  return contacts.map((contact) => {
    const emailLower = contact.email.toLowerCase();
    const dbUser = dbUserMap[emailLower];
    const pastBookings = pastBookingsMap[emailLower] || 0;
    const eventVisits = eventVisitsMap[emailLower] || 0;
    const wellnessVisits = wellnessVisitsMap[emailLower] || 0;
    const rawJoinDate = computeHubSpotJoinDate(contact, dbUser);
    const normalizedJoinDate = normalizeDateToYYYYMMDD(rawJoinDate);
    
    const formerStatuses = ['expired', 'terminated', 'former_member', 'cancelled', 'canceled', 'inactive', 'churned', 'declined', 'suspended', 'frozen', 'froze', 'pending', 'non-member'];
    const contactStatus = (contact.status || '').toLowerCase();
    const hasFormerStatus = formerStatuses.includes(contactStatus);
    
    const membershipStartExists = contact.membershipStartDate !== null && contact.membershipStartDate !== undefined && String(contact.membershipStartDate).trim() !== '';
    const dbHasJoinDate = dbUser?.join_date !== null && dbUser?.join_date !== undefined;
    const wasEverMember = membershipStartExists || dbHasJoinDate;
    
    const isFormerMember = hasFormerStatus && wasEverMember;
    const isNonMemberLead = hasFormerStatus && !wasEverMember;
    
    return {
      ...contact,
      lifetimeVisits: pastBookings + eventVisits + wellnessVisits + (walkInCounts[emailLower] || 0),
      joinDate: normalizedJoinDate,
      mindbodyClientId: dbUser?.mindbody_client_id || null,
      manuallyLinkedEmails: dbUser?.manually_linked_emails || [],
      lastBookingDate: lastActivityMap[emailLower] || null,
      wasEverMember,
      isFormerMember,
      isNonMemberLead
    };
  });
}

export async function fetchAllHubSpotContacts(forceRefresh: boolean = false): Promise<HubSpotContact[]> {
  const now = Date.now();
  
  if (!forceRefresh && allContactsCache.data && (now - allContactsCache.timestamp) < ALL_CONTACTS_CACHE_TTL) {
    return allContactsCache.data;
  }
  
  if (!isProduction) logger.info('[HubSpot] Performing full contact sync...');
  
  const hubspot = await getHubSpotClient();
  
  let allContacts: HubSpotApiObject[] = [];
  let after: string | undefined = undefined;
  
  do {
    const response = await retryableHubSpotRequest(() => 
      hubspot.crm.contacts.basicApi.getPage(100, after, HUBSPOT_CONTACT_PROPERTIES)
    );
    allContacts = allContacts.concat(response.results as unknown as HubSpotApiObject[]);
    after = response.paging?.next?.after;
  } while (after);
  
  if (!isProduction) logger.info('[HubSpot] Full sync: fetched contacts', { extra: { allContactsLength: allContacts.length } });

  const hubspotContacts = allContacts.map(transformHubSpotContact);
  
  const enrichedContacts = await enrichContactsWithDbData(hubspotContacts);
  
  allContactsCache = { data: enrichedContacts, timestamp: now, lastModifiedCheck: now };
  
  return enrichedContacts;
}

export function invalidateHubSpotContactsCache() {
  allContactsCache = { data: null, timestamp: 0, lastModifiedCheck: 0 };
}

export function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    i++;
  }
  values.push(current.trim());
  return values;
}

import { logger } from '../core/logger';
import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { isProduction } from '../core/db';
import { getHubSpotClient } from '../core/integrations';
import { db } from '../db';
import { formSubmissions, users } from '../../shared/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { notifyAllStaff } from '../core/notificationService';
import { isStaffOrAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { normalizeTierName, TIER_NAMES } from '../../shared/constants/tiers';
import * as fs from 'fs';
import * as path from 'path';
import pRetry, { AbortError } from 'p-retry';
import { broadcastDirectoryUpdate } from '../core/websocket';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { getErrorMessage } from '../utils/errorUtils';
import { denormalizeTierForHubSpot } from '../utils/tierUtils';

/**
 * Cutoff date for HubSpot batch import.
 * Contacts created on or before this date were batch-imported, so their real join date
 * is in the membership_start_date field.
 * Contacts created after this date were synced from Mindbody and have accurate create dates.
 */
const HUBSPOT_BATCH_IMPORT_CUTOFF = new Date('2025-11-12T00:00:00-08:00');

/**
 * Compute the correct join date for a HubSpot contact based on when they were added.
 * 
 * Logic:
 * - DB joined_on takes highest priority (true manual override from staff)
 * - For contacts created ON or BEFORE Nov 12, 2025 (batch import):
 *   Use HubSpot membership_start_date (the real join date manually entered by staff)
 * - For contacts created AFTER Nov 12, 2025 (real Mindbody sync):
 *   Use DB join_date if available, otherwise HubSpot createdate
 * 
 * @param contact - HubSpot contact with membershipStartDate and createdAt
 * @param dbUser - Database user record with join_date and joined_on fields
 * @returns The appropriate join date string or null
 */
function computeHubSpotJoinDate(
  contact: { membershipStartDate?: string | null; createdAt?: string | null },
  dbUser?: { join_date?: string | null; joined_on?: string | null } | null
): string | null {
  // joined_on is the true manual override field (set by staff in the app)
  if (dbUser?.joined_on) return dbUser.joined_on;
  
  // Parse the HubSpot create date to determine which logic to apply
  const createdAtStr = contact.createdAt;
  if (!createdAtStr) {
    // No create date - fall back to membership_start_date if available
    return contact.membershipStartDate || dbUser?.join_date || null;
  }
  
  // Parse create date (could be timestamp or ISO string)
  let createdDate: Date;
  if (/^\d+$/.test(createdAtStr)) {
    createdDate = new Date(parseInt(createdAtStr, 10));
  } else {
    createdDate = new Date(createdAtStr);
  }
  
  // If create date is invalid, fall back to membership_start_date
  if (isNaN(createdDate.getTime())) {
    return contact.membershipStartDate || dbUser?.join_date || null;
  }
  
  // Apply the cutoff logic based on when the contact was created in HubSpot
  if (createdDate <= HUBSPOT_BATCH_IMPORT_CUTOFF) {
    // Batch import period: these members existed before HubSpot integration
    // Their real join date was manually entered in HubSpot's membership_start_date field
    // DB join_date for these is typically the Nov 2025 import date, so ignore it
    return contact.membershipStartDate || contact.createdAt;
  } else {
    // Post-batch import: these are real Mindbody syncs with accurate create dates
    // DB join_date (if set) represents the actual join date, otherwise use HubSpot createdate
    return dbUser?.join_date || contact.createdAt || contact.membershipStartDate;
  }
}

/**
 * Normalize a date to YYYY-MM-DD format
 * Handles Date objects, YYYY-MM-DD strings, ISO timestamps, space-separated datetimes, and Unix timestamps
 */
function normalizeDateToYYYYMMDD(dateInput: string | Date | null | undefined): string | null {
  if (!dateInput) return null;
  
  try {
    // Handle Date objects directly (e.g., from PostgreSQL)
    if (dateInput instanceof Date) {
      if (isNaN(dateInput.getTime())) return null;
      const year = dateInput.getUTCFullYear();
      const month = String(dateInput.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateInput.getUTCDate()).padStart(2, '0');
      if (year < 1990 || year > 2100) return null;
      return `${year}-${month}-${day}`;
    }
    
    // Convert to string in case it's passed as a number
    const dateString = String(dateInput).trim();
    if (!dateString) return null;
    
    // Check if it's a Unix timestamp (all digits, typically 10-13 digits)
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
    
    // Extract just the date part (YYYY-MM-DD) from ISO or datetime strings
    // Handle both 'T' separator (ISO) and space separator (database datetime)
    const cleanDate = dateString.split('T')[0].split(' ')[0];
    
    // Validate it's a proper date format
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

/**
 * Validate HubSpot webhook signature (v3 method)
 * See: https://developers.hubspot.com/docs/api/webhooks/validating-requests
 */
function validateHubSpotWebhookSignature(req: Request): boolean {
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

const router = Router();

// Shared cache for all HubSpot contacts (used by both active and former member views)
let allContactsCache: { data: Record<string, unknown>[] | null; timestamp: number; lastModifiedCheck: number } = { data: null, timestamp: 0, lastModifiedCheck: 0 };
const ALL_CONTACTS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes for full refresh
const INCREMENTAL_SYNC_INTERVAL = 5 * 60 * 1000; // Check for updates every 5 minutes

// Track if a background refresh is in progress
let backgroundRefreshInProgress = false;

/**
 * Check if an error is a HubSpot rate limit error (429)
 */
function isRateLimitError(error: unknown): boolean {
  const errorMsg = error instanceof Error ? getErrorMessage(error) : String(error);
  const errObj = error as Record<string, unknown>;
  const response = errObj?.response as Record<string, unknown> | undefined;
  const statusCode = response?.statusCode || errObj?.status || errObj?.code;
  
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
      } catch (error: unknown) {
        if (isRateLimitError(error)) {
          if (!isProduction) logger.warn('HubSpot Rate Limit hit, retrying...');
          throw error; // Trigger p-retry
        }
        // Non-rate-limit errors should abort immediately
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
  'membership_start_date',
  'lastmodifieddate',
  'date_of_birth'
];

/**
 * Transform a raw HubSpot contact into our normalized format
 */
function transformHubSpotContact(contact: Record<string, unknown>): Record<string, unknown> {
  const props = contact.properties as Record<string, string | null | undefined>;
  const lifecycleStage = (props.lifecyclestage || '').toLowerCase();
  const membershipStatus = (props.membership_status || '').toLowerCase();
  
  // Include trialing and past_due as active - they still have membership access
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
    createdAt: props.createdate,
    lastModified: props.lastmodifieddate,
    dateOfBirth: props.date_of_birth || null,
    isActiveMember,
    isFormerMember,
    wasEverMember,
    isNonMemberLead
  };
}

/**
 * Fetch only contacts modified since the given timestamp using HubSpot Search API
 * This is much more efficient than fetching all contacts when we only need updates
 */
async function fetchRecentlyModifiedContacts(sinceTimestamp: number): Promise<Record<string, unknown>[]> {
  const hubspot = await getHubSpotClient();
  
  let modifiedContacts: Record<string, unknown>[] = [];
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
      hubspot.crm.contacts.searchApi.doSearch(searchRequest as any)
    );
    
    modifiedContacts = modifiedContacts.concat((response as any).results);
    after = (response as any).paging?.next?.after;
  } while (after);
  
  return modifiedContacts.map(transformHubSpotContact);
}

/**
 * Fetch and cache all HubSpot contacts with incremental sync support
 * - Full refresh: Every 30 minutes or on force refresh
 * - Incremental sync: Every 5 minutes, only fetches recently modified contacts
 */
async function fetchAllHubSpotContacts(forceRefresh: boolean = false): Promise<Record<string, unknown>[]> {
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
          const contactMap = new Map(allContactsCache.data.map((c: Record<string, unknown>) => [c.id, c]));
          for (const contact of enrichedModified) {
            contactMap.set(contact.id, contact);
          }
          
          allContactsCache.data = Array.from(contactMap.values());
          if (!isProduction) logger.info('[HubSpot] Incremental sync: updated contacts', { extra: { modifiedContactsLength: modifiedContacts.length } });
        }
        
        allContactsCache.lastModifiedCheck = now;
      } catch (err: unknown) {
        // Incremental sync failed, continue with cached data
        if (!isProduction) logger.warn('[HubSpot] Incremental sync failed, using cached data', { extra: { err } });
      }
    }
    
    return allContactsCache.data;
  }
  
  // Full refresh needed
  if (!isProduction) logger.info('[HubSpot] Performing full contact sync...');
  
  const hubspot = await getHubSpotClient();
  
  let allContacts: Record<string, unknown>[] = [];
  let after: string | undefined = undefined;
  
  do {
    const response = await retryableHubSpotRequest(() => 
      (hubspot.crm.contacts.basicApi as any).getPage(100, after, HUBSPOT_CONTACT_PROPERTIES)
    );
    allContacts = allContacts.concat((response as any).results);
    after = (response as any).paging?.next?.after;
  } while (after);
  
  if (!isProduction) logger.info('[HubSpot] Full sync: fetched contacts', { extra: { allContactsLength: allContacts.length } });

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
async function enrichContactsWithDbData(contacts: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const emails = contacts.map((c: Record<string, unknown>) => (c.email as string).toLowerCase()).filter(Boolean);
  
  if (emails.length === 0) return contacts;
  
  let dbUserMap: Record<string, Record<string, unknown>> = {};
  let lastActivityMap: Record<string, string> = {};
  let pastBookingsMap: Record<string, number> = {};
  let eventVisitsMap: Record<string, number> = {};
  let wellnessVisitsMap: Record<string, number> = {};
  
  // Get user data including id for matched_user_id joins
  const dbResult = await db.execute(sql`SELECT id, email, join_date, joined_on, mindbody_client_id, manually_linked_emails 
     FROM users WHERE LOWER(email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})`);
  for (const row of dbResult.rows) {
    dbUserMap[((row as Record<string, unknown>).email as string).toLowerCase()] = row as Record<string, unknown>;
  }
  
  // Get last visit date - most recent PAST date from bookings or experiences
  const lastActivityResult = await db.execute(sql`SELECT email, MAX(activity_date) as last_activity FROM (
      SELECT LOWER(user_email) as email, request_date as activity_date
      FROM booking_requests 
      WHERE LOWER(user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)}) AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
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
    if (row.last_activity) {
      const r = row as Record<string, unknown>;
      const date = r.last_activity instanceof Date ? r.last_activity : new Date(r.last_activity as string);
      lastActivityMap[r.email as string] = date.toISOString().split('T')[0];
    }
  }
  
  // Count past bookings (excluding cancelled/declined)
  const pastBookingsResult = await db.execute(sql`SELECT LOWER(user_email) as email, COUNT(*)::int as count
     FROM booking_requests
     WHERE LOWER(user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})
       AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
       AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
     GROUP BY LOWER(user_email)`);
  for (const row of pastBookingsResult.rows) {
    pastBookingsMap[(row as Record<string, unknown>).email as string] = (row as Record<string, unknown>).count as number;
  }
  
  // Count past event RSVPs (excluding cancelled) - include both email and matched_user_id
  const eventVisitsResult = await db.execute(sql`SELECT u.email, COUNT(DISTINCT er.id)::int as count
     FROM users u
     JOIN event_rsvps er ON (LOWER(er.user_email) = LOWER(u.email) OR er.matched_user_id = u.id)
     JOIN events e ON er.event_id = e.id
     WHERE LOWER(u.email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})
       AND er.status != 'cancelled'
       AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
     GROUP BY u.email`);
  for (const row of eventVisitsResult.rows) {
    eventVisitsMap[((row as Record<string, unknown>).email as string).toLowerCase()] = (row as Record<string, unknown>).count as number;
  }
  
  // Count past wellness enrollments (excluding cancelled)
  const wellnessVisitsResult = await db.execute(sql`SELECT LOWER(we.user_email) as email, COUNT(*)::int as count
     FROM wellness_enrollments we
     JOIN wellness_classes wc ON we.class_id = wc.id
     WHERE LOWER(we.user_email) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})
       AND we.status != 'cancelled'
       AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
     GROUP BY LOWER(we.user_email)`);
  for (const row of wellnessVisitsResult.rows) {
    wellnessVisitsMap[(row as Record<string, unknown>).email as string] = (row as Record<string, unknown>).count as number;
  }
  
  const walkInCountResult = await db.execute(sql`
    SELECT LOWER(member_email) as email, COUNT(*)::int as count
    FROM walk_in_visits
    GROUP BY LOWER(member_email)
  `);
  const walkInCounts: Record<string, number> = {};
  for (const row of walkInCountResult.rows) {
    walkInCounts[(row as Record<string, unknown>).email as string] = (row as Record<string, unknown>).count as number;
  }

  // Merge contact data with database data
  // Join date logic handles batch-import vs post-import contacts differently
  return contacts.map((contact: Record<string, unknown>) => {
    const emailLower = (contact.email as string).toLowerCase();
    const dbUser = dbUserMap[emailLower];
    const pastBookings = pastBookingsMap[emailLower] || 0;
    const eventVisits = eventVisitsMap[emailLower] || 0;
    const wellnessVisits = wellnessVisitsMap[emailLower] || 0;
    const rawJoinDate = computeHubSpotJoinDate(contact, dbUser);
    const normalizedJoinDate = normalizeDateToYYYYMMDD(rawJoinDate);
    
    // Define formerStatuses for classification checks
    const formerStatuses = ['expired', 'terminated', 'former_member', 'cancelled', 'canceled', 'inactive', 'churned', 'declined', 'suspended', 'frozen', 'froze', 'pending', 'non-member'];
    const contactStatus = String((contact.status || '')).toLowerCase();
    const hasFormerStatus = formerStatuses.includes(contactStatus);
    
    // Recalculate wasEverMember considering both HubSpot membershipStartDate AND DB join_date
    // A contact was ever a member if:
    // 1. HubSpot membershipStartDate exists AND is not empty, OR
    // 2. DB user exists with a non-null join_date
    const membershipStartExists = contact.membershipStartDate !== null && contact.membershipStartDate !== undefined && String(contact.membershipStartDate).trim() !== '';
    const dbHasJoinDate = dbUser?.join_date !== null && dbUser?.join_date !== undefined;
    const wasEverMember = membershipStartExists || dbHasJoinDate;
    
    // isFormerMember = contact has a former status AND was ever a member
    const isFormerMember = hasFormerStatus && wasEverMember;
    
    // isNonMemberLead = contact has a former status but was NEVER a member (never paid)
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

router.get('/api/hubspot/contacts', isStaffOrAdmin, async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  const statusFilter = (req.query.status as string)?.toLowerCase() || 'active';
  const searchQuery = (req.query.search as string)?.toLowerCase().trim() || '';
  const now = Date.now();
  
  // Pagination parameters - when not provided, returns all (backwards compatible)
  const pageParam = parseInt(req.query.page as string, 10);
  const limitParam = parseInt(req.query.limit as string, 10);
  const isPaginated = !isNaN(pageParam) || !isNaN(limitParam);
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const limit = isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 100); // Default 50, max 100
  
  const filterContacts = (contacts: Record<string, unknown>[]) => {
    let filtered = contacts.filter((contact: Record<string, unknown>) => {
      if (statusFilter === 'active') return contact.isActiveMember;
      if (statusFilter === 'former') return contact.isFormerMember;
      return true;
    });
    
    // Apply search filter if provided - supports multi-word queries like "nick luu"
    if (searchQuery) {
      const searchWords = searchQuery.split(/\s+/).filter(Boolean);
      filtered = filtered.filter((contact: Record<string, unknown>) => {
        const firstName = String((contact.firstName || '')).toLowerCase();
        const lastName = String((contact.lastName || '')).toLowerCase();
        const email = String((contact.email || '')).toLowerCase();
        const fullName = `${firstName} ${lastName}`.trim();
        
        // All words in the search query must match somewhere in name or email
        return searchWords.every(word => 
          firstName.includes(word) || 
          lastName.includes(word) || 
          fullName.includes(word) ||
          email.includes(word)
        );
      });
    }
    
    return filtered;
  };
  
  const buildResponse = (allFilteredContacts: Record<string, unknown>[], stale: boolean, refreshing: boolean) => {
    const total = allFilteredContacts.length;
    
    // If pagination is requested, slice the results
    if (isPaginated) {
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedContacts = allFilteredContacts.slice(startIndex, endIndex);
      const totalPages = Math.ceil(total / limit);
      
      return { 
        contacts: paginatedContacts, 
        stale, 
        refreshing, 
        count: paginatedContacts.length,
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages
      };
    }
    
    // Backwards compatible: return all contacts without pagination metadata
    return { contacts: allFilteredContacts, stale, refreshing, count: total };
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
          if (!isProduction) logger.warn('[HubSpot] Background incremental sync failed', { extra: { err } });
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
          if (!isProduction) logger.warn('[HubSpot] Background full sync failed', { extra: { err } });
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
        if (!isProduction) logger.warn('[HubSpot] Initial sync failed', { extra: { err } });
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
      hubspot.crm.contacts.basicApi.getById(id as string, [
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

    // Normalize status - trialing and past_due should show as Active
    const rawStatus = (contact.properties.membership_status || '').toLowerCase();
    const activeStatuses = ['active', 'trialing', 'past_due'];
    const normalizedStatus = activeStatuses.includes(rawStatus) ? 'Active' : (contact.properties.membership_status || contact.properties.hs_lead_status || 'Active');
    
    res.json({
      id: contact.id,
      firstName: contact.properties.firstname || '',
      lastName: contact.properties.lastname || '',
      email: contact.properties.email || '',
      phone: contact.properties.phone || '',
      company: contact.properties.company || '',
      status: normalizedStatus,
      tier: normalizeTierName(contact.properties.membership_tier),
      tags: [],
      createdAt: contact.properties.createdate,
      joinDate: normalizeDateToYYYYMMDD(contact.properties.createdate) || null
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Request failed' });
  }
});

/**
 * Fire-and-forget: enrich an event deal with structured properties
 * after the HubSpot workflow creates it.
 */
async function enrichEventDeal(
  contactEmail: string,
  formFields: Array<{ name: string; value: string }>
): Promise<void> {
  const EVENT_TYPE_TO_DEAL_VALUE: Record<string, string> = {
    'Birthday': 'birthday',
    'Corporate': 'corporate',
    'Brand Activation': 'brand_activation',
    'Other': 'other',
  };

  const EVENTS_PIPELINE_ID = '1447785156';
  const EVENTS_NEW_INQUIRY_STAGE = '2412923587';

  const getField = (name: string) => formFields.find(f => f.name === name)?.value || '';

  const dealProperties: Record<string, string> = {};

  const eventDate = getField('event_date');
  if (eventDate) dealProperties.event_date = eventDate;

  const eventTime = getField('event_time');
  if (eventTime) dealProperties.event_time = eventTime;

  const eventType = getField('event_type');
  const dealEventType = EVENT_TYPE_TO_DEAL_VALUE[eventType];
  if (dealEventType) dealProperties.event_type = dealEventType;

  const guestCount = getField('guest_count');
  if (guestCount) dealProperties.expected_guest_count = guestCount;

  const eventServices = getField('event_services');
  if (eventServices) dealProperties.event_services = eventServices;

  const additionalDetails = getField('additional_details');
  if (additionalDetails) dealProperties.additional_details = additionalDetails;

  if (Object.keys(dealProperties).length === 0) return;

  try {
    const hubspot = await getHubSpotClient();

    const contactSearch = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: contactEmail.toLowerCase()
          }]
        }],
        properties: ['email'],
        limit: 1
      })
    );

    if (!contactSearch.results?.length) {
      logger.warn('[HubSpot DealEnrich] Contact not found for', { extra: { contactEmail } });
      return;
    }

    const contactId = contactSearch.results[0].id;

    for (let attempt = 0; attempt < 2; attempt++) {
      const associations = await retryableHubSpotRequest(() =>
        (hubspot.crm.contacts as unknown as { associationsApi: { getAll: (id: string, type: string) => Promise<{ results?: Array<{ id: string }> }> } }).associationsApi.getAll(contactId, 'deals')
      );

      const assocResults = (associations as { results?: Array<{ id: string }> }).results;
      if (assocResults?.length) {
        for (const assoc of assocResults) {
          const deal = await retryableHubSpotRequest(() =>
            hubspot.crm.deals.basicApi.getById(assoc.id, ['pipeline', 'dealstage', 'createdate'])
          );

          if (deal.properties.pipeline === EVENTS_PIPELINE_ID) {
            const createDate = new Date(deal.properties.createdate);
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

            if (createDate >= fiveMinutesAgo) {
              await retryableHubSpotRequest(() =>
                hubspot.crm.deals.basicApi.update(assoc.id, { properties: dealProperties })
              );
              logger.info('[HubSpot DealEnrich] Updated deal with event details for', { extra: { assocId: assoc.id, contactEmail } });
              return;
            }
          }
        }
      }

      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    const firstName = getField('firstname');
    const lastName = getField('lastname');
    const dealName = `${firstName} ${lastName} ${eventType || 'Event'} Inquiry`.trim();

    const createResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.deals.basicApi.create({
        properties: {
          dealname: dealName,
          pipeline: EVENTS_PIPELINE_ID,
          dealstage: EVENTS_NEW_INQUIRY_STAGE,
          ...dealProperties
        },
        associations: [{
          to: { id: contactId },
          types: [{
            associationCategory: 'HUBSPOT_DEFINED' as any,
            associationTypeId: 3
          }]
        }]
      })
    );

    logger.info('[HubSpot DealEnrich] Created deal with event details for', { extra: { createResponseId: createResponse.id, contactEmail } });
  } catch (error: unknown) {
    logger.error('[HubSpot DealEnrich] Error enriching deal for', { extra: { contactEmail, error_instanceof_Error_error_String_error: error instanceof Error ? error.message : String(error) } });
  }
}

const HUBSPOT_PORTAL_ID_DEFAULT = '244200670';
const HUBSPOT_FORMS: Record<string, string> = {
  'tour-request': process.env.HUBSPOT_FORM_TOUR_REQUEST || '',
  'membership': process.env.HUBSPOT_FORM_MEMBERSHIP || '',
  'private-hire': process.env.HUBSPOT_FORM_PRIVATE_HIRE || 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2',
  'event-inquiry': process.env.HUBSPOT_FORM_EVENT_INQUIRY || 'b69f9fe4-9b3b-4d1e-a689-ba3127e5f8f2',
  'guest-checkin': process.env.HUBSPOT_FORM_GUEST_CHECKIN || '',
  'contact': process.env.HUBSPOT_FORM_CONTACT || ''
};

router.post('/api/hubspot/forms/:formType', async (req, res) => {
  try {
    const { formType } = req.params;
    const formId = HUBSPOT_FORMS[formType];
    const portalId = process.env.HUBSPOT_PORTAL_ID || HUBSPOT_PORTAL_ID_DEFAULT;
    
    if (!formId) {
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
      const sessionUser = getSessionUser(req);
      if (!sessionUser || !sessionUser.isStaff) {
        return res.status(401).json({ error: 'Authentication required. Guest check-in is a staff-only action.' });
      }

      const memberEmailField = fields.find((f: { name: string; value: string }) => f.name === 'member_email');
      if (!memberEmailField?.value) {
        return res.status(400).json({ error: 'Member email is required for guest check-in' });
      }
      
      const memberEmail = memberEmailField.value;
      
      const updateResult = await db.execute(sql`UPDATE guest_passes 
         SET passes_used = passes_used + 1 
         WHERE member_email = ${memberEmail} AND passes_used < passes_total
         RETURNING passes_used, passes_total`);
      
      if (updateResult.rows.length === 0) {
        const passCheck = await db.execute(sql`SELECT passes_used, passes_total FROM guest_passes WHERE member_email = ${memberEmail}`);
        
        if (passCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Guest pass record not found. Please contact staff.' });
        }
        
        return res.status(400).json({ error: 'No guest passes remaining. Please contact staff for assistance.' });
      }
    }
    
    const VALID_HUBSPOT_CONTACT_FIELDS = new Set([
      'firstname', 'lastname', 'email', 'phone', 'company', 'message',
      'membership_interest', 'event_type', 'guest_count',
      'eh_email_updates_opt_in',
    ]);

    const hubspotFields: Array<{ name: string; value: string }> = [];

    for (const field of fields as Array<{ name: string; value: string }>) {
      if (field.name === 'marketing_consent') {
        hubspotFields.push({
          name: 'eh_email_updates_opt_in',
          value: field.value === 'Yes' ? 'true' : 'false',
        });
        continue;
      }

      if (field.name === 'membership_interest' && field.value === 'Not sure yet') {
        hubspotFields.push({ name: field.name, value: 'Not Sure Yet' });
        continue;
      }

      if (VALID_HUBSPOT_CONTACT_FIELDS.has(field.name)) {
        hubspotFields.push({ name: field.name, value: field.value });
      }
    }

    const hubspotPayload = {
      fields: hubspotFields.map((f) => ({
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
      if (!isProduction) logger.error('HubSpot form error', { extra: { errorData } });
      return res.status(response.status).json({ error: 'Form submission failed' });
    }
    
    const result: Record<string, unknown> = await response.json();
    
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
        'membership': 'Membership Application',
        'private-hire': 'Private Hire Inquiry',
        'guest-checkin': 'Guest Check-in',
        'contact': 'Contact Form'
      };
      const formLabel = formTypeLabels[formType] || 'Form Submission';
      const submitterName = [getFieldValue('firstname') || getFieldValue('first_name'), getFieldValue('lastname') || getFieldValue('last_name')].filter(Boolean).join(' ') || getFieldValue('email') || 'Someone';
      const staffMessage = `${submitterName} submitted a ${formLabel}`;
      
      const notificationUrl = formType === 'membership' ? '/admin/applications' : '/admin/inquiries';
      const notificationRelatedType = formType === 'membership' ? 'application' : 'inquiry';
      
      notifyAllStaff(
        `New ${formLabel}`,
        staffMessage,
        'system',
        {
          relatedId: insertResult[0]?.id,
          relatedType: notificationRelatedType,
          url: notificationUrl
        }
      ).catch(err => logger.error('Staff inquiry notification failed:', { extra: { err } }));

      if (formType === 'private-hire' || formType === 'event-inquiry') {
        const emailValue = getFieldValue('email') || '';
        if (emailValue) {
          setTimeout(() => {
            enrichEventDeal(emailValue, fields).catch(err => 
              logger.error('[HubSpot DealEnrich] Background enrichment failed', { extra: { err } })
            );
          }, 5000);
        }
      }
    } catch (dbError: unknown) {
      logger.error('Failed to save form submission locally', { extra: { dbError } });
    }
    
    res.json({ success: true, message: result.inlineMessage || 'Form submitted successfully' });
  } catch (error: unknown) {
    if (!isProduction) logger.error('HubSpot form submission error', { error: error instanceof Error ? error : new Error(String(error)) });
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
    
    logger.info('[Tier Sync] Loaded rows from', { extra: { csvRowsLength: csvRows.length, files_0: files[0] } });
    
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
    let allContacts: Record<string, unknown>[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await retryableHubSpotRequest(() => 
        (hubspot.crm.contacts.basicApi as any).getPage(100, after, properties)
      );
      allContacts = allContacts.concat((response as any).results);
      after = (response as any).paging?.next?.after;
    } while (after);
    
    logger.info('[Tier Sync] Fetched contacts from HubSpot', { extra: { allContactsLength: allContacts.length } });
    
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
      const hubspotEmail = ((contact.properties as any).email || '').toLowerCase().trim();
      if (!hubspotEmail) continue;
      
      const csvData = csvByEmail.get(hubspotEmail);
      if (!csvData) {
        results.notFound++;
        continue;
      }
      
      results.matched++;
      const currentTier = (contact.properties as any).membership_tier || '';
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
      
      const hubspotTier = denormalizeTierForHubSpot(newTier);
      if (!hubspotTier) continue;
      
      updateBatch.push({
        id: contact.id as string,
        properties: { membership_tier: hubspotTier }
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
          logger.info('[Tier Sync] Updated batch : contacts', { extra: { MathFloor_i_batchSize_1: Math.floor(i / batchSize) + 1, batchLength: batch.length } });
        } catch (err: unknown) {
          results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${getErrorMessage(err)}`);
          logger.error('[Tier Sync] Batch update error:', { extra: { err } });
        }
      }
    } else if (dryRun) {
      results.updated = 0;
    }
    
    logger.info('[Tier Sync] Complete - Matched: , Updates: , Errors', { extra: { resultsMatched: results.matched, resultsUpdatesLength: results.updates.length, resultsErrorsLength: results.errors.length } });
    
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
  } catch (error: unknown) {
    logger.error('[Tier Sync] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Tier sync failed: ' + getErrorMessage(error) });
  }
});

/**
 * Update a contact's membership tier in HubSpot
 * Staff/admin only with audit logging
 */
router.put('/api/hubspot/contacts/:id/tier', isStaffOrAdmin, async (req, res) => {
  const { id } = req.params;
  const { tier } = req.body;
  const staffUser = (req as Request & { staffUser?: { name?: string } }).staffUser;
  
  if (!tier || typeof tier !== 'string') {
    return res.status(400).json({ error: 'Tier is required' });
  }
  
  const validTiers = [...TIER_NAMES, 'Founding', 'Unlimited'] as string[];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
  }
  
  try {
    const hubspot = await getHubSpotClient();
    
    // Look up user by ID (UUID) first to get their email - the universal identifier
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      hubspotId: users.hubspotId,
      firstName: users.firstName,
      lastName: users.lastName,
      tier: users.tier,
    }).from(users).where(eq(users.id, id as string)).limit(1);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const localUser = userResult[0];
    const contactEmail = localUser.email;
    const contactName = [localUser.firstName, localUser.lastName].filter(Boolean).join(' ');
    const oldTier = localUser.tier || '(empty)';
    let hubspotContactId = localUser.hubspotId;
    
    // Map tier name to tier_id and membership_tier format
    const tierMapping: Record<string, { tier_id: number | null; tier: string }> = {
      'Social': { tier_id: 1, tier: 'Social' },
      'Core': { tier_id: 2, tier: 'Core' },
      'Premium': { tier_id: 3, tier: 'Premium' },
      'Corporate': { tier_id: 4, tier: 'Corporate' },
      'VIP': { tier_id: 5, tier: 'VIP' },
      'Founding': { tier_id: 2, tier: 'Core' },
      'Unlimited': { tier_id: 3, tier: 'Premium' },
    };
    
    const tierData = tierMapping[tier];
    if (!tierData) {
      return res.status(400).json({ error: `Invalid tier: ${tier}` });
    }
    
    await db.update(users)
      .set({
        tier: tierData.tier,
        tierId: tierData.tier_id,
        membershipTier: tierData.tier,
        membershipStatus: 'active',
      } as Record<string, unknown>)
      .where(eq(users.id, localUser.id));
    
    logger.info('[Tier Update] Updated local database for', { extra: { contactEmail } });
    
    if (hubspotContactId) {
      const hubspotTier = denormalizeTierForHubSpot(tier);
      if (hubspotTier) {
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(hubspotContactId!, {
            properties: { membership_tier: hubspotTier }
          })
        );
      }
    }
    
    // Log the change for audit purposes
    logger.info('[Tier Update] Contact (, ): -> by staff', { extra: { id, contactName, contactEmail, oldTier, tierDataTier: tierData.tier, staffUser: staffUser?.name || 'Unknown' } });
    
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
  } catch (error: unknown) {
    logger.error('[Tier Update] Error updating contact', { error: error instanceof Error ? error : new Error(String(error)), extra: { id } });
    res.status(500).json({ error: 'Failed to update tier: ' + getErrorMessage(error) });
  }
});

/**
 * HubSpot webhook receiver endpoint
 * Handles contact and deal property change events
 * Raw body is captured by express.json verify function in server/index.ts
 */
router.post('/api/hubspot/webhooks', async (req, res) => {
  if (!validateHubSpotWebhookSignature(req)) {
    logger.warn('[HubSpot Webhook] Signature validation failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Always respond quickly to HubSpot (they expect 200 within 5 seconds)
  res.status(200).send('OK');
  
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    
    for (const event of events) {
      const { subscriptionType, objectId, propertyName, propertyValue } = event;
      
      logger.info('[HubSpot Webhook] Received: for object , =', { extra: { subscriptionType, objectId, propertyName, propertyValue } });
      
      if (subscriptionType === 'contact.propertyChange') {
        // Handle contact property changes (tier, status)
        if (propertyName === 'membership_tier' || propertyName === 'membership_status') {
          // Invalidate cache to pick up the change on next fetch
          allContactsCache.timestamp = 0;
          
          // Broadcast to all connected clients
          broadcastDirectoryUpdate('synced');
          
          logger.info('[HubSpot Webhook] Contact changed to', { extra: { objectId, propertyName, propertyValue } });
          
          // INSTANT DATABASE UPDATE: Update the user's status/tier immediately
          // This ensures MindBody billing status changes are reflected instantly
          try {
            const hubspot = await getHubSpotClient();
            const contact = await hubspot.crm.contacts.basicApi.getById(objectId, ['email', 'membership_status', 'membership_tier']);
            const email = contact.properties.email?.toLowerCase();
            
            if (email) {
              const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${email}`);
              if (exclusionCheck.rows.length > 0) {
                logger.info('[HubSpot Webhook] Skipping excluded/deleted email', { extra: { email, propertyName, propertyValue } });
              } else {
                const userCheck = await db.execute(sql`SELECT role, billing_provider, stripe_subscription_id, membership_status, first_name, last_name, tier FROM users WHERE LOWER(email) = ${email}`);
                const existingUser = userCheck.rows[0];
                const isStripeProtected = existingUser?.billing_provider === 'stripe';
                const isVisitorProtected = existingUser?.role === 'visitor';

                if (isVisitorProtected) {
                  logger.info('[HubSpot Webhook] VISITOR PROTECTED: Skipping update for visitor', { extra: { email, propertyName, propertyValue } });
                } else if (propertyName === 'membership_status') {
                  const newStatus = (propertyValue || 'non-member').toLowerCase();

                  if (isStripeProtected) {
                    logger.info('[HubSpot Webhook] STRIPE WINS: Skipping status change for Stripe-billed member', { extra: { email, newStatus } });
                  } else if (newStatus === 'non-member' && existingUser?.stripe_subscription_id) {
                    logger.info('[HubSpot Webhook] Skipping status change to \'non-member\' for - has active Stripe subscription', { extra: { email } });
                  } else {
                    const prevStatus = existingUser?.membership_status;
                    await db.execute(sql`UPDATE users SET membership_status = ${newStatus}, updated_at = NOW() WHERE LOWER(email) = ${email}`);
                    logger.info('[HubSpot Webhook] Updated DB membership_status for to', { extra: { email, newStatus } });

                    const activeStatuses = ['active', 'trialing'];
                    const inactiveStatuses = ['expired', 'terminated', 'cancelled', 'canceled', 'inactive', 'churned', 'declined', 'suspended', 'frozen', 'non-member'];
                    const hubspotMemberName = existingUser
                      ? `${existingUser.first_name || ''} ${existingUser.last_name || ''}`.trim() || email
                      : email;
                    const memberTier = existingUser?.tier || 'Unknown';

                    if (prevStatus && prevStatus !== 'non-member' && newStatus === 'non-member') {
                      await notifyAllStaff(
                        'Member Status Changed',
                        `${hubspotMemberName} (${email}) status changed to non-member via MindBody (was ${prevStatus}).`,
                        'member_status_change',
                        { sendPush: true, url: '/admin/members' }
                      );
                    } else if (activeStatuses.includes(newStatus) && !activeStatuses.includes((prevStatus || '') as string)) {
                      await notifyAllStaff(
                        '🎉 New Member Activated',
                        `${hubspotMemberName} (${email}) is now active via MindBody (${memberTier} tier).`,
                        'new_member',
                        { sendPush: true, url: '/admin/members' }
                      );
                    } else if (inactiveStatuses.includes(newStatus) && !inactiveStatuses.includes((prevStatus || '') as string)) {
                      await notifyAllStaff(
                        'Member Status Changed',
                        `${hubspotMemberName} (${email}) status changed to ${newStatus} via MindBody.`,
                        'member_status_change',
                        { sendPush: true, url: '/admin/members' }
                      );
                    }
                  }
                } else if (propertyName === 'membership_tier') {
                  if (isStripeProtected) {
                    logger.info('[HubSpot Webhook] STRIPE WINS: Skipping tier change for Stripe-billed member', { extra: { email, propertyValue } });
                  } else {
                    const normalizedTier = normalizeTierName(propertyValue || '');
                    if (normalizedTier) {
                      await db.execute(sql`UPDATE users SET tier = ${normalizedTier}, updated_at = NOW() WHERE LOWER(email) = ${email}`);
                      logger.info('[HubSpot Webhook] Updated DB tier for to', { extra: { email, normalizedTier } });
                    }
                  }
                }
              }
            }
          } catch (updateError: unknown) {
            logger.error('[HubSpot Webhook] Failed to update DB for contact', { extra: { objectId, error: getErrorMessage(updateError) } });
          }
        }
      } else if (subscriptionType === 'deal.propertyChange') {
        // Handle deal property changes (stage, amount)
        logger.info('[HubSpot Webhook] Deal changed to', { extra: { objectId, propertyName, propertyValue } });
        // Future: Update payment status, trigger notifications
      } else if (subscriptionType === 'deal.creation') {
        // Handle new deal creation
        logger.info('[HubSpot Webhook] New deal created', { extra: { objectId } });
        // Future: Link deal to member, set up billing
      }
    }
  } catch (error: unknown) {
    logger.error('[HubSpot Webhook] Error processing event', { error: error instanceof Error ? error : new Error(String(error)) });
  }
});

// Sync member tiers from database to HubSpot (push current tiers to HubSpot)
router.post('/api/hubspot/push-db-tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const hubspot = await getHubSpotClient();
    
    // Get all active members with hubspot_id
    // Include trialing and past_due as active - they still have membership access
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
        sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due') OR ${users.stripeSubscriptionId} IS NOT NULL)`,
        sql`${users.archivedAt} IS NULL`
      ));
    
    logger.info('[DB Tier Push] Found members with HubSpot IDs', { extra: { membersLength: members.length } });
    
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
      
      const hubspotTier = denormalizeTierForHubSpot(member.tier);
      if (!hubspotTier) continue;
      
      updateBatch.push({
        id: member.hubspotId,
        properties: { membership_tier: hubspotTier }
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
          logger.info('[DB Tier Push] Updated batch : contacts', { extra: { MathFloor_i_batchSize_1: Math.floor(i / batchSize) + 1, batchLength: batch.length } });
        } catch (err: unknown) {
          results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${getErrorMessage(err)}`);
          logger.error('[DB Tier Push] Batch update error:', { extra: { err } });
        }
        
        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    if (!dryRun && results.updated > 0) {
      broadcastDirectoryUpdate('synced');
    }
    
    logger.info('[DB Tier Push] Complete - Total: , Updated: , Errors', { extra: { resultsTotal: results.total, resultsUpdated: results.updated, resultsErrorsLength: results.errors.length } });
    
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
  } catch (error: unknown) {
    logger.error('[DB Tier Push] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'DB tier push failed: ' + getErrorMessage(error) });
  }
});

router.post('/api/hubspot/sync-billing-providers', isStaffOrAdmin, async (req, res) => {
  try {
    const { dryRun = true } = req.body;
    const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
    
    // Get all members with HubSpot IDs and billing info
    const membersResult = await db.execute(sql`
      SELECT email, membership_status, billing_provider, tier, hubspot_id, first_name, last_name
      FROM users
      WHERE hubspot_id IS NOT NULL 
        AND archived_at IS NULL
        AND (membership_status IN ('active', 'trialing', 'past_due') OR stripe_subscription_id IS NOT NULL)
      ORDER BY email
    `);
    
    logger.info('[HubSpot Sync] Found members with HubSpot IDs to sync', { extra: { membersResultRowsLength: membersResult.rows.length } });
    
    const results = {
      total: membersResult.rows.length,
      synced: 0,
      skipped: 0,
      errors: 0,
      details: [] as Array<{ email: string; status: string; billingProvider: string; tier: string; result: string }>
    };
    
    for (const member of membersResult.rows) {
      const m = member as Record<string, unknown>;
      const email: string = m.email as string;
      const status: string = (m.membership_status as string) || 'active';
      const billingProvider: string = (m.billing_provider as string) || 'manual';
      const tier: string = m.tier as string;
      
      if (dryRun) {
        results.details.push({
          email,
          status,
          billingProvider,
          tier: tier || 'none',
          result: 'would sync'
        });
        results.synced++;
        continue;
      }
      
      try {
        const syncResult = await syncMemberToHubSpot({
          email,
          status,
          billingProvider,
          tier
        });
        
        if (syncResult.success) {
          results.synced++;
          results.details.push({
            email,
            status,
            billingProvider,
            tier: tier || 'none',
            result: 'synced'
          });
        } else {
          results.skipped++;
          results.details.push({
            email,
            status,
            billingProvider,
            tier: tier || 'none',
            result: `skipped: ${syncResult.error}`
          });
        }
      } catch (err: unknown) {
        results.errors++;
        results.details.push({
          email,
          status,
          billingProvider,
          tier: tier || 'none',
          result: `error: ${getErrorMessage(err)}`
        });
      }
      
      // Rate limiting: 100ms between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    logger.info('[HubSpot Sync] Completed: synced, skipped, errors', { extra: { resultsSynced: results.synced, resultsSkipped: results.skipped, resultsErrors: results.errors } });
    
    res.json({
      dryRun,
      total: results.total,
      synced: results.synced,
      skipped: results.skipped,
      errors: results.errors,
      sampleDetails: results.details.slice(0, 50)
    });
  } catch (error: unknown) {
    logger.error('[HubSpot Sync] Error syncing billing providers', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Sync failed: ' + getErrorMessage(error) });
  }
});

router.get('/api/hubspot/products', isStaffOrAdmin, async (req, res) => {
  try {
    const hubspot = await getHubSpotClient();
    
    const properties = ['name', 'price', 'hs_sku', 'description', 'hs_recurring_billing_period'];
    let allProducts: Record<string, unknown>[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await retryableHubSpotRequest(() => 
        (hubspot.crm.products.basicApi as any).getPage(100, after, properties)
      );
      allProducts = allProducts.concat((response as any).results);
      after = (response as any).paging?.next?.after;
    } while (after);
    
    const products = allProducts.map((product: Record<string, unknown>) => {
      const props = product.properties as Record<string, string | null | undefined>;
      return {
      id: product.id,
      name: props.name || '',
      price: parseFloat(props.price || '0') || 0,
      sku: props.hs_sku || null,
      description: props.description || null,
      recurringPeriod: props.hs_recurring_billing_period || null,
    };
    });
    
    res.json({ products, count: products.length });
  } catch (error: unknown) {
    const errObj = error as Record<string, unknown>;
    const response = errObj?.response as Record<string, unknown> | undefined;
    const body = response?.body as Record<string, unknown> | undefined;
    const statusCode = response?.statusCode || errObj?.status || errObj?.code;
    const category = body?.category || (errObj?.body as Record<string, unknown> | undefined)?.category;
    if (statusCode === 403 || category === 'MISSING_SCOPES') {
      return res.status(403).json({ error: 'HubSpot API key missing required scopes for products' });
    }
    logger.error('[HubSpot] Error fetching products', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch HubSpot products' });
  }
});

router.post('/api/admin/hubspot/sync-form-submissions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { syncHubSpotFormSubmissions } = await import('../core/hubspot/formSync');
    const result = await syncHubSpotFormSubmissions();
    res.json(result);
  } catch (error: unknown) {
    logger.error('[HubSpot FormSync] Manual sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync form submissions' });
  }
});

export { fetchAllHubSpotContacts };
export default router;

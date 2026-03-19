import { logger } from '../../core/logger';
import { Router, Request } from 'express';
import { isProduction } from '../../core/db';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';
import { db } from '../../db';
import { users } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { normalizeTierName, TIER_NAMES } from '../../../shared/constants/tiers';
import { invalidateCache } from '../../core/queryCache';
import { broadcastDirectoryUpdate } from '../../core/websocket';
import { safeErrorDetail, getErrorMessage } from '../../utils/errorUtils';
import { denormalizeTierForHubSpotAsync } from '../../utils/tierUtils';
import { getHubSpotClient } from '../../core/integrations';
import {
  HubSpotContact,
  allContactsCache,
  ALL_CONTACTS_CACHE_TTL,
  backgroundRefreshInProgress,
  backgroundRefreshPromise,
  setBackgroundRefreshInProgress,
  setBackgroundRefreshPromise,
  fetchAllHubSpotContacts,
  retryableHubSpotRequest,
  normalizeDateToYYYYMMDD,
  invalidateAllContactsCacheTimestamp,
} from './shared';

const router = Router();

const hubspotContactsQuerySchema = z.object({
  refresh: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/hubspot/contacts', isStaffOrAdmin, validateQuery(hubspotContactsQuerySchema), async (req, res) => {
  try {
  const vq = (req as Request & { validatedQuery: z.infer<typeof hubspotContactsQuerySchema> }).validatedQuery;
  const forceRefresh = vq.refresh === 'true';
  const statusFilter = vq.status?.toLowerCase() || 'active';
  const searchQuery = vq.search?.toLowerCase().trim() || '';
  const now = Date.now();
  
  const pageParam = parseInt(vq.page || '', 10);
  const limitParam = parseInt(vq.limit || '', 10);
  const isPaginated = !isNaN(pageParam) || !isNaN(limitParam);
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const limit = isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 100); // Default 50, max 100
  
  const filterContacts = (contacts: HubSpotContact[]) => {
    let filtered = contacts.filter((contact) => {
      if (statusFilter === 'active') return contact.isActiveMember;
      if (statusFilter === 'former') return contact.isFormerMember;
      return true;
    });
    
    if (searchQuery) {
      const searchWords = searchQuery.split(/\s+/).filter(Boolean);
      filtered = filtered.filter((contact) => {
        const firstName = (contact.firstName || '').toLowerCase();
        const lastName = (contact.lastName || '').toLowerCase();
        const email = (contact.email || '').toLowerCase();
        const fullName = `${firstName} ${lastName}`.trim();
        
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
  
  const buildResponse = (allFilteredContacts: HubSpotContact[], stale: boolean, refreshing: boolean) => {
    const total = allFilteredContacts.length;
    
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
    
    return { contacts: allFilteredContacts, stale, refreshing, count: total };
  };
  
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  
  const hasFreshCache = allContactsCache.data && (now - allContactsCache.timestamp) < ALL_CONTACTS_CACHE_TTL;
  
  if (hasFreshCache && !forceRefresh) {
    const filteredContacts = filterContacts(allContactsCache.data!);
    return res.json(buildResponse(filteredContacts, false, backgroundRefreshInProgress));
  }
  
  if (allContactsCache.data) {
    const filteredContacts = filterContacts(allContactsCache.data);
    const isStale = (now - allContactsCache.timestamp) >= ALL_CONTACTS_CACHE_TTL;
    
    if (!backgroundRefreshInProgress) {
      setBackgroundRefreshInProgress(true);
      const promise = fetchAllHubSpotContacts(forceRefresh)
        .then(() => {})
        .catch(err => {
          if (!isProduction) logger.warn('[HubSpot] Background full sync failed', { extra: { err } });
        })
        .finally(() => {
          setBackgroundRefreshInProgress(false);
          setBackgroundRefreshPromise(null);
        });
      setBackgroundRefreshPromise(promise);
    }
    
    return res.json(buildResponse(filteredContacts, isStale, true));
  }
  
  if (!backgroundRefreshInProgress) {
    setBackgroundRefreshInProgress(true);
    const promise = fetchAllHubSpotContacts(true)
      .then(() => {})
      .catch(err => {
        logger.warn('[HubSpot] Initial sync failed', { extra: { err: getErrorMessage(err) } });
      })
      .finally(() => {
        setBackgroundRefreshInProgress(false);
        setBackgroundRefreshPromise(null);
      });
    setBackgroundRefreshPromise(promise);
  }

  if (backgroundRefreshPromise) {
    await backgroundRefreshPromise;
  }
  
  if (allContactsCache.data) {
    const filteredContacts = filterContacts(allContactsCache.data);
    return res.json(buildResponse(filteredContacts, false, false));
  }
  
  return res.json(buildResponse([], true, false));
  } catch (error: unknown) {
    logger.error('Failed to fetch contacts', { error: new Error(getErrorMessage(error)) });
    return res.status(500).json({ error: 'Failed to fetch contacts' });
  }
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
    if (!isProduction) logger.error('API error', { error: new Error(getErrorMessage(error)) });
    res.status(500).json({ error: 'Request failed' });
  }
});

router.put('/api/hubspot/contacts/:id/tier', isStaffOrAdmin, async (req, res) => {
  try {
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
    const hubspot = await getHubSpotClient();
    
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
    const hubspotContactId = localUser.hubspotId;
    
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
      })
      .where(eq(users.id, localUser.id));
    
    logger.info('[Tier Update] Updated local database for', { extra: { contactEmail } });
    
    if (hubspotContactId) {
      const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('../../core/hubspot/readOnlyGuard');
      if (isHubSpotReadOnly()) {
        logHubSpotWriteSkipped('single_tier_update', contactEmail ?? undefined);
      } else {
        const hubspotTier = await denormalizeTierForHubSpotAsync(tier);
        if (hubspotTier) {
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(hubspotContactId!, {
              properties: { membership_tier: hubspotTier }
            })
          );
        }
      }
    }
    
    logger.info('[Tier Update] Contact (, ): -> by staff', { extra: { id, contactName, contactEmail, oldTier, tierDataTier: tierData.tier, staffUser: staffUser?.name || 'Unknown' } });
    
    invalidateAllContactsCacheTimestamp();
    
    invalidateCache('members_directory');

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
    logger.error('[Tier Update] Error updating contact', { error: new Error(getErrorMessage(error)), extra: { contactId: req.params.id } });
    res.status(500).json({ error: 'Failed to update tier', details: safeErrorDetail(error) });
  }
});

export default router;

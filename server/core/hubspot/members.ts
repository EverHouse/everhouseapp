import { db } from '../../db';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../../utils/errorUtils';
import { isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { hubspotDeals, hubspotLineItems } from '../../../shared/schema';
import { logBillingAudit } from '../auditLog';
import { eq, and, sql } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { HUBSPOT_STAGE_IDS, MEMBERSHIP_PIPELINE_ID, MINDBODY_TO_STAGE_MAP } from './constants';
import { getProductMapping } from './products';
import { addLineItemToDeal } from './lineItems';
import { isPlaceholderEmail } from '../stripe/customers';
import { getTodayPacific } from '../../utils/dateUtils';

import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { logger } from '../logger';
export interface AddMemberInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  tier: string;
  startDate?: string;
  discountReason?: string;
  createdBy: string;
  createdByName?: string;
}

export interface AddMemberResult {
  success: boolean;
  userId?: string;
  hubspotContactId?: string;
  hubspotDealId?: string;
  lineItemId?: string;
  error?: string;
}

interface HubSpotAssociationResult {
  results?: Array<{ id: string }>;
}

interface HubSpotDeal {
  id: string;
  properties: Record<string, string>;
}

export async function getContactDeals(hubspotContactId: string): Promise<HubSpotDeal[]> {
  try {
    const hubspot = await getHubSpotClient();
    const response = await retryableHubSpotRequest(() =>
      (hubspot.crm.contacts as unknown as { associationsApi: { getAll: (id: string, toObjectType: string) => Promise<HubSpotAssociationResult> } }).associationsApi.getAll(hubspotContactId, 'deals')
    );
    
    if (!(response as HubSpotAssociationResult).results || (response as HubSpotAssociationResult).results!.length === 0) {
      return [];
    }
    
    const dealIds = (response as HubSpotAssociationResult).results!.map((r) => r.id);
    const deals = await Promise.all(
      dealIds.map((id: string) =>
        retryableHubSpotRequest(() =>
          hubspot.crm.deals.basicApi.getById(id, [
            'dealname',
            'pipeline',
            'dealstage',
            'amount',
            'closedate',
            'createdate'
          ])
        )
      )
    );
    
    return deals;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error fetching contact deals:', { error: error });
    return [];
  }
}

export async function findOrCreateHubSpotContact(
  email: string,
  firstName: string,
  lastName: string,
  phone?: string,
  tier?: string,
  options?: { role?: string }
): Promise<{ contactId: string; isNew: boolean }> {
  if (isPlaceholderEmail(email)) {
    logger.info(`[HubSpot] Skipping contact creation for placeholder email: ${email}`);
    throw new Error(`Cannot create HubSpot contact for placeholder email: ${email}`);
  }
  
  const hubspot = await getHubSpotClient();
  
  try {
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: email.toLowerCase()
          }]
        }],
        properties: ['email', 'firstname', 'lastname'],
        limit: 1
      })
    );
    
    if (searchResponse.results && searchResponse.results.length > 0) {
      return { contactId: searchResponse.results[0].id, isNew: false };
    }
  } catch (error: unknown) {
    const statusCode = getErrorStatusCode(error);
    const errorMsg = getErrorMessage(error);
    
    const isNotFoundError = statusCode === 404 || errorMsg.includes('not found');
    
    const isNetworkOrAuthError = 
      !isNotFoundError && (
        statusCode === 401 || 
        statusCode === 403 || 
        (statusCode && statusCode >= 500) ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('ETIMEDOUT') ||
        errorMsg.includes('unauthorized') ||
        errorMsg.includes('forbidden')
      );
    
    if (isNetworkOrAuthError) {
      logger.error('[HubSpotDeals] Network/Auth error during contact search:', { error: error });
      throw error;
    }
    
    if (!isProduction) logger.warn('[HubSpotDeals] Error searching for contact, will create new one:', { error: error });
  }
  
  try {
    const { denormalizeTierForHubSpot } = await import('../../utils/tierUtils');
    const hubspotTier = tier ? denormalizeTierForHubSpot(tier) : null;
    
    const isVisitor = options?.role === 'visitor' || options?.role === 'day-pass';
    const properties: Record<string, string> = {
      email: email.toLowerCase(),
      firstname: firstName,
      lastname: lastName,
      phone: phone || '',
      membership_status: isVisitor ? 'Non-Member' : 'Active',
      lifecyclestage: isVisitor ? 'lead' : 'customer'
    };
    
    if (hubspotTier) {
      properties.membership_tier = hubspotTier;
    }
    
    const createResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.create({ properties })
    );
    
    return { contactId: createResponse.id, isNew: true };
  } catch (createError: unknown) {
    const statusCode = getErrorStatusCode(createError) || (getErrorCode(createError) ? Number(getErrorCode(createError)) : undefined);
    const errorBody = createError && typeof createError === 'object' && 'body' in createError ? (createError as { body?: { message?: string } }).body : (createError && typeof createError === 'object' && 'response' in createError ? (createError as { response?: { body?: { message?: string } } }).response?.body : undefined);
    
    if (statusCode === 409 && errorBody?.message) {
      const match = errorBody.message.match(/Existing ID:\s*(\d+)/);
      if (match && match[1]) {
        logger.info(`[HubSpotDeals] Contact ${email} already exists (ID: ${match[1]}), using existing`);
        return { contactId: match[1], isNew: false };
      }
    }
    
    throw createError;
  }
}

export async function createMembershipDeal(
  contactId: string,
  memberEmail: string,
  dealName: string,
  tier: string,
  startDate?: string,
  stage?: string
): Promise<string> {
  logger.info(`[HubSpot] Deal creation disabled — skipping deal for ${memberEmail}`);
  return 'DEALS_DISABLED';
  const hubspot = await getHubSpotClient();
  const { denormalizeTierForHubSpot } = await import('../../utils/tierUtils');
  const hubspotTier = tier ? denormalizeTierForHubSpot(tier) : null;
  
  const properties: Record<string, string> = {
    dealname: dealName,
    pipeline: MEMBERSHIP_PIPELINE_ID,
    dealstage: stage || HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE,
    closedate: startDate || getTodayPacific()
  };
  
  if (hubspotTier) {
    properties.membership_tier = hubspotTier;
  }
  
  const dealResponse = await retryableHubSpotRequest(() =>
    hubspot.crm.deals.basicApi.create({ properties })
  );
  
  const dealId = dealResponse.id;
  
  await retryableHubSpotRequest(() =>
    hubspot.crm.associations.v4.basicApi.create(
      'deals',
      dealId,
      'contacts',
      contactId,
      [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 3 }]
    )
  );
  
  return dealId;
}

export async function createDealForLegacyMember(
  memberEmail: string,
  mindbodyStatus: string,
  performedBy: string,
  performedByName?: string
): Promise<{ success: boolean; dealId?: string; contactId?: string; lineItemId?: string; error?: string }> {
  logger.info(`[HubSpot] Deal creation disabled — skipping legacy deal for ${memberEmail}`);
  return { success: true, dealId: undefined, error: 'Deal creation disabled' };
  const normalizedEmail = memberEmail.toLowerCase().trim();
  
  try {
    const memberResult = await db.execute(sql`SELECT id, first_name, last_name, email, phone, tier, tags FROM users WHERE LOWER(email) = ${normalizedEmail}`);
    
    if (memberResult.rows.length === 0) {
      if (!isProduction) logger.info(`[HubSpotDeals] Member not found in users table: ${memberEmail}`);
      return { success: false, error: 'Member not found in users table' };
    }
    
    const memberRows = memberResult.rows as Array<Record<string, unknown>>;
    const member = memberRows[0];
    const tier = (member.tier as string) || 'Resident';
    const firstName = (member.first_name as string) || '';
    const lastName = (member.last_name as string) || '';
    const phone = (member.phone as string) || '';
    
    const product = await getProductMapping(tier);
    if (!product) {
      if (!isProduction) logger.info(`[HubSpotDeals] No product mapping for tier: ${tier}`);
      return { success: false, error: `No HubSpot product found for tier: ${tier}` };
    }
    
    const normalizedStatus = mindbodyStatus.toLowerCase().replace(/[^a-z-]/g, '');
    const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus] || HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE;
    
    const { contactId, isNew: isNewContact } = await findOrCreateHubSpotContact(
      normalizedEmail,
      firstName as string,
      lastName as string,
      phone as string,
      tier as string
    );
    
    const existingDeals = await getContactDeals(contactId);
    const existingMembershipDeal = existingDeals.find((deal: HubSpotDeal) => 
      deal.properties?.pipeline === MEMBERSHIP_PIPELINE_ID
    );
    
    if (existingMembershipDeal) {
      logger.info(`[HubSpotDeals] Contact ${normalizedEmail} already has a membership deal in HubSpot (ID: ${existingMembershipDeal.id}), skipping creation`);
      
      const localRecord = await db.select()
        .from(hubspotDeals)
        .where(eq(hubspotDeals.hubspotDealId, existingMembershipDeal.id))
        .limit(1);
      
      if (localRecord.length === 0) {
        await db.insert(hubspotDeals).values({
          memberEmail: normalizedEmail,
          hubspotContactId: contactId,
          hubspotDealId: existingMembershipDeal.id,
          dealName: existingMembershipDeal.properties?.dealname || `${firstName} ${lastName} - Membership`,
          pipelineId: MEMBERSHIP_PIPELINE_ID,
          pipelineStage: existingMembershipDeal.properties?.dealstage || targetStage,
          isPrimary: true,
          lastKnownMindbodyStatus: normalizedStatus,
          billingProvider: 'mindbody'
        } as typeof hubspotDeals.$inferInsert);
      }
      
      return { 
        success: true, 
        dealId: existingMembershipDeal.id, 
        contactId,
        error: 'Used existing deal (duplicate prevention)'
      };
    }
    
    const fullName = (firstName || lastName) 
      ? `${firstName} ${lastName}`.trim() 
      : normalizedEmail.split('@')[0];
    const dealName = `${fullName} - ${tier as string} Membership (Legacy)`;
    const dealId = await createMembershipDeal(
      contactId,
      normalizedEmail,
      dealName,
      tier as string,
      undefined,
      targetStage
    );
    
    const lineItemResult = await addLineItemToDeal(
      dealId,
      product.hubspotProductId,
      1,
      0,
      undefined,
      performedBy,
      performedByName
    );
    
    if (!lineItemResult.success) {
      logger.error('[HubSpotDeals] Failed to add line item for legacy member deal');
    }
    
    await db.insert(hubspotDeals).values({
      memberEmail: normalizedEmail,
      hubspotContactId: contactId,
      hubspotDealId: dealId,
      dealName,
      pipelineId: MEMBERSHIP_PIPELINE_ID,
      pipelineStage: targetStage,
      isPrimary: true,
      lastKnownMindbodyStatus: normalizedStatus,
      billingProvider: 'mindbody'
    } as typeof hubspotDeals.$inferInsert);
    
    await db.execute(sql`UPDATE users SET hubspot_id = ${contactId}, updated_at = NOW() WHERE LOWER(email) = ${normalizedEmail} AND (hubspot_id IS NULL OR hubspot_id = '')`);
    
    await logBillingAudit({
      memberEmail: normalizedEmail,
      hubspotDealId: dealId,
      actionType: 'deal_created_for_legacy_member',
      actionDetails: {
        firstName,
        lastName,
        tier,
        mindbodyStatus: normalizedStatus,
        targetStage,
        isNewContact,
        billingProvider: 'mindbody'
      },
      newValue: `Created deal for legacy member with ${tier} membership at stage ${targetStage}`,
      performedBy,
      performedByName
    });
    
    if (!isProduction) {
      logger.info(`[HubSpotDeals] Created deal ${dealId} for legacy member ${normalizedEmail} (stage: ${targetStage})`);
    }
    
    return {
      success: true,
      dealId,
      contactId,
      lineItemId: lineItemResult.lineItemId
    };
    
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error creating deal for legacy member:', { error: error });
    return { success: false, error: getErrorMessage(error) || 'Failed to create deal for legacy member' };
  }
}

export interface CreateMemberLocallyResult {
  success: boolean;
  userId?: number;
  error?: string;
}

export async function createMemberLocally(input: AddMemberInput): Promise<CreateMemberLocallyResult> {
  const { firstName, lastName, email, phone, tier, startDate, discountReason } = input;
  const normalizedEmail = email.toLowerCase().trim();
  
  const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${normalizedEmail}`);
  if (exclusionCheck.rows.length > 0) {
    return { success: false, error: 'This email belongs to a permanently deleted member and cannot be re-added. Remove them from the sync exclusions list first if this is intentional.' };
  }
  
  if (!tier || tier.trim() === '') {
    return { success: false, error: 'Membership tier is required when creating a member' };
  }
  
  try {
    const { resolveUserByEmail } = await import('../stripe/customers');
    const resolved = await resolveUserByEmail(normalizedEmail);

    const existingUser = resolved
      ? await db.execute(sql`SELECT id, email, role, membership_status FROM users WHERE id = ${resolved.userId}`)
      : await db.execute(sql`SELECT id, email, role, membership_status FROM users WHERE LOWER(email) = ${normalizedEmail}`);

    if (resolved && resolved.matchType !== 'direct') {
      logger.info(`[AddMember] Email ${normalizedEmail} resolved to existing user ${resolved.primaryEmail} via ${resolved.matchType}`);
    }
    
    const existingRows = existingUser.rows as Array<Record<string, unknown>>;
    if (existingRows.length > 0) {
      const existing = existingRows[0];
      if (existing.role === 'member' && existing.membership_status === 'active') {
        return { success: false, error: 'A member with this email already exists' };
      }
      
      const updateResult = await db.execute(sql`UPDATE users SET 
          first_name = COALESCE(NULLIF(${firstName}, ''), first_name),
          last_name = COALESCE(NULLIF(${lastName}, ''), last_name),
          phone = COALESCE(NULLIF(${phone || null}, ''), phone),
          role = 'member',
          tier = ${tier},
          membership_status = 'active',
          billing_provider = COALESCE(billing_provider, 'stripe'),
          join_date = COALESCE(join_date, ${startDate || getTodayPacific()}),
          discount_code = ${discountReason || null},
          updated_at = NOW()
        WHERE id = ${existing.id}
        RETURNING id`);
      
      logger.info(`[AddMember] Converted existing visitor ${normalizedEmail} to member with tier ${tier}`);

      findOrCreateHubSpotContact(normalizedEmail, firstName, lastName, phone || undefined, tier)
        .catch((err: unknown) => logger.error(`[AddMember] HubSpot contact sync failed for converted visitor ${normalizedEmail}:`, { extra: { detail: getErrorMessage(err) } }));

      return { success: true, userId: (updateResult.rows as Array<Record<string, unknown>>)[0].id as number };
    }
    
    const tags: string[] = [];
    const result = await db.execute(sql`INSERT INTO users (
        email, first_name, last_name, phone, role, tier, 
        membership_status, billing_provider,
        tags, discount_code, data_source, join_date, created_at, updated_at
      ) VALUES (${normalizedEmail}, ${firstName}, ${lastName}, ${phone || null}, 'member', ${tier}, 'active', 'stripe', ${JSON.stringify(tags)}, ${discountReason || null}, 'staff_manual', ${startDate || getTodayPacific()}, NOW(), NOW())
      RETURNING id`);

    findOrCreateHubSpotContact(normalizedEmail, firstName, lastName, phone || undefined, tier)
      .catch((err: unknown) => logger.error(`[AddMember] HubSpot contact sync failed for ${normalizedEmail}:`, { extra: { detail: getErrorMessage(err) } }));
    
    return { success: true, userId: (result.rows as Array<Record<string, unknown>>)[0].id as number };
  } catch (error: unknown) {
    logger.error('[AddMember] Failed to create user locally:', { error: error });
    return { success: false, error: getErrorMessage(error) || 'Failed to create member' };
  }
}

export async function syncNewMemberToHubSpot(input: AddMemberInput): Promise<void> {
  logger.info(`[HubSpot] Deal creation disabled — skipping syncNewMemberToHubSpot`);
  return;
  const { firstName, lastName, email, phone, tier, startDate, discountReason, createdBy, createdByName } = input;
  const normalizedEmail = email.toLowerCase().trim();
  
  const existingUser = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${normalizedEmail}`);
  
  if (existingUser.rows.length === 0) {
    logger.warn(`[SyncMember] User ${normalizedEmail} not found in database - skipping HubSpot sync`);
    return;
  }
  
  const product = await getProductMapping(tier);
  if (!product) {
    throw new Error(`No HubSpot product found for tier: ${tier}`);
  }
  
  let discountPercent = 0;
  if (discountReason) {
    const discountResult = await db.execute(sql`SELECT discount_percent FROM discount_rules WHERE discount_tag = ${discountReason} AND is_active = true`);
    const discountRows = discountResult.rows as Array<Record<string, unknown>>;
    if (discountRows.length > 0) {
      discountPercent = discountRows[0].discount_percent as number;
    }
  }
  
  const { contactId, isNew: isNewContact } = await findOrCreateHubSpotContact(
    normalizedEmail,
    firstName,
    lastName,
    phone,
    tier
  );
  
  const dealName = `${firstName} ${lastName} - ${tier} Membership`;
  const dealId = await createMembershipDeal(
    contactId,
    normalizedEmail,
    dealName,
    tier,
    startDate
  );
  
  const lineItemResult = await addLineItemToDeal(
    dealId,
    product.hubspotProductId,
    1,
    discountPercent,
    discountReason,
    createdBy,
    createdByName || createdBy
  );
  
  if (!lineItemResult.success) {
    try {
      const hubspot = await getHubSpotClient();
      await hubspot.crm.deals.basicApi.archive(dealId);
    } catch (rollbackError: unknown) {
      logger.error('[SyncMember] Failed to rollback deal creation:', { error: rollbackError });
    }
    throw new Error('Failed to add line item to deal');
  }
  
  await db.execute(sql`UPDATE users SET hubspot_id = ${contactId}, updated_at = NOW() WHERE LOWER(email) = ${normalizedEmail}`);
  
  try {
    await db.insert(hubspotDeals).values({
      memberEmail: normalizedEmail,
      hubspotContactId: contactId,
      hubspotDealId: dealId,
      dealName,
      pipelineId: MEMBERSHIP_PIPELINE_ID,
      pipelineStage: HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE,
      isPrimary: true,
      lastKnownMindbodyStatus: 'active'
    });
  } catch (dealError: unknown) {
    logger.warn('[SyncMember] Failed to store deal record locally:', { error: dealError });
  }
  
  await logBillingAudit({
    memberEmail: normalizedEmail,
    hubspotDealId: dealId,
    actionType: 'member_created',
    actionDetails: {
      firstName,
      lastName,
      tier,
      discountReason,
      discountPercent,
      isNewContact,
      billingProvider: 'hubspot',
      syncedViaQueue: true
    },
    newValue: `Created member with ${tier} membership`,
    performedBy: createdBy,
    performedByName: createdByName || createdBy
  });
  
  if (!isProduction) {
    logger.info(`[SyncMember] Successfully synced member ${normalizedEmail} to HubSpot with deal ${dealId}`);
  }
}

export async function createMemberWithDeal(input: AddMemberInput): Promise<AddMemberResult> {
  const {
    firstName,
    lastName,
    email,
    phone,
    tier,
    startDate,
    discountReason,
    createdBy,
    createdByName
  } = input;
  
  logger.info(`[HubSpot] Deal creation disabled — skipping createMemberWithDeal for ${email}`);
  return { success: false, error: 'Deal creation is currently disabled' };
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    const { resolveUserByEmail } = await import('../stripe/customers');
    const resolved = await resolveUserByEmail(normalizedEmail);

    const existingUser = resolved
      ? await db.execute(sql`SELECT id, email FROM users WHERE id = ${resolved.userId}`)
      : await db.execute(sql`SELECT id, email FROM users WHERE LOWER(email) = ${normalizedEmail}`);

    if (resolved && resolved.matchType !== 'direct') {
      logger.info(`[AddMemberWithDeal] Email ${normalizedEmail} resolved to existing user ${resolved.primaryEmail} via ${resolved.matchType}`);
    }
    
    if (existingUser.rows.length > 0) {
      return { success: false, error: 'A member with this email already exists' };
    }
    
    const product = await getProductMapping(tier);
    if (!product) {
      return { success: false, error: `No HubSpot product found for tier: ${tier}` };
    }
    
    let discountPercent = 0;
    if (discountReason) {
      const discountResult = await db.execute(sql`SELECT discount_percent FROM discount_rules WHERE discount_tag = ${discountReason} AND is_active = true`);
      const discountRows2 = discountResult.rows as Array<Record<string, unknown>>;
      if (discountRows2.length > 0) {
        discountPercent = discountRows2[0].discount_percent as number;
      }
    }
    
    const { contactId, isNew: isNewContact } = await findOrCreateHubSpotContact(
      normalizedEmail,
      firstName,
      lastName,
      phone,
      tier
    );
    
    const dealName = `${firstName} ${lastName} - ${tier} Membership`;
    const dealId = await createMembershipDeal(
      contactId,
      normalizedEmail,
      dealName,
      tier,
      startDate
    );
    
    const lineItemResult = await addLineItemToDeal(
      dealId,
      product.hubspotProductId,
      1,
      discountPercent,
      discountReason,
      createdBy,
      createdByName
    );
    
    if (!lineItemResult.success) {
      try {
        const hubspot = await getHubSpotClient();
        await hubspot.crm.deals.basicApi.archive(dealId);
      } catch (rollbackError: unknown) {
        logger.error('[AddMember] Failed to rollback deal creation:', { error: rollbackError });
      }
      return { success: false, error: 'Failed to add line item to deal' };
    }
    
    let userId: { rows: Array<{ id: number }> };
    
    try {
      const tags: string[] = [];
      userId = await db.execute(sql`INSERT INTO users (
          email, first_name, last_name, phone, role, tier, 
          membership_status, billing_provider, hubspot_id, 
          tags, discount_code, data_source, join_date, created_at, updated_at
        ) VALUES (${normalizedEmail}, ${firstName}, ${lastName}, ${phone || null}, 'member', ${tier}, 'active', 'stripe', ${contactId}, ${JSON.stringify(tags)}, ${discountReason || null}, 'staff_manual', ${startDate || getTodayPacific()}, NOW(), NOW())
        RETURNING id`) as any;
    } catch (userError: unknown) {
      logger.error('[AddMember] Failed to create user in database:', { error: userError });
      return { success: false, error: 'Failed to create user record in database' };
    }
    
    try {
      await db.insert(hubspotDeals).values({
        memberEmail: normalizedEmail,
        hubspotContactId: contactId,
        hubspotDealId: dealId,
        dealName,
        pipelineId: MEMBERSHIP_PIPELINE_ID,
        pipelineStage: HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE,
        isPrimary: true,
        lastKnownMindbodyStatus: 'active'
      });
    } catch (dealError: unknown) {
      logger.warn('[AddMember] Failed to store deal record locally (HubSpot has the deal though):', { error: dealError });
    }
    
    await logBillingAudit({
      memberEmail: normalizedEmail,
      hubspotDealId: dealId,
      actionType: 'member_created',
      actionDetails: {
        firstName,
        lastName,
        tier,
        discountReason,
        discountPercent,
        isNewContact,
        billingProvider: 'hubspot'
      },
      newValue: `Created member with ${tier} membership`,
      performedBy: createdBy,
      performedByName: createdByName
    });
    
    if (!isProduction) {
      logger.info(`[AddMember] Successfully created member ${normalizedEmail} with deal ${dealId}`);
    }
    
    return {
      success: true,
      userId: String(userId.rows[0].id),
      hubspotContactId: contactId,
      hubspotDealId: dealId,
      lineItemId: lineItemResult.lineItemId
    };
    
  } catch (error: unknown) {
    logger.error('[AddMember] Error creating member:', { error: error });
    return { success: false, error: getErrorMessage(error) || 'Failed to create member' };
  }
}

export async function getMemberPaymentStatus(email: string): Promise<{
  status: 'current' | 'overdue' | 'failed' | 'unknown';
  lastPaymentDate?: string;
  overdueAmount?: number;
  invoiceCount?: number;
}> {
  try {
    const deal = await db.select()
      .from(hubspotDeals)
      .where(and(
        eq(hubspotDeals.memberEmail, email.toLowerCase()),
        eq(hubspotDeals.isPrimary, true)
      ))
      .limit(1);
    
    if (deal.length === 0) {
      return { status: 'unknown' };
    }
    
    const cachedDeal = deal[0];
    if (cachedDeal.lastPaymentCheck) {
      const lastCheck = new Date(cachedDeal.lastPaymentCheck);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (lastCheck > hourAgo && cachedDeal.lastPaymentStatus) {
        return { status: cachedDeal.lastPaymentStatus as 'current' | 'overdue' | 'failed' | 'unknown' };
      }
    }
    
    const stage = cachedDeal.pipelineStage;
    let status: 'current' | 'overdue' | 'failed' | 'unknown' = 'unknown';
    
    if (stage === HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE) {
      status = 'current';
    } else if (stage === HUBSPOT_STAGE_IDS.PAYMENT_DECLINED) {
      status = 'failed';
    } else if (stage === HUBSPOT_STAGE_IDS.CLOSED_LOST) {
      status = 'failed';
    }
    
    await db.update(hubspotDeals)
      .set({
        lastPaymentStatus: status,
        lastPaymentCheck: new Date(),
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.id, cachedDeal.id));
    
    return { status };
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error getting payment status:', { error: error });
    return { status: 'unknown' };
  }
}

export interface TierChangeResult {
  success: boolean;
  oldLineItemRemoved?: boolean;
  newLineItemAdded?: boolean;
  newLineItemId?: string;
  error?: string;
}

export async function handleTierChange(
  memberEmail: string,
  oldTier: string,
  newTier: string,
  performedBy: string,
  performedByName?: string
): Promise<TierChangeResult> {
  const normalizedEmail = memberEmail.toLowerCase().trim();
  
  try {
    const existingDeal = await db.select()
      .from(hubspotDeals)
      .where(and(
        eq(hubspotDeals.memberEmail, normalizedEmail),
        eq(hubspotDeals.isPrimary, true)
      ))
      .limit(1);
    
    if (existingDeal.length === 0) {
      const fallbackDeal = await db.select()
        .from(hubspotDeals)
        .where(eq(hubspotDeals.memberEmail, normalizedEmail))
        .limit(1);
      
      if (fallbackDeal.length === 0) {
        logger.warn(`[HubSpotDeals] No deal found for member ${normalizedEmail} during tier change - skipping HubSpot sync`);
        return { success: true, oldLineItemRemoved: false, newLineItemAdded: false };
      }
      
      existingDeal.push(fallbackDeal[0]);
    }
    
    const deal = existingDeal[0];
    const hubspotDealId = deal.hubspotDealId;
    
    const oldProduct = await getProductMapping(oldTier);
    const newProduct = await getProductMapping(newTier);
    
    if (!newProduct) {
      logger.error(`[HubSpotDeals] No product mapping found for new tier: ${newTier}`);
      return { success: false, error: `No HubSpot product found for tier: ${newTier}` };
    }
    
    const existingLineItems = await db.select()
      .from(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotDealId, hubspotDealId));
    
    let discountPercent = 0;
    let discountReason: string | undefined;
    let oldLineItemRemoved = false;
    
    const oldTierLineItem = existingLineItems.find(li => 
      oldProduct && li.hubspotProductId === oldProduct.hubspotProductId
    );
    
    if (oldTierLineItem && oldTierLineItem.hubspotLineItemId) {
      discountPercent = oldTierLineItem.discountPercent || 0;
      discountReason = oldTierLineItem.discountReason || undefined;
      
      try {
        const hubspot = await getHubSpotClient();
        await retryableHubSpotRequest(() =>
          hubspot.crm.lineItems.basicApi.archive(oldTierLineItem.hubspotLineItemId!)
        );
        
        await db.delete(hubspotLineItems)
          .where(eq(hubspotLineItems.hubspotLineItemId, oldTierLineItem.hubspotLineItemId!));
        
        oldLineItemRemoved = true;
        
        if (!isProduction) {
          logger.info(`[HubSpotDeals] Removed old tier line item ${oldTierLineItem.hubspotLineItemId} for tier ${oldTier}`);
        }
      } catch (removeError: unknown) {
        logger.error(`[HubSpotDeals] Failed to remove old line item:`, { error: removeError });
      }
    }
    
    const lineItemResult = await addLineItemToDeal(
      hubspotDealId,
      newProduct.hubspotProductId,
      1,
      discountPercent,
      discountReason,
      performedBy,
      performedByName
    );
    
    if (!lineItemResult.success) {
      return { 
        success: false, 
        oldLineItemRemoved,
        newLineItemAdded: false,
        error: 'Failed to add new tier line item' 
      };
    }
    
    const { denormalizeTierForHubSpot } = await import('../../utils/tierUtils');
    const hubspotNewTier = denormalizeTierForHubSpot(newTier);
    
    if (hubspotNewTier) {
      try {
        const hubspot = await getHubSpotClient();
        await retryableHubSpotRequest(() =>
          hubspot.crm.deals.basicApi.update(hubspotDealId, {
            properties: {
              membership_tier: hubspotNewTier
            }
          })
        );
      } catch (dealUpdateError: unknown) {
        logger.warn('[HubSpotDeals] Failed to update deal membership_tier property:', { error: dealUpdateError });
      }
      
      if (deal.hubspotContactId) {
        try {
          const hubspot = await getHubSpotClient();
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(deal.hubspotContactId!, {
              properties: {
                membership_tier: hubspotNewTier
              }
            })
          );
        } catch (contactUpdateError: unknown) {
          logger.warn('[HubSpotDeals] Failed to update contact membership_tier property:', { error: contactUpdateError });
        }
      }
    }
    
    await logBillingAudit({
      memberEmail: normalizedEmail,
      hubspotDealId,
      actionType: 'tier_changed',
      previousValue: oldTier,
      newValue: newTier,
      actionDetails: {
        oldProductId: oldProduct?.hubspotProductId || null,
        newProductId: newProduct.hubspotProductId,
        oldLineItemRemoved,
        newLineItemId: lineItemResult.lineItemId,
        discountPreserved: discountPercent > 0,
        discountPercent,
        discountReason
      },
      performedBy,
      performedByName
    });
    
    await db.update(hubspotDeals)
      .set({
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.id, deal.id));
    
    if (!isProduction) {
      logger.info(`[HubSpotDeals] Tier change completed for ${normalizedEmail}: ${oldTier} -> ${newTier}`);
    }
    
    return {
      success: true,
      oldLineItemRemoved,
      newLineItemAdded: true,
      newLineItemId: lineItemResult.lineItemId
    };
    
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error handling tier change:', { error: error });
    return { success: false, error: getErrorMessage(error) || 'Failed to handle tier change' };
  }
}

export async function syncTierToHubSpot(params: {
  email: string;
  newTier: string;
  oldTier?: string;
  changedBy?: string;
  changedByName?: string;
}): Promise<void> {
  const { email, newTier, oldTier, changedBy, changedByName } = params;
  const normalizedEmail = email.toLowerCase().trim();
  
  const { denormalizeTierForHubSpot } = await import('../../utils/tierUtils');
  const hubspotTier = denormalizeTierForHubSpot(newTier);
  const isTierCleared = !newTier || newTier === '';
  
  if (!hubspotTier && !isTierCleared) {
    logger.info(`[HubSpot TierSync] Unknown tier "${newTier}" for ${normalizedEmail}, skipping HubSpot sync`);
    return;
  }
  
  const userResult = await db.execute(sql`SELECT hubspot_id, billing_provider, membership_status FROM users WHERE LOWER(email) = ${normalizedEmail}`);
  
  const userRows = userResult.rows as Array<Record<string, unknown>>;
  if (userRows.length === 0 || !userRows[0].hubspot_id) {
    logger.info(`[HubSpot TierSync] No HubSpot ID for ${normalizedEmail}, skipping sync`);
    return;
  }
  
  const hubspotContactId = userRows[0].hubspot_id as string;
  const billingProvider = userRows[0].billing_provider as string;
  const membershipStatus = userRows[0].membership_status as string;
  
  // Map billing provider to HubSpot value
  const DB_BILLING_PROVIDER_TO_HUBSPOT: Record<string, string> = {
    'stripe': 'Stripe',
    'mindbody': 'MindBody',
    'hubspot': 'Manual',
    'manual': 'Manual',
    'comped': 'Comped'
  };
  const hubspotBillingProvider = billingProvider ? (DB_BILLING_PROVIDER_TO_HUBSPOT[(billingProvider as string).toLowerCase()] || 'Manual') : undefined;
  
  // Determine lifecycle stage based on membership status
  const isActive = membershipStatus && ['active', 'trialing', 'past_due'].includes((membershipStatus as string).toLowerCase());
  const lifecyclestage = isActive ? 'customer' : 'other';
  
  try {
    const hubspot = await getHubSpotClient();
    
    const properties: Record<string, string> = {
      membership_tier: hubspotTier || '',
      membership_status: membershipStatus || '',
      lifecyclestage: lifecyclestage
    };
    
    if (hubspotBillingProvider) {
      properties.billing_provider = hubspotBillingProvider;
    }
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.update(hubspotContactId, { properties })
    );
    
    logger.info(`[HubSpot TierSync] Updated contact ${normalizedEmail}: tier="${hubspotTier}", status="${membershipStatus}", lifecycle="${lifecyclestage}", billing="${hubspotBillingProvider || 'not set'}"`);
    
    const dealResult = await db.select()
      .from(hubspotDeals)
      .where(and(
        eq(hubspotDeals.memberEmail, normalizedEmail),
        eq(hubspotDeals.isPrimary, true)
      ))
      .limit(1);
    
    if (dealResult.length > 0 && dealResult[0].hubspotDealId) {
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.deals.basicApi.update(dealResult[0].hubspotDealId!, {
            properties: {
              membership_tier: hubspotTier
            }
          })
        );
        logger.info(`[HubSpot TierSync] Updated deal ${dealResult[0].hubspotDealId} tier to "${hubspotTier}"`);
      } catch (dealError: unknown) {
        logger.warn(`[HubSpot TierSync] Failed to update deal tier for ${normalizedEmail}:`, { error: dealError });
      }
    }
  } catch (error: unknown) {
    logger.error(`[HubSpot TierSync] Failed to sync tier for ${normalizedEmail}:`, { error: error });
    throw error;
  }
}

export interface CancellationResult {
  success: boolean;
  lineItemsRemoved: number;
  dealMovedToLost: boolean;
  error?: string;
}

export async function handleMembershipCancellation(
  memberEmail: string,
  performedBy: string,
  performedByName?: string
): Promise<CancellationResult> {
  const normalizedEmail = memberEmail.toLowerCase().trim();
  
  try {
    const existingDeal = await db.select()
      .from(hubspotDeals)
      .where(and(
        eq(hubspotDeals.memberEmail, normalizedEmail),
        eq(hubspotDeals.isPrimary, true)
      ))
      .limit(1);
    
    if (existingDeal.length === 0) {
      const fallbackDeal = await db.select()
        .from(hubspotDeals)
        .where(eq(hubspotDeals.memberEmail, normalizedEmail))
        .limit(1);
      
      if (fallbackDeal.length === 0) {
        logger.info(`[HubSpotDeals] No deal found for cancelled member ${normalizedEmail} - skipping HubSpot sync`);
        return { success: true, lineItemsRemoved: 0, dealMovedToLost: false };
      }
      
      existingDeal.push(fallbackDeal[0]);
    }
    
    const deal = existingDeal[0];
    const hubspotDealId = deal.hubspotDealId;
    
    if (!hubspotDealId) {
      logger.info(`[HubSpotDeals] Deal has no HubSpot ID for ${normalizedEmail} - skipping HubSpot sync`);
      return { success: true, lineItemsRemoved: 0, dealMovedToLost: false };
    }
    
    const existingLineItems = await db.select()
      .from(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotDealId, hubspotDealId));
    
    let lineItemsRemoved = 0;
    const hubspot = await getHubSpotClient();
    
    for (const lineItem of existingLineItems) {
      if (lineItem.hubspotLineItemId) {
        try {
          await retryableHubSpotRequest(() =>
            hubspot.crm.lineItems.basicApi.archive(lineItem.hubspotLineItemId!)
          );
          
          await db.delete(hubspotLineItems)
            .where(eq(hubspotLineItems.hubspotLineItemId, lineItem.hubspotLineItemId));
          
          lineItemsRemoved++;
          
          if (!isProduction) {
            logger.info(`[HubSpotDeals] Removed line item ${lineItem.hubspotLineItemId} for cancelled member ${normalizedEmail}`);
          }
        } catch (removeError: unknown) {
          logger.error(`[HubSpotDeals] Failed to remove line item ${lineItem.hubspotLineItemId}:`, { error: removeError });
        }
      }
    }
    
    let dealMovedToLost = false;
    const { HUBSPOT_STAGE_IDS } = await import('./constants');
    
    if (deal.pipelineStage !== HUBSPOT_STAGE_IDS.CLOSED_LOST) {
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.deals.basicApi.update(hubspotDealId, {
            properties: {
              dealstage: HUBSPOT_STAGE_IDS.CLOSED_LOST
            }
          })
        );
        
        await db.update(hubspotDeals)
          .set({
            pipelineStage: HUBSPOT_STAGE_IDS.CLOSED_LOST,
            lastStageSyncAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(hubspotDeals.id, deal.id));
        
        dealMovedToLost = true;
        logger.info(`[HubSpotDeals] Moved deal ${hubspotDealId} to Closed Lost for ${normalizedEmail}`);
      } catch (stageError: unknown) {
        logger.error(`[HubSpotDeals] Failed to move deal to Closed Lost:`, { error: stageError });
      }
    }
    
    if (deal.hubspotContactId) {
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(deal.hubspotContactId!, {
            properties: {
              membership_status: 'cancelled',
              membership_tier: ''
            }
          })
        );
        logger.info(`[HubSpotDeals] Updated contact status to cancelled for ${normalizedEmail}`);
      } catch (contactError: unknown) {
        logger.warn(`[HubSpotDeals] Failed to update contact status:`, { error: contactError });
      }
    }
    
    await logBillingAudit({
      memberEmail: normalizedEmail,
      hubspotDealId,
      actionType: 'membership_cancelled',
      previousValue: deal.pipelineStage || 'unknown',
      newValue: HUBSPOT_STAGE_IDS.CLOSED_LOST,
      actionDetails: {
        lineItemsRemoved,
        dealMovedToLost,
        previousStage: deal.pipelineStage
      },
      performedBy,
      performedByName
    });
    
    logger.info(`[HubSpotDeals] Cancellation processed for ${normalizedEmail}: ${lineItemsRemoved} line items removed, deal moved to lost: ${dealMovedToLost}`);
    
    return {
      success: true,
      lineItemsRemoved,
      dealMovedToLost
    };
    
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error handling membership cancellation:', { error: error });
    return { success: false, lineItemsRemoved: 0, dealMovedToLost: false, error: getErrorMessage(error) || 'Failed to handle cancellation' };
  }
}

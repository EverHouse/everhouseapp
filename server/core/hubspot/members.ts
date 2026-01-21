import { db } from '../../db';
import { pool, isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { hubspotDeals, hubspotLineItems, billingAuditLog } from '../../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { HUBSPOT_STAGE_IDS, MEMBERSHIP_PIPELINE_ID, MINDBODY_TO_STAGE_MAP } from './constants';
import { getProductMapping } from './products';
import { addLineItemToDeal } from './lineItems';

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

export async function getContactDeals(hubspotContactId: string): Promise<any[]> {
  try {
    const hubspot = await getHubSpotClient();
    const response = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.associationsApi.getAll(hubspotContactId, 'deals')
    );
    
    if (!response.results || response.results.length === 0) {
      return [];
    }
    
    const dealIds = response.results.map((r: any) => r.id);
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
  } catch (error) {
    console.error('[HubSpotDeals] Error fetching contact deals:', error);
    return [];
  }
}

export async function findOrCreateHubSpotContact(
  email: string,
  firstName: string,
  lastName: string,
  phone?: string,
  tier?: string
): Promise<{ contactId: string; isNew: boolean }> {
  const hubspot = await getHubSpotClient();
  
  try {
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ',
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
  } catch (error: any) {
    const statusCode = error?.response?.statusCode || error?.status || error?.statusCode;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
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
      console.error('[HubSpotDeals] Network/Auth error during contact search:', error);
      throw error;
    }
    
    if (!isProduction) console.warn('[HubSpotDeals] Error searching for contact, will create new one:', error);
  }
  
  try {
    const createResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.create({
        properties: {
          email: email.toLowerCase(),
          firstname: firstName,
          lastname: lastName,
          phone: phone || '',
          membership_tier: tier?.toLowerCase() || '',
          membership_status: 'Active',
          lifecyclestage: 'customer'
        }
      })
    );
    
    return { contactId: createResponse.id, isNew: true };
  } catch (createError: any) {
    const statusCode = createError?.code || createError?.response?.statusCode || createError?.status;
    const errorBody = createError?.body || createError?.response?.body;
    
    if (statusCode === 409 && errorBody?.message) {
      const match = errorBody.message.match(/Existing ID:\s*(\d+)/);
      if (match && match[1]) {
        console.log(`[HubSpotDeals] Contact ${email} already exists (ID: ${match[1]}), using existing`);
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
  const hubspot = await getHubSpotClient();
  
  const dealResponse = await retryableHubSpotRequest(() =>
    hubspot.crm.deals.basicApi.create({
      properties: {
        dealname: dealName,
        pipeline: MEMBERSHIP_PIPELINE_ID,
        dealstage: stage || HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE,
        closedate: startDate || new Date().toISOString().split('T')[0],
        membership_tier: tier?.toLowerCase() || ''
      }
    })
  );
  
  const dealId = dealResponse.id;
  
  await retryableHubSpotRequest(() =>
    hubspot.crm.associations.v4.basicApi.create(
      'deals',
      dealId,
      'contacts',
      contactId,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
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
  const normalizedEmail = memberEmail.toLowerCase().trim();
  
  try {
    const memberResult = await pool.query(
      'SELECT id, first_name, last_name, email, phone, tier, tags FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    if (memberResult.rows.length === 0) {
      if (!isProduction) console.log(`[HubSpotDeals] Member not found in users table: ${memberEmail}`);
      return { success: false, error: 'Member not found in users table' };
    }
    
    const member = memberResult.rows[0];
    const tier = member.tier || 'Resident';
    const firstName = member.first_name || '';
    const lastName = member.last_name || '';
    const phone = member.phone || '';
    
    const product = await getProductMapping(tier);
    if (!product) {
      if (!isProduction) console.log(`[HubSpotDeals] No product mapping for tier: ${tier}`);
      return { success: false, error: `No HubSpot product found for tier: ${tier}` };
    }
    
    const normalizedStatus = mindbodyStatus.toLowerCase().replace(/[^a-z-]/g, '');
    const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus] || HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE;
    
    const { contactId, isNew: isNewContact } = await findOrCreateHubSpotContact(
      normalizedEmail,
      firstName,
      lastName,
      phone,
      tier
    );
    
    const existingDeals = await getContactDeals(contactId);
    const existingMembershipDeal = existingDeals.find((deal: any) => 
      deal.properties?.pipeline === MEMBERSHIP_PIPELINE_ID
    );
    
    if (existingMembershipDeal) {
      console.log(`[HubSpotDeals] Contact ${normalizedEmail} already has a membership deal in HubSpot (ID: ${existingMembershipDeal.id}), skipping creation`);
      
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
        });
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
    const dealName = `${fullName} - ${tier} Membership (Legacy)`;
    const dealId = await createMembershipDeal(
      contactId,
      normalizedEmail,
      dealName,
      tier,
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
      console.error('[HubSpotDeals] Failed to add line item for legacy member deal');
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
    });
    
    await pool.query(
      'UPDATE users SET hubspot_id = $1, updated_at = NOW() WHERE LOWER(email) = $2 AND (hubspot_id IS NULL OR hubspot_id = \'\')',
      [contactId, normalizedEmail]
    );
    
    await db.insert(billingAuditLog).values({
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
      console.log(`[HubSpotDeals] Created deal ${dealId} for legacy member ${normalizedEmail} (stage: ${targetStage})`);
    }
    
    return {
      success: true,
      dealId,
      contactId,
      lineItemId: lineItemResult.lineItemId
    };
    
  } catch (error: any) {
    console.error('[HubSpotDeals] Error creating deal for legacy member:', error);
    return { success: false, error: error.message || 'Failed to create deal for legacy member' };
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
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    const existingUser = await pool.query(
      'SELECT id, email FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    if (existingUser.rows.length > 0) {
      return { success: false, error: 'A member with this email already exists' };
    }
    
    const product = await getProductMapping(tier);
    if (!product) {
      return { success: false, error: `No HubSpot product found for tier: ${tier}` };
    }
    
    let discountPercent = 0;
    if (discountReason) {
      const discountResult = await pool.query(
        'SELECT discount_percent FROM discount_rules WHERE discount_tag = $1 AND is_active = true',
        [discountReason]
      );
      if (discountResult.rows.length > 0) {
        discountPercent = discountResult.rows[0].discount_percent;
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
      } catch (rollbackError) {
        console.error('[AddMember] Failed to rollback deal creation:', rollbackError);
      }
      return { success: false, error: 'Failed to add line item to deal' };
    }
    
    let userId: any;
    
    try {
      const tags = discountReason ? [discountReason] : [];
      userId = await pool.query(
        `INSERT INTO users (
          email, first_name, last_name, phone, role, tier, 
          membership_status, billing_provider, hubspot_id, 
          tags, data_source, join_date, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'member', $5, 'active', 'hubspot', $6, $7, 'staff_manual', $8, NOW(), NOW())
        RETURNING id`,
        [
          normalizedEmail,
          firstName,
          lastName,
          phone || null,
          tier,
          contactId,
          JSON.stringify(tags),
          startDate || new Date().toISOString().split('T')[0]
        ]
      );
    } catch (userError: any) {
      console.error('[AddMember] Failed to create user in database:', userError);
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
    } catch (dealError: any) {
      console.warn('[AddMember] Failed to store deal record locally (HubSpot has the deal though):', dealError);
    }
    
    await db.insert(billingAuditLog).values({
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
      performedByName
    });
    
    if (!isProduction) {
      console.log(`[AddMember] Successfully created member ${normalizedEmail} with deal ${dealId}`);
    }
    
    return {
      success: true,
      userId: userId.rows[0].id,
      hubspotContactId: contactId,
      hubspotDealId: dealId,
      lineItemId: lineItemResult.lineItemId
    };
    
  } catch (error: any) {
    console.error('[AddMember] Error creating member:', error);
    return { success: false, error: error.message || 'Failed to create member' };
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
        return { status: cachedDeal.lastPaymentStatus as any };
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
  } catch (error) {
    console.error('[HubSpotDeals] Error getting payment status:', error);
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
        console.warn(`[HubSpotDeals] No deal found for member ${normalizedEmail} during tier change - skipping HubSpot sync`);
        return { success: true, oldLineItemRemoved: false, newLineItemAdded: false };
      }
      
      existingDeal.push(fallbackDeal[0]);
    }
    
    const deal = existingDeal[0];
    const hubspotDealId = deal.hubspotDealId;
    
    const oldProduct = await getProductMapping(oldTier);
    const newProduct = await getProductMapping(newTier);
    
    if (!newProduct) {
      console.error(`[HubSpotDeals] No product mapping found for new tier: ${newTier}`);
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
          console.log(`[HubSpotDeals] Removed old tier line item ${oldTierLineItem.hubspotLineItemId} for tier ${oldTier}`);
        }
      } catch (removeError: any) {
        console.error(`[HubSpotDeals] Failed to remove old line item:`, removeError);
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
    
    try {
      const hubspot = await getHubSpotClient();
      await retryableHubSpotRequest(() =>
        hubspot.crm.deals.basicApi.update(hubspotDealId, {
          properties: {
            membership_tier: newTier
          }
        })
      );
    } catch (dealUpdateError) {
      console.warn('[HubSpotDeals] Failed to update deal membership_tier property:', dealUpdateError);
    }
    
    if (deal.hubspotContactId) {
      try {
        const hubspot = await getHubSpotClient();
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(deal.hubspotContactId!, {
            properties: {
              membership_tier: newTier
            }
          })
        );
      } catch (contactUpdateError) {
        console.warn('[HubSpotDeals] Failed to update contact membership_tier property:', contactUpdateError);
      }
    }
    
    await db.insert(billingAuditLog).values({
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
      console.log(`[HubSpotDeals] Tier change completed for ${normalizedEmail}: ${oldTier} -> ${newTier}`);
    }
    
    return {
      success: true,
      oldLineItemRemoved,
      newLineItemAdded: true,
      newLineItemId: lineItemResult.lineItemId
    };
    
  } catch (error: any) {
    console.error('[HubSpotDeals] Error handling tier change:', error);
    return { success: false, error: error.message || 'Failed to handle tier change' };
  }
}

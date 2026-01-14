import { db } from '../db';
import { pool, isProduction } from './db';
import { getHubSpotClient } from './integrations';
import { 
  hubspotDeals, 
  hubspotLineItems, 
  hubspotProductMappings, 
  discountRules,
  billingAuditLog 
} from '../../shared/schema';
import { eq, and, inArray } from 'drizzle-orm';
import pRetry, { AbortError } from 'p-retry';

const MEMBERSHIP_PIPELINE_ID = process.env.HUBSPOT_MEMBERSHIP_PIPELINE_ID || 'default';

// HubSpot Stage IDs from the Membership Sales pipeline
export const HUBSPOT_STAGE_IDS = {
  DAY_PASS_TOUR_REQUEST: '2414796536',
  TOUR_BOOKED: '2413968103',
  VISITED_DAY_PASS: '2414796537',
  APPLICATION_SUBMITTED: '2414797498',
  BILLING_SETUP: '2825519819',
  CLOSED_WON_ACTIVE: 'closedwon',
  PAYMENT_DECLINED: '2825519820',
  CLOSED_LOST: 'closedlost',
};

// Map Mindbody statuses to HubSpot deal stage IDs
const MINDBODY_TO_STAGE_MAP: Record<string, string> = {
  'active': HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE,      // Active Member stage
  'pending': HUBSPOT_STAGE_IDS.BILLING_SETUP,
  'declined': HUBSPOT_STAGE_IDS.PAYMENT_DECLINED,    // Payment Declined stage
  'suspended': HUBSPOT_STAGE_IDS.PAYMENT_DECLINED,   // Payment Declined stage
  'expired': HUBSPOT_STAGE_IDS.CLOSED_LOST,          // Cancelled/Churned stage
  'terminated': HUBSPOT_STAGE_IDS.CLOSED_LOST,       // Cancelled/Churned stage
  'cancelled': HUBSPOT_STAGE_IDS.CLOSED_LOST,        // Cancelled/Churned stage
  'froze': HUBSPOT_STAGE_IDS.PAYMENT_DECLINED,       // Keep in Payment Declined (frozen but not churned)
  'non-member': HUBSPOT_STAGE_IDS.CLOSED_LOST,
};

// Map Mindbody statuses to HubSpot contact membership_status property
// 'active' = full app access, 'inactive' = access kill-switch, 'former_member' = churned
type ContactMembershipStatus = 'active' | 'inactive' | 'former_member';

const MINDBODY_TO_CONTACT_STATUS_MAP: Record<string, ContactMembershipStatus> = {
  'active': 'active',
  'pending': 'active',
  'declined': 'inactive',          // Payment issue - kill switch
  'suspended': 'inactive',         // Payment issue - kill switch
  'froze': 'inactive',             // Frozen - kill switch
  'expired': 'former_member',      // Churned
  'terminated': 'former_member',   // Churned
  'cancelled': 'former_member',    // Churned
  'non-member': 'former_member',
};

// Statuses that should mark contact as inactive (kill switch for app features)
const INACTIVE_STATUSES = ['declined', 'suspended', 'froze'];
const CHURNED_STATUSES = ['expired', 'terminated', 'cancelled', 'non-member'];
const ACTIVE_STATUSES = ['active', 'pending'];

function isRateLimitError(error: any): boolean {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const statusCode = error?.response?.statusCode || error?.status || error?.code;
  return (
    statusCode === 429 ||
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

// Cache for pipeline validation to avoid repeated API calls
let pipelineValidationCache: { 
  validated: boolean; 
  pipelineExists: boolean;
  validStages: string[];
  lastChecked: Date | null;
} = { validated: false, pipelineExists: false, validStages: [], lastChecked: null };

// Validate that the Membership Pipeline and required stages exist in HubSpot
export async function validateMembershipPipeline(): Promise<{ 
  valid: boolean; 
  pipelineExists: boolean; 
  missingStages: string[];
  error?: string;
}> {
  try {
    // Check cache (valid for 1 hour)
    const cacheAge = pipelineValidationCache.lastChecked 
      ? Date.now() - pipelineValidationCache.lastChecked.getTime() 
      : Infinity;
    
    if (pipelineValidationCache.validated && cacheAge < 3600000) {
      const requiredStages = Object.values(HUBSPOT_STAGE_IDS);
      const missingStages = requiredStages.filter(s => !pipelineValidationCache.validStages.includes(s));
      return {
        valid: pipelineValidationCache.pipelineExists && missingStages.length === 0,
        pipelineExists: pipelineValidationCache.pipelineExists,
        missingStages
      };
    }
    
    const hubspot = await getHubSpotClient();
    
    // Get all deal pipelines
    const pipelinesResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.pipelines.pipelinesApi.getAll('deals')
    );
    
    const membershipPipeline = pipelinesResponse.results.find(
      (p: any) => p.id === MEMBERSHIP_PIPELINE_ID || p.label?.toLowerCase().includes('membership')
    );
    
    if (!membershipPipeline) {
      pipelineValidationCache = { validated: true, pipelineExists: false, validStages: [], lastChecked: new Date() };
      return {
        valid: false,
        pipelineExists: false,
        missingStages: Object.values(HUBSPOT_STAGE_IDS),
        error: `Membership Pipeline (${MEMBERSHIP_PIPELINE_ID}) not found in HubSpot`
      };
    }
    
    // Extract valid stage IDs from the pipeline
    const validStages = membershipPipeline.stages?.map((s: any) => s.id) || [];
    
    // Check which required stages are missing
    const requiredStages = Object.values(HUBSPOT_STAGE_IDS);
    const missingStages = requiredStages.filter(s => !validStages.includes(s));
    
    pipelineValidationCache = { 
      validated: true, 
      pipelineExists: true, 
      validStages,
      lastChecked: new Date()
    };
    
    if (missingStages.length > 0) {
      console.warn(`[HubSpotDeals] Missing stages in Membership Pipeline: ${missingStages.join(', ')}`);
    }
    
    return {
      valid: missingStages.length === 0,
      pipelineExists: true,
      missingStages
    };
  } catch (error: any) {
    console.error('[HubSpotDeals] Error validating membership pipeline:', error);
    return {
      valid: false,
      pipelineExists: false,
      missingStages: [],
      error: error.message || 'Failed to validate pipeline'
    };
  }
}

// Check if a specific stage is valid before attempting to move a deal
export function isValidStage(stageId: string): boolean {
  if (!pipelineValidationCache.validated) return true; // Allow if not yet validated
  return pipelineValidationCache.validStages.includes(stageId);
}

async function retryableHubSpotRequest<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error: any) {
        if (isRateLimitError(error)) {
          if (!isProduction) console.warn('HubSpot Rate Limit hit, retrying...');
          throw error;
        }
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

export async function updateDealStage(
  hubspotDealId: string,
  newStage: string,
  performedBy: string,
  performedByName?: string
): Promise<boolean> {
  try {
    const hubspot = await getHubSpotClient();
    
    const existingDeal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.hubspotDealId, hubspotDealId))
      .limit(1);
    
    const previousStage = existingDeal[0]?.pipelineStage || null;
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.deals.basicApi.update(hubspotDealId, {
        properties: {
          dealstage: newStage
        }
      })
    );
    
    await db.update(hubspotDeals)
      .set({
        pipelineStage: newStage,
        lastStageSyncAt: new Date(),
        lastSyncError: null,
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.hubspotDealId, hubspotDealId));
    
    if (existingDeal[0]) {
      await db.insert(billingAuditLog).values({
        memberEmail: existingDeal[0].memberEmail,
        hubspotDealId,
        actionType: 'stage_changed',
        previousValue: previousStage,
        newValue: newStage,
        performedBy,
        performedByName
      });
    }
    
    if (!isProduction) console.log(`[HubSpotDeals] Updated deal ${hubspotDealId} to stage ${newStage}`);
    return true;
  } catch (error: any) {
    console.error('[HubSpotDeals] Error updating deal stage:', error);
    
    await db.update(hubspotDeals)
      .set({
        lastSyncError: error.message || 'Unknown error',
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.hubspotDealId, hubspotDealId));
    
    return false;
  }
}

// Update HubSpot contact's membership_status property (the app kill switch)
async function updateContactMembershipStatus(
  hubspotContactId: string,
  newStatus: ContactMembershipStatus,
  performedBy: string
): Promise<boolean> {
  try {
    const hubspot = await getHubSpotClient();
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.update(hubspotContactId, {
        properties: {
          membership_status: newStatus
        }
      })
    );
    
    if (!isProduction) console.log(`[HubSpotDeals] Updated contact ${hubspotContactId} membership_status to ${newStatus}`);
    return true;
  } catch (error) {
    console.error('[HubSpotDeals] Error updating contact membership_status:', error);
    return false;
  }
}

export async function syncDealStageFromMindbodyStatus(
  memberEmail: string,
  mindbodyStatus: string,
  performedBy: string = 'system',
  performedByName?: string
): Promise<{ success: boolean; dealId?: string; newStage?: string; contactUpdated?: boolean; error?: string }> {
  try {
    // Validate pipeline exists before attempting sync
    const pipelineValidation = await validateMembershipPipeline();
    if (!pipelineValidation.pipelineExists) {
      console.error(`[HubSpotDeals] Cannot sync: ${pipelineValidation.error}`);
      return { success: false, error: pipelineValidation.error };
    }
    
    const normalizedStatus = mindbodyStatus.toLowerCase().replace(/[^a-z-]/g, '');
    const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus];
    
    if (!targetStage) {
      if (!isProduction) console.log(`[HubSpotDeals] No stage mapping for status: ${mindbodyStatus}`);
      return { success: false, error: `No stage mapping for status: ${mindbodyStatus}` };
    }
    
    // Validate target stage exists in pipeline
    if (!isValidStage(targetStage)) {
      console.warn(`[HubSpotDeals] Target stage ${targetStage} not found in pipeline, check HubSpot configuration`);
    }
    
    // Find primary deal for this member
    const existingDeal = await db.select()
      .from(hubspotDeals)
      .where(and(
        eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()),
        eq(hubspotDeals.isPrimary, true)
      ))
      .limit(1);
    
    // Fallback to any deal if no primary found
    const fallbackDeal = existingDeal.length === 0 
      ? await db.select()
          .from(hubspotDeals)
          .where(eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()))
          .limit(1)
      : existingDeal;
    
    if (fallbackDeal.length === 0) {
      if (!isProduction) console.log(`[HubSpotDeals] No deal found for member: ${memberEmail}, creating deal for legacy member`);
      
      // Create deal for legacy Mindbody member
      const legacyDealResult = await createDealForLegacyMember(
        memberEmail,
        mindbodyStatus,
        performedBy,
        performedByName
      );
      
      if (!legacyDealResult.success) {
        console.error(`[HubSpotDeals] Failed to create deal for legacy member ${memberEmail}: ${legacyDealResult.error}`);
        return { success: false };
      }
      
      return {
        success: true,
        dealId: legacyDealResult.dealId,
        newStage: targetStage,
        contactUpdated: true
      };
    }
    
    const deal = fallbackDeal[0];
    
    // Check if already in the correct state
    if (deal.pipelineStage === targetStage && deal.lastKnownMindbodyStatus === normalizedStatus) {
      return { success: true, dealId: deal.hubspotDealId, newStage: targetStage };
    }
    
    // Determine contact status based on Mindbody status using the new mapping
    const targetContactStatus: ContactMembershipStatus = MINDBODY_TO_CONTACT_STATUS_MAP[normalizedStatus] || 'inactive';
    const isRecovery = ACTIVE_STATUSES.includes(normalizedStatus);
    const isChurned = CHURNED_STATUSES.includes(normalizedStatus);
    
    // Update local deal record
    await db.update(hubspotDeals)
      .set({
        lastKnownMindbodyStatus: normalizedStatus,
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.id, deal.id));
    
    // Update deal stage in HubSpot
    const dealUpdated = await updateDealStage(deal.hubspotDealId, targetStage, performedBy, performedByName);
    
    // Update contact membership_status in HubSpot (the kill switch)
    let contactUpdated = false;
    if (deal.hubspotContactId) {
      contactUpdated = await updateContactMembershipStatus(deal.hubspotContactId, targetContactStatus, performedBy);
      
      // Log the contact status change
      await db.insert(billingAuditLog).values({
        memberEmail: deal.memberEmail,
        hubspotDealId: deal.hubspotDealId,
        actionType: 'contact_status_changed',
        newValue: targetContactStatus,
        actionDetails: { 
          trigger: 'mindbody_status_sync', 
          mindbodyStatus: normalizedStatus,
          statusCategory: isRecovery ? 'recovery' : isChurned ? 'churned' : 'payment_issue'
        },
        performedBy,
        performedByName
      });
    }
    
    // Log status transitions
    if (isRecovery) {
      if (!isProduction) console.log(`[HubSpotDeals] Recovery: Member ${memberEmail} status changed to Active, deal moved to ${targetStage}`);
    } else if (isChurned) {
      if (!isProduction) console.log(`[HubSpotDeals] Churned: Member ${memberEmail} marked as former_member, deal moved to ${targetStage}`);
    } else {
      if (!isProduction) console.log(`[HubSpotDeals] Payment Issue: Member ${memberEmail} marked as inactive, deal moved to ${targetStage}`);
    }
    
    return { success: dealUpdated, dealId: deal.hubspotDealId, newStage: targetStage, contactUpdated };
  } catch (error) {
    console.error('[HubSpotDeals] Error syncing deal stage from Mindbody:', error);
    return { success: false };
  }
}

export async function getApplicableDiscounts(memberTags: string[]): Promise<{ tag: string; percent: number }[]> {
  if (!memberTags || memberTags.length === 0) {
    return [];
  }
  
  const rules = await db.select()
    .from(discountRules)
    .where(and(
      inArray(discountRules.discountTag, memberTags),
      eq(discountRules.isActive, true)
    ));
  
  return rules.map(r => ({ tag: r.discountTag, percent: r.discountPercent }));
}

export async function calculateTotalDiscount(memberTags: string[]): Promise<{ totalPercent: number; appliedRules: string[] }> {
  const discounts = await getApplicableDiscounts(memberTags);
  
  if (discounts.length === 0) {
    return { totalPercent: 0, appliedRules: [] };
  }
  
  const maxDiscount = discounts.reduce((max, d) => d.percent > max.percent ? d : max, discounts[0]);
  
  return {
    totalPercent: Math.min(maxDiscount.percent, 100),
    appliedRules: [maxDiscount.tag]
  };
}

export async function getProductMapping(tierName?: string, productType?: string): Promise<any | null> {
  try {
    let query = db.select().from(hubspotProductMappings).where(eq(hubspotProductMappings.isActive, true));
    
    if (tierName) {
      const result = await db.select()
        .from(hubspotProductMappings)
        .where(and(
          eq(hubspotProductMappings.tierName, tierName),
          eq(hubspotProductMappings.isActive, true)
        ))
        .limit(1);
      return result[0] || null;
    }
    
    if (productType) {
      const result = await db.select()
        .from(hubspotProductMappings)
        .where(and(
          eq(hubspotProductMappings.productType, productType),
          eq(hubspotProductMappings.isActive, true)
        ));
      return result;
    }
    
    return null;
  } catch (error) {
    console.error('[HubSpotDeals] Error getting product mapping:', error);
    return null;
  }
}

export async function addLineItemToDeal(
  hubspotDealId: string,
  productId: string,
  quantity: number = 1,
  discountPercent: number = 0,
  discountReason?: string,
  createdBy?: string,
  createdByName?: string
): Promise<{ success: boolean; lineItemId?: string }> {
  try {
    const product = await db.select()
      .from(hubspotProductMappings)
      .where(eq(hubspotProductMappings.hubspotProductId, productId))
      .limit(1);
    
    if (product.length === 0) {
      console.error('[HubSpotDeals] Product not found:', productId);
      return { success: false };
    }
    
    const productInfo = product[0];
    const unitPrice = parseFloat(productInfo.unitPrice?.toString() || '0');
    const discountedPrice = unitPrice * (1 - discountPercent / 100);
    const totalAmount = discountedPrice * quantity;
    
    const hubspot = await getHubSpotClient();
    
    const lineItemResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.lineItems.basicApi.create({
        properties: {
          hs_product_id: productId,
          quantity: String(quantity),
          price: String(discountedPrice),
          name: productInfo.productName,
          ...(discountPercent > 0 && { 
            hs_discount_percentage: String(discountPercent),
            ...(discountReason && { discount_reason: discountReason })
          })
        }
      })
    );
    
    const lineItemId = lineItemResponse.id;
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.associations.v4.basicApi.create(
        'line_items',
        lineItemId,
        'deals',
        hubspotDealId,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
      )
    );
    
    await db.insert(hubspotLineItems).values({
      hubspotDealId,
      hubspotLineItemId: lineItemId,
      hubspotProductId: productId,
      productName: productInfo.productName,
      quantity,
      unitPrice: productInfo.unitPrice,
      discountPercent,
      discountReason,
      totalAmount: String(totalAmount),
      status: 'synced',
      createdBy,
      createdByName
    });
    
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.hubspotDealId, hubspotDealId))
      .limit(1);
    
    if (deal[0] && createdBy) {
      await db.insert(billingAuditLog).values({
        memberEmail: deal[0].memberEmail,
        hubspotDealId,
        actionType: 'line_item_added',
        actionDetails: {
          productId,
          productName: productInfo.productName,
          quantity,
          unitPrice,
          discountPercent,
          discountReason,
          totalAmount
        },
        newValue: `${productInfo.productName} x${quantity} @ $${discountedPrice}`,
        performedBy: createdBy,
        performedByName
      });
    }
    
    if (!isProduction) console.log(`[HubSpotDeals] Added line item ${lineItemId} to deal ${hubspotDealId}`);
    return { success: true, lineItemId };
  } catch (error: any) {
    console.error('[HubSpotDeals] Error adding line item:', error);
    return { success: false };
  }
}

export async function removeLineItemFromDeal(
  lineItemId: string,
  performedBy: string,
  performedByName?: string
): Promise<boolean> {
  try {
    const lineItem = await db.select()
      .from(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotLineItemId, lineItemId))
      .limit(1);
    
    if (lineItem.length === 0) {
      console.error('[HubSpotDeals] Line item not found:', lineItemId);
      return false;
    }
    
    const hubspot = await getHubSpotClient();
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.lineItems.basicApi.archive(lineItemId)
    );
    
    await db.delete(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotLineItemId, lineItemId));
    
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.hubspotDealId, lineItem[0].hubspotDealId))
      .limit(1);
    
    if (deal[0]) {
      await db.insert(billingAuditLog).values({
        memberEmail: deal[0].memberEmail,
        hubspotDealId: lineItem[0].hubspotDealId,
        actionType: 'line_item_removed',
        actionDetails: {
          productName: lineItem[0].productName,
          quantity: lineItem[0].quantity,
          unitPrice: lineItem[0].unitPrice
        },
        previousValue: `${lineItem[0].productName} x${lineItem[0].quantity}`,
        performedBy,
        performedByName
      });
    }
    
    if (!isProduction) console.log(`[HubSpotDeals] Removed line item ${lineItemId}`);
    return true;
  } catch (error) {
    console.error('[HubSpotDeals] Error removing line item:', error);
    return false;
  }
}

export async function getMemberDealWithLineItems(memberEmail: string): Promise<any | null> {
  try {
    const deal = await db.select()
      .from(hubspotDeals)
      .where(eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()))
      .limit(1);
    
    if (deal.length === 0) {
      return null;
    }
    
    const lineItems = await db.select()
      .from(hubspotLineItems)
      .where(eq(hubspotLineItems.hubspotDealId, deal[0].hubspotDealId));
    
    return {
      ...deal[0],
      lineItems
    };
  } catch (error) {
    console.error('[HubSpotDeals] Error fetching member deal:', error);
    return null;
  }
}

export async function getAllProductMappings(): Promise<any[]> {
  try {
    const products = await db.select().from(hubspotProductMappings).orderBy(hubspotProductMappings.productType);
    return products;
  } catch (error) {
    console.error('[HubSpotDeals] Error fetching product mappings:', error);
    return [];
  }
}

export async function getAllDiscountRules(): Promise<any[]> {
  try {
    const rules = await db.select().from(discountRules).orderBy(discountRules.discountPercent);
    return rules;
  } catch (error) {
    console.error('[HubSpotDeals] Error fetching discount rules:', error);
    return [];
  }
}

export async function updateDiscountRule(
  discountTag: string,
  discountPercent: number,
  description?: string
): Promise<boolean> {
  try {
    await db.update(discountRules)
      .set({
        discountPercent,
        description,
        updatedAt: new Date()
      })
      .where(eq(discountRules.discountTag, discountTag));
    
    return true;
  } catch (error) {
    console.error('[HubSpotDeals] Error updating discount rule:', error);
    return false;
  }
}

export async function getBillingAuditLog(memberEmail: string, limit: number = 50): Promise<any[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM billing_audit_log 
       WHERE member_email = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [memberEmail.toLowerCase(), limit]
    );
    return result.rows;
  } catch (error) {
    console.error('[HubSpotDeals] Error fetching billing audit log:', error);
    return [];
  }
}

// ============================================================
// ADD MEMBER FEATURE - Silent Mode (Deal + Line Item, no invoice)
// ============================================================

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

// Find or create HubSpot contact
async function findOrCreateHubSpotContact(
  email: string,
  firstName: string,
  lastName: string,
  phone?: string,
  tier?: string
): Promise<{ contactId: string; isNew: boolean }> {
  const hubspot = await getHubSpotClient();
  
  // Try to find existing contact by email
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
    // Only proceed to create new contact if it's a "not found" type error
    // Re-throw network/auth errors so they bubble up
    const statusCode = error?.response?.statusCode || error?.status || error?.statusCode;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    // Check if this is a 404 Not Found error (contact doesn't exist)
    const isNotFoundError = statusCode === 404 || errorMsg.includes('not found');
    
    // Re-throw network/auth errors (5xx, 401, 403, connection errors, etc.)
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
    
    // For any other error, log it but proceed to create new contact
    if (!isProduction) console.warn('[HubSpotDeals] Error searching for contact, will create new one:', error);
  }
  
  // Create new contact
  try {
    const createResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.basicApi.create({
        properties: {
          email: email.toLowerCase(),
          firstname: firstName,
          lastname: lastName,
          phone: phone || '',
          membership_tier: tier?.toLowerCase() || '',
          membership_status: 'active',
          lifecyclestage: 'customer'
        }
      })
    );
    
    return { contactId: createResponse.id, isNew: true };
  } catch (createError: any) {
    // Handle 409 Conflict - contact already exists
    // HubSpot error message format: "Contact already exists. Existing ID: 355532534519"
    const statusCode = createError?.code || createError?.response?.statusCode || createError?.status;
    const errorBody = createError?.body || createError?.response?.body;
    
    if (statusCode === 409 && errorBody?.message) {
      const match = errorBody.message.match(/Existing ID:\s*(\d+)/);
      if (match && match[1]) {
        console.log(`[HubSpotDeals] Contact ${email} already exists (ID: ${match[1]}), using existing`);
        return { contactId: match[1], isNew: false };
      }
    }
    
    // Re-throw if we couldn't extract the contact ID
    throw createError;
  }
}

// Create a deal in the Membership Sales pipeline
async function createMembershipDeal(
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
  
  // Associate deal with contact using v3 associations API
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

// Create deal for legacy Mindbody members during sync
async function createDealForLegacyMember(
  memberEmail: string,
  mindbodyStatus: string,
  performedBy: string,
  performedByName?: string
): Promise<{ success: boolean; dealId?: string; contactId?: string; lineItemId?: string; error?: string }> {
  const normalizedEmail = memberEmail.toLowerCase().trim();
  
  try {
    // Step 1: Fetch the member from users table to get their tier and name
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
    
    // Step 2: Get product mapping for the member's tier
    const product = await getProductMapping(tier);
    if (!product) {
      if (!isProduction) console.log(`[HubSpotDeals] No product mapping for tier: ${tier}`);
      return { success: false, error: `No HubSpot product found for tier: ${tier}` };
    }
    
    // Step 3: Determine the appropriate stage based on Mindbody status
    const normalizedStatus = mindbodyStatus.toLowerCase().replace(/[^a-z-]/g, '');
    const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus] || HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE;
    
    // Step 4: Find or create HubSpot contact
    const { contactId, isNew: isNewContact } = await findOrCreateHubSpotContact(
      normalizedEmail,
      firstName,
      lastName,
      phone,
      tier
    );
    
    // Step 4.5: Check if contact already has a deal in our pipeline (prevent duplicates)
    const existingDeals = await getContactDeals(contactId);
    const existingMembershipDeal = existingDeals.find((deal: any) => 
      deal.properties?.pipeline === MEMBERSHIP_PIPELINE_ID
    );
    
    if (existingMembershipDeal) {
      console.log(`[HubSpotDeals] Contact ${normalizedEmail} already has a membership deal in HubSpot (ID: ${existingMembershipDeal.id}), skipping creation`);
      
      // Store in local database if not already there
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
    
    // Step 5: Create deal in HubSpot with appropriate stage
    const dealName = `${firstName} ${lastName} - ${tier} Membership (Legacy)`;
    const dealId = await createMembershipDeal(
      contactId,
      normalizedEmail,
      dealName,
      tier,
      undefined,
      targetStage
    );
    
    // Step 6: Add line item to deal (Silent Mode - no invoice)
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
    
    // Step 7: Store deal record locally with billingProvider = 'mindbody' and isPrimary = true
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
    
    // Step 8: Update user's hubspot_id if not already set
    await pool.query(
      'UPDATE users SET hubspot_id = $1, updated_at = NOW() WHERE LOWER(email) = $2 AND (hubspot_id IS NULL OR hubspot_id = \'\')',
      [contactId, normalizedEmail]
    );
    
    // Step 9: Log the action to billingAuditLog
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

// Main Add Member function - Silent Mode
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
    // Step 1: Check if user already exists in our database
    const existingUser = await pool.query(
      'SELECT id, email FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    if (existingUser.rows.length > 0) {
      return { success: false, error: 'A member with this email already exists' };
    }
    
    // Step 2: Get product mapping for the selected tier
    const product = await getProductMapping(tier);
    if (!product) {
      return { success: false, error: `No HubSpot product found for tier: ${tier}` };
    }
    
    // Step 3: Calculate discount if discount reason provided
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
    
    // Step 4: Find or create HubSpot contact
    const { contactId, isNew: isNewContact } = await findOrCreateHubSpotContact(
      normalizedEmail,
      firstName,
      lastName,
      phone,
      tier
    );
    
    // Step 5: Create deal in HubSpot
    const dealName = `${firstName} ${lastName} - ${tier} Membership`;
    const dealId = await createMembershipDeal(
      contactId,
      normalizedEmail,
      dealName,
      tier,
      startDate
    );
    
    // Step 6: Add line item to deal
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
      // Rollback: delete the deal we just created
      try {
        const hubspot = await getHubSpotClient();
        await hubspot.crm.deals.basicApi.archive(dealId);
      } catch (rollbackError) {
        console.error('[AddMember] Failed to rollback deal creation:', rollbackError);
      }
      return { success: false, error: 'Failed to add line item to deal' };
    }
    
    // Step 7 & 8: Create user and deal record in database
    // Wrapped in try/catch to handle partial failures gracefully
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
    
    // Step 8: Store deal record locally (non-critical - HubSpot already has the deal)
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
      // Don't return error - the deal exists in HubSpot, just missing from local cache
      // This is non-critical since HubSpot is the source of truth
    }
    
    // Step 9: Log the action
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

// Get member payment status from HubSpot Commerce API (read-only)
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
    
    // If no deal found, member is likely legacy Mindbody - return unknown
    if (deal.length === 0) {
      return { status: 'unknown' };
    }
    
    // Check if we have a cached status that's recent (within 1 hour)
    const cachedDeal = deal[0];
    if (cachedDeal.lastPaymentCheck) {
      const lastCheck = new Date(cachedDeal.lastPaymentCheck);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (lastCheck > hourAgo && cachedDeal.lastPaymentStatus) {
        return { status: cachedDeal.lastPaymentStatus as any };
      }
    }
    
    // For now, infer status from deal stage
    // In the future, this can query the Commerce API for invoice/payment data
    const stage = cachedDeal.pipelineStage;
    let status: 'current' | 'overdue' | 'failed' | 'unknown' = 'unknown';
    
    if (stage === HUBSPOT_STAGE_IDS.CLOSED_WON_ACTIVE) {
      status = 'current';
    } else if (stage === HUBSPOT_STAGE_IDS.PAYMENT_DECLINED) {
      status = 'failed';
    } else if (stage === HUBSPOT_STAGE_IDS.CLOSED_LOST) {
      status = 'failed';
    }
    
    // Update cache
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
    
    // Update local hubspot_deals record with sync timestamp
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

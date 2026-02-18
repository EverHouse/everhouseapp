import { db } from '../../db';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { hubspotDeals, billingAuditLog, hubspotLineItems } from '../../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { validateMembershipPipeline, isValidStage } from './pipeline';
import { isPlaceholderEmail } from '../stripe/customers';

import { logger } from '../logger';
let _isLiveStripeCache: boolean | null = null;
async function isLiveStripeEnvironment(): Promise<boolean> {
  if (_isLiveStripeCache !== null) return _isLiveStripeCache;
  try {
    const { getStripeEnvironmentInfo } = await import('../stripe/client');
    const envInfo = await getStripeEnvironmentInfo();
    _isLiveStripeCache = envInfo.isLive;
  } catch {
    _isLiveStripeCache = process.env.REPLIT_DEPLOYMENT === '1';
  }
  return _isLiveStripeCache;
}

import { 
  HUBSPOT_STAGE_IDS, 
  MINDBODY_TO_STAGE_MAP, 
  MINDBODY_TO_CONTACT_STATUS_MAP,
  ACTIVE_STATUSES,
  CHURNED_STATUSES,
  ContactMembershipStatus,
  BillingProvider,
  DB_STATUS_TO_HUBSPOT_STATUS,
  DB_BILLING_PROVIDER_TO_HUBSPOT,
  DB_TIER_TO_HUBSPOT
} from './constants';

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
    
    if (!isProduction) logger.info(`[HubSpotDeals] Updated deal ${hubspotDealId} to stage ${newStage}`);
    return true;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error updating deal stage:', { error: error });
    
    await db.update(hubspotDeals)
      .set({
        lastSyncError: getErrorMessage(error) || 'Unknown error',
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.hubspotDealId, hubspotDealId));
    
    return false;
  }
}

export async function updateContactMembershipStatus(
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
    
    if (!isProduction) logger.info(`[HubSpotDeals] Updated contact ${hubspotContactId} membership_status to ${newStatus}`);
    return true;
  } catch (error) {
    logger.error('[HubSpotDeals] Error updating contact membership_status:', { error: error });
    return false;
  }
}

export interface SyncMemberToHubSpotInput {
  email: string;
  status?: string;
  billingProvider?: string;
  tier?: string;
  memberSince?: Date | string;
  createIfMissing?: boolean;
  stripeCustomerId?: string;
  stripeCreatedDate?: Date | string;
  stripeDelinquent?: boolean;
  stripeDiscountId?: string;
  stripePricingInterval?: string;
  billingGroupRole?: string;
}

export interface SyncMemberToHubSpotResult {
  success: boolean;
  contactId?: string;
  updated: {
    status?: boolean;
    billingProvider?: boolean;
    tier?: boolean;
    memberSince?: boolean;
    stripeFields?: boolean;
    billingGroupRole?: boolean;
  };
  error?: string;
}

export async function syncMemberToHubSpot(
  input: SyncMemberToHubSpotInput
): Promise<SyncMemberToHubSpotResult> {
  const { email, status, billingProvider, tier, memberSince, createIfMissing = true, stripeCustomerId, stripeCreatedDate, stripeDelinquent, stripeDiscountId, stripePricingInterval, billingGroupRole } = input;
  
  if (isPlaceholderEmail(email)) {
    logger.info(`[HubSpot Sync] Skipping sync for placeholder email: ${email}`);
    return { success: false, error: 'Placeholder email skipped', updated: {} };
  }
  
  try {
    const hubspot = await getHubSpotClient();
    
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ' as any,
            value: email.toLowerCase()
          }]
        }],
        properties: ['email', 'membership_status', 'billing_provider', 'membership_tier', 'membership_billing_type'],
        limit: 1
      })
    );
    
    let contactId: string;
    
    if (!searchResponse.results || searchResponse.results.length === 0) {
      if (!createIfMissing) {
        logger.info(`[HubSpot Sync] Contact not found for ${email}, skipping sync`);
        return { success: false, error: 'Contact not found', updated: {} };
      }
      
      // Create the contact if it doesn't exist
      logger.info(`[HubSpot Sync] Contact not found for ${email}, creating...`);
      const { findOrCreateHubSpotContact } = await import('./members');
      const result = await findOrCreateHubSpotContact(email, '', '');
      if (!result.contactId) {
        logger.error(`[HubSpot Sync] Failed to create contact for ${email}`);
        return { success: false, error: 'Failed to create contact', updated: {} };
      }
      contactId = result.contactId;
      logger.info(`[HubSpot Sync] Created contact ${contactId} for ${email}`);
    } else {
      contactId = searchResponse.results[0].id;
    }
    
    const properties: Record<string, string> = {};
    const updated: SyncMemberToHubSpotResult['updated'] = {};
    
    let effectiveBillingProvider = billingProvider?.toLowerCase() || null;
    if (!effectiveBillingProvider) {
      try {
        const { users } = await import('../../../shared/schema');
        const userResult = await db.select({ billingProvider: users.billingProvider })
          .from(users)
          .where(eq(users.email, email.toLowerCase()))
          .limit(1);
        effectiveBillingProvider = userResult[0]?.billingProvider || null;
      } catch (e) {
      }
    }

    const isMindbodyBilled = effectiveBillingProvider === 'mindbody';
    if (isMindbodyBilled && status) {
      logger.info(`[HubSpot Sync] Skipping status push for Mindbody-billed member ${email} to prevent sync loop`);
    }
    
    if (status && !isMindbodyBilled) {
      const normalizedStatus = status.toLowerCase();
      const hubspotStatus = DB_STATUS_TO_HUBSPOT_STATUS[normalizedStatus] || 'Suspended';
      properties.membership_status = hubspotStatus;
      updated.status = true;
      
      // Set lifecycle stage based on membership status
      // Active members should be 'customer', inactive/terminated should be 'other'
      const isActive = ['active', 'trialing', 'past_due'].includes(normalizedStatus);
      properties.lifecyclestage = isActive ? 'customer' : 'other';
    }
    
    if (billingProvider) {
      const normalizedProvider = billingProvider.toLowerCase();
      const hubspotProvider = DB_BILLING_PROVIDER_TO_HUBSPOT[normalizedProvider] || 'Manual';
      properties.billing_provider = hubspotProvider;
      updated.billingProvider = true;
    }
    
    if (tier) {
      const { denormalizeTierForHubSpot } = await import('../../utils/tierUtils');
      const hubspotTier = denormalizeTierForHubSpot(tier);
      if (hubspotTier) {
        properties.membership_tier = hubspotTier;
        updated.tier = true;
      }
    }
    
    if (memberSince) {
      const date = memberSince instanceof Date ? memberSince : new Date(memberSince);
      const midnightUtc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      properties.membership_start_date = midnightUtc.getTime().toString();
      updated.memberSince = true;
    }

    const isLiveStripe = await isLiveStripeEnvironment();

    if (isLiveStripe) {
      if (input.stripeCustomerId) {
        properties.stripe_customer_id = input.stripeCustomerId;
      }
      if (input.stripeCreatedDate) {
        const date = input.stripeCreatedDate instanceof Date ? input.stripeCreatedDate : new Date(input.stripeCreatedDate);
        const midnightUtc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        properties.stripe_created_date = midnightUtc.getTime().toString();
      }
      if (input.stripeDelinquent !== undefined) {
        properties.stripe_delinquent = input.stripeDelinquent ? 'true' : 'false';
      }
      if (input.stripeDiscountId) {
        properties.stripe_discount_id = input.stripeDiscountId;
      }
      if (input.stripePricingInterval) {
        properties.stripe_pricing_interval_of_last_active_subscription = input.stripePricingInterval;
      }
      if (Object.keys(properties).some(k => k.startsWith('stripe_'))) {
        updated.stripeFields = true;
      }
    } else {
      if (input.stripeCustomerId || input.stripeCreatedDate || input.stripeDelinquent !== undefined || input.stripeDiscountId || input.stripePricingInterval) {
        logger.info(`[HubSpot Sync] Skipping Stripe field push for ${email} — sandbox/test Stripe environment detected`);
      }
    }

    if (input.billingGroupRole) {
      properties.membership_billing_type = input.billingGroupRole;
      updated.billingGroupRole = true;
    }
    
    if (Object.keys(properties).length === 0) {
      logger.info(`[HubSpot Sync] No properties to update for ${email}`);
      return { success: true, contactId, updated };
    }
    
    // Try to update all properties first
    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(contactId, { properties })
      );
      logger.info(`[HubSpot Sync] Updated ${email}: ${JSON.stringify(properties)}`);
      return { success: true, contactId, updated };
    } catch (updateError: unknown) {
      // If some properties don't exist, retry with only the valid ones
      const errBody = updateError && typeof updateError === 'object' && 'body' in updateError ? (updateError as { body: { errors?: Array<{ code: string; context?: { propertyName?: string[] } }> } }).body : undefined;
      if (errBody?.errors?.some((e) => e.code === 'PROPERTY_DOESNT_EXIST')) {
        const invalidProps = errBody.errors
          .filter((e) => e.code === 'PROPERTY_DOESNT_EXIST')
          .map((e) => e.context?.propertyName?.[0]);
        
        const validProperties: Record<string, string> = {};
        for (const [key, value] of Object.entries(properties)) {
          if (!invalidProps.includes(key)) {
            validProperties[key] = value;
          }
        }
        
        if (Object.keys(validProperties).length > 0) {
          logger.info(`[HubSpot Sync] Retrying ${email} without missing properties: ${invalidProps.join(', ')}`);
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(contactId, { properties: validProperties })
          );
          logger.info(`[HubSpot Sync] Updated ${email}: ${JSON.stringify(validProperties)}`);
          return { success: true, contactId, updated };
        }
      }
      throw updateError;
    }
  } catch (error) {
    logger.error(`[HubSpot Sync] Error syncing ${email}:`, { error: error });
    return { success: false, error: error instanceof Error ? error.message : String(error), updated: {} };
  }
}

export async function syncDealStageFromMindbodyStatus(
  memberEmail: string,
  mindbodyStatus: string,
  performedBy: string = 'system',
  performedByName?: string
): Promise<{ success: boolean; dealId?: string; newStage?: string; contactUpdated?: boolean; error?: string }> {
  logger.info(`[HubSpot] Deal sync disabled — skipping stage sync for ${memberEmail}`);
  return { success: true, error: 'Deal sync disabled' };
  const { createDealForLegacyMember } = await import('./members');
  
  try {
    const pipelineValidation = await validateMembershipPipeline();
    if (!pipelineValidation.pipelineExists) {
      logger.error(`[HubSpotDeals] Cannot sync: ${pipelineValidation.error}`);
      return { success: false, error: pipelineValidation.error };
    }
    
    const normalizedStatus = mindbodyStatus.toLowerCase().replace(/[^a-z-]/g, '');
    const targetStage = MINDBODY_TO_STAGE_MAP[normalizedStatus];
    
    if (!targetStage) {
      if (!isProduction) logger.info(`[HubSpotDeals] No stage mapping for status: ${mindbodyStatus}`);
      return { success: false, error: `No stage mapping for status: ${mindbodyStatus}` };
    }
    
    if (!isValidStage(targetStage)) {
      logger.warn(`[HubSpotDeals] Target stage ${targetStage} not found in pipeline, check HubSpot configuration`);
    }
    
    const existingDeal = await db.select()
      .from(hubspotDeals)
      .where(and(
        eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()),
        eq(hubspotDeals.isPrimary, true)
      ))
      .limit(1);
    
    const fallbackDeal = existingDeal.length === 0 
      ? await db.select()
          .from(hubspotDeals)
          .where(eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()))
          .limit(1)
      : existingDeal;
    
    if (fallbackDeal.length === 0) {
      if (!isProduction) logger.info(`[HubSpotDeals] No deal found for member: ${memberEmail}, creating deal for legacy member`);
      
      const legacyDealResult = await createDealForLegacyMember(
        memberEmail,
        mindbodyStatus,
        performedBy,
        performedByName
      );
      
      if (!legacyDealResult.success) {
        if (!isProduction) logger.info(`[HubSpotDeals] Skipped deal creation for ${memberEmail}: ${legacyDealResult.error}`);
        return { success: false, error: legacyDealResult.error };
      }
      
      return {
        success: true,
        dealId: legacyDealResult.dealId,
        newStage: targetStage,
        contactUpdated: true
      };
    }
    
    const deal = fallbackDeal[0];
    
    if (deal.pipelineStage === targetStage && deal.lastKnownMindbodyStatus === normalizedStatus) {
      return { success: true, dealId: deal.hubspotDealId, newStage: targetStage };
    }
    
    const targetContactStatus: ContactMembershipStatus = MINDBODY_TO_CONTACT_STATUS_MAP[normalizedStatus] || 'Suspended';
    const isRecovery = ACTIVE_STATUSES.includes(normalizedStatus);
    const isChurned = CHURNED_STATUSES.includes(normalizedStatus);
    
    await db.update(hubspotDeals)
      .set({
        lastKnownMindbodyStatus: normalizedStatus,
        updatedAt: new Date()
      })
      .where(eq(hubspotDeals.id, deal.id));
    
    const dealUpdated = await updateDealStage(deal.hubspotDealId, targetStage, performedBy, performedByName);
    
    let contactUpdated = false;
    if (deal.hubspotContactId) {
      contactUpdated = await updateContactMembershipStatus(deal.hubspotContactId, targetContactStatus, performedBy);
      
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
    
    if (isRecovery) {
      if (!isProduction) logger.info(`[HubSpotDeals] Recovery: Member ${memberEmail} status changed to Active, deal moved to ${targetStage}`);
    } else if (isChurned) {
      if (!isProduction) logger.info(`[HubSpotDeals] Churned: Member ${memberEmail} marked as former_member, deal moved to ${targetStage}`);
      
      // Remove all line items and update contact for churned members (MindBody cancelled/terminated)
      if (deal.hubspotDealId) {
        try {
          const lineItems = await db.select()
            .from(hubspotLineItems)
            .where(eq(hubspotLineItems.hubspotDealId, deal.hubspotDealId));
          
          let lineItemsRemoved = 0;
          const hubspot = await getHubSpotClient();
          
          for (const lineItem of lineItems) {
            if (lineItem.hubspotLineItemId) {
              try {
                await retryableHubSpotRequest(() =>
                  hubspot.crm.lineItems.basicApi.archive(lineItem.hubspotLineItemId!)
                );
                
                await db.delete(hubspotLineItems)
                  .where(eq(hubspotLineItems.hubspotLineItemId, lineItem.hubspotLineItemId));
                
                lineItemsRemoved++;
              } catch (removeError: unknown) {
                logger.error(`[HubSpotDeals] Failed to remove line item ${lineItem.hubspotLineItemId}:`, { error: removeError });
              }
            }
          }
          
          // Clear membership tier on contact for churned members
          if (deal.hubspotContactId) {
            try {
              await retryableHubSpotRequest(() =>
                hubspot.crm.contacts.basicApi.update(deal.hubspotContactId!, {
                  properties: {
                    membership_tier: ''
                  }
                })
              );
              if (!isProduction) logger.info(`[HubSpotDeals] Cleared membership_tier for churned member ${memberEmail}`);
            } catch (tierClearError: unknown) {
              logger.warn(`[HubSpotDeals] Failed to clear membership_tier for ${memberEmail}:`, { error: tierClearError });
            }
          }
          
          if (lineItemsRemoved > 0) {
            logger.info(`[HubSpotDeals] Removed ${lineItemsRemoved} line items for churned MindBody member ${memberEmail}`);
          }
        } catch (lineItemError: unknown) {
          logger.error(`[HubSpotDeals] Error removing line items for churned member:`, { error: lineItemError });
        }
      }
    } else {
      if (!isProduction) logger.info(`[HubSpotDeals] Payment Issue: Member ${memberEmail} marked as inactive, deal moved to ${targetStage}`);
    }
    
    return { success: dealUpdated, dealId: deal.hubspotDealId, newStage: targetStage, contactUpdated };
  } catch (error) {
    logger.error('[HubSpotDeals] Error syncing deal stage from Mindbody:', { error: error });
    return { success: false };
  }
}

export async function ensureHubSpotPropertiesExist(): Promise<{ success: boolean; created: string[]; existing: string[]; errors: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  const errors: string[] = [];
  
  try {
    const hubspot = await getHubSpotClient();
    
    const billingProviderOptions = [
      { label: 'Stripe', value: 'stripe', displayOrder: 1 },
      { label: 'MindBody', value: 'mindbody', displayOrder: 2 },
      { label: 'Manual', value: 'manual', displayOrder: 3 },
      { label: 'None', value: 'None', displayOrder: 4 },
      { label: 'Comped', value: 'Comped', displayOrder: 5 },
    ];

    const propertiesToCreate = [
      {
        name: 'billing_provider',
        label: 'Billing Provider',
        type: 'enumeration',
        fieldType: 'select',
        groupName: 'contactinformation',
        description: 'The billing system managing this member\'s subscription',
        options: billingProviderOptions
      }
    ];
    
    for (const prop of propertiesToCreate) {
      try {
        const existingProp = await retryableHubSpotRequest(() =>
          hubspot.crm.properties.coreApi.getByName('contacts', prop.name)
        );
        existing.push(prop.name);
        logger.info(`[HubSpot] Property ${prop.name} already exists`);

        if (prop.type === 'enumeration' && prop.options) {
          const existingValues = new Set(
            (existingProp.options || []).map((o: { value: string }) => o.value)
          );
          const missingOptions = prop.options.filter(
            (o: { value: string }) => !existingValues.has(o.value)
          );
          if (missingOptions.length > 0) {
            const allOptions = [
              ...(existingProp.options || []),
              ...missingOptions,
            ];
            await retryableHubSpotRequest(() =>
              hubspot.crm.properties.coreApi.update('contacts', prop.name, {
                options: allOptions,
              } as any)
            );
            logger.info(`[HubSpot] Added options to ${prop.name}: ${missingOptions.map((o: { label: string }) => o.label).join(', ')}`);
          }
        }
      } catch (getError: unknown) {
        if (getErrorCode(getError) === '404' || getErrorMessage(getError)?.includes('not exist')) {
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.properties.coreApi.create('contacts', prop as Parameters<typeof hubspot.crm.properties.coreApi.create>[1])
            );
            created.push(prop.name);
            logger.info(`[HubSpot] Created property ${prop.name}`);
          } catch (createError: unknown) {
            errors.push(`${prop.name}: ${getErrorMessage(createError)}`);
            logger.error(`[HubSpot] Failed to create property ${prop.name}:`, { extra: { detail: getErrorMessage(createError) } });
          }
        } else {
          errors.push(`${prop.name}: ${getErrorMessage(getError)}`);
        }
      }
    }
    
    return { success: errors.length === 0, created, existing, errors };
  } catch (error: unknown) {
    logger.error('[HubSpot] Error ensuring properties exist:', { error: error });
    return { success: false, created, existing, errors: [getErrorMessage(error)] };
  }
}

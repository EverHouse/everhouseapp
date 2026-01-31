import { db } from '../../db';
import { isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { hubspotDeals, billingAuditLog } from '../../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { validateMembershipPipeline, isValidStage } from './pipeline';
import { isPlaceholderEmail } from '../stripe/customers';
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
    
    if (!isProduction) console.log(`[HubSpotDeals] Updated contact ${hubspotContactId} membership_status to ${newStatus}`);
    return true;
  } catch (error) {
    console.error('[HubSpotDeals] Error updating contact membership_status:', error);
    return false;
  }
}

export interface SyncMemberToHubSpotInput {
  email: string;
  status?: string;
  billingProvider?: string;
  tier?: string;
  memberSince?: Date | string; // Date when membership started (synced on new subscriptions)
  createIfMissing?: boolean; // If true (default), creates HubSpot contact if not found
}

export interface SyncMemberToHubSpotResult {
  success: boolean;
  contactId?: string;
  updated: {
    status?: boolean;
    billingProvider?: boolean;
    tier?: boolean;
    memberSince?: boolean;
  };
  error?: string;
}

export async function syncMemberToHubSpot(
  input: SyncMemberToHubSpotInput
): Promise<SyncMemberToHubSpotResult> {
  const { email, status, billingProvider, tier, memberSince, createIfMissing = true } = input;
  
  if (isPlaceholderEmail(email)) {
    console.log(`[HubSpot Sync] Skipping sync for placeholder email: ${email}`);
    return { success: false, error: 'Placeholder email skipped', updated: {} };
  }
  
  try {
    const hubspot = await getHubSpotClient();
    
    const searchResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ',
            value: email.toLowerCase()
          }]
        }],
        properties: ['email', 'membership_status', 'billing_provider', 'membership_tier'],
        limit: 1
      })
    );
    
    let contactId: string;
    
    if (!searchResponse.results || searchResponse.results.length === 0) {
      if (!createIfMissing) {
        console.log(`[HubSpot Sync] Contact not found for ${email}, skipping sync`);
        return { success: false, error: 'Contact not found', updated: {} };
      }
      
      // Create the contact if it doesn't exist
      console.log(`[HubSpot Sync] Contact not found for ${email}, creating...`);
      const { findOrCreateHubSpotContact } = await import('./members');
      const result = await findOrCreateHubSpotContact(email);
      if (!result.success || !result.contactId) {
        console.error(`[HubSpot Sync] Failed to create contact for ${email}`);
        return { success: false, error: 'Failed to create contact', updated: {} };
      }
      contactId = result.contactId;
      console.log(`[HubSpot Sync] Created contact ${contactId} for ${email}`);
    } else {
      contactId = searchResponse.results[0].id;
    }
    
    const properties: Record<string, string> = {};
    const updated: SyncMemberToHubSpotResult['updated'] = {};
    
    if (status) {
      const normalizedStatus = status.toLowerCase();
      const hubspotStatus = DB_STATUS_TO_HUBSPOT_STATUS[normalizedStatus] || 'Inactive';
      properties.membership_status = hubspotStatus;
      updated.status = true;
    }
    
    if (billingProvider) {
      const normalizedProvider = billingProvider.toLowerCase();
      const hubspotProvider = DB_BILLING_PROVIDER_TO_HUBSPOT[normalizedProvider] || 'Manual';
      properties.billing_provider = hubspotProvider;
      updated.billingProvider = true;
    }
    
    if (tier) {
      const normalizedTier = tier.toLowerCase();
      const hubspotTier = DB_TIER_TO_HUBSPOT[normalizedTier] || tier;
      properties.membership_tier = hubspotTier;
      updated.tier = true;
    }
    
    if (memberSince) {
      // HubSpot date properties expect midnight UTC timestamp in milliseconds
      const date = memberSince instanceof Date ? memberSince : new Date(memberSince);
      const midnightUtc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      properties.membership_start_date = midnightUtc.getTime().toString();
      updated.memberSince = true;
    }
    
    if (Object.keys(properties).length === 0) {
      console.log(`[HubSpot Sync] No properties to update for ${email}`);
      return { success: true, contactId, updated };
    }
    
    // Try to update all properties first
    try {
      await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.update(contactId, { properties })
      );
      console.log(`[HubSpot Sync] Updated ${email}: ${JSON.stringify(properties)}`);
      return { success: true, contactId, updated };
    } catch (updateError: any) {
      // If some properties don't exist, retry with only the valid ones
      if (updateError.body?.errors?.some((e: any) => e.code === 'PROPERTY_DOESNT_EXIST')) {
        const invalidProps = updateError.body.errors
          .filter((e: any) => e.code === 'PROPERTY_DOESNT_EXIST')
          .map((e: any) => e.context?.propertyName?.[0]);
        
        const validProperties: Record<string, string> = {};
        for (const [key, value] of Object.entries(properties)) {
          if (!invalidProps.includes(key)) {
            validProperties[key] = value;
          }
        }
        
        if (Object.keys(validProperties).length > 0) {
          console.log(`[HubSpot Sync] Retrying ${email} without missing properties: ${invalidProps.join(', ')}`);
          await retryableHubSpotRequest(() =>
            hubspot.crm.contacts.basicApi.update(contactId, { properties: validProperties })
          );
          console.log(`[HubSpot Sync] Updated ${email}: ${JSON.stringify(validProperties)}`);
          return { success: true, contactId, updated };
        }
      }
      throw updateError;
    }
  } catch (error) {
    console.error(`[HubSpot Sync] Error syncing ${email}:`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error), updated: {} };
  }
}

export async function syncDealStageFromMindbodyStatus(
  memberEmail: string,
  mindbodyStatus: string,
  performedBy: string = 'system',
  performedByName?: string
): Promise<{ success: boolean; dealId?: string; newStage?: string; contactUpdated?: boolean; error?: string }> {
  const { createDealForLegacyMember } = await import('./members');
  
  try {
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
    
    if (!isValidStage(targetStage)) {
      console.warn(`[HubSpotDeals] Target stage ${targetStage} not found in pipeline, check HubSpot configuration`);
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
      if (!isProduction) console.log(`[HubSpotDeals] No deal found for member: ${memberEmail}, creating deal for legacy member`);
      
      const legacyDealResult = await createDealForLegacyMember(
        memberEmail,
        mindbodyStatus,
        performedBy,
        performedByName
      );
      
      if (!legacyDealResult.success) {
        if (!isProduction) console.log(`[HubSpotDeals] Skipped deal creation for ${memberEmail}: ${legacyDealResult.error}`);
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
    
    const targetContactStatus: ContactMembershipStatus = MINDBODY_TO_CONTACT_STATUS_MAP[normalizedStatus] || 'inactive';
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

export async function ensureHubSpotPropertiesExist(): Promise<{ success: boolean; created: string[]; existing: string[]; errors: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  const errors: string[] = [];
  
  try {
    const hubspot = await getHubSpotClient();
    
    const propertiesToCreate = [
      {
        name: 'billing_provider',
        label: 'Billing Provider',
        type: 'enumeration',
        fieldType: 'select',
        groupName: 'contactinformation',
        description: 'The billing system managing this member\'s subscription (Stripe, MindBody, or Manual)',
        options: [
          { label: 'Stripe', value: 'Stripe', displayOrder: 1 },
          { label: 'MindBody', value: 'MindBody', displayOrder: 2 },
          { label: 'Manual', value: 'Manual', displayOrder: 3 },
        ]
      },
      {
        name: 'member_since_date',
        label: 'Member Since Date',
        type: 'date',
        fieldType: 'date',
        groupName: 'contactinformation',
        description: 'The date this person became a member'
      }
    ];
    
    for (const prop of propertiesToCreate) {
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.properties.coreApi.getByName('contacts', prop.name)
        );
        existing.push(prop.name);
        console.log(`[HubSpot] Property ${prop.name} already exists`);
      } catch (getError: any) {
        if (getError.code === 404 || getError.message?.includes('not exist')) {
          try {
            await retryableHubSpotRequest(() =>
              hubspot.crm.properties.coreApi.create('contacts', prop as any)
            );
            created.push(prop.name);
            console.log(`[HubSpot] Created property ${prop.name}`);
          } catch (createError: any) {
            errors.push(`${prop.name}: ${createError.message}`);
            console.error(`[HubSpot] Failed to create property ${prop.name}:`, createError.message);
          }
        } else {
          errors.push(`${prop.name}: ${getError.message}`);
        }
      }
    }
    
    return { success: errors.length === 0, created, existing, errors };
  } catch (error: any) {
    console.error('[HubSpot] Error ensuring properties exist:', error);
    return { success: false, created, existing, errors: [error.message] };
  }
}

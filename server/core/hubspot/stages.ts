import { db } from '../../db';
import { isProduction } from '../db';
import { getHubSpotClient } from '../integrations';
import { hubspotDeals, billingAuditLog } from '../../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { retryableHubSpotRequest } from './request';
import { validateMembershipPipeline, isValidStage } from './pipeline';
import { 
  HUBSPOT_STAGE_IDS, 
  MINDBODY_TO_STAGE_MAP, 
  MINDBODY_TO_CONTACT_STATUS_MAP,
  ACTIVE_STATUSES,
  CHURNED_STATUSES,
  ContactMembershipStatus
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

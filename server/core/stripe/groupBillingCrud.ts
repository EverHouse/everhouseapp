import { db } from '../../db';
import { billingGroups, groupMembers, familyAddOnProducts } from '../../../shared/models/hubspot-billing';
import { eq, and, sql } from 'drizzle-orm';
import { getStripeClient } from './client';
import { createHash } from 'crypto';
import { getCorporateVolumeTiers, getCorporateBasePrice, getFamilyDiscountPercent, updateFamilyDiscountPercent } from '../billing/pricingConfig';
import { getErrorMessage, getErrorCode, isStripeResourceMissing } from '../../utils/errorUtils';

import { toTextArrayLiteral } from '../../utils/sqlArrayLiteral';
import { logger } from '../logger';

export interface StripeCustomerIdRow { stripe_customer_id: string | null }
export interface UserBillingRow { id: string; billing_group_id: number | null; stripe_subscription_id: string | null; membership_status: string | null }
export interface InsertIdRow { id: number }
export interface ExclusionCheckRow { [key: string]: unknown }
export interface GroupBillingRow { id: number; primary_stripe_subscription_id: string | null; max_seats: number | null; [key: string]: unknown }
export interface MemberRecordRow { id: number; member_email: string; is_active: boolean; stripe_subscription_item_id: string | null; billing_group_id: number }
export interface RemainingCountRow { cnt: string }
export interface EarlyReturnError { __earlyReturn: boolean; result: { success: false; error: string } }

export interface BillingGroupWithMembers {
  id: number;
  primaryEmail: string;
  primaryName: string;
  groupName: string | null;
  stripeSubscriptionId: string | null;
  members: GroupMemberInfo[];
  totalMonthlyAmount: number;
  isActive: boolean;
  type: 'family' | 'corporate';
  maxSeats: number | null;
  companyName: string | null;
}

export interface GroupMemberInfo {
  id: number;
  memberEmail: string;
  memberName: string;
  memberTier: string;
  relationship: string | null;
  addOnPriceCents: number;
  isActive: boolean;
  addedAt: Date | null;
}

export type FamilyGroupWithMembers = BillingGroupWithMembers;
export type FamilyMemberInfo = GroupMemberInfo;

export function getCorporateVolumePrice(memberCount: number): number {
  const tiers = getCorporateVolumeTiers().sort((a, b) => b.minMembers - a.minMembers);
  for (const tier of tiers) {
    if (memberCount >= tier.minMembers) return tier.priceCents;
  }
  return getCorporateBasePrice();
}

const FAMILY_COUPON_ID = 'FAMILY20';

export async function getOrCreateFamilyCoupon(): Promise<string> {
  try {
    const stripe = await getStripeClient();
    
    try {
      const existingCoupon = await stripe.coupons.retrieve(FAMILY_COUPON_ID);
      if (existingCoupon.percent_off) {
        updateFamilyDiscountPercent(existingCoupon.percent_off);
      }
      logger.info(`[GroupBilling] Found existing FAMILY20 coupon: ${existingCoupon.id}`);
      return existingCoupon.id;
    } catch (retrieveError: unknown) {
      if (isStripeResourceMissing(retrieveError)) {
        const newCoupon = await stripe.coupons.create({
          id: FAMILY_COUPON_ID,
          percent_off: getFamilyDiscountPercent(),
          duration: 'forever',
          name: `Family Member Discount (${getFamilyDiscountPercent()}% off)`,
          metadata: {
            source: 'group_billing',
            type: 'family_addon',
          },
        }, { idempotencyKey: `coupon_family_${FAMILY_COUPON_ID}_${getFamilyDiscountPercent()}` });
        logger.info(`[GroupBilling] Created FAMILY20 coupon: ${newCoupon.id}`);
        return newCoupon.id;
      }
      throw retrieveError;
    }
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error getting/creating FAMILY20 coupon:', { error: err });
    throw err;
  }
}

export async function syncGroupAddOnProductsToStripe(): Promise<{
  success: boolean;
  synced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let synced = 0;

  try {
    const stripe = await getStripeClient();
    
    const addOnProducts = await db.select().from(familyAddOnProducts).where(eq(familyAddOnProducts.isActive, true));
    
    for (const product of addOnProducts) {
      try {
        let stripeProductId = product.stripeProductId;
        let stripePriceId = product.stripePriceId;
        
        if (!stripeProductId) {
          const nameHash = createHash('md5').update(product.displayName || product.tierName).digest('hex').slice(0, 8);
          const stripeProduct = await stripe.products.create({
            name: product.displayName || `Group Add-on - ${product.tierName}`,
            description: product.description || `Group add-on membership for ${product.tierName} tier`,
            metadata: {
              group_addon: 'true',
              tier_name: product.tierName,
            },
          }, { idempotencyKey: `product_groupaddon_${nameHash}_${product.tierName}` });
          stripeProductId = stripeProduct.id;
        }
        
        if (stripePriceId) {
          try {
            const existingPrice = await stripe.prices.retrieve(stripePriceId);
            if (!existingPrice.active) {
              logger.warn(`[Group Billing] Price ${stripePriceId} for ${product.tierName} is inactive, will recreate`);
              stripePriceId = null;
            }
          } catch (priceErr: unknown) {
            const errMsg = getErrorMessage(priceErr);
            if (errMsg.includes('No such price') || errMsg.includes('resource_missing')) {
              logger.warn(`[Group Billing] Price ${stripePriceId} for ${product.tierName} not found, will recreate`);
              stripePriceId = null;
            }
          }
        }

        if (!stripePriceId) {
          const interval = (product.billingInterval || 'month') as 'month' | 'year';
          const stripePrice = await stripe.prices.create({
            product: stripeProductId,
            unit_amount: product.priceCents,
            currency: 'usd',
            recurring: {
              interval,
            },
            metadata: {
              group_addon: 'true',
              tier_name: product.tierName,
            },
          }, { idempotencyKey: `price_${stripeProductId}_${product.priceCents}_${interval}_${Date.now()}` });
          stripePriceId = stripePrice.id;
        }
        
        await db.update(familyAddOnProducts)
          .set({
            stripeProductId,
            stripePriceId,
            updatedAt: new Date(),
          })
          .where(eq(familyAddOnProducts.id, product.id));
        
        synced++;
      } catch (err: unknown) {
        errors.push(`Failed to sync ${product.tierName}: ${getErrorMessage(err)}`);
      }
    }
    
    return { success: errors.length === 0, synced, errors };
  } catch (err: unknown) {
    return { success: false, synced, errors: [getErrorMessage(err)] };
  }
}

export const syncFamilyAddOnProductsToStripe = syncGroupAddOnProductsToStripe;

export async function getGroupAddOnProducts(): Promise<typeof familyAddOnProducts.$inferSelect[]> {
  return db.select().from(familyAddOnProducts).where(eq(familyAddOnProducts.isActive, true));
}

export const getFamilyAddOnProducts = getGroupAddOnProducts;

export async function getBillingGroupByPrimaryEmail(primaryEmail: string): Promise<BillingGroupWithMembers | null> {
  const group = await db.select()
    .from(billingGroups)
    .where(eq(billingGroups.primaryEmail, primaryEmail.toLowerCase()))
    .limit(1);
  
  if (group.length === 0) return null;
  
  const billingGroup = group[0];
  
  const members = await db.select()
    .from(groupMembers)
    .where(and(
      eq(groupMembers.billingGroupId, billingGroup.id),
      eq(groupMembers.isActive, true)
    ));
  
  const primaryUserResult = await db.execute(
    sql`SELECT first_name, last_name FROM users WHERE LOWER(email) = ${primaryEmail.toLowerCase()}`
  );
  const primaryName = primaryUserResult.rows[0] 
    ? `${primaryUserResult.rows[0].first_name || ''} ${primaryUserResult.rows[0].last_name || ''}`.trim()
    : primaryEmail;
  
  const memberEmails = members.map(m => m.memberEmail.toLowerCase());
  const allMemberUsers = memberEmails.length > 0
    ? await db.execute(
        sql`SELECT email, first_name, last_name FROM users WHERE LOWER(email) = ANY(${toTextArrayLiteral(memberEmails)}::text[])`
      )
    : { rows: [] };
  interface GroupUserRow { email: string; first_name: string | null; last_name: string | null }
  const typedRows = allMemberUsers.rows as unknown as GroupUserRow[];
  const memberUserMap = new Map(
    typedRows.map((r) => [r.email.toLowerCase(), r])
  );

  const memberInfos: GroupMemberInfo[] = [];
  for (const member of members) {
    const userRow = memberUserMap.get(member.memberEmail.toLowerCase());
    const memberName = userRow
      ? `${userRow.first_name || ''} ${userRow.last_name || ''}`.trim()
      : member.memberEmail;
    
    memberInfos.push({
      id: member.id,
      memberEmail: member.memberEmail,
      memberName,
      memberTier: member.memberTier,
      relationship: member.relationship,
      addOnPriceCents: member.addOnPriceCents || 0,
      isActive: member.isActive ?? true,
      addedAt: member.addedAt,
    });
  }
  
  const totalMonthlyAmount = memberInfos.reduce((sum, m) => sum + m.addOnPriceCents, 0);
  
  return {
    id: billingGroup.id,
    primaryEmail: billingGroup.primaryEmail,
    primaryName,
    groupName: billingGroup.groupName,
    stripeSubscriptionId: billingGroup.primaryStripeSubscriptionId,
    members: memberInfos,
    totalMonthlyAmount,
    isActive: billingGroup.isActive ?? true,
    type: (billingGroup.type as 'family' | 'corporate') || 'family',
    maxSeats: billingGroup.maxSeats ?? null,
    companyName: billingGroup.companyName ?? null,
  };
}

export const getFamilyGroupByPrimaryEmail = getBillingGroupByPrimaryEmail;

export async function getBillingGroupByMemberEmail(memberEmail: string): Promise<BillingGroupWithMembers | null> {
  const member = await db.select()
    .from(groupMembers)
    .where(and(
      eq(groupMembers.memberEmail, memberEmail.toLowerCase()),
      eq(groupMembers.isActive, true)
    ))
    .limit(1);
  
  if (member.length === 0) {
    const asGroup = await getBillingGroupByPrimaryEmail(memberEmail);
    return asGroup;
  }
  
  const group = await db.select()
    .from(billingGroups)
    .where(eq(billingGroups.id, member[0].billingGroupId))
    .limit(1);
  
  if (group.length === 0) return null;
  
  return getBillingGroupByPrimaryEmail(group[0].primaryEmail);
}

export const getFamilyGroupByMemberEmail = getBillingGroupByMemberEmail;

export async function createBillingGroup(params: {
  primaryEmail: string;
  groupName?: string;
  createdBy: string;
  createdByName: string;
}): Promise<{ success: boolean; groupId?: number; error?: string }> {
  try {
    const existingGroup = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.primaryEmail, params.primaryEmail.toLowerCase()))
      .limit(1);
    
    if (existingGroup.length > 0) {
      return { success: false, error: 'A billing group already exists for this member' };
    }
    
    const primaryUserResult = await db.execute(
      sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = ${params.primaryEmail.toLowerCase()}`
    );
    
    const stripeCustomerId = (primaryUserResult.rows[0] as unknown as StripeCustomerIdRow | undefined)?.stripe_customer_id || null;
    
    const groupId = await db.transaction(async (tx) => {
      const result = await tx.insert(billingGroups).values({
        primaryEmail: params.primaryEmail.toLowerCase(),
        primaryStripeCustomerId: stripeCustomerId,
        groupName: params.groupName || null,
        createdBy: params.createdBy,
        createdByName: params.createdByName,
      }).returning({ id: billingGroups.id });
      
      await tx.execute(
        sql`UPDATE users SET billing_group_id = ${result[0].id} WHERE LOWER(email) = ${params.primaryEmail.toLowerCase()}`
      );
      
      return result[0].id;
    });
    
    return { success: true, groupId };
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error creating billing group:', { error: err });
    return { success: false, error: 'Operation failed. Please try again.' };
  }
}

export const createFamilyGroup = createBillingGroup;

export async function createCorporateBillingGroupFromSubscription(params: {
  primaryEmail: string;
  companyName: string;
  quantity: number;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
}): Promise<{ success: boolean; groupId?: number; error?: string }> {
  try {
    const existingGroup = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.primaryEmail, params.primaryEmail.toLowerCase()))
      .limit(1);
    
    if (existingGroup.length > 0) {
      logger.info(`[GroupBilling] Corporate billing group already exists for ${params.primaryEmail}, updating subscription ID and seats`);
      await db.update(billingGroups)
        .set({
          primaryStripeSubscriptionId: params.stripeSubscriptionId,
          primaryStripeCustomerId: params.stripeCustomerId,
          companyName: params.companyName,
          groupName: params.companyName,
          type: 'corporate',
          maxSeats: params.quantity,
          updatedAt: new Date(),
        })
        .where(eq(billingGroups.id, existingGroup[0].id));
      return { success: true, groupId: existingGroup[0].id };
    }
    
    const groupId = await db.transaction(async (tx) => {
      const result = await tx.insert(billingGroups).values({
        primaryEmail: params.primaryEmail.toLowerCase(),
        primaryStripeCustomerId: params.stripeCustomerId,
        primaryStripeSubscriptionId: params.stripeSubscriptionId,
        groupName: params.companyName,
        companyName: params.companyName,
        type: 'corporate',
        maxSeats: params.quantity,
        isActive: true,
        createdBy: 'system',
        createdByName: 'Stripe Checkout',
      }).returning({ id: billingGroups.id });
      
      await tx.execute(
        sql`UPDATE users SET billing_group_id = ${result[0].id} WHERE LOWER(email) = ${params.primaryEmail.toLowerCase()}`
      );
      
      return result[0].id;
    });
    
    logger.info(`[GroupBilling] Auto-created corporate billing group: ${params.companyName} (ID: ${groupId}) for ${params.primaryEmail} with ${params.quantity} seats`);
    
    return { success: true, groupId };
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error auto-creating corporate billing group:', { error: err });
    return { success: false, error: getErrorMessage(err) };
  }
}

export async function updateBillingGroupName(
  groupId: number,
  groupName: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    const existingGroup = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.id, groupId))
      .limit(1);
    
    if (existingGroup.length === 0) {
      return { success: false, error: 'Billing group not found' };
    }
    
    await db.update(billingGroups)
      .set({
        groupName: groupName,
        updatedAt: new Date(),
      })
      .where(eq(billingGroups.id, groupId));
    
    return { success: true };
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error updating billing group name:', { error: err });
    return { success: false, error: 'Operation failed. Please try again.' };
  }
}

export async function deleteBillingGroup(
  groupId: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const existingGroup = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.id, groupId))
      .limit(1);
    
    if (existingGroup.length === 0) {
      return { success: false, error: 'Billing group not found' };
    }
    
    const group = existingGroup[0];
    
    if (group.primaryStripeSubscriptionId && group.isActive !== false) {
      return { 
        success: false, 
        error: 'Cannot delete billing group with an active Stripe subscription. Please cancel the subscription first.' 
      };
    }
    
    await db.update(groupMembers)
      .set({ isActive: false, removedAt: new Date() })
      .where(eq(groupMembers.billingGroupId, groupId));
    
    await db.execute(
      sql`UPDATE users SET billing_group_id = NULL WHERE billing_group_id = ${groupId}`
    );
    
    await db.delete(billingGroups)
      .where(eq(billingGroups.id, groupId));
    
    return { success: true };
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error deleting billing group:', { error: err });
    return { success: false, error: 'Operation failed. Please try again.' };
  }
}

export async function linkStripeSubscriptionToBillingGroup(params: {
  billingGroupId: number;
  stripeSubscriptionId: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    await db.update(billingGroups)
      .set({
        primaryStripeSubscriptionId: params.stripeSubscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(billingGroups.id, params.billingGroupId));
    
    return { success: true };
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error linking subscription:', { error: err });
    return { success: false, error: 'Operation failed. Please try again.' };
  }
}

export async function linkStripeSubscriptionToFamilyGroup(params: {
  familyGroupId: number;
  stripeSubscriptionId: string;
}): Promise<{ success: boolean; error?: string }> {
  return linkStripeSubscriptionToBillingGroup({
    billingGroupId: params.familyGroupId,
    stripeSubscriptionId: params.stripeSubscriptionId,
  });
}

export async function updateGroupAddOnPricing(params: {
  tierName: string;
  priceCents: number;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const existing = await db.select()
      .from(familyAddOnProducts)
      .where(eq(familyAddOnProducts.tierName, params.tierName))
      .limit(1);
    
    if (existing.length === 0) {
      await db.insert(familyAddOnProducts).values({
        tierName: params.tierName,
        priceCents: params.priceCents,
        displayName: `Group Add-on - ${params.tierName}`,
      });
    } else {
      const product = existing[0];
      
      if (product.stripeProductId) {
        try {
          const stripe = await getStripeClient();
          const newPrice = await stripe.prices.create({
            product: product.stripeProductId,
            unit_amount: params.priceCents,
            currency: 'usd',
            recurring: { interval: 'month' },
            metadata: {
              group_addon: 'true',
              tier_name: params.tierName,
            },
          }, { idempotencyKey: `price_${product.stripeProductId}_${params.priceCents}_month` });
          
          await db.update(familyAddOnProducts)
            .set({
              priceCents: params.priceCents,
              stripePriceId: newPrice.id,
              updatedAt: new Date(),
            })
            .where(eq(familyAddOnProducts.id, product.id));
        } catch (stripeErr: unknown) {
          logger.error('[GroupBilling] Error creating new Stripe price:', { error: stripeErr });
          return { success: false, error: getErrorMessage(stripeErr) };
        }
      } else {
        await db.update(familyAddOnProducts)
          .set({
            priceCents: params.priceCents,
            updatedAt: new Date(),
          })
          .where(eq(familyAddOnProducts.id, product.id));
      }
    }
    
    return { success: true };
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error updating pricing:', { error: err });
    return { success: false, error: 'Operation failed. Please try again.' };
  }
}

export const updateFamilyAddOnPricing = updateGroupAddOnPricing;

export async function getAllBillingGroups(): Promise<BillingGroupWithMembers[]> {
  const groups = await db.select()
    .from(billingGroups)
    .where(eq(billingGroups.isActive, true));
  
  const result: BillingGroupWithMembers[] = [];
  
  for (const group of groups) {
    const fullGroup = await getBillingGroupByPrimaryEmail(group.primaryEmail);
    if (fullGroup) {
      result.push(fullGroup);
    }
  }
  
  return result;
}

export const getAllFamilyGroups = getAllBillingGroups;

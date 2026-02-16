import { pool } from '../db';
import { db } from '../../db';
import { billingGroups, groupMembers, familyAddOnProducts } from '../../../shared/models/hubspot-billing';
import { eq, and } from 'drizzle-orm';
import { getStripeClient } from './client';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { getCorporateVolumeTiers, getCorporateBasePrice, getFamilyDiscountPercent, updateFamilyDiscountPercent } from '../billing/pricingConfig';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { normalizeTierName } from '../../utils/tierUtils';

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
  const tiers = getCorporateVolumeTiers();
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
      console.log(`[GroupBilling] Found existing FAMILY20 coupon: ${existingCoupon.id}`);
      return existingCoupon.id;
    } catch (retrieveError: unknown) {
      if (getErrorCode(retrieveError) === 'resource_missing') {
        const newCoupon = await stripe.coupons.create({
          id: FAMILY_COUPON_ID,
          percent_off: getFamilyDiscountPercent(),
          duration: 'forever',
          name: `Family Member Discount (${getFamilyDiscountPercent()}% off)`,
          metadata: {
            source: 'group_billing',
            type: 'family_addon',
          },
        });
        console.log(`[GroupBilling] Created FAMILY20 coupon: ${newCoupon.id}`);
        return newCoupon.id;
      }
      throw retrieveError;
    }
  } catch (err: unknown) {
    console.error('[GroupBilling] Error getting/creating FAMILY20 coupon:', err);
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
          const stripeProduct = await stripe.products.create({
            name: product.displayName || `Group Add-on - ${product.tierName}`,
            description: product.description || `Group add-on membership for ${product.tierName} tier`,
            metadata: {
              group_addon: 'true',
              tier_name: product.tierName,
            },
          });
          stripeProductId = stripeProduct.id;
        }
        
        if (!stripePriceId) {
          const stripePrice = await stripe.prices.create({
            product: stripeProductId,
            unit_amount: product.priceCents,
            currency: 'usd',
            recurring: {
              interval: (product.billingInterval || 'month') as 'month' | 'year',
            },
            metadata: {
              group_addon: 'true',
              tier_name: product.tierName,
            },
          });
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
  
  const primaryUserResult = await pool.query(
    'SELECT first_name, last_name FROM users WHERE LOWER(email) = $1',
    [primaryEmail.toLowerCase()]
  );
  const primaryName = primaryUserResult.rows[0] 
    ? `${primaryUserResult.rows[0].first_name || ''} ${primaryUserResult.rows[0].last_name || ''}`.trim()
    : primaryEmail;
  
  const memberInfos: GroupMemberInfo[] = [];
  for (const member of members) {
    const memberUserResult = await pool.query(
      'SELECT first_name, last_name FROM users WHERE LOWER(email) = $1',
      [member.memberEmail.toLowerCase()]
    );
    const memberName = memberUserResult.rows[0]
      ? `${memberUserResult.rows[0].first_name || ''} ${memberUserResult.rows[0].last_name || ''}`.trim()
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
    
    const primaryUserResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE LOWER(email) = $1',
      [params.primaryEmail.toLowerCase()]
    );
    
    const stripeCustomerId = primaryUserResult.rows[0]?.stripe_customer_id || null;
    
    const result = await db.insert(billingGroups).values({
      primaryEmail: params.primaryEmail.toLowerCase(),
      primaryStripeCustomerId: stripeCustomerId,
      groupName: params.groupName || null,
      createdBy: params.createdBy,
      createdByName: params.createdByName,
    }).returning({ id: billingGroups.id });
    
    await pool.query(
      'UPDATE users SET billing_group_id = $1 WHERE LOWER(email) = $2',
      [result[0].id, params.primaryEmail.toLowerCase()]
    );
    
    return { success: true, groupId: result[0].id };
  } catch (err: unknown) {
    console.error('[GroupBilling] Error creating billing group:', err);
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
      console.log(`[GroupBilling] Corporate billing group already exists for ${params.primaryEmail}, updating subscription ID and seats`);
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
    
    const result = await db.insert(billingGroups).values({
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
    
    await pool.query(
      'UPDATE users SET billing_group_id = $1 WHERE LOWER(email) = $2',
      [result[0].id, params.primaryEmail.toLowerCase()]
    );
    
    console.log(`[GroupBilling] Auto-created corporate billing group: ${params.companyName} (ID: ${result[0].id}) for ${params.primaryEmail} with ${params.quantity} seats`);
    
    return { success: true, groupId: result[0].id };
  } catch (err: unknown) {
    console.error('[GroupBilling] Error auto-creating corporate billing group:', err);
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
    console.error('[GroupBilling] Error updating billing group name:', err);
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
    
    if (group.primaryStripeSubscriptionId) {
      return { 
        success: false, 
        error: 'Cannot delete billing group with an active Stripe subscription. Please cancel the subscription first.' 
      };
    }
    
    await db.update(groupMembers)
      .set({ isActive: false, removedAt: new Date() })
      .where(eq(groupMembers.billingGroupId, groupId));
    
    await pool.query(
      'UPDATE users SET billing_group_id = NULL WHERE billing_group_id = $1',
      [groupId]
    );
    
    await db.delete(billingGroups)
      .where(eq(billingGroups.id, groupId));
    
    return { success: true };
  } catch (err: unknown) {
    console.error('[GroupBilling] Error deleting billing group:', err);
    return { success: false, error: 'Operation failed. Please try again.' };
  }
}

export async function addGroupMember(params: {
  billingGroupId: number;
  memberEmail: string;
  memberTier: string;
  relationship?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  dob?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  addedBy: string;
  addedByName: string;
}): Promise<{ success: boolean; memberId?: number; error?: string }> {
  const normalizedTier = normalizeTierName(params.memberTier);
  const client = await pool.connect();
  
  try {
    const existingMember = await db.select()
      .from(groupMembers)
      .where(and(
        eq(groupMembers.memberEmail, params.memberEmail.toLowerCase()),
        eq(groupMembers.isActive, true)
      ))
      .limit(1);
    
    if (existingMember.length > 0) {
      return { success: false, error: 'This member is already part of a billing group' };
    }
    
    // Check if user exists via linked email resolution
    const { resolveUserByEmail: resolveFamilyEmail } = await import('./customers');
    const resolvedFamily = await resolveFamilyEmail(params.memberEmail);
    
    // Check if user exists and their billing status
    const userResult = resolvedFamily
      ? await pool.query(
          'SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE id = $1',
          [resolvedFamily.userId]
        )
      : await pool.query(
          'SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE LOWER(email) = $1',
          [params.memberEmail.toLowerCase()]
        );
    
    if (resolvedFamily && resolvedFamily.matchType !== 'direct') {
      console.log(`[GroupBilling] Email ${params.memberEmail} resolved to existing user ${resolvedFamily.primaryEmail} via ${resolvedFamily.matchType}`);
    }
    
    let userExists = userResult.rows.length > 0;
    
    if (userExists) {
      const user = userResult.rows[0];
      
      // If user is already in a different billing group, prevent the operation
      if (user.billing_group_id !== null && user.billing_group_id !== params.billingGroupId) {
        return { 
          success: false, 
          error: 'User is already in a billing group. Remove them first.' 
        };
      }
      
      // Guard against dual subscriptions - if user has their own active subscription (any provider), prevent adding to group
      const hasActiveSubscription = user.stripe_subscription_id && 
        (user.membership_status === 'active' || user.membership_status === 'past_due');
      if (hasActiveSubscription) {
        return {
          success: false,
          error: 'User already has their own active subscription. Cancel it before adding them to a family plan.'
        };
      }
    }
    
    const addOnProduct = await db.select()
      .from(familyAddOnProducts)
      .where(eq(familyAddOnProducts.tierName, normalizedTier))
      .limit(1);
    
    if (addOnProduct.length === 0) {
      return { success: false, error: `No add-on product found for tier: ${normalizedTier}` };
    }
    
    const product = addOnProduct[0];
    
    const group = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.id, params.billingGroupId))
      .limit(1);
    
    if (group.length === 0) {
      return { success: false, error: 'Billing group not found' };
    }
    
    if (group[0].primaryStripeSubscriptionId && !product.stripePriceId) {
      return { success: false, error: 'Add-on product not synced to Stripe. Please sync products first.' };
    }
    
    let insertedMemberId: number | null = null;
    let stripeSubscriptionItemId: string | null = null;
    
    try {
      await client.query('BEGIN');
      
      const insertResult = await client.query(
        `INSERT INTO group_members (
          billing_group_id, member_email, member_tier, relationship,
          stripe_subscription_item_id, stripe_price_id, add_on_price_cents,
          added_by, added_by_name, is_active, added_at
        ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, true, NOW())
        RETURNING id`,
        [
          params.billingGroupId,
          params.memberEmail.toLowerCase(),
          normalizedTier,
          params.relationship || null,
          product.stripePriceId,
          product.priceCents,
          params.addedBy,
          params.addedByName,
        ]
      );
      
      insertedMemberId = insertResult.rows[0].id;

      // Create or update user account (matching addCorporateMember pattern)
      if (userExists) {
        const updateFields: string[] = ['billing_group_id = $1', 'tier = $2', "billing_provider = 'stripe'", "membership_status = 'active'", 'updated_at = NOW()'];
        const updateValues: any[] = [params.billingGroupId, normalizedTier];
        let paramIndex = 3;
        
        if (params.firstName) {
          updateFields.push(`first_name = $${paramIndex++}`);
          updateValues.push(params.firstName);
        }
        if (params.lastName) {
          updateFields.push(`last_name = $${paramIndex++}`);
          updateValues.push(params.lastName);
        }
        if (params.phone) {
          updateFields.push(`phone = $${paramIndex++}`);
          updateValues.push(params.phone);
        }
        if (params.dob) {
          updateFields.push(`date_of_birth = $${paramIndex++}`);
          updateValues.push(params.dob);
        }
        if (params.streetAddress) {
          updateFields.push(`street_address = $${paramIndex++}`);
          updateValues.push(params.streetAddress);
        }
        if (params.city) {
          updateFields.push(`city = $${paramIndex++}`);
          updateValues.push(params.city);
        }
        if (params.state) {
          updateFields.push(`state = $${paramIndex++}`);
          updateValues.push(params.state);
        }
        if (params.zipCode) {
          updateFields.push(`zip_code = $${paramIndex++}`);
          updateValues.push(params.zipCode);
        }
        
        if (resolvedFamily) {
          updateValues.push(resolvedFamily.userId);
          await client.query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
            updateValues
          );
          console.log(`[GroupBilling] Updated existing user ${resolvedFamily.primaryEmail} (matched ${params.memberEmail} via ${resolvedFamily.matchType}) with family group`);
        } else {
          updateValues.push(params.memberEmail.toLowerCase());
          await client.query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE LOWER(email) = $${paramIndex}`,
            updateValues
          );
          console.log(`[GroupBilling] Updated existing user ${params.memberEmail} with family group`);
        }
      } else {
        // Auto-create user so they can log in
        const userId = randomUUID();
        await client.query(
          `INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, billing_group_id, street_address, city, state, zip_code, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'stripe', $8, $9, $10, $11, $12, NOW())`,
          [
            userId,
            params.memberEmail.toLowerCase(),
            params.firstName || null,
            params.lastName || null,
            params.phone || null,
            params.dob || null,
            normalizedTier,
            params.billingGroupId,
            params.streetAddress || null,
            params.city || null,
            params.state || null,
            params.zipCode || null
          ]
        );
        console.log(`[GroupBilling] Created new user ${params.memberEmail} for family group with tier ${normalizedTier}`);
      }

      if (group[0].primaryStripeSubscriptionId && product.stripePriceId) {
        try {
          const stripe = await getStripeClient();
          
          const isFamilyGroup = params.relationship !== 'employee';
          
          const subscriptionItemParams: Stripe.SubscriptionItemCreateParams = {
            subscription: group[0].primaryStripeSubscriptionId,
            price: product.stripePriceId,
            quantity: 1,
            metadata: {
              group_member_email: params.memberEmail.toLowerCase(),
              billing_group_id: params.billingGroupId.toString(),
              tier: normalizedTier,
            },
          };
          
          if (isFamilyGroup) {
            try {
              const couponId = await getOrCreateFamilyCoupon();
              subscriptionItemParams.discounts = [{ coupon: couponId }];
              console.log(`[GroupBilling] Applying FAMILY20 coupon to family member ${params.memberEmail}`);
            } catch (couponErr: unknown) {
              console.warn(`[GroupBilling] Could not apply FAMILY20 coupon: ${getErrorMessage(couponErr)}. Proceeding without discount.`);
            }
          }
          
          const subscriptionItem = await stripe.subscriptionItems.create(subscriptionItemParams);
          stripeSubscriptionItemId = subscriptionItem.id;
          
          await client.query(
            'UPDATE group_members SET stripe_subscription_item_id = $1 WHERE id = $2',
            [stripeSubscriptionItemId, insertedMemberId]
          );
        } catch (stripeErr: unknown) {
          console.error('[GroupBilling] Stripe API failed, rolling back DB reservation:', stripeErr);
          await client.query('ROLLBACK');
          return { success: false, error: `Failed to add billing: ${getErrorMessage(stripeErr)}` };
        }
      }

      await client.query('COMMIT');
      
      return { success: true, memberId: insertedMemberId };

    } catch (dbErr: unknown) {
      await client.query('ROLLBACK');
      console.error('[GroupBilling] DB transaction failed:', dbErr);
      
      if (stripeSubscriptionItemId) {
        try {
          const stripe = await getStripeClient();
          await stripe.subscriptionItems.del(stripeSubscriptionItemId);
          console.log(`[GroupBilling] Successfully rolled back Stripe item ${stripeSubscriptionItemId}`);
        } catch (rollbackErr: unknown) {
          console.error(`[GroupBilling] CRITICAL: Failed to rollback Stripe item ${stripeSubscriptionItemId}. Manual intervention required.`, rollbackErr);
        }
      }
      
      return { success: false, error: 'System error. Please try again.' };
    }
  } catch (err: unknown) {
    console.error('[GroupBilling] Error adding group member:', err);
    return { success: false, error: 'Operation failed. Please try again.' };
  } finally {
    client.release();
  }
}

export async function addFamilyMember(params: {
  familyGroupId: number;
  memberEmail: string;
  memberTier: string;
  relationship?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  dob?: string;
  addedBy: string;
  addedByName: string;
}): Promise<{ success: boolean; memberId?: number; error?: string }> {
  return addGroupMember({
    billingGroupId: params.familyGroupId,
    memberEmail: params.memberEmail,
    memberTier: params.memberTier,
    relationship: params.relationship,
    firstName: params.firstName,
    lastName: params.lastName,
    phone: params.phone,
    dob: params.dob,
    addedBy: params.addedBy,
    addedByName: params.addedByName,
  });
}

export async function addCorporateMember(params: {
  billingGroupId: number;
  memberEmail: string;
  memberTier: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  dob?: string;
  addedBy: string;
  addedByName: string;
}): Promise<{ success: boolean; memberId?: number; error?: string }> {
  const normalizedTier = normalizeTierName(params.memberTier);
  const client = await pool.connect();
  
  try {
    let originalQuantity: number | null = null;
    let originalPricePerSeat: number | null = null;
    let originalProductId: string | null = null;
    let corporateItemId: string | null = null;
    let insertedMemberId: number | null = null;
    let stripeUpdated = false;
    let priceTierChanged = false;
    let newStripeItemId: string | null = null;
    let primaryStripeSubscriptionId: string | null = null;
    
    try {
      await client.query('BEGIN');

      const existingMemberResult = await client.query(
        `SELECT id FROM group_members WHERE LOWER(member_email) = $1 AND is_active = true LIMIT 1`,
        [params.memberEmail.toLowerCase()]
      );
    
      if (existingMemberResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'This member is already part of a billing group' };
      }
    
      // Check if user exists via linked email resolution
      const { resolveUserByEmail: resolveCorporateEmail } = await import('./customers');
      const resolvedCorporate = await resolveCorporateEmail(params.memberEmail);
      
      const userResult = resolvedCorporate
        ? await client.query(
            'SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE id = $1',
            [resolvedCorporate.userId]
          )
        : await client.query(
            'SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE LOWER(email) = $1',
            [params.memberEmail.toLowerCase()]
          );
    
      if (resolvedCorporate && resolvedCorporate.matchType !== 'direct') {
        console.log(`[GroupBilling] Email ${params.memberEmail} resolved to existing user ${resolvedCorporate.primaryEmail} via ${resolvedCorporate.matchType}`);
      }
    
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
      
        // If user is already in a different billing group, prevent the operation
        if (user.billing_group_id !== null && user.billing_group_id !== params.billingGroupId) {
          await client.query('ROLLBACK');
          return { 
            success: false, 
            error: 'User is already in a billing group. Remove them first.' 
          };
        }
      
        // Guard against dual subscriptions - if user has their own active subscription (any provider), prevent adding to group
        const hasActiveSubscription = user.stripe_subscription_id && 
          (user.membership_status === 'active' || user.membership_status === 'past_due');
        if (hasActiveSubscription) {
          await client.query('ROLLBACK');
          return {
            success: false,
            error: 'User already has their own active subscription. Cancel it before adding them to a corporate plan.'
          };
        }
      }
    
      const groupResult = await client.query(
        `SELECT * FROM billing_groups WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [params.billingGroupId]
      );
    
      if (groupResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Billing group not found' };
      }
    
      const group = [groupResult.rows[0]];
      primaryStripeSubscriptionId = group[0].primary_stripe_subscription_id || null;
    
      const currentMembersResult = await client.query(
        `SELECT id FROM group_members WHERE billing_group_id = $1 AND is_active = true`,
        [params.billingGroupId]
      );
    
      const newMemberCount = currentMembersResult.rows.length + 1;
      const pricePerSeat = getCorporateVolumePrice(newMemberCount);
      
      const insertResult = await client.query(
        `INSERT INTO group_members (
          billing_group_id, member_email, member_tier, relationship,
          add_on_price_cents, added_by, added_by_name, is_active, added_at
        ) VALUES ($1, $2, $3, 'employee', $4, $5, $6, true, NOW())
        RETURNING id`,
        [
          params.billingGroupId,
          params.memberEmail.toLowerCase(),
          normalizedTier,
          pricePerSeat,
          params.addedBy,
          params.addedByName,
        ]
      );
      
      insertedMemberId = insertResult.rows[0].id;
      
      const existingUserCheck = resolvedCorporate
        ? { rows: [{ id: resolvedCorporate.userId }] }
        : await client.query(
            'SELECT id FROM users WHERE LOWER(email) = $1',
            [params.memberEmail.toLowerCase()]
          );
      
      if (existingUserCheck.rows.length > 0) {
        const updateFields: string[] = ['billing_group_id = $1', 'tier = $2', "billing_provider = 'stripe'", "membership_status = 'active'"];
        const updateValues: any[] = [params.billingGroupId, normalizedTier];
        let paramIndex = 3;
        
        if (params.firstName) {
          updateFields.push(`first_name = $${paramIndex++}`);
          updateValues.push(params.firstName);
        }
        if (params.lastName) {
          updateFields.push(`last_name = $${paramIndex++}`);
          updateValues.push(params.lastName);
        }
        if (params.phone) {
          updateFields.push(`phone = $${paramIndex++}`);
          updateValues.push(params.phone);
        }
        if (params.dob) {
          updateFields.push(`date_of_birth = $${paramIndex++}`);
          updateValues.push(params.dob);
        }
        
        if (resolvedCorporate) {
          updateValues.push(resolvedCorporate.userId);
          await client.query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
            updateValues
          );
          console.log(`[GroupBilling] Updated existing user ${resolvedCorporate.primaryEmail} (matched ${params.memberEmail} via ${resolvedCorporate.matchType}) with corporate group`);
        } else {
          updateValues.push(params.memberEmail.toLowerCase());
          await client.query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE LOWER(email) = $${paramIndex}`,
            updateValues
          );
          console.log(`[GroupBilling] Updated existing user ${params.memberEmail} with corporate group`);
        }
      } else {
        const userId = randomUUID();
        await client.query(
          `INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, billing_group_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'stripe', $8, NOW())`,
          [
            userId,
            params.memberEmail.toLowerCase(),
            params.firstName || null,
            params.lastName || null,
            params.phone || null,
            params.dob || null,
            normalizedTier,
            params.billingGroupId
          ]
        );
        console.log(`[GroupBilling] Created new user ${params.memberEmail} with tier ${normalizedTier}`);
      }

      const hasPrePaidSeats = group[0].max_seats && group[0].max_seats > 0;
      
      if (hasPrePaidSeats) {
        console.log(`[GroupBilling] Pre-paid seats mode: ${newMemberCount} of ${group[0].max_seats} seats used (no Stripe billing change needed)`);
      } else if (group[0].primary_stripe_subscription_id) {
        try {
          const stripe = await getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(group[0].primary_stripe_subscription_id, {
            expand: ['items.data'],
          });
          
          const corporateItem = subscription.items.data.find(
            item => item.metadata?.corporate_membership === 'true'
          );
          
          if (corporateItem) {
            originalQuantity = corporateItem.quantity || 0;
            originalPricePerSeat = corporateItem.price?.unit_amount || 35000;
            originalProductId = corporateItem.price?.product as string;
            corporateItemId = corporateItem.id;
            
            const newPricePerSeat = getCorporateVolumePrice(newMemberCount);
            
            if (originalPricePerSeat !== newPricePerSeat) {
              console.log(`[GroupBilling] Price tier change: ${originalPricePerSeat} -> ${newPricePerSeat} cents/seat for ${newMemberCount} members`);
              
              // Preserve existing metadata from the old item while ensuring corporate_membership is set
              const existingMetadata = corporateItem.metadata || {};
              const newItem = await stripe.subscriptionItems.create({
                subscription: group[0].primary_stripe_subscription_id,
                price_data: {
                  currency: 'usd',
                  product: originalProductId,
                  unit_amount: newPricePerSeat,
                  recurring: { interval: 'month' },
                },
                quantity: newMemberCount,
                metadata: {
                  ...existingMetadata,
                  corporate_membership: 'true',
                },
                proration_behavior: 'create_prorations',
              });
              
              await stripe.subscriptionItems.del(corporateItem.id, {
                proration_behavior: 'none',
              });
              
              newStripeItemId = newItem.id;
              corporateItemId = newItem.id;
              priceTierChanged = true;
            } else {
              await stripe.subscriptionItems.update(corporateItem.id, {
                quantity: newMemberCount,
              });
            }
            stripeUpdated = true;
          } else {
            console.log('[GroupBilling] No corporate_membership item found - assuming pre-paid seats via checkout');
          }
        } catch (stripeErr: unknown) {
          console.error('[GroupBilling] Stripe API failed, rolling back DB reservation:', stripeErr);
          if (newStripeItemId) {
            try {
              const stripeForRollback = await getStripeClient();
              await stripeForRollback.subscriptionItems.del(newStripeItemId, {
                proration_behavior: 'none',
              });
              console.log(`[GroupBilling] Rolled back newly created Stripe subscription item ${newStripeItemId}`);
            } catch (rollbackErr: unknown) {
              console.error(`[GroupBilling] CRITICAL: Failed to delete newly created Stripe subscription item ${newStripeItemId}. Customer may be double-billed. Manual intervention required.`, rollbackErr);
            }
          }
          await client.query('ROLLBACK');
          return { success: false, error: 'Failed to update billing. Please try again.' };
        }
      }
      
      await client.query('COMMIT');
      
      return { success: true, memberId: insertedMemberId };
      
    } catch (dbErr: unknown) {
      await client.query('ROLLBACK');
      console.error('[GroupBilling] DB transaction failed:', dbErr);
      
      if (stripeUpdated && originalQuantity !== null) {
        try {
          const stripe = await getStripeClient();
          
          if (priceTierChanged && originalPricePerSeat && originalProductId && primaryStripeSubscriptionId) {
            const currentSub = await stripe.subscriptions.retrieve(primaryStripeSubscriptionId, {
              expand: ['items.data'],
            });
            const currentCorporateItem = currentSub.items.data.find(
              item => item.metadata?.corporate_membership === 'true'
            );
            if (currentCorporateItem) {
              await stripe.subscriptionItems.create({
                subscription: primaryStripeSubscriptionId,
                price_data: {
                  currency: 'usd',
                  product: originalProductId,
                  unit_amount: originalPricePerSeat,
                  recurring: { interval: 'month' },
                },
                quantity: originalQuantity,
                metadata: {
                  corporate_membership: 'true',
                },
                proration_behavior: 'none',
              });
              
              await stripe.subscriptionItems.del(currentCorporateItem.id, {
                proration_behavior: 'none',
              });
              console.log(`[GroupBilling] Rolled back Stripe to original price ${originalPricePerSeat} and quantity ${originalQuantity}`);
            }
          } else if (corporateItemId) {
            await stripe.subscriptionItems.update(corporateItemId, {
              quantity: originalQuantity,
            });
            console.log(`[GroupBilling] Rolled back Stripe quantity to ${originalQuantity}`);
          }
        } catch (rollbackErr: unknown) {
          console.error(`[GroupBilling] CRITICAL: Failed to rollback Stripe. Manual intervention required.`, rollbackErr);
        }
      }
      
      return { success: false, error: 'System error. Please try again.' };
    }
  } catch (err: unknown) {
    console.error('[GroupBilling] Error adding corporate member:', err);
    return { success: false, error: 'Failed to add corporate member. Please try again.' };
  } finally {
    client.release();
  }
}

export async function removeCorporateMember(params: {
  billingGroupId: number;
  memberEmail: string;
  removedBy: string;
}): Promise<{ success: boolean; error?: string }> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const memberResult = await client.query(
      `SELECT gm.id, gm.member_email, gm.is_active
       FROM group_members gm
       WHERE gm.billing_group_id = $1 AND LOWER(gm.member_email) = $2
       FOR UPDATE`,
      [params.billingGroupId, params.memberEmail.toLowerCase()]
    );
    
    if (memberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Member not found in this billing group' };
    }
    
    const memberRecord = memberResult.rows[0];
    
    if (!memberRecord.is_active) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Member is already inactive' };
    }
    
    await client.query(
      `UPDATE group_members SET is_active = false, removed_at = NOW() WHERE id = $1`,
      [memberRecord.id]
    );
    
    await client.query(
      'UPDATE users SET billing_group_id = NULL WHERE LOWER(email) = $1',
      [params.memberEmail.toLowerCase()]
    );
    
    const groupResult = await client.query(
      `SELECT id, primary_stripe_subscription_id FROM billing_groups WHERE id = $1 FOR UPDATE`,
      [params.billingGroupId]
    );
    const group = groupResult.rows;
    
    if (group.length > 0 && group[0].primary_stripe_subscription_id) {
      try {
        const remainingResult = await client.query(
          `SELECT COUNT(*) as cnt FROM group_members WHERE billing_group_id = $1 AND is_active = true`,
          [params.billingGroupId]
        );
        
        const newMemberCount = Math.max(parseInt(remainingResult.rows[0].cnt, 10), 5);
        const newPricePerSeat = getCorporateVolumePrice(newMemberCount);
        
        const stripe = await getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(group[0].primary_stripe_subscription_id, {
          expand: ['items.data'],
        });
        
        const corporateItem = subscription.items.data.find(
          item => item.metadata?.corporate_membership === 'true'
        );
        
        if (corporateItem) {
          const oldPricePerSeat = corporateItem.price?.unit_amount || 35000;
          
          if (oldPricePerSeat !== newPricePerSeat) {
            console.log(`[GroupBilling] Price tier change on removal: ${oldPricePerSeat} -> ${newPricePerSeat} cents/seat for ${newMemberCount} members`);
            
            await stripe.subscriptionItems.create({
              subscription: group[0].primary_stripe_subscription_id,
              price_data: {
                currency: 'usd',
                product: corporateItem.price?.product as string,
                unit_amount: newPricePerSeat,
                recurring: { interval: 'month' },
              },
              quantity: newMemberCount,
              metadata: {
                corporate_membership: 'true',
              },
              proration_behavior: 'create_prorations',
            });
            
            await stripe.subscriptionItems.del(corporateItem.id, {
              proration_behavior: 'none',
            });
          } else {
            await stripe.subscriptionItems.update(corporateItem.id, {
              quantity: newMemberCount,
            });
          }
        }
      } catch (stripeErr: unknown) {
        await client.query('ROLLBACK');
        console.error('[GroupBilling] Failed to update Stripe on member removal:', stripeErr);
        return { success: false, error: 'Failed to update billing. Please try again.' };
      }
    }
    
    await client.query('COMMIT');
    console.log(`[GroupBilling] Successfully removed corporate member ${params.memberEmail}`);
    return { success: true };
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    console.error('[GroupBilling] Error removing corporate member:', err);
    return { success: false, error: 'Failed to remove member. Please try again.' };
  } finally {
    client.release();
  }
}

export async function removeGroupMember(params: {
  memberId: number;
  removedBy: string;
}): Promise<{ success: boolean; error?: string }> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const memberResult = await client.query(
      `SELECT gm.id, gm.member_email, gm.stripe_subscription_item_id, gm.is_active
       FROM group_members gm
       WHERE gm.id = $1
       FOR UPDATE`,
      [params.memberId]
    );
    
    if (memberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Group member not found' };
    }
    
    const memberRecord = memberResult.rows[0];
    
    if (!memberRecord.is_active) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Member is already inactive' };
    }
    
    await client.query(
      `UPDATE group_members SET is_active = false, removed_at = NOW() WHERE id = $1`,
      [params.memberId]
    );
    
    await client.query(
      'UPDATE users SET billing_group_id = NULL WHERE LOWER(email) = $1',
      [memberRecord.member_email.toLowerCase()]
    );
    
    if (memberRecord.stripe_subscription_item_id) {
      try {
        const stripe = await getStripeClient();
        await stripe.subscriptionItems.del(memberRecord.stripe_subscription_item_id);
        console.log(`[GroupBilling] Deleted Stripe subscription item ${memberRecord.stripe_subscription_item_id}`);
      } catch (stripeErr: unknown) {
        await client.query('ROLLBACK');
        console.error('[GroupBilling] Failed to remove Stripe subscription item:', stripeErr);
        return { 
          success: false, 
          error: 'Cannot remove billing. Member is still being charged. Please try again or contact support.' 
        };
      }
    }
    
    await client.query('COMMIT');
    console.log(`[GroupBilling] Successfully removed group member ${params.memberId}`);
    return { success: true };
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    console.error('[GroupBilling] Error removing group member:', err);
    return { success: false, error: 'Failed to remove member. Please try again.' };
  } finally {
    client.release();
  }
}

export const removeFamilyMember = removeGroupMember;

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
    console.error('[GroupBilling] Error linking subscription:', err);
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
          });
          
          await db.update(familyAddOnProducts)
            .set({
              priceCents: params.priceCents,
              stripePriceId: newPrice.id,
              updatedAt: new Date(),
            })
            .where(eq(familyAddOnProducts.id, product.id));
        } catch (stripeErr: unknown) {
          console.error('[GroupBilling] Error creating new Stripe price:', stripeErr);
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
    console.error('[GroupBilling] Error updating pricing:', err);
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

export interface ReconciliationResult {
  success: boolean;
  groupsChecked: number;
  membersDeactivated: number;
  membersReactivated: number;
  membersCreated: number;
  itemsRelinked: number;
  errors: string[];
  details: ReconciliationDetail[];
}

export interface ReconciliationDetail {
  billingGroupId: number;
  primaryEmail: string;
  action: 'deactivated' | 'reactivated' | 'relinked' | 'error' | 'ok';
  memberEmail?: string;
  reason: string;
}

export async function reconcileGroupBillingWithStripe(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    success: true,
    groupsChecked: 0,
    membersDeactivated: 0,
    membersReactivated: 0,
    membersCreated: 0,
    itemsRelinked: 0,
    errors: [],
    details: [],
  };

  try {
    const stripe = await getStripeClient();
    
    const activeGroups = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.isActive, true));
    
    for (const group of activeGroups) {
      result.groupsChecked++;
      
      // Skip corporate groups - they use quantity-based billing, not individual subscription items
      // Corporate members don't have individual stripeSubscriptionItemId values, so the
      // individual-item reconciliation logic doesn't apply to them
      if (group.type === 'corporate') {
        result.details.push({
          billingGroupId: group.id,
          primaryEmail: group.primaryEmail,
          action: 'ok',
          reason: 'Corporate group uses quantity-based billing - skipped individual item reconciliation',
        });
        continue;
      }
      
      if (!group.primaryStripeSubscriptionId) {
        result.details.push({
          billingGroupId: group.id,
          primaryEmail: group.primaryEmail,
          action: 'ok',
          reason: 'No Stripe subscription linked - skipped',
        });
        continue;
      }
      
      try {
        const subscription = await stripe.subscriptions.retrieve(group.primaryStripeSubscriptionId, {
          expand: ['items.data'],
        });
        
        const stripeItemsMap = new Map<string, Stripe.SubscriptionItem>();
        const stripeEmailToItemMap = new Map<string, Stripe.SubscriptionItem>();
        
        for (const item of subscription.items.data) {
          stripeItemsMap.set(item.id, item);
          const memberEmail = item.metadata?.group_member_email?.toLowerCase() || 
                              item.metadata?.family_member_email?.toLowerCase();
          if (memberEmail) {
            stripeEmailToItemMap.set(memberEmail, item);
          }
        }
        
        const localMembers = await db.select()
          .from(groupMembers)
          .where(and(
            eq(groupMembers.billingGroupId, group.id),
            eq(groupMembers.isActive, true)
          ));
        
        for (const member of localMembers) {
          if (member.stripeSubscriptionItemId) {
            if (!stripeItemsMap.has(member.stripeSubscriptionItemId)) {
              const stripeItem = stripeEmailToItemMap.get(member.memberEmail.toLowerCase());
              if (stripeItem) {
                await db.update(groupMembers)
                  .set({
                    stripeSubscriptionItemId: stripeItem.id,
                  } as any)
                  .where(eq(groupMembers.id, member.id));
                
                result.itemsRelinked++;
                result.details.push({
                  billingGroupId: group.id,
                  primaryEmail: group.primaryEmail,
                  action: 'relinked',
                  memberEmail: member.memberEmail,
                  reason: `Subscription item ID updated from ${member.stripeSubscriptionItemId} to ${stripeItem.id}`,
                });
              } else {
                await db.update(groupMembers)
                  .set({
                    isActive: false,
                    removedAt: new Date(),
                  } as any)
                  .where(eq(groupMembers.id, member.id));
                
                await pool.query(
                  'UPDATE users SET billing_group_id = NULL WHERE LOWER(email) = $1',
                  [member.memberEmail.toLowerCase()]
                );
                
                result.membersDeactivated++;
                result.details.push({
                  billingGroupId: group.id,
                  primaryEmail: group.primaryEmail,
                  action: 'deactivated',
                  memberEmail: member.memberEmail,
                  reason: 'Stripe subscription item no longer exists',
                });
              }
            }
          } else {
            const stripeItem = stripeEmailToItemMap.get(member.memberEmail.toLowerCase());
            if (stripeItem) {
              await db.update(groupMembers)
                .set({
                  stripeSubscriptionItemId: stripeItem.id,
                } as any)
                .where(eq(groupMembers.id, member.id));
              
              result.itemsRelinked++;
              result.details.push({
                billingGroupId: group.id,
                primaryEmail: group.primaryEmail,
                action: 'relinked',
                memberEmail: member.memberEmail,
                reason: `Linked to existing Stripe item ${stripeItem.id}`,
              });
            }
          }
        }
        
        for (const [email, item] of stripeEmailToItemMap) {
          const hasLocalMember = localMembers.some(
            m => m.memberEmail.toLowerCase() === email
          );
          
          if (!hasLocalMember) {
            const inactiveMember = await db.select()
              .from(groupMembers)
              .where(and(
                eq(groupMembers.billingGroupId, group.id),
                eq(groupMembers.memberEmail, email),
                eq(groupMembers.isActive, false)
              ))
              .limit(1);
            
            if (inactiveMember.length > 0) {
              await db.update(groupMembers)
                .set({
                  isActive: true,
                  stripeSubscriptionItemId: item.id,
                  removedAt: null,
                } as any)
                .where(eq(groupMembers.id, inactiveMember[0].id));
              
              await pool.query(
                'UPDATE users SET billing_group_id = $1 WHERE LOWER(email) = $2',
                [group.id, email]
              );
              
              result.membersReactivated++;
              result.details.push({
                billingGroupId: group.id,
                primaryEmail: group.primaryEmail,
                action: 'reactivated',
                memberEmail: email,
                reason: 'Found active Stripe item, reactivated member',
              });
            } else {
              const tierFromMetadata = item.metadata?.tier || 'Social';
              const priceInfo = item.price;
              const priceCents = priceInfo?.unit_amount || 0;
              
              await db.insert(groupMembers).values({
                billingGroupId: group.id,
                memberEmail: email,
                memberTier: tierFromMetadata,
                stripeSubscriptionItemId: item.id,
                stripePriceId: priceInfo?.id || null,
                addOnPriceCents: priceCents,
                addedBy: 'system-reconcile',
                addedByName: 'Stripe Reconciliation',
              });
              
              await pool.query(
                'UPDATE users SET billing_group_id = $1 WHERE LOWER(email) = $2',
                [group.id, email]
              );
              
              result.membersCreated++;
              result.details.push({
                billingGroupId: group.id,
                primaryEmail: group.primaryEmail,
                action: 'reactivated',
                memberEmail: email,
                reason: `Created new group member from Stripe item (tier: ${tierFromMetadata})`,
              });
            }
          }
        }
        
      } catch (stripeErr: unknown) {
        result.errors.push(`Group ${group.id} (${group.primaryEmail}): ${getErrorMessage(stripeErr)}`);
        result.details.push({
          billingGroupId: group.id,
          primaryEmail: group.primaryEmail,
          action: 'error',
          reason: getErrorMessage(stripeErr),
        });
        result.success = false;
      }
    }
    
    return result;
  } catch (err: unknown) {
    return {
      ...result,
      success: false,
      errors: [...result.errors, getErrorMessage(err)],
    };
  }
}

export const reconcileFamilyBillingWithStripe = reconcileGroupBillingWithStripe;

export async function handleSubscriptionItemsChanged(
  subscriptionId: string,
  currentItems: Array<{ id: string; metadata?: Record<string, string> }>,
  previousItems: Array<{ id: string; metadata?: Record<string, string> }>
): Promise<void> {
  try {
    const group = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.primaryStripeSubscriptionId, subscriptionId))
      .limit(1);
    
    if (group.length === 0) {
      return;
    }
    
    const billingGroupId = group[0].id;
    
    const currentItemIds = new Set(currentItems.map(i => i.id));
    const previousItemIds = new Set(previousItems.map(i => i.id));
    
    // Build a map of current items by email for safety checks
    const currentEmailToItemMap = new Map<string, { id: string; metadata?: Record<string, string> }>();
    for (const item of currentItems) {
      const email = item.metadata?.group_member_email?.toLowerCase() ||
                    item.metadata?.family_member_email?.toLowerCase();
      if (email) {
        currentEmailToItemMap.set(email, item);
      }
    }
    
    const removedItems = previousItems.filter(item => !currentItemIds.has(item.id));
    
    for (const item of removedItems) {
      const memberEmail = item.metadata?.group_member_email?.toLowerCase() ||
                          item.metadata?.family_member_email?.toLowerCase();
      if (memberEmail) {
        // SAFETY CHECK: Verify the member's subscription item is actually fully removed
        // and not just modified (e.g., price change, quantity update)
        const existingItemForEmail = currentEmailToItemMap.get(memberEmail);
        if (existingItemForEmail) {
          // The member still has an active subscription item (possibly modified/replaced)
          console.warn(
            `[GroupBilling] Skipping deactivation for ${memberEmail} - item ${item.id} removed but ` +
            `member still has active item ${existingItemForEmail.id}. Item may have been modified, not cancelled.`
          );
          
          // Update the member's subscription item ID to the new one if different
          const member = await db.select()
            .from(groupMembers)
            .where(and(
              eq(groupMembers.billingGroupId, billingGroupId),
              eq(groupMembers.memberEmail, memberEmail),
              eq(groupMembers.isActive, true)
            ))
            .limit(1);
          
          if (member.length > 0 && member[0].stripeSubscriptionItemId !== existingItemForEmail.id) {
            await db.update(groupMembers)
              .set({
                stripeSubscriptionItemId: existingItemForEmail.id,
              } as any)
              .where(eq(groupMembers.id, member[0].id));
            console.log(`[GroupBilling] Updated member ${memberEmail} subscription item ID from ${item.id} to ${existingItemForEmail.id}`);
          }
          continue;
        }
        
        // Member's subscription item is truly removed - safe to deactivate
        const member = await db.select()
          .from(groupMembers)
          .where(and(
            eq(groupMembers.billingGroupId, billingGroupId),
            eq(groupMembers.memberEmail, memberEmail),
            eq(groupMembers.isActive, true)
          ))
          .limit(1);
        
        if (member.length > 0) {
          await db.update(groupMembers)
            .set({
              isActive: false,
              removedAt: new Date(),
            })
            .where(eq(groupMembers.id, member[0].id));
          
          await pool.query(
            'UPDATE users SET billing_group_id = NULL WHERE LOWER(email) = $1',
            [memberEmail]
          );
          
          console.log(`[GroupBilling] Auto-deactivated member ${memberEmail} - subscription item ${item.id} fully removed`);
        }
      }
    }
  } catch (err: unknown) {
    console.error('[GroupBilling] Error handling subscription items change:', err);
  }
}

/**
 * CRITICAL: Handles the scenario where the Primary Member cancels their subscription entirely.
 * This ensures Sub-Members do not retain free access when the primary payer leaves.
 * This function should be called from the customer.subscription.deleted webhook.
 */
export async function handlePrimarySubscriptionCancelled(subscriptionId: string): Promise<void> {
  try {
    // 1. Find the group linked to this subscription
    const group = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.primaryStripeSubscriptionId, subscriptionId))
      .limit(1);

    if (group.length === 0) {
      // Not a group subscription - nothing to do
      return;
    }

    const groupId = group[0].id;
    console.log(`[GroupBilling] Primary subscription ${subscriptionId} cancelled. Deactivating group ${groupId}...`);

    // 2. Find all active members in this group
    const activeMembers = await db.select()
      .from(groupMembers)
      .where(and(
        eq(groupMembers.billingGroupId, groupId),
        eq(groupMembers.isActive, true)
      ));

    if (activeMembers.length === 0) {
      console.log(`[GroupBilling] No active members in group ${groupId} - nothing to deactivate`);
      return;
    }

    // 3. Deactivate all members in the group
    await db.update(groupMembers)
      .set({
        isActive: false,
        removedAt: new Date(),
        // We keep the stripeSubscriptionItemId for audit history,
        // but since the parent subscription is dead, the item is dead too.
      })
      .where(eq(groupMembers.billingGroupId, groupId));

    // 4. Unlink the users so they lose access permissions
    const emailsToDeactivate = activeMembers.map(m => m.memberEmail.toLowerCase());

    if (emailsToDeactivate.length > 0) {
      await pool.query(
        `UPDATE users SET 
           billing_group_id = NULL,
           membership_status = 'cancelled',
           tier = NULL,
           updated_at = NOW()
         WHERE LOWER(email) = ANY($1::text[])`,
        [emailsToDeactivate]
      );
      
      // Sync cancelled sub-members to HubSpot
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        for (const subEmail of emailsToDeactivate) {
          await syncMemberToHubSpot({ email: subEmail, status: 'cancelled', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
        }
        console.log(`[GroupBilling] Synced ${emailsToDeactivate.length} cancelled sub-members to HubSpot`);
      } catch (hubspotErr) {
        console.error('[GroupBilling] HubSpot sync failed for cancelled sub-members:', hubspotErr);
      }
    }

    await pool.query(
      `UPDATE billing_groups SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true`,
      [groupId]
    );

    console.log(`[GroupBilling] Successfully deactivated group ${groupId} and ${emailsToDeactivate.length} members`);

  } catch (err) {
    console.error('[GroupBilling] Error handling primary subscription cancellation:', err);
    throw err; // Re-throw to ensure webhook retries if this fails
  }
}

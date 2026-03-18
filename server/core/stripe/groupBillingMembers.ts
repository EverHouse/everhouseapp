import { db } from '../../db';
import { billingGroups, groupMembers, familyAddOnProducts } from '../../../shared/models/hubspot-billing';
import { eq, sql } from 'drizzle-orm';
import { getStripeClient } from './client';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { getErrorMessage } from '../../utils/errorUtils';
import { normalizeTierName } from '../../utils/tierUtils';
import { findOrCreateHubSpotContact } from '../hubspot/members';
import { logger } from '../logger';
import { sendPassUpdateForMemberByEmail } from '../../walletPass/apnPushService';
import {
  getCorporateVolumePrice,
  getOrCreateFamilyCoupon,
  type InsertIdRow,
  type ExclusionCheckRow,
  type UserBillingRow,
  type GroupBillingRow,
  type EarlyReturnError,
} from './groupBillingCrud';

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
  discountCode?: string;
  addedBy: string;
  addedByName: string;
}): Promise<{ success: boolean; memberId?: number; error?: string }> {
  const normalizedTier = normalizeTierName(params.memberTier);
  
  try {
    const existingMember = await db.select()
      .from(groupMembers)
      .where(eq(groupMembers.memberEmail, params.memberEmail.toLowerCase()))
      .limit(1);
    
    if (existingMember.length > 0 && existingMember[0].isActive) {
      return { success: false, error: 'This member is already part of a billing group' };
    }
    
    const { resolveUserByEmail: resolveFamilyEmail } = await import('./customers');
    const resolvedFamily = await resolveFamilyEmail(params.memberEmail);
    
    const userResult = resolvedFamily
      ? await db.execute(
          sql`SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE id = ${resolvedFamily.userId}`
        )
      : await db.execute(
          sql`SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
        );
    
    if (resolvedFamily && resolvedFamily.matchType !== 'direct') {
      logger.info(`[GroupBilling] Email ${params.memberEmail} resolved to existing user ${resolvedFamily.primaryEmail} via ${resolvedFamily.matchType}`);
    }
    
    const userExists = userResult.rows.length > 0;
    
    if (userExists) {
      const user = (userResult.rows as unknown as UserBillingRow[])[0];
      
      if (user.billing_group_id !== null && user.billing_group_id !== params.billingGroupId) {
        return { 
          success: false, 
          error: 'User is already in a billing group. Remove them first.' 
        };
      }
      
      const hasActiveSubscription = user.stripe_subscription_id && 
        (user.membership_status === 'active' || user.membership_status === 'trialing' || user.membership_status === 'past_due');
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
    let needsStripeSync = false;
    let stripeSubscriptionId: string | null = null;
    let stripePriceId: string | null = null;
    let isFamilyGroup = false;
    
    try {
      await db.transaction(async (tx) => {
        const insertResult = await tx.execute(
          sql`INSERT INTO group_members (
            billing_group_id, member_email, member_tier, relationship,
            stripe_subscription_item_id, stripe_price_id, add_on_price_cents,
            added_by, added_by_name, is_active, added_at
          ) VALUES (${params.billingGroupId}, ${params.memberEmail.toLowerCase()}, ${normalizedTier}, ${params.relationship || null}, NULL, ${product.stripePriceId}, ${product.priceCents}, ${params.addedBy}, ${params.addedByName}, true, NOW())
          RETURNING id`
        );
        
        insertedMemberId = (insertResult.rows as unknown as InsertIdRow[])[0].id as number;

        if (userExists) {
          const setFragments = [
            sql`billing_group_id = ${params.billingGroupId}`,
            sql`tier = ${normalizedTier}`,
            sql`billing_provider = 'stripe'`,
            sql`membership_status = 'active'`,
            sql`membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END`,
            sql`updated_at = NOW()`
          ];
          
          if (params.firstName) setFragments.push(sql`first_name = ${params.firstName}`);
          if (params.lastName) setFragments.push(sql`last_name = ${params.lastName}`);
          if (params.phone) setFragments.push(sql`phone = ${params.phone}`);
          if (params.dob) setFragments.push(sql`date_of_birth = ${params.dob}`);
          if (params.streetAddress) setFragments.push(sql`street_address = ${params.streetAddress}`);
          if (params.city) setFragments.push(sql`city = ${params.city}`);
          if (params.state) setFragments.push(sql`state = ${params.state}`);
          if (params.zipCode) setFragments.push(sql`zip_code = ${params.zipCode}`);
          
          const setClauses = sql.join(setFragments, sql`, `);
          
          if (resolvedFamily) {
            await tx.execute(sql`UPDATE users SET ${setClauses} WHERE id = ${resolvedFamily.userId}`);
            logger.info(`[GroupBilling] Updated existing user ${resolvedFamily.primaryEmail} (matched ${params.memberEmail} via ${resolvedFamily.matchType}) with family group`);
          } else {
            await tx.execute(sql`UPDATE users SET ${setClauses} WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`);
            logger.info(`[GroupBilling] Updated existing user ${params.memberEmail} with family group`);
          }
        } else {
          const exclusionCheck = await tx.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${params.memberEmail.toLowerCase()}`);
          if ((exclusionCheck.rows as unknown as ExclusionCheckRow[]).length > 0) {
            logger.info(`[GroupBilling] Skipping family sub-member creation for ${params.memberEmail} — permanently deleted (sync_exclusions)`);
          } else {
            const userId = randomUUID();
            await tx.execute(
              sql`INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, billing_group_id, street_address, city, state, zip_code, created_at)
               VALUES (${userId}, ${params.memberEmail.toLowerCase()}, ${params.firstName || null}, ${params.lastName || null}, ${params.phone || null}, ${params.dob || null}, ${normalizedTier}, 'active', 'stripe', ${params.billingGroupId}, ${params.streetAddress || null}, ${params.city || null}, ${params.state || null}, ${params.zipCode || null}, NOW())`
            );
            logger.info(`[GroupBilling] Created new user ${params.memberEmail} for family group with tier ${normalizedTier}`);
          }
        }

        if (group[0].primaryStripeSubscriptionId && product.stripePriceId) {
          needsStripeSync = true;
          stripeSubscriptionId = group[0].primaryStripeSubscriptionId;
          stripePriceId = product.stripePriceId;
          isFamilyGroup = params.relationship !== 'employee';
        }
      });
      
      if (needsStripeSync && stripeSubscriptionId && stripePriceId) {
        try {
          const stripe = await getStripeClient();
          
          const subscriptionItemParams: Stripe.SubscriptionItemCreateParams = {
            subscription: stripeSubscriptionId,
            price: stripePriceId,
            quantity: 1,
            metadata: {
              group_member_email: params.memberEmail.toLowerCase(),
              billing_group_id: params.billingGroupId.toString(),
              tier: normalizedTier,
            },
          };
          
          const explicitDiscount = params.discountCode;
          const skipDiscount = explicitDiscount === '' || explicitDiscount?.toLowerCase() === 'none';
          let appliedCouponCode: string | null = null;

          if (!skipDiscount) {
            if (explicitDiscount) {
              try {
                const coupon = await stripe.coupons.retrieve(explicitDiscount);
                subscriptionItemParams.discounts = [{ coupon: coupon.id }];
                appliedCouponCode = explicitDiscount;
                logger.info(`[GroupBilling] Applying coupon ${explicitDiscount} to member ${params.memberEmail}`);
              } catch (couponErr: unknown) {
                logger.warn(`[GroupBilling] Could not apply coupon ${explicitDiscount}: ${getErrorMessage(couponErr)}. Proceeding without discount.`);
              }
            } else if (isFamilyGroup) {
              try {
                const couponId = await getOrCreateFamilyCoupon();
                subscriptionItemParams.discounts = [{ coupon: couponId }];
                appliedCouponCode = 'FAMILY20';
                logger.info(`[GroupBilling] Applying FAMILY20 coupon to family member ${params.memberEmail}`);
              } catch (couponErr: unknown) {
                logger.warn(`[GroupBilling] Could not apply FAMILY20 coupon: ${getErrorMessage(couponErr)}. Proceeding without discount.`);
              }
            }
          }
          
          const subscriptionItem = await stripe.subscriptionItems.create(subscriptionItemParams, {
            idempotencyKey: `subitem_${stripeSubscriptionId}_${stripePriceId}_${params.memberEmail.toLowerCase()}`
          });
          
          await db.execute(
            sql`UPDATE group_members SET stripe_subscription_item_id = ${subscriptionItem.id} WHERE id = ${insertedMemberId}`
          );

          try {
            if (appliedCouponCode) {
              await db.execute(
                sql`UPDATE users SET discount_code = ${appliedCouponCode}, updated_at = NOW() WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
              );
              logger.info(`[GroupBilling] Set discount_code=${appliedCouponCode} for member ${params.memberEmail}`);
            } else {
              await db.execute(
                sql`UPDATE users SET discount_code = NULL, updated_at = NOW() WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
              );
              logger.info(`[GroupBilling] Cleared discount_code for member ${params.memberEmail} (no discount applied)`);
            }
          } catch (dcErr: unknown) {
            logger.warn(`[GroupBilling] Failed to update discount_code for member: ${getErrorMessage(dcErr)}`);
          }
        } catch (stripeErr: unknown) {
          logger.error('[GroupBilling] Stripe API failed, rolling back DB reservation:', { error: stripeErr });
          try {
            await db.execute(
              sql`UPDATE group_members SET is_active = false, removed_at = NOW() WHERE id = ${insertedMemberId}`
            );
            await db.execute(
              sql`UPDATE users SET billing_group_id = NULL, membership_status = CASE WHEN billing_group_id = ${params.billingGroupId} THEN 'pending' ELSE membership_status END, membership_status_changed_at = CASE WHEN billing_group_id = ${params.billingGroupId} AND membership_status IS DISTINCT FROM 'pending' THEN NOW() ELSE membership_status_changed_at END, tier = CASE WHEN billing_group_id = ${params.billingGroupId} THEN NULL ELSE tier END WHERE LOWER(email) = ${params.memberEmail.toLowerCase()} AND billing_group_id = ${params.billingGroupId}`
            );
          } catch (compensateErr: unknown) {
            logger.error(`[GroupBilling] CRITICAL: Failed to compensate DB after Stripe failure. Manual intervention required.`, { error: compensateErr });
          }
          return { success: false, error: `Failed to add billing: ${getErrorMessage(stripeErr)}` };
        }
      }
      
      findOrCreateHubSpotContact(
        params.memberEmail,
        params.firstName || '',
        params.lastName || '',
        params.phone
      ).catch((err: unknown) => {
        logger.error('[GroupBilling] Background HubSpot sync for sub-member failed:', { error: err });
      });

      sendPassUpdateForMemberByEmail(params.memberEmail.toLowerCase()).catch(err =>
        logger.warn('[GroupBilling] Wallet pass push failed for new group member (non-fatal)', { extra: { email: params.memberEmail, error: getErrorMessage(err) } })
      );

      return { success: true, memberId: insertedMemberId ?? undefined };

    } catch (dbErr: unknown) {
      logger.error('[GroupBilling] DB transaction failed:', { error: dbErr });
      return { success: false, error: 'System error. Please try again.' };
    }
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error adding group member:', { error: err });
    return { success: false, error: 'Operation failed. Please try again.' };
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
  
  try {
    let insertedMemberId: number | null = null;
    let primaryStripeSubscriptionId: string | null = null;
    let needsStripeSync = false;
    let newMemberCount = 0;
    let hasPrePaidSeats = false;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let maxSeats: unknown = null;
    
    try {
      await db.transaction(async (tx) => {

        const existingMemberResult = await tx.execute(
          sql`SELECT id FROM group_members WHERE LOWER(member_email) = ${params.memberEmail.toLowerCase()} AND is_active = true LIMIT 1`
        );
    
        if (existingMemberResult.rows.length > 0) {
          throw Object.assign(new Error('This member is already part of a billing group'), { __earlyReturn: true, result: { success: false, error: 'This member is already part of a billing group' } });
        }
    
        const { resolveUserByEmail: resolveCorporateEmail } = await import('./customers');
        const resolvedCorporate = await resolveCorporateEmail(params.memberEmail);
      
        const userResult = resolvedCorporate
          ? await tx.execute(
              sql`SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE id = ${resolvedCorporate.userId}`
            )
          : await tx.execute(
              sql`SELECT id, billing_group_id, stripe_subscription_id, membership_status FROM users WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
            );
    
        if (resolvedCorporate && resolvedCorporate.matchType !== 'direct') {
          logger.info(`[GroupBilling] Email ${params.memberEmail} resolved to existing user ${resolvedCorporate.primaryEmail} via ${resolvedCorporate.matchType}`);
        }
    
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0] as unknown as UserBillingRow;
      
          if (user.billing_group_id !== null && user.billing_group_id !== params.billingGroupId) {
            throw Object.assign(new Error('User is already in a billing group. Remove them first.'), { __earlyReturn: true, result: { success: false, error: 'User is already in a billing group. Remove them first.' } });
          }
      
          const hasActiveSubscription = user.stripe_subscription_id && 
            (user.membership_status === 'active' || user.membership_status === 'trialing' || user.membership_status === 'past_due');
          if (hasActiveSubscription) {
            throw Object.assign(new Error('User already has their own active subscription. Cancel it before adding them to a corporate plan.'), { __earlyReturn: true, result: { success: false, error: 'User already has their own active subscription. Cancel it before adding them to a corporate plan.' } });
          }
        }
    
        const groupResult = await tx.execute(
          sql`SELECT * FROM billing_groups WHERE id = ${params.billingGroupId} LIMIT 1 FOR UPDATE`
        );
    
        if (groupResult.rows.length === 0) {
          throw Object.assign(new Error('Billing group not found'), { __earlyReturn: true, result: { success: false, error: 'Billing group not found' } });
        }
    
        const group = [groupResult.rows[0] as unknown as GroupBillingRow];
        primaryStripeSubscriptionId = (group[0].primary_stripe_subscription_id as string) || null;
    
        const currentMembersResult = await tx.execute(
          sql`SELECT id FROM group_members WHERE billing_group_id = ${params.billingGroupId} AND is_active = true`
        );
    
        newMemberCount = currentMembersResult.rows.length + 1;
        
        hasPrePaidSeats = !!(group[0].max_seats && (group[0].max_seats as number) > 0);
        maxSeats = group[0].max_seats;
        
        if (hasPrePaidSeats && newMemberCount > (group[0].max_seats as number)) {
          throw Object.assign(new Error('Seat limit exceeded'), {
            __earlyReturn: true,
            result: { success: false, error: `Corporate group has reached its maximum limit of ${group[0].max_seats} seats.` }
          } as EarlyReturnError);
        }
        
        const pricePerSeat = getCorporateVolumePrice(newMemberCount);
      
        const insertResult = await tx.execute(
          sql`INSERT INTO group_members (
            billing_group_id, member_email, member_tier, relationship,
            add_on_price_cents, added_by, added_by_name, is_active, added_at
          ) VALUES (${params.billingGroupId}, ${params.memberEmail.toLowerCase()}, ${normalizedTier}, 'employee', ${pricePerSeat}, ${params.addedBy}, ${params.addedByName}, true, NOW())
          RETURNING id`
        );
      
        insertedMemberId = (insertResult.rows as unknown as InsertIdRow[])[0].id as number;
      
        const existingUserCheck = resolvedCorporate
          ? { rows: [{ id: resolvedCorporate.userId }] }
          : await tx.execute(
              sql`SELECT id FROM users WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
            );
      
        if (existingUserCheck.rows.length > 0) {
          const setFragments = [
            sql`billing_group_id = ${params.billingGroupId}`,
            sql`tier = ${normalizedTier}`,
            sql`billing_provider = 'stripe'`,
            sql`membership_status = 'active'`,
            sql`membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END`
          ];
        
          if (params.firstName) setFragments.push(sql`first_name = ${params.firstName}`);
          if (params.lastName) setFragments.push(sql`last_name = ${params.lastName}`);
          if (params.phone) setFragments.push(sql`phone = ${params.phone}`);
          if (params.dob) setFragments.push(sql`date_of_birth = ${params.dob}`);
        
          const setClauses = sql.join(setFragments, sql`, `);
        
          if (resolvedCorporate) {
            await tx.execute(sql`UPDATE users SET ${setClauses} WHERE id = ${resolvedCorporate.userId}`);
            logger.info(`[GroupBilling] Updated existing user ${resolvedCorporate.primaryEmail} (matched ${params.memberEmail} via ${resolvedCorporate.matchType}) with corporate group`);
          } else {
            await tx.execute(sql`UPDATE users SET ${setClauses} WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`);
            logger.info(`[GroupBilling] Updated existing user ${params.memberEmail} with corporate group`);
          }
        } else {
          const corpExclusionCheck = await tx.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${params.memberEmail.toLowerCase()}`);
          if ((corpExclusionCheck.rows as unknown as ExclusionCheckRow[]).length > 0) {
            logger.info(`[GroupBilling] Skipping corporate sub-member creation for ${params.memberEmail} — permanently deleted (sync_exclusions)`);
          } else {
            const userId = randomUUID();
            await tx.execute(
              sql`INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, billing_group_id, created_at)
               VALUES (${userId}, ${params.memberEmail.toLowerCase()}, ${params.firstName || null}, ${params.lastName || null}, ${params.phone || null}, ${params.dob || null}, ${normalizedTier}, 'active', 'stripe', ${params.billingGroupId}, NOW())`
            );
            logger.info(`[GroupBilling] Created new user ${params.memberEmail} with tier ${normalizedTier}`);
          }
        }

        if (hasPrePaidSeats) {
          logger.info(`[GroupBilling] Pre-paid seats mode: ${newMemberCount} of ${group[0].max_seats} seats used (no Stripe billing change needed)`);
        } else if (primaryStripeSubscriptionId) {
          needsStripeSync = true;
        }
      });
      
      if (needsStripeSync && primaryStripeSubscriptionId) {
        let newStripeItemId: string | null = null;
        try {
          const stripe = await getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(primaryStripeSubscriptionId, {
            expand: ['items.data'],
          });
        
          const corporateItem = subscription.items.data.find(
            item => item.metadata?.corporate_membership === 'true'
          );
        
          if (corporateItem) {
            const originalPricePerSeat = corporateItem.price?.unit_amount ?? 0;
            if (!originalPricePerSeat) {
              logger.error(`[GroupBilling] Corporate seat price is missing from Stripe subscription item ${corporateItem.id} — cannot adjust`);
              throw new Error('Corporate seat price not found on Stripe subscription item');
            }
            const originalProductId = corporateItem.price?.product as string;
          
            const newPricePerSeat = getCorporateVolumePrice(newMemberCount);
          
            if (originalPricePerSeat !== newPricePerSeat) {
              logger.info(`[GroupBilling] Price tier change: ${originalPricePerSeat} -> ${newPricePerSeat} cents/seat for ${newMemberCount} members`);
            
              const existingMetadata = corporateItem.metadata || {};
              const newItem = await stripe.subscriptionItems.create({
                subscription: primaryStripeSubscriptionId,
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
              }, { idempotencyKey: `subitem_corp_add_${primaryStripeSubscriptionId}_${newPricePerSeat}_${newMemberCount}_${Math.floor(Date.now() / 300000)}` });
            
              newStripeItemId = newItem.id;
            
              await stripe.subscriptionItems.del(corporateItem.id, {
                proration_behavior: 'none',
              });
            } else {
              await stripe.subscriptionItems.update(corporateItem.id, {
                quantity: newMemberCount,
              });
            }
          } else {
            logger.info('[GroupBilling] No corporate_membership item found - assuming pre-paid seats via checkout');
          }
        } catch (stripeErr: unknown) {
          logger.error('[GroupBilling] Stripe API failed, rolling back DB reservation:', { error: stripeErr });
          if (newStripeItemId) {
            try {
              const stripeForRollback = await getStripeClient();
              await stripeForRollback.subscriptionItems.del(newStripeItemId, {
                proration_behavior: 'none',
              });
              logger.info(`[GroupBilling] Rolled back newly created Stripe subscription item ${newStripeItemId}`);
            } catch (rollbackErr: unknown) {
              logger.error(`[GroupBilling] CRITICAL: Failed to delete newly created Stripe subscription item ${newStripeItemId}. Customer may be double-billed. Manual intervention required.`, { error: rollbackErr });
            }
          }
          try {
            await db.execute(
              sql`UPDATE group_members SET is_active = false, removed_at = NOW() WHERE id = ${insertedMemberId}`
            );
            await db.execute(
              sql`UPDATE users SET billing_group_id = NULL, membership_status = CASE WHEN billing_group_id = ${params.billingGroupId} THEN 'pending' ELSE membership_status END, membership_status_changed_at = CASE WHEN billing_group_id = ${params.billingGroupId} AND membership_status IS DISTINCT FROM 'pending' THEN NOW() ELSE membership_status_changed_at END, tier = CASE WHEN billing_group_id = ${params.billingGroupId} THEN NULL ELSE tier END WHERE LOWER(email) = ${params.memberEmail.toLowerCase()} AND billing_group_id = ${params.billingGroupId}`
            );
          } catch (compensateErr: unknown) {
            logger.error(`[GroupBilling] CRITICAL: Failed to compensate DB after Stripe failure. Manual intervention required.`, { error: compensateErr });
          }
          return { success: false, error: 'Failed to update billing. Please try again.' };
        }
      }
      
      findOrCreateHubSpotContact(
        params.memberEmail,
        params.firstName || '',
        params.lastName || '',
        params.phone
      ).catch((err: unknown) => {
        logger.error('[GroupBilling] Background HubSpot sync for sub-member failed:', { error: err });
      });

      sendPassUpdateForMemberByEmail(params.memberEmail.toLowerCase()).catch(err =>
        logger.warn('[GroupBilling] Wallet pass push failed for new group member (non-fatal)', { extra: { email: params.memberEmail, error: getErrorMessage(err) } })
      );

      return { success: true, memberId: insertedMemberId ?? undefined };
      
    } catch (dbErr: unknown) {
      if ((dbErr as unknown as EarlyReturnError)?.__earlyReturn) {
        return (dbErr as unknown as EarlyReturnError).result;
      }
      logger.error('[GroupBilling] DB transaction failed:', { error: dbErr });
      return { success: false, error: 'System error. Please try again.' };
    }
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error adding corporate member:', { error: err });
    return { success: false, error: 'Failed to add corporate member. Please try again.' };
  }
}

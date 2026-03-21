import { db } from '../../db';
import { billingGroups, groupMembers } from '../../../shared/models/hubspot-billing';
import { eq, and, sql } from 'drizzle-orm';
import { getStripeClient } from './client';
import Stripe from 'stripe';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import { toTextArrayLiteral } from '../../utils/sqlArrayLiteral';
import {
  getCorporateVolumePrice,
  type MemberRecordRow,
  type RemainingCountRow,
  type GroupBillingRow,
  type EarlyReturnError,
} from './groupBillingCrud';

export async function removeCorporateMember(params: {
  billingGroupId: number;
  memberEmail: string;
  removedBy: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    let primaryStripeSubscriptionId: string | null = null;
    let newMemberCount = 0;
    let memberId: number | null = null;
    
    await db.transaction(async (tx) => {
      const groupResult = await tx.execute(
        sql`SELECT id, primary_stripe_subscription_id FROM billing_groups WHERE id = ${params.billingGroupId} FOR UPDATE`
      );
      const group = groupResult.rows as unknown as GroupBillingRow[];

      const memberResult = await tx.execute(
        sql`SELECT gm.id, gm.member_email, gm.is_active
         FROM group_members gm
         WHERE gm.billing_group_id = ${params.billingGroupId} AND LOWER(gm.member_email) = ${params.memberEmail.toLowerCase()}
         FOR UPDATE`
      );
    
      if (memberResult.rows.length === 0) {
        throw Object.assign(new Error('Member not found in this billing group'), { __earlyReturn: true, result: { success: false, error: 'Member not found in this billing group' } });
      }
    
      const memberRecord = memberResult.rows[0] as unknown as MemberRecordRow;
      memberId = memberRecord.id as number;
    
      if (!memberRecord.is_active) {
        throw Object.assign(new Error('Member is already inactive'), { __earlyReturn: true, result: { success: false, error: 'Member is already inactive' } });
      }
    
      await tx.execute(
        sql`UPDATE group_members SET is_active = false, removed_at = NOW() WHERE id = ${memberRecord.id}`
      );
    
      await tx.execute(
        sql`UPDATE users SET billing_group_id = NULL, membership_status = 'cancelled', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'cancelled' THEN NOW() ELSE membership_status_changed_at END, last_tier = tier, tier = NULL, updated_at = NOW() WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
      );
    
      if (group.length > 0 && group[0].primary_stripe_subscription_id) {
        primaryStripeSubscriptionId = group[0].primary_stripe_subscription_id as string;
        
        const remainingResult = await tx.execute(
          sql`SELECT COUNT(*) as cnt FROM group_members WHERE billing_group_id = ${params.billingGroupId} AND is_active = true`
        );
        
        newMemberCount = Math.max(parseInt((remainingResult.rows[0] as unknown as RemainingCountRow).cnt as string, 10), 5);
      }
    });
    
    if (primaryStripeSubscriptionId) {
      let newStripeItemId: string | null = null;
      try {
        const newPricePerSeat = getCorporateVolumePrice(newMemberCount);
        
        const stripe = await getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(primaryStripeSubscriptionId, {
          expand: ['items.data'],
        });
      
        const corporateItem = subscription.items.data.find(
          item => item.metadata?.corporate_membership === 'true'
        );
      
        if (corporateItem) {
          const oldPricePerSeat = corporateItem.price?.unit_amount ?? 0;
          if (!oldPricePerSeat) {
            logger.error(`[GroupBilling] Corporate seat price is missing from Stripe subscription item ${corporateItem.id} — cannot adjust`);
            throw new Error('Corporate seat price not found on Stripe subscription item');
          }
        
          if (oldPricePerSeat !== newPricePerSeat) {
            logger.info(`[GroupBilling] Price tier change on removal: ${oldPricePerSeat} -> ${newPricePerSeat} cents/seat for ${newMemberCount} members`);
          
            const newItem = await stripe.subscriptionItems.create({
              subscription: primaryStripeSubscriptionId,
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
            }, { idempotencyKey: `subitem_corp_remove_${primaryStripeSubscriptionId}_${newPricePerSeat}_${newMemberCount}_${Math.floor(Date.now() / 300000)}` });

            newStripeItemId = newItem.id;
          
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
        logger.error('[GroupBilling] Failed to update Stripe on member removal:', { error: getErrorMessage(stripeErr) });
        if (newStripeItemId) {
          try {
            const stripeForRollback = await getStripeClient();
            await stripeForRollback.subscriptionItems.del(newStripeItemId, {
              proration_behavior: 'none',
            });
            logger.info(`[GroupBilling] Rolled back newly created Stripe subscription item ${newStripeItemId}`);
          } catch (rollbackErr: unknown) {
            logger.error(`[GroupBilling] CRITICAL: Failed to delete newly created Stripe subscription item ${newStripeItemId}. Customer may be double-billed. Manual intervention required.`, { error: getErrorMessage(rollbackErr) });
          }
        }
        try {
          await db.execute(
            sql`UPDATE group_members SET is_active = true, removed_at = NULL WHERE id = ${memberId}`
          );
          await db.execute(
            sql`UPDATE users SET billing_group_id = ${params.billingGroupId}, membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, tier = last_tier, last_tier = NULL, updated_at = NOW() WHERE LOWER(email) = ${params.memberEmail.toLowerCase()}`
          );
        } catch (compensateErr: unknown) {
          logger.error(`[GroupBilling] CRITICAL: Failed to compensate DB after Stripe failure. Manual intervention required.`, { error: getErrorMessage(compensateErr) });
        }
        return { success: false, error: 'Failed to update billing. Please try again.' };
      }
    }
    
    logger.info(`[GroupBilling] Successfully removed corporate member ${params.memberEmail}`);
    return { success: true };
  } catch (err: unknown) {
    if ((err as unknown as EarlyReturnError)?.__earlyReturn) {
      return (err as unknown as EarlyReturnError).result;
    }
    logger.error('[GroupBilling] Error removing corporate member:', { error: getErrorMessage(err) });
    return { success: false, error: 'Failed to remove member. Please try again.' };
  }
}

export async function removeGroupMember(params: {
  memberId: number;
  removedBy: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    let stripeSubscriptionItemId: string | null = null;
    let memberEmail: string | null = null;
    let billingGroupId: number | null = null;
    
    await db.transaction(async (tx) => {
      const memberResult = await tx.execute(
        sql`SELECT gm.id, gm.member_email, gm.stripe_subscription_item_id, gm.is_active, gm.billing_group_id
         FROM group_members gm
         WHERE gm.id = ${params.memberId}
         FOR UPDATE`
      );
    
      if (memberResult.rows.length === 0) {
        throw Object.assign(new Error('Group member not found'), { __earlyReturn: true, result: { success: false, error: 'Group member not found' } });
      }
    
      const memberRecord = memberResult.rows[0] as unknown as MemberRecordRow;
    
      if (!memberRecord.is_active) {
        throw Object.assign(new Error('Member is already inactive'), { __earlyReturn: true, result: { success: false, error: 'Member is already inactive' } });
      }
    
      memberEmail = (memberRecord.member_email as string).toLowerCase();
      billingGroupId = memberRecord.billing_group_id as number;
      stripeSubscriptionItemId = (memberRecord.stripe_subscription_item_id as string) || null;
    
      await tx.execute(
        sql`UPDATE group_members SET is_active = false, removed_at = NOW() WHERE id = ${params.memberId}`
      );
    
      await tx.execute(
        sql`UPDATE users SET billing_group_id = NULL, membership_status = 'cancelled', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'cancelled' THEN NOW() ELSE membership_status_changed_at END, last_tier = tier, tier = NULL, updated_at = NOW() WHERE LOWER(email) = ${memberEmail}`
      );
    });
    
    if (stripeSubscriptionItemId) {
      try {
        const stripe = await getStripeClient();
        await stripe.subscriptionItems.del(stripeSubscriptionItemId);
        logger.info(`[GroupBilling] Deleted Stripe subscription item ${stripeSubscriptionItemId}`);
      } catch (stripeErr: unknown) {
        logger.error('[GroupBilling] Failed to remove Stripe subscription item:', { error: getErrorMessage(stripeErr) });
        try {
          await db.execute(
            sql`UPDATE group_members SET is_active = true, removed_at = NULL WHERE id = ${params.memberId}`
          );
          if (memberEmail && billingGroupId) {
            await db.execute(
              sql`UPDATE users SET billing_group_id = ${billingGroupId}, membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, tier = last_tier, last_tier = NULL, updated_at = NOW() WHERE LOWER(email) = ${memberEmail}`
            );
          }
        } catch (compensateErr: unknown) {
          logger.error(`[GroupBilling] CRITICAL: Failed to compensate DB after Stripe failure. Manual intervention required.`, { error: getErrorMessage(compensateErr) });
        }
        return { success: false, error: 'Cannot remove billing. Member is still being charged. Please try again or contact support.' };
      }
    }
    
    logger.info(`[GroupBilling] Successfully removed group member ${params.memberId}`);
    return { success: true };
  } catch (err: unknown) {
    if ((err as unknown as EarlyReturnError)?.__earlyReturn) {
      return (err as unknown as EarlyReturnError).result;
    }
    logger.error('[GroupBilling] Error removing group member:', { error: getErrorMessage(err) });
    return { success: false, error: 'Failed to remove member. Please try again.' };
  }
}

export const removeFamilyMember = removeGroupMember;

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
                  } as Partial<typeof groupMembers.$inferInsert>)
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
                  } as Partial<typeof groupMembers.$inferInsert>)
                  .where(eq(groupMembers.id, member.id));
                
                await db.execute(
                  sql`UPDATE users SET billing_group_id = NULL WHERE LOWER(email) = ${member.memberEmail.toLowerCase()}`
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
                } as Partial<typeof groupMembers.$inferInsert>)
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
                } as Partial<typeof groupMembers.$inferInsert>)
                .where(eq(groupMembers.id, inactiveMember[0].id));
              
              await db.execute(
                sql`UPDATE users SET billing_group_id = ${group.id} WHERE LOWER(email) = ${email}`
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
              const tierFromMetadata = item.metadata?.tier || null;
              if (!tierFromMetadata) {
                logger.warn('[GroupBilling] Stripe item has no tier in metadata, using null', { extra: { itemId: item.id, email } });
              }
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
              
              await db.execute(
                sql`UPDATE users SET billing_group_id = ${group.id} WHERE LOWER(email) = ${email}`
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
    const _previousItemIds = new Set(previousItems.map(i => i.id));
    
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
        const existingItemForEmail = currentEmailToItemMap.get(memberEmail);
        if (existingItemForEmail) {
          logger.warn(`[GroupBilling] Skipping deactivation for ${memberEmail} - item ${item.id} removed but ` +
            `member still has active item ${existingItemForEmail.id}. Item may have been modified, not cancelled.`);
          
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
              } as Partial<typeof groupMembers.$inferInsert>)
              .where(eq(groupMembers.id, member[0].id));
            logger.info(`[GroupBilling] Updated member ${memberEmail} subscription item ID from ${item.id} to ${existingItemForEmail.id}`);
          }
          continue;
        }
        
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
          
          await db.execute(
            sql`UPDATE users SET billing_group_id = NULL WHERE LOWER(email) = ${memberEmail}`
          );
          
          logger.info(`[GroupBilling] Auto-deactivated member ${memberEmail} - subscription item ${item.id} fully removed`);
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[GroupBilling] Error handling subscription items change:', { error: getErrorMessage(err) });
  }
}

/**
 * CRITICAL: Handles the scenario where the Primary Member cancels their subscription entirely.
 * This ensures Sub-Members do not retain free access when the primary payer leaves.
 * This function should be called from the customer.subscription.deleted webhook.
 */
export async function handlePrimarySubscriptionCancelled(subscriptionId: string): Promise<void> {
  try {
    const group = await db.select()
      .from(billingGroups)
      .where(eq(billingGroups.primaryStripeSubscriptionId, subscriptionId))
      .limit(1);

    if (group.length === 0) {
      return;
    }

    const groupId = group[0].id;
    logger.info(`[GroupBilling] Primary subscription ${subscriptionId} cancelled. Deactivating group ${groupId}...`);

    const activeMembers = await db.select()
      .from(groupMembers)
      .where(and(
        eq(groupMembers.billingGroupId, groupId),
        eq(groupMembers.isActive, true)
      ));

    if (activeMembers.length === 0) {
      logger.info(`[GroupBilling] No active members in group ${groupId} - nothing to deactivate`);
      return;
    }

    const emailsToDeactivate = activeMembers.map(m => m.memberEmail.toLowerCase());

    await db.transaction(async (tx) => {
      await tx.update(groupMembers)
        .set({
          isActive: false,
          removedAt: new Date(),
        })
        .where(eq(groupMembers.billingGroupId, groupId));

      if (emailsToDeactivate.length > 0) {
        await tx.execute(
          sql`UPDATE users SET 
             billing_group_id = NULL,
             membership_status = 'cancelled',
             membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'cancelled' THEN NOW() ELSE membership_status_changed_at END,
             billing_provider = 'stripe',
             last_tier = tier,
             tier = NULL,
             updated_at = NOW()
           WHERE LOWER(email) = ANY(${toTextArrayLiteral(emailsToDeactivate)}::text[])`
        );
      }

      await tx.execute(
        sql`UPDATE billing_groups SET is_active = false, updated_at = NOW() WHERE id = ${groupId} AND is_active = true`
      );
    });

    if (emailsToDeactivate.length > 0) {
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        for (const subEmail of emailsToDeactivate) {
          await syncMemberToHubSpot({ email: subEmail, status: 'cancelled', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
        }
        logger.info(`[GroupBilling] Synced ${emailsToDeactivate.length} cancelled sub-members to HubSpot`);
      } catch (hubspotErr: unknown) {
        logger.error('[GroupBilling] HubSpot sync failed for cancelled sub-members:', { error: getErrorMessage(hubspotErr) });
      }
    }

    logger.info(`[GroupBilling] Successfully deactivated group ${groupId} and ${emailsToDeactivate.length} members`);

  } catch (err: unknown) {
    logger.error('[GroupBilling] Error handling primary subscription cancellation:', { error: getErrorMessage(err) });
    throw err;
  }
}

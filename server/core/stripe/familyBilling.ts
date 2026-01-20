import { pool } from '../db';
import { db } from '../../db';
import { familyGroups, familyMembers, familyAddOnProducts } from '../../../shared/models/hubspot-billing';
import { eq, and } from 'drizzle-orm';
import { getStripeClient } from './client';
import Stripe from 'stripe';

export interface FamilyGroupWithMembers {
  id: number;
  primaryEmail: string;
  primaryName: string;
  groupName: string | null;
  stripeSubscriptionId: string | null;
  members: FamilyMemberInfo[];
  totalMonthlyAmount: number;
  isActive: boolean;
}

export interface FamilyMemberInfo {
  id: number;
  memberEmail: string;
  memberName: string;
  memberTier: string;
  relationship: string | null;
  addOnPriceCents: number;
  isActive: boolean;
  addedAt: Date | null;
}

export async function syncFamilyAddOnProductsToStripe(): Promise<{
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
            name: product.displayName || `Family Add-on - ${product.tierName}`,
            description: product.description || `Family add-on membership for ${product.tierName} tier`,
            metadata: {
              family_addon: 'true',
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
              family_addon: 'true',
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
      } catch (err: any) {
        errors.push(`Failed to sync ${product.tierName}: ${err.message}`);
      }
    }
    
    return { success: errors.length === 0, synced, errors };
  } catch (err: any) {
    return { success: false, synced, errors: [err.message] };
  }
}

export async function getFamilyAddOnProducts(): Promise<typeof familyAddOnProducts.$inferSelect[]> {
  return db.select().from(familyAddOnProducts).where(eq(familyAddOnProducts.isActive, true));
}

export async function getFamilyGroupByPrimaryEmail(primaryEmail: string): Promise<FamilyGroupWithMembers | null> {
  const group = await db.select()
    .from(familyGroups)
    .where(eq(familyGroups.primaryEmail, primaryEmail.toLowerCase()))
    .limit(1);
  
  if (group.length === 0) return null;
  
  const familyGroup = group[0];
  
  const members = await db.select()
    .from(familyMembers)
    .where(and(
      eq(familyMembers.familyGroupId, familyGroup.id),
      eq(familyMembers.isActive, true)
    ));
  
  const primaryUserResult = await pool.query(
    'SELECT first_name, last_name FROM users WHERE LOWER(email) = $1',
    [primaryEmail.toLowerCase()]
  );
  const primaryName = primaryUserResult.rows[0] 
    ? `${primaryUserResult.rows[0].first_name || ''} ${primaryUserResult.rows[0].last_name || ''}`.trim()
    : primaryEmail;
  
  const memberInfos: FamilyMemberInfo[] = [];
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
    id: familyGroup.id,
    primaryEmail: familyGroup.primaryEmail,
    primaryName,
    groupName: familyGroup.groupName,
    stripeSubscriptionId: familyGroup.primaryStripeSubscriptionId,
    members: memberInfos,
    totalMonthlyAmount,
    isActive: familyGroup.isActive ?? true,
  };
}

export async function getFamilyGroupByMemberEmail(memberEmail: string): Promise<FamilyGroupWithMembers | null> {
  const member = await db.select()
    .from(familyMembers)
    .where(and(
      eq(familyMembers.memberEmail, memberEmail.toLowerCase()),
      eq(familyMembers.isActive, true)
    ))
    .limit(1);
  
  if (member.length === 0) {
    const asGroup = await getFamilyGroupByPrimaryEmail(memberEmail);
    return asGroup;
  }
  
  const group = await db.select()
    .from(familyGroups)
    .where(eq(familyGroups.id, member[0].familyGroupId))
    .limit(1);
  
  if (group.length === 0) return null;
  
  return getFamilyGroupByPrimaryEmail(group[0].primaryEmail);
}

export async function createFamilyGroup(params: {
  primaryEmail: string;
  groupName?: string;
  createdBy: string;
  createdByName: string;
}): Promise<{ success: boolean; groupId?: number; error?: string }> {
  try {
    const existingGroup = await db.select()
      .from(familyGroups)
      .where(eq(familyGroups.primaryEmail, params.primaryEmail.toLowerCase()))
      .limit(1);
    
    if (existingGroup.length > 0) {
      return { success: false, error: 'A family group already exists for this member' };
    }
    
    const primaryUserResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE LOWER(email) = $1',
      [params.primaryEmail.toLowerCase()]
    );
    
    const stripeCustomerId = primaryUserResult.rows[0]?.stripe_customer_id || null;
    
    const result = await db.insert(familyGroups).values({
      primaryEmail: params.primaryEmail.toLowerCase(),
      primaryStripeCustomerId: stripeCustomerId,
      groupName: params.groupName || null,
      createdBy: params.createdBy,
      createdByName: params.createdByName,
    }).returning({ id: familyGroups.id });
    
    await pool.query(
      'UPDATE users SET family_group_id = $1, is_family_primary = true WHERE LOWER(email) = $2',
      [result[0].id, params.primaryEmail.toLowerCase()]
    );
    
    return { success: true, groupId: result[0].id };
  } catch (err: any) {
    console.error('[FamilyBilling] Error creating family group:', err);
    return { success: false, error: err.message };
  }
}

export async function addFamilyMember(params: {
  familyGroupId: number;
  memberEmail: string;
  memberTier: string;
  relationship?: string;
  addedBy: string;
  addedByName: string;
}): Promise<{ success: boolean; memberId?: number; error?: string }> {
  try {
    const existingMember = await db.select()
      .from(familyMembers)
      .where(and(
        eq(familyMembers.memberEmail, params.memberEmail.toLowerCase()),
        eq(familyMembers.isActive, true)
      ))
      .limit(1);
    
    if (existingMember.length > 0) {
      return { success: false, error: 'This member is already part of a family group' };
    }
    
    const addOnProduct = await db.select()
      .from(familyAddOnProducts)
      .where(eq(familyAddOnProducts.tierName, params.memberTier))
      .limit(1);
    
    if (addOnProduct.length === 0) {
      return { success: false, error: `No family add-on product found for tier: ${params.memberTier}` };
    }
    
    const product = addOnProduct[0];
    
    const group = await db.select()
      .from(familyGroups)
      .where(eq(familyGroups.id, params.familyGroupId))
      .limit(1);
    
    if (group.length === 0) {
      return { success: false, error: 'Family group not found' };
    }
    
    let stripeSubscriptionItemId: string | null = null;
    
    if (group[0].primaryStripeSubscriptionId && product.stripePriceId) {
      try {
        const stripe = await getStripeClient();
        const subscriptionItem = await stripe.subscriptionItems.create({
          subscription: group[0].primaryStripeSubscriptionId,
          price: product.stripePriceId,
          quantity: 1,
          metadata: {
            family_member_email: params.memberEmail.toLowerCase(),
            family_group_id: params.familyGroupId.toString(),
            tier: params.memberTier,
          },
        });
        stripeSubscriptionItemId = subscriptionItem.id;
      } catch (stripeErr: any) {
        console.error('[FamilyBilling] Error adding Stripe subscription item:', stripeErr);
        return { success: false, error: `Failed to add billing: ${stripeErr.message}` };
      }
    } else if (group[0].primaryStripeSubscriptionId && !product.stripePriceId) {
      return { success: false, error: 'Family add-on product not synced to Stripe. Please sync products first.' };
    }
    
    const result = await db.insert(familyMembers).values({
      familyGroupId: params.familyGroupId,
      memberEmail: params.memberEmail.toLowerCase(),
      memberTier: params.memberTier,
      relationship: params.relationship || null,
      stripeSubscriptionItemId,
      stripePriceId: product.stripePriceId,
      addOnPriceCents: product.priceCents,
      addedBy: params.addedBy,
      addedByName: params.addedByName,
    }).returning({ id: familyMembers.id });
    
    await pool.query(
      'UPDATE users SET family_group_id = $1, is_family_primary = false WHERE LOWER(email) = $2',
      [params.familyGroupId, params.memberEmail.toLowerCase()]
    );
    
    return { success: true, memberId: result[0].id };
  } catch (err: any) {
    console.error('[FamilyBilling] Error adding family member:', err);
    return { success: false, error: err.message };
  }
}

export async function removeFamilyMember(params: {
  memberId: number;
  removedBy: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const member = await db.select()
      .from(familyMembers)
      .where(eq(familyMembers.id, params.memberId))
      .limit(1);
    
    if (member.length === 0) {
      return { success: false, error: 'Family member not found' };
    }
    
    const memberRecord = member[0];
    
    if (memberRecord.stripeSubscriptionItemId) {
      try {
        const stripe = await getStripeClient();
        await stripe.subscriptionItems.del(memberRecord.stripeSubscriptionItemId);
      } catch (stripeErr: any) {
        console.error('[FamilyBilling] Error removing Stripe subscription item:', stripeErr);
      }
    }
    
    await db.update(familyMembers)
      .set({
        isActive: false,
        removedAt: new Date(),
      })
      .where(eq(familyMembers.id, params.memberId));
    
    await pool.query(
      'UPDATE users SET family_group_id = NULL, is_family_primary = false WHERE LOWER(email) = $1',
      [memberRecord.memberEmail.toLowerCase()]
    );
    
    return { success: true };
  } catch (err: any) {
    console.error('[FamilyBilling] Error removing family member:', err);
    return { success: false, error: err.message };
  }
}

export async function linkStripeSubscriptionToFamilyGroup(params: {
  familyGroupId: number;
  stripeSubscriptionId: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    await db.update(familyGroups)
      .set({
        primaryStripeSubscriptionId: params.stripeSubscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(familyGroups.id, params.familyGroupId));
    
    return { success: true };
  } catch (err: any) {
    console.error('[FamilyBilling] Error linking subscription:', err);
    return { success: false, error: err.message };
  }
}

export async function updateFamilyAddOnPricing(params: {
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
        displayName: `Family Add-on - ${params.tierName}`,
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
              family_addon: 'true',
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
        } catch (stripeErr: any) {
          console.error('[FamilyBilling] Error creating new Stripe price:', stripeErr);
          return { success: false, error: stripeErr.message };
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
  } catch (err: any) {
    console.error('[FamilyBilling] Error updating pricing:', err);
    return { success: false, error: err.message };
  }
}

export async function getAllFamilyGroups(): Promise<FamilyGroupWithMembers[]> {
  const groups = await db.select()
    .from(familyGroups)
    .where(eq(familyGroups.isActive, true));
  
  const result: FamilyGroupWithMembers[] = [];
  
  for (const group of groups) {
    const fullGroup = await getFamilyGroupByPrimaryEmail(group.primaryEmail);
    if (fullGroup) {
      result.push(fullGroup);
    }
  }
  
  return result;
}

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
  familyGroupId: number;
  primaryEmail: string;
  action: 'deactivated' | 'reactivated' | 'relinked' | 'error' | 'ok';
  memberEmail?: string;
  reason: string;
}

export async function reconcileFamilyBillingWithStripe(): Promise<ReconciliationResult> {
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
      .from(familyGroups)
      .where(eq(familyGroups.isActive, true));
    
    for (const group of activeGroups) {
      result.groupsChecked++;
      
      if (!group.primaryStripeSubscriptionId) {
        result.details.push({
          familyGroupId: group.id,
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
          const familyEmail = item.metadata?.family_member_email?.toLowerCase();
          if (familyEmail) {
            stripeEmailToItemMap.set(familyEmail, item);
          }
        }
        
        const localMembers = await db.select()
          .from(familyMembers)
          .where(and(
            eq(familyMembers.familyGroupId, group.id),
            eq(familyMembers.isActive, true)
          ));
        
        for (const member of localMembers) {
          if (member.stripeSubscriptionItemId) {
            if (!stripeItemsMap.has(member.stripeSubscriptionItemId)) {
              const stripeItem = stripeEmailToItemMap.get(member.memberEmail.toLowerCase());
              if (stripeItem) {
                await db.update(familyMembers)
                  .set({
                    stripeSubscriptionItemId: stripeItem.id,
                    updatedAt: new Date(),
                  })
                  .where(eq(familyMembers.id, member.id));
                
                result.itemsRelinked++;
                result.details.push({
                  familyGroupId: group.id,
                  primaryEmail: group.primaryEmail,
                  action: 'relinked',
                  memberEmail: member.memberEmail,
                  reason: `Subscription item ID updated from ${member.stripeSubscriptionItemId} to ${stripeItem.id}`,
                });
              } else {
                await db.update(familyMembers)
                  .set({
                    isActive: false,
                    removedAt: new Date(),
                  })
                  .where(eq(familyMembers.id, member.id));
                
                await pool.query(
                  'UPDATE users SET family_group_id = NULL, is_family_primary = false WHERE LOWER(email) = $1',
                  [member.memberEmail.toLowerCase()]
                );
                
                result.membersDeactivated++;
                result.details.push({
                  familyGroupId: group.id,
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
              await db.update(familyMembers)
                .set({
                  stripeSubscriptionItemId: stripeItem.id,
                  updatedAt: new Date(),
                })
                .where(eq(familyMembers.id, member.id));
              
              result.itemsRelinked++;
              result.details.push({
                familyGroupId: group.id,
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
              .from(familyMembers)
              .where(and(
                eq(familyMembers.familyGroupId, group.id),
                eq(familyMembers.memberEmail, email),
                eq(familyMembers.isActive, false)
              ))
              .limit(1);
            
            if (inactiveMember.length > 0) {
              await db.update(familyMembers)
                .set({
                  isActive: true,
                  stripeSubscriptionItemId: item.id,
                  removedAt: null,
                  updatedAt: new Date(),
                })
                .where(eq(familyMembers.id, inactiveMember[0].id));
              
              await pool.query(
                'UPDATE users SET family_group_id = $1 WHERE LOWER(email) = $2',
                [group.id, email]
              );
              
              result.membersReactivated++;
              result.details.push({
                familyGroupId: group.id,
                primaryEmail: group.primaryEmail,
                action: 'reactivated',
                memberEmail: email,
                reason: 'Found active Stripe item, reactivated member',
              });
            } else {
              const tierFromMetadata = item.metadata?.tier || 'Social';
              const priceInfo = item.price;
              const priceCents = priceInfo?.unit_amount || 0;
              
              await db.insert(familyMembers).values({
                familyGroupId: group.id,
                memberEmail: email,
                memberTier: tierFromMetadata,
                stripeSubscriptionItemId: item.id,
                stripePriceId: priceInfo?.id || null,
                addOnPriceCents: priceCents,
                addedBy: 'system-reconcile',
                addedByName: 'Stripe Reconciliation',
              });
              
              await pool.query(
                'UPDATE users SET family_group_id = $1, is_family_primary = false WHERE LOWER(email) = $2',
                [group.id, email]
              );
              
              result.membersCreated++;
              result.details.push({
                familyGroupId: group.id,
                primaryEmail: group.primaryEmail,
                action: 'reactivated',
                memberEmail: email,
                reason: `Created new family member from Stripe item (tier: ${tierFromMetadata})`,
              });
            }
          }
        }
        
      } catch (stripeErr: any) {
        result.errors.push(`Group ${group.id} (${group.primaryEmail}): ${stripeErr.message}`);
        result.details.push({
          familyGroupId: group.id,
          primaryEmail: group.primaryEmail,
          action: 'error',
          reason: stripeErr.message,
        });
      }
    }
    
    result.success = result.errors.length === 0;
    return result;
  } catch (err: any) {
    return {
      success: false,
      groupsChecked: result.groupsChecked,
      membersDeactivated: result.membersDeactivated,
      membersReactivated: result.membersReactivated,
      membersCreated: result.membersCreated,
      itemsRelinked: result.itemsRelinked,
      errors: [err.message],
      details: result.details,
    };
  }
}

export async function handleSubscriptionItemsChanged(params: {
  subscriptionId: string;
  currentItems: Array<{ id: string; metadata?: Record<string, string> }>;
  previousItems?: Array<{ id: string; metadata?: Record<string, string> }>;
}): Promise<{ deactivated: string[]; added: string[] }> {
  const result = { deactivated: [] as string[], added: [] as string[] };
  
  try {
    const group = await db.select()
      .from(familyGroups)
      .where(eq(familyGroups.primaryStripeSubscriptionId, params.subscriptionId))
      .limit(1);
    
    if (group.length === 0) {
      return result;
    }
    
    const familyGroupId = group[0].id;
    const currentItemIds = new Set(params.currentItems.map(i => i.id));
    
    if (params.previousItems) {
      for (const prevItem of params.previousItems) {
        if (!currentItemIds.has(prevItem.id)) {
          const familyEmail = prevItem.metadata?.family_member_email?.toLowerCase();
          
          if (familyEmail) {
            const member = await db.select()
              .from(familyMembers)
              .where(and(
                eq(familyMembers.familyGroupId, familyGroupId),
                eq(familyMembers.stripeSubscriptionItemId, prevItem.id),
                eq(familyMembers.isActive, true)
              ))
              .limit(1);
            
            if (member.length > 0) {
              await db.update(familyMembers)
                .set({
                  isActive: false,
                  removedAt: new Date(),
                })
                .where(eq(familyMembers.id, member[0].id));
              
              await pool.query(
                'UPDATE users SET family_group_id = NULL, is_family_primary = false WHERE LOWER(email) = $1',
                [familyEmail]
              );
              
              result.deactivated.push(familyEmail);
              console.log(`[FamilyBilling] Deactivated family member ${familyEmail} - Stripe item ${prevItem.id} was removed`);
            }
          }
        }
      }
    }
    
    return result;
  } catch (err: any) {
    console.error('[FamilyBilling] Error handling subscription items changed:', err);
    return result;
  }
}

import { db } from '../db';
import { users } from '../../shared/schema';
import { eq, and, isNotNull, isNull, sql } from 'drizzle-orm';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';

export interface BillingClassification {
  stripe: MemberBillingInfo[];
  mindbody: MemberBillingInfo[];
  manual: MemberBillingInfo[];
  unclassified: MemberBillingInfo[];
}

export interface MemberBillingInfo {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  tier: string | null;
  billingProvider: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  mindbodyClientId: string | null;
  membershipStatus: string | null;
}

export async function classifyMembersByBilling(): Promise<BillingClassification> {
  const allMembers = await db.select({
    id: users.id,
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
    tier: users.tier,
    billingProvider: users.billingProvider,
    stripeCustomerId: users.stripeCustomerId,
    stripeSubscriptionId: users.stripeSubscriptionId,
    mindbodyClientId: users.mindbodyClientId,
    membershipStatus: users.membershipStatus,
  })
    .from(users)
    .where(and(
      // Include trialing and past_due as active - they still have membership access
      sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due') OR ${users.stripeSubscriptionId} IS NOT NULL)`,
      isNull(users.archivedAt)
    ));

  const classification: BillingClassification = {
    stripe: [],
    mindbody: [],
    manual: [],
    unclassified: [],
  };

  for (const member of allMembers) {
    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId) {
      classification.stripe.push(member);
    } else if (member.billingProvider === 'mindbody' || member.mindbodyClientId) {
      classification.mindbody.push(member);
    } else if (member.billingProvider === 'manual') {
      classification.manual.push(member);
    } else if (member.stripeCustomerId && !member.stripeSubscriptionId) {
      classification.stripe.push(member);
    } else {
      classification.unclassified.push(member);
    }
  }

  return classification;
}

export async function getBillingClassificationSummary(): Promise<{
  total: number;
  stripe: { count: number; hasSubscription: number; noSubscription: number };
  mindbody: { count: number };
  manual: { count: number };
  unclassified: { count: number };
  needsMigration: number;
}> {
  const classification = await classifyMembersByBilling();
  
  const stripeWithSub = classification.stripe.filter(m => m.stripeSubscriptionId).length;
  const stripeNoSub = classification.stripe.filter(m => !m.stripeSubscriptionId).length;
  
  return {
    total: classification.stripe.length + classification.mindbody.length + 
           classification.manual.length + classification.unclassified.length,
    stripe: {
      count: classification.stripe.length,
      hasSubscription: stripeWithSub,
      noSubscription: stripeNoSub,
    },
    mindbody: {
      count: classification.mindbody.length,
    },
    manual: {
      count: classification.manual.length,
    },
    unclassified: {
      count: classification.unclassified.length,
    },
    needsMigration: stripeNoSub + classification.mindbody.length + 
                     classification.manual.length + classification.unclassified.length,
  };
}

export async function getMembersNeedingStripeMigration(): Promise<MemberBillingInfo[]> {
  const classification = await classifyMembersByBilling();
  
  return [
    ...classification.stripe.filter(m => !m.stripeSubscriptionId),
    ...classification.mindbody,
    ...classification.manual,
    ...classification.unclassified,
  ];
}

export async function updateMemberBillingProvider(
  memberId: string, 
  billingProvider: 'stripe' | 'mindbody' | 'manual'
): Promise<{ success: boolean; error?: string }> {
  try {
    await db.update(users)
      .set({ billingProvider, updatedAt: new Date() })
      .where(eq(users.id, memberId));
    
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function bulkClassifyMindbodyMembers(): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;
  
  try {
    const result = await db.update(users)
      .set({ billingProvider: 'mindbody', updatedAt: new Date() })
      .where(and(
        isNotNull(users.mindbodyClientId),
        isNull(users.stripeSubscriptionId),
        sql`${users.billingProvider} IS NULL OR ${users.billingProvider} = ''`
      ));
    
    updated = (result as Record<string, unknown>).count as number || 0;
    logger.info(`[BillingClassify] Updated ${updated} members with Mindbody IDs to mindbody provider`);
    
    return { updated, errors };
  } catch (error: unknown) {
    errors.push(getErrorMessage(error));
    return { updated, errors };
  }
}

import { db } from '../server/db';
import { users } from '../shared/schema';
import { eq, and, isNull, notLike } from 'drizzle-orm';
import { getHubSpotClient } from '../server/core/integrations';
import pRetry, { AbortError } from 'p-retry';

const HUBSPOT_TO_CANONICAL: Record<string, string> = {
  'Core Membership': 'Core',
  'Premium Membership': 'Premium',
  'Social Membership': 'Social',
  'VIP Membership': 'VIP',
  'Corporate Membership': 'Corporate',
  'Group Lessons Membership': 'Group Lessons',
};

function safeHubSpotTierToCanonical(hubspotTier: string): string | null {
  const canonical = HUBSPOT_TO_CANONICAL[hubspotTier];
  if (canonical) return canonical;
  
  const trimmed = hubspotTier.trim().toLowerCase();
  for (const [key, value] of Object.entries(HUBSPOT_TO_CANONICAL)) {
    if (trimmed === key.toLowerCase()) return value;
    if (trimmed.includes(value.toLowerCase())) return value;
  }
  
  return null;
}

async function retryableHubSpotRequest<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 3,
    onFailedAttempt: (error: any) => {
      if (error.code === 429) {
        console.log(`[HubSpot] Rate limited, retrying...`);
      }
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new AbortError('HubSpot authentication failed');
      }
    }
  });
}

async function run() {
  console.log('[Tier Fix] Pulling tiers from HubSpot for members without tier...');
  
  const membersNeedingTier = await db.select({
    email: users.email,
    hubspotId: users.hubspotId
  })
  .from(users)
  .where(and(
    eq(users.role, 'member'),
    eq(users.membershipStatus, 'active'),
    isNull(users.tier),
    notLike(users.email, '%test%'),
    notLike(users.email, '%example.com')
  ));
  
  console.log(`[Tier Fix] Found ${membersNeedingTier.length} members needing tier`);
  
  const hubspot = await getHubSpotClient();
  let fixed = 0;
  
  for (const member of membersNeedingTier) {
    if (!member.hubspotId) {
      console.log(`  ${member.email}: No HubSpot ID, skipping`);
      continue;
    }
    
    try {
      const contact = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.getById(member.hubspotId!, ['membership_tier'])
      );
      
      const hubspotTier = contact.properties?.membership_tier;
      if (hubspotTier) {
        const canonicalTier = safeHubSpotTierToCanonical(hubspotTier);
        
        if (canonicalTier) {
          await db.update(users)
            .set({ tier: canonicalTier })
            .where(eq(users.email, member.email));
          
          console.log(`  ${member.email}: Set tier to "${canonicalTier}" (from HubSpot: "${hubspotTier}")`);
          fixed++;
        } else {
          console.log(`  ${member.email}: Unknown tier in HubSpot "${hubspotTier}", skipping`);
        }
      } else {
        console.log(`  ${member.email}: No tier in HubSpot`);
      }
    } catch (error: any) {
      console.log(`  ${member.email}: Error fetching HubSpot - ${error.message}`);
    }
  }
  
  console.log(`\n[Tier Fix] Fixed ${fixed} members`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });

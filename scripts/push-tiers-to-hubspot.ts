import { db } from '../server/db';
import { users } from '../shared/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getHubSpotClient } from '../server/core/integrations';
import pRetry, { AbortError } from 'p-retry';

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

async function pushTiersToHubSpot() {
  console.log('[Tier Push] Starting HubSpot tier push from database...');
  
  const hubspot = await getHubSpotClient();
  
  const members = await db.select({
    email: users.email,
    tier: users.tier,
    hubspotId: users.hubspotId,
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(and(
      isNotNull(users.hubspotId),
      eq(users.membershipStatus, 'active'),
      sql`${users.archivedAt} IS NULL`,
      isNotNull(users.tier)
    ));
  
  console.log(`[Tier Push] Found ${members.length} active members with HubSpot IDs and tiers`);
  
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails: string[] = [];
  
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    
    if (!member.hubspotId || !member.tier) {
      skipped++;
      continue;
    }
    
    try {
      await retryableHubSpotRequest(() => 
        hubspot.crm.contacts.basicApi.update(member.hubspotId!, {
          properties: { membership_tier: member.tier! }
        })
      );
      updated++;
      
      if ((updated + errors) % 25 === 0) {
        console.log(`[Tier Push] Progress: ${updated} updated, ${errors} errors (${i + 1}/${members.length})`);
      }
    } catch (err: any) {
      errors++;
      const msg = `${member.email}: ${err.message?.substring(0, 50)}`;
      if (errorDetails.length < 10) errorDetails.push(msg);
    }
    
    // Rate limiting delay - 100ms between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`\n[Tier Push] Complete!`);
  console.log(`  Total members: ${members.length}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
  
  if (errorDetails.length > 0) {
    console.log(`\n  Sample errors:`);
    errorDetails.forEach(e => console.log(`    - ${e}`));
  }
}

pushTiersToHubSpot()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

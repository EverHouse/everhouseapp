import pg from 'pg';
import { syncMemberToHubSpot } from '../server/core/hubspot/stages';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function backfillMembershipStartDates(dryRun = true) {
  console.log(`\n=== Backfill Membership Start Dates to HubSpot (${dryRun ? 'DRY RUN' : 'LIVE'}) ===\n`);
  
  const result = await pool.query(`
    SELECT id, email, created_at, membership_status, tier, billing_provider, hubspot_id
    FROM users 
    WHERE hubspot_id IS NOT NULL
      AND created_at IS NOT NULL
      AND membership_status IN ('active', 'trialing', 'past_due')
    ORDER BY created_at ASC
  `);
  
  console.log(`Found ${result.rows.length} active members to backfill\n`);
  
  let success = 0;
  let failed = 0;
  
  for (const member of result.rows) {
    const startDate = new Date(member.created_at);
    
    if (dryRun) {
      console.log(`[DRY RUN] ${member.email}: start_date=${startDate.toISOString().split('T')[0]}, tier=${member.tier || 'none'}, billing=${member.billing_provider || 'none'}`);
      success++;
    } else {
      try {
        const syncResult = await syncMemberToHubSpot({
          email: member.email,
          status: member.membership_status,
          tier: member.tier || undefined,
          billingProvider: member.billing_provider || undefined,
          memberSince: startDate
        });
        
        if (syncResult.success) {
          console.log(`✓ ${member.email}: start_date=${startDate.toISOString().split('T')[0]}`);
          success++;
        } else {
          console.log(`✗ ${member.email}: ${syncResult.error?.substring(0, 100)}`);
          failed++;
        }
        
        // Rate limit: ~6 per second for HubSpot
        await new Promise(r => setTimeout(r, 170));
      } catch (error: any) {
        console.log(`✗ ${member.email}: ${error.message?.substring(0, 100)}`);
        failed++;
      }
    }
  }
  
  console.log(`\n=== Summary ===`);
  console.log(`Success: ${success}`);
  console.log(`Failed: ${failed}`);
  
  await pool.end();
}

const dryRun = !process.argv.includes('--live');
backfillMembershipStartDates(dryRun).catch(console.error);

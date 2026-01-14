import { Client } from "@hubspot/api-client";
import pg from "pg";

const hubspotClient = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function pushTiers() {
  console.log("[Quick Push] Starting immediate tier push to HubSpot...");
  
  const result = await pool.query(`
    SELECT hubspot_id, membership_tier 
    FROM users 
    WHERE hubspot_id IS NOT NULL 
    AND membership_tier IS NOT NULL 
    AND membership_status = 'active'
  `);
  
  console.log(`[Quick Push] Found ${result.rows.length} members to push`);
  
  let updated = 0, errors = 0;
  const batchSize = 100;
  
  for (let i = 0; i < result.rows.length; i += batchSize) {
    const batch = result.rows.slice(i, i + batchSize);
    const inputs = batch.map(row => ({
      id: row.hubspot_id,
      properties: { membership_tier: row.membership_tier }
    }));
    
    try {
      await hubspotClient.crm.contacts.batchApi.update({ inputs });
      updated += batch.length;
      console.log(`[Quick Push] Batch ${Math.floor(i/batchSize)+1}: Updated ${batch.length} contacts`);
    } catch (e: any) {
      errors += batch.length;
      console.error(`[Quick Push] Batch error:`, e.message);
    }
    
    if (i + batchSize < result.rows.length) await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`[Quick Push] Complete - Updated: ${updated}, Errors: ${errors}`);
  await pool.end();
}

pushTiers().catch(console.error);

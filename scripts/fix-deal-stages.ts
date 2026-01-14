import { pool } from '../server/core/db';
import { hubspotClient } from '../server/core/hubspot/client';
import { HUBSPOT_STAGE_IDS, MINDBODY_TO_STAGE_MAP } from '../server/core/hubspot/constants';

async function fixDealStages() {
  console.log('[Fix] Finding non-member deals still in Active stage...');
  
  const result = await pool.query(`
    SELECT u.email, u.membership_status, hd.hubspot_deal_id, hd.id as local_id
    FROM users u
    JOIN hubspot_deals hd ON LOWER(u.email) = LOWER(hd.member_email)
    WHERE u.role = 'member'
      AND u.membership_status IN ('non-member', 'terminated', 'cancelled')
      AND hd.pipeline_stage = 'closedwon'
    LIMIT 200
  `);
  
  console.log(`[Fix] Found ${result.rows.length} deals to fix`);
  
  if (result.rows.length === 0) {
    const remaining = await pool.query(`
      SELECT COUNT(*) as count FROM hubspot_deals WHERE pipeline_stage = 'closedwon'
    `);
    console.log(`[Fix] ${remaining.rows[0].count} total deals in Active stage`);
    console.log('[Fix] All non-member deals have been fixed!');
    process.exit(0);
    return;
  }
  
  let updated = 0;
  let errors = 0;
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
    const batch = result.rows.slice(i, i + BATCH_SIZE);
    
    const results = await Promise.allSettled(
      batch.map(async (deal: any) => {
        try {
          await hubspotClient.crm.deals.basicApi.update(deal.hubspot_deal_id, {
            properties: {
              dealstage: HUBSPOT_STAGE_IDS.CLOSED_LOST
            }
          });
          
          await pool.query(`
            UPDATE hubspot_deals 
            SET pipeline_stage = $1, last_known_mindbody_status = $2, updated_at = NOW()
            WHERE id = $3
          `, [HUBSPOT_STAGE_IDS.CLOSED_LOST, deal.membership_status, deal.local_id]);
          
          return { success: true, email: deal.email };
        } catch (err: any) {
          if (err?.code === 404) {
            await pool.query(`DELETE FROM hubspot_deals WHERE id = $1`, [deal.local_id]);
            return { success: true, email: deal.email, deleted: true };
          }
          throw err;
        }
      })
    );
    
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value.success) {
        updated++;
      } else {
        errors++;
      }
    }
    
    console.log(`[Fix] Progress: ${Math.min(i + BATCH_SIZE, result.rows.length)}/${result.rows.length} (${updated} updated, ${errors} errors)`);
    
    if (i + BATCH_SIZE < result.rows.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  console.log(`[Fix] Batch complete - Updated: ${updated}, Errors: ${errors}`);
  
  const remainingCount = await pool.query(`
    SELECT COUNT(*) as count 
    FROM users u
    JOIN hubspot_deals hd ON LOWER(u.email) = LOWER(hd.member_email)
    WHERE u.role = 'member'
      AND u.membership_status IN ('non-member', 'terminated', 'cancelled')
      AND hd.pipeline_stage = 'closedwon'
  `);
  
  console.log(`[Fix] Remaining non-member deals in Active stage: ${remainingCount.rows[0].count}`);
  if (parseInt(remainingCount.rows[0].count) > 0) {
    console.log('[Fix] Run this script again to process more deals');
  }
  
  process.exit(0);
}

fixDealStages().catch(err => {
  console.error('[Error]', err);
  process.exit(1);
});

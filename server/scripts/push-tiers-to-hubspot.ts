/**
 * One-time script to push app tier data to HubSpot contacts
 * Run with: npx tsx server/scripts/push-tiers-to-hubspot.ts
 */
import { getHubSpotClient } from '../core/integrations';
import { retryableHubSpotRequest } from '../core/hubspot/request';
import { denormalizeTierForHubSpot } from '../utils/tierUtils';
import { pool } from '../core/db';

const memberIds = [
  'bca56a22-1a16-43b4-b866-51301cc33993',
  'def64473-75f4-44ca-997c-fd9704096213',
  '645f00ec-dd85-4343-996f-055a8de71bb4',
  'c9d0ed9c-211d-4629-b062-3991e016b94a',
  'd412b582-7853-49ff-b3e2-bbf4c0354fbf'
];

async function pushTiersToHubSpot() {
  console.log('Starting tier push to HubSpot...');
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, email, first_name, last_name, membership_tier, hubspot_id 
       FROM users 
       WHERE id = ANY($1)`,
      [memberIds]
    );
    
    const members = result.rows;
    console.log('Found ' + members.length + ' members to update');
    
    const hubspot = await getHubSpotClient();
    
    for (const member of members) {
      const name = member.first_name + ' ' + member.last_name;
      const hubspotTier = denormalizeTierForHubSpot(member.membership_tier);
      
      if (!member.hubspot_id) {
        console.log('Skipping ' + name + ': No HubSpot ID');
        continue;
      }
      
      if (!hubspotTier) {
        console.log('Skipping ' + name + ': Tier "' + member.membership_tier + '" has no valid HubSpot mapping');
        continue;
      }
      
      try {
        await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.update(member.hubspot_id, {
            properties: {
              membership_tier: hubspotTier
            }
          })
        );
        console.log('Updated ' + name + ': "' + member.membership_tier + '" -> "' + hubspotTier + '"');
      } catch (error: any) {
        console.error('Failed to update ' + name + ':', error.message);
      }
    }
    
    console.log('Done!');
  } finally {
    client.release();
  }
  
  process.exit(0);
}

pushTiersToHubSpot();

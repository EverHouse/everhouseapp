import { db } from '../db';
import { users, membershipTiers } from '../../shared/schema';
import { getHubSpotClient } from './integrations';
import { normalizeTierName, extractTierTags } from '../../shared/constants/tiers';
import { sql, eq } from 'drizzle-orm';
import { isProduction } from './db';
import { broadcastMemberDataUpdated } from './websocket';

interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    company?: string;
    membership_tier?: string;
    membership_status?: string;
    membership_discount_reason?: string;
    mindbody_client_id?: string;
    membership_start_date?: string;
    createdate?: string;
    eh_email_updates_opt_in?: string;
    eh_sms_updates_opt_in?: string;
    interest_golf?: string;
    interest_in_cafe?: string;
    interest_in_events?: string;
    interest_in_workspace?: string;
    total_visit_count?: string;
  };
}

let syncInProgress = false;
let lastSyncTime = 0;
const SYNC_COOLDOWN = 5 * 60 * 1000;

export async function syncAllMembersFromHubSpot(): Promise<{ synced: number; errors: number }> {
  if (syncInProgress) {
    if (!isProduction) console.log('[MemberSync] Sync already in progress, skipping');
    return { synced: 0, errors: 0 };
  }
  
  const now = Date.now();
  if (now - lastSyncTime < SYNC_COOLDOWN) {
    if (!isProduction) console.log('[MemberSync] Sync cooldown active, skipping');
    return { synced: 0, errors: 0 };
  }
  
  syncInProgress = true;
  lastSyncTime = now;
  
  try {
    const hubspot = await getHubSpotClient();
    
    const properties = [
      'firstname',
      'lastname',
      'email',
      'phone',
      'company',
      'membership_tier',
      'membership_status',
      'membership_discount_reason',
      'mindbody_client_id',
      'membership_start_date',
      'createdate',
      'eh_email_updates_opt_in',
      'eh_sms_updates_opt_in',
      'interest_golf',
      'interest_in_cafe',
      'interest_in_events',
      'interest_in_workspace',
      'total_visit_count'
    ];
    
    let allContacts: HubSpotContact[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await hubspot.crm.contacts.basicApi.getPage(100, after, properties);
      allContacts = allContacts.concat(response.results as HubSpotContact[]);
      after = response.paging?.next?.after;
    } while (after);
    
    if (!isProduction) console.log(`[MemberSync] Fetched ${allContacts.length} contacts from HubSpot`);
    
    const tierCache = new Map<string, number>();
    const tierResults = await db.select({ id: membershipTiers.id, name: membershipTiers.name }).from(membershipTiers);
    for (const tier of tierResults) {
      tierCache.set(tier.name.toLowerCase(), tier.id);
    }
    
    let synced = 0;
    let errors = 0;
    
    for (const contact of allContacts) {
      const email = contact.properties.email?.toLowerCase();
      if (!email) continue;
      
      try {
        const status = (contact.properties.membership_status || 'active').toLowerCase();
        const normalizedTier = normalizeTierName(contact.properties.membership_tier);
        const tierId = normalizedTier ? (tierCache.get(normalizedTier.toLowerCase()) || null) : null;
        const tags = extractTierTags(contact.properties.membership_tier, contact.properties.membership_discount_reason);
        
        let joinDate: string | null = null;
        if (contact.properties.membership_start_date) {
          const dateStr = contact.properties.membership_start_date;
          if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
            joinDate = dateStr.split('T')[0];
          }
        }
        
        // Parse opt-in values from HubSpot (they come as strings like "true"/"false" or "Yes"/"No")
        const parseOptIn = (val?: string): boolean | null => {
          if (!val) return null;
          const lower = val.toLowerCase();
          return lower === 'true' || lower === 'yes' || lower === '1';
        };
        
        const emailOptIn = parseOptIn(contact.properties.eh_email_updates_opt_in);
        const smsOptIn = parseOptIn(contact.properties.eh_sms_updates_opt_in);
        
        await db.insert(users)
          .values({
            id: sql`gen_random_uuid()`,
            email,
            firstName: contact.properties.firstname || null,
            lastName: contact.properties.lastname || null,
            phone: contact.properties.phone || null,
            tier: normalizedTier,
            tierId,
            tags: tags.length > 0 ? tags : [],
            hubspotId: contact.id,
            membershipStatus: status,
            mindbodyClientId: contact.properties.mindbody_client_id || null,
            joinDate,
            emailOptIn,
            smsOptIn,
            lastSyncedAt: new Date(),
            role: 'member'
          })
          .onConflictDoUpdate({
            target: users.email,
            set: {
              firstName: sql`COALESCE(${contact.properties.firstname || null}, ${users.firstName})`,
              lastName: sql`COALESCE(${contact.properties.lastname || null}, ${users.lastName})`,
              phone: sql`COALESCE(${contact.properties.phone || null}, ${users.phone})`,
              tier: normalizedTier,
              tierId,
              tags: tags.length > 0 ? tags : sql`${users.tags}`,
              hubspotId: contact.id,
              membershipStatus: status,
              mindbodyClientId: sql`COALESCE(${contact.properties.mindbody_client_id || null}, ${users.mindbodyClientId})`,
              joinDate: joinDate ? joinDate : sql`${users.joinDate}`,
              emailOptIn: emailOptIn !== null ? emailOptIn : sql`${users.emailOptIn}`,
              smsOptIn: smsOptIn !== null ? smsOptIn : sql`${users.smsOptIn}`,
              lastSyncedAt: new Date(),
              updatedAt: new Date()
            }
          });
        
        synced++;
      } catch (err) {
        errors++;
        if (!isProduction) console.error(`[MemberSync] Error syncing ${email}:`, err);
      }
    }
    
    if (!isProduction) console.log(`[MemberSync] Complete - Synced: ${synced}, Errors: ${errors}`);
    
    // Broadcast to staff that member data has been updated
    if (synced > 0) {
      broadcastMemberDataUpdated([]);
    }
    
    return { synced, errors };
  } catch (error) {
    console.error('[MemberSync] Fatal error:', error);
    return { synced: 0, errors: 1 };
  } finally {
    syncInProgress = false;
  }
}

export function triggerMemberSync(): void {
  syncAllMembersFromHubSpot().catch(err => {
    console.error('[MemberSync] Background sync failed:', err);
  });
}

// Push lifetimeVisits to HubSpot when visit count changes
export async function updateHubSpotContactVisitCount(hubspotId: string, visitCount: number): Promise<boolean> {
  try {
    const hubspot = await getHubSpotClient();
    await hubspot.crm.contacts.basicApi.update(hubspotId, {
      properties: {
        total_visit_count: String(visitCount)
      }
    });
    if (!isProduction) console.log(`[MemberSync] Updated HubSpot contact ${hubspotId} visit count to ${visitCount}`);
    return true;
  } catch (error) {
    console.error(`[MemberSync] Failed to update HubSpot visit count for ${hubspotId}:`, error);
    return false;
  }
}

// Push communication preferences to HubSpot
export async function updateHubSpotContactPreferences(
  hubspotId: string, 
  preferences: { emailOptIn?: boolean; smsOptIn?: boolean }
): Promise<boolean> {
  try {
    const hubspot = await getHubSpotClient();
    const properties: Record<string, string> = {};
    
    if (preferences.emailOptIn !== undefined) {
      properties.eh_email_updates_opt_in = preferences.emailOptIn ? 'true' : 'false';
    }
    if (preferences.smsOptIn !== undefined) {
      properties.eh_sms_updates_opt_in = preferences.smsOptIn ? 'true' : 'false';
    }
    
    if (Object.keys(properties).length === 0) {
      return true; // Nothing to update
    }
    
    await hubspot.crm.contacts.basicApi.update(hubspotId, { properties });
    if (!isProduction) console.log(`[MemberSync] Updated HubSpot contact ${hubspotId} preferences:`, properties);
    return true;
  } catch (error) {
    console.error(`[MemberSync] Failed to update HubSpot preferences for ${hubspotId}:`, error);
    return false;
  }
}

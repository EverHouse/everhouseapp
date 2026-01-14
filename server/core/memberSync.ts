import { db } from '../db';
import { users, membershipTiers } from '../../shared/schema';
import { getHubSpotClient } from './integrations';
import { normalizeTierName, extractTierTags } from '../../shared/constants/tiers';
import { sql, eq } from 'drizzle-orm';
import { isProduction } from './db';
import { broadcastMemberDataUpdated, broadcastDataIntegrityUpdate } from './websocket';
import { syncDealStageFromMindbodyStatus } from './hubspotDeals';
import pLimit from 'p-limit';

// Helper to add delay between operations
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    hs_calculated_full_name?: string;
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
      'hs_calculated_full_name',
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
    
    // Parse opt-in values from HubSpot (they come as strings like "true"/"false" or "Yes"/"No")
    const parseOptIn = (val?: string): boolean | null => {
      if (!val) return null;
      const lower = val.toLowerCase();
      return lower === 'true' || lower === 'yes' || lower === '1';
    };
    
    // Extract first/last name from hs_calculated_full_name when individual fields are empty
    const getNameFromContact = (contact: HubSpotContact): { firstName: string | null; lastName: string | null } => {
      let firstName = contact.properties.firstname || null;
      let lastName = contact.properties.lastname || null;
      
      // If firstname or lastname is missing, try to extract from hs_calculated_full_name
      if ((!firstName || !lastName) && contact.properties.hs_calculated_full_name) {
        const fullName = contact.properties.hs_calculated_full_name.trim();
        const parts = fullName.split(' ');
        if (parts.length >= 2) {
          firstName = firstName || parts[0];
          lastName = lastName || parts.slice(1).join(' ');
        } else if (parts.length === 1 && parts[0]) {
          firstName = firstName || parts[0];
        }
      }
      
      return { firstName, lastName };
    };
    
    // Process contacts in parallel batches for better performance
    const SYNC_BATCH_SIZE = 25;
    const syncLimit = pLimit(10); // 10 concurrent DB operations
    
    for (let i = 0; i < allContacts.length; i += SYNC_BATCH_SIZE) {
      const batch = allContacts.slice(i, i + SYNC_BATCH_SIZE);
      
      const results = await Promise.allSettled(
        batch.map(contact => syncLimit(async () => {
          const email = contact.properties.email?.toLowerCase();
          if (!email) return null;
          
          const status = (contact.properties.membership_status || 'non-member').toLowerCase();
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
          
          const emailOptIn = parseOptIn(contact.properties.eh_email_updates_opt_in);
          const smsOptIn = parseOptIn(contact.properties.eh_sms_updates_opt_in);
          const { firstName, lastName } = getNameFromContact(contact);
          
          await db.insert(users)
            .values({
              id: sql`gen_random_uuid()`,
              email,
              firstName,
              lastName,
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
                firstName: sql`COALESCE(${firstName}, ${users.firstName})`,
                lastName: sql`COALESCE(${lastName}, ${users.lastName})`,
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
          
          return email;
        }))
      );
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          synced++;
        } else if (result.status === 'rejected') {
          errors++;
          if (!isProduction) console.error(`[MemberSync] Error syncing contact:`, result.reason);
        }
      }
    }
    
    if (!isProduction) console.log(`[MemberSync] Complete - Synced: ${synced}, Errors: ${errors}`);
    
    // Sync deal stages in batches with throttling to avoid HubSpot rate limits
    // Run this AFTER the main sync completes to avoid blocking member data updates
    const dealSyncStatuses = ['active', 'declined', 'suspended', 'expired', 'terminated', 'cancelled', 'froze', 'non-member', 'frozen'];
    const contactsNeedingDealSync = allContacts.filter(c => {
      const email = c.properties.email?.toLowerCase();
      const status = (c.properties.membership_status || 'non-member').toLowerCase();
      return email && dealSyncStatuses.includes(status);
    });
    
    if (contactsNeedingDealSync.length > 0) {
      if (!isProduction) console.log(`[MemberSync] Starting deal sync for ${contactsNeedingDealSync.length} members (throttled)`);
      
      // Process deals in batches of 5 with 2 second delay between batches
      // HubSpot has 110 requests per 10 seconds limit, so we stay well under
      const BATCH_SIZE = 5;
      const BATCH_DELAY_MS = 2000;
      const limit = pLimit(BATCH_SIZE);
      
      for (let i = 0; i < contactsNeedingDealSync.length; i += BATCH_SIZE) {
        const batch = contactsNeedingDealSync.slice(i, i + BATCH_SIZE);
        
        await Promise.all(
          batch.map(contact => 
            limit(async () => {
              const email = contact.properties.email!.toLowerCase();
              const status = (contact.properties.membership_status || 'non-member').toLowerCase();
              try {
                await syncDealStageFromMindbodyStatus(email, status, 'system', 'Mindbody Sync');
              } catch (err) {
                if (!isProduction) console.error(`[MemberSync] Failed to sync deal stage for ${email}:`, err);
              }
            })
          )
        );
        
        // Add delay between batches to avoid rate limits
        if (i + BATCH_SIZE < contactsNeedingDealSync.length) {
          await delay(BATCH_DELAY_MS);
        }
      }
      
      if (!isProduction) console.log(`[MemberSync] Deal sync complete for ${contactsNeedingDealSync.length} members`);
    }
    
    // Broadcast to staff that member data has been updated
    if (synced > 0) {
      broadcastMemberDataUpdated([]);
      // Also notify Data Integrity dashboard to refresh (HubSpot sync affects integrity checks)
      broadcastDataIntegrityUpdate('data_changed', { source: 'hubspot_sync' });
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

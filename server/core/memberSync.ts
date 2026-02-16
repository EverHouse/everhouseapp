import { db } from '../db';
import { getErrorStatusCode } from '../utils/errorUtils';
import { users, membershipTiers } from '../../shared/schema';
import { memberNotes, communicationLogs, userLinkedEmails } from '../../shared/models/membership';
import { getHubSpotClient } from './integrations';
import { normalizeTierName, extractTierTags, TIER_NAMES } from '../../shared/constants/tiers';
import { sql, eq, and } from 'drizzle-orm';
import { isProduction } from './db';
import { broadcastMemberDataUpdated, broadcastDataIntegrityUpdate } from './websocket';
import { syncDealStageFromMindbodyStatus } from './hubspotDeals';
import { alertOnHubSpotSyncComplete, alertOnSyncFailure } from './dataAlerts';
import pLimit from 'p-limit';
import { notifyMember, notifyAllStaff } from './notificationService';
import { sendOutstandingBalanceEmail } from '../emails/paymentEmails';

// Check if a tier string represents a valid/recognized tier (not blank/unknown)
function isRecognizedTier(tierString: string | null | undefined): boolean {
  if (!tierString || typeof tierString !== 'string') return false;
  const normalized = tierString.trim().toLowerCase();
  if (normalized.length === 0) return false;
  
  // Check if it contains any recognized tier keyword
  return TIER_NAMES.some(tier => normalized.includes(tier.toLowerCase()));
}

// Helper to add delay between operations
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function detectAndNotifyStatusChange(
  email: string,
  firstName: string | null,
  lastName: string | null,
  oldStatus: string | null,
  newStatus: string
): Promise<void> {
  if (!oldStatus || oldStatus === newStatus) return;
  
  const memberName = [firstName, lastName].filter(Boolean).join(' ') || email;
  
  const problematicStatuses = ['past_due', 'declined', 'suspended', 'expired', 'terminated', 'cancelled', 'frozen'];
  
  if (problematicStatuses.includes(newStatus) && !problematicStatuses.includes(oldStatus)) {
    await notifyMember({
      userEmail: email,
      title: 'Membership Status Update',
      message: `Your membership status has been updated to: ${newStatus}. Please contact the club if you have questions.`,
      type: 'membership_past_due'
    }, { sendPush: true });
    
    await notifyAllStaff(
      'Member Status Changed',
      `${memberName}'s membership status changed from ${oldStatus} to ${newStatus}`,
      'system',
      { relatedType: 'membership_status' }
    );
    
    console.log(`[MemberSync] Notified about status change for ${email}: ${oldStatus} -> ${newStatus}`);
    
    // Start grace period for Mindbody-billed members who become inactive
    // They'll receive daily emails with Stripe reactivation link for 3 days
    try {
      const userResult = await db.select({ 
        billingProvider: users.billingProvider,
        gracePeriodStart: users.gracePeriodStart
      })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      
      const user = userResult[0];
      
      // Only start grace period for Mindbody members who don't already have one
      if (user && user.billingProvider === 'mindbody' && !user.gracePeriodStart) {
        await db.update(users)
          .set({
            gracePeriodStart: new Date(),
            gracePeriodEmailCount: 0,
            updatedAt: new Date()
          })
          .where(eq(users.email, email));
        
        console.log(`[MemberSync] Started grace period for Mindbody member ${email} - status changed to ${newStatus}`);
      }
    } catch (err) {
      console.error(`[MemberSync] Failed to start grace period for ${email}:`, err);
    }
  }
}

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
    membership_notes?: string;
    message?: string;
    // Address fields (synced from Mindbody via HubSpot)
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    // Date of birth (synced from Mindbody via HubSpot)
    date_of_birth?: string;
    // Stripe delinquent status (synced from Stripe via HubSpot)
    stripe_delinquent?: string;
    // Granular SMS preferences
    hs_sms_promotional?: string;
    hs_sms_customer_updates?: string;
    hs_sms_reminders?: string;
    // Merged contact IDs (for linked emails)
    hs_merged_object_ids?: string;
  };
}

// Simple hash function to detect notes changes
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

let syncInProgress = false;
let lastSyncTime = 0;
const SYNC_COOLDOWN = 5 * 60 * 1000;

export async function initMemberSyncSettings(): Promise<void> {
  try {
    const result = await db.execute(sql`SELECT value FROM app_settings WHERE key = 'last_member_sync_time'`);
    if (result.rows.length > 0 && result.rows[0].value) {
      lastSyncTime = parseInt(result.rows[0].value as string, 10);
      console.log(`[MemberSync] Loaded last sync time: ${new Date(lastSyncTime).toISOString()}`);
    }
  } catch (err) {
    console.error('[MemberSync] Failed to load last sync time:', err);
  }
}

export function getLastMemberSyncTime(): number {
  return lastSyncTime;
}

export async function setLastMemberSyncTime(time: number): Promise<void> {
  lastSyncTime = time;
  try {
    await db.execute(sql`INSERT INTO app_settings (key, value, category, updated_at) 
       VALUES ('last_member_sync_time', ${time.toString()}, 'sync', NOW())
       ON CONFLICT (key) DO UPDATE SET value = ${time.toString()}, updated_at = NOW()`);
  } catch (err) {
    console.error('[MemberSync] Failed to persist last sync time:', err);
  }
}

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
      'total_visit_count',
      'membership_notes',
      'message',
      // Address fields (synced from Mindbody via HubSpot)
      'address',
      'city',
      'state',
      'zip',
      // Date of birth (synced from Mindbody via HubSpot)
      'date_of_birth',
      // Stripe delinquent status (synced from Stripe via HubSpot)
      'stripe_delinquent',
      // Granular SMS preferences
      'hs_sms_promotional',
      'hs_sms_customer_updates',
      'hs_sms_reminders',
      // Merged contact IDs (for linked emails)
      'hs_merged_object_ids'
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
    let statusChanges = 0;
    let hubspotIdCollisions = 0;
    let skippedNonTransacting = 0;
    let stripeProtectedCount = 0;
    
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
          let email = contact.properties.email?.toLowerCase();
          if (!email) return null;
          
          const status = (contact.properties.membership_status || 'non-member').toLowerCase();
          
          // Tier logic: Only sync recognized tiers, leave null for unrecognized (preserves existing in upsert)
          const rawTier = contact.properties.membership_tier;
          let normalizedTier: string | null = null;
          
          if (isRecognizedTier(rawTier)) {
            // Known tier from HubSpot - use it
            normalizedTier = normalizeTierName(rawTier);
          } else if (rawTier && rawTier.trim()) {
            // Unrecognized non-empty tier - log warning for manual review, don't overwrite existing
            console.warn(`[MemberSync] UNRECOGNIZED TIER "${rawTier}" for ${email} - requires manual mapping, tier will not be updated`);
          }
          // If normalizedTier is null, the upsert will preserve the existing tier value via COALESCE
          const tierId = normalizedTier ? (tierCache.get(normalizedTier.toLowerCase()) || null) : null;
          const tags = extractTierTags(contact.properties.membership_tier, contact.properties.membership_discount_reason);
          
          // PRIORITIZE membership_start_date for joinDate (when they became a member), fallback to createdate
          let joinDate: string | null = null;
          if (contact.properties.membership_start_date) {
            const dateStr = contact.properties.membership_start_date;
            if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
              joinDate = dateStr.split('T')[0];
            }
          }
          // Fallback to createdate if membership_start_date wasn't available
          if (!joinDate && contact.properties.createdate) {
            try {
              const createDate = new Date(contact.properties.createdate);
              if (!isNaN(createDate.getTime())) {
                joinDate = createDate.toISOString().split('T')[0];
              }
            } catch (e) {
              // If parsing fails, joinDate remains null
            }
          }
          
          const emailOptIn = parseOptIn(contact.properties.eh_email_updates_opt_in);
          const smsOptIn = parseOptIn(contact.properties.eh_sms_updates_opt_in);
          const { firstName, lastName } = getNameFromContact(contact);
          
          // Granular SMS preferences from HubSpot
          const smsPromoOptIn = parseOptIn(contact.properties.hs_sms_promotional);
          const smsTransactionalOptIn = parseOptIn(contact.properties.hs_sms_customer_updates);
          const smsRemindersOptIn = parseOptIn(contact.properties.hs_sms_reminders);
          
          // Stripe delinquent status (comes as "true"/"false" string)
          const stripeDelinquent = parseOptIn(contact.properties.stripe_delinquent);
          
          const { resolveUserByEmail } = await import('./stripe/customers');
          const resolvedSync = await resolveUserByEmail(email);
          if (resolvedSync && resolvedSync.matchType !== 'direct') {
            console.log(`[MemberSync] HubSpot email ${email} resolved to existing user ${resolvedSync.primaryEmail} via ${resolvedSync.matchType}`);
            email = resolvedSync.primaryEmail.toLowerCase();
          }

          const existingUser = await db.select({ 
            membershipStatus: users.membershipStatus,
            billingProvider: users.billingProvider,
            lastHubspotNotesHash: users.lastHubspotNotesHash
          })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          const oldStatus = existingUser[0]?.membershipStatus || null;
          const oldNotesHash = existingUser[0]?.lastHubspotNotesHash || null;
          
          if (!existingUser[0] && status === 'non-member' && !contact.properties.mindbody_client_id) {
            skippedNonTransacting++;
            return null;
          }
          
          const isStripeProtected = existingUser[0]?.billingProvider === 'stripe';

          if (isStripeProtected) {
            stripeProtectedCount++;
            console.log(`[MemberSync] STRIPE WINS: Skipping membership_status/tier update for Stripe-billed member ${email} (HubSpot status: ${status})`);
          }
          
          // Extract address fields from HubSpot (synced from Mindbody)
          const streetAddress = contact.properties.address?.trim() || null;
          const city = contact.properties.city?.trim() || null;
          const state = contact.properties.state?.trim() || null;
          const zipCode = contact.properties.zip?.trim() || null;
          
          // Extract date of birth from HubSpot (synced from Mindbody)
          // HubSpot stores dates as YYYY-MM-DD strings
          let dateOfBirth: string | null = null;
          if (contact.properties.date_of_birth) {
            const dobStr = contact.properties.date_of_birth.trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(dobStr)) {
              dateOfBirth = dobStr.split('T')[0]; // Extract just the date part
            }
          }
          
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
              smsPromoOptIn,
              smsTransactionalOptIn,
              smsRemindersOptIn,
              stripeDelinquent,
              streetAddress,
              city,
              state,
              zipCode,
              dateOfBirth,
              lastSyncedAt: new Date(),
              role: 'member'
            })
            .onConflictDoUpdate({
              target: users.email,
              set: {
                firstName: sql`COALESCE(${firstName}, ${users.firstName})`,
                lastName: sql`COALESCE(${lastName}, ${users.lastName})`,
                phone: sql`COALESCE(${contact.properties.phone || null}, ${users.phone})`,
                tier: isStripeProtected ? sql`${users.tier}` : (normalizedTier ? normalizedTier : sql`${users.tier}`),
                tierId: isStripeProtected ? sql`${users.tierId}` : (tierId !== null ? tierId : sql`${users.tierId}`),
                tags: tags.length > 0 ? tags : sql`${users.tags}`,
                hubspotId: contact.id,
                membershipStatus: isStripeProtected ? sql`${users.membershipStatus}` : status,
                // Use HubSpot value directly - clear stale mindbody IDs not present in HubSpot
                mindbodyClientId: contact.properties.mindbody_client_id || null,
                joinDate: joinDate ? joinDate : sql`${users.joinDate}`,
                emailOptIn: emailOptIn !== null ? emailOptIn : sql`${users.emailOptIn}`,
                smsOptIn: smsOptIn !== null ? smsOptIn : sql`${users.smsOptIn}`,
                smsPromoOptIn: smsPromoOptIn !== null ? smsPromoOptIn : sql`${users.smsPromoOptIn}`,
                smsTransactionalOptIn: smsTransactionalOptIn !== null ? smsTransactionalOptIn : sql`${users.smsTransactionalOptIn}`,
                smsRemindersOptIn: smsRemindersOptIn !== null ? smsRemindersOptIn : sql`${users.smsRemindersOptIn}`,
                stripeDelinquent: stripeDelinquent !== null ? stripeDelinquent : sql`${users.stripeDelinquent}`,
                streetAddress: sql`COALESCE(${streetAddress}, ${users.streetAddress})`,
                city: sql`COALESCE(${city}, ${users.city})`,
                state: sql`COALESCE(${state}, ${users.state})`,
                zipCode: sql`COALESCE(${zipCode}, ${users.zipCode})`,
                dateOfBirth: sql`COALESCE(${dateOfBirth}, ${users.dateOfBirth})`,
                lastSyncedAt: new Date(),
                updatedAt: new Date()
              }
            });
          
          if (oldStatus !== status && !isStripeProtected) {
            detectAndNotifyStatusChange(email, firstName, lastName, oldStatus, status).catch(err => {
              console.error(`[MemberSync] Failed to notify status change for ${email}:`, err);
            });
          }
          
          try {
            const duplicateCheck = await db.execute(sql`SELECT id, email, first_name, last_name, membership_status, tier
               FROM users 
               WHERE hubspot_id = ${contact.id} 
                 AND LOWER(email) != ${email}
                 AND archived_at IS NULL
                 AND membership_status != 'merged'
               LIMIT 5`);
            
            if (duplicateCheck.rows.length > 0) {
              for (const dup of duplicateCheck.rows) {
                console.warn(`[MemberSync] HubSpot ID collision detected: ${email} and ${dup.email} share HubSpot contact ${contact.id}. These may be the same person.`);
                
                await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at)
                   VALUES (${email}, ${dup.email}, 'hubspot_dedup', NOW())
                   ON CONFLICT (linked_email) DO NOTHING`);
              }
              hubspotIdCollisions++;
            }
          } catch (dupError) {
            console.error(`[MemberSync] Error checking for HubSpot ID collisions:`, dupError);
          }
          
          // Sync HubSpot notes to member_notes table with change detection
          // When notes change in HubSpot, create a NEW dated note (don't overwrite old ones)
          const hubspotNotes = contact.properties.membership_notes?.trim();
          const hubspotMessage = contact.properties.message?.trim();
          
          // Helper to sanitize HTML and limit length
          const sanitizeNoteContent = (content: string): string => {
            return content
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/?[^>]+(>|$)/g, '')
              .trim()
              .substring(0, 5000);
          };
          
          // Combine notes and message for hash comparison
          const combinedNotesContent = [hubspotNotes || '', hubspotMessage || ''].join('||');
          const currentNotesHash = combinedNotesContent ? simpleHash(combinedNotesContent) : null;
          
          // Only create new notes if the content has changed
          if (currentNotesHash && currentNotesHash !== oldNotesHash) {
            const today = new Date().toLocaleDateString('en-US', { 
              year: 'numeric', 
              month: 'short', 
              day: 'numeric',
              timeZone: 'America/Los_Angeles'
            });
            
            // Create note for membership_notes if present
            if (hubspotNotes) {
              const noteContent = `[Mindbody Notes - ${today}]:\n${sanitizeNoteContent(hubspotNotes)}`;
              await db.insert(memberNotes).values({
                memberEmail: email,
                content: noteContent,
                createdBy: 'system',
                createdByName: 'HubSpot Sync (Mindbody)',
                isPinned: false
              });
            }
            
            // Create note for message if present
            if (hubspotMessage) {
              const msgContent = `[Mindbody Message - ${today}]:\n${sanitizeNoteContent(hubspotMessage)}`;
              await db.insert(memberNotes).values({
                memberEmail: email,
                content: msgContent,
                createdBy: 'system',
                createdByName: 'HubSpot Sync (Mindbody)',
                isPinned: false
              });
            }
            
            // Update the hash to track this version
            await db.update(users)
              .set({ lastHubspotNotesHash: currentNotesHash })
              .where(eq(users.email, email));
          }
          
          return { email, statusChanged: oldStatus !== null && oldStatus !== status };
        }))
      );
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          synced++;
          if (result.value.statusChanged) {
            statusChanges++;
          }
        } else if (result.status === 'rejected') {
          errors++;
          if (!isProduction) console.error(`[MemberSync] Error syncing contact:`, result.reason);
        }
      }
    }
    
    if (!isProduction) console.log(`[MemberSync] Complete - Synced: ${synced}, Errors: ${errors}, Status Changes: ${statusChanges}, HubSpot ID Collisions: ${hubspotIdCollisions}, ${skippedNonTransacting} non-transacting skipped, ${stripeProtectedCount} Stripe-protected`);
    
    // Process merged contact IDs to extract linked emails
    // hs_merged_object_ids contains semicolon-separated HubSpot contact IDs that were merged into this contact
    const contactsWithMergedIds = allContacts.filter(c => c.properties.hs_merged_object_ids);
    if (contactsWithMergedIds.length > 0) {
      if (!isProduction) console.log(`[MemberSync] Processing ${contactsWithMergedIds.length} contacts with merged IDs`);
      
      // Collect all merged IDs to batch fetch
      const mergedIdsByPrimaryEmail = new Map<string, string[]>();
      for (const contact of contactsWithMergedIds) {
        const primaryEmail = contact.properties.email?.toLowerCase();
        if (!primaryEmail) continue;
        
        const mergedIds = contact.properties.hs_merged_object_ids!
          .split(';')
          .map(id => id.trim())
          .filter(id => id.length > 0);
        
        if (mergedIds.length > 0) {
          mergedIdsByPrimaryEmail.set(primaryEmail, mergedIds);
        }
      }
      
      // Batch lookup merged contacts to get their emails (process in batches to avoid rate limits)
      const allMergedIds = [...new Set([...mergedIdsByPrimaryEmail.values()].flat())];
      const mergedContactEmails = new Map<string, string>();
      
      if (allMergedIds.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < allMergedIds.length; i += BATCH_SIZE) {
          const batchIds = allMergedIds.slice(i, i + BATCH_SIZE);
          try {
            const batchResponse = await hubspot.crm.contacts.batchApi.read({
              inputs: batchIds.map(id => ({ id })),
              properties: ['email'],
              propertiesWithHistory: []
            });
            
            for (const result of batchResponse.results) {
              const email = result.properties?.email?.toLowerCase();
              if (email) {
                mergedContactEmails.set(result.id, email);
              }
            }
          } catch (err) {
            if (!isProduction) console.error(`[MemberSync] Error fetching merged contacts:`, err);
          }
          
          // Add delay between batches
          if (i + BATCH_SIZE < allMergedIds.length) {
            await delay(500);
          }
        }
        
        // Add linked emails to user_linked_emails table
        let linkedEmailsAdded = 0;
        for (const [primaryEmail, mergedIds] of mergedIdsByPrimaryEmail) {
          for (const mergedId of mergedIds) {
            const mergedEmail = mergedContactEmails.get(mergedId);
            if (mergedEmail && mergedEmail !== primaryEmail) {
              try {
                await db.insert(userLinkedEmails)
                  .values({
                    primaryEmail,
                    linkedEmail: mergedEmail,
                    source: 'hubspot_merge'
                  })
                  .onConflictDoNothing();
                linkedEmailsAdded++;
              } catch (err) {
                // Ignore duplicate key errors
              }
            }
          }
        }
        
        if (!isProduction && linkedEmailsAdded > 0) {
          console.log(`[MemberSync] Added ${linkedEmailsAdded} linked emails from HubSpot merged contacts`);
        }
      }
    }
    
    // Sync deal stages in batches with throttling to avoid HubSpot rate limits
    // Run this AFTER the main sync completes to avoid blocking member data updates
    const dealSyncStatuses = ['active', 'declined', 'suspended', 'expired', 'terminated', 'cancelled', 'froze', 'non-member', 'frozen', 'past_due', 'past due', 'pastdue'];
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
    
    // Alert if there were sync errors
    await alertOnHubSpotSyncComplete(synced, errors, allContacts.length);
    
    return { synced, errors };
  } catch (error) {
    console.error('[MemberSync] Fatal error:', error);
    await alertOnSyncFailure(
      'hubspot',
      'Member sync from HubSpot',
      error instanceof Error ? error : new Error(String(error))
    );
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

export async function syncRelevantMembersFromHubSpot(): Promise<{ synced: number; errors: number }> {
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
      'total_visit_count',
      'membership_notes',
      'message',
      'address',
      'city',
      'state',
      'zip',
      'date_of_birth',
      'stripe_delinquent',
      'hs_sms_promotional',
      'hs_sms_customer_updates',
      'hs_sms_reminders',
      'hs_merged_object_ids'
    ];
    
    const relevantStatuses = ['active', 'past_due', 'past due', 'pastdue', 'frozen', 'froze', 'suspended', 'declined', 'expired', 'terminated', 'cancelled'];
    
    const filterGroups: any[] = [
      {
        filters: [
          {
            propertyName: 'membership_status',
            operator: 'IN',
            values: relevantStatuses
          }
        ]
      }
    ];
    
    const previousSyncTime = getLastMemberSyncTime();
    if (previousSyncTime > 0) {
      filterGroups.push({
        filters: [
          {
            propertyName: 'lastmodifieddate',
            operator: 'GTE',
            value: new Date(previousSyncTime).toISOString()
          }
        ]
      });
    }
    
    let allContacts: HubSpotContact[] = [];
    let after: string | undefined = undefined;
    
    do {
      const searchRequest: any = {
        filterGroups,
        properties,
        limit: 100,
        ...(after ? { after } : {})
      };
      
      const response = await hubspot.crm.contacts.searchApi.doSearch(searchRequest);
      allContacts = allContacts.concat(response.results as HubSpotContact[]);
      after = response.paging?.next?.after;
    } while (after);
    
    console.log(`[MemberSync] Focused sync: fetched ${allContacts.length} relevant contacts from HubSpot`);
    
    const tierCache = new Map<string, number>();
    const tierResults = await db.select({ id: membershipTiers.id, name: membershipTiers.name }).from(membershipTiers);
    for (const tier of tierResults) {
      tierCache.set(tier.name.toLowerCase(), tier.id);
    }
    
    let synced = 0;
    let errors = 0;
    let statusChanges = 0;
    let hubspotIdCollisions = 0;
    let skippedNonTransacting = 0;
    let stripeProtectedCount = 0;
    
    const parseOptIn = (val?: string): boolean | null => {
      if (!val) return null;
      const lower = val.toLowerCase();
      return lower === 'true' || lower === 'yes' || lower === '1';
    };
    
    const getNameFromContact = (contact: HubSpotContact): { firstName: string | null; lastName: string | null } => {
      let firstName = contact.properties.firstname || null;
      let lastName = contact.properties.lastname || null;
      
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
    
    const SYNC_BATCH_SIZE = 25;
    const syncLimit = pLimit(10);
    
    for (let i = 0; i < allContacts.length; i += SYNC_BATCH_SIZE) {
      const batch = allContacts.slice(i, i + SYNC_BATCH_SIZE);
      
      const results = await Promise.allSettled(
        batch.map(contact => syncLimit(async () => {
          let email = contact.properties.email?.toLowerCase();
          if (!email) return null;
          
          const status = (contact.properties.membership_status || 'non-member').toLowerCase();
          
          const rawTier = contact.properties.membership_tier;
          let normalizedTier: string | null = null;
          
          if (isRecognizedTier(rawTier)) {
            normalizedTier = normalizeTierName(rawTier);
          } else if (rawTier && rawTier.trim()) {
            console.warn(`[MemberSync] UNRECOGNIZED TIER "${rawTier}" for ${email} - requires manual mapping, tier will not be updated`);
          }
          const tierId = normalizedTier ? (tierCache.get(normalizedTier.toLowerCase()) || null) : null;
          const tags = extractTierTags(contact.properties.membership_tier, contact.properties.membership_discount_reason);
          
          let joinDate: string | null = null;
          if (contact.properties.membership_start_date) {
            const dateStr = contact.properties.membership_start_date;
            if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
              joinDate = dateStr.split('T')[0];
            }
          }
          if (!joinDate && contact.properties.createdate) {
            try {
              const createDate = new Date(contact.properties.createdate);
              if (!isNaN(createDate.getTime())) {
                joinDate = createDate.toISOString().split('T')[0];
              }
            } catch (e) {
              console.error('[MemberSync] Failed to parse createdate:', e);
            }
          }
          
          const emailOptIn = parseOptIn(contact.properties.eh_email_updates_opt_in);
          const smsOptIn = parseOptIn(contact.properties.eh_sms_updates_opt_in);
          const { firstName, lastName } = getNameFromContact(contact);
          
          const smsPromoOptIn = parseOptIn(contact.properties.hs_sms_promotional);
          const smsTransactionalOptIn = parseOptIn(contact.properties.hs_sms_customer_updates);
          const smsRemindersOptIn = parseOptIn(contact.properties.hs_sms_reminders);
          
          const stripeDelinquent = parseOptIn(contact.properties.stripe_delinquent);
          
          const { resolveUserByEmail } = await import('./stripe/customers');
          const resolvedSync = await resolveUserByEmail(email);
          if (resolvedSync && resolvedSync.matchType !== 'direct') {
            console.log(`[MemberSync] HubSpot email ${email} resolved to existing user ${resolvedSync.primaryEmail} via ${resolvedSync.matchType}`);
            email = resolvedSync.primaryEmail.toLowerCase();
          }

          const existingUser = await db.select({ 
            membershipStatus: users.membershipStatus,
            billingProvider: users.billingProvider,
            lastHubspotNotesHash: users.lastHubspotNotesHash
          })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          const oldStatus = existingUser[0]?.membershipStatus || null;
          const oldNotesHash = existingUser[0]?.lastHubspotNotesHash || null;
          
          if (!existingUser[0] && status === 'non-member' && !contact.properties.mindbody_client_id) {
            skippedNonTransacting++;
            return null;
          }
          
          const isStripeProtected = existingUser[0]?.billingProvider === 'stripe';

          if (isStripeProtected) {
            stripeProtectedCount++;
            console.log(`[MemberSync] STRIPE WINS: Skipping membership_status/tier update for Stripe-billed member ${email} (HubSpot status: ${status})`);
          }
          
          const streetAddress = contact.properties.address?.trim() || null;
          const city = contact.properties.city?.trim() || null;
          const state = contact.properties.state?.trim() || null;
          const zipCode = contact.properties.zip?.trim() || null;
          
          let dateOfBirth: string | null = null;
          if (contact.properties.date_of_birth) {
            const dobStr = contact.properties.date_of_birth.trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(dobStr)) {
              dateOfBirth = dobStr.split('T')[0];
            }
          }
          
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
              smsPromoOptIn,
              smsTransactionalOptIn,
              smsRemindersOptIn,
              stripeDelinquent,
              streetAddress,
              city,
              state,
              zipCode,
              dateOfBirth,
              lastSyncedAt: new Date(),
              role: 'member'
            })
            .onConflictDoUpdate({
              target: users.email,
              set: {
                firstName: sql`COALESCE(${firstName}, ${users.firstName})`,
                lastName: sql`COALESCE(${lastName}, ${users.lastName})`,
                phone: sql`COALESCE(${contact.properties.phone || null}, ${users.phone})`,
                tier: isStripeProtected ? sql`${users.tier}` : (normalizedTier ? normalizedTier : sql`${users.tier}`),
                tierId: isStripeProtected ? sql`${users.tierId}` : (tierId !== null ? tierId : sql`${users.tierId}`),
                tags: tags.length > 0 ? tags : sql`${users.tags}`,
                hubspotId: contact.id,
                membershipStatus: isStripeProtected ? sql`${users.membershipStatus}` : status,
                mindbodyClientId: contact.properties.mindbody_client_id || null,
                joinDate: joinDate ? joinDate : sql`${users.joinDate}`,
                emailOptIn: emailOptIn !== null ? emailOptIn : sql`${users.emailOptIn}`,
                smsOptIn: smsOptIn !== null ? smsOptIn : sql`${users.smsOptIn}`,
                smsPromoOptIn: smsPromoOptIn !== null ? smsPromoOptIn : sql`${users.smsPromoOptIn}`,
                smsTransactionalOptIn: smsTransactionalOptIn !== null ? smsTransactionalOptIn : sql`${users.smsTransactionalOptIn}`,
                smsRemindersOptIn: smsRemindersOptIn !== null ? smsRemindersOptIn : sql`${users.smsRemindersOptIn}`,
                stripeDelinquent: stripeDelinquent !== null ? stripeDelinquent : sql`${users.stripeDelinquent}`,
                streetAddress: sql`COALESCE(${streetAddress}, ${users.streetAddress})`,
                city: sql`COALESCE(${city}, ${users.city})`,
                state: sql`COALESCE(${state}, ${users.state})`,
                zipCode: sql`COALESCE(${zipCode}, ${users.zipCode})`,
                dateOfBirth: sql`COALESCE(${dateOfBirth}, ${users.dateOfBirth})`,
                lastSyncedAt: new Date(),
                updatedAt: new Date()
              }
            });
          
          if (oldStatus !== status && !isStripeProtected) {
            detectAndNotifyStatusChange(email, firstName, lastName, oldStatus, status).catch(err => {
              console.error(`[MemberSync] Failed to notify status change for ${email}:`, err);
            });
          }
          
          try {
            const duplicateCheck = await db.execute(sql`SELECT id, email, first_name, last_name, membership_status, tier
               FROM users 
               WHERE hubspot_id = ${contact.id} 
                 AND LOWER(email) != ${email}
                 AND archived_at IS NULL
                 AND membership_status != 'merged'
               LIMIT 5`);
            
            if (duplicateCheck.rows.length > 0) {
              for (const dup of duplicateCheck.rows) {
                console.warn(`[MemberSync] HubSpot ID collision detected: ${email} and ${dup.email} share HubSpot contact ${contact.id}. These may be the same person.`);
                
                await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at)
                   VALUES (${email}, ${dup.email}, 'hubspot_dedup', NOW())
                   ON CONFLICT (linked_email) DO NOTHING`);
              }
              hubspotIdCollisions++;
            }
          } catch (dupError) {
            console.error(`[MemberSync] Error checking for HubSpot ID collisions:`, dupError);
          }
          
          const hubspotNotes = contact.properties.membership_notes?.trim();
          const hubspotMessage = contact.properties.message?.trim();
          
          const sanitizeNoteContent = (content: string): string => {
            return content
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/?[^>]+(>|$)/g, '')
              .trim()
              .substring(0, 5000);
          };
          
          const combinedNotesContent = [hubspotNotes || '', hubspotMessage || ''].join('||');
          const currentNotesHash = combinedNotesContent ? simpleHash(combinedNotesContent) : null;
          
          if (currentNotesHash && currentNotesHash !== oldNotesHash) {
            const today = new Date().toLocaleDateString('en-US', { 
              year: 'numeric', 
              month: 'short', 
              day: 'numeric',
              timeZone: 'America/Los_Angeles'
            });
            
            if (hubspotNotes) {
              const noteContent = `[Mindbody Notes - ${today}]:\n${sanitizeNoteContent(hubspotNotes)}`;
              await db.insert(memberNotes).values({
                memberEmail: email,
                content: noteContent,
                createdBy: 'system',
                createdByName: 'HubSpot Sync (Mindbody)',
                isPinned: false
              });
            }
            
            if (hubspotMessage) {
              const msgContent = `[Mindbody Message - ${today}]:\n${sanitizeNoteContent(hubspotMessage)}`;
              await db.insert(memberNotes).values({
                memberEmail: email,
                content: msgContent,
                createdBy: 'system',
                createdByName: 'HubSpot Sync (Mindbody)',
                isPinned: false
              });
            }
            
            await db.update(users)
              .set({ lastHubspotNotesHash: currentNotesHash })
              .where(eq(users.email, email));
          }
          
          return { email, statusChanged: oldStatus !== null && oldStatus !== status };
        }))
      );
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          synced++;
          if (result.value.statusChanged) {
            statusChanges++;
          }
        } else if (result.status === 'rejected') {
          errors++;
          if (!isProduction) console.error(`[MemberSync] Error syncing contact:`, result.reason);
        }
      }
    }
    
    if (!isProduction) console.log(`[MemberSync] Focused sync complete - Synced: ${synced}, Errors: ${errors}, Status Changes: ${statusChanges}, HubSpot ID Collisions: ${hubspotIdCollisions}, ${skippedNonTransacting} non-transacting skipped, ${stripeProtectedCount} Stripe-protected`);
    
    const contactsWithMergedIds = allContacts.filter(c => c.properties.hs_merged_object_ids);
    if (contactsWithMergedIds.length > 0) {
      if (!isProduction) console.log(`[MemberSync] Processing ${contactsWithMergedIds.length} contacts with merged IDs`);
      
      const mergedIdsByPrimaryEmail = new Map<string, string[]>();
      for (const contact of contactsWithMergedIds) {
        const primaryEmail = contact.properties.email?.toLowerCase();
        if (!primaryEmail) continue;
        
        const mergedIds = contact.properties.hs_merged_object_ids!
          .split(';')
          .map(id => id.trim())
          .filter(id => id.length > 0);
        
        if (mergedIds.length > 0) {
          mergedIdsByPrimaryEmail.set(primaryEmail, mergedIds);
        }
      }
      
      const allMergedIds = [...new Set([...mergedIdsByPrimaryEmail.values()].flat())];
      const mergedContactEmails = new Map<string, string>();
      
      if (allMergedIds.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < allMergedIds.length; i += BATCH_SIZE) {
          const batchIds = allMergedIds.slice(i, i + BATCH_SIZE);
          try {
            const batchResponse = await hubspot.crm.contacts.batchApi.read({
              inputs: batchIds.map(id => ({ id })),
              properties: ['email'],
              propertiesWithHistory: []
            });
            
            for (const result of batchResponse.results) {
              const email = result.properties?.email?.toLowerCase();
              if (email) {
                mergedContactEmails.set(result.id, email);
              }
            }
          } catch (err) {
            if (!isProduction) console.error(`[MemberSync] Error fetching merged contacts:`, err);
          }
          
          if (i + BATCH_SIZE < allMergedIds.length) {
            await delay(500);
          }
        }
        
        let linkedEmailsAdded = 0;
        for (const [primaryEmail, mergedIds] of mergedIdsByPrimaryEmail) {
          for (const mergedId of mergedIds) {
            const mergedEmail = mergedContactEmails.get(mergedId);
            if (mergedEmail && mergedEmail !== primaryEmail) {
              try {
                await db.insert(userLinkedEmails)
                  .values({
                    primaryEmail,
                    linkedEmail: mergedEmail,
                    source: 'hubspot_merge'
                  })
                  .onConflictDoNothing();
                linkedEmailsAdded++;
              } catch (err) {
                console.error('[MemberSync] Failed to add linked email from HubSpot merge:', err);
              }
            }
          }
        }
        
        if (!isProduction && linkedEmailsAdded > 0) {
          console.log(`[MemberSync] Added ${linkedEmailsAdded} linked emails from HubSpot merged contacts`);
        }
      }
    }
    
    const dealSyncStatuses = ['active', 'declined', 'suspended', 'expired', 'terminated', 'cancelled', 'froze', 'non-member', 'frozen', 'past_due', 'past due', 'pastdue'];
    const contactsNeedingDealSync = allContacts.filter(c => {
      const email = c.properties.email?.toLowerCase();
      const status = (c.properties.membership_status || 'non-member').toLowerCase();
      return email && dealSyncStatuses.includes(status);
    });
    
    if (contactsNeedingDealSync.length > 0) {
      if (!isProduction) console.log(`[MemberSync] Starting deal sync for ${contactsNeedingDealSync.length} members (throttled)`);
      
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
        
        if (i + BATCH_SIZE < contactsNeedingDealSync.length) {
          await delay(BATCH_DELAY_MS);
        }
      }
      
      if (!isProduction) console.log(`[MemberSync] Deal sync complete for ${contactsNeedingDealSync.length} members`);
    }
    
    if (synced > 0) {
      broadcastMemberDataUpdated([]);
      broadcastDataIntegrityUpdate('data_changed', { source: 'hubspot_sync' });
    }
    
    await alertOnHubSpotSyncComplete(synced, errors, allContacts.length);
    
    return { synced, errors };
  } catch (error) {
    console.error('[MemberSync] Fatal error in focused sync:', error);
    await alertOnSyncFailure(
      'hubspot',
      'Focused member sync from HubSpot',
      error instanceof Error ? error : new Error(String(error))
    );
    return { synced: 0, errors: 1 };
  } finally {
    syncInProgress = false;
  }
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

// Sync communication logs (calls) from HubSpot Engagements API
// This is a separate sync that runs less frequently due to higher API cost
let commLogsSyncInProgress = false;
let lastCommLogsSyncTime = 0;
const COMM_LOGS_SYNC_COOLDOWN = 30 * 60 * 1000; // 30 minutes cooldown

export async function syncCommunicationLogsFromHubSpot(): Promise<{ synced: number; errors: number }> {
  if (commLogsSyncInProgress) {
    if (!isProduction) console.log('[CommLogs] Sync already in progress, skipping');
    return { synced: 0, errors: 0 };
  }
  
  const now = Date.now();
  if (now - lastCommLogsSyncTime < COMM_LOGS_SYNC_COOLDOWN) {
    if (!isProduction) console.log('[CommLogs] Sync cooldown active, skipping');
    return { synced: 0, errors: 0 };
  }
  
  commLogsSyncInProgress = true;
  lastCommLogsSyncTime = now;
  
  let synced = 0;
  let errors = 0;
  
  try {
    const hubspot = await getHubSpotClient();
    
    // Get all active member emails with HubSpot IDs for efficient lookup
    const membersResult = await db.select({
      email: users.email,
      hubspotId: users.hubspotId
    })
    .from(users)
    .where(sql`${users.hubspotId} IS NOT NULL AND ${users.archivedAt} IS NULL`);
    
    const emailByHubSpotId = new Map<string, string>();
    for (const m of membersResult) {
      if (m.hubspotId) {
        emailByHubSpotId.set(m.hubspotId, m.email);
      }
    }
    
    if (!isProduction) console.log(`[CommLogs] Found ${emailByHubSpotId.size} members with HubSpot IDs`);
    
    // Fetch calls from HubSpot (paginated)
    const callProperties = [
      'hs_call_body',
      'hs_call_direction',
      'hs_call_disposition',
      'hs_call_duration',
      'hs_call_from_number',
      'hs_call_status',
      'hs_call_title',
      'hs_call_to_number',
      'hs_timestamp',
      'hubspot_owner_id'
    ];
    
    let allCalls: any[] = [];
    let after: string | undefined = undefined;
    
    // Limit to last 90 days of calls to avoid processing too much data
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    do {
      try {
        const response = await hubspot.crm.objects.calls.basicApi.getPage(
          100,
          after,
          callProperties
        );
        
        // Filter to recent calls only
        const recentCalls = response.results.filter((call: any) => {
          const timestamp = call.properties?.hs_timestamp;
          if (!timestamp) return false;
          return new Date(timestamp) >= ninetyDaysAgo;
        });
        
        allCalls = allCalls.concat(recentCalls);
        after = response.paging?.next?.after;
        
        // Rate limiting: pause between pages
        await delay(200);
      } catch (err: unknown) {
        // Handle rate limits gracefully
        if (getErrorStatusCode(err) === 429) {
          if (!isProduction) console.log('[CommLogs] Rate limited, waiting 10 seconds...');
          await delay(10000);
          continue;
        }
        throw err;
      }
    } while (after && allCalls.length < 1000); // Cap at 1000 calls per sync
    
    if (!isProduction) console.log(`[CommLogs] Fetched ${allCalls.length} calls from HubSpot`);
    
    // Process calls in batches
    const BATCH_SIZE = 10;
    const callLimit = pLimit(BATCH_SIZE);
    
    for (let i = 0; i < allCalls.length; i += BATCH_SIZE) {
      const batch = allCalls.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(call =>
          callLimit(async () => {
            try {
              const callId = call.id;
              const props = call.properties || {};
              
              // Check if this call already exists
              const existingLog = await db.select({ id: communicationLogs.id })
                .from(communicationLogs)
                .where(eq(communicationLogs.hubspotEngagementId, callId))
                .limit(1);
              
              if (existingLog.length > 0) {
                return; // Already synced
              }
              
              // Get associated contact for this call
              let memberEmail: string | null = null;
              
              try {
                const associations = await (hubspot.crm.objects.calls as any).associationsApi.getAll(
                  callId,
                  'contacts'
                );
                
                if (associations.results && associations.results.length > 0) {
                  const contactId = associations.results[0].id;
                  memberEmail = emailByHubSpotId.get(contactId) || null;
                  
                  // If not in our map, try to fetch the contact directly
                  if (!memberEmail) {
                    try {
                      const contact = await hubspot.crm.contacts.basicApi.getById(contactId, ['email']);
                      memberEmail = contact.properties?.email?.toLowerCase() || null;
                    } catch {
                      // Contact not found
                    }
                  }
                }
              } catch {
                // Associations not available
              }
              
              if (!memberEmail) {
                return; // Can't associate with a member
              }
              
              // Determine direction
              const direction = props.hs_call_direction === 'INBOUND' ? 'inbound' : 'outbound';
              
              // Parse timestamp
              const occurredAt = props.hs_timestamp ? new Date(props.hs_timestamp) : new Date();
              
              // Build call body/subject
              const subject = props.hs_call_title || 
                `${direction === 'inbound' ? 'Inbound' : 'Outbound'} Call`;
              
              let body = props.hs_call_body || '';
              if (props.hs_call_duration) {
                const durationSecs = parseInt(props.hs_call_duration);
                const mins = Math.floor(durationSecs / 60);
                const secs = durationSecs % 60;
                body = `Duration: ${mins}m ${secs}s\n${body}`.trim();
              }
              if (props.hs_call_disposition) {
                body = `Outcome: ${props.hs_call_disposition}\n${body}`.trim();
              }
              
              // Determine status based on disposition
              let status = 'completed';
              if (props.hs_call_status === 'NO_ANSWER') status = 'no_answer';
              if (props.hs_call_status === 'BUSY') status = 'busy';
              if (props.hs_call_status === 'FAILED') status = 'failed';
              
              // Insert the call log
              await db.insert(communicationLogs).values({
                memberEmail,
                type: 'call',
                direction,
                subject,
                body: body || null,
                status,
                hubspotEngagementId: callId,
                hubspotSyncedAt: new Date(),
                loggedBy: 'system',
                loggedByName: 'HubSpot Sync',
                occurredAt,
                createdAt: new Date(),
                updatedAt: new Date()
              });
              
              synced++;
            } catch (err) {
              errors++;
              if (!isProduction) console.error('[CommLogs] Error processing call:', err);
            }
          })
        )
      );
      
      // Rate limiting between batches
      if (i + BATCH_SIZE < allCalls.length) {
        await delay(500);
      }
    }
    
    // Also fetch SMS/communications if available (HubSpot Communications object)
    try {
      let allComms: any[] = [];
      let commAfter: string | undefined = undefined;
      
      const commProperties = [
        'hs_communication_channel_type',
        'hs_communication_body',
        'hs_timestamp',
        'hubspot_owner_id'
      ];
      
      do {
        try {
          // HubSpot stores SMS in the 'communications' object type
          const response = await hubspot.apiRequest({
            method: 'GET',
            path: `/crm/v3/objects/communications?limit=100${commAfter ? `&after=${commAfter}` : ''}&properties=${commProperties.join(',')}`
          });
          
          const data = await response.json();
          
          // Filter to SMS/text messages and recent ones
          const recentComms = (data.results || []).filter((comm: any) => {
            const channelType = comm.properties?.hs_communication_channel_type;
            const timestamp = comm.properties?.hs_timestamp;
            if (!timestamp) return false;
            // Filter to SMS/WhatsApp type communications
            return (channelType === 'SMS' || channelType === 'WHATS_APP') &&
                   new Date(timestamp) >= ninetyDaysAgo;
          });
          
          allComms = allComms.concat(recentComms);
          commAfter = data.paging?.next?.after;
          
          await delay(200);
        } catch (err: unknown) {
          if (getErrorStatusCode(err) === 429) {
            await delay(10000);
            continue;
          }
          // Communications object may not be available in all HubSpot accounts
          if (!isProduction) console.log('[CommLogs] Communications object not available, skipping SMS sync');
          break;
        }
      } while (commAfter && allComms.length < 500);
      
      if (!isProduction && allComms.length > 0) {
        console.log(`[CommLogs] Fetched ${allComms.length} SMS/communications from HubSpot`);
      }
      
      // Process SMS communications
      for (const comm of allComms) {
        try {
          const commId = comm.id;
          const props = comm.properties || {};
          
          // Check if already synced
          const existingSms = await db.select({ id: communicationLogs.id })
            .from(communicationLogs)
            .where(eq(communicationLogs.hubspotEngagementId, `sms_${commId}`))
            .limit(1);
          
          if (existingSms.length > 0) continue;
          
          // Get associated contact
          let memberEmail: string | null = null;
          try {
            const assocResponse = await hubspot.apiRequest({
              method: 'GET',
              path: `/crm/v3/objects/communications/${commId}/associations/contacts`
            });
            const assocData = await assocResponse.json();
            
            if (assocData.results && assocData.results.length > 0) {
              const contactId = assocData.results[0].id;
              memberEmail = emailByHubSpotId.get(contactId) || null;
              
              if (!memberEmail) {
                try {
                  const contact = await hubspot.crm.contacts.basicApi.getById(contactId, ['email']);
                  memberEmail = contact.properties?.email?.toLowerCase() || null;
                } catch {
                  // Contact not found
                }
              }
            }
          } catch {
            // Associations not available
          }
          
          if (!memberEmail) continue;
          
          const occurredAt = props.hs_timestamp ? new Date(props.hs_timestamp) : new Date();
          const channelType = props.hs_communication_channel_type === 'WHATS_APP' ? 'whatsapp' : 'sms';
          
          await db.insert(communicationLogs).values({
            memberEmail,
            type: channelType,
            direction: 'outbound', // Default to outbound for synced SMS
            subject: `${channelType.toUpperCase()} Message`,
            body: props.hs_communication_body || null,
            status: 'sent',
            hubspotEngagementId: `sms_${commId}`,
            hubspotSyncedAt: new Date(),
            loggedBy: 'system',
            loggedByName: 'HubSpot Sync',
            occurredAt,
            createdAt: new Date(),
            updatedAt: new Date()
          });
          
          synced++;
        } catch (err) {
          errors++;
          if (!isProduction) console.error('[CommLogs] Error processing SMS:', err);
        }
      }
      
    } catch (err) {
      // SMS sync is optional, don't fail the whole sync
      if (!isProduction) console.log('[CommLogs] SMS sync skipped:', err);
    }
    
    if (!isProduction) console.log(`[CommLogs] Complete - Synced: ${synced}, Errors: ${errors}`);
    
    return { synced, errors };
  } catch (error) {
    console.error('[CommLogs] Fatal error:', error);
    return { synced: 0, errors: 1 };
  } finally {
    commLogsSyncInProgress = false;
  }
}

export function triggerCommunicationLogsSync(): void {
  syncCommunicationLogsFromHubSpot().catch(err => {
    console.error('[CommLogs] Background sync failed:', err);
  });
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

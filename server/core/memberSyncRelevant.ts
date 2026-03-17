import { db } from '../db';
import { formatDatePacific } from '../utils/dateUtils';
import { users, membershipTiers } from '../../shared/schema';
import { memberNotes, userLinkedEmails } from '../../shared/models/membership';
import { getHubSpotClient } from './integrations';
import { normalizeTierName } from '../../shared/constants/tiers';
import { sql, eq } from 'drizzle-orm';
import { broadcastMemberDataUpdated, broadcastDataIntegrityUpdate } from './websocket';
import { alertOnHubSpotSyncComplete, alertOnSyncFailure } from './dataAlerts';
import { retryableHubSpotRequest } from './hubspot/request';
import pLimit from 'p-limit';
import { logger } from './logger';
import {
  type SyncExclusionRow,
  type HubSpotContact,
  isRecognizedTier,
  delay,
  detectAndNotifyStatusChange,
  simpleHash,
  getSyncInProgress,
  setSyncInProgress,
  getLastSyncTime,
  setLastSyncTime,
  SYNC_COOLDOWN,
  getLastMemberSyncTime,
  isProduction,
  parseOptIn,
  getNameFromContact,
  retryDbOperation,
} from './memberSyncHelpers';

export async function syncRelevantMembersFromHubSpot(): Promise<{ synced: number; errors: number }> {
  if (getSyncInProgress()) {
    if (!isProduction) logger.info('[MemberSync] Sync already in progress, skipping');
    return { synced: 0, errors: 0 };
  }
  
  const now = Date.now();
  if (now - getLastSyncTime() < SYNC_COOLDOWN) {
    if (!isProduction) logger.info('[MemberSync] Sync cooldown active, skipping');
    return { synced: 0, errors: 0 };
  }
  
  const previousSyncTime = getLastMemberSyncTime();
  setSyncInProgress(true);
  setLastSyncTime(now);
  
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
      'last_modified_at',
      'hs_merged_object_ids'
    ];
    
    const relevantStatuses = ['active', 'Active', 'trialing', 'past_due', 'past due', 'pastdue', 'frozen', 'froze', 'Froze', 'suspended', 'Suspended', 'declined', 'Declined', 'Pending', 'pending'];
    
    const filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; values?: string[]; value?: string }> }> = [
      {
        filters: [
          {
            propertyName: 'membership_status',
            operator: 'IN',
            values: relevantStatuses
          }
        ]
      },
      {
        filters: [
          {
            propertyName: 'mindbody_client_id',
            operator: 'HAS_PROPERTY'
          }
        ]
      }
    ];
    if (previousSyncTime > 0) {
      const timeFilter = {
        propertyName: 'lastmodifieddate',
        operator: 'GTE',
        value: new Date(previousSyncTime).toISOString()
      };
      for (const group of filterGroups) {
        group.filters.push(timeFilter);
      }
      logger.info(`[MemberSync] Focused sync: using time filter since ${new Date(previousSyncTime).toISOString()}`);
    } else {
      logger.info('[MemberSync] Focused sync: no previous sync time, fetching all matching contacts');
    }
    
    let allContacts: HubSpotContact[] = [];
    let after: string | undefined = undefined;
    
    do {
      const searchRequest: Record<string, unknown> = {
        filterGroups,
        properties,
        limit: 100,
        ...(after ? { after } : {})
      };
      
      const response = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch(searchRequest));
      allContacts = allContacts.concat(response.results as unknown as HubSpotContact[]);
      after = response.paging?.next?.after;
    } while (after);
    
    logger.info(`[MemberSync] Focused sync: fetched ${allContacts.length} relevant contacts from HubSpot`);
    
    const exclusionResult = await db.execute(sql`SELECT email FROM sync_exclusions`);
    const excludedEmails = new Set((exclusionResult.rows as unknown as SyncExclusionRow[]).map(r => r.email?.toLowerCase()));
    
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
    let skippedArchived = 0;
    let stripeProtectedCount = 0;
    
    const skipStatuses = ['non-member', 'archived', 'cancelled', 'expired', 'terminated'];
    
    const SYNC_BATCH_SIZE = 25;
    const syncLimit = pLimit(5);
    
    for (let i = 0; i < allContacts.length; i += SYNC_BATCH_SIZE) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      const batch = allContacts.slice(i, i + SYNC_BATCH_SIZE);
      
      const results = await Promise.allSettled(
        batch.map(contact => syncLimit(async () => {
          let email = contact.properties.email?.toLowerCase();
          if (!email) return null;
          
          if (excludedEmails.has(email)) {
            if (!isProduction) logger.info(`[MemberSync] Skipping excluded email: ${email}`);
            return null;
          }
          
          const status = (contact.properties.membership_status || 'non-member').toLowerCase();
          
          const rawTier = contact.properties.membership_tier;
          let normalizedTier: string | null = null;
          
          if (isRecognizedTier(rawTier)) {
            normalizedTier = normalizeTierName(rawTier);
          } else if (rawTier && rawTier.trim()) {
            logger.warn(`[MemberSync] UNRECOGNIZED TIER "${rawTier}" for ${email} - requires manual mapping, tier will not be updated`);
          }
          const tierId = normalizedTier ? (tierCache.get(normalizedTier.toLowerCase()) || null) : null;
          const tags: string[] = [];
          const discountCode = contact.properties.membership_discount_reason?.trim() || null;
          
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
                joinDate = formatDatePacific(createDate);
              }
            } catch (e: unknown) {
              logger.error('[MemberSync] Failed to parse createdate:', { error: e });
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
            logger.info(`[MemberSync] HubSpot email ${email} resolved to existing user ${resolvedSync.primaryEmail} via ${resolvedSync.matchType}`);
            email = resolvedSync.primaryEmail.toLowerCase();
          }

          const existingUser = await retryDbOperation(() => db.select({ 
            membershipStatus: users.membershipStatus,
            billingProvider: users.billingProvider,
            lastHubspotNotesHash: users.lastHubspotNotesHash,
            role: users.role,
            tier: users.tier,
            migrationStatus: users.migrationStatus,
            archivedAt: users.archivedAt,
            lastManualFixAt: users.lastManualFixAt,
            lastModifiedAt: users.lastModifiedAt,
            updatedAt: users.updatedAt,
          })
            .from(users)
            .where(eq(users.email, email))
            .limit(1), email);
          const oldStatus = existingUser[0]?.membershipStatus || null;
          const oldNotesHash = existingUser[0]?.lastHubspotNotesHash || null;
          
          if (existingUser[0]?.archivedAt) {
            skippedArchived++;
            return null;
          }
          
          if (!existingUser[0] && skipStatuses.includes(status) && !contact.properties.mindbody_client_id) {
            skippedNonTransacting++;
            return null;
          }
          
          const isVisitorProtected = existingUser[0]?.role === 'visitor';
          const isMindBodyBilled = existingUser[0]?.billingProvider === 'mindbody';
          const isCurrentlyActive = existingUser[0]?.membershipStatus === 'active';
          const isMindBodyActiveAllowStatus = isMindBodyBilled && isCurrentlyActive;
          const hasPendingMigration = existingUser[0]?.migrationStatus === 'pending';
          const recentlyManuallyFixed = existingUser[0]?.lastManualFixAt &&
            (Date.now() - new Date(existingUser[0].lastManualFixAt).getTime()) < 60 * 60 * 1000;
          const isStatusProtected = isVisitorProtected || !isMindBodyActiveAllowStatus || hasPendingMigration || !!recentlyManuallyFixed;
          const isMindBodyDeactivation = isMindBodyBilled && isCurrentlyActive && status !== 'active' && !hasPendingMigration && !recentlyManuallyFixed;

          if (recentlyManuallyFixed) {
            logger.info(`[MemberSync] MANUAL FIX PROTECTED: Skipping status/tier update for ${email} — manually fixed recently`);
          } else if (hasPendingMigration && isMindBodyBilled && isCurrentlyActive && status !== 'active') {
            logger.info(`[MemberSync] Skipping deactivation cascade for ${email} — pending migration to Stripe`);
          } else if (existingUser[0]?.billingProvider === 'stripe') {
            stripeProtectedCount++;
            logger.info(`[MemberSync] APP DB PRIMARY: Skipping status/tier update for Stripe-billed member ${email} (HubSpot status: ${status})`);
          } else if (isVisitorProtected) {
            logger.info(`[MemberSync] VISITOR PROTECTED: Skipping status/tier/role update for visitor ${email} (HubSpot status: ${status})`);
          } else if (isMindBodyDeactivation) {
            logger.info(`[MemberSync] MINDBODY DEACTIVATION: ${email} status changing from active to ${status} — will remove tier and set billing_provider to stripe`);
          } else if (isMindBodyActiveAllowStatus) {
            logger.info(`[MemberSync] MINDBODY ACTIVE: Allowing HubSpot status update for ${email} (HubSpot status: ${status})`);
          } else {
            logger.info(`[MemberSync] APP DB PRIMARY: Skipping status/tier update for ${email} (billing: ${existingUser[0]?.billingProvider || 'default'}, HubSpot status: ${status})`);
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

          let statusChangedDate: Date | null = null;
          if (contact.properties.last_modified_at) {
            const parsed = new Date(contact.properties.last_modified_at);
            if (!isNaN(parsed.getTime())) {
              statusChangedDate = parsed;
            }
          }

          const isBackfillArtifact = existingUser[0]?.lastModifiedAt && existingUser[0]?.updatedAt
            && Math.abs(new Date(existingUser[0].lastModifiedAt).getTime() - new Date(existingUser[0].updatedAt!).getTime()) < 2000;
          
          await retryDbOperation(() => db.insert(users)
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
              billingProvider: 'stripe',
              mindbodyClientId: contact.properties.mindbody_client_id || null,
              joinDate,
              emailOptIn,
              smsOptIn,
              smsPromoOptIn,
              smsTransactionalOptIn,
              smsRemindersOptIn,
              stripeDelinquent,
              discountCode,
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
                tier: isVisitorProtected ? sql`${users.tier}` : (isMindBodyDeactivation ? sql`NULL` : sql`COALESCE(${users.tier}, ${normalizedTier})`),
                lastTier: isVisitorProtected ? sql`${users.lastTier}` : (isMindBodyDeactivation ? sql`COALESCE(${users.tier}, ${users.lastTier})` : sql`${users.lastTier}`),
                tierId: isVisitorProtected ? sql`${users.tierId}` : (isMindBodyDeactivation ? sql`NULL` : sql`COALESCE(${users.tierId}, ${tierId})`),
                tags: tags.length > 0 ? tags : sql`${users.tags}`,
                hubspotId: contact.id,
                membershipStatus: isStatusProtected ? sql`${users.membershipStatus}` : status,
                billingProvider: isMindBodyDeactivation ? sql`'stripe'` : sql`${users.billingProvider}`,
                role: isVisitorProtected ? sql`${users.role}` : sql`COALESCE(${users.role}, 'member')`,
                mindbodyClientId: contact.properties.mindbody_client_id || null,
                joinDate: joinDate ? joinDate : sql`${users.joinDate}`,
                emailOptIn: emailOptIn !== null ? emailOptIn : sql`${users.emailOptIn}`,
                smsOptIn: smsOptIn !== null ? smsOptIn : sql`${users.smsOptIn}`,
                smsPromoOptIn: smsPromoOptIn !== null ? smsPromoOptIn : sql`${users.smsPromoOptIn}`,
                smsTransactionalOptIn: smsTransactionalOptIn !== null ? smsTransactionalOptIn : sql`${users.smsTransactionalOptIn}`,
                smsRemindersOptIn: smsRemindersOptIn !== null ? smsRemindersOptIn : sql`${users.smsRemindersOptIn}`,
                stripeDelinquent: stripeDelinquent !== null ? stripeDelinquent : sql`${users.stripeDelinquent}`,
                discountCode: discountCode !== null ? discountCode : sql`${users.discountCode}`,
                streetAddress: sql`COALESCE(${streetAddress}, ${users.streetAddress})`,
                city: sql`COALESCE(${city}, ${users.city})`,
                state: sql`COALESCE(${state}, ${users.state})`,
                zipCode: sql`COALESCE(${zipCode}, ${users.zipCode})`,
                dateOfBirth: sql`COALESCE(${dateOfBirth}, ${users.dateOfBirth})`,
                lastSyncedAt: new Date(),
                updatedAt: new Date()
              }
            }), email);

          if (!isStatusProtected && oldStatus && oldStatus !== status) {
            await retryDbOperation(() => db.execute(
              statusChangedDate
                ? sql`UPDATE users SET membership_status_changed_at = ${statusChangedDate.toISOString()}::timestamptz WHERE LOWER(email) = ${email.toLowerCase()}`
                : sql`UPDATE users SET membership_status_changed_at = NOW() WHERE LOWER(email) = ${email.toLowerCase()}`
            ), email);
          } else if (isBackfillArtifact && statusChangedDate) {
            await retryDbOperation(() => db.execute(
              sql`UPDATE users SET membership_status_changed_at = ${statusChangedDate.toISOString()}::timestamptz WHERE LOWER(email) = ${email.toLowerCase()}`
            ), email);
          }

          if (isMindBodyDeactivation) {
            logger.info(`[MemberSync] MINDBODY DEACTIVATION CASCADE: ${email} — tier removed, billing_provider set to stripe. Must reactivate via Stripe.`);
            try {
              const { syncTierToHubSpot } = await import('./hubspot/members');
              syncTierToHubSpot({ email, newTier: '', oldTier: existingUser[0]?.tier || undefined }).catch(err => {
                logger.error(`[MemberSync] Failed to push deactivation to HubSpot for ${email}:`, { error: err });
              });
            } catch (err) {
              logger.error(`[MemberSync] Failed to import syncTierToHubSpot for ${email}:`, { error: err });
            }
          }
          
          if (oldStatus !== status && !isStatusProtected) {
            detectAndNotifyStatusChange(email, firstName, lastName, oldStatus, status).catch(err => {
              logger.error(`[MemberSync] Failed to notify status change for ${email}:`, { error: err });
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
                logger.warn(`[MemberSync] HubSpot ID collision detected: ${email} and ${dup.email} share HubSpot contact ${contact.id}. These may be the same person.`);
                
                await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_at)
                   VALUES (${email}, ${dup.email}, 'hubspot_dedup', NOW())
                   ON CONFLICT (linked_email) DO NOTHING`);
              }
              hubspotIdCollisions++;
            }
          } catch (dupError: unknown) {
            logger.error(`[MemberSync] Error checking for HubSpot ID collisions:`, { error: dupError });
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
              await retryDbOperation(() => db.insert(memberNotes).values({
                memberEmail: email,
                content: noteContent,
                createdBy: 'system',
                createdByName: 'HubSpot Sync (Mindbody)',
                isPinned: false
              }), email);
            }
            
            if (hubspotMessage) {
              const msgContent = `[Mindbody Message - ${today}]:\n${sanitizeNoteContent(hubspotMessage)}`;
              await retryDbOperation(() => db.insert(memberNotes).values({
                memberEmail: email,
                content: msgContent,
                createdBy: 'system',
                createdByName: 'HubSpot Sync (Mindbody)',
                isPinned: false
              }), email);
            }
            
            await retryDbOperation(() => db.update(users)
              .set({ lastHubspotNotesHash: currentNotesHash })
              .where(eq(users.email, email)), email);
          }
          
          return { email, statusChanged: oldStatus !== null && oldStatus !== status };
        }))
      );
      
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled' && result.value) {
          synced++;
          if (result.value.statusChanged) {
            statusChanges++;
          }
        } else if (result.status === 'rejected') {
          errors++;
          const failedEmail = batch[j]?.properties?.email || 'unknown';
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          logger.error(`[MemberSync] Failed to sync contact ${failedEmail}: ${errMsg}`);
        }
      }
    }
    
    logger.info(`[MemberSync] Focused sync complete - Synced: ${synced}, Errors: ${errors}, Status Changes: ${statusChanges}, HubSpot ID Collisions: ${hubspotIdCollisions}, ${skippedNonTransacting} non-transacting skipped, ${skippedArchived} archived skipped, ${stripeProtectedCount} Stripe-protected`);
    
    const contactsWithMergedIds = allContacts.filter(c => c.properties.hs_merged_object_ids);
    if (contactsWithMergedIds.length > 0) {
      if (!isProduction) logger.info(`[MemberSync] Processing ${contactsWithMergedIds.length} contacts with merged IDs`);
      
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
            const batchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.batchApi.read({
              inputs: batchIds.map(id => ({ id })),
              properties: ['email'],
              propertiesWithHistory: []
            }));
            
            for (const result of batchResponse.results) {
              const email = result.properties?.email?.toLowerCase();
              if (email) {
                mergedContactEmails.set(result.id, email);
              }
            }
          } catch (err: unknown) {
            if (!isProduction) logger.error(`[MemberSync] Error fetching merged contacts:`, { error: err });
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
              } catch (err: unknown) {
                logger.error('[MemberSync] Failed to add linked email from HubSpot merge:', { error: err });
              }
            }
          }
        }
        
        if (!isProduction && linkedEmailsAdded > 0) {
          logger.info(`[MemberSync] Added ${linkedEmailsAdded} linked emails from HubSpot merged contacts`);
        }
      }
    }
    
    if (synced > 0) {
      broadcastMemberDataUpdated([]);
      broadcastDataIntegrityUpdate('data_changed', { source: 'hubspot_sync' });
    }
    
    await alertOnHubSpotSyncComplete(synced, errors, allContacts.length);
    
    try {
      const { processPendingMigrations } = await import('./stripe/billingMigration');
      const migrationResult = await processPendingMigrations();
      if (migrationResult.processed > 0) {
        logger.info(`[MemberSync] Post-sync migration processing: ${migrationResult.succeeded} succeeded, ${migrationResult.failed} failed, ${migrationResult.skipped} skipped`);
      }
    } catch (migrationError: unknown) {
      logger.error('[MemberSync] Error processing pending migrations after sync:', { error: migrationError });
    }
    
    return { synced, errors };
  } catch (error: unknown) {
    logger.error('[MemberSync] Fatal error in focused sync:', { error: error });
    await alertOnSyncFailure(
      'hubspot',
      'Focused member sync from HubSpot',
      error instanceof Error ? error : new Error(String(error))
    );
    return { synced: 0, errors: 1 };
  } finally {
    setSyncInProgress(false);
  }
}

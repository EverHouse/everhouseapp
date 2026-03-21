import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { isProduction } from '../../core/db';
import { sql } from 'drizzle-orm';
import { isAdmin } from '../../core/middleware';
import { getHubSpotClientWithFallback } from '../../core/integrations';
import { retryableHubSpotRequest } from '../../core/hubspot/request';
import { logFromRequest, logBillingAudit } from '../../core/auditLog';
import { getSessionUser } from '../../types/session';
import { syncCustomerMetadataToStripe } from '../../core/stripe/customers';
import { bulkPushToHubSpot } from '../../core/dataIntegrity';
import { normalizeTierName } from '@shared/constants/tiers';
import { getErrorMessage, getErrorStatusCode, safeErrorDetail } from '../../utils/errorUtils';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';

interface DbUserRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  tier: string | null;
  hubspot_id: string | null;
  stripe_customer_id: string | null;
  membership_status: string | null;
  mindbody_client_id: string | null;
  role: string;
  billing_provider: string | null;
}

const router = Router();

router.post('/api/data-tools/resync-member', isAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const existingUser = await db.execute(sql`SELECT id, first_name, last_name, tier, hubspot_id FROM users WHERE LOWER(email) = ${normalizedEmail}`);
    
    if (existingUser.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in database' });
    }
    
    const user = existingUser.rows[0] as unknown as DbUserRow;
    let hubspotContactId = user.hubspot_id;
    
    const { client: hubspot } = await getHubSpotClientWithFallback();
    
    if (!hubspotContactId) {
      const searchResponse = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: FilterOperatorEnum.Eq,
              value: normalizedEmail
            }]
          }],
          properties: ['email', 'firstname', 'lastname', 'phone', 'membership_tier', 'membership_status'],
          limit: 1
        })
      );
      
      if (!searchResponse.results || searchResponse.results.length === 0) {
        return res.status(404).json({ error: 'Member not found in HubSpot' });
      }
      
      hubspotContactId = searchResponse.results[0].id;
    }
    
    let contactResponse;
    try {
      contactResponse = await retryableHubSpotRequest(() =>
        hubspot.crm.contacts.basicApi.getById(hubspotContactId!, [
          'email',
          'firstname',
          'lastname',
          'phone',
          'membership_tier',
          'membership_status',
          'lifecyclestage'
        ])
      );
    } catch (getByIdError: unknown) {
      const statusCode = getErrorStatusCode(getByIdError);
      if (statusCode === 404) {
        const searchResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{
                propertyName: 'email',
                operator: FilterOperatorEnum.Eq,
                value: normalizedEmail
              }]
            }],
            properties: ['email', 'firstname', 'lastname', 'phone', 'membership_tier', 'membership_status', 'lifecyclestage'],
            limit: 1
          })
        );

        if (!searchResponse.results || searchResponse.results.length === 0) {
          return res.status(404).json({
            error: 'Contact not found in HubSpot. The stored HubSpot ID may be stale (contact was deleted or merged in HubSpot).',
            staleHubspotId: hubspotContactId
          });
        }

        hubspotContactId = searchResponse.results[0].id;
        contactResponse = searchResponse.results[0];

        await db.execute(sql`UPDATE users SET hubspot_id = ${hubspotContactId}, updated_at = NOW() WHERE id = ${user.id}`);
      } else {
        throw getByIdError;
      }
    }
    
    const props = contactResponse.properties;
    
    const updateData: Record<string, unknown> = {
      hubspotId: hubspotContactId,
      updatedAt: new Date()
    };
    
    if (props.firstname) updateData.firstName = props.firstname;
    if (props.lastname) updateData.lastName = props.lastname;
    if (props.phone) updateData.phone = props.phone;
    const normalizedTier = props.membership_tier ? normalizeTierName(props.membership_tier) : null;
    if (normalizedTier) updateData.tier = normalizedTier;
    if (props.membership_status) updateData.membershipStatus = props.membership_status;
    
    await db.execute(sql`UPDATE users SET 
        hubspot_id = ${hubspotContactId},
        first_name = COALESCE(${props.firstname || null}, first_name),
        last_name = COALESCE(${props.lastname || null}, last_name),
        phone = COALESCE(${props.phone || null}, phone),
        tier = COALESCE(${normalizedTier}, tier),
        tier_id = COALESCE((SELECT id FROM membership_tiers WHERE LOWER(name) = LOWER(${normalizedTier}) LIMIT 1), tier_id),
        membership_status = COALESCE(${props.membership_status || null}, membership_status),
        updated_at = NOW()
      WHERE id = ${user.id}`);
    
    syncCustomerMetadataToStripe(normalizedEmail).catch((err) => {
      logger.error('[DataTools] Background Stripe sync after HubSpot resync failed:', { error: getErrorMessage(err) });
    });
    
    await logBillingAudit({
      memberEmail: normalizedEmail,
      actionType: 'member_resynced_from_hubspot',
      actionDetails: {
        source: 'data_tools',
        hubspotContactId,
        syncedFields: Object.keys(updateData).filter(k => k !== 'updatedAt' && k !== 'hubspotId')
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      logger.info('[DataTools] Re-synced member from HubSpot by', { extra: { normalizedEmail, staffEmail } });
    }
    
    logFromRequest(req, 'sync_hubspot', 'member', null, normalizedEmail, {
      action: 'manual_sync'
    });
    
    res.json({
      success: true,
      message: `Successfully synced ${normalizedEmail} from HubSpot`,
      syncedFields: Object.keys(updateData).filter(k => k !== 'updatedAt'),
      hubspotContactId
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Resync member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to resync member', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/bulk-push-to-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const { dryRun = true } = req.body;
    const result = await bulkPushToHubSpot(dryRun);
    if (!dryRun) {
      logFromRequest(req, 'bulk_action', 'member', null, 'bulk-hubspot-push', {
        totalChecked: result.totalChecked,
        totalMismatched: result.totalMismatched,
        totalSynced: result.totalSynced
      });
    }
    res.json(result);
  } catch (error: unknown) {
    logger.error('[DataTools] Bulk push to HubSpot error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to bulk push to HubSpot', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-members-to-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { emails: rawEmails, dryRun = true } = req.body;
    const emails = Array.isArray(rawEmails) ? rawEmails.map((e: string) => e?.trim()?.toLowerCase()).filter(Boolean) : rawEmails;
    
    logger.info('[DataTools] Starting HubSpot sync for members without contacts (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    const queryBuilder = sql`
      SELECT id, email, first_name, last_name, tier, mindbody_client_id, membership_status, role
      FROM users 
      WHERE hubspot_id IS NULL
    `;
    
    if (emails && Array.isArray(emails) && emails.length > 0) {
      queryBuilder.append(sql` AND LOWER(email) IN (${sql.join(emails.map((e: string) => sql`${e.toLowerCase()}`), sql`, `)})`);
    }
    
    queryBuilder.append(sql` ORDER BY email LIMIT 100`);
    
    const membersWithoutHubspot = await db.execute(queryBuilder);
    
    if (membersWithoutHubspot.rows.length === 0) {
      return res.json({ 
        message: 'No members found without HubSpot contacts',
        totalFound: 0,
        created: 0
      });
    }
    
    const { findOrCreateHubSpotContact } = await import('../../core/hubspot/members');
    
    const created: Array<{ email: string; contactId: string }> = [];
    const existing: Array<{ email: string; contactId: string }> = [];
    const errors: string[] = [];
    
    if (!dryRun) {
      for (const member of membersWithoutHubspot.rows as unknown as DbUserRow[]) {
        try {
          const result = await findOrCreateHubSpotContact(
            member.email,
            member.first_name || '',
            member.last_name || '',
            undefined,
            member.tier || undefined,
            { role: member.role }
          );
          
          await db.execute(sql`UPDATE users SET hubspot_id = ${result.contactId}, updated_at = NOW() WHERE id = ${member.id}`);
          
          if (result.isNew) {
            created.push({ email: member.email, contactId: result.contactId });
          } else {
            existing.push({ email: member.email, contactId: result.contactId });
          }
          
          logger.info('[DataTools] HubSpot contact for', { extra: { resultIsNew_Created_Found_existing: result.isNew ? 'Created' : 'Found existing', memberEmail: member.email, resultContactId: result.contactId } });
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: unknown) {
          logger.error('[DataTools] Error syncing  to HubSpot', { extra: { email: member.email, err } });
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
        }
      }
      
      await logFromRequest(req, {
        action: 'sync_members_to_hubspot',
        resourceType: 'users',
        details: {
          created: created.length,
          existing: existing.length,
          errors: errors.length
        }
      });
    }
    
    res.json({
      message: dryRun 
        ? `Dry run: Found ${membersWithoutHubspot.rows.length} members without HubSpot contacts` 
        : `Synced ${created.length + existing.length} members to HubSpot (${created.length} new, ${existing.length} existing)`,
      totalFound: membersWithoutHubspot.rows.length,
      members: (membersWithoutHubspot.rows as unknown as DbUserRow[]).map((m) => ({
        email: m.email,
        name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        tier: m.tier,
        mindbodyClientId: m.mindbody_client_id
      })),
      created: created.length,
      existing: existing.length,
      errors: errors.slice(0, 10)
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Sync members to HubSpot error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync members to HubSpot', details: safeErrorDetail(error) });
  }
});

export default router;

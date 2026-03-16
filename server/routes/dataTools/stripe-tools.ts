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
import { broadcastToStaff } from '../../core/websocket';
import { getErrorMessage, getErrorCode, getErrorStatusCode, safeErrorDetail } from '../../utils/errorUtils';
import Stripe from 'stripe';

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

import { createBackgroundJob, updateJobProgress, completeJob, failJob, getActiveJob, getLatestJob } from '../../core/backgroundJobStore';

const STRIPE_CLEANUP_JOB_TYPE = 'stripe_cleanup';

interface StripeCleanupProgress {
  phase: 'fetching' | 'checking' | 'deleting' | 'done';
  totalCustomers: number;
  checked: number;
  emptyFound: number;
  skippedActiveCount: number;
  deleted: number;
  errors: number;
}

let currentCleanupJobId: string | null = null;
let currentCleanupProgress: StripeCleanupProgress | null = null;

const router = Router();

router.post('/api/data-tools/sync-subscription-status', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting subscription status sync (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    const membersWithStripe = await db.execute(sql`SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, billing_provider
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
         AND role = 'member'
         AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
       ORDER BY email
       LIMIT 500`);
    
    if (membersWithStripe.rows.length === 0) {
      return res.json({ 
        message: 'No members with Stripe customer IDs found',
        totalChecked: 0,
        mismatches: []
      });
    }
    
    const STRIPE_STATUS_TO_APP_STATUS: Record<string, string> = {
      'active': 'active',
      'trialing': 'active',
      'past_due': 'past_due',
      'canceled': 'cancelled',
      'unpaid': 'suspended',
      'incomplete': 'pending',
      'incomplete_expired': 'inactive',
      'paused': 'frozen'
    };
    
    const subscriptionsByCustomer = new Map<string, Stripe.Subscription>();

    for (const status of ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'paused'] as const) {
      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const params: Stripe.SubscriptionListParams = { status, limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;

        const batch = await stripe.subscriptions.list(params);

        for (const sub of batch.data) {
          const custId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
          const existing = subscriptionsByCustomer.get(custId);
          if (!existing || ['active', 'trialing', 'past_due'].includes(sub.status)) {
            if (!existing || !['active', 'trialing', 'past_due'].includes(existing.status)) {
              subscriptionsByCustomer.set(custId, sub);
            }
          }
        }

        hasMore = batch.has_more;
        if (batch.data.length > 0) {
          startingAfter = batch.data[batch.data.length - 1].id;
        }
      }
    }

    logger.info('[DataTools] Fetched all Stripe subscriptions for comparison', { extra: { totalSubscriptions: subscriptionsByCustomer.size } });

    const mismatches: Array<{
      email: string;
      name: string;
      currentStatus: string;
      stripeStatus: string;
      expectedStatus: string;
      stripeCustomerId: string;
      userId: number;
    }> = [];
    
    const updated: Array<{ email: string; oldStatus: string; newStatus: string }> = [];
    const errors: string[] = [];
    
    for (const row of membersWithStripe.rows) {
      const member = row as unknown as DbUserRow;
      try {
          const customerId = member.stripe_customer_id;
          if (!customerId) continue;
          
          const activeSub = subscriptionsByCustomer.get(customerId);
          
          let stripeStatus = 'no_subscription';
          let expectedAppStatus = 'inactive';
          
          if (activeSub) {
            stripeStatus = activeSub.status;
            expectedAppStatus = STRIPE_STATUS_TO_APP_STATUS[stripeStatus] || 'inactive';
          }
          
          const currentStatus = (member.membership_status || '').toLowerCase();
          const normalizedExpected = expectedAppStatus.toLowerCase();
          
          const statusMatches = currentStatus === normalizedExpected ||
            (currentStatus === 'active' && ['active', 'trialing'].includes(stripeStatus)) ||
            (currentStatus === 'cancelled' && stripeStatus === 'canceled') ||
            (currentStatus === 'terminated' && stripeStatus === 'canceled') ||
            (currentStatus === 'non-member' && stripeStatus === 'canceled') ||
            (currentStatus === 'pending' && ['incomplete', 'trialing'].includes(stripeStatus)) ||
            (currentStatus === 'frozen' && ['paused', 'past_due'].includes(stripeStatus)) ||
            (currentStatus === 'suspended' && ['unpaid', 'past_due'].includes(stripeStatus));
          
          if (!statusMatches) {
            const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
            
            mismatches.push({
              email: member.email,
              name: memberName,
              currentStatus: member.membership_status || 'none',
              stripeStatus,
              expectedStatus: expectedAppStatus,
              stripeCustomerId: customerId,
              userId: member.id
            });
            
            if (!dryRun) {
              await db.execute(sql`UPDATE users 
                 SET membership_status = ${expectedAppStatus}, last_modified_at = CASE WHEN membership_status IS DISTINCT FROM ${expectedAppStatus} THEN NOW() ELSE last_modified_at END, billing_provider = 'stripe', updated_at = NOW() 
                 WHERE id = ${member.id}`);
              
              try {
                const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
                await syncMemberToHubSpot({ email: member.email, status: expectedAppStatus, billingProvider: 'stripe' });
              } catch (e: unknown) {
                logger.warn('[DataTools] Failed to sync status to HubSpot for', { extra: { email: member.email, error: getErrorMessage(e) } });
              }
              
              await logBillingAudit({
                memberEmail: member.email,
                actionType: 'subscription_status_synced',
                previousValue: member.membership_status || 'none',
                newValue: expectedAppStatus,
                actionDetails: {
                  source: 'data_tools',
                  stripeCustomerId: customerId,
                  stripeSubscriptionStatus: stripeStatus,
                  syncedBy: staffEmail
                },
                performedBy: staffEmail,
                performedByName: staffEmail
              });
              
              updated.push({
                email: member.email,
                oldStatus: member.membership_status || 'none',
                newStatus: expectedAppStatus
              });
              
              if (!isProduction) {
                logger.info('[DataTools] Updated status: ->', { extra: { memberEmail: member.email, memberMembership_status: member.membership_status, expectedAppStatus } });
              }
            }
          }
        } catch (err: unknown) {
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
          if (!isProduction) {
            logger.error('[DataTools] Error checking subscription for', { extra: { email: member.email, error: getErrorMessage(err) } });
          }
        }
    }
    
    if (!dryRun && updated.length > 0) {
      logFromRequest(req, 'sync_subscription_status', 'users', null, undefined, {
        action: 'bulk_status_sync',
        updatedCount: updated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${mismatches.length} status mismatches out of ${membersWithStripe.rows.length} members`
        : `Updated ${updated.length} member statuses to match Stripe`,
      totalChecked: membersWithStripe.rows.length,
      mismatchCount: mismatches.length,
      updatedCount: updated.length,
      mismatches: mismatches.slice(0, 100),
      updated: updated.slice(0, 50),
      errors: errors.slice(0, 10),
      dryRun
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Sync subscription status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync subscription status', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/clear-orphaned-stripe-ids', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Clearing orphaned Stripe customer IDs (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    const usersWithStripe = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id, role, membership_status
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
       ORDER BY email
       LIMIT 500`);
    
    if (usersWithStripe.rows.length === 0) {
      return res.json({ 
        message: 'No users with Stripe customer IDs found',
        totalChecked: 0,
        orphanedCount: 0,
        cleared: []
      });
    }
    
    const orphaned: Array<{
      email: string;
      name: string;
      stripeCustomerId: string;
      userId: string;
      role: string;
    }> = [];
    
    const cleared: Array<{ email: string; stripeCustomerId: string }> = [];
    const errors: string[] = [];
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 100;
    
    for (let i = 0; i < usersWithStripe.rows.length; i += BATCH_SIZE) {
      const batch = usersWithStripe.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (user) => {
        try {
          const customerId = user.stripe_customer_id;
          if (!customerId) return;
          
          try {
            await stripe.customers.retrieve(customerId);
          } catch (err: unknown) {
            const isNotFound = getErrorCode(err) === 'resource_missing' || 
              getErrorStatusCode(err) === 404 || 
              getErrorMessage(err)?.includes('No such customer');
            
            if (isNotFound) {
              const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
              orphaned.push({
                email: user.email as string,
                name: userName,
                stripeCustomerId: customerId as string,
                userId: user.id as unknown as string,
                role: user.role as string
              });
              
              if (!dryRun) {
                await db.execute(sql`UPDATE users SET stripe_customer_id = NULL, updated_at = NOW() WHERE id = ${user.id}`);
                
                cleared.push({
                  email: user.email,
                  stripeCustomerId: customerId
                });
                
                logger.info('[DataTools] Cleared orphaned Stripe ID for', { extra: { userEmail: user.email, customerId } });
              }
            }
          }
        } catch (err: unknown) {
          errors.push(`${user.email}: ${getErrorMessage(err)}`);
        }
      }));
      
      if (i + BATCH_SIZE < usersWithStripe.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    if (!dryRun && cleared.length > 0) {
      logFromRequest(req, 'clear_orphaned_stripe_ids', 'users', null, undefined, {
        action: 'bulk_clear_orphaned',
        clearedCount: cleared.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${orphaned.length} orphaned Stripe customer IDs out of ${usersWithStripe.rows.length} users`
        : `Cleared ${cleared.length} orphaned Stripe customer IDs`,
      totalChecked: usersWithStripe.rows.length,
      orphanedCount: orphaned.length,
      clearedCount: cleared.length,
      orphaned: orphaned.slice(0, 100),
      cleared: cleared.slice(0, 50),
      errors: errors.slice(0, 10),
      dryRun
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Clear orphaned Stripe IDs error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to clear orphaned Stripe IDs', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/link-stripe-hubspot', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting Stripe-HubSpot link tool (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const { findOrCreateHubSpotContact } = await import('../../core/hubspot/members');
    const { getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
    const _stripe = await getStripeClient();
    
    const stripeOnlyMembers = await db.execute(sql`SELECT id, email, first_name, last_name, tier, stripe_customer_id
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
         AND (hubspot_id IS NULL OR hubspot_id = '')
         AND role = 'member'
       ORDER BY email
       LIMIT 200`);
    
    const hubspotOnlyMembers = await db.execute(sql`SELECT id, email, first_name, last_name, tier, hubspot_id
       FROM users 
       WHERE hubspot_id IS NOT NULL
         AND hubspot_id != ''
         AND (stripe_customer_id IS NULL OR stripe_customer_id = '')
         AND role = 'member'
       ORDER BY email
       LIMIT 200`);
    
    const stripeOnlyList = (stripeOnlyMembers.rows as unknown as DbUserRow[]).map((m) => ({
      id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unknown',
      tier: m.tier,
      stripeCustomerId: m.stripe_customer_id,
      issue: 'has_stripe_no_hubspot'
    }));
    
    const hubspotOnlyList = (hubspotOnlyMembers.rows as unknown as DbUserRow[]).map((m) => ({
      id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unknown',
      tier: m.tier,
      hubspotId: m.hubspot_id,
      issue: 'has_hubspot_no_stripe'
    }));
    
    const hubspotCreated: Array<{ email: string; contactId: string }> = [];
    const stripeCreated: Array<{ email: string; customerId: string }> = [];
    const errors: string[] = [];
    
    if (!dryRun) {
      for (const member of stripeOnlyMembers.rows as unknown as DbUserRow[]) {
        try {
          const result = await findOrCreateHubSpotContact(
            member.email,
            member.first_name || '',
            member.last_name || '',
            undefined,
            member.tier || undefined
          );
          
          await db.execute(sql`UPDATE users SET hubspot_id = ${result.contactId}, updated_at = NOW() WHERE id = ${member.id}`);
          
          hubspotCreated.push({ email: member.email, contactId: result.contactId });
          
          await logBillingAudit({
            memberEmail: member.email,
            actionType: 'hubspot_contact_created_from_stripe',
            actionDetails: {
              source: 'data_tools',
              hubspotContactId: result.contactId,
              stripeCustomerId: member.stripe_customer_id,
              isNew: result.isNew
            },
            performedBy: staffEmail,
            performedByName: staffEmail
          });
          
          if (!isProduction) {
            logger.info('[DataTools] Created HubSpot contact for', { extra: { memberEmail: member.email, resultContactId: result.contactId } });
          }
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: unknown) {
          errors.push(`HubSpot for ${member.email}: ${getErrorMessage(err)}`);
          logger.error('[DataTools] Error creating HubSpot contact for', { extra: { email: member.email, error: getErrorMessage(err) } });
        }
      }
      
      for (const member of hubspotOnlyMembers.rows as unknown as DbUserRow[]) {
        try {
          const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
          const result = await getOrCreateStripeCustomer(
            member.id.toString(),
            member.email,
            memberName,
            member.tier ?? undefined
          );
          
          stripeCreated.push({ email: member.email, customerId: result.customerId });
          
          await logBillingAudit({
            memberEmail: member.email,
            actionType: 'stripe_customer_created_from_hubspot',
            actionDetails: {
              source: 'data_tools',
              stripeCustomerId: result.customerId,
              hubspotContactId: member.hubspot_id,
              isNew: result.isNew
            },
            performedBy: staffEmail,
            performedByName: staffEmail
          });
          
          if (!isProduction) {
            logger.info('[DataTools] Created Stripe customer for', { extra: { memberEmail: member.email, resultCustomerId: result.customerId } });
          }
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err: unknown) {
          errors.push(`Stripe for ${member.email}: ${getErrorMessage(err)}`);
          logger.error('[DataTools] Error creating Stripe customer for', { extra: { email: member.email, error: getErrorMessage(err) } });
        }
      }
      
      logFromRequest(req, 'link_stripe_hubspot', 'users', null, undefined, {
        action: 'bulk_link_stripe_hubspot',
        hubspotCreated: hubspotCreated.length,
        stripeCreated: stripeCreated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${stripeOnlyList.length} Stripe-only and ${hubspotOnlyList.length} HubSpot-only members`
        : `Linked ${hubspotCreated.length + stripeCreated.length} members (${hubspotCreated.length} HubSpot contacts, ${stripeCreated.length} Stripe customers created)`,
      stripeOnlyCount: stripeOnlyList.length,
      hubspotOnlyCount: hubspotOnlyList.length,
      stripeOnlyMembers: stripeOnlyList.slice(0, 50),
      hubspotOnlyMembers: hubspotOnlyList.slice(0, 50),
      hubspotCreated: hubspotCreated.slice(0, 50),
      stripeCreated: stripeCreated.slice(0, 50),
      errors: errors.slice(0, 20),
      dryRun
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Link Stripe-HubSpot error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link Stripe-HubSpot', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/sync-payment-status', isAdmin, async (req: Request, res: Response) => {
  try {
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    const { dryRun = true } = req.body;
    
    logger.info('[DataTools] Starting payment status sync to HubSpot (dryRun: ) by', { extra: { dryRun, staffEmail } });
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const { client: hubspot } = await getHubSpotClientWithFallback();
    const stripe = await getStripeClient();
    
    const membersWithBoth = await db.execute(sql`SELECT id, email, first_name, last_name, tier, stripe_customer_id, hubspot_id
       FROM users 
       WHERE stripe_customer_id IS NOT NULL
         AND stripe_customer_id != ''
         AND hubspot_id IS NOT NULL
         AND hubspot_id != ''
         AND role = 'member'
       ORDER BY email
       LIMIT 500`);
    
    if (membersWithBoth.rows.length === 0) {
      return res.json({ 
        message: 'No members with both Stripe and HubSpot found',
        totalChecked: 0,
        needsUpdate: []
      });
    }
    
    interface PaymentStatusRecord {
      email: string;
      name: string;
      stripeCustomerId: string;
      hubspotId: string;
      stripePaymentStatus: string;
      stripeLastInvoiceDate: string | null;
      stripeLastInvoiceAmount: number | null;
      hubspotPaymentStatus: string | null;
      needsUpdate: boolean;
    }
    
    const needsUpdateList: PaymentStatusRecord[] = [];
    const alreadySynced: PaymentStatusRecord[] = [];
    const updated: Array<{ email: string; oldStatus: string | null; newStatus: string }> = [];
    const errors: string[] = [];
    
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 150;
    
    for (let i = 0; i < membersWithBoth.rows.length; i += BATCH_SIZE) {
      const batch = membersWithBoth.rows.slice(i, i + BATCH_SIZE) as unknown as DbUserRow[];
      
      await Promise.all(batch.map(async (member) => {
        try {
          const invoices = await stripe.invoices.list({
            customer: member.stripe_customer_id!,
            limit: 1,
            status: 'paid'
          });
          
          let stripePaymentStatus = 'no_invoices';
          let lastInvoiceDate: string | null = null;
          let lastInvoiceAmount: number | null = null;
          
          if (invoices.data.length > 0) {
            const latestInvoice = invoices.data[0];
            stripePaymentStatus = latestInvoice.status || 'unknown';
            lastInvoiceDate = latestInvoice.created 
              ? new Date(latestInvoice.created * 1000).toISOString().split('T')[0]
              : null;
            lastInvoiceAmount = latestInvoice.amount_paid || null;
          } else {
            const allInvoices = await stripe.invoices.list({
              customer: member.stripe_customer_id as string,
              limit: 1
            });
            
            if (allInvoices.data.length > 0) {
              const latestInvoice = allInvoices.data[0];
              stripePaymentStatus = latestInvoice.status || 'unknown';
              lastInvoiceDate = latestInvoice.created 
                ? new Date(latestInvoice.created * 1000).toISOString().split('T')[0]
                : null;
              lastInvoiceAmount = latestInvoice.amount_due || null;
            }
          }
          
          let hubspotPaymentStatus: string | null = null;
          try {
            const contact = await retryableHubSpotRequest(() =>
              hubspot.crm.contacts.basicApi.getById(member.hubspot_id!, ['last_payment_status'])
            );
            hubspotPaymentStatus = contact.properties?.last_payment_status || null;
          } catch (hubspotErr: unknown) {
            if (!getErrorMessage(hubspotErr)?.includes('404')) {
              throw hubspotErr;
            }
          }
          
          const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
          const record: PaymentStatusRecord = {
            email: member.email,
            name: memberName,
            stripeCustomerId: member.stripe_customer_id!,
            hubspotId: member.hubspot_id!,
            stripePaymentStatus,
            stripeLastInvoiceDate: lastInvoiceDate,
            stripeLastInvoiceAmount: lastInvoiceAmount,
            hubspotPaymentStatus,
            needsUpdate: hubspotPaymentStatus !== stripePaymentStatus
          };
          
          if (hubspotPaymentStatus !== stripePaymentStatus) {
            needsUpdateList.push(record);
            
            if (!dryRun) {
              try {
                const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('../../core/hubspot/readOnlyGuard');
                if (isHubSpotReadOnly()) {
                  logHubSpotWriteSkipped('maintenance_payment_status_update', member.email);
                } else {
                  await retryableHubSpotRequest(() =>
                    hubspot.crm.contacts.basicApi.update(member.hubspot_id!, {
                      properties: {
                        last_payment_status: stripePaymentStatus,
                        last_payment_date: lastInvoiceDate || '',
                        last_payment_amount: lastInvoiceAmount ? (lastInvoiceAmount / 100).toFixed(2) : ''
                      }
                    })
                  );
                }
                
                updated.push({
                  email: member.email,
                  oldStatus: hubspotPaymentStatus,
                  newStatus: stripePaymentStatus
                });
                
                await logBillingAudit({
                  memberEmail: member.email,
                  actionType: 'payment_status_synced_to_hubspot',
                  previousValue: hubspotPaymentStatus || 'none',
                  newValue: stripePaymentStatus,
                  actionDetails: {
                    source: 'data_tools',
                    stripeCustomerId: member.stripe_customer_id,
                    hubspotContactId: member.hubspot_id,
                    lastInvoiceDate,
                    lastInvoiceAmountCents: lastInvoiceAmount
                  },
                  performedBy: staffEmail,
                  performedByName: staffEmail
                });
                
                if (!isProduction) {
                  logger.info('[DataTools] Updated HubSpot payment status for : ->', { extra: { memberEmail: member.email, hubspotPaymentStatus, stripePaymentStatus } });
                }
              } catch (updateErr: unknown) {
                errors.push(`Update ${member.email}: ${getErrorMessage(updateErr)}`);
              }
            }
          } else {
            alreadySynced.push(record);
          }
        } catch (err: unknown) {
          errors.push(`${member.email}: ${getErrorMessage(err)}`);
          if (!isProduction) {
            logger.error('[DataTools] Error checking payment status for', { extra: { email: member.email, error: getErrorMessage(err) } });
          }
        }
      }));
      
      if (i + BATCH_SIZE < membersWithBoth.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    if (!dryRun && updated.length > 0) {
      logFromRequest(req, 'sync_payment_status', 'users', null, undefined, {
        action: 'bulk_payment_status_sync',
        updatedCount: updated.length,
        staffEmail
      });
    }
    
    res.json({
      message: dryRun 
        ? `Preview: Found ${needsUpdateList.length} members needing payment status update`
        : `Updated ${updated.length} HubSpot contacts with payment status`,
      totalChecked: membersWithBoth.rows.length,
      needsUpdateCount: needsUpdateList.length,
      alreadySyncedCount: alreadySynced.length,
      updatedCount: updated.length,
      needsUpdate: needsUpdateList.slice(0, 100),
      updated: updated.slice(0, 50),
      errors: errors.slice(0, 20),
      dryRun
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Sync payment status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync payment status', details: safeErrorDetail(error) });
  }
});

async function runCleanupInBackground(jobId: string, dryRun: boolean, staffEmail: string, req: Request) {
  const progress: StripeCleanupProgress = {
    phase: 'fetching',
    totalCustomers: 0,
    checked: 0,
    emptyFound: 0,
    skippedActiveCount: 0,
    deleted: 0,
    errors: 0,
  };

  const syncProgress = async () => {
    currentCleanupProgress = { ...progress };
    await updateJobProgress(jobId, progress as unknown as Record<string, unknown>).catch((err: unknown) => {
      logger.warn('[StripeTools] Failed to update job progress', { extra: { jobId, error: String(err) } });
    });
  };

  try {
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    progress.phase = 'fetching';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
    
    const allCustomers: Array<{ id: string; email: string | null; name: string | null; created: number }> = [];
    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const params: Stripe.CustomerListParams = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      const batch = await stripe.customers.list(params);
      
      for (const cust of batch.data) {
        if (!(cust as Stripe.Customer & { deleted?: boolean }).deleted) {
          allCustomers.push({
            id: cust.id,
            email: cust.email ?? null,
            name: cust.name ?? null,
            created: cust.created
          });
        }
      }
      
      hasMore = batch.has_more;
      if (batch.data.length > 0) {
        startingAfter = batch.data[batch.data.length - 1].id;
      }
    }
    
    logger.info('[DataTools] Found total Stripe customers', { extra: { allCustomersLength: allCustomers.length } });
    progress.totalCustomers = allCustomers.length;
    progress.phase = 'checking';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
    await syncProgress();
    
    const activeUsersResult = await db.execute(sql`
      SELECT stripe_customer_id FROM users 
      WHERE stripe_customer_id IS NOT NULL 
        AND membership_status = 'active'
    `);
    const activeStripeIds = new Set(activeUsersResult.rows.map((r) => (r as { stripe_customer_id: string }).stripe_customer_id));
    
    const emptyCustomers: typeof allCustomers = [];
    let skippedActiveCount = 0;
    
    for (const customer of allCustomers) {
      try {
        if (activeStripeIds.has(customer.id)) {
          skippedActiveCount++;
          progress.skippedActiveCount = skippedActiveCount;
          progress.checked++;
          if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
          continue;
        }
        
        const charges = await stripe.charges.list({ customer: customer.id, limit: 1 });
        if (charges.data.length > 0) { progress.checked++; if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress }); continue; }
        
        const subscriptions = await stripe.subscriptions.list({ customer: customer.id, limit: 1, status: 'all' });
        if (subscriptions.data.length > 0) { progress.checked++; if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress }); continue; }
        
        const invoices = await stripe.invoices.list({ customer: customer.id, limit: 1 });
        if (invoices.data.length > 0) { progress.checked++; if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress }); continue; }
        
        const paymentIntents = await stripe.paymentIntents.list({ customer: customer.id, limit: 1 });
        if (paymentIntents.data.length > 0) { progress.checked++; if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress }); continue; }
        
        emptyCustomers.push(customer);
        progress.emptyFound = emptyCustomers.length;
        progress.checked++;
        if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
      } catch (err: unknown) {
        logger.error('[DataTools] Error checking customer', { extra: { id: customer.id, error: getErrorMessage(err) } });
        progress.errors++;
        progress.checked++;
        if (progress.checked % 25 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
      }
      
      if (progress.checked % 25 === 0) {
        await syncProgress();
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
    await syncProgress();
    
    logger.info('[DataTools] Found customers with zero transactions out of total', { extra: { emptyCustomersLength: emptyCustomers.length, allCustomersLength: allCustomers.length } });
    logger.info('[DataTools] Skipping active members with zero transactions (keeping for future charges)', { extra: { skippedActiveCount } });
    
    if (dryRun) {
      logFromRequest(req, 'cleanup_stripe_customers', 'stripe', null, undefined, {
        action: 'preview',
        totalCustomers: allCustomers.length,
        emptyFound: emptyCustomers.length,
        skippedActiveCount,
        staffEmail
      });
      
      const jobResult = {
        success: true,
        dryRun: true,
        message: `Found ${emptyCustomers.length} Stripe customers with zero transactions (out of ${allCustomers.length} total). Skipped ${skippedActiveCount} active members.`,
        totalCustomers: allCustomers.length,
        emptyCount: emptyCustomers.length,
        skippedActiveCount,
        customers: emptyCustomers.map(c => ({
          id: c.id,
          email: c.email,
          name: c.name,
          created: new Date(c.created * 1000).toISOString()
        }))
      };
      
      progress.phase = 'done';
      await completeJob(jobId, jobResult as unknown as Record<string, unknown>, progress as unknown as Record<string, unknown>);
      currentCleanupProgress = { ...progress };
      broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress, result: jobResult });
      return;
    }
    
    progress.phase = 'deleting';
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
    await syncProgress();
    
    let deleted = 0;
    const errors: string[] = [];
    const deletedList: Array<{ id: string; email: string | null }> = [];
    
    for (const customer of emptyCustomers) {
      try {
        await stripe.customers.del(customer.id);
        
        await db.execute(sql`
          UPDATE users SET stripe_customer_id = NULL, updated_at = NOW()
          WHERE stripe_customer_id = ${customer.id}
        `);
        
        deletedList.push({ id: customer.id, email: customer.email });
        deleted++;
        progress.deleted = deleted;
        if (deleted % 10 === 0) broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress });
      } catch (err: unknown) {
        errors.push(`${customer.id} (${customer.email}): ${getErrorMessage(err)}`);
        progress.errors++;
        logger.error('[DataTools] Failed to delete customer', { extra: { id: customer.id, error: getErrorMessage(err) } });
      }
    }
    
    logFromRequest(req, 'cleanup_stripe_customers', 'stripe', null, undefined, {
      action: 'execute',
      totalCustomers: allCustomers.length,
      emptyFound: emptyCustomers.length,
      skippedActiveCount,
      deleted,
      errorCount: errors.length,
      staffEmail
    });
    
    logger.info('[DataTools] Stripe customer cleanup complete: deleted, errors', { extra: { deleted, errorsLength: errors.length } });
    
    const jobResult = {
      success: true,
      dryRun: false,
      message: `Deleted ${deleted} of ${emptyCustomers.length} empty Stripe customers. Skipped ${skippedActiveCount} active members.`,
      totalCustomers: allCustomers.length,
      emptyCount: emptyCustomers.length,
      skippedActiveCount,
      deleted: deletedList,
      deletedCount: deleted,
      errors: errors.slice(0, 20)
    };
    
    progress.phase = 'done';
    await completeJob(jobId, jobResult as unknown as Record<string, unknown>, progress as unknown as Record<string, unknown>);
    currentCleanupProgress = { ...progress };
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress, result: jobResult });
  } catch (error: unknown) {
    logger.error('[DataTools] Stripe customer cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    progress.phase = 'done';
    await failJob(jobId, getErrorMessage(error), progress as unknown as Record<string, unknown>);
    currentCleanupProgress = { ...progress };
    broadcastToStaff({ type: 'stripe_cleanup_progress', data: progress, error: getErrorMessage(error) });
  }
}

router.post('/api/data-tools/cleanup-stripe-customers', isAdmin, async (req: Request, res: Response) => {
  try {
    const existingJob = await getActiveJob(STRIPE_CLEANUP_JOB_TYPE);
    if (existingJob) {
      return res.status(409).json({ error: 'A cleanup job is already running', jobId: existingJob.id });
    }
    
    const dryRun = req.body.dryRun !== false;
    const staffEmail = getSessionUser(req)?.email || 'admin';
    
    logger.info('[DataTools] Stripe customer cleanup initiated by (dryRun: )', { extra: { staffEmail, dryRun } });
    
    const jobId = `sc_${Date.now().toString(36)}`;
    const initialProgress: StripeCleanupProgress = {
      phase: 'fetching',
      totalCustomers: 0,
      checked: 0,
      emptyFound: 0,
      skippedActiveCount: 0,
      deleted: 0,
      errors: 0,
    };

    await createBackgroundJob({
      id: jobId,
      jobType: STRIPE_CLEANUP_JOB_TYPE,
      dryRun,
      progress: initialProgress as unknown as Record<string, unknown>,
      startedBy: staffEmail,
    });

    currentCleanupJobId = jobId;
    currentCleanupProgress = { ...initialProgress };
    
    runCleanupInBackground(jobId, dryRun, staffEmail, req);
    
    res.json({ success: true, jobId, message: 'Cleanup job started' });
  } catch (error: unknown) {
    logger.error('[DataTools] Stripe customer cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to start cleanup job', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/cleanup-stripe-customers/status', isAdmin, async (req: Request, res: Response) => {
  try {
    const job = await getLatestJob(STRIPE_CLEANUP_JOB_TYPE);
    if (!job) {
      return res.json({ hasJob: false });
    }
    const jobProgress = currentCleanupJobId === job.id && currentCleanupProgress
      ? currentCleanupProgress
      : job.progress;
    res.json({
      hasJob: true,
      job: {
        id: job.id,
        status: job.status,
        dryRun: job.dryRun,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        progress: jobProgress,
        result: job.result,
        error: job.error,
      },
    });
  } catch {
    res.json({ hasJob: false });
  }
});

export default router;

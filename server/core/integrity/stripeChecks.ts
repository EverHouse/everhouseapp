import { db } from '../../db';
import { sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { getErrorMessage, getErrorCode, isStripeError } from '../../utils/errorUtils';
import { logger } from '../logger';
import { isProduction } from '../db';
import { getStripeClient } from '../stripe/client';
import type {
  IntegrityCheckResult,
  IntegrityIssue,
  SyncComparisonData,
  MemberRow,
  DuplicateStripeRow,
  SharedCustomerRow,
  OrphanPaymentIntentRow,
  HybridBillingRow,
  DuplicateInvoiceRow,
  MissingInvoiceRow,
} from './core';

export async function checkStripeSubscriptionSync(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  let stripe: Stripe;
  try {
    stripe = await getStripeClient();
  } catch (err: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Stripe API error:', { error: err });
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'stripe_sync',
      recordId: 'stripe_api',
      description: 'Unable to connect to Stripe - API may be unavailable',
      suggestion: 'Check Stripe integration connection'
    });

    return {
      checkName: 'Stripe Subscription Sync',
      status: 'warning',
      issueCount: issues.length,
      issues,
      lastRun: new Date()
    };
  }

  const appMembersResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, stripe_customer_id, billing_provider
    FROM users 
    WHERE stripe_customer_id IS NOT NULL
      AND membership_status IS NOT NULL
      AND role = 'member'
      AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    ORDER BY id
  `);
  const appMembers = appMembersResult.rows as unknown as MemberRow[];

  if (appMembers.length === 0) {
    return {
      checkName: 'Stripe Subscription Sync',
      status: 'pass',
      issueCount: 0,
      issues: [],
      lastRun: new Date()
    };
  }

  const STRIPE_STATUS_TO_EXPECTED_DB: Record<string, string[]> = {
    'active': ['active'],
    'trialing': ['active', 'pending'],
    'past_due': ['active', 'past_due', 'pending', 'suspended', 'frozen'],
    'canceled': ['cancelled', 'terminated', 'inactive', 'non-member'],
    'unpaid': ['suspended', 'frozen', 'inactive'],
    'incomplete': ['pending'],
    'incomplete_expired': ['pending', 'inactive']
  };

  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 100;

  const processMember = async (member: MemberRow): Promise<void> => {
    const customerId = member.stripe_customer_id;
    if (!customerId) return;

    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
    const dbStatus = (member.membership_status || '').toLowerCase();
    const dbTier = (member.tier || '').toLowerCase();

    try {
      const customerSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10,
        expand: ['data.items.data.price']
      });

      if (!customerSubs.data || customerSubs.data.length === 0) {
        if (dbStatus === 'active') {
          issues.push({
            category: 'sync_mismatch',
            severity: 'error',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" shows as active in database but has no Stripe subscription (billing via Stripe)`,
            suggestion: 'Verify member payment status or update membership status. Note: MindBody-billed members are excluded from this check.',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: Number(member.id),
              syncComparison: [
                { field: 'Subscription', appValue: dbStatus, externalValue: 'no subscription' }
              ]
            }
          });
        }
        return;
      }

      const activeSub = customerSubs.data.find(s =>
        ['active', 'trialing', 'past_due'].includes(s.status)
      ) || customerSubs.data[0];

      const stripeStatus = activeSub.status;
      const comparisons: SyncComparisonData[] = [];

      const expectedDbStatuses = STRIPE_STATUS_TO_EXPECTED_DB[stripeStatus] || [];
      const statusMatches = expectedDbStatuses.includes(dbStatus);

      if (!statusMatches) {
        const isStatusMismatch =
          (dbStatus === 'active' && ['canceled', 'unpaid', 'incomplete_expired'].includes(stripeStatus)) ||
          (['cancelled', 'terminated', 'inactive'].includes(dbStatus) && ['active', 'trialing'].includes(stripeStatus));

        comparisons.push({
          field: 'Membership Status',
          appValue: member.membership_status || null,
          externalValue: stripeStatus
        });

        if (isStatusMismatch) {
          issues.push({
            category: 'sync_mismatch',
            severity: 'error',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" has status mismatch: DB shows "${member.membership_status}" but Stripe subscription is "${stripeStatus}"`,
            suggestion: 'Sync membership status with Stripe subscription state',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: Number(member.id),
              syncComparison: comparisons
            }
          });
          return;
        }
      }

      const item = activeSub.items?.data?.[0];
      const price = item?.price;
      const product = typeof price?.product === 'object' ? price.product : null;

      const activeProduct = product && !('deleted' in product && product.deleted) ? product as Stripe.Product : null;
      if (activeProduct && dbTier) {
        const productTier = (activeProduct.metadata?.tier || activeProduct.name || '').toLowerCase();
        const productName = (activeProduct.name || '').toLowerCase();

        const tierMatches =
          productTier.includes(dbTier) ||
          dbTier.includes(productTier) ||
          productName.includes(dbTier) ||
          dbTier.includes(productName);

        if (!tierMatches && productTier) {
          comparisons.push({
            field: 'Membership Tier',
            appValue: member.tier || null,
            externalValue: activeProduct.metadata?.tier || activeProduct.name || null
          });

          issues.push({
            category: 'sync_mismatch',
            severity: 'warning',
            table: 'users',
            recordId: member.id,
            description: `Member "${memberName}" has tier mismatch: DB tier is "${member.tier}" but Stripe product is "${activeProduct.name}"`,
            suggestion: 'Update database tier to match Stripe subscription product',
            context: {
              memberName,
              memberEmail: member.email || undefined,
              memberTier: member.tier || undefined,
              syncType: 'stripe',
              stripeCustomerId: customerId,
              userId: Number(member.id),
              syncComparison: comparisons
            }
          });
        }
      }
    } catch (err: unknown) {
      const isCustomerNotFound = isStripeError(err) &&
        (getErrorCode(err) === 'resource_missing' || getErrorMessage(err)?.includes('No such customer'));

      if (isCustomerNotFound) {
        issues.push({
          category: 'data_quality',
          severity: 'error',
          table: 'users',
          recordId: member.id,
          description: `Member "${memberName}" has orphaned Stripe customer ID (${customerId}) - customer no longer exists in Stripe`,
          suggestion: 'Clear the stripe_customer_id field or run Stripe cleanup to remove orphaned references',
          context: {
            memberName,
            memberEmail: member.email || undefined,
            stripeCustomerId: customerId,
            userId: Number(member.id),
            errorType: 'orphaned_stripe_customer'
          }
        });
      } else {
        if (!isProduction) logger.warn(`[DataIntegrity] Stripe API error for ${customerId}:`, { extra: { detail: getErrorMessage(err) } });
        issues.push({
          category: 'sync_mismatch',
          severity: 'warning',
          table: 'users',
          recordId: member.id,
          description: `Error fetching Stripe subscriptions for "${memberName}": ${getErrorMessage(err)}`,
          suggestion: 'Check Stripe customer ID validity'
        });
      }
    }
  };

  for (let i = 0; i < appMembers.length; i += BATCH_SIZE) {
    const batch = appMembers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processMember));

    if (i + BATCH_SIZE < appMembers.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return {
    checkName: 'Stripe Subscription Sync',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkDuplicateStripeCustomers(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const duplicatesResult = await db.execute(sql`
    WITH users_with_stripe AS (
      SELECT id, email, stripe_customer_id, LOWER(email) as normalized_email
      FROM users
      WHERE stripe_customer_id IS NOT NULL
    ),
    linked_with_stripe AS (
      SELECT u.id as user_id, u.email as primary_email, u.stripe_customer_id, 
             LOWER(ule.linked_email) as normalized_email
      FROM users u
      JOIN user_linked_emails ule ON LOWER(ule.primary_email) = LOWER(u.email)
      WHERE u.stripe_customer_id IS NOT NULL
    ),
    all_email_mappings AS (
      SELECT id as user_id, email as primary_email, stripe_customer_id, normalized_email
      FROM users_with_stripe
      UNION ALL
      SELECT user_id, primary_email, stripe_customer_id, normalized_email
      FROM linked_with_stripe
    ),
    email_customer_counts AS (
      SELECT 
        normalized_email,
        COUNT(DISTINCT stripe_customer_id) as customer_count,
        ARRAY_AGG(DISTINCT stripe_customer_id) as customer_ids,
        ARRAY_AGG(DISTINCT primary_email) as member_emails
      FROM all_email_mappings
      GROUP BY normalized_email
      HAVING COUNT(DISTINCT stripe_customer_id) > 1
    )
    SELECT * FROM email_customer_counts
    ORDER BY customer_count DESC
    LIMIT 25
  `);

  const duplicates = duplicatesResult.rows as unknown as DuplicateStripeRow[];

  for (const dup of duplicates) {
    issues.push({
      category: 'data_quality',
      severity: 'warning',
      table: 'users',
      recordId: dup.normalized_email,
      description: `Email "${dup.normalized_email}" has ${dup.customer_count} different Stripe customers: ${dup.customer_ids.join(', ')}`,
      suggestion: 'Consolidate to a single Stripe customer to prevent billing issues and duplicate charges.',
      context: {
        email: dup.normalized_email,
        stripeCustomerIds: dup.customer_ids,
        memberEmails: dup.member_emails
      }
    });
  }

  const sharedCustomersResult = await db.execute(sql`
    SELECT 
      stripe_customer_id,
      COUNT(*) as user_count,
      ARRAY_AGG(email ORDER BY created_at DESC) as emails
    FROM users
    WHERE stripe_customer_id IS NOT NULL
    GROUP BY stripe_customer_id
    HAVING COUNT(*) > 1
    LIMIT 25
  `);

  const sharedCustomers = sharedCustomersResult.rows as unknown as SharedCustomerRow[];

  for (const shared of sharedCustomers) {
    const emails = shared.emails;
    if (emails.length <= 2) {
      continue;
    }

    issues.push({
      category: 'data_quality',
      severity: 'info',
      table: 'users',
      recordId: shared.stripe_customer_id,
      description: `Stripe customer ${shared.stripe_customer_id} is shared by ${shared.user_count} members: ${emails.slice(0, 5).join(', ')}${emails.length > 5 ? '...' : ''}`,
      suggestion: 'This may be intentional for billing groups. Review if these should be separate customers.',
      context: {
        stripeCustomerId: shared.stripe_customer_id,
        memberEmails: emails
      }
    });
  }

  return {
    checkName: 'Duplicate Stripe Customers',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'warning') ? 'warning' : 'info',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkOrphanedPaymentIntents(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  const orphans = await db.execute(sql`
    SELECT bfs.id, bfs.booking_id, bfs.stripe_payment_intent_id, bfs.total_cents, bfs.status, bfs.created_at
    FROM booking_fee_snapshots bfs
    INNER JOIN booking_requests br ON bfs.booking_id = br.id
    WHERE bfs.stripe_payment_intent_id IS NOT NULL
      AND bfs.status IN ('pending', 'requires_action')
      AND br.status IN ('cancelled', 'declined', 'denied', 'expired')
    LIMIT 100
  `);

  for (const row of orphans.rows as unknown as OrphanPaymentIntentRow[]) {
    issues.push({
      category: 'data_quality',
      severity: 'error',
      table: 'booking_fee_snapshots',
      recordId: row.id,
      description: `Payment intent ${row.stripe_payment_intent_id} (${row.total_cents} cents, status: ${row.status}) references a cancelled/denied/expired booking (booking_id: ${row.booking_id})`,
      suggestion: 'Cancel the Stripe payment intent and clean up the fee snapshot',
      context: {
        stripePaymentIntentId: row.stripe_payment_intent_id || undefined,
        status: row.status || undefined
      }
    });
  }

  return {
    checkName: 'Orphaned Payment Intents',
    status: issues.length === 0 ? 'pass' : 'fail',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkBillingProviderHybridState(): Promise<IntegrityCheckResult> {
  // NOTE: As of migration 0047, a CHECK constraint (users_billing_provider_no_hybrid)
  // prevents the critical case of billing_provider='mindbody' with a stripe_subscription_id.
  // This check still catches softer issues: NULL billing_provider on active members,
  // and stripe provider without a subscription ID (prod only).
  const issues: IntegrityIssue[] = [];

  const hybridResult = await db.execute(sql`
    SELECT id, email, first_name, last_name, tier, membership_status, 
           billing_provider, stripe_subscription_id, stripe_customer_id, mindbody_client_id
    FROM users 
    WHERE role = 'member'
      AND archived_at IS NULL
      AND (
        (billing_provider = 'mindbody' AND stripe_subscription_id IS NOT NULL AND stripe_subscription_id != '')
        OR
        (billing_provider IS NULL AND membership_status = 'active')
        ${isProduction ? sql`OR (billing_provider = 'stripe' AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '') AND membership_status = 'active')` : sql``}
      )
    ORDER BY membership_status, email
    LIMIT 50
  `);
  const hybrids = hybridResult.rows as unknown as HybridBillingRow[];

  for (const member of hybrids) {
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';

    let description: string;
    let suggestion: string;
    let severity: 'error' | 'warning' = 'warning';

    if (member.billing_provider === 'mindbody' && member.stripe_subscription_id) {
      description = `Member "${memberName}" has billing_provider='mindbody' but has Stripe subscription ${member.stripe_subscription_id} — billing provider should be 'stripe'`;
      suggestion = 'Update billing_provider to stripe — this member has migrated from Mindbody';
      severity = 'error';
    } else if (!member.billing_provider && member.membership_status === 'active') {
      description = `Active member "${memberName}" has no billing provider set — unable to determine billing source`;
      suggestion = 'Classify billing provider as stripe, mindbody, manual, or comped';
    } else {
      description = `Member "${memberName}" has billing_provider='stripe' but no Stripe subscription ID`;
      suggestion = 'Verify Stripe subscription exists or update billing provider';
    }

    issues.push({
      category: 'sync_mismatch',
      severity,
      table: 'users',
      recordId: member.id,
      description,
      suggestion,
      context: {
        memberName,
        memberEmail: member.email,
        memberTier: member.tier || 'none',
        memberStatus: member.membership_status,
        billingProvider: member.billing_provider || 'none',
        stripeSubscriptionId: member.stripe_subscription_id || 'none',
        stripeCustomerId: member.stripe_customer_id || 'none',
        mindbodyClientId: member.mindbody_client_id || 'none',
        userId: Number(member.id)
      }
    });
  }

  return {
    checkName: 'Billing Provider Hybrid State',
    status: issues.length > 0 ? (issues.some(i => i.severity === 'error') ? 'fail' : 'warning') : 'pass',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

export async function checkInvoiceBookingReconciliation(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  try {
    const duplicateInvoicesResult = await db.execute(sql`
      SELECT stripe_invoice_id, COUNT(*) as booking_count, array_agg(id) as booking_ids, array_remove(array_agg(DISTINCT user_email), NULL) as user_emails
      FROM booking_requests
      WHERE stripe_invoice_id IS NOT NULL
        AND status NOT IN ('cancelled', 'declined', 'deleted')
      GROUP BY stripe_invoice_id
      HAVING COUNT(*) > 1
    `);

    for (const row of duplicateInvoicesResult.rows as unknown as DuplicateInvoiceRow[]) {
      const userEmails = (row as unknown as { user_emails: string[] }).user_emails || [];
      issues.push({
        category: 'billing_issue',
        severity: 'error',
        table: 'booking_requests',
        recordId: row.stripe_invoice_id,
        description: `Stripe invoice ${row.stripe_invoice_id} is shared by ${row.booking_count} bookings (IDs: ${row.booking_ids.join(', ')}). Potential double-billing.`,
        suggestion: 'Multiple bookings share the same Stripe invoice. Review for double-billing risk.',
        context: {
          stripeCustomerId: row.stripe_invoice_id,
          memberEmail: userEmails[0] || undefined,
          bookingIds: row.booking_ids
        }
      });
    }

    const missingInvoicesResult = await db.execute(sql`
      SELECT br.id, br.user_email, br.request_date, br.status,
             SUM(COALESCE(bp.cached_fee_cents, 0)) as total_unpaid_cents
      FROM booking_requests br
      JOIN booking_sessions bs ON bs.id = br.session_id
      JOIN booking_participants bp ON bp.session_id = bs.id
      WHERE br.status = 'attended'
        AND br.stripe_invoice_id IS NULL
        AND br.request_date > CURRENT_DATE - INTERVAL '30 days'
        AND br.user_email NOT LIKE '%@trackman.local'
        AND br.user_email NOT LIKE 'private-event@%'
        AND br.is_event IS NOT TRUE
        AND bp.payment_status = 'pending'
        AND COALESCE(bp.cached_fee_cents, 0) > 0
      GROUP BY br.id, br.user_email, br.request_date, br.status
      HAVING SUM(COALESCE(bp.cached_fee_cents, 0)) > 0
    `);

    for (const row of missingInvoicesResult.rows as unknown as MissingInvoiceRow[]) {
      const totalUnpaid = Number(row.total_unpaid_cents) / 100;
      issues.push({
        category: 'billing_issue',
        severity: 'warning',
        table: 'booking_requests',
        recordId: row.id,
        description: `Attended booking #${row.id} for ${row.user_email} on ${row.request_date} has $${totalUnpaid.toFixed(2)} in unpaid fees but no Stripe invoice.`,
        suggestion: 'Participants owe fees but no invoice was created. Create an invoice or review billing.',
        context: {
          memberEmail: row.user_email || undefined,
          bookingDate: row.request_date || undefined,
          status: row.status || undefined
        }
      });
    }
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Error checking invoice-booking reconciliation:', { extra: { detail: getErrorMessage(error) } });
    return {
      checkName: 'Invoice-Booking Reconciliation',
      status: 'warning',
      issueCount: 1,
      issues: [{
        category: 'system_error',
        severity: 'error',
        table: 'booking_requests',
        recordId: 'check_error',
        description: `Failed to check invoice-booking reconciliation: ${getErrorMessage(error)}`,
        suggestion: 'Review server logs for details and retry'
      }],
      lastRun: new Date()
    };
  }

  return {
    checkName: 'Invoice-Booking Reconciliation',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date()
  };
}

import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../logger';
import { isProduction } from '../db';
import { getErrorMessage } from '../../utils/errorUtils';
import type { IntegrityCheckResult, IntegrityIssue } from './core';

export async function checkCrossSystemDrift(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  interface DriftRow {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    tier: string | null;
    membership_status: string | null;
    stripe_customer_id: string | null;
    hubspot_id: string | null;
    billing_provider: string | null;
  }

  try {
    const activeNoStripeResult = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.tier, u.membership_status,
             u.stripe_customer_id, u.hubspot_id, u.billing_provider
      FROM users u
      WHERE u.membership_status = 'active'
        AND u.stripe_customer_id IS NULL
        AND u.hubspot_id IS NOT NULL
        AND u.archived_at IS NULL
        AND u.role = 'member'
        AND (u.billing_provider IS NULL OR u.billing_provider = 'stripe')
      ORDER BY RANDOM()
      LIMIT 25
    `);

    for (const member of activeNoStripeResult.rows as unknown as DriftRow[]) {
      const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'users',
        recordId: member.id,
        description: `Member "${memberName}" (${member.email}) is active with HubSpot contact but missing Stripe customer ID — billing may not be configured`,
        suggestion: 'Verify billing status and ensure Stripe customer exists',
        context: {
          memberName,
          memberEmail: member.email,
          syncType: 'cross_system',
          userId: member.id,
        }
      });
    }

    const activeNoHubSpotResult = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.tier, u.membership_status,
             u.stripe_customer_id, u.hubspot_id, u.billing_provider
      FROM users u
      WHERE u.membership_status = 'active'
        AND u.hubspot_id IS NULL
        AND u.stripe_customer_id IS NOT NULL
        AND u.archived_at IS NULL
        AND u.role = 'member'
        AND (u.billing_provider IS NULL OR u.billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
      ORDER BY RANDOM()
      LIMIT 25
    `);

    for (const member of activeNoHubSpotResult.rows as unknown as DriftRow[]) {
      const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'users',
        recordId: member.id,
        description: `Member "${memberName}" (${member.email}) is active with Stripe customer but missing HubSpot contact ID — CRM sync may be drifting`,
        suggestion: 'Run HubSpot contact sync to associate this member',
        context: {
          memberName,
          memberEmail: member.email,
          syncType: 'cross_system',
          userId: member.id,
        }
      });
    }

    const orphanedStripeResult = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM users
      WHERE stripe_customer_id IS NOT NULL
        AND hubspot_id IS NULL
        AND membership_status = 'active'
        AND archived_at IS NULL
        AND role = 'member'
        AND (billing_provider IS NULL OR billing_provider NOT IN ('mindbody', 'family_addon', 'comped'))
    `);
    const orphanedStripeCount = Number((orphanedStripeResult.rows[0] as Record<string, string>)?.cnt) || 0;

    if (orphanedStripeCount > 5) {
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'users',
        recordId: 'cross_system_stripe_hubspot',
        description: `${orphanedStripeCount} active Stripe-billed members have no HubSpot contact ID — CRM sync may be drifting`,
        suggestion: 'Run HubSpot contact sync to associate missing contacts',
      });
    }

    const orphanedHubSpotResult = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM users
      WHERE hubspot_id IS NOT NULL
        AND stripe_customer_id IS NULL
        AND membership_status = 'active'
        AND archived_at IS NULL
        AND role = 'member'
        AND (billing_provider IS NULL OR billing_provider = 'stripe')
    `);
    const orphanedHubSpotCount = Number((orphanedHubSpotResult.rows[0] as Record<string, string>)?.cnt) || 0;

    if (orphanedHubSpotCount > 5) {
      issues.push({
        category: 'sync_mismatch',
        severity: 'warning',
        table: 'users',
        recordId: 'cross_system_hubspot_stripe',
        description: `${orphanedHubSpotCount} active members with HubSpot contact but no Stripe customer — billing may not be configured`,
        suggestion: 'Review these members to ensure billing is set up correctly',
      });
    }
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Cross-system drift check error:', { error: error as Error });
    issues.push({
      category: 'sync_mismatch',
      severity: 'info',
      table: 'cross_system',
      recordId: 'drift_check_error',
      description: `Cross-system drift check failed: ${getErrorMessage(error)}`,
      suggestion: 'Retry the integrity check',
    });
  }

  return {
    checkName: 'Cross-System Drift Detection',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date(),
  };
}

export async function checkEmailDeliveryHealth(): Promise<IntegrityCheckResult> {
  const issues: IntegrityIssue[] = [];

  try {
    const statsResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND event_id LIKE 'local-%' AND created_at >= NOW() - INTERVAL '7 days') AS sent_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '7 days') AS bounced_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '7 days') AS complained_7d
      FROM email_events
    `);

    const raw = statsResult.rows[0] as Record<string, string> | undefined;
    const sent7d = Number(raw?.sent_7d) || 0;
    const bounced7d = Number(raw?.bounced_7d) || 0;
    const complained7d = Number(raw?.complained_7d) || 0;

    if (sent7d > 0) {
      const bounceRate = (bounced7d / sent7d) * 100;
      if (bounceRate > 5) {
        issues.push({
          category: 'data_quality',
          severity: 'error',
          table: 'email_events',
          recordId: 'bounce_rate_7d',
          description: `Email bounce rate is ${bounceRate.toFixed(1)}% over last 7 days (${bounced7d} bounces / ${sent7d} sent) — exceeds 5% threshold`,
          suggestion: 'Review bounced email addresses and clean up contact list. High bounce rates can damage sender reputation.',
        });
      } else if (bounceRate > 2) {
        issues.push({
          category: 'data_quality',
          severity: 'warning',
          table: 'email_events',
          recordId: 'bounce_rate_7d',
          description: `Email bounce rate is ${bounceRate.toFixed(1)}% over last 7 days (${bounced7d} bounces / ${sent7d} sent) — approaching threshold`,
          suggestion: 'Monitor bounce rate and review bounced addresses proactively.',
        });
      }

      const complaintRate = (complained7d / sent7d) * 100;
      if (complaintRate > 0.1) {
        issues.push({
          category: 'data_quality',
          severity: 'error',
          table: 'email_events',
          recordId: 'complaint_rate_7d',
          description: `Email complaint rate is ${complaintRate.toFixed(2)}% over last 7 days (${complained7d} complaints / ${sent7d} sent) — exceeds 0.1% threshold`,
          suggestion: 'Review email content and frequency. High complaint rates can lead to email service suspension.',
        });
      }
    }

    const suppressedResult = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM users
      WHERE email_delivery_status IN ('bounced', 'complained')
        AND archived_at IS NULL
        AND membership_status = 'active'
    `);
    const activesSuppressed = Number((suppressedResult.rows[0] as Record<string, string>)?.cnt) || 0;

    if (activesSuppressed > 0) {
      issues.push({
        category: 'data_quality',
        severity: 'warning',
        table: 'users',
        recordId: 'active_members_suppressed',
        description: `${activesSuppressed} active member(s) have suppressed email delivery (bounced/complained) — they will not receive transactional emails`,
        suggestion: 'Contact these members to verify their email addresses.',
      });
    }
  } catch (error: unknown) {
    if (!isProduction) logger.error('[DataIntegrity] Email delivery health check error:', { error: error as Error });
  }

  return {
    checkName: 'Email Delivery Health',
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'error') ? 'fail' : 'warning',
    issueCount: issues.length,
    issues,
    lastRun: new Date(),
  };
}

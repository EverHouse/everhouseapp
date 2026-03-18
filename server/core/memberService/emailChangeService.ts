import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { logBillingAudit } from '../auditLog';

import { logger } from '../logger';

interface CountRow {
  count: string;
}

interface UserSyncRow {
  stripe_customer_id: string | null;
  hubspot_id: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  tier: string | null;
  id: string;
}

export interface EmailChangeResult {
  success: boolean;
  oldEmail: string;
  newEmail: string;
  tablesUpdated: {
    tableName: string;
    rowsAffected: number;
  }[];
  warnings?: string[];
  error?: string;
}

const ALLOWED_EMAIL_CHANGE_TABLES = new Set([
  'users', 'hubspot_deals', 'guest_passes', 'member_notes',
  'communication_logs', 'guest_check_ins', 'billing_groups',
  'group_members', 'booking_requests', 'admin_audit_log',
  'hubspot_line_items', 'legacy_purchases', 'notifications',
  'push_subscriptions', 'event_rsvps', 'wellness_enrollments',
  'user_linked_emails', 'user_dismissed_notices',
]);

const ALLOWED_EMAIL_CHANGE_COLUMNS = new Set([
  'email', 'member_email', 'primary_email', 'user_email',
  'resource_id', 'created_by',
]);

export async function cascadeEmailChange(
  oldEmail: string,
  newEmail: string,
  performedBy: string,
  performedByName?: string
): Promise<EmailChangeResult> {
  const tablesUpdated: EmailChangeResult['tablesUpdated'] = [];

  try {
    const normalizedOldEmail = oldEmail.toLowerCase().trim();
    const normalizedNewEmail = newEmail.toLowerCase().trim();

    if (!normalizedOldEmail || !normalizedNewEmail) {
      throw new Error('Both old and new email addresses are required');
    }

    if (normalizedOldEmail === normalizedNewEmail) {
      throw new Error('Old and new email addresses are the same');
    }

    await db.transaction(async (tx) => {
      const existingCheck = await tx.execute(
        sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${normalizedNewEmail}) LIMIT 1`
      );
      if (existingCheck.rows.length > 0) {
        throw new Error(`A user with email ${newEmail} already exists`);
      }

      const updateTable = async (
        tableName: string,
        emailColumn: string,
        additionalCondition?: string
      ): Promise<number> => {
        if (!ALLOWED_EMAIL_CHANGE_TABLES.has(tableName)) {
          throw new Error(`Invalid table for email change: ${tableName}`);
        }
        if (!ALLOWED_EMAIL_CHANGE_COLUMNS.has(emailColumn)) {
          throw new Error(`Invalid column for email change: ${emailColumn}`);
        }
        const result = await tx.execute(
          sql`UPDATE ${sql.raw(tableName)} SET ${sql.raw(emailColumn)} = ${normalizedNewEmail} WHERE LOWER(${sql.raw(emailColumn)}) = LOWER(${normalizedOldEmail}) ${additionalCondition ? sql.raw(additionalCondition) : sql``}`
        );
        return result.rowCount || 0;
      };

      let rowCount: number;

      rowCount = await updateTable('users', 'email');
      if (rowCount === 0) {
        throw new Error(`No user found with email ${oldEmail}. Email change aborted.`);
      }
      tablesUpdated.push({ tableName: 'users', rowsAffected: rowCount });

      rowCount = await updateTable('hubspot_deals', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'hubspot_deals', rowsAffected: rowCount });

      rowCount = await updateTable('guest_passes', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'guest_passes', rowsAffected: rowCount });

      rowCount = await updateTable('member_notes', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'member_notes', rowsAffected: rowCount });

      rowCount = await updateTable('communication_logs', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'communication_logs', rowsAffected: rowCount });

      rowCount = await updateTable('guest_check_ins', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'guest_check_ins', rowsAffected: rowCount });

      rowCount = await updateTable('billing_groups', 'primary_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'billing_groups', rowsAffected: rowCount });

      rowCount = await updateTable('group_members', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'group_members', rowsAffected: rowCount });

      rowCount = await updateTable('booking_requests', 'user_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'booking_requests', rowsAffected: rowCount });

      rowCount = await updateTable('admin_audit_log', 'resource_id');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'admin_audit_log', rowsAffected: rowCount });

      rowCount = await updateTable('hubspot_line_items', 'created_by');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'hubspot_line_items (created_by)', rowsAffected: rowCount });

      rowCount = await updateTable('legacy_purchases', 'member_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'legacy_purchases', rowsAffected: rowCount });

      rowCount = await updateTable('notifications', 'user_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'notifications', rowsAffected: rowCount });

      rowCount = await updateTable('push_subscriptions', 'user_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'push_subscriptions', rowsAffected: rowCount });

      rowCount = await updateTable('event_rsvps', 'user_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'event_rsvps', rowsAffected: rowCount });

      rowCount = await updateTable('wellness_enrollments', 'user_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'wellness_enrollments', rowsAffected: rowCount });

      rowCount = await updateTable('user_linked_emails', 'primary_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'user_linked_emails', rowsAffected: rowCount });

      rowCount = await updateTable('user_dismissed_notices', 'user_email');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'user_dismissed_notices', rowsAffected: rowCount });

      await logBillingAudit({
        memberEmail: normalizedNewEmail,
        actionType: 'email_changed',
        actionDetails: {
          tables_updated: tablesUpdated,
          timestamp: new Date().toISOString(),
        },
        previousValue: normalizedOldEmail,
        newValue: normalizedNewEmail,
        performedBy,
        performedByName: performedByName || null,
      });
    });

    logger.info(`[EmailChangeService] Successfully cascaded email change from ${oldEmail} to ${newEmail}. Tables updated:`, { extra: { detail: tablesUpdated } });

    const warnings: string[] = [];
    const normalizedOldEmailForSync = oldEmail.toLowerCase().trim();
    const normalizedNewEmailForSync = newEmail.toLowerCase().trim();

    try {
      const userRow = await db.execute(
        sql`SELECT stripe_customer_id, hubspot_id, first_name, last_name, phone, tier, id FROM users WHERE LOWER(email) = ${normalizedNewEmailForSync}`
      );
      const user = userRow.rows[0] as unknown as UserSyncRow | undefined;

      if (user) {
        if (user.stripe_customer_id) {
          try {
            const { getStripeClient } = await import('../stripe/client');
            const stripe = await getStripeClient();

            const metadata: Record<string, string> = {
              primaryEmail: normalizedNewEmailForSync,
              userId: user.id,
              source: 'even_house_app',
            };
            if (user.tier) metadata.tier = user.tier;
            if (user.first_name) metadata.firstName = user.first_name;
            if (user.last_name) metadata.lastName = user.last_name;

            const updateParams: Record<string, unknown> = {
              email: normalizedNewEmailForSync,
              metadata,
            };
            if (user.first_name || user.last_name) {
              updateParams.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
            }
            if (user.phone) {
              updateParams.phone = user.phone;
            }

            await stripe.customers.update(String(user.stripe_customer_id), updateParams);
            logger.info(`[EmailChangeService] Updated Stripe customer ${user.stripe_customer_id} email and metadata`, {
              extra: { oldEmail: normalizedOldEmailForSync, newEmail: normalizedNewEmailForSync },
            });
          } catch (stripeErr: unknown) {
            const msg = `Stripe sync failed: ${getErrorMessage(stripeErr)}`;
            logger.error(`[EmailChangeService] ${msg}`, {
              error: stripeErr,
              extra: { stripeCustomerId: user.stripe_customer_id, oldEmail: normalizedOldEmailForSync, newEmail: normalizedNewEmailForSync },
            });
            warnings.push(msg);
          }
        }

        if (user.hubspot_id) {
          try {
            const { getHubSpotClient } = await import('../integrations');
            const hubspotClient = await getHubSpotClient();
            await hubspotClient.crm.contacts.basicApi.update(String(user.hubspot_id), {
              properties: { email: normalizedNewEmailForSync },
            });
            logger.info(`[EmailChangeService] Updated HubSpot contact ${user.hubspot_id} email to ${normalizedNewEmailForSync}`);
          } catch (hubspotErr: unknown) {
            const errMsg = getErrorMessage(hubspotErr);
            logger.warn(`[EmailChangeService] HubSpot immediate sync failed, enqueuing for retry`, {
              error: hubspotErr,
              extra: { hubspotId: user.hubspot_id, oldEmail: normalizedOldEmailForSync, newEmail: normalizedNewEmailForSync },
            });
            try {
              const { enqueueHubSpotSync } = await import('../hubspot/queue');
              const jobId = await enqueueHubSpotSync(
                'update_contact_email',
                { hubspotId: user.hubspot_id, email: normalizedNewEmailForSync },
                { idempotencyKey: `email_change_${user.hubspot_id}_${normalizedNewEmailForSync}`, maxRetries: 5 }
              );
              if (jobId) {
                const queueMsg = `HubSpot sync failed (queued for retry, job ${jobId}): ${errMsg}`;
                logger.info(`[EmailChangeService] ${queueMsg}`);
                warnings.push(queueMsg);
              } else {
                const queueMsg = `HubSpot sync failed (retry already queued or enqueue conflict): ${errMsg}`;
                logger.warn(`[EmailChangeService] ${queueMsg}`);
                warnings.push(queueMsg);
              }
            } catch (queueErr: unknown) {
              const queueMsg = `HubSpot sync failed and queue fallback also failed: ${errMsg}; queue error: ${getErrorMessage(queueErr)}`;
              logger.error(`[EmailChangeService] ${queueMsg}`, { error: queueErr });
              warnings.push(queueMsg);
            }
          }
        }
      }
    } catch (syncErr: unknown) {
      const msg = `External sync lookup failed: ${getErrorMessage(syncErr)}`;
      logger.error(`[EmailChangeService] ${msg}`, { error: syncErr });
      warnings.push(msg);
    }

    return {
      success: true,
      oldEmail: oldEmail.toLowerCase().trim(),
      newEmail: newEmail.toLowerCase().trim(),
      tablesUpdated,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error: unknown) {
    logger.error('[EmailChangeService] Error cascading email change:', { error: error });
    return {
      success: false,
      oldEmail,
      newEmail,
      tablesUpdated: [],
      error: getErrorMessage(error) || 'Failed to cascade email change',
    };
  }
}

export async function previewEmailChangeImpact(
  email: string
): Promise<{
  tables: { tableName: string; columnName: string; rowCount: number }[];
  totalRows: number;
}> {
  const tables: { tableName: string; columnName: string; rowCount: number }[] = [];

  const tablesToCheck = [
    { table: 'users', column: 'email' },
    { table: 'hubspot_deals', column: 'member_email' },
    { table: 'guest_passes', column: 'member_email' },
    { table: 'member_notes', column: 'member_email' },
    { table: 'communication_logs', column: 'member_email' },
    { table: 'guest_check_ins', column: 'member_email' },
    { table: 'billing_groups', column: 'primary_email' },
    { table: 'group_members', column: 'member_email' },
    { table: 'booking_requests', column: 'user_email' },
    { table: 'admin_audit_log', column: 'resource_id' },
    { table: 'legacy_purchases', column: 'member_email' },
    { table: 'notifications', column: 'user_email' },
    { table: 'push_subscriptions', column: 'user_email' },
    { table: 'event_rsvps', column: 'user_email' },
    { table: 'wellness_enrollments', column: 'user_email' },
    { table: 'user_linked_emails', column: 'primary_email' },
    { table: 'user_dismissed_notices', column: 'user_email' },
  ];

  for (const { table, column } of tablesToCheck) {
    try {
      if (!ALLOWED_EMAIL_CHANGE_TABLES.has(table)) throw new Error(`Invalid table for email preview: ${table}`);
      if (!ALLOWED_EMAIL_CHANGE_COLUMNS.has(column)) throw new Error(`Invalid column for email preview: ${column}`);
      const result = await db.execute(
        sql`SELECT COUNT(*) as count FROM ${sql.raw(table)} WHERE LOWER(${sql.raw(column)}) = LOWER(${email.toLowerCase().trim()})`
      );
      const count = parseInt(String((result.rows[0] as unknown as CountRow).count), 10);
      if (count > 0) {
        tables.push({ tableName: table, columnName: column, rowCount: count });
      }
    } catch (error: unknown) {
      logger.warn(`[EmailChangeService] Could not check table ${table}:`, { error: error });
    }
  }

  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);

  return { tables, totalRows };
}

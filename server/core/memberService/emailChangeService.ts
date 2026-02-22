import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { logBillingAudit } from '../auditLog';

import { logger } from '../logger';
export interface EmailChangeResult {
  success: boolean;
  oldEmail: string;
  newEmail: string;
  tablesUpdated: {
    tableName: string;
    rowsAffected: number;
  }[];
  error?: string;
}

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
        const query = `
          UPDATE ${tableName}
          SET ${emailColumn} = $1
          WHERE LOWER(${emailColumn}) = LOWER($2)
          ${additionalCondition || ''}
        `;
        const result = await tx.execute(sql.raw(query.replace('$1', `'${normalizedNewEmail}'`).replace('$2', `'${normalizedOldEmail}'`)));
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

      rowCount = await updateTable('usage_ledger', 'member_id');
      if (rowCount > 0) tablesUpdated.push({ tableName: 'usage_ledger', rowsAffected: rowCount });

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

    const normalizedNewEmailForSync = newEmail.toLowerCase().trim();
    (async () => {
      try {
        const userRow = await db.execute(
          sql`SELECT stripe_customer_id, hubspot_id FROM users WHERE LOWER(email) = ${normalizedNewEmailForSync}`
        );
        const user = userRow.rows[0];
        if (!user) return;

        if (user.stripe_customer_id) {
          const { getStripeClient } = await import('../stripe/client');
          const stripe = await getStripeClient();
          await stripe.customers.update(user.stripe_customer_id, { email: normalizedNewEmailForSync });
          logger.info(`[EmailChangeService] Updated Stripe customer ${user.stripe_customer_id} email to ${normalizedNewEmailForSync}`);
        }

        if (user.hubspot_id) {
          const { getHubSpotClient } = await import('../integrations');
          const hubspotClient = await getHubSpotClient();
          await hubspotClient.crm.contacts.basicApi.update(user.hubspot_id, {
            properties: { email: normalizedNewEmailForSync },
          });
          logger.info(`[EmailChangeService] Updated HubSpot contact ${user.hubspot_id} email to ${normalizedNewEmailForSync}`);
        }
      } catch (err: unknown) {
        logger.error('[EmailChangeService] Background sync failed:', { error: err });
      }
    })();

    return {
      success: true,
      oldEmail: oldEmail.toLowerCase().trim(),
      newEmail: newEmail.toLowerCase().trim(),
      tablesUpdated,
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
    { table: 'booking_participants', column: 'user_id' },
    { table: 'admin_audit_log', column: 'resource_id' },
    { table: 'legacy_purchases', column: 'member_email' },
    { table: 'usage_ledger', column: 'member_id' },
  ];

  for (const { table, column } of tablesToCheck) {
    try {
      const result = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM ${table} WHERE LOWER(${column}) = LOWER('${email.replace(/'/g, "''")}')`)
      );
      const count = parseInt(result.rows[0].count, 10);
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

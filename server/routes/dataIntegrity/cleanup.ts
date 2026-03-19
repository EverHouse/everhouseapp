import { Router } from 'express';
import { isPlaceholderEmail } from '../../core/stripe/customers';
import { getStripeClient } from '../../core/stripe/client';
import { getHubSpotClientWithFallback } from '../../core/integrations';
import { retryableHubSpotRequest } from '../../core/hubspot/request';
import { logger, isAdmin, validateBody, db, sql, pool, safeRelease, logFromRequest, getErrorMessage, sendFixError } from './shared';
import type { Request } from 'express';
import { placeholderDeleteSchema } from '../../../shared/validators/dataIntegrity';

const router = Router();

router.get('/api/data-integrity/placeholder-accounts', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Scanning for placeholder accounts...');
    
    const stripeCustomers: { id: string; email: string; name: string | null; created: number }[] = [];
    const hubspotContacts: { id: string; email: string; name: string }[] = [];
    const localDatabaseUsers: { id: string; email: string; name: string; status: string; createdAt: string }[] = [];
    
    try {
      const localResult = await db.execute(sql`
        SELECT id, email, first_name, last_name, membership_status, created_at
        FROM users 
        WHERE email LIKE '%@visitors.evenhouse.club%'
           OR email LIKE '%@trackman.local%'
           OR email LIKE '%@trackman.import%'
           OR email LIKE 'unmatched-%'
           OR email LIKE 'unmatched@%'
           OR email LIKE 'golfnow-%'
           OR email LIKE 'classpass-%'
           OR email LIKE 'lesson-%'
           OR email LIKE 'anonymous-%'
           OR email LIKE 'anonymous@%'
           OR email LIKE 'private-event@%'
           OR email LIKE '%@resolved%'
           OR email LIKE '%@placeholder.%'
           OR email LIKE '%@test.local%'
           OR email LIKE '%@example.com%'
           OR email LIKE 'placeholder@%'
           OR email LIKE 'test@%'
           OR email LIKE 'test-admin%'
           OR email LIKE 'test-member%'
           OR email LIKE 'test-staff%'
           OR email LIKE 'testaccount@%'
           OR email LIKE 'testguest@%'
           OR email LIKE 'notif-test-%'
           OR email LIKE 'notification-test-%'
           OR email LIKE '%+test%@%'
        ORDER BY created_at DESC
      `);
      
      for (const row of localResult.rows) {
        localDatabaseUsers.push({
          id: row.id as string,
          email: row.email as string,
          name: [row.first_name as string, row.last_name as string].filter(Boolean).join(' ') || row.email as string,
          status: row.membership_status as string,
          createdAt: (row.created_at as Date)?.toISOString() || '',
        });
      }
    } catch (dbError: unknown) {
      logger.warn('[DataIntegrity] Local database scan failed', { extra: { dbError: getErrorMessage(dbError) } });
    }
    
    const stripe = await getStripeClient();
    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const customers = await stripe.customers.list({
        limit: 100,
        starting_after: startingAfter,
      });
      
      for (const customer of customers.data) {
        if (customer.email && isPlaceholderEmail(customer.email)) {
          stripeCustomers.push({
            id: customer.id,
            email: customer.email,
            name: customer.name ?? null,
            created: customer.created,
          });
        }
      }
      
      hasMore = customers.has_more;
      if (customers.data.length > 0) {
        startingAfter = customers.data[customers.data.length - 1].id;
      }
    }
    
    try {
      const { client: hubspot } = await getHubSpotClientWithFallback();
      let after: string | undefined;
      let hsHasMore = true;
      
      while (hsHasMore) {
        const contactsResponse = await retryableHubSpotRequest(() =>
          hubspot.crm.contacts.basicApi.getPage(100, after, ['email', 'firstname', 'lastname'])
        );
        
        for (const contact of contactsResponse.results) {
          const email = contact.properties.email;
          if (email && isPlaceholderEmail(email)) {
            const firstName = contact.properties.firstname || '';
            const lastName = contact.properties.lastname || '';
            hubspotContacts.push({
              id: contact.id,
              email,
              name: [firstName, lastName].filter(Boolean).join(' ') || email,
            });
          }
        }
        
        after = contactsResponse.paging?.next?.after;
        hsHasMore = !!after;
      }
    } catch (hubspotError: unknown) {
      logger.warn('[DataIntegrity] HubSpot scan failed', { extra: { hubspotError: getErrorMessage(hubspotError) } });
    }
    
    logFromRequest(req, 'placeholder_scan', 'system', undefined, undefined, {
      action: 'scan',
      stripeCount: stripeCustomers.length,
      hubspotCount: hubspotContacts.length,
      localDbCount: localDatabaseUsers.length,
    });

    res.json({
      success: true,
      stripeCustomers,
      hubspotContacts,
      localDatabaseUsers,
      totals: {
        stripe: stripeCustomers.length,
        hubspot: hubspotContacts.length,
        localDatabase: localDatabaseUsers.length,
        total: stripeCustomers.length + hubspotContacts.length + localDatabaseUsers.length,
      },
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Placeholder scan error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error);
  }
});

router.post('/api/data-integrity/placeholder-accounts/delete', isAdmin, validateBody(placeholderDeleteSchema), async (req: Request, res) => {
  try {
    const { stripeCustomerIds, hubspotContactIds, localDatabaseUserIds } = req.body;
    
    logger.info('[DataIntegrity] Deleting Stripe customers, HubSpot contacts, and local database users...', { extra: { stripeCustomerIds: stripeCustomerIds?.length || 0, hubspotContactIds: hubspotContactIds?.length || 0, localDatabaseUserIds: localDatabaseUserIds?.length || 0 } });
    
    const results = {
      stripeDeleted: 0,
      stripeFailed: 0,
      stripeErrors: [] as string[],
      hubspotDeleted: 0,
      hubspotFailed: 0,
      hubspotErrors: [] as string[],
      localDatabaseDeleted: 0,
      localDatabaseFailed: 0,
      localDatabaseErrors: [] as string[],
    };
    
    if (stripeCustomerIds?.length > 0) {
      const stripe = await getStripeClient();
      
      for (const customerId of stripeCustomerIds) {
        try {
          await stripe.customers.del(customerId);
          results.stripeDeleted++;
        } catch (error: unknown) {
          results.stripeFailed++;
          results.stripeErrors.push(`${customerId}: ${getErrorMessage(error)}`);
        }
      }
    }
    
    if (hubspotContactIds?.length > 0) {
      try {
        const { isHubSpotReadOnly, logHubSpotWriteSkipped } = await import('../../core/hubspot/readOnlyGuard');
        if (isHubSpotReadOnly()) {
          logHubSpotWriteSkipped('batch_archive_orphaned_contacts', `${hubspotContactIds.length} contacts`);
        } else {
          const { client: hubspot } = await getHubSpotClientWithFallback();
          
          const HUBSPOT_BATCH_SIZE = 100;
          for (let i = 0; i < hubspotContactIds.length; i += HUBSPOT_BATCH_SIZE) {
            const batch = hubspotContactIds.slice(i, i + HUBSPOT_BATCH_SIZE);
            try {
              await retryableHubSpotRequest(() =>
                hubspot.crm.contacts.batchApi.archive({ inputs: batch.map((id: string) => ({ id })) })
              );
              results.hubspotDeleted += batch.length;
            } catch (_batchErr: unknown) {
              for (const contactId of batch) {
                try {
                  await retryableHubSpotRequest(() =>
                    hubspot.crm.contacts.basicApi.archive(contactId)
                  );
                  results.hubspotDeleted++;
                } catch (error: unknown) {
                  results.hubspotFailed++;
                  results.hubspotErrors.push(`${contactId}: ${getErrorMessage(error)}`);
                }
              }
            }
          }
        }
      } catch (hubspotError: unknown) {
        logger.error('[DataIntegrity] HubSpot client failed', { extra: { hubspotError: getErrorMessage(hubspotError) } });
        results.hubspotErrors.push(`HubSpot connection failed: ${getErrorMessage(hubspotError)}`);
      }
    }
    
    if (localDatabaseUserIds?.length > 0) {
      for (const odUserId of localDatabaseUserIds) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          
          const userResult = await client.query(
            'SELECT id, email FROM users WHERE id = $1',
            [odUserId]
          );
          
          if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            results.localDatabaseFailed++;
            results.localDatabaseErrors.push(`${odUserId}: User not found`);
            continue;
          }
          
          const userId = userResult.rows[0].id;
          const userEmail = userResult.rows[0].email;
          
          await client.query(
            'DELETE FROM notifications WHERE user_id = $1',
            [userId]
          );
          
          await client.query(
            'DELETE FROM booking_sessions WHERE user_id = $1',
            [userId]
          );
          
          await client.query(
            'DELETE FROM booking_requests WHERE LOWER(user_email) = LOWER($1) OR user_id = $2',
            [userEmail, userId]
          );
          
          await client.query(
            'DELETE FROM event_rsvps WHERE LOWER(user_email) = LOWER($1)',
            [userEmail]
          );
          
          await client.query(
            'DELETE FROM wellness_enrollments WHERE LOWER(user_email) = LOWER($1)',
            [userEmail]
          );
          
          await client.query(
            'DELETE FROM pending_fees WHERE user_id = $1',
            [userId]
          );
          
          await client.query(
            'DELETE FROM user_notes WHERE user_id = $1',
            [userId]
          );
          
          const deleteResult = await client.query(
            'DELETE FROM users WHERE id = $1 RETURNING email',
            [userId]
          );
          
          await client.query('COMMIT');
          
          if (deleteResult.rowCount && deleteResult.rowCount > 0) {
            results.localDatabaseDeleted++;
            logger.info('[DataIntegrity] Deleted placeholder user and all related records', { extra: { userEmail } });
          } else {
            results.localDatabaseFailed++;
            results.localDatabaseErrors.push(`${odUserId}: Failed to delete user`);
          }
        } catch (error: unknown) {
          await client.query('ROLLBACK');
          results.localDatabaseFailed++;
          results.localDatabaseErrors.push(`${odUserId}: ${getErrorMessage(error)}`);
        } finally {
          safeRelease(client);
        }
      }
    }
    
    logFromRequest(
      req,
      'placeholder_accounts_deleted',
      'system',
      undefined,
      'Placeholder Accounts Cleanup',
      {
        stripeDeleted: results.stripeDeleted,
        stripeFailed: results.stripeFailed,
        hubspotDeleted: results.hubspotDeleted,
        hubspotFailed: results.hubspotFailed,
        localDatabaseDeleted: results.localDatabaseDeleted,
        localDatabaseFailed: results.localDatabaseFailed,
      }
    );
    
    const totalDeleted = results.stripeDeleted + results.hubspotDeleted + results.localDatabaseDeleted;
    const totalFailed = results.stripeFailed + results.hubspotFailed + results.localDatabaseFailed;
    
    res.json({
      success: true,
      message: `Deleted ${totalDeleted} placeholder accounts. ${totalFailed > 0 ? `${totalFailed} failed.` : ''}`,
      ...results,
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Placeholder delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error);
  }
});

export default router;

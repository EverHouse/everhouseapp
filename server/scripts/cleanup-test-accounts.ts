import { db } from '../db';
import { pool } from '../core/db';
import { users } from '../../shared/models/auth-session';
import { sql } from 'drizzle-orm';

const TEST_EMAILS = [
  'adinatestmbo@gmail.com',
  'notif-test-staff@example.com',
  'notification-test-member@evenhouse.club',
  'notification-test-member@example.com',
  'notification-test-staff@example.com',
  'test-admin@example.com',
  'test-member1@example.com',
  'test-staff-integrity@example.com',
  'test-staff@example.com',
  'test@evenhouse.club',
  'testaccount@example.com',
  'testcorp@evenhouse.club',
  'testguest@evenhouse.club'
];

async function cleanupTestAccounts() {
  console.log('Starting test account cleanup...');
  console.log(`Found ${TEST_EMAILS.length} test accounts to delete`);
  
  const { getStripeClient } = await import('../core/stripe');
  const { getHubSpotClient } = await import('../core/integrations');
  
  const stripe = await getStripeClient();
  let hubspot: any;
  try {
    hubspot = await getHubSpotClient();
  } catch (e) {
    console.log('HubSpot client not available, will skip HubSpot deletion');
  }
  
  let deletedCount = 0;
  let stripeDeletedCount = 0;
  let hubspotArchivedCount = 0;
  
  for (const email of TEST_EMAILS) {
    try {
      console.log(`\nProcessing: ${email}`);
      
      const userResult = await db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        stripeCustomerId: users.stripeCustomerId,
        hubspotId: users.hubspotId
      })
        .from(users)
        .where(sql`LOWER(${users.email}) = ${email.toLowerCase()}`);
      
      if (userResult.length === 0) {
        console.log(`  User not found, skipping`);
        continue;
      }
      
      const user = userResult[0];
      const userId = user.id;
      
      // Delete Stripe customer if exists
      if (user.stripeCustomerId) {
        try {
          await stripe.customers.del(user.stripeCustomerId);
          console.log(`  Deleted Stripe customer: ${user.stripeCustomerId}`);
          stripeDeletedCount++;
        } catch (stripeError: any) {
          console.log(`  Failed to delete Stripe customer: ${stripeError.message}`);
        }
      }
      
      // Archive HubSpot contact if exists
      if (user.hubspotId && hubspot) {
        try {
          await hubspot.crm.contacts.basicApi.archive(user.hubspotId);
          console.log(`  Archived HubSpot contact: ${user.hubspotId}`);
          hubspotArchivedCount++;
        } catch (hubspotError: any) {
          console.log(`  Failed to archive HubSpot contact: ${hubspotError.message}`);
        }
      }
      
      // Delete related records (handle foreign key dependencies in correct order)
      // First delete booking_fee_snapshots that reference booking_requests
      await pool.query(`
        DELETE FROM booking_fee_snapshots 
        WHERE booking_id IN (SELECT id FROM booking_requests WHERE user_email = $1)
      `, [email.toLowerCase()]);
      
      // Clear billing & financial records (by user_id)
      await pool.query('DELETE FROM usage_ledger WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM stripe_payment_intents WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM day_pass_purchases WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM legacy_purchases WHERE user_id = $1', [userId]);
      
      // Clear linked emails (by primary_email)
      await pool.query('DELETE FROM user_linked_emails WHERE LOWER(primary_email) = LOWER($1)', [email]);
      await pool.query('DELETE FROM booking_participants WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM account_deletion_requests WHERE user_id = $1', [userId]);
      
      // Clear records by email
      await pool.query('DELETE FROM member_notes WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM communication_logs WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM guest_passes WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM guest_check_ins WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM event_rsvps WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM wellness_enrollments WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM booking_requests WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM booking_members WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM notifications WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM admin_audit_log WHERE staff_email = $1 OR actor_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM billing_audit_log WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM bug_reports WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM data_export_requests WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM group_members WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM hubspot_deals WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM legacy_purchases WHERE member_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM push_subscriptions WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM user_dismissed_notices WHERE user_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM day_pass_purchases WHERE purchaser_email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM magic_links WHERE email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM form_submissions WHERE email = $1', [email.toLowerCase()]);
      await pool.query('DELETE FROM stripe_transaction_cache WHERE customer_email = $1', [email.toLowerCase()]);
      
      // Update event_rsvps that reference user by matched_user_id (clear the reference, don't delete)
      await pool.query('UPDATE event_rsvps SET matched_user_id = NULL WHERE matched_user_id = $1', [userId]);
      
      // Delete the user
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      console.log(`  Deleted user: ${user.firstName} ${user.lastName} (${email})`);
      deletedCount++;
      
    } catch (error: any) {
      console.error(`  Error processing ${email}:`, error.message);
    }
  }
  
  console.log('\n--- Cleanup Summary ---');
  console.log(`Users deleted: ${deletedCount}`);
  console.log(`Stripe customers deleted: ${stripeDeletedCount}`);
  console.log(`HubSpot contacts archived: ${hubspotArchivedCount}`);
  console.log('Cleanup complete!');
  
  process.exit(0);
}

cleanupTestAccounts().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});

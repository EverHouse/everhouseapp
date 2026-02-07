import { pool } from '../core/db';
import { getOrCreateStripeCustomer } from '../core/stripe/customers';
import { getStripeClient } from '../core/stripe/client';
import { PRICING } from '../core/billing/pricingConfig';

const TEST_MEMBER_EMAIL = 'testbooking@example.com';
const TEST_GUEST_EMAIL = 'testguest@example.com';
const CORE_TIER_PRICE_ID = 'price_1SspMd4XrxqCSeuFhrY3ChNw';

interface TestResult {
  step: string;
  success: boolean;
  data?: any;
  error?: string;
}

async function runE2ETest() {
  const results: TestResult[] = [];
  let testMemberId: string | null = null;
  let stripeCustomerId: string | null = null;
  let stripeSubscriptionId: string | null = null;
  let bookingRequestId: number | null = null;
  let webhookEventId: number | null = null;
  let sessionId: number | null = null;

  console.log('\n====================================');
  console.log('E2E BOOKING WORKFLOW TEST');
  console.log('====================================\n');

  try {
    // STEP 1: Create or get test member
    console.log('STEP 1: Creating/getting test member...');
    const memberResult = await pool.query(`
      INSERT INTO users (email, first_name, last_name, tier, membership_status, created_at, updated_at)
      VALUES ($1, 'Test', 'Booking', 'Core', 'active', NOW(), NOW())
      ON CONFLICT (email) DO UPDATE SET 
        first_name = 'Test',
        last_name = 'Booking',
        tier = 'Core',
        membership_status = 'active',
        updated_at = NOW()
      RETURNING id, email, tier, stripe_customer_id
    `, [TEST_MEMBER_EMAIL]);
    
    testMemberId = memberResult.rows[0].id;
    console.log(`  ✓ Member created/updated: ${testMemberId}`);
    results.push({ step: 'Create test member', success: true, data: { id: testMemberId } });

    // STEP 2: Create Stripe customer
    console.log('\nSTEP 2: Creating Stripe customer...');
    try {
      const customerResult = await getOrCreateStripeCustomer(
        testMemberId,
        TEST_MEMBER_EMAIL,
        'Test Booking',
        'Core'
      );
      stripeCustomerId = customerResult.customerId;
      console.log(`  ✓ Stripe customer: ${stripeCustomerId} (new: ${customerResult.isNew})`);
      results.push({ step: 'Create Stripe customer', success: true, data: { customerId: stripeCustomerId } });
    } catch (err: any) {
      console.log(`  ✗ Failed to create Stripe customer: ${err.message}`);
      results.push({ step: 'Create Stripe customer', success: false, error: err.message });
    }

    // STEP 3: Add payment method and create subscription (using test token)
    if (stripeCustomerId) {
      console.log('\nSTEP 3: Adding test payment method and subscription...');
      try {
        const stripe = await getStripeClient();
        
        // Check for existing subscription
        const existingSubs = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: 'active',
          limit: 1
        });
        
        if (existingSubs.data.length > 0) {
          stripeSubscriptionId = existingSubs.data[0].id;
          console.log(`  ✓ Using existing subscription: ${stripeSubscriptionId}`);
        } else {
          // Use test token instead of raw card numbers
          const paymentMethod = await stripe.paymentMethods.create({
            type: 'card',
            card: { token: 'tok_visa' }
          });
          
          // Attach to customer
          await stripe.paymentMethods.attach(paymentMethod.id, {
            customer: stripeCustomerId
          });
          
          // Set as default
          await stripe.customers.update(stripeCustomerId, {
            invoice_settings: {
              default_payment_method: paymentMethod.id
            }
          });
          
          // Create subscription
          const subscription = await stripe.subscriptions.create({
            customer: stripeCustomerId,
            items: [{ price: CORE_TIER_PRICE_ID }],
            default_payment_method: paymentMethod.id,
            metadata: {
              userId: testMemberId,
              source: 'e2e_test'
            }
          });
          
          stripeSubscriptionId = subscription.id;
          console.log(`  ✓ Subscription created: ${stripeSubscriptionId} (status: ${subscription.status})`);
        }
        
        // Update user with subscription ID
        await pool.query(
          'UPDATE users SET stripe_subscription_id = $1, updated_at = NOW() WHERE id = $2',
          [stripeSubscriptionId, testMemberId]
        );
        
        results.push({ step: 'Create subscription', success: true, data: { subscriptionId: stripeSubscriptionId } });
      } catch (err: any) {
        console.log(`  ✗ Failed to create subscription: ${err.message}`);
        results.push({ step: 'Create subscription', success: false, error: err.message });
      }
    }

    // STEP 4: Create booking request for tomorrow
    console.log('\nSTEP 4: Creating booking request...');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const requestDate = tomorrow.toISOString().split('T')[0];
    const startTime = '14:00:00';
    const endTime = '15:00:00';
    
    try {
      const bookingResult = await pool.query(`
        INSERT INTO booking_requests 
        (user_id, user_email, user_name, resource_id, request_date, start_time, end_time, 
         duration_minutes, status, declared_player_count, origin, created_at, updated_at)
        VALUES ($1, $2, 'Test Booking', 1, $3, $4, $5, 60, 'pending', 2, 'member_request', NOW(), NOW())
        RETURNING id, status
      `, [testMemberId, TEST_MEMBER_EMAIL, requestDate, startTime, endTime]);
      
      bookingRequestId = bookingResult.rows[0].id;
      console.log(`  ✓ Booking request created: #${bookingRequestId} for ${requestDate} ${startTime}-${endTime}`);
      results.push({ step: 'Create booking request', success: true, data: { bookingId: bookingRequestId, date: requestDate } });
    } catch (err: any) {
      console.log(`  ✗ Failed to create booking request: ${err.message}`);
      results.push({ step: 'Create booking request', success: false, error: err.message });
    }

    // STEP 5: Simulate Trackman webhook
    console.log('\nSTEP 5: Simulating Trackman webhook...');
    const trackmanBookingId = `TM-TEST-${Date.now()}`;
    try {
      // Insert webhook event (using actual column names and valid enum)
      const webhookResult = await pool.query(`
        INSERT INTO trackman_webhook_events 
        (trackman_booking_id, event_type, payload, created_at)
        VALUES ($1, 'booking_update', $2, NOW())
        RETURNING id
      `, [trackmanBookingId, JSON.stringify({
        test: true,
        booking: {
          id: trackmanBookingId,
          start: `${requestDate}T${startTime}`,
          end: `${requestDate}T${endTime}`,
          bay: { ref: 1 },
          customer: { email: TEST_MEMBER_EMAIL, name: 'Test Booking' }
        }
      })]);
      
      webhookEventId = webhookResult.rows[0].id;
      console.log(`  ✓ Webhook event created: #${webhookEventId} (trackman_id: ${trackmanBookingId})`);
      results.push({ step: 'Simulate webhook', success: true, data: { eventId: webhookEventId, trackmanId: trackmanBookingId } });
    } catch (err: any) {
      console.log(`  ✗ Failed to simulate webhook: ${err.message}`);
      results.push({ step: 'Simulate webhook', success: false, error: err.message });
    }

    // STEP 6: Auto-match the request to the webhook
    console.log('\nSTEP 6: Testing auto-match logic...');
    if (bookingRequestId && webhookEventId) {
      try {
        // Update booking with trackman ID (simulating auto-match)
        await pool.query(`
          UPDATE booking_requests 
          SET trackman_booking_id = $1,
              status = 'approved',
              reviewed_at = NOW(),
              reviewed_by = 'auto_match_test',
              updated_at = NOW()
          WHERE id = $2
        `, [trackmanBookingId, bookingRequestId]);
        
        // Update webhook event to matched
        await pool.query(`
          UPDATE trackman_webhook_events 
          SET status = 'matched',
              matched_booking_id = $1,
              matched_at = NOW()
          WHERE id = $2
        `, [bookingRequestId, webhookEventId]);
        
        console.log(`  ✓ Auto-match successful: booking #${bookingRequestId} linked to ${trackmanBookingId}`);
        results.push({ step: 'Auto-match', success: true, data: { bookingId: bookingRequestId, trackmanId: trackmanBookingId } });
      } catch (err: any) {
        console.log(`  ✗ Auto-match failed: ${err.message}`);
        results.push({ step: 'Auto-match', success: false, error: err.message });
      }
    }

    // STEP 7: Verify time slot is blocked
    console.log('\nSTEP 7: Verifying time slot is blocked...');
    if (bookingRequestId) {
      try {
        const conflictCheck = await pool.query(`
          SELECT id, status FROM booking_requests 
          WHERE resource_id = 1 
            AND request_date = $1 
            AND start_time = $2
            AND status NOT IN ('cancelled', 'declined')
        `, [requestDate, startTime]);
        
        const isBlocked = conflictCheck.rows.length > 0;
        console.log(`  ✓ Time slot blocked: ${isBlocked} (${conflictCheck.rows.length} booking(s) found)`);
        results.push({ step: 'Time slot blocked', success: isBlocked, data: { blockedCount: conflictCheck.rows.length } });
      } catch (err: any) {
        console.log(`  ✗ Failed to check time slot: ${err.message}`);
        results.push({ step: 'Time slot blocked', success: false, error: err.message });
      }
    }

    // STEP 8: Create billing session and add guest
    console.log('\nSTEP 8: Creating billing session and adding guest...');
    if (bookingRequestId) {
      try {
        // Create a booking session for the billing (using valid enum)
        const sessionResult = await pool.query(`
          INSERT INTO booking_sessions 
          (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by)
          VALUES (1, $1, $2, $3, $4, 'trackman_webhook', 'e2e_test')
          RETURNING id
        `, [requestDate, startTime, endTime, trackmanBookingId]);
        
        sessionId = sessionResult.rows[0].id;
        console.log(`  ✓ Billing session created: #${sessionId}`);
        
        // Link booking to session
        await pool.query(`
          UPDATE booking_requests SET session_id = $1 WHERE id = $2
        `, [sessionId, bookingRequestId]);
        
        // Get or create guest user
        const guestResult = await pool.query(`
          INSERT INTO guests (email, name, created_at)
          VALUES ($1, 'Test Guest', NOW())
          ON CONFLICT (email) DO UPDATE SET name = 'Test Guest'
          RETURNING id
        `, [TEST_GUEST_EMAIL]);
        
        const guestId = guestResult.rows[0].id;
        
        // Add guest as participant
        await pool.query(`
          INSERT INTO booking_participants 
          (session_id, user_id, guest_id, participant_type, display_name, created_at)
          VALUES ($1, $2, $3, 'guest', 'Test Guest', NOW())
          ON CONFLICT DO NOTHING
        `, [sessionId, testMemberId, guestId]);
        
        console.log(`  ✓ Guest added: ${TEST_GUEST_EMAIL}`);
        results.push({ step: 'Add guest', success: true, data: { guestEmail: TEST_GUEST_EMAIL, sessionId } });
      } catch (err: any) {
        console.log(`  ✗ Failed to add guest: ${err.message}`);
        results.push({ step: 'Add guest', success: false, error: err.message });
      }
    }

    // STEP 9: Check guest pass availability
    console.log('\nSTEP 9: Checking guest pass availability...');
    try {
      // Get tier guest pass limit
      const tierResult = await pool.query(`
        SELECT guest_passes_per_month FROM membership_tiers WHERE name = 'Core'
      `);
      const monthlyLimit = tierResult.rows[0]?.guest_passes_per_month || 4;
      
      // Count used guest passes this month from booking_participants
      const usedResult = await pool.query(`
        SELECT COUNT(*) as used FROM booking_participants bp
        JOIN booking_sessions bs ON bp.session_id = bs.id
        JOIN users u ON bp.user_id = u.id
        WHERE u.email = $1 
          AND bp.participant_type = 'guest' 
          AND bp.used_guest_pass = true
          AND DATE_TRUNC('month', bs.created_at) = DATE_TRUNC('month', NOW())
      `, [TEST_MEMBER_EMAIL]);
      
      const usedPasses = parseInt(usedResult.rows[0].used) || 0;
      const remainingPasses = Math.max(0, monthlyLimit - usedPasses);
      
      console.log(`  Monthly limit: ${monthlyLimit}, Used: ${usedPasses}, Remaining: ${remainingPasses}`);
      
      if (remainingPasses === 0) {
        console.log('  → Guest would require payment (no passes remaining)');
      } else {
        console.log('  → Guest covered by guest pass');
      }
      
      results.push({ 
        step: 'Check guest passes', 
        success: true, 
        data: { monthlyLimit, used: usedPasses, remaining: remainingPasses } 
      });
    } catch (err: any) {
      console.log(`  ✗ Failed to check guest passes: ${err.message}`);
      results.push({ step: 'Check guest passes', success: false, error: err.message });
    }

    // STEP 10: Test notification creation
    console.log('\nSTEP 10: Creating test notification...');
    if (testMemberId) {
      try {
        await pool.query(`
          INSERT INTO notifications 
          (user_email, type, title, message, is_read, created_at)
          VALUES ($1, 'booking_approved', 'Booking Confirmed', 
                  'Your simulator booking has been confirmed for tomorrow at 2pm', false, NOW())
        `, [TEST_MEMBER_EMAIL]);
        
        console.log('  ✓ Notification created for member');
        results.push({ step: 'Create notification', success: true });
      } catch (err: any) {
        console.log(`  ✗ Failed to create notification: ${err.message}`);
        results.push({ step: 'Create notification', success: false, error: err.message });
      }
    }

    // STEP 11: Create guest fee charge (if no passes remaining)
    console.log('\nSTEP 11: Testing guest fee charge...');
    if (stripeCustomerId) {
      try {
        const stripe = await getStripeClient();
        
        // Get the customer's default payment method
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        const defaultPaymentMethod = (customer as any).invoice_settings?.default_payment_method;
        
        if (!defaultPaymentMethod) {
          console.log('  ⚠ No default payment method - skipping charge test');
          results.push({ step: 'Charge guest fee', success: false, error: 'No payment method' });
        } else {
          // Get guest fee from tier
          const feeResult = await pool.query(`
            SELECT guest_fee_cents FROM membership_tiers WHERE name = 'Core'
          `);
          const guestFeeCents = feeResult.rows[0]?.guest_fee_cents || PRICING.GUEST_FEE_CENTS;
          
          // Create a test payment intent for guest fee with the payment method
          const paymentIntent = await stripe.paymentIntents.create({
            amount: guestFeeCents,
            currency: 'usd',
            customer: stripeCustomerId,
            payment_method: defaultPaymentMethod,
            description: `Guest fee for ${TEST_GUEST_EMAIL}`,
            metadata: {
              type: 'guest_fee',
              guestEmail: TEST_GUEST_EMAIL,
              bookingId: bookingRequestId?.toString() || '',
              source: 'e2e_test'
            },
            confirm: true,
            off_session: true
          });
          
          console.log(`  ✓ Guest fee charged: $${(guestFeeCents / 100).toFixed(2)} (${paymentIntent.id})`);
          console.log(`    Status: ${paymentIntent.status}`);
          results.push({ 
            step: 'Charge guest fee', 
            success: paymentIntent.status === 'succeeded', 
            data: { 
              amount: guestFeeCents / 100,
              paymentIntentId: paymentIntent.id,
              status: paymentIntent.status
            } 
          });
        }
      } catch (err: any) {
        console.log(`  ✗ Failed to charge guest fee: ${err.message}`);
        results.push({ step: 'Charge guest fee', success: false, error: err.message });
      }
    }

  } catch (err: any) {
    console.error('\n❌ Test failed with error:', err.message);
    results.push({ step: 'Overall test', success: false, error: err.message });
  }

  // Print summary
  console.log('\n====================================');
  console.log('TEST SUMMARY');
  console.log('====================================');
  
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  results.forEach(r => {
    const icon = r.success ? '✓' : '✗';
    console.log(`${icon} ${r.step}${r.error ? `: ${r.error}` : ''}`);
  });
  
  console.log('\n------------------------------------');
  console.log(`Total: ${passed} passed, ${failed} failed`);
  console.log('====================================\n');
  
  // Return useful IDs for verification
  return {
    testMemberId,
    stripeCustomerId,
    stripeSubscriptionId,
    bookingRequestId,
    webhookEventId,
    results
  };
}

// Run if called directly
runE2ETest()
  .then(result => {
    console.log('\nTest data for verification:');
    console.log(JSON.stringify({
      memberId: result.testMemberId,
      stripeCustomerId: result.stripeCustomerId,
      subscriptionId: result.stripeSubscriptionId,
      bookingId: result.bookingRequestId
    }, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

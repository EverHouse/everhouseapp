import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { sendPushNotification } from '../push';
import { getGuestPassesRemaining } from '../guestPasses';
import { getMemberTierByEmail, getTierLimits } from '../../core/tierService';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { logFromRequest } from '../../core/auditLog';
import { getStripeClient } from '../../core/stripe/client';

import { recordUsage, ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { updateVisitorTypeByUserId } from '../../core/visitors';
import { PRICING } from '../../core/billing/pricingConfig';
import { refundGuestPassForParticipant } from '../../core/billing/guestPassConsumer';
import { getErrorMessage } from '../../utils/errorUtils';

const router = Router();

router.get('/api/admin/trackman/needs-players', isStaffOrAdmin, async (req, res) => {
  try {
    const { limit = '20', offset = '0', search = '' } = req.query;
    const limitNum = Math.min(parseInt(limit as string) || 20, 100);
    const offsetNum = parseInt(offset as string) || 0;

    const sqlConditions: ReturnType<typeof sql>[] = [
      sql`br.status = 'approved'`,
      sql`bs.id IS NOT NULL`,
    ];

    if (search) {
      const searchPattern = `%${search}%`;
      sqlConditions.push(sql`(
        br.user_name ILIKE ${searchPattern} OR
        br.user_email ILIKE ${searchPattern}
      )`);
    }

    const whereFragment = sql.join(sqlConditions, sql` AND `);

    const countResult = await db.execute(sql`
      SELECT COUNT(*) FROM (
        SELECT br.id
        FROM booking_requests br
        INNER JOIN booking_sessions bs ON bs.id = br.session_id
        LEFT JOIN booking_participants bp ON bp.session_id = bs.id
        WHERE ${whereFragment}
        GROUP BY br.id, bs.id, br.declared_player_count, br.trackman_player_count
        HAVING COUNT(bp.id) < COALESCE(br.declared_player_count, br.trackman_player_count, 1)
      ) sub
    `);
    const totalCount = parseInt((countResult.rows[0] as any).count);

    const result = await db.execute(sql`
      SELECT
        br.id,
        br.user_name,
        br.user_email,
        br.request_date,
        br.resource_id,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.notes,
        br.trackman_player_count,
        br.declared_player_count,
        COALESCE(br.declared_player_count, br.trackman_player_count, 1) as expected_player_count,
        COUNT(bp.id)::int as assigned_count
      FROM booking_requests br
      INNER JOIN booking_sessions bs ON bs.id = br.session_id
      LEFT JOIN booking_participants bp ON bp.session_id = bs.id
      WHERE ${whereFragment}
      GROUP BY br.id, bs.id, br.declared_player_count, br.trackman_player_count
      HAVING COUNT(bp.id) < COALESCE(br.declared_player_count, br.trackman_player_count, 1)
      ORDER BY br.request_date DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}
    `);

    const data = result.rows.map((row: any) => {
      const expectedPlayerCount = parseInt(row.expected_player_count) || 1;
      const assignedCount = parseInt(row.assigned_count) || 0;
      return {
        id: row.id,
        userName: row.user_name,
        userEmail: row.user_email,
        requestDate: row.request_date,
        resourceId: row.resource_id,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        notes: row.notes,
        trackmanPlayerCount: row.trackman_player_count,
        playerCount: row.trackman_player_count,
        assignedCount,
        slotInfo: {
          totalSlots: expectedPlayerCount,
          filledSlots: assignedCount,
          expectedPlayerCount,
        },
      };
    });

    res.json({ data, totalCount });
  } catch (error: unknown) {
    console.error('Error fetching needs-players bookings:', error);
    res.status(500).json({ error: 'Failed to fetch needs-players bookings' });
  }
});

router.get('/api/admin/trackman/unmatched', isStaffOrAdmin, async (req, res) => {
  try {
    const { limit = '50', offset = '0', search = '', resolved = 'false', category = '' } = req.query;
    const limitNum = Math.min(parseInt(limit as string) || 50, 100);
    const offsetNum = parseInt(offset as string) || 0;
    const categoryFilter = (category as string).toLowerCase();
    
    const sqlConditions: ReturnType<typeof sql>[] = [sql`br.is_unmatched = true`];
    
    if (resolved === 'false') {
      sqlConditions.push(sql`(br.user_email IS NULL OR br.user_email = '' OR br.user_email LIKE 'unmatched-%@%' OR br.user_email LIKE '%@trackman.local')`);
    }
    
    if (search) {
      const searchPattern = `%${search}%`;
      sqlConditions.push(sql`(
        br.staff_notes ILIKE ${searchPattern} OR 
        br.trackman_customer_notes ILIKE ${searchPattern} OR
        br.trackman_booking_id::text ILIKE ${searchPattern}
      )`);
    }
    
    if (categoryFilter === 'matchable') {
      sqlConditions.push(sql`EXISTS (
        SELECT 1 FROM users u 
        WHERE LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
      )`);
    } else if (categoryFilter === 'events') {
      sqlConditions.push(sql`(
        br.user_name ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
        OR br.trackman_customer_notes ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
      )`);
    } else if (categoryFilter === 'visitors') {
      sqlConditions.push(sql`NOT EXISTS (
        SELECT 1 FROM users u 
        WHERE LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
      ) AND NOT (
        br.user_name ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
        OR br.trackman_customer_notes ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
      )`);
    }
    
    const whereFragment = sql.join(sqlConditions, sql` AND `);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) FROM booking_requests br WHERE ${whereFragment}`);
    const totalCount = parseInt((countResult.rows[0] as any).count);
    
    const result = await db.execute(sql`SELECT 
        br.id,
        br.trackman_booking_id,
        br.request_date as booking_date,
        br.start_time,
        br.end_time,
        br.resource_id,
        br.user_name as raw_user_name,
        r.name as bay_name,
        br.staff_notes,
        br.trackman_customer_notes as notes,
        br.trackman_player_count as player_count,
        br.created_at,
        br.updated_at,
        EXISTS (
          SELECT 1 FROM users u 
          WHERE LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
        ) as is_matchable,
        (
          br.user_name ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
          OR br.trackman_customer_notes ILIKE ANY(ARRAY['%birthday%', '%event%', '%party%', '%club%'])
        ) as is_event
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE ${whereFragment}
      ORDER BY br.request_date DESC, br.start_time DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}`);
    
    const parsedResults = result.rows.map((row: any) => {
      let userName = 'Unknown';
      let originalEmail = '';
      let matchAttemptReason = '';
      
      if (row.notes) {
        const nameMatch = row.notes.match(/Original name:\s*([^,]+)/i);
        const emailMatch = row.notes.match(/Original email:\s*([^,\s]+)/i);
        if (nameMatch) userName = nameMatch[1].trim();
        if (emailMatch) originalEmail = emailMatch[1].trim();
        matchAttemptReason = 'No matching member found in system';
      }
      
      // Use raw_user_name if no parsed name
      if (userName === 'Unknown' && row.raw_user_name) {
        userName = row.raw_user_name;
      }
      
      const bayNumber = row.bay_name ? row.bay_name.replace(/Bay\s*/i, '') : row.resource_id;
      
      // Determine category
      let bookingCategory: 'matchable' | 'events' | 'visitors' = 'visitors';
      if (row.is_matchable) {
        bookingCategory = 'matchable';
      } else if (row.is_event) {
        bookingCategory = 'events';
      }
      
      return {
        id: row.id,
        trackman_booking_id: row.trackman_booking_id,
        booking_date: row.booking_date,
        start_time: row.start_time,
        end_time: row.end_time,
        bay_number: bayNumber,
        bay_name: row.bay_name,
        user_name: userName,
        original_email: originalEmail,
        match_attempt_reason: matchAttemptReason,
        notes: row.notes,
        player_count: row.player_count,
        created_at: row.created_at,
        category: bookingCategory
      };
    });
    
    res.json({
      data: parsedResults,
      totalCount,
      page: Math.floor(offsetNum / limitNum) + 1,
      totalPages: Math.ceil(totalCount / limitNum)
    });
  } catch (error: unknown) {
    console.error('Error fetching unmatched bookings:', error);
    res.status(500).json({ error: 'Failed to fetch unmatched bookings' });
  }
});

// Auto-resolve matchable bookings - finds unmatched bookings where original email exists in users table
router.post('/api/admin/trackman/unmatched/auto-resolve', isStaffOrAdmin, async (req, res) => {
  try {
    const staffEmail = (req as any).session?.user?.email || 'admin';
    
    // Find all matchable bookings with their matching user
    const matchableResult = await db.execute(sql`SELECT 
        br.id as booking_id,
        br.trackman_booking_id,
        br.trackman_customer_notes,
        br.request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.resource_id,
        u.id as user_id,
        u.email as user_email,
        u.first_name,
        u.last_name,
        u.role
      FROM booking_requests br
      INNER JOIN users u ON LOWER(u.email) = LOWER(REGEXP_REPLACE(br.trackman_customer_notes, '.*Original email:\\s*([^,\\s]+).*', '\\1'))
      WHERE br.is_unmatched = true
        AND (br.user_email IS NULL OR br.user_email = '' OR br.user_email LIKE 'unmatched-%@%' OR br.user_email LIKE '%@trackman.local')
      ORDER BY br.request_date DESC
      LIMIT 100`);
    
    if (matchableResult.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No matchable bookings found',
        resolved: 0 
      });
    }
    
    let resolvedCount = 0;
    const errors: string[] = [];
    
    for (const row of matchableResult.rows as any[]) {
      try {
        // Update booking to link to the matched user
        await db.execute(sql`UPDATE booking_requests 
           SET user_id = ${row.user_id}, 
               user_email = ${row.user_email}, 
               user_name = ${`${row.first_name} ${row.last_name}`},
               is_unmatched = false,
               staff_notes = COALESCE(staff_notes, '') || ${` [Auto-resolved by ${staffEmail} on ${new Date().toISOString()}]`},
               updated_at = NOW()
           WHERE id = ${row.booking_id}`);
        
        resolvedCount++;
      } catch (err: unknown) {
        errors.push(`Booking ${row.trackman_booking_id}: ${getErrorMessage(err)}`);
      }
    }
    
    await logFromRequest(req, {
      action: 'bulk_action',
      resourceType: 'trackman',
      resourceId: 'auto-resolve',
      resourceName: 'Auto-resolve matchable bookings',
      details: { 
        resolvedCount,
        totalFound: matchableResult.rows.length,
        errors: errors.length > 0 ? errors : undefined
      }
    });
    
    res.json({ 
      success: true, 
      message: `Auto-resolved ${resolvedCount} matchable booking(s)`,
      resolved: resolvedCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: unknown) {
    console.error('Error auto-resolving matchable bookings:', error);
    res.status(500).json({ error: 'Failed to auto-resolve matchable bookings' });
  }
});

// Bulk dismiss bookings as external (visitor/event) - removes from unresolved queue
router.post('/api/admin/trackman/unmatched/bulk-dismiss', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingIds, reason = 'external_booking' } = req.body;
    const staffEmail = (req as any).session?.user?.email || 'admin';
    
    if (!bookingIds || !Array.isArray(bookingIds) || bookingIds.length === 0) {
      return res.status(400).json({ error: 'bookingIds array is required' });
    }
    
    if (bookingIds.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 bookings can be dismissed at once' });
    }
    
    const validReasons = ['external_booking', 'visitor', 'event', 'duplicate', 'test_data', 'other'];
    const dismissReason = validReasons.includes(reason) ? reason : 'external_booking';
    
    const result = await db.execute(sql`UPDATE booking_requests 
       SET is_unmatched = false,
           staff_notes = COALESCE(staff_notes, '') || ${` [Dismissed as ${dismissReason} by ${staffEmail} on ${new Date().toISOString()}]`},
           updated_at = NOW()
       WHERE id IN (${sql.join(bookingIds.map((id: number) => sql`${id}`), sql`, `)})
         AND is_unmatched = true
       RETURNING id, trackman_booking_id`);
    
    const dismissedCount = result.rowCount || 0;
    
    await logFromRequest(req, {
      action: 'bulk_action',
      resourceType: 'trackman',
      resourceId: 'bulk-dismiss',
      resourceName: 'Bulk dismiss unmatched bookings',
      details: { 
        dismissedCount,
        reason: dismissReason,
        bookingIds: result.rows.map((r: any) => r.trackman_booking_id || r.id)
      }
    });
    
    res.json({ 
      success: true, 
      message: `Dismissed ${dismissedCount} booking(s) as ${dismissReason}`,
      dismissed: dismissedCount
    });
  } catch (error: unknown) {
    console.error('Error bulk dismissing bookings:', error);
    res.status(500).json({ error: 'Failed to dismiss bookings' });
  }
});

router.put('/api/admin/trackman/unmatched/:id/resolve', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, memberEmail, rememberEmail } = req.body;
    const resolveEmail = memberEmail || email;
    
    if (!resolveEmail) {
      return res.status(400).json({ error: 'Email is required (memberEmail or email)' });
    }
    
    const memberResult = await db.execute(sql`SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.stripe_customer_id, u.tier, u.archived_at,
              su.role as staff_role, su.is_active as is_staff_active
       FROM users u
       LEFT JOIN staff_users su ON LOWER(su.email) = LOWER(u.email) AND su.is_active = true
       WHERE LOWER(u.email) = LOWER(${resolveEmail.toLowerCase()})`);
    
    if (memberResult.rows.length === 0) {
      const staffCheck = await db.execute(sql`SELECT id, email, first_name, last_name, role FROM staff_users WHERE LOWER(email) = LOWER(${resolveEmail.toLowerCase()}) AND is_active = true`);
      
      if (staffCheck.rows.length > 0) {
        return res.status(404).json({ 
          error: 'This is a staff email but no user profile exists. Please ask an admin to set up this staff member in the system first.',
          isStaffEmail: true
        });
      }
      
      return res.status(404).json({ error: 'Member not found with that email. Make sure they exist in the member directory.' });
    }
    
    const member = memberResult.rows[0] as any;
    
    // Task 7: Check if member is archived
    if (member.archived_at) {
      return res.status(400).json({ error: 'Cannot assign booking to an archived member. Please reactivate the member first.' });
    }
    
    const isVisitor = member.role === 'visitor' && !member.staff_role;
    const staffEmail = (req as any).session?.user?.email || 'admin';
    
    let bookingResult = await db.execute(sql`SELECT id, trackman_booking_id, staff_notes, trackman_customer_notes, request_date, start_time, end_time, 
              duration_minutes, resource_id, session_id
       FROM booking_requests WHERE id = ${id}`);
    
    let booking = bookingResult.rows[0] as any;
    let fromLegacyTable = false;
    
    if (!booking) {
      const legacyResult = await db.execute(sql`SELECT id, trackman_booking_id, user_name, original_email, booking_date, 
                start_time, end_time, duration_minutes, bay_number, notes
         FROM trackman_unmatched_bookings WHERE id = ${id} AND resolved_at IS NULL`);
      
      if (legacyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found in either booking requests or unmatched bookings' });
      }
      
      const legacy = legacyResult.rows[0] as any;
      fromLegacyTable = true;
      
      let resourceId = 1;
      if (legacy.bay_number) {
        const bayNum = parseInt(legacy.bay_number.replace(/\D/g, ''));
        if (bayNum >= 1 && bayNum <= 4) resourceId = bayNum;
      }
      
      // Use ON CONFLICT to handle race conditions (e.g., if booking was already created via CSV import)
      const createResult = await db.execute(sql`INSERT INTO booking_requests (
          user_id, user_email, user_name, resource_id, request_date, start_time, end_time,
          duration_minutes, status, trackman_booking_id, is_unmatched, staff_notes, created_at, updated_at
        ) VALUES (${member.id}, ${member.email}, ${`${member.first_name} ${member.last_name}`}, ${resourceId}, ${legacy.booking_date}, ${legacy.start_time}, ${legacy.end_time}, ${legacy.duration_minutes || 60}, 'approved', ${legacy.trackman_booking_id}, false, ${`[Resolved from legacy unmatched by ${staffEmail}] ${legacy.notes || ''}`}, NOW(), NOW())
        ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
          user_id = EXCLUDED.user_id,
          user_email = EXCLUDED.user_email,
          user_name = EXCLUDED.user_name,
          is_unmatched = false,
          staff_notes = booking_requests.staff_notes || ' ' || EXCLUDED.staff_notes,
          updated_at = NOW()
        RETURNING id, trackman_booking_id, staff_notes, request_date, start_time, end_time, duration_minutes, resource_id`);
      
      booking = createResult.rows[0] as any;
      
      await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_email = ${member.email} WHERE id = ${id}`);
    } else {
      await db.execute(sql`UPDATE booking_requests 
         SET user_id = ${member.id}, 
             user_email = ${member.email}, 
             is_unmatched = false,
             staff_notes = COALESCE(staff_notes, '') || ${` [Resolved by ${staffEmail} on ${new Date().toISOString()}]`},
             updated_at = NOW()
         WHERE id = ${id}`);
    }
    
    await db.execute(sql`UPDATE booking_requests 
       SET user_id = ${member.id}, 
           user_email = ${member.email}, 
           is_unmatched = false,
           staff_notes = COALESCE(staff_notes, '') || ${` [Resolved by ${staffEmail} on ${new Date().toISOString()}]`},
           updated_at = NOW()
       WHERE id = ${id}`);
    
    let originalEmailForLearning: string | null = null;
    if (fromLegacyTable) {
      const legacyData = await db.execute(sql`SELECT original_email FROM trackman_unmatched_bookings WHERE id = ${id}`);
      if ((legacyData.rows[0] as any)?.original_email) {
        originalEmailForLearning = (legacyData.rows[0] as any).original_email.toLowerCase().trim();
      }
    } else if (booking.trackman_customer_notes) {
      const emailMatch = booking.trackman_customer_notes.match(/Original email:\s*([^\s,]+)/i);
      if (emailMatch && emailMatch[1]) {
        originalEmailForLearning = emailMatch[1].toLowerCase().trim();
      }
    }
    
    const PLACEHOLDER_EMAILS = [
      'anonymous@yourgolfbooking.com',
      'booking@evenhouse.club',
      'bookings@evenhouse.club',
      'tccmembership@evenhouse.club'
    ];
    const isPlaceholderEmail = (email: string): boolean => {
      const normalizedEmail = email.toLowerCase().trim();
      if (PLACEHOLDER_EMAILS.includes(normalizedEmail)) return true;
      if (normalizedEmail.endsWith('@evenhouse.club') && normalizedEmail.length < 25) {
        const localPart = normalizedEmail.split('@')[0];
        if (/^[a-z]{3,12}$/.test(localPart) && !/\d/.test(localPart)) {
          return true;
        }
      }
      if (normalizedEmail.endsWith('@trackman.local') || normalizedEmail.startsWith('unmatched-')) return true;
      return false;
    };
    
    let emailLearningMessage = '';
    if (rememberEmail && originalEmailForLearning && originalEmailForLearning.includes('@')) {
      if (originalEmailForLearning.toLowerCase() !== member.email.toLowerCase() && 
          !isPlaceholderEmail(originalEmailForLearning)) {
        try {
          const existingLink = await db.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${originalEmailForLearning})`);
          
          if (existingLink.rows.length === 0) {
            await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
               VALUES (${member.email.toLowerCase()}, ${originalEmailForLearning}, ${'staff_resolution'}, ${staffEmail})`);
            console.log(`[Email Learning] Linked ${originalEmailForLearning} -> ${member.email} by ${staffEmail}`);
            
            // Auto-resolve other unresolved bookings with the same original email
            const otherUnresolvedResult = await db.execute(sql`SELECT id, trackman_booking_id 
               FROM booking_requests 
               WHERE is_unmatched = true 
               AND id != ${id}
               AND (
                 trackman_customer_notes ILIKE ${`%${originalEmailForLearning}%`}
                 OR user_email ILIKE ${`%${originalEmailForLearning.split('@')[0]}%`}
               )`);
            
            let autoResolvedCount = 0;
            for (const otherBooking of otherUnresolvedResult.rows as any[]) {
              try {
                await db.execute(sql`UPDATE booking_requests 
                   SET user_id = ${member.id}, 
                       user_email = ${member.email}, 
                       is_unmatched = false,
                       staff_notes = COALESCE(staff_notes, '') || ${` [Auto-resolved via linked email by ${staffEmail} on ${new Date().toISOString()}]`},
                       updated_at = NOW()
                   WHERE id = ${otherBooking.id}`);
                autoResolvedCount++;
              } catch (autoErr: unknown) {
                console.error(`[Email Learning] Failed to auto-resolve booking ${otherBooking.id}:`, getErrorMessage(autoErr));
              }
            }
            
            if (autoResolvedCount > 0) {
              emailLearningMessage = ` Email ${originalEmailForLearning} learned and ${autoResolvedCount} other booking(s) auto-resolved.`;
              console.log(`[Email Learning] Auto-resolved ${autoResolvedCount} other bookings for ${originalEmailForLearning}`);
            } else {
              emailLearningMessage = ` Email ${originalEmailForLearning} learned for future auto-matching.`;
            }
          }
        } catch (linkError: unknown) {
          console.error('[Email Learning] Failed to save email link:', getErrorMessage(linkError));
        }
      }
    }
    
    let billingMessage = '';
    
    if (isVisitor) {
      try {
        const bookingDate = booking.request_date;
        const bookingDateStr = typeof bookingDate === 'string' ? bookingDate : 
          new Date(bookingDate).toISOString().split('T')[0];
        
        const existingDayPass = await db.execute(sql`SELECT id, stripe_payment_intent_id FROM day_pass_purchases 
           WHERE user_id = ${member.id} 
           AND product_type = 'day-pass-golf-sim'
           AND (
             (booking_date = ${bookingDateStr}::date OR (booking_date IS NULL AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = ${bookingDateStr}::date))
             OR trackman_booking_id = ${booking.trackman_booking_id}
           )
           AND (status IS NULL OR status != 'cancelled')`);
        
        if (existingDayPass.rows.length === 0) {
          const dayPassResult = await db.execute(sql`SELECT price_cents, stripe_price_id, name FROM membership_tiers 
             WHERE slug = 'day-pass-golf-sim' AND is_active = true`);
          
          if (dayPassResult.rows.length > 0) {
            const dayPass = dayPassResult.rows[0] as any;
            const amountCents = dayPass.price_cents;
            if (!amountCents || amountCents <= 0) {
              console.error(`[Trackman Resolve] Day pass price_cents is missing or zero for slug 'day-pass-golf-sim' — cannot bill`);
              billingMessage = ' Day pass billing skipped: price not configured in membership_tiers.';
              await db.execute(sql`INSERT INTO day_pass_purchases 
                 (user_id, product_type, quantity, amount_cents, booking_date, status, trackman_booking_id, created_at)
                 VALUES (${member.id}, ${'day-pass-golf-sim'}, 1, 0, ${bookingDateStr}, ${'pending_price'}, ${booking.trackman_booking_id}, NOW())`);
            } else {
            const customerId = member.stripe_customer_id;
            if (!customerId) {
              console.log(`[Trackman Resolve] Skipping day pass billing for visitor ${member.email} - no Stripe customer`);
              billingMessage = ' Day pass record created (no Stripe customer for billing).';
              await db.execute(sql`INSERT INTO day_pass_purchases 
                 (user_id, product_type, quantity, amount_cents, booking_date, status, trackman_booking_id, created_at)
                 VALUES (${member.id}, ${'day-pass-golf-sim'}, 1, ${amountCents}, ${bookingDateStr}, ${'pending'}, ${booking.trackman_booking_id}, NOW())`);
            } else {
            
            const stripe = await getStripeClient();
            
            const paymentMethods = await stripe.paymentMethods.list({
              customer: customerId,
              type: 'card',
              limit: 1
            });
            
            let paymentStatus = 'pending';
            let paymentIntentId = '';
            
            if (paymentMethods.data.length > 0) {
              const paymentIntent = await stripe.paymentIntents.create({
                amount: amountCents,
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethods.data[0].id,
                confirm: true,
                off_session: true,
                description: `Day Pass - Golf Simulator (${bookingDateStr})`,
                metadata: {
                  type: 'day_pass',
                  product_slug: 'day-pass-golf-sim',
                  booking_id: booking.id.toString(),
                  booking_date: bookingDateStr,
                  visitor_email: member.email,
                  created_via: 'trackman_resolve'
                }
              }, {
                idempotencyKey: `trackman_daypass_${booking.id}_${customerId}`
              });
              
              paymentIntentId = paymentIntent.id;
              paymentStatus = paymentIntent.status === 'succeeded' ? 'paid' : 'pending';
              
              if (paymentIntent.status === 'succeeded') {
                billingMessage = ` Day pass charged: $${(amountCents / 100).toFixed(2)}.`;
                console.log(`[Trackman Resolve] Day pass charged for visitor ${member.email}: $${(amountCents / 100).toFixed(2)}`);
              } else {
                billingMessage = ` Day pass payment initiated ($${(amountCents / 100).toFixed(2)}).`;
              }
            } else {
              const invoice = await stripe.invoices.create({
                customer: customerId,
                auto_advance: true,
                collection_method: 'send_invoice',
                days_until_due: 1,
                metadata: {
                  type: 'day_pass',
                  product_slug: 'day-pass-golf-sim',
                  booking_id: booking.id.toString(),
                  booking_date: bookingDateStr,
                  visitor_email: member.email,
                  created_via: 'trackman_resolve'
                }
              });
              
              await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: amountCents,
                currency: 'usd',
                description: `Day Pass - Golf Simulator (${bookingDateStr})`
              });
              
              await stripe.invoices.finalizeInvoice(invoice.id);
              await stripe.invoices.sendInvoice(invoice.id);
              
              paymentIntentId = invoice.id;
              billingMessage = ` Day pass invoice sent ($${(amountCents / 100).toFixed(2)}).`;
              console.log(`[Trackman Resolve] Day pass invoice sent for visitor ${member.email}: $${(amountCents / 100).toFixed(2)}`);
            }
            
            await db.execute(sql`INSERT INTO day_pass_purchases 
               (user_id, product_type, quantity, amount_cents, stripe_payment_intent_id, booking_date, status, trackman_booking_id, created_at)
               VALUES (${member.id}, ${'day-pass-golf-sim'}, 1, ${amountCents}, ${paymentIntentId}, ${bookingDateStr}, ${paymentStatus}, ${booking.trackman_booking_id}, NOW())`);
            
            updateVisitorTypeByUserId(member.id, 'day_pass', 'day_pass_purchase', new Date(bookingDateStr))
              .catch(err => console.error('[VisitorType] Failed to update day_pass type:', err));
            }
            }
          }
        } else {
          billingMessage = ' (Day pass already purchased for this date)';
        }
        
        let sessionId = booking.session_id;
        if (!sessionId) {
          const sessionResult = await ensureSessionForBooking({
            bookingId: booking.id,
            resourceId: booking.resource_id,
            sessionDate: bookingDateStr,
            startTime: booking.start_time,
            endTime: booking.end_time,
            ownerEmail: member.email || '',
            ownerName: `${member.first_name} ${member.last_name}`,
            ownerUserId: member.id?.toString(),
            trackmanBookingId: booking.trackman_booking_id,
            source: 'trackman_import',
            createdBy: 'staff_resolve'
          });
          sessionId = sessionResult.sessionId || null;
        }
        
        if (sessionId) {
          await recordUsage(sessionId, {
            memberId: member.id,
            minutesCharged: booking.duration_minutes || 60,
          } as any);
        }
      } catch (billingError: unknown) {
        console.error('[Trackman Resolve] Billing error for visitor:', billingError);
        billingMessage = ' (Billing setup failed - manual follow-up needed)';
      }
    }
    
    if (!isVisitor) {
      try {
        const bookingDateStr = typeof booking.request_date === 'string' ? booking.request_date : 
          new Date(booking.request_date).toISOString().split('T')[0];
        
        let sessionId = booking.session_id;
        if (!sessionId) {
          const sessionResult = await ensureSessionForBooking({
            bookingId: booking.id,
            resourceId: booking.resource_id,
            sessionDate: bookingDateStr,
            startTime: booking.start_time,
            endTime: booking.end_time,
            ownerEmail: member.email || '',
            ownerName: `${member.first_name} ${member.last_name}`,
            ownerUserId: member.id?.toString(),
            trackmanBookingId: booking.trackman_booking_id,
            source: 'trackman_import',
            createdBy: 'staff_resolve'
          });
          sessionId = sessionResult.sessionId || null;
        }
        
        if (sessionId) {
          // Recalculate fees for the session now that we have an owner
          try {
            await recalculateSessionFees(sessionId, 'assign_to_member' as any);
            console.log(`[Trackman Resolve] Recalculated fees for session ${sessionId}`);
          } catch (feeErr) {
            console.warn(`[Trackman Resolve] Failed to recalculate fees for session ${sessionId}:`, feeErr);
          }
          
          // IDEMPOTENCY: Check existing usage and handle ownership
          const existingUsage = await db.execute(sql`SELECT id, member_id FROM usage_ledger WHERE session_id = ${sessionId} AND usage_type = 'base' LIMIT 1`);
          
          if (existingUsage.rows.length === 0) {
            await recordUsage(sessionId, {
              memberId: member.id,
              minutesCharged: booking.duration_minutes || 60,
            } as any);
            console.log(`[Trackman Resolve] Created session and usage ledger for member ${member.email}, booking #${booking.id}`);
          } else {
            // OWNERSHIP CORRECTION: If existing usage belongs to a different member, update it
            const existingMemberId = (existingUsage.rows[0] as any).member_id;
            if (existingMemberId !== member.id) {
              await db.execute(sql`UPDATE usage_ledger SET member_id = ${member.id} WHERE session_id = ${sessionId} AND usage_type = 'base'`);
              console.log(`[Trackman Resolve] Corrected usage ownership: ${existingMemberId} -> ${member.id} for session ${sessionId}`);
            } else {
              console.log(`[Trackman Resolve] Session ${sessionId} already has correct usage ledger, skipping`);
            }
          }
        }
      } catch (sessionError: unknown) {
        console.error('[Trackman Resolve] Session creation error for member:', sessionError);
        billingMessage += ' (Session setup may need manual review)';
      }
    }

    await logFromRequest(req, {
      action: 'link_trackman_to_member',
      resourceType: 'booking',
      resourceId: id as string,
      resourceName: `Trackman ${booking.trackman_booking_id || id}`,
      details: { 
        linkedEmail: member.email, 
        memberName: `${member.first_name} ${member.last_name}`,
        trackmanId: booking.trackman_booking_id,
        isVisitor,
        billingApplied: billingMessage.length > 0
      }
    });
    
    res.json({ 
      success: true, 
      message: `Booking linked to ${member.first_name} ${member.last_name}${billingMessage}${emailLearningMessage}`,
      emailLearned: emailLearningMessage.length > 0 ? originalEmailForLearning : null
    });
  } catch (error: unknown) {
    console.error('Error resolving unmatched booking:', error);
    const errorMessage = (error as any)?.message || 'Unknown error';
    if (errorMessage.includes('Stripe') || errorMessage.includes('stripe')) {
      return res.status(500).json({ error: `Billing error: ${errorMessage}` });
    }
    if (errorMessage.includes('constraint') || errorMessage.includes('duplicate')) {
      return res.status(400).json({ error: 'This booking may already be assigned to a member' });
    }
    res.status(500).json({ error: `Failed to resolve booking: ${errorMessage}` });
  }
});

router.post('/api/admin/trackman/auto-resolve-same-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { originalEmail, memberEmail, excludeTrackmanId } = req.body;
    
    if (!originalEmail) {
      return res.status(400).json({ error: 'originalEmail is required' });
    }
    
    const resolveToEmail = memberEmail || null;
    const staffEmail = (req as any).session?.user?.email || 'admin';
    
    // First, resolve bookings in booking_requests table (current system)
    let bookingRequestsResolved = 0;
    if (resolveToEmail) {
      const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, role FROM users WHERE LOWER(email) = LOWER(${resolveToEmail})`);
      
      if (memberResult.rows.length > 0) {
        const member = memberResult.rows[0] as any;
        
        const bookingRequestsResult = await db.execute(sql`SELECT id, trackman_booking_id 
           FROM booking_requests 
           WHERE is_unmatched = true 
           AND (${excludeTrackmanId || null}::text IS NULL OR trackman_booking_id != ${excludeTrackmanId || null})
           AND (
             trackman_customer_notes ILIKE ${`%${originalEmail}%`}
             OR staff_notes ILIKE ${`%${originalEmail}%`}
           )`);
        
        for (const booking of bookingRequestsResult.rows as any[]) {
          try {
            if (member.role === 'golf_instructor' || 
                (await db.execute(sql`SELECT 1 FROM staff_users WHERE LOWER(email) = LOWER(${member.email}) AND role = 'golf_instructor' AND is_active = true`)).rows.length > 0) {
              const bookingDetails = await db.execute(sql`SELECT request_date, start_time, end_time, resource_id FROM booking_requests WHERE id = ${booking.id}`);
              if (bookingDetails.rows.length > 0) {
                const bd = bookingDetails.rows[0] as any;
                await db.execute(sql`INSERT INTO facility_closures (title, affected_areas, start_date, end_date, is_active, created_by)
                   VALUES (${`Lesson: ${member.first_name} ${member.last_name}`}, ${'simulators'}, ${bd.request_date}, ${bd.request_date}, true, ${staffEmail})
                   ON CONFLICT DO NOTHING
                   RETURNING id`);
                await db.execute(sql`INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
                   VALUES (${bd.resource_id}, ${bd.request_date}, ${bd.start_time}, ${bd.end_time}, ${'blocked'}, ${`Lesson: ${member.first_name} ${member.last_name} [Auto-resolved by ${staffEmail}]`}, ${staffEmail})
                   ON CONFLICT DO NOTHING`);
              }
              await db.execute(sql`DELETE FROM booking_requests WHERE id = ${booking.id}`);
            } else {
              await db.execute(sql`UPDATE booking_requests 
                 SET user_id = ${member.id}, 
                     user_email = ${member.email}, 
                     user_name = ${`${member.first_name} ${member.last_name}`},
                     is_unmatched = false,
                     staff_notes = COALESCE(staff_notes, '') || ${` [Auto-resolved via same email by ${staffEmail} on ${new Date().toISOString()}]`},
                     updated_at = NOW()
                 WHERE id = ${booking.id}`);
            }
            bookingRequestsResolved++;
          } catch (err: unknown) {
            console.error(`[Auto-resolve] Failed to resolve booking ${booking.id}:`, getErrorMessage(err));
          }
        }
        
        if (bookingRequestsResolved > 0) {
          console.log(`[Auto-resolve] Resolved ${bookingRequestsResolved} bookings from booking_requests for ${originalEmail}`);
        }
      }
    }
    
    // Also check legacy trackman_unmatched_bookings table
    const unmatchedResult = await db.execute(sql`SELECT id, trackman_booking_id, user_name, original_email, booking_date, 
              start_time, end_time, duration_minutes, bay_number, notes
       FROM trackman_unmatched_bookings 
       WHERE LOWER(TRIM(original_email)) = LOWER(TRIM(${originalEmail})) 
         AND resolved_at IS NULL
         AND (${excludeTrackmanId || null}::text IS NULL OR trackman_booking_id != ${excludeTrackmanId || null})`);
    
    if (unmatchedResult.rows.length === 0 && bookingRequestsResolved === 0) {
      return res.json({ success: true, autoResolved: 0, message: 'No additional bookings to auto-resolve' });
    }
    
    if (unmatchedResult.rows.length === 0) {
      return res.json({ success: true, autoResolved: bookingRequestsResolved, message: `Auto-resolved ${bookingRequestsResolved} booking(s)` });
    }
    
    let autoResolved = 0;
    const errors: string[] = [];
    
    for (const booking of unmatchedResult.rows as any[]) {
      try {
        let targetEmail = resolveToEmail;
        
        if (!targetEmail) {
          const emailMappingResult = await db.execute(sql`SELECT ule.primary_email as email FROM user_linked_emails ule
             WHERE LOWER(ule.linked_email) = LOWER(${originalEmail})
             LIMIT 1`);
          
          if (emailMappingResult.rows.length > 0) {
            targetEmail = (emailMappingResult.rows[0] as any).email;
          }
        }
        
        if (!targetEmail) continue;
        
        const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${targetEmail})`);
        
        if (memberResult.rows.length === 0) continue;
        
        const member = memberResult.rows[0] as any;
        let resourceId = 1;
        if (booking.bay_number) {
          const bayNum = parseInt(booking.bay_number.replace(/\D/g, ''));
          if (bayNum >= 1 && bayNum <= 4) resourceId = bayNum;
        }
        
        await db.execute(sql`INSERT INTO booking_requests (
            user_id, user_email, user_name, resource_id, request_date, start_time, end_time,
            duration_minutes, status, trackman_booking_id, is_unmatched, staff_notes, created_at, updated_at
          ) VALUES (${member.id}, ${member.email}, ${`${member.first_name} ${member.last_name}`}, ${resourceId}, ${booking.booking_date}, ${booking.start_time}, ${booking.end_time}, ${booking.duration_minutes || 60}, 'approved', ${booking.trackman_booking_id}, false, ${`[Auto-resolved from same email by ${staffEmail}] ${booking.notes || ''}`}, NOW(), NOW())
          ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL DO UPDATE SET
            user_id = EXCLUDED.user_id,
            user_email = EXCLUDED.user_email,
            user_name = EXCLUDED.user_name,
            is_unmatched = false,
            staff_notes = booking_requests.staff_notes || ' ' || EXCLUDED.staff_notes,
            updated_at = NOW()
          RETURNING id`);
        
        await db.execute(sql`UPDATE trackman_unmatched_bookings SET resolved_at = NOW(), resolved_email = ${member.email}, resolved_by = ${staffEmail} WHERE id = ${booking.id}`);
        
        autoResolved++;
      } catch (bookingErr: unknown) {
        errors.push(`Booking ${booking.id}: ${getErrorMessage(bookingErr)}`);
      }
    }
    
    const totalResolved = autoResolved + bookingRequestsResolved;
    
    if (totalResolved > 0) {
      await logFromRequest(req, {
        action: 'trackman_auto_resolve' as any,
        resourceType: 'booking',
        resourceName: `Auto-resolved ${totalResolved} bookings`,
        details: { originalEmail, autoResolved: totalResolved, legacyResolved: autoResolved, bookingRequestsResolved, errors: errors.length > 0 ? errors : undefined }
      });
    }
    
    res.json({ 
      success: true, 
      autoResolved: totalResolved,
      message: totalResolved > 0 
        ? `Auto-resolved ${totalResolved} additional booking(s) with same email`
        : 'No additional bookings to auto-resolve'
    });
  } catch (error: unknown) {
    console.error('Error auto-resolving bookings:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to auto-resolve bookings' });
  }
});

router.delete('/api/admin/trackman/linked-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail, linkedEmail } = req.body;
    
    if (!memberEmail || !linkedEmail) {
      return res.status(400).json({ error: 'memberEmail and linkedEmail are required' });
    }
    
    const result = await db.execute(sql`UPDATE users 
       SET manually_linked_emails = (
         SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
         FROM jsonb_array_elements_text(COALESCE(manually_linked_emails, '[]'::jsonb)) elem
         WHERE elem != ${linkedEmail}
       )
       WHERE LOWER(email) = LOWER(${memberEmail})
       RETURNING manually_linked_emails`);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    res.json({ 
      success: true, 
      manuallyLinkedEmails: (result.rows[0] as any).manually_linked_emails || []
    });
  } catch (error: unknown) {
    console.error('Remove linked email error:', error);
    res.status(500).json({ error: 'Failed to remove linked email' });
  }
});

router.get('/api/admin/trackman/matched', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim().toLowerCase();
    
    const matchedConditions: ReturnType<typeof sql>[] = [
      sql`(br.trackman_booking_id IS NOT NULL OR br.notes LIKE '%[Trackman Import ID:%')`,
      sql`br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')`,
      sql`(
        COALESCE(br.trackman_player_count, 1) = 1
        OR (
          br.session_id IS NOT NULL
          AND (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id) >= COALESCE(br.trackman_player_count, 1)
        )
      )`
    ];
    
    if (search) {
      const searchPattern = `%${search}%`;
      matchedConditions.push(sql`(LOWER(br.user_name) LIKE ${searchPattern} OR LOWER(br.user_email) LIKE ${searchPattern} OR LOWER(u.first_name || ' ' || u.last_name) LIKE ${searchPattern})`);
    }
    
    const matchedWhere = sql.join(matchedConditions, sql` AND `);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total FROM booking_requests br LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email) WHERE ${matchedWhere}`);
    const totalCount = parseInt((countResult.rows[0] as any).total, 10);
    
    const result = await db.execute(sql`SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.resource_id,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.status,
        br.notes,
        br.trackman_booking_id,
        br.trackman_player_count,
        br.created_at,
        br.session_id,
        u.first_name as member_first_name,
        u.last_name as member_last_name,
        u.email as member_email,
        COALESCE(br.trackman_player_count, 1) as total_slots,
        CASE 
          WHEN br.session_id IS NOT NULL THEN
            COALESCE((
              SELECT COUNT(*) FROM booking_participants bp 
              LEFT JOIN guests g ON g.id = bp.guest_id
              WHERE bp.session_id = br.session_id
                AND (bp.participant_type != 'guest' OR (bp.participant_type = 'guest' AND g.email IS NOT NULL AND g.email != ''))
            ), 0)
          ELSE
            CASE 
              WHEN br.user_email IS NOT NULL 
                   AND br.user_email NOT LIKE 'unmatched-%@%' 
                   AND br.user_email NOT LIKE '%unmatched@%'
              THEN 1
              ELSE 0
            END + COALESCE((SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NOT NULL AND bm.user_email != '' AND bm.is_primary = false), 0)
        END as filled_slots
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE ${matchedWhere}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    const data = result.rows.map((row: any) => {
      const totalSlots = parseInt(row.total_slots) || 1;
      const filledSlots = parseInt(row.filled_slots) || 0;
      return {
        id: row.id,
        userEmail: row.user_email,
        userName: row.user_name,
        resourceId: row.resource_id,
        requestDate: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        status: row.status,
        notes: row.notes,
        trackmanBookingId: row.trackman_booking_id,
        trackmanPlayerCount: row.trackman_player_count,
        createdAt: row.created_at,
        member: row.member_email ? {
          email: row.member_email,
          firstName: row.member_first_name,
          lastName: row.member_last_name,
          fullName: [row.member_first_name, row.member_last_name].filter(Boolean).join(' ')
        } : null,
        totalSlots,
        filledSlots,
        assignedCount: filledSlots,
        playerCount: totalSlots,
        isSolo: totalSlots === 1,
        isFullyResolved: totalSlots === 1 || filledSlots >= totalSlots,
        slotInfo: {
          totalSlots,
          filledSlots,
          isSolo: totalSlots === 1,
          isFullyResolved: totalSlots === 1 || filledSlots >= totalSlots
        }
      };
    });
    
    res.json({ data, totalCount });
  } catch (error: unknown) {
    console.error('Fetch matched bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch matched bookings' });
  }
});

router.put('/api/admin/trackman/matched/:id/reassign', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { newMemberEmail } = req.body;
    
    if (!newMemberEmail) {
      return res.status(400).json({ error: 'newMemberEmail is required' });
    }
    
    await client.query('BEGIN');
    
    // Get booking with session_id
    const bookingResult = await client.query(
      `SELECT user_email, notes, session_id FROM booking_requests WHERE id = $1`,
      [id]
    );
    
    if (bookingResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const oldEmail = (bookingResult.rows[0] as any).user_email;
    const notes = (bookingResult.rows[0] as any).notes || '';
    const sessionId = (bookingResult.rows[0] as any).session_id;
    
    // Get new member info
    const newMemberResult = await client.query(
      `SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
      [newMemberEmail]
    );
    
    if (newMemberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'New member not found' });
    }
    
    const newMember = newMemberResult.rows[0] as any;
    const newMemberName = `${newMember.first_name} ${newMember.last_name}`.trim();
    
    let placeholderEmail: string | null = null;
    const trackmanMatch = notes.match(/\[Trackman Import ID:[^\]]+\]\s*Original email:\s*([^\s\]]+)/i);
    if (trackmanMatch) {
      placeholderEmail = trackmanMatch[1].toLowerCase().trim();
    } else {
      const emailMatch = notes.match(/original\s*email[:\s]+([^\s,\]]+)/i);
      if (emailMatch) {
        placeholderEmail = emailMatch[1].toLowerCase().trim();
      }
    }
    
    // 1. Update booking_requests
    await client.query(
      `UPDATE booking_requests SET user_id = $1, user_email = $2, updated_at = NOW() WHERE id = $3`,
      [newMember.id, newMemberEmail.toLowerCase(), id]
    );
    
    // 2. CRITICAL FIX: Update booking_participants if session exists
    if (sessionId) {
      // Get the old owner's user_id to filter ledger entries
      const oldOwnerResult = await client.query(
        `SELECT user_id FROM booking_participants WHERE session_id = $1 AND participant_type = 'owner'`,
        [sessionId]
      );
      const oldOwnerId = (oldOwnerResult.rows[0] as any)?.user_id;
      
      await client.query(
        `UPDATE booking_participants 
         SET user_id = $1, display_name = $2
         WHERE session_id = $3 AND participant_type = 'owner'`,
        [newMember.id, newMemberName, sessionId]
      );
      
      // 3. CRITICAL FIX: Update usage_ledger - ONLY for the old owner's entries
      // Do NOT reassign guest entries or other member entries
      if (oldOwnerId) {
        await client.query(
          `UPDATE usage_ledger 
           SET member_id = $1
           WHERE session_id = $2 AND member_id = $3`,
          [newMember.id, sessionId, oldOwnerId]
        );
      } else {
        // Fallback: If no old owner found, update entries that aren't guests
        await client.query(
          `UPDATE usage_ledger 
           SET member_id = $1
           WHERE session_id = $2 AND member_id IS NOT NULL AND usage_type != 'guest'`,
          [newMember.id, sessionId]
        );
      }
    }
    
    // 4. CRITICAL FIX: Update booking_members (primary slot)
    await client.query(
      `UPDATE booking_members 
       SET user_email = $1
       WHERE booking_id = $2 AND is_primary = true`,
      [newMemberEmail.toLowerCase(), id]
    );
    
    // Handle placeholder email mapping
    if (placeholderEmail) {
      await client.query(
        `UPDATE users 
         SET manually_linked_emails = (
           SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
           FROM jsonb_array_elements_text(COALESCE(manually_linked_emails, '[]'::jsonb)) elem
           WHERE elem != $1
         )
         WHERE LOWER(email) = LOWER($2)`,
        [placeholderEmail, oldEmail]
      );
      
      await client.query(
        `UPDATE users 
         SET manually_linked_emails = COALESCE(manually_linked_emails, '[]'::jsonb) || to_jsonb($1::text)
         WHERE LOWER(email) = LOWER($2)
           AND NOT (COALESCE(manually_linked_emails, '[]'::jsonb) @> to_jsonb($1::text))`,
        [placeholderEmail, newMemberEmail]
      );
    }
    
    await client.query('COMMIT');
    
    logFromRequest(req, 'reassign_booking' as any, 'booking', id as string, newMemberEmail.toLowerCase(), {
      oldEmail,
      newEmail: newMemberEmail.toLowerCase(),
      placeholderEmail,
      sessionId,
      updatedParticipants: !!sessionId,
      updatedLedger: !!sessionId
    });
    
    res.json({ 
      success: true, 
      message: 'Booking reassigned completely (including billing records)',
      oldEmail,
      newEmail: newMemberEmail.toLowerCase(),
      placeholderEmail
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Reassign matched booking error:', error);
    res.status(500).json({ error: 'Failed to reassign booking' });
  } finally {
    client.release();
  }
});

router.post('/api/admin/trackman/unmatch-member', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    const unmatchedBy = (req as any).session?.user?.email || 'admin';
    
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    if (normalizedEmail.includes('unmatched@') || 
        normalizedEmail.includes('unmatched-') || 
        normalizedEmail.includes('@trackman.local') ||
        normalizedEmail.includes('anonymous@') ||
        normalizedEmail.includes('booking@everclub')) {
      return res.json({ 
        success: true, 
        affectedCount: 0,
        email: normalizedEmail,
        message: 'This booking is already unmatched'
      });
    }
    
    const bookingsResult = await db.execute(sql`SELECT id, notes, user_name 
       FROM booking_requests 
       WHERE LOWER(user_email) = ${normalizedEmail}
         AND (notes LIKE '%[Trackman Import ID:%' OR trackman_booking_id IS NOT NULL)
         AND status IN ('approved', 'pending', 'attended', 'no_show')`);
    
    if (bookingsResult.rowCount === 0) {
      return res.json({ 
        success: true, 
        affectedCount: 0,
        email: normalizedEmail,
        message: 'No bookings found to unmatch'
      });
    }
    
    let affectedCount = 0;
    for (const booking of bookingsResult.rows as any[]) {
      const notesMatch = booking.notes?.match(/\[Trackman Import ID:\d+\]\s*([^\[]+)/);
      const originalName = notesMatch ? notesMatch[1].trim() : booking.user_name || 'Unknown';
      
      const trackmanIdMatch = booking.notes?.match(/\[Trackman Import ID:(\d+)\]/);
      const trackmanId = trackmanIdMatch ? trackmanIdMatch[1] : booking.id;
      
      await db.execute(sql`UPDATE booking_requests 
         SET user_email = NULL,
             user_name = ${originalName},
             is_unmatched = true,
             staff_notes = COALESCE(staff_notes, '') || ${` [Unmatched from ${normalizedEmail} by ${unmatchedBy} on ${new Date().toISOString()}]`}
         WHERE id = ${booking.id}`);
      affectedCount++;
    }
    
    if (affectedCount > 0) {
      logFromRequest(req, 'unmatch_booking', 'booking', undefined, normalizedEmail, {
        email: normalizedEmail,
        affectedCount,
        unmatchedAt: new Date().toISOString()
      });
    }
    
    res.json({ 
      success: true, 
      affectedCount,
      email: normalizedEmail,
      message: affectedCount > 0 
        ? `Unmatched ${affectedCount} booking(s) for ${normalizedEmail}`
        : 'No bookings found to unmatch'
    });
  } catch (error: unknown) {
    console.error('Unmatch member error:', error);
    res.status(500).json({ error: 'Failed to unmatch member bookings' });
  }
});

router.get('/api/admin/booking/:id/members', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const bookingResult = await db.execute(sql`SELECT br.guest_count, br.trackman_player_count, br.declared_player_count, br.resource_id, br.user_email as owner_email,
              br.user_name as owner_name, br.duration_minutes, br.request_date, br.session_id, br.status,
              br.user_id as owner_user_id,
              br.notes, br.staff_notes, br.trackman_customer_notes,
              r.capacity as resource_capacity,
              r.type as resource_type,
              EXTRACT(EPOCH FROM (bs.end_time - bs.start_time)) / 60 as session_duration_minutes
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       LEFT JOIN booking_sessions bs ON br.session_id = bs.id
       WHERE br.id = ${id}`);
    
    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const legacyGuestCount = (bookingResult.rows[0] as any)?.guest_count || 0;
    const trackmanPlayerCount = (bookingResult.rows[0] as any)?.trackman_player_count;
    const declaredPlayerCount = (bookingResult.rows[0] as any)?.declared_player_count;
    const resourceCapacity = (bookingResult.rows[0] as any)?.resource_capacity || null;
    const ownerEmail = (bookingResult.rows[0] as any)?.owner_email;
    const ownerName = (bookingResult.rows[0] as any)?.owner_name;
    const sessionId = (bookingResult.rows[0] as any)?.session_id || null;
    const ownerUserId = (bookingResult.rows[0] as any)?.owner_user_id || null;
    let resolvedOwnerUserId = ownerUserId;
    if (!resolvedOwnerUserId && ownerEmail && !ownerEmail.includes('unmatched') && !ownerEmail.includes('@trackman.import')) {
      const userLookup = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${ownerEmail}) LIMIT 1`);
      if (userLookup.rows.length > 0) {
        resolvedOwnerUserId = (userLookup.rows[0] as any).id;
      }
    }
    const sessionDurationMinutes = (bookingResult.rows[0] as any)?.session_duration_minutes;
    const bookingDuration = (bookingResult.rows[0] as any)?.duration_minutes || 60;
    const durationMinutes = Math.max(bookingDuration, sessionDurationMinutes || 0);
    const requestDate = (bookingResult.rows[0] as any)?.request_date;
    const bookingStatus = (bookingResult.rows[0] as any)?.status;
    
    let ownerTier: string | null = null;
    let ownerTierLimits: Awaited<ReturnType<typeof getTierLimits>> | null = null;
    let ownerGuestPassesRemaining = 0;
    
    if (ownerEmail && !ownerEmail.includes('unmatched')) {
      ownerTier = await getMemberTierByEmail(ownerEmail);
      if (ownerTier) {
        ownerTierLimits = await getTierLimits(ownerTier);
      }
      ownerGuestPassesRemaining = await getGuestPassesRemaining(ownerEmail, ownerTier || undefined);
    }
    
    let membersResult = await db.execute(sql`SELECT bm.*, u.first_name, u.last_name, u.email as member_email, u.tier as user_tier, u.membership_status
       FROM booking_members bm
       LEFT JOIN users u ON LOWER(bm.user_email) = LOWER(u.email)
       WHERE bm.booking_id = ${id}
       ORDER BY bm.slot_number`);
    
    const targetPlayerCount = declaredPlayerCount || trackmanPlayerCount || 1;
    const isUnmatchedOwner = !ownerEmail || ownerEmail.includes('unmatched@') || ownerEmail.includes('@trackman.import');
    
    // Always ensure we have slots for ALL declared players (not just when zero exist)
    if (membersResult.rows.length < targetPlayerCount && targetPlayerCount > 0) {
      const existingSlotNumbers = new Set(membersResult.rows.map((r: any) => r.slot_number));
      
      for (let i = 1; i <= targetPlayerCount; i++) {
        if (!existingSlotNumbers.has(i)) {
          const isPrimary = i === 1;
          const userEmail = (i === 1 && !isUnmatchedOwner) ? ownerEmail : null;
          await db.execute(sql`INSERT INTO booking_members (booking_id, slot_number, is_primary, user_email, created_at)
             VALUES (${id}, ${i}, ${isPrimary}, ${userEmail}, NOW())
             ON CONFLICT (booking_id, slot_number) DO NOTHING`);
        }
      }
      
      membersResult = await db.execute(sql`SELECT bm.*, u.first_name, u.last_name, u.email as member_email, u.tier as user_tier, u.membership_status
         FROM booking_members bm
         LEFT JOIN users u ON LOWER(bm.user_email) = LOWER(u.email)
         WHERE bm.booking_id = ${id}
         ORDER BY bm.slot_number`);
    }
    
    const guestsResult = await db.execute(sql`SELECT * FROM booking_guests WHERE booking_id = ${id} ORDER BY slot_number`);
    
    const bookingData = bookingResult.rows[0] as any;
    let participantsCount = 0;
    if (bookingData.session_id) {
      const participantsResult = await db.execute(sql`SELECT COUNT(*) as count FROM booking_participants WHERE session_id = ${bookingData.session_id}`);
      participantsCount = parseInt((participantsResult.rows[0] as any)?.count) || 0;
    }
    
    const totalMemberSlots = membersResult.rows.length;
    const actualGuestCount = guestsResult.rows.length;
    
    let expectedPlayerCount: number;
    if (declaredPlayerCount && declaredPlayerCount > 0) {
      expectedPlayerCount = declaredPlayerCount;
    } else if (trackmanPlayerCount && trackmanPlayerCount > 0) {
      expectedPlayerCount = trackmanPlayerCount;
    } else if (totalMemberSlots > 0) {
      expectedPlayerCount = totalMemberSlots + actualGuestCount;
    } else if (participantsCount > 0) {
      expectedPlayerCount = participantsCount + actualGuestCount;
    } else {
      expectedPlayerCount = Math.max(legacyGuestCount + 1, 1);
    }
    
    if (resourceCapacity && resourceCapacity > 0) {
      expectedPlayerCount = Math.min(expectedPlayerCount, resourceCapacity);
    }
    
    const effectiveGuestCount = actualGuestCount > 0 ? actualGuestCount : legacyGuestCount;
    
    const filledMemberSlots = membersResult.rows.filter((row: any) => row.user_email).length;
    const actualPlayerCount = filledMemberSlots + effectiveGuestCount;
    
    const playerCountMismatch = actualPlayerCount !== expectedPlayerCount;
    
    const perPersonMins = Math.floor(durationMinutes / expectedPlayerCount);
    
    const bookingId = parseInt(id as string);
    
    const staffEmailsResult = await db.execute(sql`SELECT LOWER(email) as email FROM staff_users WHERE is_active = true`);
    const staffEmailSet = new Set(staffEmailsResult.rows.map((r: any) => r.email));
    
    const participantsArray: Array<{
      userId?: string;
      email?: string;
      displayName: string;
      participantType: 'owner' | 'member' | 'guest';
    }> = [];
    for (const row of membersResult.rows as any[]) {
      if (row.user_email) {
        participantsArray.push({
          userId: row.user_email,
          email: row.user_email,
          displayName: row.first_name && row.last_name
            ? `${row.first_name} ${row.last_name}`
            : row.user_email,
          participantType: row.is_primary ? 'owner' : 'member'
        });
      }
    }
    for (const row of guestsResult.rows as any[]) {
      participantsArray.push({
        email: row.guest_email || undefined,
        displayName: row.guest_name || 'Guest',
        participantType: 'guest'
      });
    }
    if (participantsArray.length === 0 && ownerEmail) {
      participantsArray.push({
        userId: ownerEmail,
        email: ownerEmail,
        displayName: ownerName || ownerEmail,
        participantType: 'owner'
      });
    }

    const feeBreakdownResult = await computeFeeBreakdown(
      sessionId
        ? { sessionId, bookingId, declaredPlayerCount: expectedPlayerCount, source: 'preview', isConferenceRoom: bookingData.resource_type === 'conference_room', excludeSessionFromUsage: true }
        : {
            sessionDate: requestDate,
            startTime: bookingData.start_time,
            sessionDuration: durationMinutes,
            declaredPlayerCount: expectedPlayerCount,
            hostEmail: ownerEmail || '',
            participants: participantsArray,
            source: 'preview',
            isConferenceRoom: bookingData.resource_type === 'conference_room',
            bookingId
          }
    );

    const ownerLineItems = feeBreakdownResult.participants.filter(li => li.participantType === 'owner');
    const memberLineItems = feeBreakdownResult.participants.filter(li => li.participantType === 'member');
    const guestLineItems = feeBreakdownResult.participants.filter(li => li.participantType === 'guest');

    const lineItemEmailMap = new Map<string, typeof feeBreakdownResult.participants[0]>();
    if (sessionId) {
      const userIds = feeBreakdownResult.participants
        .filter(li => li.userId && li.participantType !== 'guest')
        .map(li => li.userId!);
      if (userIds.length > 0) {
        const emailLookup = await pool.query(
          `SELECT id, LOWER(email) as email FROM users WHERE id = ANY($1::text[])`,
          [userIds]
        );
        for (const r of emailLookup.rows as any[]) {
          const li = feeBreakdownResult.participants.find(p => p.userId === r.id);
          if (li) lineItemEmailMap.set(r.email, li);
        }
      }
    } else {
      for (const li of feeBreakdownResult.participants) {
        if (li.userId) lineItemEmailMap.set(li.userId.toLowerCase(), li);
      }
    }

    function findLineItemForMember(row: any): typeof feeBreakdownResult.participants[0] | undefined {
      const email = (row.user_email || '').toLowerCase();
      if (!email) return undefined;
      const mapped = lineItemEmailMap.get(email);
      if (mapped) return mapped;
      if (row.is_primary && ownerLineItems.length > 0) return ownerLineItems[0];
      return undefined;
    }

    function generateFeeNote(lineItem: typeof feeBreakdownResult.participants[0], membershipStatus: string | null, isPrimary: boolean): string {
      const fee = lineItem.totalCents / 100;
      const hasActiveMembership = membershipStatus && ['active', 'trialing', 'past_due'].includes(membershipStatus);

      if (lineItem.isStaff) return 'Staff — included';

      if (!hasActiveMembership) {
        const statusLabel = membershipStatus || 'non-member';
        return isPrimary
          ? `${statusLabel} — $${fee} (no membership benefits)`
          : `${statusLabel} — $${fee} charged to host`;
      }

      const dailyAllowance = lineItem.dailyAllowance || 0;
      const isUnlimited = dailyAllowance >= 999;
      const isSocialTier = lineItem.tierName?.toLowerCase() === 'social';

      if (isUnlimited) return 'Included in membership';
      if (isSocialTier) return fee > 0 ? `Social tier - $${fee} (${lineItem.minutesAllocated} min)` : 'Included';
      if (lineItem.tierName) {
        if (dailyAllowance > 0) return fee > 0 ? `${lineItem.tierName} - $${fee} (overage)` : 'Included in membership';
        return `Pay-as-you-go - $${fee}`;
      }
      return `No tier assigned — $${fee}`;
    }

    const membersWithFees = membersResult.rows.map((row: any) => {
      const membershipStatus = row.membership_status || null;
      const hasActiveMembership = membershipStatus && ['active', 'trialing', 'past_due'].includes(membershipStatus);
      const isStaffUser = row.user_email ? staffEmailSet.has(row.user_email.toLowerCase()) : false;

      let tier: string | null = null;
      let fee = 0;
      let feeNote = '';
      let feeBreakdownObj: {
        perPersonMins: number;
        dailyAllowance: number;
        usedToday: number;
        overageMinutes: number;
        fee: number;
        isUnlimited: boolean;
        isSocialTier: boolean;
      } | null = null;

      if (row.user_email) {
        const lineItem = findLineItemForMember(row);
        if (lineItem) {
          fee = lineItem.totalCents / 100;
          tier = lineItem.isStaff ? 'Staff' : (lineItem.tierName || null);
          feeNote = generateFeeNote(lineItem, membershipStatus, row.is_primary);
          const dailyAllowance = lineItem.dailyAllowance || 0;
          const overageMinutes = lineItem.overageCents > 0
            ? Math.ceil((lineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES
            : 0;
          feeBreakdownObj = {
            perPersonMins: lineItem.minutesAllocated,
            dailyAllowance,
            usedToday: lineItem.usedMinutesToday || 0,
            overageMinutes,
            fee,
            isUnlimited: lineItem.isStaff ? true : dailyAllowance >= 999,
            isSocialTier: lineItem.tierName?.toLowerCase() === 'social'
          };
        } else {
          fee = PRICING.GUEST_FEE_DOLLARS;
          feeNote = `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`;
        }
      } else {
        fee = PRICING.GUEST_FEE_DOLLARS;
        feeNote = `Pending assignment - $${PRICING.GUEST_FEE_DOLLARS}`;
      }

      const isInactiveMember = !hasActiveMembership && !!row.user_email && !row.is_primary && !isStaffUser;

      return {
        id: row.id,
        bookingId: row.booking_id,
        userEmail: row.user_email,
        slotNumber: row.slot_number,
        isPrimary: row.is_primary,
        linkedAt: row.linked_at,
        linkedBy: row.linked_by,
        memberName: row.first_name && row.last_name
          ? `${row.first_name} ${row.last_name}`
          : row.user_email || 'Empty Slot',
        tier,
        fee,
        feeNote,
        feeBreakdown: feeBreakdownObj,
        membershipStatus,
        isInactiveMember: !!isInactiveMember,
        isStaff: isStaffUser,
        guestInfo: null as any
      };
    });

    let guestPassesUsedThisBooking = feeBreakdownResult.totals.guestPassesUsed;
    let guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
    const guestsWithFees = guestsResult.rows.map((row: any, idx: number) => {
      const lineItem = guestLineItems[idx];
      let fee: number;
      let feeNote: string;
      let usedGuestPass = false;

      if (lineItem) {
        if (lineItem.guestPassUsed) {
          fee = 0;
          feeNote = 'Guest Pass Used';
          usedGuestPass = true;
        } else {
          fee = lineItem.guestCents / 100;
          feeNote = fee > 0 ? `No passes - $${fee} due` : 'No charge';
        }
      } else {
        fee = PRICING.GUEST_FEE_DOLLARS;
        feeNote = `No passes - $${PRICING.GUEST_FEE_DOLLARS} due`;
      }

      return {
        id: row.id,
        bookingId: row.booking_id,
        guestName: row.guest_name,
        guestEmail: row.guest_email,
        slotNumber: row.slot_number,
        fee,
        feeNote,
        usedGuestPass
      };
    });
    
    const guestsToRemove: number[] = [];
    for (let i = 0; i < guestsWithFees.length; i++) {
      const guest = guestsWithFees[i];
      // Try to match by slot number first, then fall back to first available empty slot
      const emptySlot = (guest.slotNumber 
        ? membersWithFees.find(m => !m.userEmail && !m.guestInfo && m.slotNumber === guest.slotNumber)
        : null) || membersWithFees.find(m => !m.userEmail && !m.guestInfo);
      if (emptySlot) {
        emptySlot.guestInfo = {
          guestId: guest.id,
          guestName: guest.guestName,
          guestEmail: guest.guestEmail,
          fee: guest.fee,
          feeNote: guest.feeNote,
          usedGuestPass: guest.usedGuestPass
        };
        emptySlot.memberName = guest.guestName;
        emptySlot.fee = guest.fee;
        emptySlot.feeNote = guest.feeNote;
        guestsToRemove.push(i);
      }
    }
    for (let i = guestsToRemove.length - 1; i >= 0; i--) {
      guestsWithFees.splice(guestsToRemove[i], 1);
    }
    
    const dailyAllowance = ownerTierLimits?.daily_sim_minutes || 0;
    const isUnlimitedTier = dailyAllowance >= 999 || (ownerTierLimits?.unlimited_access ?? false);
    const allowanceText = isUnlimitedTier 
      ? 'Unlimited simulator access' 
      : dailyAllowance > 0 
        ? `${dailyAllowance} minutes/day included`
        : 'Pay-as-you-go';
    
    let ownerOverageFee = 0;
    let guestFeesWithoutPass = 0;
    let totalPlayersOwe = 0;
    let playerBreakdownFromSession: Array<{ name: string; tier: string | null; fee: number; feeNote: string; membershipStatus?: string | null }> = [];
    
    let hasCompletedFeeSnapshot = false;
    let snapshotTotalCents = 0;
    if (sessionId) {
      const snapshotCheck = await db.execute(sql`SELECT id, total_cents FROM booking_fee_snapshots WHERE session_id = ${sessionId} AND status = 'completed' ORDER BY created_at DESC LIMIT 1`);
      if (snapshotCheck.rows.length > 0) {
        hasCompletedFeeSnapshot = true;
        snapshotTotalCents = parseInt((snapshotCheck.rows[0] as any).total_cents) || 0;
      }
    }

    const feeEligibleMembers = membersWithFees.filter(m => m.slotNumber <= expectedPlayerCount);
    
    if (sessionId) {
      const participantsResult = await db.execute(sql`SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.user_id,
          bp.used_guest_pass,
          bp.payment_status,
          bp.cached_fee_cents,
          u.tier as user_tier,
          u.email as user_email,
          u.membership_status
        FROM booking_participants bp
        LEFT JOIN users u ON u.id = bp.user_id
        WHERE bp.session_id = ${sessionId}
        ORDER BY bp.participant_type, bp.created_at`);
      
      if (participantsResult.rows.length > 0) {
        const allParticipantIds = participantsResult.rows.map((p: any) => p.participant_id);
        // Use recalculateSessionFees to sync fees to booking_requests.overage_fee_cents
        const breakdown = await recalculateSessionFees(sessionId, 'trackman' as any);
        
        const feeMap = new Map<number, number>();
        const staffFlagMap = new Map<number, boolean>();
        for (const p of breakdown.participants) {
          if (p.participantId) {
            feeMap.set(p.participantId, p.totalCents / 100);
            if (p.isStaff) staffFlagMap.set(p.participantId, true);
          }
        }
        
        const emailToFeeMap = new Map<string, { fee: number; feeNote: string; isPaid?: boolean; isStaff?: boolean }>();
        
        for (const p of participantsResult.rows as any[]) {
          const participantFee = feeMap.get(p.participant_id) || 0;
          const email = p.user_email?.toLowerCase();
          const isPaid = p.payment_status === 'paid';
          const participantIsStaff = staffFlagMap.get(p.participant_id) || false;
          
          if (p.participant_type === 'owner') {
            const ownerStatus = p.membership_status || null;
            const ownerIsInactive = ownerStatus && !['active', 'trialing', 'past_due'].includes(ownerStatus);
            ownerOverageFee = ((isPaid && !hasCompletedFeeSnapshot) || participantIsStaff) ? 0 : participantFee;
            if (email) {
              const ownerNote = participantIsStaff ? 'Staff — included'
                : ownerIsInactive ? `${ownerStatus} — $${participantFee} (no membership benefits)`
                : (isPaid ? 'Paid' : (participantFee > 0 ? 'Overage fee' : 'Within daily allowance'));
              emailToFeeMap.set(email, {
                fee: participantIsStaff ? 0 : participantFee,
                feeNote: ownerNote,
                isPaid,
                isStaff: participantIsStaff
              });
            }
          } else if (p.participant_type === 'member') {
            const memberStatus = p.membership_status || null;
            const isInactive = !memberStatus || !['active', 'trialing', 'past_due'].includes(memberStatus);
            
            if (isInactive && !isPaid && !participantIsStaff && participantFee > 0) {
              ownerOverageFee += participantFee;
            } else if (!isPaid && !participantIsStaff) {
              totalPlayersOwe += participantFee;
            }
            playerBreakdownFromSession.push({
              name: p.display_name || 'Unknown Member',
              tier: participantIsStaff ? 'Staff' : (p.user_tier || null),
              fee: (isPaid || participantIsStaff || isInactive) ? 0 : participantFee,
              feeNote: isInactive ? `${memberStatus} — $${participantFee} charged to host` : (participantIsStaff ? 'Staff — included' : (isPaid ? 'Paid' : (participantFee > 0 ? 'Overage fee' : 'Within allowance'))),
              membershipStatus: memberStatus
            });
            if (email) {
              emailToFeeMap.set(email, {
                fee: (isInactive || participantIsStaff) ? 0 : participantFee,
                feeNote: isInactive ? `${memberStatus} — $${participantFee} charged to host` : (participantIsStaff ? 'Staff — included' : (isPaid ? 'Paid' : (participantFee > 0 ? 'Overage fee' : 'Within daily allowance'))),
                isPaid,
                isStaff: participantIsStaff
              });
            }
          } else if (p.participant_type === 'guest') {
            if (!p.user_id && !p.used_guest_pass && participantFee > 0 && !isPaid && !participantIsStaff) {
              guestFeesWithoutPass += participantFee;
            }
          }
        }
        
        for (const member of membersWithFees) {
          if (member.userEmail) {
            const sessionFeeData = emailToFeeMap.get(member.userEmail.toLowerCase());
            if (sessionFeeData) {
              member.fee = sessionFeeData.fee;
              member.feeNote = sessionFeeData.feeNote;
            }
          }
        }
        
        const guestParticipants: any[] = participantsResult.rows.filter((p: any) => p.participant_type === 'guest');
        for (let i = 0; i < guestsWithFees.length && i < guestParticipants.length; i++) {
          const gp = guestParticipants[i];
          const participantFee = feeMap.get(gp.participant_id) || 0;
          guestsWithFees[i].fee = participantFee;
          guestsWithFees[i].usedGuestPass = gp.used_guest_pass || false;
          guestsWithFees[i].feeNote = gp.used_guest_pass ? 'Guest Pass Used' : (participantFee > 0 ? `No passes - $${PRICING.GUEST_FEE_DOLLARS} due` : 'No charge');
        }
        
        const guestParticipantsByGuestId = new Map<number, typeof guestParticipants[0]>();
        for (const gp of guestParticipants) {
          if (gp.guest_id) guestParticipantsByGuestId.set(gp.guest_id, gp);
        }
        for (const member of membersWithFees) {
          if (member.guestInfo) {
            const gp = guestParticipantsByGuestId.get(member.guestInfo.guestId);
            if (gp) {
              const participantFee = feeMap.get(gp.participant_id) || 0;
              const passUsed = gp.used_guest_pass || false;
              const note = passUsed ? 'Guest Pass Used' : (participantFee > 0 ? `No passes - $${PRICING.GUEST_FEE_DOLLARS} due` : 'No charge');
              member.guestInfo.fee = participantFee;
              member.guestInfo.usedGuestPass = passUsed;
              member.guestInfo.feeNote = note;
              member.fee = participantFee;
              member.feeNote = note;
            }
          }
        }
        
        guestPassesUsedThisBooking = guestParticipants.filter(gp => gp.used_guest_pass).length;
        guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
        
        const emptyMemberSlots = feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo);
        const guestParticipantCount = participantsResult.rows.filter((p: any) => p.participant_type === 'guest').length;
        const unaccountedEmptySlots = Math.max(0, emptyMemberSlots.length - guestParticipantCount);
        const emptySlotFees = unaccountedEmptySlots * PRICING.GUEST_FEE_DOLLARS;
        guestFeesWithoutPass += emptySlotFees;
      } else {
        const ownerMember = feeEligibleMembers.find(m => m.isPrimary);
        const nonOwnerMembers = feeEligibleMembers.filter(m => !m.isPrimary && m.userEmail);
        const emptySlots = feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo);
        const emptySlotFees = emptySlots.length * PRICING.GUEST_FEE_DOLLARS;
        guestFeesWithoutPass = guestsWithFees.filter(g => !g.usedGuestPass).reduce((sum, g) => sum + g.fee, 0) + emptySlotFees;
        ownerOverageFee = ownerMember?.fee || 0;
        
        const activeNonOwners = nonOwnerMembers.filter(m => !m.isInactiveMember);
        const inactiveNonOwners = nonOwnerMembers.filter(m => m.isInactiveMember);
        const inactiveFeeTotal = inactiveNonOwners.reduce((sum, m) => sum + m.fee, 0);
        ownerOverageFee += inactiveFeeTotal;
        
        totalPlayersOwe = activeNonOwners.reduce((sum, m) => sum + m.fee, 0);
        playerBreakdownFromSession = nonOwnerMembers.map(m => ({
          name: m.memberName,
          tier: m.tier,
          fee: m.isInactiveMember ? 0 : m.fee,
          feeNote: m.isInactiveMember ? `${m.membershipStatus} — $${m.fee} charged to host` : m.feeNote,
          membershipStatus: m.membershipStatus
        }));
      }
    } else {
      const ownerMember = feeEligibleMembers.find(m => m.isPrimary);
      const nonOwnerMembers = feeEligibleMembers.filter(m => !m.isPrimary && m.userEmail);
      const emptySlots = feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo);
      const emptySlotFees = emptySlots.length * PRICING.GUEST_FEE_DOLLARS;
      guestFeesWithoutPass = guestsWithFees.filter(g => !g.usedGuestPass).reduce((sum, g) => sum + g.fee, 0) + emptySlotFees;
      ownerOverageFee = ownerMember?.fee || 0;
      
      const activeNonOwners = nonOwnerMembers.filter(m => !m.isInactiveMember);
      const inactiveNonOwners = nonOwnerMembers.filter(m => m.isInactiveMember);
      const inactiveFeeTotal = inactiveNonOwners.reduce((sum, m) => sum + m.fee, 0);
      ownerOverageFee += inactiveFeeTotal;
      
      totalPlayersOwe = activeNonOwners.reduce((sum, m) => sum + m.fee, 0);
      playerBreakdownFromSession = nonOwnerMembers.map(m => ({
        name: m.memberName,
        tier: m.tier,
        fee: m.isInactiveMember ? 0 : m.fee,
        feeNote: m.isInactiveMember ? `${m.membershipStatus} — $${m.fee} charged to host` : m.feeNote,
        membershipStatus: m.membershipStatus
      }));
    }
    
    guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
    let grandTotal = ownerOverageFee + guestFeesWithoutPass + totalPlayersOwe;
    
    let hasPaidFees = false;
    let hasOriginalFees = false;
    let pendingFeeCount = 0;
    if (sessionId) {
      const paidCheck = await db.execute(sql`SELECT 
          COUNT(*) FILTER (WHERE payment_status = 'paid' AND cached_fee_cents > 0) as paid_count,
          COUNT(*) FILTER (WHERE cached_fee_cents > 0 OR payment_status = 'paid') as total_with_fees,
          COUNT(*) FILTER (WHERE payment_status = 'pending' AND cached_fee_cents > 0) as pending_count
        FROM booking_participants 
        WHERE session_id = ${sessionId}`);
      hasPaidFees = parseInt((paidCheck.rows[0] as any)?.paid_count || '0') > 0;
      hasOriginalFees = parseInt((paidCheck.rows[0] as any)?.total_with_fees || '0') > 0;
      pendingFeeCount = parseInt((paidCheck.rows[0] as any)?.pending_count || '0');
    }
    
    if (hasCompletedFeeSnapshot && snapshotTotalCents > 0 && pendingFeeCount === 0) {
      grandTotal = Math.max(grandTotal, snapshotTotalCents / 100);
    }
    
    const allPaid = (hasCompletedFeeSnapshot && pendingFeeCount === 0) || (hasOriginalFees && grandTotal === 0 && hasPaidFees);
    
    const isOwnerStaff = ownerEmail ? staffEmailSet.has(ownerEmail.toLowerCase()) : false;
    
    res.json({
      sessionId,
      ownerId: resolvedOwnerUserId,
      isOwnerStaff,
      ownerGuestPassesRemaining,
      bookingNotes: {
        notes: (bookingResult.rows[0] as any)?.notes || null,
        staffNotes: (bookingResult.rows[0] as any)?.staff_notes || null,
        trackmanNotes: (bookingResult.rows[0] as any)?.trackman_customer_notes || null,
      },
      bookingInfo: {
        durationMinutes,
        perPersonMins,
        expectedPlayerCount
      },
      members: membersWithFees,
      guests: guestsWithFees,
      validation: {
        expectedPlayerCount,
        actualPlayerCount,
        totalMemberSlots,
        filledMemberSlots,
        guestCount: effectiveGuestCount,
        playerCountMismatch,
        emptySlots: feeEligibleMembers.filter(m => !m.userEmail && !m.guestInfo).length
      },
      tierLimits: ownerTierLimits ? {
        can_book_simulators: ownerTierLimits.can_book_simulators,
        daily_sim_minutes: ownerTierLimits.daily_sim_minutes,
        guest_passes_per_month: ownerTierLimits.guest_passes_per_month,
        unlimited_access: ownerTierLimits.unlimited_access
      } : null,
      tierContext: {
        ownerTier,
        allowanceText,
        isUnlimitedTier
      },
      guestPassContext: {
        passesBeforeBooking: ownerGuestPassesRemaining,
        passesUsedThisBooking: guestPassesUsedThisBooking,
        passesRemainingAfterBooking: guestPassesRemainingAfterBooking,
        guestsWithoutPasses: guestsWithFees.filter(g => !g.usedGuestPass).length
      },
      financialSummary: {
        ownerOverageFee,
        guestFeesWithoutPass,
        totalOwnerOwes: grandTotal,
        totalPlayersOwe,
        grandTotal,
        playerBreakdown: playerBreakdownFromSession,
        allPaid
      }
    });
  } catch (error: unknown) {
    console.error('Get booking members error:', error);
    res.status(500).json({ error: 'Failed to get booking members' });
  }
});

router.post('/api/admin/booking/:id/guests', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    const { guestName, guestEmail, guestPhone, slotId, forceAddAsGuest } = req.body;
    
    if (!guestName?.trim()) {
      return res.status(400).json({ error: 'Guest name is required' });
    }
    
    if (guestEmail && !forceAddAsGuest) {
      const memberMatch = await db.execute(sql`SELECT id, email, first_name, last_name, tier FROM users WHERE LOWER(email) = LOWER(${guestEmail.trim()})`);
      if (memberMatch.rowCount && memberMatch.rowCount > 0) {
        const member = memberMatch.rows[0] as any;
        return res.status(409).json({
          error: 'Email belongs to an existing member',
          memberMatch: {
            id: member.id,
            email: member.email,
            name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
            tier: member.tier
          }
        });
      }
    }
    
    const bookingResult = await db.execute(sql`SELECT b.*, u.id as owner_id FROM bookings b 
       LEFT JOIN users u ON LOWER(u.email) = LOWER(b.user_email) 
       WHERE b.id = ${bookingId}`);
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const existingGuests = await db.execute(sql`SELECT MAX(slot_number) as max_slot FROM booking_guests WHERE booking_id = ${bookingId}`);
    const nextSlotNumber = ((existingGuests.rows[0] as any)?.max_slot || 0) + 1;
    
    const insertResult = await db.execute(sql`INSERT INTO booking_guests (booking_id, guest_name, guest_email, guest_phone, slot_number, created_at)
       VALUES (${bookingId}, ${guestName.trim()}, ${guestEmail?.trim() || null}, ${guestPhone?.trim() || null}, ${nextSlotNumber}, NOW())
       RETURNING *`);
    
    if (slotId) {
      await db.execute(sql`DELETE FROM booking_members WHERE id = ${slotId} AND booking_id = ${bookingId}`);
    }
    
    const ownerEmail = (bookingResult.rows[0] as any).user_email;
    let guestPassesRemaining = 0;
    if (ownerEmail) {
      const passesResult = await db.execute(sql`SELECT guest_passes_remaining FROM users WHERE LOWER(email) = LOWER(${ownerEmail})`);
      if (passesResult.rowCount && passesResult.rowCount > 0) {
        guestPassesRemaining = (passesResult.rows[0] as any).guest_passes_remaining || 0;
      }
    }
    
    res.json({
      success: true,
      guest: insertResult.rows[0],
      guestPassesRemaining
    });
  } catch (error: unknown) {
    console.error('Add guest error:', error);
    res.status(500).json({ error: 'Failed to add guest' });
  }
});

router.delete('/api/admin/booking/:id/guests/:guestId', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    const guestId = parseInt(req.params.guestId as string);
    const staffEmail = (req as any).session?.user?.email || 'admin';

    const bookingResult = await db.execute(sql`SELECT br.id, br.session_id, br.guest_count, br.user_email as owner_email
       FROM booking_requests br
       WHERE br.id = ${bookingId}`);

    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as any;
    const sessionId = booking.session_id;

    let guestDisplayName = 'Unknown guest';
    let guestFound = false;

    const guestBookingResult = await db.execute(sql`SELECT id, guest_name, guest_email FROM booking_guests WHERE id = ${guestId} AND booking_id = ${bookingId}`);

    if (guestBookingResult.rowCount && guestBookingResult.rowCount > 0) {
      guestFound = true;
      const guestRecord = guestBookingResult.rows[0] as any;
      guestDisplayName = guestRecord.guest_name || guestDisplayName;

      await db.execute(sql`DELETE FROM booking_guests WHERE id = ${guestId}`);

      if (sessionId) {
        const participantResult = await db.execute(sql`SELECT id, used_guest_pass FROM booking_participants 
           WHERE session_id = ${sessionId} AND participant_type = 'guest' AND display_name = ${guestDisplayName}`);

        if (participantResult.rowCount && participantResult.rowCount > 0) {
          const participant = participantResult.rows[0] as any;
          if (participant.used_guest_pass === true && booking.owner_email) {
            try {
              await refundGuestPassForParticipant(participant.id, booking.owner_email, guestDisplayName);
              console.log(`[RemoveGuest] Guest pass refunded for ${guestDisplayName}`);
            } catch (err) {
              console.error('[RemoveGuest] Failed to refund guest pass:', err);
            }
          }
          await db.execute(sql`DELETE FROM booking_participants WHERE id = ${participant.id}`);
        }
      }
    } else if (sessionId) {
      const participantResult = await db.execute(sql`SELECT id, display_name, used_guest_pass FROM booking_participants WHERE id = ${guestId} AND session_id = ${sessionId} AND participant_type = 'guest'`);

      if (participantResult.rowCount && participantResult.rowCount > 0) {
        guestFound = true;
        const participant = participantResult.rows[0] as any;
        guestDisplayName = participant.display_name || guestDisplayName;
        if (participant.used_guest_pass === true && booking.owner_email) {
          try {
            await refundGuestPassForParticipant(participant.id, booking.owner_email, guestDisplayName);
            console.log(`[RemoveGuest] Guest pass refunded for ${guestDisplayName}`);
          } catch (err) {
            console.error('[RemoveGuest] Failed to refund guest pass:', err);
          }
        }
        await db.execute(sql`DELETE FROM booking_participants WHERE id = ${guestId}`);
      }
    }

    if (!guestFound) {
      return res.status(404).json({ error: 'Guest not found in booking_guests or booking_participants' });
    }

    if (booking.guest_count && booking.guest_count > 0) {
      await db.execute(sql`UPDATE booking_requests SET guest_count = GREATEST(0, guest_count - 1), updated_at = NOW() WHERE id = ${bookingId}`);
    }

    // Step 4: Recalculate fees for the session
    if (sessionId) {
      await recalculateSessionFees(sessionId, 'roster_update');
    }

    await logFromRequest(req, {
      action: 'update' as any,
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Remove guest ${guestDisplayName}`,
      details: { guestId, guestDisplayName, staffEmail }
    });

    res.json({
      success: true,
      message: `Guest ${guestDisplayName} removed successfully`
    });
  } catch (error: unknown) {
    console.error('Remove guest error:', error);
    res.status(500).json({ error: 'Failed to remove guest' });
  }
});

router.put('/api/admin/booking/:bookingId/members/:slotId/link', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    const { memberEmail } = req.body;
    const linkedBy = (req as any).session?.user?.email || 'admin';
    
    if (!memberEmail) {
      return res.status(400).json({ error: 'memberEmail is required' });
    }
    
    const slotResult = await db.execute(sql`SELECT * FROM booking_members WHERE id = ${slotId} AND booking_id = ${bookingId}`);
    
    if (slotResult.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    
    const slot = slotResult.rows[0] as any;
    if (slot.user_email) {
      if (slot.user_email.toLowerCase() === memberEmail.toLowerCase()) {
        return res.json({ success: true, message: 'Member already linked to this slot' });
      }
      return res.status(400).json({ error: 'Slot is already linked to a different member' });
    }
    
    await db.execute(sql`UPDATE booking_members 
       SET user_email = ${memberEmail.toLowerCase()}, linked_at = NOW(), linked_by = ${linkedBy} 
       WHERE id = ${slotId}`);
    
    const bookingResult = await db.execute(sql`SELECT request_date, start_time, end_time, status, session_id FROM booking_requests WHERE id = ${bookingId}`);
    
    if ((bookingResult.rows[0] as any)?.session_id) {
      const sessionId = (bookingResult.rows[0] as any).session_id;
      const booking = bookingResult.rows[0] as any;
      
      const slotDuration = booking.start_time && booking.end_time
        ? Math.round((new Date(`2000-01-01T${booking.end_time}`).getTime() - 
                     new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000)
        : 60;
      
      const memberInfo = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);
      
      if (!(memberInfo.rows[0] as any)?.id) {
        console.warn(`[Link Member] User not found for email ${memberEmail}`);
        return res.status(404).json({ error: 'Member not found in system' });
      }
      
      const userId = (memberInfo.rows[0] as any).id;
      const displayName = `${(memberInfo.rows[0] as any).first_name || ''} ${(memberInfo.rows[0] as any).last_name || ''}`.trim() || memberEmail;
      
      const existingParticipant = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId} AND user_id = ${userId}`);
      
      if (existingParticipant.rowCount === 0) {
        const matchingGuest = await db.execute(sql`SELECT bp.id, bp.display_name, g.email as guest_email
           FROM booking_participants bp
           LEFT JOIN guests g ON bp.guest_id = g.id
           WHERE bp.session_id = ${sessionId} 
             AND bp.participant_type = 'guest'
             AND (LOWER(bp.display_name) = LOWER(${displayName}) OR LOWER(g.email) = LOWER(${memberEmail}))`);
        
        if (matchingGuest.rowCount && matchingGuest.rowCount > 0) {
          const guestIds = matchingGuest.rows.map((r: any) => r.id);
          if (guestIds.length > 0) {
            await db.execute(sql`DELETE FROM booking_participants WHERE id IN (${sql.join(guestIds.map((id: number) => sql`${id}`), sql`, `)})`);
            console.log(`[Link Member] Removed ${guestIds.length} duplicate guest entries for member ${memberEmail} in session ${sessionId}`);
          }
        }
        
        await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, invite_status, slot_duration)
           VALUES (${sessionId}, ${userId}, 'member', ${displayName}, 'pending', 'confirmed', ${slotDuration})`);
      }
      
      // Recalculate fees after adding participant
      try {
        await recalculateSessionFees(sessionId as number, 'link_member' as any);
      } catch (feeErr) {
        console.warn(`[Link Member] Failed to recalculate fees for session ${sessionId}:`, feeErr);
      }
    }
    
    if (bookingResult.rows[0]) {
      const booking = bookingResult.rows[0] as any;
      const bookingDate = booking.request_date;
      const now = new Date();
      const bookingDateTime = new Date(`${bookingDate}T${booking.start_time}`);
      
      if (bookingDateTime > now && booking.status === 'approved') {
        const notificationMessage = `You've been added to a simulator booking on ${new Date(bookingDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`;
        
        await db.execute(sql`INSERT INTO notifications (user_email, title, message, type, related_id, related_type)
           VALUES (${memberEmail.toLowerCase()}, ${'Added to Booking'}, ${notificationMessage}, ${'booking_approved'}, ${bookingId}, ${'booking_request'})`);
        
        sendPushNotification(memberEmail.toLowerCase(), {
          title: 'Added to Booking',
          body: notificationMessage,
          tag: `booking-linked-${bookingId}`
        }).catch(() => {});
      }
    }
    
    logFromRequest(req, 'link_member_to_booking' as any, 'booking', bookingId as any, memberEmail.toLowerCase(), {
      slotId,
      memberEmail: memberEmail.toLowerCase(),
      linkedBy
    });
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} linked to slot` 
    });
  } catch (error: unknown) {
    console.error('Link member error:', error);
    res.status(500).json({ error: 'Failed to link member to slot' });
  }
});

router.put('/api/admin/booking/:bookingId/members/:slotId/unlink', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    
    const slotResult = await db.execute(sql`SELECT * FROM booking_members WHERE id = ${slotId} AND booking_id = ${bookingId}`);
    
    if (slotResult.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    
    const slot = slotResult.rows[0] as any;
    if (!slot.user_email) {
      return res.status(400).json({ error: 'Slot is already empty' });
    }
    
    const memberEmail = slot.user_email;
    
    await db.execute(sql`UPDATE booking_members 
       SET user_email = NULL, linked_at = NULL, linked_by = NULL 
       WHERE id = ${slotId}`);
    
    const bookingResult = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${bookingId}`);
    
    if ((bookingResult.rows[0] as any)?.session_id) {
      const sessionId = (bookingResult.rows[0] as any).session_id;
      
      const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${memberEmail}) LIMIT 1`);
      
      if (userResult.rows.length > 0) {
        const userId = (userResult.rows[0] as any).id;
        await db.execute(sql`DELETE FROM booking_participants 
           WHERE session_id = ${sessionId} AND user_id = ${userId} AND participant_type = 'member'`);
        
        // Recalculate session fees after removing participant
        try {
          const { recalculateSessionFees } = await import('../../core/billing/unifiedFeeService');
          await recalculateSessionFees(sessionId as number, 'roster_change' as any);
        } catch (feeError) {
          console.warn('[unlink] Failed to recalculate session fees (non-blocking):', feeError);
        }
      } else {
        console.warn(`[unlink] No user found for email ${memberEmail} - booking_members may be out of sync with users table`);
      }
    }
    
    logFromRequest(req, 'unlink_member_from_booking' as any, 'booking', bookingId as any, memberEmail.toLowerCase(), {
      slotId
    });
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} unlinked from slot` 
    });
  } catch (error: unknown) {
    console.error('Unlink member error:', error);
    res.status(500).json({ error: 'Failed to unlink member from slot' });
  }
});

function calculateMatchScore(searchName: string, firstName: string | null, lastName: string | null): number {
  const search = searchName.toLowerCase().trim();
  const first = (firstName || '').toLowerCase().trim();
  const last = (lastName || '').toLowerCase().trim();
  const full = `${first} ${last}`.trim();
  
  if (search === full) return 100;
  
  let score = 0;
  const searchParts = search.split(/\s+/);
  
  for (const part of searchParts) {
    if (first === part) score += 40;
    else if (first.startsWith(part)) score += 30;
    else if (first.includes(part)) score += 20;
    
    if (last === part) score += 40;
    else if (last.startsWith(part)) score += 30;
    else if (last.includes(part)) score += 20;
  }
  
  return Math.min(score, 99);
}

router.get('/api/admin/trackman/potential-matches', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const unmatchedResult = await db.execute(sql`SELECT 
        tub.id, tub.trackman_booking_id, tub.user_name, tub.original_email, 
        TO_CHAR(tub.booking_date, 'YYYY-MM-DD') as booking_date,
        tub.start_time, tub.end_time, tub.bay_number, tub.player_count, tub.status, tub.notes, tub.created_at
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br 
           WHERE br.trackman_booking_id = tub.trackman_booking_id::text
         )
       ORDER BY tub.booking_date DESC, tub.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    const potentialMatches: any[] = [];
    
    for (const unmatched of unmatchedResult.rows as any[]) {
      const matchingBookings = await db.execute(sql`SELECT br.id, br.user_email, br.user_name, br.start_time, br.end_time, br.status,
                u.first_name, u.last_name
         FROM booking_requests br
         LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
         WHERE br.request_date = ${unmatched.booking_date}
           AND ABS(EXTRACT(EPOCH FROM (br.start_time::time - ${unmatched.start_time}::time))) <= 1800
           AND br.trackman_booking_id IS NULL
           AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
         LIMIT 5`);
      
      if (matchingBookings.rows.length > 0) {
        potentialMatches.push({
          unmatchedBooking: {
            id: unmatched.id,
            trackmanBookingId: unmatched.trackman_booking_id,
            userName: unmatched.user_name,
            originalEmail: unmatched.original_email,
            bookingDate: unmatched.booking_date,
            startTime: unmatched.start_time,
            endTime: unmatched.end_time,
            bayNumber: unmatched.bay_number,
            playerCount: unmatched.player_count,
            status: unmatched.status,
            notes: unmatched.notes,
            createdAt: unmatched.created_at
          },
          potentialAppBookings: matchingBookings.rows.map((b: any) => ({
            id: b.id,
            userEmail: b.user_email,
            userName: b.user_name,
            startTime: b.start_time,
            endTime: b.end_time,
            status: b.status,
            memberName: [b.first_name, b.last_name].filter(Boolean).join(' ') || b.user_name
          }))
        });
      }
    }
    
    const totalCount = potentialMatches.length;
    
    res.json({ data: potentialMatches, totalCount });
  } catch (error: unknown) {
    console.error('Fetch potential-matches error:', error);
    res.status(500).json({ error: 'Failed to fetch potential matches' });
  }
});

router.delete('/api/admin/trackman/reset-data', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = (req as any).session?.user?.email || 'admin';
    
    await client.query('BEGIN');
    
    const bookingCount = await client.query(
      `SELECT COUNT(*) FROM booking_requests WHERE trackman_booking_id IS NOT NULL`
    );
    const sessionCount = await client.query(
      `SELECT COUNT(*) FROM booking_sessions WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL`
    );
    const unmatchedCount = await client.query(
      `SELECT COUNT(*) FROM trackman_unmatched_bookings`
    );
    
    await client.query(`
      DELETE FROM usage_ledger 
      WHERE session_id IN (
        SELECT id FROM booking_sessions 
        WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM booking_payment_audit 
      WHERE booking_id IN (
        SELECT id FROM booking_requests 
        WHERE trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM booking_participants 
      WHERE session_id IN (
        SELECT id FROM booking_sessions 
        WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM booking_members 
      WHERE booking_id IN (
        SELECT id FROM booking_requests 
        WHERE trackman_booking_id IS NOT NULL
      )
    `);
    
    await client.query(`
      DELETE FROM booking_sessions 
      WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
    `);
    
    await client.query(`
      DELETE FROM booking_requests 
      WHERE trackman_booking_id IS NOT NULL
    `);
    
    await client.query(`DELETE FROM trackman_unmatched_bookings`);
    
    await client.query(`DELETE FROM trackman_import_runs`);
    
    await client.query('COMMIT');
    
    console.log(`[Trackman Reset] Data wiped by ${user}: ${(bookingCount.rows[0] as any).count} bookings, ${(sessionCount.rows[0] as any).count} sessions, ${(unmatchedCount.rows[0] as any).count} unmatched`);
    
    res.json({
      success: true,
      message: 'Trackman data reset complete',
      deleted: {
        bookings: parseInt((bookingCount.rows[0] as any).count),
        sessions: parseInt((sessionCount.rows[0] as any).count),
        unmatched: parseInt((unmatchedCount.rows[0] as any).count)
      }
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('Trackman reset error:', error);
    res.status(500).json({ error: 'Failed to reset Trackman data: ' + getErrorMessage(error) });
  } finally {
    client.release();
  }
});

router.get('/api/admin/trackman/fuzzy-matches/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const unmatchedResult = await db.execute(sql`SELECT id, user_name, original_email, notes, match_attempt_reason
       FROM trackman_unmatched_bookings
       WHERE id = ${id}`);
    
    if (unmatchedResult.rowCount === 0) {
      return res.status(404).json({ error: 'Unmatched booking not found' });
    }
    
    const unmatched = unmatchedResult.rows[0] as any;
    const userName = (unmatched.user_name || '').toLowerCase().trim();
    
    if (!userName) {
      return res.json({ suggestions: [], message: 'No name to match against' });
    }
    
    const nameParts = userName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    
    let suggestions: any[] = [];
    
    if (firstName && lastName) {
      const result = await db.execute(sql`SELECT id, email, first_name, last_name, membership_status, trackman_email
         FROM users
         WHERE (
           (LOWER(first_name) LIKE ${`%${firstName}%`} AND LOWER(last_name) LIKE ${`%${lastName}%`})
           OR (LOWER(first_name) LIKE ${`%${lastName}%`} AND LOWER(last_name) LIKE ${`%${firstName}%`})
           OR LOWER(first_name || ' ' || last_name) LIKE ${`%${userName}%`}
           OR LOWER(last_name || ' ' || first_name) LIKE ${`%${userName}%`}
         )
         AND membership_status IS NOT NULL
         ORDER BY 
           CASE WHEN membership_status = 'active' THEN 0 ELSE 1 END,
           first_name, last_name
         LIMIT 10`);
      suggestions = result.rows;
    } else if (firstName) {
      const result = await db.execute(sql`SELECT id, email, first_name, last_name, membership_status, trackman_email
         FROM users
         WHERE (LOWER(first_name) LIKE ${`%${firstName}%`} OR LOWER(last_name) LIKE ${`%${firstName}%`})
         AND membership_status IS NOT NULL
         ORDER BY 
           CASE WHEN membership_status = 'active' THEN 0 ELSE 1 END,
           first_name, last_name
         LIMIT 10`);
      suggestions = result.rows;
    }
    
    const formattedSuggestions = suggestions.map(s => ({
      id: s.id,
      email: s.email,
      firstName: s.first_name,
      lastName: s.last_name,
      fullName: [s.first_name, s.last_name].filter(Boolean).join(' '),
      membershipStatus: s.membership_status,
      trackmanEmail: s.trackman_email,
      matchScore: calculateMatchScore(userName, s.first_name, s.last_name)
    })).sort((a, b) => b.matchScore - a.matchScore);
    
    res.json({ 
      unmatchedName: unmatched.user_name,
      unmatchedEmail: unmatched.original_email,
      matches: formattedSuggestions,
      requiresReview: (unmatched.match_attempt_reason || '').includes('REQUIRES_REVIEW')
    });
  } catch (error: unknown) {
    console.error('Fuzzy match error:', error);
    res.status(500).json({ error: 'Failed to find fuzzy matches' });
  }
});

router.get('/api/admin/trackman/requires-review', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const result = await db.execute(sql`SELECT 
        tub.id,
        tub.trackman_booking_id as "trackmanBookingId",
        tub.user_name as "userName",
        tub.original_email as "originalEmail",
        TO_CHAR(tub.booking_date, 'YYYY-MM-DD') as "bookingDate",
        tub.start_time as "startTime",
        tub.end_time as "endTime",
        tub.bay_number as "bayNumber",
        tub.player_count as "playerCount",
        tub.notes,
        tub.match_attempt_reason as "matchAttemptReason",
        tub.created_at as "createdAt"
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL
         AND tub.match_attempt_reason LIKE '%REQUIRES_REVIEW%'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br 
           WHERE br.trackman_booking_id = tub.trackman_booking_id::text
         )
       ORDER BY tub.booking_date DESC, tub.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total 
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL 
         AND tub.match_attempt_reason LIKE '%REQUIRES_REVIEW%'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br 
           WHERE br.trackman_booking_id = tub.trackman_booking_id::text
         )`);
    
    res.json({ 
      data: result.rows,
      totalCount: parseInt((countResult.rows[0] as any).total)
    });
  } catch (error: unknown) {
    console.error('Fetch requires-review error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings requiring review' });
  }
});

// ============================================================================
// Session Backfill Endpoints - for legacy Trackman imports without sessions
// ============================================================================

router.get('/api/admin/backfill-sessions/preview', isStaffOrAdmin, async (req, res) => {
  try {
    // Get count and sample of bookings without sessions
    const countResult = await db.execute(sql`SELECT COUNT(*) as total
      FROM booking_requests br
      WHERE br.session_id IS NULL
        AND br.status IN ('attended', 'approved', 'confirmed')
        AND br.resource_id IS NOT NULL
        AND (br.is_unmatched = false OR br.is_unmatched IS NULL)`);
    
    const totalCount = parseInt((countResult.rows[0] as any).total);
    
    const samplesResult = await db.execute(sql`SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.resource_id,
        r.name as resource_name,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.status,
        br.trackman_booking_id,
        br.origin,
        br.created_at
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE br.session_id IS NULL
        AND br.status IN ('attended', 'approved', 'confirmed')
        AND br.resource_id IS NOT NULL
        AND (br.is_unmatched = false OR br.is_unmatched IS NULL)
      ORDER BY br.request_date DESC, br.start_time DESC
      LIMIT 10`);
    
    res.json({
      totalCount,
      sampleBookings: samplesResult.rows.map((row: any) => ({
        id: row.id,
        userEmail: row.user_email,
        userName: row.user_name,
        resourceId: row.resource_id,
        resourceName: row.resource_name,
        requestDate: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        status: row.status,
        trackmanBookingId: row.trackman_booking_id,
        origin: row.origin,
        createdAt: row.created_at
      })),
      message: `Found ${totalCount} booking(s) without sessions that can be backfilled`
    });
  } catch (error: unknown) {
    console.error('[Backfill Preview] Error:', error);
    res.status(500).json({ error: 'Failed to preview backfill candidates' });
  }
});

router.post('/api/admin/backfill-sessions', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const staffEmail = (req as any).session?.user?.email || 'admin';
    
    // Find all bookings without sessions
    const bookingsResult = await client.query(`
      SELECT 
        br.id,
        br.user_id,
        br.user_email,
        br.user_name,
        br.resource_id,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.trackman_booking_id,
        u.id as owner_user_id
      FROM booking_requests br
      LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
      WHERE br.session_id IS NULL
        AND br.status IN ('attended', 'approved', 'confirmed')
        AND br.resource_id IS NOT NULL
        AND (br.is_unmatched = false OR br.is_unmatched IS NULL)
      ORDER BY br.request_date ASC
    `);
    
    const bookings = bookingsResult.rows;
    
    if (bookings.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        sessionsCreated: 0,
        message: 'No bookings found without sessions'
      });
    }
    
    let sessionsCreated = 0;
    let sessionsLinked = 0;
    const errors: Array<{ bookingId: number; error: string }> = [];
    let savepointCounter = 0;
    
    for (const booking of bookings) {
      // Use savepoint for each booking so individual failures don't abort entire transaction
      savepointCounter++;
      const savepointName = `sp_${savepointCounter}`;
      
      try {
        await client.query(`SAVEPOINT ${savepointName}`);
        
        const displayName = booking.user_name || booking.user_email || 'Unknown';
        const userId = booking.owner_user_id || booking.user_id;
        
        let source = 'member_request';
        if (booking.trackman_booking_id) {
          source = 'trackman_import';
        }
        
        const sessionResult = await ensureSessionForBooking({
          bookingId: booking.id,
          resourceId: booking.resource_id,
          sessionDate: booking.request_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
          ownerEmail: booking.user_email || '',
          ownerName: displayName,
          ownerUserId: userId?.toString(),
          trackmanBookingId: booking.trackman_booking_id,
          source: source,
          createdBy: 'backfill_tool'
        }, client);
        
        if (sessionResult.sessionId === 0 && sessionResult.error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          errors.push({
            bookingId: booking.id,
            error: sessionResult.error
          });
          continue;
        }
        
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        
        if (sessionResult.created) {
          sessionsCreated++;
        } else {
          sessionsLinked++;
        }
      } catch (bookingError: unknown) {
        // Rollback to savepoint so we can continue with next booking
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch (rollbackError) {
          // If rollback fails, log but continue
          console.error(`[Backfill] Failed to rollback savepoint for booking ${booking.id}`);
        }
        
        console.error(`[Backfill] Error processing booking ${booking.id}:`, getErrorMessage(bookingError) || bookingError);
        errors.push({
          bookingId: booking.id,
          error: getErrorMessage(bookingError) || 'Unknown error'
        });
      }
    }
    
    await client.query('COMMIT');
    
    // Log the backfill action
    logFromRequest(req, 'bulk_action', 'booking', undefined, 'Session Backfill', {
      action: 'backfill_sessions',
      sessionsCreated,
      sessionsLinked,
      totalProcessed: bookings.length,
      errorsCount: errors.length,
      errors: errors.slice(0, 10) // Only log first 10 errors
    });
    
    const totalResolved = sessionsCreated + sessionsLinked;
    console.log(`[Backfill] Completed: ${sessionsCreated} new sessions, ${sessionsLinked} linked to existing for ${bookings.length} bookings by ${staffEmail}`);
    
    const messageParts = [];
    if (sessionsCreated > 0) messageParts.push(`${sessionsCreated} new sessions created`);
    if (sessionsLinked > 0) messageParts.push(`${sessionsLinked} linked to existing sessions`);
    const message = messageParts.length > 0 
      ? `Successfully resolved ${totalResolved} bookings: ${messageParts.join(', ')}`
      : 'No bookings could be resolved';
    
    res.json({
      success: true,
      sessionsCreated,
      sessionsLinked,
      totalProcessed: bookings.length,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
      message
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('[Backfill Sessions] Error:', error);
    
    // Log the failed attempt
    logFromRequest(req, 'bulk_action', 'booking', undefined, 'Session Backfill Failed', {
      action: 'backfill_sessions',
      error: getErrorMessage(error)
    });
    
    res.status(500).json({ error: 'Failed to backfill sessions: ' + (getErrorMessage(error) || 'Unknown error') });
  } finally {
    client.release();
  }
});

// Admin endpoint to detect and clean up duplicate Trackman booking IDs
// This is needed because production may have duplicates from race conditions
router.get('/api/admin/trackman/duplicate-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`SELECT 
        trackman_booking_id,
        COUNT(*) as duplicate_count,
        array_agg(id ORDER BY created_at) as booking_ids,
        array_agg(created_at ORDER BY created_at) as created_dates,
        array_agg(is_unmatched ORDER BY created_at) as is_unmatched_flags,
        array_agg(user_email ORDER BY created_at) as emails
      FROM booking_requests
      WHERE trackman_booking_id IS NOT NULL
      GROUP BY trackman_booking_id
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC`);

    res.json({
      duplicatesFound: result.rows.length,
      duplicates: result.rows.map((row: any) => ({
        trackmanBookingId: row.trackman_booking_id,
        count: parseInt(row.duplicate_count),
        bookingIds: row.booking_ids,
        createdDates: row.created_dates,
        isUnmatchedFlags: row.is_unmatched_flags,
        emails: row.emails
      }))
    });
  } catch (error: unknown) {
    console.error('[Trackman Duplicates] Error:', error);
    res.status(500).json({ error: 'Failed to check for duplicates' });
  }
});

// Admin endpoint to clean up duplicate Trackman bookings by keeping the oldest (first created)
router.post('/api/admin/trackman/cleanup-duplicates', isStaffOrAdmin, async (req, res) => {
  const { dryRun = true } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Find all duplicates, keeping the oldest (first created) for each trackman_booking_id
    const duplicateResult = await client.query(`
      WITH ranked AS (
        SELECT 
          id,
          trackman_booking_id,
          ROW_NUMBER() OVER (PARTITION BY trackman_booking_id ORDER BY created_at ASC) as rn
        FROM booking_requests
        WHERE trackman_booking_id IS NOT NULL
      )
      SELECT id, trackman_booking_id
      FROM ranked
      WHERE rn > 1
    `);
    
    const idsToDelete = duplicateResult.rows.map((r: any) => r.id);
    
    if (dryRun) {
      await client.query('ROLLBACK');
      res.json({
        dryRun: true,
        wouldDelete: idsToDelete.length,
        bookingIds: idsToDelete.slice(0, 50),
        message: `Would delete ${idsToDelete.length} duplicate booking(s). Set dryRun=false to execute.`
      });
      return;
    }
    
    // Delete the duplicates (keeps the oldest)
    if (idsToDelete.length > 0) {
      // First delete related records
      await client.query(
        `DELETE FROM booking_payment_audit WHERE booking_id = ANY($1)`,
        [idsToDelete]
      );
      await client.query(
        `DELETE FROM booking_fee_snapshots WHERE booking_id = ANY($1)`,
        [idsToDelete]
      );
      await client.query(
        `DELETE FROM booking_members WHERE booking_id = ANY($1)`,
        [idsToDelete]
      );
      // Delete the duplicate booking requests
      await client.query(
        `DELETE FROM booking_requests WHERE id = ANY($1)`,
        [idsToDelete]
      );
    }
    
    await client.query('COMMIT');
    
    const sessionUser = (req as any).session?.user?.email || 'admin';
    const { logFromRequest } = await import('../../core/auditLog');
    await logFromRequest(req, {
      action: 'bulk_action',
      resourceType: 'booking',
      resourceId: undefined,
      resourceName: 'Duplicate Cleanup',
      details: { deletedCount: idsToDelete.length, bookingIds: idsToDelete }
    });
    
    res.json({
      success: true,
      deletedCount: idsToDelete.length,
      bookingIds: idsToDelete,
      message: `Successfully deleted ${idsToDelete.length} duplicate booking(s)`
    });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.error('[Trackman Cleanup Duplicates] Error:', error);
    res.status(500).json({ error: 'Failed to cleanup duplicates: ' + (getErrorMessage(error) || 'Unknown error') });
  } finally {
    client.release();
  }
});

// Auto-match unmatched bookings to visitors based on MindBody purchase history
router.post('/api/admin/trackman/auto-match-visitors', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = (req as any).session?.user?.email || 'system';
    
    const { autoMatchAllUnmatchedBookings } = await import('../../core/visitors/autoMatchService');
    
    const results = await autoMatchAllUnmatchedBookings(sessionUser);
    
    // Log the auto-match action
    logFromRequest(
      req,
      'bulk_action',
      'booking',
      undefined,
      'Auto-Match Visitors',
      { 
        matched: results.matched, 
        failed: results.failed,
        matchTypes: results.results.reduce((acc, r) => {
          acc[r.matchType] = (acc[r.matchType] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      }
    );
    
    res.json({
      success: true,
      matched: results.matched,
      failed: results.failed,
      results: results.results.slice(0, 50), // Limit response size
      message: `Auto-matched ${results.matched} booking(s), ${results.failed} could not be matched`
    });
  } catch (error: unknown) {
    console.error('[Trackman Auto-Match] Error:', error);
    res.status(500).json({ 
      error: 'Failed to auto-match visitors: ' + (getErrorMessage(error) || 'Unknown error') 
    });
  }
});

// -----------------------------------------------------------------------
// HISTORICAL LESSON CLEANUP
// Converts existing bookings linked to instructors into availability blocks
// and resolves unmatched lesson entries from the queue
// -----------------------------------------------------------------------
router.post('/api/trackman/admin/cleanup-lessons', isStaffOrAdmin, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === 'true';
    const sessionUser = (req as any).session?.user?.email || 'system';
    const logs: string[] = [];
    const log = (msg: string) => {
      console.log(msg);
      logs.push(msg);
    };

    log(`[Lesson Cleanup] Starting cleanup run (Dry Run: ${dryRun})...`);

    // Staff email patterns to detect lesson bookings
    const INSTRUCTOR_EMAILS = [
      'tim@evenhouse.club',
      'rebecca@evenhouse.club',
      'instructors@evenhouse.club'
    ];

    let convertedBookings = 0;
    let resolvedUnmatched = 0;

    // 1. Find bookings that look like lessons based on patterns
    if (INSTRUCTOR_EMAILS.length === 0) {
      return res.json({ success: true, convertedBookings: 0, resolvedUnmatched: 0, blocksCreated: 0 });
    }
    const lessonBookings = await db.execute(sql`SELECT 
        br.id,
        br.user_name,
        br.user_email,
        br.resource_id,
        br.request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.notes,
        br.trackman_booking_id
      FROM booking_requests br
      WHERE br.status NOT IN ('cancelled', 'cancellation_pending')
        AND (
          LOWER(br.user_email) IN (${sql.join(INSTRUCTOR_EMAILS.map((e: string) => sql`${e}`), sql`, `)})
          OR LOWER(br.user_name) LIKE '%lesson%'
          OR LOWER(br.notes) LIKE '%lesson%'
          OR (LOWER(br.user_name) LIKE '%rebecca%' AND LOWER(br.user_name) LIKE '%lee%')
          OR (LOWER(br.user_name) LIKE '%tim%' AND LOWER(br.user_name) LIKE '%silverman%')
        )
      ORDER BY br.request_date DESC
      LIMIT 500`);

    log(`[Lesson Cleanup] Found ${lessonBookings.rows.length} lesson bookings to process.`);

    for (const booking of lessonBookings.rows as any[]) {
      if (!booking.resource_id || !booking.request_date || !booking.start_time) continue;

      const bookingDate = booking.request_date instanceof Date 
        ? booking.request_date.toISOString().split('T')[0]
        : booking.request_date;
      const endTime = booking.end_time || booking.start_time;

      // Check if block already exists
      const existingBlock = await db.execute(sql`SELECT ab.id FROM availability_blocks ab
        JOIN facility_closures fc ON ab.closure_id = fc.id
        WHERE ab.resource_id = ${booking.resource_id}
          AND ab.block_date = ${bookingDate}
          AND ab.start_time < ${endTime}::time
          AND ab.end_time > ${booking.start_time}::time
          AND fc.notice_type = 'private_event'
          AND fc.is_active = true
        LIMIT 1`);

      const blockAlreadyExists = existingBlock.rows.length > 0;

      if (!dryRun) {
        if (!blockAlreadyExists) {
          const closureResult = await db.execute(sql`INSERT INTO facility_closures 
              (resource_id, start_date, end_date, start_time, end_time, reason, notice_type, is_active, created_by)
            VALUES (${booking.resource_id}, ${bookingDate}, ${bookingDate}, ${booking.start_time}, ${endTime}, ${`Lesson (Converted): ${booking.user_name} [TM:${booking.trackman_booking_id || booking.id}]`}, 'private_event', true, ${'system_cleanup'})
            RETURNING id`);

          await db.execute(sql`INSERT INTO availability_blocks 
              (closure_id, resource_id, block_date, start_time, end_time, reason)
            VALUES (${(closureResult.rows[0] as any).id}, ${booking.resource_id}, ${bookingDate}, ${booking.start_time}, ${endTime}, ${`Lesson - ${booking.user_name}`})`);
        }

        await db.execute(sql`UPDATE booking_requests 
          SET status = 'cancelled',
              staff_notes = COALESCE(staff_notes, '') || ${` [Converted to Availability Block by ${sessionUser}]`},
              updated_at = NOW()
          WHERE id = ${booking.id}`);

        await db.execute(sql`DELETE FROM booking_members WHERE booking_id = ${booking.id}`);
        await db.execute(sql`DELETE FROM booking_guests WHERE booking_id = ${booking.id}`);
        await db.execute(sql`DELETE FROM booking_participants WHERE booking_id = ${booking.id}`);

        await db.execute(sql`DELETE FROM usage_ledger WHERE booking_id = ${booking.id}`);

        const pendingIntents = await db.execute(sql`SELECT stripe_payment_intent_id FROM stripe_payment_intents 
          WHERE booking_id = ${booking.id} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`);
        
        for (const intent of pendingIntents.rows as any[]) {
          try {
            const stripe = await getStripeClient();
            await stripe.paymentIntents.cancel(intent.stripe_payment_intent_id);
          } catch (err: unknown) {
            log(`[Lesson Cleanup] Could not cancel payment intent ${intent.stripe_payment_intent_id}: ${getErrorMessage(err)}`);
          }
        }

        await db.execute(sql`DELETE FROM booking_sessions WHERE booking_id = ${booking.id}`);
      }

      log(`[Lesson Cleanup] ${blockAlreadyExists ? 'Block exists, cleaned up booking' : 'Converted Booking'} #${booking.id} (${booking.user_name}).`);
      convertedBookings++;
    }

    // 2. Resolve unmatched lesson entries from the queue
    const unmatchedLessons = await db.execute(sql`SELECT id, user_name, booking_date, start_time, end_time, bay_number, notes, trackman_booking_id
      FROM trackman_unmatched_bookings
      WHERE resolved_at IS NULL
        AND (
          LOWER(user_name) LIKE '%lesson%'
          OR LOWER(notes) LIKE '%lesson%'
          OR (LOWER(user_name) LIKE '%rebecca%')
          OR (LOWER(user_name) LIKE '%tim%' AND LOWER(user_name) LIKE '%silverman%')
        )
      LIMIT 500`);

    log(`[Lesson Cleanup] Found ${unmatchedLessons.rows.length} unmatched lesson entries to resolve.`);

    for (const item of unmatchedLessons.rows as any[]) {
      const resourceId = parseInt(item.bay_number) || null;
      
      if (resourceId && item.booking_date && item.start_time) {
        if (!dryRun) {
          const bookingDate = item.booking_date instanceof Date 
            ? item.booking_date.toISOString().split('T')[0]
            : item.booking_date;

          // Check if block already exists
          const existingBlock = await db.execute(sql`SELECT ab.id FROM availability_blocks ab
            JOIN facility_closures fc ON ab.closure_id = fc.id
            WHERE ab.resource_id = ${resourceId}
              AND ab.block_date = ${bookingDate}
              AND ab.start_time < ${item.end_time || item.start_time}::time
              AND ab.end_time > ${item.start_time}::time
              AND fc.notice_type = 'private_event'
              AND fc.is_active = true
            LIMIT 1`);

          if (existingBlock.rows.length === 0) {
            const closureResult = await db.execute(sql`INSERT INTO facility_closures 
                (resource_id, start_date, end_date, start_time, end_time, reason, notice_type, is_active, created_by)
              VALUES (${resourceId}, ${bookingDate}, ${bookingDate}, ${item.start_time}, ${item.end_time || item.start_time}, ${`Lesson: ${item.user_name} [TM:${item.trackman_booking_id || item.id}]`}, 'private_event', true, ${'system_cleanup'})
              RETURNING id`);

            await db.execute(sql`INSERT INTO availability_blocks 
                (closure_id, resource_id, block_date, start_time, end_time, reason)
              VALUES (${(closureResult.rows[0] as any).id}, ${resourceId}, ${bookingDate}, ${item.start_time}, ${item.end_time || item.start_time}, ${`Lesson - ${item.user_name}`})`);
          }

          await db.execute(sql`UPDATE trackman_unmatched_bookings
            SET resolved_at = NOW(),
                resolved_by = ${sessionUser},
                match_attempt_reason = 'Converted to Availability Block (Lesson Cleanup)'
            WHERE id = ${item.id}`);
        }

        log(`[Lesson Cleanup] Resolved unmatched lesson #${item.id} (${item.user_name}).`);
        resolvedUnmatched++;
      }
    }

    // Log the cleanup action
    logFromRequest(
      req,
      'bulk_action',
      'booking',
      undefined,
      'Lesson Cleanup',
      { 
        dryRun,
        convertedBookings,
        resolvedUnmatched
      }
    );

    res.json({
      success: true,
      dryRun,
      convertedBookings,
      resolvedUnmatched,
      logs
    });
  } catch (error: unknown) {
    console.error('[Lesson Cleanup] Error:', error);
    res.status(500).json({ 
      error: 'Failed to cleanup lessons: ' + (getErrorMessage(error) || 'Unknown error') 
    });
  }
});

export default router;

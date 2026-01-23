import { Router } from 'express';
import { importTrackmanBookings, getImportRuns } from '../core/trackmanImport';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { isStaffOrAdmin } from '../core/middleware';
import { pool } from '../core/db';
import { sendPushNotification } from './push';
import { 
  findAttendanceDiscrepancies, 
  markAsReconciled, 
  adjustLedgerForReconciliation, 
  getReconciliationSummary 
} from '../core/bookingService/trackmanReconciliation';
import { getGuestPassesRemaining } from './guestPasses';
import { getMemberTierByEmail, getTierLimits, getDailyBookedMinutes, getTotalDailyUsageMinutes } from '../core/tierService';
import { calculateAndCacheParticipantFees } from '../core/billing/feeCalculator';

const router = Router();

const uploadDir = path.join(process.cwd(), 'uploads', 'trackman');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    cb(null, `trackman_${timestamp}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// NOTE: Unmatched bookings endpoints removed - simulator bookings now use Trackman webhooks only

router.get('/api/admin/trackman/import-runs', isStaffOrAdmin, async (req, res) => {
  try {
    const runs = await getImportRuns();
    res.json(runs);
  } catch (error: any) {
    console.error('Error fetching import runs:', error);
    res.status(500).json({ error: 'Failed to fetch import runs' });
  }
});

router.post('/api/admin/trackman/import', isStaffOrAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    const user = (req as any).session?.user?.email || 'admin';
    
    const safeFilename = path.basename(filename || 'trackman_bookings_1767009308200.csv');
    if (!safeFilename.endsWith('.csv') || !/^[a-zA-Z0-9_\-\.]+$/.test(safeFilename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }
    
    const csvPath = path.join(process.cwd(), 'attached_assets', safeFilename);
    
    const result = await importTrackmanBookings(csvPath, user);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message || 'Failed to import bookings' });
  }
});

router.post('/api/admin/trackman/upload', isStaffOrAdmin, upload.single('file'), async (req, res) => {
  let csvPath: string | undefined;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const user = (req as any).session?.user?.email || 'admin';
    csvPath = req.file.path;
    
    const result = await importTrackmanBookings(csvPath, user);
    
    res.json({
      success: true,
      filename: req.file.filename,
      ...result
    });
  } catch (error: any) {
    console.error('Upload/Import error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload and import bookings' });
  } finally {
    if (csvPath && fs.existsSync(csvPath)) {
      try {
        fs.unlinkSync(csvPath);
      } catch (cleanupErr) {
        console.error('Failed to cleanup uploaded file:', cleanupErr);
      }
    }
  }
});

router.delete('/api/admin/trackman/linked-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail, linkedEmail } = req.body;
    
    if (!memberEmail || !linkedEmail) {
      return res.status(400).json({ error: 'memberEmail and linkedEmail are required' });
    }
    
    // Use array_remove after casting jsonb to text array, then back to jsonb
    const result = await pool.query(
      `UPDATE users 
       SET manually_linked_emails = (
         SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
         FROM jsonb_array_elements_text(COALESCE(manually_linked_emails, '[]'::jsonb)) elem
         WHERE elem != $1
       )
       WHERE LOWER(email) = LOWER($2)
       RETURNING manually_linked_emails`,
      [linkedEmail, memberEmail]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    res.json({ 
      success: true, 
      manuallyLinkedEmails: result.rows[0].manually_linked_emails || []
    });
  } catch (error: any) {
    console.error('Remove linked email error:', error);
    res.status(500).json({ error: 'Failed to remove linked email' });
  }
});

router.get('/api/admin/trackman/matched', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim().toLowerCase();
    
    // Only return fully resolved bookings:
    // - Solo bookings: trackman_player_count = 1
    // - OR all player slots are filled (participant count >= trackman_player_count)
    let whereClause = `
      (br.trackman_booking_id IS NOT NULL OR br.notes LIKE '%[Trackman Import ID:%')
      AND br.status NOT IN ('cancelled', 'declined')
      AND (
        -- Solo bookings: trackman_player_count = 1
        COALESCE(br.trackman_player_count, 1) = 1
        -- OR all slots are filled (participant count >= trackman_player_count)
        OR (
          br.session_id IS NOT NULL
          AND (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id) >= COALESCE(br.trackman_player_count, 1)
        )
      )
    `;
    const queryParams: any[] = [];
    
    if (search) {
      whereClause += ` AND (LOWER(br.user_name) LIKE $1 OR LOWER(br.user_email) LIKE $1 OR LOWER(u.first_name || ' ' || u.last_name) LIKE $1)`;
      queryParams.push(`%${search}%`);
    }
    
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM booking_requests br LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email) WHERE ${whereClause}`,
      queryParams
    );
    const totalCount = parseInt(countResult.rows[0].total, 10);
    
    const limitParam = queryParams.length + 1;
    const offsetParam = queryParams.length + 2;
    
    const result = await pool.query(
      `SELECT 
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
        -- Count filled slots: use booking_participants if session exists, otherwise count owner + non-primary members
        -- Guests without email are NOT counted as filled (slot shows unfilled until email is added)
        CASE 
          WHEN br.session_id IS NOT NULL THEN
            COALESCE((
              SELECT COUNT(*) FROM booking_participants bp 
              LEFT JOIN guests g ON g.id = bp.guest_id
              WHERE bp.session_id = br.session_id
                AND (bp.participant_type != 'guest' OR (bp.participant_type = 'guest' AND g.email IS NOT NULL AND g.email != ''))
            ), 0)
          ELSE
            -- No session: count owner as 1 if real email, plus non-primary booking_members
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
       WHERE ${whereClause}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...queryParams, limit, offset]
    );
    
    const data = result.rows.map(row => {
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
        // Flattened slot info (Task 6A)
        totalSlots,
        filledSlots,
        assignedCount: filledSlots,
        playerCount: totalSlots,
        isSolo: totalSlots === 1,
        isFullyResolved: totalSlots === 1 || filledSlots >= totalSlots,
        // Keep slotInfo for backward compatibility
        slotInfo: {
          totalSlots,
          filledSlots,
          isSolo: totalSlots === 1,
          isFullyResolved: totalSlots === 1 || filledSlots >= totalSlots
        }
      };
    });
    
    res.json({ data, totalCount });
  } catch (error: any) {
    console.error('Fetch matched bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch matched bookings' });
  }
});

router.put('/api/admin/trackman/matched/:id/reassign', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newMemberEmail } = req.body;
    
    if (!newMemberEmail) {
      return res.status(400).json({ error: 'newMemberEmail is required' });
    }
    
    const bookingResult = await pool.query(
      `SELECT user_email, notes FROM booking_requests WHERE id = $1`,
      [id]
    );
    
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const oldEmail = bookingResult.rows[0].user_email;
    const notes = bookingResult.rows[0].notes || '';
    
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
    
    await pool.query(
      `UPDATE booking_requests SET user_email = $1, updated_at = NOW() WHERE id = $2`,
      [newMemberEmail.toLowerCase(), id]
    );
    
    if (placeholderEmail) {
      await pool.query(
        `UPDATE users 
         SET manually_linked_emails = (
           SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
           FROM jsonb_array_elements_text(COALESCE(manually_linked_emails, '[]'::jsonb)) elem
           WHERE elem != $1
         )
         WHERE LOWER(email) = LOWER($2)`,
        [placeholderEmail, oldEmail]
      );
      
      await pool.query(
        `UPDATE users 
         SET manually_linked_emails = COALESCE(manually_linked_emails, '[]'::jsonb) || to_jsonb($1::text)
         WHERE LOWER(email) = LOWER($2)
           AND NOT (COALESCE(manually_linked_emails, '[]'::jsonb) @> to_jsonb($1::text))`,
        [placeholderEmail, newMemberEmail]
      );
    }
    
    res.json({ 
      success: true, 
      message: 'Booking reassigned successfully',
      oldEmail,
      newEmail: newMemberEmail.toLowerCase(),
      placeholderEmail
    });
  } catch (error: any) {
    console.error('Reassign matched booking error:', error);
    res.status(500).json({ error: 'Failed to reassign booking' });
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
    
    // Skip if this is already an unmatched placeholder email
    if (normalizedEmail.includes('unmatched@') || 
        normalizedEmail.includes('unmatched-') || 
        normalizedEmail.includes('@trackman.local') ||
        normalizedEmail.includes('anonymous@') ||
        normalizedEmail.includes('booking@evenhouse')) {
      return res.json({ 
        success: true, 
        affectedCount: 0,
        email: normalizedEmail,
        message: 'This booking is already unmatched'
      });
    }
    
    // First, get all affected bookings to extract their original Trackman info
    const bookingsResult = await pool.query(
      `SELECT id, notes, user_name 
       FROM booking_requests 
       WHERE LOWER(user_email) = $1
         AND (notes LIKE '%[Trackman Import ID:%' OR trackman_booking_id IS NOT NULL)
         AND status IN ('approved', 'pending', 'attended', 'no_show')`,
      [normalizedEmail]
    );
    
    if (bookingsResult.rowCount === 0) {
      return res.json({ 
        success: true, 
        affectedCount: 0,
        email: normalizedEmail,
        message: 'No bookings found to unmatch'
      });
    }
    
    // Update each booking individually to preserve original Trackman info in notes
    let affectedCount = 0;
    for (const booking of bookingsResult.rows) {
      // Extract original name from notes if available (format: "[Trackman Import ID:12345] Original Name [Email: ...")
      const notesMatch = booking.notes?.match(/\[Trackman Import ID:\d+\]\s*([^\[]+)/);
      const originalName = notesMatch ? notesMatch[1].trim() : booking.user_name || 'Unknown';
      
      // Extract Trackman ID for unique placeholder email
      const trackmanIdMatch = booking.notes?.match(/\[Trackman Import ID:(\d+)\]/);
      const trackmanId = trackmanIdMatch ? trackmanIdMatch[1] : booking.id;
      
      await pool.query(
        `UPDATE booking_requests 
         SET user_email = $1,
             user_name = $2,
             staff_notes = COALESCE(staff_notes, '') || $3
         WHERE id = $4`,
        [
          `unmatched-${trackmanId}@trackman.local`,
          originalName,
          ` [Unmatched from ${normalizedEmail} by ${unmatchedBy} on ${new Date().toISOString()}]`,
          booking.id
        ]
      );
      affectedCount++;
    }
    
    res.json({ 
      success: true, 
      affectedCount,
      email: normalizedEmail,
      message: affectedCount > 0 
        ? `Unmatched ${affectedCount} booking(s) for ${normalizedEmail}`
        : 'No bookings found to unmatch'
    });
  } catch (error: any) {
    console.error('Unmatch member error:', error);
    res.status(500).json({ error: 'Failed to unmatch member bookings' });
  }
});

// Get booking members for a specific booking
router.get('/api/admin/booking/:id/members', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get booking details including duration for fee calculation
    const bookingResult = await pool.query(
      `SELECT br.guest_count, br.trackman_player_count, br.resource_id, br.user_email as owner_email,
              br.duration_minutes, br.request_date, br.session_id,
              r.capacity as resource_capacity
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = $1`,
      [id]
    );
    
    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const legacyGuestCount = bookingResult.rows[0]?.guest_count || 0;
    const trackmanPlayerCount = bookingResult.rows[0]?.trackman_player_count;
    const resourceCapacity = bookingResult.rows[0]?.resource_capacity || null;
    const ownerEmail = bookingResult.rows[0]?.owner_email;
    const durationMinutes = bookingResult.rows[0]?.duration_minutes || 60;
    const requestDate = bookingResult.rows[0]?.request_date;
    
    // Get owner's tier, tier limits, and guest passes remaining
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
    
    const membersResult = await pool.query(
      `SELECT bm.*, u.first_name, u.last_name, u.email as member_email, u.tier as user_tier
       FROM booking_members bm
       LEFT JOIN users u ON LOWER(bm.user_email) = LOWER(u.email)
       WHERE bm.booking_id = $1
       ORDER BY bm.slot_number`,
      [id]
    );
    
    const guestsResult = await pool.query(
      `SELECT * FROM booking_guests WHERE booking_id = $1 ORDER BY slot_number`,
      [id]
    );
    
    // Check booking_participants table for legacy records (used for session-based bookings)
    const bookingData = bookingResult.rows[0];
    let participantsCount = 0;
    if (bookingData.session_id) {
      const participantsResult = await pool.query(
        `SELECT COUNT(*) as count FROM booking_participants WHERE session_id = $1`,
        [bookingData.session_id]
      );
      participantsCount = parseInt(participantsResult.rows[0]?.count) || 0;
    }
    
    // Expected player count: use Trackman's original value if available, else compute from slots
    // Priority: trackman_player_count > member_slots + guests > booking_participants > legacy guest_count + 1
    const totalMemberSlots = membersResult.rows.length;
    const actualGuestCount = guestsResult.rows.length;
    
    let expectedPlayerCount: number;
    if (trackmanPlayerCount && trackmanPlayerCount > 0) {
      // Trackman import with stored player count - most authoritative
      expectedPlayerCount = trackmanPlayerCount;
    } else if (totalMemberSlots > 0) {
      // Trackman import without stored player count - compute from slots + guests
      expectedPlayerCount = totalMemberSlots + actualGuestCount;
    } else if (participantsCount > 0) {
      // Legacy session-based booking - use participant count + guests
      expectedPlayerCount = participantsCount + actualGuestCount;
    } else {
      // Legacy booking without booking_members or booking_participants - use legacy formula
      expectedPlayerCount = Math.max(legacyGuestCount + 1, 1);
    }
    
    // Cap expectedPlayerCount at resource capacity (e.g., simulator max 4 players)
    if (resourceCapacity && resourceCapacity > 0) {
      expectedPlayerCount = Math.min(expectedPlayerCount, resourceCapacity);
    }
    
    // For display purposes, use appropriate guest count
    const effectiveGuestCount = actualGuestCount > 0 ? actualGuestCount : legacyGuestCount;
    
    // Count filled slots (members with email assigned)
    const filledMemberSlots = membersResult.rows.filter(row => row.user_email).length;
    // Assigned players = filled member slots + guests
    const actualPlayerCount = filledMemberSlots + effectiveGuestCount;
    
    // Check for player count mismatch (unfilled member slots)
    const playerCountMismatch = actualPlayerCount !== expectedPlayerCount;
    
    // Calculate per-person minutes based on player count (same formula as BookGolf.tsx)
    const perPersonMins = Math.floor(durationMinutes / expectedPlayerCount);
    
    // Calculate fee for each member using SAME logic as booking flow
    // Use getTotalDailyUsageMinutes to get usage from both owned bookings AND participant bookings
    const bookingId = parseInt(id);
    
    const membersWithFees = await Promise.all(membersResult.rows.map(async (row) => {
      let tier: string | null = null;
      let fee = 0;
      let feeNote = '';
      let feeBreakdown: {
        perPersonMins: number;
        dailyAllowance: number;
        usedToday: number;
        overageMinutes: number;
        fee: number;
        isUnlimited: boolean;
        isSocialTier: boolean;
      } | null = null;
      
      if (row.user_email) {
        tier = row.user_tier || await getMemberTierByEmail(row.user_email);
        
        if (tier) {
          const tierLimits = await getTierLimits(tier);
          const isSocialTier = tier.toLowerCase() === 'social';
          const dailyAllowance = tierLimits.daily_sim_minutes || 0;
          const isUnlimited = dailyAllowance >= 999 || tierLimits.unlimited_access;
          
          // Get THEIR total usage today including participant time, excluding THIS booking
          const usageData = await getTotalDailyUsageMinutes(row.user_email, requestDate, bookingId);
          const usedToday = usageData.totalMinutes;
          
          let overageMinutes = 0;
          
          // Unlimited tiers (999+ minutes) pay nothing
          if (isUnlimited) {
            fee = 0;
            feeNote = 'Included in membership';
            overageMinutes = 0;
          } else if (isSocialTier) {
            // Social tier pays for ALL their minutes (no included time)
            overageMinutes = perPersonMins;
            const overageBlocks = Math.ceil(perPersonMins / 30);
            fee = overageBlocks * 25;
            feeNote = fee > 0 ? `Social tier - $${fee} (${perPersonMins} min)` : 'Included';
          } else if (dailyAllowance > 0) {
            // Other tiers: check what they've used today + this booking's portion
            overageMinutes = Math.max(0, (usedToday + perPersonMins) - dailyAllowance);
            const overageBlocks = Math.ceil(overageMinutes / 30);
            fee = overageBlocks * 25;
            feeNote = fee > 0 ? `${tier} - $${fee} (overage)` : 'Included in membership';
          } else {
            // No daily allowance = pay as you go
            overageMinutes = perPersonMins;
            const overageBlocks = Math.ceil(perPersonMins / 30);
            fee = overageBlocks * 25;
            feeNote = `Pay-as-you-go - $${fee}`;
          }
          
          // Build feeBreakdown for frontend
          feeBreakdown = {
            perPersonMins,
            dailyAllowance,
            usedToday,
            overageMinutes,
            fee,
            isUnlimited,
            isSocialTier
          };
        }
      }
      
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
        feeBreakdown
      };
    }));
    
    // Calculate fee for each guest, tracking guest passes used for THIS booking
    let guestPassesAvailable = ownerGuestPassesRemaining;
    let guestPassesUsedThisBooking = 0;
    const guestsWithFees = guestsResult.rows.map(row => {
      let fee: number;
      let feeNote: string;
      let usedGuestPass = false;
      
      if (guestPassesAvailable > 0) {
        fee = 0;
        feeNote = 'Guest Pass Used';
        guestPassesAvailable--;
        guestPassesUsedThisBooking++;
        usedGuestPass = true;
      } else {
        fee = 25;
        feeNote = 'No passes - $25 due';
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
    
    // Calculate remaining passes after this booking's deduction
    // Note: This will be recalculated if session data overrides guestPassesUsedThisBooking
    let guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
    
    // Build tier metadata for the response
    const dailyAllowance = ownerTierLimits?.daily_sim_minutes || 0;
    const isUnlimitedTier = dailyAllowance >= 999 || (ownerTierLimits?.unlimited_access ?? false);
    const allowanceText = isUnlimitedTier 
      ? 'Unlimited simulator access' 
      : dailyAllowance > 0 
        ? `${dailyAllowance} minutes/day included`
        : 'Pay-as-you-go';
    
    // Calculate financial summary for display
    // When session_id exists, use the authoritative participant fees from booking_participants
    // This ensures the summary matches what's shown in the Check-In & Billing modal
    let ownerOverageFee = 0;
    let guestFeesWithoutPass = 0;
    let totalPlayersOwe = 0;
    let playerBreakdownFromSession: Array<{ name: string; tier: string | null; fee: number; feeNote: string }> = [];
    
    const sessionId = bookingResult.rows[0]?.session_id;
    if (sessionId) {
      // Get actual participant fees from booking_participants (authoritative source)
      const participantsResult = await pool.query(`
        SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.user_id,
          bp.used_guest_pass,
          u.tier as user_tier,
          u.email as user_email
        FROM booking_participants bp
        LEFT JOIN users u ON u.id = bp.user_id
        WHERE bp.session_id = $1
        ORDER BY bp.participant_type, bp.created_at
      `, [sessionId]);
      
      if (participantsResult.rows.length > 0) {
        const allParticipantIds = participantsResult.rows.map(p => p.participant_id);
        const feeResult = await calculateAndCacheParticipantFees(sessionId, allParticipantIds);
        
        const feeMap = new Map<number, number>();
        for (const f of feeResult.fees) {
          feeMap.set(f.participantId, f.amountCents / 100);
        }
        
        // Build email-to-fee map to update membersWithFees array
        const emailToFeeMap = new Map<string, { fee: number; feeNote: string }>();
        
        for (const p of participantsResult.rows) {
          const participantFee = feeMap.get(p.participant_id) || 0;
          const email = p.user_email?.toLowerCase();
          
          if (p.participant_type === 'owner') {
            ownerOverageFee = participantFee;
            if (email) {
              emailToFeeMap.set(email, {
                fee: participantFee,
                feeNote: participantFee > 0 ? 'Overage fee' : 'Within daily allowance'
              });
            }
          } else if (p.participant_type === 'member') {
            totalPlayersOwe += participantFee;
            playerBreakdownFromSession.push({
              name: p.display_name || 'Unknown Member',
              tier: p.user_tier || null,
              fee: participantFee,
              feeNote: participantFee > 0 ? 'Overage fee' : 'Within allowance'
            });
            if (email) {
              emailToFeeMap.set(email, {
                fee: participantFee,
                feeNote: participantFee > 0 ? 'Overage fee' : 'Within daily allowance'
              });
            }
          } else if (p.participant_type === 'guest') {
            // Only count guest fees if the participant has no user_id (actual guest, not a linked member)
            // Members who were incorrectly marked as guests should not incur guest fees
            if (!p.user_id && !p.used_guest_pass && participantFee > 0) {
              guestFeesWithoutPass += participantFee;
            }
          }
        }
        
        // Update membersWithFees with authoritative session-based fees
        for (const member of membersWithFees) {
          if (member.userEmail) {
            const sessionFeeData = emailToFeeMap.get(member.userEmail.toLowerCase());
            if (sessionFeeData) {
              member.fee = sessionFeeData.fee;
              member.feeNote = sessionFeeData.feeNote;
            }
          }
        }
        
        // Also update guestsWithFees from session data for guest participants
        const guestParticipants = participantsResult.rows.filter(p => p.participant_type === 'guest');
        for (let i = 0; i < guestsWithFees.length && i < guestParticipants.length; i++) {
          const gp = guestParticipants[i];
          const participantFee = feeMap.get(gp.participant_id) || 0;
          guestsWithFees[i].fee = participantFee;
          guestsWithFees[i].usedGuestPass = gp.used_guest_pass || false;
          guestsWithFees[i].feeNote = gp.used_guest_pass ? 'Guest Pass Used' : (participantFee > 0 ? 'No passes - $25 due' : 'No charge');
        }
        
        // Recalculate guest pass counts from session data
        guestPassesUsedThisBooking = guestParticipants.filter(gp => gp.used_guest_pass).length;
        guestPassesRemainingAfterBooking = ownerGuestPassesRemaining - guestPassesUsedThisBooking;
      }
    } else {
      // Fallback to calculated fees for legacy bookings without session_id
      const ownerMember = membersWithFees.find(m => m.isPrimary);
      const nonOwnerMembers = membersWithFees.filter(m => !m.isPrimary && m.userEmail);
      guestFeesWithoutPass = guestsWithFees.filter(g => !g.usedGuestPass).reduce((sum, g) => sum + g.fee, 0);
      ownerOverageFee = ownerMember?.fee || 0;
      totalPlayersOwe = nonOwnerMembers.reduce((sum, m) => sum + m.fee, 0);
      playerBreakdownFromSession = nonOwnerMembers.map(m => ({
        name: m.memberName,
        tier: m.tier,
        fee: m.fee,
        feeNote: m.feeNote
      }));
    }
    
    const totalOwnerOwes = ownerOverageFee + guestFeesWithoutPass;
    
    res.json({
      ownerGuestPassesRemaining,
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
        emptySlots: membersResult.rows.filter(row => !row.user_email).length
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
        totalOwnerOwes,
        totalPlayersOwe,
        grandTotal: totalOwnerOwes + totalPlayersOwe,
        playerBreakdown: playerBreakdownFromSession
      }
    });
  } catch (error: any) {
    console.error('Get booking members error:', error);
    res.status(500).json({ error: 'Failed to get booking members' });
  }
});

// Link a member to an empty slot
router.put('/api/admin/booking/:bookingId/members/:slotId/link', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    const { memberEmail } = req.body;
    const linkedBy = (req as any).session?.user?.email || 'admin';
    
    if (!memberEmail) {
      return res.status(400).json({ error: 'memberEmail is required' });
    }
    
    // Check if the slot exists and is empty
    const slotResult = await pool.query(
      `SELECT * FROM booking_members WHERE id = $1 AND booking_id = $2`,
      [slotId, bookingId]
    );
    
    if (slotResult.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    
    const slot = slotResult.rows[0];
    if (slot.user_email) {
      // Check if already linked to the SAME member (idempotent)
      if (slot.user_email.toLowerCase() === memberEmail.toLowerCase()) {
        return res.json({ success: true, message: 'Member already linked to this slot' });
      }
      return res.status(400).json({ error: 'Slot is already linked to a different member' });
    }
    
    // Update the slot with the member email
    await pool.query(
      `UPDATE booking_members 
       SET user_email = $1, linked_at = NOW(), linked_by = $2 
       WHERE id = $3`,
      [memberEmail.toLowerCase(), linkedBy, slotId]
    );
    
    // Get booking details for notification and sync with booking_participants
    const bookingResult = await pool.query(
      `SELECT request_date, start_time, status, session_id FROM booking_requests WHERE id = $1`,
      [bookingId]
    );
    
    // Sync with booking_participants for RosterManager display
    if (bookingResult.rows[0]?.session_id) {
      const sessionId = bookingResult.rows[0].session_id;
      
      // Get member display name
      const memberInfo = await pool.query(
        `SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
        [memberEmail]
      );
      const displayName = memberInfo.rows[0] 
        ? `${memberInfo.rows[0].first_name} ${memberInfo.rows[0].last_name}`.trim()
        : memberEmail;
      
      // Check if member already exists in booking_participants
      const existingParticipant = await pool.query(
        `SELECT id FROM booking_participants WHERE session_id = $1 AND user_id = $2`,
        [sessionId, memberEmail.toLowerCase()]
      );
      
      if (existingParticipant.rowCount === 0) {
        // Check if there's a guest entry with matching name that should be converted
        // This handles cases where someone was added as guest but is actually a member
        const matchingGuest = await pool.query(
          `SELECT bp.id, bp.display_name, g.email as guest_email
           FROM booking_participants bp
           LEFT JOIN guests g ON bp.guest_id = g.id
           WHERE bp.session_id = $1 
             AND bp.participant_type = 'guest'
             AND (LOWER(bp.display_name) = LOWER($2) OR LOWER(g.email) = LOWER($3))`,
          [sessionId, displayName, memberEmail]
        );
        
        if (matchingGuest.rowCount && matchingGuest.rowCount > 0) {
          // Remove the guest entry since this person is actually a member (no guest fee needed)
          const guestIds = matchingGuest.rows.map(r => r.id);
          await pool.query(
            `DELETE FROM booking_participants WHERE id = ANY($1)`,
            [guestIds]
          );
          console.log(`[Link Member] Removed ${guestIds.length} duplicate guest entries for member ${memberEmail} in session ${sessionId}`);
        }
        
        // Add to booking_participants as member
        await pool.query(
          `INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, invite_status)
           VALUES ($1, $2, 'member', $3, 'pending', 'confirmed')`,
          [sessionId, memberEmail.toLowerCase(), displayName]
        );
      }
    }
    
    // Send notification for future bookings
    if (bookingResult.rows[0]) {
      const booking = bookingResult.rows[0];
      const bookingDate = booking.request_date;
      const now = new Date();
      const bookingDateTime = new Date(`${bookingDate}T${booking.start_time}`);
      
      if (bookingDateTime > now && booking.status === 'approved') {
        // Insert notification
        const notificationMessage = `You've been added to a simulator booking on ${new Date(bookingDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`;
        
        await pool.query(
          `INSERT INTO notifications (user_email, title, message, type, related_id, related_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            memberEmail.toLowerCase(),
            'Added to Booking',
            notificationMessage,
            'booking_approved',
            bookingId,
            'booking_request'
          ]
        );
        
        // Send push notification (non-blocking)
        sendPushNotification(memberEmail.toLowerCase(), {
          title: 'Added to Booking',
          body: notificationMessage,
          tag: `booking-linked-${bookingId}`
        }).catch(() => {});
      }
    }
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} linked to slot` 
    });
  } catch (error: any) {
    console.error('Link member error:', error);
    res.status(500).json({ error: 'Failed to link member to slot' });
  }
});

// Unlink a member from a slot
router.put('/api/admin/booking/:bookingId/members/:slotId/unlink', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    
    // Check if the slot exists
    const slotResult = await pool.query(
      `SELECT * FROM booking_members WHERE id = $1 AND booking_id = $2`,
      [slotId, bookingId]
    );
    
    if (slotResult.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    
    const slot = slotResult.rows[0];
    if (slot.is_primary) {
      return res.status(400).json({ error: 'Cannot unlink the primary member' });
    }
    
    const unlinkedEmail = slot.user_email;
    
    // Clear the slot
    await pool.query(
      `UPDATE booking_members 
       SET user_email = NULL, linked_at = NULL, linked_by = NULL 
       WHERE id = $1`,
      [slotId]
    );
    
    // Sync with booking_participants - remove the member if they were added via link
    if (unlinkedEmail) {
      const bookingResult = await pool.query(
        `SELECT session_id FROM booking_requests WHERE id = $1`,
        [bookingId]
      );
      
      if (bookingResult.rows[0]?.session_id) {
        await pool.query(
          `DELETE FROM booking_participants 
           WHERE session_id = $1 AND user_id = $2 AND participant_type = 'member'`,
          [bookingResult.rows[0].session_id, unlinkedEmail.toLowerCase()]
        );
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Member unlinked from slot' 
    });
  } catch (error: any) {
    console.error('Unlink member error:', error);
    res.status(500).json({ error: 'Failed to unlink member from slot' });
  }
});

// Add a guest to a booking (deducts guest pass from owner)
router.post('/api/admin/booking/:bookingId/guests', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { guestName, slotId, forceAddAsGuest } = req.body;
    const sessionUser = (req as any).session?.user;
    const staffEmail = sessionUser?.email || 'staff';
    
    if (!guestName || !guestName.trim()) {
      return res.status(400).json({ error: 'Guest name is required' });
    }
    
    // LOOPHOLE FIX: Check if this "guest" is actually a known member
    // This prevents adding members as guests to avoid their tier-based fees
    if (!forceAddAsGuest) {
      const memberCheck = await pool.query(
        `SELECT email, first_name, last_name, tier, membership_status 
         FROM users 
         WHERE LOWER(first_name || ' ' || last_name) = LOWER($1)
            OR LOWER(first_name) = LOWER($1)
            OR (LOWER(first_name || ' ' || LEFT(last_name, 1)) = LOWER($1))
         LIMIT 1`,
        [guestName.trim()]
      );
      
      if (memberCheck.rows.length > 0) {
        const matchedMember = memberCheck.rows[0];
        const tierFeeNote = matchedMember.tier?.toLowerCase() === 'social' 
          ? 'Social tier members pay $25/30min for their time' 
          : 'Member fees are based on their tier';
        
        return res.status(409).json({
          error: 'This person appears to be a member',
          memberMatch: {
            email: matchedMember.email,
            name: `${matchedMember.first_name} ${matchedMember.last_name}`,
            tier: matchedMember.tier,
            status: matchedMember.membership_status,
            note: tierFeeNote
          },
          suggestion: 'Add them as a member to apply proper tier-based billing. If this is truly a different person, use "forceAddAsGuest: true".'
        });
      }
    }
    
    // Get booking info for owner email
    const bookingResult = await pool.query(
      `SELECT br.user_email, br.request_date, br.start_time, br.session_id
       FROM booking_requests br 
       WHERE br.id = $1`,
      [bookingId]
    );
    
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = bookingResult.rows[0];
    const ownerEmail = booking.user_email?.toLowerCase();
    
    // Check if booking is in the future (for notifications)
    const isUpcoming = (() => {
      const now = new Date();
      const bookingDate = new Date(booking.request_date + 'T' + booking.start_time);
      return bookingDate > now;
    })();
    
    // Try to deduct a guest pass from the booking owner
    const { useGuestPass, getGuestPassesRemaining } = await import('./guestPasses');
    const guestEmail = req.body.guestEmail?.trim() || null;
    
    // Check how many passes the owner has remaining
    let passesRemaining = await getGuestPassesRemaining(ownerEmail);
    let usedGuestPass = false;
    let guestFee = 0;
    let finalPassesRemaining = passesRemaining;
    
    if (passesRemaining > 0) {
      // Try to use a guest pass (free)
      const guestPassResult = await useGuestPass(ownerEmail, guestName.trim(), isUpcoming);
      if (guestPassResult.success) {
        usedGuestPass = true;
        guestFee = 0;
        // useGuestPass returns the remaining count AFTER deduction - use directly
        finalPassesRemaining = typeof guestPassResult.remaining === 'number' 
          ? guestPassResult.remaining 
          : passesRemaining - 1;
      } else {
        // Pass deduction failed (e.g., concurrency issue) - charge $25 fee instead
        process.stderr.write(`[Staff Add Guest] Pass deduction failed for ${ownerEmail} despite ${passesRemaining} remaining. Charging $25 fee. Error: ${guestPassResult.error}\n`);
        usedGuestPass = false;
        guestFee = 25;
        // Re-fetch to get the accurate count after failure
        finalPassesRemaining = await getGuestPassesRemaining(ownerEmail);
      }
    } else {
      // No guest passes - guest will be charged $25
      usedGuestPass = false;
      guestFee = 25;
      finalPassesRemaining = 0;
    }
    
    // Wrap all DB operations in a transaction for atomicity
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Add guest to booking_guests table
      const nextSlotResult = await client.query(
        `SELECT COALESCE(MAX(slot_number), 0) + 1 as next_slot FROM booking_guests WHERE booking_id = $1`,
        [bookingId]
      );
      const nextSlot = nextSlotResult.rows[0].next_slot;
      
      await client.query(
        `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, guestName.trim(), guestEmail, nextSlot]
      );
      
      // Create purchase history record for transparency
      const saleId = `guest_${bookingId}_${Date.now()}`;
      const bookingDate = new Date(booking.request_date + 'T' + booking.start_time);
      
      if (usedGuestPass) {
        // Create $0.00 "Guest Pass Redemption" entry
        await client.query(
          `INSERT INTO legacy_purchases (mindbody_client_id, member_email, mindbody_sale_id, line_number, item_name, item_category, item_price_cents, quantity, subtotal_cents, discount_amount_cents, tax_cents, item_total_cents, payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, import_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [ownerEmail, ownerEmail, saleId, 1, `Guest Pass Redemption: ${guestName.trim()}`, 'guest_pass_redemption', 0, 1, 0, 0, 0, 0, 'guest_pass', bookingDate, booking.session_id, true, false, `staff_checkin_${bookingId}`]
        );
        process.stderr.write(`[Staff Add Guest] Created $0.00 guest pass redemption record for ${ownerEmail}\n`);
      } else if (guestFee > 0) {
        // Create $25 guest fee entry
        await client.query(
          `INSERT INTO legacy_purchases (mindbody_client_id, member_email, mindbody_sale_id, line_number, item_name, item_category, item_price_cents, quantity, subtotal_cents, discount_amount_cents, tax_cents, item_total_cents, payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, import_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [ownerEmail, ownerEmail, saleId, 1, `Guest Simulator Fee: ${guestName.trim()}`, 'guest_sim_fee', guestFee * 100, 1, guestFee * 100, 0, 0, guestFee * 100, 'pending', bookingDate, booking.session_id, false, false, `staff_checkin_${bookingId}`]
        );
        process.stderr.write(`[Staff Add Guest] Created $${guestFee} guest fee record for ${ownerEmail}\n`);
      }
      
      // If there's a slot ID provided, clear that slot since we're using a guest instead
      if (slotId) {
        await client.query(
          `DELETE FROM booking_members WHERE id = $1 AND booking_id = $2 AND is_primary = false AND user_email IS NULL`,
          [slotId, bookingId]
        );
      }
      
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
    
    const feeMessage = usedGuestPass 
      ? `Guest pass used. ${finalPassesRemaining} pass${finalPassesRemaining !== 1 ? 'es' : ''} remaining.`
      : guestFee > 0 ? `$${guestFee} guest fee applies.` : 'Guest added.';
    
    process.stderr.write(`[Staff Add Guest] Added guest "${guestName}" to booking ${bookingId}. Pass used: ${usedGuestPass}, Fee: $${guestFee}, Remaining passes: ${finalPassesRemaining}\n`);
    
    res.json({ 
      success: true, 
      message: `Guest "${guestName}" added. ${feeMessage}`,
      guestPassesRemaining: finalPassesRemaining,
      usedGuestPass,
      guestFee
    });
  } catch (error: any) {
    console.error('Add guest error:', error);
    res.status(500).json({ error: 'Failed to add guest' });
  }
});

// GET /api/admin/trackman/needs-players - Returns bookings with unfilled player slots
router.get('/api/admin/trackman/needs-players', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim().toLowerCase();
    
    // Find Trackman bookings with multi-player counts that have unfilled slots
    // Multi-player = trackman_player_count > 1
    // Unfilled = participant count < trackman_player_count
    let whereClause = `
      (br.trackman_booking_id IS NOT NULL OR br.notes LIKE '%[Trackman Import ID:%')
      AND br.status NOT IN ('cancelled', 'declined')
      AND COALESCE(br.trackman_player_count, 1) > 1
      AND (
        br.session_id IS NULL
        OR (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id) < COALESCE(br.trackman_player_count, 1)
      )
    `;
    const queryParams: any[] = [];
    
    if (search) {
      whereClause += ` AND (LOWER(br.user_name) LIKE $1 OR LOWER(br.user_email) LIKE $1 OR LOWER(u.first_name || ' ' || u.last_name) LIKE $1)`;
      queryParams.push(`%${search}%`);
    }
    
    const countResult = await pool.query(
      `SELECT COUNT(*) as total 
       FROM booking_requests br 
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email) 
       WHERE ${whereClause}`,
      queryParams
    );
    const totalCount = parseInt(countResult.rows[0].total, 10);
    
    const limitParam = queryParams.length + 1;
    const offsetParam = queryParams.length + 2;
    
    const result = await pool.query(
      `SELECT 
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
        br.guest_count,
        br.trackman_player_count,
        br.session_id,
        br.created_at,
        u.first_name as member_first_name,
        u.last_name as member_last_name,
        u.email as member_email,
        COALESCE(br.trackman_player_count, 1) as total_slots,
        -- Count filled slots: use booking_participants if session exists, otherwise count owner + non-primary members
        -- Guests without email are NOT counted as filled (slot shows unfilled until email is added)
        CASE 
          WHEN br.session_id IS NOT NULL THEN
            COALESCE((
              SELECT COUNT(*) FROM booking_participants bp 
              LEFT JOIN guests g ON g.id = bp.guest_id
              WHERE bp.session_id = br.session_id
                AND (bp.participant_type != 'guest' OR (bp.participant_type = 'guest' AND g.email IS NOT NULL AND g.email != ''))
            ), 0)
          ELSE
            -- No session: count owner as 1 if real email, plus non-primary booking_members
            CASE 
              WHEN br.user_email IS NOT NULL 
                   AND br.user_email NOT LIKE 'unmatched-%@%' 
                   AND br.user_email NOT LIKE '%unmatched@%'
              THEN 1
              ELSE 0
            END + COALESCE((SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NOT NULL AND bm.user_email != '' AND bm.is_primary = false), 0)
        END as filled_slots,
        (SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = br.id AND bg.guest_email IS NOT NULL AND bg.guest_email != '') as guest_count_actual
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE ${whereClause}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...queryParams, limit, offset]
    );
    
    const data = result.rows.map(row => {
      const totalSlots = parseInt(row.total_slots) || 1;
      const filledSlots = parseInt(row.filled_slots) || 0;
      const emptySlots = Math.max(0, totalSlots - filledSlots);
      const actualGuests = parseInt(row.guest_count_actual) || 0;
      const legacyGuests = parseInt(row.guest_count) || 0;
      const effectiveGuests = actualGuests > 0 ? actualGuests : legacyGuests;
      
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
        guestCount: row.guest_count,
        createdAt: row.created_at,
        member: row.member_email ? {
          email: row.member_email,
          firstName: row.member_first_name,
          lastName: row.member_last_name,
          fullName: [row.member_first_name, row.member_last_name].filter(Boolean).join(' ')
        } : null,
        // Flattened slot info (Task 6A)
        totalSlots,
        filledSlots,
        emptySlots,
        guestCount: effectiveGuests,
        assignedCount: filledSlots + effectiveGuests,
        playerCount: totalSlots,
        expectedPlayerCount: totalSlots,
        // Keep slotInfo for backward compatibility
        slotInfo: {
          totalSlots,
          filledSlots,
          emptySlots,
          guestCount: effectiveGuests,
          expectedPlayerCount: totalSlots
        }
      };
    });
    
    res.json({ data, totalCount });
  } catch (error: any) {
    console.error('Fetch needs-players bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings needing players' });
  }
});

// Helper function to convert time to minutes
function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  return hours * 60 + minutes;
}

// GET /api/admin/trackman/potential-matches - Returns unmatched bookings with potential app booking matches
router.get('/api/admin/trackman/potential-matches', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    
    // Get unresolved unmatched bookings
    const unmatchedResult = await pool.query(
      `SELECT 
        tub.id,
        tub.trackman_booking_id,
        tub.user_name,
        tub.original_email,
        TO_CHAR(tub.booking_date, 'YYYY-MM-DD') as booking_date,
        tub.start_time,
        tub.end_time,
        tub.bay_number,
        tub.player_count,
        tub.status,
        tub.notes,
        tub.created_at
       FROM trackman_unmatched_bookings tub
       WHERE tub.resolved_at IS NULL
       ORDER BY tub.booking_date DESC, tub.start_time DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    // For each unmatched booking, check if there's a potential match in app bookings
    const potentialMatches: any[] = [];
    
    for (const unmatched of unmatchedResult.rows) {
      // Find app bookings with same bay + date that are within 5 min tolerance
      const appBookingsResult = await pool.query(
        `SELECT 
          br.id,
          br.user_email,
          br.user_name,
          br.start_time,
          br.end_time,
          br.status,
          br.trackman_booking_id,
          u.first_name,
          u.last_name
         FROM booking_requests br
         LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
         WHERE br.request_date = $1
           AND br.resource_id = $2
           AND br.status NOT IN ('cancelled', 'declined')
           AND br.trackman_booking_id IS NULL`,
        [unmatched.booking_date, parseInt(unmatched.bay_number) || null]
      );
      
      // Filter for time tolerance (±5 minutes)
      const unmatchedMins = timeToMinutes(unmatched.start_time || '00:00');
      const matchingBookings = appBookingsResult.rows.filter(booking => {
        const bookingMins = timeToMinutes(booking.start_time || '00:00');
        return Math.abs(unmatchedMins - bookingMins) <= 5;
      });
      
      if (matchingBookings.length > 0) {
        potentialMatches.push({
          unmatched: {
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
          potentialAppBookings: matchingBookings.map(b => ({
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
    
    // Get total count of unmatched with potential matches (for pagination)
    const totalCount = potentialMatches.length;
    
    res.json({ data: potentialMatches, totalCount });
  } catch (error: any) {
    console.error('Fetch potential-matches error:', error);
    res.status(500).json({ error: 'Failed to fetch potential matches' });
  }
});

// Data reset endpoint - wipes all Trackman-imported booking data for clean re-import
router.delete('/api/admin/trackman/reset-data', isStaffOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = (req as any).session?.user?.email || 'admin';
    
    await client.query('BEGIN');
    
    // Get counts before deletion for logging
    const bookingCount = await client.query(
      `SELECT COUNT(*) FROM booking_requests WHERE trackman_booking_id IS NOT NULL`
    );
    const sessionCount = await client.query(
      `SELECT COUNT(*) FROM booking_sessions WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL`
    );
    const unmatchedCount = await client.query(
      `SELECT COUNT(*) FROM trackman_unmatched_bookings`
    );
    
    // Delete in correct order to respect foreign key constraints
    
    // 1. Delete usage_ledger entries for Trackman sessions
    await client.query(`
      DELETE FROM usage_ledger 
      WHERE session_id IN (
        SELECT id FROM booking_sessions 
        WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
      )
    `);
    
    // 2. Delete booking_payment_audit entries for Trackman bookings
    await client.query(`
      DELETE FROM booking_payment_audit 
      WHERE booking_id IN (
        SELECT id FROM booking_requests 
        WHERE trackman_booking_id IS NOT NULL
      )
    `);
    
    // 3. Delete booking_participants for Trackman sessions
    await client.query(`
      DELETE FROM booking_participants 
      WHERE session_id IN (
        SELECT id FROM booking_sessions 
        WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
      )
    `);
    
    // 4. Delete booking_members for Trackman bookings (legacy table)
    await client.query(`
      DELETE FROM booking_members 
      WHERE booking_id IN (
        SELECT id FROM booking_requests 
        WHERE trackman_booking_id IS NOT NULL
      )
    `);
    
    // 5. Delete booking_sessions for Trackman imports
    await client.query(`
      DELETE FROM booking_sessions 
      WHERE source = 'trackman_import' OR trackman_booking_id IS NOT NULL
    `);
    
    // 6. Delete booking_requests with trackman_booking_id
    await client.query(`
      DELETE FROM booking_requests 
      WHERE trackman_booking_id IS NOT NULL
    `);
    
    // 7. Clear trackman_unmatched_bookings
    await client.query(`DELETE FROM trackman_unmatched_bookings`);
    
    // 8. Clear trackman_import_runs history
    await client.query(`DELETE FROM trackman_import_runs`);
    
    await client.query('COMMIT');
    
    console.log(`[Trackman Reset] Data wiped by ${user}: ${bookingCount.rows[0].count} bookings, ${sessionCount.rows[0].count} sessions, ${unmatchedCount.rows[0].count} unmatched`);
    
    res.json({
      success: true,
      message: 'Trackman data reset complete',
      deleted: {
        bookings: parseInt(bookingCount.rows[0].count),
        sessions: parseInt(sessionCount.rows[0].count),
        unmatched: parseInt(unmatchedCount.rows[0].count)
      }
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Trackman reset error:', error);
    res.status(500).json({ error: 'Failed to reset Trackman data: ' + error.message });
  } finally {
    client.release();
  }
});

// Task 6E: Fuzzy match API endpoint for partial names
router.get('/api/admin/trackman/fuzzy-matches/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the unmatched booking
    const unmatchedResult = await pool.query(
      `SELECT id, user_name, original_email, notes, match_attempt_reason
       FROM trackman_unmatched_bookings
       WHERE id = $1`,
      [id]
    );
    
    if (unmatchedResult.rowCount === 0) {
      return res.status(404).json({ error: 'Unmatched booking not found' });
    }
    
    const unmatched = unmatchedResult.rows[0];
    const userName = (unmatched.user_name || '').toLowerCase().trim();
    
    if (!userName) {
      return res.json({ suggestions: [], message: 'No name to match against' });
    }
    
    // Split name into parts for fuzzy matching
    const nameParts = userName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    
    // Find potential matches using ILIKE for case-insensitive partial matching
    let suggestions: any[] = [];
    
    if (firstName && lastName) {
      // Try first name + last name combo
      const result = await pool.query(
        `SELECT id, email, first_name, last_name, membership_status, trackman_email
         FROM users
         WHERE (
           (LOWER(first_name) LIKE $1 AND LOWER(last_name) LIKE $2)
           OR (LOWER(first_name) LIKE $2 AND LOWER(last_name) LIKE $1)
           OR LOWER(first_name || ' ' || last_name) LIKE $3
           OR LOWER(last_name || ' ' || first_name) LIKE $3
         )
         AND membership_status IS NOT NULL
         ORDER BY 
           CASE WHEN membership_status = 'active' THEN 0 ELSE 1 END,
           first_name, last_name
         LIMIT 10`,
        [`%${firstName}%`, `%${lastName}%`, `%${userName}%`]
      );
      suggestions = result.rows;
    } else if (firstName) {
      // Try just first name or last name
      const result = await pool.query(
        `SELECT id, email, first_name, last_name, membership_status, trackman_email
         FROM users
         WHERE (LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1)
         AND membership_status IS NOT NULL
         ORDER BY 
           CASE WHEN membership_status = 'active' THEN 0 ELSE 1 END,
           first_name, last_name
         LIMIT 10`,
        [`%${firstName}%`]
      );
      suggestions = result.rows;
    }
    
    // Format response
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
  } catch (error: any) {
    console.error('Fuzzy match error:', error);
    res.status(500).json({ error: 'Failed to find fuzzy matches' });
  }
});

// Calculate match score for ranking fuzzy matches
function calculateMatchScore(searchName: string, firstName: string | null, lastName: string | null): number {
  const search = searchName.toLowerCase().trim();
  const first = (firstName || '').toLowerCase().trim();
  const last = (lastName || '').toLowerCase().trim();
  const full = `${first} ${last}`.trim();
  
  // Exact match
  if (search === full) return 100;
  
  // Partial matches
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
  
  return Math.min(score, 99); // Cap at 99 to distinguish from exact match
}

// Task 6E: Get unmatched bookings that require review (fuzzy match candidates)
router.get('/api/admin/trackman/requires-review', isStaffOrAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const result = await pool.query(
      `SELECT 
        id,
        trackman_booking_id as "trackmanBookingId",
        user_name as "userName",
        original_email as "originalEmail",
        TO_CHAR(booking_date, 'YYYY-MM-DD') as "bookingDate",
        start_time as "startTime",
        end_time as "endTime",
        bay_number as "bayNumber",
        player_count as "playerCount",
        notes,
        match_attempt_reason as "matchAttemptReason",
        created_at as "createdAt"
       FROM trackman_unmatched_bookings
       WHERE resolved_at IS NULL
         AND match_attempt_reason LIKE '%REQUIRES_REVIEW%'
       ORDER BY booking_date DESC, start_time DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    const countResult = await pool.query(
      `SELECT COUNT(*) as total 
       FROM trackman_unmatched_bookings 
       WHERE resolved_at IS NULL 
         AND match_attempt_reason LIKE '%REQUIRES_REVIEW%'`
    );
    
    res.json({ 
      data: result.rows,
      totalCount: parseInt(countResult.rows[0].total)
    });
  } catch (error: any) {
    console.error('Fetch requires-review error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings requiring review' });
  }
});

// ============================================================================
// Task 7D: Trackman Reconciliation Endpoints
// ============================================================================

router.get('/api/admin/trackman/reconciliation', isStaffOrAdmin, async (req, res) => {
  try {
    const startDate = req.query.start_date as string | undefined;
    const endDate = req.query.end_date as string | undefined;
    const status = req.query.status as 'pending' | 'reviewed' | 'adjusted' | 'all' | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const result = await findAttendanceDiscrepancies({
      startDate,
      endDate,
      status: status || 'all',
      limit,
      offset
    });
    
    res.json({
      discrepancies: result.discrepancies,
      stats: result.stats,
      totalCount: result.totalCount
    });
  } catch (error: any) {
    console.error('Fetch reconciliation discrepancies error:', error);
    res.status(500).json({ error: 'Failed to fetch attendance discrepancies' });
  }
});

router.get('/api/admin/trackman/reconciliation/summary', isStaffOrAdmin, async (req, res) => {
  try {
    const summary = await getReconciliationSummary();
    res.json(summary);
  } catch (error: any) {
    console.error('Fetch reconciliation summary error:', error);
    res.status(500).json({ error: 'Failed to fetch reconciliation summary' });
  }
});

router.put('/api/admin/trackman/reconciliation/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, adjustLedger } = req.body;
    const staffEmail = (req as any).session?.user?.email || 'admin';
    
    if (!status || !['reviewed', 'adjusted'].includes(status)) {
      return res.status(400).json({ 
        error: 'status is required and must be "reviewed" or "adjusted"' 
      });
    }
    
    let result;
    
    if (status === 'adjusted' && adjustLedger) {
      const adjustResult = await adjustLedgerForReconciliation(
        parseInt(id),
        staffEmail,
        notes
      );
      
      if (!adjustResult.success) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      result = { 
        success: true, 
        status: 'adjusted',
        adjustmentAmount: adjustResult.adjustmentAmount 
      };
    } else {
      const reconcileResult = await markAsReconciled(
        parseInt(id),
        staffEmail,
        status,
        notes
      );
      
      if (!reconcileResult.success) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      result = { 
        success: true, 
        status,
        booking: reconcileResult.booking 
      };
    }
    
    res.json(result);
  } catch (error: any) {
    console.error('Update reconciliation error:', error);
    res.status(500).json({ error: 'Failed to update reconciliation status' });
  }
});

export default router;

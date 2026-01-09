import { Router } from 'express';
import { importTrackmanBookings, getUnmatchedBookings, resolveUnmatchedBooking, getImportRuns } from '../core/trackmanImport';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { isAdmin } from '../core/middleware';
import { pool } from '../core/db';
import { sendPushNotification } from './push';

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

router.get('/api/admin/trackman/unmatched', isAdmin, async (req, res) => {
  try {
    const resolved = req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string || '';
    
    const result = await getUnmatchedBookings({ resolved, limit, offset, search });
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching unmatched bookings:', error);
    res.status(500).json({ error: 'Failed to fetch unmatched bookings' });
  }
});

router.get('/api/admin/trackman/unmatched-calendar', isAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }
    
    const result = await pool.query(
      `SELECT 
        id,
        TO_CHAR(booking_date, 'YYYY-MM-DD') as "bookingDate",
        start_time as "startTime",
        end_time as "endTime",
        bay_number as "bayNumber",
        user_name as "userName",
        original_email as "originalEmail"
       FROM trackman_unmatched_bookings
       WHERE resolved_at IS NULL
         AND booking_date >= $1
         AND booking_date <= $2
       ORDER BY booking_date, start_time`,
      [start_date, end_date]
    );
    
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching unmatched bookings for calendar:', error);
    res.status(500).json({ error: 'Failed to fetch unmatched bookings' });
  }
});

router.get('/api/admin/trackman/import-runs', isAdmin, async (req, res) => {
  try {
    const runs = await getImportRuns();
    res.json(runs);
  } catch (error: any) {
    console.error('Error fetching import runs:', error);
    res.status(500).json({ error: 'Failed to fetch import runs' });
  }
});

router.post('/api/admin/trackman/import', isAdmin, async (req, res) => {
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

router.post('/api/admin/trackman/upload', isAdmin, upload.single('file'), async (req, res) => {
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

router.put('/api/admin/trackman/unmatched/:id/resolve', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { memberEmail } = req.body;
    const resolvedBy = (req as any).session?.user?.email || 'admin';
    
    if (!memberEmail) {
      return res.status(400).json({ error: 'memberEmail is required' });
    }
    
    const result = await resolveUnmatchedBooking(parseInt(id), memberEmail, resolvedBy);
    
    if (result.success) {
      res.json({ 
        success: true, 
        resolved: result.resolved,
        autoResolved: result.autoResolved,
        message: result.autoResolved > 0 
          ? `Resolved ${result.resolved} booking(s) (${result.autoResolved} auto-resolved with same email)`
          : 'Booking resolved successfully'
      });
    } else {
      res.status(404).json({ error: 'Unmatched booking not found' });
    }
  } catch (error: any) {
    console.error('Resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve unmatched booking' });
  }
});

router.delete('/api/admin/trackman/linked-email', isAdmin, async (req, res) => {
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

router.get('/api/admin/trackman/matched', isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim().toLowerCase();
    
    // Only return fully resolved bookings:
    // - Solo bookings (no booking_members entries OR only 1 member slot)
    // - OR bookings where ALL player slots are filled (no empty slots)
    let whereClause = `
      (br.trackman_booking_id IS NOT NULL OR br.notes LIKE '%[Trackman Import ID:%')
      AND br.status NOT IN ('cancelled', 'declined')
      AND (
        -- Solo bookings: no booking_members entries
        NOT EXISTS (SELECT 1 FROM booking_members bm WHERE bm.booking_id = br.id)
        -- OR only one member slot (solo)
        OR (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id) = 1
        -- OR all slots are filled (no empty slots)
        OR NOT EXISTS (
          SELECT 1 FROM booking_members bm 
          WHERE bm.booking_id = br.id AND bm.user_email IS NULL
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
        br.created_at,
        u.first_name as member_first_name,
        u.last_name as member_last_name,
        u.email as member_email,
        (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id) as total_slots,
        (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NOT NULL) as filled_slots
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE ${whereClause}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...queryParams, limit, offset]
    );
    
    const data = result.rows.map(row => ({
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
      createdAt: row.created_at,
      member: row.member_email ? {
        email: row.member_email,
        firstName: row.member_first_name,
        lastName: row.member_last_name,
        fullName: [row.member_first_name, row.member_last_name].filter(Boolean).join(' ')
      } : null,
      slotInfo: {
        totalSlots: parseInt(row.total_slots) || 0,
        filledSlots: parseInt(row.filled_slots) || 0,
        isSolo: parseInt(row.total_slots) <= 1,
        isFullyResolved: parseInt(row.total_slots) <= 1 || parseInt(row.filled_slots) === parseInt(row.total_slots)
      }
    }));
    
    res.json({ data, totalCount });
  } catch (error: any) {
    console.error('Fetch matched bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch matched bookings' });
  }
});

router.put('/api/admin/trackman/matched/:id/reassign', isAdmin, async (req, res) => {
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

router.post('/api/admin/trackman/unmatch-member', isAdmin, async (req, res) => {
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
router.get('/api/admin/booking/:id/members', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get guest_count and trackman_player_count from booking_requests
    const bookingResult = await pool.query(
      `SELECT guest_count, trackman_player_count FROM booking_requests WHERE id = $1`,
      [id]
    );
    const legacyGuestCount = bookingResult.rows[0]?.guest_count || 0;
    const trackmanPlayerCount = bookingResult.rows[0]?.trackman_player_count;
    
    const membersResult = await pool.query(
      `SELECT bm.*, u.first_name, u.last_name, u.email as member_email
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
    
    // Expected player count: use Trackman's original value if available, else compute from slots
    // Priority: trackman_player_count > member_slots + guests > legacy guest_count + 1
    const totalMemberSlots = membersResult.rows.length;
    const actualGuestCount = guestsResult.rows.length;
    
    let expectedPlayerCount: number;
    if (trackmanPlayerCount && trackmanPlayerCount > 0) {
      // Trackman import with stored player count - most authoritative
      expectedPlayerCount = trackmanPlayerCount;
    } else if (totalMemberSlots > 0) {
      // Trackman import without stored player count - compute from slots + guests
      expectedPlayerCount = totalMemberSlots + actualGuestCount;
    } else {
      // Legacy booking without booking_members - use legacy formula
      expectedPlayerCount = Math.max(legacyGuestCount + 1, 1);
    }
    
    // For display purposes, use appropriate guest count
    const effectiveGuestCount = actualGuestCount > 0 ? actualGuestCount : legacyGuestCount;
    
    // Count filled slots (members with email assigned)
    const filledMemberSlots = membersResult.rows.filter(row => row.user_email).length;
    // Assigned players = filled member slots + guests
    const actualPlayerCount = filledMemberSlots + effectiveGuestCount;
    
    // Check for player count mismatch (unfilled member slots)
    const playerCountMismatch = actualPlayerCount !== expectedPlayerCount;
    
    res.json({
      members: membersResult.rows.map(row => ({
        id: row.id,
        bookingId: row.booking_id,
        userEmail: row.user_email,
        slotNumber: row.slot_number,
        isPrimary: row.is_primary,
        linkedAt: row.linked_at,
        linkedBy: row.linked_by,
        memberName: row.first_name && row.last_name 
          ? `${row.first_name} ${row.last_name}`
          : row.user_email || 'Empty Slot'
      })),
      guests: guestsResult.rows.map(row => ({
        id: row.id,
        bookingId: row.booking_id,
        guestName: row.guest_name,
        guestEmail: row.guest_email,
        slotNumber: row.slot_number
      })),
      validation: {
        expectedPlayerCount,
        actualPlayerCount,
        totalMemberSlots,
        filledMemberSlots,
        guestCount: effectiveGuestCount,
        playerCountMismatch,
        emptySlots: membersResult.rows.filter(row => !row.user_email).length
      }
    });
  } catch (error: any) {
    console.error('Get booking members error:', error);
    res.status(500).json({ error: 'Failed to get booking members' });
  }
});

// Link a member to an empty slot
router.put('/api/admin/booking/:bookingId/members/:slotId/link', isAdmin, async (req, res) => {
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
      return res.status(400).json({ error: 'Slot is already linked to a member' });
    }
    
    // Update the slot with the member email
    await pool.query(
      `UPDATE booking_members 
       SET user_email = $1, linked_at = NOW(), linked_by = $2 
       WHERE id = $3`,
      [memberEmail.toLowerCase(), linkedBy, slotId]
    );
    
    // Get booking details for notification
    const bookingResult = await pool.query(
      `SELECT request_date, start_time, status FROM booking_requests WHERE id = $1`,
      [bookingId]
    );
    
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
router.put('/api/admin/booking/:bookingId/members/:slotId/unlink', isAdmin, async (req, res) => {
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
    
    // Clear the slot
    await pool.query(
      `UPDATE booking_members 
       SET user_email = NULL, linked_at = NULL, linked_by = NULL 
       WHERE id = $1`,
      [slotId]
    );
    
    res.json({ 
      success: true, 
      message: 'Member unlinked from slot' 
    });
  } catch (error: any) {
    console.error('Unlink member error:', error);
    res.status(500).json({ error: 'Failed to unlink member from slot' });
  }
});

// GET /api/admin/trackman/needs-players - Returns bookings with unfilled player slots
router.get('/api/admin/trackman/needs-players', isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string || '').trim().toLowerCase();
    
    // Find Trackman bookings that have empty slots in booking_members
    // Include past attended bookings (no date filter)
    let whereClause = `
      (br.trackman_booking_id IS NOT NULL OR br.notes LIKE '%[Trackman Import ID:%')
      AND br.status NOT IN ('cancelled', 'declined')
      AND EXISTS (
        SELECT 1 FROM booking_members bm 
        WHERE bm.booking_id = br.id AND bm.user_email IS NULL
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
        br.created_at,
        u.first_name as member_first_name,
        u.last_name as member_last_name,
        u.email as member_email,
        (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id) as total_slots,
        (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NOT NULL) as filled_slots,
        (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NULL) as empty_slots,
        (SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = br.id) as guest_count_actual
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE ${whereClause}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...queryParams, limit, offset]
    );
    
    const data = result.rows.map(row => ({
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
      guestCount: row.guest_count,
      createdAt: row.created_at,
      member: row.member_email ? {
        email: row.member_email,
        firstName: row.member_first_name,
        lastName: row.member_last_name,
        fullName: [row.member_first_name, row.member_last_name].filter(Boolean).join(' ')
      } : null,
      slotInfo: (() => {
        const totalSlots = parseInt(row.total_slots) || 0;
        const actualGuests = parseInt(row.guest_count_actual) || 0;
        const legacyGuests = parseInt(row.guest_count) || 0;
        const filledSlots = parseInt(row.filled_slots) || 0;
        const trackmanCount = row.trackman_player_count ? parseInt(row.trackman_player_count) : null;
        // Priority: trackman_player_count > slots + guests > legacy
        let expectedPlayers: number;
        if (trackmanCount && trackmanCount > 0) {
          expectedPlayers = trackmanCount;
        } else if (totalSlots > 0) {
          expectedPlayers = totalSlots + actualGuests;
        } else {
          expectedPlayers = Math.max(legacyGuests + 1, 1);
        }
        const effectiveGuests = actualGuests > 0 ? actualGuests : legacyGuests;
        return {
          totalSlots,
          filledSlots,
          emptySlots: parseInt(row.empty_slots) || 0,
          guestCount: effectiveGuests,
          expectedPlayerCount: expectedPlayers
        };
      })()
    }));
    
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
router.get('/api/admin/trackman/potential-matches', isAdmin, async (req, res) => {
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

export default router;

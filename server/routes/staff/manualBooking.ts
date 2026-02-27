import { Router } from 'express';
import { pool } from '../../core/db';
import { isStaffOrAdmin } from '../../core/middleware';
import { notifyAllStaff } from '../../core/notificationService';
import { broadcastAvailabilityUpdate } from '../../core/websocket';
import { logFromRequest } from '../../core/auditLog';
import {logAndRespond, logger } from '../../core/logger';
import { formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { db } from '../../db';
import { resources, dayPassPurchases, passRedemptionLogs, bookingRequests } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';

const router = Router();

router.post('/api/staff/manual-booking', isStaffOrAdmin, async (req, res) => {
  try {
    const { 
      user_email, 
      user_name, 
      resource_id, 
      request_date, 
      start_time, 
      duration_minutes,
      declared_player_count,
      request_participants,
      dayPassPurchaseId,
      paymentStatus
    } = req.body;
    const trackman_booking_id_val = req.body.trackman_booking_id;
    const trackman_external_id_val = req.body.trackman_external_id;
    const trackman_id = trackman_booking_id_val || trackman_external_id_val;
    
    if (trackman_id && !/^\d+$/.test(trackman_id)) {
      return res.status(400).json({ 
        error: 'Trackman Booking ID must be a number (e.g., 19510379). UUIDs and other formats are not valid Trackman IDs.' 
      });
    }

    if (trackman_id) {
      const [duplicate] = await db.select({ id: bookingRequests.id, status: bookingRequests.status, userEmail: bookingRequests.userEmail })
        .from(bookingRequests)
        .where(eq(bookingRequests.trackmanBookingId, trackman_id))
        .limit(1);
      
      if (duplicate) {
        const terminalStatuses = ['cancelled', 'cancellation_pending', 'declined', 'no_show'];
        const sameEmail = user_email && duplicate.userEmail &&
          user_email.toLowerCase() === duplicate.userEmail.toLowerCase();

        if (terminalStatuses.includes(duplicate.status || '')) {
          await db.update(bookingRequests)
            .set({ trackmanBookingId: null })
            .where(eq(bookingRequests.id, duplicate.id));
        } else if (sameEmail) {
          const duplicateId = duplicate.id as number;
          await db.update(bookingRequests)
            .set({
              trackmanBookingId: null,
              status: 'declined',
              staffNotes: sql`COALESCE(staff_notes, '') || ' [Auto-declined: Trackman ID re-linked via manual booking for the same member]'`,
              reviewedBy: 'system_relink',
              reviewedAt: sql`NOW()`,
              updatedAt: sql`NOW()`
            })
            .where(eq(bookingRequests.id, duplicateId));

          const orphanedSession = await db.execute(sql`
            SELECT id FROM booking_sessions WHERE id = (
              SELECT session_id FROM booking_requests WHERE id = ${duplicateId}
            )
          `).then(r => (r.rows as Array<Record<string, unknown>>)[0]);

          if (orphanedSession?.id) {
            await db.execute(sql`DELETE FROM booking_sessions WHERE id = ${orphanedSession.id}`);
          }

          logger.info('[ManualBooking] Declined orphaned same-member booking during Trackman re-link', {
            extra: { declinedBookingId: duplicateId, trackmanId: trackman_id }
          });
        } else {
          return res.status(409).json({ 
            error: `Trackman Booking ID ${trackman_id} is already linked to another booking (#${duplicate.id}). Each Trackman booking can only be linked once.` 
          });
        }
      }
    }

    if (!user_email || !request_date || !start_time || !duration_minutes) {
      return res.status(400).json({ error: 'Missing required fields: user_email, request_date, start_time, duration_minutes' });
    }
    
    if (!trackman_id) {
      return res.status(400).json({ error: 'Missing required field: trackman_booking_id (or trackman_external_id)' });
    }
    
    const parsedDate = new Date(request_date + 'T00:00:00');
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    const [year, month, day] = request_date.split('-').map((n: string) => parseInt(n, 10));
    const validatedDate = new Date(year, month - 1, day);
    if (validatedDate.getFullYear() !== year || 
        validatedDate.getMonth() !== month - 1 || 
        validatedDate.getDate() !== day) {
      return res.status(400).json({ error: 'Invalid date - date does not exist (e.g., Feb 30)' });
    }
    
    if (typeof duration_minutes !== 'number' || !Number.isInteger(duration_minutes) || duration_minutes <= 0 || duration_minutes > 480) {
      return res.status(400).json({ error: 'Invalid duration. Must be a whole number between 1 and 480 minutes.' });
    }
    
    const [hours, mins] = start_time.split(':').map(Number);
    const totalMins = hours * 60 + mins + duration_minutes;
    const endHours = Math.floor(totalMins / 60);
    const endMins = totalMins % 60;
    const end_time = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    
    if (endHours >= 24) {
      return res.status(400).json({ error: 'Booking cannot extend past midnight. Please choose an earlier start time or shorter duration.' });
    }
    
    let sanitizedParticipants: Array<{ email: string; type: string; userId?: string; name?: string }> = [];
    if (request_participants && Array.isArray(request_participants)) {
      sanitizedParticipants = request_participants
        .slice(0, 3)
        .map((p: Record<string, unknown>) => ({
          email: typeof p.email === 'string' ? p.email.toLowerCase().trim() : '',
          type: p.type === 'member' ? 'member' : 'guest',
          userId: p.userId != null ? String(p.userId) : undefined,
          name: typeof p.name === 'string' ? p.name.trim() : undefined
        }))
        .filter((p: { email: string; userId?: string }) => p.email || p.userId);
    }
    
    const isDayPassPayment = paymentStatus === 'Paid (Day Pass)' && dayPassPurchaseId;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'staff';
    
    const client = await pool.connect();
    let row: Record<string, unknown> | undefined;
    let dayPassRedeemed = false;
    
    try {
      await client.query('BEGIN');
      
      if (isDayPassPayment) {
        const dayPassResult = await client.query(
          `SELECT id, purchaser_email, redeemed_at, status, remaining_uses, booking_id
           FROM day_pass_purchases 
           WHERE id = $1
           FOR UPDATE`,
          [dayPassPurchaseId]
        );
        
        if (dayPassResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Day pass not found' });
        }
        
        const dayPass = dayPassResult.rows[0];
        
        if (dayPass.purchaser_email.toLowerCase() !== user_email.toLowerCase()) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Day pass belongs to a different user' });
        }
        
        if (dayPass.redeemed_at !== null || dayPass.booking_id !== null) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Day pass has already been redeemed' });
        }
        
        if (dayPass.status === 'redeemed' || (dayPass.remaining_uses !== null && dayPass.remaining_uses <= 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Day pass has already been used' });
        }
      }
      
      await client.query(
        `SELECT id FROM booking_requests 
         WHERE LOWER(user_email) = LOWER($1) 
         AND request_date = $2 
         AND status IN ('pending', 'approved', 'confirmed')
         FOR UPDATE`,
        [user_email, request_date]
      );
      
      if (resource_id) {
        const overlapCheck = await client.query(
          `SELECT id, start_time, end_time FROM booking_requests 
           WHERE resource_id = $1 
           AND request_date = $2 
           AND status IN ('pending', 'pending_approval', 'approved', 'confirmed', 'attended', 'cancellation_pending')
           AND (
             (start_time < $4 AND end_time > $3) OR
             (end_time < start_time AND (start_time < $4 OR end_time > $3))
           )
           FOR UPDATE`,
          [resource_id, request_date, start_time, end_time]
        );
        
        if (overlapCheck.rows.length > 0) {
          const conflict = overlapCheck.rows[0];
          const conflictStart = conflict.start_time?.substring(0, 5);
          const conflictEnd = conflict.end_time?.substring(0, 5);
          await client.query('ROLLBACK');
          const errorMsg = conflictStart && conflictEnd
            ? `This time slot conflicts with an existing booking from ${formatTime12Hour(conflictStart)} to ${formatTime12Hour(conflictEnd)}. Please adjust your time or duration.`
            : 'This time slot is already booked';
          return res.status(409).json({ error: errorMsg });
        }
      }
      
      const bookingStatus = isDayPassPayment ? 'approved' : 'pending';
      
      const insertResult = await client.query(
        `INSERT INTO booking_requests (
          user_email, user_name, resource_id, 
          request_date, start_time, duration_minutes, end_time,
          declared_player_count, request_participants,
          trackman_booking_id, trackman_external_id, origin,
          status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
        RETURNING *`,
        [
          user_email.toLowerCase(),
          user_name || null,
          resource_id || null,
          request_date,
          start_time,
          duration_minutes,
          end_time,
          declared_player_count && declared_player_count >= 1 && declared_player_count <= 4 ? declared_player_count : null,
          sanitizedParticipants.length > 0 ? JSON.stringify(sanitizedParticipants) : '[]',
          trackman_booking_id_val || trackman_external_id_val,
          trackman_external_id_val || null,
          'staff_manual',
          bookingStatus
        ]
      );
      
      const dbRow = insertResult.rows[0];
      const bookingId = dbRow.id;
      
      if (isDayPassPayment) {
        await client.query(
          `UPDATE day_pass_purchases 
           SET redeemed_at = NOW(),
               booking_id = $1,
               status = 'redeemed',
               remaining_uses = 0,
               updated_at = NOW()
           WHERE id = $2`,
          [bookingId, dayPassPurchaseId]
        );
        
        await client.query(
          `INSERT INTO pass_redemption_logs (purchase_id, redeemed_by, location, notes)
           VALUES ($1, $2, 'staff_manual_booking', $3)`,
          [dayPassPurchaseId, staffEmail, `Redeemed via manual booking #${bookingId}`]
        );
        
        dayPassRedeemed = true;
        logger.info('[StaffManualBooking] Day pass redeemed for booking', { extra: { dayPassPurchaseId, bookingId } });
      }
      
      await client.query('COMMIT');
      
      row = {
        id: dbRow.id as number,
        userEmail: dbRow.user_email as string,
        userName: dbRow.user_name as string,
        resourceId: dbRow.resource_id as number,
        requestDate: dbRow.request_date as string,
        startTime: dbRow.start_time as string,
        durationMinutes: dbRow.duration_minutes as number,
        endTime: dbRow.end_time as string,
        status: dbRow.status as string,
        declaredPlayerCount: dbRow.declared_player_count as number,
        requestParticipants: (dbRow.request_participants as unknown as unknown[]) || [],
        trackmanExternalId: dbRow.trackman_external_id as string,
        origin: dbRow.origin as string,
        createdAt: dbRow.created_at,
        updatedAt: dbRow.updated_at
      };

      // Ensure session exists for approved day pass bookings
      if (isDayPassPayment && row.resourceId) {
        try {
          await ensureSessionForBooking({
            bookingId: row.id as number,
            resourceId: row.resourceId as number,
            sessionDate: request_date,
            startTime: start_time,
            endTime: (row.endTime as string) || end_time,
            ownerEmail: user_email.toLowerCase(),
            ownerName: user_name || row.userName || undefined,
            source: 'staff_manual',
            createdBy: 'staff_manual_day_pass'
          });
        } catch (sessionErr: unknown) {
          logger.error('[StaffManualBooking] Failed to ensure session', { extra: { sessionErr } });
        }
      }
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
    let resourceName = 'Bay';
    if (row.resourceId) {
      try {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, row.resourceId as number));
        if (resource?.name) {
          resourceName = resource.name;
        }
      } catch (e: unknown) {
        logger.error('[ManualBooking] Failed to fetch resource name', { extra: { e } });
      }
    }
    
    const dateStr = typeof row.requestDate === 'string' 
      ? row.requestDate 
      : request_date;
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const formattedTime12h = formatTime12Hour(String(row.startTime || '').substring(0, 5) || start_time.substring(0, 5));
    
    const durationMins = row.durationMinutes || duration_minutes;
    let durationDisplay = '';
    if (durationMins) {
      if (Number(durationMins) < 60) {
        durationDisplay = `${durationMins} min`;
      } else {
        const hours = Number(durationMins)/ 60;
        durationDisplay = hours === Math.floor(hours) ? `${hours} hr${hours > 1 ? 's' : ''}` : `${hours.toFixed(1)} hrs`;
      }
    }
    
    const playerCount = declared_player_count && declared_player_count > 1 ? ` (${declared_player_count} players)` : '';
    const dayPassNote = dayPassRedeemed ? ' [Day Pass]' : '';
    
    const staffTitle = 'Staff Manual Booking Created';
    const staffMessage = `${row.userName || row.userEmail}${playerCount} - ${resourceName} on ${formattedDate} at ${formattedTime12h} for ${durationDisplay}${dayPassNote} (Trackman: ${trackman_id})`;
    
    res.status(201).json({
      id: row.id,
      user_email: row.userEmail,
      user_name: row.userName,
      resource_id: row.resourceId,
      request_date: row.requestDate,
      start_time: row.startTime,
      duration_minutes: row.durationMinutes,
      end_time: row.endTime,
      status: row.status,
      declared_player_count: row.declaredPlayerCount,
      request_participants: row.requestParticipants,
      trackman_external_id: row.trackmanExternalId,
      origin: row.origin,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      day_pass_redeemed: dayPassRedeemed,
      day_pass_id: dayPassRedeemed ? dayPassPurchaseId : undefined
    });
    
    try {
      notifyAllStaff(
        staffTitle,
        staffMessage,
        'booking',
        {
          relatedId: row.id as number,
          relatedType: 'booking_request'
        }
      ).catch(err => logger.error('Staff notification failed:', { extra: { err } }));
      
      broadcastAvailabilityUpdate({
        resourceId: (row.resourceId as number) || undefined,
        resourceType: 'simulator',
        date: row.requestDate as string,
        action: 'booked'
      });
      
      logFromRequest(req, 'create_booking', 'booking', String(row.id), (row.userName || row.userEmail) as string, {
        trackman_booking_id: trackman_id,
        origin: 'staff_manual',
        resource_id: row.resourceId,
        request_date: row.requestDate,
        start_time: row.startTime,
        day_pass_id: dayPassRedeemed ? dayPassPurchaseId : undefined,
        payment_status: isDayPassPayment ? 'paid_day_pass' : undefined
      });
    } catch (postCommitError: unknown) {
      logger.error('[StaffManualBooking] Post-commit operations failed', { extra: { postCommitError } });
    }
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to create manual booking', error);
  }
});

export default router;

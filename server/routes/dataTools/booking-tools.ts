import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { isProduction } from '../../core/db';
import { legacyPurchases } from '@shared/schema';
import { eq, sql, and, gte, lte, desc, isNull } from 'drizzle-orm';
import { isAdmin, isStaffOrAdmin } from '../../core/middleware';
import { logBillingAudit } from '../../core/auditLog';
import { getSessionUser } from '../../types/session';
import { safeErrorDetail } from '../../utils/errorUtils';

interface DbBookingSearchRow {
  id: number;
  user_email: string;
  user_name: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  status: string;
  resource_name: string | null;
  reconciliation_status: string | null;
  reconciliation_notes: string | null;
  reconciled_by: string | null;
  reconciled_at: string | null;
}

const router = Router();

router.get('/api/data-tools/unlinked-guest-fees', isAdmin, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    const unlinkedFees = await db.select({
      id: legacyPurchases.id,
      memberEmail: legacyPurchases.memberEmail,
      mindbodyClientId: legacyPurchases.mindbodyClientId,
      itemName: legacyPurchases.itemName,
      itemCategory: legacyPurchases.itemCategory,
      saleDate: legacyPurchases.saleDate,
      itemTotalCents: legacyPurchases.itemTotalCents,
      userId: legacyPurchases.userId,
    })
      .from(legacyPurchases)
      .where(and(
        sql`item_category IN ('guest_pass', 'guest_sim_fee')`,
        isNull(legacyPurchases.linkedBookingSessionId),
        gte(legacyPurchases.saleDate, new Date(startDate as string)),
        lte(legacyPurchases.saleDate, new Date(endDate as string))
      ))
      .orderBy(desc(legacyPurchases.saleDate))
      .limit(100);
    
    const formatted = unlinkedFees.map(fee => ({
      ...fee,
      itemTotal: ((fee.itemTotalCents || 0) / 100).toFixed(2),
      saleDate: fee.saleDate?.toISOString().split('T')[0]
    }));
    
    res.json(formatted);
  } catch (error: unknown) {
    logger.error('[DataTools] Get unlinked guest fees error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get unlinked guest fees', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/available-sessions', isAdmin, async (req: Request, res: Response) => {
  try {
    const { date, memberEmail } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }
    
    const queryBuilder = sql`
      SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.status,
        r.name as resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE br.request_date = ${date}
      AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
    `;
    
    if (memberEmail) {
      queryBuilder.append(sql` AND LOWER(br.user_email) = ${(memberEmail as string).trim().toLowerCase()}`);
    }
    
    queryBuilder.append(sql` ORDER BY br.start_time ASC LIMIT 50`);
    
    const result = await db.execute(queryBuilder);
    
    res.json(result.rows.map((row) => {
      const r = row as unknown as DbBookingSearchRow;
      return {
        id: r.id,
        userEmail: r.user_email,
        userName: r.user_name,
        requestDate: r.request_date,
        startTime: r.start_time,
        endTime: r.end_time,
        status: r.status,
        resourceName: r.resource_name
      };
    }));
  } catch (error: unknown) {
    logger.error('[DataTools] Get available sessions error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get available sessions', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/link-guest-fee', isAdmin, async (req: Request, res: Response) => {
  try {
    const { guestFeeId, bookingId } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!guestFeeId || !bookingId) {
      return res.status(400).json({ error: 'guestFeeId and bookingId are required' });
    }
    
    const existingFee = await db.select()
      .from(legacyPurchases)
      .where(eq(legacyPurchases.id, guestFeeId))
      .limit(1);
    
    if (existingFee.length === 0) {
      return res.status(404).json({ error: 'Guest fee not found' });
    }
    
    const existingBooking = await db.execute(sql`SELECT id, user_email FROM booking_requests WHERE id = ${bookingId}`);
    
    if (existingBooking.rows.length === 0) {
      return res.status(404).json({ error: 'Booking session not found' });
    }
    
    await db.update(legacyPurchases)
      .set({
        linkedBookingSessionId: bookingId,
        linkedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(legacyPurchases.id, guestFeeId));
    
    await logBillingAudit({
      memberEmail: existingFee[0].memberEmail || 'unknown',
      actionType: 'guest_fee_manually_linked',
      actionDetails: {
        source: 'data_tools',
        guestFeeId,
        bookingId,
        itemName: existingFee[0].itemName,
        saleDate: existingFee[0].saleDate
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      logger.info('[DataTools] Linked guest fee to booking by', { extra: { guestFeeId, bookingId, staffEmail } });
    }
    
    res.json({
      success: true,
      message: 'Guest fee successfully linked to booking session'
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Link guest fee error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link guest fee', details: safeErrorDetail(error) });
  }
});

router.get('/api/data-tools/bookings-search', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { date, memberEmail, limit = '50' } = req.query;
    
    if (!date && !memberEmail) {
      return res.status(400).json({ error: 'Either date or memberEmail is required' });
    }
    
    const queryBuilder = sql`
      SELECT 
        br.id,
        br.user_email,
        br.user_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.status,
        br.reconciliation_status,
        br.reconciliation_notes,
        br.reconciled_by,
        br.reconciled_at,
        r.name as resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE 1=1
    `;
    
    if (date) {
      queryBuilder.append(sql` AND br.request_date = ${date}`);
    }
    
    if (memberEmail) {
      queryBuilder.append(sql` AND LOWER(br.user_email) = ${(memberEmail as string).trim().toLowerCase()}`);
    }
    
    queryBuilder.append(sql` ORDER BY br.request_date DESC, br.start_time ASC LIMIT ${parseInt(limit as string, 10) || 50}`);
    
    const result = await db.execute(queryBuilder);
    
    res.json(result.rows.map((row) => {
      const r = row as unknown as DbBookingSearchRow;
      return {
        id: r.id,
        userEmail: r.user_email,
        userName: r.user_name,
        requestDate: r.request_date,
        startTime: r.start_time,
        endTime: r.end_time,
        status: r.status,
        reconciliationStatus: r.reconciliation_status,
        reconciliationNotes: r.reconciliation_notes,
        reconciledBy: r.reconciled_by,
        reconciledAt: r.reconciled_at,
        resourceName: r.resource_name
      };
    }));
  } catch (error: unknown) {
    logger.error('[DataTools] Bookings search error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to search bookings', details: safeErrorDetail(error) });
  }
});

router.post('/api/data-tools/update-attendance', isAdmin, async (req: Request, res: Response) => {
  try {
    const { bookingId, attendanceStatus, notes } = req.body;
    const staffEmail = getSessionUser(req)?.email || 'unknown';
    
    if (!bookingId || !attendanceStatus) {
      return res.status(400).json({ error: 'bookingId and attendanceStatus are required' });
    }
    
    if (!['attended', 'no_show', 'late_cancel', 'pending'].includes(attendanceStatus)) {
      return res.status(400).json({ error: 'Invalid attendance status' });
    }
    
    const existingBooking = await db.execute(sql`SELECT id, user_email, reconciliation_status, reconciliation_notes FROM booking_requests WHERE id = ${bookingId}`);
    
    if (existingBooking.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const bookingRow = existingBooking.rows[0] as { id: number; user_email: string; reconciliation_status: string | null; reconciliation_notes: string | null };
    const previousStatus = bookingRow.reconciliation_status;
    const previousNotes = bookingRow.reconciliation_notes;
    
    await db.execute(sql`UPDATE booking_requests SET 
        reconciliation_status = ${attendanceStatus},
        reconciliation_notes = ${notes || null},
        reconciled_by = ${staffEmail},
        reconciled_at = NOW(),
        updated_at = NOW()
      WHERE id = ${bookingId}`);
    
    await logBillingAudit({
      memberEmail: (bookingRow.user_email as string) || 'unknown',
      actionType: 'attendance_manually_updated',
      previousValue: previousStatus || 'none',
      newValue: attendanceStatus,
      actionDetails: {
        source: 'data_tools',
        bookingId,
        previousNotes,
        newNotes: notes
      },
      performedBy: staffEmail,
      performedByName: staffEmail
    });
    
    if (!isProduction) {
      logger.info('[DataTools] Updated attendance for booking to by', { extra: { bookingId, attendanceStatus, staffEmail } });
    }
    
    res.json({
      success: true,
      message: `Attendance status updated to ${attendanceStatus}`
    });
  } catch (error: unknown) {
    logger.error('[DataTools] Update attendance error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update attendance', details: safeErrorDetail(error) });
  }
});

export default router;

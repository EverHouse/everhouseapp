// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../server/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('drizzle-orm', () => ({
  sql: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ne: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
}));

vi.mock('../server/utils/errorUtils', () => ({
  getErrorMessage: vi.fn((e: unknown) => String(e)),
  getErrorStatusCode: vi.fn(() => 500),
}));

vi.mock('../server/utils/dateUtils', () => ({
  formatNotificationDateTime: vi.fn(() => 'Jan 1 at 10:00 AM'),
  formatDateDisplayWithDay: vi.fn(() => 'Wed, Jan 1'),
  formatTime12Hour: vi.fn(() => '10:00 AM'),
}));

vi.mock('../server/routes/push', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/notificationService', () => ({
  notifyAllStaff: vi.fn().mockResolvedValue(undefined),
  notifyMember: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/bookingEvents', () => ({
  bookingEvents: { publish: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../server/core/websocket', () => ({
  sendNotificationToUser: vi.fn(),
  broadcastAvailabilityUpdate: vi.fn(),
  broadcastBillingUpdate: vi.fn(),
  broadcastMemberStatsUpdated: vi.fn(),
}));

vi.mock('../server/routes/guestPasses', () => ({
  refundGuestPass: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/billing/PaymentStatusService', () => ({
  PaymentStatusService: {
    markPaymentRefunded: vi.fn().mockResolvedValue(undefined),
    markPaymentCancelled: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/core/stripe', () => ({
  cancelPaymentIntent: vi.fn().mockResolvedValue(undefined),
  getStripeClient: vi.fn().mockResolvedValue({
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
    refunds: { create: vi.fn() },
    customers: { createBalanceTransaction: vi.fn() },
  }),
}));

vi.mock('../server/routes/bays/helpers', () => ({
  getCalendarNameForBayAsync: vi.fn().mockResolvedValue(null),
}));

vi.mock('../server/core/calendar/index', () => ({
  getCalendarIdByName: vi.fn().mockResolvedValue(null),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
  createCalendarEventOnCalendar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/billing/guestPassHoldService', () => ({
  releaseGuestPassHold: vi.fn().mockResolvedValue({ success: true, passesReleased: 0 }),
}));

vi.mock('../server/core/billing/bookingInvoiceService', () => ({
  voidBookingInvoice: vi.fn().mockResolvedValue(undefined),
  finalizeAndPayInvoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/auditLog', () => ({
  logPaymentAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../shared/schema', () => ({
  bookingRequests: { id: 'id', userEmail: 'userEmail', userName: 'userName', resourceId: 'resourceId', requestDate: 'requestDate', startTime: 'startTime', status: 'status', calendarEventId: 'calendarEventId', sessionId: 'sessionId', trackmanBookingId: 'trackmanBookingId', staffNotes: 'staffNotes', cancellationPendingAt: 'cancellationPendingAt', updatedAt: 'updatedAt', durationMinutes: 'durationMinutes', endTime: 'endTime' },
  resources: { id: 'id', type: 'type', name: 'name' },
  notifications: { userEmail: 'userEmail', title: 'title', message: 'message', type: 'type', relatedId: 'relatedId', relatedType: 'relatedType', isRead: 'isRead' },
  bookingParticipants: { id: 'id', sessionId: 'sessionId', stripePaymentIntentId: 'stripePaymentIntentId', cachedFeeCents: 'cachedFeeCents', displayName: 'displayName', paymentStatus: 'paymentStatus', participantType: 'participantType', usedGuestPass: 'usedGuestPass', refundedAt: 'refundedAt' },
  stripePaymentIntents: { bookingId: 'bookingId', stripePaymentIntentId: 'stripePaymentIntentId', status: 'status' },
  users: {},
}));

vi.mock('stripe', () => ({ default: vi.fn() }));

import { db } from '../server/db';

import { BookingStateService } from '../server/core/bookingService/bookingStateService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockDbSelectChain(result: any[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.select as any).mockReturnValue(chain);
  return chain;
}

describe('BookingStateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cancelBooking', () => {
    it('returns error when booking is not found', async () => {
      mockDbSelectChain([]);

      const result = await BookingStateService.cancelBooking({
        bookingId: 999,
        source: 'staff',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Booking request not found');
      expect(result.statusCode).toBe(404);
    });

    it('returns success when booking is already cancelled', async () => {
      const cancelledBooking = {
        id: 1,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'cancelled',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: null,
        staffNotes: null,
      };
      mockDbSelectChain([cancelledBooking]);

      const result = await BookingStateService.cancelBooking({
        bookingId: 1,
        source: 'staff',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('cancelled');
      expect(result.bookingData.userEmail).toBe('test@example.com');
    });

    it('returns cancellation_pending when booking is already pending cancellation and source is not trackman', async () => {
      const pendingBooking = {
        id: 2,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'cancellation_pending',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: '12345',
        staffNotes: null,
      };
      mockDbSelectChain([pendingBooking]);

      const result = await BookingStateService.cancelBooking({
        bookingId: 2,
        source: 'staff',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('cancellation_pending');
    });

    it('routes to pending cancellation flow for approved Trackman-linked bookings from non-webhook source', async () => {
      const approvedTrackmanBooking = {
        id: 3,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'approved',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: '67890',
        staffNotes: null,
      };
      mockDbSelectChain([approvedTrackmanBooking]);

      const resourceChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ name: 'Bay 1' }]),
      };

      const txMock = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      let selectCallCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.select as any).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([approvedTrackmanBooking]),
          };
        }
        return resourceChain;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.transaction as any).mockImplementation(async (fn: any) => {
        return await fn(txMock);
      });

      const result = await BookingStateService.cancelBooking({
        bookingId: 3,
        source: 'member',
        cancelledBy: 'test@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('cancellation_pending');
    });

    it('handles DB error during booking lookup gracefully', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.select as any).mockImplementation(() => {
        throw new Error('DB connection failed');
      });

      const result = await BookingStateService.cancelBooking({
        bookingId: 1,
        source: 'staff',
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
    });
  });

  describe('completePendingCancellation', () => {
    it('returns error when booking is not found', async () => {
      mockDbSelectChain([]);

      const result = await BookingStateService.completePendingCancellation({
        bookingId: 999,
        staffEmail: 'staff@example.com',
        source: 'staff_manual',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Booking not found');
      expect(result.statusCode).toBe(404);
    });

    it('returns error when booking status is not cancellation_pending', async () => {
      const approvedBooking = {
        id: 1,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'approved',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: '12345',
        staffNotes: null,
      };
      mockDbSelectChain([approvedBooking]);

      const result = await BookingStateService.completePendingCancellation({
        bookingId: 1,
        staffEmail: 'staff@example.com',
        source: 'staff_manual',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot complete cancellation");
      expect(result.error).toContain("approved");
      expect(result.statusCode).toBe(400);
    });

    it('rejects completion when booking is in pending status instead of cancellation_pending', async () => {
      const pendingBooking = {
        id: 2,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'pending',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: null,
        staffNotes: null,
      };
      mockDbSelectChain([pendingBooking]);

      const result = await BookingStateService.completePendingCancellation({
        bookingId: 2,
        staffEmail: 'staff@example.com',
        source: 'staff_manual',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("pending");
      expect(result.error).toContain("expected 'cancellation_pending'");
      expect(result.statusCode).toBe(400);
    });

    it('rejects completion when booking is already cancelled', async () => {
      const cancelledBooking = {
        id: 3,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'cancelled',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: null,
        staffNotes: null,
      };
      mockDbSelectChain([cancelledBooking]);

      const result = await BookingStateService.completePendingCancellation({
        bookingId: 3,
        staffEmail: 'staff@example.com',
        source: 'staff_manual',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cancelled");
      expect(result.statusCode).toBe(400);
    });

    it('successfully completes cancellation for cancellation_pending booking', async () => {
      const pendingCancelBooking = {
        id: 4,
        userEmail: 'test@example.com',
        userName: 'Test User',
        resourceId: 1,
        requestDate: '2025-01-01',
        startTime: '10:00',
        status: 'cancellation_pending',
        calendarEventId: null,
        sessionId: null,
        trackmanBookingId: '12345',
        staffNotes: 'Previous notes',
      };

      let selectCallCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.select as any).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([pendingCancelBooking]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ type: 'simulator' }]),
        };
      });

      const txMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([]),
        }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.transaction as any).mockImplementation(async (fn: any) => {
        return await fn(txMock);
      });

      const result = await BookingStateService.completePendingCancellation({
        bookingId: 4,
        staffEmail: 'staff@example.com',
        source: 'staff_manual',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('cancelled');
      expect(result.bookingData.userEmail).toBe('test@example.com');
    });
  });
});

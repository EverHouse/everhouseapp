// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logAndRespond: vi.fn(),
}));

vi.mock('../server/utils/errorUtils', () => ({
  getErrorMessage: vi.fn((e: unknown) => {
    if (e instanceof Error) return e.message;
    return String(e);
  }),
  getErrorStatusCode: vi.fn(() => 500),
}));

const { mockExecute, mockTransaction, mockSelect, mockUpdate, mockInsert } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockTransaction: vi.fn(),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock('../server/db', () => ({
  db: {
    execute: mockExecute,
    transaction: mockTransaction,
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
  },
}));

const mockQueryWithRetry = vi.fn();
vi.mock('../server/core/db', () => ({
  queryWithRetry: (...args: unknown[]) => mockQueryWithRetry(...args),
  pool: { connect: vi.fn() },
}));

const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

vi.mock('drizzle-orm', () => {
  const sqlTagFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const result = { __sqlStrings: Array.from(strings), __sqlValues: values };
    sqlCalls.push({ strings: Array.from(strings), values });
    return result;
  };
  sqlTagFn.join = vi.fn();
  return { sql: sqlTagFn, eq: vi.fn(), and: vi.fn(), or: vi.fn(), ne: vi.fn(), inArray: vi.fn(), isNull: vi.fn(), isNotNull: vi.fn(), desc: vi.fn(), SQL: class {} };
});

vi.mock('../shared/schema', () => ({
  bookingRequests: { id: 'id', userEmail: 'userEmail', userName: 'userName', resourceId: 'resourceId', requestDate: 'requestDate', startTime: 'startTime', endTime: 'endTime', durationMinutes: 'durationMinutes', status: 'status', calendarEventId: 'calendarEventId', sessionId: 'sessionId', trackmanBookingId: 'trackmanBookingId', staffNotes: 'staffNotes', isUnmatched: 'isUnmatched', updatedAt: 'updatedAt', cancellationPendingAt: 'cancellationPendingAt' },
  resources: { id: 'id', type: 'type', name: 'name' },
  bookingParticipants: { id: 'id', sessionId: 'sessionId', stripePaymentIntentId: 'stripePaymentIntentId', cachedFeeCents: 'cachedFeeCents', displayName: 'displayName', paymentStatus: 'paymentStatus', participantType: 'participantType', usedGuestPass: 'usedGuestPass', refundedAt: 'refundedAt' },
  notifications: { userEmail: 'userEmail', title: 'title', message: 'message', type: 'type', relatedId: 'relatedId', relatedType: 'relatedType', isRead: 'isRead' },
  stripePaymentIntents: { bookingId: 'bookingId', stripePaymentIntentId: 'stripePaymentIntentId', status: 'status', amountCents: 'amountCents' },
  users: { id: 'id', email: 'email' },
  failedSideEffects: { bookingId: 'bookingId', manifestJson: 'manifestJson', errorsJson: 'errorsJson', createdAt: 'createdAt' },
}));

const mockCancelPaymentIntent = vi.fn().mockResolvedValue({ success: true });
const mockRefundsCreate = vi.fn().mockResolvedValue({ id: 'refund_test_123', amount: 5000 });
const mockPiRetrieve = vi.fn().mockResolvedValue({ status: 'succeeded', latest_charge: 'ch_test' });
const mockGetStripeClient = vi.fn().mockResolvedValue({
  paymentIntents: { retrieve: mockPiRetrieve, cancel: vi.fn() },
  refunds: { create: mockRefundsCreate },
  customers: { createBalanceTransaction: vi.fn() },
});

vi.mock('../server/core/stripe', () => ({
  cancelPaymentIntent: (...args: unknown[]) => mockCancelPaymentIntent(...args),
  getStripeClient: (...args: unknown[]) => mockGetStripeClient(...args),
}));
vi.mock('../server/core/stripe/payments', () => ({
  cancelPaymentIntent: (...args: unknown[]) => mockCancelPaymentIntent(...args),
}));
vi.mock('../server/core/stripe/client', () => ({
  getStripeClient: (...args: unknown[]) => mockGetStripeClient(...args),
}));
vi.mock('stripe', () => ({ default: vi.fn() }));

const mockNotifyAllStaff = vi.fn().mockResolvedValue(undefined);
const mockNotifyMember = vi.fn().mockResolvedValue(undefined);
vi.mock('../server/core/notificationService', () => ({
  notifyAllStaff: (...args: unknown[]) => mockNotifyAllStaff(...args),
  notifyMember: (...args: unknown[]) => mockNotifyMember(...args),
  isSyntheticEmail: vi.fn().mockReturnValue(false),
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

const mockRefundGuestPass = vi.fn().mockResolvedValue({ success: true });
vi.mock('../server/routes/guestPasses', () => ({
  refundGuestPass: (...args: unknown[]) => mockRefundGuestPass(...args),
}));

vi.mock('../server/core/billing/PaymentStatusService', () => ({
  PaymentStatusService: { markPaymentRefunded: vi.fn().mockResolvedValue(undefined), markPaymentCancelled: vi.fn().mockResolvedValue(undefined) },
  markPaymentRefunded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../server/routes/bays/helpers', () => ({
  getCalendarNameForBayAsync: vi.fn().mockResolvedValue(null),
  isStaffOrAdminCheck: vi.fn().mockReturnValue(false),
}));
vi.mock('../server/core/calendar/index', () => ({
  getCalendarIdByName: vi.fn().mockResolvedValue(null),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
  createCalendarEventOnCalendar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../server/core/billing/guestPassHoldService', () => ({
  releaseGuestPassHold: vi.fn().mockResolvedValue({ success: true, passesReleased: 0 }),
  createGuestPassHold: vi.fn().mockResolvedValue({ success: true }),
}));

const mockVoidBookingInvoice = vi.fn().mockResolvedValue({ success: true });
vi.mock('../server/core/billing/bookingInvoiceService', () => ({
  voidBookingInvoice: (...args: unknown[]) => mockVoidBookingInvoice(...args),
  finalizeAndPayInvoice: vi.fn().mockResolvedValue(undefined),
  syncBookingInvoice: vi.fn().mockResolvedValue(undefined),
  getBookingInvoiceId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../server/core/auditLog', () => ({
  logPaymentAudit: vi.fn().mockResolvedValue(undefined),
  logFromRequest: vi.fn().mockResolvedValue(undefined),
  logMemberAction: vi.fn().mockResolvedValue(undefined),
}));

const mockCreatePacificDate = vi.fn(() => new Date('2026-06-15T10:00:00'));
vi.mock('../server/utils/dateUtils', () => ({
  formatNotificationDateTime: vi.fn(() => 'Jan 1 at 10:00 AM'),
  formatDateDisplayWithDay: vi.fn(() => 'Wed, Jan 1'),
  formatTime12Hour: vi.fn(() => '10:00 AM'),
  getTodayPacific: vi.fn(() => '2025-06-15'),
  formatTimePacific: vi.fn(() => '14:00'),
  createPacificDate: (...args: unknown[]) => mockCreatePacificDate(...args),
}));

vi.mock('../server/routes/push', () => ({ sendPushNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../server/utils/sqlArrayLiteral', () => ({
  toIntArrayLiteral: vi.fn((arr: number[]) => `{${arr.join(',')}}`),
  toTextArrayLiteral: vi.fn((arr: string[]) => `{${arr.join(',')}}`),
}));
vi.mock('../server/core/jobQueue', () => ({ queueJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../server/walletPass/bookingPassService', () => ({ voidBookingPass: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../server/core/schedulerTracker', () => ({
  schedulerTracker: { recordRun: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('../server/core/middleware', () => ({
  isAuthenticated: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isStaffOrAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../server/types/session', () => ({
  getSessionUser: vi.fn().mockReturnValue({ email: 'member@example.com', role: 'member' }),
}));
vi.mock('../server/core/tierService', () => ({
  checkDailyBookingLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getMemberTierByEmail: vi.fn().mockResolvedValue('gold'),
  getTierLimits: vi.fn().mockResolvedValue({ dailyMinutes: 120 }),
  getDailyBookedMinutes: vi.fn().mockResolvedValue(0),
}));
vi.mock('../server/core/billing/unifiedFeeService', () => ({
  computeFeeBreakdown: vi.fn().mockResolvedValue({ totalCents: 0, lineItems: [] }),
  applyFeeBreakdownToParticipants: vi.fn().mockResolvedValue(undefined),
  recalculateSessionFees: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../server/core/billing/pricingConfig', () => ({ PRICING: { GUEST_FEE_CENTS: 7500, GUEST_FEE_DOLLARS: 75 } }));
vi.mock('../server/core/bookingService/sessionManager', () => ({
  ensureSessionForBooking: vi.fn().mockResolvedValue({ sessionId: 100 }),
  createSessionWithUsageTracking: vi.fn().mockResolvedValue({ sessionId: 100 }),
}));
vi.mock('../server/utils/dateNormalize', () => ({ normalizeToISODate: vi.fn((d: string) => d) }));
vi.mock('../server/middleware/rateLimiting', () => ({
  bookingRateLimiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../server/middleware/validate', () => ({
  validateBody: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  validateQuery: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../server/core/stripe/customers', () => ({ resolveUserByEmail: vi.fn().mockResolvedValue(null) }));
vi.mock('../server/replit_integrations/auth/replitAuth', () => ({
  isAdminEmail: vi.fn().mockResolvedValue(false),
  getAuthPool: vi.fn().mockReturnValue(null),
  queryWithRetry: vi.fn(),
}));
vi.mock('../server/replit_integrations/auth', () => ({
  isAuthenticated: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isStaffOrAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isAdminEmail: vi.fn().mockReturnValue(false),
  getSession: vi.fn(),
}));

import { cancelPendingPaymentIntentsForBooking } from '../server/core/billing/paymentIntentCleanup';
import { BookingStateService } from '../server/core/bookingService/bookingStateService';
import { runManualBookingExpiry } from '../server/schedulers/bookingExpiryScheduler';

function findSqlCallsContaining(needle: string) {
  return sqlCalls.filter(c => c.strings.some(s => s.includes(needle)));
}

interface RouteLayer {
  route?: { path: string; stack: Array<{ method: string; handle: Function }> };
}

async function invokeMemberCancel(req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>): Promise<void> {
  const mod = await import('../server/routes/bays/bookings');
  const router = mod.default;
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === '/api/booking-requests/:id/member-cancel');
  if (!layer?.route) throw new Error('member-cancel route not found');
  const handlers = layer.route.stack.filter(s => s.method === 'put').map(s => s.handle);
  for (const handler of handlers) {
    await new Promise<void>((resolve, reject) => {
      const next = (err?: unknown) => { if (err) reject(err); else resolve(); };
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(() => resolve()).catch(reject);
      }
    });
  }
}

function makeReq(bookingId: number) {
  return {
    params: { id: String(bookingId) },
    body: {},
    session: { user: { email: 'member@example.com', role: 'member' } },
  };
}

function makeRes() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return res;
}

describe('Payment Intent Cleanup Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
  });

  describe('cancelPendingPaymentIntentsForBooking', () => {
    it('cancels each pending PI via Stripe and updates booking_fee_snapshots to cancelled', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_pending_1' }, { stripe_payment_intent_id: 'pi_pending_2' }] })
        .mockResolvedValue({ rows: [], rowCount: 1 });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      await cancelPendingPaymentIntentsForBooking(42);

      expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(2);
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_pending_1');
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_pending_2');

      const cancelledUpdates = findSqlCallsContaining('booking_fee_snapshots').filter(c => c.strings.some(s => s.includes("status = 'cancelled'")));
      expect(cancelledUpdates.length).toBe(2);
      expect(cancelledUpdates.map(c => c.values[0])).toContain('pi_pending_1');
      expect(cancelledUpdates.map(c => c.values[0])).toContain('pi_pending_2');
    });

    it('skips per-PI snapshot update when skipSnapshotUpdate is true (used by expiry scheduler)', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_skip_1' }, { stripe_payment_intent_id: 'pi_skip_2' }] });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      await cancelPendingPaymentIntentsForBooking(42, { skipSnapshotUpdate: true });

      expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(2);
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_skip_1');
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_skip_2');
      expect(findSqlCallsContaining('booking_fee_snapshots').length).toBe(0);

      vi.clearAllMocks();
      sqlCalls.length = 0;
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_contrast' }] })
        .mockResolvedValue({ rows: [], rowCount: 1 });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });
      await cancelPendingPaymentIntentsForBooking(42);
      expect(findSqlCallsContaining('booking_fee_snapshots').filter(c => c.strings.some(s => s.includes("status = 'cancelled'"))).length).toBe(1);
    });

    it('does not update snapshots for PIs that failed to cancel', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_ok' }, { stripe_payment_intent_id: 'pi_fail' }] })
        .mockResolvedValue({ rows: [], rowCount: 1 });
      mockCancelPaymentIntent
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Already cancelled' });

      await cancelPendingPaymentIntentsForBooking(42);

      const cancelledUpdates = findSqlCallsContaining('booking_fee_snapshots').filter(c => c.strings.some(s => s.includes("status = 'cancelled'")));
      expect(cancelledUpdates.length).toBe(1);
      expect(cancelledUpdates[0].values[0]).toBe('pi_ok');
    });

    it('handles no pending PIs gracefully', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      await cancelPendingPaymentIntentsForBooking(42);
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('survives cancelPaymentIntent throwing and still processes remaining PIs', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_throw' }, { stripe_payment_intent_id: 'pi_after' }] })
        .mockResolvedValue({ rows: [], rowCount: 1 });
      mockCancelPaymentIntent
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce({ success: true });

      await cancelPendingPaymentIntentsForBooking(42);

      expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(2);
      const cancelledUpdates = findSqlCallsContaining('booking_fee_snapshots').filter(c => c.strings.some(s => s.includes("status = 'cancelled'")));
      expect(cancelledUpdates.length).toBe(1);
      expect(cancelledUpdates[0].values[0]).toBe('pi_after');
    });
  });

  describe('BookingStateService executeSideEffects — pending PI cancel path', () => {
    function setupCancelMocks(snapshotPiId: string, piStatus: string) {
      const booking = {
        id: 10, userEmail: 'member@example.com', userName: 'Test Member', resourceId: 1,
        requestDate: '2025-06-15', startTime: '10:00', durationMinutes: 60, endTime: '11:00',
        status: 'approved', calendarEventId: null, sessionId: null, trackmanBookingId: null,
        staffNotes: null, isUnmatched: false,
      };
      let dbSelectCount = 0;
      mockSelect.mockImplementation(() => {
        dbSelectCount++;
        if (dbSelectCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([booking]) };
        if (dbSelectCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ type: 'simulator' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      const txMock = {
        execute: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1, stripe_payment_intent_id: snapshotPiId, snapshot_status: 'pending', total_cents: 5000 }] }).mockResolvedValue({ rows: [], rowCount: 0 }),
        select: vi.fn().mockImplementation(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
      mockExecute.mockImplementation((query: unknown) => {
        const q = query as { __sqlStrings?: string[] };
        if (q?.__sqlStrings?.some(s => s.includes('stripe_payment_intents') && s.includes('SELECT status'))) return Promise.resolve({ rows: [{ status: piStatus }] });
        if (q?.__sqlStrings?.some(s => s.includes('booking_fee_snapshots') && s.includes("status = 'cancelled'"))) return Promise.resolve({ rows: [], rowCount: 1 });
        if (q?.__sqlStrings?.some(s => s.includes('booking_fee_snapshots') && s.includes("status = 'refunded'"))) return Promise.resolve({ rows: [], rowCount: 1 });
        if (q?.__sqlStrings?.some(s => s.includes("SET status = 'refunding'"))) return Promise.resolve({ rows: [{ stripe_payment_intent_id: snapshotPiId }], rowCount: 1 });
        if (q?.__sqlStrings?.some(s => s.includes('failed_side_effects'))) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    }

    it('calls cancelPaymentIntent for pending snapshot PIs and marks snapshots cancelled', async () => {
      setupCancelMocks('pi_snap_pending', 'pending');
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      const result = await BookingStateService.cancelBooking({ bookingId: 10, source: 'staff' });

      expect(result.success).toBe(true);
      expect(result.status).toBe('cancelled');
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_snap_pending');
      const cancelledUpdates = sqlCalls.filter(c => c.strings.some(s => s.includes('booking_fee_snapshots')) && c.strings.some(s => s.includes("status = 'cancelled'")));
      expect(cancelledUpdates.length).toBeGreaterThanOrEqual(1);
    });

    it('handles requires_action status same as pending', async () => {
      setupCancelMocks('pi_snap_action', 'requires_action');
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      const result = await BookingStateService.cancelBooking({ bookingId: 10, source: 'staff' });

      expect(result.success).toBe(true);
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_snap_action');
    });
  });

  describe('BookingStateService executeSideEffects — succeeded PI refund path', () => {
    it('refunds succeeded PIs via stripe.refunds.create with correct args and marks snapshots refunded', async () => {
      const snapshotPiId = 'pi_snap_succeeded';
      const booking = {
        id: 10, userEmail: 'member@example.com', userName: 'Test Member', resourceId: 1,
        requestDate: '2025-06-15', startTime: '10:00', durationMinutes: 60, endTime: '11:00',
        status: 'approved', calendarEventId: null, sessionId: null, trackmanBookingId: null,
        staffNotes: null, isUnmatched: false,
      };
      let dbSelectCount = 0;
      mockSelect.mockImplementation(() => {
        dbSelectCount++;
        if (dbSelectCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([booking]) };
        if (dbSelectCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ type: 'simulator' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      const txMock = {
        execute: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1, stripe_payment_intent_id: snapshotPiId, snapshot_status: 'pending', total_cents: 7500 }] }).mockResolvedValue({ rows: [], rowCount: 0 }),
        select: vi.fn().mockImplementation(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
      mockRefundsCreate.mockResolvedValue({ id: 'refund_snap_xyz', amount: 7500 });
      mockExecute.mockImplementation((query: unknown) => {
        const q = query as { __sqlStrings?: string[] };
        if (q?.__sqlStrings?.some(s => s.includes('stripe_payment_intents') && s.includes('SELECT status'))) return Promise.resolve({ rows: [{ status: 'succeeded' }] });
        if (q?.__sqlStrings?.some(s => s.includes("SET status = 'refunding'"))) return Promise.resolve({ rows: [{ stripe_payment_intent_id: snapshotPiId }], rowCount: 1 });
        if (q?.__sqlStrings?.some(s => s.includes('booking_fee_snapshots') && s.includes("status = 'refunded'"))) return Promise.resolve({ rows: [], rowCount: 1 });
        if (q?.__sqlStrings?.some(s => s.includes('failed_side_effects'))) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await BookingStateService.cancelBooking({ bookingId: 10, source: 'staff' });

      expect(result.success).toBe(true);
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
      expect(mockRefundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: snapshotPiId, reason: 'requested_by_customer', amount: 7500 });
      const refundedUpdates = sqlCalls.filter(c => c.strings.some(s => s.includes('booking_fee_snapshots')) && c.strings.some(s => s.includes("status = 'refunded'")));
      expect(refundedUpdates.length).toBeGreaterThanOrEqual(1);
    });

    it('returns sideEffectErrors and reverts PI status when stripe refund fails', async () => {
      const snapshotPiId = 'pi_snap_fail_refund';
      const booking = {
        id: 10, userEmail: 'member@example.com', userName: 'Test Member', resourceId: 1,
        requestDate: '2025-06-15', startTime: '10:00', durationMinutes: 60, endTime: '11:00',
        status: 'approved', calendarEventId: null, sessionId: null, trackmanBookingId: null,
        staffNotes: null, isUnmatched: false,
      };
      let dbSelectCount = 0;
      mockSelect.mockImplementation(() => {
        dbSelectCount++;
        if (dbSelectCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([booking]) };
        if (dbSelectCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ type: 'simulator' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      const txMock = {
        execute: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1, stripe_payment_intent_id: snapshotPiId, snapshot_status: 'pending', total_cents: 5000 }] }).mockResolvedValue({ rows: [], rowCount: 0 }),
        select: vi.fn().mockImplementation(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
      mockRefundsCreate.mockRejectedValue(new Error('Stripe card declined'));
      mockExecute.mockImplementation((query: unknown) => {
        const q = query as { __sqlStrings?: string[] };
        if (q?.__sqlStrings?.some(s => s.includes('stripe_payment_intents') && s.includes('SELECT status'))) return Promise.resolve({ rows: [{ status: 'succeeded' }] });
        if (q?.__sqlStrings?.some(s => s.includes("SET status = 'refunding'"))) return Promise.resolve({ rows: [{ stripe_payment_intent_id: snapshotPiId }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await BookingStateService.cancelBooking({ bookingId: 10, source: 'staff' });

      expect(result.success).toBe(true);
      expect(result.sideEffectErrors).toBeDefined();
      expect(result.sideEffectErrors!.length).toBeGreaterThan(0);
      expect(result.sideEffectErrors![0]).toContain('pi_snap_fail');
      const revertUpdates = sqlCalls.filter(c => c.strings.some(s => s.includes('stripe_payment_intents')) && c.strings.some(s => s.includes("SET status = 'succeeded'")) && c.strings.some(s => s.includes("status = 'refunding'")));
      expect(revertUpdates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Member-cancel route — normal path (shouldSkipRefund=false)', () => {
    function setupNormalCancel(bookingId: number, opts: {
      paidParticipants?: Array<{ id: number; stripe_payment_intent_id: string; cached_fee_cents: number; display_name: string }>;
      pendingPIs?: Array<{ stripe_payment_intent_id: string }>;
      guestParticipants?: Array<{ display_name: string }>;
    } = {}) {
      const { paidParticipants = [], pendingPIs = [], guestParticipants = [] } = opts;
      const existing = {
        id: bookingId, userEmail: 'member@example.com', userName: 'Test Member',
        requestDate: '2026-06-15', startTime: '10:00', status: 'approved',
        calendarEventId: null, resourceId: 1, trackmanBookingId: null, staffNotes: null, sessionId: 100,
      };

      mockCreatePacificDate.mockReturnValue(new Date(Date.now() + 48 * 60 * 60 * 1000));

      let selectCount = 0;
      mockSelect.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([existing]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ name: 'Bay 1' }]) };
      });

      const txExecuteHandler = (query: unknown) => {
        const q = query as { __sqlStrings?: string[] };
        const joined = q?.__sqlStrings?.join(' ') || '';
        if (joined.includes('guest_pass_holds')) return Promise.resolve({ rows: [] });
        if (joined.includes('booking_participants') && joined.includes('guest') && joined.includes('used_guest_pass'))
          return Promise.resolve({ rows: guestParticipants });
        if (joined.includes('booking_participants') && joined.includes('payment_status'))
          return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      };

      mockTransaction.mockImplementation(async (fn: Function) => fn({ execute: vi.fn().mockImplementation(txExecuteHandler) }));

      mockExecute.mockImplementation((query: unknown) => {
        const q = query as { __sqlStrings?: string[] };
        const joined = q?.__sqlStrings?.join(' ') || '';
        if (joined.includes('booking_participants') && joined.includes("payment_status = 'paid'"))
          return Promise.resolve({ rows: paidParticipants });
        if (joined.includes('stripe_payment_intents') && joined.includes("IN ('refunding', 'refunded')"))
          return Promise.resolve({ rows: [], rowCount: 0 });
        if (joined.includes("SET status = 'refunding'"))
          return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
        if (joined.includes('stripe_payment_intents') && joined.includes("'pending'") && joined.includes('SELECT'))
          return Promise.resolve({ rows: pendingPIs });
        if (joined.includes('booking_fee_snapshots'))
          return Promise.resolve({ rows: [], rowCount: 1 });
        if (joined.includes('booking_participants') && joined.includes("payment_status = 'refunded'"))
          return Promise.resolve({ rows: [], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: bookingId }]),
          }),
        }),
      });
    }

    it('calls cancelPendingPaymentIntentsForBooking for normal cancellation', async () => {
      setupNormalCancel(55, { pendingPIs: [{ stripe_payment_intent_id: 'pi_member_pending' }] });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      await invokeMemberCancel(makeReq(55), makeRes());

      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_member_pending');
    });

    it('refunds paid participant PIs via Stripe', async () => {
      setupNormalCancel(56, {
        paidParticipants: [{ id: 1, stripe_payment_intent_id: 'pi_paid_1', cached_fee_cents: 7500, display_name: 'Guest A' }],
      });
      mockPiRetrieve.mockResolvedValue({ status: 'succeeded', latest_charge: 'ch_paid_1' });
      mockRefundsCreate.mockResolvedValue({ id: 'refund_paid_1', amount: 7500 });

      await invokeMemberCancel(makeReq(56), makeRes());

      expect(mockRefundsCreate).toHaveBeenCalled();
      expect(mockRefundsCreate.mock.calls[0][0]).toMatchObject({ charge: 'ch_paid_1', reason: 'requested_by_customer' });
    });

    it('voids booking invoice', async () => {
      setupNormalCancel(57);
      await invokeMemberCancel(makeReq(57), makeRes());
      expect(mockVoidBookingInvoice).toHaveBeenCalledWith(57);
    });

    it('refunds guest passes', async () => {
      setupNormalCancel(58, { guestParticipants: [{ display_name: 'Guest With Pass' }] });
      await invokeMemberCancel(makeReq(58), makeRes());
      expect(mockRefundGuestPass).toHaveBeenCalledWith('member@example.com', 'Guest With Pass', false);
    });
  });

  describe('Member-cancel route — late path (shouldSkipRefund=true)', () => {
    function setupLateCancel(bookingId: number) {
      const existing = {
        id: bookingId, userEmail: 'member@example.com', userName: 'Test Member',
        requestDate: '2025-06-14', startTime: '10:00', status: 'approved',
        calendarEventId: null, resourceId: 1, trackmanBookingId: null, staffNotes: null, sessionId: 100,
      };

      mockCreatePacificDate.mockReturnValue(new Date(Date.now() + 30 * 60 * 1000));

      let selectCount = 0;
      mockSelect.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([existing]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ name: 'Bay 1' }]) };
      });

      mockTransaction.mockImplementation(async (fn: Function) => fn({
        execute: vi.fn().mockImplementation((query: unknown) => {
          const q = query as { __sqlStrings?: string[] };
          if (q?.__sqlStrings?.some(s => s.includes('guest_pass_holds'))) return Promise.resolve({ rows: [] });
          if (q?.__sqlStrings?.some(s => s.includes('booking_participants') && s.includes('guest') && s.includes('used_guest_pass')))
            return Promise.resolve({ rows: [{ display_name: 'Late Guest' }] });
          return Promise.resolve({ rows: [], rowCount: 0 });
        }),
      }));

      mockExecute.mockResolvedValue({ rows: [], rowCount: 1 });

      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: bookingId }]),
          }),
        }),
      });
    }

    it('does NOT call cancelPendingPaymentIntentsForBooking for late cancellations', async () => {
      setupLateCancel(77);
      await invokeMemberCancel(makeReq(77), makeRes());
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('updates booking_fee_snapshots to cancelled directly via SQL', async () => {
      setupLateCancel(78);
      await invokeMemberCancel(makeReq(78), makeRes());

      const snapshotUpdates = findSqlCallsContaining('booking_fee_snapshots').filter(c =>
        c.strings.some(s => s.includes("status = 'cancelled'")) && c.strings.some(s => s.includes('booking_id'))
      );
      expect(snapshotUpdates.length).toBeGreaterThanOrEqual(1);
      expect(snapshotUpdates[0].values[0]).toBe(78);
    });

    it('does NOT void booking invoice for late cancellations', async () => {
      setupLateCancel(79);
      await invokeMemberCancel(makeReq(79), makeRes());
      expect(mockVoidBookingInvoice).not.toHaveBeenCalled();
    });

    it('does NOT refund guest passes for late cancellations', async () => {
      setupLateCancel(80);
      await invokeMemberCancel(makeReq(80), makeRes());
      expect(mockRefundGuestPass).not.toHaveBeenCalled();
    });
  });

  describe('Expiry scheduler — runManualBookingExpiry', () => {
    it('calls cancelPendingPaymentIntentsForBooking with skipSnapshotUpdate:true for each expired booking', async () => {
      mockQueryWithRetry
        .mockResolvedValueOnce({ rows: [{ id: 101 }, { id: 102 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 });
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_exp_101' }] })
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_exp_102' }] })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      const result = await runManualBookingExpiry();

      expect(result.expiredCount).toBe(2);
      expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(2);
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_exp_101');
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_exp_102');
      expect(findSqlCallsContaining('booking_fee_snapshots').length).toBe(0);
    });

    it('batch updates booking_fee_snapshots via queryWithRetry before individual PI cancellations', async () => {
      mockQueryWithRetry
        .mockResolvedValueOnce({ rows: [{ id: 201 }, { id: 202 }, { id: 203 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 3 });
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_exp_201' }] })
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_exp_202' }] })
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_exp_203' }] })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      await runManualBookingExpiry();

      expect(mockQueryWithRetry).toHaveBeenCalledTimes(2);
      const secondCall = mockQueryWithRetry.mock.calls[1];
      expect(secondCall[0]).toContain('booking_fee_snapshots');
      expect(secondCall[0]).toContain("status = 'cancelled'");
      expect(secondCall[1]).toEqual([[201, 202, 203]]);
    });

    it('continues cancelling PIs for remaining bookings when one throws', async () => {
      mockQueryWithRetry
        .mockResolvedValueOnce({ rows: [{ id: 301 }, { id: 302 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 });
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_301' }] })
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_302' }] })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      mockCancelPaymentIntent
        .mockRejectedValueOnce(new Error('Stripe timeout'))
        .mockResolvedValueOnce({ success: true });

      await runManualBookingExpiry();

      expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(2);
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_301');
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_302');
    });

    it('handles zero expired bookings — no PI cancellations or snapshot updates', async () => {
      mockQueryWithRetry.mockResolvedValueOnce({ rows: [] });
      const result = await runManualBookingExpiry();
      expect(result.expiredCount).toBe(0);
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockQueryWithRetry).toHaveBeenCalledTimes(1);
    });

    it('still cancels PIs even when batch snapshot update fails', async () => {
      mockQueryWithRetry
        .mockResolvedValueOnce({ rows: [{ id: 401 }] })
        .mockRejectedValueOnce(new Error('DB snapshot update failed'));
      mockExecute
        .mockResolvedValueOnce({ rows: [{ stripe_payment_intent_id: 'pi_exp_401' }] })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      mockCancelPaymentIntent.mockResolvedValue({ success: true });

      await runManualBookingExpiry();

      expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_exp_401');
    });
  });
});

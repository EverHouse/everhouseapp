// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../server/utils/errorUtils', () => ({
  getErrorMessage: vi.fn((e: unknown) => {
    if (e instanceof Error) return e.message;
    return String(e);
  }),
  getErrorCode: vi.fn((e: unknown) => {
    if (e && typeof e === 'object' && 'code' in e) return (e as { code: string }).code;
    return undefined;
  }),
  getErrorStatusCode: vi.fn(() => 500),
}));

const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

const { mockExecute, mockTransaction, mockSelect, mockUpdate, mockInsert, mockDelete } = vi.hoisted(() => {
  return {
    mockExecute: vi.fn(),
    mockTransaction: vi.fn(),
    mockSelect: vi.fn(),
    mockUpdate: vi.fn(),
    mockInsert: vi.fn(),
    mockDelete: vi.fn(),
  };
});

vi.mock('../server/db', () => ({
  db: {
    execute: mockExecute,
    transaction: mockTransaction,
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
    delete: mockDelete,
  },
}));

vi.mock('drizzle-orm', () => {
  const sqlTagFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const result = { __sqlStrings: Array.from(strings), __sqlValues: values };
    sqlCalls.push({ strings: Array.from(strings), values });
    return result;
  };
  sqlTagFn.join = vi.fn();
  return {
    sql: sqlTagFn,
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ne: vi.fn(),
    inArray: vi.fn(),
    isNull: vi.fn(),
    isNotNull: vi.fn(),
  };
});

vi.mock('../shared/schema', () => ({
  bookingRequests: { id: 'id', userEmail: 'userEmail', userName: 'userName', resourceId: 'resourceId', requestDate: 'requestDate', startTime: 'startTime', endTime: 'endTime', durationMinutes: 'durationMinutes', status: 'status', calendarEventId: 'calendarEventId', sessionId: 'sessionId', trackmanBookingId: 'trackmanBookingId', staffNotes: 'staffNotes', rosterVersion: 'rosterVersion', declaredPlayerCount: 'declaredPlayerCount', isUnmatched: 'isUnmatched', updatedAt: 'updatedAt' },
  resources: { id: 'id', type: 'type', name: 'name', capacity: 'capacity' },
  bookingParticipants: { id: 'id', sessionId: 'sessionId', userId: 'userId', guestId: 'guestId', participantType: 'participantType', displayName: 'displayName', slotDuration: 'slotDuration', paymentStatus: 'paymentStatus', createdAt: 'createdAt', stripePaymentIntentId: 'stripePaymentIntentId', cachedFeeCents: 'cachedFeeCents', usedGuestPass: 'usedGuestPass', refundedAt: 'refundedAt', inviteStatus: 'inviteStatus' },
  notifications: { userEmail: 'userEmail', title: 'title', message: 'message', type: 'type', relatedId: 'relatedId', relatedType: 'relatedType', isRead: 'isRead' },
  users: { id: 'id', email: 'email', firstName: 'firstName', lastName: 'lastName', tier: 'tier' },
  bookingSessions: {},
  availabilityBlocks: {},
  facilityClosures: {},
  stripePaymentIntents: { bookingId: 'bookingId', stripePaymentIntentId: 'stripePaymentIntentId', status: 'status', amountCents: 'amountCents' },
}));

vi.mock('../server/core/bookingService/sessionManager', () => ({
  createOrFindGuest: vi.fn().mockResolvedValue({ id: 10, name: 'Test Guest' }),
  linkParticipants: vi.fn().mockResolvedValue([
    { id: 50, sessionId: 100, userId: null, guestId: 20, participantType: 'guest', displayName: 'New Guest', slotDuration: null, paymentStatus: 'pending', createdAt: new Date(), inviteStatus: null, usedGuestPass: false, cachedFeeCents: 0, stripePaymentIntentId: null, refundedAt: null },
  ]),
  getSessionParticipants: vi.fn().mockResolvedValue([
    { id: 1, sessionId: 100, userId: 'owner-1', guestId: null, participantType: 'owner', displayName: 'Owner Test', slotDuration: null, paymentStatus: null, createdAt: null, inviteStatus: null, usedGuestPass: false, cachedFeeCents: null, stripePaymentIntentId: null, refundedAt: null },
  ]),
  ensureSessionForBooking: vi.fn().mockResolvedValue({ sessionId: 100 }),
}));

vi.mock('../server/core/bookingService/tierRules', () => ({
  getGuestPassesRemaining: vi.fn().mockResolvedValue(4),
  getRemainingMinutes: vi.fn().mockResolvedValue(120),
  enforceSocialTierRules: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../server/core/bookingService/usageCalculator', () => ({
  computeUsageAllocation: vi.fn().mockReturnValue({ allocations: [] }),
  calculateOverageFee: vi.fn().mockReturnValue(0),
}));

vi.mock('../server/core/tierService', () => ({
  getTierLimits: vi.fn().mockResolvedValue({ dailyMinutes: 120, guestPassesPerYear: 4 }),
  getMemberTierByEmail: vi.fn().mockResolvedValue('gold'),
  checkDailyBookingLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getDailyBookedMinutes: vi.fn().mockResolvedValue(0),
}));

vi.mock('../server/core/billing/unifiedFeeService', () => ({
  computeFeeBreakdown: vi.fn().mockResolvedValue({ totalCents: 0, lineItems: [] }),
  getEffectivePlayerCount: vi.fn().mockReturnValue(1),
  invalidateCachedFees: vi.fn(),
  recalculateSessionFees: vi.fn().mockResolvedValue(undefined),
  applyFeeBreakdownToParticipants: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/billing/pricingConfig', () => ({
  PRICING: { GUEST_FEE_CENTS: 7500, GUEST_FEE_DOLLARS: 75 },
  isPlaceholderGuestName: vi.fn().mockReturnValue(false),
}));

vi.mock('../server/core/billing/prepaymentService', () => ({
  createPrepaymentIntent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../server/core/bookingService/conflictDetection', () => ({
  findConflictingBookings: vi.fn().mockResolvedValue({ hasConflict: false, conflicts: [] }),
}));

vi.mock('../server/core/notificationService', () => ({
  notifyMember: vi.fn().mockResolvedValue(undefined),
  notifyAllStaff: vi.fn().mockResolvedValue(undefined),
  isSyntheticEmail: vi.fn().mockReturnValue(false),
}));

vi.mock('../server/routes/guestPasses', () => ({
  useGuestPass: vi.fn().mockResolvedValue({ success: true, remaining: 3 }),
  refundGuestPass: vi.fn().mockResolvedValue(undefined),
  ensureGuestPassRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/visitors/matchingService', () => ({
  upsertVisitor: vi.fn().mockResolvedValue({ id: 'visitor-1' }),
}));

vi.mock('../server/core/billing/bookingInvoiceService', () => ({
  syncBookingInvoice: vi.fn().mockResolvedValue(undefined),
  isBookingInvoicePaid: vi.fn().mockResolvedValue({ locked: false }),
  voidBookingInvoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/core/websocket', () => ({
  broadcastBookingRosterUpdate: vi.fn(),
  sendNotificationToUser: vi.fn(),
  broadcastAvailabilityUpdate: vi.fn(),
  broadcastBillingUpdate: vi.fn(),
  broadcastMemberStatsUpdated: vi.fn(),
}));

vi.mock('../server/core/bookingValidation', () => ({
  checkClosureConflict: vi.fn().mockResolvedValue({ hasConflict: false }),
  checkAvailabilityBlockConflict: vi.fn().mockResolvedValue({ hasConflict: false }),
  checkBookingConflict: vi.fn().mockResolvedValue({ hasConflict: false }),
  parseTimeToMinutes: vi.fn((t: string) => {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }),
  hasTimeOverlap: vi.fn(),
}));

vi.mock('../server/core/affectedAreas', () => ({
  parseAffectedAreasBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock('../server/replit_integrations/auth/replitAuth', () => ({
  isAdminEmail: vi.fn().mockResolvedValue(true),
  getAuthPool: vi.fn().mockReturnValue(null),
  queryWithRetry: vi.fn(),
}));

vi.mock('../server/core/billing/guestPassHoldService', () => ({
  createGuestPassHold: vi.fn().mockResolvedValue({ success: true, passesHeld: 0 }),
  releaseGuestPassHold: vi.fn().mockResolvedValue({ success: true, passesReleased: 0 }),
}));

vi.mock('../server/utils/sqlArrayLiteral', () => ({
  toIntArrayLiteral: vi.fn((arr: number[]) => `{${arr.join(',')}}`),
  toTextArrayLiteral: vi.fn((arr: string[]) => `{${arr.join(',')}}`),
  toNumericArrayLiteral: vi.fn(),
}));

vi.mock('../server/core/auditLog', () => ({
  logPaymentAudit: vi.fn(),
  logMemberAction: vi.fn(),
  logFromRequest: vi.fn(),
}));

import { addParticipant, removeParticipant } from '../server/core/bookingService/rosterService';
import { checkSessionConflictWithLock } from '../server/core/bookingService/availabilityGuard';
import { acquireBookingLocks, checkResourceOverlap, BookingConflictError } from '../server/core/bookingService/bookingCreationGuard';
import { getErrorCode } from '../server/utils/errorUtils';

const makeBookingRow = (overrides: Record<string, unknown> = {}) => ({
  booking_id: 1,
  owner_email: 'owner@test.com',
  owner_name: 'Owner Test',
  request_date: '2025-06-15',
  start_time: '10:00',
  end_time: '11:00',
  duration_minutes: 60,
  declared_player_count: 4,
  status: 'approved',
  session_id: 100,
  resource_id: 1,
  notes: null,
  staff_notes: null,
  roster_version: 0,
  trackman_booking_id: null,
  resource_name: 'Bay 1',
  owner_tier: 'gold',
  ...overrides,
});

function findSqlCallContaining(needle: string): { strings: string[]; values: unknown[] } | undefined {
  return sqlCalls.find(c => c.strings.some(s => s.includes(needle)));
}

describe('Booking Concurrency Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
  });

  describe('Advisory Lock Serialization (booking creation via acquireBookingLocks)', () => {
    it('acquireBookingLocks acquires resource advisory lock with pg_advisory_xact_lock SQL', async () => {
      const txMock = {
        execute: vi.fn().mockResolvedValue({ rows: [{ cnt: 0 }] }),
      };

      await acquireBookingLocks(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: false,
        isViewAsMode: false,
        resourceType: 'simulator',
      });

      const advisoryLockCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('pg_advisory_xact_lock'))
      );
      expect(advisoryLockCall).toBeDefined();

      const resourceLockCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('pg_advisory_xact_lock')) &&
        c.values.some(v => String(v).includes('1'))
      );
      expect(resourceLockCall).toBeDefined();
    });

    it('acquireBookingLocks acquires locks in deterministic sorted order', async () => {
      const lockValues: string[] = [];
      const txMock = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const sqlQuery = query as { __sqlStrings?: string[]; __sqlValues?: unknown[] };
          if (sqlQuery?.__sqlStrings?.some(s => s.includes('pg_advisory_xact_lock'))) {
            const lockId = sqlQuery.__sqlValues?.[0] as string;
            lockValues.push(lockId);
          }
          return { rows: [{ cnt: 0 }] };
        }),
      };

      await acquireBookingLocks(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: false,
        isViewAsMode: false,
        resourceType: 'simulator',
      });

      expect(lockValues.length).toBe(2);
      const sorted = [...lockValues].sort();
      expect(lockValues).toEqual(sorted);
    });

    it('checkResourceOverlap uses FOR UPDATE to lock conflicting rows', async () => {
      const txMock = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await checkResourceOverlap(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
      });

      const forUpdateCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('FOR UPDATE')) &&
        c.strings.some(s => s.includes('booking_requests'))
      );
      expect(forUpdateCall).toBeDefined();
    });

    it('checkResourceOverlap throws BookingConflictError with 409 when overlap exists', async () => {
      const txMock = {
        execute: vi.fn().mockResolvedValue({
          rows: [{ id: 99, start_time: '10:00', end_time: '11:00' }],
        }),
      };

      const error = await checkResourceOverlap(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
      }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(BookingConflictError);
      expect((error as BookingConflictError).statusCode).toBe(409);
      expect((error as BookingConflictError).errorBody.error).toContain('conflicts with an existing booking');
    });

    it('acquireBookingLocks throws 409 when member already has a pending request', async () => {
      const txMock = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }),
      };

      const error = await acquireBookingLocks(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: false,
        isViewAsMode: false,
        resourceType: 'simulator',
      }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(BookingConflictError);
      expect((error as BookingConflictError).statusCode).toBe(409);
      expect((error as BookingConflictError).errorBody.error).toContain('already have a pending request');
    });

    it('acquireBookingLocks skips resource lock when resourceId is null', async () => {
      const txMock = {
        execute: vi.fn().mockResolvedValue({ rows: [{ cnt: 0 }] }),
      };

      await acquireBookingLocks(txMock, {
        resourceId: null,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: false,
        isViewAsMode: false,
        resourceType: 'simulator',
      });

      const lockCalls = sqlCalls.filter(c =>
        c.strings.some(s => s.includes('pg_advisory_xact_lock'))
      );
      expect(lockCalls.length).toBe(1);

      const hasResourceLock = lockCalls.some(c =>
        c.values.some(v => typeof v === 'string' && v.includes('::'))
      );
      expect(hasResourceLock).toBe(false);
    });

    it('acquireBookingLocks skips pending check for conference rooms', async () => {
      const txMock = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await acquireBookingLocks(txMock, {
        resourceId: 5,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: false,
        isViewAsMode: false,
        resourceType: 'conference_room',
      });

      const pendingCheckCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('booking_requests')) &&
        c.strings.some(s => s.includes('pending'))
      );
      expect(pendingCheckCall).toBeUndefined();
    });

    it('staff requests skip member advisory lock unless view-as mode', async () => {
      const txMock = {
        execute: vi.fn().mockResolvedValue({ rows: [{ cnt: 0 }] }),
      };

      await acquireBookingLocks(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: true,
        isViewAsMode: false,
        resourceType: 'simulator',
      });

      const lockCalls = sqlCalls.filter(c =>
        c.strings.some(s => s.includes('pg_advisory_xact_lock'))
      );
      expect(lockCalls.length).toBe(1);

      sqlCalls.length = 0;

      await acquireBookingLocks(txMock, {
        resourceId: 1,
        requestDate: '2025-06-15',
        startTime: '10:00',
        endTime: '11:00',
        requestEmail: 'member@test.com',
        isStaffRequest: true,
        isViewAsMode: true,
        resourceType: 'simulator',
      });

      const lockCallsViewAs = sqlCalls.filter(c =>
        c.strings.some(s => s.includes('pg_advisory_xact_lock'))
      );
      expect(lockCallsViewAs.length).toBe(2);
    });
  });

  describe('Roster Version Optimistic Locking via addParticipant', () => {
    it('addParticipant throws 409 ROSTER_CONFLICT when rosterVersion is stale', async () => {
      const booking = makeBookingRow({ roster_version: 5 });
      mockExecute.mockResolvedValue({ rows: [booking] });

      const txMock = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ roster_version: 5 }] }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));

      const error = await addParticipant({
        bookingId: 1,
        type: 'guest',
        guest: { name: 'New Guest', email: 'guest@test.com' },
        rosterVersion: 2,
        userEmail: 'owner@test.com',
      }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Roster was modified by another user');
      expect((error as Error & { statusCode: number }).statusCode).toBe(409);
      expect((error as Error & { extra: Record<string, unknown> }).extra).toMatchObject({
        code: 'ROSTER_CONFLICT',
        currentVersion: 5,
      });
    });

    it('addParticipant issues SELECT ... FOR UPDATE on roster_version before version check', async () => {
      const booking = makeBookingRow({ roster_version: 2 });
      mockExecute.mockResolvedValue({ rows: [booking] });

      const txMock = {
        execute: vi.fn().mockResolvedValue({ rows: [{ roster_version: 2 }] }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));

      await addParticipant({
        bookingId: 1,
        type: 'guest',
        guest: { name: 'New Guest', email: 'guest@test.com' },
        rosterVersion: 99,
        userEmail: 'owner@test.com',
      }).catch(() => {});

      const forUpdateCall = findSqlCallContaining('roster_version');
      expect(forUpdateCall).toBeDefined();

      const forUpdateSqlCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('roster_version')) &&
        c.strings.some(s => s.includes('FOR UPDATE'))
      );
      expect(forUpdateSqlCall).toBeDefined();
    });

    it('addParticipant succeeds and increments roster_version when version matches', async () => {
      const booking = makeBookingRow({ roster_version: 3 });
      mockExecute.mockResolvedValue({ rows: [booking] });

      const { getSessionParticipants } = await import('../server/core/bookingService/sessionManager');
      vi.mocked(getSessionParticipants).mockResolvedValue([
        { id: 1, sessionId: 100, userId: 'owner-1', guestId: null, participantType: 'owner', displayName: 'Owner Test', slotDuration: null, paymentStatus: null, createdAt: null, inviteStatus: null, usedGuestPass: false, cachedFeeCents: null, stripePaymentIntentId: null, refundedAt: null },
      ]);

      const txMock = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ roster_version: 3 }] })
          .mockResolvedValue({ rows: [], rowCount: 1 }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 50, sessionId: 100, userId: null, guestId: 20,
              participantType: 'guest', displayName: 'New Guest',
              slotDuration: null, paymentStatus: 'pending', createdAt: new Date(),
              inviteStatus: null, usedGuestPass: false, cachedFeeCents: 0,
              stripePaymentIntentId: null, refundedAt: null,
            }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));

      const result = await addParticipant({
        bookingId: 1,
        type: 'guest',
        guest: { name: 'New Guest', email: 'guest@test.com' },
        rosterVersion: 3,
        userEmail: 'owner@test.com',
      });

      expect(result.newRosterVersion).toBe(4);

      const versionIncrementCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('roster_version')) &&
        c.strings.some(s => s.includes('COALESCE'))
      );
      expect(versionIncrementCall).toBeDefined();
    });
  });

  describe('Roster Version Optimistic Locking via removeParticipant', () => {
    it('removeParticipant throws 409 ROSTER_CONFLICT when rosterVersion is stale', async () => {
      const booking = makeBookingRow({ roster_version: 7, session_id: 100 });
      mockExecute.mockResolvedValue({ rows: [booking] });

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{
          id: 55, sessionId: 100, userId: null, guestId: 20,
          participantType: 'guest', displayName: 'Guest X',
          usedGuestPass: false,
        }]),
      });

      const txMock = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ roster_version: 7 }] }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));

      const error = await removeParticipant({
        bookingId: 1,
        participantId: 55,
        rosterVersion: 4,
        userEmail: 'owner@test.com',
      }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Roster was modified by another user');
      expect((error as Error & { statusCode: number }).statusCode).toBe(409);
      expect((error as Error & { extra: Record<string, unknown> }).extra).toMatchObject({
        code: 'ROSTER_CONFLICT',
        currentVersion: 7,
      });
    });
  });

  describe('Availability Guard FOR UPDATE NOWAIT', () => {
    it('FOR UPDATE NOWAIT detects row locked by concurrent transaction (55P03)', async () => {
      const lockError = Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
      vi.mocked(getErrorCode).mockReturnValue('55P03');

      const mockClient = {
        query: vi.fn().mockRejectedValue(lockError),
      } as unknown as import('pg').PoolClient;

      const result = await checkSessionConflictWithLock(mockClient, 1, '2025-01-15', '10:00', '11:00');

      expect(result.hasConflict).toBe(true);
      expect(result.conflictDetails).toBeUndefined();
    });

    it('FOR UPDATE NOWAIT returns conflict when session exists', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [{ id: 42, start_time: '10:00', end_time: '11:00' }],
        }),
      } as unknown as import('pg').PoolClient;

      const result = await checkSessionConflictWithLock(mockClient, 1, '2025-01-15', '10:00', '11:00');

      expect(result.hasConflict).toBe(true);
      expect(result.conflictDetails).toEqual({
        id: 42,
        startTime: '10:00',
        endTime: '11:00',
      });
    });

    it('FOR UPDATE NOWAIT returns no conflict when no overlapping sessions', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as unknown as import('pg').PoolClient;

      const result = await checkSessionConflictWithLock(mockClient, 1, '2025-01-15', '10:00', '11:00');

      expect(result.hasConflict).toBe(false);
    });

    it('FOR UPDATE NOWAIT re-throws non-lock errors', async () => {
      vi.mocked(getErrorCode).mockReturnValue('42P01');

      const dbError = Object.assign(new Error('relation does not exist'), { code: '42P01' });

      const mockClient = {
        query: vi.fn().mockRejectedValue(dbError),
      } as unknown as import('pg').PoolClient;

      await expect(
        checkSessionConflictWithLock(mockClient, 1, '2025-01-15', '10:00', '11:00')
      ).rejects.toThrow('relation does not exist');
    });

    it('FOR UPDATE NOWAIT query includes correct SQL and parameters', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as unknown as import('pg').PoolClient;

      await checkSessionConflictWithLock(mockClient, 1, '2025-01-15', '10:00', '11:00', 99);

      const queryCall = vi.mocked(mockClient.query).mock.calls[0];
      const queryText = queryCall[0] as string;
      const queryParams = queryCall[1] as unknown[];

      expect(queryText).toContain('FOR UPDATE NOWAIT');
      expect(queryText).toContain('booking_sessions');
      expect(queryParams).toEqual([1, '2025-01-15', '11:00', '10:00', 99]);
    });
  });
});

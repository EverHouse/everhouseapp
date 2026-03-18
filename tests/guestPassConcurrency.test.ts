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
}));

vi.mock('../server/core/bookingService/sessionManager', () => ({}));

const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

const { mockExecute, mockTransaction } = vi.hoisted(() => {
  const mockExecute = vi.fn();
  const mockTransaction = vi.fn();
  return { mockExecute, mockTransaction };
});

vi.mock('../server/db', () => ({
  db: {
    execute: mockExecute,
    transaction: mockTransaction,
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
  };
});

vi.mock('../server/core/billing/pricingConfig', () => ({
  PRICING: { GUEST_FEE_CENTS: 7500, GUEST_FEE_DOLLARS: 75 },
  isPlaceholderGuestName: vi.fn().mockReturnValue(false),
}));

vi.mock('../server/core/billing/bookingInvoiceService', () => ({
  syncBookingInvoice: vi.fn().mockResolvedValue(undefined),
}));

import {
  getAvailableGuestPasses,
  createGuestPassHold,
  convertHoldToUsage,
} from '../server/core/billing/guestPassHoldService';

import {
  consumeGuestPassForParticipant,
} from '../server/core/billing/guestPassConsumer';

describe('Guest Pass Concurrency Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
  });

  describe('Concurrent Guest Pass Hold Creation', () => {
    it('second concurrent hold fails when first hold exhausts available passes', async () => {
      let passesHeld = 0;
      const totalPasses = 4;
      const passesUsed = 2;

      mockTransaction
        .mockImplementationOnce(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn()
              .mockResolvedValueOnce({ rows: [] })
              .mockResolvedValueOnce({ rows: [{ id: 1 }] })
              .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: totalPasses }] })
              .mockResolvedValueOnce({ rows: [{ passes_used: passesUsed, passes_total: totalPasses }] })
              .mockResolvedValueOnce({ rows: [{ total_held: String(passesHeld) }] })
              .mockResolvedValueOnce({ rows: [{ id: 100 }] }),
          };
          const result = await fn(tx);
          passesHeld += 2;
          return result;
        })
        .mockImplementationOnce(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn()
              .mockResolvedValueOnce({ rows: [] })
              .mockResolvedValueOnce({ rows: [{ id: 1 }] })
              .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: totalPasses }] })
              .mockResolvedValueOnce({ rows: [{ passes_used: passesUsed, passes_total: totalPasses }] })
              .mockResolvedValueOnce({ rows: [{ total_held: String(passesHeld) }] }),
          };
          return fn(tx);
        });

      const result1 = await createGuestPassHold('member@test.com', 1, 2);
      expect(result1.success).toBe(true);
      expect(result1.passesHeld).toBe(2);

      const result2 = await createGuestPassHold('member@test.com', 2, 2);
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('Not enough guest passes');
    });

    it('createGuestPassHold issues FOR UPDATE on guest_passes row to serialize access', async () => {
      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 1 }] })
            .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total_held: '0' }] })
            .mockResolvedValueOnce({ rows: [{ id: 200 }] }),
        };
        return fn(tx);
      });

      await createGuestPassHold('member@test.com', 1, 1);

      const forUpdateCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('guest_passes')) &&
        c.strings.some(s => s.includes('FOR UPDATE'))
      );
      expect(forUpdateCall).toBeDefined();
    });

    it('hold correctly caps at available passes when requesting more than available', async () => {
      const mockTx = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] })
          .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
          .mockResolvedValueOnce({ rows: [{ passes_used: 3, passes_total: 4 }] })
          .mockResolvedValueOnce({ rows: [{ total_held: '0' }] })
          .mockResolvedValueOnce({ rows: [{ id: 200 }] }),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockTransaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

      const result = await createGuestPassHold('member@test.com', 1, 3);
      expect(result.success).toBe(true);
      expect(result.passesHeld).toBe(1);
      expect(result.passesAvailable).toBe(0);
    });
  });

  describe('Concurrent Hold-to-Usage Conversion (Idempotency)', () => {
    it('concurrent conversions: first converts, second finds no hold (idempotent)', async () => {
      mockTransaction
        .mockImplementationOnce(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn()
              .mockResolvedValueOnce({ rows: [{ id: 1, passes_held: 2 }] })
              .mockResolvedValueOnce({ rowCount: 1 })
              .mockResolvedValueOnce({ rowCount: 1 }),
          };
          return fn(tx);
        })
        .mockImplementationOnce(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn()
              .mockResolvedValueOnce({ rows: [] }),
          };
          return fn(tx);
        });

      const result1 = await convertHoldToUsage(1, 'member@test.com');
      expect(result1.success).toBe(true);
      expect(result1.passesConverted).toBe(2);

      const result2 = await convertHoldToUsage(1, 'member@test.com');
      expect(result2.success).toBe(true);
      expect(result2.passesConverted).toBe(0);
    });

    it('convertHoldToUsage issues FOR UPDATE on guest_pass_holds to prevent races', async () => {
      sqlCalls.length = 0;

      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [{ id: 1, passes_held: 1 }] })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({ rowCount: 1 }),
        };
        return fn(tx);
      });

      await convertHoldToUsage(1, 'member@test.com');

      const forUpdateCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('guest_pass_holds')) &&
        c.strings.some(s => s.includes('FOR UPDATE'))
      );
      expect(forUpdateCall).toBeDefined();
    });

    it('conversion creates guest_passes row if none exists', async () => {
      const executeCalls: string[] = [];

      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockImplementation((_query: unknown) => {
              const callIndex = executeCalls.length;
              executeCalls.push(`call_${callIndex}`);
              if (callIndex === 0) {
                return { rows: [{ id: 1, passes_held: 1 }] };
              }
              if (callIndex === 1) {
                return { rowCount: 0 };
              }
              if (callIndex === 2) {
                return { rows: [{ guest_passes_per_year: 4 }] };
              }
              if (callIndex === 3) {
                return { rowCount: 1 };
              }
              return { rowCount: 1 };
            }),
        };
        return fn(tx);
      });

      const result = await convertHoldToUsage(1, 'member@test.com');
      expect(result.success).toBe(true);
      expect(result.passesConverted).toBe(1);
      expect(executeCalls.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Guest Pass Consumption Double-Check Pattern', () => {
    it('UPDATE WHERE passes_used < passes_total prevents over-consumption', async () => {
      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [{ id: 1, used_guest_pass: false, guest_id: null }] })
            .mockResolvedValueOnce({ rows: [{ id: 'owner-1' }] })
            .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, passes_used: 4, passes_total: 4 }] }),
        };
        return fn(tx);
      });

      mockExecute.mockResolvedValue({ rows: [] });

      const result = await consumeGuestPassForParticipant(
        1, 'owner@test.com', 'Guest Name', 100, new Date(), 'staff@test.com'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No guest passes remaining');
    });

    it('concurrent consumption: second attempt fails due to double-check guard', async () => {
      let dbPassesUsed = 3;
      const passesTotal = 4;

      mockTransaction
        .mockImplementationOnce(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn()
              .mockResolvedValueOnce({ rows: [{ id: 1, used_guest_pass: false, guest_id: null }] })
              .mockResolvedValueOnce({ rows: [{ id: 'owner-1' }] })
              .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: passesTotal }] })
              .mockResolvedValueOnce({ rows: [{ id: 1, passes_used: dbPassesUsed, passes_total: passesTotal }] })
              .mockResolvedValueOnce({ rows: [{ remaining: passesTotal - dbPassesUsed - 1 }] })
              .mockResolvedValueOnce({ rows: [] })
              .mockResolvedValueOnce({ rowCount: 1 })
              .mockResolvedValueOnce({ rows: [{ id: 10 }] })
              .mockResolvedValueOnce({ rowCount: 1 }),
          };
          const result = await fn(tx);
          dbPassesUsed++;
          return result;
        })
        .mockImplementationOnce(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn()
              .mockResolvedValueOnce({ rows: [{ id: 2, used_guest_pass: false, guest_id: null }] })
              .mockResolvedValueOnce({ rows: [{ id: 'owner-1' }] })
              .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: passesTotal }] })
              .mockResolvedValueOnce({ rows: [{ id: 1, passes_used: dbPassesUsed, passes_total: passesTotal }] }),
          };
          return fn(tx);
        });

      mockExecute.mockResolvedValue({ rows: [] });

      const result1 = await consumeGuestPassForParticipant(
        1, 'owner@test.com', 'Guest A', 100, new Date(), 'staff@test.com'
      );
      expect(result1.success).toBe(true);

      const result2 = await consumeGuestPassForParticipant(
        2, 'owner@test.com', 'Guest B', 100, new Date(), 'staff@test.com'
      );
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('No guest passes remaining');
    });

    it('idempotent: consuming same participant twice returns success without double-counting', async () => {
      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [{ id: 1, used_guest_pass: true, guest_id: 5 }] }),
        };
        return fn(tx);
      });

      const result = await consumeGuestPassForParticipant(
        1, 'owner@test.com', 'Guest Name', 100, new Date(), 'staff@test.com'
      );

      expect(result.success).toBe(true);
      expect(result.passesRemaining).toBeUndefined();
    });

    it('UPDATE with WHERE passes_used < passes_total returns 0 rows on race condition', async () => {
      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [{ id: 1, used_guest_pass: false, guest_id: null }] })
            .mockResolvedValueOnce({ rows: [{ id: 'owner-1' }] })
            .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, passes_used: 3, passes_total: 4 }] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        return fn(tx);
      });

      mockExecute.mockResolvedValue({ rows: [] });

      const result = await consumeGuestPassForParticipant(
        1, 'owner@test.com', 'Guest Name', 100, new Date(), 'staff@test.com'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Race condition prevented over-consumption');
    });

    it('consumeGuestPassForParticipant issues FOR UPDATE on guest_passes to serialize access', async () => {
      sqlCalls.length = 0;

      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [{ id: 1, used_guest_pass: false, guest_id: null }] })
            .mockResolvedValueOnce({ rows: [{ id: 'owner-1' }] })
            .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, passes_used: 0, passes_total: 4 }] })
            .mockResolvedValueOnce({ rows: [{ remaining: 3 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ id: 10 }] })
            .mockResolvedValueOnce({ rowCount: 1 }),
        };
        return fn(tx);
      });

      mockExecute.mockResolvedValue({ rows: [] });

      const result = await consumeGuestPassForParticipant(
        1, 'owner@test.com', 'Guest Name', 100, new Date(), 'staff@test.com'
      );

      expect(result.success).toBe(true);

      const forUpdateCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('guest_passes')) &&
        c.strings.some(s => s.includes('FOR UPDATE'))
      );
      expect(forUpdateCall).toBeDefined();
    });

    it('consumeGuestPassForParticipant uses UPDATE WHERE passes_used < passes_total guard', async () => {
      sqlCalls.length = 0;

      mockTransaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn()
            .mockResolvedValueOnce({ rows: [{ id: 1, used_guest_pass: false, guest_id: null }] })
            .mockResolvedValueOnce({ rows: [{ id: 'owner-1' }] })
            .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, passes_used: 0, passes_total: 4 }] })
            .mockResolvedValueOnce({ rows: [{ remaining: 3 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ id: 10 }] })
            .mockResolvedValueOnce({ rowCount: 1 }),
        };
        return fn(tx);
      });

      mockExecute.mockResolvedValue({ rows: [] });

      await consumeGuestPassForParticipant(
        1, 'owner@test.com', 'Guest Name', 100, new Date(), 'staff@test.com'
      );

      const doubleCheckCall = sqlCalls.find(c =>
        c.strings.some(s => s.includes('passes_used')) &&
        c.strings.some(s => s.includes('passes_total')) &&
        c.strings.some(s => s.includes('passes_used = passes_used + 1'))
      );
      expect(doubleCheckCall).toBeDefined();
    });
  });

  describe('Available Guest Passes with Holds', () => {
    it('available = total - used - held (no negative values)', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 1, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [{ total_held: '2' }] });

      const result = await getAvailableGuestPasses('member@test.com');
      expect(result).toBe(1);
    });

    it('available never goes below 0 even with over-holds', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_year: 4 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 3, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [{ total_held: '5' }] });

      const result = await getAvailableGuestPasses('member@test.com');
      expect(result).toBe(0);
    });
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../server/utils/errorUtils', () => ({
  getErrorMessage: vi.fn((e: unknown) => String(e)),
}));

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

vi.mock('../server/core/bookingService/sessionManager', () => ({}));

import {
  getAvailableGuestPasses,
  cleanupExpiredHolds,
  createGuestPassHold,
  releaseGuestPassHold,
  convertHoldToUsage,
} from '../server/core/billing/guestPassHoldService';

describe('GuestPassHoldService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAvailableGuestPasses', () => {
    it('returns full allowance when no passes used and no holds', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total_held: '0' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(4);
    });

    it('subtracts used passes from total', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 2, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [{ total_held: '0' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(2);
    });

    it('subtracts held passes from available', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 1, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [{ total_held: '1' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(2);
    });

    it('returns 0 when all passes are used', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 4, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [{ total_held: '0' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(0);
    });

    it('returns 0 when passes used plus holds exceed total', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 3, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [{ total_held: '2' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(0);
    });

    it('defaults to 4 guest passes when tier not found', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total_held: '0' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(4);
    });

    it('updates passes_total when tier allows more than current total', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 6 }] })
        .mockResolvedValueOnce({ rows: [{ passes_used: 1, passes_total: 4 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total_held: '0' }] });

      const result = await getAvailableGuestPasses('test@example.com');
      expect(result).toBe(5);
      expect(mockExecute).toHaveBeenCalledTimes(4);
    });

    it('uses provided transaction context without managing its own', async () => {
      const txCtx = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ total_held: '0' }] }),
      };

      const result = await getAvailableGuestPasses('test@example.com', undefined, txCtx as any);
      expect(result).toBe(4);
      expect(txCtx.execute).toHaveBeenCalledTimes(3);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('normalizes email to lowercase and trimmed', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 4 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total_held: '0' }] });

      await getAvailableGuestPasses('  TEST@Example.COM  ');
      expect(mockExecute).toHaveBeenCalledTimes(3);
    });
  });

  describe('cleanupExpiredHolds', () => {
    it('returns count of deleted expired holds', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
      });

      const result = await cleanupExpiredHolds();
      expect(result).toBe(3);
    });

    it('returns 0 when no expired holds exist', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const result = await cleanupExpiredHolds();
      expect(result).toBe(0);
    });
  });

  describe('createGuestPassHold', () => {
    it('returns success with 0 held when passesNeeded is 0', async () => {
      const result = await createGuestPassHold('test@example.com', 1, 0);
      expect(result.success).toBe(true);
      expect(result.passesHeld).toBe(0);
    });

    it('returns success with 0 held when passesNeeded is negative', async () => {
      const result = await createGuestPassHold('test@example.com', 1, -1);
      expect(result.success).toBe(true);
      expect(result.passesHeld).toBe(0);
    });

    it('returns error when not enough passes available', async () => {
      const mockTx = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] })
          .mockResolvedValueOnce({ rows: [{ guest_passes_per_month: 2 }] })
          .mockResolvedValueOnce({ rows: [{ passes_used: 2, passes_total: 2 }] })
          .mockResolvedValueOnce({ rows: [{ total_held: '0' }] }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

      const result = await createGuestPassHold('test@example.com', 1, 3);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not enough guest passes');
    });
  });

  describe('releaseGuestPassHold', () => {
    it('returns passes released count', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ passes_held: 2 }, { passes_held: 1 }],
        rowCount: 2,
      });

      const result = await releaseGuestPassHold(123);
      expect(result.success).toBe(true);
      expect(result.passesReleased).toBe(3);
    });

    it('returns 0 when no holds exist for booking', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const result = await releaseGuestPassHold(999);
      expect(result.success).toBe(true);
      expect(result.passesReleased).toBe(0);
    });

    it('returns failure on DB error', async () => {
      mockExecute.mockRejectedValueOnce(new Error('DB error'));

      const result = await releaseGuestPassHold(123);
      expect(result.success).toBe(false);
      expect(result.passesReleased).toBe(0);
    });
  });

  describe('convertHoldToUsage', () => {
    it('returns 0 when no holds exist for booking', async () => {
      const mockTx = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

      const result = await convertHoldToUsage(123, 'test@example.com');
      expect(result.success).toBe(true);
      expect(result.passesConverted).toBe(0);
    });

    it('converts held passes to usage', async () => {
      const mockTx = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, passes_held: 3 }] })
          .mockResolvedValueOnce({ rowCount: 1 })
          .mockResolvedValueOnce({ rowCount: 1 }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

      const result = await convertHoldToUsage(123, 'test@example.com');
      expect(result.success).toBe(true);
      expect(result.passesConverted).toBe(3);
    });

    it('returns failure on DB error', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('DB error'));

      const result = await convertHoldToUsage(123, 'test@example.com');
      expect(result.success).toBe(false);
      expect(result.passesConverted).toBe(0);
    });
  });
});

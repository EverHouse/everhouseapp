// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('../server/core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../server/db', () => ({
  db: { execute: vi.fn(), select: vi.fn(), query: vi.fn() },
}));

vi.mock('drizzle-orm', () => ({
  sql: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
}));

import { validateBody } from '../server/middleware/validate';
import { z } from 'zod';

function createMockReq(body: unknown = {}) {
  return { body } as { body: unknown };
}

function createMockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as { status: (code: number) => typeof res; json: (data: unknown) => typeof res };
}

describe('validateBody middleware', () => {
  const schema = z.object({
    email: z.string().email(),
    amount: z.number().positive(),
  });

  it('passes valid body to next()', () => {
    const middleware = validateBody(schema);
    const req = createMockReq({ email: 'test@example.com', amount: 100 });
    const res = createMockRes();
    const next = vi.fn();

    middleware(req as never, res as never, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects invalid email', () => {
    const middleware = validateBody(schema);
    const req = createMockReq({ email: 'not-an-email', amount: 100 });
    const res = createMockRes();
    const next = vi.fn();

    middleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects negative amount', () => {
    const middleware = validateBody(schema);
    const req = createMockReq({ email: 'test@example.com', amount: -5 });
    const res = createMockRes();
    const next = vi.fn();

    middleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects missing required fields', () => {
    const middleware = validateBody(schema);
    const req = createMockReq({});
    const res = createMockRes();
    const next = vi.fn();

    middleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  getErrorMessage,
  getErrorCode,
  getErrorStatusCode,
  isStripeError,
  getFullErrorDetails,
  getErrorDetail,
  getErrorStack,
  getErrorProperty,
  safeErrorDetail,
} from '../server/utils/errorUtils';

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('returns string directly', () => {
    expect(getErrorMessage('raw string')).toBe('raw string');
  });

  it('converts non-string/non-Error to string', () => {
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});

describe('getErrorCode', () => {
  it('extracts code from error-like object', () => {
    expect(getErrorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
  });

  it('returns undefined for plain Error', () => {
    expect(getErrorCode(new Error('no code'))).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(getErrorCode(null)).toBeUndefined();
  });

  it('extracts code from Drizzle-wrapped error cause', () => {
    const drizzleError = new Error('DrizzleError');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (drizzleError as any).cause = { code: '23505' };
    expect(getErrorCode(drizzleError)).toBe('23505');
  });

  it('prefers direct code over cause code', () => {
    expect(getErrorCode({ code: 'DIRECT', cause: { code: '23505' } })).toBe('DIRECT');
  });

  it('extracts deadlock code from wrapped error', () => {
    const err = new Error('wrapped');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).cause = { code: '40P01' };
    expect(getErrorCode(err)).toBe('40P01');
  });
});

describe('getErrorStatusCode', () => {
  it('extracts statusCode', () => {
    expect(getErrorStatusCode({ statusCode: 404 })).toBe(404);
  });

  it('extracts status', () => {
    expect(getErrorStatusCode({ status: 500 })).toBe(500);
  });

  it('extracts nested response.status (HubSpot SDK pattern)', () => {
    expect(getErrorStatusCode({ response: { status: 429 } })).toBe(429);
  });

  it('extracts numeric code as fallback', () => {
    expect(getErrorStatusCode({ code: 503 })).toBe(503);
  });

  it('returns undefined when no status found', () => {
    expect(getErrorStatusCode(new Error('plain'))).toBeUndefined();
    expect(getErrorStatusCode(null)).toBeUndefined();
    expect(getErrorStatusCode('string')).toBeUndefined();
  });
});

describe('isStripeError', () => {
  it('identifies Stripe errors', () => {
    expect(isStripeError({ type: 'StripeCardError', message: 'declined' })).toBe(true);
    expect(isStripeError({ type: 'StripeInvalidRequestError', message: 'bad' })).toBe(true);
  });

  it('rejects non-Stripe errors', () => {
    expect(isStripeError({ type: 'ValidationError', message: 'bad' })).toBe(false);
    expect(isStripeError(new Error('test'))).toBe(false);
    expect(isStripeError(null)).toBe(false);
  });
});

describe('getFullErrorDetails', () => {
  it('returns all available details', () => {
    const err = Object.assign(new Error('test'), { code: 'E1', statusCode: 400 });
    const details = getFullErrorDetails(err);
    expect(details.message).toBe('test');
    expect(details.code).toBe('E1');
    expect(details.statusCode).toBe(400);
    expect(details.stack).toBeDefined();
  });
});

describe('getErrorDetail', () => {
  it('extracts detail property', () => {
    expect(getErrorDetail({ detail: 'column not found' })).toBe('column not found');
  });

  it('returns undefined when missing', () => {
    expect(getErrorDetail(new Error('test'))).toBeUndefined();
  });
});

describe('getErrorStack', () => {
  it('returns stack from Error', () => {
    const err = new Error('test');
    expect(getErrorStack(err)).toContain('Error: test');
  });

  it('returns stack from object with stack property', () => {
    expect(getErrorStack({ stack: 'fake stack' })).toBe('fake stack');
  });
});

describe('getErrorProperty', () => {
  it('extracts arbitrary property', () => {
    expect(getErrorProperty({ hint: 'try again' }, 'hint')).toBe('try again');
  });

  it('returns undefined for missing property', () => {
    expect(getErrorProperty({}, 'missing')).toBeUndefined();
  });
});

describe('safeErrorDetail', () => {
  it('redacts Stripe secret keys', () => {
    const result = safeErrorDetail(new Error('key: sk_live_abc123XYZ'));
    expect(result).not.toContain('sk_live_abc123XYZ');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts database connection strings', () => {
    const result = safeErrorDetail(new Error('postgresql://user:pass@host/db'));
    expect(result).not.toContain('user:pass');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const result = safeErrorDetail(new Error('Bearer eyJhbGciOiJIUzI1NiJ9.test'));
    expect(result).toContain('[REDACTED]');
  });

  it('truncates long messages to 200 chars', () => {
    const longMsg = 'x'.repeat(300);
    const result = safeErrorDetail(new Error(longMsg));
    expect(result.length).toBeLessThanOrEqual(201);
    expect(result).toContain('…');
  });

  it('takes only first line', () => {
    const result = safeErrorDetail(new Error('line1\nline2\nline3'));
    expect(result).toBe('line1');
  });

  it('handles non-Error input', () => {
    expect(safeErrorDetail('simple string')).toBe('simple string');
    expect(safeErrorDetail(null)).toBe('null');
  });
});

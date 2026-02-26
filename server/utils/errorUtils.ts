function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return isNonNullObject(value) && key in value;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function getErrorCode(error: unknown): string | undefined {
  return hasProperty(error, 'code') ? String(error.code) : undefined;
}

export function getErrorStatusCode(error: unknown): number | undefined {
  if (hasProperty(error, 'statusCode')) return Number(error.statusCode);
  if (hasProperty(error, 'status')) return Number(error.status);
  if (hasProperty(error, 'code') && typeof error.code === 'number') return error.code;
  return undefined;
}

export function isStripeError(error: unknown): error is { type: string; message: string; code?: string; statusCode?: number } {
  return hasProperty(error, 'type') &&
    typeof error.type === 'string' &&
    error.type.startsWith('Stripe');
}

export function getFullErrorDetails(error: unknown): { message: string; code?: string; statusCode?: number; stack?: string } {
  return {
    message: getErrorMessage(error),
    code: getErrorCode(error),
    statusCode: getErrorStatusCode(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

export function getErrorDetail(error: unknown): string | undefined {
  return hasProperty(error, 'detail') ? String(error.detail) : undefined;
}

export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  return hasProperty(error, 'stack') ? String(error.stack) : undefined;
}

export function getErrorProperty(error: unknown, key: string): unknown {
  return hasProperty(error, key) ? error[key] : undefined;
}

const SENSITIVE_PATTERNS = [
  /postgres(?:ql)?:\/\/[^\s]+/gi,
  /mysql:\/\/[^\s]+/gi,
  /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
  /redis:\/\/[^\s]+/gi,
  /sk_(?:live|test)_[A-Za-z0-9]+/g,
  /pk_(?:live|test)_[A-Za-z0-9]+/g,
  /rk_(?:live|test)_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /password[=:]\s*\S+/gi,
  /secret[=:]\s*\S+/gi,
  /apikey[=:]\s*\S+/gi,
  /token[=:]\s*\S+/gi,
];

export function safeErrorDetail(error: unknown): string {
  const raw = getErrorMessage(error);
  let sanitized = raw;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  const firstLine = sanitized.split('\n')[0];
  if (firstLine.length > 200) {
    return firstLine.slice(0, 200) + '…';
  }
  return firstLine;
}

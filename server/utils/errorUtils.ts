function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return isNonNullObject(value) && key in value;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error) {
      return `${error.message} [cause: ${cause.message}]`;
    }
    if (typeof cause === 'string') {
      return `${error.message} [cause: ${cause}]`;
    }
    if (isNonNullObject(cause) && 'message' in cause && typeof cause.message === 'string') {
      return `${error.message} [cause: ${cause.message}]`;
    }
    return error.message;
  }
  if (typeof error === 'string') return error;
  return String(error);
}

export function getErrorCode(error: unknown): string | undefined {
  if (hasProperty(error, 'code') && error.code) return String(error.code);
  if (hasProperty(error, 'cause') && isNonNullObject(error.cause) && 'code' in error.cause && error.cause.code) return String(error.cause.code);
  return undefined;
}

export function isStripeResourceMissing(error: unknown): boolean {
  if (getErrorCode(error) === 'resource_missing') return true;
  const statusCode = getErrorStatusCode(error);
  const message = getErrorMessage(error);
  if (statusCode === 404 && /No such (customer|subscription|invoice|charge|payment_intent|product|price|plan|coupon|promotion_code|tax_rate|setup_intent)/i.test(message)) return true;
  return false;
}

export function getErrorStatusCode(error: unknown): number | undefined {
  if (hasProperty(error, 'statusCode')) return Number(error.statusCode);
  if (hasProperty(error, 'status')) return Number(error.status);
  if (hasProperty(error, 'response') && isNonNullObject(error.response) && 'status' in error.response) return Number(error.response.status);
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

export interface ParsedConstraintError {
  table: string;
  message: string;
  isConstraintError: boolean;
  constraintName?: string;
}

export function parseConstraintError(error: unknown): ParsedConstraintError {
  const msg = getErrorMessage(error);
  const detail = getErrorDetail(error);
  const code = getErrorCode(error);

  const constraintCodes = new Set(['23514', '23505', '23503', '23502', '23P01', 'P0001']);
  const isConstraintError = !!code && constraintCodes.has(code);

  const pgTable = hasProperty(error, 'table') ? String(error.table) : undefined;
  const pgConstraint = hasProperty(error, 'constraint') ? String(error.constraint) : undefined;

  const triggerMatch = msg.match(/^\[(\w+)\]\s*(.+)/);
  if (triggerMatch) {
    return {
      table: triggerMatch[1],
      message: triggerMatch[2],
      isConstraintError: true,
    };
  }

  const checkMatch = msg.match(/new row for relation "(\w+)" violates check constraint "(\w+)"/);
  if (checkMatch) {
    return {
      table: pgTable || checkMatch[1],
      message: `Check constraint violation: ${checkMatch[2]}`,
      isConstraintError: true,
      constraintName: pgConstraint || checkMatch[2],
    };
  }

  const uniqueMatch = msg.match(/duplicate key value violates unique constraint "(\w+)"/);
  if (uniqueMatch) {
    return {
      table: pgTable || 'unknown',
      message: `Duplicate value violates unique constraint: ${uniqueMatch[1]}`,
      isConstraintError: true,
      constraintName: pgConstraint || uniqueMatch[1],
    };
  }

  if (code === '23503') {
    const fkMatch = msg.match(/violates foreign key constraint "(\w+)"/);
    return {
      table: pgTable || 'unknown',
      message: fkMatch ? `Foreign key violation: ${fkMatch[1]}` : msg,
      isConstraintError: true,
      constraintName: pgConstraint || fkMatch?.[1],
    };
  }

  if (code === '23502') {
    const notNullMatch = msg.match(/null value in column "(\w+)" of relation "(\w+)"/);
    return {
      table: pgTable || notNullMatch?.[2] || 'unknown',
      message: notNullMatch ? `NOT NULL violation on column "${notNullMatch[1]}"` : msg,
      isConstraintError: true,
      constraintName: pgConstraint,
    };
  }

  if (code === '23P01') {
    const exclMatch = msg.match(/conflicting key value violates exclusion constraint "(\w+)"/);
    return {
      table: pgTable || 'unknown',
      message: exclMatch ? `Exclusion constraint violation: ${exclMatch[1]}` : msg,
      isConstraintError: true,
      constraintName: pgConstraint || exclMatch?.[1],
    };
  }

  if (isConstraintError) {
    const raiseMatch = msg.match(/(?:ERROR:\s*)?(.+)/);
    return {
      table: pgTable || 'unknown',
      message: raiseMatch ? raiseMatch[1] : msg,
      isConstraintError: true,
      constraintName: pgConstraint,
    };
  }

  return {
    table: pgTable || 'unknown',
    message: msg,
    isConstraintError: false,
  };
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

/**
 * Shared error handling utilities for consistent, user-friendly error messages
 */

/**
 * Safely extract error message from unknown error type
 * Use this instead of 'catch (error: unknown)' pattern
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Extract request ID from API response headers
 */
export function getRequestId(response: Response): string | null {
  return response.headers.get('X-Request-Id');
}

export interface ApiError {
  status?: number;
  message?: string;
}

/**
 * Get a user-friendly error message based on HTTP status code
 * @param response - Fetch Response object or status code
 * @param context - Optional context for the error (e.g., "load billing info", "save event")
 */
export function getApiErrorMessage(response: Response | number, context?: string): string {
  const status = typeof response === 'number' ? response : response.status;
  const action = context ? ` ${context}` : '';
  
  switch (status) {
    case 401:
      return 'Session expired. Please refresh the page to log in again.';
    case 403:
      return 'You don\'t have permission to perform this action.';
    case 404:
      return `Could not find the requested resource${action ? ` to${action}` : ''}.`;
    case 409:
      return 'This action conflicts with another change. Please refresh and try again.';
    case 422:
      return 'The provided information is invalid. Please check and try again.';
    case 429:
      return 'Too many requests. Please wait a moment and try again.';
    default:
      if (status >= 500) {
        return 'Server error. The system may be temporarily unavailable. Please try again.';
      }
      return `Failed to${action || ' complete action'}. Please try again.`;
  }
}

/**
 * Get a user-friendly error message for network/fetch errors
 */
export function getNetworkErrorMessage(): string {
  return 'Network error. Check your connection and try again.';
}

/**
 * Handle a fetch response and return appropriate error message if not ok
 * @param response - Fetch Response object
 * @param context - Optional context for the error
 * @returns null if response is ok, error message string if not
 */
export function handleResponseError(response: Response, context?: string): string | null {
  if (response.ok) return null;
  return getApiErrorMessage(response, context);
}

/**
 * Wrapper for fetch that provides consistent error handling
 * Use in try/catch blocks for consistent error messaging
 */
export async function fetchWithErrorHandling<T>(
  url: string,
  options?: RequestInit,
  context?: string
): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      ...options,
    });
    
    if (!response.ok) {
      return { data: null, error: getApiErrorMessage(response, context) };
    }
    
    const data = await response.json();
    return { data, error: null };
  } catch (err: unknown) {
    console.error(`Failed to ${context || 'fetch'}:`, err);
    return { data: null, error: getNetworkErrorMessage() };
  }
}

/**
 * Extract error message from API response body or use fallback
 */
export async function extractApiError(response: Response, context?: string): Promise<string> {
  try {
    const body = await response.json();
    if (body.error && typeof body.error === 'string') {
      return body.error;
    }
    if (body.message && typeof body.message === 'string') {
      return body.message;
    }
  } catch {
    // Response body is not JSON or already consumed
  }
  return getApiErrorMessage(response, context);
}

export interface ApiErrorDetails {
  message: string;
  requestId: string | null;
  status: number;
}

/**
 * Extract full error details including request ID for support purposes
 */
export async function extractApiErrorDetails(response: Response, context?: string): Promise<ApiErrorDetails> {
  const requestId = getRequestId(response);
  let message = getApiErrorMessage(response, context);
  
  try {
    const body = await response.clone().json();
    if (body.error && typeof body.error === 'string') {
      message = body.error;
    } else if (body.message && typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // Response body is not JSON or already consumed
  }
  
  return {
    message,
    requestId,
    status: response.status
  };
}

/**
 * Log error with request ID for debugging
 */
export function logApiError(context: string, details: ApiErrorDetails): void {
  console.error(`[${context}] ${details.message}`, {
    status: details.status,
    requestId: details.requestId
  });
}

const backendErrorPatterns: Array<{ test: (msg: string) => boolean; friendly: string }> = [
  {
    test: (msg) => /unique.?constraint|duplicate key|UNIQUE_CONSTRAINT/i.test(msg),
    friendly: 'This record already exists. Please try a different value.',
  },
  {
    test: (msg) => /foreign.?key|violates foreign key|FOREIGN_KEY/i.test(msg),
    friendly: 'This item is referenced by other records and cannot be modified.',
  },
  {
    test: (msg) => /not.?null|null value in column|NOT_NULL/i.test(msg),
    friendly: 'A required field is missing. Please fill in all required fields.',
  },
  {
    test: (msg) => /check.?constraint|CHECK_CONSTRAINT/i.test(msg),
    friendly: "The provided value doesn't meet the requirements. Please check and try again.",
  },
  {
    test: (msg) => /timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg),
    friendly: 'The server is taking too long to respond. Please try again.',
  },
  {
    test: (msg) => /stripe/i.test(msg) && /card|declined/i.test(msg),
    friendly: 'Your payment could not be processed. Please check your card details.',
  },
  {
    test: (msg) => /^Internal/i.test(msg) || /stack|at \//i.test(msg),
    friendly: 'Something went wrong. Please try again or contact support.',
  },
];

/**
 * Translate common backend error strings to user-friendly messages.
 * Returns the original message if no pattern matches.
 */
export function mapBackendError(message: string): string {
  for (const pattern of backendErrorPatterns) {
    if (pattern.test(message)) {
      return pattern.friendly;
    }
  }
  return message;
}

/**
 * Extract error from API response, map it through backend error patterns,
 * and return a user-friendly string.
 *
 * Fallback chain: extractApiError → mapBackendError → getApiErrorMessage (status-based) → generic fallback.
 */
export async function extractUserFriendlyError(response: Response, context?: string): Promise<string> {
  let rawMessage: string | null = null;

  try {
    const body = await response.clone().json();
    if (body.error && typeof body.error === 'string') {
      rawMessage = body.error;
    } else if (body.message && typeof body.message === 'string') {
      rawMessage = body.message;
    }
  } catch {
    // Response body is not JSON or already consumed
  }

  if (rawMessage) {
    const mapped = mapBackendError(rawMessage);
    if (mapped !== rawMessage) {
      return mapped;
    }
    return rawMessage;
  }

  return getApiErrorMessage(response, context);
}

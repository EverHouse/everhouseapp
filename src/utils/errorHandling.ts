/**
 * Shared error handling utilities for consistent, user-friendly error messages
 */

/**
 * Safely extract error message from unknown error type
 * Use this instead of 'catch (error: any)' pattern
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
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
  } catch (err) {
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

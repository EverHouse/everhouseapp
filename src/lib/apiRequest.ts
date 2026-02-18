const isDev = import.meta.env.DEV;

// CSRF protection removed - SameSite cookies + CORS provide sufficient protection for SPA

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  errorType?: string;
  errorData?: Record<string, unknown>;
}

interface RetryConfig {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryNonIdempotent?: boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 8000,
  retryNonIdempotent: false,
};

const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function isIdempotentMethod(method?: string): boolean {
  return IDEMPOTENT_METHODS.includes((method || 'GET').toUpperCase());
}

function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const retryablePatterns = [
    'network',
    'fetch',
    'timeout',
    'aborted',
    'load failed',
    'failed to fetch',
    'networkerror',
    'connection',
    'econnreset',
    'socket hang up',
    'service unavailable',
  ];
  return retryablePatterns.some(pattern => message.includes(pattern));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function apiRequest<T = unknown>(
  url: string,
  options?: RequestInit,
  retryConfig?: RetryConfig
): Promise<ApiResult<T>> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  const method = options?.method || 'GET';
  const canRetry = isIdempotentMethod(method) || config.retryNonIdempotent;
  const maxRetries = canRetry ? (config.maxRetries || 3) : 1;
  
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const headers: Record<string, string> = {
        ...(options?.headers as Record<string, string> || {}),
      };

      const res = await fetch(url, {
        ...options,
        headers,
        credentials: 'include',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const error = errorData.error || errorData.message || `Request failed (${res.status})`;
        if (isDev) console.error('[API]', url, error);
        
        const isServerOrColdStart = res.status >= 500 || res.status === 502 || res.status === 503 || res.status === 504;
        if (isServerOrColdStart && canRetry && attempt < maxRetries) {
          lastError = new Error(error);
          const delayMs = Math.min(
            (config.baseDelay || 500) * Math.pow(2, attempt - 1),
            config.maxDelay || 5000
          );
          if (isDev) console.log(`[API] Retrying ${url} in ${delayMs}ms (attempt ${attempt}/${maxRetries})...`);
          await delay(delayMs);
          continue;
        }
        
        return { 
          ok: false, 
          error,
          errorType: errorData.errorType,
          errorData: errorData
        };
      }

      // Handle potential empty response body gracefully
      const text = await res.text();
      let data: T;
      try {
        data = text ? JSON.parse(text) : {} as T;
      } catch {
        // If response is not valid JSON but status was ok, treat as success with empty data
        data = {} as T;
      }
      return { ok: true, data };
    } catch (err: unknown) {
      lastError = err;
      
      if (canRetry && isRetryableError(err) && attempt < maxRetries) {
        const delayMs = Math.min(
          (config.baseDelay || 500) * Math.pow(2, attempt - 1),
          config.maxDelay || 5000
        );
        if (isDev) console.log(`[API] Retrying ${url} in ${delayMs}ms (attempt ${attempt}/${maxRetries})...`);
        await delay(delayMs);
        continue;
      }

      if (isDev) console.error('[API]', url, (err instanceof Error ? err.message : String(err)));
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) || 'Network error' };
    }
  }

  return { ok: false, error: (lastError instanceof Error ? lastError.message : null) || 'Request failed after retries' };
}

export async function apiRequestNoRetry<T = unknown>(
  url: string,
  options?: RequestInit
): Promise<ApiResult<T>> {
  return apiRequest<T>(url, options, { maxRetries: 1 });
}

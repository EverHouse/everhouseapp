const isDev = import.meta.env.DEV;

export interface ApiResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
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

function isRetryableError(error: any): boolean {
  if (!error) return false;
  const message = (error.message || '').toLowerCase();
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

export async function apiRequest<T = any>(
  url: string,
  options?: RequestInit,
  retryConfig?: RetryConfig
): Promise<ApiResult<T>> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  const method = options?.method || 'GET';
  const canRetry = isIdempotentMethod(method) || config.retryNonIdempotent;
  const maxRetries = canRetry ? (config.maxRetries || 3) : 1;
  
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(url, {
        ...options,
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
        
        return { ok: false, error };
      }

      const data = await res.json();
      return { ok: true, data };
    } catch (err: any) {
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

      if (isDev) console.error('[API]', url, err.message);
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  return { ok: false, error: lastError?.message || 'Request failed after retries' };
}

export async function apiRequestNoRetry<T = any>(
  url: string,
  options?: RequestInit
): Promise<ApiResult<T>> {
  return apiRequest<T>(url, options, { maxRetries: 1 });
}

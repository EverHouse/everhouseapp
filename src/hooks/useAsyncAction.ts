import { useCallback, useRef, useState } from 'react';

interface UseAsyncActionOptions<T = unknown> {
  onSuccess?: (result: T) => void;
  onError?: (error: Error) => void;
  debounceMs?: number;
}

/**
 * Hook that prevents double-tap/double-submit issues for async operations.
 * Provides loading and error states with optional debounce protection.
 *
 * @example
 * const { execute, isLoading, error } = useAsyncAction(
 *   async () => {
 *     await api.approveBooking(id);
 *   },
 *   { onSuccess: () => showToast('Approved!') }
 * );
 *
 * <button onClick={execute} disabled={isLoading}>
 *   {isLoading ? 'Processing...' : 'Approve'}
 * </button>
 */
export function useAsyncAction<T = unknown, Args extends unknown[] = unknown[]>(
  asyncFn: (...args: Args) => Promise<T>,
  options: UseAsyncActionOptions<T> = {}
) {
  const { onSuccess, onError, debounceMs = 300 } = options;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Refs to avoid recreating execute function on every render
  const asyncFnRef = useRef(asyncFn);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  const debounceRef = useRef(Math.max(300, debounceMs));

  // Keep refs in sync with current props
  asyncFnRef.current = asyncFn;
  onSuccessRef.current = onSuccess;
  onErrorRef.current = onError;
  debounceRef.current = Math.max(300, debounceMs);

  // Track execution state to prevent double calls
  const isLoadingRef = useRef(false);
  const lastExecutionTimeRef = useRef(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const execute = useCallback(
    async (...args: Args): Promise<T | undefined> => {
      // Prevent execution if already loading
      if (isLoadingRef.current) {
        return undefined;
      }

      const now = Date.now();
      const timeSinceLastExecution = now - lastExecutionTimeRef.current;

      // If minimum debounce time hasn't passed, schedule retry
      if (timeSinceLastExecution < debounceRef.current && lastExecutionTimeRef.current > 0) {
        const waitTime = debounceRef.current - timeSinceLastExecution;

        return new Promise((resolve, reject) => {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = setTimeout(async () => {
            try {
              const result = await execute(...args);
              resolve(result);
            } catch (err) {
              reject(err);
            }
          }, waitTime);
        });
      }

      setIsLoading(true);
      isLoadingRef.current = true;
      setError(null);
      lastExecutionTimeRef.current = Date.now();

      try {
        const result = await asyncFnRef.current(...args);
        onSuccessRef.current?.(result);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        onErrorRef.current?.(error);
        throw error;
      } finally {
        setIsLoading(false);
        isLoadingRef.current = false;
      }
    },
    []
  );

  const reset = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setError(null);
  }, []);

  return {
    execute,
    isLoading,
    error,
    reset
  };
}

export default useAsyncAction;

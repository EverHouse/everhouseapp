import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { getApiErrorMessage, mapBackendError } from '../utils/errorHandling';
import { haptic } from '../utils/haptics';

interface UseAppMutationOptions<TData, TVariables, TContext = unknown> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  successMessage?: string;
  errorMessage?: string;
  showSuccessToast?: boolean;
  showErrorToast?: boolean;
  hapticFeedback?: boolean;
  optimisticUpdate?: {
    queryKey: unknown[];
    updater: (old: unknown, variables: TVariables) => unknown;
  };
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  invalidateKeys?: unknown[][];
}

function getErrorString(error: unknown, fallback?: string): string {
  if (error instanceof Response) {
    return getApiErrorMessage(error);
  }
  if (error instanceof Error) {
    const raw = error.message || fallback || 'Something went wrong. Please try again.';
    return mapBackendError(raw);
  }
  if (typeof error === 'string') {
    return mapBackendError(error);
  }
  return fallback || 'Something went wrong. Please try again.';
}

export function useAppMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: UseAppMutationOptions<TData, TVariables, TContext>
) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const {
    mutationFn,
    successMessage = 'Done!',
    errorMessage,
    showSuccessToast = true,
    showErrorToast = true,
    hapticFeedback = true,
    optimisticUpdate,
    onSuccess,
    onError,
    invalidateKeys,
  } = options;

  return useMutation<TData, Error, TVariables, { previousData?: unknown }>({
    mutationFn,
    onMutate: optimisticUpdate
      ? async (variables: TVariables) => {
          await queryClient.cancelQueries({ queryKey: optimisticUpdate.queryKey });
          const previousData = queryClient.getQueryData(optimisticUpdate.queryKey);
          queryClient.setQueryData(
            optimisticUpdate.queryKey,
            (old: unknown) => optimisticUpdate.updater(old, variables)
          );
          return { previousData };
        }
      : undefined,
    onSuccess: (data: TData, variables: TVariables) => {
      if (hapticFeedback) {
        haptic.success();
      }
      if (showSuccessToast) {
        showToast(successMessage, 'success');
      }
      if (invalidateKeys) {
        invalidateKeys.forEach((key) => {
          queryClient.invalidateQueries({ queryKey: key });
        });
      }
      onSuccess?.(data, variables);
    },
    onError: (error: Error, variables: TVariables, context) => {
      if (hapticFeedback) {
        haptic.error();
      }
      if (optimisticUpdate && context?.previousData !== undefined) {
        queryClient.setQueryData(optimisticUpdate.queryKey, context.previousData);
      }
      if (showErrorToast) {
        const message = errorMessage || getErrorString(error);
        showToast(message, 'error');
      }
      onError?.(error, variables);
    },
    onSettled: optimisticUpdate
      ? () => {
          queryClient.invalidateQueries({ queryKey: optimisticUpdate.queryKey });
        }
      : undefined,
  });
}

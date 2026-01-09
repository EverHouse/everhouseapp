import React from 'react';

interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  variant?: 'default' | 'compact' | 'inline';
}

const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'Something went wrong',
  message = 'We encountered an error loading this content. Please try again.',
  onRetry,
  variant = 'default'
}) => {
  if (variant === 'inline') {
    return (
      <div className="flex items-center gap-3 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
        <span className="material-symbols-outlined text-red-500 dark:text-red-400">error</span>
        <span className="text-sm text-red-700 dark:text-red-300 flex-1">{message}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-sm font-semibold text-red-600 dark:text-red-400 hover:underline"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const isCompact = variant === 'compact';

  return (
    <div className={`flex flex-col items-center justify-center text-center ${isCompact ? 'py-8 px-4' : 'py-16 px-6'} animate-pop-in`}>
      <div className={`relative ${isCompact ? 'mb-3' : 'mb-6'}`}>
        <div className={`${isCompact ? 'w-16 h-16' : 'w-24 h-24'} rounded-full bg-gradient-to-br from-red-100 to-red-50 dark:from-red-500/20 dark:to-red-500/10 flex items-center justify-center`}>
          <span className={`material-symbols-outlined ${isCompact ? 'text-3xl' : 'text-5xl'} text-red-500 dark:text-red-400`}>
            error_outline
          </span>
        </div>
      </div>

      <h3 className={`${isCompact ? 'text-base' : 'text-xl'} font-semibold text-primary dark:text-white mb-2`}>
        {title}
      </h3>

      <p className={`${isCompact ? 'text-xs' : 'text-sm'} text-primary/60 dark:text-white/60 max-w-[280px] mb-4`}>
        {message}
      </p>

      {onRetry && (
        <button
          onClick={onRetry}
          className={`
            inline-flex items-center gap-2 
            ${isCompact ? 'px-4 py-2 text-sm' : 'px-6 py-3 text-base'}
            bg-red-500 hover:bg-red-600
            text-white 
            rounded-2xl font-semibold 
            hover:scale-[1.02] active:scale-[0.98] 
            transition-all duration-300
            shadow-lg hover:shadow-xl
          `}
        >
          <span className="material-symbols-outlined text-lg">refresh</span>
          Try Again
        </button>
      )}
    </div>
  );
};

export const NetworkError: React.FC<{ onRetry?: () => void }> = ({ onRetry }) => (
  <ErrorState
    title="Connection Error"
    message="Unable to connect to the server. Please check your internet connection and try again."
    onRetry={onRetry}
    variant="compact"
  />
);

export const NotFoundError: React.FC<{ item?: string }> = ({ item = 'content' }) => (
  <ErrorState
    title="Not Found"
    message={`The ${item} you're looking for doesn't exist or has been removed.`}
    variant="compact"
  />
);

export default ErrorState;

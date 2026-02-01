import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  featureName: string;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showRetry?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

class FeatureErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, retryCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[FeatureErrorBoundary - ${this.props.featureName}] Error:`, error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState(prev => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1
    }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const canRetry = this.props.showRetry !== false && this.state.retryCount < 3;

      return (
        <div className="flex items-center justify-center p-6 min-h-[120px]">
          <div className="text-center max-w-xs">
            <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-red-500/10 dark:bg-red-500/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-lg text-red-400">
                error_outline
              </span>
            </div>
            <h3 className="text-sm font-semibold mb-1 text-gray-800 dark:text-white">
              {this.props.featureName} unavailable
            </h3>
            <p className="text-xs text-gray-500 dark:text-white/60 mb-3">
              Something went wrong loading this section.
            </p>
            {canRetry && (
              <button
                onClick={this.handleRetry}
                className="px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white rounded-lg hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default FeatureErrorBoundary;

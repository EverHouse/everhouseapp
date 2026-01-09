import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  pageName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

class PageErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, retryCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[PageErrorBoundary${this.props.pageName ? ` - ${this.props.pageName}` : ''}] Error:`, error, errorInfo);
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

      const isNetworkError = this.state.error?.message?.toLowerCase().includes('fetch') ||
                              this.state.error?.message?.toLowerCase().includes('network') ||
                              this.state.error?.message?.toLowerCase().includes('load failed');
      const canRetry = this.state.retryCount < 3;

      return (
        <div className="flex items-center justify-center min-h-[50vh] p-6">
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-2xl text-red-400">
                {isNetworkError ? 'wifi_off' : 'error'}
              </span>
            </div>
            <h2 className="text-lg font-semibold mb-2 text-primary dark:text-white">
              {isNetworkError ? 'Connection Issue' : 'Unable to load'}
            </h2>
            <p className="text-gray-600 dark:text-white/60 text-sm mb-4">
              {isNetworkError 
                ? 'Please check your connection and try again.'
                : 'Something went wrong loading this section.'}
            </p>
            {canRetry && (
              <button
                onClick={this.handleRetry}
                className="px-5 py-2.5 bg-accent text-brand-green rounded-xl font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryCount}>{this.props.children}</React.Fragment>;
  }
}

export default PageErrorBoundary;

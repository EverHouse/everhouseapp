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

const RELOAD_COUNT_KEY = 'error_reload_count';
const RELOAD_TIMESTAMP_KEY = 'error_reload_timestamp';
const MAX_AUTO_RELOADS = 2;
const RELOAD_WINDOW_MS = 60000;

function getReloadCount(): number {
  const timestamp = sessionStorage.getItem(RELOAD_TIMESTAMP_KEY);
  const count = sessionStorage.getItem(RELOAD_COUNT_KEY);
  
  if (!timestamp || !count) return 0;
  
  const elapsed = Date.now() - parseInt(timestamp, 10);
  if (elapsed > RELOAD_WINDOW_MS) {
    sessionStorage.removeItem(RELOAD_COUNT_KEY);
    sessionStorage.removeItem(RELOAD_TIMESTAMP_KEY);
    return 0;
  }
  
  return parseInt(count, 10) || 0;
}

function incrementReloadCount(): number {
  const currentCount = getReloadCount();
  const newCount = currentCount + 1;
  sessionStorage.setItem(RELOAD_COUNT_KEY, newCount.toString());
  sessionStorage.setItem(RELOAD_TIMESTAMP_KEY, Date.now().toString());
  return newCount;
}

function clearReloadCount(): void {
  sessionStorage.removeItem(RELOAD_COUNT_KEY);
  sessionStorage.removeItem(RELOAD_TIMESTAMP_KEY);
}

function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  const message = error.message?.toLowerCase() || '';
  return (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('loading chunk') ||
    message.includes('loading css chunk') ||
    message.includes('dynamically imported module') ||
    (message.includes('failed to fetch') && message.includes('.js'))
  );
}

class PageErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, retryCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[PageErrorBoundary${this.props.pageName ? ` - ${this.props.pageName}` : ''}] Error:`, error, errorInfo);
    
    if (isChunkLoadError(error)) {
      const reloadCount = getReloadCount();
      
      if (reloadCount < MAX_AUTO_RELOADS) {
        console.log(`[PageErrorBoundary] Detected stale chunk error, auto-reload ${reloadCount + 1}/${MAX_AUTO_RELOADS}...`);
        incrementReloadCount();
        window.location.reload();
      } else {
        console.log('[PageErrorBoundary] Max auto-reloads reached, showing error UI');
      }
    }
  }

  handleRetry = () => {
    this.setState(prev => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1
    }));
  };

  handleHardReload = () => {
    clearReloadCount();
    window.location.reload();
  };

  handleClearCacheAndReload = async () => {
    clearReloadCount();
    
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
    } catch (err) {
      console.error('Failed to clear caches:', err);
    }
    
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isChunkError = isChunkLoadError(this.state.error);
      const isNetworkError = this.state.error?.message?.toLowerCase().includes('fetch') ||
                              this.state.error?.message?.toLowerCase().includes('network') ||
                              this.state.error?.message?.toLowerCase().includes('load failed');
      const canRetry = this.state.retryCount < 3;
      const reloadCount = getReloadCount();
      const hitReloadLimit = reloadCount >= MAX_AUTO_RELOADS;

      if (isChunkError && hitReloadLimit) {
        return (
          <div className="flex items-center justify-center min-h-[50vh] p-6">
            <div className="text-center max-w-sm">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-2xl text-amber-400">
                  update
                </span>
              </div>
              <h2 className="text-lg font-semibold mb-2 text-primary dark:text-white">
                App Update Required
              </h2>
              <p className="text-gray-600 dark:text-white/60 text-sm mb-4">
                A new version is available but couldn't load automatically. Try clearing the cache or contact support if the issue persists.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={this.handleClearCacheAndReload}
                  className="px-5 py-2.5 bg-accent text-brand-green rounded-xl font-medium text-sm hover:opacity-90 transition-opacity"
                >
                  Clear Cache & Refresh
                </button>
                <a
                  href="mailto:support@everclub.app?subject=App Loading Issue"
                  className="px-5 py-2.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl font-medium text-sm hover:bg-gray-200 dark:hover:bg-white/20 transition-colors text-center"
                >
                  Contact Support
                </a>
              </div>
            </div>
          </div>
        );
      }

      if (isChunkError && !hitReloadLimit) {
        return (
          <div className="flex items-center justify-center min-h-[50vh] p-6">
            <div className="text-center max-w-sm">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-2xl text-amber-400">
                  update
                </span>
              </div>
              <h2 className="text-lg font-semibold mb-2 text-primary dark:text-white">
                App Updated
              </h2>
              <p className="text-gray-600 dark:text-white/60 text-sm mb-4">
                A new version is available. Please refresh to continue.
              </p>
              <button
                onClick={this.handleHardReload}
                className="px-5 py-2.5 bg-accent text-brand-green rounded-xl font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Refresh Now
              </button>
            </div>
          </div>
        );
      }

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
            <div className="flex flex-col gap-2">
              {canRetry && (
                <button
                  onClick={this.handleRetry}
                  className="px-5 py-2.5 bg-accent text-brand-green rounded-xl font-medium text-sm hover:opacity-90 transition-opacity"
                >
                  Try Again
                </button>
              )}
              {!canRetry && (
                <>
                  <button
                    onClick={this.handleHardReload}
                    className="px-5 py-2.5 bg-accent text-brand-green rounded-xl font-medium text-sm hover:opacity-90 transition-opacity"
                  >
                    Refresh Page
                  </button>
                  <a
                    href="mailto:support@everclub.app?subject=App Error Report"
                    className="px-5 py-2.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl font-medium text-sm hover:bg-gray-200 dark:hover:bg-white/20 transition-colors text-center"
                  >
                    Contact Support
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryCount}>{this.props.children}</React.Fragment>;
  }
}

export default PageErrorBoundary;

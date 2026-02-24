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
  autoRetryCount: number;
  countdown: number | null;
}

const MAX_AUTO_RETRIES = 2;
const AUTO_RETRY_DELAYS = [3, 5];

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
    message.includes('is not a valid javascript mime type') ||
    message.includes('unable to preload') ||
    (message.includes('failed to fetch') && message.includes('.js'))
  );
}

class PageErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, retryCount: 0, autoRetryCount: 0, countdown: null };

  private retryTimerRef: ReturnType<typeof setTimeout> | null = null;
  private countdownTimerRef: ReturnType<typeof setInterval> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[PageErrorBoundary${this.props.pageName ? ` - ${this.props.pageName}` : ''}] Error:`, error, errorInfo);
    
    try {
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          page: this.props.pageName || 'unknown',
          error: error.message,
          stack: error.stack?.substring(0, 2000),
          componentStack: errorInfo.componentStack?.substring(0, 2000)
        })
      }).catch(() => {});
    } catch {}
    
    if (isChunkLoadError(error)) {
      const reloadCount = getReloadCount();
      
      if (reloadCount < MAX_AUTO_RELOADS) {
        console.log(`[PageErrorBoundary] Detected stale chunk error, auto-reload ${reloadCount + 1}/${MAX_AUTO_RELOADS}...`);
        incrementReloadCount();
        window.location.reload();
        return;
      } else {
        console.log('[PageErrorBoundary] Max auto-reloads reached, showing error UI');
      }
    }

    if (this.state.autoRetryCount < MAX_AUTO_RETRIES && !isChunkLoadError(error)) {
      this.startAutoRetryCountdown();
    }
  }

  componentWillUnmount() {
    this.clearTimers();
  }

  private clearTimers() {
    if (this.retryTimerRef) {
      clearTimeout(this.retryTimerRef);
      this.retryTimerRef = null;
    }
    if (this.countdownTimerRef) {
      clearInterval(this.countdownTimerRef);
      this.countdownTimerRef = null;
    }
  }

  private startAutoRetryCountdown() {
    this.clearTimers();

    const delaySeconds = AUTO_RETRY_DELAYS[this.state.autoRetryCount] ?? 5;
    console.log(`[PageErrorBoundary${this.props.pageName ? ` - ${this.props.pageName}` : ''}] Auto-retry ${this.state.autoRetryCount + 1}/${MAX_AUTO_RETRIES} in ${delaySeconds}s...`);

    this.setState({ countdown: delaySeconds });

    this.countdownTimerRef = setInterval(() => {
      this.setState(prev => {
        const next = (prev.countdown ?? 1) - 1;
        if (next <= 0) {
          return { countdown: null };
        }
        return { countdown: next };
      });
    }, 1000);

    this.retryTimerRef = setTimeout(() => {
      this.clearTimers();
      this.setState(prev => ({
        hasError: false,
        error: null,
        countdown: null,
        autoRetryCount: prev.autoRetryCount + 1,
        retryCount: prev.retryCount + 1
      }));
    }, delaySeconds * 1000);
  }

  handleRetry = () => {
    this.clearTimers();
    this.setState(prev => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1,
      autoRetryCount: 0,
      countdown: null
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
    } catch (err: unknown) {
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
      const reloadCount = getReloadCount();
      const hitReloadLimit = reloadCount >= MAX_AUTO_RELOADS;
      const isAutoRetrying = this.state.countdown !== null && this.state.autoRetryCount < MAX_AUTO_RETRIES;

      if (isAutoRetrying && !isChunkError) {
        return (
          <div className="flex items-center justify-center min-h-[50vh] p-6">
            <div className="text-center max-w-sm">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-amber-400 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold mb-2 text-primary dark:text-white">
                {isNetworkError ? 'Reconnecting...' : 'Retrying...'}
              </h2>
              <p className="text-gray-600 dark:text-white/60 text-sm mb-4">
                Retrying in {this.state.countdown}s... (attempt {this.state.autoRetryCount + 1}/{MAX_AUTO_RETRIES})
              </p>
              <button
                onClick={this.handleRetry}
                className="px-5 py-2.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl font-medium text-sm hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
              >
                Retry Now
              </button>
            </div>
          </div>
        );
      }

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
                  href="sms:9495455855"
                  className="px-5 py-2.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl font-medium text-sm hover:bg-gray-200 dark:hover:bg-white/20 transition-colors text-center"
                >
                  Text Us — (949) 545-5855
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
              <button
                onClick={this.handleRetry}
                className="px-5 py-2.5 bg-accent text-brand-green rounded-xl font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Try Again
              </button>
              <button
                onClick={this.handleHardReload}
                className="px-5 py-2.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl font-medium text-sm hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
              >
                Reload Page
              </button>
              <a
                href="sms:9495455855"
                className="px-5 py-2.5 text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 text-sm transition-colors"
              >
                Text Us — (949) 545-5855
              </a>
            </div>
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryCount}>{this.props.children}</React.Fragment>;
  }
}

export default PageErrorBoundary;

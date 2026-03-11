import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ErrorFallback } from './ui/ErrorFallback';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  reloadAttempts: number;
}

const GLOBAL_RELOAD_KEY = 'global_error_reload_count';
const GLOBAL_RELOAD_TIMESTAMP = 'global_error_reload_timestamp';
const CHUNK_RELOAD_KEY = 'chunk_error_reload';
const MAX_GLOBAL_RELOADS = 3;
const RELOAD_WINDOW_MS = 120000;

function isChunkLoadError(error: Error): boolean {
  const message = error.message || '';
  return (
    message.includes('Importing a module script failed') ||
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Loading chunk') ||
    message.includes('Loading CSS chunk') ||
    (error.name === 'TypeError' && message.includes('Failed to fetch'))
  );
}

function getGlobalReloadCount(): number {
  const timestamp = sessionStorage.getItem(GLOBAL_RELOAD_TIMESTAMP);
  const count = sessionStorage.getItem(GLOBAL_RELOAD_KEY);
  
  if (!timestamp || !count) return 0;
  
  const elapsed = Date.now() - parseInt(timestamp, 10);
  if (elapsed > RELOAD_WINDOW_MS) {
    sessionStorage.removeItem(GLOBAL_RELOAD_KEY);
    sessionStorage.removeItem(GLOBAL_RELOAD_TIMESTAMP);
    return 0;
  }
  
  return parseInt(count, 10) || 0;
}

function incrementGlobalReloadCount(): number {
  const currentCount = getGlobalReloadCount();
  const newCount = currentCount + 1;
  sessionStorage.setItem(GLOBAL_RELOAD_KEY, newCount.toString());
  sessionStorage.setItem(GLOBAL_RELOAD_TIMESTAMP, Date.now().toString());
  return newCount;
}

function clearGlobalReloadCount(): void {
  sessionStorage.removeItem(GLOBAL_RELOAD_KEY);
  sessionStorage.removeItem(GLOBAL_RELOAD_TIMESTAMP);
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, reloadAttempts: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);

    if (isChunkLoadError(error)) {
      console.warn('[ErrorBoundary] Chunk load error detected — showing fallback UI');
    }
  }

  componentDidMount() {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    this.setState({ reloadAttempts: getGlobalReloadCount() });
  }

  private clearCachesAndReload() {
    const doClear = async () => {
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
        console.error('[ErrorBoundary] Failed to clear caches:', err);
      }
      window.location.reload();
    };
    doClear();
  }

  handleReload = () => {
    const newCount = incrementGlobalReloadCount();
    if (newCount <= MAX_GLOBAL_RELOADS) {
      window.location.reload();
    } else {
      this.setState({ reloadAttempts: newCount });
    }
  };

  handleClearCache = async () => {
    clearGlobalReloadCount();
    
    try {
      if (window.clearPWACaches) {
        await window.clearPWACaches();
      } else {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(key => caches.delete(key)));
        }
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map(reg => reg.unregister()));
        }
      }
    } catch (err: unknown) {
      console.error('Failed to clear caches:', err);
    }
    
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const hitReloadLimit = this.state.reloadAttempts >= MAX_GLOBAL_RELOADS;
      const isChunk = this.state.error ? isChunkLoadError(this.state.error) : false;

      return (
        <ErrorFallback
          variant="page"
          title={isChunk ? "Update available" : "Something went wrong"}
          description={
            hitReloadLimit
              ? "We're having trouble loading the app. Try clearing the cache or contact support if this continues."
              : isChunk
                ? 'A new version of the app is available. Please reload to get the latest update.'
                : 'The app encountered an unexpected error. Please try again.'
          }
          onRetry={this.handleReload}
          retryLabel="Reload App"
          extraActions={
            <button
              onClick={this.handleClearCache}
              className="px-6 py-3 bg-black/5 dark:bg-white/10 text-gray-700 dark:text-white font-medium rounded-full hover:bg-black/10 dark:hover:bg-white/20 transition-colors text-sm"
            >
              Clear Cache & Reload
            </button>
          }
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
export { ErrorBoundary };

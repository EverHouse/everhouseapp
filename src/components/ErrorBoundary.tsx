import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  reloadAttempts: number;
}

const GLOBAL_RELOAD_KEY = 'global_error_reload_count';
const GLOBAL_RELOAD_TIMESTAMP = 'global_error_reload_timestamp';
const MAX_GLOBAL_RELOADS = 3;
const RELOAD_WINDOW_MS = 120000;

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
  state: State = { hasError: false, reloadAttempts: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  componentDidMount() {
    this.setState({ reloadAttempts: getGlobalReloadCount() });
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
    } catch (err) {
      console.error('Failed to clear caches:', err);
    }
    
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const hitReloadLimit = this.state.reloadAttempts >= MAX_GLOBAL_RELOADS;

      return (
        <div className="flex items-center justify-center min-h-screen bg-[#0f120a] text-white p-6">
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-400">error</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-white/60 mb-6">
              {hitReloadLimit 
                ? "We're having trouble loading the app. Try clearing the cache or contact support if this continues."
                : "The app encountered an unexpected error."}
            </p>
            <div className="flex flex-col gap-3">
              {!hitReloadLimit ? (
                <button 
                  onClick={this.handleReload}
                  className="px-6 py-3 bg-brand-green text-white font-semibold rounded-full hover:bg-brand-green/90 transition-colors"
                >
                  Reload App
                </button>
              ) : null}
              <button 
                onClick={this.handleClearCache}
                className="px-6 py-3 bg-white/10 text-white font-medium rounded-full hover:bg-white/20 transition-colors text-sm"
              >
                Clear Cache & Reload
              </button>
              <a
                href="mailto:support@everhouse.com?subject=App Error Report"
                className="px-6 py-3 text-white/70 hover:text-white transition-colors text-sm underline"
              >
                Contact Support
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

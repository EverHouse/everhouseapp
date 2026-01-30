import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleClearCache = async () => {
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
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-[#0f120a] text-white p-6">
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-400">error</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Something went wrong.</h1>
            <p className="text-white/60 mb-6">The app encountered an error.</p>
            <div className="flex flex-col gap-3">
              <button 
                onClick={this.handleReload}
                className="px-6 py-3 bg-brand-green text-white font-semibold rounded-full hover:bg-brand-green/90 transition-colors"
              >
                Reload App
              </button>
              <button 
                onClick={this.handleClearCache}
                className="px-6 py-3 bg-white/10 text-white font-medium rounded-full hover:bg-white/20 transition-colors text-sm"
              >
                Clear Cache & Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

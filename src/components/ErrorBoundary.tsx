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

  render() {
    if (this.state.hasError) {
      return (
        <div 
          className="flex items-center justify-center min-h-screen bg-[#0f120a] text-white p-6 cursor-pointer"
          onClick={this.handleReload}
        >
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-400">error</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Something went wrong.</h1>
            <p className="text-white/60">Tap to reload.</p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

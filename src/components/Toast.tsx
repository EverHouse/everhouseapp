import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useTheme } from '../contexts/ThemeContext';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  hideToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

const getIconForType = (type: ToastType): string => {
  switch (type) {
    case 'success': return 'check_circle';
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'info': return 'info';
  }
};

const getColorForType = (type: ToastType, isDark: boolean): string => {
  switch (type) {
    case 'success': return 'text-green-500';
    case 'error': return 'text-red-500';
    case 'warning': return 'text-orange-500';
    case 'info': return isDark ? 'text-accent' : 'text-brand-green';
  }
};

const ToastItem: React.FC<{ toast: ToastMessage; onDismiss: () => void; isDark: boolean }> = ({ toast, onDismiss, isDark }) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.duration || 3000);
    return () => clearTimeout(timer);
  }, [toast.duration, onDismiss]);

  return (
    <div 
      className="glass-card px-5 py-3 text-sm font-bold flex items-center gap-3 animate-pop-in w-max max-w-[90%] pointer-events-auto"
      role="alert"
      aria-live="polite"
    >
      <span className={`material-symbols-outlined text-xl ${getColorForType(toast.type, isDark)}`}>
        {getIconForType(toast.type)}
      </span>
      <span>{toast.message}</span>
      <button 
        onClick={onDismiss}
        className="ml-1 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full glass-button transition-all duration-[400ms] ease-in-out"
        aria-label="Dismiss notification"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
      </button>
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const { effectiveTheme } = useTheme();
  const isDarkTheme = effectiveTheme === 'dark';

  const showToast = useCallback((message: string, type: ToastType = 'success', duration: number = 3000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts(prev => [...prev, { id, message, type, duration }]);
  }, []);

  const hideToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      <div className="fixed top-[max(96px,calc(env(safe-area-inset-top)+80px))] left-0 right-0 flex flex-col items-center gap-2 pointer-events-none" style={{ zIndex: 'var(--z-toast)' }}>
        {toasts.map(toast => (
          <ToastItem 
            key={toast.id} 
            toast={toast} 
            onDismiss={() => hideToast(toast.id)} 
            isDark={isDarkTheme}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export default ToastProvider;

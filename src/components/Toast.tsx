import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useTheme } from '../contexts/ThemeContext';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  key?: string;
  isExiting?: boolean;
  createdAt?: number;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number, key?: string) => void;
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

const getBorderColor = (type: ToastType): string => {
  switch (type) {
    case 'success': return '#22c55e';
    case 'error': return '#ef4444';
    case 'warning': return '#f97316';
    case 'info': return '#8b5cf6';
  }
};

const getIconColor = (type: ToastType): string => {
  switch (type) {
    case 'success': return 'text-green-400';
    case 'error': return 'text-red-400';
    case 'warning': return 'text-orange-400';
    case 'info': return 'text-violet-400';
  }
};

const getTitleForType = (type: ToastType): string => {
  switch (type) {
    case 'success': return 'Success';
    case 'error': return 'Error';
    case 'warning': return 'Warning';
    case 'info': return 'Notice';
  }
};

const ProgressBar: React.FC<{ duration: number; isExiting: boolean; color: string }> = ({ duration, isExiting, color }) => {
  return (
    <div className="absolute bottom-0 left-0 right-0 h-[1px] overflow-hidden rounded-b-xl">
      <div
        className="h-full rounded-b-xl"
        style={{
          backgroundColor: color,
          opacity: 0.6,
          animation: isExiting ? 'none' : `toast-progress ${duration}ms linear forwards`,
        }}
      />
    </div>
  );
};

const ToastItem: React.FC<{ toast: ToastMessage; onDismiss: () => void; isDark: boolean }> = ({ toast, onDismiss, isDark }) => {
  const duration = toast.duration || 3000;
  const borderColor = getBorderColor(toast.type);

  useEffect(() => {
    if (toast.isExiting) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, toast.isExiting, onDismiss]);

  return (
    <div
      className={`relative overflow-hidden rounded-xl pointer-events-auto
        ${toast.isExiting ? 'toast-slide-out' : 'toast-slide-in'}
        ${isDark ? 'bg-white/[0.08] border border-white/[0.12]' : 'bg-white/80 border border-black/[0.06]'}
      `}
      style={{
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderLeft: `3px solid ${borderColor}`,
        boxShadow: isDark
          ? '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)'
          : '0 8px 32px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.8)',
        minWidth: '280px',
        maxWidth: '420px',
      }}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3 pl-4 pr-2 py-3">
        <span className={`material-symbols-outlined text-xl mt-0.5 flex-shrink-0 ${getIconColor(toast.type)}`}>
          {getIconForType(toast.type)}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-bold tracking-wide uppercase ${isDark ? 'text-white/90' : 'text-gray-900'}`}>
            {getTitleForType(toast.type)}
          </p>
          <p className={`text-sm mt-0.5 leading-snug ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
            {toast.message}
          </p>
        </div>
        <button
          onClick={onDismiss}
          className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
            isDark ? 'hover:bg-white/10 text-white/40 hover:text-white/70' : 'hover:bg-black/5 text-gray-400 hover:text-gray-600'
          }`}
          aria-label="Dismiss notification"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
        </button>
      </div>
      <ProgressBar duration={duration} isExiting={toast.isExiting || false} color={borderColor} />
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const { effectiveTheme } = useTheme();
  const isDarkTheme = effectiveTheme === 'dark';
  
  const recentToastsRef = useRef<Array<{ message: string; type: ToastType; timestamp: number }>>([]);

  const showToast = useCallback((message: string, type: ToastType = 'success', duration: number = 3000, key?: string) => {
    if (key) {
      setToasts(prev => {
        const existingIndex = prev.findIndex(t => t.key === key);
        const newToast: ToastMessage = {
          id: existingIndex !== -1 ? prev[existingIndex].id : `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          message,
          type,
          duration,
          key,
          createdAt: Date.now(),
        };
        
        if (existingIndex !== -1) {
          const updated = [...prev];
          updated[existingIndex] = newToast;
          return updated;
        } else {
          return [...prev, newToast];
        }
      });
      return;
    }

    const now = Date.now();
    const isDuplicate = recentToastsRef.current.some(
      t => t.message === message && t.type === type && (now - t.timestamp) < 2000
    );

    if (isDuplicate) return;

    recentToastsRef.current.push({ message, type, timestamp: now });
    recentToastsRef.current = recentToastsRef.current.filter(t => (now - t.timestamp) < 2000);

    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts(prev => [...prev, { id, message, type, duration, createdAt: now }]);
  }, []);

  const hideToast = useCallback((id: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, isExiting: true } : t));
    
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 300);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      <div
        className="fixed top-[env(safe-area-inset-top,0px)] mt-16 right-4 flex flex-col gap-3 pointer-events-none"
        style={{ zIndex: 'var(--z-toast)', maxWidth: '420px' }}
      >
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

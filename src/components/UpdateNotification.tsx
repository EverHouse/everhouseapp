import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate';

const EXIT_DURATION = 250;

export const UpdateNotification: React.FC = () => {
  const { updateAvailable, isUpdating, applyUpdate, dismissUpdate } = useServiceWorkerUpdate();
  const [isExiting, setIsExiting] = useState(false);
  const [rendered, setRendered] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsExiting(false);

    if (updateAvailable && !rendered) {
      setRendered(true);
    } else if (!updateAvailable && rendered) {
      setIsExiting(true);
      exitTimer.current = setTimeout(() => {
        setIsExiting(false);
        setRendered(false);
        exitTimer.current = null;
      }, EXIT_DURATION);
    }

    return () => {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [updateAvailable]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    exitTimer.current = setTimeout(() => {
      dismissUpdate();
      setIsExiting(false);
      setRendered(false);
      exitTimer.current = null;
    }, EXIT_DURATION);
  }, [dismissUpdate]);

  if (!rendered) return null;

  return (
    <div 
      className={`fixed left-4 right-4 md:left-auto md:right-6 md:max-w-sm transition-all duration-normal ease-spring-smooth ${
        isExiting ? 'opacity-0 scale-95 translate-y-[-8px]' : 'animate-pop-in'
      }`}
      style={{ 
        top: 'max(120px, calc(env(safe-area-inset-top) + 100px))',
        zIndex: 'var(--z-toast, 10500)'
      }}
      role="alert"
      aria-live="polite"
    >
      <div className="glass-card p-4 shadow-lg border border-brand-green/20">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-2xl text-brand-green mt-0.5">
            system_update
          </span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm">Update Available</p>
            <p className="text-xs text-muted mt-1">
              A new version is ready. Refresh to get the latest features.
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={applyUpdate}
                disabled={isUpdating}
                className="px-4 py-2 bg-brand-green text-white text-xs font-semibold rounded-full hover:bg-brand-green/90 transition-colors disabled:opacity-50 tactile-btn"
              >
                {isUpdating ? 'Updating...' : 'Refresh Now'}
              </button>
              <button
                onClick={handleDismiss}
                disabled={isUpdating}
                className="px-4 py-2 text-xs font-medium text-muted hover:text-foreground transition-colors tactile-btn"
              >
                Later
              </button>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors tactile-btn"
            aria-label="Dismiss"
          >
            <span className="material-symbols-outlined text-lg text-muted">close</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default UpdateNotification;

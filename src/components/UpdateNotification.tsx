import React from 'react';
import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate';

export const UpdateNotification: React.FC = () => {
  const { updateAvailable, isUpdating, applyUpdate, dismissUpdate } = useServiceWorkerUpdate();

  if (!updateAvailable) return null;

  return (
    <div 
      className="fixed top-20 left-4 right-4 md:left-auto md:right-6 md:max-w-sm z-[100] animate-pop-in"
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
                className="px-4 py-2 bg-brand-green text-white text-xs font-semibold rounded-full hover:bg-brand-green/90 transition-colors disabled:opacity-50"
              >
                {isUpdating ? 'Updating...' : 'Refresh Now'}
              </button>
              <button
                onClick={dismissUpdate}
                disabled={isUpdating}
                className="px-4 py-2 text-xs font-medium text-muted hover:text-foreground transition-colors"
              >
                Later
              </button>
            </div>
          </div>
          <button
            onClick={dismissUpdate}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors"
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

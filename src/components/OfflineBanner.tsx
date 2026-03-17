import { useEffect, useState, useRef } from 'react';

const EXIT_DURATION = 250;

export default function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [isExiting, setIsExiting] = useState(false);
  const [rendered, setRendered] = useState(!navigator.onLine);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }

    if (isOffline && !rendered) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsExiting(false);
      setRendered(true);
    } else if (!isOffline && rendered) {
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
  }, [isOffline, rendered]);

  if (!rendered) return null;

  return (
    <div
      className={`fixed top-0 left-0 right-0 bg-amber-500 text-white text-center py-2 px-4 text-sm font-medium ${
        isExiting ? 'transition-all duration-normal var(--m3-emphasized-decel) opacity-0 -translate-y-full' : 'animate-banner-slide-down'
      }`}
      style={{ zIndex: 'var(--z-nav)' }}
    >
      You're offline. Showing your last available data.
    </div>
  );
}

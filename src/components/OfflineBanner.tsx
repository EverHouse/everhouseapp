import { useEffect, useState, useRef } from 'react';
import { useRealtimeHealth } from '../hooks/useRealtimeHealth';

interface OfflineBannerProps {
  staffWsConnected?: boolean;
}

type BannerType = 'offline' | 'reconnected' | 'degraded';

const EXIT_DURATION = 250;

export default function OfflineBanner({ staffWsConnected }: OfflineBannerProps) {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const { status, justReconnected } = useRealtimeHealth(staffWsConnected);
  const [showReconnected, setShowReconnected] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [rendered, setRendered] = useState<BannerType | null>(null);
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
    if (justReconnected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowReconnected(true);
      const timer = setTimeout(() => setShowReconnected(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [justReconnected]);

  const target: BannerType | null = isOffline
    ? 'offline'
    : showReconnected
      ? 'reconnected'
      : status === 'degraded'
        ? 'degraded'
        : null;

  useEffect(() => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsExiting(false);

    if (target && target !== rendered) {
      if (rendered) {
        setIsExiting(true);
        exitTimer.current = setTimeout(() => {
          setIsExiting(false);
          setRendered(target);
          exitTimer.current = null;
        }, EXIT_DURATION);
      } else {
        setRendered(target);
      }
    } else if (!target && rendered) {
      setIsExiting(true);
      exitTimer.current = setTimeout(() => {
        setIsExiting(false);
        setRendered(null);
        exitTimer.current = null;
      }, EXIT_DURATION);
    }

    return () => {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [target]);

  if (!rendered) return null;

  const content = {
    offline: <span>You're offline. Showing your last available data.</span>,
    reconnected: (
      <span className="inline-flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[16px]">check_circle</span>
        Live updates restored
      </span>
    ),
    degraded: (
      <span className="inline-flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
        Live updates paused. Reconnecting...
      </span>
    ),
  };

  const colors = {
    offline: 'bg-amber-500',
    reconnected: 'bg-emerald-500',
    degraded: 'bg-amber-500/90',
  };

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[100] ${colors[rendered]} text-white text-center py-2 px-4 text-sm font-medium ${
        isExiting ? 'transition-all duration-normal var(--m3-emphasized-decel) opacity-0 -translate-y-full' : 'animate-banner-slide-down'
      }`}
    >
      {content[rendered]}
    </div>
  );
}

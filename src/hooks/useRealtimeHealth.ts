import { useState, useEffect, useRef, useCallback } from 'react';
import { getSupabase } from '../lib/supabase';
import { queryClient } from '../lib/queryClient';

export type RealtimeStatus = 'healthy' | 'degraded' | 'offline';

interface RealtimeHealthState {
  status: RealtimeStatus;
  wsConnected: boolean;
  supabaseConnected: boolean;
  justReconnected: boolean;
}

const REALTIME_QUERY_KEYS = ['bookings', 'command-center', 'trackman', 'simulator', 'announcements'];

const SUPABASE_CHECK_INTERVAL_MS = 30000;

const DEGRADED_GRACE_PERIOD_MS = 5000;

export function useRealtimeHealth(staffWsConnected?: boolean) {
  const [state, setState] = useState<RealtimeHealthState>({
    status: navigator.onLine ? 'healthy' : 'offline',
    wsConnected: staffWsConnected ?? true,
    supabaseConnected: true,
    justReconnected: false,
  });

  const prevWsConnectedRef = useRef(staffWsConnected ?? true);
  const prevSupabaseConnectedRef = useRef(true);
  const prevOnlineRef = useRef(navigator.onLine);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supabaseCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateRealtimeQueries = useCallback(() => {
    for (const key of REALTIME_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, []);

  useEffect(() => {
    const wasConnected = prevWsConnectedRef.current;
    const globalStaffWs = typeof window !== 'undefined' ? window.__staffWsConnected : undefined;
    const isNowConnected = staffWsConnected ?? globalStaffWs ?? true;
    prevWsConnectedRef.current = isNowConnected;

    if (!wasConnected && isNowConnected && navigator.onLine) {
      invalidateRealtimeQueries();

      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(prev => ({ ...prev, wsConnected: true, justReconnected: true }));

      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        setState(prev => ({ ...prev, justReconnected: false }));
      }, 3000);
    } else {
      setState(prev => ({ ...prev, wsConnected: isNowConnected }));
    }
  }, [staffWsConnected, invalidateRealtimeQueries]);

  useEffect(() => {
    const handleStaffWsChange = () => {
      const globalStaffWs = window.__staffWsConnected;
      const isNowConnected = globalStaffWs ?? true;
      const wasConnected = prevWsConnectedRef.current;
      prevWsConnectedRef.current = isNowConnected;

      if (!wasConnected && isNowConnected && navigator.onLine) {
        invalidateRealtimeQueries();
        setState(prev => ({ ...prev, wsConnected: true, justReconnected: true }));
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          setState(prev => ({ ...prev, justReconnected: false }));
        }, 3000);
      } else {
        setState(prev => ({ ...prev, wsConnected: isNowConnected }));
      }
    };

    window.addEventListener('staff-ws-status-change', handleStaffWsChange);
    return () => window.removeEventListener('staff-ws-status-change', handleStaffWsChange);
  }, [invalidateRealtimeQueries]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;

    const checkChannels = () => {
      const channels = supabase.getChannels();

      if (channels.length === 0) {
        const wasDisconnected = !prevSupabaseConnectedRef.current;
        prevSupabaseConnectedRef.current = true;
        if (wasDisconnected && navigator.onLine) {
          invalidateRealtimeQueries();
        }
        setState(prev => ({ ...prev, supabaseConnected: true }));
        return;
      }

      const hasSubscribed = channels.some(
        (ch) => ch.state === 'joined'
      );
      const allUnhealthy = channels.every(
        (ch) => ch.state === 'errored' || ch.state === 'closed'
      );
      const hasTransient = channels.some(
        (ch) => ch.state === 'joining' || ch.state === 'leaving'
      );

      const newConnected = hasSubscribed || hasTransient || !allUnhealthy;
      const wasDisconnected = !prevSupabaseConnectedRef.current;
      prevSupabaseConnectedRef.current = newConnected;

      if (wasDisconnected && newConnected && navigator.onLine) {
        invalidateRealtimeQueries();
      }

      setState(prev => {
        return { ...prev, supabaseConnected: newConnected };
      });
    };

    checkChannels();
    supabaseCheckRef.current = setInterval(checkChannels, SUPABASE_CHECK_INTERVAL_MS);

    return () => {
      if (supabaseCheckRef.current) clearInterval(supabaseCheckRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- invalidateRealtimeQueries is stable (useCallback with [])

  useEffect(() => {
    const handleOnline = () => {
      prevOnlineRef.current = true;
      setState(prev => ({ ...prev }));
    };
    const handleOffline = () => {
      prevOnlineRef.current = false;
      setState(prev => ({ ...prev }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const isOnline = navigator.onLine;

    if (!isOnline) {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(prev => ({ ...prev, status: 'offline' }));
    } else if (!state.wsConnected || !state.supabaseConnected) {
      if (state.status !== 'degraded') {
        if (!graceTimerRef.current) {
          graceTimerRef.current = setTimeout(() => {
            graceTimerRef.current = null;
            setState(prev => {
              if (!prev.wsConnected || !prev.supabaseConnected) {
                return { ...prev, status: 'degraded' };
              }
              return prev;
            });
          }, DEGRADED_GRACE_PERIOD_MS);
        }
      }
    } else {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      setState(prev => ({ ...prev, status: 'healthy' }));
    }
  }, [state.wsConnected, state.supabaseConnected, state.status]);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (supabaseCheckRef.current) clearInterval(supabaseCheckRef.current);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    };
  }, []);

  return state;
}

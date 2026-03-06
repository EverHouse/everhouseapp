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

const REALTIME_QUERY_KEYS = ['notifications', 'booking_sessions', 'announcements'];

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

  const invalidateRealtimeQueries = useCallback(() => {
    for (const key of REALTIME_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, []);

  useEffect(() => {
    const wasConnected = prevWsConnectedRef.current;
    const isNowConnected = staffWsConnected ?? true;
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
  }, [staffWsConnected, invalidateRealtimeQueries]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;

    const checkChannels = () => {
      const channels = supabase.getChannels();
      const hasSubscribed = channels.some(
        (ch) => ch.state === 'joined'
      );
      const hasError = channels.length > 0 && channels.every(
        (ch) => ch.state === 'errored' || ch.state === 'closed'
      );

      const newConnected = channels.length === 0 ? true : hasSubscribed && !hasError;
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
    supabaseCheckRef.current = setInterval(checkChannels, 10000);

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
      setState(prev => ({ ...prev, status: 'offline' }));
    } else if (!state.wsConnected || !state.supabaseConnected) {
      setState(prev => ({ ...prev, status: 'degraded' }));
    } else {
      setState(prev => ({ ...prev, status: 'healthy' }));
    }
  }, [state.wsConnected, state.supabaseConnected]);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (supabaseCheckRef.current) clearInterval(supabaseCheckRef.current);
    };
  }, []);

  return state;
}

import { useState, useEffect, useCallback, useRef } from 'react';

interface UsePendingCountsResult {
  pendingRequestsCount: number;
  decrementPendingCount: () => void;
  refetch: () => void;
}

export function usePendingCounts(): UsePendingCountsResult {
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);
  const fetchPendingCountRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const fetchPendingCount = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/command-center', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const count = (data.counts?.pendingBookings || 0) + (data.pendingRequests?.length || 0);
        setPendingRequestsCount(count);
      }
    } catch (err) {
      console.error('Failed to fetch pending count:', err);
    }
  }, []);

  fetchPendingCountRef.current = fetchPendingCount;

  useEffect(() => {
    fetchPendingCount();
    const interval = setInterval(fetchPendingCount, 30000);
    
    const handleBookingAction = () => {
      setPendingRequestsCount(prev => Math.max(0, prev - 1));
    };
    window.addEventListener('booking-action-completed', handleBookingAction);
    
    const handleBookingUpdate = () => {
      fetchPendingCount();
    };
    window.addEventListener('booking-update', handleBookingUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('booking-action-completed', handleBookingAction);
      window.removeEventListener('booking-update', handleBookingUpdate);
    };
  }, [fetchPendingCount]);

  const decrementPendingCount = useCallback(() => {
    setPendingRequestsCount(prev => Math.max(0, prev - 1));
  }, []);

  const refetch = useCallback(() => {
    fetchPendingCountRef.current?.();
  }, []);

  return { pendingRequestsCount, decrementPendingCount, refetch };
}

import { useState, useEffect, useCallback } from 'react';

interface UsePendingCountsResult {
  pendingRequestsCount: number;
  decrementPendingCount: () => void;
  refetch: () => void;
}

export function usePendingCounts(): UsePendingCountsResult {
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);

  const handleCommandCenterData = useCallback((e: Event) => {
    const data = (e as CustomEvent).detail;
    if (data?.counts) {
      const count = (data.counts.pendingBookings || 0) + (data.pendingRequests?.length || 0);
      setPendingRequestsCount(count);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('command-center-data', handleCommandCenterData);

    const handleBookingAction = () => {
      setPendingRequestsCount(prev => Math.max(0, prev - 1));
    };
    window.addEventListener('booking-action-completed', handleBookingAction);

    window.dispatchEvent(new CustomEvent('request-command-center-refresh'));

    return () => {
      window.removeEventListener('command-center-data', handleCommandCenterData);
      window.removeEventListener('booking-action-completed', handleBookingAction);
    };
  }, [handleCommandCenterData]);

  const decrementPendingCount = useCallback(() => {
    setPendingRequestsCount(prev => Math.max(0, prev - 1));
  }, []);

  const refetch = useCallback(() => {
    window.dispatchEvent(new CustomEvent('request-command-center-refresh'));
  }, []);

  return { pendingRequestsCount, decrementPendingCount, refetch };
}

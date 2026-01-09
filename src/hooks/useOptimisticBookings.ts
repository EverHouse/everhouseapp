import { useState, useCallback, useRef } from 'react';
import { useToast } from '../components/Toast';

export interface BookingRequest {
  id: number;
  user_email: string;
  user_name: string;
  resource_id: number | null;
  bay_name: string | null;
  resource_preference: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  notes: string | null;
  status: 'pending' | 'pending_approval' | 'approved' | 'declined' | 'cancelled' | 'confirmed' | 'attended' | 'no_show';
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string;
  source?: 'booking_request' | 'booking';
  resource_name?: string;
  first_name?: string;
  last_name?: string;
  tier?: string;
}

export type BookingStatus = BookingRequest['status'];

interface UseOptimisticBookingsOptions {
  onStatusUpdateSuccess?: (id: number, newStatus: BookingStatus) => void;
  onStatusUpdateError?: (id: number, error: Error) => void;
}

export function useOptimisticBookings(options: UseOptimisticBookingsOptions = {}) {
  const [bookings, setBookings] = useState<BookingRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showToast } = useToast();
  const snapshotRef = useRef<BookingRequest[]>([]);

  const fetchBookings = useCallback(async () => {
    setIsLoading(true);
    try {
      const results = await Promise.allSettled([
        fetch('/api/booking-requests?include_all=true', { credentials: 'include' }),
        fetch('/api/pending-bookings', { credentials: 'include' })
      ]);
      
      let allRequests: BookingRequest[] = [];
      
      if (results[0].status === 'fulfilled' && results[0].value.ok) {
        const data = await results[0].value.json();
        allRequests = data.map((r: any) => ({ ...r, source: 'booking_request' as const }));
      }
      
      if (results[1].status === 'fulfilled' && results[1].value.ok) {
        const pendingBookings = await results[1].value.json();
        const mappedBookings = pendingBookings.map((b: any) => ({
          id: b.id,
          user_email: b.user_email,
          user_name: b.first_name && b.last_name ? `${b.first_name} ${b.last_name}` : b.user_email,
          resource_id: null,
          bay_name: null,
          resource_preference: b.resource_name || null,
          request_date: b.booking_date,
          start_time: b.start_time,
          end_time: b.end_time,
          duration_minutes: 60,
          notes: b.notes,
          status: b.status,
          staff_notes: null,
          suggested_time: null,
          created_at: b.created_at,
          source: 'booking' as const,
          resource_name: b.resource_name,
          tier: b.tier
        }));
        allRequests = [...allRequests, ...mappedBookings];
      }
      
      setBookings(allRequests);
    } catch (err) {
      console.error('Failed to fetch bookings:', err);
      showToast('Failed to load bookings', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  const fetchApprovedBookings = useCallback(async (startDate: string, endDate: string): Promise<BookingRequest[]> => {
    try {
      const res = await fetch(`/api/approved-bookings?start_date=${startDate}&end_date=${endDate}`, { credentials: 'include' });
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.error('Failed to fetch approved bookings:', err);
    }
    return [];
  }, []);

  const updateBookingStatus = useCallback(async (
    id: number,
    newStatus: BookingStatus,
    source?: 'booking_request' | 'booking'
  ): Promise<boolean> => {
    snapshotRef.current = [...bookings];
    
    setBookings(prev => prev.map(booking => 
      booking.id === id && (!source || booking.source === source)
        ? { ...booking, status: newStatus }
        : booking
    ));
    
    try {
      const res = await fetch(`/api/bookings/${id}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus, source })
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update booking status');
      }
      
      const statusLabel = newStatus === 'attended' ? 'checked in' : 
                          newStatus === 'no_show' ? 'marked as no show' :
                          newStatus === 'cancelled' ? 'cancelled' : 'updated';
      showToast(`Booking ${statusLabel}`, 'success');
      options.onStatusUpdateSuccess?.(id, newStatus);
      return true;
    } catch (err: any) {
      setBookings(snapshotRef.current);
      showToast(err.message || 'Failed to update booking', 'error');
      options.onStatusUpdateError?.(id, err);
      return false;
    }
  }, [bookings, showToast, options]);

  const cancelBooking = useCallback(async (
    id: number,
    source?: 'booking_request' | 'booking',
    cancelledBy?: string
  ): Promise<boolean> => {
    snapshotRef.current = [...bookings];
    
    setBookings(prev => prev.map(booking => 
      booking.id === id && (!source || booking.source === source)
        ? { ...booking, status: 'cancelled' }
        : booking
    ));
    
    try {
      const res = await fetch(`/api/bookings/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          status: 'cancelled', 
          source,
          cancelled_by: cancelledBy
        })
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to cancel booking');
      }
      
      showToast('Booking cancelled', 'success');
      return true;
    } catch (err: any) {
      setBookings(snapshotRef.current);
      showToast(err.message || 'Failed to cancel booking', 'error');
      return false;
    }
  }, [bookings, showToast]);

  const refetch = useCallback(async () => {
    await fetchBookings();
  }, [fetchBookings]);

  const updateBookingInState = useCallback((id: number, updates: Partial<BookingRequest>) => {
    setBookings(prev => prev.map(booking => 
      booking.id === id ? { ...booking, ...updates } : booking
    ));
  }, []);

  const removeBookingFromState = useCallback((id: number) => {
    setBookings(prev => prev.filter(booking => booking.id !== id));
  }, []);

  return {
    bookings,
    isLoading,
    fetchBookings,
    fetchApprovedBookings,
    updateBookingStatus,
    cancelBooking,
    refetch,
    setBookings,
    updateBookingInState,
    removeBookingFromState
  };
}

export default useOptimisticBookings;

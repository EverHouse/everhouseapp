import { useCallback, useState } from 'react';
import { useToast } from '../components/Toast';

interface BookingForCheckIn {
  id: number | string;
  user_name?: string;
  bay_name?: string;
  resource_name?: string;
  source?: string;
  [key: string]: any;
}

interface CheckInResult {
  success: boolean;
  requiresRoster?: boolean;
  requiresBilling?: boolean;
  bookingId?: number;
  error?: string;
}

export function useBookingCheckIn() {
  const { showToast } = useToast();
  const [isCheckingIn, setIsCheckingIn] = useState<number | null>(null);

  const parseBookingId = (id: number | string): number => {
    if (typeof id === 'number') return id;
    return parseInt(String(id).replace('cal_', ''), 10);
  };

  const checkIn = useCallback(async (
    booking: BookingForCheckIn,
    status: 'attended' | 'no_show' = 'attended'
  ): Promise<CheckInResult> => {
    const bookingId = parseBookingId(booking.id);
    
    console.log('[useBookingCheckIn] Starting check-in', { 
      originalId: booking.id, 
      parsedId: bookingId, 
      status 
    });

    if (isNaN(bookingId)) {
      console.error('[useBookingCheckIn] Invalid booking ID:', booking.id);
      showToast('Invalid booking ID', 'error');
      return { success: false, error: 'Invalid booking ID' };
    }

    setIsCheckingIn(bookingId);

    try {
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status, source: booking.source })
      });

      console.log('[useBookingCheckIn] API response status:', res.status);

      if (res.ok) {
        const statusLabel = status === 'attended' ? 'checked in' : 'marked as no show';
        showToast(`Booking ${statusLabel}`, 'success');
        return { success: true, bookingId };
      }

      if (res.status === 402) {
        const errorData = await res.json();
        console.log('[useBookingCheckIn] 402 response - needs action:', errorData);
        
        if (errorData.requiresRoster) {
          return { success: false, requiresRoster: true, bookingId };
        } else {
          return { success: false, requiresBilling: true, bookingId };
        }
      }

      if (res.status === 400) {
        const errorData = await res.json();
        
        if (errorData.requiresSync) {
          console.log('[useBookingCheckIn] Retrying with skipPaymentCheck');
          const retryRes = await fetch(`/api/bookings/${bookingId}/checkin`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ status, skipPaymentCheck: true })
          });
          
          if (retryRes.ok) {
            showToast('Booking checked in (billing session pending)', 'success');
            return { success: true, bookingId };
          }
          
          const retryErr = await retryRes.json();
          throw new Error(retryErr.error || 'Failed to check in');
        }
        
        throw new Error(errorData.error || 'Failed to update status');
      }

      const err = await res.json();
      throw new Error(err.error || 'Failed to update status');

    } catch (err: any) {
      console.error('[useBookingCheckIn] Error:', err);
      showToast(err.message || 'Check-in failed', 'error');
      return { success: false, error: err.message };
    } finally {
      setIsCheckingIn(null);
    }
  }, [showToast]);

  return {
    checkIn,
    isCheckingIn,
    parseBookingId
  };
}

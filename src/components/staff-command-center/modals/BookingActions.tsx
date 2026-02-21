import { useState, useEffect } from 'react';
import { BookingContextType, FetchedContext, ManageModeRosterData } from './bookingSheetTypes';

interface BookingActionsProps {
  bookingId?: number;
  bookingStatus?: string;
  fetchedContext?: FetchedContext | null;
  bookingContext?: BookingContextType;
  rosterData?: ManageModeRosterData | null;
  onCheckIn?: (bookingId: number) => void | Promise<void>;
  onReschedule?: (booking: { id: number; requestDate: string; startTime: string; endTime: string; resourceId: number; resourceName?: string; userName?: string; userEmail?: string }) => void;
  onCancelBooking?: (bookingId: number) => void;
  ownerName?: string;
  ownerEmail?: string;
  bayName?: string;
}

export function BookingActions({
  bookingId,
  bookingStatus,
  fetchedContext,
  bookingContext,
  rosterData,
  onCheckIn,
  onReschedule: _onReschedule,
  onCancelBooking,
  ownerName,
  ownerEmail,
  bayName,
}: BookingActionsProps) {
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  
  const effectiveStatus = bookingStatus || fetchedContext?.bookingStatus;

  // Reset optimistic states when bookingId changes
  useEffect(() => {
    setCheckingIn(false);
    setCheckedIn(false);
  }, [bookingId]);

  const handleCheckIn = async () => {
    if (!bookingId || !onCheckIn) return;
    
    setCheckingIn(true);
    try {
      const result = onCheckIn(bookingId);
      // Handle both async and sync returns
      if (result instanceof Promise) {
        await result;
      }
      setCheckedIn(true);
      setCheckingIn(false);
    } catch (error) {
      // On error, just reset the checking state
      setCheckingIn(false);
      console.error('Check-in failed:', error);
    }
  };

  if (!(onCheckIn || onCancelBooking) || !bookingId) {
    return null;
  }

  const isPaymentPending = !!(rosterData?.financialSummary && rosterData.financialSummary.grandTotal > 0 && !rosterData.financialSummary.allPaid);

  return (
    <>
      <div className="flex gap-2">
        {onCheckIn && effectiveStatus !== 'attended' && effectiveStatus !== 'cancelled' && !checkedIn && (
          <button
            onClick={handleCheckIn}
            disabled={checkingIn || isPaymentPending}
            className={`tactile-btn flex-1 py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
              checkingIn
                ? 'bg-green-600 text-white opacity-75'
                : isPaymentPending
                ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {checkingIn ? (
              <>
                <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                Checking In...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">how_to_reg</span>
                Check In
              </>
            )}
          </button>
        )}
        {checkedIn && (
          <button
            disabled={true}
            className="tactile-btn flex-1 py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 cursor-default"
          >
            <span className="material-symbols-outlined text-sm">check_circle</span>
            Checked In
          </button>
        )}
        {onCancelBooking && effectiveStatus !== 'cancelled' && effectiveStatus !== 'cancellation_pending' && !checkedIn && (
          <button
            onClick={() => onCancelBooking(bookingId)}
            className="tactile-btn flex-1 py-2 px-3 rounded-lg border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">cancel</span>
            Cancel Booking
          </button>
        )}
      </div>
      {onCheckIn && effectiveStatus !== 'attended' && effectiveStatus !== 'cancelled' && !checkedIn &&
        isPaymentPending && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <span className="material-symbols-outlined text-xs">info</span>
          Payment must be collected before check-in
        </p>
      )}
    </>
  );
}

export default BookingActions;

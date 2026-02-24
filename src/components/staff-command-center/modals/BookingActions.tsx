import { useState, useEffect } from 'react';
import { BookingContextType, FetchedContext, ManageModeRosterData } from './bookingSheetTypes';

interface BookingActionsProps {
  bookingId?: number;
  bookingStatus?: string;
  fetchedContext?: FetchedContext | null;
  bookingContext?: BookingContextType;
  rosterData?: ManageModeRosterData | null;
  onCheckIn?: (bookingId: number, targetStatus?: 'attended' | 'no_show') => void | Promise<void>;
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
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  
  const effectiveStatus = bookingStatus || fetchedContext?.bookingStatus;

  useEffect(() => {
    setCheckingIn(false);
    setCheckedIn(false);
    setStatusMenuOpen(false);
  }, [bookingId]);

  const handleCheckIn = async (targetStatus?: 'attended' | 'no_show') => {
    if (!bookingId || !onCheckIn) return;
    
    setCheckingIn(true);
    try {
      const result = onCheckIn(bookingId, targetStatus);
      if (result instanceof Promise) {
        await result;
      }
      setCheckedIn(true);
      setCheckingIn(false);
    } catch (error) {
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
        {onCheckIn && effectiveStatus !== 'attended' && effectiveStatus !== 'no_show' && effectiveStatus !== 'cancelled' && !checkedIn && (
          <div className="relative flex-1">
            <button
              onClick={() => setStatusMenuOpen(!statusMenuOpen)}
              disabled={checkingIn || isPaymentPending}
              className={`tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
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
                  Updating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">how_to_reg</span>
                  Check In
                  <span className="material-symbols-outlined text-sm ml-0.5">expand_more</span>
                </>
              )}
            </button>
            {statusMenuOpen && !isPaymentPending && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setStatusMenuOpen(false)}
                />
                <div className="absolute left-0 bottom-full mb-1 z-50 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-primary/10 dark:border-white/20 py-1 min-w-[160px] animate-pop-in">
                  <button
                    type="button"
                    onClick={() => { setStatusMenuOpen(false); handleCheckIn('attended'); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500/20 text-green-700 dark:text-green-400">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                    </span>
                    Checked In
                  </button>
                  <button
                    type="button"
                    onClick={() => { setStatusMenuOpen(false); handleCheckIn('no_show'); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500/20 text-red-700 dark:text-red-400">
                      <span className="material-symbols-outlined text-sm">person_off</span>
                    </span>
                    No Show
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {(checkedIn || effectiveStatus === 'attended') && (
          <div className="relative flex-1">
            <button
              onClick={() => setStatusMenuOpen(!statusMenuOpen)}
              disabled={checkingIn}
              className="tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 hover:ring-2 hover:ring-green-300 dark:hover:ring-green-600 cursor-pointer"
            >
              {checkingIn ? (
                <>
                  <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                  Updating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">check_circle</span>
                  Checked In
                  <span className="material-symbols-outlined text-sm ml-0.5">expand_more</span>
                </>
              )}
            </button>
            {statusMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setStatusMenuOpen(false)}
                />
                <div className="absolute left-0 bottom-full mb-1 z-50 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-primary/10 dark:border-white/20 py-1 min-w-[160px] animate-pop-in">
                  <button
                    type="button"
                    onClick={() => { setStatusMenuOpen(false); handleCheckIn('attended'); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors font-bold"
                  >
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500/20 text-green-700 dark:text-green-400">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                    </span>
                    Checked In
                    <span className="material-symbols-outlined text-sm ml-auto text-green-600">check</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setStatusMenuOpen(false); handleCheckIn('no_show'); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500/20 text-red-700 dark:text-red-400">
                      <span className="material-symbols-outlined text-sm">person_off</span>
                    </span>
                    No Show
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {effectiveStatus === 'no_show' && !checkedIn && (
          <div className="relative flex-1">
            <button
              onClick={() => setStatusMenuOpen(!statusMenuOpen)}
              disabled={checkingIn}
              className="tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300 hover:ring-2 hover:ring-red-300 dark:hover:ring-red-600 cursor-pointer"
            >
              {checkingIn ? (
                <>
                  <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                  Updating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">person_off</span>
                  No Show
                  <span className="material-symbols-outlined text-sm ml-0.5">expand_more</span>
                </>
              )}
            </button>
            {statusMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setStatusMenuOpen(false)}
                />
                <div className="absolute left-0 bottom-full mb-1 z-50 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-primary/10 dark:border-white/20 py-1 min-w-[160px] animate-pop-in">
                  <button
                    type="button"
                    onClick={() => { setStatusMenuOpen(false); handleCheckIn('attended'); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500/20 text-green-700 dark:text-green-400">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                    </span>
                    Checked In
                  </button>
                  <button
                    type="button"
                    onClick={() => { setStatusMenuOpen(false); handleCheckIn('no_show'); }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors font-bold"
                  >
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500/20 text-red-700 dark:text-red-400">
                      <span className="material-symbols-outlined text-sm">person_off</span>
                    </span>
                    No Show
                    <span className="material-symbols-outlined text-sm ml-auto text-red-600">check</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {onCancelBooking && effectiveStatus !== 'cancelled' && effectiveStatus !== 'cancellation_pending' && effectiveStatus !== 'no_show' && !checkedIn && (
          <button
            onClick={() => onCancelBooking(bookingId)}
            className="tactile-btn flex-1 py-2 px-3 rounded-lg border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">cancel</span>
            Cancel Booking
          </button>
        )}
      </div>
      {onCheckIn && effectiveStatus !== 'attended' && effectiveStatus !== 'no_show' && effectiveStatus !== 'cancelled' && !checkedIn &&
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

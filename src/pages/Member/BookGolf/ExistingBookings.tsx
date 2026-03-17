import React from 'react';
import { haptic } from '../../../utils/haptics';
import { formatDateShort, formatTime12Hour } from '../../../utils/dateUtils';
import type { BookingRequest } from '../bookGolf/bookGolfTypes';

interface ExistingBookingsProps {
  bookings: BookingRequest[];
  isDark: boolean;
  walletPassAvailable: boolean;
  walletPassDownloading: number | null;
  setWalletPassDownloading: (id: number | null) => void;
  setCancelTargetBooking: (b: BookingRequest) => void;
  setShowCancelConfirm: (v: boolean) => void;
  showToast: (msg: string, type: 'success' | 'error' | 'info' | 'warning', duration?: number) => void;
}

const ExistingBookings: React.FC<ExistingBookingsProps> = ({
  bookings, isDark, walletPassAvailable, walletPassDownloading,
  setWalletPassDownloading, setCancelTargetBooking, setShowCancelConfirm, showToast,
}) => {
  if (bookings.length === 0) return null;

  const handleWalletPassDownload = async (booking: BookingRequest) => {
    haptic.light();
    setWalletPassDownloading(booking.id);
    try {
      const response = await fetch(`/api/member/booking-wallet-pass/${booking.id}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to download');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `EverClub-Booking-${booking.id}.pkpass`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Wallet pass downloaded — open it to add to Apple Wallet', 'success', 5000);
    } catch {
      showToast('Failed to download booking wallet pass', 'error');
    } finally {
      setWalletPassDownloading(null);
    }
  };

  return (
    <div className="space-y-3">
      {bookings.map((booking) => (
        <section key={booking.id} className={`rounded-xl p-4 border ${
          booking.status === 'cancellation_pending'
            ? (isDark ? 'bg-orange-500/10 border-orange-500/30' : 'bg-orange-50 border-orange-200')
            : (isDark ? 'bg-accent/10 border-accent/30' : 'bg-accent/5 border-accent/30')
        }`}>
          <div className="flex items-start gap-3">
            <span className={`material-symbols-outlined text-2xl ${
              booking.status === 'cancellation_pending' ? (isDark ? 'text-orange-400' : 'text-orange-600') : (isDark ? 'text-accent' : 'text-accent-dark')
            }`}>
              {booking.status === 'cancellation_pending' ? 'hourglass_top' : booking.status === 'pending' ? 'schedule' : 'event_available'}
            </span>
            <div className="flex-1">
              <h4 className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                {booking.status === 'cancellation_pending'
                  ? 'Cancellation in Progress'
                  : booking.status === 'pending'
                    ? `You have a pending request for ${formatDateShort(booking.request_date)}`
                    : `You already have a booking for ${formatDateShort(booking.request_date)}`
                }
              </h4>
              <p className={`text-sm mt-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                {booking.bay_name} - {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
              </p>
              {booking.status === 'cancellation_pending' && (
                <p className={`text-xs mt-2 ${isDark ? 'text-orange-400' : 'text-orange-600'}`}>
                  Your cancellation is being processed
                </p>
              )}
            </div>
          </div>
          {booking.status !== 'cancellation_pending' && (
            <div className="mt-4 space-y-2">
              {walletPassAvailable && ['approved', 'confirmed', 'checked_in', 'attended'].includes(booking.status) && (
                <button
                  onClick={() => handleWalletPassDownload(booking)}
                  disabled={walletPassDownloading === booking.id}
                  className="tactile-btn w-full py-3 rounded-xl font-bold text-sm border transition-colors flex items-center justify-center gap-2"
                  style={{ backgroundColor: '#000000', color: '#FFFFFF', borderColor: '#000000' }}
                  aria-label="Add to Apple Wallet"
                >
                  {walletPassDownloading === booking.id ? (
                    <span className="animate-spin material-symbols-outlined text-lg">progress_activity</span>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white">
                        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                      </svg>
                      <span>Add to Apple Wallet</span>
                    </>
                  )}
                </button>
              )}
              <button
                onClick={() => { haptic.light(); setCancelTargetBooking(booking); setShowCancelConfirm(true); }}
                className={`tactile-btn w-full py-3 rounded-xl font-bold text-sm border transition-colors flex items-center justify-center gap-2 ${
                  isDark
                    ? 'border-red-500/50 text-red-400 hover:bg-red-500/10'
                    : 'border-red-300 text-red-600 hover:bg-red-50'
                }`}
              >
                <span className="material-symbols-outlined text-lg">event_busy</span>
                {booking.status === 'pending' ? 'Cancel Request' : 'Cancel Booking'}
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
};

export default ExistingBookings;

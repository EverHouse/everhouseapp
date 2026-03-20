import React from 'react';
import { haptic } from '../../../utils/haptics';
import { apiRequestBlob } from '../../../lib/apiRequest';
import { formatDateShort, formatTime12Hour } from '../../../utils/dateUtils';
import type { BookingRequest } from './bookGolfTypes';
import Icon from '../../../components/icons/Icon';

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
      const response = await apiRequestBlob(`/api/member/booking-wallet-pass/${booking.id}`);
      if (!response.ok || !response.blob) throw new Error(response.error || 'Failed to download');
      const url = URL.createObjectURL(response.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `EverClub-Booking-${booking.id}.pkpass`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Wallet pass downloaded — open it to add to your digital wallet', 'success', 5000);
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
            <Icon name={booking.status === 'cancellation_pending' ? 'hourglass_top' : booking.status === 'pending' ? 'schedule' : 'event_available'} className={`text-2xl ${ booking.status === 'cancellation_pending' ? (isDark ? 'text-orange-400' : 'text-orange-600') : (isDark ? 'text-accent' : 'text-accent-dark') }`} />
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
                  aria-label="Add to Digital Wallet"
                >
                  {walletPassDownloading === booking.id ? (
                    <Icon name="progress_activity" className="animate-spin text-lg" />
                  ) : (
                    <>
                      <Icon name="wallet" className="text-[20px] text-white" />
                      <span>Add to Digital Wallet</span>
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
                <Icon name="event_busy" className="text-lg" />
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

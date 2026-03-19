import React from 'react';
import ModalShell from '../../../components/ModalShell';
import { GuardianConsentForm, type GuardianConsentData } from '../../../components/booking';
import { formatDateShort, formatTime12Hour } from '../../../utils/dateUtils';
import type { BookingRequest } from './bookGolfTypes';

interface BookingModalsProps {
  isDark: boolean;
  showCancelConfirm: boolean;
  setShowCancelConfirm: (v: boolean) => void;
  cancelTargetBooking: BookingRequest | null;
  setCancelTargetBooking: (b: BookingRequest | null) => void;
  cancelBookingIsPending: boolean;
  handleCancelRequest: (id: number) => Promise<void>;
  showViewAsConfirm: boolean;
  setShowViewAsConfirm: (v: boolean) => void;
  viewAsUser: { name: string } | null;
  submitBooking: () => Promise<void>;
  showGuardianConsent: boolean;
  setShowGuardianConsent: (v: boolean) => void;
  effectiveUserName: string;
  handleGuardianConsentSubmit: (data: GuardianConsentData) => void;
  showUnfilledSlotsWarning: boolean;
  setShowUnfilledSlotsWarning: (v: boolean) => void;
  playerCount: number;
  playerSlots: Array<{ selectedId?: string; email?: string }>;
}

const BookingModals: React.FC<BookingModalsProps> = ({
  isDark, showCancelConfirm, setShowCancelConfirm, cancelTargetBooking, setCancelTargetBooking,
  cancelBookingIsPending, handleCancelRequest, showViewAsConfirm, setShowViewAsConfirm,
  viewAsUser, submitBooking, showGuardianConsent, setShowGuardianConsent,
  effectiveUserName, handleGuardianConsentSubmit, showUnfilledSlotsWarning,
  setShowUnfilledSlotsWarning, playerCount, playerSlots,
}) => {
  return (
    <>
      <ModalShell isOpen={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} showCloseButton={false}>
        <div className="p-6 text-center">
          {(() => {
            const hasTrackman = cancelTargetBooking && (
              !!(cancelTargetBooking.trackman_booking_id) ||
              (cancelTargetBooking.notes && cancelTargetBooking.notes.includes('[Trackman Import ID:'))
            );
            return (
              <>
                <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${hasTrackman ? (isDark ? 'bg-amber-500/20' : 'bg-amber-100') : (isDark ? 'bg-red-500/20' : 'bg-red-100')}`}>
                  <span className={`material-symbols-outlined text-3xl ${hasTrackman ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-red-400' : 'text-red-600')}`}>
                    {hasTrackman ? 'warning' : 'event_busy'}
                  </span>
                </div>
                <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>{cancelTargetBooking?.status === 'pending' ? 'Cancel Request?' : 'Cancel Booking?'}</h3>
                <p className={`text-sm mb-4 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                  Are you sure you want to cancel your {cancelTargetBooking?.status === 'pending' ? 'request' : 'booking'} for {cancelTargetBooking ? formatDateShort(cancelTargetBooking.request_date) : ''} at {cancelTargetBooking ? `${formatTime12Hour(cancelTargetBooking.start_time)} - ${formatTime12Hour(cancelTargetBooking.end_time)}` : ''}?
                </p>
                {hasTrackman && (
                  <div className={`rounded-lg p-4 mb-4 text-left ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                    <div className="flex gap-3">
                      <span className={`material-symbols-outlined text-xl flex-shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>info</span>
                      <div>
                        <p className={`text-sm font-medium ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>This booking is linked to Trackman</p>
                        <p className={`text-xs mt-1 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>After cancelling, the staff will be notified to also cancel it in Trackman.</p>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowCancelConfirm(false)}
                    disabled={cancelBookingIsPending}
                    className={`flex-1 py-3 rounded-xl font-bold text-sm border transition-colors ${
                      isDark ? 'border-white/20 text-white hover:bg-white/5' : 'border-primary/20 text-primary hover:bg-primary/5'
                    }`}
                  >
                    {cancelTargetBooking?.status === 'pending' ? 'Keep Request' : 'Keep Booking'}
                  </button>
                  <button
                    onClick={async () => {
                      if (!cancelTargetBooking) return;
                      const bookingId = cancelTargetBooking.id;
                      setCancelTargetBooking(null);
                      setShowCancelConfirm(false);
                      await handleCancelRequest(bookingId);
                    }}
                    disabled={cancelBookingIsPending}
                    className={`flex-1 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2 ${
                      cancelBookingIsPending ? 'opacity-50 cursor-not-allowed' : ''
                    } ${isDark ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-red-600 text-white hover:bg-red-700'}`}
                  >
                    {cancelBookingIsPending ? (
                      <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                    ) : (
                      <><span className="material-symbols-outlined text-lg">check</span>Yes, Cancel</>
                    )}
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      </ModalShell>

      <ModalShell
        isOpen={showViewAsConfirm && !!viewAsUser}
        onClose={() => setShowViewAsConfirm(false)}
        title="Booking on Behalf"
        size="sm"
      >
        {viewAsUser && (
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                <span className="material-symbols-outlined text-2xl text-amber-500">warning</span>
              </div>
              <div>
                <p className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>View As Mode Active</p>
              </div>
            </div>
            <p className={`text-sm mb-6 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
              You're about to make a booking on behalf of <span className="font-bold">{viewAsUser.name}</span>.
              This booking will appear in their account.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowViewAsConfirm(false)}
                className={`flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-colors ${isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-black/5 text-primary hover:bg-black/10'}`}
              >Cancel</button>
              <button
                onClick={() => submitBooking()}
                className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-accent text-brand-green hover:bg-accent/90 transition-colors"
              >Confirm Booking</button>
            </div>
          </div>
        )}
      </ModalShell>

      <ModalShell
        isOpen={showGuardianConsent}
        onClose={() => setShowGuardianConsent(false)}
        title="Guardian Consent Required"
      >
        <GuardianConsentForm
          memberName={effectiveUserName.includes('@') ? 'this member' : (effectiveUserName || 'this member')}
          onSubmit={handleGuardianConsentSubmit}
          onCancel={() => setShowGuardianConsent(false)}
        />
      </ModalShell>

      <ModalShell
        isOpen={showUnfilledSlotsWarning}
        onClose={() => setShowUnfilledSlotsWarning(false)}
        showCloseButton={false}
        size="sm"
      >
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
              <span className="material-symbols-outlined text-2xl text-amber-500">warning</span>
            </div>
            <div>
              <p className={`font-bold ${isDark ? 'text-white' : 'text-primary'}`}>Unfilled Player Slots</p>
            </div>
          </div>
          <p className={`text-sm mb-6 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            You selected {playerCount} players but {(() => {
              const filled = playerSlots.filter(s => s.selectedId || (s.email && s.email.includes('@'))).length;
              const unfilled = (playerCount - 1) - filled;
              return `${unfilled} slot${unfilled !== 1 ? 's are' : ' is'} unfilled. Unfilled slots will be charged the guest fee.`;
            })()}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setShowUnfilledSlotsWarning(false)}
              className={`flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-colors ${isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-black/5 text-primary hover:bg-black/10'}`}
            >Go Back</button>
            <button
              onClick={() => { setShowUnfilledSlotsWarning(false); submitBooking(); }}
              className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-accent text-brand-green hover:bg-accent/90 transition-colors"
            >Continue Anyway</button>
          </div>
        </div>
      </ModalShell>
    </>
  );
};

export default BookingModals;

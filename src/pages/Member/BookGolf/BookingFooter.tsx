import React from 'react';
import { haptic } from '../../../utils/haptics';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import FeeBreakdownCard from '../../../components/shared/FeeBreakdownCard';

interface BookingFooterProps {
  canBook: boolean;
  isBooking: boolean;
  isDark: boolean;
  activeTab: 'simulator' | 'conference';
  conferencePaymentRequired: boolean;
  conferenceOverageFee: number;
  handleConfirm: () => void;
  estimatedFees: {
    overageFee: number;
    overageMinutes: number;
    guestFees: number;
    guestsCharged: number;
    guestsUsingPasses: number;
    guestFeePerUnit: number;
    totalFee: number;
    passesRemainingAfter: number;
  };
  guestFeeDollars: number;
  guestPassInfo: { passes_remaining: number; passes_total: number } | undefined;
  effectiveUserTier: string | undefined;
  requestButtonRef: React.RefObject<HTMLDivElement | null>;
  feeRef: (el: HTMLElement | null) => void;
  showConfirmation: boolean;
}

const BookingFooter: React.FC<BookingFooterProps> = ({
  canBook, isBooking, isDark, activeTab, conferencePaymentRequired, conferenceOverageFee,
  handleConfirm, estimatedFees, guestFeeDollars, guestPassInfo, effectiveUserTier,
  requestButtonRef, feeRef, showConfirmation,
}) => {
  return (
    <>
      {canBook && (
        <div ref={requestButtonRef} className="fixed bottom-24 left-0 right-0 z-20 px-4 sm:px-6 flex flex-col items-center w-full max-w-lg sm:max-w-xl lg:max-w-2xl mx-auto animate-in slide-in-from-bottom-4 duration-normal gap-2">
          <div ref={feeRef} className="w-full flex flex-col gap-2">
            {activeTab === 'conference' && conferencePaymentRequired && conferenceOverageFee > 0 && (
              <div className={`w-full px-3 sm:px-4 py-3 rounded-xl backdrop-blur-md border flex items-start gap-3 ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}>
                <span className={`material-symbols-outlined text-lg flex-shrink-0 mt-0.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>payments</span>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-sm font-bold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      Overage Fee: ${(conferenceOverageFee / 100).toFixed(2)}
                    </span>
                  </div>
                  <p className={`text-xs ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                    This booking exceeds your daily allowance. Your account credit will be charged automatically when you book.
                  </p>
                </div>
              </div>
            )}
            {activeTab === 'conference' && (
              <FeeBreakdownCard
                overageFee={estimatedFees.overageFee}
                overageMinutes={estimatedFees.overageMinutes}
                guestFees={estimatedFees.guestFees}
                guestsCharged={estimatedFees.guestsCharged}
                guestsUsingPasses={estimatedFees.guestsUsingPasses}
                guestFeePerUnit={estimatedFees.guestFeePerUnit || guestFeeDollars}
                totalFee={estimatedFees.totalFee}
                passesRemainingAfter={guestPassInfo ? estimatedFees.passesRemainingAfter : undefined}
                passesTotal={guestPassInfo?.passes_total}
                tierLabel={effectiveUserTier}
                resourceType="conference"
                isDark={isDark}
              />
            )}
          </div>
          <button
            onClick={() => { haptic.heavy(); handleConfirm(); }}
            disabled={isBooking}
            className="w-full py-4 rounded-xl font-bold text-lg shadow-glow transition-all duration-fast flex items-center justify-center gap-2 bg-accent text-primary hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 focus:ring-2 focus:ring-white focus:outline-none"
          >
            {isBooking ? (
              <><WalkingGolferSpinner size="sm" /><span>Booking...</span></>
            ) : activeTab === 'conference' && conferencePaymentRequired ? (
              <><span className="material-symbols-outlined text-xl">payments</span><span>Book & Pay ${(conferenceOverageFee / 100).toFixed(2)}</span></>
            ) : activeTab === 'conference' ? (
              <><span>Book Conference Room</span><span className="material-symbols-outlined text-xl">arrow_forward</span></>
            ) : (
              <><span>Request Booking</span><span className="material-symbols-outlined text-xl">arrow_forward</span></>
            )}
          </button>
        </div>
      )}

      {showConfirmation && (
        <div className="fixed bottom-32 left-0 right-0 z-[60] flex justify-center pointer-events-none">
          <div className={`backdrop-blur-md px-6 py-3 rounded-full shadow-2xl text-sm font-bold flex items-center gap-3 animate-pop-in w-max max-w-[90%] border pointer-events-auto ${isDark ? 'bg-black/80 text-white border-white/25' : 'bg-white/95 text-primary border-black/10'}`}>
            <span className="material-symbols-outlined text-xl text-green-500">{activeTab === 'conference' ? 'check_circle' : 'schedule_send'}</span>
            <div>
              <p>{activeTab === 'conference' ? 'Booked!' : 'Request sent!'}</p>
              <p className="text-[10px] font-normal opacity-80 mt-0.5">{activeTab === 'conference' ? 'Conference room confirmed.' : 'Staff will review shortly.'}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default BookingFooter;

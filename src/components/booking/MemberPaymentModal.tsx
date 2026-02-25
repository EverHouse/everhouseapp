import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { StripePaymentWithSecret } from '../stripe/StripePaymentForm';
import { SlideUpDrawer } from '../SlideUpDrawer';
import WalkingGolferSpinner from '../WalkingGolferSpinner';

interface ParticipantFee {
  id: number;
  displayName: string;
  amount: number;
}

export interface MemberPaymentModalProps {
  isOpen: boolean;
  bookingId: number;
  sessionId: number;
  ownerEmail: string;
  ownerName: string;
  onSuccess: () => void;
  onClose: () => void;
}

interface PayFeesResponse {
  paidInFull?: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  invoiceId?: string;
  totalAmount: number;
  balanceApplied?: number;
  remainingAmount?: number;
  participantFees: ParticipantFee[];
  error?: string;
}

export function MemberPaymentModal({
  isOpen,
  bookingId,
  sessionId,
  ownerEmail,
  ownerName,
  onSuccess,
  onClose
}: MemberPaymentModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [paymentData, setPaymentData] = useState<PayFeesResponse | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const paymentSucceededRef = useRef(false);

  const initializePayment = useCallback(async () => {
    try {
      paymentSucceededRef.current = false;
      setLoading(true);
      setError(null);

      const { ok, data, error: apiError } = await apiRequest<PayFeesResponse>(
        `/api/member/bookings/${bookingId}/pay-fees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (ok && data) {
        setPaymentData(data);
        if (data.paymentIntentId) {
          setPaymentIntentId(data.paymentIntentId);
        }
        if (data.paidInFull) {
          setTimeout(() => onSuccess(), 1500);
        }
      } else {
        setError(apiError || "We couldn't set up your payment. Please try again.");
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || "We couldn't set up your payment. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [bookingId, onSuccess]);

  useEffect(() => {
    if (isOpen) {
      initializePayment();
    }
  }, [isOpen, initializePayment]);

  useEffect(() => {
    const currentPiId = paymentIntentId;
    
    const handleBeforeUnload = () => {
      if (currentPiId && !paymentSucceededRef.current) {
        navigator.sendBeacon(
          `/api/member/bookings/${bookingId}/cancel-payment`,
          new Blob([JSON.stringify({ paymentIntentId: currentPiId })], { type: 'application/json' })
        );
      }
    };

    if (currentPiId && isOpen) {
      window.addEventListener('beforeunload', handleBeforeUnload);
    }

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (currentPiId && !paymentSucceededRef.current) {
        fetch(`/api/member/bookings/${bookingId}/cancel-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ paymentIntentId: currentPiId }),
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [paymentIntentId, bookingId, isOpen]);

  const handlePaymentSuccess = async () => {
    paymentSucceededRef.current = true;
    if (!paymentIntentId) {
      onSuccess();
      return;
    }

    setConfirming(true);

    try {
      const { ok, error: confirmError } = await apiRequest(
        `/api/member/bookings/${bookingId}/confirm-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId })
        }
      );

      if (!ok) {
        console.error('[MemberPaymentModal] Failed to confirm payment:', confirmError);
        setError('Your payment was processed, but we had trouble confirming it. Please refresh the page.');
        setConfirming(false);
        return;
      }

      onSuccess();
    } catch (err: unknown) {
      console.error('[MemberPaymentModal] Error confirming payment:', err);
      setError('A network issue occurred during confirmation. Please refresh the page.');
      setConfirming(false);
    }
  };

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Pay Booking Fees"
      maxHeight="large"
    >
      <div className="p-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <WalkingGolferSpinner size="sm" variant="light" />
          </div>
        )}

        {error && (
          <div className="text-center py-8 animate-content-enter">
            <span className={`material-symbols-outlined text-4xl mb-2 ${isDark ? 'text-amber-400' : 'text-amber-500'}`}>info</span>
            <p className={`mb-4 text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>{error}</p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-primary/10 dark:bg-white/10 text-primary dark:text-white rounded-xl tactile-btn"
            >
              Go Back
            </button>
          </div>
        )}

        {confirming && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <WalkingGolferSpinner size="sm" variant="light" />
            <p className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              Confirming payment...
            </p>
          </div>
        )}

        {!loading && !confirming && !error && paymentData && (
          <div className="space-y-4">
            <div className={`rounded-xl p-4 ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
              <h4 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                Fee Summary
              </h4>
              <div className="space-y-2">
                {paymentData.participantFees.map((fee) => (
                  <div key={fee.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                        isDark
                          ? 'bg-amber-500/20 text-amber-400'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        G
                      </span>
                      <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                        {fee.displayName}
                      </span>
                    </div>
                    <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                      ${fee.amount.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
              <div className={`mt-3 pt-3 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>
                  Total
                </span>
                <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                  ${paymentData.totalAmount.toFixed(2)}
                </span>
              </div>

              {paymentData.paidInFull && paymentData.balanceApplied && paymentData.balanceApplied > 0 && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                      Account Credit Applied
                    </span>
                    <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                      -${paymentData.balanceApplied.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}

              {!paymentData.paidInFull && paymentData.balanceApplied && paymentData.balanceApplied > 0 && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                  <div className={`rounded-lg p-3 ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="material-symbols-outlined text-sm text-emerald-500">wallet</span>
                      <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                        Account Credit: ${paymentData.balanceApplied.toFixed(2)}
                      </span>
                    </div>
                    <p className={`text-xs ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                      Credit will be applied as a refund after payment
                    </p>
                  </div>
                </div>
              )}
            </div>

            {paymentData.paidInFull ? (
              <div className={`rounded-xl p-4 text-center ${isDark ? 'bg-emerald-500/20' : 'bg-emerald-100'}`}>
                <span className="material-symbols-outlined text-4xl text-emerald-500 mb-2">check_circle</span>
                <p className={`text-lg font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                  Paid with Account Credit
                </p>
                <p className={`text-sm mt-1 ${isDark ? 'text-emerald-400/80' : 'text-emerald-600'}`}>
                  Your account balance covered the full amount
                </p>
              </div>
            ) : paymentData.clientSecret ? (
              <StripePaymentWithSecret
                clientSecret={paymentData.clientSecret}
                amount={paymentData.remainingAmount || paymentData.totalAmount}
                description={`Booking fees for #${bookingId}`}
                onSuccess={handlePaymentSuccess}
                onCancel={onClose}
              />
            ) : paymentData.error ? (
              <div className={`rounded-xl p-4 text-center animate-content-enter ${isDark ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200/60'}`}>
                <span className={`material-symbols-outlined text-4xl mb-2 ${isDark ? 'text-amber-400' : 'text-amber-500'}`}>info</span>
                <p className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                  {paymentData.error}
                </p>
                <button
                  onClick={() => setPaymentData(null)}
                  className={`mt-3 px-4 py-2 rounded-xl text-sm font-medium tactile-btn ${isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-primary/10 text-primary hover:bg-primary/15'}`}
                >
                  Try Again
                </button>
              </div>
            ) : (
              <div className="text-center py-4">
                <p className={`text-sm ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                  Processing payment...
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </SlideUpDrawer>
  );
}

export default MemberPaymentModal;

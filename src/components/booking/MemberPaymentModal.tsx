import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { StripePaymentForm } from '../stripe/StripePaymentForm';

interface ParticipantFee {
  id: number;
  displayName: string;
  amount: number;
}

export interface MemberPaymentModalProps {
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
}

export function MemberPaymentModal({
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
  const [paymentData, setPaymentData] = useState<PayFeesResponse | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const initializePayment = useCallback(async () => {
    try {
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
        // If fully paid by account balance, trigger success immediately
        if (data.paidInFull) {
          setTimeout(() => onSuccess(), 1500); // Show success message briefly
        }
      } else {
        setError(apiError || 'Failed to initialize payment');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize payment');
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    initializePayment();
  }, [initializePayment]);

  const handlePaymentSuccess = async () => {
    if (!paymentIntentId) {
      onSuccess();
      return;
    }

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
      }
    } catch (err) {
      console.error('[MemberPaymentModal] Error confirming payment:', err);
    }

    onSuccess();
  };

  const modalContent = (
    <div
      className={`fixed inset-0 z-[60] ${isDark ? 'dark' : ''}`}
      style={{ overscrollBehavior: 'contain' }}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-backdrop-fade-in"
        aria-hidden="true"
        onClick={onClose}
      />

      <div
        className="fixed inset-0 overflow-y-auto"
        style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        <div
          className="flex min-h-full items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onClose();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-modal-title"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-md max-h-[90vh] overflow-hidden ${
              isDark ? 'bg-black/80' : 'bg-white/80'
            } backdrop-blur-xl border border-primary/10 dark:border-white/10 rounded-2xl shadow-2xl animate-modal-slide-up`}
          >
            <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'bg-white/5 border-white/10' : 'bg-primary/5 border-primary/10'}`}>
              <h3
                id="payment-modal-title"
                className={`text-xl font-bold font-serif ${isDark ? 'text-white' : 'text-primary'}`}
              >
                Pay Guest Fees
              </h3>
              <button
                onClick={onClose}
                className={`p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-colors ${
                  isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'
                }`}
                aria-label="Close modal"
              >
                <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
              </button>
            </div>

            <div
              className="overflow-y-auto p-4"
              style={{ maxHeight: 'calc(90vh - 80px)', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', overscrollBehavior: 'contain' }}
            >
              {loading && (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#CCB8E4] border-t-transparent" />
                </div>
              )}

              {error && (
                <div className="text-center py-8">
                  <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
                  <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
                  <button
                    onClick={onClose}
                    className="px-4 py-2 bg-primary/10 dark:bg-white/10 text-primary dark:text-white rounded-xl"
                  >
                    Go Back
                  </button>
                </div>
              )}

              {!loading && !error && paymentData && (
                <div className="space-y-4">
                  <div className={`rounded-xl p-4 ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
                    <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                      Guest Fee Summary
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
                      <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                        Total
                      </span>
                      <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                        ${paymentData.totalAmount.toFixed(2)}
                      </span>
                    </div>

                    {/* Show account balance applied if any (only for paidInFull case) */}
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

                    {/* Show balance that will be applied for partial balance case */}
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

                  {/* Show success message if fully paid by balance */}
                  {paymentData.paidInFull ? (
                    <div className={`rounded-xl p-4 text-center ${isDark ? 'bg-emerald-500/20' : 'bg-emerald-100'}`}>
                      <span className="material-symbols-outlined text-4xl text-emerald-500 mb-2">check_circle</span>
                      <p className={`text-lg font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                        Paid with Account Credit
                      </p>
                      <p className={`text-sm mt-1 ${isDark ? 'text-emerald-400/80' : 'text-emerald-600'}`}>
                        Your account balance covered the full amount
                      </p>
                    </div>
                  ) : paymentData.clientSecret ? (
                    <StripePaymentForm
                      amount={paymentData.remainingAmount || paymentData.totalAmount}
                      description={`Guest fees for booking #${bookingId}`}
                      userId={ownerEmail}
                      userEmail={ownerEmail}
                      memberName={ownerName}
                      purpose="guest_fee"
                      bookingId={bookingId}
                      sessionId={sessionId}
                      participantFees={paymentData.participantFees.map(pf => ({ id: pf.id, amount: pf.amount }))}
                      onSuccess={handlePaymentSuccess}
                      onCancel={onClose}
                    />
                  ) : paymentData.error ? (
                    <div className={`rounded-xl p-4 text-center ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}>
                      <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
                      <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-700'}`}>
                        {paymentData.error}
                      </p>
                      <button
                        onClick={() => setPaymentData(null)}
                        className="mt-3 px-4 py-2 rounded-lg text-sm bg-red-500 text-white hover:bg-red-600"
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
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

export default MemberPaymentModal;

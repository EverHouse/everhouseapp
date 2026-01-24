import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { StripePaymentForm } from '../stripe/StripePaymentForm';

interface GuestPaymentChoiceModalProps {
  bookingId: number;
  sessionId: number | null;
  guestName: string;
  guestEmail: string;
  ownerEmail: string;
  ownerName: string;
  guestPassesRemaining: number;
  onSuccess: () => void;
  onClose: () => void;
}

interface GuestAddResponse {
  success: boolean;
  participantId: number;
  guestId: number;
  passesRemaining?: number;
}

interface PaymentInitResponse {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
  participantId: number;
}

export function GuestPaymentChoiceModal({
  bookingId,
  sessionId,
  guestName,
  guestEmail,
  ownerEmail,
  ownerName,
  guestPassesRemaining,
  onSuccess,
  onClose
}: GuestPaymentChoiceModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [step, setStep] = useState<'choice' | 'payment'>('choice');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentData, setPaymentData] = useState<PaymentInitResponse | null>(null);

  const handleClose = async () => {
    if (step === 'payment' && paymentData) {
      try {
        await apiRequest(
          `/api/bookings/${bookingId}/cancel-guest-payment`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              participantId: paymentData.participantId,
              paymentIntentId: paymentData.paymentIntentId
            })
          }
        );
      } catch (err) {
        console.error('[GuestPaymentChoice] Error cancelling payment:', err);
      }
    }
    onClose();
  };
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  const handleUseGuestPass = async () => {
    setLoading(true);
    setError(null);

    try {
      const { ok, data, error: apiError } = await apiRequest<GuestAddResponse>(
        `/api/bookings/${bookingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'guest',
            guest: {
              name: guestName.trim(),
              email: guestEmail.trim()
            },
            useGuestPass: true
          })
        }
      );

      if (ok && data) {
        onSuccess();
      } else {
        setError(apiError || 'Failed to add guest with pass');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to add guest');
    } finally {
      setLoading(false);
    }
  };

  const handlePayFee = async () => {
    setLoading(true);
    setError(null);

    try {
      const { ok, data, error: apiError } = await apiRequest<PaymentInitResponse>(
        `/api/bookings/${bookingId}/guest-fee-checkout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guestName: guestName.trim(),
            guestEmail: guestEmail.trim()
          })
        }
      );

      if (ok && data) {
        setPaymentData(data);
        setPaymentIntentId(data.paymentIntentId);
        setStep('payment');
      } else {
        setError(apiError || 'Failed to initialize payment');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize payment');
    } finally {
      setLoading(false);
    }
  };

  const handlePaymentSuccess = async () => {
    if (!paymentIntentId || !paymentData) {
      onSuccess();
      return;
    }

    try {
      const { ok, error: confirmError } = await apiRequest(
        `/api/bookings/${bookingId}/confirm-guest-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId,
            participantId: paymentData.participantId
          })
        }
      );

      if (!ok) {
        console.error('[GuestPaymentChoice] Failed to confirm payment:', confirmError);
        setError(confirmError || 'Payment succeeded but confirmation failed. Please contact support.');
        return;
      }

      onSuccess();
    } catch (err: any) {
      console.error('[GuestPaymentChoice] Error confirming payment:', err);
      setError(err.message || 'Payment succeeded but confirmation failed. Please contact support.');
    }
  };

  const modalContent = (
    <div
      className={`fixed inset-0 z-[60] ${isDark ? 'dark' : ''}`}
      style={{ overscrollBehavior: 'contain' }}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-backdrop-fade-in"
        aria-hidden="true"
        onClick={handleClose}
      />

      <div
        className="fixed inset-0 overflow-y-auto"
        style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
      >
        <div
          className="flex min-h-full items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="guest-payment-choice-title"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-md max-h-[90vh] overflow-hidden ${
              isDark ? 'bg-black/80' : 'bg-white/80'
            } backdrop-blur-xl border border-primary/10 dark:border-white/10 rounded-2xl shadow-2xl animate-modal-slide-up`}
          >
            <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'bg-white/5 border-white/10' : 'bg-primary/5 border-primary/10'}`}>
              <h3
                id="guest-payment-choice-title"
                className={`text-xl font-bold font-serif ${isDark ? 'text-white' : 'text-primary'}`}
              >
                {step === 'choice' ? 'Add Guest' : 'Pay Guest Fee'}
              </h3>
              <button
                onClick={handleClose}
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
              {error && (
                <div className={`mb-4 p-3 rounded-xl ${isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-50 text-red-600'}`}>
                  {error}
                </div>
              )}

              {step === 'choice' && (
                <div className="space-y-4">
                  <div className={`p-4 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
                    <div className="flex items-center gap-3 mb-1">
                      <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${
                        isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
                      }`}>
                        <span className="material-symbols-outlined">person</span>
                      </span>
                      <div>
                        <p className={`font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>
                          {guestName}
                        </p>
                        <p className={`text-sm ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                          {guestEmail}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className={`p-4 rounded-2xl border-2 ${isDark ? 'bg-white/5 border-white/10' : 'bg-primary/5 border-primary/10'}`}>
                    <p className={`text-center text-sm font-medium mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                      How would you like to cover this guest?
                    </p>

                    <div className="space-y-3">
                      <button
                        onClick={handleUseGuestPass}
                        disabled={loading || guestPassesRemaining <= 0}
                        className={`w-full p-4 rounded-xl border-2 transition-all flex items-start gap-4 ${
                          guestPassesRemaining > 0
                            ? isDark
                              ? 'border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/20'
                              : 'border-emerald-500/50 bg-emerald-50 hover:bg-emerald-100'
                            : isDark
                              ? 'border-white/10 bg-white/5 opacity-50 cursor-not-allowed'
                              : 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                          guestPassesRemaining > 0
                            ? isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-600'
                            : isDark ? 'bg-white/10 text-white/40' : 'bg-gray-100 text-gray-400'
                        }`}>
                          <span className="material-symbols-outlined text-2xl">confirmation_number</span>
                        </div>
                        <div className="flex-1 text-left">
                          <p className={`font-bold ${
                            guestPassesRemaining > 0
                              ? isDark ? 'text-emerald-400' : 'text-emerald-700'
                              : isDark ? 'text-white/40' : 'text-gray-400'
                          }`}>
                            Use Guest Pass
                          </p>
                          <p className={`text-sm ${
                            guestPassesRemaining > 0
                              ? isDark ? 'text-white/60' : 'text-gray-600'
                              : isDark ? 'text-white/30' : 'text-gray-400'
                          }`}>
                            {guestPassesRemaining > 0
                              ? `${guestPassesRemaining} pass${guestPassesRemaining > 1 ? 'es' : ''} remaining`
                              : 'No passes remaining this month'
                            }
                          </p>
                          <p className={`text-lg font-bold mt-1 ${
                            guestPassesRemaining > 0
                              ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                              : isDark ? 'text-white/40' : 'text-gray-400'
                          }`}>
                            FREE
                          </p>
                        </div>
                        {loading && guestPassesRemaining > 0 && (
                          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        )}
                      </button>

                      <button
                        onClick={handlePayFee}
                        disabled={loading}
                        className={`w-full p-4 rounded-xl border-2 transition-all flex items-start gap-4 ${
                          isDark
                            ? 'border-[#CCB8E4]/50 bg-[#CCB8E4]/10 hover:bg-[#CCB8E4]/20'
                            : 'border-[#CCB8E4] bg-[#CCB8E4]/10 hover:bg-[#CCB8E4]/20'
                        }`}
                      >
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                          isDark ? 'bg-[#CCB8E4]/20 text-[#CCB8E4]' : 'bg-[#CCB8E4]/30 text-[#5a4a6d]'
                        }`}>
                          <span className="material-symbols-outlined text-2xl">credit_card</span>
                        </div>
                        <div className="flex-1 text-left">
                          <p className={`font-bold ${isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]'}`}>
                            Pay Guest Fee
                          </p>
                          <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                            One-time charge for this visit
                          </p>
                          <p className={`text-lg font-bold mt-1 ${isDark ? 'text-white' : 'text-primary'}`}>
                            $25.00
                          </p>
                        </div>
                        {loading && guestPassesRemaining <= 0 && (
                          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {step === 'payment' && paymentData && (
                <div className="space-y-4">
                  <div className={`rounded-xl p-4 ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
                    <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                      Guest Fee
                    </h4>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                          isDark
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-amber-100 text-amber-700'
                        }`}>
                          G
                        </span>
                        <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                          {guestName}
                        </span>
                      </div>
                      <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                        ${(paymentData.amount / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <StripePaymentForm
                    amount={paymentData.amount / 100}
                    description={`Guest fee for ${guestName}`}
                    userId={ownerEmail}
                    userEmail={ownerEmail}
                    memberName={ownerName}
                    purpose="guest_fee"
                    bookingId={bookingId}
                    sessionId={sessionId || undefined}
                    participantFees={[{ id: paymentData.participantId, amount: paymentData.amount / 100 }]}
                    onSuccess={handlePaymentSuccess}
                    onCancel={handleClose}
                  />
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

export default GuestPaymentChoiceModal;

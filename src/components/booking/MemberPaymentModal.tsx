import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest, fireAndForgetRequest } from '../../lib/apiRequest';
import { StripePaymentWithSecret } from '../stripe/StripePaymentForm';
import { SlideUpDrawer } from '../SlideUpDrawer';
import WalkingGolferSpinner from '../WalkingGolferSpinner';

interface ParticipantFee {
  id: number;
  displayName: string;
  amount: number;
  feeType?: 'overage' | 'guest' | 'mixed';
  feeDescription?: string;
  participantType?: 'owner' | 'member' | 'guest';
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
  description?: string;
  error?: string;
  customerSessionClientSecret?: string;
}

interface AccountCreditInfo {
  balanceCents: number;
  balanceDollars: number;
  isCredit?: boolean;
}

export function MemberPaymentModal({
  isOpen,
  bookingId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sessionId,
  ownerEmail,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const [accountCredit, setAccountCredit] = useState<AccountCreditInfo | null>(null);
  const paymentSucceededRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [applyingCredit, setApplyingCredit] = useState(false);

  const initializePayment = useCallback(async (opts?: { useAccountBalance?: boolean }) => {
    try {
      paymentSucceededRef.current = false;
      setLoading(true);
      setError(null);

      const body: Record<string, unknown> = {};
      if (opts?.useAccountBalance) body.useAccountBalance = true;

      const payResult = await apiRequest<PayFeesResponse>(
        `/api/member/bookings/${bookingId}/pay-fees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { maxRetries: 1, timeout: 60000 }
      );

      if (payResult.ok && payResult.data) {
        setPaymentData(payResult.data);
        if (payResult.data.paymentIntentId) {
          setPaymentIntentId(payResult.data.paymentIntentId);
        }
        if (payResult.data.paidInFull) {
          paymentSucceededRef.current = true;
          if (successTimerRef.current) clearTimeout(successTimerRef.current);
          successTimerRef.current = setTimeout(() => onSuccess(), 1500);
        }
      } else {
        setError(payResult.error || "We couldn't set up your payment. Please try again.");
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || "We couldn't set up your payment. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [bookingId, onSuccess]);

  useEffect(() => {
    if (!isOpen) {
      return () => {
        if (successTimerRef.current) {
          clearTimeout(successTimerRef.current);
          successTimerRef.current = null;
        }
      };
    }

    setLoading(true);
    setAccountCredit(null);
    setPaymentData(null);
    setApplyingCredit(false);

    const fetchCreditThenFees = async () => {
      if (ownerEmail) {
        try {
          const result = await apiRequest<AccountCreditInfo & { isCredit?: boolean }>(
            `/api/my-billing/account-balance?user_email=${encodeURIComponent(ownerEmail)}`,
            { method: 'GET' },
            { maxRetries: 1, timeout: 10000 }
          );
          if (result.ok && result.data && result.data.balanceCents > 0 && result.data.isCredit === true) {
            setAccountCredit(result.data);
          }
        } catch {
          setAccountCredit(null);
        }
      }
      await initializePayment();
    };

    fetchCreditThenFees();

    return () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleApplyCredit = async () => {
    setApplyingCredit(true);
    setError(null);
    const previousPiId = paymentIntentId;
    try {
      if (previousPiId) {
        fireAndForgetRequest(`/api/member/bookings/${bookingId}/cancel-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId: previousPiId }),
        });
        setPaymentIntentId(null);
      }
      await initializePayment({ useAccountBalance: true });
    } finally {
      setApplyingCredit(false);
    }
  };

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
        fireAndForgetRequest(`/api/member/bookings/${bookingId}/cancel-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId: currentPiId }),
        });
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
                {paymentData.participantFees.map((fee) => {
                  const isGuest = fee.participantType === 'guest';
                  const iconLetter = isGuest ? 'G' : fee.displayName?.charAt(0)?.toUpperCase() || 'M';
                  const iconColors = isGuest
                    ? (isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700')
                    : (isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700');

                  return (
                    <div key={fee.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${iconColors}`}>
                          {iconLetter}
                        </span>
                        <div className="flex flex-col">
                          <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                            {fee.displayName}
                          </span>
                          {fee.feeDescription && (
                            <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                              {fee.feeDescription}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                        ${fee.amount.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className={`mt-3 pt-3 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>
                  Total
                </span>
                <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                  ${paymentData.totalAmount.toFixed(2)}
                </span>
              </div>

              {paymentData.balanceApplied && paymentData.balanceApplied > 0 && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                      <span className="material-symbols-outlined text-sm align-middle mr-1">account_balance_wallet</span>
                      Account Credit Applied
                    </span>
                    <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                      -${paymentData.balanceApplied.toFixed(2)}
                    </span>
                  </div>
                  {!paymentData.paidInFull && paymentData.remainingAmount != null && (
                    <div className="flex items-center justify-between mt-1">
                      <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>
                        Remaining (Card)
                      </span>
                      <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                        ${paymentData.remainingAmount.toFixed(2)}
                      </span>
                    </div>
                  )}
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
            ) : (
              <>
                {accountCredit && accountCredit.balanceCents > 0 && !paymentData.balanceApplied && (
                  <div className={`rounded-xl p-4 ${isDark ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-emerald-50 border border-emerald-200'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="material-symbols-outlined text-emerald-500">account_balance_wallet</span>
                      <span className={`text-sm font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                        Account Credit Available
                      </span>
                    </div>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Your credit balance</span>
                      <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                        ${accountCredit.balanceDollars.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mb-3">
                      <span className={`text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Amount due</span>
                      <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                        ${paymentData.totalAmount.toFixed(2)}
                      </span>
                    </div>
                    {accountCredit.balanceCents >= Math.round(paymentData.totalAmount * 100) ? (
                      <p className={`text-xs mb-3 ${isDark ? 'text-emerald-400/80' : 'text-emerald-600'}`}>
                        Your credit fully covers this payment
                      </p>
                    ) : (
                      <p className={`text-xs mb-3 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                        ${accountCredit.balanceDollars.toFixed(2)} credit will be applied, remaining ${(paymentData.totalAmount - accountCredit.balanceDollars).toFixed(2)} charged to card
                      </p>
                    )}
                    <button
                      onClick={handleApplyCredit}
                      disabled={applyingCredit || confirming}
                      className="w-full py-2.5 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {applyingCredit ? (
                        <><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> Applying Credit...</>
                      ) : accountCredit.balanceCents >= Math.round(paymentData.totalAmount * 100) ? (
                        <><span className="material-symbols-outlined text-sm">account_balance_wallet</span> Pay with Account Credit</>
                      ) : (
                        <><span className="material-symbols-outlined text-sm">account_balance_wallet</span> Apply ${accountCredit.balanceDollars.toFixed(2)} Credit &amp; Pay Rest by Card</>
                      )}
                    </button>
                  </div>
                )}

                {accountCredit && accountCredit.balanceCents > 0 && !paymentData.balanceApplied && paymentData.clientSecret && (
                  <div className={`flex items-center gap-3 my-2 ${isDark ? 'text-white/40' : 'text-primary/30'}`}>
                    <div className="flex-1 border-t border-current" />
                    <span className="text-xs font-medium uppercase">or pay by card</span>
                    <div className="flex-1 border-t border-current" />
                  </div>
                )}

                {paymentData.clientSecret ? (
                  <StripePaymentWithSecret
                    clientSecret={paymentData.clientSecret}
                    amount={paymentData.remainingAmount || paymentData.totalAmount}
                    description={paymentData.description || `Booking fees for #${bookingId}`}
                    onSuccess={handlePaymentSuccess}
                    onCancel={onClose}
                    customerSessionClientSecret={paymentData.customerSessionClientSecret}
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
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </SlideUpDrawer>
  );
}

export default MemberPaymentModal;

import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { StripePaymentWithSecret } from '../stripe/StripePaymentForm';
import { SlideUpDrawer } from '../SlideUpDrawer';

interface ParticipantFee {
  id: number;
  amountCents: number;
}

interface PayBalanceResponse {
  paidInFull?: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  invoiceId?: string;
  totalCents: number;
  balanceApplied?: number;
  remainingCents?: number;
  itemCount: number;
  participantFees: ParticipantFee[];
  error?: string;
}

export interface BalancePaymentModalProps {
  isOpen: boolean;
  memberEmail: string;
  memberName: string;
  onSuccess: () => void;
  onClose: () => void;
}

export function BalancePaymentModal({
  isOpen,
  memberEmail,
  memberName,
  onSuccess,
  onClose
}: BalancePaymentModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paymentData, setPaymentData] = useState<PayBalanceResponse | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  const initializePayment = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const { ok, data, error: apiError } = await apiRequest<PayBalanceResponse>(
        '/api/member/balance/pay',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberEmail })
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
        setError(apiError || 'Failed to initialize payment');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize payment');
    } finally {
      setLoading(false);
    }
  }, [memberEmail, onSuccess]);

  useEffect(() => {
    if (isOpen) {
      initializePayment();
    }
  }, [isOpen, initializePayment]);

  const handlePaymentSuccess = async () => {
    if (!paymentIntentId) {
      onSuccess();
      return;
    }

    try {
      const { ok, error: confirmError } = await apiRequest(
        '/api/member/balance/confirm',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId })
        }
      );

      if (!ok) {
        console.error('[BalancePaymentModal] Failed to confirm payment:', confirmError);
      }
    } catch (err) {
      console.error('[BalancePaymentModal] Error confirming payment:', err);
    }

    onSuccess();
  };

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Pay Outstanding Balance"
      maxHeight="large"
    >
      <div className="p-4">
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
            <div className={`rounded-xl p-4 ${isDark ? 'bg-amber-900/20 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
              <div className="flex items-center gap-3 mb-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                  <span className={`material-symbols-outlined text-lg ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>receipt_long</span>
                </div>
                <h4 className={`text-sm font-bold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                  Outstanding Balance
                </h4>
              </div>
              <div className={`flex items-center justify-between pt-2 border-t ${isDark ? 'border-amber-500/20' : 'border-amber-200'}`}>
                <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                  {paymentData.itemCount} {paymentData.itemCount === 1 ? 'item' : 'items'}
                </span>
                <span className={`text-xl font-bold font-serif ${isDark ? 'text-white' : 'text-primary'}`}>
                  ${((paymentData.remainingCents ?? paymentData.totalCents) / 100).toFixed(2)}
                </span>
              </div>

              {paymentData.balanceApplied && paymentData.balanceApplied > 0 && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-amber-500/20' : 'border-amber-200'}`}>
                  <div className={`rounded-lg p-3 ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm text-emerald-500">wallet</span>
                      <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                        Account Credit: ${(paymentData.balanceApplied / 100).toFixed(2)}
                      </span>
                    </div>
                    <p className={`text-xs mt-1 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                      Credit will be applied as a refund after payment
                    </p>
                  </div>
                </div>
              )}
            </div>

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
              <StripePaymentWithSecret
                clientSecret={paymentData.clientSecret}
                amount={(paymentData.remainingCents || paymentData.totalCents) / 100}
                description={`Outstanding balance - ${paymentData.itemCount} item(s)`}
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
    </SlideUpDrawer>
  );
}

export default BalancePaymentModal;

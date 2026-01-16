import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { StripePaymentForm } from '../stripe/StripePaymentForm';

interface ParticipantFee {
  id: number;
  amountCents: number;
}

interface PayBalanceResponse {
  clientSecret: string;
  paymentIntentId: string;
  totalCents: number;
  itemCount: number;
  participantFees: ParticipantFee[];
}

export interface BalancePaymentModalProps {
  memberEmail: string;
  memberName: string;
  onSuccess: () => void;
  onClose: () => void;
}

export function BalancePaymentModal({
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

      const { ok, data, error: apiError } = await apiRequest<PayBalanceResponse>(
        '/api/member/balance/pay',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (ok && data) {
        setPaymentData(data);
        setPaymentIntentId(data.paymentIntentId);
      } else {
        setError(apiError || 'Failed to initialize payment');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize payment');
    } finally {
      setLoading(false);
    }
  }, []);

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
            aria-labelledby="balance-payment-modal-title"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-md max-h-[85vh] overflow-hidden ${
              isDark ? 'bg-black/80' : 'bg-white/80'
            } backdrop-blur-xl border border-primary/10 dark:border-white/10 rounded-2xl shadow-2xl animate-modal-slide-up`}
          >
            <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'bg-white/5 border-white/10' : 'bg-primary/5 border-primary/10'}`}>
              <h3
                id="balance-payment-modal-title"
                className={`text-xl font-bold font-serif ${isDark ? 'text-white' : 'text-primary'}`}
              >
                Pay Outstanding Balance
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
              style={{ maxHeight: 'calc(85vh - 80px)', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
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
                  <div className={`rounded-xl p-4 ${isDark ? 'bg-amber-900/20 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                        <span className={`material-symbols-outlined text-lg ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>receipt_long</span>
                      </div>
                      <h4 className={`text-sm font-bold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                        Payment Summary
                      </h4>
                    </div>
                    <div className={`flex items-center justify-between pt-2 border-t ${isDark ? 'border-amber-500/20' : 'border-amber-200'}`}>
                      <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                        {paymentData.itemCount} {paymentData.itemCount === 1 ? 'item' : 'items'}
                      </span>
                      <span className={`text-xl font-bold font-serif ${isDark ? 'text-white' : 'text-primary'}`}>
                        ${(paymentData.totalCents / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <StripePaymentForm
                    amount={paymentData.totalCents / 100}
                    description={`Outstanding balance - ${paymentData.itemCount} item(s)`}
                    userId={memberEmail}
                    userEmail={memberEmail}
                    memberName={memberName}
                    purpose="overage_fee"
                    onSuccess={handlePaymentSuccess}
                    onCancel={onClose}
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

export default BalancePaymentModal;

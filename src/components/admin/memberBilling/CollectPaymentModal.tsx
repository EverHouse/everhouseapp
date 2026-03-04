import React from 'react';
import { ModalShell } from '../../ModalShell';
import { TerminalPayment } from '../../staff-command-center/TerminalPayment';
import type { BillingInfo } from './types';

export function CollectPaymentModal({
  isOpen,
  onClose,
  billingInfo,
  memberId,
  memberEmail,
  collectPaymentAmount,
  collectPaymentMode,
  setCollectPaymentMode,
  isChargingCard,
  onChargeCard,
  onTerminalSuccess,
  onError,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  billingInfo: BillingInfo;
  memberId?: string;
  memberEmail: string;
  collectPaymentAmount: number;
  collectPaymentMode: 'terminal' | 'charge_card';
  setCollectPaymentMode: (mode: 'terminal' | 'charge_card') => void;
  isChargingCard: boolean;
  onChargeCard: () => void;
  onTerminalSuccess: (piId: string) => void;
  onError: (msg: string) => void;
  isDark: boolean;
}) {
  if (!billingInfo.activeSubscription) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Collect Subscription Payment"
      size="md"
    >
      <div className="p-4 space-y-4">
        <div className={`p-3 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>info</span>
            <span className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
              Collecting payment of ${(collectPaymentAmount / 100).toFixed(2)} for {billingInfo.activeSubscription.planName || 'membership subscription'}
            </span>
          </div>
        </div>

        <div className={`flex rounded-lg overflow-hidden border ${isDark ? 'border-white/20' : 'border-gray-200'}`}>
          <button
            onClick={() => setCollectPaymentMode('terminal')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              collectPaymentMode === 'terminal'
                ? isDark
                  ? 'bg-accent text-primary'
                  : 'bg-primary text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
          >
            <span className="material-symbols-outlined text-lg">point_of_sale</span>
            Card Reader
          </button>
          <button
            onClick={() => setCollectPaymentMode('charge_card')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              collectPaymentMode === 'charge_card'
                ? isDark
                  ? 'bg-accent text-primary'
                  : 'bg-primary text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
          >
            <span className="material-symbols-outlined text-lg">credit_card</span>
            Charge Saved Card
          </button>
        </div>

        {collectPaymentMode === 'terminal' && (
          <TerminalPayment
            amount={collectPaymentAmount}
            subscriptionId={billingInfo.activeSubscription.id}
            userId={memberId || null}
            email={memberEmail}
            description={`${billingInfo.activeSubscription.planName || 'Membership'} subscription payment`}
            onSuccess={onTerminalSuccess}
            onError={onError}
            onCancel={onClose}
          />
        )}

        {collectPaymentMode === 'charge_card' && (
          <div className="space-y-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              This will charge the member's saved card on file for the outstanding subscription invoice.
            </p>

            {billingInfo.paymentMethods && billingInfo.paymentMethods.length > 0 ? (
              <div className={`p-3 rounded-lg flex items-center gap-3 ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'}`}>
                <span className={`material-symbols-outlined text-xl ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>credit_card</span>
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {(billingInfo.paymentMethods[0].brand || 'Card').charAt(0).toUpperCase() + (billingInfo.paymentMethods[0].brand || 'Card').slice(1)} •••• {billingInfo.paymentMethods[0].last4}
                  </p>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    Expires {billingInfo.paymentMethods[0].expMonth}/{billingInfo.paymentMethods[0].expYear}
                  </p>
                </div>
              </div>
            ) : (
              <div className={`p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>warning</span>
                  <span className={`text-sm ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
                    No saved card on file. Use the card reader or ask the member to update their payment method.
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={onClose}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={onChargeCard}
                disabled={isChargingCard || !billingInfo.paymentMethods || billingInfo.paymentMethods.length === 0}
                className="flex-1 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity tactile-btn"
              >
                {isChargingCard ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                    Charging...
                  </span>
                ) : (
                  `Charge $${(collectPaymentAmount / 100).toFixed(2)}`
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

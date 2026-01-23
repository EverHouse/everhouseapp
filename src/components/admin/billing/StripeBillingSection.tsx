import React from 'react';

interface Subscription {
  id: string;
  status: string;
  planName?: string;
  planAmount?: number;
  currency?: string;
  interval?: string;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  pauseCollection?: { behavior: string } | null;
  discount?: {
    id: string;
    coupon: {
      id: string;
      name?: string;
      percentOff?: number;
      amountOff?: number;
    };
  } | null;
}

interface PaymentMethod {
  id: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

interface Invoice {
  id: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
}

interface StripeBillingSectionProps {
  activeSubscription: Subscription | null;
  paymentMethods?: PaymentMethod[];
  recentInvoices?: Invoice[];
  customerBalance?: number;
  isPausing: boolean;
  isResuming: boolean;
  isGettingPaymentLink: boolean;
  onPause: () => void;
  onResume: () => void;
  onShowCancelModal: () => void;
  onShowCreditModal: () => void;
  onShowDiscountModal: () => void;
  onShowTierChangeModal: () => void;
  onGetPaymentLink: () => void;
  isDark: boolean;
}

function formatCurrency(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatDate(timestamp: number | string | undefined): string {
  if (!timestamp) return 'No date';
  
  // Handle both Unix timestamps (seconds) and ISO strings
  let date: Date;
  if (typeof timestamp === 'string') {
    date = new Date(timestamp);
  } else if (timestamp > 9999999999) {
    // Milliseconds (13+ digits)
    date = new Date(timestamp);
  } else {
    // Seconds (Unix timestamp)
    date = new Date(timestamp * 1000);
  }
  
  if (isNaN(date.getTime())) return 'Invalid Date';
  
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const StripeBillingSection: React.FC<StripeBillingSectionProps> = ({
  activeSubscription,
  paymentMethods,
  recentInvoices,
  customerBalance,
  isPausing,
  isResuming,
  isGettingPaymentLink,
  onPause,
  onResume,
  onShowCancelModal,
  onShowCreditModal,
  onShowDiscountModal,
  onShowTierChangeModal,
  onGetPaymentLink,
  isDark,
}) => {
  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-700',
      paused: isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700',
      canceled: isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-700',
      past_due: isDark ? 'bg-orange-500/20 text-orange-400' : 'bg-orange-100 text-orange-700',
      trialing: isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700',
      paid: isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-700',
      open: isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700',
      draft: isDark ? 'bg-gray-500/20 text-gray-400' : 'bg-gray-100 text-gray-600',
      uncollectible: isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-700',
    };
    return styles[status] || (isDark ? 'bg-gray-500/20 text-gray-400' : 'bg-gray-100 text-gray-600');
  };

  const isPaused = activeSubscription?.pauseCollection !== null && activeSubscription?.pauseCollection !== undefined;

  return (
    <>
      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 mb-4">
          <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>subscriptions</span>
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Subscription</h3>
        </div>

        {activeSubscription ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusBadge(isPaused ? 'paused' : activeSubscription.status)}`}>
                {isPaused ? 'Paused' : activeSubscription.status.replace('_', ' ')}
              </span>
              {activeSubscription.cancelAtPeriodEnd && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${isDark ? 'bg-orange-500/20 text-orange-400' : 'bg-orange-100 text-orange-700'}`}>
                  Cancels at period end
                </span>
              )}
            </div>

            <div className={`grid grid-cols-2 gap-3 text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              {activeSubscription.planName && (
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Plan</p>
                  <p className={isDark ? 'text-white' : 'text-primary'}>{activeSubscription.planName}</p>
                </div>
              )}
              {activeSubscription.planAmount && (
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Price</p>
                  <p className={isDark ? 'text-white' : 'text-primary'}>
                    {formatCurrency(activeSubscription.planAmount)}/{activeSubscription.interval || 'month'}
                  </p>
                </div>
              )}
              {activeSubscription.currentPeriodStart && (
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Current Period</p>
                  <p className={isDark ? 'text-white' : 'text-primary'}>
                    {formatDate(activeSubscription.currentPeriodStart)} - {formatDate(activeSubscription.currentPeriodEnd || 0)}
                  </p>
                </div>
              )}
              {activeSubscription.currentPeriodEnd && !activeSubscription.cancelAtPeriodEnd && (
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Next Payment</p>
                  <p className={isDark ? 'text-white' : 'text-primary'}>
                    {formatDate(activeSubscription.currentPeriodEnd)}
                  </p>
                </div>
              )}
            </div>

            {activeSubscription.discount && (
              <div className={`p-2 rounded-lg ${isDark ? 'bg-purple-500/10' : 'bg-purple-50'}`}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-purple-500 text-base">sell</span>
                  <span className={`text-sm ${isDark ? 'text-purple-400' : 'text-purple-700'}`}>
                    {activeSubscription.discount.coupon.name || activeSubscription.discount.coupon.id}
                    {activeSubscription.discount.coupon.percentOff && ` (${activeSubscription.discount.coupon.percentOff}% off)`}
                  </span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              <button
                onClick={onShowTierChangeModal}
                disabled={activeSubscription.status !== 'active'}
                className="flex items-center gap-1.5 px-3 py-2 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <span className="material-symbols-outlined text-base">swap_vert</span>
                Change Tier
              </button>
              {isPaused ? (
                <button
                  onClick={onResume}
                  disabled={isResuming}
                  className="flex items-center gap-1.5 px-3 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
                >
                  {isResuming ? (
                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined text-base">play_arrow</span>
                  )}
                  Resume
                </button>
              ) : (
                <button
                  onClick={onPause}
                  disabled={isPausing || activeSubscription.status !== 'active'}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                    isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {isPausing ? (
                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined text-base">pause</span>
                  )}
                  Pause
                </button>
              )}
              {!activeSubscription.cancelAtPeriodEnd && (
                <button
                  onClick={onShowCancelModal}
                  className="flex items-center gap-1.5 px-3 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">cancel</span>
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={`p-4 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <span className={`material-symbols-outlined ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>block</span>
              </div>
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No Active Subscription</p>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>This member doesn't have an active Stripe subscription</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 mb-4">
          <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>credit_card</span>
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Payment Method</h3>
        </div>

        {paymentMethods && paymentMethods.length > 0 ? (
          <div className="space-y-3">
            {paymentMethods.map((pm) => (
              <div key={pm.id} className={`p-3 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`material-symbols-outlined ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>credit_card</span>
                    <div>
                      <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                        {pm.brand?.toUpperCase()} •••• {pm.last4}
                      </p>
                      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        Expires {pm.expMonth}/{pm.expYear}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={onGetPaymentLink}
              disabled={isGettingPaymentLink}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              } disabled:opacity-50`}
            >
              {isGettingPaymentLink ? (
                <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-base">open_in_new</span>
              )}
              Update Payment Method
            </button>
          </div>
        ) : (
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>No payment methods on file</p>
        )}
      </div>

      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>account_balance_wallet</span>
            <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Account Balance</h3>
          </div>
          <button
            onClick={onShowCreditModal}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
          >
            <span className="material-symbols-outlined text-base">add</span>
            Apply Credit
          </button>
        </div>
        <div className={`p-3 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
          <div className="flex items-center justify-between">
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Current Balance</span>
            <span className={`text-lg font-semibold ${
              (customerBalance || 0) < 0
                ? isDark ? 'text-green-400' : 'text-green-600'
                : isDark ? 'text-white' : 'text-primary'
            }`}>
              {(customerBalance || 0) < 0 && '+'}
              {formatCurrency(customerBalance || 0)}
              {(customerBalance || 0) < 0 && ' credit'}
            </span>
          </div>
        </div>
      </div>

      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>sell</span>
            <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Discounts</h3>
          </div>
          <button
            onClick={onShowDiscountModal}
            disabled={!activeSubscription}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-base">add</span>
            Apply Discount
          </button>
        </div>
        {activeSubscription?.discount ? (
          <div className={`p-3 rounded-lg ${isDark ? 'bg-purple-500/10' : 'bg-purple-50'}`}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-purple-500 text-base">check_circle</span>
              <span className={`text-sm ${isDark ? 'text-purple-400' : 'text-purple-700'}`}>
                Active: {activeSubscription.discount.coupon.name || activeSubscription.discount.coupon.id}
                {activeSubscription.discount.coupon.percentOff && ` (${activeSubscription.discount.coupon.percentOff}% off)`}
              </span>
            </div>
          </div>
        ) : (
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>No active discounts</p>
        )}
      </div>

      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 mb-4">
          <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>receipt_long</span>
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Invoice History</h3>
        </div>
        {recentInvoices && recentInvoices.length > 0 ? (
          <div className="space-y-2">
            {recentInvoices.map((inv) => (
              <div
                key={inv.id}
                className={`p-3 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-100'}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusBadge(inv.status)}`}>
                      {inv.status}
                    </span>
                    <span className={`text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
                      {formatCurrency(inv.amountDue)}
                    </span>
                    <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {formatDate(inv.created)}
                    </span>
                  </div>
                  {inv.hostedInvoiceUrl && (
                    <a
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center gap-1 text-xs font-medium ${isDark ? 'text-accent hover:text-accent/80' : 'text-primary hover:text-primary/80'}`}
                    >
                      View
                      <span className="material-symbols-outlined text-base">open_in_new</span>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>No invoices found</p>
        )}
      </div>
    </>
  );
};

export default StripeBillingSection;

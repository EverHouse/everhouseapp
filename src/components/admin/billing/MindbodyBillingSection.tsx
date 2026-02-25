import React from 'react';

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

interface MindbodyBillingSectionProps {
  mindbodyClientId?: string;
  stripeCustomerId?: string;
  paymentMethods?: PaymentMethod[];
  recentInvoices?: Invoice[];
  customerBalance?: number;
  isDark: boolean;
  hasStripeCustomer?: boolean;
  migrationStatus?: string | null;
  migrationBillingStartDate?: string | null;
  migrationRequestedBy?: string | null;
  hasCardOnFile?: boolean;
  tierHasStripePrice?: boolean;
  onInitiateMigration?: () => void;
  onCancelMigration?: () => void;
  isMigrationLoading?: boolean;
}

export const MindbodyBillingSection: React.FC<MindbodyBillingSectionProps> = ({
  mindbodyClientId,
  stripeCustomerId,
  paymentMethods,
  recentInvoices,
  customerBalance,
  isDark,
  hasStripeCustomer = false,
  migrationStatus,
  migrationBillingStartDate,
  migrationRequestedBy,
  hasCardOnFile = false,
  tierHasStripePrice = true,
  onInitiateMigration,
  onCancelMigration,
  isMigrationLoading = false,
}) => {
  const formatCurrency = (amount: number, currency: string = 'usd') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Los_Angeles',
    });
  };

  const formatDateStr = (dateStr: string) => {
    try {
      const normalized = dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`;
      return new Date(normalized).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Los_Angeles',
      });
    } catch {
      return dateStr;
    }
  };

  const hasStripeData = stripeCustomerId && (
    (recentInvoices && recentInvoices.length > 0) ||
    (paymentMethods && paymentMethods.length > 0) ||
    (customerBalance && customerBalance !== 0)
  );

  const effectiveStatus = migrationStatus === 'cancelled' ? null : migrationStatus;

  const renderMigrationSection = () => {
    if (effectiveStatus === 'pending') {
      return (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isDark ? 'bg-blue-500/20' : 'bg-blue-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>schedule</span>
            </div>
            <div className="flex-1">
              <p className={`text-sm font-medium ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                Migration Pending
              </p>
              {migrationBillingStartDate && (
                <p className={`text-xs mt-1 ${isDark ? 'text-blue-400/80' : 'text-blue-600'}`}>
                  Stripe billing starts {formatDateStr(migrationBillingStartDate)}
                </p>
              )}
              {migrationRequestedBy && (
                <p className={`text-xs mt-1 ${isDark ? 'text-blue-400/80' : 'text-blue-600'}`}>
                  Requested by {migrationRequestedBy}
                </p>
              )}
              {onCancelMigration && (
                <button
                  onClick={onCancelMigration}
                  disabled={isMigrationLoading}
                  className={`tactile-btn inline-flex items-center gap-1.5 mt-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isDark ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-red-100 text-red-700 hover:bg-red-200'
                  } disabled:opacity-50`}
                >
                  {isMigrationLoading ? (
                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined text-base">cancel</span>
                  )}
                  Cancel Migration
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (effectiveStatus === 'completed') {
      return (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-green-400' : 'text-green-600'}`}>check_circle</span>
            </div>
            <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
              Migration completed
            </p>
          </div>
        </div>
      );
    }

    if (effectiveStatus === 'failed') {
      return (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-red-400' : 'text-red-600'}`}>error</span>
            </div>
            <div className="flex-1">
              <p className={`text-sm font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                Migration Failed
              </p>
              {onInitiateMigration && (
                <button
                  onClick={onInitiateMigration}
                  disabled={isMigrationLoading}
                  className={`tactile-btn inline-flex items-center gap-1.5 mt-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isDark ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-red-100 text-red-700 hover:bg-red-200'
                  } disabled:opacity-50`}
                >
                  {isMigrationLoading ? (
                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined text-base">refresh</span>
                  )}
                  Retry Migration
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (!hasCardOnFile) {
      return (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'}`}>
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isDark ? 'bg-gray-500/20' : 'bg-gray-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>swap_horiz</span>
            </div>
            <div className="flex-1">
              <p className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Migrate to Stripe Billing
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Member needs a card on file first
              </p>
              <button
                disabled
                title="Member needs a card on file first"
                className={`tactile-btn inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg text-sm font-medium opacity-50 cursor-not-allowed ${
                  isDark ? 'bg-green-500/20 text-green-300' : 'bg-green-100 text-green-700'
                }`}
              >
                <span className="material-symbols-outlined text-base">swap_horiz</span>
                Migrate to Stripe
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (!tierHasStripePrice) {
      return (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'}`}>
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isDark ? 'bg-gray-500/20' : 'bg-gray-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>swap_horiz</span>
            </div>
            <div className="flex-1">
              <p className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Migrate to Stripe Billing
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                This tier doesn't have Stripe pricing configured
              </p>
              <button
                disabled
                title="This tier doesn't have Stripe pricing configured"
                className={`tactile-btn inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg text-sm font-medium opacity-50 cursor-not-allowed ${
                  isDark ? 'bg-green-500/20 text-green-300' : 'bg-green-100 text-green-700'
                }`}
              >
                <span className="material-symbols-outlined text-base">swap_horiz</span>
                Migrate to Stripe
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={`p-4 rounded-xl ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}>
            <span className={`material-symbols-outlined ${isDark ? 'text-green-400' : 'text-green-600'}`}>swap_horiz</span>
          </div>
          <div className="flex-1">
            <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
              Migrate to Stripe Billing
            </p>
            <p className={`text-xs mt-1 ${isDark ? 'text-green-400/80' : 'text-green-600'}`}>
              {hasStripeCustomer
                ? 'This member already has a Stripe account with their credits intact. Start the migration to move their billing from Mindbody to Stripe.'
                : 'Start the migration process to move this member\'s billing from Mindbody to Stripe.'}
            </p>
            {onInitiateMigration && (
              <button
                onClick={onInitiateMigration}
                disabled={isMigrationLoading}
                className={`tactile-btn inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isDark ? 'bg-green-500/20 text-green-300 hover:bg-green-500/30' : 'bg-green-100 text-green-700 hover:bg-green-200'
                } disabled:opacity-50`}
              >
                {isMigrationLoading ? (
                  <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                ) : (
                  <span className="material-symbols-outlined text-base">swap_horiz</span>
                )}
                Migrate to Stripe
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className={`p-4 rounded-xl ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
        <div className="flex items-start gap-3">
          <span className={`material-symbols-outlined ${isDark ? 'text-blue-400' : 'text-blue-600'} text-xl`}>info</span>
          <div className="flex-1">
            <p className={`text-sm font-medium ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
              This member is billed through Mindbody
            </p>
            {mindbodyClientId && (
              <p className={`text-xs mt-1 ${isDark ? 'text-blue-400/80' : 'text-blue-600'}`}>
                Mindbody Client ID: {mindbodyClientId}
              </p>
            )}
            <p className={`text-xs mt-2 ${isDark ? 'text-blue-400/80' : 'text-blue-600'}`}>
              Subscription billing is managed through Mindbody. One-off charges (overage fees, guest passes) can be processed through Stripe.
            </p>
            <a
              href="https://clients.mindbodyonline.com"
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 mt-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isDark ? 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
              }`}
            >
              <span className="material-symbols-outlined text-base">open_in_new</span>
              Open Mindbody
            </a>
          </div>
        </div>
      </div>

      {renderMigrationSection()}

      {stripeCustomerId && (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className={`material-symbols-outlined ${isDark ? 'text-purple-400' : 'text-purple-600'} text-xl`}>credit_card</span>
            <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>
              Stripe One-Off Purchases
            </h3>
          </div>
          
          {paymentMethods && paymentMethods.length > 0 && (
            <div className="mb-3">
              <p className={`text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Payment Method on File
              </p>
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined text-base ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  credit_card
                </span>
                <span className={`text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
                  {paymentMethods[0].brand?.toUpperCase()} •••• {paymentMethods[0].last4}
                </span>
                <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  Exp {paymentMethods[0].expMonth}/{paymentMethods[0].expYear}
                </span>
              </div>
            </div>
          )}
          
          {customerBalance !== undefined && customerBalance !== 0 && (
            <div className="mb-3">
              <p className={`text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Account Balance
              </p>
              <span className={`text-sm font-medium ${customerBalance < 0 ? (isDark ? 'text-green-400' : 'text-green-600') : (isDark ? 'text-red-400' : 'text-red-600')}`}>
                {customerBalance < 0 ? `${formatCurrency(Math.abs(customerBalance))} credit` : `${formatCurrency(customerBalance)} due`}
              </span>
            </div>
          )}
          
          {recentInvoices && recentInvoices.length > 0 && (
            <div>
              <p className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Recent Stripe Payments
              </p>
              <div className="space-y-2">
                {recentInvoices.slice(0, 5).map((inv) => (
                  <div
                    key={inv.id}
                    className={`flex items-center justify-between p-2 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                          inv.status === 'paid'
                            ? isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-700'
                            : inv.status === 'open'
                            ? isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
                            : isDark ? 'bg-gray-500/20 text-gray-400' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {inv.status}
                      </span>
                      <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {formatDate(inv.created)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                        {formatCurrency(inv.amountPaid || inv.amountDue, inv.currency)}
                      </span>
                      {inv.hostedInvoiceUrl && (
                        <a
                          href={inv.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`p-1 rounded hover:bg-white/10 ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-400 hover:text-gray-600'}`}
                        >
                          <span className="material-symbols-outlined text-sm">open_in_new</span>
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {!hasStripeData && (
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              No Stripe payments yet. One-off charges will appear here once processed.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default MindbodyBillingSection;

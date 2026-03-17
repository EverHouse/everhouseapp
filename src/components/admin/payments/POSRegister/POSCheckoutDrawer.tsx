import React from 'react';
import type { Stripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { SimpleCheckoutForm } from '../../../stripe/StripePaymentForm';
import { getStripeAppearance } from '../../../stripe/stripeAppearance';
import { TerminalPayment } from '../../../staff-command-center/TerminalPayment';
import AnimatedCheckmark from '../../../AnimatedCheckmark';
import WalkingGolferSpinner from '../../../WalkingGolferSpinner';
import type { CartItem, PaymentMethodType, SavedCardInfo } from './posTypes';

interface POSCheckoutDrawerProps {
  isDark: boolean;
  success: boolean;
  useGuestCheckout: boolean;
  useNewCustomer: boolean;
  cartItems: CartItem[];
  totalFormatted: string;
  totalCents: number;
  error: string | null;
  setError: (v: string | null) => void;
  receiptSent: boolean;
  receiptSending: boolean;
  guestReceiptEmail: string;
  setGuestReceiptEmail: (v: string) => void;
  attachingEmail: boolean;
  selectedPaymentMethod: PaymentMethodType | null;
  handleSelectPaymentMethod: (method: PaymentMethodType) => void;
  savedCard: SavedCardInfo | null;
  checkingSavedCard: boolean;
  clientSecret: string | null;
  stripePromise: Promise<Stripe | null>;
  isCreatingIntent: boolean;
  isProcessing: boolean;
  handleCardPaymentSuccess: (piId?: string) => void;
  handleTerminalSuccess: (piId: string) => void;
  handleSavedCardCharge: () => void;
  handleSendReceipt: (overrideEmail?: string) => void;
  handleGuestReceiptSubmit: () => void;
  resetForm: () => void;
  getCustomerInfo: () => { email: string; name: string; id: string | null } | null;
  buildDescription: () => string;
}

const POSCheckoutDrawer: React.FC<POSCheckoutDrawerProps> = ({
  isDark,
  success,
  useGuestCheckout,
  useNewCustomer,
  cartItems,
  totalFormatted,
  totalCents,
  error,
  setError,
  receiptSent,
  receiptSending,
  guestReceiptEmail,
  setGuestReceiptEmail,
  attachingEmail,
  selectedPaymentMethod,
  handleSelectPaymentMethod,
  savedCard,
  checkingSavedCard,
  clientSecret,
  stripePromise,
  isCreatingIntent,
  isProcessing,
  handleCardPaymentSuccess,
  handleTerminalSuccess,
  handleSavedCardCharge,
  handleSendReceipt,
  handleGuestReceiptSubmit,
  resetForm,
  getCustomerInfo,
  buildDescription,
}) => {
  if (success) {
    if (useGuestCheckout) {
      return (
        <div className="flex flex-col items-center justify-center py-8 gap-4 px-5">
          <AnimatedCheckmark size={64} color={isDark ? '#4ade80' : '#16a34a'} />
          <p className="text-xl font-bold text-primary dark:text-white">
            Payment of {totalFormatted} successful!
          </p>
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl text-red-700 dark:text-red-300 text-sm w-full max-w-xs">
              {error}
            </div>
          )}
          {!receiptSent ? (
            <div className="w-full max-w-xs mt-4 space-y-3">
              <div className={`p-4 rounded-xl border ${isDark ? 'border-white/10 bg-white/5' : 'border-primary/10 bg-primary/5'}`}>
                <p className="text-sm font-semibold text-primary dark:text-white mb-1">Email receipt?</p>
                <p className="text-xs text-primary/60 dark:text-white/60 mb-3">Enter customer's email to send receipt</p>
                <input
                  type="email"
                  value={guestReceiptEmail}
                  onChange={(e) => setGuestReceiptEmail(e.target.value)}
                  placeholder="customer@example.com"
                  className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm mb-3"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && guestReceiptEmail.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestReceiptEmail.trim())) {
                      handleGuestReceiptSubmit();
                    }
                  }}
                />
                <button
                  onClick={handleGuestReceiptSubmit}
                  disabled={!guestReceiptEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestReceiptEmail.trim()) || attachingEmail || receiptSending}
                  className="w-full py-3 px-6 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-colors hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-lg">email</span>
                  {attachingEmail || receiptSending ? 'Sending...' : 'Send Receipt'}
                </button>
              </div>
              <button
                onClick={resetForm}
                className="w-full py-3 px-6 rounded-xl font-semibold bg-white/60 dark:bg-white/5 border border-primary/20 dark:border-white/20 text-primary dark:text-white transition-colors hover:bg-white/80 dark:hover:bg-white/10 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg">close</span>
                No Thanks
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 w-full max-w-xs mt-4">
              <div className="flex items-center justify-center gap-2 py-3 text-emerald-600 dark:text-emerald-400">
                <span className="material-symbols-outlined">check_circle</span>
                <span className="font-semibold text-sm">Receipt sent to {guestReceiptEmail}</span>
              </div>
              <button
                onClick={resetForm}
                className="w-full py-3 px-6 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-colors hover:opacity-90"
              >
                New Sale
              </button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-8 gap-4 px-5">
        <AnimatedCheckmark size={64} color={isDark ? '#4ade80' : '#16a34a'} />
        <p className="text-xl font-bold text-primary dark:text-white">
          Payment of {totalFormatted} successful!
        </p>
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl text-red-700 dark:text-red-300 text-sm w-full max-w-xs">
            {error}
          </div>
        )}
        <div className="flex flex-col gap-3 w-full max-w-xs mt-4">
          <button
            onClick={() => handleSendReceipt()}
            disabled={receiptSent || receiptSending}
            className={`w-full py-3 px-6 rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors ${
              receiptSent
                ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-white/60 dark:bg-white/5 border border-primary/20 dark:border-white/20 text-primary dark:text-white hover:bg-white/80 dark:hover:bg-white/10'
            }`}
          >
            <span className="material-symbols-outlined text-lg">
              {receiptSent ? 'check' : 'email'}
            </span>
            {receiptSending ? 'Sending...' : receiptSent ? 'Receipt Sent' : 'Email Receipt'}
          </button>
          <button
            onClick={resetForm}
            className="w-full py-3 px-6 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-colors hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-5 pb-5">
      <div>
        <h4 className="text-sm font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider mb-3">
          Order Summary
        </h4>
        <div className={`rounded-xl overflow-hidden border ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
          {cartItems.map((item, idx) => (
            <div
              key={item.productId}
              className={`flex items-center justify-between px-4 py-3 ${
                idx < cartItems.length - 1 ? `border-b ${isDark ? 'border-white/10' : 'border-primary/10'}` : ''
              }`}
            >
              <div className="flex-1">
                <span className="text-sm font-medium text-primary dark:text-white">{item.name}</span>
                <span className="text-sm text-primary/60 dark:text-white/60 ml-2">
                  {item.quantity} × ${(item.priceCents / 100).toFixed(2)}
                </span>
              </div>
              <span className="text-sm font-semibold text-primary dark:text-white">
                ${((item.priceCents * item.quantity) / 100).toFixed(2)}
              </span>
            </div>
          ))}
          <div
            className={`flex items-center justify-between px-4 py-3 border-t ${
              isDark ? 'border-white/10 bg-white/5' : 'border-primary/10 bg-primary/5'
            }`}
          >
            <span className="text-base font-bold text-primary dark:text-white">Total</span>
            <span className="text-lg font-bold text-primary dark:text-white">{totalFormatted}</span>
          </div>
        </div>
      </div>

      {!useGuestCheckout && (
        <div>
          <h4 className="text-sm font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider mb-2">
            Customer
          </h4>
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
            <span className="material-symbols-outlined text-primary/60 dark:text-white/60">person</span>
            <div>
              <p className="text-sm font-medium text-primary dark:text-white">{getCustomerInfo()?.name}</p>
              <p className="text-xs text-primary/60 dark:text-white/60">{getCustomerInfo()?.email}</p>
            </div>
          </div>
        </div>
      )}

      {useGuestCheckout && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30">
          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">bolt</span>
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Guest Checkout</p>
            <p className="text-xs text-amber-600 dark:text-amber-400">Terminal payment only</p>
          </div>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider mb-3">
          Payment Method
        </h4>
        {useGuestCheckout ? (
          <button
            onClick={() => handleSelectPaymentMethod('terminal')}
            className={`w-full flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
              selectedPaymentMethod === 'terminal'
                ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
            }`}
          >
            <span className="material-symbols-outlined text-xl">contactless</span>
            Card Reader
          </button>
        ) : (
        <div className={`grid gap-2 ${savedCard?.hasSavedCard && !useNewCustomer ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <button
            onClick={() => handleSelectPaymentMethod('online_card')}
            className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
              selectedPaymentMethod === 'online_card'
                ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
            }`}
          >
            <span className="material-symbols-outlined text-xl">credit_card</span>
            Online Card
          </button>
          <button
            onClick={() => handleSelectPaymentMethod('terminal')}
            className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
              selectedPaymentMethod === 'terminal'
                ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
            }`}
          >
            <span className="material-symbols-outlined text-xl">contactless</span>
            Card Reader
          </button>
          {savedCard?.hasSavedCard && !useNewCustomer && (
            <button
              onClick={() => handleSelectPaymentMethod('saved_card')}
              className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
                selectedPaymentMethod === 'saved_card'
                  ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                  : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
              }`}
            >
              <span className="material-symbols-outlined text-xl">wallet</span>
              <span className="leading-tight text-center">Card on File{savedCard.cardLast4 ? ` ••${savedCard.cardLast4}` : ''}</span>
            </button>
          )}
        </div>
        )}
        {checkingSavedCard && (
          <p className="text-xs text-primary/40 dark:text-white/40 mt-2 flex items-center gap-1">
            <span className="animate-spin inline-block w-3 h-3 border border-primary/30 dark:border-white/30 border-t-transparent rounded-full" />
            Checking saved card...
          </p>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {selectedPaymentMethod === 'online_card' && (
        <div>
          {isCreatingIntent ? (
            <div className="flex items-center justify-center py-8">
              <WalkingGolferSpinner size="sm" variant="auto" />
            </div>
          ) : clientSecret ? (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: getStripeAppearance(isDark),
              }}
            >
              <SimpleCheckoutForm
                onSuccess={handleCardPaymentSuccess}
                onError={(msg) => setError(msg)}
                submitLabel={`Pay ${totalFormatted}`}
              />
            </Elements>
          ) : null}
        </div>
      )}

      {selectedPaymentMethod === 'terminal' && (
        <TerminalPayment
          amount={totalCents}
          userId={getCustomerInfo()?.id || null}
          description={buildDescription()}
          paymentMetadata={{
            source: 'pos',
            items: cartItems.map(i => `${i.name} x${i.quantity}`).join(', '),
            ...(useGuestCheckout ? { guestCheckout: 'true' } : {}),
            ...(getCustomerInfo()?.id ? { userId: getCustomerInfo()!.id! } : {}),
            ...(!useGuestCheckout && getCustomerInfo()?.email ? { ownerEmail: getCustomerInfo()!.email } : {}),
            ...(!useGuestCheckout && getCustomerInfo()?.name ? { ownerName: getCustomerInfo()!.name } : {}),
          }}
          cartItems={useGuestCheckout ? undefined : cartItems.map(item => ({
            productId: item.productId,
            name: item.name,
            priceCents: item.priceCents,
            quantity: item.quantity,
          }))}
          onSuccess={handleTerminalSuccess}
          onError={(msg) => setError(msg)}
          onCancel={() => handleSelectPaymentMethod(null as unknown as PaymentMethodType)}
        />
      )}

      {selectedPaymentMethod === 'saved_card' && (
        <div className="space-y-4">
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
            <span className="material-symbols-outlined text-primary/60 dark:text-white/60">credit_card</span>
            <div>
              <p className="text-sm font-medium text-primary dark:text-white capitalize">
                {savedCard?.cardBrand || 'Card'} ending in {savedCard?.cardLast4 || '****'}
              </p>
              <p className="text-xs text-primary/50 dark:text-white/50">Will be charged instantly</p>
            </div>
          </div>
          <button
            onClick={handleSavedCardCharge}
            disabled={isProcessing}
            className="w-full py-4 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50"
          >
            {isProcessing ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                Charging...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">bolt</span>
                Charge {totalFormatted}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default POSCheckoutDrawer;

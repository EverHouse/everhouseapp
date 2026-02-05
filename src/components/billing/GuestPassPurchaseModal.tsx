import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { loadStripe, Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { SlideUpDrawer } from '../SlideUpDrawer';
import { getStripeAppearance } from '../stripe/stripeAppearance';

let stripePromise: Promise<Stripe | null> | null = null;

async function getStripePromise(): Promise<Stripe | null> {
  if (stripePromise) return stripePromise;
  
  try {
    const res = await fetch('/api/stripe/config', { credentials: 'include' });
    if (!res.ok) return null;
    const { publishableKey } = await res.json();
    if (!publishableKey) return null;
    stripePromise = loadStripe(publishableKey);
    return stripePromise;
  } catch {
    return null;
  }
}

interface PassOption {
  quantity: 1 | 3 | 5;
  price: number;
  pricePerPass: number;
  savings?: number;
}

const PASS_OPTIONS: PassOption[] = [
  { quantity: 1, price: 30, pricePerPass: 30 },
  { quantity: 3, price: 75, pricePerPass: 25, savings: 15 },
  { quantity: 5, price: 100, pricePerPass: 20, savings: 50 },
];

export interface GuestPassPurchaseModalProps {
  isOpen: boolean;
  userEmail: string;
  userName: string;
  onSuccess: () => void;
  onClose: () => void;
}

interface PurchaseResponse {
  clientSecret: string;
  paymentIntentId: string;
  quantity: number;
  amountCents: number;
}

function GuestPassCheckoutForm({ 
  onSuccess, 
  onCancel,
  quantity,
  paymentIntentId,
  isProcessing,
  setIsProcessing
}: { 
  onSuccess: () => void; 
  onCancel: () => void;
  quantity: number;
  paymentIntentId: string;
  isProcessing: boolean;
  setIsProcessing: (v: boolean) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
      redirect: 'if_required',
    });

    if (error) {
      setErrorMessage(error.message || 'Payment failed');
      setIsProcessing(false);
    } else if (paymentIntent && paymentIntent.status === 'succeeded') {
      try {
        await apiRequest(
          `/api/member/guest-passes/confirm`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentIntentId, quantity })
          }
        );
      } catch (err) {
        console.error('[GuestPassPurchaseModal] Error confirming payment:', err);
      }
      onSuccess();
    } else {
      setErrorMessage('Payment incomplete. Please try again.');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-white dark:bg-[#1a1d12] rounded-lg p-4 border border-primary/10 dark:border-white/10">
        <PaymentElement
          options={{
            layout: 'tabs',
          }}
        />
      </div>

      {errorMessage && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl text-red-700 dark:text-red-300 text-sm">
          {errorMessage}
        </div>
      )}
    </form>
  );
}

export function GuestPassPurchaseModal({
  isOpen,
  userEmail,
  userName,
  onSuccess,
  onClose
}: GuestPassPurchaseModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [selectedOption, setSelectedOption] = useState<PassOption | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentData, setPaymentData] = useState<PurchaseResponse | null>(null);
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setSelectedOption(null);
      setPaymentData(null);
      setError(null);
      setIsProcessing(false);
    }
  }, [isOpen]);

  const initializePayment = useCallback(async (option: PassOption) => {
    try {
      setLoading(true);
      setError(null);

      const stripe = await getStripePromise();
      if (!stripe) {
        setError('Payment system not available');
        setLoading(false);
        return;
      }
      setStripeInstance(stripe);

      const { ok, data, error: apiError } = await apiRequest<PurchaseResponse>(
        `/api/member/guest-passes/purchase`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: option.quantity })
        }
      );

      if (ok && data) {
        setPaymentData(data);
      } else {
        setError(apiError || 'Failed to initialize payment');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize payment');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSelectOption = (option: PassOption) => {
    setSelectedOption(option);
    initializePayment(option);
  };

  const handleBack = () => {
    setSelectedOption(null);
    setPaymentData(null);
    setError(null);
  };

  const options: StripeElementsOptions | null = paymentData?.clientSecret ? {
    clientSecret: paymentData.clientSecret,
    appearance: getStripeAppearance(isDark),
  } : null;

  const handleFormSubmit = () => {
    const form = document.querySelector('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  };

  const stickyFooter = selectedOption && !loading && !error && paymentData && stripeInstance && options ? (
    <div className="flex gap-2 p-4">
      <button
        type="button"
        onClick={handleFormSubmit}
        disabled={isProcessing}
        className="flex-1 py-4 rounded-xl backdrop-blur-md transition-all duration-300 flex items-center justify-center gap-2 group border bg-emerald-100/60 text-emerald-900 border-emerald-200 hover:bg-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-emerald-500/20 dark:hover:bg-emerald-900/60 disabled:opacity-50 font-semibold"
      >
        {isProcessing ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-emerald-600 dark:border-emerald-400 border-t-transparent" />
            Processing...
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300">credit_card</span>
            Complete Purchase
          </>
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={isProcessing}
        className="py-3 px-6 rounded-lg font-medium transition-colors text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-white/40 dark:hover:text-white dark:hover:bg-white/5 disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  ) : null;

  const title = selectedOption ? 'Complete Purchase' : 'Buy Guest Passes';

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      maxHeight="large"
      stickyFooter={stickyFooter}
    >
      <div className="p-4">
        {selectedOption && (
          <button
            onClick={handleBack}
            className={`flex items-center gap-1 mb-4 text-sm font-medium transition-colors ${
              isDark ? 'text-white/60 hover:text-white' : 'text-primary/60 hover:text-primary'
            }`}
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            Back to options
          </button>
        )}

        {!selectedOption && (
          <div className="space-y-3">
            <p className={`text-sm mb-4 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
              Purchase additional guest passes to bring more friends and family to the club.
            </p>
            
            {PASS_OPTIONS.map((option) => (
              <button
                key={option.quantity}
                onClick={() => handleSelectOption(option)}
                className={`w-full p-4 rounded-2xl border transition-all text-left ${
                  isDark 
                    ? 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20' 
                    : 'bg-primary/5 border-primary/10 hover:bg-primary/10 hover:border-primary/20'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                        {option.quantity} {option.quantity === 1 ? 'Pass' : 'Passes'}
                      </span>
                      {option.savings && (
                        <span className="px-2 py-0.5 text-xs font-bold bg-green-500/20 text-green-600 dark:text-green-400 rounded-full">
                          Save ${option.savings}
                        </span>
                      )}
                    </div>
                    <p className={`text-sm mt-1 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                      ${option.pricePerPass} per pass
                    </p>
                  </div>
                  <div className="text-right">
                    <span className={`text-2xl font-bold font-serif ${isDark ? 'text-white' : 'text-primary'}`}>
                      ${option.price}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {selectedOption && loading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
          </div>
        )}

        {selectedOption && error && (
          <div className="text-center py-8">
            <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
            <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
            <button
              onClick={handleBack}
              className="py-3 px-6 rounded-lg font-medium transition-colors text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-white/40 dark:hover:text-white dark:hover:bg-white/5"
            >
              Go Back
            </button>
          </div>
        )}

        {selectedOption && !loading && !error && paymentData && stripeInstance && options && (
          <div className="space-y-4">
            <div className={`rounded-xl p-4 ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
              <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                Order Summary
              </h4>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${
                    isDark
                      ? 'bg-primary/20 text-primary'
                      : 'bg-primary/10 text-primary'
                  }`}>
                    {selectedOption.quantity}
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                    Guest {selectedOption.quantity === 1 ? 'Pass' : 'Passes'}
                  </span>
                </div>
                <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                  ${selectedOption.price.toFixed(2)}
                </span>
              </div>
              {selectedOption.savings && (
                <div className={`mt-2 pt-2 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                  <span className={`text-xs ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                    You save
                  </span>
                  <span className={`text-xs font-medium ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                    ${selectedOption.savings.toFixed(2)}
                  </span>
                </div>
              )}
              <div className={`mt-3 pt-3 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                  Total
                </span>
                <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                  ${selectedOption.price.toFixed(2)}
                </span>
              </div>
            </div>

            <Elements stripe={stripeInstance} options={options} key={isDark ? 'dark' : 'light'}>
              <GuestPassCheckoutForm 
                onSuccess={onSuccess} 
                onCancel={onClose}
                quantity={selectedOption.quantity}
                paymentIntentId={paymentData.paymentIntentId}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
              />
            </Elements>
          </div>
        )}
      </div>
    </SlideUpDrawer>
  );
}

export default GuestPassPurchaseModal;

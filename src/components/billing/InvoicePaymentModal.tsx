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

interface Invoice {
  id: string;
  status: string;
  amountDue: number;
  description: string | null;
  lines: Array<{
    description: string | null;
    amount: number;
    quantity: number | null;
  }>;
}

export interface InvoicePaymentModalProps {
  isOpen: boolean;
  invoice: Invoice;
  userEmail: string;
  userName: string;
  onSuccess: () => void;
  onClose: () => void;
}

interface PayInvoiceResponse {
  clientSecret: string;
  paymentIntentId: string;
  invoiceId: string;
  amount: number;
  description: string;
  currency: string;
}

function InvoiceCheckoutForm({ 
  onSuccess, 
  onCancel,
  invoiceId,
  paymentIntentId,
  isProcessing,
  setIsProcessing
}: { 
  onSuccess: () => void; 
  onCancel: () => void;
  invoiceId: string;
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
          `/api/member/invoices/${invoiceId}/confirm`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentIntentId })
          }
        );
      } catch (err) {
        console.error('[InvoicePaymentModal] Error confirming payment:', err);
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

export function InvoicePaymentModal({
  isOpen,
  invoice,
  userEmail,
  userName,
  onSuccess,
  onClose
}: InvoicePaymentModalProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paymentData, setPaymentData] = useState<PayInvoiceResponse | null>(null);
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const initializePayment = useCallback(async () => {
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

      const { ok, data, error: apiError } = await apiRequest<PayInvoiceResponse>(
        `/api/member/invoices/${invoice.id}/pay`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
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
  }, [invoice.id]);

  useEffect(() => {
    if (isOpen) {
      initializePayment();
    }
  }, [isOpen, initializePayment]);

  const formatAmount = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const primaryLine = invoice.lines?.[0];
  const description = primaryLine?.description || invoice.description || 'Invoice';

  const options: StripeElementsOptions | null = paymentData?.clientSecret ? {
    clientSecret: paymentData.clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#31543C',
        colorBackground: '#ffffff',
        colorText: '#31543C',
        colorDanger: '#df1b41',
        fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px',
      },
    },
  } : null;

  const handleFormSubmit = () => {
    const form = document.querySelector('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  };

  const stickyFooter = !loading && !error && paymentData && stripeInstance && options ? (
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
            Pay Now
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

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Pay Invoice"
      maxHeight="large"
      stickyFooter={stickyFooter}
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
              className="py-3 px-6 rounded-lg font-medium transition-colors text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-white/40 dark:hover:text-white dark:hover:bg-white/5"
            >
              Go Back
            </button>
          </div>
        )}

        {!loading && !error && paymentData && stripeInstance && options && (
          <div className="space-y-4">
            <div className={`rounded-xl p-4 ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
              <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                Invoice Summary
              </h4>
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <span className={`text-sm flex-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                    {description}
                  </span>
                  <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>
                    {formatAmount(invoice.amountDue)}
                  </span>
                </div>
                {invoice.lines.length > 1 && invoice.lines.slice(1).map((line, idx) => (
                  <div key={idx} className="flex items-start justify-between gap-2">
                    <span className={`text-sm flex-1 ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
                      {line.description || 'Item'}
                    </span>
                    <span className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                      {formatAmount(line.amount)}
                    </span>
                  </div>
                ))}
              </div>
              <div className={`mt-3 pt-3 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
                <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                  Total Due
                </span>
                <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-primary'}`}>
                  {formatAmount(invoice.amountDue)}
                </span>
              </div>
            </div>

            <Elements stripe={stripeInstance} options={options}>
              <InvoiceCheckoutForm 
                onSuccess={onSuccess} 
                onCancel={onClose}
                invoiceId={invoice.id}
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

export default InvoicePaymentModal;

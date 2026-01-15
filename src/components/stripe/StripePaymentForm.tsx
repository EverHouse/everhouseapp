import React, { useState, useEffect } from 'react';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { loadStripe, Stripe, StripeElementsOptions } from '@stripe/stripe-js';

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

interface ParticipantFee {
  id: number;
  amount: number;
}

interface PaymentFormProps {
  amount: number;
  description: string;
  userId: string;
  userEmail: string;
  memberName: string;
  purpose: 'guest_fee' | 'overage_fee' | 'one_time_purchase';
  bookingId?: number;
  sessionId?: number;
  participantFees?: ParticipantFee[];
  onSuccess: () => void;
  onCancel: () => void;
}

function CheckoutForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
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

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!stripe || isProcessing}
          className="flex-1 py-3 bg-primary text-white font-semibold rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isProcessing ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
              Processing...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined">credit_card</span>
              Pay Now
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isProcessing}
          className="px-4 py-3 bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium rounded-xl hover:bg-primary/20 dark:hover:bg-white/20 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function StripePaymentForm({
  amount,
  description,
  userId,
  userEmail,
  memberName,
  purpose,
  bookingId,
  sessionId,
  participantFees,
  onSuccess,
  onCancel,
}: PaymentFormProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const intentCreatedRef = React.useRef(false);

  useEffect(() => {
    if (intentCreatedRef.current) {
      return;
    }
    
    const initStripe = async () => {
      try {
        intentCreatedRef.current = true;
        const stripe = await getStripePromise();
        if (!stripe) {
          throw new Error('Stripe is not configured');
        }
        setStripeInstance(stripe);

        const res = await fetch('/api/stripe/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId,
            email: userEmail,
            memberName,
            amountCents: Math.round(amount * 100),
            purpose,
            description,
            bookingId,
            sessionId,
            participantFees,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create payment');
        }

        const data = await res.json();
        setClientSecret(data.clientSecret);
      } catch (err: any) {
        setError(err.message || 'Failed to initialize payment');
        intentCreatedRef.current = false;
      } finally {
        setLoading(false);
      }
    };

    initStripe();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
        <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
        <button
          onClick={onCancel}
          className="px-4 py-2 bg-primary/10 dark:bg-white/10 text-primary dark:text-white rounded-xl"
        >
          Go Back
        </button>
      </div>
    );
  }

  if (!clientSecret || !stripeInstance) {
    return null;
  }

  const options: StripeElementsOptions = {
    clientSecret,
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
  };

  return (
    <Elements stripe={stripeInstance} options={options}>
      <div className="space-y-4">
        <div className="bg-primary/5 dark:bg-white/5 rounded-xl p-4 flex items-center justify-between">
          <span className="text-primary/70 dark:text-white/70">{description}</span>
          <span className="text-xl font-bold text-primary dark:text-white">
            ${amount.toFixed(2)}
          </span>
        </div>
        <CheckoutForm onSuccess={onSuccess} onCancel={onCancel} />
      </div>
    </Elements>
  );
}

export default StripePaymentForm;

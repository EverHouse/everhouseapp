import React, { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || '');

export interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

const QuickChargeSection: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentStep, setPaymentStep] = useState<'form' | 'payment'>('form');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [isCreatingPayment, setIsCreatingPayment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleCreatePayment = async () => {
    if (!selectedMember || !amount || parseFloat(amount) <= 0) return;
    
    setIsCreatingPayment(true);
    setError(null);
    
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      const res = await fetch('/api/stripe/staff/quick-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: selectedMember.email,
          memberName: selectedMember.name,
          amountCents,
          description: description || 'Quick charge'
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create payment');
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      setPaymentStep('payment');
    } catch (err: any) {
      setError(err.message || 'Failed to create payment');
    } finally {
      setIsCreatingPayment(false);
    }
  };

  const handlePaymentSuccess = async () => {
    if (!paymentIntentId) return;
    
    try {
      await fetch('/api/stripe/staff/quick-charge/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId })
      });
      setSuccess(true);
      setTimeout(() => {
        setSelectedMember(null);
        setAmount('');
        setDescription('');
        setPaymentStep('form');
        setSuccess(false);
        setClientSecret(null);
        setPaymentIntentId(null);
      }, 2000);
    } catch (err) {
      console.error('Confirm failed:', err);
    }
  };

  const handlePaymentError = (errorMessage: string) => {
    setError(errorMessage);
    setPaymentStep('form');
  };

  const content = (
    <div className="space-y-4">
      {success ? (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
            <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
          </div>
          <p className="text-lg font-semibold text-primary dark:text-white">Payment Successful!</p>
        </div>
      ) : paymentStep === 'form' ? (
        <>
          <MemberSearchInput
            label="Search Member"
            placeholder="Name or email..."
            selectedMember={selectedMember}
            onSelect={(member) => setSelectedMember(member)}
            onClear={() => setSelectedMember(null)}
          />

          {selectedMember && (
            <>
              <div>
                <label htmlFor="quick-charge-amount" className="block text-sm font-medium text-primary dark:text-white mb-2">Amount</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
                  <input
                    id="quick-charge-amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0.50"
                    className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-lg font-semibold"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="quick-charge-description" className="block text-sm font-medium text-primary dark:text-white mb-2">Description (optional)</label>
                <input
                  id="quick-charge-description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this charge for?"
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                  <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                </div>
              )}

              <button
                onClick={handleCreatePayment}
                disabled={!amount || parseFloat(amount) < 0.5 || isCreatingPayment}
                className="w-full py-3.5 rounded-full bg-primary dark:bg-lavender text-white dark:text-primary font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCreatingPayment ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                    Creating...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined">credit_card</span>
                    Charge ${amount || '0.00'}
                  </>
                )}
              </button>
            </>
          )}
        </>
      ) : (
        <div>
          <div className="mb-4 p-3 rounded-xl bg-primary/5 dark:bg-white/5">
            <p className="text-sm text-primary/60 dark:text-white/60">Charging</p>
            <p className="text-2xl font-bold text-primary dark:text-white">${amount}</p>
            <p className="text-sm text-primary/60 dark:text-white/60 mt-1">{selectedMember?.name}</p>
          </div>
          
          {clientSecret && (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <StripePaymentForm
                onSuccess={handlePaymentSuccess}
                onError={handlePaymentError}
                submitLabel={`Pay $${amount}`}
              />
            </Elements>
          )}
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-slate-600 dark:text-slate-400">point_of_sale</span>
          <h3 className="font-bold text-primary dark:text-white">Quick Charge</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-slate-600 dark:text-slate-400">point_of_sale</span>
          <h3 className="font-bold text-primary dark:text-white">Quick Charge</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

export default QuickChargeSection;

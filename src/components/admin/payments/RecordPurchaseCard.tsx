import React, { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || '');

export interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

type PaymentMode = 'card' | 'cash';

interface StripeProduct {
  id: number;
  stripeProductId: string;
  stripePriceId: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  isActive: boolean;
}

const RecordPurchaseCard: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('card');
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  
  const [products, setProducts] = useState<StripeProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<StripeProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'check' | 'other'>('cash');
  const [category, setCategory] = useState<'guest_fee' | 'overage' | 'merchandise' | 'membership' | 'other'>('other');
  const [notes, setNotes] = useState('');
  
  const [paymentStep, setPaymentStep] = useState<'form' | 'payment'>('form');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (paymentMode === 'card') {
      fetchProducts();
    }
  }, [paymentMode]);

  const fetchProducts = async () => {
    setIsLoadingProducts(true);
    try {
      const res = await fetch('/api/stripe/products', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const oneTimeProducts = (data.products || []).filter(
          (p: StripeProduct) => p.isActive && p.billingInterval === 'one_time'
        );
        setProducts(oneTimeProducts);
      }
    } catch (err) {
      console.error('Failed to fetch products:', err);
    } finally {
      setIsLoadingProducts(false);
    }
  };

  const handleProductSelect = (productId: string) => {
    if (!productId) {
      setSelectedProduct(null);
      setQuantity(1);
      return;
    }
    const product = products.find(p => p.stripeProductId === productId);
    if (product) {
      setSelectedProduct(product);
      setQuantity(1);
      setAmount((product.priceCents / 100).toFixed(2));
      setDescription(product.name);
    }
  };

  const handleQuantityChange = (newQuantity: number) => {
    const qty = Math.max(1, Math.min(99, newQuantity));
    setQuantity(qty);
    if (selectedProduct) {
      const totalCents = selectedProduct.priceCents * qty;
      setAmount((totalCents / 100).toFixed(2));
      setDescription(qty > 1 ? `${selectedProduct.name} x${qty}` : selectedProduct.name);
    }
  };

  const resetForm = () => {
    setSelectedMember(null);
    setAmount('');
    setDescription('');
    setSelectedProduct(null);
    setQuantity(1);
    setPaymentMethod('cash');
    setCategory('other');
    setNotes('');
    setPaymentStep('form');
    setClientSecret(null);
    setPaymentIntentId(null);
    setError(null);
    setSuccess(false);
  };

  const handleCreateCardPayment = async () => {
    if (!selectedMember || !amount || parseFloat(amount) <= 0) return;
    
    setIsProcessing(true);
    setError(null);
    
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      const payload: Record<string, any> = {
        memberEmail: selectedMember.email,
        memberName: selectedMember.name,
        amountCents,
        description: description || 'Quick charge'
      };
      
      if (selectedProduct) {
        payload.productId = selectedProduct.stripeProductId;
      }
      
      const res = await fetch('/api/stripe/staff/quick-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
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
      setIsProcessing(false);
    }
  };

  const handleCardPaymentSuccess = async () => {
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
        resetForm();
      }, 2000);
    } catch (err) {
      console.error('Confirm failed:', err);
    }
  };

  const handleCardPaymentError = (errorMessage: string) => {
    setError(errorMessage);
    setPaymentStep('form');
  };

  const handleRecordCashPayment = async () => {
    if (!selectedMember || !amount || parseFloat(amount) <= 0) return;
    
    setIsProcessing(true);
    setError(null);
    
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      const res = await fetch('/api/payments/record-offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: selectedMember.email,
          memberId: selectedMember.id,
          memberName: selectedMember.name,
          amountCents,
          paymentMethod,
          category,
          description: description || undefined,
          notes: notes || undefined
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to record payment');
      }

      setSuccess(true);
      setTimeout(() => {
        resetForm();
      }, 2500);
    } catch (err: any) {
      setError(err.message || 'Failed to record payment');
    } finally {
      setIsProcessing(false);
    }
  };

  const paymentMethodOptions = [
    { value: 'cash', label: 'Cash', icon: 'payments' },
    { value: 'check', label: 'Check', icon: 'money' },
    { value: 'other', label: 'Other', icon: 'more_horiz' },
  ];

  const categoryOptions = [
    { value: 'guest_fee', label: 'Guest Fee' },
    { value: 'overage', label: 'Overage' },
    { value: 'merchandise', label: 'Merchandise' },
    { value: 'membership', label: 'Membership' },
    { value: 'other', label: 'Other' },
  ];

  const content = (
    <div className="space-y-4">
      {success ? (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
            <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
          </div>
          <p className="text-lg font-semibold text-primary dark:text-white">
            {paymentMode === 'card' ? 'Payment Successful!' : 'Payment Recorded!'}
          </p>
          <p className="text-sm text-primary/60 dark:text-white/60">
            ${amount} {paymentMode === 'cash' ? `via ${paymentMethod}` : 'charged'}
          </p>
        </div>
      ) : paymentStep === 'payment' && paymentMode === 'card' ? (
        <div>
          <div className="mb-4 p-3 rounded-xl bg-primary/5 dark:bg-white/5">
            <p className="text-sm text-primary/60 dark:text-white/60">Charging</p>
            <p className="text-2xl font-bold text-primary dark:text-white">${amount}</p>
            <p className="text-sm text-primary/60 dark:text-white/60 mt-1">{selectedMember?.name}</p>
          </div>
          
          {clientSecret && (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <StripePaymentForm
                onSuccess={handleCardPaymentSuccess}
                onError={handleCardPaymentError}
                submitLabel={`Pay $${amount}`}
              />
            </Elements>
          )}
        </div>
      ) : (
        <>
          <div className="flex rounded-xl bg-primary/5 dark:bg-white/5 p-1">
            <button
              onClick={() => setPaymentMode('card')}
              className={`flex-1 py-2.5 px-4 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-colors ${
                paymentMode === 'card'
                  ? 'bg-primary dark:bg-white text-white dark:text-primary shadow-sm'
                  : 'text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-lg">credit_card</span>
              Card
            </button>
            <button
              onClick={() => setPaymentMode('cash')}
              className={`flex-1 py-2.5 px-4 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-colors ${
                paymentMode === 'cash'
                  ? 'bg-primary dark:bg-white text-white dark:text-primary shadow-sm'
                  : 'text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-lg">payments</span>
              Cash/Check
            </button>
          </div>

          <MemberSearchInput
            label="Search Member"
            placeholder="Name or email..."
            selectedMember={selectedMember}
            onSelect={(member) => setSelectedMember(member)}
            onClear={() => setSelectedMember(null)}
          />

          {selectedMember && (
            <>
              {paymentMode === 'card' && (
                <div>
                  <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                    Product (optional)
                  </label>
                  {isLoadingProducts ? (
                    <div className="flex items-center gap-2 py-3 text-sm text-primary/60 dark:text-white/60">
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary/40 border-t-transparent" />
                      Loading products...
                    </div>
                  ) : (
                    <select
                      value={selectedProduct?.stripeProductId || ''}
                      onChange={(e) => handleProductSelect(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      <option value="">Custom amount (no product)</option>
                      {products.map(product => (
                        <option key={product.stripeProductId} value={product.stripeProductId}>
                          {product.name} - ${(product.priceCents / 100).toFixed(2)}
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedProduct && (
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                        Quantity
                      </label>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => handleQuantityChange(quantity - 1)}
                          disabled={quantity <= 1}
                          className="w-10 h-10 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white flex items-center justify-center hover:bg-primary/20 dark:hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <span className="material-symbols-outlined">remove</span>
                        </button>
                        <input
                          type="number"
                          value={quantity}
                          onChange={(e) => handleQuantityChange(parseInt(e.target.value) || 1)}
                          min="1"
                          max="99"
                          className="w-16 text-center py-2 rounded-lg bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white font-semibold focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        <button
                          type="button"
                          onClick={() => handleQuantityChange(quantity + 1)}
                          disabled={quantity >= 99}
                          className="w-10 h-10 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white flex items-center justify-center hover:bg-primary/20 dark:hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <span className="material-symbols-outlined">add</span>
                        </button>
                        <span className="text-sm text-primary/60 dark:text-white/60">
                          @ ${(selectedProduct.priceCents / 100).toFixed(2)} each
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="amount" className="block text-sm font-medium text-primary dark:text-white mb-2">Amount</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
                  <input
                    id="amount"
                    type="number"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      if (selectedProduct) {
                        setSelectedProduct(null);
                      }
                    }}
                    placeholder="0.00"
                    step="0.01"
                    min={paymentMode === 'card' ? '0.50' : '0.01'}
                    className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-lg font-semibold"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="description" className="block text-sm font-medium text-primary dark:text-white mb-2">
                  Description {paymentMode === 'card' ? '(optional)' : ''}
                </label>
                <input
                  id="description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={paymentMode === 'card' ? 'What is this charge for?' : 'What is this payment for?'}
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {paymentMode === 'cash' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">Payment Method</label>
                    <div className="flex gap-2">
                      {paymentMethodOptions.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setPaymentMethod(opt.value as typeof paymentMethod)}
                          className={`flex-1 py-2.5 px-3 rounded-xl font-medium text-sm flex items-center justify-center gap-1.5 transition-colors ${
                            paymentMethod === opt.value
                              ? 'bg-orange-500 text-white'
                              : 'bg-white/50 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10'
                          }`}
                        >
                          <span className="material-symbols-outlined text-base">{opt.icon}</span>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">Category</label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as typeof category)}
                      className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {categoryOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">Notes (optional)</label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Additional notes..."
                      rows={2}
                      className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                    />
                  </div>
                </>
              )}

              {error && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                  <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                </div>
              )}

              {paymentMode === 'card' ? (
                <button
                  onClick={handleCreateCardPayment}
                  disabled={!amount || parseFloat(amount) < 0.5 || isProcessing}
                  className="w-full py-3.5 rounded-full bg-primary dark:bg-lavender text-white dark:text-primary font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isProcessing ? (
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
              ) : (
                <button
                  onClick={handleRecordCashPayment}
                  disabled={!amount || parseFloat(amount) <= 0 || isProcessing}
                  className="w-full py-3.5 rounded-full bg-orange-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isProcessing ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                      Recording...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined">savings</span>
                      Record ${amount || '0.00'} Payment
                    </>
                  )}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-primary dark:text-accent">point_of_sale</span>
          <h3 className="font-bold text-primary dark:text-white">Record Purchase</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary dark:text-accent">point_of_sale</span>
          <h3 className="font-bold text-primary dark:text-white">Record Purchase</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

export default RecordPurchaseCard;

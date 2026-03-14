import React, { useState, useEffect, useRef } from 'react';
import { Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { SimpleCheckoutForm } from '../../../stripe/StripePaymentForm';
import { formatPhoneInput } from '../../../../utils/formatting';
import {
  VisitorFlowProps,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  DayPassProduct,
  EMAIL_REGEX,
  getStripePromise,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  RecentCreation,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  EmailCheckResult,
} from './newUserTypes';
import WalkingGolferSpinner from '../../../WalkingGolferSpinner';

export function VisitorFlow({
  step,
  form,
  setForm,
  products,
  isDark,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isLoading,
  setIsLoading,
  setError,
  setStep,
  onSuccess,
  createdUser,
  onClose,
  onBookNow,
  showToast,
  scannedIdImage,
  onShowIdScanner,
  recentCreations,
  emailCheckResult,
  onEmailBlur,
}: VisitorFlowProps) {
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const paymentInitiatedRef = useRef(false);

  const selectedProduct = products.find(p => p.id === form.productId);

  useEffect(() => {
    if (step === 'payment' && selectedProduct && !paymentInitiatedRef.current) {
      initializePayment();
    }
  }, [step, selectedProduct]);

  const initializePayment = async () => {
    if (paymentInitiatedRef.current || !selectedProduct) return;
    paymentInitiatedRef.current = true;
    setStripeLoading(true);
    setStripeError(null);

    try {
      const stripe = await getStripePromise();
      if (!stripe) {
        throw new Error('Stripe is not configured');
      }
      setStripeInstance(stripe);

      const res = await fetch('/api/day-passes/staff-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          productSlug: form.productId,
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          streetAddress: form.streetAddress || undefined,
          city: form.city || undefined,
          state: form.state || undefined,
          zipCode: form.zipCode || undefined,
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create payment');
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
    } catch (err: unknown) {
      setStripeError((err instanceof Error ? err.message : String(err)) || 'Failed to initialize payment');
      paymentInitiatedRef.current = false;
    } finally {
      setStripeLoading(false);
    }
  };

  const handlePaymentSuccess = async (paymentIntentIdResult?: string) => {
    if (!paymentIntentId && !paymentIntentIdResult) return;
    setIsLoading(true);
    
    try {
      const confirmRes = await fetch('/api/day-passes/staff-checkout/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId: paymentIntentIdResult || paymentIntentId })
      });

      if (!confirmRes.ok) {
        throw new Error('Failed to confirm purchase');
      }

      const confirmData = await confirmRes.json();
      showToast('Day pass purchased successfully!', 'success');
      const visitorId = confirmData.userId || 'visitor-' + Date.now();
      if (scannedIdImage && visitorId && !visitorId.startsWith('visitor-')) {
        fetch('/api/admin/save-id-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: visitorId,
            image: scannedIdImage.base64,
            mimeType: scannedIdImage.mimeType,
          }),
        }).catch(err => console.error('Failed to save ID image:', err));
      }
      onSuccess({
        id: visitorId,
        email: form.email,
        name: `${form.firstName} ${form.lastName}`
      });
    } catch (_err: unknown) {
      setError('Payment confirmation failed. Please contact support.');
    } finally {
      setIsLoading(false);
    }
  };

  const resetPayment = () => {
    paymentInitiatedRef.current = false;
    setClientSecret(null);
    setPaymentIntentId(null);
    setStripeError(null);
  };

  const proceedSubmittingRef = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const getInputClass = (fieldName: string) => `w-full px-3 py-2.5 rounded-lg border ${
    fieldErrors[fieldName]
      ? 'border-red-500 focus:border-red-500 focus:ring-red-500 bg-red-50 dark:bg-red-900/10'
      : isDark 
        ? 'bg-white/5 border-white/20 focus:border-emerald-500' 
        : 'bg-white border-gray-300 focus:border-emerald-500'
  } ${isDark ? 'text-white placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'} focus:outline-none focus:ring-1 transition-colors`;

  const inputClass = `w-full px-3 py-2.5 rounded-lg border ${
    isDark 
      ? 'bg-white/5 border-white/20 text-white placeholder-gray-500 focus:border-emerald-500' 
      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-emerald-500'
  } focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors`;

  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`;
  const errorMsgClass = 'text-red-500 text-xs mt-1 flex items-center gap-1';

  const handleProceedToPayment = () => {
    if (proceedSubmittingRef.current) return;

    const errors: Record<string, string> = {};
    if (!form.productId) errors.productId = 'Please select a day pass';
    if (!form.firstName) errors.firstName = 'First name is required';
    if (!form.lastName) errors.lastName = 'Last name is required';
    if (!form.email) errors.email = 'Email is required';
    else if (!EMAIL_REGEX.test(form.email)) errors.email = 'Please enter a valid email address';
    if (!form.phone) errors.phone = 'Phone number is required';
    
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Please fill in all required fields');
      return;
    }

    proceedSubmittingRef.current = true;
    setTimeout(() => { proceedSubmittingRef.current = false; }, 1000);

    setError(null);
    setStep('payment');
  };

  if (step === 'success') {
    return (
      <div className="text-center py-8">
        <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${
          isDark ? 'bg-emerald-600/20' : 'bg-emerald-100'
        }`}>
          <span className="material-symbols-outlined text-3xl text-emerald-600">check_circle</span>
        </div>
        <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Day Pass Purchased!
        </h3>
        <p className={`text-sm mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          {createdUser?.name}'s day pass is ready. Would you like to book their session now?
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className={`flex-1 py-2.5 rounded-lg font-medium transition-colors tactile-btn ${
              isDark 
                ? 'bg-white/10 text-white hover:bg-white/20' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Done
          </button>
          <button
            onClick={onBookNow}
            className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors tactile-btn"
          >
            <span className="material-symbols-outlined text-sm mr-1 align-middle">calendar_add_on</span>
            Book Now
          </button>
        </div>
      </div>
    );
  }

  if (step === 'payment') {
    const totalPrice = selectedProduct?.priceCents || 0;

    const stripeOptions = (clientSecret ? {
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#059669',
          colorBackground: isDark ? '#1a1d12' : '#ffffff',
          colorText: isDark ? '#ffffff' : '#31543C',
          colorDanger: '#df1b41',
          fontFamily: 'system-ui, sans-serif',
          borderRadius: '8px',
        },
      },
    } : undefined) as import('@stripe/stripe-js').StripeElementsOptions | undefined;

    return (
      <div className="space-y-4">
        <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Payment
        </h3>

        <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex justify-between items-center mb-2">
            <div>
              <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {selectedProduct?.name}
              </p>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                for {form.firstName} {form.lastName}
              </p>
            </div>
            <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              ${(totalPrice / 100).toFixed(2)}
            </span>
          </div>
        </div>

        {stripeLoading && (
          <div className="flex items-center justify-center py-8">
            <WalkingGolferSpinner size="sm" variant="auto" />
          </div>
        )}

        {stripeError && (
          <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            <p className="text-sm">{stripeError}</p>
            <button
              onClick={() => {
                resetPayment();
                initializePayment();
              }}
              className="text-sm underline mt-2 tactile-btn"
            >
              Try Again
            </button>
          </div>
        )}

        {clientSecret && stripeInstance && stripeOptions && (
          <Elements stripe={stripeInstance} options={stripeOptions}>
            <SimpleCheckoutForm
              onSuccess={handlePaymentSuccess}
              onError={(msg) => setStripeError(msg)}
              submitLabel={`Pay $${(totalPrice / 100).toFixed(2)}`}
            />
          </Elements>
        )}

        {!stripeLoading && !stripeError && !clientSecret && (
          <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Initializing payment...
            </p>
          </div>
        )}

        <button
          onClick={() => {
            resetPayment();
            setStep('form');
          }}
          className={`w-full py-2.5 text-sm tactile-btn ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
        >
          Back to Details
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onShowIdScanner}
        className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg border-2 border-dashed transition-colors tactile-btn ${
          isDark
            ? 'border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10'
            : 'border-emerald-500/50 text-emerald-600 hover:bg-emerald-50'
        }`}
      >
        <span className="material-symbols-outlined text-xl">photo_camera</span>
        <span className="text-sm font-medium">Scan Driver's License / ID</span>
      </button>
      {scannedIdImage && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
          isDark ? 'bg-emerald-900/30 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
        }`}>
          <span className="material-symbols-outlined text-sm">check_circle</span>
          ID scanned — fields auto-filled
        </div>
      )}
      <div className="space-y-1">
        <label className={labelClass}>Day Pass Product *</label>
        <select
          value={form.productId}
          onChange={(e) => {
            setForm(prev => ({ ...prev, productId: e.target.value }));
            if (fieldErrors.productId) setFieldErrors(prev => ({ ...prev, productId: '' }));
          }}
          className={getInputClass('productId')}
        >
          <option value="">Select a product...</option>
          {products.map(product => (
            <option key={product.id} value={product.id}>
              {product.name} - ${(product.priceCents / 100).toFixed(2)}
            </option>
          ))}
        </select>
        {fieldErrors.productId && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.productId}
          </p>
        )}
      </div>

      {selectedProduct && (
        <div className={`p-3 rounded-lg ${isDark ? 'bg-emerald-900/20 border border-emerald-700' : 'bg-emerald-50 border border-emerald-200'}`}>
          <div className="flex justify-between items-center">
            <span className={`text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
              Amount to charge:
            </span>
            <span className={`font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
              ${(selectedProduct.priceCents / 100).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className={labelClass}>First Name *</label>
          <input
            type="text"
            value={form.firstName}
            onChange={(e) => {
              setForm(prev => ({ ...prev, firstName: e.target.value }));
              if (fieldErrors.firstName) setFieldErrors(prev => ({ ...prev, firstName: '' }));
            }}
            placeholder="First name"
            className={getInputClass('firstName')}
          />
          {fieldErrors.firstName && (
            <p className={errorMsgClass}>
              <span className="material-symbols-outlined text-xs">error</span>
              {fieldErrors.firstName}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label className={labelClass}>Last Name *</label>
          <input
            type="text"
            value={form.lastName}
            onChange={(e) => {
              setForm(prev => ({ ...prev, lastName: e.target.value }));
              if (fieldErrors.lastName) setFieldErrors(prev => ({ ...prev, lastName: '' }));
            }}
            placeholder="Last name"
            className={getInputClass('lastName')}
          />
          {fieldErrors.lastName && (
            <p className={errorMsgClass}>
              <span className="material-symbols-outlined text-xs">error</span>
              {fieldErrors.lastName}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass}>Email *</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => {
            setForm(prev => ({ ...prev, email: e.target.value }));
            if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
          }}
          onBlur={() => onEmailBlur(form.email)}
          placeholder="email@example.com"
          className={getInputClass('email')}
        />
        {fieldErrors.email && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.email}
          </p>
        )}
        {emailCheckResult?.exists && (
          <div className={`mt-1.5 p-2 rounded-lg flex items-start gap-2 text-xs ${isDark ? 'bg-amber-900/20 border border-amber-700 text-amber-400' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
            <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">warning</span>
            <span>A {emailCheckResult.role || 'user'} named <strong>{emailCheckResult.userName}</strong> already exists with this email ({emailCheckResult.membershipStatus || 'active'}). Are you sure this is correct?</span>
          </div>
        )}
        {(() => {
          const currentEmail = form.email.trim().toLowerCase();
          const currentName = `${form.firstName} ${form.lastName}`.trim().toLowerCase();
          const recentMatch = recentCreations.find(r => (Date.now() - r.timestamp) < 600000 && (r.email === currentEmail || (currentName.length > 1 && r.name.toLowerCase() === currentName)));
          if (recentMatch) {
            const minsAgo = Math.round((Date.now() - recentMatch.timestamp) / 60000);
            return (
              <div className={`mt-1.5 p-2 rounded-lg flex items-start gap-2 text-xs ${isDark ? 'bg-orange-900/20 border border-orange-700 text-orange-400' : 'bg-orange-50 border border-orange-200 text-orange-700'}`}>
                <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">history</span>
                <span>You created a record for <strong>{recentMatch.name}</strong> {minsAgo < 1 ? 'just now' : `${minsAgo} min ago`}. Is this a different person?</span>
              </div>
            );
          }
          return null;
        })()}
      </div>

      <div className="space-y-1">
        <label className={labelClass}>Phone *</label>
        <input
          type="tel"
          value={formatPhoneInput(form.phone)}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
            setForm(prev => ({ ...prev, phone: digits }));
            if (fieldErrors.phone) setFieldErrors(prev => ({ ...prev, phone: '' }));
          }}
          placeholder="(555) 123-4567"
          className={getInputClass('phone')}
        />
        {fieldErrors.phone && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.phone}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Date of Birth</label>
        <input
          type="date"
          value={form.dob}
          onChange={(e) => setForm(prev => ({ ...prev, dob: e.target.value }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Notes</label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
          placeholder="Any additional notes about this visitor..."
          rows={3}
          className={inputClass}
        />
      </div>

      <button
        onClick={handleProceedToPayment}
        disabled={!form.productId || !form.firstName || !form.lastName || !form.email || !form.phone}
        className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed tactile-btn"
      >
        Proceed to Payment
      </button>
    </div>
  );
}

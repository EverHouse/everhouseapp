import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import Logo from '../components/Logo';
import EmptyState from '../components/EmptyState';

interface DayPassProduct {
  id: string;
  name: string;
  priceCents: number;
  description: string | null;
  stripePriceId: string | null;
  hasPriceId: boolean;
}

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

interface CheckoutFormProps {
  tier: string;
  email?: string;
  quantity?: number;
  companyName?: string;
  jobTitle?: string;
  isCorporate?: boolean;
}

function CheckoutForm({ tier, email, quantity = 1, companyName, jobTitle, isCorporate }: CheckoutFormProps) {
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const stripe = await getStripePromise();
        if (!stripe) {
          throw new Error('Stripe is not configured');
        }
        setStripeInstance(stripe);

        const res = await fetch('/api/checkout/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ 
            tier, 
            email,
            quantity: isCorporate ? quantity : 1,
            companyName: isCorporate ? companyName : undefined,
            jobTitle: isCorporate ? jobTitle : undefined,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create checkout session');
        }

        const data = await res.json();
        setClientSecret(data.clientSecret);
      } catch (err: any) {
        setError(err.message || 'Failed to initialize checkout');
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [tier, email, quantity, companyName, jobTitle, isCorporate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-12 w-12 border-3 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <span className="material-symbols-outlined text-6xl text-red-500 mb-4 block">error</span>
        <p className="text-red-600 dark:text-red-400 text-lg mb-4">{error}</p>
        <a
          href="/#/membership"
          className="inline-block py-3 px-6 rounded-xl font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          Back to Membership
        </a>
      </div>
    );
  }

  if (!clientSecret || !stripeInstance) {
    return null;
  }

  return (
    <EmbeddedCheckoutProvider
      stripe={stripeInstance}
      options={{ clientSecret }}
    >
      <EmbeddedCheckout />
    </EmbeddedCheckoutProvider>
  );
}

function getCorporatePriceDisplay(count: number): number {
  if (count >= 50) return 249;
  if (count >= 20) return 275;
  if (count >= 10) return 299;
  if (count >= 5) return 325;
  return 350;
}

function getPriceTier(count: number): string {
  if (count >= 50) return '50+ employees';
  if (count >= 20) return '20-49 employees';
  if (count >= 10) return '10-19 employees';
  return '5-9 employees';
}

interface CorporateCheckoutFormProps {
  tier: string;
  email?: string;
  initialQuantity: number;
}

function CorporateCheckoutForm({ tier, email, initialQuantity }: CorporateCheckoutFormProps) {
  const [companyName, setCompanyName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [quantity, setQuantity] = useState(Math.max(initialQuantity, 5));
  const [showStripeCheckout, setShowStripeCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pricePerSeat = getCorporatePriceDisplay(quantity);
  const totalMonthly = pricePerSeat * quantity;
  const priceTier = getPriceTier(quantity);

  const handleQuantityChange = (delta: number) => {
    setQuantity(prev => Math.max(5, Math.min(100, prev + delta)));
  };

  const handleContinue = () => {
    if (!companyName.trim()) {
      setError('Company name is required');
      return;
    }
    setError(null);
    setShowStripeCheckout(true);
  };

  if (showStripeCheckout) {
    return (
      <div className="space-y-6">
        <div className="glass-card rounded-2xl p-4 backdrop-blur-xl bg-white/30 dark:bg-white/5 border border-white/20">
          <div className="flex items-center justify-between text-sm">
            <div className="text-primary/70 dark:text-white/70">
              <span className="font-medium text-primary dark:text-white">{companyName}</span>
              {jobTitle && <span className="ml-2">({jobTitle})</span>}
            </div>
            <div className="text-primary dark:text-white font-medium">
              {quantity} seats × ${pricePerSeat}/mo = ${totalMonthly.toLocaleString()}/mo
            </div>
          </div>
        </div>
        <CheckoutForm 
          tier={tier} 
          email={email} 
          quantity={quantity}
          companyName={companyName}
          jobTitle={jobTitle}
          isCorporate={true}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent/20 flex items-center justify-center">
          <span className="material-symbols-outlined text-3xl text-accent">corporate_fare</span>
        </div>
        <h2 className="text-2xl font-bold text-primary dark:text-white mb-2">Corporate Membership</h2>
        <p className="text-primary/70 dark:text-white/70">Team memberships with volume discounts</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-2">
            Company Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme Corporation"
            className="w-full px-4 py-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 backdrop-blur-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent transition-all"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-2">
            Your Job Title
          </label>
          <input
            type="text"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="HR Manager, CEO, etc."
            className="w-full px-4 py-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 backdrop-blur-sm text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent transition-all"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-2">
            Number of Employee Seats
          </label>
          <div className="flex items-center gap-4">
            <button
              onClick={() => handleQuantityChange(-5)}
              disabled={quantity <= 5}
              className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/10 dark:bg-white/10 text-primary dark:text-white hover:bg-primary/20 dark:hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined">remove</span>
            </button>
            <div className="flex-1 text-center">
              <div className="text-4xl font-bold text-primary dark:text-white">{quantity}</div>
              <div className="text-sm text-primary/60 dark:text-white/60">{priceTier}</div>
            </div>
            <button
              onClick={() => handleQuantityChange(5)}
              disabled={quantity >= 100}
              className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/10 dark:bg-white/10 text-primary dark:text-white hover:bg-primary/20 dark:hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined">add</span>
            </button>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-5 backdrop-blur-xl bg-white/40 dark:bg-white/5 border border-white/30 dark:border-white/10">
        <h3 className="font-semibold text-primary dark:text-white mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-accent">receipt_long</span>
          Price Summary
        </h3>
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-primary/70 dark:text-white/70">Price per employee</span>
            <span className="text-primary dark:text-white font-medium">${pricePerSeat}/month</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-primary/70 dark:text-white/70">Number of seats</span>
            <span className="text-primary dark:text-white font-medium">×{quantity}</span>
          </div>
          <div className="border-t border-primary/10 dark:border-white/10 pt-3 flex justify-between">
            <span className="text-primary dark:text-white font-semibold">Total Monthly</span>
            <span className="text-2xl font-bold text-accent">${totalMonthly.toLocaleString()}</span>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-primary/10 dark:border-white/10">
          <h4 className="text-xs font-medium text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Volume Discounts</h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className={`p-2 rounded-lg ${quantity >= 5 && quantity < 10 ? 'bg-accent/20 text-accent font-medium' : 'text-primary/60 dark:text-white/60'}`}>5-9 seats: $325/mo</div>
            <div className={`p-2 rounded-lg ${quantity >= 10 && quantity < 20 ? 'bg-accent/20 text-accent font-medium' : 'text-primary/60 dark:text-white/60'}`}>10-19 seats: $299/mo</div>
            <div className={`p-2 rounded-lg ${quantity >= 20 && quantity < 50 ? 'bg-accent/20 text-accent font-medium' : 'text-primary/60 dark:text-white/60'}`}>20-49 seats: $275/mo</div>
            <div className={`p-2 rounded-lg ${quantity >= 50 ? 'bg-accent/20 text-accent font-medium' : 'text-primary/60 dark:text-white/60'}`}>50+ seats: $249/mo</div>
          </div>
        </div>
      </div>

      {error && (
        <p className="text-red-500 text-sm text-center">{error}</p>
      )}

      <button
        onClick={handleContinue}
        className="w-full py-4 px-6 rounded-xl font-semibold bg-accent text-brand-green hover:opacity-90 transition-opacity flex items-center justify-center gap-2 text-lg"
      >
        <span className="material-symbols-outlined">arrow_forward</span>
        Continue to Payment
      </button>

      <p className="text-xs text-center text-primary/50 dark:text-white/50">
        Minimum 5 employees required for corporate membership
      </p>
    </div>
  );
}

function DayPassesSection() {
  const [products, setProducts] = useState<DayPassProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<DayPassProduct | null>(null);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const res = await fetch('/api/day-passes/products');
        if (!res.ok) throw new Error('Failed to fetch products');
        const data = await res.json();
        setProducts(data.products || []);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchProducts();
  }, []);

  const handleCheckout = async (product: DayPassProduct) => {
    if (!email) {
      setSelectedProduct(product);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/day-passes/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productSlug: product.id,
          email,
          firstName,
          lastName,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create checkout');
      }

      const { sessionUrl } = await res.json();
      if (sessionUrl) {
        window.location.href = sessionUrl;
      }
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const formatPrice = (cents: number) => {
    return `$${(cents / 100).toFixed(0)}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-12 w-12 border-3 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error && !selectedProduct) {
    return (
      <div className="text-center py-8">
        <p className="text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-primary dark:text-white mb-2">Day Passes</h1>
        <p className="text-primary/70 dark:text-white/70">Experience the club for a day</p>
      </div>

      {selectedProduct ? (
        <div className="glass-card rounded-2xl p-6 md:p-8 max-w-md mx-auto">
          <h2 className="text-xl font-bold text-primary dark:text-white mb-4">
            Complete Your Purchase
          </h2>
          <p className="text-primary/70 dark:text-white/70 mb-6">
            {selectedProduct.name} - {formatPrice(selectedProduct.priceCents)}
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
                Email <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full px-4 py-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
                  First Name
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="John"
                  className="w-full px-4 py-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
                  Last Name
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Doe"
                  className="w-full px-4 py-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>

            {error && (
              <p className="text-red-500 text-sm">{error}</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setSelectedProduct(null)}
                className="flex-1 py-3 px-4 rounded-xl font-medium border border-primary/20 dark:border-white/20 text-primary dark:text-white hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => handleCheckout(selectedProduct)}
                disabled={!email || submitting}
                className="flex-1 py-3 px-4 rounded-xl font-semibold bg-accent text-brand-green hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-2 border-brand-green border-t-transparent" />
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">shopping_cart</span>
                    Pay {formatPrice(selectedProduct.priceCents)}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-3 gap-6">
          {products.map((product) => (
            <div
              key={product.id}
              className="glass-card rounded-2xl p-6 flex flex-col hover:shadow-lg transition-shadow"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-primary dark:text-white">
                    {product.id.includes('golf') ? 'sports_golf' : product.id.includes('cowork') ? 'work' : 'confirmation_number'}
                  </span>
                </div>
                <div>
                  <h3 className="font-bold text-primary dark:text-white">{product.name}</h3>
                  <p className="text-2xl font-bold text-accent">{formatPrice(product.priceCents)}</p>
                </div>
              </div>

              <p className="text-primary/70 dark:text-white/70 text-sm mb-6 flex-grow">
                {product.description || 'Experience the club for a day'}
              </p>

              {product.hasPriceId ? (
                <button
                  onClick={() => handleCheckout(product)}
                  className="w-full py-3 px-4 rounded-xl font-semibold bg-accent text-brand-green hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-lg">shopping_cart</span>
                  Buy Now
                </button>
              ) : (
                <div className="w-full py-3 px-4 rounded-xl font-medium bg-primary/10 dark:bg-white/10 text-primary/50 dark:text-white/50 text-center">
                  Coming Soon
                </div>
              )}
            </div>
          ))}

          {products.length === 0 && (
            <div className="col-span-3">
              <EmptyState
                icon="confirmation_number"
                title="No day passes available"
                description="Check back soon for available day passes."
                variant="compact"
              />
            </div>
          )}
        </div>
      )}

      <div className="text-center pt-8 border-t border-primary/10 dark:border-white/10">
        <p className="text-primary/60 dark:text-white/60 mb-4">Looking for a membership instead?</p>
        <a
          href="/#/membership"
          className="inline-flex items-center gap-2 py-3 px-6 rounded-xl font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
        >
          <span className="material-symbols-outlined">card_membership</span>
          View Membership Options
        </a>
      </div>
    </div>
  );
}

function CheckoutSuccess() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [customerEmail, setCustomerEmail] = useState<string | null>(null);
  const [purchaseType, setPurchaseType] = useState<'membership' | 'day_pass' | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setStatus('error');
      return;
    }

    const fetchSession = async () => {
      try {
        const res = await fetch(`/api/checkout/session/${sessionId}`);
        if (!res.ok) throw new Error('Failed to fetch session');
        
        const data = await res.json();
        setCustomerEmail(data.customerEmail);
        setStatus(data.status === 'complete' ? 'success' : 'error');
        
        if (data.metadata?.purpose === 'day_pass') {
          setPurchaseType('day_pass');
        } else {
          setPurchaseType('membership');
        }
      } catch {
        setStatus('error');
      }
    };

    fetchSession();
  }, [sessionId]);

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-12 w-12 border-3 border-primary border-t-transparent" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="text-center py-16">
        <span className="material-symbols-outlined text-6xl text-red-500 mb-4 block">error</span>
        <h2 className="text-2xl font-bold text-primary dark:text-white mb-2">Something went wrong</h2>
        <p className="text-primary/70 dark:text-white/70 mb-6">We couldn't verify your payment. Please contact support.</p>
        <a
          href="/#/contact"
          className="inline-block py-3 px-6 rounded-xl font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          Contact Support
        </a>
      </div>
    );
  }

  if (purchaseType === 'day_pass') {
    return (
      <div className="text-center py-16">
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
          <span className="material-symbols-outlined text-5xl text-emerald-600 dark:text-emerald-400">check_circle</span>
        </div>
        <h2 className="text-3xl font-bold text-primary dark:text-white mb-2">Purchase Complete!</h2>
        <p className="text-primary/70 dark:text-white/70 text-lg mb-2">Your day pass has been confirmed.</p>
        {customerEmail && (
          <p className="text-primary/60 dark:text-white/60 mb-4">A confirmation has been sent to {customerEmail}</p>
        )}
        <div className="glass-card rounded-2xl p-6 max-w-md mx-auto mb-8 text-left">
          <h3 className="font-bold text-primary dark:text-white mb-3">What's Next?</h3>
          <ul className="space-y-2 text-primary/70 dark:text-white/70 text-sm">
            <li className="flex items-start gap-2">
              <span className="material-symbols-outlined text-accent text-lg">mail</span>
              Check your email for your day pass details
            </li>
            <li className="flex items-start gap-2">
              <span className="material-symbols-outlined text-accent text-lg">location_on</span>
              Visit us at 123 Ever House Lane
            </li>
            <li className="flex items-start gap-2">
              <span className="material-symbols-outlined text-accent text-lg">schedule</span>
              Present your confirmation at the front desk
            </li>
          </ul>
        </div>
        <a
          href="/#/"
          className="inline-flex items-center justify-center gap-2 py-3 px-8 rounded-xl font-semibold bg-accent text-brand-green hover:opacity-90 transition-opacity"
        >
          <span className="material-symbols-outlined">home</span>
          Return Home
        </a>
      </div>
    );
  }

  return (
    <div className="text-center py-16">
      <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
        <span className="material-symbols-outlined text-5xl text-emerald-600 dark:text-emerald-400">check_circle</span>
      </div>
      <h2 className="text-3xl font-bold text-primary dark:text-white mb-2">Welcome to EverHouse!</h2>
      <p className="text-primary/70 dark:text-white/70 text-lg mb-2">Your membership is now active.</p>
      {customerEmail && (
        <p className="text-primary/60 dark:text-white/60 mb-8">A confirmation has been sent to {customerEmail}</p>
      )}
      <div className="flex flex-col sm:flex-row gap-4 justify-center">
        <a
          href="/#/login"
          className="inline-flex items-center justify-center gap-2 py-3 px-8 rounded-xl font-semibold bg-accent text-brand-green hover:opacity-90 transition-opacity"
        >
          <span className="material-symbols-outlined">login</span>
          Sign In to Your Account
        </a>
      </div>
    </div>
  );
}

export default function Checkout() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const isSuccess = location.pathname.includes('/success');
  
  const tier = searchParams.get('tier');
  const email = searchParams.get('email') || undefined;
  const qty = parseInt(searchParams.get('qty') || '1', 10);
  const isCorporate = tier === 'corporate';

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f5f7f0] to-[#eef1e6] dark:from-[#0f120a] dark:to-[#1a1d12]">
      <header className="sticky top-0 z-50 bg-transparent">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <a href="/#/" className="inline-flex items-center gap-2 text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white transition-colors text-sm">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            Back to EverHouse
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        {isSuccess ? (
          <CheckoutSuccess />
        ) : tier ? (
          <div className="glass-card rounded-2xl p-6 md:p-8 backdrop-blur-xl bg-white/50 dark:bg-white/5 border border-white/30 dark:border-white/10">
            {isCorporate ? (
              <CorporateCheckoutForm 
                tier={tier} 
                email={email} 
                initialQuantity={qty}
              />
            ) : (
              <>
                <h1 className="text-2xl font-bold text-primary dark:text-white mb-6 text-center">Complete Your Membership</h1>
                <CheckoutForm tier={tier} email={email} />
              </>
            )}
          </div>
        ) : (
          <DayPassesSection />
        )}
      </main>
    </div>
  );
}

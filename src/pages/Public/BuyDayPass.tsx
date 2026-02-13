import React, { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import Input from '../../components/Input';
import EmptyState from '../../components/EmptyState';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import SEO from '../../components/SEO';

interface DayPassTier {
  id: number;
  name: string;
  slug: string;
  priceString: string;
  priceCents: number;
  description: string | null;
  stripePriceId: string | null;
}

const BuyDayPass: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const filterType = searchParams.get('type');
  const { startNavigation } = useNavigationLoading();
  const { setPageReady } = usePageReady();
  const [tiers, setTiers] = useState<DayPassTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [processingSlug, setProcessingSlug] = useState<string | null>(null);

  useEffect(() => {
    fetchDayPassTiers();
  }, []);

  const fetchDayPassTiers = async () => {
    try {
      const response = await fetch('/api/membership-tiers?active=true');
      if (!response.ok) throw new Error('Failed to fetch day passes');
      
      const allTiers = await response.json();
      const dayPasses = allTiers
        .filter((tier: any) => tier.product_type === 'one_time')
        .filter((tier: any) => !tier.slug?.includes('overage'))
        .map((tier: any) => ({
          id: tier.id,
          name: tier.name,
          slug: tier.slug,
          priceString: tier.price_string,
          priceCents: tier.price_cents,
          description: tier.description,
          stripePriceId: tier.stripe_price_id,
        }));
      
      const filtered = filterType 
        ? dayPasses.filter((t: DayPassTier) => t.slug === filterType || t.slug.includes(filterType)) 
        : dayPasses;
      setTiers(filtered.length > 0 ? filtered : dayPasses);
      setPageReady(true);
    } catch (err) {
      setError('Unable to load day passes. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePurchase = async (tier: DayPassTier) => {
    if (!email) {
      setError('Please enter your email address');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setError(null);
    setProcessingSlug(tier.slug);

    try {
      const response = await fetch('/api/public/day-pass/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          passType: tier.slug,
          firstName,
          lastName,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create checkout');
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Something went wrong. Please try again.');
      setProcessingSlug(null);
    }
  };

  const formatPrice = (cents: number) => {
    return `$${(cents / 100).toFixed(0)}`;
  };

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-bone dark:bg-[#0f120a]">
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary dark:border-white border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-bone dark:bg-[#0f120a] overflow-x-hidden">
      <SEO title="Day Pass — Golf Simulator & Coworking | Ever Members Club, Orange County" description="No membership needed. Purchase a day pass for Trackman golf simulators or premium coworking at Ever Members Club in Tustin, Orange County." url="/day-pass" />
      <div className="px-6 pt-4 md:pt-2 pb-6 text-center animate-pop-in">
        <h1 className="text-3xl font-bold tracking-tight text-primary dark:text-white mb-3">Day Passes</h1>
        <p className="text-primary/70 dark:text-white/70 text-sm leading-relaxed max-w-xs mx-auto">
          Experience Ever Club as a guest. No membership required.
        </p>
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-primary/60 dark:text-white/60 mt-3">
          <span className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">wifi</span>
            High-speed wifi
          </span>
          <span className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">local_cafe</span>
            Cafe access
          </span>
          <span className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">weekend</span>
            Lounge access
          </span>
        </div>
      </div>

      <section className="px-4 mb-6">
        <div className="bg-white dark:bg-[#1a1d15] rounded-[2rem] p-6 shadow-sm dark:shadow-none border border-black/5 dark:border-white/10">
          <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-xl">person</span>
            Your Information
          </h2>
          
          <div className="space-y-4">
            <Input 
              label="Email Address" 
              type="email" 
              placeholder="your@email.com" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              variant="solid"
              required 
            />
            <div className="grid grid-cols-2 gap-3">
              <Input 
                label="First Name" 
                placeholder="John" 
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                variant="solid"
              />
              <Input 
                label="Last Name" 
                placeholder="Doe" 
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                variant="solid"
              />
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="px-4 mb-4">
          <div className="bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        </div>
      )}

      <section className="px-4 mb-8">
        <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2 px-2">
          <span className="material-symbols-outlined text-xl">confirmation_number</span>
          Available Passes
        </h2>

        {tiers.length === 0 ? (
          <div className="bg-white dark:bg-[#1a1d15] rounded-2xl border border-black/5 dark:border-white/10">
            <EmptyState
              icon="confirmation_number"
              title="No day passes available"
              description="Check back soon for available day passes."
              variant="compact"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {tiers.map((tier) => (
              <div 
                key={tier.id}
                className="bg-white dark:bg-[#1a1d15] rounded-2xl p-5 border border-black/5 dark:border-white/10 shadow-sm dark:shadow-none"
              >
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-primary dark:text-white">{tier.name}</h3>
                    {tier.description && (
                      <p className="text-sm text-primary/60 dark:text-white/60 mt-1">{tier.description}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-bold text-primary dark:text-white">
                      {tier.priceCents ? formatPrice(tier.priceCents) : tier.priceString}
                    </span>
                  </div>
                </div>
                
                <button
                  onClick={() => handlePurchase(tier)}
                  disabled={processingSlug !== null || !tier.stripePriceId}
                  className="w-full flex justify-center items-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-bold text-white shadow-md hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {processingSlug === tier.slug ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Processing...
                    </>
                  ) : !tier.stripePriceId ? (
                    'Coming Soon'
                  ) : (
                    <>
                      Buy Now
                      <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="px-4 mb-8">
        <div className="bg-[#E8E8E0]/50 dark:bg-white/5 rounded-2xl p-5">
          <h3 className="text-base font-bold text-primary dark:text-white mb-3 flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">info</span>
            How It Works
          </h3>
          <ul className="space-y-2 text-sm text-primary/70 dark:text-white/70">
            <li className="flex items-start gap-2">
              <span className="material-symbols-outlined text-base text-primary/50 dark:text-white/50 mt-0.5">check_circle</span>
              <span>Complete your purchase securely with Stripe</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="material-symbols-outlined text-base text-primary/50 dark:text-white/50 mt-0.5">check_circle</span>
              <span>Receive a QR code via email</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="material-symbols-outlined text-base text-primary/50 dark:text-white/50 mt-0.5">check_circle</span>
              <span>Show your QR code at the front desk when you arrive</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="px-4 py-8 mb-4">
        <div className="bg-primary rounded-2xl p-6 text-center">
          <h3 className="text-xl font-bold text-white mb-2">Want more than a day pass?</h3>
          <p className="text-white/70 text-sm mb-4">Become a member and enjoy unlimited access plus exclusive benefits.</p>
          <button 
            onClick={() => { startNavigation(); navigate('/membership'); }}
            className="bg-bone text-primary px-6 py-3 rounded-xl font-bold text-sm hover:bg-white transition-colors"
          >
            Explore Memberships
          </button>
        </div>
      </section>
      
      <section className="px-6 py-10 text-center">
        <p className="text-primary/60 dark:text-white/60 text-sm mb-2">Loved your visit?</p>
        <p className="text-primary/80 dark:text-white/80 text-sm font-medium mb-4">Membership gives you unlimited access, priority booking, and a community of professionals.</p>
        <Link to="/tour" className="inline-block px-8 py-4 bg-primary text-white rounded-2xl font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-300 active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]">
          Book a Tour
        </Link>
      </section>

      <Footer />
    </div>
  );
};

export default BuyDayPass;

import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import BackToTop from '../../components/BackToTop';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { AnimatedPage } from '../../components/motion';
import SEO from '../../components/SEO';
import { usePricing } from '../../hooks/usePricing';

interface MembershipTier {
  id: number;
  name: string;
  slug: string;
  price_string: string;
  description: string;
  button_text: string;
  sort_order: number;
  is_active: boolean;
  is_popular: boolean;
  show_in_comparison: boolean;
  show_on_membership_page?: boolean;
  product_type?: string;
  highlighted_features: string[];
  daily_sim_minutes: number;
  guest_passes_per_month: number;
  booking_window_days: number;
  daily_conf_room_minutes: number;
  can_book_simulators: boolean;
  can_book_conference: boolean;
  can_book_wellness: boolean;
  has_group_lessons: boolean;
  has_extended_sessions: boolean;
  has_private_lesson: boolean;
  has_simulator_guest_passes: boolean;
  has_discounted_merch: boolean;
  unlimited_access: boolean;
}

interface TierFeature {
  id: number;
  featureKey: string;
  displayLabel: string;
  valueType: 'boolean' | 'number' | 'text';
  sortOrder: number;
  isActive: boolean;
  values: Record<string, { tierId: number; value: string | boolean | number | null }>;
}

const Membership: React.FC = () => {
  return (
    <Routes>
      <Route index element={<MembershipOverview />} />
      <Route path="compare" element={<CompareFeatures />} />
      <Route path="corporate" element={<Corporate />} />
    </Routes>
  );
};

const MembershipOverview: React.FC = () => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const { setPageReady } = usePageReady();
  const { guestFeeDollars, dayPassPrices } = usePricing();
  const [selectedPass, setSelectedPass] = useState<'workspace' | 'sim' | null>(null);
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!loading) {
      setPageReady(true);
    }
  }, [loading, setPageReady]);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
        const response = await fetch('/api/membership-tiers?active=true');
        if (response.ok) {
          const data = await response.json();
          const filteredTiers = data.filter((t: MembershipTier) => t.show_on_membership_page !== false && t.product_type === 'subscription');
          setTiers(filteredTiers);
        }
      } catch (error) {
        console.error('Failed to fetch membership tiers:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchTiers();
  }, []);

  const extractPrice = (priceString: string) => {
    const match = priceString.match(/\$[\d,]+/);
    return match ? match[0] : priceString;
  };

  const extractSuffix = (priceString: string) => {
    const match = priceString.match(/\/\w+/);
    return match ? match[0] : '/mo';
  };

  if (loading) {
    return (
      <div className="px-4 pt-4 pb-0 flex flex-col gap-8 bg-bone dark:bg-[#141414] min-h-screen overflow-x-hidden">
        <div className="text-center px-2 animate-pulse">
          <div className="h-8 bg-primary/10 dark:bg-white/10 rounded-lg w-48 mx-auto mb-3"></div>
          <div className="h-4 bg-primary/10 dark:bg-white/10 rounded w-64 mx-auto"></div>
        </div>
        <div className="space-y-5">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-64 bg-white/50 dark:bg-white/5 rounded-[2rem] animate-pulse"></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <AnimatedPage>
      <SEO
        title="Membership Plans & Pricing | Ever Club — Tustin, OC"
        description="Explore membership tiers at Ever Club in OC. Social, Core, Premium & Corporate plans with Trackman access, coworking, wellness & exclusive events."
        url="/membership"
        image="/images/hero-lounge-optimized.webp"
      />
    <div className="px-4 pt-4 pb-0 flex flex-col gap-8 bg-bone dark:bg-[#141414] min-h-screen overflow-x-hidden">
      <div className="text-center px-2 animate-content-enter">
        <p className="text-primary/40 dark:text-white/40 text-[10px] font-bold uppercase tracking-[0.3em] mb-2">Est. 2025</p>
        <h1 className="text-3xl font-medium tracking-tight text-primary dark:text-white mb-3">Your Office. Your Course. Your Club.</h1>
        <p className="text-primary/70 dark:text-white/70 text-base font-light leading-relaxed max-w-[320px] mx-auto">
          Select the membership that fits how you work, play, and connect.
        </p>
      </div>

      <Link to="compare" className="tactile-btn w-full flex items-center justify-center gap-1 text-xs font-bold uppercase tracking-widest text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white transition-colors py-2 animate-content-enter-delay-1">
        Compare full feature table
        <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
      </Link>

      <div className="text-center py-4 animate-content-enter-delay-1">
        <p className="text-sm text-primary/70 dark:text-white/70 font-light">
          Join <span className="font-semibold text-primary dark:text-white">200+ professionals</span> who chose Ever Club over country clubs, home simulators, and co-working spaces.
        </p>
      </div>

      <div className="flex flex-col gap-5 animate-content-enter-delay-2">
        {tiers.map((tier) => {
          const isCorporate = tier.slug === 'corporate';
          const suffix = isCorporate ? '/mo per employee' : extractSuffix(tier.price_string);
          const handleClick = () => {
            if (isCorporate) {
              startNavigation();
              navigate('corporate');
            } else {
              navigate('/membership/apply');
            }
          };
          const btnText = isCorporate ? 'View Details' : tier.button_text;

          if (tier.is_popular) {
            return (
              <div key={tier.id} className="relative flex flex-col p-6 backdrop-blur-xl bg-primary/90 rounded-[2rem] overflow-hidden text-white border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.2),0_0_20px_rgba(41,53,21,0.3),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
                <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl pointer-events-none"></div>
                <div className="flex justify-between items-start mb-4 relative z-10">
                  <div className="pr-2">
                    <h2 className="text-xl font-semibold mb-2">{tier.name} Membership</h2>
                    <p className="text-sm text-white/70 leading-relaxed font-light">{tier.description}</p>
                  </div>
                  <span className="shrink-0 px-3 py-1 bg-accent/90 backdrop-blur text-primary text-[10px] font-bold rounded-full uppercase tracking-wider shadow-sm border border-white/20 mt-1">
                    Popular
                  </span>
                </div>
                <div className="flex items-baseline gap-1 mb-6 relative z-10">
                  <span className="text-4xl font-semibold tracking-tight">{extractPrice(tier.price_string)}</span>
                  <span className="text-sm font-medium text-white/60">{suffix}</span>
                </div>
                <ul className="flex flex-col gap-3 mb-8 relative z-10">
                  {tier.highlighted_features.map((f, i) => (
                    <li key={i} className="flex gap-3 text-sm text-white/90 font-light">
                      <span className="material-symbols-outlined text-[18px] text-accent shrink-0 font-light">check_circle</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <button 
                  onClick={handleClick}
                  className="w-full relative z-10 py-4 px-6 rounded-2xl bg-white/95 backdrop-blur text-primary font-bold text-sm tracking-widest uppercase hover:bg-white transition-all duration-normal active:scale-[0.98] shadow-[0_4px_16px_rgba(0,0,0,0.2)]"
                >
                  {btnText}
                </button>
              </div>
            );
          } else {
            return (
              <MembershipCard
                key={tier.id}
                title={`${tier.name} Membership`}
                price={extractPrice(tier.price_string)}
                suffix={suffix}
                desc={tier.description}
                features={tier.highlighted_features}
                onClick={handleClick}
                btnText={btnText}
              />
            );
          }
        })}
      </div>

      <div className="text-center py-6 px-4 animate-content-enter-delay-3">
        <p className="text-xs text-primary/50 dark:text-white/50 uppercase tracking-[0.15em] font-medium mb-1">
          For perspective
        </p>
        <p className="text-sm text-primary/70 dark:text-white/70 font-light max-w-md mx-auto leading-relaxed">
          Traditional country club initiation fees start at $20,000+. A home simulator build-out runs $15,000–$25,000. Ever Club gives you Trackman technology, a premium workspace, and a curated community — starting at a fraction of the cost.
        </p>
      </div>
      
      <div className="bg-white/40 dark:bg-white/5 backdrop-blur-xl rounded-3xl p-6 border border-white/60 dark:border-white/10 shadow-sm dark:shadow-black/20 animate-content-enter-delay-3">
        <div className="text-center mb-8">
          <h3 className="text-2xl font-medium text-primary dark:text-white mb-2">How to Join</h3>
          <p className="text-primary/60 dark:text-white/60 text-sm font-light">Your path to membership in 3 simple steps</p>
        </div>
        
        <div className="flex flex-col md:flex-row items-center md:items-start justify-center gap-4 md:gap-2 relative">
          <div className="hidden md:block absolute top-8 left-[20%] right-[20%] h-[2px] border-t-2 border-dashed border-primary/20 dark:border-white/20"></div>
          
          <div className="flex flex-col items-center text-center relative z-10 flex-1 max-w-[200px]">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-white text-lg font-bold mb-3 shadow-lg dark:shadow-black/20">
              1
            </div>
            <div className="p-3 bg-white/50 dark:bg-white/5 rounded-xl mb-2">
              <span className="material-symbols-outlined text-primary dark:text-white text-2xl">edit_note</span>
            </div>
            <h4 className="font-semibold text-primary dark:text-white text-sm mb-1">Apply Online</h4>
            <p className="text-xs text-primary/60 dark:text-white/60 font-light leading-relaxed">Fill out a brief application form. Takes about 2 minutes.</p>
          </div>
          
          <div className="md:hidden w-px h-8 border-l-2 border-dashed border-primary/20 dark:border-white/20"></div>
          
          <div className="flex flex-col items-center text-center relative z-10 flex-1 max-w-[200px]">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-white text-lg font-bold mb-3 shadow-lg dark:shadow-black/20">
              2
            </div>
            <div className="p-3 bg-white/50 dark:bg-white/5 rounded-xl mb-2">
              <span className="material-symbols-outlined text-primary dark:text-white text-2xl">calendar_month</span>
            </div>
            <h4 className="font-semibold text-primary dark:text-white text-sm mb-1">Book a Tour</h4>
            <p className="text-xs text-primary/60 dark:text-white/60 font-light leading-relaxed">Visit the club and meet our team. We'll show you around.</p>
          </div>
          
          <div className="md:hidden w-px h-8 border-l-2 border-dashed border-primary/20 dark:border-white/20"></div>
          
          <div className="flex flex-col items-center text-center relative z-10 flex-1 max-w-[200px]">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-white text-lg font-bold mb-3 shadow-lg dark:shadow-black/20">
              3
            </div>
            <div className="p-3 bg-white/50 dark:bg-white/5 rounded-xl mb-2">
              <span className="material-symbols-outlined text-primary dark:text-white text-2xl">celebration</span>
            </div>
            <h4 className="font-semibold text-primary dark:text-white text-sm mb-1">Welcome Home</h4>
            <p className="text-xs text-primary/60 dark:text-white/60 font-light leading-relaxed">Get your membership card and start enjoying all the benefits.</p>
          </div>
        </div>
        
        <div className="mt-8 text-center">
          <button 
            onClick={() => navigate('/membership/apply')}
            className="tactile-btn px-8 py-4 rounded-2xl bg-primary text-white font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-normal active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]"
          >
            Apply Now — Limited Membership
          </button>
          <p className="text-xs text-primary/40 dark:text-white/40 mt-3 font-light">
            We cap membership to ensure availability. Once a tier fills, the waitlist opens.
          </p>
        </div>
      </div>

      <div className="bg-white/40 dark:bg-white/5 backdrop-blur-xl rounded-3xl p-5 border border-white/60 dark:border-white/10 shadow-sm dark:shadow-black/20 animate-content-enter-delay-4">
        <div className="flex items-center gap-3 mb-4">
           <div className="p-2 bg-primary/5 dark:bg-white/5 rounded-xl text-primary dark:text-white">
              <span className="material-symbols-outlined font-light">id_card</span>
           </div>
           <div>
              <h3 className="font-semibold text-lg text-primary dark:text-white">Day Passes</h3>
              <p className="text-xs text-primary/60 dark:text-white/60 font-medium">Experience the club for a day.</p>
           </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
           <button 
             onClick={() => setSelectedPass('workspace')}
             className={`flex flex-col gap-2 p-3 rounded-2xl border transition-all duration-fast text-left ${selectedPass === 'workspace' ? 'bg-primary text-white border-primary shadow-md dark:shadow-black/20' : 'bg-white/40 dark:bg-white/5 border-white/50 dark:border-white/10 hover:bg-white/60 dark:hover:bg-white/10 hover:scale-[1.02] text-primary dark:text-white'}`}
           >
              <span className={`material-symbols-outlined font-light ${selectedPass === 'workspace' ? 'text-white' : 'text-primary dark:text-white'}`}>work</span>
              <div>
                 <p className="font-semibold text-sm">Workspace</p>
                 <p className={`text-xs font-medium ${selectedPass === 'workspace' ? 'text-white/80' : 'text-primary/60 dark:text-white/60'}`}>${dayPassPrices['day-pass-coworking'] ?? 35} / day</p>
              </div>
           </button>
           <button 
             onClick={() => setSelectedPass('sim')}
             className={`flex flex-col gap-2 p-3 rounded-2xl border transition-all duration-fast text-left ${selectedPass === 'sim' ? 'bg-primary text-white border-primary shadow-md dark:shadow-black/20' : 'bg-white/40 dark:bg-white/5 border-white/50 dark:border-white/10 hover:bg-white/60 dark:hover:bg-white/10 hover:scale-[1.02] text-primary dark:text-white'}`}
           >
              <span className={`material-symbols-outlined font-light ${selectedPass === 'sim' ? 'text-white' : 'text-primary dark:text-white'}`}>sports_golf</span>
              <div>
                 <p className="font-semibold text-sm">Golf Sim</p>
                 <p className={`text-xs font-medium ${selectedPass === 'sim' ? 'text-white/80' : 'text-primary/60 dark:text-white/60'}`}>${dayPassPrices['day-pass-golf-sim'] ?? 50} / 60min</p>
              </div>
           </button>
        </div>
        <Link 
            to={selectedPass === 'workspace' ? '/checkout?type=day-pass-coworking' : '/checkout?type=day-pass-golf-sim'}
            className="tactile-btn w-full mt-4 py-3 text-sm font-semibold text-primary dark:text-white border-t border-primary/5 dark:border-white/10 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors rounded-b-xl tracking-wide uppercase block text-center"
        >
           Experience the Club
        </Link>
      </div>

      <Footer hideCta />
      
      <BackToTop threshold={200} />
    </div>
    </AnimatedPage>
  );
};

const MembershipCard: React.FC<any> = ({ title, price, suffix="/mo", desc, features, onClick, btnText="Apply" }) => (
  <div className="relative flex flex-col p-6 bg-white/50 dark:bg-white/5 backdrop-blur-xl rounded-[2rem] border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
    <div className="mb-4">
      <h2 className="text-xl font-semibold text-primary dark:text-white mb-2">{title}</h2>
      <p className="text-sm text-primary/70 dark:text-white/70 leading-relaxed font-light">{desc}</p>
    </div>
    <div className="flex items-baseline gap-1 mb-6">
      <span className="text-4xl font-semibold text-primary dark:text-white tracking-tight">{price}</span>
      <span className="text-sm font-medium text-primary/60 dark:text-white/60">{suffix}</span>
    </div>
    <ul className="flex flex-col gap-3 mb-8">
      {features.map((f: string, i: number) => (
        <li key={i} className="flex gap-3 text-sm text-primary/80 dark:text-white/80 font-light">
          <span className="material-symbols-outlined text-[18px] text-primary/60 dark:text-white/60 shrink-0 font-light">check_circle</span>
          <span className={i===0 && f.includes("Caf") ? "font-medium" : ""}>{f}</span>
        </li>
      ))}
    </ul>
    <button onClick={onClick} className="w-full py-4 px-6 rounded-2xl bg-primary text-white font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-normal active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]">
      {btnText}
    </button>
  </div>
);

const Corporate: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { getCorporatePrice, corporateTiers, corporateBasePrice, guestFeeDollars } = usePricing();
    const [employeeCount, setEmployeeCount] = useState(5);

    const getPricePerEmployee = (count: number): number => {
      return getCorporatePrice(count);
    };

    const getPricingTier = (count: number): string => {
      const sorted = [...corporateTiers].sort((a, b) => b.minMembers - a.minMembers);
      for (const t of sorted) {
        if (count >= t.minMembers) return `${t.minMembers}+ employees`;
      }
      return '1-4 employees';
    };

    useEffect(() => {
      setPageReady(true);
    }, [setPageReady]);

    return (
      <AnimatedPage>
      <div className="px-6 pt-6 pb-12 flex flex-col gap-6 bg-bone dark:bg-[#141414] min-h-screen">
        <div className="flex flex-col gap-2 mb-2 pt-4 animate-content-enter">
            <div className="flex items-center gap-2">
                <span className="px-4 py-1 bg-white/50 dark:bg-white/5 backdrop-blur text-primary dark:text-white text-[10px] font-bold rounded-full uppercase tracking-wider border border-primary/5 dark:border-white/10 shadow-sm dark:shadow-black/20">
                    For the team
                </span>
            </div>
            <h1 className="text-4xl font-medium tracking-tight text-primary dark:text-white leading-[1.1] mt-4">
                Corporate <br/>Membership
            </h1>
            <p className="text-primary/70 dark:text-white/70 text-base font-light leading-relaxed max-w-xs mt-2">
                A unified space for your team to connect, create, and grow together.
            </p>
        </div>

        <div className="bg-white/40 dark:bg-white/5 backdrop-blur-xl rounded-[2rem] p-8 shadow-sm dark:shadow-black/20 border border-white/60 dark:border-white/10 animate-content-enter-delay-1">
            <ul className="space-y-8">
                <li className="flex gap-4 items-center">
                    <div className="w-10 h-10 rounded-full bg-[#E8E8E0] dark:bg-white/5 flex items-center justify-center shrink-0">
                         <span className="material-symbols-outlined text-lg text-primary dark:text-white font-light">verified</span>
                    </div>
                    <div>
                        <h3 className="font-semibold text-primary dark:text-white text-lg leading-tight">Baseline Features</h3>
                    </div>
                </li>
                <li className="flex gap-4 items-start">
                    <div className="w-10 h-10 rounded-full bg-white dark:bg-[#1a1d15] border border-black/5 dark:border-white/10 flex items-center justify-center shrink-0 shadow-sm dark:shadow-black/20">
                         <span className="material-symbols-outlined text-lg text-primary dark:text-white font-light">diamond</span>
                    </div>
                    <div>
                        <h3 className="font-semibold text-primary dark:text-white text-lg leading-tight mb-2">Full Premium Experience</h3>
                        <p className="text-sm text-primary/60 dark:text-white/60 leading-relaxed font-light">Includes every benefit of the Premium tier: Private office priority, concierge, and exclusive dinner access.</p>
                        <span className="inline-block mt-3 px-3 py-1 bg-white/30 dark:bg-white/5 text-[10px] font-bold uppercase tracking-wider text-primary/60 dark:text-white/60 rounded border border-primary/5 dark:border-white/10">Excludes Drink Credit</span>
                    </div>
                </li>
                 <li className="flex gap-4 items-start">
                    <div className="w-10 h-10 rounded-full bg-white dark:bg-[#1a1d15] border border-black/5 dark:border-white/10 flex items-center justify-center shrink-0 shadow-sm dark:shadow-black/20">
                         <span className="material-symbols-outlined text-lg text-primary dark:text-white font-light">confirmation_number</span>
                    </div>
                    <div>
                        <h3 className="font-semibold text-primary dark:text-white text-lg leading-tight mb-2">15 Annual Guest Passes</h3>
                        <p className="text-sm text-primary/60 dark:text-white/60 leading-relaxed font-light">Bring clients or partners anytime. After 15 passes, guests are just ${guestFeeDollars}/visit.</p>
                    </div>
                </li>
            </ul>
        </div>

        <div className="mt-4 animate-content-enter-delay-2">
             <div className="flex justify-between items-center mb-6 px-2">
                <h2 className="text-2xl font-medium text-primary dark:text-white tracking-tight">Volume Discounts</h2>
                <span className="px-3 py-1 bg-white/50 dark:bg-white/5 rounded-full border border-primary/5 dark:border-white/10 text-[10px] font-bold text-primary/60 dark:text-white/60 uppercase tracking-wider">Per employee / mo</span>
             </div>
             
             <div className="bg-white/40 dark:bg-white/5 backdrop-blur-md rounded-[2rem] border border-white/60 dark:border-white/10 shadow-sm dark:shadow-black/20 overflow-hidden divide-y divide-primary/5 dark:divide-white/10">
                <DiscountRow count="1–4" price={`$${corporateBasePrice}`} icon="1+" isActive={employeeCount < 5} />
                {[...corporateTiers].sort((a, b) => a.minMembers - b.minMembers).map((t, i, arr) => {
                  const nextTier = arr[i + 1];
                  const label = nextTier ? `${t.minMembers}–${nextTier.minMembers - 1}` : `${t.minMembers}+`;
                  const isActive = nextTier
                    ? employeeCount >= t.minMembers && employeeCount < nextTier.minMembers
                    : employeeCount >= t.minMembers;
                  return (
                    <DiscountRow key={t.minMembers} count={label} price={`$${t.priceDollars}`} icon={`${t.minMembers}+`} isActive={isActive} />
                  );
                })}
             </div>

             <div className="bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-[2rem] border border-white/60 dark:border-white/10 shadow-sm dark:shadow-black/20 p-6 mt-6">
                <div className="flex flex-col gap-4">
                   <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-primary dark:text-white">Team Size</span>
                      <span className="text-lg font-bold text-primary dark:text-white">{employeeCount} employees</span>
                   </div>
                   <input
                      type="range"
                      min={5}
                      max={100}
                      step={1}
                      value={employeeCount}
                      onChange={(e) => setEmployeeCount(Number(e.target.value))}
                      className="w-full h-2 bg-primary/20 dark:bg-white/20 rounded-full appearance-none cursor-pointer accent-primary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0"
                   />
                   <div className="flex justify-between text-[10px] text-primary/50 dark:text-white/50 font-medium">
                      <span>5</span>
                      <span>100</span>
                   </div>
                </div>

                <div className="mt-6 pt-6 border-t border-primary/10 dark:border-white/10">
                   <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-primary/60 dark:text-white/60 uppercase tracking-wider">Current Tier</span>
                      <span className="px-3 py-1 bg-primary/10 dark:bg-white/10 rounded-full text-xs font-bold text-primary dark:text-white">{getPricingTier(employeeCount)}</span>
                   </div>
                   <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-medium text-primary/60 dark:text-white/60 uppercase tracking-wider">Price per Employee</span>
                      <span className="text-xl font-bold text-primary dark:text-white">${getPricePerEmployee(employeeCount)}<span className="text-sm font-medium text-primary/60 dark:text-white/60">/mo</span></span>
                   </div>
                   <div className="flex items-center justify-between p-4 bg-primary/5 dark:bg-white/5 rounded-2xl">
                      <span className="text-sm font-semibold text-primary dark:text-white">Estimated Monthly Total</span>
                      <span className="text-2xl font-bold text-primary dark:text-white">${(employeeCount * getPricePerEmployee(employeeCount)).toLocaleString()}</span>
                   </div>
                </div>
             </div>

             <p className="text-center text-[10px] text-primary/40 dark:text-white/40 mt-6 px-8 leading-relaxed max-w-xs mx-auto">
                 Prices listed are per employee, billed monthly. Minimum contract terms may apply.
             </p>
        </div>

        <Link to={`/checkout?tier=corporate&qty=${employeeCount}`} className="w-full py-5 px-6 rounded-2xl bg-primary text-white font-bold text-sm uppercase tracking-widest hover:bg-primary/90 shadow-xl shadow-primary/20 flex items-center justify-center gap-3 mt-4 mb-8 group animate-content-enter-delay-3">
            Join as Corporate
            <span className="material-symbols-outlined text-[20px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
        </Link>
      </div>
      </AnimatedPage>
    );
};

const DiscountRow: React.FC<{count: string; price: string; icon: string; isActive?: boolean}> = ({ count, price, icon, isActive }) => (
    <div className={`flex items-center justify-between p-5 transition-colors group ${isActive ? 'bg-primary/10 dark:bg-white/10' : 'hover:bg-white/40 dark:hover:bg-white/5'}`}>
        <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center shadow-sm dark:shadow-black/20 border group-hover:scale-105 transition-all duration-fast ${isActive ? 'bg-primary border-primary' : 'bg-white dark:bg-[#1a1d15] border-white dark:border-white/10'}`}>
                <span className={`text-xs font-bold ${isActive ? 'text-white' : 'text-primary/70 dark:text-white/70'}`}>{icon}</span>
            </div>
            <span className={`font-medium text-lg ${isActive ? 'text-primary dark:text-white font-semibold' : 'text-primary dark:text-white'}`}>{count} employees</span>
        </div>
        <span className={`font-semibold text-xl tracking-tight ${isActive ? 'text-primary dark:text-white' : 'text-primary dark:text-white'}`}>{price}</span>
    </div>
);

const CompareFeatures: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [tierFeatures, setTierFeatures] = useState<TierFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTiers, setSelectedTiers] = useState<string[]>(['Social', 'Core', 'Premium']);

  useEffect(() => {
    if (!loading) {
      setPageReady(true);
    }
  }, [loading, setPageReady]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tiersResponse, featuresResponse] = await Promise.all([
          fetch('/api/membership-tiers?active=true'),
          fetch('/api/tier-features')
        ]);

        if (tiersResponse.ok) {
          const data = await tiersResponse.json();
          const filteredTiers = data.filter((t: MembershipTier) => t.show_in_comparison !== false);
          setTiers(filteredTiers);
        }

        if (featuresResponse.ok) {
          const data = await featuresResponse.json();
          const activeFeatures = (data.features || []).filter((f: TierFeature) => f.isActive);
          setTierFeatures(activeFeatures);
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const toggleTier = (tier: string) => {
    if (selectedTiers.includes(tier)) {
        if (selectedTiers.length > 1) {
            setSelectedTiers(prev => prev.filter(t => t !== tier));
        }
    } else {
        if (selectedTiers.length < 3) {
            setSelectedTiers(prev => [...prev, tier]);
        }
    }
  };

  const tierNames = tiers.map(t => t.name);
  const tiersMap = Object.fromEntries(tiers.map(t => [t.name, t]));

  const extractPrice = (priceString: string) => {
    const match = priceString.match(/\$[\d,]+/);
    return match ? match[0] : priceString;
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 pt-6 px-4 pb-12 bg-bone dark:bg-[#141414] min-h-screen">
        <div className="text-center px-2 pt-4 animate-pulse">
          <div className="h-8 bg-primary/10 dark:bg-white/10 rounded-lg w-48 mx-auto mb-3"></div>
          <div className="h-4 bg-primary/10 dark:bg-white/10 rounded w-64 mx-auto"></div>
        </div>
        <div className="h-96 bg-white/50 dark:bg-white/5 rounded-3xl animate-pulse"></div>
      </div>
    );
  }

  return (
    <AnimatedPage>
    <div className="flex flex-col gap-6 pt-6 px-4 pb-12 bg-bone dark:bg-[#141414] min-h-screen">
       <div className="text-center px-2 pt-4 animate-content-enter">
        <h2 className="text-3xl font-medium tracking-tight text-primary dark:text-white mb-3">Compare Features</h2>
        <p className="text-primary/70 dark:text-white/70 text-base font-light leading-relaxed max-w-[320px] mx-auto">
          Select up to 3 memberships to compare side-by-side.
        </p>
      </div>
      
      <div className="bg-white/40 dark:bg-white/5 backdrop-blur-xl rounded-3xl p-4 shadow-sm dark:shadow-black/20 border border-white/60 dark:border-white/10 animate-content-enter-delay-1">
        <h3 className="text-xs font-bold text-primary/50 dark:text-white/50 mb-3 uppercase tracking-wider">Select to Compare (Max 3)</h3>
        <div className="flex flex-wrap gap-2">
          {tierNames.map(t => {
            const isSelected = selectedTiers.includes(t);
            return (
                <button 
                    key={t} 
                    onClick={() => toggleTier(t)}
                    disabled={!isSelected && selectedTiers.length >= 3}
                    className={`px-4 py-2 rounded-full text-xs font-bold border flex items-center gap-1 transition-all duration-fast ${isSelected ? 'bg-primary text-white border-primary shadow-sm dark:shadow-black/20' : 'bg-white/30 dark:bg-white/5 text-primary/60 dark:text-white/60 border-primary/10 dark:border-white/10 hover:border-primary/20 dark:hover:border-white/20'} ${!isSelected && selectedTiers.length >= 3 ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                    {isSelected && <span className="material-symbols-outlined text-[14px]">check</span>} {t}
                </button>
            )
          })}
        </div>
      </div>

      <div className="w-full bg-white/40 dark:bg-white/5 backdrop-blur-xl rounded-3xl p-4 shadow-sm dark:shadow-black/20 border border-white/60 dark:border-white/10 overflow-x-auto animate-content-enter-delay-2">
        <div className="min-w-[320px]">
          <div className="grid grid-cols-[25%_1fr_1fr_1fr] gap-1 mb-4 border-b border-primary/5 dark:border-white/10 pb-4 items-end">
             <div className="text-[10px] font-bold text-primary/40 dark:text-white/40 uppercase tracking-widest pl-1">Features</div>
             {selectedTiers.map((tier) => {
                const tierData = tiersMap[tier];
                if (!tierData) return null;
                return (
                  <div key={tier} className="text-center px-0.5">
                    {tierData.is_popular && <div className="inline-block bg-accent text-[8px] font-bold px-1.5 py-0.5 rounded-full text-primary mb-1 shadow-sm">POPULAR</div>}
                    <span className="text-xs md:text-sm font-bold block text-primary dark:text-white truncate">{tier}</span>
                    <span className="text-[10px] text-primary/60 dark:text-white/60 font-medium">{extractPrice(tierData.price_string)}</span>
                  </div>
                );
             })}
             {[...Array(3 - selectedTiers.length)].map((_, i) => <div key={i}></div>)}
          </div>
          
          {tierFeatures.map((feature) => {
              const renderValue = (tierData: MembershipTier) => {
                const tierId = tierData.id;
                const featureValue = feature.values[tierId];
                const value = featureValue?.value;

                if (feature.valueType === 'boolean') {
                  if (value === true) {
                    return <span className="material-symbols-outlined text-[18px] text-primary/80 dark:text-white/80">check_circle</span>;
                  }
                  return <span className="text-[10px] font-bold text-primary/20 dark:text-white/20">—</span>;
                }

                if (feature.valueType === 'number') {
                  if (value !== null && value !== undefined && value !== 0) {
                    return <span className="text-[10px] font-bold text-primary/80 dark:text-white/80 leading-tight">{value}</span>;
                  }
                  return <span className="text-[10px] font-bold text-primary/20 dark:text-white/20">—</span>;
                }

                if (feature.valueType === 'text') {
                  if (value && String(value).trim() !== '') {
                    return <span className="text-[10px] font-bold text-primary/80 dark:text-white/80 leading-tight">{value}</span>;
                  }
                  return <span className="text-[10px] font-bold text-primary/20 dark:text-white/20">—</span>;
                }

                return <span className="text-[10px] font-bold text-primary/20 dark:text-white/20">—</span>;
              };

              return (
                <div key={feature.id} className="grid grid-cols-[25%_1fr_1fr_1fr] gap-1 items-center py-3 border-b border-primary/5 dark:border-white/10 last:border-0">
                    <div className="text-[10px] font-bold text-primary/80 dark:text-white/80 pl-1 leading-tight">{feature.displayLabel}</div>
                    {selectedTiers.map(tier => {
                        const tierData = tiersMap[tier];
                        if (!tierData) return null;
                        
                        return (
                          <div key={`${tier}-${feature.id}`} className="flex justify-center text-center">
                              {renderValue(tierData)}
                          </div>
                        );
                    })}
                    {[...Array(3 - selectedTiers.length)].map((_, i) => <div key={i}></div>)}
                </div>
              );
          })}
        </div>
      </div>
    </div>
    </AnimatedPage>
  );
};

export default Membership;

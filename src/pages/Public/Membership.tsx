import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import HubSpotFormModal from '../../components/HubSpotFormModal';
import BackToTop from '../../components/BackToTop';
import { usePageReady } from '../../contexts/PageReadyContext';

const MEMBERSHIP_FIELDS = [
  { name: 'firstname', label: 'First Name', type: 'text' as const, required: true, placeholder: 'Jane' },
  { name: 'lastname', label: 'Last Name', type: 'text' as const, required: true, placeholder: 'Doe' },
  { name: 'email', label: 'Email', type: 'email' as const, required: true, placeholder: 'jane@example.com' },
  { name: 'phone', label: 'Phone', type: 'tel' as const, required: true, placeholder: '(949) 555-0100' },
  { name: 'membership_tier', label: 'Which tier are you interested in?', type: 'select' as const, required: false, options: ['Social', 'Core', 'Premium', 'Corporate', 'Not sure yet'] },
  { name: 'message', label: 'Tell us about yourself', type: 'textarea' as const, required: false, placeholder: 'Tell us about yourself and your interests...' }
];

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

interface FeatureConfig {
  label: string;
  getValue: (tier: MembershipTier) => { included: boolean; value: string };
}

const FEATURE_DISPLAY: FeatureConfig[] = [
  {
    label: 'Daily Golf Time',
    getValue: (t) => ({
      included: t.can_book_simulators && t.daily_sim_minutes > 0,
      value: t.unlimited_access ? 'Unlimited' : t.daily_sim_minutes > 0 ? `${t.daily_sim_minutes} min` : '—'
    })
  },
  {
    label: 'Guest Passes',
    getValue: (t) => ({
      included: t.guest_passes_per_month > 0,
      value: t.guest_passes_per_month > 12 ? 'Unlimited' : t.guest_passes_per_month > 0 ? `${t.guest_passes_per_month}/mo` : '—'
    })
  },
  {
    label: 'Booking Window',
    getValue: (t) => ({
      included: t.booking_window_days > 0,
      value: `${t.booking_window_days} days`
    })
  },
  {
    label: 'Cafe & Bar Access',
    getValue: () => ({ included: true, value: '✓' })
  },
  {
    label: 'Lounge Access',
    getValue: () => ({ included: true, value: '✓' })
  },
  {
    label: 'Work Desks',
    getValue: () => ({ included: true, value: '✓' })
  },
  {
    label: 'Golf Simulators',
    getValue: (t) => ({
      included: t.can_book_simulators,
      value: t.can_book_simulators ? '✓' : '—'
    })
  },
  {
    label: 'Putting Green',
    getValue: () => ({ included: true, value: '✓' })
  },
  {
    label: 'Member Events',
    getValue: () => ({ included: true, value: '✓' })
  },
  {
    label: 'Conference Room',
    getValue: (t) => ({
      included: t.can_book_conference && t.daily_conf_room_minutes > 0,
      value: t.daily_conf_room_minutes > 0 ? `${t.daily_conf_room_minutes} min` : '—'
    })
  },
  {
    label: 'Group Lessons',
    getValue: (t) => ({
      included: t.has_group_lessons,
      value: t.has_group_lessons ? '✓' : '—'
    })
  },
  {
    label: 'Extended Sessions',
    getValue: (t) => ({
      included: t.has_extended_sessions,
      value: t.has_extended_sessions ? '✓' : '—'
    })
  },
  {
    label: 'Private Lessons',
    getValue: (t) => ({
      included: t.has_private_lesson,
      value: t.has_private_lesson ? '✓' : '—'
    })
  },
  {
    label: 'Sim Guest Passes',
    getValue: (t) => ({
      included: t.has_simulator_guest_passes,
      value: t.has_simulator_guest_passes ? '✓' : '—'
    })
  },
  {
    label: 'Discounted Merch',
    getValue: (t) => ({
      included: t.has_discounted_merch,
      value: t.has_discounted_merch ? '✓' : '—'
    })
  }
];

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
  const { setPageReady } = usePageReady();
  const [selectedPass, setSelectedPass] = useState<'workspace' | 'sim' | null>(null);
  const [showApplicationForm, setShowApplicationForm] = useState(false);
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
          const filteredTiers = data.filter((t: MembershipTier) => t.show_in_comparison !== false);
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

  const socialTier = tiers.find(t => t.slug === 'social');
  const coreTier = tiers.find(t => t.slug === 'core');
  const premiumTier = tiers.find(t => t.slug === 'premium');
  const corporateTier = tiers.find(t => t.slug === 'corporate');

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
      <div className="px-4 pt-4 pb-0 flex flex-col gap-8 bg-[#F2F2EC] min-h-screen overflow-x-hidden">
        <div className="text-center px-2 animate-pulse">
          <div className="h-8 bg-primary/10 rounded-lg w-48 mx-auto mb-3"></div>
          <div className="h-4 bg-primary/10 rounded w-64 mx-auto"></div>
        </div>
        <div className="space-y-5">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-64 bg-white/50 rounded-[2rem] animate-pulse"></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 pb-0 flex flex-col gap-8 bg-[#F2F2EC] min-h-screen overflow-x-hidden">
      <div className="text-center px-2 animate-pop-in">
        <p className="text-primary/40 text-[10px] font-bold uppercase tracking-[0.3em] mb-2">Est. 2025</p>
        <h2 className="text-3xl font-medium tracking-tight text-primary mb-3">Membership Overview</h2>
        <p className="text-primary/70 text-base font-light leading-relaxed max-w-[320px] mx-auto">
          A space for connection and growth. Select the membership that fits your lifestyle.
        </p>
      </div>

      <Link to="compare" className="w-full flex items-center justify-center gap-1 text-xs font-bold uppercase tracking-widest text-primary/60 hover:text-primary transition-colors py-2 animate-pop-in" style={{animationDelay: '0.05s'}}>
        Compare full feature table
        <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
      </Link>

      <div className="flex flex-col gap-5 animate-pop-in" style={{animationDelay: '0.1s'}}>
        {socialTier && (
          <MembershipCard 
            title={`${socialTier.name} Membership`}
            price={extractPrice(socialTier.price_string)}
            suffix={extractSuffix(socialTier.price_string)}
            desc={socialTier.description}
            features={socialTier.highlighted_features}
            onClick={() => setShowApplicationForm(true)}
            btnText={socialTier.button_text}
          />
        )}
        
        {coreTier && (
          <div className="relative flex flex-col p-6 backdrop-blur-xl bg-primary/90 rounded-[2rem] overflow-hidden text-white border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.2),0_0_20px_rgba(41,53,21,0.3),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
            <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl pointer-events-none"></div>
            <div className="flex justify-between items-start mb-4 relative z-10">
              <div className="pr-2">
                <h3 className="text-xl font-semibold mb-2">{coreTier.name} Membership</h3>
                <p className="text-sm text-white/70 leading-relaxed font-light">{coreTier.description}</p>
              </div>
              {coreTier.is_popular && (
                <span className="shrink-0 px-3 py-1 bg-accent/90 backdrop-blur text-primary text-[10px] font-bold rounded-full uppercase tracking-wider shadow-sm border border-white/20 mt-1">
                  Popular
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-1 mb-6 relative z-10">
              <span className="text-4xl font-semibold tracking-tight">{extractPrice(coreTier.price_string)}</span>
              <span className="text-sm font-medium text-white/60">{extractSuffix(coreTier.price_string)}</span>
            </div>
            <ul className="flex flex-col gap-3 mb-8 relative z-10">
              {coreTier.highlighted_features.map((f, i) => (
                <li key={i} className="flex gap-3 text-sm text-white/90 font-light">
                  <span className="material-symbols-outlined text-[18px] text-accent shrink-0 font-light">check_circle</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <button 
              onClick={() => setShowApplicationForm(true)}
              className="w-full relative z-10 py-4 px-6 rounded-2xl bg-white/95 backdrop-blur text-primary font-bold text-sm tracking-widest uppercase hover:bg-white transition-all duration-300 active:scale-[0.98] shadow-[0_4px_16px_rgba(0,0,0,0.2)]"
            >
              {coreTier.button_text}
            </button>
          </div>
        )}
        
        {corporateTier && (
          <MembershipCard 
            title={`${corporateTier.name} Membership`}
            price={extractPrice(corporateTier.price_string)}
            suffix="/mo per employee"
            desc={corporateTier.description}
            features={corporateTier.highlighted_features}
            onClick={() => navigate('corporate')}
            btnText="View Details"
          />
        )}

        {premiumTier && (
          <MembershipCard 
            title={`${premiumTier.name} Membership`}
            price={extractPrice(premiumTier.price_string)}
            suffix={extractSuffix(premiumTier.price_string)}
            desc={premiumTier.description}
            features={premiumTier.highlighted_features}
            onClick={() => setShowApplicationForm(true)}
            btnText={premiumTier.button_text}
          />
        )}
      </div>
      
      <div className="bg-white/40 backdrop-blur-xl rounded-3xl p-6 border border-white/60 shadow-sm animate-pop-in" style={{animationDelay: '0.2s'}}>
        <div className="text-center mb-8">
          <h3 className="text-2xl font-medium text-primary mb-2">How to Join</h3>
          <p className="text-primary/60 text-sm font-light">Your path to membership in 3 simple steps</p>
        </div>
        
        <div className="flex flex-col md:flex-row items-center md:items-start justify-center gap-4 md:gap-2 relative">
          <div className="hidden md:block absolute top-8 left-[20%] right-[20%] h-[2px] border-t-2 border-dashed border-primary/20"></div>
          
          <div className="flex flex-col items-center text-center relative z-10 flex-1 max-w-[200px]">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-white text-lg font-bold mb-3 shadow-lg">
              1
            </div>
            <div className="p-3 bg-white/50 rounded-xl mb-2">
              <span className="material-symbols-outlined text-primary text-2xl">edit_note</span>
            </div>
            <h4 className="font-semibold text-primary text-sm mb-1">Apply Online</h4>
            <p className="text-xs text-primary/60 font-light leading-relaxed">Fill out a brief application form. Takes about 2 minutes.</p>
          </div>
          
          <div className="md:hidden w-px h-8 border-l-2 border-dashed border-primary/20"></div>
          
          <div className="flex flex-col items-center text-center relative z-10 flex-1 max-w-[200px]">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-white text-lg font-bold mb-3 shadow-lg">
              2
            </div>
            <div className="p-3 bg-white/50 rounded-xl mb-2">
              <span className="material-symbols-outlined text-primary text-2xl">calendar_month</span>
            </div>
            <h4 className="font-semibold text-primary text-sm mb-1">Book a Tour</h4>
            <p className="text-xs text-primary/60 font-light leading-relaxed">Visit the club and meet our team. We'll show you around.</p>
          </div>
          
          <div className="md:hidden w-px h-8 border-l-2 border-dashed border-primary/20"></div>
          
          <div className="flex flex-col items-center text-center relative z-10 flex-1 max-w-[200px]">
            <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-white text-lg font-bold mb-3 shadow-lg">
              3
            </div>
            <div className="p-3 bg-white/50 rounded-xl mb-2">
              <span className="material-symbols-outlined text-primary text-2xl">celebration</span>
            </div>
            <h4 className="font-semibold text-primary text-sm mb-1">Welcome Home</h4>
            <p className="text-xs text-primary/60 font-light leading-relaxed">Get your membership card and start enjoying all the benefits.</p>
          </div>
        </div>
        
        <div className="mt-8 text-center">
          <button 
            onClick={() => setShowApplicationForm(true)}
            className="px-8 py-4 rounded-2xl bg-primary text-white font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-300 active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]"
          >
            Start Your Application
          </button>
        </div>
      </div>

      <div className="bg-white/40 backdrop-blur-xl rounded-3xl p-5 border border-white/60 shadow-sm animate-pop-in" style={{animationDelay: '0.25s'}}>
        <div className="flex items-center gap-3 mb-4">
           <div className="p-2 bg-primary/5 rounded-xl text-primary">
              <span className="material-symbols-outlined font-light">id_card</span>
           </div>
           <div>
              <h3 className="font-semibold text-lg text-primary">Day Passes</h3>
              <p className="text-xs text-primary/60 font-medium">Experience the club for a day.</p>
           </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
           <button 
             onClick={() => setSelectedPass('workspace')}
             className={`flex flex-col gap-2 p-3 rounded-2xl border transition-all text-left ${selectedPass === 'workspace' ? 'bg-primary text-white border-primary shadow-md' : 'bg-white/40 border-white/50 hover:bg-white/60 hover:scale-[1.02] text-primary'}`}
           >
              <span className={`material-symbols-outlined font-light ${selectedPass === 'workspace' ? 'text-white' : 'text-primary'}`}>work</span>
              <div>
                 <p className="font-semibold text-sm">Workspace</p>
                 <p className={`text-xs font-medium ${selectedPass === 'workspace' ? 'text-white/80' : 'text-primary/60'}`}>$25 / day</p>
              </div>
           </button>
           <button 
             onClick={() => setSelectedPass('sim')}
             className={`flex flex-col gap-2 p-3 rounded-2xl border transition-all text-left ${selectedPass === 'sim' ? 'bg-primary text-white border-primary shadow-md' : 'bg-white/40 border-white/50 hover:bg-white/60 hover:scale-[1.02] text-primary'}`}
           >
              <span className={`material-symbols-outlined font-light ${selectedPass === 'sim' ? 'text-white' : 'text-primary'}`}>sports_golf</span>
              <div>
                 <p className="font-semibold text-sm">Golf Sim</p>
                 <p className={`text-xs font-medium ${selectedPass === 'sim' ? 'text-white/80' : 'text-primary/60'}`}>$50 / 60min</p>
              </div>
           </button>
        </div>
        <Link 
            to="/contact"
            className="w-full mt-4 py-3 text-sm font-semibold text-primary border-t border-primary/5 hover:bg-primary/5 transition-colors rounded-b-xl tracking-wide uppercase block text-center"
        >
           Request a Pass
        </Link>
      </div>

      <Footer hideCta />
      
      {/* Spacer for sticky mobile CTA */}
      <div className="h-24 md:hidden" aria-hidden="true"></div>

      <HubSpotFormModal
        isOpen={showApplicationForm}
        onClose={() => setShowApplicationForm(false)}
        formType="membership"
        title="Membership Application"
        subtitle="Join the Ever House community."
        fields={MEMBERSHIP_FIELDS}
        submitButtonText="Submit Application"
      />

      <BackToTop threshold={200} />

      {/* Sticky Mobile CTA - Green background bar with bone white button */}
      <div 
        className="fixed bottom-0 left-0 right-0 md:hidden bg-[#293515] px-4 pt-3 pb-4 border-t border-white/10"
        style={{ 
          zIndex: 50,
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))'
        }}
      >
        <button 
          onClick={() => setShowApplicationForm(true)}
          className="w-full max-w-md mx-auto py-4 px-6 rounded-2xl bg-[#F2F2EC] text-[#293515] font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity border border-[#F2F2EC]/80 shadow-[0_4px_16px_rgba(0,0,0,0.15)]"
        >
          Apply for Membership
          <span className="material-symbols-outlined text-lg">arrow_forward</span>
        </button>
      </div>
    </div>
  );
};

const MembershipCard: React.FC<any> = ({ title, price, suffix="/mo", desc, features, onClick, btnText="Apply" }) => (
  <div className="relative flex flex-col p-6 bg-white/50 backdrop-blur-xl rounded-[2rem] border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
    <div className="mb-4">
      <h3 className="text-xl font-semibold text-primary mb-2">{title}</h3>
      <p className="text-sm text-primary/70 leading-relaxed font-light">{desc}</p>
    </div>
    <div className="flex items-baseline gap-1 mb-6">
      <span className="text-4xl font-semibold text-primary tracking-tight">{price}</span>
      <span className="text-sm font-medium text-primary/60">{suffix}</span>
    </div>
    <ul className="flex flex-col gap-3 mb-8">
      {features.map((f: string, i: number) => (
        <li key={i} className="flex gap-3 text-sm text-primary/80 font-light">
          <span className="material-symbols-outlined text-[18px] text-primary/60 shrink-0 font-light">check_circle</span>
          <span className={i===0 && f.includes("Caf") ? "font-medium" : ""}>{f}</span>
        </li>
      ))}
    </ul>
    <button onClick={onClick} className="w-full py-4 px-6 rounded-2xl bg-primary text-white font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-300 active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]">
      {btnText}
    </button>
  </div>
);

const Corporate: React.FC = () => {
    const { setPageReady } = usePageReady();

    useEffect(() => {
      setPageReady(true);
    }, [setPageReady]);

    return (
      <div className="px-6 pt-6 pb-12 flex flex-col gap-6 bg-[#F2F2EC] min-h-screen">
        <div className="flex flex-col gap-2 mb-2 pt-4 animate-pop-in">
            <div className="flex items-center gap-2">
                <span className="px-4 py-1 bg-white/50 backdrop-blur text-primary text-[10px] font-bold rounded-full uppercase tracking-wider border border-primary/5 shadow-sm">
                    For the team
                </span>
            </div>
            <h1 className="text-4xl font-medium tracking-tight text-primary leading-[1.1] mt-4">
                Corporate <br/>Membership
            </h1>
            <p className="text-primary/70 text-base font-light leading-relaxed max-w-xs mt-2">
                A unified space for your team to connect, create, and grow together.
            </p>
        </div>

        <div className="bg-white/40 backdrop-blur-xl rounded-[2rem] p-8 shadow-sm border border-white/60 animate-pop-in" style={{animationDelay: '0.05s'}}>
            <ul className="space-y-8">
                <li className="flex gap-4 items-center">
                    <div className="w-10 h-10 rounded-full bg-[#E8E8E0] flex items-center justify-center shrink-0">
                         <span className="material-symbols-outlined text-lg text-primary font-light">verified</span>
                    </div>
                    <div>
                        <h3 className="font-semibold text-primary text-lg leading-tight">Baseline Features</h3>
                    </div>
                </li>
                <li className="flex gap-4 items-start">
                    <div className="w-10 h-10 rounded-full bg-white border border-black/5 flex items-center justify-center shrink-0 shadow-sm">
                         <span className="material-symbols-outlined text-lg text-primary font-light">diamond</span>
                    </div>
                    <div>
                        <h3 className="font-semibold text-primary text-lg leading-tight mb-2">Full Premium Experience</h3>
                        <p className="text-sm text-primary/60 leading-relaxed font-light">Includes every benefit of the Premium tier: Private office priority, concierge, and exclusive dinner access.</p>
                        <span className="inline-block mt-3 px-3 py-1 bg-white/30 text-[10px] font-bold uppercase tracking-wider text-primary/60 rounded border border-primary/5">Excludes Drink Credit</span>
                    </div>
                </li>
                 <li className="flex gap-4 items-start">
                    <div className="w-10 h-10 rounded-full bg-white border border-black/5 flex items-center justify-center shrink-0 shadow-sm">
                         <span className="material-symbols-outlined text-lg text-primary font-light">confirmation_number</span>
                    </div>
                    <div>
                        <h3 className="font-semibold text-primary text-lg leading-tight mb-2">15 Annual Guest Passes</h3>
                        <p className="text-sm text-primary/60 leading-relaxed font-light">Bring clients or partners anytime. After 15 passes, guests are just $25/visit.</p>
                    </div>
                </li>
            </ul>
        </div>

        <div className="mt-4 animate-pop-in" style={{animationDelay: '0.1s'}}>
             <div className="flex justify-between items-center mb-6 px-2">
                <h2 className="text-2xl font-medium text-primary tracking-tight">Volume Discounts</h2>
                <span className="px-3 py-1 bg-white/50 rounded-full border border-primary/5 text-[10px] font-bold text-primary/60 uppercase tracking-wider">Per employee / mo</span>
             </div>
             
             <div className="bg-white/40 backdrop-blur-md rounded-[2rem] border border-white/60 shadow-sm overflow-hidden divide-y divide-primary/5">
                <DiscountRow count="1–4" price="$350" icon="1+" />
                <DiscountRow count="5–9" price="$325" icon="5+" />
                <DiscountRow count="10–19" price="$299" icon="10+" />
                <DiscountRow count="20–49" price="$275" icon="20+" />
                <DiscountRow count="50+" price="$249" icon="50+" />
             </div>
             <p className="text-center text-[10px] text-primary/40 mt-6 px-8 leading-relaxed max-w-xs mx-auto">
                 Prices listed are per employee, billed monthly. Minimum contract terms may apply.
             </p>
        </div>

        <Link to="/contact" className="w-full py-5 px-6 rounded-2xl bg-primary text-white font-bold text-sm uppercase tracking-widest hover:bg-primary/90 shadow-xl shadow-primary/20 flex items-center justify-center gap-3 mt-4 mb-8 group animate-pop-in" style={{animationDelay: '0.15s'}}>
            Apply for Corporate Membership
            <span className="material-symbols-outlined text-[20px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
        </Link>
      </div>
    );
};

const DiscountRow: React.FC<{count: string; price: string; icon: string}> = ({ count, price, icon }) => (
    <div className="flex items-center justify-between p-5 hover:bg-white/40 transition-colors group">
        <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-sm border border-white group-hover:scale-105 transition-all">
                <span className="text-xs font-bold text-primary/70">{icon}</span>
            </div>
            <span className="font-medium text-primary text-lg">{count} employees</span>
        </div>
        <span className="font-semibold text-primary text-xl tracking-tight">{price}</span>
    </div>
);

const CompareFeatures: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTiers, setSelectedTiers] = useState<string[]>(['Social', 'Core', 'Premium']);

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
          const filteredTiers = data.filter((t: MembershipTier) => t.show_in_comparison !== false);
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
      <div className="flex flex-col gap-6 pt-6 px-4 pb-12 bg-[#F2F2EC] min-h-screen">
        <div className="text-center px-2 pt-4 animate-pulse">
          <div className="h-8 bg-primary/10 rounded-lg w-48 mx-auto mb-3"></div>
          <div className="h-4 bg-primary/10 rounded w-64 mx-auto"></div>
        </div>
        <div className="h-96 bg-white/50 rounded-3xl animate-pulse"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pt-6 px-4 pb-12 bg-[#F2F2EC] min-h-screen">
       <div className="text-center px-2 pt-4 animate-pop-in">
        <h2 className="text-3xl font-medium tracking-tight text-primary mb-3">Compare Features</h2>
        <p className="text-primary/70 text-base font-light leading-relaxed max-w-[320px] mx-auto">
          Select up to 3 memberships to compare side-by-side.
        </p>
      </div>
      
      <div className="bg-white/40 backdrop-blur-xl rounded-3xl p-4 shadow-sm border border-white/60 animate-pop-in" style={{animationDelay: '0.05s'}}>
        <h3 className="text-xs font-bold text-primary/50 mb-3 uppercase tracking-wider">Select to Compare (Max 3)</h3>
        <div className="flex flex-wrap gap-2">
          {tierNames.map(t => {
            const isSelected = selectedTiers.includes(t);
            return (
                <button 
                    key={t} 
                    onClick={() => toggleTier(t)}
                    disabled={!isSelected && selectedTiers.length >= 3}
                    className={`px-4 py-2 rounded-full text-xs font-bold border flex items-center gap-1 transition-all ${isSelected ? 'bg-primary text-white border-primary shadow-sm' : 'bg-white/30 text-primary/60 border-primary/10 hover:border-primary/20'} ${!isSelected && selectedTiers.length >= 3 ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                    {isSelected && <span className="material-symbols-outlined text-[14px]">check</span>} {t}
                </button>
            )
          })}
        </div>
      </div>

      <div className="w-full bg-white/40 backdrop-blur-xl rounded-3xl p-4 shadow-sm border border-white/60 overflow-x-auto animate-pop-in" style={{animationDelay: '0.1s'}}>
        <div className="min-w-[320px]">
          <div className="grid grid-cols-[25%_1fr_1fr_1fr] gap-1 mb-4 border-b border-primary/5 pb-4 items-end">
             <div className="text-[10px] font-bold text-primary/40 uppercase tracking-widest pl-1">Features</div>
             {selectedTiers.map((tier) => {
                const tierData = tiersMap[tier];
                if (!tierData) return null;
                return (
                  <div key={tier} className="text-center px-0.5">
                    {tierData.is_popular && <div className="inline-block bg-accent text-[8px] font-bold px-1.5 py-0.5 rounded-full text-primary mb-1 shadow-sm">POPULAR</div>}
                    <span className="text-xs md:text-sm font-bold block text-primary truncate">{tier}</span>
                    <span className="text-[10px] text-primary/60 font-medium">{extractPrice(tierData.price_string)}</span>
                  </div>
                );
             })}
             {[...Array(3 - selectedTiers.length)].map((_, i) => <div key={i}></div>)}
          </div>
          
          {FEATURE_DISPLAY.map((feature, idx) => {
              return (
                <div key={idx} className="grid grid-cols-[25%_1fr_1fr_1fr] gap-1 items-center py-3 border-b border-primary/5 last:border-0">
                    <div className="text-[10px] font-bold text-primary/80 pl-1 leading-tight">{feature.label}</div>
                    {selectedTiers.map(tier => {
                        const tierData = tiersMap[tier];
                        if (!tierData) return null;
                        const { included, value } = feature.getValue(tierData);
                        
                        return (
                          <div key={`${tier}-${idx}`} className="flex justify-center text-center">
                              {included ? (
                                  value === '✓' ? (
                                      <span className="material-symbols-outlined text-[18px] text-primary/80">check_circle</span>
                                  ) : (
                                      <span className="text-[10px] font-bold text-primary/80 leading-tight">{value}</span>
                                  )
                              ) : (
                                  <span className="text-[10px] font-bold text-primary/20">—</span>
                              )}
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
  );
};

export default Membership;

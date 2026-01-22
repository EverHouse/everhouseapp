import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import BackToTop from '../../components/BackToTop';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useParallax } from '../../hooks/useParallax';
import { playSound } from '../../utils/sounds';
import ModalShell from '../../components/ModalShell';
import EditorialSection from '../../components/layout/EditorialSection';
import { AnimatedPage } from '../../components/motion';

interface MembershipTier {
  id: number;
  name: string;
  slug: string;
  price_string: string;
  description: string;
  is_popular: boolean;
  highlighted_features: string[];
}


interface TourFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const HubSpotMeetingModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<'form' | 'calendar'>('form');
  const [formData, setFormData] = useState<TourFormData>({ firstName: '', lastName: '', email: '', phone: '' });
  const [tourId, setTourId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingConfirmed, setBookingConfirmed] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setStep('form');
      setFormData({ firstName: '', lastName: '', email: '', phone: '' });
      setTourId(null);
      setError(null);
      setBookingConfirmed(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (step === 'calendar' && containerRef.current && formData.email) {
      containerRef.current.innerHTML = '';
      const script = document.createElement('script');
      script.src = 'https://static.hsappstatic.net/MeetingsEmbed/ex/MeetingsEmbedCode.js';
      script.async = true;
      
      const params = new URLSearchParams({
        embed: 'true',
        firstname: formData.firstName,
        lastname: formData.lastName,
        email: formData.email,
        ...(formData.phone && { phone: formData.phone })
      });
      
      const meetingsDiv = document.createElement('div');
      meetingsDiv.className = 'meetings-iframe-container';
      meetingsDiv.setAttribute('data-src', `https://meetings-na2.hubspot.com/memberships/tourbooking?${params.toString()}`);
      
      containerRef.current.appendChild(meetingsDiv);
      containerRef.current.appendChild(script);
    }
  }, [step, formData]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.meetingBookSucceeded && tourId) {
        try {
          await fetch(`/api/tours/${tourId}/confirm`, { method: 'PATCH' });
          playSound('bookingConfirmed');
          setBookingConfirmed(true);
        } catch (err) {
          console.error('Failed to confirm tour:', err);
        }
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [tourId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    
    try {
      const res = await fetch('/api/tours/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit');
      }
      
      setTourId(data.id);
      setStep('calendar');
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  };

  const subtitle = step === 'form' ? 'Tell us a bit about yourself.' : bookingConfirmed ? 'Your tour is confirmed!' : 'Select a time that works for you.';

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Book a Tour" size="lg" className="bg-[#F2F2EC] dark:bg-[#1a1f12]" hideTitleBorder>
      <div className="px-6 pb-2">
        <p className="text-sm text-[#293515]/60 dark:text-white/60">{subtitle}</p>
      </div>
      
      {step === 'form' ? (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#293515]/70 dark:text-white/70 mb-1">First Name *</label>
                <input
                  type="text"
                  required
                  value={formData.firstName}
                  onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl bg-white/60 dark:bg-white/5 border border-[#293515]/10 dark:border-white/10 text-[#293515] dark:text-white placeholder-[#293515]/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#CCB8E4]/50"
                  placeholder="Jane"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#293515]/70 dark:text-white/70 mb-1">Last Name *</label>
                <input
                  type="text"
                  required
                  value={formData.lastName}
                  onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl bg-white/60 dark:bg-white/5 border border-[#293515]/10 dark:border-white/10 text-[#293515] dark:text-white placeholder-[#293515]/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#CCB8E4]/50"
                  placeholder="Doe"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#293515]/70 dark:text-white/70 mb-1">Email *</label>
              <input
                type="email"
                required
                value={formData.email}
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                className="w-full px-4 py-3 rounded-xl bg-white/60 dark:bg-white/5 border border-[#293515]/10 dark:border-white/10 text-[#293515] dark:text-white placeholder-[#293515]/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#CCB8E4]/50"
                placeholder="jane@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#293515]/70 dark:text-white/70 mb-1">Phone</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                className="w-full px-4 py-3 rounded-xl bg-white/60 dark:bg-white/5 border border-[#293515]/10 dark:border-white/10 text-[#293515] dark:text-white placeholder-[#293515]/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#CCB8E4]/50"
                placeholder="(949) 555-0100"
              />
            </div>
            
            {error && (
              <p className="text-red-500 text-sm text-center">{error}</p>
            )}
            
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-4 rounded-xl bg-[#293515] text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Submitting...
                </>
              ) : (
                <>
                  Continue to Select Time
                  <span className="material-symbols-outlined text-lg">arrow_forward</span>
                </>
              )}
            </button>
          </form>
        ) : bookingConfirmed ? (
          <div className="p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
            </div>
            <h3 className="text-xl font-bold text-[#293515] dark:text-white mb-2">Tour Confirmed!</h3>
            <p className="text-[#293515]/60 dark:text-white/60 mb-6">We've received your booking. You'll receive a confirmation email shortly.</p>
            <button
              onClick={onClose}
              className="px-8 py-3 rounded-xl bg-[#293515] text-white font-bold text-sm hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
      ) : (
        <div ref={containerRef} className="p-4 overflow-y-auto flex-1 min-h-[500px]"></div>
      )}
    </ModalShell>
  );
};

const Landing: React.FC = () => {
  const navigate = useNavigate();
  const { setPageReady } = usePageReady();
  const [showTourModal, setShowTourModal] = useState(false);
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showStickyMobileCta, setShowStickyMobileCta] = useState(false);
  const { offset: parallaxOffset, opacity: parallaxOpacity, gradientShift, ref: heroRef } = useParallax({ speed: 0.25, maxOffset: 120 });

  useEffect(() => {
    const handleScroll = () => {
      const heroHeight = window.innerHeight;
      setShowStickyMobileCta(window.scrollY > heroHeight * 0.8);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
        const response = await fetch('/api/membership-tiers?active=true');
        if (response.ok) {
          const data = await response.json();
          setTiers(data.filter((t: MembershipTier) => ['social', 'core', 'corporate'].includes(t.slug)));
        }
      } catch (error) {
        console.error('Failed to fetch tiers:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchTiers();
  }, []);

  const socialTier = tiers.find(t => t.slug === 'social');
  const coreTier = tiers.find(t => t.slug === 'core');
  const corporateTier = tiers.find(t => t.slug === 'corporate');

  const extractPrice = (priceString: string) => {
    const match = priceString?.match(/\$[\d,]+/);
    return match ? match[0] : '$—';
  };

  const extractSuffix = (priceString: string) => {
    const match = priceString?.match(/\/\w+/);
    return match ? match[0] : '/mo';
  };

  return (
    <AnimatedPage>
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-[#F2F2EC]">
      {/* Fixed brand green status bar fill for iOS PWA */}
      <div 
        className="fixed top-0 left-0 right-0 bg-[#293515]"
        style={{ height: 'env(safe-area-inset-top, 0px)', zIndex: 'var(--z-header)' }}
        aria-hidden="true"
      />
      
      {/* Hero Section - extends behind status bar */}
      <div 
        ref={heroRef as React.RefObject<HTMLDivElement>}
        className="relative flex flex-col justify-end p-6 pb-[max(4rem,env(safe-area-inset-bottom))] overflow-visible"
        style={{ 
          height: '100vh', 
          minHeight: '700px'
        }}
      >
        {/* Background container that extends into safe area */}
        <div 
          className="absolute inset-0 overflow-hidden rounded-b-[2.5rem]"
          style={{
            top: 'calc(-1 * env(safe-area-inset-top, 0px))',
            height: 'calc(100% + env(safe-area-inset-top, 0px))'
          }}
        >
          <img 
            src="/images/hero-lounge-optimized.webp" 
            alt="Ever House Lounge" 
            className="absolute inset-0 w-full h-[120%] object-cover object-[center_35%] will-change-transform"
            loading="eager"
            style={{ 
              transform: `translateY(${parallaxOffset}px) scale(1.05)`
            }}
          />
          <div 
            className="absolute inset-0 transition-opacity duration-300"
            style={{
              background: `linear-gradient(to top, rgba(0,0,0,${0.7 + gradientShift * 0.003}) 0%, rgba(0,0,0,${0.45 + gradientShift * 0.005}) 20%, rgba(0,0,0,0.2) 35%, rgba(0,0,0,0.08) 50%, transparent 60%)`
            }}
          />
        </div>
        
        {/* Hero content */}
        <div className="relative z-10 animate-pop-in flex flex-col items-center text-center">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05] mb-4 text-white text-shadow-sm font-serif">
            A new kind of <br/> members club — <br/> rooted in golf, built <br/> for community.
          </h1>
          <p className="text-sm sm:text-base text-white/80 mb-8 sm:mb-10 max-w-sm tracking-wide">
            Orange County's private indoor golf & social club.<br className="hidden sm:inline" /> Golf. Work. Connect.
          </p>
          <div className="flex flex-col gap-3 w-full max-w-xs">
             <Link to="/membership" className="w-full py-4 rounded-2xl bg-white/30 backdrop-blur-xl text-white font-bold text-xs uppercase tracking-[0.15em] shadow-lg hover:scale-[1.02] hover:bg-white/40 transition-all text-center border border-white/40">
                Apply for Membership
             </Link>
             <button onClick={() => setShowTourModal(true)} className="w-full py-3 text-white font-medium text-sm hover:opacity-80 transition-opacity flex items-center justify-center gap-2 group">
                Book a Tour
                <span className="material-symbols-outlined text-lg group-hover:translate-x-0.5 transition-transform">arrow_forward</span>
             </button>
          </div>
        </div>
      </div>

      {/* Content wrapper with cream background */}
      <div className="bg-[#F2F2EC]">
      {/* Features Section - "Why Even House" (Moved to First Position) */}
      <div className="px-6 py-12 animate-content-enter-delay-1">
        <h2 className="text-3xl font-bold text-[#293515] mb-8 font-sans">Why Ever House</h2>
        <div className="grid grid-cols-2 gap-4">
          <FeatureCard 
            image="/images/golf-sims-optimized.webp"
            icon="sports_golf"
            title="Golf all year"
            desc="4 TrackMan bays, putting course, private/group lessons"
            delay="0.1s"
          />
          <FeatureCard 
            image="/images/cowork-optimized.webp"
            icon="work"
            title="Work from the club"
            desc="Luxury work spaces, conference room, wifi, cafe"
            delay="0.2s"
          />
          <FeatureCard 
            image="/images/wellness-yoga-optimized.webp"
            icon="spa"
            title="Wellness & classes"
            desc="Med spa, fitness, yoga, recovery options"
            delay="0.3s"
          />
          <FeatureCard 
            image="/images/events-crowd-optimized.webp"
            icon="groups"
            title="Events & community"
            desc="Member events, watch parties, mixers"
            delay="0.4s"
          />
        </div>
      </div>

      {/* Editorial Sections */}
      <div>
        <EditorialSection
          image="/images/golf-sims-optimized.webp"
          title="Curated Events & Wellness"
          description="From intimate tastings to golf socials and wellness workshops, discover experiences designed to inspire and connect."
          ctaLabel="See What's On"
          ctaLink="/whats-on"
          reversed={false}
        />
        
        <EditorialSection
          image="/images/cafe-bar-optimized.webp"
          title="Farm-to-Table Cafe"
          description="Our chef-driven cafe serves thoughtfully crafted dishes and specialty coffee in a relaxed atmosphere. From morning espresso to afternoon bites, fuel your day with locally-sourced ingredients and a menu designed for both quick visits and lingering conversations."
          ctaLabel="View Menu"
          ctaLink="/cafe"
          reversed={true}
        />
        
        <EditorialSection
          image="/images/cowork-optimized.webp"
          title="Luxury Workspaces"
          description="Thoughtfully designed spaces where productivity meets comfort. High-speed wifi, private conference rooms, and an inspiring atmosphere."
          ctaLabel="View Gallery"
          ctaLink="/gallery"
          reversed={false}
        />
      </div>

      {/* Press & Media Section */}
      <div className="px-6 pt-6 pb-12 bg-[#F2F2EC] animate-content-enter-delay-2">
        <p className="text-center text-xs font-bold uppercase tracking-[0.2em] text-[#293515]/50 mb-8">As Featured In</p>
        
        {/* Quote Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
          {/* Forbes Quote */}
          <a 
            href="https://www.forbes.com/sites/mikedojc/2025/09/09/even-house-turns-indoor-golf-into-a-community-social-hub/" 
            target="_blank" 
            rel="noreferrer"
            className="backdrop-blur-xl bg-white/40 p-6 rounded-[1.5rem] border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:bg-white/60 hover:scale-[1.01] transition-all duration-300 flex flex-col"
          >
            <p className="text-xl font-bold text-[#293515]/80 tracking-tight mb-4" style={{ fontFamily: 'Georgia, serif' }}>Forbes</p>
            <blockquote className="text-sm text-[#293515]/80 leading-relaxed flex-1">
              "Ever House has fashioned a tribe-finding concept... creating a 'third place' around an indoor golf experience while layering in a farm-to-table café and flex space for co-working."
            </blockquote>
            <p className="text-xs text-[#293515]/50 font-medium mt-4">September 2025</p>
          </a>

          {/* Hypebeast Quote */}
          <a 
            href="https://hypebeast.com/2025/2/even-house-membership-golf-club-for-the-next-generation" 
            target="_blank" 
            rel="noreferrer"
            className="backdrop-blur-xl bg-white/40 p-6 rounded-[1.5rem] border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:bg-white/60 hover:scale-[1.01] transition-all duration-300 flex flex-col"
          >
            <p className="text-lg font-black text-[#293515]/80 uppercase tracking-tighter mb-4">Hypebeast</p>
            <blockquote className="text-sm text-[#293515]/80 leading-relaxed flex-1">
              "A laid-back yet high-end culture where people can connect and unwind... creating a place where people can come to recharge."
            </blockquote>
            <p className="text-xs text-[#293515]/50 font-medium mt-4">February 2025</p>
          </a>

          {/* Fox 11 Good Day LA Quote */}
          <a 
            href="https://www.foxla.com/video/fmc-t05loqz15hed9sfa" 
            target="_blank" 
            rel="noreferrer"
            className="backdrop-blur-xl bg-white/40 p-6 rounded-[1.5rem] border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:bg-white/60 hover:scale-[1.01] transition-all duration-300 flex flex-col"
          >
            <p className="text-lg font-black text-[#293515]/80 uppercase tracking-wide mb-4">Fox 11</p>
            <blockquote className="text-sm text-[#293515]/80 leading-relaxed flex-1">
              "It's all about having another place where you feel like you belong... the third space. We are missing out on third spaces."
            </blockquote>
            <p className="text-xs text-[#293515]/50 font-medium mt-4">December 2025</p>
          </a>
        </div>
      </div>

      {/* Membership Preview Section */}
      <div className="px-6 pb-12 bg-[#F2F2EC] animate-content-enter-delay-3">
         <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-[#293515] mb-2">Membership Tiers</h2>
            <p className="text-[#293515]/70 text-sm">Select the plan that fits your lifestyle.</p>
         </div>
         
         <div className="flex flex-col gap-4">
            {/* Social Tier */}
            {socialTier && (
            <div className="backdrop-blur-xl bg-white/50 p-6 rounded-[2rem] border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-xl font-bold text-[#293515]">{socialTier.name}</h3>
                    <span className="text-lg font-bold text-[#293515]">{extractPrice(socialTier.price_string)}<span className="text-xs font-medium opacity-60">{extractSuffix(socialTier.price_string)}</span></span>
                </div>
                <p className="text-sm text-[#293515]/70 mb-4">{socialTier.description}</p>
                <ul className="space-y-2 mb-6">
                    {(socialTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2 text-xs font-bold text-[#293515]/80"><span className="material-symbols-outlined text-sm">check</span> {feature}</li>
                    ))}
                </ul>
                <Link to="/membership" className="w-full py-3 rounded-xl bg-white/60 backdrop-blur border border-white/80 text-[#293515] font-bold text-xs hover:bg-white/80 transition-all duration-300 block text-center">View Details</Link>
            </div>
            )}

            {/* Core Tier - Featured/Popular */}
            {coreTier && (
            <div className="backdrop-blur-xl bg-[#293515]/90 p-6 rounded-[2rem] border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.2),0_0_20px_rgba(41,53,21,0.3),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms] relative overflow-hidden">
                <div className="flex justify-between items-start mb-2 relative z-10">
                    <div className="flex items-center gap-2">
                        <h3 className="text-xl font-bold text-white">{coreTier.name}</h3>
                        {coreTier.is_popular && <span className="bg-[#CCB8E4]/90 backdrop-blur text-[#293515] text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shadow-sm border border-white/20">Popular</span>}
                    </div>
                    <span className="text-lg font-bold text-white">{extractPrice(coreTier.price_string)}<span className="text-xs font-medium opacity-60">{extractSuffix(coreTier.price_string)}</span></span>
                </div>
                <p className="text-sm text-white/70 mb-4 relative z-10">{coreTier.description}</p>
                <ul className="space-y-2 mb-6 relative z-10">
                    {(coreTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2 text-xs font-bold text-white/90"><span className="material-symbols-outlined text-sm text-[#CCB8E4]">check</span> {feature}</li>
                    ))}
                </ul>
                <Link to="/membership" className="w-full py-3 rounded-xl bg-white/95 backdrop-blur text-[#293515] font-bold text-xs hover:bg-white transition-all duration-300 relative z-10 shadow-md block text-center">View Details</Link>
            </div>
            )}

            {/* Corporate Tier */}
            {corporateTier && (
            <div className="backdrop-blur-xl bg-white/50 p-6 rounded-[2rem] border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-xl font-bold text-[#293515]">{corporateTier.name}</h3>
                    <span className="text-lg font-bold text-[#293515]">{extractPrice(corporateTier.price_string)}<span className="text-xs font-medium opacity-60">{extractSuffix(corporateTier.price_string)}</span></span>
                </div>
                <p className="text-sm text-[#293515]/70 mb-4">{corporateTier.description}</p>
                <ul className="space-y-2 mb-6">
                    {(corporateTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2 text-xs font-bold text-[#293515]/80"><span className="material-symbols-outlined text-sm">check</span> {feature}</li>
                    ))}
                </ul>
                <Link to="/membership/corporate" className="w-full py-3 rounded-xl bg-white/60 backdrop-blur border border-white/80 text-[#293515] font-bold text-xs hover:bg-white/80 transition-all duration-300 block text-center">View Details</Link>
            </div>
            )}

            <Link to="/membership/compare" className="w-full mt-2 flex items-center justify-center gap-1 text-xs font-bold uppercase tracking-widest text-[#293515]/60 hover:text-[#293515] transition-colors py-2">
              Compare all tiers
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </Link>
         </div>
      </div>

      {/* Social Proof Stats Section */}
      <div className="px-6 py-10 bg-[#F2F2EC] animate-content-enter-delay-4">
        <h3 className="text-center text-2xl font-bold text-[#293515] mb-6">Join 200+ Members</h3>
        <div className="flex justify-center items-center gap-0 overflow-x-auto">
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-[#293515]">4</p>
            <p className="text-[10px] sm:text-xs text-[#293515]/70 uppercase tracking-wider font-medium">TrackMan Bays</p>
          </div>
          <div className="w-px h-8 bg-[#293515]/20 shrink-0"></div>
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-[#293515]">200+</p>
            <p className="text-[10px] sm:text-xs text-[#293515]/70 uppercase tracking-wider font-medium">Active Members</p>
          </div>
          <div className="w-px h-8 bg-[#293515]/20 shrink-0"></div>
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-[#293515]">5-Star</p>
            <p className="text-[10px] sm:text-xs text-[#293515]/70 uppercase tracking-wider font-medium">Rated</p>
          </div>
          <div className="w-px h-8 bg-[#293515]/20 shrink-0"></div>
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-[#293515]">Est. 2025</p>
            <p className="text-[10px] sm:text-xs text-[#293515]/70 uppercase tracking-wider font-medium">Founded</p>
          </div>
        </div>
      </div>

      {/* Testimonial Section */}
      <div className="px-6 py-12 bg-[#F2F2EC] animate-content-enter-delay-5">
        <div className="max-w-2xl mx-auto text-center">
          <span className="text-6xl text-[#293515]/20 font-serif leading-none block mb-2">"</span>
          <blockquote className="text-lg sm:text-xl italic text-[#293515]/90 mb-4 leading-relaxed -mt-8">
            Ever House has become my second office. The golf is incredible, but the community is what keeps me coming back.
          </blockquote>
          <p className="text-sm text-[#293515]/60 font-medium">— Michael R., Core Member</p>
        </div>
      </div>

      {/* Private Events Inquiry Section */}
      <div className="px-4 pb-12 animate-content-enter-delay-6">
         <div className="relative rounded-[2rem] overflow-hidden h-[400px] group backdrop-blur-xl border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.2),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.01] transition-all duration-[400ms]">
            <div className="absolute inset-0 bg-[url('/images/events-crowd-optimized.webp')] bg-cover bg-center opacity-70 transition-transform duration-700 group-hover:scale-105"></div>
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/40 to-black/20"></div>
            <div className="absolute inset-0 p-8 flex flex-col justify-center items-center text-center">
                <span className="px-4 py-1.5 bg-white/15 backdrop-blur-md border border-white/30 rounded-full text-white/90 text-xs font-bold uppercase tracking-[0.2em] mb-4 shadow-[0_0_12px_rgba(255,255,255,0.1)]">Host with Us</span>
                <h2 className="text-4xl font-bold text-white mb-6 leading-tight drop-shadow-lg">Private Events &<br/>Full Buyouts</h2>
                <Link to="/private-hire" className="px-8 py-3 bg-white/95 backdrop-blur text-[#293515] rounded-xl font-bold text-sm hover:scale-105 hover:bg-white transition-all duration-300 shadow-[0_8px_24px_rgba(0,0,0,0.2)] inline-block">
                    Inquire Now
                </Link>
            </div>
         </div>
      </div>
      </div>

      <Footer hideCta />

      <HubSpotMeetingModal isOpen={showTourModal} onClose={() => setShowTourModal(false)} />

      <BackToTop threshold={200} />

      {/* Sticky Mobile CTA */}
      <div 
        className={`fixed bottom-0 left-0 right-0 md:hidden transition-all duration-300 ${
          showStickyMobileCta 
            ? 'translate-y-0 opacity-100' 
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
        style={{ 
          zIndex: 'var(--z-sticky)',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))'
        }}
      >
        <div className="mx-4 mb-2 backdrop-blur-xl bg-white/80 border border-white/60 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.15),inset_0_1px_1px_rgba(255,255,255,0.6)] p-3">
          <Link 
            to="/membership" 
            className="w-full py-3 rounded-xl bg-[#293515] text-white font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
          >
            Apply for Membership
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
          </Link>
        </div>
      </div>
    </div>
    </AnimatedPage>
  );
};

const FeatureCard: React.FC<{image: string; icon: string; title: string; desc: string; delay: string}> = ({ image, icon, title, desc, delay }) => (
  <div 
    className="relative h-[240px] rounded-[2rem] overflow-hidden group animate-pop-in backdrop-blur-xl bg-black/20 border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.15),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]" 
    style={{animationDelay: delay}}
  >
     <div className="absolute inset-0 bg-cover bg-center opacity-60 transition-transform duration-700 group-hover:scale-110" style={{backgroundImage: `url('${image}')`}}></div>
     <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent"></div>
     <div className="absolute bottom-0 left-0 right-0 p-4">
        <div className="mb-2 w-10 h-10 rounded-xl bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center shadow-[0_0_12px_rgba(255,255,255,0.1)]">
            <span className="material-symbols-outlined text-white text-xl">{icon}</span>
        </div>
        <h3 className="font-bold text-white text-base leading-tight mb-1 drop-shadow-md">{title}</h3>
        <p className="text-[10px] text-white/80 leading-snug">{desc}</p>
     </div>
  </div>
);

export default Landing;
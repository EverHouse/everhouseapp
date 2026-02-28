import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import BackToTop from '../../components/BackToTop';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useData } from '../../contexts/DataContext';
import { useParallax } from '../../hooks/useParallax';
import EditorialShowcase from '../../components/layout/EditorialShowcase';
import { AnimatedPage } from '../../components/motion';
import SEO from '../../components/SEO';

interface MembershipTier {
  id: number;
  name: string;
  slug: string;
  price_string: string;
  description: string;
  is_popular: boolean;
  highlighted_features: string[];
}

const Landing: React.FC = () => {
  const navigate = useNavigate();
  const { setPageReady } = usePageReady();
  const { user, actualUser, isViewingAs, sessionChecked } = useData();
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { offset: parallaxOffset, opacity: parallaxOpacity, gradientShift, ref: heroRef } = useParallax({ speed: 0.25, maxOffset: 120 });

  useEffect(() => {
    if (!sessionChecked) return;
    if (user) {
      const staffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
      navigate((staffOrAdmin && !isViewingAs) ? '/admin' : '/dashboard', { replace: true });
    }
  }, [sessionChecked, user, actualUser, isViewingAs, navigate]);


  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  const fetchTiers = useCallback(async () => {
    if (user) return;
    try {
      const response = await fetch('/api/membership-tiers?active=true');
      if (response.ok) {
        const data = await response.json();
        setTiers(data.filter((t: MembershipTier) => ['social', 'core', 'corporate'].includes(t.slug)));
      }
    } catch (error: unknown) {
      console.error('Failed to fetch tiers:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchTiers();
  }, [fetchTiers]);

  useEffect(() => {
    const handler = () => { fetchTiers(); };
    window.addEventListener('app-refresh', handler);
    return () => window.removeEventListener('app-refresh', handler);
  }, [fetchTiers]);

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

  if (sessionChecked && user) {
    return <div className="min-h-screen" />;
  }

  return (
    <AnimatedPage>
      <SEO
        title="Ever Club | Indoor Golf & Social Club in Tustin, OC"
        description="Orange County's premier indoor golf & social club, formerly Even House. Trackman simulators, coworking, café & wellness in Tustin. Book a tour today."
        url="/"
        image="/images/hero-lounge-optimized.webp"
      />
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-bone dark:bg-[#141414]">
      <div 
        className="fixed top-0 left-0 right-0 bg-primary"
        style={{ height: 'env(safe-area-inset-top, 0px)', zIndex: 'var(--z-header)' }}
        aria-hidden="true"
      />
      
      <div 
        ref={heroRef as React.RefObject<HTMLDivElement>}
        className="relative flex flex-col justify-end p-6 pb-[max(4rem,env(safe-area-inset-bottom))] overflow-visible"
        style={{ 
          height: '100vh', 
          minHeight: '700px'
        }}
      >
        <div 
          className="absolute inset-0 overflow-hidden rounded-b-[2.5rem]"
          style={{
            top: 'calc(-1 * env(safe-area-inset-top, 0px))',
            height: 'calc(100% + env(safe-area-inset-top, 0px))'
          }}
        >
          <img 
            src="/images/hero-lounge-optimized.webp" 
            alt="Ever Members Club indoor lounge and social space in Tustin, Orange County" 
            className="absolute inset-0 w-full h-[120%] object-cover object-[center_35%] will-change-transform animate-hero-bg"
            loading="eager"
            fetchPriority="high"
            decoding="sync"
            style={{ 
              transform: `translateY(${parallaxOffset}px) scale(1.05)`
            }}
          />
          <div 
            className="absolute inset-0 transition-opacity duration-normal animate-hero-overlay"
            style={{
              background: `linear-gradient(to top, rgba(0,0,0,${0.7 + gradientShift * 0.003}) 0%, rgba(0,0,0,${0.45 + gradientShift * 0.005}) 20%, rgba(0,0,0,0.2) 35%, rgba(0,0,0,0.08) 50%, transparent 60%)`
            }}
          />
        </div>
        
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 via-black/20 to-transparent pointer-events-none z-[1]" />

        <div className="absolute left-6 bottom-12 md:left-12 md:bottom-20 z-10 max-w-xl animate-hero-headline">
          <div className="bg-white/10 backdrop-blur-xl border border-white/20 p-8 md:p-12 rounded-xl">
            <h1 className="mb-4 text-white text-shadow-sm">
              <span className="block text-4xl md:text-6xl font-light italic" style={{ fontFamily: 'var(--font-display)' }}>Your</span>
              <span className="block text-3xl md:text-5xl font-bold uppercase tracking-[0.25em] mt-1" style={{ fontFamily: 'var(--font-body)' }}>Office. Course. Club.</span>
            </h1>
            <p className="text-sm text-white/70 mb-2 max-w-sm leading-relaxed animate-hero-tagline" style={{ fontFamily: 'var(--font-body)' }}>
              Orange County's private club for professionals who work, play, and connect — all under one roof.
            </p>
            <p className="text-[10px] text-white/40 uppercase tracking-[0.3em] mb-6 animate-hero-tagline" style={{ fontFamily: 'var(--font-label)' }}>
              Formerly Even House · Tustin, CA
            </p>
            <div className="flex flex-wrap gap-4 animate-hero-cta">
              <Link
                to="/tour"
                className="border border-white/40 bg-transparent hover:bg-white/10 text-white px-6 py-3 uppercase tracking-[0.2em] text-[10px] font-medium transition-all"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                Private Tour
              </Link>
              <Link
                to="/membership"
                className="border border-white/40 bg-transparent hover:bg-white/10 text-white px-6 py-3 uppercase tracking-[0.2em] text-[10px] font-medium transition-all"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                Explore Membership
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-bone dark:bg-[#141414]">

      <div className="px-6 pt-6 pb-12 bg-bone dark:bg-[#141414] animate-content-enter-delay-1">
        <p className="text-center text-xs font-bold uppercase tracking-[0.2em] text-primary/50 dark:text-white/50 mb-8">As Featured In</p>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
          <a 
            href="https://www.forbes.com/sites/mikedojc/2025/09/09/even-house-turns-indoor-golf-into-a-community-social-hub/" 
            target="_blank" 
            rel="noreferrer"
            className="backdrop-blur-xl bg-white/40 dark:bg-white/5 p-6 rounded-xl border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:bg-white/60 dark:hover:bg-white/10 hover:scale-[1.01] transition-all duration-normal flex flex-col"
          >
            <p className="text-xl font-bold text-primary/80 dark:text-white/80 tracking-tight mb-4" style={{ fontFamily: 'Georgia, serif' }}>Forbes</p>
            <blockquote className="text-sm text-primary/80 dark:text-white/80 leading-relaxed flex-1">
              "Ever Club has fashioned a tribe-finding concept... creating a 'third place' around an indoor golf experience while layering in a farm-to-table café and flex space for co-working."
            </blockquote>
            <p className="text-xs text-primary/50 dark:text-white/50 font-medium mt-4">September 2025</p>
          </a>

          <a 
            href="https://hypebeast.com/2025/2/even-house-membership-golf-club-for-the-next-generation" 
            target="_blank" 
            rel="noreferrer"
            className="backdrop-blur-xl bg-white/40 dark:bg-white/5 p-6 rounded-xl border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:bg-white/60 dark:hover:bg-white/10 hover:scale-[1.01] transition-all duration-normal flex flex-col"
          >
            <p className="text-lg font-black text-primary/80 dark:text-white/80 uppercase tracking-tighter mb-4">Hypebeast</p>
            <blockquote className="text-sm text-primary/80 dark:text-white/80 leading-relaxed flex-1">
              "A laid-back yet high-end culture where people can connect and unwind... creating a place where people can come to recharge."
            </blockquote>
            <p className="text-xs text-primary/50 dark:text-white/50 font-medium mt-4">February 2025</p>
          </a>

          <a 
            href="https://www.foxla.com/video/fmc-t05loqz15hed9sfa" 
            target="_blank" 
            rel="noreferrer"
            className="backdrop-blur-xl bg-white/40 dark:bg-white/5 p-6 rounded-xl border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:bg-white/60 dark:hover:bg-white/10 hover:scale-[1.01] transition-all duration-normal flex flex-col"
          >
            <p className="text-lg font-black text-primary/80 dark:text-white/80 uppercase tracking-wide mb-4">Fox 11</p>
            <blockquote className="text-sm text-primary/80 dark:text-white/80 leading-relaxed flex-1">
              "It's all about having another place where you feel like you belong... the third space. We are missing out on third spaces."
            </blockquote>
            <p className="text-xs text-primary/50 dark:text-white/50 font-medium mt-4">December 2025</p>
          </a>
        </div>
      </div>

      <div>
        <EditorialShowcase
          overline="Tour-Level Technology"
          title={<>Trackman Golf <em style={{ fontStyle: 'italic' }}>Simulators</em></>}
          description="Four state-of-the-art Trackman 4 bays deliver tour-level ball and club data for year-round play. Practice your swing, take on 100+ championship courses, or host a competitive league night — rain or shine, no tee time required."
          image="/images/golf-sims-optimized.webp"
          imageAlt="Trackman golf simulator bay at Ever Club"
          ctaLabel="Book a Bay"
          ctaLink="/checkout?type=day-pass-golf-sim"
          reversed={true}
        />

        <EditorialShowcase
          overline="Curated Programming"
          title={<>Events & <em style={{ fontStyle: 'italic' }}>Wellness</em></>}
          description="From intimate wine tastings and chef-led dinners to golf socials and guided wellness workshops, our curated calendar is designed to spark connection and inspire something new every week."
          image="/images/private-dining-optimized.webp"
          imageAlt="Curated events and wellness programming at Ever Club"
          ctaLabel="Explore Events"
          ctaLink="/whats-on"
          reversed={false}
        />
        
        <EditorialShowcase
          overline="Chef-Driven Cafe"
          title={<>Farm-to-Table <em style={{ fontStyle: 'italic' }}>Dining</em></>}
          description="Thoughtfully crafted dishes and specialty coffee in a relaxed atmosphere. From morning espresso to afternoon bites, fuel your day with locally-sourced ingredients and a menu designed for both quick visits and lingering conversations."
          image="/images/cafe-bar-optimized.webp"
          imageAlt="Ever Club farm-to-table cafe and bar"
          ctaLabel="View Menu"
          ctaLink="/menu"
          reversed={true}
        />
        
        <EditorialShowcase
          overline="Designed for Focus"
          title={<>Luxury <em style={{ fontStyle: 'italic' }}>Workspaces</em></>}
          description="Thoughtfully appointed private offices, conference rooms, and open lounges with high-speed fiber, espresso on demand, and an atmosphere built for deep work and creative collaboration."
          image="/images/gallery/gallery-l1050509.webp"
          imageAlt="Luxury co-working spaces at Ever Club"
          ctaLabel="View Spaces"
          ctaLink="/gallery"
          reversed={false}
        />
      </div>

      <section className="px-6 pb-12 bg-bone dark:bg-[#141414] animate-content-enter-delay-3">
         <div className="text-center mb-8">
            <h2 className="text-2xl text-primary dark:text-white mb-2 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Membership Tiers</h2>
            <p className="text-base text-primary/70 dark:text-white/70 leading-relaxed" style={{ fontFamily: 'var(--font-body)' }}>Select the plan that fits your lifestyle.</p>
         </div>
         
         <div className="flex flex-col gap-4">
            {socialTier && (
            <div className="backdrop-blur-xl bg-white/50 dark:bg-white/5 p-6 rounded-xl border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-xl font-bold text-primary dark:text-white">{socialTier.name}</h3>
                    <span className="text-lg font-bold text-primary dark:text-white">{extractPrice(socialTier.price_string)}<span className="text-xs font-medium opacity-60">{extractSuffix(socialTier.price_string)}</span></span>
                </div>
                <p className="text-sm text-primary/70 dark:text-white/70 mb-4">{socialTier.description}</p>
                <ul className="space-y-2 mb-6">
                    {(socialTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2 text-xs font-bold text-primary/80 dark:text-white/80"><span className="material-symbols-outlined text-sm">check</span> {feature}</li>
                    ))}
                </ul>
                <Link to="/membership" className="tactile-btn w-full py-3 rounded-[4px] bg-white/60 dark:bg-white/10 backdrop-blur border border-white/80 text-primary dark:text-white font-bold text-xs hover:bg-white/80 transition-all duration-normal block text-center">View Details</Link>
            </div>
            )}

            {coreTier && (
            <div className="backdrop-blur-xl bg-primary/90 p-6 rounded-xl border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.2),0_0_20px_rgba(41,53,21,0.3),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms] relative overflow-hidden">
                <div className="flex justify-between items-start mb-2 relative z-10">
                    <div className="flex items-center gap-2">
                        <h3 className="text-xl font-bold text-white">{coreTier.name}</h3>
                        {coreTier.is_popular && <span className="bg-accent/90 backdrop-blur text-primary text-[10px] font-bold w-fit px-2 py-0.5 rounded-[4px] uppercase tracking-widest shadow-sm border border-white/20">Popular</span>}
                    </div>
                    <span className="text-lg font-bold text-white">{extractPrice(coreTier.price_string)}<span className="text-xs font-medium opacity-60">{extractSuffix(coreTier.price_string)}</span></span>
                </div>
                <p className="text-sm text-white/70 mb-4 relative z-10">{coreTier.description}</p>
                <ul className="space-y-2 mb-6 relative z-10">
                    {(coreTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2 text-xs font-bold text-white/90"><span className="material-symbols-outlined text-sm text-accent">check</span> {feature}</li>
                    ))}
                </ul>
                <Link to="/membership" className="tactile-btn w-full py-3 rounded-[4px] bg-white/95 dark:bg-white/10 backdrop-blur text-primary dark:text-white font-bold text-xs hover:bg-white transition-all duration-normal relative z-10 shadow-md block text-center">View Details</Link>
            </div>
            )}

            {corporateTier && (
            <div className="backdrop-blur-xl bg-white/50 dark:bg-white/5 p-6 rounded-xl border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms]">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-xl font-bold text-primary dark:text-white">{corporateTier.name}</h3>
                    <span className="text-lg font-bold text-primary dark:text-white">{extractPrice(corporateTier.price_string)}<span className="text-xs font-medium opacity-60">{extractSuffix(corporateTier.price_string)}</span></span>
                </div>
                <p className="text-sm text-primary/70 dark:text-white/70 mb-4">{corporateTier.description}</p>
                <ul className="space-y-2 mb-6">
                    {(corporateTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2 text-xs font-bold text-primary/80 dark:text-white/80"><span className="material-symbols-outlined text-sm">check</span> {feature}</li>
                    ))}
                </ul>
                <Link to="/membership/corporate" className="tactile-btn w-full py-3 rounded-[4px] bg-white/60 dark:bg-white/10 backdrop-blur border border-white/80 text-primary dark:text-white font-bold text-xs hover:bg-white/80 transition-all duration-normal block text-center">View Details</Link>
            </div>
            )}

            <Link to="/membership/compare" className="tactile-btn w-full mt-2 flex items-center justify-center gap-1 text-xs font-bold uppercase tracking-widest text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white transition-colors py-2">
              Compare all tiers
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </Link>
         </div>
      </section>

      <section className="px-6 py-10 bg-bone dark:bg-[#141414] animate-content-enter-delay-4">
        <h3 className="text-center text-2xl text-primary dark:text-white mb-6 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Join 200+ Members</h3>
        <div className="flex justify-center items-center gap-0 overflow-x-auto">
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-primary dark:text-white">4</p>
            <p className="text-[10px] sm:text-xs text-primary/70 dark:text-white/70 uppercase tracking-wider font-medium">TrackMan Bays</p>
          </div>
          <div className="w-px h-8 bg-primary/20 dark:bg-white/20 shrink-0"></div>
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-primary dark:text-white">200+</p>
            <p className="text-[10px] sm:text-xs text-primary/70 dark:text-white/70 uppercase tracking-wider font-medium">Active Members</p>
          </div>
          <div className="w-px h-8 bg-primary/20 dark:bg-white/20 shrink-0"></div>
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-primary dark:text-white">5-Star</p>
            <p className="text-[10px] sm:text-xs text-primary/70 dark:text-white/70 uppercase tracking-wider font-medium">Rated</p>
          </div>
          <div className="w-px h-8 bg-primary/20 dark:bg-white/20 shrink-0"></div>
          <div className="flex-1 min-w-0 text-center px-3">
            <p className="text-xl sm:text-2xl font-bold text-primary dark:text-white">Est. 2025</p>
            <p className="text-[10px] sm:text-xs text-primary/70 dark:text-white/70 uppercase tracking-wider font-medium">Founded</p>
          </div>
        </div>
      </section>

      <section className="px-6 py-12 bg-bone dark:bg-[#141414] animate-content-enter-delay-5">
        <div className="max-w-2xl mx-auto text-center">
          <span className="text-6xl text-primary/20 dark:text-white/20 leading-none block mb-2" style={{ fontFamily: 'var(--font-display)' }}>"</span>
          <blockquote className="text-lg sm:text-xl italic text-primary/90 dark:text-white/90 mb-4 leading-relaxed -mt-8">
            Ever Club has become my second office. The golf is incredible, but the community is what keeps me coming back.
          </blockquote>
          <p className="text-sm text-primary/60 dark:text-white/60 font-medium">— Michael R., Core Member</p>
        </div>
      </section>

      <div className="px-4 pb-12 animate-content-enter-delay-6">
         <div className="relative rounded-xl overflow-hidden h-[400px] group backdrop-blur-xl border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.2),inset_0_1px_1px_rgba(255,255,255,0.1)] hover:scale-[1.01] transition-all duration-[400ms]">
            <div className="absolute inset-0 bg-[url('/images/gallery/gallery-l1050555.webp')] bg-cover bg-center opacity-70 transition-transform duration-emphasis group-hover:scale-105"></div>
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/40 to-black/20"></div>
            <div className="absolute inset-0 p-8 flex flex-col justify-center items-center text-center">
                <span className="w-fit px-2 py-1.5 bg-white/15 backdrop-blur-md border border-white/30 rounded-[4px] text-white/90 text-xs font-bold uppercase tracking-widest mb-4 shadow-[0_0_12px_rgba(255,255,255,0.1)]">Host with Us</span>
                <h2 className="text-2xl text-white mb-6 leading-tight drop-shadow-lg" style={{ fontFamily: 'var(--font-headline)' }}>Private Events &<br/>Full Buyouts</h2>
                <Link to="/private-hire" className="px-8 py-3 bg-white/95 backdrop-blur text-primary rounded-[4px] font-bold text-sm hover:scale-105 hover:bg-white transition-all duration-normal shadow-[0_8px_24px_rgba(0,0,0,0.2)] inline-block">
                    Inquire Now
                </Link>
            </div>
         </div>
      </div>

      <section className="px-6 py-16 bg-bone dark:bg-[#141414]">
        <div className="max-w-md mx-auto text-center">
          <h2 className="text-2xl text-primary dark:text-white mb-3 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>See it for yourself.</h2>
          <p className="text-sm sm:text-base text-primary/60 dark:text-white/60 mb-8">Book a private tour and experience Ever Club firsthand.</p>
          <Link to="/tour" className="inline-block px-10 py-4 rounded-[4px] bg-primary text-white font-bold text-xs uppercase tracking-[0.15em] shadow-lg hover:scale-[1.02] hover:bg-primary/90 transition-all duration-fast">
            Book Your Private Tour
          </Link>
        </div>
      </section>

      </div>

      <Footer hideCta />


      <BackToTop threshold={200} />

    </div>
    </AnimatedPage>
  );
};

export default Landing;
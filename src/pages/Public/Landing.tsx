import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import BackToTop from '../../components/BackToTop';
import { usePageReady } from '../../stores/pageReadyStore';
import { useAuthData } from '../../contexts/DataContext';
import { useParallax } from '../../hooks/useParallax';
import EditorialShowcase from '../../components/layout/EditorialShowcase';
import { AnimatedPage } from '../../components/motion';
import SEO from '../../components/SEO';
import { fetchWithCredentials } from '../../hooks/queries/useFetch';
import Icon from '../../components/icons/Icon';
import { useScrollReveal } from '../../hooks/useScrollReveal';

interface MembershipTier {
  id: number;
  name: string;
  slug: string;
  price_string: string;
  description: string;
  is_popular: boolean;
  highlighted_features: string[];
}

const HERO_ANIM_KEY = 'ever_hero_played';

const Landing: React.FC = () => {
  const navigate = useNavigate();
  const { setPageReady } = usePageReady();
  const { user, actualUser, isViewingAs, sessionChecked } = useAuthData();
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const landingGradient = useMemo(() => ({
    base: [0.65, 0.35, 0.12, 0],
    multipliers: [0.002, 0.003, 0, 0],
    stops: ['0%', '25%', '45%', '65%'],
  }), []);
  const { ref: heroRef, imageRef: heroImageRef, overlayRef: heroOverlayRef } = useParallax({ speed: 0.15, maxOffset: 80, imageScale: 1.03, gradient: landingGradient });
  const scrollRef = useScrollReveal<HTMLDivElement>();
  const [heroAnimPlayed] = useState(() => {
    const played = sessionStorage.getItem(HERO_ANIM_KEY) === '1';
    if (!played) sessionStorage.setItem(HERO_ANIM_KEY, '1');
    return played;
  });

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
      const data = await fetchWithCredentials<MembershipTier[]>('/api/membership-tiers?active=true');
      setTiers(data.filter((t: MembershipTier) => ['social', 'core', 'corporate'].includes(t.slug)));
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
    return <div className="min-h-screen bg-bone dark:bg-[#141414]" />;
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
      
      {/* Hero Section — cinematic, no glassmorphic card */}
      <div 
        ref={heroRef as React.RefObject<HTMLDivElement>}
        className="relative flex flex-col justify-end overflow-visible h-dvh"
        style={{ 
          minHeight: '700px'
        }}
      >
        <div 
          className="absolute inset-0 overflow-hidden"
          style={{
            top: 'calc(-1 * env(safe-area-inset-top, 0px))',
            height: 'calc(100% + env(safe-area-inset-top, 0px))'
          }}
        >
          <img 
            ref={heroImageRef as React.RefObject<HTMLImageElement>}
            src="/images/hero-lounge-optimized.webp" 
            alt="Ever Members Club indoor lounge and social space in Tustin, Orange County" 
            className={`absolute inset-0 w-full h-[115%] object-cover object-[center_35%] will-change-transform ${heroAnimPlayed ? '' : 'animate-hero-bg'}`}
            loading="eager"
            fetchPriority="high"
            decoding="sync"
            width={1920}
            height={1080}
            style={{ 
              transform: 'translateY(0px) scale(1.03)'
            }}
          />
          <div 
            ref={heroOverlayRef as React.RefObject<HTMLDivElement>}
            className={`absolute inset-0 transition-opacity duration-normal ${heroAnimPlayed ? '' : 'animate-hero-overlay'}`}
            style={{
              background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.35) 25%, rgba(0,0,0,0.12) 45%, transparent 65%)'
            }}
          />
        </div>

        <div className={`relative z-10 px-6 md:px-16 pb-20 md:pb-28 max-w-2xl ${heroAnimPlayed ? '' : 'animate-hero-headline'}`}>
          <h1 className="mb-6 text-white">
            <span
              className="block text-5xl md:text-7xl font-normal italic leading-[1.05]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Your
            </span>
            <span
              className="block text-2xl md:text-3xl font-light uppercase tracking-[0.3em] mt-2 text-white/90"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              Office. Course. Club.
            </span>
          </h1>
          <p
            className={`text-sm text-white/60 mb-2 max-w-md leading-[1.8] font-light ${heroAnimPlayed ? '' : 'animate-hero-tagline'}`}
            style={{ fontFamily: 'var(--font-body)' }}
          >
            Orange County's private club for professionals who work, play, and connect — all under one roof.
          </p>
          <p
            className={`text-[10px] text-white/30 uppercase tracking-[0.3em] mb-10 ${heroAnimPlayed ? '' : 'animate-hero-tagline'}`}
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Formerly Even House · Tustin, CA
          </p>
          <div className={`flex flex-wrap gap-5 ${heroAnimPlayed ? '' : 'animate-hero-cta'}`}>
            <Link
              to="/tour"
              className="border border-white/60 bg-white text-primary px-8 py-3.5 uppercase tracking-[0.2em] text-[10px] font-medium transition-all duration-[600ms] hover:bg-white/90"
              style={{ fontFamily: 'var(--font-label)' }}
            >
              Book a Tour
            </Link>
            <Link
              to="/membership"
              className="border border-white/30 bg-transparent hover:border-white/60 text-white px-8 py-3.5 uppercase tracking-[0.2em] text-[10px] font-light transition-all duration-[600ms]"
              style={{ fontFamily: 'var(--font-label)' }}
            >
              Explore Membership
            </Link>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="scroll-reveal-group bg-bone dark:bg-[#141414]">

      {/* As Seen In — minimal horizontal strip */}
      <div className="scroll-reveal px-6 py-16 md:py-20 bg-bone dark:bg-[#141414]">
        <p
          className="text-center text-[10px] uppercase tracking-[0.35em] text-primary/30 dark:text-white/30 mb-10"
          style={{ fontFamily: 'var(--font-label)', fontWeight: 400 }}
        >
          As Seen In
        </p>
        
        <div className="flex flex-wrap items-center justify-center gap-10 md:gap-16 max-w-4xl mx-auto mb-12">
          <a
            href="https://www.forbes.com/sites/mikedojc/2025/09/09/even-house-turns-indoor-golf-into-a-community-social-hub/"
            target="_blank"
            rel="noreferrer"
            className="text-primary/40 dark:text-white/40 hover:text-primary/70 dark:hover:text-white/70 transition-opacity duration-[600ms]"
          >
            <span className="text-xl font-normal tracking-tight" style={{ fontFamily: 'Georgia, serif' }}>Forbes</span>
          </a>
          <a
            href="https://hypebeast.com/2025/2/even-house-membership-golf-club-for-the-next-generation"
            target="_blank"
            rel="noreferrer"
            className="text-primary/40 dark:text-white/40 hover:text-primary/70 dark:hover:text-white/70 transition-opacity duration-[600ms]"
          >
            <span className="text-lg font-bold uppercase tracking-tight">Hypebeast</span>
          </a>
          <a
            href="https://www.foxla.com/video/fmc-t05loqz15hed9sfa"
            target="_blank"
            rel="noreferrer"
            className="text-primary/40 dark:text-white/40 hover:text-primary/70 dark:hover:text-white/70 transition-opacity duration-[600ms]"
          >
            <span className="text-lg font-bold uppercase tracking-wider">Fox 11</span>
          </a>
        </div>

        <blockquote className="max-w-xl mx-auto text-center">
          <p
            className="text-sm text-primary/50 dark:text-white/50 leading-[1.9] italic"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            "Ever Club has fashioned a tribe-finding concept... creating a 'third place' around an indoor golf experience while layering in a farm-to-table café and flex space for co-working."
          </p>
          <cite
            className="block mt-4 text-[10px] uppercase tracking-[0.3em] text-primary/30 dark:text-white/30 not-italic"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Forbes
          </cite>
        </blockquote>
      </div>

      {/* Private Events — editorial spread */}
      <div className="scroll-reveal px-6 md:px-12 py-16 bg-bone dark:bg-[#141414]">
         <div
           className="relative overflow-hidden h-[450px] md:h-[500px] group max-w-5xl mx-auto cursor-pointer"
           onClick={() => navigate('/private-hire')}
           role="link"
           tabIndex={0}
           onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/private-hire'); }}
         >
            <div className="absolute inset-0 bg-[url('/images/gallery/gallery-l1050555.webp')] bg-cover bg-center transition-opacity duration-[1200ms] ease-out group-hover:opacity-90"></div>
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/25 to-transparent"></div>
            <div className="absolute inset-0 p-10 md:p-16 flex flex-col justify-end items-start text-left">
                <span
                  className="text-[10px] uppercase tracking-[0.35em] text-white/40 mb-4"
                  style={{ fontFamily: 'var(--font-label)', fontWeight: 300 }}
                >
                  Host with Us
                </span>
                <h2
                  className="text-3xl md:text-4xl text-white mb-6 leading-[1.1]"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  Private Events &<br/>Full Buyouts
                </h2>
                <Link
                  to="/private-hire/inquire"
                  className="px-8 py-3.5 border border-white/40 text-white text-[10px] uppercase tracking-[0.25em] font-light hover:border-white/70 transition-all duration-[600ms] inline-block"
                  style={{ fontFamily: 'var(--font-label)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  Inquire Now
                </Link>
            </div>
         </div>
      </div>

      {/* Editorial Showcases */}
      <div className="space-y-32 py-32 px-6 md:px-20 bg-bone dark:bg-[#141414]">
        <EditorialShowcase
          overline="Tour-Level Technology"
          title={<>Trackman Golf <em style={{ fontStyle: 'italic' }}>Simulators</em></>}
          description="Four state-of-the-art Trackman 4 bays deliver tour-level ball and club data for year-round play. Practice your swing, take on 100+ championship courses, or host a competitive league night — rain or shine, no tee time required."
          image="/images/golf-sims-optimized.webp"
          imageAlt="Trackman golf simulator bay at Ever Club"
          ctaLabel="Get a Day Pass"
          ctaLink="/checkout?type=day-pass-golf-sim"
          reversed={true}
        />

        <EditorialShowcase
          overline="Designed for Focus"
          title={<>Luxury <em style={{ fontStyle: 'italic' }}>Workspaces</em></>}
          description="Thoughtfully appointed private offices, conference rooms, and open lounges with high-speed fiber, espresso on demand, and an atmosphere built for deep work and creative collaboration."
          image="/images/gallery/gallery-l1050509.webp"
          imageAlt="Luxury co-working spaces at Ever Club"
          ctaLabel="Get a Day Pass"
          ctaLink="/checkout?type=day-pass-coworking"
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
          overline="Curated Programming"
          title={<>Events & <em style={{ fontStyle: 'italic' }}>Wellness</em></>}
          description="From intimate wine tastings and chef-led dinners to golf socials and guided wellness workshops, our curated calendar is designed to spark connection and inspire something new every week."
          image="/images/private-dining-optimized.webp"
          imageAlt="Curated events and wellness programming at Ever Club"
          ctaLabel="Explore Events"
          ctaLink="/whats-on"
          reversed={false}
        />
      </div>

      {/* Membership Tiers — typographic, no glassmorphism */}
      <section className="scroll-reveal px-6 py-24 bg-bone dark:bg-[#141414]">
         <div className="text-center mb-16">
            <p
              className="text-[10px] uppercase tracking-[0.35em] text-primary/30 dark:text-white/30 mb-4"
              style={{ fontFamily: 'var(--font-label)', fontWeight: 400 }}
            >
              Membership
            </p>
            <h2
              className="text-3xl md:text-4xl text-primary dark:text-white mb-4 leading-tight"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Find Your Tier
            </h2>
            <p
              className="text-sm text-primary/50 dark:text-white/50 leading-relaxed font-light max-w-md mx-auto"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              Select the plan that fits your lifestyle.
            </p>
         </div>
         
         <div className="grid grid-cols-1 lg:grid-cols-3 gap-px max-w-5xl mx-auto border border-primary/10 dark:border-white/10" style={{ minHeight: '420px' }}>
            {socialTier && (
            <div className="p-8 md:p-10 bg-bone dark:bg-[#1a1a1a] transition-colors duration-[600ms] hover:bg-white/60 dark:hover:bg-white/5">
                <div className="mb-6">
                    <h3
                      className="text-lg text-primary dark:text-white mb-1"
                      style={{ fontFamily: 'var(--font-display)' }}
                    >
                      {socialTier.name}
                    </h3>
                    <span className="text-2xl font-light text-primary dark:text-white" style={{ fontFamily: 'var(--font-display)' }}>
                      {extractPrice(socialTier.price_string)}
                      <span className="text-xs font-light text-primary/40 dark:text-white/40 ml-0.5">{extractSuffix(socialTier.price_string)}</span>
                    </span>
                </div>
                <p className="text-xs text-primary/50 dark:text-white/50 mb-6 leading-[1.8] font-light" style={{ fontFamily: 'var(--font-body)' }}>{socialTier.description}</p>
                <ul className="space-y-3 mb-8">
                    {(socialTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2.5 text-xs text-primary/60 dark:text-white/60 font-light">
                          <span className="text-primary/30 dark:text-white/30 text-[10px] mt-0.5">—</span> {feature}
                        </li>
                    ))}
                </ul>
                <Link
                  to="/membership"
                  className="block text-center py-3 text-[10px] uppercase tracking-[0.25em] font-normal text-primary/60 dark:text-white/60 border border-primary/15 dark:border-white/15 hover:border-primary/40 dark:hover:border-white/40 hover:text-primary dark:hover:text-white transition-all duration-[600ms]"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  View Details
                </Link>
            </div>
            )}

            {coreTier && (
            <div className="p-8 md:p-10 bg-[#f5f5ef] dark:bg-[#1e1e18] border-x border-primary/10 dark:border-white/10 transition-colors duration-[600ms] hover:bg-[#f0f0e8] dark:hover:bg-[#222218] relative">
                <div className="mb-6">
                    <div className="flex items-baseline gap-3">
                        <h3
                          className="text-lg text-primary dark:text-white"
                          style={{ fontFamily: 'var(--font-display)' }}
                        >
                          {coreTier.name}
                        </h3>
                        {coreTier.is_popular && (
                          <span
                            className="text-[9px] italic text-primary/40 dark:text-white/40"
                            style={{ fontFamily: 'var(--font-display)' }}
                          >
                            Most popular
                          </span>
                        )}
                    </div>
                    <span className="text-2xl font-light text-primary dark:text-white" style={{ fontFamily: 'var(--font-display)' }}>
                      {extractPrice(coreTier.price_string)}
                      <span className="text-xs font-light text-primary/40 dark:text-white/40 ml-0.5">{extractSuffix(coreTier.price_string)}</span>
                    </span>
                </div>
                <p className="text-xs text-primary/50 dark:text-white/50 mb-6 leading-[1.8] font-light" style={{ fontFamily: 'var(--font-body)' }}>{coreTier.description}</p>
                <ul className="space-y-3 mb-8">
                    {(coreTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2.5 text-xs text-primary/60 dark:text-white/60 font-light">
                          <span className="text-primary/30 dark:text-white/30 text-[10px] mt-0.5">—</span> {feature}
                        </li>
                    ))}
                </ul>
                <Link
                  to="/membership"
                  className="block text-center py-3 text-[10px] uppercase tracking-[0.25em] font-normal text-primary dark:text-white border border-primary/30 dark:border-white/30 hover:border-primary/60 dark:hover:border-white/60 transition-all duration-[600ms]"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  View Details
                </Link>
                <div className="absolute top-0 left-0 right-0 h-px bg-[#b8a44c]/40"></div>
            </div>
            )}

            {corporateTier && (
            <div className="p-8 md:p-10 bg-bone dark:bg-[#1a1a1a] transition-colors duration-[600ms] hover:bg-white/60 dark:hover:bg-white/5">
                <div className="mb-6">
                    <h3
                      className="text-lg text-primary dark:text-white mb-1"
                      style={{ fontFamily: 'var(--font-display)' }}
                    >
                      {corporateTier.name}
                    </h3>
                    <span className="text-2xl font-light text-primary dark:text-white" style={{ fontFamily: 'var(--font-display)' }}>
                      {extractPrice(corporateTier.price_string)}
                      <span className="text-xs font-light text-primary/40 dark:text-white/40 ml-0.5">{extractSuffix(corporateTier.price_string)}</span>
                    </span>
                </div>
                <p className="text-xs text-primary/50 dark:text-white/50 mb-6 leading-[1.8] font-light" style={{ fontFamily: 'var(--font-body)' }}>{corporateTier.description}</p>
                <ul className="space-y-3 mb-8">
                    {(corporateTier.highlighted_features || []).slice(0, 3).map((feature, idx) => (
                        <li key={idx} className="flex gap-2.5 text-xs text-primary/60 dark:text-white/60 font-light">
                          <span className="text-primary/30 dark:text-white/30 text-[10px] mt-0.5">—</span> {feature}
                        </li>
                    ))}
                </ul>
                <Link
                  to="/membership/corporate"
                  className="block text-center py-3 text-[10px] uppercase tracking-[0.25em] font-normal text-primary/60 dark:text-white/60 border border-primary/15 dark:border-white/15 hover:border-primary/40 dark:hover:border-white/40 hover:text-primary dark:hover:text-white transition-all duration-[600ms]"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  View Details
                </Link>
            </div>
            )}

         </div>

            <Link
              to="/membership/compare"
              className="w-full mt-8 flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.25em] text-primary/35 dark:text-white/35 hover:text-primary/60 dark:hover:text-white/60 transition-colors duration-[600ms] py-2 max-w-5xl mx-auto"
              style={{ fontFamily: 'var(--font-label)', fontWeight: 400 }}
            >
              Compare all tiers
              <Icon name="arrow_forward" className="text-[14px]" />
            </Link>
      </section>


      {/* Final CTA — calm invitation */}
      <section className="scroll-reveal px-6 py-28 md:py-36 bg-bone dark:bg-[#141414]">
        <div className="max-w-lg mx-auto text-center">
          <h2
            className="text-3xl md:text-4xl text-primary dark:text-white mb-5 leading-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            See it for yourself.
          </h2>
          <p
            className="text-sm text-primary/45 dark:text-white/45 mb-12 font-light leading-[1.8]"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            Book a private tour and experience Ever Club firsthand.
          </p>
          <Link
            to="/tour"
            className="inline-block px-12 py-4 border border-primary/30 dark:border-white/30 text-primary dark:text-white text-[10px] uppercase tracking-[0.25em] font-normal hover:border-primary dark:hover:border-white transition-all duration-[600ms]"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Book Your Private Tour
          </Link>
        </div>
      </section>

      </div>

      <Footer hideCta />


      <BackToTop />

    </div>
    </AnimatedPage>
  );
};

export default Landing;

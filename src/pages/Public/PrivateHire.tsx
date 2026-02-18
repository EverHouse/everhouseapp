import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import VirtualTour from '../../components/VirtualTour';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useParallax } from '../../hooks/useParallax';
import SEO from '../../components/SEO';

const PrivateHire: React.FC = () => {
  const { setPageReady } = usePageReady();
  const { offset: parallaxOffset, opacity: parallaxOpacity, gradientShift, ref: heroRef } = useParallax({ speed: 0.25, maxOffset: 120 });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  return (
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-bone dark:bg-[#141414]">
       <SEO title="Private Events & Venue Hire | Ever Club, Tustin" description="Host private events, corporate gatherings & celebrations at Ever Club in Tustin. Trackman simulator bays, conference rooms & event spaces in OC." url="/private-hire" />
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
             src="/images/venue-wide-optimized.webp" 
             alt="Private event venue with Trackman golf simulators at Ever Members Club in Orange County" 
             className="absolute inset-0 w-full h-[120%] object-cover object-[center_35%] will-change-transform animate-hero-bg"
             loading="eager"
             fetchPriority="high"
             style={{ 
               transform: `translateY(${parallaxOffset}px) scale(1.05)`,
               opacity: parallaxOpacity
             }}
           />
           <div 
             className="absolute inset-0 transition-opacity duration-normal animate-hero-overlay"
             style={{
               background: `linear-gradient(to top, rgba(0,0,0,${0.7 + gradientShift * 0.003}) 0%, rgba(0,0,0,${0.45 + gradientShift * 0.005}) 20%, rgba(0,0,0,0.2) 35%, rgba(0,0,0,0.08) 50%, transparent 60%)`
             }}
           />
         </div>
         
         <div className="relative z-10 flex flex-col items-center text-center">
           <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05] mb-4 text-white text-shadow-sm font-serif animate-hero-headline">
             Curated spaces for <br/> unforgettable moments.
           </h1>
           <p className="text-sm sm:text-base text-white/80 mb-4 sm:mb-5 max-w-md tracking-wide leading-relaxed animate-hero-tagline">
             From intimate dinners to grand receptions, discover the perfect setting for your next event at our Tustin location. Our team handles every detail so you can focus on your guests.
           </p>
           <p className="text-xs text-white/50 uppercase tracking-[0.2em] mb-8 sm:mb-10 animate-hero-tagline font-light">
             Private events for 10 to 600+ guests
           </p>
           <div className="flex flex-col gap-3 w-full max-w-xs animate-hero-cta">
             <Link 
               to="/private-hire/inquire"
               className="w-full py-4 rounded-2xl bg-white/30 backdrop-blur-xl text-white font-bold text-xs uppercase tracking-[0.15em] shadow-lg hover:scale-[1.02] hover:bg-white/40 transition-all duration-fast text-center border border-white/40"
             >
               Plan Your Event
             </Link>
           </div>
         </div>
       </div>

       <div className="bg-bone dark:bg-[#141414]">

       <section className="py-20 px-4 md:px-6 bg-bone dark:bg-[#141414]">
         <div className="max-w-7xl mx-auto">
           <div className="text-center mb-12 px-2">
             <h2 className="text-3xl md:text-4xl font-light text-primary dark:text-white mb-4 font-serif">
               Explore the Space
             </h2>
             <p className="text-primary/60 dark:text-white/60 max-w-2xl mx-auto">
               Take a virtual walk through our lounges, simulator bays, and terrace before you visit.
             </p>
           </div>
           <VirtualTour />
         </div>
       </section>

       <section className="py-20 px-4 md:px-6 bg-bone dark:bg-[#141414]">
         <div className="max-w-7xl mx-auto">
           <div className="text-center mb-12 px-2">
             <h2 className="text-3xl md:text-4xl font-light text-primary dark:text-white mb-4 font-serif">
               Tailored to Your Vision
             </h2>
             <p className="text-primary/60 dark:text-white/60 max-w-2xl mx-auto">
               From floorplan to final toast, every detail is crafted around your event.
             </p>
           </div>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
             {[
               { icon: 'dashboard_customize', title: 'Flexible Floorplans', desc: 'Our space adapts to your occasion with configurable layouts, furniture rentals, dance floor installations, and seamless room transitions.' },
               { icon: 'sports_golf', title: 'Golf Facilities & Programming', desc: 'Four TrackMan simulator bays and a custom 9-hole putting and chipping course create interactive experiences for all skill levels. From casual closest-to-the-pin and longest drive contests to fully structured 18-hole tournaments, complete with prizes to elevate the fun.' },
               { icon: 'palette', title: 'Custom Décor & Event Styling', desc: 'Personalized décor, lighting, florals, and branded touches designed to transform the space and bring your vision to life.' },
               { icon: 'music_note', title: 'Live Music & Entertainment', desc: 'From DJs and acoustic musicians to full live bands, we curate entertainment that fits the tone of your event and keeps energy flowing all night.' },
               { icon: 'restaurant', title: 'Custom Food Experiences', desc: "Tailored culinary offerings including passed hors d'oeuvres, buffet-style dining, plated meals, smoothie bars, and more\u2014designed for your guests and your flow." },
               { icon: 'local_bar', title: 'Custom Beverage Programs', desc: 'Choose from hosted or ticketed bars, craft cocktails, premium mocktails, and fully customized drink menus.' },
               { icon: 'speaker_group', title: 'Advanced Audio & Visual', desc: 'A 180" projection screen, wireless microphones, and a zoned overhead sound system support everything from presentations to live performances.' },
               { icon: 'local_parking', title: 'Abundant On-Site Parking', desc: 'Over 400 on-site parking spaces make arrival and departure effortless for guests of all sizes.' },
             ].map((feature, i) => (
               <div
                 key={feature.title}
                 className="flex flex-col p-6 bg-white/40 dark:bg-white/5 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-[2rem] shadow-[0_8px_32px_rgba(0,0,0,0.1),inset_0_1px_1px_rgba(255,255,255,0.6)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] animate-slide-up-stagger"
                 style={{ '--stagger-index': i } as React.CSSProperties}
               >
                 <span className="material-symbols-outlined text-3xl text-primary dark:text-white mb-3">{feature.icon}</span>
                 <h4 className="text-lg font-bold text-primary dark:text-white mb-2">{feature.title}</h4>
                 <p className="text-sm text-primary/60 dark:text-white/60 leading-relaxed">{feature.desc}</p>
               </div>
             ))}
           </div>
         </div>
       </section>

       <div className="px-4 pb-8 space-y-6">
          <div className="flex items-center justify-between px-2 pb-2 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
             <h3 className="text-lg font-bold text-primary dark:text-white">Available Spaces</h3>
             <span className="text-xs font-bold text-primary/50 dark:text-white/50 bg-[#E8E8E0] dark:bg-white/5 px-2 py-1 rounded uppercase tracking-widest">Select One</span>
          </div>
          
          <SpaceCard
            title="The Main Hall"
            cap="600 Max"
            img="/images/events-crowd-optimized.webp"
            tags={['AV System', 'Full Bar', 'Stage']}
            desc="Our signature space featuring vaulted ceilings, abundant natural light, and a dedicated stage area."
            index={0}
          />
          <SpaceCard
            title="The Private Dining Room"
            cap="30 Seated"
            img="/images/private-dining-optimized.webp"
            tags={['Private Service', 'Custom Menu']}
            desc="An exclusive enclave for business meetings or family gatherings, offering complete privacy."
            index={1}
          />
          <SpaceCard
            title="The Terrace"
            cap="60 Standing"
            img="/images/terrace-optimized.webp"
            tags={['Lush Setting', 'Cocktail Hours']}
            desc="Enjoy the California breeze in our lush outdoor setting, perfect for cocktail hours."
            index={2}
          />
       </div>

       </div>
       
       <Footer />
    </div>
  );
};

const SpaceCard: React.FC<{ title: string; cap: string; img: string; tags: string[]; desc: string; index?: number }> = ({ title, cap, img, tags, desc, index = 0 }) => (
  <div className="group relative flex flex-col rounded-[2rem] overflow-hidden backdrop-blur-xl bg-white/40 dark:bg-white/5 border border-white/60 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.1),inset_0_1px_1px_rgba(255,255,255,0.6)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms] animate-slide-up-stagger" style={{ '--stagger-index': index + 1 } as React.CSSProperties}>
     <div className="h-56 bg-cover bg-center relative" style={{backgroundImage: `url("${img}")`}}>
        <div className="absolute inset-0 bg-gradient-to-t from-white/40 dark:from-black/40 to-transparent"></div>
        <div className="absolute top-4 right-4 bg-black/30 backdrop-blur-md border border-white/30 px-3 py-1.5 rounded-full flex items-center gap-1 shadow-[0_0_12px_rgba(0,0,0,0.2)]">
           <span className="material-symbols-outlined text-sm text-white drop-shadow">groups</span>
           <span className="text-[10px] font-bold text-white uppercase drop-shadow">{cap}</span>
        </div>
     </div>
     <div className="p-5 bg-white/30 dark:bg-white/5 backdrop-blur-sm">
        <h4 className="text-xl font-bold text-primary dark:text-white mb-2">{title}</h4>
        <p className="text-sm text-primary/60 dark:text-white/60 mb-4 line-clamp-2 leading-relaxed">{desc}</p>
        <div className="flex flex-wrap gap-2">
           {tags.map((tag: string) => (
             <span key={tag} className="px-3 py-1 bg-white/60 dark:bg-white/10 backdrop-blur border border-white/80 dark:border-white/10 rounded-full text-[10px] font-bold uppercase tracking-wide text-primary dark:text-white shadow-sm dark:shadow-black/20">{tag}</span>
           ))}
        </div>
     </div>
  </div>
);

export default PrivateHire;

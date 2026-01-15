import React, { useState, useEffect, useRef } from 'react';
import { Footer } from '../../components/Footer';
import HubSpotFormModal from '../../components/HubSpotFormModal';
import VirtualTour from '../../components/VirtualTour';
import { triggerHaptic } from '../../utils/haptics';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useParallax } from '../../hooks/useParallax';

const PRIVATE_HIRE_FIELDS = [
  { name: 'firstname', label: 'First Name', type: 'text' as const, required: true, placeholder: 'Jane' },
  { name: 'lastname', label: 'Last Name', type: 'text' as const, required: true, placeholder: 'Doe' },
  { name: 'email', label: 'Email', type: 'email' as const, required: true, placeholder: 'jane@example.com' },
  { name: 'phone', label: 'Phone', type: 'tel' as const, required: false, placeholder: '(949) 555-0100' },
  { name: 'company', label: 'Company', type: 'text' as const, required: false, placeholder: 'Your company name' },
  { name: 'message', label: 'Event Details', type: 'textarea' as const, required: true, placeholder: 'Tell us about your event: date, guest count, type of event, special requests...' }
];

const PrivateHire: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [showInquiryForm, setShowInquiryForm] = useState(false);
  const { offset: parallaxOffset, opacity: parallaxOpacity, gradientShift, ref: heroRef } = useParallax({ speed: 0.25, maxOffset: 120 });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const openForm = () => {
    triggerHaptic('light');
    setShowInquiryForm(true);
  };

  return (
    <div className="min-h-screen pb-0 overflow-x-hidden relative bg-[#F2F2EC]">
       {/* Fixed brand green status bar fill for iOS PWA */}
       <div 
         className="fixed top-0 left-0 right-0 bg-[#293515]"
         style={{ height: 'env(safe-area-inset-top, 0px)', zIndex: 'var(--z-header)' }}
         aria-hidden="true"
       />
       
       {/* Hero Section - full viewport like Landing page */}
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
             src="/images/venue-wide-optimized.webp" 
             alt="Ever House Event Space" 
             className="absolute inset-0 w-full h-[120%] object-cover object-[center_35%] will-change-transform"
             loading="eager"
             style={{ 
               transform: `translateY(${parallaxOffset}px) scale(1.05)`,
               opacity: parallaxOpacity
             }}
           />
           <div 
             className="absolute inset-0 transition-opacity duration-300"
             style={{
               background: `linear-gradient(to top, rgba(0,0,0,${0.7 + gradientShift * 0.003}) 0%, rgba(0,0,0,${0.45 + gradientShift * 0.005}) 20%, rgba(0,0,0,0.2) 35%, rgba(0,0,0,0.08) 50%, transparent 60%)`
             }}
           />
         </div>
         
         {/* Hero content - centered like Landing page */}
         <div className="relative z-10 animate-pop-in flex flex-col items-center text-center">
           <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05] mb-4 text-white text-shadow-sm font-serif">
             Curated spaces for <br/> unforgettable moments.
           </h1>
           <p className="text-sm sm:text-base text-white/80 mb-8 sm:mb-10 max-w-md tracking-wide leading-relaxed">
             From intimate dinners to grand receptions, discover the perfect setting for your next event at our Tustin location. Our team handles every detail so you can focus on your guests.
           </p>
           <div className="flex flex-col gap-3 w-full max-w-xs">
             <button 
               onClick={openForm}
               className="w-full py-4 rounded-2xl bg-white/30 backdrop-blur-xl text-white font-bold text-xs uppercase tracking-[0.15em] shadow-lg hover:scale-[1.02] hover:bg-white/40 transition-all text-center border border-white/40"
             >
               Submit Inquiry
             </button>
           </div>
         </div>
       </div>

       {/* Content wrapper with cream background */}
       <div className="bg-[#F2F2EC]">

       <section className="py-20 px-4 md:px-6 bg-[#F2F2EC]">
         <div className="max-w-7xl mx-auto">
           <div className="text-center mb-12 px-2">
             <h2 className="text-3xl md:text-4xl font-light text-primary mb-4 font-serif">
               Explore the Space
             </h2>
             <p className="text-primary/60 max-w-2xl mx-auto">
               Take a virtual walk through our lounges, simulator bays, and terrace before you visit.
             </p>
           </div>
           <VirtualTour />
         </div>
       </section>

       <div className="px-4 pb-8 space-y-6">
          <div className="flex items-center justify-between px-2 pb-2 animate-pop-in" style={{animationDelay: '0.1s'}}>
             <h3 className="text-lg font-bold text-primary">Available Spaces</h3>
             <span className="text-xs font-bold text-primary/50 bg-[#E8E8E0] px-2 py-1 rounded uppercase tracking-widest">Select One</span>
          </div>
          
          <SpaceCard 
            title="The Main Hall"
            cap="150 Max"
            img="/images/events-crowd-optimized.webp"
            tags={['AV System', 'Full Bar', 'Stage']}
            desc="Our signature space featuring vaulted ceilings, abundant natural light, and a dedicated stage area."
            index={0}
          />
          <SpaceCard 
            title="The Private Dining Room"
            cap="20 Seated"
            img="/images/private-dining-optimized.webp"
            tags={['Private Service', 'Custom Menu']}
            desc="An exclusive enclave for business meetings or family gatherings, offering complete privacy."
            index={1}
          />
          <SpaceCard 
            title="The Terrace"
            cap="60 Standing"
            img="/images/terrace-optimized.webp"
            tags={['Outdoor Heating', 'Fire Pit']}
            desc="Enjoy the California breeze in our lush outdoor setting, perfect for cocktail hours."
            index={2}
          />
       </div>
       </div>
       
       <Footer />

       <HubSpotFormModal
         isOpen={showInquiryForm}
         onClose={() => setShowInquiryForm(false)}
         formType="private-hire"
         title="Private Event Inquiry"
         subtitle="Tell us about your event and we'll get back to you with availability."
         fields={PRIVATE_HIRE_FIELDS}
         submitButtonText="Submit Inquiry"
       />
    </div>
  );
};

const SpaceCard: React.FC<any> = ({ title, cap, img, tags, desc, index = 0 }) => (
  <div className="group relative flex flex-col rounded-[2rem] overflow-hidden backdrop-blur-xl bg-white/40 border border-white/60 shadow-[0_8px_32px_rgba(0,0,0,0.1),inset_0_1px_1px_rgba(255,255,255,0.6)] hover:scale-[1.02] hover:-translate-y-1 transition-all duration-[400ms] animate-pop-in" style={{animationDelay: `${0.15 + index * 0.08}s`}}>
     <div className="h-56 bg-cover bg-center relative" style={{backgroundImage: `url("${img}")`}}>
        <div className="absolute inset-0 bg-gradient-to-t from-white/40 to-transparent"></div>
        <div className="absolute top-4 right-4 bg-black/30 backdrop-blur-md border border-white/30 px-3 py-1.5 rounded-full flex items-center gap-1 shadow-[0_0_12px_rgba(0,0,0,0.2)]">
           <span className="material-symbols-outlined text-sm text-white drop-shadow">groups</span>
           <span className="text-[10px] font-bold text-white uppercase drop-shadow">{cap}</span>
        </div>
     </div>
     <div className="p-5 bg-white/30 backdrop-blur-sm">
        <h4 className="text-xl font-bold text-primary mb-2">{title}</h4>
        <p className="text-sm text-primary/60 mb-4 line-clamp-2 leading-relaxed">{desc}</p>
        <div className="flex flex-wrap gap-2">
           {tags.map((tag: string) => (
             <span key={tag} className="px-3 py-1 bg-white/60 backdrop-blur border border-white/80 rounded-full text-[10px] font-bold uppercase tracking-wide text-primary shadow-sm">{tag}</span>
           ))}
        </div>
     </div>
  </div>
);

export default PrivateHire;
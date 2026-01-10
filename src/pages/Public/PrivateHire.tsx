import React, { useState, useEffect, useRef } from 'react';
import { Footer } from '../../components/Footer';
import HubSpotFormModal from '../../components/HubSpotFormModal';
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
  const { offset: parallaxOffset, opacity: parallaxOpacity, gradientShift, ref: heroRef } = useParallax({ speed: 0.2, maxOffset: 80 });

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  const openForm = () => {
    triggerHaptic('light');
    setShowInquiryForm(true);
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#F2F2EC] overflow-x-hidden">
       <div 
         ref={heroRef as React.RefObject<HTMLDivElement>}
         className="relative w-full h-[420px] bg-primary flex flex-col justify-end overflow-hidden group rounded-b-[2rem]"
       >
         <div 
           className="absolute inset-0 h-[120%] bg-cover bg-center will-change-transform" 
           style={{
             backgroundImage: 'url("/images/venue-wide-optimized.webp")',
             transform: `translateY(${parallaxOffset}px) scale(1.05)`,
             opacity: parallaxOpacity
           }}
         ></div>
         <div 
           className="absolute inset-0 transition-opacity duration-300"
           style={{
             background: `linear-gradient(to top, rgba(41,53,21,${0.9 + gradientShift * 0.005}) 0%, rgba(41,53,21,${0.3 + gradientShift * 0.02}) ${35 + gradientShift}%, transparent 100%)`
           }}
         ></div>
         <div className="relative z-10 p-6 pb-12">
            <p className="text-white/60 text-[10px] font-bold uppercase tracking-[0.3em] mb-3">Est. 2025</p>
            <span className="inline-block px-3 py-1 mb-3 text-[10px] font-bold tracking-widest text-white uppercase bg-white/20 backdrop-blur-sm rounded-full border border-white/10">Events</span>
            <h2 className="text-white text-5xl font-bold leading-tight tracking-tight">Host at <br/>Ever House</h2>
         </div>
       </div>

       <div className="px-6 py-10 animate-pop-in">
          <h2 className="text-2xl font-bold leading-snug text-primary mb-4">Curated spaces for unforgettable moments.</h2>
          <p className="text-base font-medium leading-relaxed text-primary/70">From intimate dinners to grand receptions, discover the perfect setting for your next event at our Tustin location. Our team handles every detail so you can focus on your guests.</p>
       </div>

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

       <div className="mt-4 bg-white rounded-[2.5rem] shadow-[0_-4px_20px_rgba(0,0,0,0.03)] overflow-hidden mx-4 mb-6 animate-pop-in" style={{animationDelay: '0.35s'}}>
          <div className="px-6 py-8 flex flex-col items-center text-center">
             <div className="p-3 bg-[#F2F2EC] rounded-xl mb-4">
                <span className="material-symbols-outlined text-primary text-3xl">calendar_today</span>
             </div>
             <h3 className="text-2xl font-bold text-primary mb-3">Start your Inquiry</h3>
             <p className="text-primary/70 mb-8 max-w-xs mx-auto text-sm leading-relaxed">
               Tell us a bit about your event and our team will get back to you with availability and pricing.
             </p>
             <button 
                onClick={openForm}
                className="w-full bg-primary hover:bg-primary/90 text-white font-bold text-lg py-4 rounded-xl shadow-lg shadow-primary/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
             >
                Submit Inquiry
             </button>
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
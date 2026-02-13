import React from 'react';
import { Link } from 'react-router-dom';
import Logo from './Logo';
import { APP_VERSION, formatLastUpdated } from '../config/version';

interface FooterProps {
  hideCta?: boolean;
}

export const Footer: React.FC<FooterProps> = ({ hideCta = false }) => (
  <footer className="bg-[#293515] text-[#E7E7DC] pt-16 pb-16 px-6 text-center rounded-t-[2.5rem] mt-8 -mx-4 sm:-mx-6 w-[calc(100%+2rem)] sm:w-[calc(100%+3rem)]">
     <div className="flex justify-center mb-8">
       <Logo type="mascot" variant="white" className="h-16 w-auto" />
     </div>
     
     <div className="space-y-6 text-sm font-medium mb-10 flex flex-col items-center">
        <div className="relative flex flex-col items-center">
            <span className="material-symbols-outlined text-lg absolute -left-8 top-0.5 text-[#E7E7DC]/70">location_on</span>
            <p className="text-[#E7E7DC]">15771 Red Hill Ave, Ste 500</p>
            <p className="text-[#E7E7DC]/70 text-xs">Tustin, CA 92780</p>
        </div>

        <div className="relative flex items-center">
            <span className="material-symbols-outlined text-lg absolute -left-8 text-[#E7E7DC]/70">call</span>
            <a href="tel:9495455855" className="hover:underline">(949) 545-5855</a>
        </div>

        <div className="relative flex flex-col items-center text-xs">
            <span className="font-bold uppercase tracking-wider text-[#E7E7DC] mb-2">Hours</span>
            <div className="space-y-1 text-[#E7E7DC]/70 text-center">
                <p>Mon: Closed</p>
                <p>Tue–Thu: 8:30 AM–8 PM</p>
                <p>Fri–Sat: 8:30 AM–10 PM</p>
                <p>Sun: 8:30 AM–6 PM</p>
            </div>
        </div>
     </div>

     <div className="flex justify-center gap-4 mb-10">
        <SocialLink href="https://www.instagram.com/everclub/" icon="instagram" />
        <SocialLink href="https://www.linkedin.com/company/ever-club" icon="linkedin" />
        <SocialLink href="https://www.tiktok.com/@everclub" icon="tiktok" />
     </div>
     
     {!hideCta && (
       <a 
         href="/membership" 
         className="w-full max-w-sm mx-auto mb-10 py-4 px-6 rounded-2xl bg-[#F2F2EC] text-[#293515] font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity border border-[#F2F2EC]/80 shadow-[0_4px_16px_rgba(0,0,0,0.1)]"
       >
         Apply for Membership
         <span className="material-symbols-outlined text-lg">arrow_forward</span>
       </a>
     )}
     
     <div className="w-full max-w-xs mx-auto h-px bg-[#E7E7DC]/10 mb-8"></div>
     
     <div className="flex justify-center gap-6 mb-6 text-xs">
        <Link to="/privacy" className="text-[#E7E7DC]/60 hover:text-[#E7E7DC] transition-colors">Privacy Policy</Link>
        <Link to="/terms" className="text-[#E7E7DC]/60 hover:text-[#E7E7DC] transition-colors">Terms of Service</Link>
     </div>
     
     <div className="flex flex-col items-center gap-2">
        <p className="text-[10px] opacity-40">© {new Date().getFullYear()} Ever Members Club. All rights reserved.</p>
        <p className="text-[10px] opacity-30">v{APP_VERSION} · Updated {formatLastUpdated()}</p>
     </div>
  </footer>
);

const InstagramIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
  </svg>
);

const LinkedInIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
  </svg>
);

const TikTokIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
    <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
  </svg>
);

const SocialLink: React.FC<{href: string; icon: 'instagram' | 'linkedin' | 'tiktok'}> = ({ href, icon }) => {
  const IconComponent = {
    instagram: InstagramIcon,
    linkedin: LinkedInIcon,
    tiktok: TikTokIcon
  }[icon];

  return (
    <a 
      href={href} 
      target="_blank" 
      rel="noreferrer" 
      className="w-11 h-11 rounded-full border border-[#E7E7DC]/30 backdrop-blur-[20px] bg-white/10 flex items-center justify-center hover:bg-[#E7E7DC] hover:text-[#293515] hover:scale-[1.1] active:scale-95 transition-all duration-[400ms] ease-in-out cursor-pointer text-[#E7E7DC]"
      aria-label={icon}
    >
      <IconComponent />
    </a>
  );
};

export default Footer;

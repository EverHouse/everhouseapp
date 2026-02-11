import React, { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { TabType, tabToPath } from './types';
import { useNavigationLoading } from '../../../contexts/NavigationLoadingContext';
import { getLatestVersion } from '../../../data/changelog';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../../../lib/prefetch';

interface NavItem {
  id: TabType;
  icon: string;
  label: string;
}

interface StaffSidebarProps {
  activeTab: TabType;
  isAdmin?: boolean;
}

const MAIN_NAV_ITEMS: NavItem[] = [
  { id: 'home', icon: 'dashboard', label: 'Dashboard' },
  { id: 'simulator', icon: 'event_note', label: 'Bookings' },
  { id: 'financials', icon: 'point_of_sale', label: 'Financials' },
  { id: 'tours', icon: 'directions_walk', label: 'Tours' },
  { id: 'events', icon: 'calendar_month', label: 'Calendar' },
  { id: 'blocks', icon: 'domain', label: 'Facility' },
  { id: 'updates', icon: 'campaign', label: 'Updates' },
  { id: 'directory', icon: 'group', label: 'Directory' },
  { id: 'training', icon: 'school', label: 'Training Guide' },
];

const ADMIN_ITEMS: NavItem[] = [
  { id: 'tiers', icon: 'storefront', label: 'Products & Pricing' },
  { id: 'team', icon: 'badge', label: 'Manage Team' },
  { id: 'gallery', icon: 'photo_library', label: 'Gallery' },
  { id: 'faqs', icon: 'help_outline', label: 'FAQs' },
  { id: 'inquiries', icon: 'mail', label: 'Inquiries' },
  { id: 'bugs', icon: 'bug_report', label: 'Bug Reports' },
  { id: 'changelog', icon: 'history', label: 'Changelog' },
  { id: 'data-integrity', icon: 'fact_check', label: 'Data Integrity' },
];

export const StaffSidebar: React.FC<StaffSidebarProps> = ({ 
  activeTab, 
  isAdmin = false 
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { startNavigation } = useNavigationLoading();
  const [optimisticTab, setOptimisticTab] = useState<TabType | null>(null);
  
  useEffect(() => {
    prefetchAdjacentStaffRoutes(location.pathname);
  }, [location.pathname]);
  
  useEffect(() => {
    if (optimisticTab && activeTab === optimisticTab) {
      setOptimisticTab(null);
    }
  }, [activeTab, optimisticTab]);
  
  const displayActiveTab = optimisticTab || activeTab;
  
  const navigateToTab = useCallback((tab: TabType) => {
    if (tab === activeTab) return;
    startNavigation();
    setOptimisticTab(tab);
    if (tabToPath[tab]) {
      navigate(tabToPath[tab]);
    }
  }, [navigate, startNavigation, activeTab]);
  const navContainerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Map<TabType, HTMLButtonElement>>(new Map());
  const [indicatorStyle, setIndicatorStyle] = useState<{ top: number; height: number } | null>(null);
  
  const updateIndicatorPosition = useCallback(() => {
    const activeButton = buttonRefs.current.get(displayActiveTab);
    const container = navContainerRef.current;
    if (activeButton && container) {
      setIndicatorStyle({
        top: activeButton.offsetTop,
        height: activeButton.offsetHeight
      });
    }
  }, [displayActiveTab]);
  
  useEffect(() => {
    const timer = setTimeout(updateIndicatorPosition, 50);
    window.addEventListener('resize', updateIndicatorPosition);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateIndicatorPosition);
    };
  }, [displayActiveTab, isAdmin, updateIndicatorPosition]);
  
  const setButtonRef = useCallback((id: TabType, el: HTMLButtonElement | null) => {
    if (el) {
      buttonRefs.current.set(id, el);
    } else {
      buttonRefs.current.delete(id);
    }
  }, []);
  
  const NavButton: React.FC<{ item: NavItem }> = ({ item }) => {
    const isActive = displayActiveTab === item.id;
    return (
      <button
        ref={(el) => setButtonRef(item.id, el)}
        onClick={() => navigateToTab(item.id)}
        onMouseEnter={() => prefetchStaffRoute(tabToPath[item.id])}
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className={`
          relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-300 ease-out
          ${isActive 
            ? 'text-white font-semibold' 
            : 'text-white/60 hover:text-white hover:bg-white/[0.07] group/nav'
          }
        `}
      >
        <span className={`material-symbols-outlined text-xl relative z-10 transition-colors duration-300 ${isActive ? 'filled text-[#CCB8E4]' : 'group-hover/nav:text-white/90'}`}>
          {item.icon}
        </span>
        <span className="text-sm relative z-10">{item.label}</span>
        <span className={`relative z-10 ml-auto w-2 h-2 rounded-full bg-[#CCB8E4] transition-all duration-300 ${isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-0'}`} />
      </button>
    );
  };

  const sidebarContent = (
    <aside className="hidden lg:flex flex-col w-64 h-screen fixed left-0 top-0 bg-gradient-to-b from-[#293515] via-[#1f2a0f] to-[#1a220c] isolate" style={{ zIndex: 9999 }}>
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }}></div>
      <button 
        onClick={() => { startNavigation(); navigate('/'); }}
        className="flex items-center gap-3 px-4 py-5 flex-shrink-0 hover:opacity-80 transition-opacity w-full text-left"
        aria-label="Go to home"
      >
        <img 
          src="/assets/logos/mascot-white.webp" 
          alt="Ever Club" 
          className="h-10 w-auto object-contain"
        />
        <div>
          <h1 className="text-white font-bold text-lg leading-tight">Staff Portal</h1>
          <p className="text-white/50 text-xs">Ever Club</p>
        </div>
      </button>

      <nav ref={navContainerRef} className="relative flex-1 overflow-y-auto px-3 py-4">
        {indicatorStyle && (
          <div 
            className="absolute left-3 right-3 rounded-xl bg-white/10 border border-white/20 shadow-[0_0_24px_rgba(204,184,228,0.1),0_4px_12px_rgba(0,0,0,0.15),inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-xl pointer-events-none transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            style={{ 
              top: indicatorStyle.top,
              height: indicatorStyle.height
            }}
          />
        )}
        <div className="space-y-1">
          {MAIN_NAV_ITEMS.map(item => (
            <NavButton key={item.id} item={item} />
          ))}
        </div>

        {isAdmin && (
          <div className="mt-6 pt-4 border-t border-white/10">
            <p className="px-3 mb-3 text-xs font-semibold text-white/40 uppercase tracking-widest">
              Admin
            </p>
            <div className="space-y-1">
              {ADMIN_ITEMS.map(item => (
                <NavButton key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-white/10 flex-shrink-0">
        <p className="text-white/40 text-[10px] text-center">
          v{getLatestVersion().version} · Updated {new Date(getLatestVersion().date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      </div>
    </aside>
  );

  return createPortal(sidebarContent, document.body);
};

export default StaffSidebar;

import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { TabType, NavItemData, tabToPath, MAIN_NAV_ITEMS, ADMIN_NAV_ITEMS } from './types';
import { useNavigationLoading } from '../../../contexts/NavigationLoadingContext';
import { getLatestVersion } from '../../../data/changelog-version';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../../../lib/prefetch-actions';

interface StaffSidebarProps {
  activeTab: TabType;
  isAdmin?: boolean;
}

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
  
  const NavButton: React.FC<{ item: NavItemData }> = ({ item }) => {
    const isActive = displayActiveTab === item.id;
    return (
      <button
        onClick={() => navigateToTab(item.id)}
        onMouseEnter={() => prefetchStaffRoute(tabToPath[item.id])}
        style={{ WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
        className={`
          tactile-row relative w-full flex items-center gap-3 px-3 py-3 text-left transition-all duration-normal ease-out
          ${isActive 
            ? 'text-white font-semibold border-l-2 border-[#CCB8E4]' 
            : 'text-white/50 hover:text-white/80 border-l-2 border-transparent group/nav'
          }
        `}
      >
        <span className={`material-symbols-outlined text-[18px] transition-colors duration-normal ${isActive ? 'filled text-[#CCB8E4]' : 'group-hover/nav:text-white/70'}`}>
          {item.icon}
        </span>
        <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px]">{item.label}</span>
      </button>
    );
  };

  const sidebarContent = (
    <aside className="hidden xl:flex flex-col w-64 h-screen fixed left-0 top-0 bg-gradient-to-b from-[#293515] via-[#1f2a0f] to-[#1a220c] border-r border-white/10 isolate" style={{ zIndex: 'var(--z-nav)' }}>
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }}></div>
      <button 
        onClick={() => { startNavigation(); navigate('/'); }}
        className="flex items-center gap-3 px-6 py-6 flex-shrink-0 hover:opacity-80 transition-opacity w-full text-left"
        aria-label="Go to home"
      >
        <img 
          src="/assets/logos/mascot-white.webp" 
          alt="Ever Club" 
          className="h-8 w-auto object-contain"
        />
        <div>
          <h1 className="text-[10px] text-white/40 uppercase tracking-[0.4em] leading-none" style={{ fontFamily: 'var(--font-label)' }}>Staff Portal</h1>
          <p className="text-[9px] text-white/25 uppercase tracking-[0.3em] mt-1.5" style={{ fontFamily: 'var(--font-label)' }}>Ever Club</p>
        </div>
      </button>

      <nav className="relative flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-0.5">
          {MAIN_NAV_ITEMS.map(item => (
            <NavButton key={item.id} item={item} />
          ))}
        </div>

        {isAdmin && (
          <div className="mt-6 pt-4 border-t border-white/10">
            <p className="px-3 mb-2 text-[10px] font-semibold text-white/30 uppercase tracking-[0.2em]" style={{ fontFamily: 'var(--font-label)' }}>
              Admin
            </p>
            <div className="space-y-0.5">
              {ADMIN_NAV_ITEMS.map(item => (
                <NavButton key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-white/10 flex-shrink-0">
        <p className="text-white/40 text-[10px] text-center">
          v{getLatestVersion().version} · Updated {new Date(getLatestVersion().date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })}
        </p>
      </div>
    </aside>
  );

  return createPortal(sidebarContent, document.body);
};

export default StaffSidebar;

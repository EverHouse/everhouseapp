import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { TabType, NavItemData, tabToPath, MAIN_NAV_ITEMS, ADMIN_NAV_ITEMS } from './types';
import { useNavigationLoading } from '../../../stores/navigationLoadingStore';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../../../lib/prefetch-actions';
import Icon from '../../../components/icons/Icon';

interface StaffNavigationRailProps {
  activeTab: TabType;
  isAdmin?: boolean;
}

export const StaffNavigationRail: React.FC<StaffNavigationRailProps> = ({
  activeTab,
  isAdmin = false,
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

  const RailItem: React.FC<{ item: NavItemData }> = ({ item }) => {
    const isActive = displayActiveTab === item.id;
    return (
      <button
        onClick={() => navigateToTab(item.id)}
        onMouseEnter={() => prefetchStaffRoute(tabToPath[item.id])}
        style={{ WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
        aria-label={item.label}
        aria-current={isActive ? 'page' : undefined}
        className="tactile-btn flex flex-col items-center gap-1 w-full min-h-[56px] py-2 px-1 transition-colors duration-normal ease-out"
      >
        <div className={`flex items-center justify-center w-10 h-7 rounded-full transition-colors duration-normal ${isActive ? 'bg-accent/20' : 'hover:bg-white/10'}`}>
          <Icon name={item.icon} className={`text-[20px] transition-colors duration-normal ${isActive ? 'filled text-[#CCB8E4]' : 'text-white/50 group-hover:text-white/70'}`} />
        </div>
        <span className={`text-[9px] uppercase tracking-[0.1em] leading-tight text-center truncate w-full px-0.5 transition-colors duration-normal ${isActive ? 'text-white font-semibold' : 'text-white/50'}`}>
          {item.label}
        </span>
      </button>
    );
  };

  const railContent = (
    <aside
      className="hidden md:flex xl:hidden flex-col w-20 h-screen fixed left-0 top-0 bg-gradient-to-b from-[#293515] via-[#1f2a0f] to-[#1a220c] border-r border-white/10 isolate"
      style={{ zIndex: 'var(--z-nav)' }}
    >
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }}></div>

      <button
        onClick={() => { startNavigation(); navigate('/'); }}
        className="flex items-center justify-center py-5 flex-shrink-0 hover:opacity-80 transition-opacity"
        aria-label="Go to home"
      >
        <img
          src="/assets/logos/mascot-white.webp"
          alt="Ever Club"
          className="h-7 w-auto object-contain"
        />
      </button>

      <nav className="relative flex-1 overflow-y-auto px-1 py-2">
        <div className="space-y-0.5">
          {MAIN_NAV_ITEMS.map(item => (
            <RailItem key={item.id} item={item} />
          ))}
        </div>

        {isAdmin && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <div className="space-y-0.5">
              {ADMIN_NAV_ITEMS.map(item => (
                <RailItem key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="px-1 py-3 border-t border-white/10 flex-shrink-0">
        <button
          onClick={() => {
            const isPwa = window.matchMedia('(display-mode: standalone)').matches
              || (navigator as any).standalone === true;
            if (isPwa) {
              startNavigation();
              navigate('/kiosk');
            } else {
              window.open('/kiosk', '_blank', 'noopener,noreferrer');
            }
          }}
          style={{ WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
          aria-label="Kiosk Check-in"
          className="tactile-btn flex flex-col items-center gap-1 w-full min-h-[56px] py-2 px-1 transition-colors duration-normal ease-out"
        >
          <div className="flex items-center justify-center w-10 h-7 rounded-full hover:bg-white/10 transition-colors duration-normal">
            <Icon name="qr_code_scanner" className="text-[20px] text-white/50 group-hover:text-white/70" />
          </div>
          <span className="text-[9px] uppercase tracking-[0.1em] leading-tight text-center truncate w-full px-0.5 text-white/50">
            Kiosk
          </span>
        </button>
      </div>
    </aside>
  );

  return createPortal(railContent, document.body);
};

export default StaffNavigationRail;

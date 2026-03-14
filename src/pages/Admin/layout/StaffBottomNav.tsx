import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { SafeAreaBottomOverlay } from '../../../components/layout/SafeAreaBottomOverlay';
import { TabType, NAV_ITEMS, tabToPath } from './types';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../../../lib/prefetch-actions';

interface StaffBottomNavProps {
  activeTab: TabType;
  isAdmin?: boolean;
  pendingRequestsCount?: number;
}

export const StaffBottomNav: React.FC<StaffBottomNavProps> = ({ 
  activeTab, 
  isAdmin, 
  pendingRequestsCount = 0 
}) => {
  const navigate = useNavigate();
  const location = useLocation();
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
  
  const navigateToTab = useCallback((tab: TabType) => {
    if (tab === activeTab) return;
    if (tabToPath[tab]) {
      setOptimisticTab(tab);
      navigate(tabToPath[tab]);
    }
  }, [navigate, activeTab]);
  const navRef = useRef<HTMLDivElement>(null);
  
  const displayActiveTab = optimisticTab || activeTab;
  const visibleItems = NAV_ITEMS.filter(item => !item.adminOnly || isAdmin);
  
  const navContent = (
    <nav 
      ref={navRef}
      className="staff-bottom-nav relative mb-8 mx-auto w-[calc(100%-3rem)] max-w-md bg-black/60 backdrop-blur-xl border border-white/10 p-2 rounded-full pointer-events-auto"
      role="navigation"
      aria-label="Staff navigation"
    >
      <div className="relative flex items-center w-full">
        {visibleItems.map((item) => {
          const isActive = displayActiveTab === item.id;
          const shouldFill = isActive;
          return (
          <button
            type="button"
            key={item.id}
            onClick={() => navigateToTab(item.id)}
            onMouseEnter={() => prefetchStaffRoute(tabToPath[item.id])}
            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
            aria-label={item.label}
            aria-current={isActive ? 'page' : undefined}
            className={`
              tactile-btn flex-1 flex flex-col items-center gap-1 py-3.5 px-1 min-h-[48px] relative z-10 cursor-pointer
              select-none transition-all duration-normal ease-out active:scale-95
              focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-inset focus-visible:outline-none
              ${isActive ? 'text-white' : 'text-white/50 hover:text-white/70'}
            `}
          >
            <div className="relative">
              <span className={`material-symbols-outlined text-[20px] transition-all duration-normal pointer-events-none ${shouldFill ? 'filled' : ''}`} aria-hidden="true">
                {item.icon}
              </span>
              {item.id === 'simulator' && pendingRequestsCount > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full shadow-sm animate-badge-pulse">
                  {pendingRequestsCount > 99 ? '99+' : pendingRequestsCount}
                </span>
              )}
            </div>
            <span className={`text-[9px] uppercase tracking-[0.2em] transition-colors duration-normal pointer-events-none translate-y-[1px] ${isActive ? 'font-semibold text-white' : 'font-medium'}`}>
              {item.label}
            </span>
            <div className={`absolute bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-white transition-all duration-normal ${isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-0'}`} />
          </button>
          );
        })}
      </div>
    </nav>
  );
  
  return <SafeAreaBottomOverlay>{navContent}</SafeAreaBottomOverlay>;
};

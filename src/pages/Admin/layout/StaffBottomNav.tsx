import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { SafeAreaBottomOverlay } from '../../../components/layout/SafeAreaBottomOverlay';
import { TabType, NavItemData, NAV_ITEMS, tabToPath } from './types';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../../../lib/prefetch';

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
  const activeIndex = visibleItems.findIndex(item => item.id === displayActiveTab);
  const itemCount = visibleItems.length;
  
  const blobWidth = 100 / itemCount;
  
  const navContent = (
    <nav 
      ref={navRef}
      className="staff-bottom-nav relative mb-8 mx-auto w-[calc(100%-3rem)] max-w-md bg-black/60 backdrop-blur-xl border border-white/15 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.2)] rounded-full pointer-events-auto"
    >
      <div className="relative flex items-center w-full">
        {activeIndex >= 0 && (
        <div 
          className="absolute top-0 bottom-0 left-0 rounded-full pointer-events-none bg-gradient-to-b from-white/20 to-white/10 shadow-[0_0_20px_rgba(41,53,21,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)] transition-transform duration-emphasis ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{ 
            width: `${blobWidth}%`, 
            transform: `translateX(${activeIndex * 100}%)`,
          }}
        />
        )}
        
        {visibleItems.map((item) => {
          const isActive = displayActiveTab === item.id;
          return (
          <button
            type="button"
            key={item.id}
            onClick={() => navigateToTab(item.id)}
            onMouseEnter={() => prefetchStaffRoute(tabToPath[item.id])}
            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
            aria-label={item.label}
            aria-current={isActive ? 'page' : undefined}
            className={`
              tactile-btn flex-1 flex flex-col items-center gap-1 py-2 px-1 min-h-[48px] relative z-10 cursor-pointer
              transition-colors duration-normal ease-out active:scale-95
              ${isActive ? 'text-white' : 'text-white/60 hover:text-white'}
            `}
          >
            <div className="relative">
              <span className={`material-symbols-outlined text-xl transition-transform duration-normal ${isActive ? 'filled scale-110' : ''}`} aria-hidden="true">
                {item.icon}
              </span>
              {item.id === 'simulator' && pendingRequestsCount > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full shadow-sm animate-badge-pulse">
                  {pendingRequestsCount > 99 ? '99+' : pendingRequestsCount}
                </span>
              )}
            </div>
            <span className={`text-[11px] tracking-wide transition-colors duration-normal ${isActive ? 'font-semibold' : 'font-medium'}`}>
              {item.label}
            </span>
          </button>
          );
        })}
      </div>
    </nav>
  );
  
  return <SafeAreaBottomOverlay>{navContent}</SafeAreaBottomOverlay>;
};

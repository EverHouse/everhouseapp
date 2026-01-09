import React, { useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { SafeAreaBottomOverlay } from './layout/SafeAreaBottomOverlay';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { haptic } from '../utils/haptics';

interface StaffNavItem {
  path: string;
  tab: string | null;
  icon: string;
  label: string;
}

const STAFF_NAV_ITEMS: StaffNavItem[] = [
  { path: '/admin', tab: null, icon: 'home', label: 'Home' },
  { path: '/admin?tab=simulator', tab: 'simulator', icon: 'event_note', label: 'Bookings' },
  { path: '/admin?tab=tours', tab: 'tours', icon: 'directions_walk', label: 'Tours' },
  { path: '/admin?tab=events', tab: 'events', icon: 'calendar_month', label: 'Calendar' },
  { path: '/admin?tab=directory', tab: 'directory', icon: 'group', label: 'Directory' },
];

const TAB_MAPPING: Record<string, number> = {
  'simulator': 1, 'bookings': 1,
  'tours': 2,
  'events': 3, 'calendar': 3,
  'directory': 4, 'members': 4,
};

const StaffBottomNavSimple: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { startNavigation } = useNavigationLoading();
  const navigatingRef = useRef(false);
  const itemCount = STAFF_NAV_ITEMS.length;
  
  const activeIndex = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const currentTab = params.get('tab');
    
    // Check query param first
    if (currentTab) {
      const mapped = TAB_MAPPING[currentTab];
      if (mapped !== undefined) return mapped;
      const idx = STAFF_NAV_ITEMS.findIndex(item => item.tab === currentTab);
      if (idx >= 0) return idx;
    }
    
    // For /admin without tab param, show home
    if (location.pathname === '/admin' && !currentTab) {
      return 0;
    }
    
    // For any other admin path, no nav item is highlighted (return -1 to hide blob)
    // But if we're on /admin, default to home
    return location.pathname.startsWith('/admin') ? -1 : 0;
  }, [location.pathname, location.search]);
  
  const handleNavigation = useCallback((path: string) => {
    if (navigatingRef.current) return;
    haptic.light();
    navigatingRef.current = true;
    startNavigation();
    navigate(path);
    setTimeout(() => { navigatingRef.current = false; }, 500);
  }, [navigate, startNavigation]);
  
  const showBlob = activeIndex >= 0;
  
  const navContent = (
    <nav 
      className="relative mb-8 mx-auto w-[calc(100%-3rem)] max-w-md bg-black/60 backdrop-blur-xl border border-[#293515]/80 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.2)] rounded-full pointer-events-auto"
      role="navigation"
      aria-label="Staff navigation"
    >
      <div className="relative flex items-center w-full">
        {showBlob && (
          <div 
            className="absolute h-[calc(100%-8px)] bg-[#293515]/80 rounded-full transition-all duration-300 ease-out pointer-events-none"
            style={{ 
              width: `calc(${100 / itemCount}% - 4px)`,
              left: `calc(${(activeIndex * 100) / itemCount}% + 2px)`,
              top: '4px'
            }}
            aria-hidden="true"
          />
        )}
        {STAFF_NAV_ITEMS.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              type="button"
              key={item.path}
              onClick={() => handleNavigation(item.path)}
              style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center gap-0.5 py-3 px-1 min-h-[44px] relative z-10 cursor-pointer transition-colors duration-300 ease-out active:scale-95 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-inset focus-visible:outline-none ${
                isActive ? 'text-white' : 'text-white/70 hover:text-white/90'
              }`}
            >
              <span className={`material-symbols-outlined text-xl transition-transform duration-300 ${isActive ? 'scale-110' : ''}`} aria-hidden="true">
                {item.icon}
              </span>
              <span className="text-[9px] tracking-wide font-medium">
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

export default StaffBottomNavSimple;

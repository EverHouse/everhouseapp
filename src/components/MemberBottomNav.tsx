import React, { useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { SafeAreaBottomOverlay } from './layout/SafeAreaBottomOverlay';
import { prefetchRoute, prefetchAdjacentRoutes } from '../lib/prefetch';
import { haptic } from '../utils/haptics';

interface MemberNavItem {
  path: string;
  icon: string;
  label: string;
}

const MEMBER_NAV_ITEMS: MemberNavItem[] = [
  { path: '/dashboard', icon: 'dashboard', label: 'Home' },
  { path: '/book', icon: 'book_online', label: 'Book' },
  { path: '/member-wellness', icon: 'spa', label: 'Wellness' },
  { path: '/member-events', icon: 'event', label: 'Events' },
  { path: '/history', icon: 'history', label: 'History' },
];

interface MemberBottomNavProps {
  currentPath: string;
  isDarkTheme: boolean;
}

const MemberBottomNav: React.FC<MemberBottomNavProps> = ({ currentPath, isDarkTheme }) => {
  const navigate = useNavigate();
  const navigatingRef = useRef(false);
  const lastTapRef = useRef(0);
  
  useEffect(() => {
    prefetchAdjacentRoutes(currentPath);
    navigatingRef.current = false;
  }, [currentPath]);
  
  const handleNavigation = useCallback((path: string, label: string) => {
    if (navigatingRef.current) return;
    if (path === currentPath) return;
    
    haptic.light();
    navigatingRef.current = true;
    if (import.meta.env.DEV) {
      console.log(`[MemberNav] navigating to "${label}"`);
    }
    navigate(path);
  }, [navigate, currentPath]);
  
  const activeIndex = MEMBER_NAV_ITEMS.findIndex(item => item.path === currentPath);
  const itemCount = MEMBER_NAV_ITEMS.length;
  
  const blobWidth = 100 / itemCount;
  
  const navContent = (
      <nav 
        className="relative mb-8 mx-auto w-[calc(100%-3rem)] max-w-md rounded-full p-2 bg-black/60 backdrop-blur-xl border border-[#293515]/80 shadow-[0_4px_16px_rgba(0,0,0,0.15)] pointer-events-auto"
        role="navigation"
        aria-label="Member navigation"
      >
        <div className="relative flex items-center w-full">
          {activeIndex >= 0 && (
            <div 
              className="absolute top-0 bottom-0 left-0 rounded-full pointer-events-none bg-gradient-to-b from-white/20 to-white/10 shadow-[0_0_20px_rgba(41,53,21,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)] transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
              style={{ 
                width: `${blobWidth}%`, 
                transform: `translateX(${activeIndex * 100}%)`,
              }}
            />
          )}
          
          {MEMBER_NAV_ITEMS.map((item) => {
            const isActive = currentPath === item.path;
            const isGolfIcon = item.icon === 'sports_golf';
            const shouldFill = isActive && !isGolfIcon;
            
            return (
              <button
                type="button"
                key={item.path}
                onClick={() => handleNavigation(item.path, item.label)}
                onPointerUp={(e) => {
                  if (e.pointerType === 'touch') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (Date.now() - lastTapRef.current < 350) return;
                    lastTapRef.current = Date.now();
                    handleNavigation(item.path, item.label);
                  }
                }}
                onMouseEnter={() => prefetchRoute(item.path)}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                className={`
                  flex-1 flex flex-col items-center gap-0.5 py-3.5 px-1 min-h-[48px] relative z-10 cursor-pointer
                  select-none transition-colors duration-300 ease-out active:scale-95
                  focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-inset focus-visible:outline-none
                  ${isActive ? 'text-white' : 'text-white/70 hover:text-white/90'}
                `}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className={`material-symbols-outlined text-[22px] transition-transform duration-300 pointer-events-none ${shouldFill ? 'filled' : ''} ${isActive ? 'scale-110' : ''}`}>
                  {item.icon}
                </span>
                <span className={`text-[10px] tracking-wide transition-colors duration-300 pointer-events-none ${isActive ? 'font-bold' : 'font-medium'}`}>
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

export default MemberBottomNav;

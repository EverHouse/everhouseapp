import React, { useState, useEffect, useCallback } from 'react';
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
  { path: '/wellness', icon: 'spa', label: 'Wellness' },
  { path: '/events', icon: 'event', label: 'Events' },
  { path: '/history', icon: 'history', label: 'History' },
];

interface MemberBottomNavProps {
  currentPath: string;
  isDarkTheme: boolean;
}

const MemberBottomNav: React.FC<MemberBottomNavProps> = ({ currentPath, isDarkTheme }) => {
  const navigate = useNavigate();
  const [optimisticPath, setOptimisticPath] = useState<string | null>(null);
  
  useEffect(() => {
    prefetchAdjacentRoutes(currentPath);
  }, [currentPath]);
  
  useEffect(() => {
    if (optimisticPath && currentPath === optimisticPath) {
      setOptimisticPath(null);
    }
  }, [currentPath, optimisticPath]);
  
  const handleNavigation = useCallback((path: string, label: string) => {
    if (path === currentPath) return;
    haptic.light();
    setOptimisticPath(path);
    navigate(path);
  }, [navigate, currentPath]);
  
  const activePath = optimisticPath || currentPath;
  
  const navContent = (
      <nav 
        className="member-bottom-nav relative mb-8 mx-auto w-[calc(100%-3rem)] max-w-md rounded-full p-2 bg-black/60 backdrop-blur-xl border border-white/10 pointer-events-auto"
        role="navigation"
        aria-label="Member navigation"
      >
        <div className="relative flex items-center w-full">
          {MEMBER_NAV_ITEMS.map((item) => {
            const isActive = activePath === item.path;
            const isGolfIcon = item.icon === 'sports_golf';
            const shouldFill = isActive && !isGolfIcon;
            
            return (
              <button
                type="button"
                key={item.path}
                onClick={() => handleNavigation(item.path, item.label)}
                onMouseEnter={() => prefetchRoute(item.path)}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
                className={`
                  tactile-btn flex-1 flex flex-col items-center gap-1 py-3.5 px-1 min-h-[48px] relative z-10 cursor-pointer
                  select-none transition-all duration-normal ease-out active:scale-95
                  focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-inset focus-visible:outline-none
                  ${isActive ? 'text-white' : 'text-white/50 hover:text-white/70'}
                `}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className={`material-symbols-outlined text-[20px] transition-all duration-normal pointer-events-none ${shouldFill ? 'filled' : ''}`}>
                  {item.icon}
                </span>
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

export default MemberBottomNav;

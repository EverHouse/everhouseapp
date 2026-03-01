import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { useBottomNav } from '../contexts/BottomNavContext';
import { haptic } from '../utils/haptics';
import BugReportModal from './BugReportModal';

interface MemberMenuOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  path: string;
  icon: string;
}

const MEMBER_MENU_ITEMS: MenuItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/dashboard', icon: 'dashboard' },
  { id: 'book-golf', label: 'Book Golf', path: '/book', icon: 'golf_course' },
  { id: 'book-conference', label: 'Book Conference Room', path: '/book?tab=conference', icon: 'meeting_room' },
  { id: 'wellness', label: 'Wellness', path: '/wellness', icon: 'spa' },
  { id: 'medspa', label: 'MedSpa Menu', path: '/wellness?tab=medspa', icon: 'health_and_beauty' },
  { id: 'events', label: 'Events', path: '/events', icon: 'celebration' },
  { id: 'history', label: 'Visit History', path: '/history', icon: 'history' },
  { id: 'payments', label: 'Payment History', path: '/history?tab=payments', icon: 'receipt_long' },
  { id: 'announcements', label: 'Announcements', path: '/updates?tab=announcements', icon: 'campaign' },
  { id: 'notices', label: 'Notices', path: '/updates?tab=notices', icon: 'notifications' },
  { id: 'profile', label: 'Profile', path: '/profile', icon: 'person' },
];

const MemberMenuOverlay: React.FC<MemberMenuOverlayProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { effectiveTheme } = useTheme();
  const { startNavigation } = useNavigationLoading();
  const { setDrawerOpen } = useBottomNav();
  const isDark = effectiveTheme === 'dark';
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const originalBgRef = useRef<string>('');
  const scrollingRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  const scrollCooldownRef = useRef<NodeJS.Timeout | null>(null);

  const menuBgColor = isDark ? '#141414' : '#F2F2EC';

  useEffect(() => {
    if (isOpen) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      originalBgRef.current = document.body.style.backgroundColor || '';
      document.documentElement.style.backgroundColor = menuBgColor;
      document.body.style.backgroundColor = menuBgColor;
      document.querySelectorAll('meta[name="theme-color"]').forEach(el => el.setAttribute('content', menuBgColor));
      setIsVisible(true);
      setIsClosing(false);
    } else if (isVisible) {
      setIsClosing(true);
      timerRef.current = setTimeout(() => {
        if (originalBgRef.current) {
          document.documentElement.style.backgroundColor = originalBgRef.current;
          document.body.style.backgroundColor = originalBgRef.current;
        }
        const metaLight = document.querySelector('meta[name="theme-color"][media*="light"]');
        const metaDark = document.querySelector('meta[name="theme-color"][media*="dark"]');
        if (metaLight) metaLight.setAttribute('content', '#293515');
        if (metaDark) metaDark.setAttribute('content', '#1a2310');
        setIsVisible(false);
        setIsClosing(false);
        timerRef.current = null;
      }, 250);
    }
    
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isOpen, isVisible, menuBgColor]);

  useScrollLockManager(isVisible);

  useEffect(() => {
    setDrawerOpen(isVisible);
    return () => setDrawerOpen(false);
  }, [isVisible, setDrawerOpen]);

  const handleClose = () => {
    haptic.selection();
    onClose();
  };

  const handleNav = (path: string) => {
    haptic.light();
    startNavigation();
    navigate(path);
    handleClose();
  };

  const isActive = (item: MenuItem) => {
    const currentPath = location.pathname;
    const currentSearch = new URLSearchParams(location.search);
    
    if (item.path.includes('?')) {
      const [basePath, queryString] = item.path.split('?');
      if (!currentPath.startsWith(basePath)) return false;
      const params = new URLSearchParams(queryString);
      for (const [key, value] of params) {
        if (currentSearch.get(key) !== value) return false;
      }
      return true;
    }
    
    if (currentPath === item.path || currentPath.startsWith(item.path + '/')) {
      const hasActiveTabChild = MEMBER_MENU_ITEMS.some(other => {
        if (!other.path.includes('?')) return false;
        const [otherBase, otherQuery] = other.path.split('?');
        if (otherBase !== item.path && !item.path.startsWith(otherBase)) return false;
        if (!currentPath.startsWith(otherBase)) return false;
        const otherParams = new URLSearchParams(otherQuery);
        for (const [key, value] of otherParams) {
          if (currentSearch.get(key) === value) return true;
        }
        return false;
      });
      return !hasActiveTabChild;
    }
    
    return false;
  };

  if (!isVisible) return null;

  const menuContent = (
    <div 
      className="fixed left-0 right-0 flex justify-start overflow-visible pointer-events-auto" 
      style={{ zIndex: 'var(--z-drawer)', top: 0, bottom: '-100px', height: 'calc(100% + 100px)' }}
    >
      <div 
        className={`absolute inset-0 bg-black/20 backdrop-blur-xl ${isClosing ? 'animate-backdrop-out' : 'animate-backdrop-in'}`}
        onClick={handleClose}
        aria-hidden="true"
      ></div>

      <div 
        className={`relative w-[85%] md:w-[320px] lg:w-[320px] h-full flex flex-col overflow-hidden rounded-tr-[2rem] border-l-0 ${isDark ? 'bg-[#141414]' : 'bg-[#F2F2EC]'} backdrop-blur-xl ${isClosing ? 'animate-slide-out-left' : 'animate-slide-in-left'}`}
      >
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none mix-blend-multiply"></div>

        <div className={`relative z-10 flex flex-col lg:w-[320px] py-8 safe-area-inset-menu pb-[calc(2rem+env(safe-area-inset-bottom,0px)+100px)] ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`} style={{ height: 'calc(100% - 100px)' }}>
            
            <div className="flex items-center justify-between mb-6 px-1">
                <button 
                  onClick={() => handleNav('/')}
                  aria-label="Go to home"
                  className="w-14 h-14 min-w-[56px] min-h-[56px] flex items-center justify-center transition-transform duration-normal rounded-full active:scale-90 hover:scale-105"
                >
                  <img 
                    src={isDark ? "/assets/logos/mascot-white.webp" : "/assets/logos/mascot-dark.webp"}
                    alt="Ever Club mascot character"
                    className="h-14 w-auto object-contain"
                  />
                </button>
                <button 
                  onClick={handleClose}
                  aria-label="Close menu"
                  className={`w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center hover:rotate-90 transition-transform duration-normal rounded-full active:scale-90 ${isDark ? 'text-[#F2F2EC] hover:bg-white/10' : 'text-[#293515] hover:bg-black/5'}`}
                >
                    <span className="material-symbols-outlined text-3xl">close</span>
                </button>
            </div>
            
            <nav
              className="flex flex-col gap-0.5 flex-1 overflow-y-auto scrollbar-hide py-2 px-2"
              onTouchStart={(e) => {
                touchStartYRef.current = e.touches[0].clientY;
                if (scrollCooldownRef.current) {
                  clearTimeout(scrollCooldownRef.current);
                  scrollCooldownRef.current = null;
                }
              }}
              onTouchMove={(e) => {
                if (touchStartYRef.current !== null && Math.abs(e.touches[0].clientY - touchStartYRef.current) > 8) {
                  scrollingRef.current = true;
                }
              }}
              onTouchEnd={() => {
                touchStartYRef.current = null;
                if (scrollingRef.current) {
                  scrollCooldownRef.current = setTimeout(() => {
                    scrollingRef.current = false;
                    scrollCooldownRef.current = null;
                  }, 300);
                }
              }}
            >
              {MEMBER_MENU_ITEMS.map((item, index) => (
                <MemberMenuLink
                  key={item.id}
                  item={item}
                  isActive={isActive(item)}
                  onClick={() => handleNav(item.path)}
                  staggerIndex={index}
                  isDark={isDark}
                  scrollingRef={scrollingRef}
                />
              ))}
            </nav>
            
            <div className={`mt-4 pt-4 border-t px-2 animate-slide-up-stagger ${isDark ? 'border-white/10' : 'border-black/10'}`} style={{ '--stagger-index': MEMBER_MENU_ITEMS.length } as React.CSSProperties}>
              <button
                onClick={() => {
                  haptic.light();
                  setShowBugReport(true);
                }}
                style={{ fontFamily: 'var(--font-label)' }}
                className={`tactile-row w-full flex items-center gap-4 px-4 py-3.5 text-left transition-all duration-normal leading-tight min-h-[48px] border-l-2 border-transparent ${
                  isDark 
                    ? 'text-[#F2F2EC]/50 hover:text-[#F2F2EC]/80' 
                    : 'text-[#293515]/50 hover:text-[#293515]/80'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">bug_report</span>
                <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px]">Report a Bug</span>
              </button>
            </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(menuContent, document.body)}
      <BugReportModal
        isOpen={showBugReport}
        onClose={() => setShowBugReport(false)}
      />
    </>
  );
};

interface MemberMenuLinkProps {
  item: MenuItem;
  isActive: boolean;
  onClick: () => void;
  staggerIndex: number;
  isDark: boolean;
  scrollingRef: React.MutableRefObject<boolean>;
}

const MemberMenuLink: React.FC<MemberMenuLinkProps> = ({ item, isActive, onClick, staggerIndex, isDark, scrollingRef }) => {
  const handleClick = () => {
    if (scrollingRef.current) return;
    onClick();
  };

  return (
    <button 
      type="button"
      onClick={handleClick}
      style={{ '--stagger-index': staggerIndex, touchAction: 'pan-y', animationFillMode: 'both', fontFamily: 'var(--font-label)' } as React.CSSProperties}
      className={`tactile-row flex items-center gap-4 px-4 py-3.5 text-left transition-all duration-normal animate-slide-up-stagger leading-tight min-h-[48px] ${
        isActive
          ? isDark 
            ? 'text-[#F2F2EC] font-semibold border-l-2 border-[#CCB8E4]' 
            : 'text-[#293515] font-semibold border-l-2 border-[#293515]'
          : isDark 
            ? 'text-[#F2F2EC]/50 hover:text-[#F2F2EC]/80 border-l-2 border-transparent' 
            : 'text-[#293515]/50 hover:text-[#293515]/80 border-l-2 border-transparent'
      }`}
    >
      <span className={`material-symbols-outlined text-[18px] ${
        isActive 
          ? isDark ? 'filled text-[#CCB8E4]' : 'filled text-[#293515]'
          : ''
      }`}>
        {item.icon}
      </span>
      <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px] flex-1">{item.label}</span>
    </button>
  );
};

export default MemberMenuOverlay;

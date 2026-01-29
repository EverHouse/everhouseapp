import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { haptic } from '../utils/haptics';

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
  { id: 'wellness', label: 'Wellness', path: '/member-wellness', icon: 'spa' },
  { id: 'medspa', label: 'MedSpa Menu', path: '/member-wellness?tab=medspa', icon: 'health_and_beauty' },
  { id: 'events', label: 'Events', path: '/member-events', icon: 'celebration' },
  { id: 'history', label: 'Visit History', path: '/history', icon: 'history' },
  { id: 'payments', label: 'Payment History', path: '/history?tab=payments', icon: 'receipt_long' },
  { id: 'announcements', label: 'Announcements', path: '/updates?tab=announcements', icon: 'campaign' },
  { id: 'notices', label: 'Notices', path: '/updates?tab=activity', icon: 'notifications' },
  { id: 'profile', label: 'Profile', path: '/profile', icon: 'person' },
];

const MemberMenuOverlay: React.FC<MemberMenuOverlayProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { effectiveTheme } = useTheme();
  const { startNavigation } = useNavigationLoading();
  const isDark = effectiveTheme === 'dark';
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const originalBgRef = useRef<string>('');

  const menuBgColor = isDark ? '#0f120a' : '#F2F2EC';

  useEffect(() => {
    if (isOpen) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      originalBgRef.current = document.body.style.backgroundColor || '';
      document.documentElement.style.backgroundColor = menuBgColor;
      document.body.style.backgroundColor = menuBgColor;
      setIsVisible(true);
      setIsClosing(false);
    } else if (isVisible) {
      setIsClosing(true);
      timerRef.current = setTimeout(() => {
        if (originalBgRef.current) {
          document.documentElement.style.backgroundColor = originalBgRef.current;
          document.body.style.backgroundColor = originalBgRef.current;
        }
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
    if (item.path.includes('?')) {
      const [basePath, queryString] = item.path.split('?');
      if (!location.pathname.startsWith(basePath)) return false;
      const params = new URLSearchParams(queryString);
      const searchParams = new URLSearchParams(location.search);
      for (const [key, value] of params) {
        if (searchParams.get(key) !== value) return false;
      }
      return true;
    }
    return location.pathname === item.path || location.pathname.startsWith(item.path + '/');
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
      ></div>

      <div 
        className={`relative w-[85%] md:w-[320px] lg:w-[320px] h-full flex flex-col overflow-hidden rounded-tr-[2rem] border-l-0 ${isDark ? 'bg-[#0f120a]' : 'bg-[#F2F2EC]'} backdrop-blur-xl ${isClosing ? 'animate-slide-out-left' : 'animate-slide-in-left'}`}
      >
        <div className="absolute inset-0 opacity-[0.03] bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] pointer-events-none mix-blend-multiply"></div>

        <div className={`relative z-10 flex flex-col lg:w-[320px] py-8 safe-area-inset-menu pb-[calc(2rem+env(safe-area-inset-bottom,0px)+100px)] ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`} style={{ height: 'calc(100% - 100px)' }}>
            
            <div className="flex items-center justify-between mb-6 px-1">
                <button 
                  onClick={() => handleNav('/')}
                  aria-label="Go to home"
                  className="w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center transition-transform duration-300 rounded-full active:scale-90 hover:scale-105"
                >
                  <img 
                    src={isDark ? "/assets/logos/mascot-white.webp" : "/assets/logos/mascot-dark.webp"}
                    alt="Ever House"
                    className="h-10 w-auto object-contain"
                  />
                </button>
                <button 
                  onClick={handleClose}
                  aria-label="Close menu"
                  className={`w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center hover:rotate-90 transition-transform duration-300 rounded-full active:scale-90 ${isDark ? 'text-[#F2F2EC] hover:bg-white/10' : 'text-[#293515] hover:bg-black/5'}`}
                >
                    <span className="material-symbols-outlined text-3xl">close</span>
                </button>
            </div>
            
            <nav className="flex flex-col gap-1 flex-1 overflow-y-auto scrollbar-hide py-2 px-2">
              {MEMBER_MENU_ITEMS.map((item, index) => (
                <MemberMenuLink
                  key={item.id}
                  item={item}
                  isActive={isActive(item)}
                  onClick={() => handleNav(item.path)}
                  staggerIndex={index}
                  isDark={isDark}
                />
              ))}
            </nav>
        </div>
      </div>
    </div>
  );

  return createPortal(menuContent, document.body);
};

interface MemberMenuLinkProps {
  item: MenuItem;
  isActive: boolean;
  onClick: () => void;
  staggerIndex: number;
  isDark: boolean;
}

const MemberMenuLink: React.FC<MemberMenuLinkProps> = ({ item, isActive, onClick, staggerIndex, isDark }) => {
  const lastTapRef = useRef(0);
  
  const handlePointerUp = () => {
    if (Date.now() - lastTapRef.current < 350) return;
    lastTapRef.current = Date.now();
    onClick();
  };
  
  return (
    <button 
      type="button"
      onClick={onClick}
      onPointerUp={handlePointerUp}
      style={{ '--stagger-index': staggerIndex, touchAction: 'manipulation', animationFillMode: 'both' } as React.CSSProperties}
      className={`relative flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-base font-medium transition-all duration-300 animate-slide-up-stagger leading-tight min-h-[48px] ${
        isActive
          ? isDark 
            ? 'text-[#F2F2EC]' 
            : 'text-[#293515]'
          : isDark 
            ? 'text-[#F2F2EC]/60 hover:text-[#F2F2EC] hover:bg-white/5' 
            : 'text-[#293515]/60 hover:text-[#293515] hover:bg-black/5'
      }`}
    >
      {isActive && (
        <div 
          className={`absolute inset-0 rounded-xl ${
            isDark 
              ? 'bg-white/10 border border-white/20 shadow-[0_0_20px_rgba(255,255,255,0.08),inset_0_1px_1px_rgba(255,255,255,0.1)]' 
              : 'bg-white/80 border border-black/10 shadow-[0_4px_20px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.8)]'
          } backdrop-blur-md`}
        />
      )}

      <span className={`material-symbols-outlined text-xl relative z-10 ${
        isActive 
          ? 'text-[#7cb342]'
          : ''
      }`}>
        {item.icon}
      </span>
      <span className="relative z-10 flex-1">{item.label}</span>
      
      {isActive && (
        <span className="relative z-10 w-2 h-2 rounded-full bg-[#7cb342]" />
      )}
    </button>
  );
};

export default MemberMenuOverlay;

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { haptic } from '../utils/haptics';

interface MenuOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

const MenuOverlay: React.FC<MenuOverlayProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const { effectiveTheme } = useTheme();
  const { startNavigation } = useNavigationLoading();
  const isDark = effectiveTheme === 'dark';
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
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
        className={`relative w-[85%] md:w-[320px] lg:w-[320px] h-full flex flex-col overflow-hidden rounded-tr-xl border-l-0 ${isDark ? 'bg-[#141414]' : 'bg-[#F2F2EC]'} backdrop-blur-xl ${isClosing ? 'animate-slide-out-left' : 'animate-slide-in-left'}`}
      >
        
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none mix-blend-multiply"></div>

        <div className={`relative z-10 flex flex-col lg:w-[320px] py-8 px-8 safe-area-inset-menu pb-[calc(2rem+env(safe-area-inset-bottom,0px)+100px)] ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`} style={{ height: 'calc(100% - 100px)' }}>
            
            <div className="flex items-center justify-between mb-10">
                <button 
                  onClick={() => handleNav('/')}
                  aria-label="Go to home"
                  className="w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center transition-transform duration-normal rounded-full active:scale-90 hover:scale-105"
                >
                  <img 
                    src={isDark ? "/assets/logos/mascot-white.webp" : "/assets/logos/mascot-dark.webp"}
                    alt="Ever Club mascot character"
                    className="h-10 w-auto object-contain"
                  />
                </button>
                <button 
                  onClick={handleClose}
                  aria-label="Close menu"
                  className={`w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center hover:rotate-90 transition-transform duration-normal rounded-full active:scale-90 tactile-btn ${isDark ? 'text-[#F2F2EC] hover:bg-white/10' : 'text-[#293515] hover:bg-black/5'}`}
                >
                    <span className="material-symbols-outlined text-3xl">close</span>
                </button>
            </div>
            
            <nav
              className="flex flex-col gap-0 flex-1 overflow-y-auto scrollbar-hide py-4"
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
                <MenuLink label="Membership" onClick={() => handleNav('/membership')} staggerIndex={0} isDark={isDark} scrollingRef={scrollingRef} />
                <MenuLink label="Cafe" onClick={() => handleNav('/menu')} staggerIndex={1} isDark={isDark} scrollingRef={scrollingRef} />
                <MenuLink label="Host Events" onClick={() => handleNav('/private-hire')} staggerIndex={2} isDark={isDark} scrollingRef={scrollingRef} />
                <MenuLink label="What's On" onClick={() => handleNav('/whats-on')} staggerIndex={3} isDark={isDark} scrollingRef={scrollingRef} />
                <MenuLink label="Gallery" onClick={() => handleNav('/gallery')} staggerIndex={4} isDark={isDark} scrollingRef={scrollingRef} />
                <MenuLink label="FAQ" onClick={() => handleNav('/faq')} staggerIndex={5} isDark={isDark} scrollingRef={scrollingRef} />
            </nav>
            
            <div className={`mt-4 pt-6 border-t animate-slide-up-stagger ${isDark ? 'border-[#F2F2EC]/10' : 'border-[#293515]/10'}`} style={{ '--stagger-index': 6 } as React.CSSProperties}>
                <button 
                    onClick={() => handleNav('/contact')}
                    style={{ fontFamily: 'var(--font-label)' }}
                    className={`w-full group flex items-center justify-between px-4 py-3 min-h-[44px] rounded-[4px] glass-button border tactile-btn ${isDark ? 'border-white/20' : 'border-black/20'}`}
                >
                    <span className={`text-sm uppercase tracking-[0.3em] font-semibold ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`}>Contact Us</span>
                    <span className="w-11 h-11 min-w-[44px] min-h-[44px] rounded-full glass-button flex items-center justify-center group-hover:scale-110 transition-all duration-[400ms] ease-in-out">
                        <span className={`material-symbols-outlined ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`}>arrow_forward</span>
                    </span>
                </button>
            </div>
        </div>
      </div>
    </div>
  );

  return createPortal(menuContent, document.body);
};

interface MenuLinkProps {
  label: string;
  onClick: () => void;
  staggerIndex: number;
  isDark: boolean;
  scrollingRef: React.MutableRefObject<boolean>;
}

const MenuLink: React.FC<MenuLinkProps> = ({ label, onClick, staggerIndex, isDark, scrollingRef }) => {
  const handleClick = () => {
    if (scrollingRef.current) return;
    onClick();
  };

  return (
    <button 
      type="button"
      onClick={handleClick}
      style={{ '--stagger-index': staggerIndex, touchAction: 'pan-y', animationFillMode: 'both', fontFamily: 'var(--font-label)' } as React.CSSProperties}
      className={`text-left text-sm uppercase tracking-[0.3em] font-medium py-4 transition-all duration-normal animate-slide-up-stagger leading-none min-h-[44px] hoverable-translate active:translate-x-2 tactile-row ${isDark ? 'text-[#F2F2EC]/70 hover:text-[#F2F2EC]' : 'text-[#293515]/70 hover:text-[#293515]'}`}
    >
      {label}
    </button>
  );
};

export default MenuOverlay;

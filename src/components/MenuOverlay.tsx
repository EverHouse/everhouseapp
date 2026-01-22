import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';
import { haptic } from '../utils/haptics';

interface MenuOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

const MenuOverlay: React.FC<MenuOverlayProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setIsVisible(true);
      setIsClosing(false);
    } else if (isVisible) {
      setIsClosing(true);
      timerRef.current = setTimeout(() => {
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
  }, [isOpen, isVisible]);

  useScrollLockManager(isVisible);

  const handleClose = () => {
    haptic.selection();
    onClose();
  };

  const handleNav = (path: string) => {
    haptic.light();
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
      ></div>

      <div 
        className={`relative w-[85%] md:w-[320px] lg:w-[320px] h-full flex flex-col overflow-hidden rounded-tr-[2rem] border-l-0 ${isDark ? 'bg-[#0f120a]' : 'bg-[#F2F2EC]'} backdrop-blur-xl ${isClosing ? 'animate-slide-out-left' : 'animate-slide-in-left'}`}
      >
        
        <div className="absolute inset-0 opacity-[0.03] bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] pointer-events-none mix-blend-multiply"></div>

        <div className={`relative z-10 flex flex-col lg:w-[320px] py-8 safe-area-inset-menu pb-[calc(2rem+env(safe-area-inset-bottom,0px)+100px)] ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`} style={{ height: 'calc(100% - 100px)' }}>
            
            <div className="flex items-center justify-between mb-8">
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
            
            <nav className="flex flex-col gap-4 flex-1 overflow-y-auto scrollbar-hide py-2">
                <MenuLink label="Membership" onClick={() => handleNav('/membership')} delay="0.05s" isDark={isDark} />
                <MenuLink label="Cafe" onClick={() => handleNav('/menu')} delay="0.1s" isDark={isDark} />
                <MenuLink label="Host Events" onClick={() => handleNav('/private-hire')} delay="0.15s" isDark={isDark} />
                <MenuLink label="What's On" onClick={() => handleNav('/whats-on')} delay="0.2s" isDark={isDark} />
                <MenuLink label="Gallery" onClick={() => handleNav('/gallery')} delay="0.25s" isDark={isDark} />
                <MenuLink label="FAQ" onClick={() => handleNav('/faq')} delay="0.3s" isDark={isDark} />
            </nav>
            
            <div className={`mt-4 pt-6 border-t animate-pop-in ${isDark ? 'border-[#F2F2EC]/10' : 'border-[#293515]/10'}`} style={{ animationDelay: '0.4s' }}>
                <button 
                    onClick={() => handleNav('/contact')}
                    className={`w-full group flex items-center justify-between px-4 py-3 min-h-[44px] rounded-[2rem] glass-button border ${isDark ? 'border-white/20' : 'border-black/20'}`}
                >
                    <span className={`text-xl font-bold ${isDark ? 'text-[#F2F2EC]' : 'text-[#293515]'}`}>Contact Us</span>
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
  delay: string;
  isDark: boolean;
}

const MenuLink: React.FC<MenuLinkProps> = ({ label, onClick, delay, isDark }) => {
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
      style={{ touchAction: 'manipulation', animationDelay: delay, animationFillMode: 'both' }}
      className={`text-left text-[24px] font-display font-medium transition-all duration-300 tracking-tight animate-pop-in leading-tight min-h-[44px] hoverable-translate active:translate-x-2 ${isDark ? 'text-[#F2F2EC] hover:text-[#F2F2EC]/80' : 'text-[#293515] hover:text-[#293515]/80'}`}
    >
      {label}
    </button>
  );
};

export default MenuOverlay;

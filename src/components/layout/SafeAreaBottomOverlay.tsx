import React from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../../contexts/BottomNavContext';

interface SafeAreaBottomOverlayProps {
  children: React.ReactNode;
}

export const SafeAreaBottomOverlay: React.FC<SafeAreaBottomOverlayProps> = ({ children }) => {
  const overlayRoot = document.getElementById('nav-overlay-root');
  const { isAtBottom, drawerOpen } = useBottomNav();
  
  if (!overlayRoot) return null;
  
  const overlayContent = (
    <div 
      className={`fixed inset-x-0 bottom-0 pointer-events-none transition-transform duration-300 ease-out lg:hidden ${isAtBottom || drawerOpen ? 'translate-y-[calc(100%+env(safe-area-inset-bottom,0px))]' : 'translate-y-0'}`}
      style={{ zIndex: 'var(--z-nav)' }}
    >
      <div 
        className="absolute bottom-full left-0 right-0 h-16 pointer-events-none"
        style={{ 
          background: 'linear-gradient(to top, var(--nav-fade-color, transparent) 0%, transparent 100%)'
        }}
      />
      {children}
      <div 
        className="w-full pointer-events-none dark:bg-[#0f120a] bg-bone"
        style={{ 
          height: 'env(safe-area-inset-bottom, 0px)'
        }}
      />
    </div>
  );
  
  return createPortal(overlayContent, overlayRoot);
};

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
  
  const isHidden = isAtBottom || drawerOpen;
  
  const overlayContent = (
    <div 
      className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ zIndex: 'var(--z-nav)' }}
    >
      <div
        className={`transition-[opacity,visibility] duration-normal ease-out ${isHidden ? 'opacity-0 pointer-events-none invisible' : 'opacity-100 visible'}`}
      >
        {children}
      </div>
      <div 
        className="w-full pointer-events-none bg-transparent"
        style={{ 
          height: 'env(safe-area-inset-bottom, 0px)'
        }}
      />
    </div>
  );
  
  return createPortal(overlayContent, overlayRoot);
};

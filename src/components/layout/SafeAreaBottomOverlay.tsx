import React from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../../contexts/BottomNavContext';

interface SafeAreaBottomOverlayProps {
  children: React.ReactNode;
}

export const SafeAreaBottomOverlay: React.FC<SafeAreaBottomOverlayProps> = ({ children }) => {
  const overlayRoot = document.getElementById('nav-overlay-root');
  const { isAtBottom } = useBottomNav();
  
  if (!overlayRoot) return null;
  
  const overlayContent = (
    <div 
      className={`fixed inset-x-0 bottom-0 pointer-events-none transition-transform duration-300 ease-out ${isAtBottom ? 'translate-y-[calc(100%+env(safe-area-inset-bottom,0px))]' : 'translate-y-0'}`}
      style={{ zIndex: 'var(--z-nav)' }}
    >
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

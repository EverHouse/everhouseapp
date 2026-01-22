import React from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../../contexts/BottomNavContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useLocation } from 'react-router-dom';

interface SafeAreaBottomOverlayProps {
  children: React.ReactNode;
}

export const SafeAreaBottomOverlay: React.FC<SafeAreaBottomOverlayProps> = ({ children }) => {
  const overlayRoot = document.getElementById('nav-overlay-root');
  const { isAtBottom, drawerOpen } = useBottomNav();
  const { effectiveTheme } = useTheme();
  const location = useLocation();
  
  if (!overlayRoot) return null;
  
  const isHidden = isAtBottom || drawerOpen;
  const isMemberRoute = ['/dashboard', '/book', '/member-events', '/member-wellness', '/profile', '/updates', '/history'].some(path => location.pathname.startsWith(path));
  const isAdminRoute = location.pathname.startsWith('/admin');
  const isDark = (isAdminRoute || isMemberRoute) && effectiveTheme === 'dark';
  
  const gradientColor = isDark ? 'rgba(15, 18, 10, 0.9)' : 'rgba(242, 242, 236, 0.9)';
  
  const overlayContent = (
    <div 
      className={`fixed inset-x-0 bottom-0 pointer-events-none transition-all duration-300 ease-out lg:hidden ${isHidden ? 'translate-y-[calc(100%+env(safe-area-inset-bottom,0px))] opacity-0' : 'translate-y-0 opacity-100'}`}
      style={{ zIndex: 'var(--z-nav)' }}
    >
      <div className="relative">
        <div 
          className="absolute inset-x-0 bottom-full h-24 pointer-events-none"
          style={{ 
            background: `linear-gradient(to bottom, transparent 0%, ${gradientColor} 100%)`
          }}
        />
        <div className="relative" style={{ zIndex: 1 }}>
          {children}
        </div>
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

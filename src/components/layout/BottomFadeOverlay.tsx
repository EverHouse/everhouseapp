import React from 'react';

interface BottomFadeOverlayProps {
  isDark?: boolean;
}

export const BottomFadeOverlay: React.FC<BottomFadeOverlayProps> = ({ isDark = false }) => {
  return (
    <div 
      className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ 
        zIndex: 'var(--z-nav)',
        height: '80px',
        background: isDark 
          ? 'linear-gradient(to bottom, rgba(15, 18, 10, 0) 0%, rgba(15, 18, 10, 0.4) 50%, rgba(15, 18, 10, 0.7) 100%)'
          : 'linear-gradient(to bottom, rgba(242, 242, 236, 0) 0%, rgba(242, 242, 236, 0.5) 50%, rgba(242, 242, 236, 0.85) 100%)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        maskImage: 'linear-gradient(to bottom, transparent 0%, black 30%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 30%)',
      }}
    />
  );
};

export default BottomFadeOverlay;

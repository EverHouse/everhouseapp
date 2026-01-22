import React from 'react';

interface BottomFadeOverlayProps {
  isDark?: boolean;
}

export const BottomFadeOverlay: React.FC<BottomFadeOverlayProps> = ({ isDark = false }) => {
  return (
    <div 
      className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ 
        zIndex: 8400,
        height: '100px',
        background: isDark 
          ? 'linear-gradient(to bottom, rgba(15, 18, 10, 0) 0%, rgba(15, 18, 10, 0.3) 30%, rgba(15, 18, 10, 0.7) 60%, rgba(15, 18, 10, 1) 100%)'
          : 'linear-gradient(to bottom, rgba(242, 242, 236, 0) 0%, rgba(242, 242, 236, 0.3) 30%, rgba(242, 242, 236, 0.7) 60%, rgba(242, 242, 236, 1) 100%)',
      }}
    />
  );
};

export default BottomFadeOverlay;

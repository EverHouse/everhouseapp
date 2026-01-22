import React from 'react';

interface BottomFadeOverlayProps {
  isDark?: boolean;
  variant?: 'colored' | 'shadow';
}

export const BottomFadeOverlay: React.FC<BottomFadeOverlayProps> = ({ isDark = false, variant = 'colored' }) => {
  if (variant === 'shadow') {
    return null;
  }

  const color = isDark ? '15, 18, 10' : '242, 242, 236';
  
  return (
    <div 
      className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ 
        zIndex: 8400,
        height: '80px',
        background: `linear-gradient(to top, rgba(${color}, 1) 0%, rgba(${color}, 0.85) 15%, rgba(${color}, 0.5) 35%, rgba(${color}, 0.15) 55%, rgba(${color}, 0.03) 75%, transparent 100%)`,
      }}
    />
  );
};

export default BottomFadeOverlay;

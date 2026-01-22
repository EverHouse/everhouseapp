import React from 'react';

interface BottomFadeOverlayProps {
  isDark?: boolean;
  variant?: 'colored' | 'shadow';
}

export const BottomFadeOverlay: React.FC<BottomFadeOverlayProps> = ({ isDark = false, variant = 'colored' }) => {
  if (variant === 'shadow') {
    return (
      <div 
        className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
        style={{ 
          zIndex: 8400,
          height: '80px',
          background: 'linear-gradient(to top, rgba(0, 0, 0, 0.08) 0%, rgba(0, 0, 0, 0.04) 40%, transparent 100%)',
        }}
      />
    );
  }

  const color = isDark ? '15, 18, 10' : '242, 242, 236';
  
  return (
    <div 
      className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ 
        zIndex: 8400,
        height: '100px',
        background: `linear-gradient(to top, rgba(${color}, 0.9) 0%, rgba(${color}, 0.7) 20%, rgba(${color}, 0.4) 40%, rgba(${color}, 0.1) 60%, transparent 80%)`,
      }}
    />
  );
};

export default BottomFadeOverlay;

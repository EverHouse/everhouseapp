import React from 'react';

interface BottomFadeOverlayProps {
  isDark?: boolean;
  variant?: 'colored' | 'shadow';
}

export const BottomFadeOverlay: React.FC<BottomFadeOverlayProps> = ({ isDark = false, variant = 'colored' }) => {
  const getGradient = () => {
    if (variant === 'shadow') {
      return 'linear-gradient(to top, rgba(0, 0, 0, 0.12) 0%, rgba(0, 0, 0, 0.08) 25%, rgba(0, 0, 0, 0.02) 50%, transparent 75%)';
    }
    
    const color = isDark ? '15, 18, 10' : '242, 242, 236';
    return `linear-gradient(to top, rgba(${color}, 0.85) 0%, rgba(${color}, 0.6) 15%, rgba(${color}, 0.25) 25%, rgba(${color}, 0.05) 40%, transparent 75%)`;
  };

  return (
    <div 
      className="fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ 
        zIndex: 8400,
        height: '120px',
        background: getGradient(),
        backdropFilter: variant === 'colored' ? 'blur(1px)' : undefined,
        WebkitBackdropFilter: variant === 'colored' ? 'blur(1px)' : undefined,
        maskImage: variant === 'colored' 
          ? 'linear-gradient(to top, black 0%, black 25%, transparent 100%)'
          : undefined,
        WebkitMaskImage: variant === 'colored'
          ? 'linear-gradient(to top, black 0%, black 25%, transparent 100%)'
          : undefined,
      }}
    />
  );
};

export default BottomFadeOverlay;

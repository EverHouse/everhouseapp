import React from 'react';
import { haptic } from '../utils/haptics';

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  isDark?: boolean;
}

const TabButton: React.FC<TabButtonProps> = ({ label, active, onClick, isDark = true }) => {
  const handleClick = () => {
    if (import.meta.env.DEV) {
      console.log(`[TabButton] click fired for "${label}"`);
    }
    haptic.light();
    onClick();
  };

  return (
    <button 
      type="button"
      onClick={handleClick}
      style={{ touchAction: 'manipulation' }}
      className={`pb-3 border-b-[3px] text-sm whitespace-nowrap flex-shrink-0 transition-colors min-h-[44px] ${
        active 
          ? (isDark ? 'border-white text-white font-bold' : 'border-primary text-primary font-bold') 
          : (isDark ? 'border-transparent text-white/60 font-medium' : 'border-transparent text-primary/60 font-medium')
      }`}
    >
      {label}
    </button>
  );
};

export default TabButton;
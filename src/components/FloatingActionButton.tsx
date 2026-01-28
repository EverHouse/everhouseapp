import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../contexts/BottomNavContext';

export type FABColor = 'brand' | 'amber' | 'green' | 'purple' | 'red';

interface FloatingActionButtonProps {
  onClick: () => void;
  color?: FABColor;
  icon?: string;
  secondaryIcon?: string;
  label?: string;
}

const colorClasses: Record<FABColor, string> = {
  brand: 'bg-[#293515] dark:bg-[#CCB8E4] text-white dark:text-[#293515] backdrop-blur-xl border border-[#293515]/80 dark:border-[#CCB8E4]/80 shadow-lg',
  amber: 'bg-amber-500/50 dark:bg-amber-400/50 text-white dark:text-gray-900 backdrop-blur-xl border border-white/30 dark:border-amber-300/50 shadow-[inset_0_1px_1px_rgba(255,255,255,0.3)]',
  green: 'bg-[#293515] dark:bg-[#CCB8E4] text-white dark:text-[#293515] backdrop-blur-xl border border-[#293515]/80 dark:border-[#CCB8E4]/80 shadow-lg',
  purple: 'bg-[#CCB8E4]/50 dark:bg-[#CCB8E4]/50 text-[#293515] dark:text-[#293515] backdrop-blur-xl border border-white/40 dark:border-white/50 shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)]',
  red: 'bg-red-600/50 dark:bg-red-500/50 text-white backdrop-blur-xl border border-white/30 dark:border-red-400/40 shadow-[inset_0_1px_1px_rgba(255,255,255,0.3)]',
};

const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
  onClick,
  color = 'brand',
  icon = 'add',
  secondaryIcon,
  label,
}) => {
  const { isAtBottom, drawerOpen } = useBottomNav();
  
  useEffect(() => {
    document.body.classList.add('has-fab');
    return () => {
      document.body.classList.remove('has-fab');
    };
  }, []);
  
  if (drawerOpen) return null;
  
  // On desktop (md+), position closer to bottom since there's no bottom nav
  // On mobile, use existing logic based on scroll position
  const mobileBottom = isAtBottom 
    ? 'calc(24px + env(safe-area-inset-bottom, 0px))' 
    : 'calc(140px + env(safe-area-inset-bottom, 0px))';
  
  const fabContent = (
    <button
      onClick={onClick}
      className={`fixed right-5 md:right-8 bottom-8 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ease-out hover:scale-110 active:scale-95 fab-button ${colorClasses[color]}`}
      style={{ 
        zIndex: 'var(--z-fab)',
        '--fab-mobile-bottom': mobileBottom,
      } as React.CSSProperties}
      aria-label={label || 'Add new item'}
    >
      {secondaryIcon ? (
        <div className="relative flex items-center justify-center w-full h-full">
          <span className="material-symbols-outlined text-2xl">{secondaryIcon}</span>
          <span className="material-symbols-outlined text-[10px] font-bold absolute -left-0.5 -top-0.5 text-inherit flex items-center justify-center">{icon}</span>
        </div>
      ) : (
        <span className="material-symbols-outlined text-2xl">{icon}</span>
      )}
    </button>
  );
  
  return createPortal(fabContent, document.body);
};

export default FloatingActionButton;

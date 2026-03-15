import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../contexts/BottomNavContext';
import { useScrollDirection } from '../hooks/useScrollDirection';

export type FABColor = 'brand' | 'amber' | 'green' | 'purple' | 'red';

interface FloatingActionButtonProps {
  onClick: () => void;
  color?: FABColor;
  icon?: string;
  secondaryIcon?: string;
  label?: string;
  extended?: boolean;
  text?: string;
}

const colorClasses: Record<FABColor, string> = {
  brand: 'fab-main-btn bg-[#293515]/50 dark:bg-[#CCB8E4]/50 text-white dark:text-white backdrop-blur-xl border border-white/15 dark:border-white/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]',
  amber: 'fab-main-btn bg-amber-500/50 dark:bg-amber-400/50 text-white dark:text-gray-900 backdrop-blur-xl border border-white/15 dark:border-amber-300/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]',
  green: 'fab-main-btn bg-[#293515]/50 dark:bg-[#CCB8E4]/50 text-white dark:text-white backdrop-blur-xl border border-white/15 dark:border-white/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]',
  purple: 'fab-main-btn bg-[#CCB8E4]/50 dark:bg-[#CCB8E4]/50 text-[#293515] dark:text-white backdrop-blur-xl border border-white/15 dark:border-white/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]',
  red: 'fab-main-btn bg-red-600/50 dark:bg-red-500/50 text-white backdrop-blur-xl border border-white/15 dark:border-red-400/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]',
};

const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
  onClick,
  color = 'brand',
  icon = 'add',
  secondaryIcon,
  label,
  extended = false,
  text,
}) => {
  const { isAtBottom, drawerOpen } = useBottomNav();
  const { direction, isAtTop } = useScrollDirection(extended);
  const [isExiting, setIsExiting] = useState(false);
  const [shouldRender, setShouldRender] = useState(!drawerOpen);
  const [collapsed, setCollapsed] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shouldCollapse = extended && direction === 'down' && !isAtTop;

  useEffect(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (shouldCollapse) {
      collapseTimerRef.current = setTimeout(() => {
        setCollapsed(true);
      }, 150);
    } else {
      setCollapsed(false);
    }
    return () => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
      }
    };
  }, [shouldCollapse]);

  useEffect(() => {
    const currentCount = parseInt(document.body.getAttribute('data-fab-count') || '0', 10);
    document.body.setAttribute('data-fab-count', String(currentCount + 1));
    return () => {
      const currentCount = parseInt(document.body.getAttribute('data-fab-count') || '0', 10);
      if (currentCount <= 1) {
        document.body.removeAttribute('data-fab-count');
      } else {
        document.body.setAttribute('data-fab-count', String(currentCount - 1));
      }
    };
  }, []);

  useEffect(() => {
    if (drawerOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsExiting(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsExiting(false);
      }, 100);
      return () => clearTimeout(timer);
    } else {
      setShouldRender(true);
      setIsExiting(false);
    }
  }, [drawerOpen]);

  if (!shouldRender) return null;
  
  const mobileBottom = isAtBottom 
    ? 'calc(24px + env(safe-area-inset-bottom, 0px))' 
    : 'calc(140px + env(safe-area-inset-bottom, 0px))';

  const isExpanded = extended && !collapsed;

  const iconContent = secondaryIcon ? (
    <div className="relative flex items-center justify-center w-6 h-6 shrink-0">
      <span className="material-symbols-outlined text-2xl">{secondaryIcon}</span>
      <span className="material-symbols-outlined text-[10px] font-bold absolute -left-0.5 -top-0.5 text-inherit flex items-center justify-center">{icon}</span>
    </div>
  ) : (
    <span className="material-symbols-outlined text-2xl shrink-0">{icon}</span>
  );

  const fabContent = (
    <button
      onClick={onClick}
      className={`fixed right-5 md:right-8 bottom-8 shadow-lg flex items-center justify-center hover:shadow-xl hover:brightness-110 dark:hover:brightness-110 active:scale-[0.97] fab-button ${isExiting ? '' : 'animate-fab-bounce-in'} ${colorClasses[color]} ${
        isExpanded
          ? 'min-h-[56px] px-4 gap-2 rounded-2xl'
          : 'w-14 h-14 rounded-full'
      }`}
      style={{ 
        zIndex: 'var(--z-fab)',
        '--fab-mobile-bottom': mobileBottom,
        transition: 'width 0.35s var(--m3-standard), border-radius 0.35s var(--m3-standard), padding 0.35s var(--m3-standard), gap 0.35s var(--m3-standard), transform 0.1s var(--m3-standard), box-shadow 0.2s var(--m3-standard), opacity 0.1s var(--m3-standard)',
        ...(isExiting ? { transform: 'scale(0.8)', opacity: 0 } : {}),
      } as React.CSSProperties}
      aria-label={isExpanded && text ? text : label || 'Add new item'}
    >
      {iconContent}
      {extended && (
        <span
          className="text-sm font-semibold whitespace-nowrap overflow-hidden"
          style={{
            display: 'grid',
            gridTemplateColumns: isExpanded ? '1fr' : '0fr',
            opacity: isExpanded ? 1 : 0,
            transition: 'grid-template-columns 0.35s var(--m3-standard), opacity 0.25s var(--m3-standard)',
          }}
        >
          <span className="overflow-hidden">{text}</span>
        </span>
      )}
    </button>
  );
  
  return createPortal(fabContent, document.body);
};

export default FloatingActionButton;

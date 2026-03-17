import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../stores/bottomNavStore';
import { useScrollDirection } from '../hooks/useScrollDirection';

interface BackToTopProps {
  threshold?: number;
  className?: string;
}

const FAB_HEIGHT = 56;
const BTT_SIZE = 48;
const FAB_GAP = 12;
const CENTER_OFFSET = (FAB_HEIGHT - BTT_SIZE) / 2;

const BackToTop: React.FC<BackToTopProps> = ({ 
  threshold = 300,
  className = '' 
}) => {
  const { isAtBottom } = useBottomNav();
  const { direction, isAtTop } = useScrollDirection();
  const [hasFab, setHasFab] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [hasBottomNav, setHasBottomNav] = useState(false);
  const [pastThreshold, setPastThreshold] = useState(false);

  useEffect(() => {
    const checkFab = () => setHasFab(parseInt(document.body.getAttribute('data-fab-count') || '0', 10) > 0);
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    const checkBottomNav = () => setHasBottomNav(
      !!document.querySelector('.staff-bottom-nav, .member-bottom-nav')
    );
    
    checkFab();
    checkMobile();
    checkBottomNav();

    const fabObserver = new MutationObserver(checkFab);
    fabObserver.observe(document.body, { attributes: true, attributeFilter: ['data-fab-count'] });

    const navCheckInterval = setInterval(checkBottomNav, 2000);
    window.addEventListener('resize', checkMobile);

    return () => {
      fabObserver.disconnect();
      clearInterval(navCheckInterval);
      window.removeEventListener('resize', checkMobile);
    };
  }, []);

  useEffect(() => {
    const checkThreshold = () => {
      setPastThreshold(window.scrollY > threshold);
    };

    window.addEventListener('scroll', checkThreshold, { passive: true });
    checkThreshold();

    return () => {
      window.removeEventListener('scroll', checkThreshold);
    };
  }, [threshold]);

  const isVisible = pastThreshold && !isAtTop && direction === 'up';

  const handleClick = useCallback(() => {
    document.body.setAttribute('data-programmatic-scroll', 'true');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const clearFlag = () => {
      if (window.scrollY <= 0) {
        document.body.removeAttribute('data-programmatic-scroll');
        window.removeEventListener('scroll', clearFlag);
        clearTimeout(fallbackTimer);
      }
    };
    window.addEventListener('scroll', clearFlag, { passive: true });
    const fallbackTimer = setTimeout(() => {
      document.body.removeAttribute('data-programmatic-scroll');
      window.removeEventListener('scroll', clearFlag);
    }, 1500);
  }, []);

  let bottomValue: string;
  let rightValue: string;

  if (isMobile) {
    rightValue = hasFab ? `${20 + CENTER_OFFSET}px` : '1.25rem';
    if (hasFab) {
      const fabBottom = isAtBottom ? 24 : 140;
      bottomValue = `calc(${fabBottom}px + env(safe-area-inset-bottom, 0px) + ${FAB_HEIGHT + FAB_GAP}px)`;
    } else if (hasBottomNav) {
      const fabBottom = isAtBottom ? 24 : 140;
      bottomValue = `calc(${fabBottom}px + env(safe-area-inset-bottom, 0px))`;
    } else {
      bottomValue = 'calc(24px + env(safe-area-inset-bottom, 0px))';
    }
  } else {
    rightValue = hasFab ? `${32 + CENTER_OFFSET}px` : '1.25rem';
    bottomValue = hasFab
      ? 'calc(env(safe-area-inset-bottom, 0px) + 100px)'
      : 'calc(env(safe-area-inset-bottom, 0px) + 24px)';
  }

  const content = (
    <div
      className={`back-to-top ${isVisible ? 'visible' : ''} ${className}`}
      style={{ bottom: bottomValue, right: rightValue }}
    >
      <button
        onClick={handleClick}
        className="glass-button bg-black/80 dark:bg-black/70 text-white hover:scale-110 active:scale-95 transition-all duration-normal min-w-[44px] min-h-[44px] w-12 h-12 flex items-center justify-center shadow-lg"
        aria-label="Back to top"
        tabIndex={isVisible ? 0 : -1}
        aria-hidden={!isVisible}
      >
        <span className="material-symbols-outlined text-xl text-[#293515] dark:text-white">keyboard_arrow_up</span>
      </button>
    </div>
  );

  return createPortal(content, document.body);
};

export default BackToTop;

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBottomNav } from '../contexts/BottomNavContext';

interface BackToTopProps {
  threshold?: number;
  className?: string;
}

const SCROLL_DOWN_TOLERANCE = 50;
const FAB_HEIGHT = 56;
const BTT_SIZE = 48;
const FAB_GAP = 12;
const CENTER_OFFSET = (FAB_HEIGHT - BTT_SIZE) / 2;

const BackToTop: React.FC<BackToTopProps> = ({ 
  threshold = 300,
  className = '' 
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const { isAtBottom } = useBottomNav();
  const lastScrollY = useRef(0);
  const showRef = useRef(false);
  const [hasFab, setHasFab] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [hasBottomNav, setHasBottomNav] = useState(false);

  useEffect(() => {
    const checkFab = () => setHasFab(document.body.classList.contains('has-fab'));
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    const checkBottomNav = () => setHasBottomNav(
      !!document.querySelector('.staff-bottom-nav, .member-bottom-nav')
    );
    
    checkFab();
    checkMobile();
    checkBottomNav();

    const fabObserver = new MutationObserver(checkFab);
    fabObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const navObserver = new MutationObserver(() => {
      requestAnimationFrame(checkBottomNav);
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', checkMobile);

    return () => {
      fabObserver.disconnect();
      navObserver.disconnect();
      window.removeEventListener('resize', checkMobile);
    };
  }, []);

  useEffect(() => {
    const getScrollTop = () => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      return Math.max(window.scrollY, scrollingElement.scrollTop);
    };

    const handleScroll = () => {
      const current = getScrollTop();
      const belowThreshold = current > threshold;

      if (!belowThreshold) {
        showRef.current = false;
        setIsVisible(false);
      } else if (current < lastScrollY.current) {
        showRef.current = true;
        setIsVisible(true);
      } else if (showRef.current && current - lastScrollY.current > SCROLL_DOWN_TOLERANCE) {
        showRef.current = false;
        setIsVisible(false);
      }

      lastScrollY.current = current;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('scroll', handleScroll);
    };
  }, [threshold]);

  const handleClick = useCallback(() => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    scrollingElement.scrollTo({ top: 0, behavior: 'smooth' });
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
    rightValue = hasFab ? `${20 + CENTER_OFFSET}px` : '1.25rem';
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

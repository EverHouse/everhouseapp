import React, { useState, useEffect, useCallback } from 'react';
import { useBottomNav } from '../contexts/BottomNavContext';

interface BackToTopProps {
  threshold?: number;
  className?: string;
}

const BackToTop: React.FC<BackToTopProps> = ({ 
  threshold = 200,
  className = '' 
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const { isAtBottom } = useBottomNav();

  useEffect(() => {
    const getScrollTop = () => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      return Math.max(window.scrollY, scrollingElement.scrollTop);
    };

    const handleScroll = () => {
      setIsVisible(getScrollTop() > threshold);
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

  const showWithNav = !isAtBottom;

  return (
    <div className={`back-to-top ${isVisible ? 'visible' : ''} ${showWithNav ? 'with-nav' : ''} ${className}`}>
      <button
        onClick={handleClick}
        className="glass-button bg-black/80 dark:bg-black/70 text-white hover:scale-110 active:scale-95 transition-all duration-300 min-w-[44px] min-h-[44px] w-12 h-12 flex items-center justify-center shadow-lg"
        aria-label="Scroll to top"
      >
        <span className="material-symbols-outlined text-xl text-[#293515] dark:text-white">keyboard_arrow_up</span>
      </button>
    </div>
  );
};

export default BackToTop;

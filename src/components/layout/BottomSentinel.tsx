import React, { useRef, useEffect, useCallback } from 'react';
import { useBottomNav } from '../../contexts/BottomNavContext';

export const BottomSentinel: React.FC = () => {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { setIsAtBottom } = useBottomNav();
  const lastScrollY = useRef(0);
  const lastTouchY = useRef(0);
  const isHiddenRef = useRef(false);
  const SCROLL_THRESHOLD = 50;
  const rafRef = useRef<number | null>(null);
  
  const updateNavVisibility = useCallback((scrollDelta: number, currentScrollY: number) => {
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = window.innerHeight;
    const isScrollable = scrollHeight > clientHeight + 100;
    
    if (isScrollable) {
      if (scrollDelta > 8 && currentScrollY > SCROLL_THRESHOLD) {
        if (!isHiddenRef.current) {
          isHiddenRef.current = true;
          setIsAtBottom(true);
        }
      } else if (scrollDelta < -8) {
        if (isHiddenRef.current) {
          isHiddenRef.current = false;
          setIsAtBottom(false);
        }
      }
    } else if (isHiddenRef.current) {
      isHiddenRef.current = false;
      setIsAtBottom(false);
    }
  }, [setIsAtBottom]);
  
  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    
    rafRef.current = requestAnimationFrame(() => {
      const currentScrollY = window.scrollY;
      const scrollDelta = currentScrollY - lastScrollY.current;
      
      updateNavVisibility(scrollDelta, currentScrollY);
      lastScrollY.current = currentScrollY;
      rafRef.current = null;
    });
  }, [updateNavVisibility]);
  
  const handleTouchStart = useCallback((e: TouchEvent) => {
    lastTouchY.current = e.touches[0].clientY;
  }, []);
  
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (rafRef.current) return;
    
    rafRef.current = requestAnimationFrame(() => {
      const currentTouchY = e.touches[0].clientY;
      const touchDelta = lastTouchY.current - currentTouchY;
      const currentScrollY = window.scrollY;
      
      updateNavVisibility(touchDelta, currentScrollY);
      lastTouchY.current = currentTouchY;
      rafRef.current = null;
    });
  }, [updateNavVisibility]);
  
  useEffect(() => {
    lastScrollY.current = window.scrollY;
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      setIsAtBottom(false);
    };
  }, [handleScroll, handleTouchStart, handleTouchMove, setIsAtBottom]);
  
  return <div ref={sentinelRef} className="h-24 w-full pointer-events-none" aria-hidden="true" />;
};

import { useEffect, useRef } from 'react';

let lockCount = 0;

function lockScroll(scrollY: number) {
  lockCount++;
  if (lockCount === 1) {
    document.documentElement.classList.add('overflow-hidden');
    document.body.classList.add('overflow-hidden');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overscrollBehavior = 'none';
  }
}

function unlockScroll(scrollY: number) {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.documentElement.classList.remove('overflow-hidden');
    document.body.classList.remove('overflow-hidden');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.overscrollBehavior = '';
    window.scrollTo(0, scrollY);
  }
}

export function useScrollLock(isLocked: boolean, onEscape?: () => void) {
  const scrollYRef = useRef(0);
  const wasLockedRef = useRef(false);

  useEffect(() => {
    if (isLocked && !wasLockedRef.current) {
      scrollYRef.current = window.scrollY;
      lockScroll(scrollYRef.current);
      wasLockedRef.current = true;
    } else if (!isLocked && wasLockedRef.current) {
      unlockScroll(scrollYRef.current);
      wasLockedRef.current = false;
    }

    return () => {
      if (wasLockedRef.current) {
        unlockScroll(scrollYRef.current);
        wasLockedRef.current = false;
      }
    };
  }, [isLocked]);

  useEffect(() => {
    if (!isLocked || !onEscape) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscape();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isLocked, onEscape]);
}

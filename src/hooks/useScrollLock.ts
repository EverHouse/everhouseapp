import { useEffect, useRef } from 'react';

export function useScrollLock(isLocked: boolean, onEscape?: () => void) {
  const scrollYRef = useRef(0);

  useEffect(() => {
    if (!isLocked) return;

    scrollYRef.current = window.scrollY;
    
    document.documentElement.classList.add('overflow-hidden');
    document.body.classList.add('overflow-hidden');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollYRef.current}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overscrollBehavior = 'none';

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        onEscape();
      }
    };

    if (onEscape) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      if (onEscape) {
        document.removeEventListener('keydown', handleEscape);
      }
      document.documentElement.classList.remove('overflow-hidden');
      document.body.classList.remove('overflow-hidden');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overscrollBehavior = '';
      window.scrollTo(0, scrollYRef.current);
    };
  }, [isLocked, onEscape]);
}

import { useRef, useCallback, useEffect } from 'react';

interface UseDragAutoScrollOptions {
  threshold?: number;
  maxSpeed?: number;
}

export function useDragAutoScroll(options: UseDragAutoScrollOptions = {}) {
  const { threshold = 120, maxSpeed = 400 } = options;
  
  const rafRef = useRef<number | null>(null);
  const scrollSpeedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  
  const scrollLoop = useCallback(() => {
    const now = performance.now();
    
    if (lastTimeRef.current !== null) {
      const deltaTime = (now - lastTimeRef.current) / 1000;
      const scrollAmount = scrollSpeedRef.current * deltaTime;
      
      if (Math.abs(scrollAmount) > 0.1) {
        window.scrollBy(0, scrollAmount);
      }
    }
    
    lastTimeRef.current = now;
    
    if (isDraggingRef.current) {
      rafRef.current = requestAnimationFrame(scrollLoop);
    }
  }, []);
  
  const updatePosition = useCallback((clientY: number) => {
    const viewportHeight = window.innerHeight;
    const distanceFromTop = clientY;
    const distanceFromBottom = viewportHeight - clientY;
    
    if (distanceFromTop < threshold) {
      const proximity = 1 - (distanceFromTop / threshold);
      scrollSpeedRef.current = -maxSpeed * proximity * proximity;
    } else if (distanceFromBottom < threshold) {
      const proximity = 1 - (distanceFromBottom / threshold);
      scrollSpeedRef.current = maxSpeed * proximity * proximity;
    } else {
      scrollSpeedRef.current = 0;
    }
  }, [threshold, maxSpeed]);
  
  const startAutoScroll = useCallback(() => {
    isDraggingRef.current = true;
    lastTimeRef.current = null;
    scrollSpeedRef.current = 0;
    scrollLoop();
  }, [scrollLoop]);
  
  const stopAutoScroll = useCallback(() => {
    isDraggingRef.current = false;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    scrollSpeedRef.current = 0;
    lastTimeRef.current = null;
  }, []);
  
  useEffect(() => {
    return () => stopAutoScroll();
  }, [stopAutoScroll]);
  
  return { startAutoScroll, updatePosition, stopAutoScroll };
}

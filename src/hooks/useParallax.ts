import { useState, useEffect, useCallback, useRef } from 'react';

interface ParallaxOptions {
  speed?: number;
  direction?: 'up' | 'down';
  maxOffset?: number;
}

interface ParallaxResult {
  offset: number;
  opacity: number;
  gradientShift: number;
  ref: React.RefObject<HTMLElement | null>;
}

export function useParallax(options: ParallaxOptions = {}): ParallaxResult {
  const { speed = 0.3, direction = 'up', maxOffset = 150 } = options;
  const [offset, setOffset] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [gradientShift, setGradientShift] = useState(0);
  const ref = useRef<HTMLElement | null>(null);
  const ticking = useRef(false);

  const updatePosition = useCallback(() => {
    if (!ref.current) {
      ticking.current = false;
      return;
    }

    const rect = ref.current.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    
    if (rect.bottom < 0 || rect.top > windowHeight) {
      ticking.current = false;
      return;
    }

    const scrollProgress = Math.max(0, -rect.top);
    const rawOffset = scrollProgress * speed;
    const clampedOffset = Math.min(rawOffset, maxOffset);
    
    const finalOffset = direction === 'up' ? -clampedOffset : clampedOffset;
    setOffset(finalOffset);

    const fadeStart = windowHeight * 0.3;
    const fadeProgress = Math.max(0, scrollProgress - fadeStart) / (windowHeight * 0.4);
    const newOpacity = Math.max(0.3, 1 - fadeProgress * 0.5);
    setOpacity(newOpacity);

    const gradientProgress = Math.min(1, scrollProgress / (windowHeight * 0.8));
    setGradientShift(gradientProgress * 15);

    ticking.current = false;
  }, [speed, direction, maxOffset]);

  const handleScroll = useCallback(() => {
    if (!ticking.current) {
      ticking.current = true;
      requestAnimationFrame(updatePosition);
    }
  }, [updatePosition]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    updatePosition();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll, updatePosition]);

  return { offset, opacity, gradientShift, ref };
}

export function useScrollProgress(): number {
  const [progress, setProgress] = useState(0);
  const ticking = useRef(false);

  const updateProgress = useCallback(() => {
    const scrollTop = window.scrollY;
    const windowHeight = window.innerHeight;
    const docHeight = document.documentElement.scrollHeight;
    const maxScroll = docHeight - windowHeight;
    
    const newProgress = maxScroll > 0 ? Math.min(1, scrollTop / maxScroll) : 0;
    setProgress(newProgress);
    ticking.current = false;
  }, []);

  const handleScroll = useCallback(() => {
    if (!ticking.current) {
      ticking.current = true;
      requestAnimationFrame(updateProgress);
    }
  }, [updateProgress]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    updateProgress();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll, updateProgress]);

  return progress;
}

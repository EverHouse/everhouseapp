import { useState, useEffect, useRef, RefObject } from 'react';

interface UseParallaxOptions {
  speed?: number;
  maxOffset?: number;
}

interface UseParallaxReturn {
  offset: number;
  opacity: number;
  gradientShift: number;
  ref: RefObject<HTMLElement>;
}

export function useParallax(options?: UseParallaxOptions): UseParallaxReturn {
  const [offset, setOffset] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [gradientShift, setGradientShift] = useState(0);
  const ref = useRef<HTMLElement | null>(null);

  const speed = options?.speed ?? 0.5;
  const maxOffset = options?.maxOffset ?? 200;

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const calculatedOffset = Math.min(scrollY * speed, maxOffset);
      setOffset(calculatedOffset);
      
      const viewportHeight = window.innerHeight;
      const fadeStart = viewportHeight * 0.2;
      const fadeEnd = viewportHeight * 0.8;
      const newOpacity = scrollY < fadeStart 
        ? 1 
        : scrollY > fadeEnd 
          ? 0.3 
          : 1 - ((scrollY - fadeStart) / (fadeEnd - fadeStart)) * 0.7;
      setOpacity(newOpacity);
      
      const maxGradientShift = 20;
      const gradientProgress = Math.min(scrollY / (viewportHeight * 0.5), 1);
      setGradientShift(gradientProgress * maxGradientShift);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [speed, maxOffset]);

  return { offset, opacity, gradientShift, ref: ref as React.RefObject<HTMLElement> };
}

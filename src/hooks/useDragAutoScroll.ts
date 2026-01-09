import { useRef, useCallback } from 'react';

const SCROLL_ZONE_SIZE = 80;
const SCROLL_SPEED = 8;

export function useDragAutoScroll() {
  const rafRef = useRef<number | null>(null);
  const scrollDirectionRef = useRef<'up' | 'down' | null>(null);

  const scrollStep = useCallback(() => {
    const direction = scrollDirectionRef.current;
    if (!direction) return;

    const delta = direction === 'up' ? -SCROLL_SPEED : SCROLL_SPEED;
    window.scrollBy(0, delta);

    rafRef.current = requestAnimationFrame(scrollStep);
  }, []);

  const startAutoScroll = useCallback(() => {
    scrollDirectionRef.current = null;
  }, []);

  const updatePosition = useCallback((clientY: number) => {
    const viewportHeight = window.innerHeight;
    const topZone = SCROLL_ZONE_SIZE;
    const bottomZone = viewportHeight - SCROLL_ZONE_SIZE;

    let newDirection: 'up' | 'down' | null = null;

    if (clientY < topZone) {
      newDirection = 'up';
    } else if (clientY > bottomZone) {
      newDirection = 'down';
    }

    if (newDirection !== scrollDirectionRef.current) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      scrollDirectionRef.current = newDirection;
      if (newDirection) {
        rafRef.current = requestAnimationFrame(scrollStep);
      }
    }
  }, [scrollStep]);

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    scrollDirectionRef.current = null;
  }, []);

  return { startAutoScroll, updatePosition, stopAutoScroll };
}

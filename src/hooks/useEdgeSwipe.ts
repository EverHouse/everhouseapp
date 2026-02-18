import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface EdgeSwipeConfig {
  edgeWidth?: number;
  threshold?: number;
  velocityThreshold?: number;
  enabled?: boolean;
  onBack?: () => void;
}

interface EdgeSwipeState {
  isActive: boolean;
  progress: number;
  startX: number;
  startY: number;
  currentX: number;
}

export function useEdgeSwipe(config: EdgeSwipeConfig = {}) {
  const {
    edgeWidth = 20,
    threshold = 100,
    velocityThreshold = 0.3,
    enabled = true,
    onBack
  } = config;

  const navigate = useNavigate();
  const [state, setState] = useState<EdgeSwipeState>({
    isActive: false,
    progress: 0,
    startX: 0,
    startY: 0,
    currentX: 0
  });

  const startTimeRef = useRef(0);
  const isHorizontalRef = useRef<boolean | null>(null);

  const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window;
  
  const isStandalonePWA = typeof window !== 'undefined' && 
    (window.matchMedia('(display-mode: standalone)').matches || 
     (window.navigator as unknown as { standalone?: boolean }).standalone === true);

  const handleStart = useCallback((clientX: number, clientY: number) => {
    if (!enabled || !isTouchDevice || isStandalonePWA) return;
    if (clientX <= edgeWidth) {
      setState({
        isActive: true,
        progress: 0,
        startX: clientX,
        startY: clientY,
        currentX: clientX
      });
      startTimeRef.current = Date.now();
      isHorizontalRef.current = null;
    }
  }, [enabled, edgeWidth, isTouchDevice, isStandalonePWA]);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!state.isActive) return;

    const deltaX = clientX - state.startX;
    const deltaY = clientY - state.startY;

    if (isHorizontalRef.current === null) {
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        isHorizontalRef.current = Math.abs(deltaX) > Math.abs(deltaY);
        if (!isHorizontalRef.current) {
          setState(prev => ({ ...prev, isActive: false, progress: 0 }));
          return;
        }
      }
    }

    if (isHorizontalRef.current && deltaX > 0) {
      const progress = Math.min(deltaX / threshold, 1);
      setState(prev => ({ ...prev, currentX: clientX, progress }));
    }
  }, [state.isActive, state.startX, state.startY, threshold]);

  const handleEnd = useCallback(() => {
    if (!state.isActive) return;

    const deltaX = state.currentX - state.startX;
    const durationMs = Date.now() - startTimeRef.current;
    
    const minDuration = 50;
    const safeDuration = Math.max(durationMs, minDuration) / 1000;
    const velocity = Math.min(deltaX / safeDuration / window.innerWidth, 2);

    const shouldNavigate = (deltaX >= threshold && durationMs > minDuration) || 
                           (velocity > velocityThreshold && deltaX > threshold * 0.5);

    if (shouldNavigate && isHorizontalRef.current) {
      if (onBack) {
        onBack();
      } else {
        navigate(-1);
      }
    }

    setState({
      isActive: false,
      progress: 0,
      startX: 0,
      startY: 0,
      currentX: 0
    });
    isHorizontalRef.current = null;
  }, [state.isActive, state.currentX, state.startX, threshold, velocityThreshold, navigate, onBack]);

  useEffect(() => {
    if (!enabled || !isTouchDevice || isStandalonePWA) return;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleStart(touch.clientX, touch.clientY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleMove(touch.clientX, touch.clientY);
    };

    const handleTouchEnd = () => handleEnd();

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [enabled, isTouchDevice, isStandalonePWA, handleStart, handleMove, handleEnd]);

  return {
    isActive: state.isActive,
    progress: state.progress
  };
}

export default useEdgeSwipe;

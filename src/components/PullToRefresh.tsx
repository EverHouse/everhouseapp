import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface PullToRefreshProps {
  children: React.ReactNode;
  onRefresh?: () => Promise<void> | void;
  disabled?: boolean;
  className?: string;
}

const PULL_THRESHOLD = 160;
const MAX_PULL = 240;
const HEADER_HEIGHT = 72;
const DESKTOP_SETTLE_DELAY = 300;

const isTouchDevice = () => {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

const PullToRefresh: React.FC<PullToRefreshProps> = ({ children, disabled = false, className = '' }) => {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFillingScreen, setIsFillingScreen] = useState(false);
  const [isSpringBack, setIsSpringBack] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isTouchCapable] = useState(() => isTouchDevice());
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number | null>(null);
  const isPullingRef = useRef(false);
  const wheelAccumulatorRef = useRef(0);
  const wheelTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isWheelPullingRef = useRef(false);
  const isSettledAtTopRef = useRef(false);
  const settleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const springBackAnimationRef = useRef<number | null>(null);

  useEffect(() => {
    const checkModalState = () => {
      const modalCount = document.body.getAttribute('data-modal-count');
      setIsModalOpen(modalCount !== null && parseInt(modalCount, 10) > 0);
    };
    
    checkModalState();
    
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-modal-count') {
          checkModalState();
          break;
        }
      }
    });
    
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-modal-count'] });
    
    return () => observer.disconnect();
  }, []);

  const animateSpringBack = useCallback((fromDistance: number) => {
    if (springBackAnimationRef.current) {
      cancelAnimationFrame(springBackAnimationRef.current);
    }
    
    setIsSpringBack(true);
    const startTime = performance.now();
    const duration = 280;
    
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const newDistance = fromDistance * (1 - easeOut);
      
      setPullDistance(newDistance);
      
      if (progress < 1) {
        springBackAnimationRef.current = requestAnimationFrame(animate);
      } else {
        setPullDistance(0);
        setIsSpringBack(false);
        springBackAnimationRef.current = null;
      }
    };
    
    springBackAnimationRef.current = requestAnimationFrame(animate);
  }, []);

  const triggerRefresh = useCallback(async () => {
    if (isRefreshing || isFillingScreen) return;
    
    wheelAccumulatorRef.current = 0;
    isWheelPullingRef.current = false;
    isSettledAtTopRef.current = false;
    setIsFillingScreen(true);
    setPullDistance(0);
    
    await new Promise(resolve => setTimeout(resolve, 350));
    
    setIsFillingScreen(false);
    setIsRefreshing(true);
    
    sessionStorage.setItem('ptr-reload', '1');
    window.location.reload();
  }, [isRefreshing, isFillingScreen]);

  useEffect(() => {
    if (!isTouchCapable) return;
    
    const container = containerRef.current;
    if (!container) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (disabled || isModalOpen || isRefreshing || isFillingScreen || isSpringBack) return;
      
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      
      if (scrollTop <= 5 && e.deltaY < 0) {
        if (!isSettledAtTopRef.current && !isWheelPullingRef.current) {
          if (settleTimeoutRef.current) {
            clearTimeout(settleTimeoutRef.current);
          }
          settleTimeoutRef.current = setTimeout(() => {
            isSettledAtTopRef.current = true;
          }, DESKTOP_SETTLE_DELAY);
          return;
        }
        
        if (!isSettledAtTopRef.current) return;
        
        wheelAccumulatorRef.current += Math.abs(e.deltaY) * 0.3;
        wheelAccumulatorRef.current = Math.min(wheelAccumulatorRef.current, MAX_PULL);
        isWheelPullingRef.current = true;
        
        setPullDistance(wheelAccumulatorRef.current);
        
        if (wheelTimeoutRef.current) {
          clearTimeout(wheelTimeoutRef.current);
        }
        wheelTimeoutRef.current = setTimeout(() => {
          if (wheelAccumulatorRef.current >= PULL_THRESHOLD && !isRefreshing && !isFillingScreen) {
            triggerRefresh();
          } else {
            const currentDistance = wheelAccumulatorRef.current;
            wheelAccumulatorRef.current = 0;
            isWheelPullingRef.current = false;
            if (currentDistance > 5) {
              animateSpringBack(currentDistance);
            } else {
              setPullDistance(0);
            }
          }
        }, 150);
      } else if (scrollTop > 5) {
        isSettledAtTopRef.current = false;
        if (settleTimeoutRef.current) {
          clearTimeout(settleTimeoutRef.current);
          settleTimeoutRef.current = null;
        }
        if (wheelAccumulatorRef.current > 0) {
          const currentDistance = wheelAccumulatorRef.current;
          wheelAccumulatorRef.current = 0;
          isWheelPullingRef.current = false;
          animateSpringBack(currentDistance);
        }
      } else if (e.deltaY > 0 && scrollTop <= 5) {
        if (wheelAccumulatorRef.current > 0) {
          const currentDistance = wheelAccumulatorRef.current;
          wheelAccumulatorRef.current = 0;
          isWheelPullingRef.current = false;
          animateSpringBack(currentDistance);
        }
      }
    };
    
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (wheelTimeoutRef.current) {
        clearTimeout(wheelTimeoutRef.current);
      }
      if (settleTimeoutRef.current) {
        clearTimeout(settleTimeoutRef.current);
      }
    };
  }, [isTouchCapable, disabled, isModalOpen, isRefreshing, isFillingScreen, isSpringBack, triggerRefresh, animateSpringBack]);

  const disabledRef = useRef(disabled);
  const isModalOpenRef = useRef(isModalOpen);
  const isRefreshingRef = useRef(isRefreshing);
  const isSpringBackRef = useRef(isSpringBack);
  const isFillingScreenRef = useRef(isFillingScreen);
  const pullDistanceRef = useRef(pullDistance);
  const animateSpringBackRef = useRef(animateSpringBack);

  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { isModalOpenRef.current = isModalOpen; }, [isModalOpen]);
  useEffect(() => { isRefreshingRef.current = isRefreshing; }, [isRefreshing]);
  useEffect(() => { isSpringBackRef.current = isSpringBack; }, [isSpringBack]);
  useEffect(() => { isFillingScreenRef.current = isFillingScreen; }, [isFillingScreen]);
  useEffect(() => { pullDistanceRef.current = pullDistance; }, [pullDistance]);
  useEffect(() => { animateSpringBackRef.current = animateSpringBack; }, [animateSpringBack]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isTouchCapable) return;

    const onTouchStart = (e: TouchEvent) => {
      if (disabledRef.current || isModalOpenRef.current || isRefreshingRef.current || isSpringBackRef.current) return;

      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      if (scrollTop <= 5) {
        startYRef.current = e.touches[0].clientY;
        isPullingRef.current = true;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isPullingRef.current || startYRef.current === null || disabledRef.current || isModalOpenRef.current || isRefreshingRef.current || isSpringBackRef.current) return;

      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      if (scrollTop > 5) {
        isPullingRef.current = false;
        const currentDistance = pullDistanceRef.current;
        if (currentDistance > 5) {
          animateSpringBackRef.current(currentDistance);
        } else {
          setPullDistance(0);
        }
        return;
      }

      const currentY = e.touches[0].clientY;
      const diff = currentY - startYRef.current;

      if (diff > 0) {
        const resistance = 0.33;
        const distance = Math.min(diff * resistance, MAX_PULL);
        setPullDistance(distance);

        if (distance > 10) {
          e.preventDefault();
        }
      } else {
        setPullDistance(0);
      }
    };

    const onTouchEnd = async () => {
      if (!isPullingRef.current || disabledRef.current || isModalOpenRef.current) return;

      isPullingRef.current = false;
      startYRef.current = null;
      const currentPullDistance = pullDistanceRef.current;

      if (currentPullDistance >= PULL_THRESHOLD && !isRefreshingRef.current && !isFillingScreenRef.current) {
        setIsFillingScreen(true);
        setPullDistance(0);

        await new Promise(resolve => setTimeout(resolve, 350));

        setIsFillingScreen(false);
        setIsRefreshing(true);

        sessionStorage.setItem('ptr-reload', '1');
        window.location.reload();
      } else {
        if (currentPullDistance > 5) {
          animateSpringBackRef.current(currentPullDistance);
        } else {
          setPullDistance(0);
        }
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, [isTouchCapable]);

  useEffect(() => {
    if (isRefreshing || isFillingScreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isRefreshing, isFillingScreen]);

  useEffect(() => {
    const pullProgress = Math.min(pullDistance / PULL_THRESHOLD, 1);
    if (pullDistance > 0 || isFillingScreen || isRefreshing) {
      document.body.setAttribute('data-ptr-active', 'true');
      document.body.style.setProperty('--ptr-progress', String(pullProgress));
    } else {
      document.body.removeAttribute('data-ptr-active');
      document.body.style.removeProperty('--ptr-progress');
    }
    return () => {
      document.body.removeAttribute('data-ptr-active');
      document.body.style.removeProperty('--ptr-progress');
    };
  }, [pullDistance, isFillingScreen, isRefreshing]);

  useEffect(() => {
    return () => {
      if (springBackAnimationRef.current) {
        cancelAnimationFrame(springBackAnimationRef.current);
      }
    };
  }, []);

  const pullProgress = Math.min(pullDistance / PULL_THRESHOLD, 1);
  const showPullBar = pullDistance > 5 && !isRefreshing && !isFillingScreen;
  const barHeight = HEADER_HEIGHT + pullDistance;

  return (
    <div
      ref={containerRef}
      className={`min-h-full ${className}`}
      style={isTouchCapable ? { touchAction: pullDistance > 0 ? 'none' : 'pan-y' } : undefined}
    >
      {showPullBar && createPortal(
        <div 
          className="ptr-pull-bar"
          style={{ 
            height: `${barHeight}px`,
            paddingTop: 'env(safe-area-inset-top, 0px)'
          }}
        >
          <div 
            className="ptr-pull-content"
            style={{
              opacity: pullProgress,
              transform: `scale(${0.7 + pullProgress * 0.3})`
            }}
          >
            <img 
              src="/assets/logos/walking-mascot-white.gif" 
              alt="" 
              className="ptr-pull-mascot"
            />
            {pullProgress >= 1 && (
              <span className="ptr-release-text">Release to refresh</span>
            )}
          </div>

          <style>{`
            .ptr-pull-bar {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              background-color: #293515;
              z-index: 9999;
              display: flex;
              align-items: flex-end;
              justify-content: center;
              padding-bottom: 12px;
              border-radius: 0 0 20px 20px;
              box-shadow: 0 4px 20px rgba(0,0,0,0.3);
              will-change: height;
            }

            .ptr-pull-content {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 6px;
              will-change: opacity, transform;
            }

            .ptr-pull-mascot {
              width: 56px;
              height: 56px;
              object-fit: contain;
            }

            .ptr-release-text {
              font-family: 'Instrument Sans', sans-serif;
              font-size: 12px;
              font-weight: 500;
              color: rgba(255,255,255,0.9);
              text-transform: uppercase;
              letter-spacing: 0.5px;
            }
          `}</style>
        </div>,
        document.body
      )}

      {isFillingScreen && createPortal(
        <div className="ptr-fill-overlay">
          <style>{`
            .ptr-fill-overlay {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background-color: #293515;
              z-index: 99999;
              animation: ptrFillScreen 0.35s var(--m3-standard) forwards;
            }

            @keyframes ptrFillScreen {
              0% {
                clip-path: inset(0 0 100% 0);
              }
              100% {
                clip-path: inset(0 0 0 0);
              }
            }
          `}</style>
        </div>,
        document.body
      )}

      {isRefreshing && createPortal(
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          backgroundColor: '#293515',
        }} />,
        document.body
      )}

      {children}
    </div>
  );
};

export default PullToRefresh;

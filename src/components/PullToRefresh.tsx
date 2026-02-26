import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

const taglines = [
  "Your second home.",
  "Rooted in golf, built for community.",
  "Where design meets lifestyle.",
  "Elevate your everyday experience.",
  "Come in, settle down, stay awhile.",
  "A place to focus, meet, and connect.",
  "Step onto the green.",
  "Golf all year.",
  "Where every day feels like a day on the course.",
  "Practice with purpose.",
  "Tour-level data, right here at home.",
  "Inspire. Engage. Elevate.",
  "Effortless balance.",
  "Play through.",
  "Refined leisure.",
  "Always open.",
  "A welcoming community.",
  "More than a sport.",
  "Productivity meets leisure."
];

interface PullToRefreshProps {
  children: React.ReactNode;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  className?: string;
}

const PULL_THRESHOLD = 80;
const MAX_PULL = 160;
const HEADER_HEIGHT = 72;
const DESKTOP_SETTLE_DELAY = 300;

const isTouchDevice = () => {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

const PullToRefresh: React.FC<PullToRefreshProps> = ({ children, onRefresh, disabled = false, className = '' }) => {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFillingScreen, setIsFillingScreen] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isSpringBack, setIsSpringBack] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [tagline] = useState(() => taglines[Math.floor(Math.random() * taglines.length)]);
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

  // Track modal open state via MutationObserver
  useEffect(() => {
    const checkModalState = () => {
      const modalCount = document.body.getAttribute('data-modal-count');
      setIsModalOpen(modalCount !== null && parseInt(modalCount, 10) > 0);
    };
    
    // Check initial state
    checkModalState();
    
    // Watch for attribute changes on body
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
    
    try {
      await onRefresh();
    } catch (e: unknown) {
      console.error('Refresh failed:', e);
    }
    
    setIsExiting(true);
    await new Promise(resolve => setTimeout(resolve, 550));
    setIsRefreshing(false);
    setIsExiting(false);
  }, [isRefreshing, isFillingScreen, onRefresh]);

  // Desktop scroll wheel support with settlement tracking
  // Only register on touch devices to avoid blocking native wheel scroll on desktop
  useEffect(() => {
    // Skip wheel listener on desktop - let browser handle wheel scroll natively
    if (!isTouchCapable) return;
    
    const container = containerRef.current;
    if (!container) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (disabled || isModalOpen || isRefreshing || isFillingScreen || isSpringBack) return;
      
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      
      // When at top and scrolling up
      if (scrollTop <= 5 && e.deltaY < 0) {
        // If not yet settled at top, start settlement timer
        if (!isSettledAtTopRef.current && !isWheelPullingRef.current) {
          // Clear any existing settle timeout
          if (settleTimeoutRef.current) {
            clearTimeout(settleTimeoutRef.current);
          }
          // Start settlement - user needs to pause at top before PTR activates
          settleTimeoutRef.current = setTimeout(() => {
            isSettledAtTopRef.current = true;
          }, DESKTOP_SETTLE_DELAY);
          return;
        }
        
        // Only allow pull-to-refresh if settled at top
        if (!isSettledAtTopRef.current) return;
        
        // Accumulate upward scroll
        wheelAccumulatorRef.current += Math.abs(e.deltaY) * 0.3;
        wheelAccumulatorRef.current = Math.min(wheelAccumulatorRef.current, MAX_PULL);
        isWheelPullingRef.current = true;
        
        setPullDistance(wheelAccumulatorRef.current);
        
        // Reset accumulator after a pause in scrolling
        if (wheelTimeoutRef.current) {
          clearTimeout(wheelTimeoutRef.current);
        }
        wheelTimeoutRef.current = setTimeout(() => {
          if (wheelAccumulatorRef.current >= PULL_THRESHOLD && !isRefreshing && !isFillingScreen) {
            triggerRefresh();
          } else {
            // Spring back animation instead of instant reset
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
        // Reset settlement when scrolled away from top
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
        // Scrolling down while at top - reset pull but maintain settlement
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
  const onRefreshRef = useRef(onRefresh);
  const animateSpringBackRef = useRef(animateSpringBack);

  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { isModalOpenRef.current = isModalOpen; }, [isModalOpen]);
  useEffect(() => { isRefreshingRef.current = isRefreshing; }, [isRefreshing]);
  useEffect(() => { isSpringBackRef.current = isSpringBack; }, [isSpringBack]);
  useEffect(() => { isFillingScreenRef.current = isFillingScreen; }, [isFillingScreen]);
  useEffect(() => { pullDistanceRef.current = pullDistance; }, [pullDistance]);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
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
        const resistance = 0.5;
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

        try {
          await onRefreshRef.current();
        } catch (err: unknown) {
          console.error('Refresh failed:', err);
        }

        setIsExiting(true);
        await new Promise(resolve => setTimeout(resolve, 550));
        setIsRefreshing(false);
        setIsExiting(false);
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

  // Set body attribute for header fade effect
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

  // Cleanup animation frame on unmount
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
              font-family: 'Plus Jakarta Sans', sans-serif;
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
              animation: ptrFillScreen 0.35s cubic-bezier(0.4, 0, 0.2, 1) forwards;
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
        <div className={`ptr-loader-overlay ${isExiting ? 'ptr-loader-exit' : ''}`}>
          <div className={`ptr-loader-content ${isExiting ? 'ptr-content-exit' : ''}`}>
            <div className="ptr-mascot">
              <img 
                src="/assets/logos/walking-mascot-white.gif" 
                alt="Animated loading indicator" 
                className="ptr-mascot-image"
              />
            </div>
            <p className="ptr-tagline">{tagline}</p>
          </div>

          <style>{`
            .ptr-loader-overlay {
              position: fixed;
              inset: 0;
              z-index: 99999;
              display: flex;
              justify-content: center;
              align-items: center;
              background-color: #293515;
              will-change: transform;
            }

            .ptr-loader-exit {
              animation: ptrSlideUp 0.55s cubic-bezier(0.32, 0, 0.67, 0) forwards;
              pointer-events: none;
            }

            @keyframes ptrSlideUp {
              0% {
                transform: translateY(0);
              }
              100% {
                transform: translateY(-100%);
              }
            }

            .ptr-loader-content {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 1.5rem;
              will-change: opacity, transform;
              animation: ptrContentFadeIn 0.3s ease-out forwards;
            }

            @keyframes ptrContentFadeIn {
              from {
                opacity: 0;
                transform: scale(0.9);
              }
              to {
                opacity: 1;
                transform: scale(1);
              }
            }

            .ptr-content-exit {
              animation: ptrContentFadeOut 0.3s cubic-bezier(0.4, 0, 1, 1) forwards;
            }

            @keyframes ptrContentFadeOut {
              0% {
                opacity: 1;
                transform: translateY(0);
              }
              100% {
                opacity: 0;
                transform: translateY(-30px);
              }
            }

            .ptr-mascot-image {
              width: 120px;
              height: auto;
            }

            .ptr-tagline {
              font-family: 'Playfair Display', serif;
              color: white;
              font-size: 1rem;
              text-align: center;
              margin: 0;
              padding: 0 2rem;
            }

            .ptr-mascot {
              display: flex;
              justify-content: center;
              align-items: center;
            }
          `}</style>
        </div>,
        document.body
      )}

      {children}
    </div>
  );
};

export default PullToRefresh;

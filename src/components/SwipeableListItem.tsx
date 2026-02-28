import { useState, useRef, useCallback, type ReactNode } from 'react';
import { haptic } from '../utils/haptics';

interface SwipeAction {
  id: string;
  icon: string;
  label: string;
  color: 'red' | 'green' | 'blue' | 'orange' | 'gray' | 'primary' | 'lavender';
  onClick: () => void;
}

interface SwipeableListItemProps {
  children: ReactNode;
  leftActions?: SwipeAction[];
  rightActions?: SwipeAction[];
  onSwipeStart?: () => void;
  onSwipeEnd?: () => void;
  disabled?: boolean;
  threshold?: number;
  isRemoving?: boolean;
}

const colorClasses = {
  red: 'bg-red-500 text-white',
  green: 'bg-green-500 text-white',
  blue: 'bg-blue-500 text-white',
  orange: 'bg-orange-500 text-white',
  gray: 'bg-gray-500 text-white',
  primary: 'bg-[#293515] text-white',
  lavender: 'bg-[#CCB8E4] text-[#293515]'
};

export function SwipeableListItem({
  children,
  leftActions = [],
  rightActions = [],
  onSwipeStart,
  onSwipeEnd,
  disabled = false,
  threshold = 80,
  isRemoving = false
}: SwipeableListItemProps) {
  const [translateX, setTranslateX] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [crossedTriggerThreshold, setCrossedTriggerThreshold] = useState<'left' | 'right' | null>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isSwipingRef = useRef(false);
  const directionLockedRef = useRef<'horizontal' | 'vertical' | null>(null);
  const hasTriggeredHapticRef = useRef(false);

  const actionWidth = threshold;
  const maxLeftSwipe = leftActions.length > 0 ? actionWidth * leftActions.length : 0;
  const maxRightSwipe = rightActions.length > 0 ? actionWidth * rightActions.length : 0;
  const triggerThreshold = actionWidth * 1.5;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return;
    const touch = e.touches[0];
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    isSwipingRef.current = false;
    directionLockedRef.current = null;
    hasTriggeredHapticRef.current = false;
    setCrossedTriggerThreshold(null);
    setIsTransitioning(false);
  }, [disabled]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (disabled) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - startXRef.current;
    const deltaY = touch.clientY - startYRef.current;

    if (directionLockedRef.current === null) {
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        directionLockedRef.current = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
        if (directionLockedRef.current === 'horizontal') {
          isSwipingRef.current = true;
          onSwipeStart?.();
          haptic.selection();
        }
      }
    }

    if (directionLockedRef.current === 'horizontal') {
      let newTranslateX = deltaX;
      
      if (deltaX > 0 && leftActions.length === 0) {
        newTranslateX = deltaX * 0.2;
      } else if (deltaX < 0 && rightActions.length === 0) {
        newTranslateX = deltaX * 0.2;
      } else if (deltaX > maxLeftSwipe) {
        newTranslateX = maxLeftSwipe + (deltaX - maxLeftSwipe) * 0.2;
      } else if (deltaX < -maxRightSwipe) {
        newTranslateX = -maxRightSwipe + (deltaX + maxRightSwipe) * 0.2;
      }

      if (deltaX > triggerThreshold && leftActions.length > 0) {
        if (!hasTriggeredHapticRef.current) {
          haptic.success();
          hasTriggeredHapticRef.current = true;
        }
        setCrossedTriggerThreshold('right');
      } else if (deltaX < -triggerThreshold && rightActions.length > 0) {
        if (!hasTriggeredHapticRef.current) {
          haptic.success();
          hasTriggeredHapticRef.current = true;
        }
        setCrossedTriggerThreshold('left');
      } else {
        if (crossedTriggerThreshold !== null) {
          hasTriggeredHapticRef.current = false;
        }
        setCrossedTriggerThreshold(null);
      }

      setTranslateX(newTranslateX);
    }
  }, [disabled, leftActions.length, rightActions.length, maxLeftSwipe, maxRightSwipe, triggerThreshold, crossedTriggerThreshold, onSwipeStart]);

  const handleTouchEnd = useCallback(() => {
    if (disabled || !isSwipingRef.current) return;
    
    setIsTransitioning(true);
    
    if (crossedTriggerThreshold === 'right' && leftActions.length > 0) {
      setTranslateX(0);
      setCrossedTriggerThreshold(null);
      haptic.medium();
      leftActions[0].onClick();
    } else if (crossedTriggerThreshold === 'left' && rightActions.length > 0) {
      setTranslateX(0);
      setCrossedTriggerThreshold(null);
      haptic.medium();
      rightActions[0].onClick();
    } else if (translateX > threshold && leftActions.length > 0) {
      setTranslateX(maxLeftSwipe);
      haptic.light();
    } else if (translateX < -threshold && rightActions.length > 0) {
      setTranslateX(-maxRightSwipe);
      haptic.light();
    } else {
      setTranslateX(0);
    }

    onSwipeEnd?.();
    isSwipingRef.current = false;
  }, [disabled, translateX, threshold, leftActions, rightActions, maxLeftSwipe, maxRightSwipe, crossedTriggerThreshold, onSwipeEnd]);

  const handleActionClick = (action: SwipeAction) => {
    haptic.medium();
    action.onClick();
    setIsTransitioning(true);
    setTranslateX(0);
  };

  const close = useCallback(() => {
    setIsTransitioning(true);
    setTranslateX(0);
  }, []);

  const isSwipingLeft = translateX < 0;
  const isSwipingRight = translateX > 0;
  const showLeftActions = isSwipingRight && leftActions.length > 0;
  const showRightActions = isSwipingLeft && rightActions.length > 0;

  // Use a wrapper div that doesn't clip the border, with the action containers inside
  // The action containers use their own overflow-hidden to clip themselves
  return (
    <div className={`relative ${isRemoving ? 'animate-card-remove' : ''}`}>
      {/* Action containers positioned behind the card, clipped independently */}
      {leftActions.length > 0 && (
        <div 
          className={`absolute inset-0 flex items-stretch rounded-xl overflow-hidden transition-opacity duration-instant ${showLeftActions ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ zIndex: 1 }}
        >
          <div className="flex">
            {leftActions.map((action, index) => {
              const isFirstAction = index === 0;
              const isExpanded = isFirstAction && crossedTriggerThreshold === 'right';
              return (
                <button
                  key={action.id}
                  onClick={() => handleActionClick(action)}
                  className={`flex flex-col items-center justify-center gap-1 min-h-[44px] ${colorClasses[action.color]} tap-target transition-all duration-fast pointer-events-auto tactile-btn ${isExpanded ? 'scale-105' : ''}`}
                  style={{ 
                    width: isExpanded ? actionWidth * 1.2 : actionWidth,
                    minWidth: actionWidth 
                  }}
                  aria-label={action.label}
                >
                  <span className={`material-symbols-outlined transition-transform duration-fast ${isExpanded ? 'text-2xl scale-125' : 'text-xl'}`}>{action.icon}</span>
                  <span className="text-xs font-medium">{action.label}</span>
                </button>
              );
            })}
          </div>
          <div className={`flex-1 ${leftActions.length > 0 ? colorClasses[leftActions[leftActions.length - 1].color].split(' ')[0] : ''}`} />
        </div>
      )}

      {rightActions.length > 0 && (
        <div 
          className={`absolute inset-0 flex items-stretch justify-end rounded-xl overflow-hidden transition-opacity duration-instant ${showRightActions ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ zIndex: 1 }}
        >
          <div className={`flex-1 ${rightActions.length > 0 ? colorClasses[rightActions[0].color].split(' ')[0] : ''}`} />
          <div className="flex">
            {rightActions.map((action, index) => {
              const isFirstAction = index === 0;
              const isExpanded = isFirstAction && crossedTriggerThreshold === 'left';
              return (
                <button
                  key={action.id}
                  onClick={() => handleActionClick(action)}
                  className={`flex flex-col items-center justify-center gap-1 min-h-[44px] ${colorClasses[action.color]} tap-target transition-all duration-fast pointer-events-auto tactile-btn ${isExpanded ? 'scale-105' : ''}`}
                  style={{ 
                    width: isExpanded ? actionWidth * 1.2 : actionWidth,
                    minWidth: actionWidth 
                  }}
                  aria-label={action.label}
                >
                  <span className={`material-symbols-outlined transition-transform duration-fast ${isExpanded ? 'text-2xl scale-125' : 'text-xl'}`}>{action.icon}</span>
                  <span className="text-xs font-medium">{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Card container - no overflow-hidden so border shows fully */}
      <div
        className={`relative ${isTransitioning ? 'transition-transform duration-fast ease-out' : ''}`}
        style={{ transform: `translateX(${translateX}px)`, zIndex: 2 }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={translateX !== 0 ? close : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export default SwipeableListItem;

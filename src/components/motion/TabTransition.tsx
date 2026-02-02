import React, { useState, useEffect, useRef } from 'react';

interface TabTransitionProps {
  activeKey: string | number;
  children: React.ReactNode;
  className?: string;
}

export const TabTransition: React.FC<TabTransitionProps> = ({ 
  activeKey, 
  children, 
  className = '' 
}) => {
  const [displayedChildren, setDisplayedChildren] = useState(children);
  const [animationPhase, setAnimationPhase] = useState<'idle' | 'exiting' | 'entering'>('idle');
  const prevKeyRef = useRef(activeKey);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip animation on first render
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (activeKey !== prevKeyRef.current) {
      // Start exit animation with current (old) content
      setAnimationPhase('exiting');
      
      // After exit animation completes, switch to new content and enter
      const exitTimer = setTimeout(() => {
        setDisplayedChildren(children);
        setAnimationPhase('entering');
        prevKeyRef.current = activeKey;
        
        // Clear entering state after animation completes
        const enterTimer = setTimeout(() => {
          setAnimationPhase('idle');
        }, 250);
        
        return () => clearTimeout(enterTimer);
      }, 150);
      
      return () => clearTimeout(exitTimer);
    } else {
      // Same key, just update children without animation
      setDisplayedChildren(children);
    }
  }, [activeKey, children]);

  const animationClass = 
    animationPhase === 'exiting' ? 'animate-tab-exit' :
    animationPhase === 'entering' ? 'animate-tab-enter' : '';

  return (
    <div className={`${animationClass} ${className}`}>
      {displayedChildren}
    </div>
  );
};

export default TabTransition;

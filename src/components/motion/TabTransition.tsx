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
  const [animationPhase, setAnimationPhase] = useState<'idle' | 'exiting' | 'entering'>('idle');
  const prevKeyRef = useRef(activeKey);
  const isFirstRender = useRef(true);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frozenChildrenRef = useRef<React.ReactNode>(children);

  if (animationPhase !== 'exiting') {
    frozenChildrenRef.current = children;
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevKeyRef.current = activeKey;
      return;
    }

    if (activeKey !== prevKeyRef.current) {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);

      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnimationPhase('exiting');
      
      exitTimerRef.current = setTimeout(() => {
        setAnimationPhase('entering');
        prevKeyRef.current = activeKey;
        
        enterTimerRef.current = setTimeout(() => {
          setAnimationPhase('idle');
        }, 200);
      }, 100);
    }

    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    };
  }, [activeKey]);

  const animationClass = 
    animationPhase === 'exiting' ? 'animate-tab-exit' :
    animationPhase === 'entering' ? 'animate-tab-enter' : '';

  const renderedChildren = animationPhase === 'exiting' ? frozenChildrenRef.current : children;

  return (
    <div className={`${animationClass} ${className}`}>
      {renderedChildren}
    </div>
  );
};

export default TabTransition;

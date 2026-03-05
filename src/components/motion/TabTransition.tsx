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
  const frozenChildrenRef = useRef<React.ReactNode>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevKeyRef.current = activeKey;
      return;
    }

    if (activeKey !== prevKeyRef.current) {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);

      frozenChildrenRef.current = null;
      setAnimationPhase('exiting');
      
      exitTimerRef.current = setTimeout(() => {
        setAnimationPhase('entering');
        prevKeyRef.current = activeKey;
        
        enterTimerRef.current = setTimeout(() => {
          setAnimationPhase('idle');
        }, 250);
      }, 120);
    }

    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    };
  }, [activeKey]);

  const animationClass = 
    animationPhase === 'exiting' ? 'animate-tab-exit' :
    animationPhase === 'entering' ? 'animate-tab-enter' : '';

  return (
    <div className={`${animationClass} ${className}`}>
      {children}
    </div>
  );
};

export default TabTransition;

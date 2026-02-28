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

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevKeyRef.current = activeKey;
      return;
    }

    if (activeKey !== prevKeyRef.current) {
      frozenChildrenRef.current = null;
      setAnimationPhase('exiting');
      
      const exitTimer = setTimeout(() => {
        setAnimationPhase('entering');
        prevKeyRef.current = activeKey;
        
        const enterTimer = setTimeout(() => {
          setAnimationPhase('idle');
        }, 250);
        
        return () => clearTimeout(enterTimer);
      }, 120);
      
      return () => clearTimeout(exitTimer);
    }
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

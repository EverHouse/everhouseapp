import React, { useEffect, useState, useRef } from 'react';

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  formatValue?: (value: number) => string;
}

const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  duration = 500,
  prefix = '',
  suffix = '',
  className = '',
  formatValue
}) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [isAnimating, setIsAnimating] = useState(false);
  const previousValue = useRef(value);
  const animationFrame = useRef<number>();

  useEffect(() => {
    if (value === previousValue.current) return;

    const startValue = previousValue.current;
    const endValue = value;
    const startTime = performance.now();
    
    setIsAnimating(true);

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Easing function (ease-out cubic)
      const easeOut = 1 - Math.pow(1 - progress, 3);
      
      const currentValue = Math.round(startValue + (endValue - startValue) * easeOut);
      setDisplayValue(currentValue);

      if (progress < 1) {
        animationFrame.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(endValue);
        setIsAnimating(false);
        previousValue.current = endValue;
      }
    };

    animationFrame.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrame.current) {
        cancelAnimationFrame(animationFrame.current);
      }
    };
  }, [value, duration]);

  const formattedValue = formatValue ? formatValue(displayValue) : displayValue.toString();

  return (
    <span className={`${isAnimating ? 'animate-counter-change' : ''} ${className}`}>
      {prefix}{formattedValue}{suffix}
    </span>
  );
};

export default AnimatedCounter;

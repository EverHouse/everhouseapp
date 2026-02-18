import React from 'react';

interface MotionListProps {
  children: React.ReactNode;
  className?: string;
}

export const MotionList = React.forwardRef<HTMLDivElement, MotionListProps>(({ children, className }, ref) => {
  return (
    <div ref={ref} className={`animate-fade-in ${className || ''}`}>
      {children}
    </div>
  );
});

interface MotionListItemProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
  index?: number;
}

const getStaggerDelayClass = (index: number): string => {
  if (index <= 0) return 'animate-list-item';
  if (index > 10) return 'animate-list-item-delay-10';
  return `animate-list-item-delay-${index}`;
};

export const MotionListItem: React.FC<MotionListItemProps> = ({ 
  children, 
  className, 
  onClick,
  style,
  index = 0
}) => {
  return (
    <div
      className={`${getStaggerDelayClass(index)} ${className || ''}`}
      onClick={onClick}
      style={style}
    >
      {children}
    </div>
  );
};

interface AnimatedPageProps {
  children: React.ReactNode;
  className?: string;
}

export const AnimatedPage: React.FC<AnimatedPageProps> = ({ children, className }) => {
  return (
    <div className={`animate-page-enter ${className || ''}`}>
      {children}
    </div>
  );
};

interface AnimatedSectionProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}

export const AnimatedSection: React.FC<AnimatedSectionProps> = ({ 
  children, 
  className,
  delay = 0
}) => {
  const delayClass = delay <= 0 
    ? 'animate-content-enter' 
    : delay > 12 
      ? 'animate-content-enter-delay-12'
      : `animate-content-enter-delay-${delay}`;
  
  return (
    <div className={`${delayClass} ${className || ''}`}>
      {children}
    </div>
  );
};

export const getStaggerClass = (index: number, prefix: 'list' | 'content' = 'list'): string => {
  if (prefix === 'content') {
    if (index <= 0) return 'animate-content-enter';
    if (index > 12) return 'animate-content-enter-delay-12';
    return `animate-content-enter-delay-${index}`;
  }
  return getStaggerDelayClass(index);
};

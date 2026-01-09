import React from 'react';

interface MotionListProps {
  children: React.ReactNode;
  className?: string;
}

export const MotionList: React.FC<MotionListProps> = ({ children, className }) => {
  return (
    <div className={`animate-fade-in ${className || ''}`}>
      {children}
    </div>
  );
};

interface MotionListItemProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export const MotionListItem: React.FC<MotionListItemProps> = ({ 
  children, 
  className, 
  onClick,
  style 
}) => {
  return (
    <div
      className={`animate-slide-in-up ${className || ''}`}
      onClick={onClick}
      style={style}
    >
      {children}
    </div>
  );
};

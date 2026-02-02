import React from 'react';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'avatar' | 'card' | 'rectangular';
  width?: string | number;
  height?: string | number;
}

const Skeleton: React.FC<SkeletonProps> = ({
  className = '',
  variant = 'rectangular',
  width,
  height
}) => {
  const variantClasses = {
    text: 'skeleton-text',
    avatar: 'skeleton-avatar',
    card: 'skeleton-card',
    rectangular: 'skeleton-base'
  };

  const style: React.CSSProperties = {};
  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <div
      className={`skeleton-shimmer ${variantClasses[variant]} ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
};

export default Skeleton;

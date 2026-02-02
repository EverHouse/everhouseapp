import React from 'react';

interface AnimatedCheckmarkProps {
  size?: number;
  color?: string;
  className?: string;
}

const AnimatedCheckmark: React.FC<AnimatedCheckmarkProps> = ({ 
  size = 56, 
  color = '#293515',
  className = ''
}) => {
  return (
    <div className={`animate-checkmark-container ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 52 52"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          className="animate-checkmark-circle"
          cx="26"
          cy="26"
          r="25"
          fill="none"
          stroke={color}
          strokeWidth="2"
        />
        <path
          className="animate-checkmark-check"
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.1 27.2l7.1 7.2 16.7-16.8"
        />
      </svg>
    </div>
  );
};

export default AnimatedCheckmark;

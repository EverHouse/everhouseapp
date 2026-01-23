import React from 'react';

interface TrackmanIconProps {
  className?: string;
  size?: number;
}

export const TrackmanIcon: React.FC<TrackmanIconProps> = ({ className = '', size = 20 }) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect
        x="10"
        y="10"
        width="80"
        height="80"
        rx="12"
        className="fill-primary/80 dark:fill-white/80"
      />
      <path
        d="M35 90 C35 90, 50 50, 65 10"
        stroke="white"
        strokeWidth="12"
        strokeLinecap="round"
        className="dark:stroke-surface-dark"
      />
      <path
        d="M30 85 Q45 45, 60 15"
        stroke="white"
        strokeWidth="8"
        strokeLinecap="round"
        className="dark:stroke-surface-dark"
      />
    </svg>
  );
};

export default TrackmanIcon;

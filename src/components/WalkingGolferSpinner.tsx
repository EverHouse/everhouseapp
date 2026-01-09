import React from 'react';

interface WalkingGolferSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'dark' | 'light';
  className?: string;
}

const WalkingGolferSpinner: React.FC<WalkingGolferSpinnerProps> = ({ 
  size = 'md',
  variant = 'dark',
  className = '' 
}) => {
  const sizeStyles = {
    sm: { width: '24px' },
    md: { width: '48px' },
    lg: { width: '80px' }
  };

  const imageSrc = variant === 'light' 
    ? '/assets/logos/walking-mascot-white.gif'
    : '/assets/logos/walking-mascot-green.gif';

  return (
    <div className={`inline-flex items-center justify-center ${className}`}>
      <img 
        src={imageSrc}
        alt="Loading..." 
        style={sizeStyles[size]}
        className="h-auto"
      />
    </div>
  );
};

export default WalkingGolferSpinner;

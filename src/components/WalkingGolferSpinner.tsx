import React, { useState, useEffect } from 'react';

interface WalkingGolferSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'dark' | 'light' | 'auto';
  className?: string;
}

const WalkingGolferSpinner: React.FC<WalkingGolferSpinnerProps> = ({ 
  size = 'md',
  variant = 'dark',
  className = '' 
}) => {
  const [isDark, setIsDark] = useState(() => 
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    if (variant !== 'auto') return;
    
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setIsDark(document.documentElement.classList.contains('dark'));
    
    return () => observer.disconnect();
  }, [variant]);

  const sizeStyles = {
    sm: { width: '24px' },
    md: { width: '48px' },
    lg: { width: '80px' }
  };

  let imageSrc: string;
  if (variant === 'auto') {
    imageSrc = isDark
      ? '/assets/logos/walking-mascot-white.gif'
      : '/assets/logos/walking-mascot-green.gif';
  } else {
    imageSrc = variant === 'light'
      ? '/assets/logos/walking-mascot-white.gif'
      : '/assets/logos/walking-mascot-green.gif';
  }

  return (
    <div className={`inline-flex items-center justify-center animate-content-enter ${className}`}>
      <img 
        src={imageSrc}
        alt="Animated golfer mascot walking on golf course" 
        style={sizeStyles[size]}
        className="h-auto"
      />
    </div>
  );
};

export default WalkingGolferSpinner;

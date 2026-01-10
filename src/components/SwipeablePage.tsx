import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

interface SwipeablePageProps {
  children: React.ReactNode;
  className?: string;
}

const SwipeablePage: React.FC<SwipeablePageProps> = ({ children, className = "" }) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  return (
    <div 
      className={`w-full min-h-[100dvh] ${isDark ? 'bg-[#0f120a]' : 'bg-[#F2F2EC]'} relative animate-page-enter ${className}`}
      style={{
        marginTop: 'calc(-1 * var(--header-offset))',
        paddingTop: 'var(--header-offset)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 80px)'
      }}
    >
      {children}
    </div>
  );
};

export default SwipeablePage;

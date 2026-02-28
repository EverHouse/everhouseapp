import React from 'react';
import { haptic } from '../utils/haptics';

interface DateButtonProps {
  day: string;
  date: string;
  active?: boolean;
  onClick?: () => void;
  isDark?: boolean;
}

const DateButton: React.FC<DateButtonProps> = ({ day, date, active, onClick, isDark = true }) => {
  const handleClick = () => {
    haptic.selection();
    onClick?.();
  };

  return (
    <button 
      onClick={handleClick} 
      className={`tactile-btn flex-shrink-0 flex flex-col items-center justify-center w-16 h-20 rounded-[4px] transition-all duration-fast ease-spring-smooth active:scale-95 border ${active ? 'bg-accent text-[#293515] shadow-glow border-accent' : `glass-card ${isDark ? 'text-white border-white/10' : 'text-primary border-black/10'}`}`}
    >
      <span className={`text-xs font-medium mb-1 ${active ? 'opacity-90' : 'opacity-80'}`}>{day}</span>
      <span className="text-xl font-bold">{date}</span>
    </button>
  );
};

export default DateButton;
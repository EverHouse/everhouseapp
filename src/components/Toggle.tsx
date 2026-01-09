import React from 'react';
import { haptic } from '../utils/haptics';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
}

const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  label,
  className = '',
}) => {
  const sizes = {
    sm: {
      track: 'h-[30px] w-[48px]',
      thumb: 'h-[22px] w-[22px]',
      translate: 'translate-x-[18px]',
    },
    md: {
      track: 'h-[36px] w-[56px]',
      thumb: 'h-[28px] w-[28px]',
      translate: 'translate-x-[20px]',
    },
  };

  const { track, thumb, translate } = sizes[size];

  const handleClick = () => {
    if (!disabled) {
      haptic.light();
      onChange(!checked);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={handleClick}
      className={`
        relative inline-flex items-center ${track} shrink-0 rounded-full p-[2px]
        border-2 transition-colors duration-200 ease-in-out 
        focus:outline-none focus-visible:ring-2 focus-visible:ring-[#34C759]/50 focus-visible:ring-offset-2
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
        ${checked ? 'bg-[#34C759] border-[#34C759]' : 'bg-[#E5E5EA] border-[#E5E5EA]'}
        ${className}
      `}
    >
      <span
        className={`
          pointer-events-none inline-block ${thumb} rounded-full 
          bg-white shadow-[0_2px_4px_rgba(0,0,0,0.12)] transition-transform duration-200 ease-in-out
          ${checked ? translate : 'translate-x-0'}
        `}
      />
    </button>
  );
};

export default Toggle;

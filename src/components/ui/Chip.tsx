import React from 'react';
import { haptic } from '../../utils/haptics';

type ChipVariant = 'filter' | 'input' | 'assist';

interface ChipProps {
  variant: ChipVariant;
  label: string;
  selected?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
  onClick?: () => void;
  icon?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const sizeStyles = {
  sm: 'min-h-[32px] px-3 text-sm gap-1.5',
  md: 'min-h-[36px] px-4 text-sm gap-2',
};

export const Chip: React.FC<ChipProps> = ({
  variant,
  label,
  selected = false,
  onToggle,
  onRemove,
  onClick,
  icon,
  disabled = false,
  size = 'md',
  className = '',
}) => {
  const isFilter = variant === 'filter';
  const isInput = variant === 'input';
  const isAssist = variant === 'assist';

  const handleClick = () => {
    if (disabled) return;
    haptic.selection();
    if (isFilter && onToggle) onToggle();
    if (isAssist && onClick) onClick();
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    haptic.light();
    if (onRemove) onRemove();
  };

  const baseStyles =
    'inline-flex items-center justify-center rounded-full border font-medium transition-all duration-fast focus:ring-2 focus:ring-offset-1 focus:ring-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed tactile-btn select-none';

  const unselectedBorder = 'border-primary/20 dark:border-white/20';
  const selectedBorder = 'border-primary/30 dark:border-white/30';

  const variantStyles = (() => {
    if (isFilter && selected) {
      return `${selectedBorder} bg-primary/10 text-primary dark:bg-white/10 dark:text-bone`;
    }
    if (isInput && selected) {
      return `${selectedBorder} bg-primary/10 text-primary dark:bg-white/10 dark:text-bone`;
    }
    return `${unselectedBorder} bg-transparent text-primary/80 dark:text-bone/80 hover:bg-primary/5 dark:hover:bg-white/5`;
  })();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  const interactiveProps = (() => {
    if (isFilter) {
      return {
        role: 'checkbox' as const,
        'aria-checked': selected,
        onClick: handleClick,
        tabIndex: disabled ? -1 : 0,
        onKeyDown: handleKeyDown,
      };
    }
    if (isAssist) {
      return {
        role: 'button' as const,
        onClick: handleClick,
        tabIndex: disabled ? -1 : 0,
        onKeyDown: handleKeyDown,
      };
    }
    return {
      tabIndex: disabled ? -1 : 0,
    };
  })();

  return (
    <span
      className={`${baseStyles} ${variantStyles} ${sizeStyles[size]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
      {...interactiveProps}
    >
      {isFilter && selected && (
        <span className="material-symbols-outlined text-[18px] leading-none" aria-hidden="true">
          check
        </span>
      )}
      {icon && !(isFilter && selected) && (
        <span className="material-symbols-outlined text-[18px] leading-none" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{label}</span>
      {isInput && (
        <button
          type="button"
          onClick={handleRemove}
          disabled={disabled}
          aria-label={`Remove ${label}`}
          className="inline-flex items-center justify-center rounded-full p-0.5 -mr-1 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors focus:ring-2 focus:ring-accent focus:outline-none"
        >
          <span className="material-symbols-outlined text-[16px] leading-none" aria-hidden="true">
            close
          </span>
        </button>
      )}
    </span>
  );
};

export type { ChipProps, ChipVariant };
export default Chip;

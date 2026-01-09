import { useRef, useEffect, useState, useCallback } from 'react';
import { haptic } from '../utils/haptics';

interface Segment {
  id: string;
  label: string;
  icon?: string;
}

interface SegmentedControlProps {
  segments: Segment[];
  value: string;
  onChange: (id: string) => void;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

const sizeClasses = {
  sm: 'text-xs py-1.5 px-3',
  md: 'text-sm py-2 px-4',
  lg: 'text-base py-2.5 px-5'
};

export function SegmentedControl({
  segments,
  value,
  onChange,
  size = 'md',
  fullWidth = false
}: SegmentedControlProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  const updateIndicator = useCallback(() => {
    if (!containerRef.current) return;
    const activeIndex = segments.findIndex(s => s.id === value);
    if (activeIndex === -1) return;
    
    const buttons = containerRef.current.querySelectorAll('[role="tab"]');
    const activeButton = buttons[activeIndex] as HTMLElement;
    if (activeButton) {
      setIndicatorStyle({
        left: activeButton.offsetLeft,
        width: activeButton.offsetWidth
      });
    }
  }, [segments, value]);

  useEffect(() => {
    updateIndicator();
    window.addEventListener('resize', updateIndicator);
    return () => window.removeEventListener('resize', updateIndicator);
  }, [updateIndicator]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let newIndex = index;
    if (e.key === 'ArrowLeft') {
      newIndex = index > 0 ? index - 1 : segments.length - 1;
    } else if (e.key === 'ArrowRight') {
      newIndex = index < segments.length - 1 ? index + 1 : 0;
    } else {
      return;
    }
    e.preventDefault();
    onChange(segments[newIndex].id);
    haptic.selection();
  };

  const handleSelect = (id: string) => {
    if (id !== value) {
      haptic.light();
      onChange(id);
    }
  };

  return (
    <div
      ref={containerRef}
      role="tablist"
      className={`relative inline-flex rounded-xl bg-primary/10 dark:bg-white/10 p-1 ${fullWidth ? 'w-full' : ''}`}
    >
      <div
        className="absolute top-1 bottom-1 bg-white dark:bg-white/20 rounded-lg shadow-sm transition-all duration-200 ease-out"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          transform: 'translateZ(0)'
        }}
      />
      
      {segments.map((segment, index) => {
        const isActive = segment.id === value;
        return (
          <button
            key={segment.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => handleSelect(segment.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`
              relative z-10 flex items-center justify-center gap-1.5 font-medium rounded-lg
              transition-colors duration-150
              ${sizeClasses[size]}
              ${fullWidth ? 'flex-1' : ''}
              ${isActive 
                ? 'text-primary dark:text-white' 
                : 'text-primary/60 dark:text-white/60 hover:text-primary/80 dark:hover:text-white/80'
              }
              tap-target
            `}
          >
            {segment.icon && (
              <span className="material-symbols-outlined text-[1.1em]">
                {segment.icon}
              </span>
            )}
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;

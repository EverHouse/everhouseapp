import { useState, useRef, useEffect, useCallback, useMemo, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

type StatusValue = 'attended' | 'no_show' | 'approved';

interface BookingStatusDropdownProps {
  currentStatus: 'check_in' | 'checked_in' | 'attended' | 'no_show' | 'cancellation_pending';
  onStatusChange: (status: StatusValue) => void;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  menuDirection?: 'up' | 'down';
  className?: string;
  showRevert?: boolean;
}

const BASE_OPTIONS: Array<{ value: StatusValue; label: string }> = [
  { value: 'attended', label: 'Checked In' },
  { value: 'no_show', label: 'No Show' },
];

const REVERT_OPTION: { value: StatusValue; label: string } = { value: 'approved', label: 'Revert to Approved' };

export function BookingStatusDropdown({
  currentStatus,
  onStatusChange,
  disabled = false,
  loading = false,
  size = 'sm',
  menuDirection = 'down',
  className = '',
  showRevert = false,
}: BookingStatusDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const menuRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => showRevert && (currentStatus === 'attended' || currentStatus === 'no_show')
    ? [...BASE_OPTIONS, REVERT_OPTION]
    : BASE_OPTIONS, [showRevert, currentStatus]);

  const isSm = size === 'sm';
  const minWidth = isSm ? 'min-w-[140px]' : 'min-w-[180px]';
  const itemTextSize = isSm ? 'text-xs' : 'text-sm';
  const iconSize = isSm ? 'w-5 h-5' : 'w-6 h-6';
  const iconTextSize = isSm ? 'text-xs' : 'text-sm';
  const listboxId = 'booking-status-listbox';

  const handleButtonClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!disabled && !loading) {
      setIsOpen(!isOpen);
      setActiveIndex(-1);
    }
  };

  const handleItemClick = (e: MouseEvent<HTMLButtonElement>, status: StatusValue) => {
    e.stopPropagation();
    e.preventDefault();
    setIsOpen(false);
    onStatusChange(status);
  };

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    setIsOpen(false);
  };

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled && !loading) {
          setIsOpen(true);
          setActiveIndex(0);
        }
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex(prev => (prev + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex(prev => (prev - 1 + options.length) % options.length);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        if (activeIndex >= 0 && activeIndex < options.length) {
          setIsOpen(false);
          onStatusChange(options[activeIndex].value);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        break;
      case 'Tab':
        setIsOpen(false);
        break;
    }
  }, [isOpen, activeIndex, disabled, loading, onStatusChange, options]);

  const renderButton = () => {
    const ariaProps = {
      'aria-haspopup': 'listbox' as const,
      'aria-expanded': isOpen,
      'aria-controls': isOpen ? listboxId : undefined,
    };

    if (loading) {
      const loadingClass = isSm
        ? 'text-xs px-2 py-1 rounded-lg flex items-center gap-1'
        : 'tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors';

      const loadingColorClass = currentStatus === 'check_in'
        ? (isSm ? 'bg-glass-surface-primary dark:bg-glass-surface-primary-dark text-glass-surface-primary-text dark:text-accent opacity-50' : 'bg-green-600 text-white opacity-75')
        : currentStatus === 'checked_in'
        ? (isSm ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300')
        : currentStatus === 'attended'
          ? (isSm ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300')
          : (isSm ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300');

      return (
        <button type="button" disabled className={`${loadingClass} ${loadingColorClass}`} {...ariaProps}>
          <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'} animate-spin`}>progress_activity</span>
          Updating...
        </button>
      );
    }

    if (currentStatus === 'cancellation_pending') {
      const btnClass = isSm
        ? 'text-xs px-2 py-1 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 rounded-lg font-medium flex items-center gap-1'
        : 'tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-orange-100 dark:bg-orange-900/30 border border-orange-400 dark:border-orange-600 text-orange-700 dark:text-orange-300';
      return (
        <button type="button" disabled className={btnClass} {...ariaProps}>
          <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'}`}>event_busy</span>
          Cancellation Pending
        </button>
      );
    }

    if (currentStatus === 'checked_in') {
      const btnClass = isSm
        ? 'text-xs px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg font-medium flex items-center gap-1 hover:ring-2 hover:ring-emerald-300 dark:hover:ring-emerald-600 transition-all cursor-pointer'
        : 'tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 hover:ring-2 hover:ring-green-300 dark:hover:ring-green-600 cursor-pointer';

      return (
        <button type="button" onClick={handleButtonClick} onKeyDown={handleKeyDown} disabled={disabled} className={btnClass} {...ariaProps}>
          <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'}`}>check_circle</span>
          Checked In
          <span className={`material-symbols-outlined ${isSm ? 'text-xs' : 'text-sm'} ml-0.5`}>expand_more</span>
        </button>
      );
    }

    if (currentStatus === 'check_in') {
      const btnClass = isSm
        ? 'tactile-btn text-xs px-2 py-1 bg-glass-surface-primary dark:bg-glass-surface-primary-dark text-glass-surface-primary-text dark:text-accent rounded-lg hover:bg-glass-surface-primary/80 dark:hover:bg-glass-surface-primary-dark/80 transition-colors disabled:opacity-50 flex items-center gap-1'
        : `tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
            disabled
              ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700 text-white'
          }`;

      return (
        <button type="button" onClick={handleButtonClick} onKeyDown={handleKeyDown} disabled={disabled} className={btnClass} {...ariaProps}>
          <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'}`}>{isSm ? 'login' : 'how_to_reg'}</span>
          Check In
          <span className={`material-symbols-outlined ${isSm ? 'text-xs' : 'text-sm'} ml-0.5`}>expand_more</span>
        </button>
      );
    }

    if (currentStatus === 'attended') {
      const btnClass = isSm
        ? 'text-xs px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg font-medium flex items-center gap-1 hover:ring-2 hover:ring-emerald-300 dark:hover:ring-emerald-600 transition-all cursor-pointer'
        : 'tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 hover:ring-2 hover:ring-green-300 dark:hover:ring-green-600 cursor-pointer';

      return (
        <button type="button" onClick={handleButtonClick} onKeyDown={handleKeyDown} disabled={disabled} className={btnClass} {...ariaProps}>
          <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'}`}>check_circle</span>
          Checked In
          <span className={`material-symbols-outlined ${isSm ? 'text-xs' : 'text-sm'} ml-0.5`}>expand_more</span>
        </button>
      );
    }

    const btnClass = isSm
      ? 'text-xs px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg font-medium flex items-center gap-1 hover:ring-2 hover:ring-red-300 dark:hover:ring-red-600 transition-all cursor-pointer'
      : 'tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300 hover:ring-2 hover:ring-red-300 dark:hover:ring-red-600 cursor-pointer';

    return (
      <button type="button" onClick={handleButtonClick} onKeyDown={handleKeyDown} disabled={disabled} className={btnClass} {...ariaProps}>
        <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'}`}>person_off</span>
        No Show
        <span className={`material-symbols-outlined ${isSm ? 'text-xs' : 'text-sm'} ml-0.5`}>expand_more</span>
      </button>
    );
  };

  const buttonRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const computeMenuStyle = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    if (menuDirection === 'up') {
      setMenuStyle({
        position: 'fixed',
        left: centerX,
        transform: 'translateX(-50%)',
        bottom: window.innerHeight - rect.top + 4,
        zIndex: 'var(--z-modal)',
      });
    } else {
      setMenuStyle({
        position: 'fixed',
        left: centerX,
        transform: 'translateX(-50%)',
        top: rect.bottom + 4,
        zIndex: 'var(--z-modal)',
      });
    }
  }, [menuDirection]);

  useEffect(() => {
    if (isOpen) {
      computeMenuStyle();
      const scrollParents: Element[] = [];
      let el: Element | null = buttonRef.current;
      while (el) {
        if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
          scrollParents.push(el);
        }
        el = el.parentElement;
      }
      const handleScroll = () => setIsOpen(false);
      scrollParents.forEach(sp => sp.addEventListener('scroll', handleScroll, { passive: true }));
      window.addEventListener('scroll', handleScroll, { passive: true });
      return () => {
        scrollParents.forEach(sp => sp.removeEventListener('scroll', handleScroll));
        window.removeEventListener('scroll', handleScroll);
      };
    }
  }, [isOpen, menuDirection, computeMenuStyle]);

  const getOptionIcon = (value: StatusValue) => {
    if (value === 'attended') return 'check_circle';
    if (value === 'no_show') return 'person_off';
    return 'undo';
  };

  const getOptionColor = (value: StatusValue) => {
    if (value === 'attended') return 'bg-green-500/20 text-green-700 dark:text-green-400';
    if (value === 'no_show') return 'bg-red-500/20 text-red-700 dark:text-red-400';
    return 'bg-amber-500/20 text-amber-700 dark:text-amber-400';
  };

  const getCheckColor = (value: StatusValue) => {
    if (value === 'attended') return 'text-green-600';
    if (value === 'no_show') return 'text-red-600';
    return 'text-amber-600';
  };

  return (
    <div ref={buttonRef} className={`relative w-full ${className}`}>
      {renderButton()}
      {isOpen && !disabled && !loading && createPortal(
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: 'var(--z-modal)' }}
            onClick={handleBackdropClick}
            aria-hidden="true"
          />
          <div ref={menuRef} id={listboxId} role="listbox" aria-label="Booking status" style={menuStyle} className={`bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-primary/10 dark:border-white/20 py-1 ${minWidth} animate-pop-in`}>
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                id={`${listboxId}-option-${index}`}
                aria-selected={currentStatus === option.value}
                onClick={(e) => handleItemClick(e, option.value)}
                className={`w-full px-3 py-2 text-left ${itemTextSize} flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors ${currentStatus === option.value ? 'font-bold' : ''} ${activeIndex === index ? 'bg-primary/10 dark:bg-white/10' : ''} ${option.value === 'approved' && index > 0 ? 'border-t border-primary/10 dark:border-white/10' : ''}`}
              >
                <span className={`inline-flex items-center justify-center ${iconSize} rounded-full ${getOptionColor(option.value)}`}>
                  <span className={`material-symbols-outlined ${iconTextSize}`}>{getOptionIcon(option.value)}</span>
                </span>
                {option.label}
                {currentStatus === option.value && (
                  <span className={`material-symbols-outlined text-sm ml-auto ${getCheckColor(option.value)}`}>check</span>
                )}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

export default BookingStatusDropdown;

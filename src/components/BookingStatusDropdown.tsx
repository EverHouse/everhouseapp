import { useState, useRef, useEffect, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

interface BookingStatusDropdownProps {
  currentStatus: 'check_in' | 'attended' | 'no_show';
  onStatusChange: (status: 'attended' | 'no_show') => void;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  menuDirection?: 'up' | 'down';
  className?: string;
}

export function BookingStatusDropdown({
  currentStatus,
  onStatusChange,
  disabled = false,
  loading = false,
  size = 'sm',
  menuDirection = 'down',
  className = '',
}: BookingStatusDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  const isSm = size === 'sm';
  const minWidth = isSm ? 'min-w-[140px]' : 'min-w-[160px]';
  const itemTextSize = isSm ? 'text-xs' : 'text-sm';
  const iconSize = isSm ? 'w-5 h-5' : 'w-6 h-6';
  const iconTextSize = isSm ? 'text-xs' : 'text-sm';

  const handleButtonClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!disabled && !loading) {
      setIsOpen(!isOpen);
    }
  };

  const handleItemClick = (e: MouseEvent<HTMLButtonElement>, status: 'attended' | 'no_show') => {
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

  const renderButton = () => {
    if (loading) {
      const loadingClass = isSm
        ? 'text-xs px-2 py-1 rounded-lg flex items-center gap-1'
        : 'tactile-btn w-full py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors';

      const loadingColorClass = currentStatus === 'check_in'
        ? (isSm ? 'bg-glass-surface-primary dark:bg-glass-surface-primary-dark text-glass-surface-primary-text dark:text-accent opacity-50' : 'bg-green-600 text-white opacity-75')
        : currentStatus === 'attended'
          ? (isSm ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600 text-green-700 dark:text-green-300')
          : (isSm ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300');

      return (
        <button type="button" disabled className={`${loadingClass} ${loadingColorClass}`}>
          <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'} animate-spin`}>progress_activity</span>
          Updating...
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
        <button type="button" onClick={handleButtonClick} disabled={disabled} className={btnClass}>
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
        <button type="button" onClick={handleButtonClick} disabled={disabled} className={btnClass}>
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
      <button type="button" onClick={handleButtonClick} disabled={disabled} className={btnClass}>
        <span className={`material-symbols-outlined ${isSm ? 'text-sm' : 'text-sm'}`}>person_off</span>
        No Show
        <span className={`material-symbols-outlined ${isSm ? 'text-xs' : 'text-sm'} ml-0.5`}>expand_more</span>
      </button>
    );
  };

  const buttonRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const computeMenuStyle = () => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    if (menuDirection === 'up') {
      setMenuStyle({
        position: 'fixed',
        left: centerX,
        transform: 'translateX(-50%)',
        bottom: window.innerHeight - rect.top + 4,
        zIndex: 10050,
      });
    } else {
      setMenuStyle({
        position: 'fixed',
        left: centerX,
        transform: 'translateX(-50%)',
        top: rect.bottom + 4,
        zIndex: 10050,
      });
    }
  };

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
  }, [isOpen, menuDirection]);

  return (
    <div ref={buttonRef} className={`relative w-full ${className}`}>
      {renderButton()}
      {isOpen && !disabled && !loading && createPortal(
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: 10049 }}
            onClick={handleBackdropClick}
          />
          <div style={menuStyle} className={`bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-primary/10 dark:border-white/20 py-1 ${minWidth} animate-pop-in`}>
            <button
              type="button"
              onClick={(e) => handleItemClick(e, 'attended')}
              className={`w-full px-3 py-2 text-left ${itemTextSize} flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors ${currentStatus === 'attended' ? 'font-bold' : ''}`}
            >
              <span className={`inline-flex items-center justify-center ${iconSize} rounded-full bg-green-500/20 text-green-700 dark:text-green-400`}>
                <span className={`material-symbols-outlined ${iconTextSize}`}>check_circle</span>
              </span>
              Checked In
              {currentStatus === 'attended' && (
                <span className="material-symbols-outlined text-sm ml-auto text-green-600">check</span>
              )}
            </button>
            <button
              type="button"
              onClick={(e) => handleItemClick(e, 'no_show')}
              className={`w-full px-3 py-2 text-left ${itemTextSize} flex items-center gap-2 hover:bg-primary/5 dark:hover:bg-white/5 transition-colors ${currentStatus === 'no_show' ? 'font-bold' : ''}`}
            >
              <span className={`inline-flex items-center justify-center ${iconSize} rounded-full bg-red-500/20 text-red-700 dark:text-red-400`}>
                <span className={`material-symbols-outlined ${iconTextSize}`}>person_off</span>
              </span>
              No Show
              {currentStatus === 'no_show' && (
                <span className="material-symbols-outlined text-sm ml-auto text-red-600">check</span>
              )}
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

export default BookingStatusDropdown;

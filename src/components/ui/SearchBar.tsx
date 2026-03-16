import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { haptic } from '../../utils/haptics';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onClear?: () => void;
  onFilterClick?: () => void;
  autoFocus?: boolean;
  className?: string;
  onDebouncedChange?: (value: string) => void;
  expandOnMobile?: boolean;
  recentSearches?: string[];
  suggestions?: string[];
  'aria-label'?: string;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  value,
  onChange,
  placeholder = 'Search...',
  onClear,
  onFilterClick,
  autoFocus = false,
  className = '',
  onDebouncedChange,
  expandOnMobile = false,
  recentSearches = [],
  suggestions = [],
  'aria-label': ariaLabel = 'Search',
}) => {
  const [internalValue, setInternalValue] = useState(value);
  const [isMobileExpanded, setIsMobileExpanded] = useState(false);
  const [isMobileVisible, setIsMobileVisible] = useState(false);
  const [isMobileClosing, setIsMobileClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMd = useBreakpoint('md');
  const isMobile = !isMd;

  useEffect(() => {
    setInternalValue(value);
  }, [value]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (onDebouncedChange) onDebouncedChange(internalValue);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [internalValue, onDebouncedChange]);

  useEffect(() => {
    if (isMobileExpanded && mobileInputRef.current) {
      mobileInputRef.current.focus();
    }
  }, [isMobileExpanded]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange(newValue);
    },
    [onChange],
  );

  const handleClear = useCallback(() => {
    haptic.light();
    setInternalValue('');
    onChange('');
    if (onClear) onClear();
    inputRef.current?.focus();
    mobileInputRef.current?.focus();
  }, [onChange, onClear]);

  useEffect(() => {
    return () => {
      if (mobileCloseTimerRef.current) clearTimeout(mobileCloseTimerRef.current);
    };
  }, []);

  const handleMobileClose = useCallback(() => {
    haptic.light();
    setIsMobileClosing(true);
    if (mobileCloseTimerRef.current) clearTimeout(mobileCloseTimerRef.current);
    mobileCloseTimerRef.current = setTimeout(() => {
      setIsMobileExpanded(false);
      setIsMobileVisible(false);
      setIsMobileClosing(false);
      mobileCloseTimerRef.current = null;
    }, 200);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        if (internalValue) {
          handleClear();
        } else if (isMobileExpanded) {
          handleMobileClose();
        }
      }
    },
    [internalValue, handleClear, isMobileExpanded, handleMobileClose],
  );

  const handleFocus = useCallback(() => {
    if (expandOnMobile && isMobile) {
      setIsMobileExpanded(true);
      requestAnimationFrame(() => {
        setIsMobileVisible(true);
      });
    }
  }, [expandOnMobile, isMobile]);

  const handleSuggestionSelect = useCallback(
    (text: string) => {
      haptic.selection();
      setInternalValue(text);
      onChange(text);
      setIsMobileExpanded(false);
    },
    [onChange],
  );

  const hasValue = internalValue.length > 0;

  const searchInput = (
    ref: React.RefObject<HTMLInputElement | null>,
    extraClass?: string,
  ) => (
    <div
      className={`group relative flex items-center gap-2 min-h-[48px] rounded-full bg-primary/5 dark:bg-white/5 border border-transparent focus-within:border-primary/30 dark:focus-within:border-white/30 focus-within:shadow-md transition-all duration-[100ms] px-4 ${extraClass ?? ''} ${className}`}
    >
      <span
        className="material-symbols-outlined text-[20px] text-primary/50 dark:text-white/50 shrink-0"
        aria-hidden="true"
      >
        search
      </span>
      <input
        ref={ref}
        type="text"
        role="searchbox"
        aria-label={ariaLabel}
        value={internalValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="flex-1 bg-transparent border-none outline-none text-primary dark:text-bone placeholder:text-primary/40 dark:placeholder:text-white/40 text-base"
      />
      {hasValue && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          className="animate-pop-in inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-primary/10 dark:hover:bg-white/10 transition-colors shrink-0"
        >
          <span
            className="material-symbols-outlined text-[18px] text-primary/60 dark:text-white/60"
            aria-hidden="true"
          >
            close
          </span>
        </button>
      )}
      {onFilterClick && (
        <button
          type="button"
          onClick={() => {
            haptic.light();
            onFilterClick();
          }}
          aria-label="Filter"
          className="inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-primary/10 dark:hover:bg-white/10 transition-colors shrink-0"
        >
          <span
            className="material-symbols-outlined text-[18px] text-primary/60 dark:text-white/60"
            aria-hidden="true"
          >
            tune
          </span>
        </button>
      )}
    </div>
  );

  if (isMobileExpanded) {
    const mobileAnimClass = isMobileClosing
      ? 'opacity-0 scale-95'
      : isMobileVisible
        ? 'opacity-100 scale-100'
        : 'opacity-0 scale-95';

    return (
      <div
        className={`fixed inset-0 bg-bone dark:bg-primary flex flex-col transition-all duration-[200ms] ease-[var(--m3-emphasized-decel)] ${mobileAnimClass}`}
        style={{ zIndex: 'var(--z-nav)', overflow: 'hidden', transformOrigin: 'top center' }}
      >
          <div className="flex items-center gap-2 px-3 pt-safe-top">
            <button
              type="button"
              onClick={handleMobileClose}
              aria-label="Close search"
              className="inline-flex items-center justify-center w-10 h-10 rounded-full hover:bg-primary/10 dark:hover:bg-white/10 transition-colors shrink-0"
            >
              <span
                className="material-symbols-outlined text-[22px] text-primary dark:text-bone"
                aria-hidden="true"
              >
                arrow_back
              </span>
            </button>
            <div className="flex-1">{searchInput(mobileInputRef, 'flex-1')}</div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pt-4">
            {!hasValue && recentSearches.length > 0 && (
              <div className="mb-6">
                <p className="text-xs font-medium text-primary/50 dark:text-white/50 uppercase tracking-wider mb-2">
                  Recent
                </p>
                <div className="flex flex-wrap gap-2">
                  {recentSearches.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => handleSuggestionSelect(term)}
                      className="inline-flex items-center gap-1.5 min-h-[36px] px-4 rounded-full border border-primary/20 dark:border-white/20 bg-transparent text-primary/80 dark:text-bone/80 hover:bg-primary/5 dark:hover:bg-white/5 text-sm font-medium transition-colors"
                    >
                      <span
                        className="material-symbols-outlined text-[16px]"
                        aria-hidden="true"
                      >
                        history
                      </span>
                      {term}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {hasValue && suggestions.length > 0 && (
              <div>
                <p className="text-xs font-medium text-primary/50 dark:text-white/50 uppercase tracking-wider mb-2">
                  Suggestions
                </p>
                <ul className="space-y-1">
                  {suggestions.map((suggestion) => (
                    <li key={suggestion}>
                      <button
                        type="button"
                        onClick={() => handleSuggestionSelect(suggestion)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left text-primary dark:text-bone hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
                      >
                        <span
                          className="material-symbols-outlined text-[18px] text-primary/40 dark:text-white/40"
                          aria-hidden="true"
                        >
                          search
                        </span>
                        <span className="text-sm">{suggestion}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
      </div>
    );
  }

  // eslint-disable-next-line react-hooks/refs
  return searchInput(inputRef);
};

export type { SearchBarProps };
export default SearchBar;

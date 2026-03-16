import React, { useState, useRef, useEffect, useMemo, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { useMemberData } from '../../contexts/DataContext';

export interface SelectedMember {
  id: string;
  email: string;
  emailRedacted?: string;
  name: string;
  tier: string | null;
  stripeCustomerId?: string | null;
  membershipStatus?: string;
}

const matchesMultiWordQuery = (text: string | undefined, query: string): boolean => {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(word => lowerText.includes(word));
};

interface MemberSearchInputProps {
  onSelect: (member: SelectedMember) => void;
  onClear?: () => void;
  placeholder?: string;
  label?: string;
  selectedMember?: SelectedMember | null;
  disabled?: boolean;
  className?: string;
  showTier?: boolean;
  autoFocus?: boolean;
  privacyMode?: boolean;
  excludeEmails?: string[];
  excludeIds?: string[];
  includeVisitors?: boolean;
  includeFormer?: boolean;
  forceApiSearch?: boolean;
}

const redactEmail = (email: string): string => {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visibleChars = Math.min(2, local.length);
  const redacted = local.slice(0, visibleChars) + '***';
  return `${redacted}@${domain}`;
};

export const MemberSearchInput: React.FC<MemberSearchInputProps> = ({
  onSelect,
  onClear,
  placeholder = 'Search by name or email...',
  label,
  selectedMember,
  disabled = false,
  className = '',
  showTier = true,
  autoFocus = false,
  privacyMode = false,
  excludeEmails = [],
  excludeIds = [],
  includeVisitors = false,
  includeFormer = false,
  forceApiSearch = false
}) => {
  const { members } = useMemberData();
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [apiResults, setApiResults] = useState<SelectedMember[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rafRef = useRef<number>(0);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const instanceId = useId();
  const listboxId = `member-search-listbox-${instanceId}`;
  const getOptionId = (index: number) => `member-search-option-${instanceId}-${index}`;

  const useApiSearch = forceApiSearch || includeVisitors || includeFormer;

  const excludeEmailsKey = useMemo(() => 
    JSON.stringify([...excludeEmails].map(e => e.toLowerCase()).sort()),
    [excludeEmails]
  );
  
  const excludeEmailsLower = useMemo(() => 
    excludeEmails.map(e => e.toLowerCase()), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [excludeEmailsKey]
  );

  const excludeIdsKey = useMemo(() =>
    JSON.stringify([...excludeIds].sort()),
    [excludeIds]
  );

  const excludeIdsSet = useMemo(() =>
    new Set(excludeIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [excludeIdsKey]
  );

  const filterKey = `${includeFormer}-${includeVisitors}-${excludeEmailsKey}-${excludeIdsKey}`;
  
  const searchApi = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setApiResults([]);
      return;
    }
    
    setIsSearching(true);
    try {
      const params = new URLSearchParams({
        query: searchQuery,
        limit: '10',
        includeFormer: includeFormer.toString(),
        includeVisitors: includeVisitors.toString()
      });
      
      const res = await fetch(`/api/members/search?${params}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const results: SelectedMember[] = data
          .filter((r: { id: string | number; email?: string; emailRedacted?: string; name?: string; tier?: string; membershipStatus?: string }) =>
            !excludeEmailsLower.includes(r.email?.toLowerCase() || '') &&
            !excludeIdsSet.has(String(r.id))
          )
          .map((r: { id: string | number; email?: string; emailRedacted?: string; name?: string; tier?: string; membershipStatus?: string }) => ({
            id: r.id,
            email: r.email || '',
            emailRedacted: r.emailRedacted || '',
            name: r.name || 'Unknown',
            tier: r.tier || null,
            membershipStatus: r.membershipStatus
          }));
        setApiResults(results);
      }
    } catch (err: unknown) {
      console.error('Search error:', err);
    } finally {
      setIsSearching(false);
    }
  }, [includeFormer, includeVisitors, excludeEmailsLower, excludeIdsSet]);

  useEffect(() => {
    if (useApiSearch && query.trim()) {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      searchTimeoutRef.current = setTimeout(() => {
        searchApi(query);
      }, 250);
    } else if (useApiSearch) {
      setApiResults([]);
    }
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [query, useApiSearch, filterKey, searchApi]);

  const filteredMembers = useMemo(() => {
    if (useApiSearch) {
      return apiResults;
    }
    if (!query.trim()) return [];
    return members.filter(m => 
      (matchesMultiWordQuery(m.name, query) || matchesMultiWordQuery(m.email, query)) &&
      !excludeEmailsLower.includes(m.email.toLowerCase()) &&
      !excludeIdsSet.has(String(m.id))
    ).slice(0, 8).map(m => ({
      id: m.id,
      email: m.email,
      name: m.name,
      tier: m.tier || null,
      stripeCustomerId: m.stripeCustomerId || null
    }));
  }, [useApiSearch, apiResults, members, query, excludeEmailsLower, excludeIdsSet]);

  useEffect(() => {
    if (selectedMember) {
      setQuery(selectedMember.name);
      setIsOpen(false);
    } else {
      setQuery('');
      setIsOpen(false);
    }
  }, [selectedMember]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredMembers.length]);

  const syncDropdownPosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    const vv = window.visualViewport;
    const viewportHeight = vv ? vv.height : window.innerHeight;
    const vvOffsetTop = vv ? vv.offsetTop : 0;
    const vvOffsetLeft = vv ? vv.offsetLeft : 0;

    const spaceBelow = viewportHeight - (rect.bottom - vvOffsetTop);
    const spaceAbove = rect.top - vvOffsetTop;
    const maxDropdownHeight = 256;
    const keyboardOpen = vv && vv.height < window.innerHeight * 0.75;
    const placeAbove = !keyboardOpen && spaceBelow < Math.min(maxDropdownHeight, 120) && spaceAbove > spaceBelow;
    const clampedHeight = Math.min(maxDropdownHeight, Math.max(placeAbove ? spaceAbove - 8 : spaceBelow - 8, 80));

    setDropdownStyle({
      position: 'fixed',
      top: placeAbove
        ? (rect.top + vvOffsetTop - clampedHeight - 4)
        : (rect.bottom + vvOffsetTop + 4),
      left: rect.left + vvOffsetLeft,
      width: rect.width,
      maxHeight: clampedHeight,
      zIndex: 'var(--z-dropdown)',
    } as React.CSSProperties);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    syncDropdownPosition();

    const onScrollOrResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(syncDropdownPosition);
    };

    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.visualViewport?.addEventListener('resize', onScrollOrResize);
    window.visualViewport?.addEventListener('scroll', onScrollOrResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.visualViewport?.removeEventListener('resize', onScrollOrResize);
      window.visualViewport?.removeEventListener('scroll', onScrollOrResize);
    };
  }, [isOpen, syncDropdownPosition]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const insideContainer = containerRef.current?.contains(target);
      const insideDropdown = dropdownRef.current?.contains(target);
      if (!insideContainer && !insideDropdown) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    setIsOpen(value.trim().length > 0);
    if (selectedMember && onClear) {
      onClear();
    }
  };

  const handleSelect = (member: SelectedMember) => {
    setQuery(member.name);
    setIsOpen(false);
    onSelect(member);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || filteredMembers.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => 
        prev < filteredMembers.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => prev > 0 ? prev - 1 : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredMembers[highlightedIndex]) {
        handleSelect(filteredMembers[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleClear = () => {
    setQuery('');
    setIsOpen(false);
    if (onClear) onClear();
    inputRef.current?.focus();
  };

  const showDropdown = isOpen && (filteredMembers.length > 0 || (query.trim() && !isSearching) || (isSearching && filteredMembers.length === 0));

  const dropdownContent = showDropdown ? (
    <div
      ref={dropdownRef}
      id={listboxId}
      role="listbox"
      data-scroll-lock-allow=""
      style={dropdownStyle}
      className="bg-white dark:bg-gray-900 border border-primary/10 dark:border-white/10 rounded-xl shadow-xl overflow-hidden overflow-y-auto overscroll-contain"
      onTouchMove={(e) => e.stopPropagation()}
    >
      {filteredMembers.length > 0 ? (
        filteredMembers.map((member, index) => {
          const isVisitor = ('membershipStatus' in member) && (member.membershipStatus === 'visitor' || member.membershipStatus === 'non-member');
          return (
            <button
              key={member.id || member.email}
              id={getOptionId(index)}
              type="button"
              role="option"
              aria-selected={index === highlightedIndex}
              onPointerDown={(e) => { e.preventDefault(); handleSelect(member); }}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`tactile-row w-full px-4 py-3 flex items-center gap-3 border-b border-primary/5 dark:border-white/5 last:border-0 transition-colors ${
                index === highlightedIndex 
                  ? 'bg-primary/10 dark:bg-white/10' 
                  : 'hover:bg-primary/5 dark:hover:bg-white/5'
              }`}
            >
              <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                isVisitor ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-primary/10 dark:bg-white/10'
              }`}>
                <span className={`material-symbols-outlined text-base ${
                  isVisitor ? 'text-amber-600 dark:text-amber-400' : 'text-primary dark:text-white'
                }`}>{isVisitor ? 'person_outline' : 'person'}</span>
              </div>
              <div className="text-left flex-1 min-w-0">
                <p className="font-medium text-primary dark:text-white truncate">
                  {member.name}
                  {isVisitor && (
                    <span className="ml-2 text-xs font-normal px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded">Visitor</span>
                  )}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                  {showTier && member.tier ? `${member.tier} • ` : ''}{privacyMode ? (('emailRedacted' in member ? member.emailRedacted : null) || redactEmail(member.email)) : member.email}
                </p>
              </div>
            </button>
          );
        })
      ) : isSearching ? (
        <div className="p-4 text-center">
          <p className="text-sm text-primary/60 dark:text-white/60">Searching...</p>
        </div>
      ) : query.trim() ? (
        <div className="p-4 text-center">
          <p className="text-sm text-primary/60 dark:text-white/60">No {includeVisitors ? 'users' : 'members'} found</p>
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && (
        <label htmlFor={`member-search-input-${instanceId}`} className="block text-sm font-medium text-primary dark:text-white mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        <span className={`absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-lg ${
          selectedMember 
            ? 'text-green-600 dark:text-green-400' 
            : 'text-primary/40 dark:text-white/40'
        }`}>
          {selectedMember ? 'check_circle' : 'search'}
        </span>
        <input
          id={`member-search-input-${instanceId}`}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={isOpen && filteredMembers.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={isOpen && filteredMembers.length > 0 ? getOptionId(highlightedIndex) : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          enterKeyHint="search"
          onFocus={() => {
            if (query.trim()) setIsOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          className={`w-full pl-10 pr-10 py-2.5 border rounded-xl text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 disabled:opacity-50 ${
            selectedMember 
              ? 'border-green-500 dark:border-green-400 bg-green-50 dark:bg-green-900/20 ring-2 ring-green-500/30 dark:ring-green-400/30' 
              : 'border-primary/20 dark:border-white/20 bg-white dark:bg-black/20 focus:ring-primary/30 dark:focus:ring-lavender/30'
          }`}
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 hover:text-primary dark:hover:text-white"
            aria-label="Clear search"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden="true">close</span>
          </button>
        )}
      </div>

      {dropdownContent && createPortal(dropdownContent, document.body)}

      <div aria-live="polite" className="sr-only">
        {isOpen && filteredMembers.length > 0
          ? `${filteredMembers.length} result${filteredMembers.length === 1 ? '' : 's'} available`
          : isOpen && query.trim() && !isSearching
            ? 'No results available'
            : ''}
      </div>
    </div>
  );
};

export default MemberSearchInput;

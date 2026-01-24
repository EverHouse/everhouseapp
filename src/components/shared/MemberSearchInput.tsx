import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useData } from '../../contexts/DataContext';

export interface SelectedMember {
  id: string;
  email: string;
  name: string;
  tier: string | null;
  stripeCustomerId?: string | null;
}

// Helper to search by multiple words (e.g., "nick luu" matches "Nick Luu")
const matchesMultiWordQuery = (text: string | undefined, query: string): boolean => {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // All words must appear somewhere in the text
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
  excludeEmails = []
}) => {
  const { members } = useData();
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const excludeEmailsLower = useMemo(() => 
    excludeEmails.map(e => e.toLowerCase()), 
    [excludeEmails]
  );

  const filteredMembers = useMemo(() => {
    if (!query.trim()) return [];
    return members.filter(m => 
      (matchesMultiWordQuery(m.name, query) || matchesMultiWordQuery(m.email, query)) &&
      !excludeEmailsLower.includes(m.email.toLowerCase())
    ).slice(0, 8);
  }, [members, query, excludeEmailsLower]);

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

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current && 
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    setIsOpen(value.trim().length > 0);
    if (selectedMember && onClear) {
      onClear();
    }
  };

  const handleSelect = (member: typeof members[0]) => {
    const selected: SelectedMember = {
      id: member.id,
      email: member.email,
      name: member.name,
      tier: member.tier || null,
      stripeCustomerId: member.stripeCustomerId || null
    };
    setQuery(member.name);
    setIsOpen(false);
    onSelect(selected);
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

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && (
        <label htmlFor="member-search-input" className="block text-sm font-medium text-primary dark:text-white mb-2">
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
          id="member-search-input"
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => query.trim() && setIsOpen(true)}
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

      {/* Dropdown positioned absolutely within the container - moves naturally with scroll */}
      {isOpen && filteredMembers.length > 0 && (
        <div 
          ref={dropdownRef}
          className="absolute left-0 right-0 top-full mt-1 z-[9999] bg-white dark:bg-gray-900 border border-primary/10 dark:border-white/10 rounded-xl shadow-xl overflow-hidden max-h-64 overflow-y-auto"
        >
          {filteredMembers.map((member, index) => (
            <button
              key={member.email}
              type="button"
              onClick={() => handleSelect(member)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`w-full px-4 py-3 flex items-center gap-3 border-b border-primary/5 dark:border-white/5 last:border-0 transition-colors ${
                index === highlightedIndex 
                  ? 'bg-primary/10 dark:bg-white/10' 
                  : 'hover:bg-primary/5 dark:hover:bg-white/5'
              }`}
            >
              <div className="w-9 h-9 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-base text-primary dark:text-white">person</span>
              </div>
              <div className="text-left flex-1 min-w-0">
                <p className="font-medium text-primary dark:text-white truncate">{member.name}</p>
                <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                  {showTier && member.tier ? `${member.tier} • ` : ''}{privacyMode ? redactEmail(member.email) : member.email}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {isOpen && query.trim() && filteredMembers.length === 0 && (
        <div 
          className="absolute left-0 right-0 top-full mt-1 z-[9999] bg-white dark:bg-gray-900 border border-primary/10 dark:border-white/10 rounded-xl shadow-lg p-4 text-center"
        >
          <p className="text-sm text-primary/60 dark:text-white/60">No members found</p>
        </div>
      )}
    </div>
  );
};

export default MemberSearchInput;

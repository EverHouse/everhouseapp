import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import ModalShell from '../ModalShell';
import Input from '../Input';
import TierBadge from '../TierBadge';
import Avatar from '../Avatar';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import WalkingGolferSpinner from '../WalkingGolferSpinner';

interface MemberSearchResult {
  id: string;
  name: string;
  emailRedacted: string;
  tier?: string;
}

interface AddMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (userId: string, memberName: string) => void;
}

// Email is already redacted from API, no need for client-side redaction

const AddMemberModal: React.FC<AddMemberModalProps> = ({
  isOpen,
  onClose,
  onAdd
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const [searchListRef] = useAutoAnimate();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setHasSearched(false);
      setIsSearching(false);
    }
  }, [isOpen]);

  const searchMembers = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }
    
    setIsSearching(true);
    setHasSearched(true);
    
    try {
      const { ok, data } = await apiRequest<MemberSearchResult[]>(
        `/api/members/search?query=${encodeURIComponent(query)}&limit=10`
      );
      
      if (ok && data) {
        setSearchResults(data);
      } else {
        setSearchResults([]);
      }
    } catch (err: unknown) {
      console.error('[AddMemberModal] Error searching members:', err);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    
    if (searchQuery.length < 2) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }
    
    debounceRef.current = setTimeout(() => {
      searchMembers(searchQuery);
    }, 300);
    
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchQuery, searchMembers]);

  const handleSelectMember = (member: MemberSearchResult) => {
    onAdd(member.id, member.name);
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Add Member"
      size="md"
    >
      <div className="p-4 space-y-4">
        <Input
          label="Search Members"
          placeholder="Search by name or email..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          icon="search"
        />
        
        {isSearching && (
          <div className="flex items-center justify-center py-8">
            <WalkingGolferSpinner size="sm" />
          </div>
        )}
        
        {!isSearching && searchResults.length > 0 && (
          <div ref={searchListRef} className="space-y-2 max-h-72 overflow-y-auto">
            {searchResults.map((member) => (
              <button
                key={member.id}
                onClick={() => handleSelectMember(member)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl transition-colors ${
                  isDark 
                    ? 'hover:bg-white/10 active:bg-white/15' 
                    : 'hover:bg-black/5 active:bg-black/10'
                }`}
              >
                <Avatar 
                  name={member.name} 
                  size="md" 
                />
                <div className="flex-1 text-left min-w-0">
                  <p className={`font-semibold truncate ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                    {member.name}
                  </p>
                  <p className={`text-sm truncate ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                    {member.emailRedacted}
                  </p>
                </div>
                {member.tier && <TierBadge tier={member.tier} size="sm" />}
              </button>
            ))}
          </div>
        )}
        
        {!isSearching && hasSearched && searchResults.length === 0 && (
          <div className="text-center py-8">
            <span className={`material-symbols-outlined text-4xl mb-2 block ${isDark ? 'text-white/30' : 'text-[#293515]/30'}`}>
              search_off
            </span>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
              No members found
            </p>
          </div>
        )}
        
        {!isSearching && !hasSearched && (
          <div className="text-center py-8">
            <span className={`material-symbols-outlined text-4xl mb-2 block ${isDark ? 'text-white/30' : 'text-[#293515]/30'}`}>
              person_search
            </span>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
              Type at least 2 characters to search
            </p>
          </div>
        )}
      </div>
    </ModalShell>
  );
};

export default AddMemberModal;

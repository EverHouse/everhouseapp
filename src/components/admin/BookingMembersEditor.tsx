import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import TierBadge from '../TierBadge';

interface BookingMember {
  id: number;
  bookingId: number;
  userEmail: string | null;
  slotNumber: number;
  isPrimary: boolean;
  linkedAt: string | null;
  linkedBy: string | null;
  memberName: string;
}

interface BookingGuest {
  id: number;
  bookingId: number;
  guestName: string | null;
  guestEmail: string | null;
  slotNumber: number;
}

interface MemberSearchResult {
  email: string;
  firstName: string | null;
  lastName: string | null;
  tier: string | null;
}

interface ValidationInfo {
  expectedPlayerCount: number;
  actualPlayerCount: number;
  filledMemberSlots: number;
  guestCount: number;
  playerCountMismatch: boolean;
  emptySlots: number;
}

interface BookingMembersEditorProps {
  bookingId: number | string;
  onMemberLinked?: () => void;
}

const BookingMembersEditor: React.FC<BookingMembersEditorProps> = ({ bookingId, onMemberLinked }) => {
  const [members, setMembers] = useState<BookingMember[]>([]);
  const [guests, setGuests] = useState<BookingGuest[]>([]);
  const [validation, setValidation] = useState<ValidationInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkingSlotId, setLinkingSlotId] = useState<number | null>(null);
  const [unlinkingSlotId, setUnlinkingSlotId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [allMembers, setAllMembers] = useState<MemberSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [activeSearchSlot, setActiveSearchSlot] = useState<number | null>(null);
  
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchBookingMembers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
        setGuests(data.guests || []);
        setValidation(data.validation || null);
      } else {
        setError('Failed to load booking members');
      }
    } catch (err) {
      setError('Failed to load booking members');
    } finally {
      setIsLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    fetchBookingMembers();
  }, [fetchBookingMembers]);

  useEffect(() => {
    const fetchAllMembers = async () => {
      try {
        const res = await fetch('/api/hubspot/contacts', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const membersList: MemberSearchResult[] = data.map((m: { email: string; firstName?: string; lastName?: string; tier?: string }) => ({
            email: m.email,
            firstName: m.firstName || null,
            lastName: m.lastName || null,
            tier: m.tier || null
          }));
          setAllMembers(membersList);
        }
      } catch (err) {
        console.error('Failed to fetch members:', err);
      }
    };
    fetchAllMembers();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setActiveSearchSlot(null);
        setSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(() => {
      const query = searchQuery.toLowerCase();
      const linkedEmails = new Set(members.filter(m => m.userEmail).map(m => m.userEmail!.toLowerCase()));
      const filtered = allMembers.filter(m => {
        if (linkedEmails.has(m.email.toLowerCase())) return false;
        const fullName = `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase();
        return m.email.toLowerCase().includes(query) || fullName.includes(query);
      }).slice(0, 8);
      setSearchResults(filtered);
      setShowDropdown(filtered.length > 0);
      setIsSearching(false);
    }, 200);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery, allMembers, members]);

  const handleLinkMember = async (slotId: number, memberEmail: string) => {
    setLinkingSlotId(slotId);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members/${slotId}/link`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail })
      });
      
      if (res.ok) {
        await fetchBookingMembers();
        setShowDropdown(false);
        setActiveSearchSlot(null);
        setSearchQuery('');
        onMemberLinked?.();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to link member');
      }
    } catch (err) {
      setError('Failed to link member');
    } finally {
      setLinkingSlotId(null);
    }
  };

  const handleUnlinkMember = async (slotId: number) => {
    setUnlinkingSlotId(slotId);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members/${slotId}/unlink`, {
        method: 'PUT',
        credentials: 'include'
      });
      
      if (res.ok) {
        await fetchBookingMembers();
        onMemberLinked?.();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to unlink member');
      }
    } catch (err) {
      setError('Failed to unlink member');
    } finally {
      setUnlinkingSlotId(null);
    }
  };

  const emptySlots = useMemo(() => 
    members.filter(m => !m.userEmail),
    [members]
  );
  
  const filledSlots = useMemo(() => 
    members.filter(m => m.userEmail),
    [members]
  );

  if (isLoading) {
    return (
      <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
          <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
          Loading players...
        </div>
      </div>
    );
  }

  if (members.length === 0 && guests.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <span className="material-symbols-outlined text-primary dark:text-white text-lg">group</span>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wide">Players</p>
        </div>

        {error && (
          <div className="mb-3 p-2 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {validation?.emptySlots > 0 && (
          <div className="mb-3 p-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg flex items-center gap-2">
            <span className="material-symbols-outlined text-amber-500 text-base">warning</span>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {validation.emptySlots} empty player slot{validation.emptySlots > 1 ? 's' : ''} - link members to complete booking assignment
            </p>
          </div>
        )}

        <div className="space-y-2">
          {filledSlots.map((member) => (
            <div 
              key={member.id} 
              className="flex items-center justify-between p-2 bg-white dark:bg-black/20 rounded-lg border border-gray-100 dark:border-white/10"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary dark:text-white">{member.slotNumber}</span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-primary dark:text-white truncate">
                      {member.memberName}
                    </p>
                    {member.isPrimary && (
                      <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-accent/20 text-primary dark:text-accent shrink-0">
                        PRIMARY
                      </span>
                    )}
                  </div>
                  {member.userEmail && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{member.userEmail}</p>
                  )}
                </div>
              </div>
              {!member.isPrimary && member.userEmail && (
                <button
                  onClick={() => handleUnlinkMember(member.id)}
                  disabled={unlinkingSlotId === member.id}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  title="Remove from booking"
                >
                  {unlinkingSlotId === member.id ? (
                    <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined text-base">person_remove</span>
                  )}
                </button>
              )}
            </div>
          ))}

          {emptySlots.map((slot) => (
            <div 
              key={slot.id} 
              className="p-2 bg-white dark:bg-black/20 rounded-lg border border-dashed border-gray-200 dark:border-white/20"
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-gray-100 dark:bg-white/5 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-gray-400 dark:text-gray-500">{slot.slotNumber}</span>
                </div>
                
                {activeSearchSlot === slot.id ? (
                  <div className="flex-1 relative">
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-sm">search</span>
                      <input
                        ref={inputRef}
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onFocus={() => searchQuery.length >= 2 && searchResults.length > 0 && setShowDropdown(true)}
                        placeholder="Search by name or email..."
                        autoFocus
                        className="w-full py-1.5 pl-7 pr-8 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 text-primary dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      {isSearching && (
                        <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm animate-spin">progress_activity</span>
                      )}
                      {!isSearching && searchQuery && (
                        <button
                          onClick={() => {
                            setSearchQuery('');
                            setActiveSearchSlot(null);
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        >
                          <span className="material-symbols-outlined text-sm">close</span>
                        </button>
                      )}
                    </div>
                    
                    {showDropdown && searchResults.length > 0 && (
                      <div 
                        ref={dropdownRef}
                        className="absolute z-50 w-full mt-1 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/20 rounded-lg shadow-lg max-h-48 overflow-y-auto"
                      >
                        {searchResults.map((member, idx) => (
                          <button
                            key={member.email}
                            type="button"
                            onClick={() => handleLinkMember(slot.id, member.email)}
                            disabled={linkingSlotId === slot.id}
                            className={`w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-white/5 flex items-center justify-between disabled:opacity-50 ${idx !== searchResults.length - 1 ? 'border-b border-gray-100 dark:border-white/10' : ''}`}
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-primary dark:text-white truncate">
                                {member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.email}
                              </p>
                              {member.firstName && member.lastName && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{member.email}</p>
                              )}
                            </div>
                            {member.tier && (
                              <TierBadge tier={member.tier} size="sm" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    
                    {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">No members found</p>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setActiveSearchSlot(slot.id)}
                    className="flex-1 flex items-center gap-2 py-1.5 px-2 text-left text-gray-400 dark:text-gray-500 hover:text-primary dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">add</span>
                    <span className="text-sm">Add member to slot</span>
                  </button>
                )}
              </div>
            </div>
          ))}

          {guests.length > 0 && (
            <>
              <div className="pt-2 border-t border-gray-100 dark:border-white/10">
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase tracking-wide mb-2">Guests</p>
              </div>
              {guests.map((guest) => (
                <div 
                  key={guest.id} 
                  className="flex items-center gap-2 p-2 bg-amber-50/50 dark:bg-amber-500/5 rounded-lg border border-amber-100 dark:border-amber-500/20"
                >
                  <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-amber-600 dark:text-amber-400">{guest.slotNumber}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-primary dark:text-white truncate">
                        {guest.guestName || 'Guest'}
                      </p>
                      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shrink-0">
                        GUEST
                      </span>
                    </div>
                    {guest.guestEmail && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{guest.guestEmail}</p>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BookingMembersEditor;

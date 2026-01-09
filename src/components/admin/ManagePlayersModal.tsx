import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ModalShell from '../ModalShell';
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
  tier?: string | null;
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

interface ManagePlayersModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: {
    id: number;
    userEmail: string;
    userName: string;
    resourceId: number;
    requestDate: string;
    startTime: string;
    notes: string;
    playerCount?: number;
  };
  onSaved?: () => void;
}

function parseNamesFromNotes(notes: string): string[] {
  if (!notes) return [];
  const names: string[] = [];
  
  const withMatch = notes.match(/\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi);
  if (withMatch) {
    withMatch.forEach(m => {
      const name = m.replace(/^with\s+/i, '').trim();
      if (name && name.length > 2) names.push(name);
    });
  }
  
  const andMatch = notes.match(/([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)/gi);
  if (andMatch) {
    andMatch.forEach(m => {
      const parts = m.split(/\s+and\s+/i);
      parts.forEach(p => {
        const name = p.trim();
        if (name && name.length > 2 && !names.includes(name)) names.push(name);
      });
    });
  }
  
  const commaMatch = notes.match(/(?:players?|members?|guests?)[:\s]+([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)+)/i);
  if (commaMatch) {
    const nameList = commaMatch[1].split(',');
    nameList.forEach(n => {
      const name = n.trim();
      if (name && name.length > 2 && !names.includes(name)) names.push(name);
    });
  }
  
  return [...new Set(names)].slice(0, 5);
}

function hasAllMembersKeyword(notes: string): boolean {
  if (!notes) return false;
  return /all\s+members?/i.test(notes) || /full\s+group/i.test(notes);
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
  } catch {
    return dateStr;
  }
}

function getBayName(resourceId: number): string {
  const bayMap: Record<number, string> = {
    1: 'Bay 1',
    2: 'Bay 2', 
    3: 'Bay 3',
    4: 'Bay 4',
    5: 'Bay 5',
    6: 'Bay 6'
  };
  return bayMap[resourceId] || `Bay ${resourceId}`;
}

const ManagePlayersModal: React.FC<ManagePlayersModalProps> = ({
  isOpen,
  onClose,
  booking,
  onSaved
}) => {
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
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchBookingMembers = useCallback(async () => {
    if (!booking?.id) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/booking/${booking.id}/members`, { credentials: 'include' });
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
  }, [booking?.id]);

  useEffect(() => {
    if (isOpen) {
      fetchBookingMembers();
      setHasChanges(false);
    }
  }, [isOpen, fetchBookingMembers]);

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
    if (isOpen) {
      fetchAllMembers();
    }
  }, [isOpen]);

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
      const res = await fetch(`/api/admin/booking/${booking.id}/members/${slotId}/link`, {
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
        setHasChanges(true);
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
      const res = await fetch(`/api/admin/booking/${booking.id}/members/${slotId}/unlink`, {
        method: 'PUT',
        credentials: 'include'
      });
      
      if (res.ok) {
        await fetchBookingMembers();
        setHasChanges(true);
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

  const handleQuickAdd = (name: string) => {
    const query = name.toLowerCase();
    const match = allMembers.find(m => {
      const fullName = `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase();
      return fullName.includes(query) || (m.firstName?.toLowerCase() === query);
    });
    
    if (match) {
      const emptySlot = members.find(m => !m.userEmail && !m.isPrimary);
      if (emptySlot) {
        handleLinkMember(emptySlot.id, match.email);
      }
    } else {
      setSearchQuery(name);
      const emptySlot = members.find(m => !m.userEmail && !m.isPrimary);
      if (emptySlot) {
        setActiveSearchSlot(emptySlot.id);
      }
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    await new Promise(r => setTimeout(r, 300));
    setIsSaving(false);
    onSaved?.();
    onClose();
  };

  const suggestedNames = useMemo(() => parseNamesFromNotes(booking.notes), [booking.notes]);
  const showAllMembers = useMemo(() => hasAllMembersKeyword(booking.notes), [booking.notes]);
  
  const filledSlotCount = useMemo(() => 
    members.filter(m => m.userEmail).length + guests.length,
    [members, guests]
  );
  
  const expectedCount = validation?.expectedPlayerCount || booking.playerCount || members.length;
  const isComplete = filledSlotCount >= expectedCount;

  const ownerMember = useMemo(() => 
    members.find(m => m.isPrimary),
    [members]
  );
  
  const emptySlots = useMemo(() => 
    members.filter(m => !m.userEmail && !m.isPrimary),
    [members]
  );
  
  const filledSlots = useMemo(() => 
    members.filter(m => m.userEmail && !m.isPrimary),
    [members]
  );

  const ownerTier = useMemo(() => {
    if (!ownerMember?.userEmail) return null;
    const match = allMembers.find(m => m.email.toLowerCase() === ownerMember.userEmail?.toLowerCase());
    return match?.tier || null;
  }, [ownerMember, allMembers]);

  if (!isOpen) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Players"
      size="lg"
      showCloseButton={true}
    >
      <div className="p-4 space-y-4">
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-primary dark:text-white">
            {booking.userName}
          </h2>
          <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
            <span className="material-symbols-outlined text-base">check_circle</span>
            Currently assigned to: {booking.userName}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-base">calendar_today</span>
              {formatDate(booking.requestDate)} • {getBayName(booking.resourceId)}
            </span>
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-base">group</span>
              {expectedCount} players
            </span>
          </div>
          {booking.notes && (
            <div className="mt-2 p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium">Notes:</span> {booking.notes}
              </p>
            </div>
          )}
        </div>

        <div className={`flex items-center justify-between p-3 rounded-lg ${
          isComplete 
            ? 'bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30' 
            : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30'
        }`}>
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined text-lg ${
              isComplete ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
            }`}>groups</span>
            <span className={`text-sm font-medium ${
              isComplete ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'
            }`}>
              EXPECTED {expectedCount} Players
            </span>
          </div>
          <span className={`px-2.5 py-1 text-xs font-bold rounded-full ${
            isComplete 
              ? 'bg-green-600 text-white' 
              : 'bg-amber-500 text-white'
          }`}>
            {filledSlotCount}/{expectedCount} Assigned
          </span>
        </div>

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
              <span className="material-symbols-outlined text-base">error</span>
              {error}
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <span className="material-symbols-outlined animate-spin text-2xl text-gray-400">progress_activity</span>
          </div>
        ) : (
          <>
            {ownerMember && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">
                  <span className="material-symbols-outlined text-sm">lock</span>
                  Owner (Player 1)
                </div>
                <div className="flex items-center justify-between p-3 bg-primary/5 dark:bg-white/5 rounded-lg border border-primary/20 dark:border-white/10">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center">
                      <span className="material-symbols-outlined text-primary dark:text-white">person</span>
                    </div>
                    <div>
                      <p className="font-medium text-primary dark:text-white">
                        {ownerMember.memberName}
                      </p>
                      {ownerMember.userEmail && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{ownerMember.userEmail}</p>
                      )}
                    </div>
                  </div>
                  {ownerTier && <TierBadge tier={ownerTier} size="sm" />}
                </div>
              </div>
            )}

            {(suggestedNames.length > 0 || showAllMembers) && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">
                  <span className="material-symbols-outlined text-sm text-amber-500">lightbulb</span>
                  Quick Add from Notes
                </div>
                <div className="flex flex-wrap gap-2">
                  {suggestedNames.map((name, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleQuickAdd(name)}
                      className="px-3 py-1.5 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded-full text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-sm">person_add</span>
                      {name}
                    </button>
                  ))}
                  {showAllMembers && (
                    <span className="px-3 py-1.5 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded-full text-sm font-medium">
                      All Members
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">
                <span className="material-symbols-outlined text-sm">person</span>
                Player Slots
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {filledSlots.map((member) => (
                  <div 
                    key={member.id}
                    className="flex items-center justify-between p-3 bg-white dark:bg-black/20 rounded-lg border border-gray-200 dark:border-white/10"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                        <span className="material-symbols-outlined text-primary dark:text-white">person</span>
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-primary dark:text-white truncate">
                          {member.memberName}
                        </p>
                        {(() => {
                          const memberData = allMembers.find(m => m.email.toLowerCase() === member.userEmail?.toLowerCase());
                          return memberData?.tier ? (
                            <TierBadge tier={memberData.tier} size="sm" />
                          ) : null;
                        })()}
                      </div>
                    </div>
                    <button
                      onClick={() => handleUnlinkMember(member.id)}
                      disabled={unlinkingSlotId === member.id}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="Remove player"
                    >
                      {unlinkingSlotId === member.id ? (
                        <span className="material-symbols-outlined animate-spin">progress_activity</span>
                      ) : (
                        <span className="material-symbols-outlined">close</span>
                      )}
                    </button>
                  </div>
                ))}

                {guests.map((guest) => (
                  <div 
                    key={`guest-${guest.id}`}
                    className="flex items-center justify-between p-3 bg-amber-50/50 dark:bg-amber-500/5 rounded-lg border border-amber-200 dark:border-amber-500/20"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                        <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">person_outline</span>
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-primary dark:text-white truncate">
                          {guest.guestName || 'Guest'}
                        </p>
                        <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400">
                          GUEST
                        </span>
                      </div>
                    </div>
                  </div>
                ))}

                {emptySlots.map((slot) => (
                  <div 
                    key={slot.id}
                    className="relative"
                  >
                    {activeSearchSlot === slot.id ? (
                      <div className="p-3 bg-white dark:bg-black/20 rounded-lg border-2 border-accent">
                        <div className="relative">
                          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">search</span>
                          <input
                            ref={inputRef}
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onFocus={() => searchQuery.length >= 2 && searchResults.length > 0 && setShowDropdown(true)}
                            placeholder="Search by name or email..."
                            autoFocus
                            className="w-full py-2 pl-10 pr-8 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 text-primary dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
                          />
                          {isSearching && (
                            <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin">progress_activity</span>
                          )}
                          {!isSearching && searchQuery && (
                            <button
                              onClick={() => {
                                setSearchQuery('');
                                setActiveSearchSlot(null);
                              }}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            >
                              <span className="material-symbols-outlined text-sm">close</span>
                            </button>
                          )}
                        </div>
                        
                        {showDropdown && searchResults.length > 0 && (
                          <div 
                            ref={dropdownRef}
                            className="absolute left-0 right-0 z-50 mt-2 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/20 rounded-lg shadow-xl max-h-48 overflow-y-auto"
                          >
                            {searchResults.map((member, idx) => (
                              <button
                                key={member.email}
                                type="button"
                                onClick={() => handleLinkMember(slot.id, member.email)}
                                disabled={linkingSlotId === slot.id}
                                className={`w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-white/5 flex items-center justify-between disabled:opacity-50 ${idx !== searchResults.length - 1 ? 'border-b border-gray-100 dark:border-white/10' : ''}`}
                              >
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-primary dark:text-white truncate">
                                    {member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.email}
                                  </p>
                                  {member.firstName && member.lastName && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{member.email}</p>
                                  )}
                                </div>
                                {member.tier && <TierBadge tier={member.tier} size="sm" />}
                              </button>
                            ))}
                          </div>
                        )}
                        
                        {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">No members found</p>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => setActiveSearchSlot(slot.id)}
                        className="w-full p-4 flex items-center justify-center gap-2 bg-white dark:bg-black/20 rounded-lg border-2 border-dashed border-gray-300 dark:border-white/20 text-gray-500 dark:text-gray-400 hover:border-accent hover:text-accent dark:hover:border-accent dark:hover:text-accent transition-colors"
                      >
                        <span className="material-symbols-outlined">add</span>
                        <span className="font-medium">ADD Player {slot.slotNumber}</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="sticky bottom-0 p-4 border-t border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1d15] flex items-center justify-between gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {isSaving ? (
            <>
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Saving...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-sm">save</span>
              Save Players
            </>
          )}
        </button>
      </div>
    </ModalShell>
  );
};

export default ManagePlayersModal;

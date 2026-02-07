import React, { useState, useEffect, useMemo, useCallback } from 'react';
import SlideUpDrawer from '../SlideUpDrawer';
import TierBadge from '../TierBadge';
import { MemberSearchInput, SelectedMember } from '../shared/MemberSearchInput';
import { useData } from '../../contexts/DataContext';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../utils/errorHandling';

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
  originalEmail?: string | null;
}

interface BookingGuest {
  id: number;
  bookingId: number;
  guestName: string | null;
  guestEmail: string | null;
  slotNumber: number;
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
    const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    const date = new Date(datePart + 'T00:00:00');
    if (isNaN(date.getTime())) return dateStr;
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

function isPlaceholderEmail(email: string): boolean {
  if (!email) return true;
  const lower = email.toLowerCase();
  return lower.includes('@visitors.evenhouse.club') || 
         lower.includes('@trackman.local') || 
         lower.startsWith('classpass-') ||
         lower.startsWith('golfnow-') ||
         lower.startsWith('lesson-') ||
         lower.startsWith('unmatched-');
}

interface PendingLinkConfirmation {
  slotId: number;
  memberEmail: string;
  memberName: string;
  originalEmail: string;
}

const ManagePlayersModal: React.FC<ManagePlayersModalProps> = ({
  isOpen,
  onClose,
  booking,
  onSaved
}) => {
  const { members: allMembersList } = useData();
  const [bookingMembers, setBookingMembers] = useState<BookingMember[]>([]);
  const [guests, setGuests] = useState<BookingGuest[]>([]);
  const [validation, setValidation] = useState<ValidationInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkingSlotId, setLinkingSlotId] = useState<number | null>(null);
  const [unlinkingSlotId, setUnlinkingSlotId] = useState<number | null>(null);
  const [activeSearchSlot, setActiveSearchSlot] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [pendingLink, setPendingLink] = useState<PendingLinkConfirmation | null>(null);
  const [rememberEmail, setRememberEmail] = useState(true);

  const fetchBookingMembers = useCallback(async () => {
    if (!booking?.id) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/booking/${booking.id}/members`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setBookingMembers(data.members || []);
        setGuests(data.guests || []);
        setValidation(data.validation || null);
      } else {
        setError(getApiErrorMessage(res, 'load booking members'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsLoading(false);
    }
  }, [booking?.id]);

  useEffect(() => {
    if (isOpen) {
      fetchBookingMembers();
      setHasChanges(false);
      setPendingLink(null);
      setRememberEmail(true);
    }
  }, [isOpen, fetchBookingMembers]);

  const handleLinkMember = async (slotId: number, memberEmail: string, options?: { rememberEmail?: boolean; originalEmail?: string }) => {
    setLinkingSlotId(slotId);
    try {
      const body: { memberEmail: string; rememberEmail?: boolean; originalEmail?: string } = { memberEmail };
      if (options?.rememberEmail !== undefined) {
        body.rememberEmail = options.rememberEmail;
      }
      if (options?.originalEmail) {
        body.originalEmail = options.originalEmail;
      }

      const res = await fetch(`/api/admin/booking/${booking.id}/members/${slotId}/link`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      
      if (res.ok) {
        await fetchBookingMembers();
        setActiveSearchSlot(null);
        setPendingLink(null);
        setRememberEmail(true);
        setHasChanges(true);
      } else {
        setError(getApiErrorMessage(res, 'link member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setLinkingSlotId(null);
    }
  };

  const handleMemberSelected = (slot: BookingMember, member: SelectedMember) => {
    const slotOriginalEmail = slot.originalEmail;
    
    if (slotOriginalEmail && 
        !isPlaceholderEmail(slotOriginalEmail) && 
        slotOriginalEmail.toLowerCase() !== member.email.toLowerCase()) {
      setPendingLink({
        slotId: slot.id,
        memberEmail: member.email,
        memberName: member.name,
        originalEmail: slotOriginalEmail
      });
      setRememberEmail(true);
      setActiveSearchSlot(null);
    } else {
      handleLinkMember(slot.id, member.email);
    }
  };

  const handleConfirmLink = () => {
    if (!pendingLink) return;
    handleLinkMember(pendingLink.slotId, pendingLink.memberEmail, {
      rememberEmail,
      originalEmail: pendingLink.originalEmail
    });
  };

  const handleCancelPendingLink = () => {
    setPendingLink(null);
    setRememberEmail(true);
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
        setError(getApiErrorMessage(res, 'unlink member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setUnlinkingSlotId(null);
    }
  };

  const handleQuickAdd = (name: string) => {
    const query = name.toLowerCase();
    const match = allMembersList.find(m => {
      return m.name?.toLowerCase().includes(query);
    });
    
    if (match) {
      const emptySlot = bookingMembers.find(m => !m.userEmail && !m.isPrimary);
      if (emptySlot) {
        handleMemberSelected(emptySlot, { id: match.id?.toString() || '', email: match.email, name: match.name || '', tier: match.tier });
      }
    } else {
      const emptySlot = bookingMembers.find(m => !m.userEmail && !m.isPrimary);
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
    bookingMembers.filter(m => m.userEmail).length + guests.length,
    [bookingMembers, guests]
  );
  
  const expectedCount = validation?.expectedPlayerCount || booking.playerCount || bookingMembers.length;
  const isComplete = filledSlotCount >= expectedCount;

  const ownerMember = useMemo(() => 
    bookingMembers.find(m => m.isPrimary),
    [bookingMembers]
  );
  
  const emptySlots = useMemo(() => 
    bookingMembers.filter(m => !m.userEmail && !m.isPrimary),
    [bookingMembers]
  );
  
  const filledSlots = useMemo(() => 
    bookingMembers.filter(m => m.userEmail && !m.isPrimary),
    [bookingMembers]
  );

  const ownerTier = useMemo(() => {
    if (!ownerMember?.userEmail) return null;
    const match = allMembersList.find(m => m.email.toLowerCase() === ownerMember.userEmail?.toLowerCase());
    return match?.tier || null;
  }, [ownerMember, allMembersList]);

  const footerContent = (
    <div className="flex items-center justify-between gap-3 p-4">
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
  );

  if (!isOpen) return null;

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Players"
      maxHeight="large"
      stickyFooter={footerContent}
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
                          const memberData = allMembersList.find(m => m.email.toLowerCase() === member.userEmail?.toLowerCase());
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
                        <MemberSearchInput
                          onSelect={(selectedMember: SelectedMember) => handleMemberSelected(slot, selectedMember)}
                          onClear={() => setActiveSearchSlot(null)}
                          placeholder="Search by name or email..."
                          autoFocus
                          showTier
                          disabled={linkingSlotId === slot.id}
                          includeVisitors={true}
                        />
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
                
                {pendingLink && (
                  <div className="col-span-full p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center flex-shrink-0">
                        <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">link</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-primary dark:text-white">
                          Link {pendingLink.memberName}?
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Original booking email: <span className="font-medium">{pendingLink.originalEmail}</span>
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Member email: <span className="font-medium">{pendingLink.memberEmail}</span>
                        </p>
                      </div>
                    </div>
                    
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberEmail}
                        onChange={(e) => setRememberEmail(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-accent focus:ring-accent"
                      />
                      <span className="text-sm text-primary dark:text-white">
                        Remember this email for future bookings
                      </span>
                    </label>
                    
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleConfirmLink}
                        disabled={linkingSlotId !== null}
                        className="flex-1 px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {linkingSlotId !== null ? (
                          <>
                            <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            Linking...
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined text-sm">check</span>
                            Confirm Link
                          </>
                        )}
                      </button>
                      <button
                        onClick={handleCancelPendingLink}
                        disabled={linkingSlotId !== null}
                        className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </SlideUpDrawer>
  );
};

export default ManagePlayersModal;

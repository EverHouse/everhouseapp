import React, { useState, useEffect, useMemo, useCallback } from 'react';
import TierBadge from '../TierBadge';
import { MemberSearchInput, SelectedMember } from '../shared/MemberSearchInput';

interface BookingMember {
  id: number;
  bookingId: number;
  userEmail: string | null;
  slotNumber: number;
  isPrimary: boolean;
  linkedAt: string | null;
  linkedBy: string | null;
  memberName: string;
  tier: string | null;
  fee: number;
  feeNote: string;
}

interface BookingGuest {
  id: number;
  bookingId: number;
  guestName: string | null;
  guestEmail: string | null;
  slotNumber: number;
  fee: number;
  feeNote: string;
}

interface ValidationInfo {
  expectedPlayerCount: number;
  actualPlayerCount: number;
  filledMemberSlots: number;
  guestCount: number;
  playerCountMismatch: boolean;
  emptySlots: number;
}

interface FinancialSummary {
  ownerOverageFee: number;
  guestFeesWithoutPass: number;
  totalOwnerOwes: number;
  totalPlayersOwe: number;
  grandTotal: number;
  playerBreakdown: Array<{
    name: string;
    tier: string | null;
    fee: number;
    feeNote: string;
  }>;
}

interface BookingMembersEditorProps {
  bookingId: number | string;
  onMemberLinked?: () => void;
  onCollectPayment?: (bookingId: number) => void;
}

const BookingMembersEditor: React.FC<BookingMembersEditorProps> = ({ bookingId, onMemberLinked, onCollectPayment }) => {
  const [members, setMembers] = useState<BookingMember[]>([]);
  const [guests, setGuests] = useState<BookingGuest[]>([]);
  const [validation, setValidation] = useState<ValidationInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkingSlotId, setLinkingSlotId] = useState<number | null>(null);
  const [unlinkingSlotId, setUnlinkingSlotId] = useState<number | null>(null);
  const [activeSearchSlot, setActiveSearchSlot] = useState<number | null>(null);
  const [guestAddSlot, setGuestAddSlot] = useState<number | null>(null);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [isAddingGuest, setIsAddingGuest] = useState(false);
  const [guestPassesRemaining, setGuestPassesRemaining] = useState<number>(0);
  const [guestPassesTotal, setGuestPassesTotal] = useState<number>(0);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);
  const [memberMatchWarning, setMemberMatchWarning] = useState<{
    slotId: number;
    guestName: string;
    memberMatch: { email: string; name: string; tier: string; status: string; note: string };
  } | null>(null);

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
        setGuestPassesRemaining(data.ownerGuestPassesRemaining || 0);
        setGuestPassesTotal(data.tierLimits?.guest_passes_per_month || data.ownerGuestPassesRemaining || 0);
        setFinancialSummary(data.financialSummary || null);
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
        setActiveSearchSlot(null);
        onMemberLinked?.();
      } else if (res.status === 400) {
        const data = await res.json();
        await fetchBookingMembers();
        setActiveSearchSlot(null);
        if (data.error && data.error.includes('different member')) {
          setError(data.error);
        }
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

  const handleAddGuest = async (slotId: number, forceAddAsGuest: boolean = false) => {
    const nameToAdd = memberMatchWarning ? memberMatchWarning.guestName : guestName;
    if (!nameToAdd.trim()) {
      setError('Please enter a guest name');
      return;
    }
    setIsAddingGuest(true);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ guestName: nameToAdd.trim(), guestEmail: guestEmail.trim() || null, slotId, forceAddAsGuest })
      });
      
      if (res.ok) {
        const data = await res.json();
        await fetchBookingMembers();
        setGuestAddSlot(null);
        setGuestName('');
        setGuestEmail('');
        setActiveSearchSlot(null);
        setMemberMatchWarning(null);
        if (typeof data.guestPassesRemaining === 'number') {
          setGuestPassesRemaining(data.guestPassesRemaining);
        }
        onMemberLinked?.();
      } else if (res.status === 409) {
        const data = await res.json();
        if (data.memberMatch) {
          setMemberMatchWarning({
            slotId,
            guestName: nameToAdd.trim(),
            memberMatch: data.memberMatch
          });
        }
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to add guest');
      }
    } catch (err) {
      setError('Failed to add guest');
    } finally {
      setIsAddingGuest(false);
    }
  };

  const handleLinkMatchedMember = async () => {
    if (!memberMatchWarning) return;
    setLinkingSlotId(memberMatchWarning.slotId);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members/${memberMatchWarning.slotId}/link`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail: memberMatchWarning.memberMatch.email })
      });
      
      if (res.ok) {
        await fetchBookingMembers();
        setGuestAddSlot(null);
        setGuestName('');
        setActiveSearchSlot(null);
        setMemberMatchWarning(null);
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
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className="w-6 h-6 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary dark:text-white">{member.slotNumber}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-primary dark:text-white truncate">
                      {member.memberName}
                    </p>
                    {member.isPrimary && (
                      <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-accent/20 text-primary dark:text-accent shrink-0">
                        PRIMARY
                      </span>
                    )}
                    {member.tier && (
                      <TierBadge tier={member.tier} size="sm" />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {member.userEmail && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{member.userEmail}</p>
                    )}
                  </div>
                </div>
                {member.userEmail && (
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span 
                      className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${
                        member.fee === 0 
                          ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400' 
                          : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'
                      }`}
                      title={member.feeNote}
                    >
                      ${member.fee.toFixed(2)}
                    </span>
                    {member.feeNote && (
                      <span className="text-[9px] text-gray-500 dark:text-gray-400 max-w-[100px] truncate hidden sm:inline" title={member.feeNote}>
                        {member.feeNote}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {!member.isPrimary && member.userEmail && (
                <button
                  onClick={() => handleUnlinkMember(member.id)}
                  disabled={unlinkingSlotId === member.id}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50 ml-1"
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
                  <div className="flex-1">
                    <MemberSearchInput
                      placeholder="Search by name or email..."
                      autoFocus
                      disabled={linkingSlotId === slot.id}
                      onSelect={(member: SelectedMember) => handleLinkMember(slot.id, member.email)}
                      onClear={() => setActiveSearchSlot(null)}
                    />
                  </div>
                ) : guestAddSlot === slot.id ? (
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={guestName}
                        onChange={(e) => setGuestName(e.target.value)}
                        placeholder="Guest name *"
                        autoFocus
                        className="flex-1 py-1.5 px-2 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 text-primary dark:text-white placeholder:text-gray-400"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="email"
                        value={guestEmail}
                        onChange={(e) => setGuestEmail(e.target.value)}
                        placeholder="Guest email (required)"
                        className={`flex-1 py-1.5 px-2 text-sm rounded-lg border bg-white dark:bg-black/30 text-primary dark:text-white placeholder:text-gray-400 ${
                          guestName.trim() && !guestEmail.trim() ? 'border-red-300 dark:border-red-500/50' : 'border-gray-200 dark:border-white/20'
                        }`}
                        required
                      />
                    </div>
                    {guestName.trim() && !guestEmail.trim() && (
                      <p className="text-[10px] text-red-600 dark:text-red-400">Email is required for guest tracking</p>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleAddGuest(slot.id)}
                        disabled={isAddingGuest || !guestName.trim() || !guestEmail.trim()}
                        className="flex-1 py-1.5 text-xs font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-1"
                      >
                        {isAddingGuest ? (
                          <>
                            <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                            Adding...
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined text-sm">person_add</span>
                            {guestPassesRemaining > 0 ? 'Add Guest (Free)' : 'Add Guest ($25)'}
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => { setGuestAddSlot(null); setGuestName(''); setGuestEmail(''); }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                    {guestPassesRemaining === 0 && (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400">No guest passes remaining - $25 fee applies</p>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center gap-2">
                    <button
                      onClick={() => setActiveSearchSlot(slot.id)}
                      className="flex-1 flex items-center gap-2 py-1.5 px-2 text-left text-gray-400 dark:text-gray-500 hover:text-primary dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/5 rounded-lg transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">search</span>
                      <span className="text-sm">Find member</span>
                    </button>
                    <button
                      onClick={() => { setGuestAddSlot(slot.id); setGuestName(''); setGuestEmail(''); }}
                      className={`flex items-center gap-1 py-1.5 px-2 text-xs font-medium rounded-lg transition-colors ${
                        guestPassesRemaining > 0 
                          ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-500/30'
                          : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-500/30'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">person_add</span>
                      <span>Add Guest</span>
                      <span className="px-1 py-0.5 text-[10px] font-bold bg-white/50 dark:bg-black/30 rounded">
                        {guestPassesRemaining}/{guestPassesTotal}
                      </span>
                    </button>
                  </div>
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
                  className="flex items-center justify-between p-2 bg-amber-50/50 dark:bg-amber-500/5 rounded-lg border border-amber-100 dark:border-amber-500/20"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-bold text-amber-600 dark:text-amber-400">{guest.slotNumber}</span>
                    </div>
                    <div className="min-w-0 flex-1">
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
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span 
                      className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${
                        guest.fee === 0 
                          ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400' 
                          : 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400'
                      }`}
                      title={guest.feeNote}
                    >
                      ${guest.fee.toFixed(2)}
                    </span>
                    <span className="text-[9px] text-gray-500 dark:text-gray-400 max-w-[80px] truncate" title={guest.feeNote}>
                      {guest.feeNote}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Financial Summary - Always show when data is present */}
      {financialSummary && (
        <div className="mt-3 p-3 bg-gradient-to-r from-gray-50 to-white dark:from-gray-800/50 dark:to-gray-900 rounded-lg border border-gray-200 dark:border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-outlined text-primary dark:text-white text-sm">payments</span>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wide">Financial Summary</p>
          </div>
          
          <div className="space-y-2">
            {/* Owner Owes */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700 dark:text-gray-300">Owner Owes</span>
                {financialSummary.totalOwnerOwes > 0 && (
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">
                    {financialSummary.ownerOverageFee > 0 && financialSummary.guestFeesWithoutPass > 0 
                      ? `(overage + ${financialSummary.guestFeesWithoutPass > 25 ? 'guest fees' : 'guest fee'})`
                      : financialSummary.ownerOverageFee > 0 
                        ? '(tier overage)'
                        : financialSummary.guestFeesWithoutPass > 0 
                          ? '(guest fees)'
                          : ''}
                  </span>
                )}
              </div>
              <span className={`text-sm font-semibold ${financialSummary.totalOwnerOwes > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                {financialSummary.totalOwnerOwes > 0 ? `$${financialSummary.totalOwnerOwes.toFixed(2)}` : '$0.00'}
              </span>
            </div>
            
            {/* Players Owe */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700 dark:text-gray-300">Players Owe</span>
                {financialSummary.totalPlayersOwe > 0 && (
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">
                    ({financialSummary.playerBreakdown.filter(p => p.fee > 0).length} player{financialSummary.playerBreakdown.filter(p => p.fee > 0).length > 1 ? 's' : ''})
                  </span>
                )}
              </div>
              <span className={`text-sm font-semibold ${financialSummary.totalPlayersOwe > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                {financialSummary.totalPlayersOwe > 0 ? `$${financialSummary.totalPlayersOwe.toFixed(2)}` : '$0.00'}
              </span>
            </div>
            
            {/* Grand Total */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-200 dark:border-white/10">
              <span className="text-sm font-medium text-gray-800 dark:text-white">Total Due</span>
              <span className={`text-base font-bold ${financialSummary.grandTotal > 0 ? 'text-primary dark:text-white' : 'text-green-600 dark:text-green-400'}`}>
                {financialSummary.grandTotal > 0 ? `$${financialSummary.grandTotal.toFixed(2)}` : 'No fees due'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Collect Payment Button */}
      {financialSummary && financialSummary.grandTotal > 0 && (
        <button
          onClick={() => onCollectPayment?.(Number(bookingId))}
          className="w-full mt-3 py-2.5 px-4 bg-primary text-white rounded-lg font-medium flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors"
        >
          <span className="material-symbols-outlined text-lg">credit_card</span>
          Collect ${financialSummary.grandTotal.toFixed(2)}
        </button>
      )}

      {/* Member Match Warning Modal */}
      {memberMatchWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-md w-full p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-amber-500 text-xl">warning</span>
              <h3 className="text-base font-semibold text-primary dark:text-white">Member Detected</h3>
            </div>
            
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
              "{memberMatchWarning.guestName}" matches an existing member:
            </p>
            
            <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg mb-3">
              <p className="text-sm font-medium text-primary dark:text-white">{memberMatchWarning.memberMatch.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{memberMatchWarning.memberMatch.email}</p>
              <div className="flex items-center gap-2 mt-1">
                {memberMatchWarning.memberMatch.tier && (
                  <TierBadge tier={memberMatchWarning.memberMatch.tier} size="sm" />
                )}
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  ({memberMatchWarning.memberMatch.status})
                </span>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                {memberMatchWarning.memberMatch.note}
              </p>
            </div>
            
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Adding them as a member ensures proper tier-based billing. Adding as a guest uses a $25 guest pass fee instead.
            </p>
            
            <div className="flex gap-2">
              <button
                onClick={handleLinkMatchedMember}
                disabled={linkingSlotId === memberMatchWarning.slotId}
                className="flex-1 py-2 px-3 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
              >
                {linkingSlotId === memberMatchWarning.slotId ? 'Adding...' : 'Add as Member'}
              </button>
              <button
                onClick={() => handleAddGuest(memberMatchWarning.slotId, true)}
                disabled={isAddingGuest}
                className="flex-1 py-2 px-3 text-sm font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50"
              >
                {isAddingGuest ? 'Adding...' : 'Add as Guest Anyway'}
              </button>
            </div>
            
            <button
              onClick={() => { setMemberMatchWarning(null); setGuestName(''); setGuestAddSlot(null); }}
              className="w-full mt-2 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default BookingMembersEditor;

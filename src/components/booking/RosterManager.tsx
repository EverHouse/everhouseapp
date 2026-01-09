import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { useToast } from '../Toast';
import { haptic } from '../../utils/haptics';
import ModalShell from '../ModalShell';
import Avatar from '../Avatar';
import Input from '../Input';

export interface RosterParticipant {
  id: number;
  sessionId: number;
  userId: string | null;
  guestId: number | null;
  participantType: 'owner' | 'member' | 'guest';
  displayName: string;
  slotDuration: number | null;
  paymentStatus: string | null;
  inviteStatus: string | null;
  createdAt: string;
}

export interface RosterBooking {
  id: number;
  ownerEmail: string;
  ownerName: string;
  requestDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  resourceId: number | null;
  resourceName: string | null;
  status: string;
  sessionId: number | null;
}

interface ParticipantsResponse {
  booking: RosterBooking;
  declaredPlayerCount: number;
  currentParticipantCount: number;
  remainingSlots: number;
  participants: RosterParticipant[];
  ownerTier: string | null;
  guestPassesRemaining: number;
  guestPassesUsed: number;
  remainingMinutes: number;
}

interface FeePreviewResponse {
  booking: {
    id: number;
    durationMinutes: number;
    startTime: string;
    endTime: string;
  };
  participants: {
    total: number;
    members: number;
    guests: number;
    owner: number;
  };
  timeAllocation: {
    totalMinutes: number;
    minutesPerParticipant: number;
    allocations: Array<{
      displayName: string;
      type: string;
      minutes: number;
    }>;
  };
  ownerFees: {
    tier: string | null;
    includedDailyMinutes: number;
    ownerMinutesUsed: number;
    guestMinutesCharged: number;
    totalMinutesResponsible: number;
    overageMinutes: number;
    overageFee: number;
  };
  guestPasses: {
    monthlyAllowance: number;
    remaining: number;
    usedThisBooking: number;
    afterBooking: number;
  };
}

interface Member {
  id: string;
  name: string;
  emailRedacted: string;
  tier?: string;
}

export interface RosterManagerProps {
  bookingId: number;
  declaredPlayerCount: number;
  isOwner: boolean;
  isStaff: boolean;
  onUpdate?: () => void;
}

const RosterManager: React.FC<RosterManagerProps> = ({
  bookingId,
  declaredPlayerCount,
  isOwner,
  isStaff,
  onUpdate
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [participants, setParticipants] = useState<RosterParticipant[]>([]);
  const [booking, setBooking] = useState<RosterBooking | null>(null);
  const [guestPassesRemaining, setGuestPassesRemaining] = useState(0);
  const [feePreview, setFeePreview] = useState<FeePreviewResponse | null>(null);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const [memberSearch, setMemberSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Member[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [addingMember, setAddingMember] = useState(false);

  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [addingGuest, setAddingGuest] = useState(false);
  const [apiDeclaredPlayerCount, setApiDeclaredPlayerCount] = useState<number>(declaredPlayerCount);
  const [apiRemainingSlots, setApiRemainingSlots] = useState<number>(Math.max(0, declaredPlayerCount - 1));
  const [apiCurrentParticipantCount, setApiCurrentParticipantCount] = useState<number>(1); // Owner counts as 1

  const canManage = isOwner || isStaff;
  const remainingSlots = apiRemainingSlots;

  const fetchParticipants = useCallback(async () => {
    try {
      const { ok, data, error } = await apiRequest<ParticipantsResponse>(
        `/api/bookings/${bookingId}/participants`
      );
      
      if (ok && data) {
        setParticipants(data.participants);
        setBooking(data.booking);
        setGuestPassesRemaining(data.guestPassesRemaining);
        // Use API values which account for owner as participant
        if (data.declaredPlayerCount) {
          setApiDeclaredPlayerCount(data.declaredPlayerCount);
        }
        if (typeof data.remainingSlots === 'number') {
          setApiRemainingSlots(data.remainingSlots);
        }
        if (typeof data.currentParticipantCount === 'number') {
          setApiCurrentParticipantCount(data.currentParticipantCount);
        }
      } else {
        console.error('[RosterManager] Failed to fetch participants:', error);
      }
    } catch (err) {
      console.error('[RosterManager] Error fetching participants:', err);
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  const fetchFeePreview = useCallback(async () => {
    try {
      const { ok, data } = await apiRequest<FeePreviewResponse>(
        `/api/bookings/${bookingId}/participants/preview-fees`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      
      if (ok && data) {
        setFeePreview(data);
      }
    } catch (err) {
      console.error('[RosterManager] Error fetching fee preview:', err);
    }
  }, [bookingId]);

  useEffect(() => {
    fetchParticipants();
  }, [fetchParticipants]);

  useEffect(() => {
    if (participants.length > 0) {
      fetchFeePreview();
    }
  }, [participants, fetchFeePreview]);

  const searchMembers = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    
    setSearchLoading(true);
    try {
      const { ok, data } = await apiRequest<Member[]>(
        `/api/members/search?query=${encodeURIComponent(query)}&limit=10`
      );
      
      if (ok && data) {
        const existingIds = new Set(participants.map(p => p.userId));
        const filtered = data.filter(m => !existingIds.has(m.id));
        setSearchResults(filtered);
      }
    } catch (err) {
      console.error('[RosterManager] Error searching members:', err);
    } finally {
      setSearchLoading(false);
    }
  }, [participants]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (memberSearch) {
        searchMembers(memberSearch);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [memberSearch, searchMembers]);

  const handleAddMember = async (member: Member) => {
    setAddingMember(true);
    haptic.light();
    
    try {
      const { ok, error } = await apiRequest(
        `/api/bookings/${bookingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'member',
            userId: member.id
          })
        }
      );
      
      if (ok) {
        haptic.success();
        showToast(`${member.name} added to booking`, 'success');
        setShowAddMemberModal(false);
        setMemberSearch('');
        setSearchResults([]);
        await fetchParticipants();
        onUpdate?.();
      } else {
        haptic.error();
        showToast(error || 'Failed to add member', 'error');
      }
    } catch (err) {
      haptic.error();
      showToast('Failed to add member', 'error');
    } finally {
      setAddingMember(false);
    }
  };

  const handleAddGuest = async () => {
    if (!guestName.trim()) {
      showToast('Please enter the guest name', 'error');
      return;
    }
    
    setAddingGuest(true);
    haptic.light();
    
    try {
      const { ok, error } = await apiRequest(
        `/api/bookings/${bookingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'guest',
            guest: {
              name: guestName.trim(),
              email: guestEmail.trim() || undefined
            }
          })
        }
      );
      
      if (ok) {
        haptic.success();
        showToast(`${guestName} added as guest`, 'success');
        setShowGuestModal(false);
        setGuestName('');
        setGuestEmail('');
        await fetchParticipants();
        onUpdate?.();
      } else {
        haptic.error();
        showToast(error || 'Failed to add guest', 'error');
      }
    } catch (err) {
      haptic.error();
      showToast('Failed to add guest', 'error');
    } finally {
      setAddingGuest(false);
    }
  };

  const handleRemoveParticipant = async (participantId: number, displayName: string) => {
    setRemovingId(participantId);
    haptic.light();
    
    try {
      const { ok, error } = await apiRequest(
        `/api/bookings/${bookingId}/participants/${participantId}`,
        { method: 'DELETE' }
      );
      
      if (ok) {
        haptic.success();
        showToast(`${displayName} removed from booking`, 'success');
        await fetchParticipants();
        onUpdate?.();
      } else {
        haptic.error();
        showToast(error || 'Failed to remove participant', 'error');
      }
    } catch (err) {
      haptic.error();
      showToast('Failed to remove participant', 'error');
    } finally {
      setRemovingId(null);
    }
  };

  const getTypeBadge = (type: 'owner' | 'member' | 'guest') => {
    const styles = {
      owner: isDark 
        ? 'bg-[#CCB8E4]/20 text-[#CCB8E4] border-[#CCB8E4]/30' 
        : 'bg-[#CCB8E4]/30 text-[#5a4a6d] border-[#CCB8E4]/50',
      member: isDark
        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
        : 'bg-emerald-100 text-emerald-700 border-emerald-200',
      guest: isDark
        ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
        : 'bg-amber-100 text-amber-700 border-amber-200'
    };
    
    const labels = { owner: 'Owner', member: 'Member', guest: 'Guest' };
    
    return (
      <span className={`px-2 py-0.5 text-[11px] font-bold rounded border ${styles[type]}`}>
        {labels[type]}
      </span>
    );
  };

  const ownerParticipant = useMemo(() => 
    participants.find(p => p.participantType === 'owner'),
    [participants]
  );
  
  const otherParticipants = useMemo(() => 
    participants.filter(p => p.participantType !== 'owner'),
    [participants]
  );

  if (loading) {
    return (
      <div className={`glass-card rounded-3xl p-6 ${isDark ? 'border-white/10' : 'border-black/5'}`}>
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-[#CCB8E4] border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`glass-card rounded-3xl overflow-hidden ${isDark ? 'border-white/10' : 'border-black/5'}`}>
        <div className={`px-5 py-4 border-b ${isDark ? 'border-white/10' : 'border-black/5'}`}>
          <div className="flex items-center justify-between">
            <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-[#293515]'}`}>
              {canManage ? 'Manage Players' : 'Players'}
            </h3>
            <span className={`text-sm font-medium ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
              {apiCurrentParticipantCount}/{apiDeclaredPlayerCount}
            </span>
          </div>
        </div>

        <div className="p-5 space-y-3">
          {ownerParticipant && (
            <div className={`flex items-center gap-3 p-3 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/[0.02]'}`}>
              <Avatar name={ownerParticipant.displayName} size="md" />
              <div className="flex-1 min-w-0">
                <p className={`font-semibold truncate ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                  {ownerParticipant.displayName}
                </p>
              </div>
              {getTypeBadge('owner')}
            </div>
          )}

          {otherParticipants.map(participant => (
            <div 
              key={participant.id}
              className={`flex items-center gap-3 p-3 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/[0.02]'}`}
            >
              <Avatar name={participant.displayName} size="md" />
              <div className="flex-1 min-w-0">
                <p className={`font-semibold truncate ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                  {participant.displayName}
                </p>
              </div>
              {getTypeBadge(participant.participantType)}
              {canManage && (
                <button
                  onClick={() => handleRemoveParticipant(participant.id, participant.displayName)}
                  disabled={removingId === participant.id}
                  className={`p-2 rounded-full transition-colors ${
                    isDark 
                      ? 'hover:bg-red-500/20 text-red-400' 
                      : 'hover:bg-red-100 text-red-600'
                  } ${removingId === participant.id ? 'opacity-50' : ''}`}
                  aria-label={`Remove ${participant.displayName}`}
                >
                  {removingId === participant.id ? (
                    <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <span className="material-symbols-outlined text-xl">close</span>
                  )}
                </button>
              )}
            </div>
          ))}

          {remainingSlots > 0 && canManage && (
            <div className={`flex flex-col gap-2 p-3 rounded-2xl border-2 border-dashed ${
              isDark ? 'border-white/20' : 'border-black/10'
            }`}>
              <p className={`text-sm font-medium text-center ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
                {remainingSlots} slot{remainingSlots > 1 ? 's' : ''} available
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddMemberModal(true)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#293515] text-white font-semibold text-sm transition-all hover:bg-[#3a4a20] active:scale-[0.98]"
                >
                  <span className="material-symbols-outlined text-lg">person_add</span>
                  Add Member
                </button>
                <button
                  onClick={() => setShowGuestModal(true)}
                  disabled={guestPassesRemaining <= 0}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-semibold text-sm transition-all active:scale-[0.98] ${
                    guestPassesRemaining > 0
                      ? 'bg-[#CCB8E4] text-[#293515] hover:bg-[#baa6d6]'
                      : isDark
                        ? 'bg-white/10 text-white/40 cursor-not-allowed'
                        : 'bg-black/5 text-black/30 cursor-not-allowed'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg">group_add</span>
                  Add Guest
                </button>
              </div>
              {guestPassesRemaining > 0 && (
                <p className={`text-xs text-center ${isDark ? 'text-white/40' : 'text-[#293515]/40'}`}>
                  {guestPassesRemaining} guest pass{guestPassesRemaining > 1 ? 'es' : ''} remaining this month
                </p>
              )}
              {guestPassesRemaining <= 0 && (
                <p className={`text-xs text-center ${isDark ? 'text-amber-400/70' : 'text-amber-600'}`}>
                  No guest passes remaining this month
                </p>
              )}
            </div>
          )}

          {remainingSlots > 0 && !canManage && (
            <div className={`p-3 rounded-2xl border-2 border-dashed text-center ${
              isDark ? 'border-white/20' : 'border-black/10'
            }`}>
              <p className={`text-sm ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
                {remainingSlots} slot{remainingSlots > 1 ? 's' : ''} available
              </p>
            </div>
          )}
        </div>

        {feePreview && (
          <div className={`px-5 py-4 border-t ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-black/5 bg-black/[0.01]'}`}>
            <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-white/80' : 'text-[#293515]/80'}`}>
              Time Allocation
            </h4>
            
            <div className="space-y-2">
              {feePreview.timeAllocation.allocations.map((alloc, idx) => (
                <div key={idx} className="flex items-center justify-between">
                  <span className={`text-sm ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                    {alloc.displayName}
                  </span>
                  <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                    {alloc.minutes} min
                  </span>
                </div>
              ))}
              
              <div className={`pt-2 mt-2 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
                <div className="flex items-center justify-between">
                  <span className={`text-sm ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                    Total Session
                  </span>
                  <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                    {feePreview.timeAllocation.totalMinutes} min
                  </span>
                </div>
              </div>

              {feePreview.ownerFees.includedDailyMinutes > 0 && feePreview.ownerFees.includedDailyMinutes < 999 && (
                <>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                      Included (daily)
                    </span>
                    <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                      {feePreview.ownerFees.includedDailyMinutes} min
                    </span>
                  </div>
                  
                  {feePreview.ownerFees.overageMinutes > 0 && (
                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        Overage
                      </span>
                      <span className={`text-sm font-medium ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        {feePreview.ownerFees.overageMinutes} min
                      </span>
                    </div>
                  )}
                  
                  {feePreview.ownerFees.overageFee > 0 && (
                    <div className={`flex items-center justify-between pt-2 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
                      <span className={`text-sm font-semibold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        Est. Overage Fee
                      </span>
                      <span className={`text-sm font-bold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        ${feePreview.ownerFees.overageFee.toFixed(2)}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <ModalShell
        isOpen={showAddMemberModal}
        onClose={() => {
          setShowAddMemberModal(false);
          setMemberSearch('');
          setSearchResults([]);
        }}
        title="Add Member"
        size="md"
      >
        <div className="p-4 space-y-4">
          <Input
            label="Search Members"
            placeholder="Search by name or email..."
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            icon="search"
          />
          
          {searchLoading && (
            <div className="flex items-center justify-center py-6">
              <div className="animate-spin w-6 h-6 border-2 border-[#CCB8E4] border-t-transparent rounded-full" />
            </div>
          )}
          
          {!searchLoading && searchResults.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {searchResults.map(member => (
                <button
                  key={member.id}
                  onClick={() => handleAddMember(member)}
                  disabled={addingMember}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl transition-colors ${
                    isDark 
                      ? 'hover:bg-white/10 active:bg-white/15' 
                      : 'hover:bg-black/5 active:bg-black/10'
                  } ${addingMember ? 'opacity-50' : ''}`}
                >
                  <Avatar name={member.name} size="md" />
                  <div className="flex-1 text-left min-w-0">
                    <p className={`font-semibold truncate ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                      {member.name}
                    </p>
                    <p className={`text-sm truncate ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                      {member.emailRedacted}
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-[#CCB8E4]">add_circle</span>
                </button>
              ))}
            </div>
          )}
          
          {!searchLoading && memberSearch.length >= 2 && searchResults.length === 0 && (
            <div className="text-center py-6">
              <span className={`material-symbols-outlined text-4xl mb-2 ${isDark ? 'text-white/30' : 'text-[#293515]/30'}`}>
                search_off
              </span>
              <p className={`text-sm ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
                No members found
              </p>
            </div>
          )}
          
          {!searchLoading && memberSearch.length < 2 && (
            <div className="text-center py-6">
              <p className={`text-sm ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
                Type at least 2 characters to search
              </p>
            </div>
          )}
        </div>
      </ModalShell>

      <ModalShell
        isOpen={showGuestModal}
        onClose={() => {
          setShowGuestModal(false);
          setGuestName('');
          setGuestEmail('');
        }}
        title="Add Guest"
        size="md"
      >
        <div className="p-4 space-y-4">
          <Input
            label="Guest Name"
            placeholder="Enter guest's full name"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            icon="person"
          />
          
          <Input
            label="Guest Email (optional)"
            placeholder="Enter guest's email"
            type="email"
            value={guestEmail}
            onChange={(e) => setGuestEmail(e.target.value)}
            icon="mail"
          />
          
          <div className={`p-3 rounded-xl ${isDark ? 'bg-[#CCB8E4]/10' : 'bg-[#CCB8E4]/20'}`}>
            <p className={`text-sm ${isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]'}`}>
              <span className="font-semibold">{guestPassesRemaining}</span> guest pass{guestPassesRemaining !== 1 ? 'es' : ''} remaining this month
            </p>
          </div>
          
          <button
            onClick={handleAddGuest}
            disabled={addingGuest || !guestName.trim()}
            className={`w-full py-3 px-4 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${
              guestName.trim() && !addingGuest
                ? 'bg-[#293515] text-white hover:bg-[#3a4a20] active:scale-[0.98]'
                : isDark
                  ? 'bg-white/10 text-white/40 cursor-not-allowed'
                  : 'bg-black/5 text-black/30 cursor-not-allowed'
            }`}
          >
            {addingGuest ? (
              <>
                <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">group_add</span>
                Add Guest
              </>
            )}
          </button>
        </div>
      </ModalShell>
    </>
  );
};

export default RosterManager;

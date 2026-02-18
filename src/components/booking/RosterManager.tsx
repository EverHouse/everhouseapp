import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';
import { useToast } from '../Toast';
import { haptic } from '../../utils/haptics';
import ModalShell from '../ModalShell';
import Avatar from '../Avatar';
import Input from '../Input';
import MemberPaymentModal from './MemberPaymentModal';
import GuestPaymentChoiceModal from './GuestPaymentChoiceModal';
import { usePricing } from '../../hooks/usePricing';
import WalkingGolferSpinner from '../WalkingGolferSpinner';

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
  inviteExpiresAt: string | null;
  createdAt: string;
}

interface BookingConflictDetails {
  memberName: string;
  conflictingBooking: {
    id: number;
    date: string;
    startTime: string;
    endTime: string;
    resourceName?: string;
  };
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
  notes: string | null;
  staffNotes: string | null;
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
    declaredPlayerCount: number;
    totalSlots?: number;
    minutesPerParticipant: number;
    allocations: Array<{
      displayName: string;
      type: string;
      minutes: number;
    }>;
  };
  ownerFees: {
    tier: string | null;
    dailyAllowance: number;
    remainingMinutesToday: number;
    ownerMinutesUsed: number;
    guestMinutesCharged: number;
    totalMinutesResponsible: number;
    minutesWithinAllowance: number;
    overageMinutes: number;
    estimatedOverageFee: number;
    estimatedGuestFees?: number;
    estimatedTotalFees?: number;
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
  const { guestFeeDollars } = usePricing();
  const [rosterListRef] = useAutoAnimate();

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

  const [guestFirstName, setGuestFirstName] = useState('');
  const [guestLastName, setGuestLastName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestEmailError, setGuestEmailError] = useState<string | undefined>(undefined);
  const [addingGuest, setAddingGuest] = useState(false);
  const [apiDeclaredPlayerCount, setApiDeclaredPlayerCount] = useState<number>(declaredPlayerCount);
  const [apiRemainingSlots, setApiRemainingSlots] = useState<number>(Math.max(0, declaredPlayerCount - 1));
  const [apiCurrentParticipantCount, setApiCurrentParticipantCount] = useState<number>(1); // Owner counts as 1

  const [showConflictModal, setShowConflictModal] = useState(false);
  const [conflictDetails, setConflictDetails] = useState<BookingConflictDetails | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showGuestPaymentChoiceModal, setShowGuestPaymentChoiceModal] = useState(false);
  const [pendingGuestName, setPendingGuestName] = useState('');
  const [pendingGuestEmail, setPendingGuestEmail] = useState('');

  const canManage = isOwner || isStaff;

  const getExpiryCountdown = useCallback((expiresAt: string): string | null => {
    const now = Date.now();
    const expiryStr = expiresAt.endsWith('Z') ? expiresAt : expiresAt + 'Z';
    const expiry = new Date(expiryStr).getTime();
    const diffMs = expiry - now;
    
    if (diffMs <= 0) return 'Expired';
    
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) {
      return `Expires in ${diffMins} min`;
    }
    
    const diffHours = Math.floor(diffMins / 60);
    return `Expires in ${diffHours} hr${diffHours > 1 ? 's' : ''}`;
  }, []);
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
      const { ok, data, error, errorType, errorData } = await apiRequest<{ success: boolean; participant: any; conflict?: any; errorType?: string }>(
        `/api/bookings/${bookingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'member',
            userId: member.id
          })
        },
        { retryNonIdempotent: false }
      );
      
      if (ok && data) {
        haptic.success();
        showToast(`${member.name} added to booking`, 'success');
        setShowAddMemberModal(false);
        setMemberSearch('');
        setSearchResults([]);
        await fetchParticipants();
        onUpdate?.();
      } else {
        haptic.error();
        
        if (errorType === 'booking_conflict' || (error && error.includes('scheduling conflict'))) {
          const conflict = errorData?.conflict;
          setConflictDetails({
            memberName: member.name,
            conflictingBooking: conflict ? {
              id: conflict.id || 0,
              date: conflict.date || booking?.requestDate || 'Unknown',
              startTime: conflict.startTime || booking?.startTime || 'Unknown',
              endTime: conflict.endTime || booking?.endTime || 'Unknown',
              resourceName: conflict.resourceName || booking?.resourceName || undefined
            } : {
              id: 0,
              date: booking?.requestDate || 'Unknown',
              startTime: booking?.startTime || 'Unknown',
              endTime: booking?.endTime || 'Unknown',
              resourceName: booking?.resourceName || undefined
            }
          });
          setShowConflictModal(true);
          showToast(`${member.name} has a conflicting booking at this time`, 'warning');
        } else {
          showToast(error || 'Failed to add member', 'error');
        }
      }
    } catch (err) {
      haptic.error();
      showToast('Failed to add member', 'error');
    } finally {
      setAddingMember(false);
    }
  };

  const validateGuestEmail = (value: string): string | undefined => {
    if (!value.trim()) return 'Email is required for guest tracking';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) return 'Please enter a valid email address';
    return undefined;
  };

  const handleGuestEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setGuestEmail(value);
    if (guestEmailError) {
      setGuestEmailError(validateGuestEmail(value));
    }
  };

  const handleAddGuest = () => {
    if (!guestFirstName.trim() || !guestLastName.trim()) {
      showToast('Please enter the guest first and last name', 'error');
      return;
    }
    
    const emailError = validateGuestEmail(guestEmail);
    if (emailError) {
      setGuestEmailError(emailError);
      return;
    }
    
    haptic.light();
    
    setPendingGuestName(`${guestFirstName.trim()} ${guestLastName.trim()}`);
    setPendingGuestEmail(guestEmail.trim());
    setShowGuestModal(false);
    setShowGuestPaymentChoiceModal(true);
    setGuestFirstName('');
    setGuestLastName('');
    setGuestEmail('');
    setGuestEmailError(undefined);
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

  const pendingGuestFees = useMemo(() => {
    const pendingGuests = participants.filter(
      p => p.participantType === 'guest' && 
           (p.paymentStatus === 'pending' || p.paymentStatus === null)
    );
    return {
      count: pendingGuests.length,
      participants: pendingGuests
    };
  }, [participants]);

  const handlePaymentSuccess = useCallback(() => {
    setShowPaymentModal(false);
    showToast('Payment successful! Guest fees have been paid.', 'success');
    haptic.success();
    fetchParticipants();
    onUpdate?.();
  }, [showToast, fetchParticipants, onUpdate]);

  if (loading) {
    return (
      <div className={`glass-card rounded-3xl p-6 ${isDark ? 'border-white/10' : 'border-black/5'}`}>
        <div className="flex items-center justify-center py-8">
          <WalkingGolferSpinner size="sm" />
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

        <div ref={rosterListRef} className="p-5 space-y-3">
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
                {participant.inviteStatus === 'pending' && participant.inviteExpiresAt && (
                  <span className={`inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 text-[10px] font-bold rounded ${
                    isDark 
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' 
                      : 'bg-amber-100 text-amber-700 border border-amber-200'
                  }`}>
                    <span className="material-symbols-outlined text-xs">schedule</span>
                    {getExpiryCountdown(participant.inviteExpiresAt)}
                  </span>
                )}
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
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#293515] text-white font-semibold text-sm transition-all duration-fast hover:bg-[#3a4a20] active:scale-[0.98]"
                >
                  <span className="material-symbols-outlined text-lg">person_add</span>
                  Add Member
                </button>
                <button
                  onClick={() => setShowGuestModal(true)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-semibold text-sm transition-all duration-fast active:scale-[0.98] bg-[#CCB8E4] text-[#293515] hover:bg-[#baa6d6]"
                >
                  <span className="material-symbols-outlined text-lg">group_add</span>
                  Add Guest
                </button>
              </div>
              <p className={`text-xs text-center ${guestPassesRemaining > 0 ? (isDark ? 'text-white/40' : 'text-[#293515]/40') : (isDark ? 'text-amber-400/70' : 'text-amber-600')}`}>
                {guestPassesRemaining > 0
                  ? `${guestPassesRemaining} guest pass${guestPassesRemaining > 1 ? 'es' : ''} remaining this month`
                  : `No passes left — $${guestFeeDollars} guest fee applies`
                }
              </p>
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
              
              {/* Open Slots - show unfilled slots so math balances */}
              {(() => {
                const declaredCount = feePreview.timeAllocation.declaredPlayerCount || apiDeclaredPlayerCount;
                const filledCount = feePreview.timeAllocation.allocations.length;
                const unfilledCount = Math.max(0, declaredCount - filledCount);
                const minutesPerSlot = feePreview.timeAllocation.minutesPerParticipant;
                
                return Array.from({ length: unfilledCount }, (_, idx) => (
                  <div key={`open-${idx}`} className="flex items-center justify-between">
                    <span className={`text-sm italic ${isDark ? 'text-white/40' : 'text-[#293515]/40'}`}>
                      Open Slot {filledCount + idx + 1}
                    </span>
                    <span className={`text-sm font-medium ${isDark ? 'text-white/40' : 'text-[#293515]/40'}`}>
                      {minutesPerSlot} min
                    </span>
                  </div>
                ));
              })()}
              
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

              {feePreview.ownerFees.dailyAllowance > 0 && feePreview.ownerFees.dailyAllowance < 999 && (
                <>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                      Included (daily)
                    </span>
                    <span className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                      {feePreview.ownerFees.dailyAllowance} min
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
                  
                  {feePreview.ownerFees.estimatedOverageFee > 0 && (
                    <div className={`flex items-center justify-between pt-2 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
                      <span className={`text-sm font-semibold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        Est. Overage Fee
                      </span>
                      <span className={`text-sm font-bold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                        ${feePreview.ownerFees.estimatedOverageFee.toFixed(2)}
                      </span>
                    </div>
                  )}
                </>
              )}

              {isOwner && ((feePreview?.ownerFees?.estimatedTotalFees ?? 0) > 0 || pendingGuestFees.count > 0 || (feePreview?.ownerFees?.estimatedOverageFee ?? 0) > 0) && (
                <div className={`mt-4 pt-4 border-t ${isDark ? 'border-white/10' : 'border-black/5'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                        Estimated Fees
                      </p>
                      <p className={`text-xs ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
                        {(feePreview?.ownerFees?.estimatedOverageFee ?? 0) > 0 && `$${feePreview?.ownerFees?.estimatedOverageFee?.toFixed(2)} overage`}
                        {(feePreview?.ownerFees?.estimatedOverageFee ?? 0) > 0 && (feePreview?.ownerFees?.estimatedGuestFees ?? 0) > 0 && ' + '}
                        {(feePreview?.ownerFees?.estimatedGuestFees ?? 0) > 0 && `$${feePreview?.ownerFees?.estimatedGuestFees?.toFixed(2)} guest fees`}
                      </p>
                    </div>
                    <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                      ${(feePreview?.ownerFees?.estimatedTotalFees ?? ((feePreview?.ownerFees?.estimatedOverageFee ?? 0) + (feePreview?.ownerFees?.estimatedGuestFees ?? 0))).toFixed(2)}
                    </span>
                  </div>
                  {(booking?.status === 'confirmed' || booking?.status === 'approved') ? (
                    <button
                      onClick={() => {
                        haptic.light();
                        setShowPaymentModal(true);
                      }}
                      className="w-full py-3 px-4 rounded-xl bg-primary text-white font-semibold text-sm transition-colors hover:bg-primary/90 active:scale-[0.98] flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-lg">credit_card</span>
                      Pay Now
                    </button>
                  ) : (
                    <p className={`text-xs text-center ${isDark ? 'text-white/50' : 'text-[#293515]/50'}`}>
                      Pay now or at check-in once booking is approved
                    </p>
                  )}
                </div>
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
              <WalkingGolferSpinner size="sm" />
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
          setGuestFirstName('');
          setGuestLastName('');
          setGuestEmail('');
          setGuestEmailError(undefined);
        }}
        title="Add Guest"
        size="md"
      >
        <div className="p-4 space-y-4">
          <Input
            label="First Name"
            placeholder="Enter first name"
            value={guestFirstName}
            onChange={(e) => setGuestFirstName(e.target.value)}
            icon="person"
          />
          
          <Input
            label="Last Name"
            placeholder="Enter last name"
            value={guestLastName}
            onChange={(e) => setGuestLastName(e.target.value)}
            icon="person"
          />
          
          <Input
            label="Guest Email"
            placeholder="Enter guest's email"
            type="email"
            value={guestEmail}
            onChange={handleGuestEmailChange}
            icon="mail"
            error={guestEmailError}
            required
          />
          
          <div className={`p-3 rounded-xl ${guestPassesRemaining > 0 ? (isDark ? 'bg-[#CCB8E4]/10' : 'bg-[#CCB8E4]/20') : (isDark ? 'bg-amber-500/10' : 'bg-amber-50')}`}>
            <p className={`text-sm ${guestPassesRemaining > 0 ? (isDark ? 'text-[#CCB8E4]' : 'text-[#5a4a6d]') : (isDark ? 'text-amber-400' : 'text-amber-700')}`}>
              {guestPassesRemaining > 0
                ? <>You have <span className="font-semibold">{guestPassesRemaining}</span> guest pass{guestPassesRemaining !== 1 ? 'es' : ''} remaining</>
                : `No passes left — a $${guestFeeDollars} fee will apply`
              }
            </p>
          </div>
          
          <button
            onClick={handleAddGuest}
            disabled={!guestFirstName.trim() || !guestLastName.trim() || !guestEmail.trim()}
            className={`w-full py-3 px-4 rounded-xl font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
              guestFirstName.trim() && guestLastName.trim() && guestEmail.trim()
                ? 'bg-[#293515] text-white hover:bg-[#3a4a20] active:scale-[0.98]'
                : isDark
                  ? 'bg-white/10 text-white/40 cursor-not-allowed'
                  : 'bg-black/5 text-black/30 cursor-not-allowed'
            }`}
          >
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
            Continue
          </button>
        </div>
      </ModalShell>

      <ModalShell
        isOpen={showConflictModal}
        onClose={() => {
          setShowConflictModal(false);
          setConflictDetails(null);
        }}
        title="Booking Conflict"
        size="sm"
      >
        <div className="p-4 space-y-4">
          <div className={`flex items-center gap-3 p-4 rounded-2xl ${
            isDark ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'
          }`}>
            <span className={`material-symbols-outlined text-3xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              warning
            </span>
            <div className="flex-1">
              <p className={`font-semibold ${isDark ? 'text-white' : 'text-[#293515]'}`}>
                {conflictDetails?.memberName || 'This member'} already has a booking
              </p>
              <p className={`text-sm ${isDark ? 'text-white/60' : 'text-[#293515]/60'}`}>
                They cannot be added to this session due to a time conflict.
              </p>
            </div>
          </div>

          {conflictDetails?.conflictingBooking && (
            <div className={`p-4 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-black/[0.02]'}`}>
              <h4 className={`text-sm font-bold mb-2 ${isDark ? 'text-white/80' : 'text-[#293515]/80'}`}>
                Conflicting Booking Details
              </h4>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-lg ${isDark ? 'text-white/40' : 'text-[#293515]/40'}`}>
                    calendar_today
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/80' : 'text-[#293515]/80'}`}>
                    {conflictDetails.conflictingBooking.date}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-lg ${isDark ? 'text-white/40' : 'text-[#293515]/40'}`}>
                    schedule
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/80' : 'text-[#293515]/80'}`}>
                    {conflictDetails.conflictingBooking.startTime} - {conflictDetails.conflictingBooking.endTime}
                  </span>
                </div>
                {conflictDetails.conflictingBooking.resourceName && (
                  <div className="flex items-center gap-2">
                    <span className={`material-symbols-outlined text-lg ${isDark ? 'text-white/40' : 'text-[#293515]/40'}`}>
                      sports_golf
                    </span>
                    <span className={`text-sm ${isDark ? 'text-white/80' : 'text-[#293515]/80'}`}>
                      {conflictDetails.conflictingBooking.resourceName}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setShowConflictModal(false);
              setConflictDetails(null);
            }}
            className="w-full py-3 px-4 rounded-xl bg-[#293515] text-white font-bold text-sm transition-all duration-fast hover:bg-[#3a4a20] active:scale-[0.98]"
          >
            Understood
          </button>
        </div>
      </ModalShell>

      {booking?.sessionId && (
        <MemberPaymentModal
          isOpen={showPaymentModal}
          bookingId={bookingId}
          sessionId={booking.sessionId}
          ownerEmail={booking.ownerEmail}
          ownerName={booking.ownerName}
          onSuccess={handlePaymentSuccess}
          onClose={() => setShowPaymentModal(false)}
        />
      )}

      {showGuestPaymentChoiceModal && booking && (
        <GuestPaymentChoiceModal
          bookingId={bookingId}
          sessionId={booking.sessionId}
          guestName={pendingGuestName}
          guestEmail={pendingGuestEmail}
          ownerEmail={booking.ownerEmail}
          ownerName={booking.ownerName}
          guestPassesRemaining={guestPassesRemaining}
          onSuccess={() => {
            haptic.success();
            showToast(`${pendingGuestName} added as guest`, 'success');
            setShowGuestPaymentChoiceModal(false);
            setPendingGuestName('');
            setPendingGuestEmail('');
            fetchParticipants();
            onUpdate?.();
          }}
          onClose={() => {
            setShowGuestPaymentChoiceModal(false);
            setPendingGuestName('');
            setPendingGuestEmail('');
          }}
        />
      )}
    </>
  );
};

export default RosterManager;

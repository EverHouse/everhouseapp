import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import TierBadge from '../TierBadge';
import { MemberSearchInput, SelectedMember } from '../shared/MemberSearchInput';
import { useData } from '../../contexts/DataContext';
import { useToast } from '../Toast';
import { StripePaymentForm } from '../stripe/StripePaymentForm';
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
  allPaid?: boolean;
}

interface BookingContext {
  requestDate?: string;
  startTime?: string;
  endTime?: string;
  resourceId?: number;
  resourceName?: string;
  durationMinutes?: number;
  notes?: string;
  ownerName?: string;
}

interface ParticipantFee {
  participantId: number;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  paymentStatus: 'pending' | 'paid' | 'waived';
  overageFee: number;
  guestFee: number;
  totalFee: number;
  tierAtBooking: string | null;
  dailyAllowance?: number;
  minutesUsed?: number;
  guestPassUsed?: boolean;
  waiverNeedsReview?: boolean;
  prepaidOnline?: boolean;
}

interface BillingContext {
  bookingId: number;
  sessionId: number | null;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  memberNotes: string | null;
  participants: ParticipantFee[];
  totalOutstanding: number;
  hasUnpaidBalance: boolean;
  overageMinutes?: number;
  overageFeeCents?: number;
  overagePaid?: boolean;
  hasUnpaidOverage?: boolean;
}

interface BookingMembersEditorProps {
  bookingId: number | string;
  onMemberLinked?: () => void;
  onCollectPayment?: (bookingId: number) => void;
  bookingContext?: BookingContext;
  showHeader?: boolean;
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

function formatBookingDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
  } catch {
    return dateStr;
  }
}

function formatTime12(time: string): string {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
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

const BookingMembersEditor: React.FC<BookingMembersEditorProps> = ({ 
  bookingId, 
  onMemberLinked, 
  onCollectPayment,
  bookingContext,
  showHeader = false
}) => {
  const { members: allMembersList } = useData();
  const [members, setMembers] = useState<BookingMember[]>([]);
  const [guests, setGuests] = useState<BookingGuest[]>([]);
  const [validation, setValidation] = useState<ValidationInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkingSlotId, setLinkingSlotId] = useState<number | null>(null);
  const [unlinkingSlotId, setUnlinkingSlotId] = useState<number | null>(null);
  const [activeSearchSlot, setActiveSearchSlot] = useState<number | null>(null);
  const [guestAddSlot, setGuestAddSlot] = useState<number | null>(null);
  const [guestMode, setGuestMode] = useState<'search' | 'new'>('search');
  const [guestSearchQuery, setGuestSearchQuery] = useState('');
  const [guestSearchResults, setGuestSearchResults] = useState<Array<{id: string; name: string; email: string; emailRedacted: string; visitorType?: string}>>([]);
  const [isSearchingGuests, setIsSearchingGuests] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [isAddingGuest, setIsAddingGuest] = useState(false);
  const [guestPassesRemaining, setGuestPassesRemaining] = useState<number>(0);
  const [guestPassesTotal, setGuestPassesTotal] = useState<number>(0);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);
  const guestSearchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [memberMatchWarning, setMemberMatchWarning] = useState<{
    slotId: number;
    guestName: string;
    memberMatch: { email: string; name: string; tier: string; status: string; note: string };
  } | null>(null);

  // Inline billing section state
  const [showBillingSection, setShowBillingSection] = useState(false);
  const [billingContext, setBillingContext] = useState<BillingContext | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingActionInProgress, setBillingActionInProgress] = useState<string | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [showWaiverInput, setShowWaiverInput] = useState<number | 'all' | null>(null);
  const [showStripePayment, setShowStripePayment] = useState(false);
  const [frozenPaymentData, setFrozenPaymentData] = useState<{
    participantFees: Array<{id: number; amount: number}>;
    totalAmount: number;
    description: string;
  } | null>(null);
  
  // Player count editing state
  const [isEditingPlayerCount, setIsEditingPlayerCount] = useState(false);
  const [editingPlayerCount, setEditingPlayerCount] = useState<number>(1);
  const [isUpdatingPlayerCount, setIsUpdatingPlayerCount] = useState(false);
  
  const { showToast } = useToast();

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
        // Use tier limits for total, or guestPassContext.passesBeforeBooking + used passes for accurate total
        const tierTotal = data.tierLimits?.guest_passes_per_month;
        if (tierTotal !== undefined && tierTotal !== null) {
          setGuestPassesTotal(tierTotal);
        } else if (data.guestPassContext) {
          // Calculate total from remaining + used this month (passesBeforeBooking is remaining before this booking)
          setGuestPassesTotal(data.guestPassContext.passesBeforeBooking + data.guestPassContext.passesUsedThisBooking);
        } else {
          setGuestPassesTotal(4); // Default fallback for display purposes
        }
        setFinancialSummary(data.financialSummary || null);
      } else {
        setError(getApiErrorMessage(res, 'load booking members'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
        setError(getApiErrorMessage(res, 'link member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
        setError(getApiErrorMessage(res, 'unlink member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
        setError(getApiErrorMessage(res, 'add guest'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
        setError(getApiErrorMessage(res, 'link member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setLinkingSlotId(null);
    }
  };

  const handleGuestSearch = useCallback((query: string) => {
    setGuestSearchQuery(query);
    
    if (guestSearchTimeoutRef.current) {
      clearTimeout(guestSearchTimeoutRef.current);
    }
    
    if (query.length < 2) {
      setGuestSearchResults([]);
      return;
    }
    
    guestSearchTimeoutRef.current = setTimeout(async () => {
      setIsSearchingGuests(true);
      try {
        // Search both members and past guests in parallel
        const [membersRes, guestsRes] = await Promise.all([
          fetch(`/api/members/search?query=${encodeURIComponent(query)}&limit=6&includeVisitors=false`, {
            credentials: 'include'
          }),
          fetch(`/api/guests/search?query=${encodeURIComponent(query)}&limit=6&includeFullEmail=true`, {
            credentials: 'include'
          })
        ]);
        
        const combinedResults: Array<{id: string; name: string; email: string; emailRedacted: string; visitorType?: string; isMember?: boolean}> = [];
        const seenEmails = new Set<string>();
        
        // Add members first (they take priority)
        if (membersRes.ok) {
          const members = await membersRes.json();
          for (const m of members) {
            const email = (m.email || '').toLowerCase();
            if (!seenEmails.has(email)) {
              seenEmails.add(email);
              combinedResults.push({
                id: m.id,
                name: m.name || `${m.firstName || ''} ${m.lastName || ''}`.trim() || 'Unknown',
                email: m.email || '',
                emailRedacted: m.email || '',
                visitorType: m.tier || 'Member',
                isMember: true
              });
            }
          }
        }
        
        // Add guests (visitors) that aren't already in the list
        if (guestsRes.ok) {
          const guests = await guestsRes.json();
          for (const g of guests) {
            const email = (g.email || g.emailRedacted || '').toLowerCase();
            if (!seenEmails.has(email)) {
              seenEmails.add(email);
              combinedResults.push({
                id: g.id,
                name: g.name,
                email: g.email || g.emailRedacted || '',
                emailRedacted: g.emailRedacted || g.email || '',
                visitorType: g.visitorType || 'Guest'
              });
            }
          }
        }
        
        setGuestSearchResults(combinedResults.slice(0, 10));
      } catch (err) {
        console.error('Guest search error:', err);
      } finally {
        setIsSearchingGuests(false);
      }
    }, 300);
  }, []);

  const handleSelectGuest = async (slotId: number, guest: {id: string; name: string; email: string}) => {
    setGuestName(guest.name);
    setGuestEmail(guest.email);
    setGuestSearchQuery('');
    setGuestSearchResults([]);
    
    await handleAddGuest(slotId, guest.name, guest.email);
  };

  const resetGuestForm = () => {
    setGuestAddSlot(null);
    setGuestName('');
    setGuestEmail('');
    setGuestSearchQuery('');
    setGuestSearchResults([]);
    setGuestMode('search');
  };

  // Billing section functions
  const fetchBillingContext = useCallback(async () => {
    setBillingLoading(true);
    setBillingError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/staff-checkin-context`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setBillingContext(data);
      } else {
        setBillingError('Failed to load billing context');
      }
    } catch (err) {
      setBillingError('Failed to load billing context');
    } finally {
      setBillingLoading(false);
    }
  }, [bookingId]);

  const handleToggleBillingSection = useCallback(async () => {
    if (showBillingSection) {
      setShowBillingSection(false);
      setShowStripePayment(false);
      setFrozenPaymentData(null);
    } else {
      setShowBillingSection(true);
      await fetchBillingContext();
    }
  }, [showBillingSection, fetchBillingContext]);

  const handleConfirmPayment = async (participantId: number) => {
    if (!billingContext) return;
    
    // Store previous state for rollback
    const previousBillingContext = billingContext;
    
    // Optimistically update the participant's payment status to 'paid'
    setBillingContext({
      ...billingContext,
      participants: billingContext.participants.map(p =>
        p.participantId === participantId ? { ...p, paymentStatus: 'paid' } : p
      ),
      totalOutstanding: billingContext.totalOutstanding - (billingContext.participants.find(p => p.participantId === participantId)?.totalFee || 0),
      hasUnpaidBalance: billingContext.participants.filter(p => p.participantId !== participantId && p.paymentStatus === 'pending' && p.totalFee > 0).length > 0
    });
    
    setBillingActionInProgress(`confirm-${participantId}`);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ participantId, action: 'confirm' })
      });
      if (res.ok) {
        showToast('Payment confirmed', 'success');
        // Refresh to get accurate server state
        await fetchBillingContext();
        await fetchBookingMembers();
      } else {
        // Rollback on failure
        setBillingContext(previousBillingContext);
        showToast('Failed to confirm payment', 'error');
      }
    } catch (err) {
      console.error('Failed to confirm payment:', err);
      // Rollback on error
      setBillingContext(previousBillingContext);
      showToast('Failed to confirm payment', 'error');
    } finally {
      setBillingActionInProgress(null);
    }
  };

  const handleWaivePayment = async (participantId: number | 'all') => {
    if (!waiverReason.trim()) {
      return;
    }
    setBillingActionInProgress(`waive-${participantId}`);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          participantId: participantId === 'all' ? undefined : participantId,
          action: participantId === 'all' ? 'waive_all' : 'waive',
          reason: waiverReason.trim()
        })
      });
      if (res.ok) {
        showToast(participantId === 'all' ? 'All fees waived' : 'Fee waived', 'success');
        setWaiverReason('');
        setShowWaiverInput(null);
        await fetchBillingContext();
        await fetchBookingMembers();
      } else {
        showToast('Failed to waive fee', 'error');
      }
    } catch (err) {
      console.error('Failed to waive payment:', err);
      showToast('Failed to waive fee', 'error');
    } finally {
      setBillingActionInProgress(null);
    }
  };

  const handleUseGuestPass = async (participantId: number) => {
    setBillingActionInProgress(`guest-pass-${participantId}`);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ participantId, action: 'use_guest_pass' })
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`Guest pass used${data.passesRemaining !== undefined ? ` (${data.passesRemaining} remaining)` : ''}`, 'success');
        await fetchBillingContext();
        await fetchBookingMembers();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to use guest pass', 'error');
      }
    } catch (err) {
      console.error('Failed to use guest pass:', err);
      showToast('Failed to use guest pass', 'error');
    } finally {
      setBillingActionInProgress(null);
    }
  };

  const handleConfirmAll = async () => {
    if (!billingContext) return;
    
    // Store previous state for rollback
    const previousBillingContext = billingContext;
    
    // Optimistically update all participants' payment status to 'paid'
    setBillingContext({
      ...billingContext,
      participants: billingContext.participants.map(p =>
        p.paymentStatus === 'pending' && p.totalFee > 0 ? { ...p, paymentStatus: 'paid' } : p
      ),
      totalOutstanding: 0,
      hasUnpaidBalance: false
    });
    
    setBillingActionInProgress('confirm-all');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'confirm_all' })
      });
      if (res.ok) {
        showToast('All payments confirmed', 'success');
        // Refresh to get accurate server state
        await fetchBillingContext();
        await fetchBookingMembers();
      } else {
        // Rollback on failure
        setBillingContext(previousBillingContext);
        showToast('Failed to confirm payments', 'error');
      }
    } catch (err) {
      console.error('Failed to confirm all payments:', err);
      // Rollback on error
      setBillingContext(previousBillingContext);
      showToast('Failed to confirm payments', 'error');
    } finally {
      setBillingActionInProgress(null);
    }
  };

  const handleShowStripePayment = () => {
    if (!billingContext) return;
    const pendingParticipants = billingContext.participants.filter(p => p.paymentStatus === 'pending' && p.totalFee > 0);
    const fees = pendingParticipants.map(p => ({ id: p.participantId, amount: p.totalFee }));
    const totalAmount = fees.reduce((sum, f) => sum + f.amount, 0);
    
    // Format date nicely (e.g., "Jan 27, 2026")
    let formattedDate = 'Booking';
    if (billingContext.bookingDate) {
      const dateObj = new Date(billingContext.bookingDate + 'T12:00:00');
      if (!isNaN(dateObj.getTime())) {
        formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
    
    // Format times (e.g., "8:30 AM - 12:30 PM")
    const formatTime = (time: string) => {
      const [h, m] = time.split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour = h % 12 || 12;
      return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
    };
    const timeRange = `${formatTime(billingContext.startTime)} - ${formatTime(billingContext.endTime)}`;
    
    // Build fee breakdown
    const totalOverage = pendingParticipants.reduce((sum, p) => sum + (p.overageFee || 0), 0);
    const totalGuestFees = pendingParticipants.reduce((sum, p) => sum + (p.guestFee || 0), 0);
    const breakdownParts: string[] = [];
    if (totalOverage > 0) breakdownParts.push(`Overage: $${totalOverage.toFixed(2)}`);
    if (totalGuestFees > 0) breakdownParts.push(`Guest fees: $${totalGuestFees.toFixed(2)}`);
    const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';
    
    const description = `${billingContext.resourceName} • ${formattedDate} • ${timeRange}${breakdown}`;
    
    setFrozenPaymentData({ participantFees: fees, totalAmount, description });
    setShowStripePayment(true);
  };

  const handleStripePaymentSuccess = async () => {
    showToast('Payment successful!', 'success');
    setShowStripePayment(false);
    setFrozenPaymentData(null);
    await fetchBillingContext();
    await fetchBookingMembers();
  };

  const emptySlots = useMemo(() => 
    members.filter(m => !m.userEmail),
    [members]
  );
  
  const filledSlots = useMemo(() => 
    members.filter(m => m.userEmail),
    [members]
  );

  const filledSlotCount = useMemo(() => 
    members.filter(m => m.userEmail).length + guests.length,
    [members, guests]
  );

  const expectedCount = validation?.expectedPlayerCount || members.length;
  const isRosterComplete = filledSlotCount >= expectedCount;

  const suggestedNames = useMemo(() => 
    parseNamesFromNotes(bookingContext?.notes || ''),
    [bookingContext?.notes]
  );

  const showAllMembersHint = useMemo(() => 
    hasAllMembersKeyword(bookingContext?.notes || ''),
    [bookingContext?.notes]
  );

  const timeAllocationPerPlayer = useMemo(() => {
    const duration = bookingContext?.durationMinutes || 60;
    const playerCount = expectedCount || 1;
    return Math.round(duration / playerCount);
  }, [bookingContext?.durationMinutes, expectedCount]);

  const handleQuickAdd = (name: string) => {
    const query = name.toLowerCase();
    const match = allMembersList.find(m => {
      return m.name?.toLowerCase().includes(query);
    });
    
    if (match) {
      const emptySlot = members.find(m => !m.userEmail && !m.isPrimary);
      if (emptySlot) {
        handleLinkMember(emptySlot.id, match.email);
      }
    } else {
      const emptySlot = members.find(m => !m.userEmail && !m.isPrimary);
      if (emptySlot) {
        setActiveSearchSlot(emptySlot.id);
      }
    }
  };

  const handleStartEditPlayerCount = () => {
    setEditingPlayerCount(expectedCount);
    setIsEditingPlayerCount(true);
  };

  const handleCancelEditPlayerCount = () => {
    setIsEditingPlayerCount(false);
    setEditingPlayerCount(expectedCount);
  };

  const handleSavePlayerCount = async () => {
    if (editingPlayerCount === expectedCount) {
      setIsEditingPlayerCount(false);
      return;
    }

    setIsUpdatingPlayerCount(true);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/player-count`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ playerCount: editingPlayerCount })
      });

      if (res.ok) {
        showToast(`Player count updated to ${editingPlayerCount}`, 'success');
        setIsEditingPlayerCount(false);
        await fetchBookingMembers();
        if (onMemberLinked) {
          onMemberLinked();
        }
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to update player count', 'error');
      }
    } catch (err) {
      showToast('Failed to update player count', 'error');
    } finally {
      setIsUpdatingPlayerCount(false);
    }
  };

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

  if (members.length === 0 && guests.length === 0 && !validation) {
    return (
      <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500 text-sm">
          <span className="material-symbols-outlined text-base">group</span>
          No player data available
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Booking Context Header - Only shown when showHeader is true */}
      {showHeader && bookingContext && (
        <div className="p-3 bg-primary/5 dark:bg-white/5 rounded-lg border border-primary/10 dark:border-white/10">
          {bookingContext.ownerName && (
            <h3 className="text-base font-semibold text-primary dark:text-white mb-2">
              {bookingContext.ownerName}
            </h3>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
            {bookingContext.requestDate && (
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">calendar_today</span>
                {formatBookingDate(bookingContext.requestDate)}
              </span>
            )}
            {(bookingContext.resourceName || bookingContext.resourceId) && (
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">sports_golf</span>
                {bookingContext.resourceName || (bookingContext.resourceId && getBayName(bookingContext.resourceId))}
              </span>
            )}
            {bookingContext.startTime && (
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">schedule</span>
                {formatTime12(bookingContext.startTime)}
                {bookingContext.endTime && ` - ${formatTime12(bookingContext.endTime)}`}
              </span>
            )}
            {bookingContext.durationMinutes && (
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">timer</span>
                {bookingContext.durationMinutes} min
              </span>
            )}
          </div>
          {bookingContext.notes && (
            <div className="mt-2 pt-2 border-t border-primary/10 dark:border-white/10">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium">Notes:</span> {bookingContext.notes}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Player Count Summary Banner */}
      {showHeader && (
        <div className={`flex items-center justify-between p-3 rounded-lg ${
          isRosterComplete 
            ? 'bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30' 
            : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30'
        }`}>
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined text-lg ${
              isRosterComplete ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
            }`}>groups</span>
            <div className="flex items-center gap-2">
              {isEditingPlayerCount ? (
                <div className="flex items-center gap-2">
                  <select
                    value={editingPlayerCount}
                    onChange={(e) => setEditingPlayerCount(parseInt(e.target.value, 10))}
                    className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-primary dark:text-white"
                    disabled={isUpdatingPlayerCount}
                  >
                    {[1, 2, 3, 4].map(n => (
                      <option key={n} value={n}>{n} Player{n !== 1 ? 's' : ''}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleSavePlayerCount}
                    disabled={isUpdatingPlayerCount}
                    className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-500/20 text-green-600 dark:text-green-400"
                    title="Save"
                  >
                    <span className="material-symbols-outlined text-sm">
                      {isUpdatingPlayerCount ? 'progress_activity' : 'check'}
                    </span>
                  </button>
                  <button
                    onClick={handleCancelEditPlayerCount}
                    disabled={isUpdatingPlayerCount}
                    className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-500/20 text-red-600 dark:text-red-400"
                    title="Cancel"
                  >
                    <span className="material-symbols-outlined text-sm">close</span>
                  </button>
                </div>
              ) : (
                <>
                  <span className={`text-sm font-medium ${
                    isRosterComplete ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'
                  }`}>
                    {expectedCount} Player{expectedCount !== 1 ? 's' : ''} Expected
                  </span>
                  <button
                    onClick={handleStartEditPlayerCount}
                    className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400"
                    title="Edit player count"
                  >
                    <span className="material-symbols-outlined text-sm">edit</span>
                  </button>
                </>
              )}
              {!isEditingPlayerCount && bookingContext?.durationMinutes && expectedCount > 0 && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  ({timeAllocationPerPlayer} min each)
                </span>
              )}
            </div>
          </div>
          <span className={`px-2.5 py-1 text-xs font-bold rounded-full ${
            isRosterComplete 
              ? 'bg-green-600 text-white' 
              : 'bg-amber-500 text-white'
          }`}>
            {filledSlotCount}/{expectedCount} Assigned
          </span>
        </div>
      )}

      {/* Suggested Names from Notes (Quick Add) */}
      {showHeader && (suggestedNames.length > 0 || showAllMembersHint) && emptySlots.length > 0 && (
        <div className="p-2 bg-amber-50/50 dark:bg-amber-500/5 rounded-lg border border-amber-100 dark:border-amber-500/20">
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium mb-2">
            <span className="material-symbols-outlined text-sm text-amber-500">lightbulb</span>
            Quick Add from Notes
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestedNames.map((name, idx) => (
              <button
                key={idx}
                onClick={() => handleQuickAdd(name)}
                className="px-2.5 py-1 bg-white dark:bg-black/20 text-amber-700 dark:text-amber-300 rounded-full text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors flex items-center gap-1 border border-amber-200 dark:border-amber-500/30"
              >
                <span className="material-symbols-outlined text-xs">person_add</span>
                {name}
              </button>
            ))}
            {showAllMembersHint && (
              <span className="px-2.5 py-1 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded-full text-xs font-medium border border-blue-200 dark:border-blue-500/30">
                All Members
              </span>
            )}
          </div>
        </div>
      )}

      <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <span className="material-symbols-outlined text-primary dark:text-white text-lg">group</span>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wide">Players</p>
          {!showHeader && validation && (
            <span className={`ml-auto px-2 py-0.5 text-[10px] font-bold rounded-full ${
              isRosterComplete 
                ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400' 
                : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'
            }`}>
              {filledSlotCount}/{expectedCount}
            </span>
          )}
        </div>

        {error && (
          <div className="mb-3 p-2 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {validation?.emptySlots > 0 && !showHeader && (
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
                      forceApiSearch
                    />
                  </div>
                ) : guestAddSlot === slot.id ? (
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-1 mb-1">
                      <button
                        onClick={() => setGuestMode('search')}
                        className={`px-2 py-1 text-[10px] font-medium rounded-l-lg transition-colors ${
                          guestMode === 'search'
                            ? 'bg-primary text-white'
                            : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                      >
                        Search
                      </button>
                      <button
                        onClick={() => setGuestMode('new')}
                        className={`px-2 py-1 text-[10px] font-medium rounded-r-lg transition-colors ${
                          guestMode === 'new'
                            ? 'bg-primary text-white'
                            : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'
                        }`}
                      >
                        New
                      </button>
                      <button
                        onClick={resetGuestForm}
                        className="ml-auto p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                    
                    {guestMode === 'search' ? (
                      <div className="relative">
                        <input
                          type="text"
                          value={guestSearchQuery}
                          onChange={(e) => handleGuestSearch(e.target.value)}
                          placeholder="Search members or past guests..."
                          autoFocus
                          className="w-full py-1.5 px-2 text-sm rounded-lg border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 text-primary dark:text-white placeholder:text-gray-400"
                        />
                        {isSearchingGuests && (
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-sm animate-spin text-gray-400">progress_activity</span>
                        )}
                        {guestSearchResults.length > 0 && (
                          <div className="absolute z-50 left-0 right-0 mt-1 rounded-lg border shadow-lg overflow-hidden max-h-40 overflow-y-auto bg-white dark:bg-gray-900 border-gray-200 dark:border-white/20">
                            {guestSearchResults.map((result) => {
                              const isMember = (result as any).isMember === true;
                              return (
                                <button
                                  key={result.id}
                                  type="button"
                                  onClick={() => {
                                    if (isMember) {
                                      handleLinkMember(slot.id, result.email);
                                      resetGuestForm();
                                    } else {
                                      handleSelectGuest(slot.id, { id: result.id, name: result.name, email: result.email || result.emailRedacted });
                                    }
                                  }}
                                  className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-2 border-b border-gray-100 dark:border-white/5 last:border-b-0"
                                >
                                  <span className={`material-symbols-outlined text-base ${isMember ? 'text-green-600 dark:text-green-400' : 'text-amber-500'}`}>
                                    {isMember ? 'verified_user' : 'person'}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-primary dark:text-white truncate">{result.name}</p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{result.email || result.emailRedacted}</p>
                                  </div>
                                  {result.visitorType && (
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                      isMember 
                                        ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400' 
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400'
                                    }`}>
                                      {result.visitorType}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {guestSearchQuery.length >= 2 && !isSearchingGuests && guestSearchResults.length === 0 && (
                          <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">No results found. Try "New" to add a new guest.</p>
                        )}
                      </div>
                    ) : (
                      <>
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
                        <button
                          onClick={() => handleAddGuest(slot.id)}
                          disabled={isAddingGuest || !guestName.trim() || !guestEmail.trim()}
                          className="w-full py-1.5 text-xs font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-1"
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
                      </>
                    )}
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
          
          <div className="space-y-1.5">
            {/* Breakdown - only show items with fees */}
            {financialSummary.ownerOverageFee > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">Owner overage</span>
                <span className="text-gray-700 dark:text-gray-300">${financialSummary.ownerOverageFee.toFixed(2)}</span>
              </div>
            )}
            
            {financialSummary.totalPlayersOwe > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">
                  Player fees ({financialSummary.playerBreakdown.filter(p => p.fee > 0).length} player{financialSummary.playerBreakdown.filter(p => p.fee > 0).length > 1 ? 's' : ''})
                </span>
                <span className="text-gray-700 dark:text-gray-300">${financialSummary.totalPlayersOwe.toFixed(2)}</span>
              </div>
            )}
            
            {financialSummary.guestFeesWithoutPass > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">Guest fees</span>
                <span className="text-gray-700 dark:text-gray-300">${financialSummary.guestFeesWithoutPass.toFixed(2)}</span>
              </div>
            )}
            
            {/* Owner Pays Total */}
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-gray-200 dark:border-white/10">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-gray-800 dark:text-white">Owner Pays</span>
                <span className="text-[10px] text-gray-500 dark:text-gray-400">(total)</span>
              </div>
              <span className={`text-base font-bold ${financialSummary.grandTotal > 0 ? 'text-primary dark:text-white' : 'text-green-600 dark:text-green-400'}`}>
                {financialSummary.grandTotal > 0 ? `$${financialSummary.grandTotal.toFixed(2)}` : 'No fees due'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Collect Payment Button or Paid Indicator */}
      {financialSummary && financialSummary.allPaid && (
        <div className="w-full mt-3 py-2.5 px-4 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg font-medium flex items-center justify-center gap-2 border border-green-200 dark:border-green-800">
          <span className="material-symbols-outlined text-lg">check_circle</span>
          Paid
        </div>
      )}
      {financialSummary && financialSummary.grandTotal > 0 && !financialSummary.allPaid && (
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

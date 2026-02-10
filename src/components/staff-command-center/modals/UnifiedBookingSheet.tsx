import { useState, useEffect, useCallback, useRef } from 'react';
import { SlideUpDrawer } from '../../SlideUpDrawer';
import TrackmanIcon from '../../icons/TrackmanIcon';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';
import { useToast } from '../../Toast';
import { usePricing } from '../../../hooks/usePricing';
import TierBadge from '../../TierBadge';
import { StripePaymentForm } from '../../stripe/StripePaymentForm';

export type BookingType = 'simulator' | 'conference_room' | 'lesson' | 'staff_block';
export type SheetMode = 'assign' | 'manage';

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
  guestInfo?: { guestId: number; guestName: string; guestEmail: string; fee: number; feeNote: string; usedGuestPass: boolean } | null;
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
  playerBreakdown: Array<{ name: string; tier: string | null; fee: number; feeNote: string }>;
  allPaid?: boolean;
}

interface BookingContextType {
  requestDate?: string;
  startTime?: string;
  endTime?: string;
  resourceId?: number;
  resourceName?: string;
  durationMinutes?: number;
  notes?: string;
  trackmanCustomerNotes?: string;
}

interface ManageModeRosterData {
  members: BookingMember[];
  guests: BookingGuest[];
  validation: ValidationInfo;
  ownerGuestPassesRemaining: number;
  tierLimits?: { guest_passes_per_month: number };
  guestPassContext?: { passesBeforeBooking: number; passesUsedThisBooking: number };
  financialSummary?: FinancialSummary;
  bookingNotes?: { notes: string | null; staffNotes: string | null; trackmanNotes: string | null };
  sessionId?: number;
  ownerId?: string;
}

interface VisitorSearchResult {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name?: string;
  userType?: 'visitor' | 'member' | 'staff' | 'instructor';
  isInstructor?: boolean;
  staffRole?: string;
}

interface SlotState {
  type: 'empty' | 'member' | 'guest_placeholder' | 'visitor';
  member?: { id: string; email: string; name: string; tier?: string | null };
  guestName?: string;
}

type SlotsArray = [SlotState, SlotState, SlotState, SlotState];

interface MemberMatchWarning {
  slotNumber: number;
  guestData: { guestName: string; guestEmail: string; guestPhone?: string };
  memberMatch: { email: string; name: string; tier: string; status: string; note: string };
}

export interface UnifiedBookingSheetProps {
  isOpen: boolean;
  onClose: () => void;
  mode: SheetMode;
  bookingType?: BookingType;
  trackmanBookingId?: string | null;
  bayName?: string;
  bookingDate?: string;
  timeSlot?: string;
  matchedBookingId?: number | string;
  currentMemberName?: string;
  currentMemberEmail?: string;
  isRelink?: boolean;
  importedName?: string;
  notes?: string;
  isLegacyReview?: boolean;
  originalEmail?: string;
  bookingId?: number;
  ownerName?: string;
  ownerEmail?: string;
  declaredPlayerCount?: number;
  bookingContext?: BookingContextType;
  checkinMode?: boolean;
  onSuccess?: (options?: { markedAsEvent?: boolean; memberEmail?: string; memberName?: string }) => void;
  onOpenBillingModal?: (bookingId: number) => void;
  onRosterUpdated?: () => void;
  onCheckinComplete?: () => void;
  onCollectPayment?: (bookingId: number) => void;
  onReschedule?: (booking: { id: number; request_date: string; start_time: string; end_time: string; resource_id: number; resource_name?: string; user_name?: string; user_email?: string }) => void;
  onCancelBooking?: (bookingId: number) => void;
  onCheckIn?: (bookingId: number) => void;
  bookingStatus?: string;
  ownerMembershipStatus?: string | null;
}

export function UnifiedBookingSheet({
  isOpen,
  onClose,
  mode,
  bookingType,
  trackmanBookingId,
  bayName,
  bookingDate,
  timeSlot,
  matchedBookingId,
  currentMemberName,
  currentMemberEmail,
  isRelink,
  importedName,
  notes,
  isLegacyReview,
  originalEmail,
  bookingId,
  ownerName,
  ownerEmail,
  declaredPlayerCount,
  bookingContext,
  checkinMode,
  onSuccess,
  onOpenBillingModal,
  onRosterUpdated,
  onCheckinComplete,
  onCollectPayment,
  onReschedule,
  onCancelBooking,
  onCheckIn,
  bookingStatus,
  ownerMembershipStatus,
}: UnifiedBookingSheetProps) {
  const resolvedBookingType: BookingType = bookingType || 'simulator';
  const isConferenceRoom = resolvedBookingType === 'conference_room';
  const isLessonOrStaffBlock = resolvedBookingType === 'lesson' || resolvedBookingType === 'staff_block';

  const { guestFeeDollars } = usePricing();
  const [slots, setSlots] = useState<SlotsArray>([
    { type: 'empty' },
    { type: 'empty' },
    { type: 'empty' },
    { type: 'empty' }
  ]);
  const [activeSlotIndex, setActiveSlotIndex] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const [markingAsEvent, setMarkingAsEvent] = useState(false);
  const [showAddVisitor, setShowAddVisitor] = useState(false);
  const [visitorData, setVisitorData] = useState({ firstName: '', lastName: '', email: '', visitorType: '' as string });
  const [isCreatingVisitor, setIsCreatingVisitor] = useState(false);
  const [visitorSearch, setVisitorSearch] = useState('');
  const [visitorSearchResults, setVisitorSearchResults] = useState<VisitorSearchResult[]>([]);
  const [isSearchingVisitors, setIsSearchingVisitors] = useState(false);
  const [rememberEmail, setRememberEmail] = useState(true);
  const [potentialDuplicates, setPotentialDuplicates] = useState<Array<{id: string; email: string; name: string}>>([]);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [showStaffList, setShowStaffList] = useState(false);
  const [staffList, setStaffList] = useState<Array<{id: string; email: string; first_name: string; last_name: string; role: string; user_id: string | null}>>([]);
  const [isLoadingStaff, setIsLoadingStaff] = useState(false);
  const [assigningToStaff, setAssigningToStaff] = useState(false);
  const [showNoticeSelection, setShowNoticeSelection] = useState(false);
  const [overlappingNotices, setOverlappingNotices] = useState<Array<{id: number; title: string; reason: string | null; notice_type: string | null; start_date: string; end_date: string; start_time: string | null; end_time: string | null; source: string}>>([]);
  const [isLoadingNotices, setIsLoadingNotices] = useState(false);
  const { showToast } = useToast();
  const [feeEstimate, setFeeEstimate] = useState<{ totalCents: number; overageCents: number; guestCents: number } | null>(null);
  const [isCalculatingFees, setIsCalculatingFees] = useState(false);

  const [rosterData, setRosterData] = useState<ManageModeRosterData | null>(null);
  const [isLoadingRoster, setIsLoadingRoster] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [editingPlayerCount, setEditingPlayerCount] = useState<number>(declaredPlayerCount || 1);
  const [isUpdatingPlayerCount, setIsUpdatingPlayerCount] = useState(false);
  const [manageModeGuestForm, setManageModeGuestForm] = useState<number | null>(null);
  const [manageModeGuestData, setManageModeGuestData] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [isAddingManageGuest, setIsAddingManageGuest] = useState(false);
  const [memberMatchWarning, setMemberMatchWarning] = useState<MemberMatchWarning | null>(null);
  const [unlinkingSlotId, setUnlinkingSlotId] = useState<number | null>(null);
  const [removingGuestId, setRemovingGuestId] = useState<number | null>(null);
  const [manageModeSearchSlot, setManageModeSearchSlot] = useState<number | null>(null);
  const [isLinkingMember, setIsLinkingMember] = useState(false);
  const [savingChanges, setSavingChanges] = useState(false);
  const membersSnapshotRef = useRef<BookingMember[]>([]);
  const [showInlinePayment, setShowInlinePayment] = useState(false);
  const [inlinePaymentAction, setInlinePaymentAction] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [savedCardInfo, setSavedCardInfo] = useState<{hasSavedCard: boolean; cardLast4?: string; cardBrand?: string} | null>(null);
  const [checkingCard, setCheckingCard] = useState(false);
  const [waiverReason, setWaiverReason] = useState('');
  const [showWaiverInput, setShowWaiverInput] = useState(false);

  const isManageMode = mode === 'manage';

  const renderTierBadge = (tier: string | null | undefined) => {
    if (!tier) return null;
    if (tier === 'Staff') {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded">Staff</span>
      );
    }
    return <TierBadge tier={tier} size="sm" />;
  };

  const isPlaceholderEmail = (email: string): boolean => {
    if (!email) return true;
    const lower = email.toLowerCase();
    return lower.includes('@visitors.evenhouse.club') || 
           lower.includes('@trackman.local') || 
           lower.startsWith('classpass-') ||
           lower.startsWith('golfnow-') ||
           lower.startsWith('lesson-') ||
           lower.startsWith('unmatched-');
  };

  const shouldShowRememberEmail = (): boolean => {
    if (isManageMode) return false;
    const ownerSlot = slots[0];
    if (ownerSlot.type !== 'member' && ownerSlot.type !== 'visitor') return false;
    if (!originalEmail || isPlaceholderEmail(originalEmail)) return false;
    const selectedEmail = ownerSlot.member?.email?.toLowerCase() || '';
    return originalEmail.toLowerCase() !== selectedEmail;
  };

  const fetchRosterData = useCallback(async () => {
    if (!bookingId) return;
    setIsLoadingRoster(true);
    setRosterError(null);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members`, { credentials: 'include' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to load roster');
      }
      const data: ManageModeRosterData = await res.json();
      setRosterData(data);
      membersSnapshotRef.current = [...data.members];

      if (data.validation) {
        setEditingPlayerCount(data.validation.expectedPlayerCount);
      }

      const newSlots: SlotsArray = [
        { type: 'empty' },
        { type: 'empty' },
        { type: 'empty' },
        { type: 'empty' }
      ];

      const primary = data.members.find(m => m.isPrimary);
      if (primary) {
        if (primary.userEmail) {
          newSlots[0] = {
            type: 'member',
            member: {
              id: String(primary.id),
              email: primary.userEmail,
              name: primary.memberName,
              tier: primary.tier
            }
          };
        } else if (primary.guestInfo) {
          newSlots[0] = {
            type: 'guest_placeholder',
            guestName: primary.guestInfo.guestName,
            member: {
              id: String(primary.guestInfo.guestId),
              email: primary.guestInfo.guestEmail || '',
              name: primary.guestInfo.guestName,
              tier: null
            }
          };
        }
      }

      const others = data.members
        .filter(m => !m.isPrimary)
        .sort((a, b) => a.slotNumber - b.slotNumber);

      let slotIdx = 1;
      for (const member of others) {
        if (slotIdx > 3) break;
        if (member.guestInfo) {
          newSlots[slotIdx] = {
            type: 'guest_placeholder',
            guestName: member.guestInfo.guestName,
            member: {
              id: String(member.guestInfo.guestId),
              email: member.guestInfo.guestEmail || '',
              name: member.guestInfo.guestName,
              tier: null
            }
          };
        } else if (member.userEmail) {
          newSlots[slotIdx] = {
            type: 'member',
            member: {
              id: String(member.id),
              email: member.userEmail,
              name: member.memberName,
              tier: member.tier
            }
          };
        }
        slotIdx++;
      }

      setSlots(newSlots);
    } catch (err: any) {
      setRosterError(err.message || 'Failed to load roster data');
    } finally {
      setIsLoadingRoster(false);
    }
  }, [bookingId]);

  useEffect(() => {
    if (!isOpen) {
      setSlots([
        { type: 'empty' },
        { type: 'empty' },
        { type: 'empty' },
        { type: 'empty' }
      ]);
      setActiveSlotIndex(null);
      setLinking(false);
      setMarkingAsEvent(false);
      setShowAddVisitor(false);
      setVisitorData({ firstName: '', lastName: '', email: '', visitorType: '' });
      setVisitorSearch('');
      setVisitorSearchResults([]);
      setRememberEmail(true);
      setPotentialDuplicates([]);
      setShowStaffList(false);
      setStaffList([]);
      setShowNoticeSelection(false);
      setOverlappingNotices([]);
      setFeeEstimate(null);
      setIsCalculatingFees(false);
      setRosterData(null);
      setRosterError(null);
      setManageModeGuestForm(null);
      setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
      setMemberMatchWarning(null);
      setManageModeSearchSlot(null);
      setSavingChanges(false);
      setShowInlinePayment(false);
      setInlinePaymentAction(null);
      setPaymentSuccess(false);
      setSavedCardInfo(null);
      setShowWaiverInput(false);
      setWaiverReason('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && isManageMode) {
      fetchRosterData();
    }
  }, [isOpen, isManageMode, fetchRosterData]);

  useEffect(() => {
    if (isOpen && isManageMode && ownerEmail) {
      checkSavedCard(ownerEmail);
    }
  }, [isOpen, isManageMode, ownerEmail, checkSavedCard]);

  useEffect(() => {
    const fetchStaffList = async () => {
      if (!showStaffList || staffList.length > 0) return;
      setIsLoadingStaff(true);
      try {
        const res = await fetch('/api/staff/list', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setStaffList(data);
        }
      } catch (err) {
        console.error('Failed to fetch staff list:', err);
      } finally {
        setIsLoadingStaff(false);
      }
    };
    fetchStaffList();
  }, [showStaffList]);

  useEffect(() => {
    if (isManageMode) return;
    const checkDuplicates = async () => {
      const fullName = `${visitorData.firstName} ${visitorData.lastName}`.trim();
      if (fullName.length < 3) {
        setPotentialDuplicates([]);
        return;
      }
      
      setIsCheckingDuplicates(true);
      try {
        const res = await fetch(`/api/visitors/search?query=${encodeURIComponent(fullName)}&limit=5&includeStaff=true&includeMembers=true`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const matches = data.filter((v: any) => {
            const vName = (v.name || `${v.firstName} ${v.lastName}`).toLowerCase().trim();
            return vName === fullName.toLowerCase();
          });
          setPotentialDuplicates(matches.map((v: any) => ({
            id: v.id,
            email: v.email,
            name: v.name || `${v.firstName} ${v.lastName}`
          })));
        }
      } catch (err) {
        console.error('Duplicate check error:', err);
      } finally {
        setIsCheckingDuplicates(false);
      }
    };
    
    const timeoutId = setTimeout(checkDuplicates, 500);
    return () => clearTimeout(timeoutId);
  }, [visitorData.firstName, visitorData.lastName, isManageMode]);

  useEffect(() => {
    if (isManageMode) return;
    const searchVisitors = async () => {
      if (!visitorSearch || visitorSearch.length < 2) {
        setVisitorSearchResults([]);
        return;
      }
      setIsSearchingVisitors(true);
      try {
        const res = await fetch(`/api/visitors/search?query=${encodeURIComponent(visitorSearch)}&limit=10&includeMembers=true`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setVisitorSearchResults(data);
        }
      } catch (err) {
        console.error('Visitor search error:', err);
      } finally {
        setIsSearchingVisitors(false);
      }
    };
    const timeoutId = setTimeout(searchVisitors, 300);
    return () => clearTimeout(timeoutId);
  }, [visitorSearch, isManageMode]);

  useEffect(() => {
    if (isManageMode) return;
    const calculateFees = async () => {
      const ownerSlot = slots[0];
      if (ownerSlot.type !== 'member' && ownerSlot.type !== 'visitor') {
        setFeeEstimate(null);
        return;
      }
      
      let durationMinutes = 60;
      if (timeSlot) {
        const match = timeSlot.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
        if (match) {
          const parseTime = (t: string) => {
            const [time, period] = t.trim().split(/\s+/);
            let [h, m] = time.split(':').map(Number);
            if (period?.toUpperCase() === 'PM' && h !== 12) h += 12;
            if (period?.toUpperCase() === 'AM' && h === 12) h = 0;
            return h * 60 + m;
          };
          const startMins = parseTime(match[1]);
          const endMins = parseTime(match[2]);
          durationMinutes = endMins > startMins ? endMins - startMins : 1440 - startMins + endMins;
        }
      }
      
      const guestCount = slots.filter(s => s.type === 'guest_placeholder').length;
      const memberCount = slots.slice(1).filter(s => s.type === 'member' || s.type === 'visitor').length;
      const totalPlayers = 1 + guestCount + memberCount;
      
      setIsCalculatingFees(true);
      try {
        const params = new URLSearchParams({
          email: ownerSlot.member?.email || '',
          durationMinutes: String(durationMinutes),
          playerCount: String(totalPlayers),
          guestCount: String(guestCount)
        });
        if (bookingDate) {
          params.set('date', bookingDate);
        }
        const res = await fetch(`/api/fee-estimate?${params}`, {
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json();
          setFeeEstimate({
            totalCents: data.totalCents || 0,
            overageCents: data.overageCents || 0,
            guestCents: data.guestCents || 0
          });
        }
      } catch (err) {
        console.error('Fee estimation error:', err);
      } finally {
        setIsCalculatingFees(false);
      }
    };
    
    calculateFees();
  }, [slots, timeSlot, bookingDate, isManageMode]);

  const updateSlot = (index: number, slotState: SlotState) => {
    setSlots(prev => {
      const newSlots = [...prev] as SlotsArray;
      newSlots[index] = slotState;
      return newSlots;
    });
  };

  const clearSlot = (index: number) => {
    updateSlot(index, { type: 'empty' });
  };

  const handleMemberSelect = (member: SelectedMember, slotIndex: number) => {
    updateSlot(slotIndex, {
      type: 'member',
      member: {
        id: member.id,
        email: member.email,
        name: member.name,
        tier: member.tier
      }
    });
    setActiveSlotIndex(null);
  };

  const handleAddGuestPlaceholder = (slotIndex: number) => {
    updateSlot(slotIndex, {
      type: 'guest_placeholder',
      guestName: 'Guest (info pending)'
    });
    setActiveSlotIndex(null);
  };

  const handleSelectExistingVisitor = (visitor: VisitorSearchResult) => {
    if (activeSlotIndex === null) return;
    updateSlot(activeSlotIndex, {
      type: 'visitor',
      member: {
        id: visitor.id,
        email: visitor.email,
        name: visitor.name || `${visitor.firstName} ${visitor.lastName}`.trim()
      }
    });
    setShowAddVisitor(false);
    setVisitorSearch('');
    setVisitorSearchResults([]);
    setActiveSlotIndex(null);
  };

  const handleCreateVisitorAndAssign = async () => {
    if (!visitorData.email || !visitorData.firstName || !visitorData.lastName || activeSlotIndex === null) return;
    
    setIsCreatingVisitor(true);
    try {
      const createRes = await fetch('/api/visitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: visitorData.email,
          firstName: visitorData.firstName,
          lastName: visitorData.lastName,
          visitorType: visitorData.visitorType,
          createStripeCustomer: true
        })
      });
      
      if (!createRes.ok) {
        const errorData = await createRes.json();
        if (createRes.status === 409 && errorData.existingUser) {
          showToast(`User already exists: ${errorData.existingUser.name || errorData.existingUser.email}`, 'error');
        } else {
          showToast(errorData.error || 'Failed to create visitor', 'error');
        }
        setIsCreatingVisitor(false);
        return;
      }
      
      const data = await createRes.json();
      if (data.stripeCreated) {
        showToast(`Created visitor: ${data.visitor.firstName} ${data.visitor.lastName}`, 'success');
      } else {
        showToast(`Created visitor but Stripe setup failed - can add later`, 'warning');
      }
      
      updateSlot(activeSlotIndex, {
        type: 'visitor',
        member: {
          id: data.visitor.id,
          email: data.visitor.email,
          name: `${data.visitor.firstName} ${data.visitor.lastName}`
        }
      });
      
      setShowAddVisitor(false);
      setVisitorData({ firstName: '', lastName: '', email: '', visitorType: 'guest' });
      setActiveSlotIndex(null);
    } catch (err: any) {
      showToast(err.message || 'Failed to create visitor', 'error');
    } finally {
      setIsCreatingVisitor(false);
    }
  };

  const handleManageModeUpdatePlayerCount = async (newCount: number) => {
    if (!bookingId || isUpdatingPlayerCount) return;
    setIsUpdatingPlayerCount(true);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/player-count`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ playerCount: newCount })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to update player count');
      }
      setEditingPlayerCount(newCount);
      showToast(`Player count updated to ${newCount}`, 'success');
      await fetchRosterData();
    } catch (err: any) {
      showToast(err.message || 'Failed to update player count', 'error');
    } finally {
      setIsUpdatingPlayerCount(false);
    }
  };

  const handleManageModeLinkMember = async (slotId: number, memberEmail: string) => {
    if (!bookingId) return;
    setIsLinkingMember(true);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members/${slotId}/link`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to link member');
      }
      showToast('Member linked successfully', 'success');
      await fetchRosterData();
    } catch (err: any) {
      showToast(err.message || 'Failed to link member', 'error');
    } finally {
      setIsLinkingMember(false);
      setManageModeSearchSlot(null);
    }
  };

  const handleManageModeUnlinkMember = async (slotId: number) => {
    if (!bookingId) return;
    membersSnapshotRef.current = rosterData ? [...rosterData.members] : [];
    setUnlinkingSlotId(slotId);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members/${slotId}/unlink`, {
        method: 'PUT',
        credentials: 'include'
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to unlink member');
      }
      showToast('Member removed', 'success');
      await fetchRosterData();
    } catch (err: any) {
      showToast(err.message || 'Failed to unlink member', 'error');
      if (rosterData) {
        setRosterData({ ...rosterData, members: membersSnapshotRef.current });
      }
    } finally {
      setUnlinkingSlotId(null);
    }
  };

  const handleManageModeAddGuest = async (slotNumber: number, forceAddAsGuest?: boolean) => {
    if (!bookingId) return;
    setIsAddingManageGuest(true);
    try {
      const body: any = {
        guestName: `${manageModeGuestData.firstName} ${manageModeGuestData.lastName}`.trim(),
        guestEmail: manageModeGuestData.email,
        slotId: slotNumber
      };
      if (manageModeGuestData.phone) body.guestPhone = manageModeGuestData.phone;
      if (forceAddAsGuest) body.forceAddAsGuest = true;

      const res = await fetch(`/api/admin/booking/${bookingId}/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });

      if (res.status === 409) {
        const errData = await res.json();
        if (errData.memberMatch) {
          setMemberMatchWarning({
            slotNumber,
            guestData: {
              guestName: body.guestName,
              guestEmail: body.guestEmail,
              guestPhone: manageModeGuestData.phone
            },
            memberMatch: errData.memberMatch
          });
          setIsAddingManageGuest(false);
          return;
        }
        throw new Error(errData.error || 'Conflict adding guest');
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to add guest');
      }

      showToast('Guest added successfully', 'success');
      setManageModeGuestForm(null);
      setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
      setMemberMatchWarning(null);
      await fetchRosterData();
    } catch (err: any) {
      showToast(err.message || 'Failed to add guest', 'error');
    } finally {
      setIsAddingManageGuest(false);
    }
  };

  const checkSavedCard = useCallback(async (email: string) => {
    try {
      setCheckingCard(true);
      const res = await fetch(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSavedCardInfo(data);
      }
    } catch (err) {
      console.error('Failed to check saved card:', err);
    } finally {
      setCheckingCard(false);
    }
  }, []);

  const handleInlineMarkPaid = async () => {
    if (!bookingId) return;
    setInlinePaymentAction('mark-paid');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'confirm_all' })
      });
      if (res.ok) {
        showToast('Payment confirmed', 'success');
        setPaymentSuccess(true);
        setShowInlinePayment(false);
        await fetchRosterData();
      } else {
        showToast('Failed to confirm payment', 'error');
      }
    } catch (err) {
      showToast('Failed to confirm payment', 'error');
    } finally {
      setInlinePaymentAction(null);
    }
  };

  const handleInlineChargeSavedCard = async () => {
    if (!bookingId || !rosterData || !savedCardInfo?.hasSavedCard) return;
    const pendingParticipants = rosterData.financialSummary?.playerBreakdown?.filter((p: any) => p.fee > 0) || [];
    setInlinePaymentAction('charge-card');
    try {
      const res = await fetch('/api/stripe/staff/charge-saved-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: ownerEmail,
          bookingId,
          sessionId: rosterData.sessionId
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || 'Card charged successfully', 'success');
        setPaymentSuccess(true);
        setShowInlinePayment(false);
        await fetchRosterData();
      } else {
        if (data.noSavedCard || data.noStripeCustomer) {
          showToast('No saved card on file', 'warning');
          setSavedCardInfo({ hasSavedCard: false });
        } else {
          showToast(data.error || 'Failed to charge card', 'error');
        }
      }
    } catch (err) {
      showToast('Failed to charge card', 'error');
    } finally {
      setInlinePaymentAction(null);
    }
  };

  const handleInlineWaiveAll = async () => {
    if (!bookingId || !waiverReason.trim()) return;
    setInlinePaymentAction('waive');
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'waive_all', reason: waiverReason.trim() })
      });
      if (res.ok) {
        showToast('All fees waived', 'success');
        setPaymentSuccess(true);
        setShowInlinePayment(false);
        setShowWaiverInput(false);
        setWaiverReason('');
        await fetchRosterData();
      } else {
        showToast('Failed to waive fees', 'error');
      }
    } catch (err) {
      showToast('Failed to waive fees', 'error');
    } finally {
      setInlinePaymentAction(null);
    }
  };

  const handleInlineStripeSuccess = async () => {
    showToast('Payment successful!', 'success');
    setPaymentSuccess(true);
    setShowInlinePayment(false);
    await fetchRosterData();
  };

  const handleManageModeRemoveGuest = async (guestId: number) => {
    if (!bookingId) return;
    setRemovingGuestId(guestId);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/guests/${guestId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to remove guest');
      }
      showToast('Guest removed', 'success');
      await fetchRosterData();
    } catch (err: any) {
      showToast(err.message || 'Failed to remove guest', 'error');
    } finally {
      setRemovingGuestId(null);
    }
  };

  const handleManageModeMemberMatchResolve = async (action: 'member' | 'guest') => {
    if (!memberMatchWarning) return;
    if (action === 'member') {
      const member = rosterData?.members.find(m => m.slotNumber === memberMatchWarning.slotNumber);
      if (member) {
        await handleManageModeLinkMember(member.id, memberMatchWarning.memberMatch.email);
      }
      setMemberMatchWarning(null);
      setManageModeGuestForm(null);
      setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
    } else {
      setMemberMatchWarning(null);
      await handleManageModeAddGuest(memberMatchWarning.slotNumber, true);
    }
  };

  const handleManageModeSave = async () => {
    setSavingChanges(true);
    try {
      if (checkinMode && bookingId) {
        const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to check in');
        }
        showToast('Check-in complete', 'success');
        onCheckinComplete?.();
        onClose();
      } else {
        showToast('Changes saved', 'success');
        onRosterUpdated?.();
        onClose();
      }
    } catch (err: any) {
      showToast(err.message || 'Failed to save changes', 'error');
    } finally {
      setSavingChanges(false);
    }
  };

  const ownerSlot = slots[0];
  const hasOwner = ownerSlot.type !== 'empty';
  const filledSlotsCount = slots.filter(s => s.type !== 'empty').length;
  const guestCount = slots.filter(s => s.type === 'guest_placeholder').length;

  const handleFinalizeBooking = async () => {
    if (!hasOwner || linking) return;
    
    setLinking(true);
    try {
      const owner = ownerSlot.member!;
      const additionalPlayers = slots.slice(1).filter(s => s.type !== 'empty').map(s => {
        if (s.type === 'member' || s.type === 'visitor') {
          return {
            type: 'member' as const,
            member_id: s.member!.id,
            email: s.member!.email,
            name: s.member!.name
          };
        } else {
          return {
            type: 'guest_placeholder' as const,
            guest_name: s.guestName || 'Guest (info pending)'
          };
        }
      });

      let feesRecalculated = false;
      let resultBookingId = matchedBookingId;

      if (isLegacyReview && matchedBookingId) {
        let numericId: number;
        if (typeof matchedBookingId === 'string') {
          numericId = parseInt(matchedBookingId.replace('review-', ''), 10);
        } else {
          numericId = matchedBookingId;
        }
        
        if (isNaN(numericId)) {
          throw new Error('Invalid booking ID for legacy resolution');
        }
        
        const res = await fetch(`/api/admin/trackman/unmatched/${numericId}/resolve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            memberEmail: owner.email,
            rememberEmail: true
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to resolve booking');
        }
        const data = await res.json();
        feesRecalculated = data.feesRecalculated === true;
        if (data.booking?.id) {
          resultBookingId = typeof data.booking.id === 'number' ? data.booking.id : parseInt(data.booking.id, 10);
        }
      } else if (matchedBookingId && !isLegacyReview) {
        const res = await fetch(`/api/bookings/${matchedBookingId}/assign-with-players`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            owner: {
              email: owner.email,
              name: owner.name,
              member_id: owner.id
            },
            additional_players: additionalPlayers,
            rememberEmail: shouldShowRememberEmail() ? rememberEmail : false,
            originalEmail: originalEmail
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to assign member to booking');
        }
        const data = await res.json();
        feesRecalculated = data.feesRecalculated === true;
      } else if (trackmanBookingId) {
        const res = await fetch('/api/bookings/link-trackman-to-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            trackman_booking_id: trackmanBookingId,
            owner: {
              email: owner.email,
              name: owner.name,
              member_id: owner.id
            },
            additional_players: additionalPlayers,
            rememberEmail: shouldShowRememberEmail() ? rememberEmail : false,
            originalEmail: originalEmail
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to link booking to member');
        }
        const data = await res.json();
        feesRecalculated = data.feesRecalculated === true;
        if (data.bookingId) {
          resultBookingId = data.bookingId;
        }
      }
      
      if (isLegacyReview) {
        showToast(`Booking resolved and assigned to ${owner.name}`, 'success');
      } else {
        showToast(`Booking assigned with ${filledSlotsCount} player${filledSlotsCount > 1 ? 's' : ''}${guestCount > 0 ? ` (${guestCount} guest${guestCount > 1 ? 's' : ''})` : ''}`, 'success');
      }
      onSuccess?.({ memberEmail: owner.email, memberName: owner.name });
      onClose();
      
      if (feesRecalculated && resultBookingId && onOpenBillingModal) {
        const numericBookingId = typeof resultBookingId === 'number' 
          ? resultBookingId 
          : parseInt(String(resultBookingId).replace('review-', ''), 10);
        if (!isNaN(numericBookingId)) {
          setTimeout(() => {
            onOpenBillingModal(numericBookingId);
          }, 300);
        }
      }
    } catch (err: any) {
      showToast(err.message || 'Failed to assign booking', 'error');
    } finally {
      setLinking(false);
    }
  };

  const parseTimeSlot = (slot: string | undefined): { startTime: string; endTime: string } => {
    if (!slot) return { startTime: '00:00:00', endTime: '23:59:59' };
    const match = slot.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (match) {
      const formatTime = (t: string) => {
        const [h, m] = t.split(':');
        return `${h.padStart(2, '0')}:${m}:00`;
      };
      return { startTime: formatTime(match[1]), endTime: formatTime(match[2]) };
    }
    return { startTime: '00:00:00', endTime: '23:59:59' };
  };

  const fetchOverlappingNotices = async (): Promise<boolean> => {
    if (!bookingDate) return false;
    
    setIsLoadingNotices(true);
    try {
      const { startTime, endTime } = parseTimeSlot(timeSlot);
      const params = new URLSearchParams({
        startDate: bookingDate,
        endDate: bookingDate,
        startTime,
        endTime
      });
      
      const res = await fetch(`/api/resources/overlapping-notices?${params}`, { credentials: 'include' });
      if (res.ok) {
        const notices = await res.json();
        if (notices.length > 0) {
          setOverlappingNotices(notices);
          setShowNoticeSelection(true);
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error('Failed to fetch overlapping notices:', err);
      return false;
    } finally {
      setIsLoadingNotices(false);
    }
  };

  const handleMarkAsEvent = async () => {
    if (markingAsEvent || isLoadingNotices) return;
    
    const hasOverlapping = await fetchOverlappingNotices();
    if (hasOverlapping) {
      return;
    }
    
    await executeMarkAsEvent();
  };

  const executeMarkAsEvent = async (existingClosureId?: number) => {
    if (markingAsEvent) return;
    
    setMarkingAsEvent(true);
    try {
      const bkId = matchedBookingId;
      if (!bkId && !trackmanBookingId) {
        throw new Error('No booking to mark as event');
      }

      const res = await fetch('/api/bookings/mark-as-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          booking_id: bkId,
          trackman_booking_id: trackmanBookingId,
          existingClosureId
        })
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.message || 'Failed to mark as event');
      }
      
      const linkedMsg = existingClosureId ? ' (linked to existing notice)' : '';
      showToast(`Booking marked as private event${linkedMsg}`, 'success');
      onSuccess?.({ markedAsEvent: true });
      onClose();
    } catch (err: any) {
      showToast(err.message || 'Failed to mark as event', 'error');
    } finally {
      setMarkingAsEvent(false);
      setShowNoticeSelection(false);
    }
  };

  const handleAssignToStaff = async (staff: {id: string; email: string; first_name: string; last_name: string; role: string; user_id: string | null}) => {
    if (assigningToStaff) return;
    
    setAssigningToStaff(true);
    try {
      const staffName = `${staff.first_name} ${staff.last_name}`;
      
      if (isLegacyReview && matchedBookingId) {
        let numericId: number;
        if (typeof matchedBookingId === 'string') {
          numericId = parseInt(matchedBookingId.replace('review-', ''), 10);
        } else {
          numericId = matchedBookingId;
        }
        
        if (isNaN(numericId)) {
          throw new Error('Invalid booking ID for legacy resolution');
        }
        
        const res = await fetch(`/api/admin/trackman/unmatched/${numericId}/resolve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            memberEmail: staff.email,
            rememberEmail: false
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to assign to staff');
        }
      } else if (matchedBookingId) {
        const res = await fetch(`/api/bookings/${matchedBookingId}/assign-with-players`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            owner: {
              email: staff.email,
              name: staffName,
              member_id: staff.user_id || staff.id
            },
            additional_players: [],
            rememberEmail: false
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to assign to staff');
        }
      } else if (trackmanBookingId) {
        const res = await fetch('/api/bookings/link-trackman-to-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            trackman_booking_id: trackmanBookingId,
            owner: {
              email: staff.email,
              name: staffName,
              member_id: staff.user_id || staff.id
            },
            additional_players: [],
            rememberEmail: false
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to assign to staff');
        }
      }
      
      showToast(`Booking assigned to ${staffName}`, 'success');
      onSuccess?.({ memberEmail: staff.email, memberName: staffName });
      onClose();
    } catch (err: any) {
      showToast(err.message || 'Failed to assign to staff', 'error');
    } finally {
      setAssigningToStaff(false);
    }
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'golf_instructor':
        return (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 rounded">
            Instructor
          </span>
        );
      case 'admin':
        return (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded">
            Admin
          </span>
        );
      default:
        return (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded">
            Staff
          </span>
        );
    }
  };

  const renderSlot = (slotIndex: number, isOwnerSlot: boolean) => {
    const slot = slots[slotIndex];
    const isActive = activeSlotIndex === slotIndex;
    
    if (slot.type !== 'empty') {
      return (
        <div className={`p-3 rounded-xl border ${isOwnerSlot ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                slot.type === 'guest_placeholder' ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-green-100 dark:bg-green-900/40'
              }`}>
                <span className={`material-symbols-outlined text-sm ${
                  slot.type === 'guest_placeholder' ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'
                }`}>
                  {slot.type === 'guest_placeholder' ? 'person_add' : 'person'}
                </span>
              </div>
              <div>
                <p className="font-medium text-sm text-primary dark:text-white">
                  {slot.type === 'guest_placeholder' ? slot.guestName : slot.member?.name}
                </p>
                {slot.member?.email && (
                  <p className="text-xs text-primary/60 dark:text-white/60">{slot.member.email}</p>
                )}
                {slot.member?.tier === 'Staff' ? (
                  <p className="text-xs text-blue-600 dark:text-blue-400">$0.00 — Staff — included</p>
                ) : slot.type === 'guest_placeholder' ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{`Guest fee: $${guestFeeDollars}`}</p>
                ) : null}
              </div>
            </div>
            <button
              onClick={() => clearSlot(slotIndex)}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 transition-colors"
              title="Remove"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        </div>
      );
    }

    if (isActive) {
      if (showAddVisitor) {
        return (
          <div className="p-3 rounded-xl border border-green-200 dark:border-green-700 bg-green-50/50 dark:bg-green-900/10 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm text-primary dark:text-white">Create New Visitor</h4>
              <button
                onClick={() => {
                  setShowAddVisitor(false);
                  setVisitorData({ firstName: '', lastName: '', email: '', visitorType: 'guest' });
                  setVisitorSearch('');
                  setVisitorSearchResults([]);
                }}
                className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            <div>
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="First Name *"
                    value={visitorData.firstName}
                    onChange={(e) => setVisitorData({ ...visitorData, firstName: e.target.value })}
                    className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Last Name *"
                    value={visitorData.lastName}
                    onChange={(e) => setVisitorData({ ...visitorData, lastName: e.target.value })}
                    className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
                  />
                </div>
                <input
                  type="email"
                  placeholder="Email Address *"
                  value={visitorData.email}
                  onChange={(e) => setVisitorData({ ...visitorData, email: e.target.value })}
                  className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
                />
                <div>
                  <label className="block text-xs text-primary/70 dark:text-white/70 mb-1">Visitor Type *</label>
                  <select
                    value={visitorData.visitorType}
                    onChange={(e) => setVisitorData({ ...visitorData, visitorType: e.target.value })}
                    className={`w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border text-primary dark:text-white text-xs ${
                      visitorData.visitorType ? 'border-primary/20 dark:border-white/20' : 'border-red-300 dark:border-red-500/50'
                    }`}
                    required
                  >
                    <option value="">Select visitor type...</option>
                    <option value="guest">Guest</option>
                    <option value="day_pass">Day Pass</option>
                    <option value="sim_walkin">Simulator Walk-in</option>
                    <option value="golfnow">GolfNow</option>
                    <option value="classpass">ClassPass</option>
                    <option value="private_lesson">Private Lesson</option>
                    <option value="lead">Lead</option>
                  </select>
                  {!visitorData.visitorType && visitorData.email && (
                    <p className="text-xs text-red-500 mt-0.5">Please select a visitor type</p>
                  )}
                </div>
              </div>
            </div>

            {potentialDuplicates.length > 0 && (
              <div className="p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-1">
                  <span className="material-symbols-outlined text-sm">warning</span>
                  Possible duplicate found
                </p>
                <div className="space-y-1">
                  {potentialDuplicates.map((dup) => (
                    <button
                      key={dup.id}
                      onClick={() => {
                        if (activeSlotIndex !== null) {
                          updateSlot(activeSlotIndex, {
                            type: 'visitor',
                            member: { id: dup.id, email: dup.email, name: dup.name }
                          });
                          setShowAddVisitor(false);
                          setVisitorData({ firstName: '', lastName: '', email: '', visitorType: '' });
                          setActiveSlotIndex(null);
                          setPotentialDuplicates([]);
                        }
                      }}
                      className="w-full p-1.5 text-left rounded-lg bg-white dark:bg-white/5 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors border border-amber-200 dark:border-amber-500/20"
                    >
                      <p className="text-xs font-medium text-primary dark:text-white">{dup.name}</p>
                      <p className="text-xs text-primary/60 dark:text-white/60">{dup.email}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Click to use existing record instead</p>
              </div>
            )}

            <button
              onClick={handleCreateVisitorAndAssign}
              disabled={!visitorData.email || !visitorData.firstName || !visitorData.lastName || !visitorData.visitorType || isCreatingVisitor}
              className="w-full py-2 px-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
            >
              {isCreatingVisitor ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Creating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">add_circle</span>
                  Create & Add
                </>
              )}
            </button>
          </div>
        );
      }

      return (
        <div className="p-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-primary/60 dark:text-white/60">
              {isOwnerSlot ? 'Select Owner (Required)' : `Player ${slotIndex + 1}`}
            </span>
            <button
              onClick={() => setActiveSlotIndex(null)}
              className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          
          <MemberSearchInput
            placeholder="Search..."
            onSelect={(member) => handleMemberSelect(member, slotIndex)}
            showTier={true}
            autoFocus={true}
            includeVisitors={true}
          />
          
          <div className="flex gap-2 pt-1">
            {!isOwnerSlot && (
              <button
                onClick={() => handleAddGuestPlaceholder(slotIndex)}
                className="flex-1 py-1.5 px-2 rounded-lg border border-amber-500 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors flex items-center justify-center gap-1"
              >
                <span className="material-symbols-outlined text-sm">person_add</span>
                Add Guest
              </button>
            )}
            <button
              onClick={() => setShowAddVisitor(true)}
              className="flex-1 py-1.5 px-2 rounded-lg border border-green-500 text-green-600 dark:text-green-400 text-xs font-medium hover:bg-green-50 dark:hover:bg-green-500/10 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">person_add</span>
              New Visitor
            </button>
          </div>
        </div>
      );
    }

    return (
      <button
        onClick={() => setActiveSlotIndex(slotIndex)}
        className={`w-full p-3 rounded-xl border-2 border-dashed transition-colors text-left ${
          isOwnerSlot 
            ? 'border-amber-300 dark:border-amber-600 hover:border-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-900/10'
            : 'border-primary/20 dark:border-white/20 hover:border-primary/40 dark:hover:border-white/40 hover:bg-primary/5 dark:hover:bg-white/5'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            isOwnerSlot ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-primary/10 dark:bg-white/10'
          }`}>
            <span className={`material-symbols-outlined text-sm ${
              isOwnerSlot ? 'text-amber-600 dark:text-amber-400' : 'text-primary/40 dark:text-white/40'
            }`}>add</span>
          </div>
          <div>
            <p className={`font-medium text-sm ${isOwnerSlot ? 'text-amber-700 dark:text-amber-400' : 'text-primary/60 dark:text-white/60'}`}>
              {isOwnerSlot ? 'Add Owner (Required)' : `Add Player ${slotIndex + 1}`}
            </p>
            <p className="text-xs text-primary/40 dark:text-white/40">
              {isOwnerSlot ? 'Search member or add visitor' : 'Member or guest'}
            </p>
          </div>
        </div>
      </button>
    );
  };

  const renderManageModeSlot = (member: BookingMember, index: number) => {
    const isOwner = member.isPrimary;
    const isUnlinking = unlinkingSlotId === member.id;
    const isGuestSlot = !!member.guestInfo;
    const isRemoving = isGuestSlot && removingGuestId === member.guestInfo?.guestId;
    const showGuestPassBadge = isGuestSlot && member.guestInfo?.usedGuestPass === true && member.guestInfo?.fee === 0;
    const isStaff = member.tier === 'Staff';

    return (
      <div 
        key={member.id}
        className={`relative p-3 rounded-xl border transition-all ${
          isOwner 
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700'
            : isGuestSlot
              ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700'
              : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700'
        }`}
      >
        {(isUnlinking || isRemoving) && (
          <div className="absolute inset-0 bg-white/60 dark:bg-black/40 rounded-xl flex items-center justify-center z-10">
            <span className="material-symbols-outlined animate-spin text-red-500">progress_activity</span>
            <span className="ml-2 text-sm text-red-600 dark:text-red-400">Removing...</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
              isOwner 
                ? 'bg-green-200 dark:bg-green-800 text-green-700 dark:text-green-300'
                : 'bg-primary/10 dark:bg-white/10 text-primary/60 dark:text-white/60'
            }`}>
              {member.slotNumber}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium text-sm text-primary dark:text-white truncate">
                  {isGuestSlot ? member.guestInfo?.guestName : member.memberName}
                </p>
                {isOwner && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 rounded">
                    Owner
                  </span>
                )}
                {renderTierBadge(member.tier)}
                {isGuestSlot && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 rounded">
                    Guest
                  </span>
                )}
                {showGuestPassBadge && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 rounded flex items-center gap-0.5">
                    <span className="material-symbols-outlined text-[10px]">redeem</span>
                    Guest Pass Used
                  </span>
                )}
              </div>
              <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                {isGuestSlot ? member.guestInfo?.guestEmail : member.userEmail}
              </p>
              {isStaff ? (
                <p className="text-xs text-blue-600 dark:text-blue-400">$0.00 — Staff — included</p>
              ) : member.fee > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ${member.fee.toFixed(2)} — {member.feeNote}
                </p>
              ) : member.fee === 0 && member.feeNote ? (
                <p className="text-xs text-green-600 dark:text-green-400">{member.feeNote}</p>
              ) : null}
            </div>
          </div>
          {!isOwner && (
            <button
              onClick={() => {
                if (isGuestSlot && member.guestInfo) {
                  handleManageModeRemoveGuest(member.guestInfo.guestId);
                } else {
                  handleManageModeUnlinkMember(member.id);
                }
              }}
              disabled={isUnlinking || isRemoving}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 transition-colors flex-shrink-0"
              title="Remove"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderManageModeEmptySlot = (slotNumber: number) => {
    const isSearching = manageModeSearchSlot === slotNumber;
    const isGuestForm = manageModeGuestForm === slotNumber;
    const memberSlot = rosterData?.members.find(m => m.slotNumber === slotNumber);

    if (isGuestForm) {
      return (
        <div key={`empty-${slotNumber}`} className="p-3 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-900/10 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary/10 dark:bg-white/10 text-primary/60 dark:text-white/60">
                {slotNumber}
              </div>
              <span className="text-xs font-medium text-primary dark:text-white">New Guest</span>
            </div>
            <button
              onClick={() => {
                setManageModeGuestForm(null);
                setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
                setMemberMatchWarning(null);
              }}
              className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="First Name *"
              value={manageModeGuestData.firstName}
              onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, firstName: e.target.value })}
              className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
            />
            <input
              type="text"
              placeholder="Last Name *"
              value={manageModeGuestData.lastName}
              onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, lastName: e.target.value })}
              className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
            />
          </div>
          <input
            type="email"
            placeholder="Email Address *"
            value={manageModeGuestData.email}
            onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, email: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
          />
          <input
            type="tel"
            placeholder="Phone (optional)"
            value={manageModeGuestData.phone}
            onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, phone: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
          />

          {memberMatchWarning && memberMatchWarning.slotNumber === slotNumber && (
            <div className="p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-500/30 rounded-lg space-y-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">warning</span>
                This email matches an existing member
              </p>
              <p className="text-xs text-primary/70 dark:text-white/70">
                {memberMatchWarning.memberMatch.name} ({memberMatchWarning.memberMatch.tier}) — {memberMatchWarning.memberMatch.note}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleManageModeMemberMatchResolve('member')}
                  className="flex-1 py-1.5 px-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
                >
                  Add as Member
                </button>
                <button
                  onClick={() => handleManageModeMemberMatchResolve('guest')}
                  className="flex-1 py-1.5 px-2 rounded-lg border border-amber-500 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors"
                >
                  Add as Guest Anyway
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => handleManageModeAddGuest(slotNumber)}
            disabled={!manageModeGuestData.firstName || !manageModeGuestData.lastName || !manageModeGuestData.email || isAddingManageGuest}
            className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
          >
            {isAddingManageGuest ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Adding...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">person_add</span>
                Add Guest
              </>
            )}
          </button>
        </div>
      );
    }

    if (isSearching) {
      return (
        <div key={`empty-${slotNumber}`} className="p-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary/10 dark:bg-white/10 text-primary/60 dark:text-white/60">
                {slotNumber}
              </div>
              <span className="text-xs font-medium text-primary/60 dark:text-white/60">Search Member</span>
            </div>
            <button
              onClick={() => setManageModeSearchSlot(null)}
              className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          <MemberSearchInput
            placeholder="Search member..."
            onSelect={(selected) => {
              if (memberSlot) {
                handleManageModeLinkMember(memberSlot.id, selected.email);
              }
            }}
            showTier={true}
            autoFocus={true}
            includeVisitors={true}
            disabled={isLinkingMember}
          />
          {isLinkingMember && (
            <div className="flex items-center justify-center gap-2 text-sm text-primary/50 dark:text-white/50">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Linking...
            </div>
          )}
        </div>
      );
    }

    return (
      <div key={`empty-${slotNumber}`} className="p-3 rounded-xl border-2 border-dashed border-primary/20 dark:border-white/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary/10 dark:bg-white/10 text-primary/40 dark:text-white/40">
              {slotNumber}
            </div>
            <div>
              <p className="text-sm text-primary/50 dark:text-white/50">Empty Slot</p>
              <p className="text-xs text-amber-600 dark:text-amber-400">${guestFeeDollars} fee applies</p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                setManageModeSearchSlot(slotNumber);
                setManageModeGuestForm(null);
              }}
              className="py-1 px-2 rounded-lg border border-blue-500 text-blue-600 dark:text-blue-400 text-xs font-medium hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-xs">search</span>
              Search
            </button>
            <button
              onClick={() => {
                setManageModeGuestForm(slotNumber);
                setManageModeSearchSlot(null);
                setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
              }}
              className="py-1 px-2 rounded-lg border border-amber-500 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-xs">person_add</span>
              New Guest
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderManageModeFinancialSummary = () => {
    if (isConferenceRoom) return null;
    const fs = rosterData?.financialSummary;
    if (!fs) return null;

    const guestPassesUsed = rosterData?.members.filter(
      m => m.guestInfo && m.guestInfo.usedGuestPass === true && m.guestInfo.fee === 0
    ).length || 0;

    return (
      <div className="p-3 rounded-xl border border-primary/10 dark:border-white/10 bg-primary/5 dark:bg-white/5 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-lg">payments</span>
          <h4 className="font-medium text-sm text-primary dark:text-white">Financial Summary</h4>
          {fs.allPaid && (
            <span className="ml-auto flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
              <span className="material-symbols-outlined text-sm">check_circle</span>
              Paid
            </span>
          )}
        </div>

        <div className="space-y-1 text-xs">
          {fs.ownerOverageFee > 0 && (
            <div className="flex justify-between text-primary/70 dark:text-white/70">
              <span>Owner overage fee</span>
              <span>${fs.ownerOverageFee.toFixed(2)}</span>
            </div>
          )}
          {fs.guestFeesWithoutPass > 0 && (
            <div className="flex justify-between text-primary/70 dark:text-white/70">
              <span>Guest fees (no pass)</span>
              <span>${fs.guestFeesWithoutPass.toFixed(2)}</span>
            </div>
          )}
          {guestPassesUsed > 0 && (
            <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
              <span>Guest passes used</span>
              <span>{guestPassesUsed}</span>
            </div>
          )}
          {fs.playerBreakdown && fs.playerBreakdown.length > 0 && (
            <div className="pt-1 border-t border-primary/10 dark:border-white/10 space-y-0.5">
              {fs.playerBreakdown.map((p, idx) => (
                <div key={idx} className="flex justify-between text-primary/60 dark:text-white/60">
                  <span className="flex items-center gap-1">
                    {p.name}
                    {renderTierBadge(p.tier)}
                  </span>
                  <span className={p.tier === 'Staff' ? 'text-blue-600 dark:text-blue-400' : ''}>
                    {p.tier === 'Staff' ? '$0.00 — Staff — included' : p.fee > 0 ? `$${p.fee.toFixed(2)}` : p.feeNote || 'Included'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="pt-1 border-t border-primary/10 dark:border-white/10 flex justify-between font-semibold text-sm text-primary dark:text-white">
            <span>Owner Pays</span>
            <span>${fs.totalOwnerOwes.toFixed(2)}</span>
          </div>
          {fs.grandTotal > 0 && fs.grandTotal !== fs.totalOwnerOwes && (
            <div className="flex justify-between text-primary/70 dark:text-white/70">
              <span>Grand Total</span>
              <span>${fs.grandTotal.toFixed(2)}</span>
            </div>
          )}
        </div>

        {paymentSuccess && fs.allPaid && (
          <div className="mt-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-500/30 rounded-lg flex items-center gap-2">
            <span className="material-symbols-outlined text-green-600 dark:text-green-400 text-base">check_circle</span>
            <span className="text-sm font-medium text-green-700 dark:text-green-300">Payment collected — ready for check-in</span>
          </div>
        )}

        {!fs.allPaid && fs.grandTotal > 0 && bookingId && !showInlinePayment && (
          <button
            onClick={() => setShowInlinePayment(true)}
            className="w-full mt-2 py-2 px-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">payments</span>
            Collect ${fs.grandTotal.toFixed(2)}
          </button>
        )}

        {showInlinePayment && !fs.allPaid && fs.grandTotal > 0 && bookingId && (
          <div className="mt-2 space-y-2 p-3 bg-primary/5 dark:bg-white/5 rounded-lg border border-primary/10 dark:border-white/10">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-primary dark:text-white flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">payments</span>
                Collect ${fs.grandTotal.toFixed(2)}
              </span>
              <button onClick={() => { setShowInlinePayment(false); setInlinePaymentAction(null); setShowWaiverInput(false); setWaiverReason(''); }} className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            {inlinePaymentAction === 'stripe' ? (
              <StripePaymentForm
                amount={fs.grandTotal}
                description={`${bayName || 'Booking'} • ${bookingDate || ''}`}
                userId={rosterData?.ownerId || ''}
                userEmail={ownerEmail || ''}
                memberName={ownerName || ''}
                purpose="overage_fee"
                bookingId={bookingId}
                sessionId={rosterData?.sessionId}
                participantFees={rosterData?.financialSummary?.playerBreakdown?.filter((p: any) => p.fee > 0).map((p: any, i: number) => ({ id: i, amount: p.fee })) || []}
                onSuccess={handleInlineStripeSuccess}
                onCancel={() => setInlinePaymentAction(null)}
              />
            ) : (
              <div className="space-y-2">
                {savedCardInfo?.hasSavedCard && (
                  <button
                    onClick={handleInlineChargeSavedCard}
                    disabled={!!inlinePaymentAction}
                    className="w-full py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {inlinePaymentAction === 'charge-card' ? (
                      <><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> Charging...</>
                    ) : (
                      <><span className="material-symbols-outlined text-sm">credit_card</span> Charge Card on File ({savedCardInfo.cardBrand} •••• {savedCardInfo.cardLast4})</>
                    )}
                  </button>
                )}

                <button
                  onClick={() => setInlinePaymentAction('stripe')}
                  disabled={!!inlinePaymentAction}
                  className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-sm">credit_card</span>
                  Pay with Card (${fs.grandTotal.toFixed(2)})
                </button>

                <button
                  onClick={handleInlineMarkPaid}
                  disabled={!!inlinePaymentAction}
                  className="w-full py-2 px-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {inlinePaymentAction === 'mark-paid' ? (
                    <><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span> Confirming...</>
                  ) : (
                    <><span className="material-symbols-outlined text-sm">payments</span> Mark Paid (Cash/External)</>
                  )}
                </button>

                {!showWaiverInput ? (
                  <button
                    onClick={() => setShowWaiverInput(true)}
                    disabled={!!inlinePaymentAction}
                    className="w-full py-2 px-3 rounded-lg border border-gray-300 dark:border-white/20 text-primary/70 dark:text-white/70 hover:bg-gray-50 dark:hover:bg-white/5 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-sm">money_off</span>
                    Waive All Fees
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={waiverReason}
                      onChange={(e) => setWaiverReason(e.target.value)}
                      placeholder="Reason for waiving fees..."
                      className="w-full py-2 px-3 rounded-lg border border-gray-300 dark:border-white/20 bg-white dark:bg-white/5 text-sm text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setShowWaiverInput(false); setWaiverReason(''); }}
                        className="flex-1 py-1.5 px-3 rounded-lg border border-gray-300 dark:border-white/20 text-primary/70 dark:text-white/70 text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleInlineWaiveAll}
                        disabled={!waiverReason.trim() || !!inlinePaymentAction}
                        className="flex-1 py-1.5 px-3 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium disabled:opacity-50"
                      >
                        {inlinePaymentAction === 'waive' ? 'Waiving...' : 'Confirm Waive'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderManageModeGuestPassInfo = () => {
    if (!rosterData) return null;
    const total = rosterData.tierLimits?.guest_passes_per_month;
    if (!total) return null;
    const remaining = rosterData.ownerGuestPassesRemaining;

    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="material-symbols-outlined text-emerald-500 text-sm">redeem</span>
        <span className="text-primary/70 dark:text-white/70">
          Guest Passes: <span className="font-semibold text-primary dark:text-white">{remaining}/{total}</span> remaining
        </span>
      </div>
    );
  };

  if (isManageMode) {
    const validation = rosterData?.validation;
    const filledCount = validation ? validation.actualPlayerCount : 0;
    const totalCount = validation ? validation.expectedPlayerCount : (declaredPlayerCount || 1);
    const filledMembers = (rosterData?.members.filter(m => (m.userEmail || m.guestInfo) && m.slotNumber <= editingPlayerCount) || []);
    const emptySlotNumbers: number[] = [];
    if (rosterData?.members) {
      for (const m of rosterData.members) {
        if (!m.userEmail && !m.guestInfo && m.slotNumber <= editingPlayerCount) {
          emptySlotNumbers.push(m.slotNumber);
        }
      }
    }

    const manageModeTitle = ownerName || 'Booking Details';

    const manageModeFooter = (
      <div className="p-4 space-y-2">
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleManageModeSave}
            disabled={savingChanges}
            className="flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white"
          >
            {savingChanges ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                {checkinMode ? 'Checking In...' : 'Saving...'}
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">{checkinMode ? 'how_to_reg' : 'save'}</span>
                {checkinMode ? 'Complete Check-In' : 'Save Changes'}
              </>
            )}
          </button>
        </div>
      </div>
    );

    return (
      <SlideUpDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={manageModeTitle}
        maxHeight="full"
        stickyFooter={manageModeFooter}
      >
        <div className="p-4 space-y-4">
          {isLoadingRoster ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
            </div>
          ) : rosterError ? (
            <div className="text-center py-8">
              <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
              <p className="text-red-600 dark:text-red-400">{rosterError}</p>
              <button onClick={fetchRosterData} className="mt-4 px-4 py-2 bg-primary text-white rounded-lg text-sm">
                Retry
              </button>
            </div>
          ) : (
            <>
              {ownerMembershipStatus && ownerMembershipStatus.toLowerCase() !== 'active' && ownerMembershipStatus.toLowerCase() !== 'unknown' && (
                <div className="p-3 rounded-xl border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-900/15 flex items-center gap-2">
                  <span className="material-symbols-outlined text-red-500 dark:text-red-400 text-lg">warning</span>
                  <div>
                    <p className="text-sm font-medium text-red-700 dark:text-red-300">Inactive Member</p>
                    <p className="text-xs text-red-600 dark:text-red-400">This booking owner's membership status is "{ownerMembershipStatus}" — they may not be eligible to book.</p>
                  </div>
                </div>
              )}
              <div className="p-3 bg-gradient-to-r from-primary/5 to-primary/10 dark:from-white/5 dark:to-white/10 rounded-xl border border-primary/10 dark:border-white/10">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {(bookingContext?.resourceName || bayName) && (
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">sports_golf</span>
                      <span className="font-medium text-primary dark:text-white">{bookingContext?.resourceName || bayName}</span>
                    </div>
                  )}
                  {(bookingContext?.requestDate || bookingDate) && (
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">calendar_today</span>
                      <span className="text-primary/80 dark:text-white/80">{bookingContext?.requestDate || bookingDate}</span>
                    </div>
                  )}
                  {(bookingContext?.startTime && bookingContext?.endTime) ? (
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">schedule</span>
                      <span className="text-primary/80 dark:text-white/80">{bookingContext.startTime} - {bookingContext.endTime}</span>
                    </div>
                  ) : timeSlot ? (
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">schedule</span>
                      <span className="text-primary/80 dark:text-white/80">{timeSlot}</span>
                    </div>
                  ) : null}
                  {bookingContext?.durationMinutes && (
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">timer</span>
                      <span className="text-primary/80 dark:text-white/80">{bookingContext.durationMinutes} min</span>
                    </div>
                  )}
                  {trackmanBookingId && (
                    <div className="flex items-center gap-2">
                      <TrackmanIcon className="w-4 h-4 text-primary/60 dark:text-white/60" />
                      <span className="text-primary/80 dark:text-white/80 text-xs">{trackmanBookingId}</span>
                    </div>
                  )}
                  {bookingStatus && (
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">info</span>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                        bookingStatus === 'attended' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                        bookingStatus === 'cancelled' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' :
                        bookingStatus === 'confirmed' || bookingStatus === 'approved' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                        'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300'
                      }`}>
                        {bookingStatus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {(() => {
                const bookingNotesText = (rosterData?.bookingNotes?.notes || notes || '').trim();
                const trackmanNotesText = (rosterData?.bookingNotes?.trackmanNotes || bookingContext?.trackmanCustomerNotes || '').trim();
                const showTrackman = trackmanNotesText && bookingNotesText !== trackmanNotesText && !bookingNotesText.includes(trackmanNotesText) && !trackmanNotesText.includes(bookingNotesText);
                return (
                  <>
                    {bookingNotesText && (
                      <div className="p-3 rounded-xl border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-900/10">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-base">description</span>
                          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Booking Notes</span>
                        </div>
                        <p className="text-sm text-amber-800 dark:text-amber-200 whitespace-pre-wrap">{bookingNotesText}</p>
                      </div>
                    )}
                    {showTrackman && (
                      <div className="p-3 rounded-xl border border-blue-200 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-900/10">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400 text-base">sell</span>
                          <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Trackman Notes</span>
                        </div>
                        <p className="text-sm text-blue-800 dark:text-blue-200 whitespace-pre-wrap">{trackmanNotesText}</p>
                      </div>
                    )}
                  </>
                );
              })()}

              {rosterData?.bookingNotes?.staffNotes && (
                <div className="p-3 rounded-xl border border-purple-200 dark:border-purple-500/20 bg-purple-50 dark:bg-purple-900/10">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-purple-600 dark:text-purple-400 text-base">sticky_note_2</span>
                    <span className="text-xs font-medium text-purple-700 dark:text-purple-300">Staff Notes</span>
                  </div>
                  <p className="text-sm text-purple-800 dark:text-purple-200 whitespace-pre-wrap">{rosterData.bookingNotes.staffNotes}</p>
                </div>
              )}

              {!isConferenceRoom && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h4 className="font-medium text-primary dark:text-white">Player Slots</h4>
                    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                      filledCount === totalCount 
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                    }`}>
                      {filledCount}/{totalCount} Assigned
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-primary/60 dark:text-white/60">Players:</label>
                    <select
                      value={editingPlayerCount}
                      onChange={(e) => handleManageModeUpdatePlayerCount(Number(e.target.value))}
                      disabled={isUpdatingPlayerCount}
                      className="px-2 py-1 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white text-xs disabled:opacity-50"
                    >
                      {[1, 2, 3, 4].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    {isUpdatingPlayerCount && (
                      <span className="material-symbols-outlined animate-spin text-sm text-primary/50 dark:text-white/50">progress_activity</span>
                    )}
                  </div>
                </div>
              )}

              {!isConferenceRoom && renderManageModeGuestPassInfo()}

              {!isConferenceRoom && (
                <div className="space-y-2">
                  {filledMembers.map((member, idx) => renderManageModeSlot(member, idx))}
                  {emptySlotNumbers.map(slotNum => renderManageModeEmptySlot(slotNum))}
                </div>
              )}

              {isConferenceRoom && filledMembers.length > 0 && (
                <div className="space-y-2">
                  {filledMembers.filter(m => m.isPrimary).map((member, idx) => renderManageModeSlot(member, idx))}
                </div>
              )}

              {renderManageModeFinancialSummary()}

              {(onCheckIn || onReschedule || onCancelBooking) && bookingId && (
                <div className="flex gap-2">
                  {onCheckIn && bookingStatus !== 'attended' && bookingStatus !== 'cancelled' && (
                    <button
                      onClick={() => onCheckIn(bookingId)}
                      disabled={!!(rosterData?.financialSummary && rosterData.financialSummary.grandTotal > 0 && !rosterData.financialSummary.allPaid)}
                      className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
                        rosterData?.financialSummary && rosterData.financialSummary.grandTotal > 0 && !rosterData.financialSummary.allPaid
                          ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                          : 'bg-green-600 hover:bg-green-700 text-white'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">how_to_reg</span>
                      Check In
                    </button>
                  )}
                  {onReschedule && bookingStatus !== 'cancelled' && (
                    <button
                      onClick={() => onReschedule({
                        id: bookingId,
                        request_date: bookingContext?.requestDate || '',
                        start_time: bookingContext?.startTime || '',
                        end_time: bookingContext?.endTime || '',
                        resource_id: bookingContext?.resourceId || 0,
                        resource_name: bookingContext?.resourceName || bayName,
                        user_name: ownerName,
                        user_email: ownerEmail,
                      })}
                      className="flex-1 py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">event_repeat</span>
                      Reschedule
                    </button>
                  )}
                  {onCancelBooking && bookingStatus !== 'cancelled' && bookingStatus !== 'cancellation_pending' && (
                    <button
                      onClick={() => onCancelBooking(bookingId)}
                      className="flex-1 py-2 px-3 rounded-lg border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">cancel</span>
                      Cancel Booking
                    </button>
                  )}
                </div>
              )}

              {onCheckIn && bookingStatus !== 'attended' && bookingStatus !== 'cancelled' && 
                rosterData?.financialSummary && rosterData.financialSummary.grandTotal > 0 && !rosterData.financialSummary.allPaid && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">info</span>
                  Payment must be collected before check-in
                </p>
              )}
            </>
          )}
        </div>
      </SlideUpDrawer>
    );
  }

  const drawerTitle = `${bayName || 'Booking'}${timeSlot ? ` • ${timeSlot}` : ''}`;

  const stickyFooterContent = (
    <div className="p-4 space-y-2">
      {!isConferenceRoom && feeEstimate && feeEstimate.totalCents > 0 && (
        <div className="mb-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-lg">payments</span>
              <span className="text-sm font-medium text-amber-700 dark:text-amber-300">Estimated Fees</span>
            </div>
            <span className="text-lg font-bold text-amber-700 dark:text-amber-300">
              ${(feeEstimate.totalCents / 100).toFixed(2)}
            </span>
          </div>
          <div className="mt-1 flex gap-4 text-xs text-amber-600 dark:text-amber-400">
            {feeEstimate.overageCents > 0 && (
              <span>Overage: ${(feeEstimate.overageCents / 100).toFixed(2)}</span>
            )}
            {feeEstimate.guestCents > 0 && (
              <span>Guest fees: ${(feeEstimate.guestCents / 100).toFixed(2)}</span>
            )}
          </div>
        </div>
      )}
      {!isConferenceRoom && isCalculatingFees && (
        <div className="mb-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 flex items-center justify-center gap-2 text-sm text-primary/50 dark:text-white/50">
          <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
          Calculating fees...
        </div>
      )}
      <div className="flex gap-3">
        <button
          onClick={onClose}
          className="flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleFinalizeBooking}
          disabled={!hasOwner || linking}
          className="flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white"
        >
          {linking ? (
            <>
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Assigning...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-sm">check_circle</span>
              Assign & Confirm
            </>
          )}
        </button>
      </div>

      <button
        onClick={handleMarkAsEvent}
        disabled={markingAsEvent || isLoadingNotices}
        className="w-full py-2.5 px-4 rounded-lg border border-purple-500 text-purple-600 dark:text-purple-400 font-medium hover:bg-purple-50 dark:hover:bg-purple-500/10 transition-colors flex items-center justify-center gap-2"
      >
        {markingAsEvent || isLoadingNotices ? (
          <>
            <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
            {isLoadingNotices ? 'Checking...' : 'Marking...'}
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-sm">event</span>
            Mark as Private Event
          </>
        )}
      </button>

      {showNoticeSelection && overlappingNotices.length > 0 && (
        <div className="p-3 rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50/50 dark:bg-purple-900/10 space-y-2">
          <div className="flex items-center gap-2 text-purple-700 dark:text-purple-400">
            <span className="material-symbols-outlined text-sm">info</span>
            <span className="text-sm font-medium">Existing notices found for this time</span>
          </div>
          <p className="text-xs text-primary/60 dark:text-white/60">
            Link to an existing notice to avoid duplicates, or create a new one.
          </p>
          <div className="space-y-1.5">
            {overlappingNotices.map((notice) => (
              <button
                key={notice.id}
                onClick={() => executeMarkAsEvent(notice.id)}
                disabled={markingAsEvent}
                className="w-full p-2 text-left rounded-lg bg-white dark:bg-white/5 hover:bg-purple-100 dark:hover:bg-purple-900/20 transition-colors border border-purple-200 dark:border-purple-500/20"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-primary dark:text-white">{notice.title || notice.reason || 'Untitled Notice'}</p>
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded">
                    {notice.source}
                  </span>
                </div>
                <p className="text-xs text-primary/60 dark:text-white/60 mt-0.5">
                  {notice.start_time && notice.end_time 
                    ? `${notice.start_time.slice(0, 5)} - ${notice.end_time.slice(0, 5)}` 
                    : 'All day'
                  }
                  {notice.notice_type && ` • ${notice.notice_type}`}
                </p>
              </button>
            ))}
            <button
              onClick={() => executeMarkAsEvent()}
              disabled={markingAsEvent}
              className="w-full p-2 text-center rounded-lg border-2 border-dashed border-purple-300 dark:border-purple-600 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-500/10 transition-colors text-sm font-medium"
            >
              <span className="material-symbols-outlined text-sm mr-1">add</span>
              Create New Notice Instead
            </button>
          </div>
          <button
            onClick={() => setShowNoticeSelection(false)}
            className="w-full text-center text-xs text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white pt-1"
          >
            Cancel
          </button>
        </div>
      )}

      <button
        onClick={() => setShowStaffList(!showStaffList)}
        disabled={assigningToStaff}
        className="w-full py-2.5 px-4 rounded-lg border border-teal-500 text-teal-600 dark:text-teal-400 font-medium hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-sm">badge</span>
        Assign to Staff
        <span className={`material-symbols-outlined text-sm transition-transform ${showStaffList ? 'rotate-180' : ''}`}>expand_more</span>
      </button>

      {showStaffList && (
        <div className="border border-teal-200 dark:border-teal-500/30 rounded-lg overflow-hidden">
          {isLoadingStaff ? (
            <div className="p-4 text-center">
              <span className="material-symbols-outlined animate-spin text-teal-500">progress_activity</span>
              <p className="text-sm text-primary/60 dark:text-white/60 mt-1">Loading staff...</p>
            </div>
          ) : staffList.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-sm text-primary/60 dark:text-white/60">No active staff found</p>
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {staffList.map((staff) => (
                <button
                  key={staff.id}
                  onClick={() => handleAssignToStaff(staff)}
                  disabled={assigningToStaff}
                  className="w-full p-3 text-left hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors border-b border-teal-100 dark:border-teal-500/20 last:border-b-0 disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-primary dark:text-white">
                        {staff.first_name} {staff.last_name}
                      </p>
                      <p className="text-xs text-primary/60 dark:text-white/60">{staff.email}</p>
                    </div>
                    {getRoleBadge(staff.role)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-center text-primary/50 dark:text-white/50">
        Use for event blocks that don't require member assignment
      </p>
    </div>
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={drawerTitle}
      maxHeight="full"
      stickyFooter={stickyFooterContent}
    >
      <div className="p-4 space-y-4">
        {isRelink && currentMemberName && (
          <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1">
              Currently Linked To
            </p>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">person</span>
              <div>
                <p className="font-medium text-blue-800 dark:text-blue-200">{currentMemberName}</p>
                {currentMemberEmail && !isPlaceholderEmail(currentMemberEmail) && (
                  <p className="text-sm text-blue-600 dark:text-blue-400">{currentMemberEmail}</p>
                )}
              </div>
            </div>
          </div>
        )}
        
        {!isConferenceRoom && trackmanBookingId && (
          <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-2">
              Booking Details
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm text-amber-700 dark:text-amber-400">
              {importedName && (
                <p className="flex items-center gap-1 col-span-2 font-semibold">
                  <span className="material-symbols-outlined text-sm">person</span>
                  {importedName}
                </p>
              )}
              {bayName && (
                <p className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">sports_golf</span>
                  {bayName}
                </p>
              )}
              {bookingDate && (
                <p className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">calendar_today</span>
                  {bookingDate}
                </p>
              )}
              {timeSlot && (
                <p className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">schedule</span>
                  {timeSlot}
                </p>
              )}
              <p className="flex items-center gap-1 text-xs opacity-70">
                <span className="material-symbols-outlined text-xs">tag</span>
                ID: #{trackmanBookingId}
              </p>
            </div>
          </div>
        )}

        {isConferenceRoom && (
          <div className="p-3 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 rounded-lg">
            <p className="text-sm font-medium text-indigo-800 dark:text-indigo-300 mb-2">
              Conference Room Booking
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm text-indigo-700 dark:text-indigo-400">
              {bayName && (
                <p className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">meeting_room</span>
                  {bayName}
                </p>
              )}
              {bookingDate && (
                <p className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">calendar_today</span>
                  {bookingDate}
                </p>
              )}
              {timeSlot && (
                <p className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">schedule</span>
                  {timeSlot}
                </p>
              )}
            </div>
          </div>
        )}

        {(() => {
          const bNotes = (notes || '').trim();
          const tNotes = (bookingContext?.trackmanCustomerNotes || '').trim();
          const showTrackmanAssign = tNotes && bNotes !== tNotes && !bNotes.includes(tNotes) && !tNotes.includes(bNotes);
          return (
            <>
              {bNotes && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-500/20 rounded-lg">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-1 flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">description</span>
                    Booking Notes
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-400 whitespace-pre-wrap">{bNotes}</p>
                </div>
              )}
              {showTrackmanAssign && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-500/20 rounded-lg">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1 flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">sell</span>
                    Trackman Notes
                  </p>
                  <p className="text-sm text-blue-700 dark:text-blue-400 whitespace-pre-wrap">{tNotes}</p>
                </div>
              )}
            </>
          );
        })()}

        {!isConferenceRoom && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-primary dark:text-white">Player Slots</h4>
              {filledSlotsCount > 0 && (
                <span className="text-xs text-primary/60 dark:text-white/60">
                  {filledSlotsCount} player{filledSlotsCount !== 1 ? 's' : ''}
                  {guestCount > 0 && ` (${guestCount} guest${guestCount !== 1 ? 's' : ''} = $${guestCount * guestFeeDollars})`}
                </span>
              )}
            </div>

            <div className="space-y-2">
              <div>
                <p className="text-xs text-amber-600 dark:text-amber-400 mb-1 font-medium">Slot 1: Owner (Required)</p>
                {renderSlot(0, true)}
              </div>
              
              {!isLessonOrStaffBlock && (
                <div className="border-t border-primary/10 dark:border-white/10 pt-2">
                  <p className="text-xs text-primary/50 dark:text-white/50 mb-1">Additional Players (Optional)</p>
                  {isLegacyReview ? (
                    <p className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-500/10 p-2 rounded-lg">
                      Add additional players after assigning the owner. This booking needs review first.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {[1, 2, 3].map(index => (
                        <div key={index}>
                          {renderSlot(index, false)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {!isLessonOrStaffBlock && slots.slice(1).some(s => s.type === 'empty') && (
              <button
                onClick={() => {
                  const emptyIndex = slots.findIndex((s, i) => i > 0 && s.type === 'empty');
                  if (emptyIndex > 0) handleAddGuestPlaceholder(emptyIndex);
                }}
                className="w-full py-2 px-3 rounded-lg border-2 border-dashed border-amber-300 dark:border-amber-600 text-amber-600 dark:text-amber-400 font-medium text-sm hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">person_add</span>
                {`Quick Add Guest (+$${guestFeeDollars})`}
              </button>
            )}
          </div>
        )}

        {isConferenceRoom && (
          <div className="space-y-3">
            <h4 className="font-medium text-primary dark:text-white">Assign To</h4>
            <div>
              <p className="text-xs text-amber-600 dark:text-amber-400 mb-1 font-medium">Owner (Required)</p>
              {renderSlot(0, true)}
            </div>
          </div>
        )}

        {shouldShowRememberEmail() && (
          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-500/30">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberEmail}
                onChange={(e) => setRememberEmail(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-amber-400 text-amber-500 focus:ring-amber-500/50 focus:ring-offset-0"
              />
              <div>
                <p className="text-sm font-medium text-primary dark:text-white">Remember this email for future bookings</p>
                <p className="text-xs text-primary/70 dark:text-white/70 mt-0.5">
                  Link "{originalEmail}" to this member's account so future imports match automatically
                </p>
              </div>
            </label>
          </div>
        )}
      </div>
    </SlideUpDrawer>
  );
}

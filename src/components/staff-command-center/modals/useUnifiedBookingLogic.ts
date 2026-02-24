import { useState, useEffect, useCallback, useRef } from 'react';
import { SelectedMember } from '../../shared/MemberSearchInput';
import { useToast } from '../../Toast';
import { usePricing } from '../../../hooks/usePricing';
import TierBadge from '../../TierBadge';
import type { BookingMember, BookingGuest, ValidationInfo, FinancialSummary, BookingContextType, ManageModeRosterData, MemberMatchWarning, FetchedContext } from './bookingSheetTypes';
import { isPlaceholderEmail } from './bookingSheetTypes';
import type { UnifiedBookingSheetProps } from './UnifiedBookingSheet';
import { useBookingActions } from '../../../hooks/useBookingActions';
import React from 'react';

export interface VisitorSearchResult {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name?: string;
  userType?: 'visitor' | 'member' | 'staff' | 'instructor';
  isInstructor?: boolean;
  staffRole?: string;
}

export interface SlotState {
  type: 'empty' | 'member' | 'guest_placeholder' | 'visitor';
  member?: { id: string; email: string; name: string; tier?: string | null };
  guestName?: string;
}

export type SlotsArray = [SlotState, SlotState, SlotState, SlotState];

export function useUnifiedBookingLogic(props: UnifiedBookingSheetProps) {
  const {
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
  } = props;

  const resolvedBookingType = bookingType || 'simulator';
  const isConferenceRoom = resolvedBookingType === 'conference_room';
  const isLessonOrStaffBlock = resolvedBookingType === 'lesson' || resolvedBookingType === 'staff_block';

  const { checkInBooking, chargeCardOnFile } = useBookingActions();
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

  const [fetchedContext, setFetchedContext] = useState<{
    bayName?: string; bookingDate?: string; timeSlot?: string;
    trackmanBookingId?: string; bookingStatus?: string;
    ownerName?: string; ownerEmail?: string; ownerUserId?: string; durationMinutes?: number;
    resourceId?: number; notes?: string;
  } | null>(null);

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
  const [processingPayment, setProcessingPayment] = useState(false);
  const [savedCardInfo, setSavedCardInfo] = useState<{hasSavedCard: boolean; cardLast4?: string; cardBrand?: string} | null>(null);
  const [checkingCard, setCheckingCard] = useState(false);
  const [waiverReason, setWaiverReason] = useState('');
  const [showWaiverInput, setShowWaiverInput] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reassignSearchOpen, setReassignSearchOpen] = useState(false);
  const [isReassigningOwner, setIsReassigningOwner] = useState(false);
  const [isQuickAddingGuest, setIsQuickAddingGuest] = useState(false);
  const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollingCountRef = useRef(0);

  const isManageMode = mode === 'manage';

  const renderTierBadge = (tier: string | null | undefined, membershipStatus?: string | null) => {
    if (membershipStatus && membershipStatus !== 'active') {
      return React.createElement('span', { 
        className: 'px-1.5 py-0.5 text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 rounded uppercase' 
      }, membershipStatus.toUpperCase());
    }
    if (!tier) return null;
    if (tier === 'Staff') {
      return (
        React.createElement('span', { className: 'px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded' }, 'Staff')
      );
    }
    return React.createElement(TierBadge, { tier, size: 'sm' });
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`/api/admin/booking/${bookingId}/members`, { 
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
      });
      clearTimeout(timeoutId);
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
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setRosterError('Request timed out. Please try again.');
      } else {
        setRosterError((err instanceof Error ? err.message : String(err)) || 'Failed to load roster data');
      }
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
      setIsLoadingRoster(false);
      setManageModeGuestForm(null);
      setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
      setMemberMatchWarning(null);
      setManageModeSearchSlot(null);
      setSavingChanges(false);
      setShowInlinePayment(false);
      setInlinePaymentAction(null);
      setPaymentSuccess(false);
      setProcessingPayment(false);
      setSavedCardInfo(null);
      setShowWaiverInput(false);
      setWaiverReason('');
      setFetchedContext(null);
      setReassignSearchOpen(false);
      setIsReassigningOwner(false);
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      pollingCountRef.current = 0;
    }
  }, [isOpen]);

  const stopPaymentPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    pollingCountRef.current = 0;
  }, []);

  const onPaymentConfirmed = useCallback(async () => {
    stopPaymentPolling();
    setProcessingPayment(false);
    setPaymentSuccess(true);
    setShowInlinePayment(false);
    setInlinePaymentAction(null);
    await fetchRosterData();
  }, [stopPaymentPolling, fetchRosterData]);

  const startPaymentPolling = useCallback(() => {
    stopPaymentPolling();
    pollingCountRef.current = 0;
    pollingTimerRef.current = setInterval(async () => {
      pollingCountRef.current++;
      if (pollingCountRef.current > 5) {
        stopPaymentPolling();
        setProcessingPayment(false);
        await fetchRosterData();
        return;
      }
      try {
        if (!bookingId) return;
        const res = await fetch(`/api/admin/booking/${bookingId}/members`, {
          credentials: 'include',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!res.ok) return;
        const data: ManageModeRosterData = await res.json();
        if (data.financialSummary?.allPaid) {
          setRosterData(data);
          membersSnapshotRef.current = [...data.members];
          stopPaymentPolling();
          setProcessingPayment(false);
          setPaymentSuccess(true);
          setShowInlinePayment(false);
          setInlinePaymentAction(null);
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
  }, [bookingId, stopPaymentPolling, fetchRosterData]);

  useEffect(() => {
    if (!isOpen || !bookingId) return;

    const handleBillingUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail) return;
      if (detail.bookingId && Number(detail.bookingId) === bookingId) {
        console.log('[BookingSheet] Billing update received for this booking, refreshing');
        onPaymentConfirmed();
      }
    };

    window.addEventListener('billing-update', handleBillingUpdate);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate);
    };
  }, [isOpen, bookingId, onPaymentConfirmed]);

  useEffect(() => {
    if (!isOpen || !bookingId) return;

    const handleRosterUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || Number(detail.bookingId) !== bookingId) return;
      console.log('[BookingSheet] Roster update received via WebSocket, refreshing', detail.action);
      fetchRosterData();
    };

    const handleInvoiceUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || Number(detail.bookingId) !== bookingId) return;
      console.log('[BookingSheet] Invoice update received via WebSocket, refreshing', detail.action);
      fetchRosterData();
      if (detail.action === 'invoice_paid' || detail.action === 'payment_confirmed') {
        setPaymentSuccess(true);
        setShowInlinePayment(false);
        setInlinePaymentAction(null);
      }
    };

    window.addEventListener('booking-roster-update', handleRosterUpdate);
    window.addEventListener('booking-invoice-update', handleInvoiceUpdate);
    return () => {
      window.removeEventListener('booking-roster-update', handleRosterUpdate);
      window.removeEventListener('booking-invoice-update', handleInvoiceUpdate);
    };
  }, [isOpen, bookingId, fetchRosterData]);

  useEffect(() => {
    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen && isManageMode) {
      fetchRosterData();
    }
  }, [isOpen, isManageMode, fetchRosterData]);

  useEffect(() => {
    if (!isOpen || !bookingId) return;
    const hasPropContext = bayName || bookingDate || timeSlot || bookingContext;
    if (hasPropContext) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/booking-requests/${bookingId}`, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const formatTime = (t: string | null) => {
          if (!t) return '';
          const [h, m] = t.split(':').map(Number);
          const ampm = h >= 12 ? 'PM' : 'AM';
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
        };
        const start = formatTime(data.start_time);
        const end = formatTime(data.end_time);
        setFetchedContext({
          bayName: data.resource_name || data.bay_name || (data.resource_id ? `Bay ${data.resource_id}` : undefined),
          bookingDate: data.request_date || undefined,
          timeSlot: start && end ? `${start} - ${end}` : undefined,
          trackmanBookingId: data.trackman_booking_id || undefined,
          bookingStatus: data.status || undefined,
          ownerName: data.user_name || undefined,
          ownerEmail: data.user_email || undefined,
          ownerUserId: data.user_id?.toString() || undefined,
          durationMinutes: data.duration_minutes || undefined,
          resourceId: data.resource_id || undefined,
          notes: data.notes || undefined,
        });
        if (!ownerEmail && data.user_email) {
          checkSavedCard(data.user_email);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [isOpen, bookingId, bayName, bookingDate, timeSlot, bookingContext]);

  const checkSavedCard = useCallback(async (email: string) => {
    try {
      setCheckingCard(true);
      const res = await fetch(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSavedCardInfo(data);
      }
    } catch (err: unknown) {
      console.error('Failed to check saved card:', err);
    } finally {
      setCheckingCard(false);
    }
  }, []);

  useEffect(() => {
    const email = ownerEmail || fetchedContext?.ownerEmail;
    if (isOpen && isManageMode && email) {
      checkSavedCard(email);
    }
  }, [isOpen, isManageMode, ownerEmail, fetchedContext?.ownerEmail, checkSavedCard]);

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
      } catch (err: unknown) {
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
      } catch (err: unknown) {
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
      } catch (err: unknown) {
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
      } catch (err: unknown) {
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to create visitor', 'error');
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to update player count', 'error');
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to link member', 'error');
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to unlink member', 'error');
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
      const body: Record<string, unknown> = {
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
              guestName: body.guestName as string,
              guestEmail: body.guestEmail as string,
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to add guest', 'error');
    } finally {
      setIsAddingManageGuest(false);
    }
  };

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
    } catch (err: unknown) {
      showToast('Failed to confirm payment', 'error');
    } finally {
      setInlinePaymentAction(null);
    }
  };

  const handleInlineChargeSavedCard = async () => {
    if (!bookingId || !rosterData || !savedCardInfo?.hasSavedCard) return;
    setInlinePaymentAction('charge-card');
    try {
      const allParticipantIds = [
        ...rosterData.members.map(m => m.id),
        ...rosterData.guests.map(g => g.id),
      ];
      const result = await chargeCardOnFile({
        memberEmail: ownerEmail || fetchedContext?.ownerEmail || rosterData.members?.find(m => m.isPrimary)?.userEmail || '',
        bookingId,
        sessionId: rosterData.sessionId,
        participantIds: allParticipantIds,
      });
      if (result.success) {
        showToast(result.message || 'Card charged — confirming payment...', 'success');
        setProcessingPayment(true);
        setShowInlinePayment(false);
        setInlinePaymentAction(null);
        startPaymentPolling();
        return;
      } else if (result.noSavedCard) {
        showToast('No saved card on file', 'warning');
        setSavedCardInfo({ hasSavedCard: false });
      } else {
        showToast(result.error || 'Failed to charge card', 'error');
      }
    } catch (err: unknown) {
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
        setInlinePaymentAction(null);
        await fetchRosterData();
      } else {
        showToast('Failed to waive fees', 'error');
        setInlinePaymentAction(null);
      }
    } catch (err: unknown) {
      showToast('Failed to waive fees', 'error');
      setInlinePaymentAction(null);
    }
  };

  const handleInlineStripeSuccess = async () => {
    showToast('Payment processing...', 'success');
    setProcessingPayment(true);
    setShowInlinePayment(false);
    setInlinePaymentAction(null);
    startPaymentPolling();
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to remove guest', 'error');
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
        const result = await checkInBooking(bookingId);
        if (!result.success) {
          throw new Error(result.error || 'Failed to check in');
        }
        showToast('Check-in complete', 'success');
        onCheckinComplete?.();
        onClose();
      } else {
        showToast('Changes saved', 'success');
        onRosterUpdated?.();
        onClose();
      }
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to save changes', 'error');
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to assign booking', 'error');
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
        endTime,
        sameDayOnly: 'true'
      });
      
      const res = await fetch(`/api/resources/overlapping-notices?${params}`, { credentials: 'include' });
      if (res.ok) {
        const notices = await res.json();
        setOverlappingNotices(notices);
      }
      setShowNoticeSelection(true);
      return true;
    } catch (err: unknown) {
      console.error('Failed to fetch overlapping notices:', err);
      setShowNoticeSelection(true);
      return false;
    } finally {
      setIsLoadingNotices(false);
    }
  };

  const handleMarkAsEvent = async () => {
    if (markingAsEvent || isLoadingNotices) return;
    
    await fetchOverlappingNotices();
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to mark as event', 'error');
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
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to assign to staff', 'error');
    } finally {
      setAssigningToStaff(false);
    }
  };

  const handleDeleteBooking = async () => {
    const deleteId = matchedBookingId || bookingId;
    if (!deleteId) return;
    if (!window.confirm('Are you sure you want to delete this booking? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/bookings/${deleteId}?hard_delete=true`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || 'Failed to delete booking');
      }
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      alert((err instanceof Error ? err.message : String(err)) || 'Failed to delete booking');
    } finally {
      setDeleting(false);
    }
  };

  const handleManageModeQuickAddGuest = async (slotNumber: number) => {
    if (!bookingId) return;
    setIsQuickAddingGuest(true);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ quickAdd: true }),
      });
      if (res.ok) {
        showToast('Guest added', 'success');
        await fetchRosterData();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to add guest', 'error');
      }
    } catch (err) {
      showToast('Failed to add guest', 'error');
    } finally {
      setIsQuickAddingGuest(false);
    }
  };

  const handleReassignOwner = useCallback(async (newMemberEmail: string) => {
    if (!bookingId) {
      showToast('No booking ID found', 'error');
      return;
    }

    setIsReassigningOwner(true);
    try {
      const response = await fetch(`/api/admin/trackman/matched/${bookingId}/reassign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newMemberEmail }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to reassign owner');
      }

      showToast(data.message || `Booking reassigned to ${newMemberEmail}`, 'success');
      setReassignSearchOpen(false);

      await fetchRosterData();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to reassign owner';
      showToast(message, 'error');
    } finally {
      setIsReassigningOwner(false);
    }
  }, [bookingId, showToast, fetchRosterData]);

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'golf_instructor':
        return (
          React.createElement('span', { className: 'px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 rounded' }, 'Instructor')
        );
      case 'admin':
        return (
          React.createElement('span', { className: 'px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded' }, 'Admin')
        );
      default:
        return (
          React.createElement('span', { className: 'px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded' }, 'Staff')
        );
    }
  };

  return {
    resolvedBookingType,
    isConferenceRoom,
    isLessonOrStaffBlock,
    isManageMode,
    guestFeeDollars,
    slots,
    setSlots,
    activeSlotIndex,
    setActiveSlotIndex,
    linking,
    markingAsEvent,
    showAddVisitor,
    setShowAddVisitor,
    visitorData,
    setVisitorData,
    isCreatingVisitor,
    visitorSearch,
    setVisitorSearch,
    visitorSearchResults,
    isSearchingVisitors,
    rememberEmail,
    setRememberEmail,
    potentialDuplicates,
    isCheckingDuplicates,
    showStaffList,
    setShowStaffList,
    staffList,
    isLoadingStaff,
    assigningToStaff,
    showNoticeSelection,
    setShowNoticeSelection,
    overlappingNotices,
    isLoadingNotices,
    feeEstimate,
    isCalculatingFees,
    fetchedContext,
    rosterData,
    isLoadingRoster,
    rosterError,
    editingPlayerCount,
    isUpdatingPlayerCount,
    manageModeGuestForm,
    setManageModeGuestForm,
    manageModeGuestData,
    setManageModeGuestData,
    isAddingManageGuest,
    memberMatchWarning,
    setMemberMatchWarning,
    unlinkingSlotId,
    removingGuestId,
    manageModeSearchSlot,
    setManageModeSearchSlot,
    isLinkingMember,
    savingChanges,
    showInlinePayment,
    setShowInlinePayment,
    inlinePaymentAction,
    setInlinePaymentAction,
    paymentSuccess,
    processingPayment,
    savedCardInfo,
    checkingCard,
    waiverReason,
    setWaiverReason,
    showWaiverInput,
    setShowWaiverInput,
    ownerSlot,
    hasOwner,
    filledSlotsCount,
    guestCount,
    renderTierBadge,
    shouldShowRememberEmail,
    getRoleBadge,
    fetchRosterData,
    updateSlot,
    clearSlot,
    handleMemberSelect,
    handleAddGuestPlaceholder,
    handleSelectExistingVisitor,
    handleCreateVisitorAndAssign,
    handleManageModeUpdatePlayerCount,
    handleManageModeLinkMember,
    handleManageModeUnlinkMember,
    handleManageModeAddGuest,
    handleInlineMarkPaid,
    handleInlineChargeSavedCard,
    handleInlineWaiveAll,
    handleInlineStripeSuccess,
    handleManageModeRemoveGuest,
    handleManageModeMemberMatchResolve,
    handleManageModeSave,
    handleFinalizeBooking,
    handleMarkAsEvent,
    executeMarkAsEvent,
    handleAssignToStaff,
    deleting,
    handleDeleteBooking,
    reassignSearchOpen,
    setReassignSearchOpen,
    isReassigningOwner,
    handleReassignOwner,
    isQuickAddingGuest,
    handleManageModeQuickAddGuest,
  };
}

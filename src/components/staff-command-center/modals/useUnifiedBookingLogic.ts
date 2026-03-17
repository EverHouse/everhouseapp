import { useState, useEffect, useCallback, useRef } from 'react';
import { SelectedMember } from '../../shared/MemberSearchInput';
import { useToast } from '../../Toast';
import { usePricing } from '../../../hooks/usePricing';
import { fetchWithCredentials, postWithCredentials, putWithCredentials, deleteWithCredentials, patchWithCredentials } from '../../../hooks/queries/useFetch';
import { apiRequest } from '../../../lib/apiRequest';
import TierBadge from '../../TierBadge';
import type { BookingMember, ManageModeRosterData, MemberMatchWarning, UnifiedBookingSheetProps, VisitorSearchResult, SlotState, SlotsArray } from './bookingSheetTypes';
import { isPlaceholderEmail } from './bookingSheetTypes';
import { useBookingActions } from '../../../hooks/useBookingActions';
import React from 'react';

export type { VisitorSearchResult, SlotState, SlotsArray } from './bookingSheetTypes';

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    currentMemberName,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    currentMemberEmail,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isRelink,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    importedName,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    notes,
    originalEmail,
    bookingId,
    sessionId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ownerName,
    ownerEmail,
    declaredPlayerCount,
    bookingContext,
    checkinMode,
    onSuccess,
    onOpenBillingModal,
    onRosterUpdated,
    onCheckinComplete,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onCollectPayment,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onReschedule,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onCancelBooking,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onCheckIn,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    bookingStatus,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const isPollingFetchingRef = useRef(false);
  const wsRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const rosterFetchIdRef = useRef(0);
  const checkCardFetchIdRef = useRef(0);
  const billingModalTimerRef = useRef<NodeJS.Timeout | null>(null);

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
    const fetchId = ++rosterFetchIdRef.current;
    setIsLoadingRoster(true);
    setRosterError(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const data = await fetchWithCredentials<ManageModeRosterData>(`/api/admin/booking/${bookingId}/members`, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
      });
      clearTimeout(timeoutId);
      if (fetchId !== rosterFetchIdRef.current) return;
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
    isPollingFetchingRef.current = false;
    pollingTimerRef.current = setInterval(async () => {
      if (isPollingFetchingRef.current) return;
      pollingCountRef.current++;
      if (pollingCountRef.current > 5) {
        stopPaymentPolling();
        setProcessingPayment(false);
        await fetchRosterData();
        return;
      }
      try {
        if (!bookingId) return;
        isPollingFetchingRef.current = true;
        const data = await fetchWithCredentials<ManageModeRosterData>(`/api/admin/booking/${bookingId}/members`, {
          headers: { 'Cache-Control': 'no-cache' }
        });
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
      } finally {
        isPollingFetchingRef.current = false;
      }
    }, 2000);
  }, [bookingId, stopPaymentPolling, fetchRosterData]);

  useEffect(() => {
    if (!isOpen || !bookingId) return;

    const handleBillingUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail) return;
      if (detail.bookingId && Number(detail.bookingId) === bookingId) {
        // eslint-disable-next-line no-console
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

    const debouncedRefresh = () => {
      if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
      wsRefreshTimerRef.current = setTimeout(() => {
        wsRefreshTimerRef.current = null;
        fetchRosterData();
      }, 300);
    };

    const handleRosterUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || Number(detail.bookingId) !== bookingId) return;
      // eslint-disable-next-line no-console
      console.log('[BookingSheet] Roster update received via WebSocket, refreshing', detail.action);
      debouncedRefresh();
    };

    const handleInvoiceUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || Number(detail.bookingId) !== bookingId) return;
      // eslint-disable-next-line no-console
      console.log('[BookingSheet] Invoice update received via WebSocket, refreshing', detail.action);
      debouncedRefresh();
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
      if (wsRefreshTimerRef.current) {
        clearTimeout(wsRefreshTimerRef.current);
        wsRefreshTimerRef.current = null;
      }
    };
  }, [isOpen, bookingId, fetchRosterData]);

  useEffect(() => {
    stopPaymentPolling();
  }, [bookingId, stopPaymentPolling]);

  useEffect(() => {
    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      if (billingModalTimerRef.current) {
        clearTimeout(billingModalTimerRef.current);
        billingModalTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen && isManageMode) {
      fetchRosterData();
    }
  }, [isOpen, isManageMode, fetchRosterData]);

  const checkSavedCard = useCallback(async (email: string) => {
    const fetchId = ++checkCardFetchIdRef.current;
    try {
      setCheckingCard(true);
      const data = await fetchWithCredentials<{ hasSavedCard: boolean; last4?: string; brand?: string }>(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`);
      if (fetchId !== checkCardFetchIdRef.current) return;
      setSavedCardInfo(data);
    } catch (err: unknown) {
      if (fetchId !== checkCardFetchIdRef.current) return;
      console.error('Failed to check saved card:', err);
    } finally {
      if (fetchId === checkCardFetchIdRef.current) {
        setCheckingCard(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !bookingId) return;
    const hasPropContext = bayName || bookingDate || timeSlot || bookingContext;
    if (hasPropContext) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchWithCredentials<{
          start_time?: string; end_time?: string; resource_name?: string; bay_name?: string;
          resource_id?: number; request_date?: string; trackman_booking_id?: string;
          status?: string; user_name?: string; user_email?: string; user_id?: number;
          duration_minutes?: number; notes?: string;
        }>(`/api/booking-requests/${bookingId}`);
        if (cancelled) return;
        const formatTime = (t: string | null) => {
          if (!t) return '';
          const [h, m] = t.split(':').map(Number);
          const ampm = h >= 12 ? 'PM' : 'AM';
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
        };
        const start = formatTime(data.start_time ?? null);
        const end = formatTime(data.end_time ?? null);
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
      } catch (err: unknown) {
        if (!cancelled) {
          console.error('[UnifiedBooking] Failed to fetch booking context:', err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, bookingId, bayName, bookingDate, timeSlot, bookingContext, ownerEmail, checkSavedCard]);

  useEffect(() => {
    const email = ownerEmail || fetchedContext?.ownerEmail;
    if (isOpen && isManageMode && email) {
      checkSavedCard(email);
    }
  }, [isOpen, isManageMode, ownerEmail, fetchedContext?.ownerEmail, checkSavedCard]);

  useEffect(() => {
    let isCurrent = true;
    const fetchStaffList = async () => {
      if (!showStaffList || staffList.length > 0) return;
      setIsLoadingStaff(true);
      try {
        const data = await fetchWithCredentials<Array<{ id: string; email: string; first_name: string; last_name: string; role: string; user_id: string | null }>>('/api/staff/list');
        if (isCurrent) {
          setStaffList(data);
        }
      } catch (err: unknown) {
        if (isCurrent) console.error('Failed to fetch staff list:', err);
      } finally {
        if (isCurrent) setIsLoadingStaff(false);
      }
    };
    fetchStaffList();
    return () => { isCurrent = false; };
  }, [showStaffList, staffList.length]);

  useEffect(() => {
    if (isManageMode) return;
    let isActive = true;
    const checkDuplicates = async () => {
      const fullName = `${visitorData.firstName} ${visitorData.lastName}`.trim();
      if (fullName.length < 3) {
        setPotentialDuplicates([]);
        return;
      }
      
      setIsCheckingDuplicates(true);
      try {
        const data = await fetchWithCredentials<Array<{ id: string; email: string; name?: string; firstName?: string; lastName?: string }>>(`/api/visitors/search?query=${encodeURIComponent(fullName)}&limit=5&includeStaff=true&includeMembers=true`);
        if (isActive) {
          const matches = data.filter((v) => {
            const vName = (v.name || `${v.firstName} ${v.lastName}`).toLowerCase().trim();
            return vName === fullName.toLowerCase();
          });
          setPotentialDuplicates(matches.map((v) => ({
            id: v.id,
            email: v.email,
            name: v.name || `${v.firstName} ${v.lastName}`
          })));
        }
      } catch (err: unknown) {
        if (isActive) console.error('Duplicate check error:', err);
      } finally {
        if (isActive) setIsCheckingDuplicates(false);
      }
    };
    
    const timeoutId = setTimeout(checkDuplicates, 500);
    return () => { isActive = false; clearTimeout(timeoutId); };
  }, [visitorData.firstName, visitorData.lastName, isManageMode]);

  useEffect(() => {
    if (isManageMode) return;
    let isActive = true;
    const searchVisitors = async () => {
      if (!visitorSearch || visitorSearch.length < 2) {
        setVisitorSearchResults([]);
        return;
      }
      setIsSearchingVisitors(true);
      try {
        const data = await fetchWithCredentials<VisitorSearchResult[]>(`/api/visitors/search?query=${encodeURIComponent(visitorSearch)}&limit=10&includeMembers=true`);
        if (isActive) {
          setVisitorSearchResults(data);
        }
      } catch (err: unknown) {
        if (isActive) console.error('Visitor search error:', err);
      } finally {
        if (isActive) setIsSearchingVisitors(false);
      }
    };
    const timeoutId = setTimeout(searchVisitors, 300);
    return () => { isActive = false; clearTimeout(timeoutId); };
  }, [visitorSearch, isManageMode]);

  useEffect(() => {
    if (isManageMode) return;
    let isCurrent = true;
    const controller = new AbortController();
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
            // eslint-disable-next-line prefer-const
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
        const data = await fetchWithCredentials<{ totalCents?: number; overageCents?: number; guestCents?: number }>(`/api/fee-estimate?${params}`, {
          signal: controller.signal
        });
        if (isCurrent) {
          setFeeEstimate({
            totalCents: data.totalCents || 0,
            overageCents: data.overageCents || 0,
            guestCents: data.guestCents || 0
          });
        }
      } catch (err: unknown) {
        if (isCurrent && !(err instanceof DOMException && (err as DOMException).name === 'AbortError')) {
          console.error('Fee estimation error:', err);
        }
      } finally {
        if (isCurrent) setIsCalculatingFees(false);
      }
    };
    
    calculateFees();
    return () => {
      isCurrent = false;
      controller.abort();
    };
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
      const autoVisitorType = activeSlotIndex === 0 ? 'day_pass' : 'guest';
      const createResult = await apiRequest<Record<string, unknown>>('/api/visitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: visitorData.email,
          firstName: visitorData.firstName,
          lastName: visitorData.lastName,
          visitorType: autoVisitorType,
          createStripeCustomer: true
        })
      }, { maxRetries: 1 });
      
      if (!createResult.ok) {
        if (createResult.errorData?.existingUser) {
          const existingUser = createResult.errorData.existingUser as Record<string, unknown>;
          showToast(`User already exists: ${existingUser.name || existingUser.email}`, 'error');
        } else {
          showToast(createResult.error || 'Failed to create visitor', 'error');
        }
        setIsCreatingVisitor(false);
        return;
      }
      
      const data = createResult.data as Record<string, unknown>;
      const visitor = data.visitor as Record<string, string>;
      if (data.stripeCreated) {
        showToast(`Created visitor: ${visitor.firstName} ${visitor.lastName}`, 'success');
      } else {
        showToast(`Created visitor but Stripe setup failed - can add later`, 'warning');
      }
      
      updateSlot(activeSlotIndex, {
        type: 'visitor',
        member: {
          id: visitor.id,
          email: visitor.email,
          name: `${visitor.firstName} ${visitor.lastName}`
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
      await patchWithCredentials(`/api/admin/booking/${bookingId}/player-count`, { playerCount: newCount });
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
      await putWithCredentials(`/api/admin/booking/${bookingId}/members/${slotId}/link`, { memberEmail });
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
    setUnlinkingSlotId(slotId);
    try {
      await putWithCredentials(`/api/admin/booking/${bookingId}/members/${slotId}/unlink`, {});
      showToast('Member removed', 'success');
      await fetchRosterData();
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to unlink member', 'error');
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

      const guestResult = await apiRequest<Record<string, unknown>>(`/api/admin/booking/${bookingId}/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, { maxRetries: 1 });

      if (!guestResult.ok) {
        if (guestResult.errorData?.memberMatch) {
          setMemberMatchWarning({
            slotNumber,
            guestData: {
              guestName: body.guestName as string,
              guestEmail: body.guestEmail as string,
              guestPhone: manageModeGuestData.phone
            },
            memberMatch: guestResult.errorData.memberMatch as MemberMatchWarning['memberMatch']
          });
          setIsAddingManageGuest(false);
          return;
        }
        throw new Error(guestResult.error || 'Failed to add guest');
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
      await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { action: 'confirm_all' });
      showToast('Payment confirmed', 'success');
      setPaymentSuccess(true);
      setShowInlinePayment(false);
      await fetchRosterData();
    } catch (_err: unknown) {
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
        sessionId: rosterData.sessionId!,
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
    } catch (_err: unknown) {
      showToast('Failed to charge card', 'error');
    } finally {
      setInlinePaymentAction(null);
    }
  };

  const handleInlineWaiveAll = async () => {
    if (!bookingId || !waiverReason.trim()) return;
    setInlinePaymentAction('waive');
    try {
      await patchWithCredentials(`/api/bookings/${bookingId}/payments`, { action: 'waive_all', reason: waiverReason.trim() });
      showToast('All fees waived', 'success');
      setPaymentSuccess(true);
      setShowInlinePayment(false);
      setShowWaiverInput(false);
      setWaiverReason('');
      setInlinePaymentAction(null);
      await fetchRosterData();
    } catch (_err: unknown) {
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
      await deleteWithCredentials(`/api/admin/booking/${bookingId}/guests/${guestId}`);
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
      const member = rosterData?.members?.find(m => m.slotNumber === memberMatchWarning.slotNumber);
      if (member) {
        await handleManageModeLinkMember(member.id, memberMatchWarning.memberMatch.email);
      } else {
        await postWithCredentials(`/api/admin/booking/${bookingId}/members`, { memberEmail: memberMatchWarning.memberMatch.email, slotId: memberMatchWarning.slotNumber });
        await fetchRosterData();
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
      if (matchedBookingId) {
        const data = await putWithCredentials<{ feesRecalculated?: boolean }>(`/api/bookings/${matchedBookingId}/assign-with-players`, {
          owner: {
            email: owner.email,
            name: owner.name,
            member_id: owner.id
          },
          additional_players: additionalPlayers,
          rememberEmail: shouldShowRememberEmail() ? rememberEmail : false,
          originalEmail: originalEmail
        });
        feesRecalculated = data.feesRecalculated === true;
      } else if (trackmanBookingId) {
        const data = await postWithCredentials<{ convertedToAvailabilityBlock?: boolean; instructorName?: string; feesRecalculated?: boolean; bookingId?: number }>('/api/bookings/link-trackman-to-member', {
          trackman_booking_id: trackmanBookingId,
          owner: {
            email: owner.email,
            name: owner.name,
            member_id: owner.id
          },
          additional_players: additionalPlayers,
          rememberEmail: shouldShowRememberEmail() ? rememberEmail : false,
          originalEmail: originalEmail
        });
        if (data.convertedToAvailabilityBlock) {
          showToast(`${data.instructorName || 'Instructor'} lesson converted to availability block`, 'success');
          onSuccess?.({ memberEmail: owner.email, memberName: owner.name });
          onClose();
          return;
        }
        feesRecalculated = data.feesRecalculated === true;
        if (data.bookingId) {
          resultBookingId = data.bookingId;
        }
      } else if (sessionId) {
        await postWithCredentials('/api/data-integrity/fix/assign-session-owner', {
          sessionId: sessionId,
          ownerEmail: owner.email,
          additional_players: additionalPlayers
        });
      }
      
      showToast(`Booking assigned with ${filledSlotsCount} player${filledSlotsCount > 1 ? 's' : ''}${guestCount > 0 ? ` (${guestCount} guest${guestCount > 1 ? 's' : ''})` : ''}`, 'success');
      onSuccess?.({ memberEmail: owner.email, memberName: owner.name });
      onClose();
      
      if (feesRecalculated && resultBookingId && onOpenBillingModal) {
        const numericBookingId = typeof resultBookingId === 'number' 
          ? resultBookingId 
          : parseInt(String(resultBookingId).replace('review-', ''), 10);
        if (!isNaN(numericBookingId)) {
          if (billingModalTimerRef.current) clearTimeout(billingModalTimerRef.current);
          billingModalTimerRef.current = setTimeout(() => {
            billingModalTimerRef.current = null;
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
      
      const notices = await fetchWithCredentials<Array<{ id: number; title: string; reason: string | null; notice_type: string | null; start_date: string; end_date: string; start_time: string | null; end_time: string | null; source: string }>>(`/api/resources/overlapping-notices?${params}`);
      setOverlappingNotices(notices);
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

  const executeMarkAsEvent = async (existingClosureId?: number, eventTitle?: string) => {
    if (markingAsEvent) return;
    
    setMarkingAsEvent(true);
    try {
      const bkId = matchedBookingId;
      if (!bkId && !trackmanBookingId) {
        throw new Error('No booking to mark as event');
      }

      const body: Record<string, unknown> = {
        booking_id: bkId,
        trackman_booking_id: trackmanBookingId,
        existingClosureId,
      };
      if (eventTitle?.trim()) {
        body.eventTitle = eventTitle.trim();
      }

      await postWithCredentials('/api/bookings/mark-as-event', body);
      
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
      
      if (matchedBookingId) {
        await putWithCredentials(`/api/bookings/${matchedBookingId}/assign-with-players`, {
          owner: {
            email: staff.email,
            name: staffName,
            member_id: staff.user_id
          },
          additional_players: [],
          rememberEmail: false
        });
      } else if (trackmanBookingId) {
        await postWithCredentials('/api/bookings/link-trackman-to-member', {
          trackman_booking_id: trackmanBookingId,
          owner: {
            email: staff.email,
            name: staffName,
            member_id: staff.user_id
          },
          additional_players: [],
          rememberEmail: false
        });
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
      await deleteWithCredentials(`/api/bookings/${deleteId}?hard_delete=true`);
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      alert((err instanceof Error ? err.message : String(err)) || 'Failed to delete booking');
    } finally {
      setDeleting(false);
    }
  };

  const handleManageModeQuickAddGuest = async (_slotNumber: number) => {
    if (!bookingId) return;
    setIsQuickAddingGuest(true);
    try {
      await postWithCredentials(`/api/admin/booking/${bookingId}/guests`, { quickAdd: true });
      showToast('Guest added', 'success');
      await fetchRosterData();
    } catch (_err) {
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
      const data = await putWithCredentials<{ message?: string }>(`/api/admin/trackman/matched/${bookingId}/reassign`, { newMemberEmail });

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

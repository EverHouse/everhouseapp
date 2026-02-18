import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useData } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { getTodayPacific, addDaysToPacificDate, formatTime12Hour } from '../../../utils/dateUtils';
import { usePricing } from '../../../hooks/usePricing';
import ModalShell from '../../../components/ModalShell';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../contexts/ThemeContext';
import { TabType, tabToPath } from '../layout/types';
import { TrackmanBookingModal } from '../../../components/staff-command-center/modals/TrackmanBookingModal';
import { UnifiedBookingSheet } from '../../../components/staff-command-center/modals/UnifiedBookingSheet';
import { StaffManualBookingModal, type StaffManualBookingData } from '../../../components/staff-command-center/modals/StaffManualBookingModal';
import { RescheduleBookingModal } from '../../../components/booking/RescheduleBookingModal';
import { useBookingActions } from '../../../hooks/useBookingActions';
import { AnimatedPage } from '../../../components/motion';
import FloatingActionButton from '../../../components/FloatingActionButton';
import { useConfirmDialog } from '../../../components/ConfirmDialog';
import { SimulatorTabSkeleton } from '../../../components/skeletons';
import {
    useResources,
    useBays,
    useAllBookingRequests,
    usePendingBookings,
    useApprovedBookings,
    useCalendarClosures,
    useAvailabilityBlocks,
    useMemberContacts,
    bookingsKeys,
    simulatorKeys,
} from '../../../hooks/queries/useBookingsQueries';

import type { BookingRequest, Bay, Resource, CalendarClosure, AvailabilityBlock } from './simulator/simulatorTypes';
import { formatDateShortAdmin } from './simulator/simulatorUtils';
import ManualBookingModal from './simulator/MemberSearchPopover';
import CalendarGrid from './simulator/CalendarGrid';
import BookingRequestsPanel from './simulator/BookingRequestsPanel';
import GuideBookings from '../../../components/guides/GuideBookings';

const SimulatorTab: React.FC = () => {
    const navigate = useNavigate();
    const { setPageReady } = usePageReady();
    const { user, actualUser, members } = useData();
    const queryClient = useQueryClient();
    const { guestFeeDollars, overageRatePerBlockDollars, tierMinutes } = usePricing();
    
    const navigateToTab = useCallback((tab: TabType) => {
        if (tabToPath[tab]) {
            navigate(tabToPath[tab]);
        }
    }, [navigate]);
    
    const activeMemberEmails = useMemo(() => 
        new Set(members.map(m => m.email.toLowerCase())),
        [members]
    );
    
    const { showToast } = useToast();
    const { checkInWithToast } = useBookingActions();
    const { effectiveTheme } = useTheme();
    const isDark = effectiveTheme === 'dark';
    const [activeView, setActiveView] = useState<'requests' | 'calendar'>('requests');
    const [calendarDate, setCalendarDate] = useState(() => getTodayPacific());

    const { data: resourcesData = [], isLoading: resourcesLoading } = useResources();
    const { data: baysData = [], isLoading: baysLoading } = useBays();
    const { data: bookingRequestsData = [], isLoading: requestsLoading } = useAllBookingRequests();
    const { data: pendingBookingsData = [] } = usePendingBookings();
    const { data: memberContactsData = [] } = useMemberContacts('all');
    const { data: closuresData = [] } = useCalendarClosures();
    
    const today = getTodayPacific();
    const baseDate = activeView === 'calendar' ? calendarDate : today;
    const startDate = addDaysToPacificDate(baseDate, -60);
    const endDate = addDaysToPacificDate(baseDate, 30);
    
    const { data: approvedBookingsData = [], isLoading: approvedLoading } = useApprovedBookings(startDate, endDate);
    const { data: availabilityBlocksData = [] } = useAvailabilityBlocks(calendarDate);
    
    const isLoading = resourcesLoading || baysLoading || requestsLoading || approvedLoading;
    
    const resources: Resource[] = resourcesData;
    const bays: Bay[] = baysData;
    const closures: CalendarClosure[] = closuresData.filter((c: CalendarClosure) => 
        c.startDate <= endDate && c.endDate >= startDate
    );
    
    const availabilityBlocks: AvailabilityBlock[] = useMemo(() => 
        availabilityBlocksData.map((b: { id: number; resource_id?: number; resourceId?: number; block_date?: string; blockDate?: string; start_time?: string; startTime?: string; end_time?: string; endTime?: string; block_type?: string; blockType?: string; notes?: string; closure_title?: string; closureTitle?: string }) => ({
            id: b.id,
            resourceId: b.resource_id || b.resourceId,
            blockDate: b.block_date?.includes('T') ? b.block_date.split('T')[0] : (b.blockDate || b.block_date),
            startTime: b.start_time || b.startTime,
            endTime: b.end_time || b.endTime,
            blockType: b.block_type || b.blockType,
            notes: b.notes,
            closureTitle: b.closure_title || b.closureTitle
        })),
        [availabilityBlocksData]
    );
    
    const requests: BookingRequest[] = useMemo(() => {
        const fromRequests = bookingRequestsData.map((r: BookingRequest) => ({ ...r, source: 'booking_request' as const }));
        const fromPending = pendingBookingsData.map((b: Record<string, string | number | null>) => ({
            id: b.id,
            user_email: b.user_email,
            user_name: b.first_name && b.last_name ? `${b.first_name} ${b.last_name}` : b.user_email,
            resource_id: null,
            bay_name: null,
            resource_preference: b.resource_name || null,
            request_date: b.booking_date,
            start_time: b.start_time,
            end_time: b.end_time,
            duration_minutes: 60,
            notes: b.notes,
            status: b.status,
            staff_notes: null,
            suggested_time: null,
            created_at: b.created_at,
            source: 'booking' as const,
            resource_name: b.resource_name
        }));
        return [...fromRequests, ...fromPending];
    }, [bookingRequestsData, pendingBookingsData]);
    
    const approvedBookings: BookingRequest[] = approvedBookingsData as BookingRequest[];
    
    const { memberStatusMap, memberNameMap } = useMemo(() => {
        const statusMap: Record<string, string> = {};
        const nameMap: Record<string, string> = {};
        memberContactsData.forEach((m: { email?: string; firstName?: string; lastName?: string; status?: string; manuallyLinkedEmails?: string[] }) => {
            const fullName = [m.firstName, m.lastName].filter(Boolean).join(' ');
            if (m.email) {
                const emailLower = m.email.toLowerCase();
                statusMap[emailLower] = m.status || 'unknown';
                if (fullName) {
                    nameMap[emailLower] = fullName;
                }
            }
            if (m.manuallyLinkedEmails && fullName) {
                m.manuallyLinkedEmails.forEach((linkedEmail: string) => {
                    if (linkedEmail) {
                        const linkedEmailLower = linkedEmail.toLowerCase();
                        statusMap[linkedEmailLower] = m.status || 'unknown';
                        nameMap[linkedEmailLower] = fullName;
                    }
                });
            }
        });
        return { memberStatusMap: statusMap, memberNameMap: nameMap };
    }, [memberContactsData]);
    
    const approveBookingMutation = undefined;
    const declineBookingMutation = undefined;
    
    const [selectedRequest, setSelectedRequest] = useState<BookingRequest | null>(null);
    const [actionModal, setActionModal] = useState<'approve' | 'decline' | null>(null);
    const [selectedBayId, setSelectedBayId] = useState<number | null>(null);
    const [staffNotes, setStaffNotes] = useState('');
    const [suggestedTime, setSuggestedTime] = useState('');
    const [declineAvailableSlots, setDeclineAvailableSlots] = useState<string[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [availabilityStatus, setAvailabilityStatus] = useState<'checking' | 'available' | 'conflict' | null>(null);
    const [conflictDetails, setConflictDetails] = useState<string | null>(null);
    const [showTrackmanConfirm, setShowTrackmanConfirm] = useState(false);
    const [showManualBooking, setShowManualBooking] = useState(false);
    const [prefillResourceId, setPrefillResourceId] = useState<number | null>(null);
    const [prefillDate, setPrefillDate] = useState<string | null>(null);
    const [prefillStartTime, setPrefillStartTime] = useState<string | null>(null);
    
    const [scheduledFilter, setScheduledFilter] = useState<'all' | 'today' | 'tomorrow' | 'week'>('all');
    const [markStatusModal, setMarkStatusModal] = useState<{ booking: BookingRequest | null; confirmNoShow: boolean }>({ booking: null, confirmNoShow: false });
    
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    
    const [rescheduleModal, setRescheduleModal] = useState<{ isOpen: boolean; booking: BookingRequest | null }>({ isOpen: false, booking: null });
    const [feeEstimate, setFeeEstimate] = useState<{
      totalFee: number;
      ownerTier: string | null;
      perPersonMins: number;
      feeBreakdown: {
        overageMinutes: number;
        overageFee: number;
        guestCount: number;
        guestPassesRemaining: number;
        guestsUsingPasses: number;
        guestsCharged: number;
        guestFees: number;
        guestFeePerUnit?: number;
        overageRatePerBlock?: number;
      };
      note: string;
    } | null>(null);
    const [isFetchingFeeEstimate, setIsFetchingFeeEstimate] = useState(false);
    const [trackmanModal, setTrackmanModal] = useState<{ isOpen: boolean; booking: BookingRequest | null }>({ isOpen: false, booking: null });
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const [bookingSheet, setBookingSheet] = useState<{ 
        isOpen: boolean; 
        trackmanBookingId: string | null;
        bayName?: string;
        bookingDate?: string;
        timeSlot?: string;
        matchedBookingId?: number;
        currentMemberName?: string;
        currentMemberEmail?: string;
        isRelink?: boolean;
        importedName?: string;
        notes?: string;
        bookingId?: number | null;
        mode?: 'assign' | 'manage';
        ownerName?: string;
        ownerEmail?: string;
        declaredPlayerCount?: number;
        bookingStatus?: string;
        bookingContext?: { requestDate?: string; startTime?: string; endTime?: string; resourceId?: number; resourceName?: string; durationMinutes?: number; notes?: string };
        ownerMembershipStatus?: string | null;
    }>({ isOpen: false, trackmanBookingId: null });
    const [cancelConfirmModal, setCancelConfirmModal] = useState<{
        isOpen: boolean;
        booking: BookingRequest | null;
        hasTrackman: boolean;
        isCancelling: boolean;
        showSuccess: boolean;
    }>({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
    const [staffManualBookingModalOpen, setStaffManualBookingModalOpen] = useState(false);
    const checkinInProgressRef = useRef<Set<number>>(new Set());
    const [staffManualBookingDefaults, setStaffManualBookingDefaults] = useState<{
        resourceId?: number;
        startTime?: string;
        date?: string;
        initialMode?: 'member' | 'lesson' | 'conference';
    }>({});
    
    const [actionInProgress, setActionInProgress] = useState<Record<string, string>>({});
    const [isCreatingBooking, setIsCreatingBooking] = useState(false);
    const [optimisticNewBooking, setOptimisticNewBooking] = useState<BookingRequest | null>(null);
    
    const calendarColRef = useRef<HTMLDivElement>(null);
    const [queueMaxHeight, setQueueMaxHeight] = useState<number | null>(null);
    
    useLayoutEffect(() => {
        const syncHeights = () => {
            if (calendarColRef.current) {
                const calendarHeight = calendarColRef.current.offsetHeight;
                if (calendarHeight > 0) {
                    setQueueMaxHeight(calendarHeight);
                }
            }
        };
        
        const timer = setTimeout(syncHeights, 100);
        
        window.addEventListener('resize', syncHeights);
        
        const observer = new ResizeObserver(syncHeights);
        if (calendarColRef.current) {
            observer.observe(calendarColRef.current);
        }
        
        return () => {
            clearTimeout(timer);
            window.removeEventListener('resize', syncHeights);
            observer.disconnect();
        };
    }, [isLoading, calendarDate]);

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);

    useEffect(() => {
        const openBookingById = async (bookingId: number | string) => {
            try {
                const res = await fetch(`/api/booking-requests?id=${bookingId}`, { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.length > 0) {
                        const booking = data[0];
                        const email = (booking.user_email || '').toLowerCase();
                        const isPlaceholderEmail = !email || 
                            email.includes('@trackman.local') ||
                            email.includes('@visitors.evenhouse.club') ||
                            email.startsWith('unmatched-') ||
                            email.startsWith('golfnow-') ||
                            email.startsWith('classpass-') ||
                            email === 'unmatched@trackman.import';
                        const isUnmatched = booking.is_unmatched === true ||
                            isPlaceholderEmail ||
                            booking.user_name === 'Unknown (Trackman)';
                        setBookingSheet({
                            isOpen: true,
                            trackmanBookingId: booking.trackman_booking_id || null,
                            bookingId: booking.id,
                            mode: isUnmatched ? 'assign' as const : 'manage' as const,
                            bayName: booking.bay_name || booking.resource_name,
                            bookingDate: booking.request_date,
                            timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                            matchedBookingId: Number(booking.id),
                            currentMemberName: isUnmatched ? undefined : (booking.user_name || undefined),
                            currentMemberEmail: isUnmatched ? undefined : (booking.user_email || undefined),
                            ownerName: booking.user_name || undefined,
                            ownerEmail: booking.user_email || undefined,
                            declaredPlayerCount: booking.declared_player_count || booking.player_count || 1,
                            isRelink: !isUnmatched,
                            importedName: booking.user_name || booking.userName,
                            notes: booking.notes || booking.note,
                            bookingStatus: booking.status,
                            bookingContext: { requestDate: booking.request_date, startTime: booking.start_time, endTime: booking.end_time, resourceId: booking.resource_id, resourceName: booking.bay_name || booking.resource_name, durationMinutes: booking.duration_minutes },
                        });
                    }
                }
            } catch (err) {
                console.error('Failed to open booking details:', err);
            }
        };
        
        const handleOpenBookingDetails = async (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.bookingId) {
                await openBookingById(detail.bookingId);
            }
        };
        window.addEventListener('open-booking-details', handleOpenBookingDetails);
        
        const pendingBookingId = sessionStorage.getItem('pendingRosterBookingId');
        if (pendingBookingId) {
            sessionStorage.removeItem('pendingRosterBookingId');
            openBookingById(pendingBookingId);
        }
        
        return () => window.removeEventListener('open-booking-details', handleOpenBookingDetails);
    }, []);

    useEffect(() => {
        if (actionModal || showTrackmanConfirm || markStatusModal.booking) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [actionModal, showTrackmanConfirm, markStatusModal.booking]);

    const handleRefresh = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
        queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
        setLastRefresh(new Date());
    }, [queryClient]);

    useEffect(() => {
        const handleBookingUpdate = () => {
            console.log('[SimulatorTab] Global booking-update event received');
            handleRefresh();
        };
        window.addEventListener('booking-update', handleBookingUpdate);
        return () => window.removeEventListener('booking-update', handleBookingUpdate);
    }, [handleRefresh]);

    const handleTrackmanConfirm = useCallback(async (bookingId: number | string, trackmanBookingId: string) => {
        const apiId = typeof bookingId === 'string' ? parseInt(String(bookingId).replace('cal_', '')) : bookingId;
        const booking = requests.find(r => r.id === bookingId);

        try {
            const res = await fetch(`/api/booking-requests/${apiId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ 
                    status: 'approved',
                    trackman_booking_id: trackmanBookingId
                })
            });
            if (res.ok) {
                showToast('Booking confirmed with Trackman', 'success');
                window.dispatchEvent(new CustomEvent('booking-action-completed'));
                handleRefresh();
            } else {
                const error = await res.json().catch(() => ({}));
                throw new Error(error.error || 'Failed to confirm booking');
            }
        } catch (err: unknown) {
            throw err;
        }
    }, [requests, showToast, handleRefresh]);

    const handleLinkTrackmanToMember = useCallback((event: {
        trackmanBookingId: string;
        bayName?: string;
        bookingDate?: string;
        timeSlot?: string;
        matchedBookingId?: number;
        currentMemberName?: string;
        currentMemberEmail?: string;
        isRelink?: boolean;
    }) => {
        setBookingSheet({
            isOpen: true,
            trackmanBookingId: event.trackmanBookingId,
            bayName: event.bayName,
            bookingDate: event.bookingDate,
            timeSlot: event.timeSlot,
            matchedBookingId: event.matchedBookingId,
            currentMemberName: event.currentMemberName,
            currentMemberEmail: event.currentMemberEmail,
            isRelink: event.isRelink
        });
    }, []);

    const handleStaffManualBookingSubmit = useCallback(async (data: StaffManualBookingData) => {
        const requestParticipants = data.participants.map(p => ({
            type: p.type,
            email: p.member?.email || p.email || '',
            userId: p.member?.id,
            name: p.member?.name || p.name
        })).filter(p => p.email || p.userId);

        setIsCreatingBooking(true);
        
        const [startHour, startMin] = data.startTime.split(':').map(Number);
        const endTotalMins = startHour * 60 + startMin + data.durationMinutes;
        const endHour = Math.floor(endTotalMins / 60) % 24;
        const endMin = endTotalMins % 60;
        const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;
        
        const optimisticId = `creating-${Date.now()}`;
        const optimisticBooking: BookingRequest = {
            id: optimisticId,
            user_email: data.hostMember.email,
            user_name: data.hostMember.name,
            resource_id: data.resourceId,
            bay_name: resources?.find(r => r.id === data.resourceId)?.name || null,
            resource_preference: null,
            request_date: data.requestDate,
            start_time: data.startTime + ':00',
            end_time: endTime + ':00',
            duration_minutes: data.durationMinutes,
            notes: null,
            status: 'confirmed',
            staff_notes: null,
            suggested_time: null,
            created_at: new Date().toISOString(),
            source: 'booking'
        };
        setOptimisticNewBooking(optimisticBooking);
        
        setStaffManualBookingModalOpen(false);

        try {
            const res = await fetch('/api/staff/manual-booking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    user_email: data.hostMember.email,
                    user_name: data.hostMember.name,
                    resource_id: data.resourceId,
                    request_date: data.requestDate,
                    start_time: data.startTime + ':00',
                    duration_minutes: data.durationMinutes,
                    declared_player_count: data.declaredPlayerCount,
                    request_participants: requestParticipants,
                    trackman_booking_id: data.trackmanBookingId
                })
            });

            if (!res.ok) {
                const error = await res.json().catch(() => ({}));
                throw new Error(error.error || 'Failed to create booking');
            }

            showToast('Booking created successfully', 'success');
            handleRefresh();
        } catch (err: unknown) {
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to create booking', 'error');
        } finally {
            setIsCreatingBooking(false);
            setOptimisticNewBooking(null);
        }
    }, [showToast, handleRefresh, resources]);

    const unmatchedBookings = useMemo(() => {
        const today = getTodayPacific();
        return approvedBookings.filter(b => 
            b.is_unmatched === true && 
            b.request_date >= today &&
            (b.status === 'approved' || b.status === 'confirmed')
        ).sort((a, b) => {
            if (a.request_date !== b.request_date) {
                return a.request_date.localeCompare(b.request_date);
            }
            return a.start_time.localeCompare(b.start_time);
        });
    }, [approvedBookings]);

    const updateBookingStatusOptimistic = useCallback(async (
        booking: BookingRequest,
        newStatus: 'attended' | 'no_show' | 'cancelled'
    ): Promise<boolean> => {
        const bookingId = typeof booking.id === 'string' 
            ? parseInt(String(booking.id).replace('cal_', '')) 
            : booking.id;
        
        if (newStatus === 'attended' && checkinInProgressRef.current.has(bookingId)) {
            console.log('[Check-in v2] Already in progress for booking', bookingId);
            return false;
        }
        if (newStatus === 'attended') {
            checkinInProgressRef.current.add(bookingId);
        }
        
        const previousRequests = queryClient.getQueryData(simulatorKeys.allRequests());
        const previousApproved = queryClient.getQueryData(simulatorKeys.approvedBookings(startDate, endDate));
        
        queryClient.setQueryData(simulatorKeys.allRequests(), (old: BookingRequest[] | undefined) => 
            (old || []).map(r => 
                r.id === booking.id ? { ...r, status: newStatus } : r
            )
        );
        queryClient.setQueryData(simulatorKeys.approvedBookings(startDate, endDate), (old: BookingRequest[] | undefined) => 
            (old || []).map(b => 
                b.id === booking.id ? { ...b, status: newStatus } : b
            )
        );
        
        try {
            const result = await checkInWithToast(bookingId, { status: newStatus, source: booking.source });
            
            if (!result.success) {
                queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
                queryClient.setQueryData(simulatorKeys.approvedBookings(startDate, endDate), previousApproved);
                
                if (result.requiresRoster) {
                    setBookingSheet({
                        isOpen: true,
                        trackmanBookingId: null,
                        bookingId,
                        mode: 'manage' as const,
                    });
                } else if (result.requiresPayment) {
                    setBookingSheet({
                        isOpen: true,
                        trackmanBookingId: null,
                        bookingId,
                        mode: 'manage' as const,
                    });
                }
                if (newStatus === 'attended') {
                    checkinInProgressRef.current.delete(bookingId);
                }
                return false;
            }
            
            queryClient.invalidateQueries({ queryKey: simulatorKeys.allRequests() });
            queryClient.invalidateQueries({ queryKey: simulatorKeys.approvedBookings(startDate, endDate) });
            return true;
        } catch (err: unknown) {
            queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
            queryClient.setQueryData(simulatorKeys.approvedBookings(startDate, endDate), previousApproved);
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to update status', 'error');
            if (newStatus === 'attended') {
                checkinInProgressRef.current.delete(bookingId);
            }
            return false;
        }
    }, [queryClient, startDate, endDate, showToast, checkInWithToast]);

    const showCancelConfirmation = useCallback((booking: BookingRequest) => {
        const hasTrackman = !!(booking.trackman_booking_id) || 
            (booking.notes && booking.notes.includes('[Trackman Import ID:'));
        setCancelConfirmModal({
            isOpen: true,
            booking,
            hasTrackman,
            isCancelling: false,
            showSuccess: false
        });
    }, []);

    const performCancellation = useCallback(async () => {
        const booking = cancelConfirmModal.booking;
        if (!booking) return;
        
        const bookingKey = `${booking.source || 'booking'}-${booking.id}`;
        setCancelConfirmModal(prev => ({ ...prev, isCancelling: true }));
        
        setActionInProgress(prev => ({ ...prev, [bookingKey]: 'cancelling' }));
        
        const previousRequests = queryClient.getQueryData(simulatorKeys.allRequests());
        const previousApproved = queryClient.getQueryData(simulatorKeys.approvedBookings(startDate, endDate));
        
        queryClient.setQueryData(simulatorKeys.allRequests(), (old: BookingRequest[] | undefined) => 
            (old || []).map(r => 
                r.id === booking.id && r.source === booking.source 
                    ? { ...r, status: 'cancelled' } 
                    : r
            )
        );
        queryClient.setQueryData(simulatorKeys.approvedBookings(startDate, endDate), (old: BookingRequest[] | undefined) => 
            (old || []).filter(b => 
                !(b.id === booking.id && b.source === booking.source)
            )
        );
        
        try {
            const res = await fetch(`/api/bookings/${booking.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ 
                    status: 'cancelled', 
                    source: booking.source,
                    cancelled_by: actualUser?.email
                })
            });
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to cancel booking');
            }
            
            showToast('Booking cancelled', 'success');
            
            if (cancelConfirmModal.hasTrackman) {
                setCancelConfirmModal(prev => ({ ...prev, isCancelling: false, showSuccess: true }));
            } else {
                setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
            }
        } catch (err: unknown) {
            queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
            queryClient.setQueryData(simulatorKeys.approvedBookings(startDate, endDate), previousApproved);
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to cancel booking', 'error');
            setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
        } finally {
            setActionInProgress(prev => {
                const next = { ...prev };
                delete next[bookingKey];
                return next;
            });
        }
    }, [cancelConfirmModal.booking, cancelConfirmModal.hasTrackman, queryClient, startDate, endDate, actualUser?.email, showToast]);

    const cancelBookingOptimistic = useCallback(async (
        booking: BookingRequest
    ): Promise<boolean> => {
        showCancelConfirmation(booking);
        return true;
    }, [showCancelConfirmation]);

    useEffect(() => {
        const checkAvailability = async () => {
            if (!selectedBayId || !selectedRequest || actionModal !== 'approve') {
                setAvailabilityStatus(null);
                setConflictDetails(null);
                return;
            }
            
            setAvailabilityStatus('checking');
            setConflictDetails(null);
            
            try {
                const [bookingsRes, closuresRes] = await Promise.all([
                    fetch(`/api/approved-bookings?start_date=${selectedRequest.request_date}&end_date=${selectedRequest.request_date}`),
                    fetch('/api/closures')
                ]);
                
                let hasConflict = false;
                let details = '';
                
                if (bookingsRes.ok) {
                    const bookings = await bookingsRes.json();
                    const reqStart = selectedRequest.start_time;
                    const reqEnd = selectedRequest.end_time;
                    
                    const conflict = bookings.find((b: { resource_id?: number; request_date?: string; start_time: string; end_time: string }) => 
                        b.resource_id === selectedBayId && 
                        b.request_date === selectedRequest.request_date &&
                        b.start_time < reqEnd && b.end_time > reqStart
                    );
                    
                    if (conflict) {
                        hasConflict = true;
                        details = `Conflicts with existing booking: ${formatTime12Hour(conflict.start_time)} - ${formatTime12Hour(conflict.end_time)}`;
                    }
                }
                
                if (!hasConflict && closuresRes.ok) {
                    const allClosures = await closuresRes.json();
                    const reqDate = selectedRequest.request_date;
                    const reqStartMins = parseInt(selectedRequest.start_time.split(':')[0]) * 60 + parseInt(selectedRequest.start_time.split(':')[1]);
                    const reqEndMins = parseInt(selectedRequest.end_time.split(':')[0]) * 60 + parseInt(selectedRequest.end_time.split(':')[1]);
                    
                    const closure = allClosures.find((c: { startDate: string; endDate: string; affectedAreas: string; startTime?: string; endTime?: string; title: string }) => {
                        if (c.startDate > reqDate || c.endDate < reqDate) return false;
                        
                        const areas = c.affectedAreas;
                        const affectsResource = areas === 'entire_facility' || 
                            areas === 'all_bays' || 
                            areas.includes(String(selectedBayId));
                        
                        if (!affectsResource) return false;
                        
                        if (c.startTime && c.endTime) {
                            const closureStartMins = parseInt(c.startTime.split(':')[0]) * 60 + parseInt(c.startTime.split(':')[1]);
                            const closureEndMins = parseInt(c.endTime.split(':')[0]) * 60 + parseInt(c.endTime.split(':')[1]);
                            return reqStartMins < closureEndMins && reqEndMins > closureStartMins;
                        }
                        return true;
                    });
                    
                    if (closure) {
                        hasConflict = true;
                        details = `Conflicts with notice: ${closure.title}`;
                    }
                }
                
                setAvailabilityStatus(hasConflict ? 'conflict' : 'available');
                setConflictDetails(hasConflict ? details : null);
            } catch (err) {
                setAvailabilityStatus(null);
            }
        };
        
        checkAvailability();
    }, [selectedBayId, selectedRequest, actionModal]);

    useEffect(() => {
        if (actionModal === 'approve' && selectedRequest?.id) {
            const fetchFeeEstimate = async () => {
                setIsFetchingFeeEstimate(true);
                try {
                    const res = await fetch(`/api/booking-requests/${selectedRequest.id}/fee-estimate`, {
                        credentials: 'include'
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setFeeEstimate(data);
                    } else {
                        setFeeEstimate(null);
                    }
                } catch (err) {
                    console.error('Failed to fetch fee estimate:', err);
                    setFeeEstimate(null);
                } finally {
                    setIsFetchingFeeEstimate(false);
                }
            };
            fetchFeeEstimate();
        } else {
            setFeeEstimate(null);
        }
    }, [actionModal, selectedRequest?.id]);

    useEffect(() => {
        const fetchDeclineSlots = async (bookingDate: string, resourceId: number) => {
            try {
                const res = await fetch(`/api/bays/${resourceId}/availability?date=${bookingDate}`, {
                    credentials: 'include'
                });
                if (res.ok) {
                    const blocks = await res.json();
                    const available = blocks
                        .filter((b: { block_type?: string; start_time?: string }) => b.block_type === 'available' || !b.block_type)
                        .map((b: { block_type?: string; start_time?: string }) => b.start_time?.substring(0, 5))
                        .filter(Boolean);
                    setDeclineAvailableSlots(available);
                }
            } catch (err) {
                console.error('Failed to fetch available slots:', err);
                setDeclineAvailableSlots([]);
            }
        };

        if (actionModal === 'decline' && selectedRequest) {
            setSuggestedTime('');
            setDeclineAvailableSlots([]);
            if (selectedRequest.resource_id) {
                fetchDeclineSlots(selectedRequest.request_date, selectedRequest.resource_id);
            }
        }
    }, [actionModal, selectedRequest]);

    const pendingRequests = requests.filter(r => 
        r.status === 'pending' || 
        r.status === 'pending_approval'
    );
    
    const unmatchedWebhookBookings = approvedBookings.filter(b => {
        const email = (b.user_email || '').toLowerCase();
        const isPlaceholderEmail = !email || 
            email.includes('@trackman.local') ||
            email.includes('@visitors.evenhouse.club') ||
            email.startsWith('unmatched-') ||
            email.startsWith('golfnow-') ||
            email.startsWith('classpass-') ||
            email === 'unmatched@trackman.import';
        
        const isUnmatched = b.is_unmatched === true ||
            isPlaceholderEmail ||
            (b.user_name || '').includes('Unknown (Trackman)');
        
        const bookingDate = b.request_date || '';
        return isUnmatched && bookingDate >= today;
    });
    
    const cancellationPendingBookings = approvedBookings.filter(b => 
        b.status === 'cancellation_pending'
    );

    const queueItems = [
        ...cancellationPendingBookings.map(b => ({ ...b, queueType: 'cancellation' as const })),
        ...pendingRequests.map(r => ({ ...r, queueType: 'pending' as const })),
    ].sort((a, b) => {
        if (a.queueType === 'cancellation' && b.queueType !== 'cancellation') return -1;
        if (a.queueType !== 'cancellation' && b.queueType === 'cancellation') return 1;
        if (a.request_date !== b.request_date) {
            return a.request_date.localeCompare(b.request_date);
        }
        return a.start_time.localeCompare(b.start_time);
    });

    const scheduledBookings = useMemo(() => {
        const today = getTodayPacific();
        const tomorrow = (() => {
            const d = new Date(today);
            d.setDate(d.getDate() + 1);
            return d.toISOString().split('T')[0];
        })();
        const weekEnd = (() => {
            const d = new Date(today);
            d.setDate(d.getDate() + 7);
            return d.toISOString().split('T')[0];
        })();
        
        const bookingsToFilter = optimisticNewBooking 
            ? [...approvedBookings, optimisticNewBooking]
            : approvedBookings;
        
        return bookingsToFilter
            .filter(b => {
                const isScheduledStatus = b.status === 'approved' || b.status === 'confirmed';
                const isCheckedInToday = b.status === 'attended' && b.request_date === today;
                if (!(isScheduledStatus || isCheckedInToday) || b.request_date < today) return false;
                
                if (scheduledFilter === 'today') return b.request_date === today;
                if (scheduledFilter === 'tomorrow') return b.request_date === tomorrow;
                if (scheduledFilter === 'week') return b.request_date >= today && b.request_date <= weekEnd;
                return true;
            })
            .sort((a, b) => {
                if (a.request_date !== b.request_date) {
                    return a.request_date.localeCompare(b.request_date);
                }
                return a.start_time.localeCompare(b.start_time);
            });
    }, [approvedBookings, scheduledFilter, optimisticNewBooking]);

    const isBookingUnmatched = useCallback((booking: BookingRequest): boolean => {
        const email = (booking.user_email || '').toLowerCase();
        const isPlaceholderEmail = !email || 
            email.includes('@trackman.local') ||
            email.includes('@visitors.evenhouse.club') ||
            email.startsWith('unmatched-') ||
            email.startsWith('golfnow-') ||
            email.startsWith('classpass-') ||
            email === 'unmatched@trackman.import';
        
        return booking.is_unmatched === true ||
            isPlaceholderEmail ||
            (booking.user_name || '').includes('Unknown (Trackman)');
    }, []);

    const initiateApproval = () => {
        if (!selectedRequest) return;
        
        if (selectedRequest.source !== 'booking' && !selectedBayId) {
            setError('Please select a bay');
            return;
        }
        
        setShowTrackmanConfirm(true);
    };

    const handleApprove = async () => {
        if (!selectedRequest) return;
        
        const bookingKey = `${selectedRequest.source || 'request'}-${selectedRequest.id}`;
        setIsProcessing(true);
        setError(null);
        
        setActionInProgress(prev => ({ ...prev, [bookingKey]: 'approving' }));
        
        const previousRequests = queryClient.getQueryData(simulatorKeys.allRequests());
        
        queryClient.setQueryData(simulatorKeys.allRequests(), (old: BookingRequest[] | undefined) => 
            (old || []).map(r => 
                r.id === selectedRequest.id && r.source === selectedRequest.source 
                    ? { ...r, status: 'confirmed' } 
                    : r
            )
        );
        setShowTrackmanConfirm(false);
        setActionModal(null);
        const approvedRequest = selectedRequest;
        const approvedBayId = selectedBayId;
        const approvedStaffNotes = staffNotes;
        setSelectedRequest(null);
        setSelectedBayId(null);
        setStaffNotes('');
        
        try {
            let res;
            if (approvedRequest.source === 'booking') {
                res = await fetch(`/api/bookings/${approvedRequest.id}/approve`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' }
                });
            } else {
                res = await fetch(`/api/booking-requests/${approvedRequest.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: 'approved',
                        resource_id: approvedBayId,
                        staff_notes: approvedStaffNotes || null,
                        reviewed_by: user?.email
                    })
                });
            }
            
            if (!res.ok) {
                queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
                const errData = await res.json();
                setError(errData.message || errData.error || 'Failed to approve');
                showToast(errData.message || errData.error || 'Failed to approve', 'error');
            } else {
                showToast('Booking approved', 'success');
                window.dispatchEvent(new CustomEvent('booking-action-completed'));
                queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
                queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
            }
        } catch (err: unknown) {
            queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
            setError((err instanceof Error ? err.message : String(err)));
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to approve booking', 'error');
        } finally {
            setIsProcessing(false);
            setActionInProgress(prev => {
                const next = { ...prev };
                delete next[bookingKey];
                return next;
            });
        }
    };

    const handleDecline = async () => {
        if (!selectedRequest) return;
        
        const bookingKey = `${selectedRequest.source || 'request'}-${selectedRequest.id}`;
        setIsProcessing(true);
        setError(null);
        
        const newStatus = selectedRequest.status === 'approved' ? 'cancelled' : 'declined';
        const wasPending = selectedRequest.status === 'pending' || selectedRequest.status === 'pending_approval';
        
        setActionInProgress(prev => ({ ...prev, [bookingKey]: 'declining' }));
        
        const previousRequests = queryClient.getQueryData(simulatorKeys.allRequests());
        
        queryClient.setQueryData(simulatorKeys.allRequests(), (old: BookingRequest[] | undefined) => 
            (old || []).map(r => 
                r.id === selectedRequest.id && r.source === selectedRequest.source 
                    ? { ...r, status: newStatus } 
                    : r
            )
        );
        const declinedRequest = selectedRequest;
        const declinedStaffNotes = staffNotes;
        const declinedSuggestedTime = suggestedTime;
        setActionModal(null);
        setSelectedRequest(null);
        setStaffNotes('');
        setSuggestedTime('');
        
        try {
            let res;
            if (declinedRequest.source === 'booking') {
                res = await fetch(`/api/bookings/${declinedRequest.id}/decline`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include'
                });
            } else {
                res = await fetch(`/api/booking-requests/${declinedRequest.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        status: newStatus,
                        staff_notes: declinedStaffNotes || null,
                        suggested_time: declinedSuggestedTime ? declinedSuggestedTime + ':00' : null,
                        reviewed_by: actualUser?.email || user?.email,
                        cancelled_by: newStatus === 'cancelled' ? (actualUser?.email || user?.email) : undefined
                    })
                });
            }
            
            if (!res.ok) {
                queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
                const errData = await res.json();
                setError(errData.error || 'Failed to process request');
                showToast(errData.error || 'Failed to process request', 'error');
            } else {
                const statusLabel = newStatus === 'cancelled' ? 'cancelled' : 'declined';
                showToast(`Booking ${statusLabel}`, 'success');
                if (wasPending) {
                    window.dispatchEvent(new CustomEvent('booking-action-completed'));
                }
                queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
                queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
            }
        } catch (err: unknown) {
            queryClient.setQueryData(simulatorKeys.allRequests(), previousRequests);
            setError((err instanceof Error ? err.message : String(err)));
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to process request', 'error');
        } finally {
            setIsProcessing(false);
            setActionInProgress(prev => {
                const next = { ...prev };
                delete next[bookingKey];
                return next;
            });
        }
    };

    return (
            <AnimatedPage className="flex flex-col">
                <div className="w-full bg-white dark:bg-surface-dark rounded-2xl shadow-lg border border-gray-200 dark:border-white/25 flex flex-col">
                <div className="lg:hidden flex items-center justify-between border-b border-gray-200 dark:border-white/25 mb-0 animate-content-enter-delay-1 px-4 py-3">
                    <div className="flex">
                        <button
                            onClick={() => setActiveView('requests')}
                            className={`tactile-btn py-3 px-6 font-medium text-sm transition-all duration-fast relative ${
                                activeView === 'requests'
                                    ? 'text-primary dark:text-white'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                            }`}
                        >
                            Queue {queueItems.length > 0 && `(${queueItems.length})`}
                            {activeView === 'requests' && (
                                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary dark:bg-white" />
                            )}
                        </button>
                        <button
                            onClick={() => setActiveView('calendar')}
                            className={`tactile-btn py-3 px-6 font-medium text-sm transition-all duration-fast relative ${
                                activeView === 'calendar'
                                    ? 'text-primary dark:text-white'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                            }`}
                        >
                            Calendar
                            {activeView === 'calendar' && (
                                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary dark:bg-white" />
                            )}
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <GuideBookings />
                        <button
                            onClick={() => navigateToTab('trackman')}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary dark:text-white bg-primary/10 dark:bg-white/10 hover:bg-primary/20 dark:hover:bg-white/20 rounded-lg transition-colors shadow-sm"
                            title="Import bookings from Trackman CSV"
                        >
                            <span className="material-symbols-outlined text-sm">upload_file</span>
                            <span>Import</span>
                        </button>
                    </div>
                </div>

            {isLoading ? (
                <SimulatorTabSkeleton />
            ) : (
                <div className="flex flex-col lg:grid lg:grid-cols-[400px_1fr] xl:grid-cols-[450px_1fr] lg:items-start flex-1">
                    <BookingRequestsPanel
                        queueItems={queueItems}
                        pendingRequests={pendingRequests}
                        cancellationPendingBookings={cancellationPendingBookings}
                        scheduledBookings={scheduledBookings}
                        scheduledFilter={scheduledFilter}
                        setScheduledFilter={setScheduledFilter}
                        resources={resources}
                        memberNameMap={memberNameMap}
                        actionInProgress={actionInProgress}
                        navigateToTab={navigateToTab}
                        setBookingSheet={setBookingSheet}
                        setTrackmanModal={setTrackmanModal}
                        setSelectedRequest={setSelectedRequest}
                        setActionModal={setActionModal}
                        cancelBookingOptimistic={cancelBookingOptimistic}
                        updateBookingStatusOptimistic={updateBookingStatusOptimistic}
                        isBookingUnmatched={isBookingUnmatched}
                        handleRefresh={handleRefresh}
                        showToast={showToast}
                        confirm={confirm}
                        guestFeeDollars={guestFeeDollars}
                        overageRatePerBlockDollars={overageRatePerBlockDollars}
                        tierMinutes={tierMinutes}
                        optimisticNewBooking={optimisticNewBooking}
                        startDate={startDate}
                        endDate={endDate}
                        queryClient={queryClient}
                        simulatorKeys={simulatorKeys}
                        activeView={activeView}
                        queueMaxHeight={queueMaxHeight}
                        setActionInProgress={setActionInProgress}
                    />
                    
                    <CalendarGrid
                        resources={resources}
                        calendarDate={calendarDate}
                        setCalendarDate={setCalendarDate}
                        showDatePicker={showDatePicker}
                        setShowDatePicker={setShowDatePicker}
                        approvedBookings={approvedBookings}
                        pendingRequests={pendingRequests}
                        closures={closures}
                        availabilityBlocks={availabilityBlocks}
                        memberStatusMap={memberStatusMap}
                        memberNameMap={memberNameMap}
                        setBookingSheet={setBookingSheet}
                        setStaffManualBookingDefaults={setStaffManualBookingDefaults}
                        setStaffManualBookingModalOpen={setStaffManualBookingModalOpen}
                        setTrackmanModal={setTrackmanModal}
                        handleRefresh={handleRefresh}
                        isSyncing={isSyncing}
                        setIsSyncing={setIsSyncing}
                        lastRefresh={lastRefresh}
                        setLastRefresh={setLastRefresh}
                        isDark={isDark}
                        showToast={showToast}
                        calendarColRef={calendarColRef}
                        activeView={activeView}
                        guestFeeDollars={guestFeeDollars}
                        overageRatePerBlockDollars={overageRatePerBlockDollars}
                        tierMinutes={tierMinutes}
                    />
                </div>
            )}
            
            <ModalShell isOpen={!!actionModal && !!selectedRequest} onClose={() => { setActionModal(null); setSelectedRequest(null); setError(null); setShowTrackmanConfirm(false); }} title={actionModal === 'approve' ? 'Approve Request' : 'Decline Request'} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                        <p className="font-medium text-primary dark:text-white">{selectedRequest?.user_name || selectedRequest?.user_email}</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {selectedRequest && formatDateShortAdmin(selectedRequest.request_date)} • {selectedRequest && formatTime12Hour(selectedRequest.start_time)} - {selectedRequest && formatTime12Hour(selectedRequest.end_time)}
                        </p>
                        {selectedRequest?.declared_player_count && (
                            <div className="flex items-center gap-1 mt-2 text-sm text-accent">
                                <span className="material-symbols-outlined text-base">group</span>
                                <span>{selectedRequest?.declared_player_count} {selectedRequest?.declared_player_count === 1 ? 'player' : 'players'}</span>
                            </div>
                        )}
                    </div>
                    
                    {actionModal === 'approve' && (
                        <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-base">payments</span>
                                <p className="text-xs text-amber-700 dark:text-amber-300 font-medium uppercase tracking-wide">Fee Estimate</p>
                            </div>
                            {isFetchingFeeEstimate ? (
                                <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                                    Calculating fees...
                                </div>
                            ) : feeEstimate ? (
                                <div className="space-y-1.5">
                                    {feeEstimate.ownerTier && (
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-gray-600 dark:text-gray-400">Member tier</span>
                                            <span className="text-gray-700 dark:text-gray-300 font-medium">{feeEstimate.ownerTier}</span>
                                        </div>
                                    )}
                                    {feeEstimate.feeBreakdown.overageFee > 0 && (
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-gray-600 dark:text-gray-400">Overage ({feeEstimate.feeBreakdown.overageMinutes} min)</span>
                                            <span className="text-amber-700 dark:text-amber-300">${feeEstimate.feeBreakdown.overageFee}</span>
                                        </div>
                                    )}
                                    {feeEstimate.feeBreakdown.guestCount > 0 && (
                                        <>
                                            {feeEstimate.feeBreakdown.guestsUsingPasses > 0 && (
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="text-gray-600 dark:text-gray-400">{feeEstimate.feeBreakdown.guestsUsingPasses} guest{feeEstimate.feeBreakdown.guestsUsingPasses > 1 ? 's' : ''} (using pass)</span>
                                                    <span className="text-green-600 dark:text-green-400">$0</span>
                                                </div>
                                            )}
                                            {feeEstimate.feeBreakdown.guestsCharged > 0 && (
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="text-gray-600 dark:text-gray-400">{feeEstimate.feeBreakdown.guestsCharged} guest{feeEstimate.feeBreakdown.guestsCharged > 1 ? 's' : ''} @ ${feeEstimate.feeBreakdown.guestFeePerUnit || guestFeeDollars}</span>
                                                    <span className="text-amber-700 dark:text-amber-300">${feeEstimate.feeBreakdown.guestFees}</span>
                                                </div>
                                            )}
                                        </>
                                    )}
                                    {feeEstimate.feeBreakdown.guestPassesRemaining > 0 && (
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-gray-600 dark:text-gray-400">Guest passes remaining</span>
                                            <span className="text-gray-500 dark:text-gray-400">{feeEstimate.feeBreakdown.guestPassesRemaining}</span>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between pt-1.5 mt-1.5 border-t border-amber-200 dark:border-amber-500/30">
                                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Owner pays</span>
                                        <span className={`text-sm font-bold ${feeEstimate.totalFee > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-green-600 dark:text-green-400'}`}>
                                            {feeEstimate.totalFee > 0 ? `$${feeEstimate.totalFee}` : 'No fees'}
                                        </span>
                                    </div>
                                    <p className="text-[10px] text-gray-500 dark:text-gray-400 italic">{feeEstimate.note}</p>
                                </div>
                            ) : (
                                <p className="text-xs text-gray-500 dark:text-gray-400">Unable to calculate fees</p>
                            )}
                        </div>
                    )}
                    
                    {selectedRequest?.member_notes && (
                        <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
                            <p className="text-xs text-blue-600 dark:text-blue-400 mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-sm">chat</span>
                                Member Notes
                            </p>
                            <p className="text-sm text-primary dark:text-white">{selectedRequest?.member_notes}</p>
                        </div>
                    )}
                    
                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
                            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                        </div>
                    )}
                    
                    {actionModal === 'approve' && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Assign Resource *</label>
                            <select
                                value={selectedBayId || ''}
                                onChange={(e) => setSelectedBayId(Number(e.target.value))}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                            >
                                <option value="">Select a resource...</option>
                                {resources.map(resource => (
                                    <option key={resource.id} value={resource.id}>
                                        {resource.type === 'conference_room' ? 'Conference Room' : resource.name}
                                    </option>
                                ))}
                            </select>
                            
                            {selectedBayId && availabilityStatus && (
                                <div className={`mt-2 p-2 rounded-lg flex items-center gap-2 text-sm ${
                                    availabilityStatus === 'checking' 
                                        ? 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400'
                                        : availabilityStatus === 'available'
                                            ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400'
                                            : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400'
                                }`}>
                                    <span className={`material-symbols-outlined text-base ${availabilityStatus === 'checking' ? 'animate-spin' : ''}`}>
                                        {availabilityStatus === 'checking' ? 'progress_activity' : availabilityStatus === 'available' ? 'check_circle' : 'warning'}
                                    </span>
                                    <span>
                                        {availabilityStatus === 'checking' && 'Checking availability...'}
                                        {availabilityStatus === 'available' && 'This time slot is available'}
                                        {availabilityStatus === 'conflict' && (conflictDetails || 'Conflict detected')}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                    
                    {actionModal === 'decline' && selectedRequest?.status !== 'approved' && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Suggest Alternative Time (Optional)</label>
                            <select
                                value={suggestedTime || ''}
                                onChange={(e) => setSuggestedTime(e.target.value)}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
                            >
                                <option value="">Select alternative time...</option>
                                {declineAvailableSlots.map((time) => (
                                    <option key={time} value={time}>
                                        {formatTime12Hour(time)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Staff Notes (Optional)</label>
                        <textarea
                            value={staffNotes}
                            onChange={(e) => setStaffNotes(e.target.value)}
                            placeholder="Add a note for the member..."
                            rows={2}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white resize-none"
                        />
                    </div>
                    
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => { setActionModal(null); setSelectedRequest(null); setError(null); setShowTrackmanConfirm(false); }}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                            disabled={isProcessing}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={actionModal === 'approve' ? initiateApproval : handleDecline}
                            disabled={isProcessing || (actionModal === 'approve' && (!selectedBayId || availabilityStatus === 'conflict' || availabilityStatus === 'checking'))}
                            className={`flex-1 py-3 px-4 rounded-lg text-white font-medium flex items-center justify-center gap-2 ${
                                actionModal === 'approve' 
                                    ? 'bg-green-500 hover:bg-green-600' 
                                    : 'bg-red-500 hover:bg-red-600'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            {isProcessing ? (
                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            ) : (
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">
                                    {actionModal === 'approve' ? 'check' : 'close'}
                                </span>
                            )}
                            {actionModal === 'approve' ? 'Approve' : (selectedRequest?.status === 'approved' ? 'Cancel Booking' : 'Decline')}
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell isOpen={showTrackmanConfirm && !!selectedRequest} onClose={() => setShowTrackmanConfirm(false)} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center mx-auto mb-3">
                            <span aria-hidden="true" className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-2xl">sports_golf</span>
                        </div>
                        <h3 className="text-lg font-bold text-primary dark:text-white mb-2">Trackman Confirmation</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Have you created this booking in Trackman?
                        </p>
                    </div>
                    
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg text-sm">
                        <p className="font-medium text-primary dark:text-white">{selectedRequest?.user_name || selectedRequest?.user_email}</p>
                        <p className="text-gray-500 dark:text-gray-400">
                            {selectedRequest && formatDateShortAdmin(selectedRequest.request_date)} • {selectedRequest && formatTime12Hour(selectedRequest.start_time)} - {selectedRequest && formatTime12Hour(selectedRequest.end_time)}
                        </p>
                        {selectedBayId && (
                            <p className="text-gray-500 dark:text-gray-400">
                                {resources.find(r => r.id === selectedBayId)?.name || `Bay ${selectedBayId}`}
                            </p>
                        )}
                    </div>

                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
                            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                        </div>
                    )}
                    
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => setShowTrackmanConfirm(false)}
                            className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                            disabled={isProcessing}
                        >
                            Go Back
                        </button>
                        <button
                            onClick={handleApprove}
                            disabled={isProcessing}
                            className="flex-1 py-3 px-4 rounded-lg bg-green-500 hover:bg-green-600 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isProcessing ? (
                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            ) : (
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">check</span>
                            )}
                            Yes, Approve
                        </button>
                    </div>
                </div>
            </ModalShell>

            {showManualBooking && (
                <ManualBookingModal 
                    resources={resources}
                    defaultResourceId={prefillResourceId || undefined}
                    defaultDate={prefillDate || undefined}
                    defaultStartTime={prefillStartTime || undefined}
                    onClose={() => { setShowManualBooking(false); setPrefillResourceId(null); setPrefillDate(null); setPrefillStartTime(null); }}
                    onSuccess={(booking) => {
                        setShowManualBooking(false);
                        setPrefillResourceId(null);
                        setPrefillDate(null);
                        setPrefillStartTime(null);
                        
                        if (booking) {
                            const newBooking: BookingRequest = {
                                id: booking.id,
                                user_email: booking.user_email,
                                user_name: booking.user_name,
                                resource_id: booking.resource_id,
                                bay_name: booking.bay_name,
                                resource_preference: null,
                                request_date: booking.request_date,
                                start_time: booking.start_time,
                                end_time: booking.end_time,
                                duration_minutes: booking.duration_minutes,
                                notes: booking.notes,
                                status: booking.status,
                                staff_notes: booking.staff_notes,
                                suggested_time: null,
                                created_at: new Date().toISOString(),
                                source: 'booking'
                            };
                            queryClient.invalidateQueries({ queryKey: simulatorKeys.approvedBookings(startDate, endDate) });
                        }
                        
                        window.dispatchEvent(new CustomEvent('booking-action-completed'));
                        setTimeout(() => handleRefresh(), 500);
                    }}
                />
            )}

            <ModalShell isOpen={!!markStatusModal.booking} onClose={() => setMarkStatusModal({ booking: null, confirmNoShow: false })} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-3">
                            <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-accent text-2xl">task_alt</span>
                        </div>
                        <h3 className="text-lg font-bold text-primary dark:text-white mb-2">
                            {markStatusModal.confirmNoShow ? 'Confirm No Show' : 'Mark Booking Status'}
                        </h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            {markStatusModal.confirmNoShow 
                                ? 'Are you sure you want to mark this booking as a no show?' 
                                : 'Did the member attend their booking?'}
                        </p>
                    </div>
                    
                    <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg text-sm">
                        <p className="font-medium text-primary dark:text-white">{markStatusModal.booking?.user_name || markStatusModal.booking?.user_email}</p>
                        <p className="text-gray-500 dark:text-gray-400">
                            {markStatusModal.booking && formatDateShortAdmin(markStatusModal.booking.request_date)} • {markStatusModal.booking && formatTime12Hour(markStatusModal.booking.start_time)} - {markStatusModal.booking && formatTime12Hour(markStatusModal.booking.end_time)}
                        </p>
                        {markStatusModal.booking?.bay_name && (
                            <p className="text-gray-500 dark:text-gray-400">
                                {markStatusModal.booking.bay_name}
                            </p>
                        )}
                    </div>
                    
                    {markStatusModal.confirmNoShow ? (
                        <div className="flex gap-3">
                            <button
                                onClick={() => setMarkStatusModal({ ...markStatusModal, confirmNoShow: false })}
                                className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
                            >
                                Go Back
                            </button>
                            <button
                                onClick={async () => {
                                    if (!markStatusModal.booking) return;
                                    const booking = markStatusModal.booking;
                                    setMarkStatusModal({ booking: null, confirmNoShow: false });
                                    await updateBookingStatusOptimistic(booking, 'no_show');
                                }}
                                className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">person_off</span>
                                Confirm No Show
                            </button>
                        </div>
                    ) : (
                        <div className="flex gap-3">
                            <button
                                onClick={async () => {
                                    if (!markStatusModal.booking) return;
                                    const booking = markStatusModal.booking;
                                    setMarkStatusModal({ booking: null, confirmNoShow: false });
                                    await updateBookingStatusOptimistic(booking, 'attended');
                                }}
                                className="flex-1 py-3 px-4 rounded-lg bg-green-500 hover:bg-green-600 text-white font-medium flex items-center justify-center gap-2"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">check_circle</span>
                                Attended
                            </button>
                            <button
                                onClick={() => setMarkStatusModal({ ...markStatusModal, confirmNoShow: true })}
                                className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">person_off</span>
                                No Show
                            </button>
                        </div>
                    )}
                    
                    <button
                        onClick={() => setMarkStatusModal({ booking: null, confirmNoShow: false })}
                        className="w-full py-2 px-4 rounded-lg text-gray-500 dark:text-gray-400 text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </ModalShell>


            <TrackmanBookingModal
              isOpen={trackmanModal.isOpen}
              onClose={() => setTrackmanModal({ isOpen: false, booking: null })}
              booking={trackmanModal.booking}
              onConfirm={handleTrackmanConfirm}
            />

            <StaffManualBookingModal
              isOpen={staffManualBookingModalOpen}
              onClose={() => {
                setStaffManualBookingModalOpen(false);
                setStaffManualBookingDefaults({});
              }}
              onSubmit={handleStaffManualBookingSubmit}
              defaultResourceId={staffManualBookingDefaults.resourceId}
              defaultStartTime={staffManualBookingDefaults.startTime}
              defaultDate={staffManualBookingDefaults.date}
              initialMode={staffManualBookingDefaults.initialMode}
            />

            <UnifiedBookingSheet
              isOpen={bookingSheet.isOpen}
              onClose={() => setBookingSheet({ isOpen: false, trackmanBookingId: null })}
              mode={bookingSheet.mode || 'assign'}
              trackmanBookingId={bookingSheet.trackmanBookingId}
              bayName={bookingSheet.bayName}
              bookingDate={bookingSheet.bookingDate}
              timeSlot={bookingSheet.timeSlot}
              matchedBookingId={bookingSheet.matchedBookingId}
              currentMemberName={bookingSheet.currentMemberName}
              currentMemberEmail={bookingSheet.currentMemberEmail}
              isRelink={bookingSheet.isRelink}
              importedName={bookingSheet.importedName}
              notes={bookingSheet.notes}
              bookingId={bookingSheet.bookingId || undefined}
              ownerName={bookingSheet.ownerName}
              ownerEmail={bookingSheet.ownerEmail}
              declaredPlayerCount={bookingSheet.declaredPlayerCount}
              onSuccess={(options) => {
                if (!options?.markedAsEvent) {
                  showToast(bookingSheet.isRelink ? 'Booking owner changed' : 'Trackman booking linked to member', 'success');
                }
                handleRefresh();
              }}
              onRosterUpdated={() => handleRefresh()}
              bookingStatus={bookingSheet.bookingStatus}
              bookingContext={bookingSheet.bookingContext}
              ownerMembershipStatus={bookingSheet.ownerMembershipStatus}
              onReschedule={(booking) => {
                setBookingSheet({ isOpen: false, trackmanBookingId: null });
                setRescheduleModal({ isOpen: true, booking });
              }}
              onCancelBooking={async (bookingId) => {
                const confirmed = await confirm({
                  title: 'Cancel Booking',
                  message: 'Are you sure you want to cancel this booking?',
                  confirmText: 'Cancel Booking',
                  variant: 'warning'
                });
                if (!confirmed) return;
                try {
                  const res = await fetch(`/api/booking-requests/${bookingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                      status: 'cancelled',
                      staff_notes: 'Cancelled from booking sheet',
                      cancelled_by: actualUser?.email || user?.email
                    })
                  });
                  if (!res.ok) {
                    const errData = await res.json();
                    throw new Error(errData.error || 'Failed to cancel booking');
                  }
                  showToast('Booking cancelled successfully', 'success');
                  setBookingSheet({ isOpen: false, trackmanBookingId: null });
                  handleRefresh();
                } catch (err: unknown) {
                  showToast((err instanceof Error ? err.message : String(err)) || 'Failed to cancel booking', 'error');
                }
              }}
              onCheckIn={async (bookingId) => {
                const result = await checkInWithToast(bookingId);
                if (result.success) {
                  handleRefresh();
                }
              }}
            />

            {rescheduleModal.isOpen && rescheduleModal.booking && (
              <RescheduleBookingModal
                isOpen={rescheduleModal.isOpen}
                onClose={() => setRescheduleModal({ isOpen: false, booking: null })}
                booking={rescheduleModal.booking}
                resources={resources}
                onSuccess={() => {
                  setRescheduleModal({ isOpen: false, booking: null });
                  handleRefresh();
                  window.dispatchEvent(new CustomEvent('booking-action-completed'));
                }}
              />
            )}

            <ModalShell 
              isOpen={cancelConfirmModal.isOpen} 
              onClose={() => !cancelConfirmModal.isCancelling && setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false })} 
              showCloseButton={!cancelConfirmModal.isCancelling}
            >
              <div className="p-6">
                {!cancelConfirmModal.showSuccess ? (
                  <>
                    <div className="flex items-center justify-center mb-4">
                      <div className={`w-16 h-16 rounded-full flex items-center justify-center ${cancelConfirmModal.hasTrackman ? 'bg-amber-100 dark:bg-amber-500/20' : 'bg-red-100 dark:bg-red-500/20'}`}>
                        <span className={`material-symbols-outlined text-3xl ${cancelConfirmModal.hasTrackman ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                          {cancelConfirmModal.hasTrackman ? 'warning' : 'event_busy'}
                        </span>
                      </div>
                    </div>
                    <h3 className="text-xl font-bold text-center text-primary dark:text-white mb-2">
                      Cancel Booking?
                    </h3>
                    <p className="text-sm text-center text-gray-600 dark:text-gray-300 mb-4">
                      Cancel booking for {cancelConfirmModal.booking?.user_name || cancelConfirmModal.booking?.user_email}?
                    </p>
                    
                    {cancelConfirmModal.hasTrackman && (
                      <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4 mb-4">
                        <div className="flex gap-3">
                          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-xl flex-shrink-0">info</span>
                          <div>
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                              This booking is linked to Trackman
                            </p>
                            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                              After cancelling here, you'll need to also cancel it in Trackman.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <div className="flex gap-3">
                      <button
                        onClick={() => setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false })}
                        disabled={cancelConfirmModal.isCancelling}
                        className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                      >
                        Keep Booking
                      </button>
                      <button
                        onClick={performCancellation}
                        disabled={cancelConfirmModal.isCancelling}
                        className="flex-1 py-3 px-4 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {cancelConfirmModal.isCancelling ? (
                          <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-sm">check</span>
                        )}
                        {cancelConfirmModal.isCancelling ? 'Cancelling...' : 'Yes, Cancel'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-center mb-4">
                      <div className="w-16 h-16 rounded-full flex items-center justify-center bg-green-100 dark:bg-green-500/20">
                        <span className="material-symbols-outlined text-3xl text-green-600 dark:text-green-400">check_circle</span>
                      </div>
                    </div>
                    <h3 className="text-xl font-bold text-center text-primary dark:text-white mb-2">
                      Booking Cancelled
                    </h3>
                    <p className="text-sm text-center text-gray-600 dark:text-gray-300 mb-4">
                      The booking has been cancelled in the app.
                    </p>
                    
                    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4 mb-4">
                      <div className="flex gap-3">
                        <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-xl flex-shrink-0">task_alt</span>
                        <div>
                          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                            Action Required: Cancel in Trackman
                          </p>
                          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                            Please also cancel this booking in the Trackman system to keep both systems in sync.
                          </p>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex gap-3">
                      <button
                        onClick={() => setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false })}
                        className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        Done
                      </button>
                      <button
                        onClick={() => {
                          window.open('https://booking.indoorgolf.io', '_blank');
                          setCancelConfirmModal({ isOpen: false, booking: null, hasTrackman: false, isCancelling: false, showSuccess: false });
                        }}
                        className="flex-1 py-3 px-4 rounded-lg bg-primary hover:bg-primary/90 text-white font-medium flex items-center justify-center gap-2"
                      >
                        <span className="material-symbols-outlined text-sm">open_in_new</span>
                        Open Trackman
                      </button>
                    </div>
                  </>
                )}
              </div>
            </ModalShell>
                </div>

                <FloatingActionButton
                  onClick={() => setStaffManualBookingModalOpen(true)}
                  icon="add"
                  color="brand"
                  label="Create Booking for Member"
                />
                <ConfirmDialogComponent />
            </AnimatedPage>
    );
};

export default SimulatorTab;

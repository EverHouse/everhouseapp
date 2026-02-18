import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../contexts/DataContext';
import { AnnouncementFormDrawer } from '../admin/AnnouncementFormDrawer';
import { NoticeFormDrawer } from '../admin/NoticeFormDrawer';
import { EventFormDrawer } from '../admin/EventFormDrawer';
import { WellnessFormDrawer } from '../admin/WellnessFormDrawer';
import { useBottomNav } from '../../contexts/BottomNavContext';
import { useIsMobile } from '../../hooks/useBreakpoint';
import PullToRefresh from '../PullToRefresh';
import { useToast } from '../Toast';
import { getTodayPacific, formatTime12Hour } from '../../utils/dateUtils';
import { StaffCommandCenterSkeleton } from '../skeletons';
import { AnimatedPage } from '../motion';
import { useStaffWebSocketContext } from '../../contexts/StaffWebSocketContext';
import { useBookingActions } from '../../hooks/useBookingActions';
import { playSound } from '../../utils/sounds';

import { useCommandCenterData } from './hooks/useCommandCenterData';
import { formatLastSynced, formatTodayDate } from './helpers';
import { getLatestVersion } from '../../data/changelog';
import { BookingQueuesSection } from './sections/BookingQueuesSection';
import { TodayScheduleSection } from './sections/TodayScheduleSection';
import { ResourcesSection, NoticeBoardWidget } from './sections/ResourcesSection';
import { AlertsCard } from './sections/AlertsCard';
import { QuickActionsGrid } from './sections/QuickActionsGrid';
import { CheckinBillingModal } from './modals/CheckinBillingModal';
import QrScannerModal from './modals/QrScannerModal';
import CheckInConfirmationModal from './modals/CheckInConfirmationModal';
import { TrackmanBookingModal } from './modals/TrackmanBookingModal';
import { UnifiedBookingSheet } from './modals/UnifiedBookingSheet';
import { StaffManualBookingModal, type StaffManualBookingData } from './modals/StaffManualBookingModal';
import { NewUserDrawer } from './drawers/NewUserDrawer';
import type { SelectedMember } from '../shared/MemberSearchInput';
import { tabToPath } from '../../pages/Admin/layout/types';
import type { StaffCommandCenterProps, BookingRequest, RecentActivity, TabType } from './types';

interface OptimisticUpdateRef {
  bookingId: number | string;
  originalStatus: string;
  newStatus: string;
}

const StaffCommandCenter: React.FC<StaffCommandCenterProps> = ({ onTabChange: onTabChangeProp, isAdmin }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { isAtBottom } = useBottomNav();
  const isMobile = useIsMobile();
  const { actualUser, refreshMembers } = useData();
  const { isConnected: wsConnected } = useStaffWebSocketContext();
  const { checkInWithToast } = useBookingActions();
  
  const navigateToTab = useCallback((tab: TabType) => {
    if (tabToPath[tab as keyof typeof tabToPath]) {
      navigate(tabToPath[tab as keyof typeof tabToPath]);
    } else if (onTabChangeProp) {
      onTabChangeProp(tab);
    }
  }, [navigate, onTabChangeProp]);
  
  const { data, refresh, updatePendingRequests, updateBayStatuses, updateTodaysBookings, updateRecentActivity } = useCommandCenterData(actualUser?.email);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [billingModal, setBillingModal] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const [newUserDrawerOpen, setNewUserDrawerOpen] = useState(false);
  const [newUserDrawerMode, setNewUserDrawerMode] = useState<'member' | 'visitor'>('member');
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [manualBookingModalOpen, setManualBookingModalOpen] = useState(false);
  const [prefillHostMember, setPrefillHostMember] = useState<SelectedMember | null>(null);
  const [announcementDrawerOpen, setAnnouncementDrawerOpen] = useState(false);
  const [noticeDrawerOpen, setNoticeDrawerOpen] = useState(false);
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);
  const [wellnessDrawerOpen, setWellnessDrawerOpen] = useState(false);
  const [trackmanModal, setTrackmanModal] = useState<{ isOpen: boolean; booking: BookingRequest | null }>({ isOpen: false, booking: null });
  const [checkinConfirmation, setCheckinConfirmation] = useState<{
    isOpen: boolean;
    memberName: string;
    pinnedNotes: Array<{ content: string; createdBy: string }>;
    tier?: string | null;
    membershipStatus?: string | null;
  }>({ isOpen: false, memberName: '', pinnedNotes: [] });
  const [bookingSheet, setBookingSheet] = useState<{
    isOpen: boolean;
    trackmanBookingId: string | null;
    bayName?: string;
    bookingDate?: string;
    timeSlot?: string;
    matchedBookingId?: number;
    isRelink?: boolean;
    importedName?: string;
    notes?: string;
    originalEmail?: string;
    bookingId?: number | null;
    mode?: 'assign' | 'manage';
    ownerName?: string;
    ownerEmail?: string;
    declaredPlayerCount?: number;
  }>({ isOpen: false, trackmanBookingId: null });
  
  const optimisticUpdateRef = useRef<OptimisticUpdateRef | null>(null);

  useEffect(() => {
    const handleBookingAutoConfirmed = (event: CustomEvent) => {
      const detail = event.detail;
      const memberName = detail?.data?.memberName || 'Member';
      const date = detail?.data?.date || '';
      const time = detail?.data?.time || '';
      const bay = detail?.data?.bay || '';
      
      const timeFormatted = time ? formatTime12Hour(time) : '';
      const message = `Booking confirmed: ${memberName} for ${date}${timeFormatted ? ` at ${timeFormatted}` : ''}${bay ? ` (${bay})` : ''}`;
      
      showToast(message, 'success', 5000);
      refresh();
    };

    window.addEventListener('booking-auto-confirmed', handleBookingAutoConfirmed as EventListener);
    return () => {
      window.removeEventListener('booking-auto-confirmed', handleBookingAutoConfirmed as EventListener);
    };
  }, [showToast, refresh]);

  const handleScanSuccess = async (decodedText: string) => {
    setQrScannerOpen(false);

    const memberMatch = decodedText.match(/^MEMBER:(.+)$/);
    if (memberMatch) {
      const memberId = memberMatch[1];
      try {
        showToast('Processing check-in...', 'info');
        const response = await fetch('/api/staff/qr-checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ memberId })
        });
        const result = await response.json();
        if (response.ok && result.success) {
          setCheckinConfirmation({
            isOpen: true,
            memberName: result.memberName,
            pinnedNotes: result.pinnedNotes || [],
            tier: result.tier,
            membershipStatus: result.membershipStatus
          });
        } else if (result.alreadyCheckedIn) {
          playSound('tap');
          showToast('This member was already checked in just now', 'info');
        } else {
          playSound('checkinWarning');
          showToast(result.error || 'Check-in failed', 'error');
        }
      } catch (err) {
        playSound('checkinWarning');
        showToast('Failed to process check-in', 'error');
      }
      return;
    }

    try {
      const scanData = JSON.parse(decodedText);
      if (scanData.bookingId) {
        const booking = data.todaysBookings.find(b => b.id === scanData.bookingId);
        if (booking) {
          handleCheckIn(booking);
          showToast(`Checking in ${booking.user_name}...`, 'info');
        } else {
          playSound('checkinWarning');
          showToast('Booking not found for today.', 'error');
        }
      } else {
        playSound('checkinWarning');
        showToast('Invalid QR code format.', 'error');
      }
    } catch (error) {
      playSound('checkinWarning');
      showToast('Invalid QR code.', 'error');
    }
  };
  
  const safeRevertOptimisticUpdate = useCallback((
    bookingId: number | string,
    expectedOptimisticStatus: string,
    activityIdToRemove?: string
  ) => {
    const ref = optimisticUpdateRef.current;
    if (!ref || ref.bookingId !== bookingId) {
      return;
    }
    
    updateTodaysBookings(prev => prev.map(b => {
      if (b.id === bookingId && b.status === expectedOptimisticStatus) {
        return { ...b, status: ref.originalStatus };
      }
      return b;
    }));
    
    updateBayStatuses(prev => prev.map(bay => {
      if (bay.currentBooking?.id === bookingId && bay.currentBooking?.status === expectedOptimisticStatus) {
        return {
          ...bay,
          currentBooking: { ...bay.currentBooking, status: ref.originalStatus }
        };
      }
      return bay;
    }));
    
    if (activityIdToRemove) {
      updateRecentActivity(prev => prev.filter(a => a.id !== activityIdToRemove));
    }
    
    optimisticUpdateRef.current = null;
  }, [updateTodaysBookings, updateBayStatuses, updateRecentActivity]);

  const today = getTodayPacific();
  const pendingCount = data.pendingRequests.length;
  
  // Filter unmatched bookings - check is_unmatched flag OR null/placeholder emails
  const unmatchedBookings = data.todaysBookings.filter(b => {
    if (b.is_unmatched === true) return true;
    
    // Also consider booking unmatched if user_email is null/empty or a placeholder
    const email = (b.user_email || '').toLowerCase();
    if (!email) return true;
    if (email.includes('@trackman.local')) return true;
    if (email.includes('@visitors.evenhouse.club')) return true;
    if (email.startsWith('unmatched-')) return true;
    if (email.startsWith('golfnow-')) return true;
    if (email.startsWith('classpass-')) return true;
    
    return false;
  });

  const handleOpenTrackman = (booking?: BookingRequest) => {
    if (booking) {
      setTrackmanModal({ isOpen: true, booking });
    } else {
      window.open('https://portal.trackmangolf.com/facility/RmFjaWxpdHkKZGI4YWMyN2FhLTM2YWQtNDM4ZC04MjUzLWVmOWU5NzMwMjkxZg==', '_blank');
    }
  };

  const handleTrackmanConfirm = async (bookingId: number | string, trackmanBookingId: string) => {
    const apiId = typeof bookingId === 'string' ? parseInt(String(bookingId).replace('cal_', '')) : bookingId;
    const booking = data.pendingRequests.find(r => r.id === bookingId);
    
    const previousPendingRequests = [...data.pendingRequests];
    updatePendingRequests(prev => prev.filter(r => r.id !== bookingId));
    
    if (booking) {
      const newActivity: RecentActivity = {
        id: `approve-${apiId}-${Date.now()}`,
        type: 'booking_approved',
        timestamp: new Date().toISOString(),
        primary_text: booking.user_name || 'Member',
        secondary_text: booking.bay_name || 'Bay',
        icon: 'check_circle'
      };
      updateRecentActivity(prev => [newActivity, ...prev]);
    }

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
        refresh();
      } else {
        const error = await res.json().catch(() => ({}));
        updatePendingRequests(() => previousPendingRequests);
        throw new Error(error.error || 'Failed to confirm booking');
      }
    } catch (err: unknown) {
      updatePendingRequests(() => previousPendingRequests);
      throw err;
    }
  };

  const handleApprove = async (request: BookingRequest) => {
    const apiId = typeof request.id === 'string' ? parseInt(String(request.id).replace('cal_', '')) : request.id;
    setActionInProgress(`approve-${request.id}`);
    
    const previousPendingRequests = [...data.pendingRequests];
    
    updatePendingRequests(prev => prev.filter(r => r.id !== request.id));
    
    const newActivity: RecentActivity = {
      id: `approve-${apiId}-${Date.now()}`,
      type: 'booking_approved',
      timestamp: new Date().toISOString(),
      primary_text: request.user_name || 'Member',
      secondary_text: request.bay_name || 'Bay',
      icon: 'check_circle'
    };
    updateRecentActivity(prev => [newActivity, ...prev]);
    
    try {
      const res = await fetch(`/api/booking-requests/${apiId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'approved' })
      });
      if (res.ok) {
        showToast('Booking approved', 'success');
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
        refresh();
      } else {
        updatePendingRequests(() => previousPendingRequests);
        updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
        showToast('Failed to approve booking', 'error');
      }
    } catch (err) {
      updatePendingRequests(() => previousPendingRequests);
      updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
      showToast('Failed to approve booking', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDeny = async (request: BookingRequest) => {
    const apiId = typeof request.id === 'string' ? parseInt(String(request.id).replace('cal_', '')) : request.id;
    setActionInProgress(`deny-${request.id}`);
    
    const previousPendingRequests = [...data.pendingRequests];
    
    updatePendingRequests(prev => prev.filter(r => r.id !== request.id));
    
    const newActivity: RecentActivity = {
      id: `deny-${apiId}-${Date.now()}`,
      type: 'booking_declined' as string,
      timestamp: new Date().toISOString(),
      primary_text: request.user_name || 'Member',
      secondary_text: request.bay_name || 'Bay',
      icon: 'cancel'
    };
    updateRecentActivity(prev => [newActivity, ...prev]);
    
    try {
      const res = await fetch(`/api/booking-requests/${apiId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'declined' })
      });
      if (res.ok) {
        showToast('Booking declined', 'success');
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
      } else {
        updatePendingRequests(() => previousPendingRequests);
        updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
        showToast('Failed to decline booking', 'error');
      }
    } catch (err) {
      updatePendingRequests(() => previousPendingRequests);
      updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
      showToast('Failed to decline booking', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCompleteCancellation = async (request: BookingRequest) => {
    const apiId = typeof request.id === 'string' ? parseInt(String(request.id).replace('cal_', '')) : request.id;
    setActionInProgress(`complete-cancel-${request.id}`);
    
    const previousPendingRequests = [...data.pendingRequests];
    updatePendingRequests(prev => prev.filter(r => r.id !== request.id));
    
    const newActivity: RecentActivity = {
      id: `cancel-${apiId}-${Date.now()}`,
      type: 'cancellation',
      timestamp: new Date().toISOString(),
      primary_text: request.user_name || 'Member',
      secondary_text: request.bay_name || 'Bay',
      icon: 'cancel'
    };
    updateRecentActivity(prev => [newActivity, ...prev]);
    
    try {
      const res = await fetch(`/api/booking-requests/${apiId}/complete-cancellation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (res.ok) {
        showToast('Cancellation completed', 'success');
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
        refresh();
      } else {
        const error = await res.json().catch(() => ({}));
        updatePendingRequests(() => previousPendingRequests);
        updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
        showToast(error.error || 'Failed to complete cancellation', 'error');
      }
    } catch (err) {
      updatePendingRequests(() => previousPendingRequests);
      updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
      showToast('Failed to complete cancellation', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCheckIn = async (booking: BookingRequest) => {
    const id = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
    setActionInProgress(`checkin-${id}`);
    
    const originalStatus = booking.status;
    const optimisticStatus = 'attended';
    
    optimisticUpdateRef.current = {
      bookingId: booking.id,
      originalStatus,
      newStatus: optimisticStatus
    };
    
    updateTodaysBookings(prev => prev.map(b => 
      b.id === booking.id ? { ...b, status: optimisticStatus } : b
    ));
    
    updateBayStatuses(prev => prev.map(bay => {
      if (bay.currentBooking?.id === booking.id) {
        return {
          ...bay,
          currentBooking: { ...bay.currentBooking, status: optimisticStatus }
        };
      }
      return bay;
    }));
    
    const newActivity: RecentActivity = {
      id: `checkin-${id}-${Date.now()}`,
      type: 'booking_checked_in' as string,
      timestamp: new Date().toISOString(),
      primary_text: booking.user_name || 'Member',
      secondary_text: booking.bay_name || 'Bay',
      icon: 'how_to_reg'
    };
    updateRecentActivity(prev => [newActivity, ...prev]);
    
    const result = await checkInWithToast(id);
    
    if (result.success) {
      optimisticUpdateRef.current = null;
    } else {
      optimisticUpdateRef.current = null;
      updateTodaysBookings(prev => prev.map(b => 
        b.id === booking.id ? { ...b, status: originalStatus } : b
      ));
      updateBayStatuses(prev => prev.map(bay => {
        if (bay.currentBooking?.id === booking.id) {
          return {
            ...bay,
            currentBooking: { ...bay.currentBooking, status: originalStatus }
          };
        }
        return bay;
      }));
      updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
      
      if (result.requiresRoster) {
        setBookingSheet({
          isOpen: true,
          trackmanBookingId: null,
          bookingId: id,
          mode: 'manage' as const,
        });
      } else if (result.requiresPayment) {
        setBillingModal({ isOpen: true, bookingId: id });
      }
    }
    
    setActionInProgress(null);
  };

  const handleBillingModalComplete = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleManualBookingSubmit = useCallback(async (bookingData: StaffManualBookingData) => {
    const response = await fetch('/api/staff/manual-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        hostMemberId: bookingData.hostMember.id,
        resourceId: bookingData.resourceId,
        requestDate: bookingData.requestDate,
        startTime: bookingData.startTime,
        durationMinutes: bookingData.durationMinutes,
        declaredPlayerCount: bookingData.declaredPlayerCount,
        participants: bookingData.participants,
        trackman_booking_id: bookingData.trackmanBookingId
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to create booking');
    }
    refresh();
  }, [refresh]);

  const handleRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  if (data.isLoading) {
    return <StaffCommandCenterSkeleton />;
  }

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <AnimatedPage className="pb-40">
        <div className="flex items-start justify-between mb-4 lg:mb-6 animate-content-enter-delay-1">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-primary dark:text-white">Welcome, {actualUser?.name?.split(' ')[0] || 'Staff'}</h1>
            <p className="text-xs lg:text-sm text-primary/60 dark:text-white/60">{formatTodayDate()}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-1 text-[10px] lg:text-xs ${wsConnected ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-white/30'}`} title={wsConnected ? 'Live updates active' : 'Connecting to live updates...'}>
                <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></span>
                <span className="hidden sm:inline">{wsConnected ? 'Live' : 'Connecting...'}</span>
              </div>
              <div className="flex items-center gap-1 text-[10px] lg:text-xs text-gray-500 dark:text-white/50">
                <span className="material-symbols-outlined text-xs lg:text-sm">sync</span>
                <span>{formatLastSynced(data.lastSynced)}</span>
              </div>
            </div>
            {pendingCount > 0 && (
              <button 
                onClick={() => navigateToTab('simulator')}
                className="tactile-btn flex lg:hidden items-center gap-1 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-[10px] font-medium"
              >
                <span className="material-symbols-outlined text-xs">pending_actions</span>
                {pendingCount} pending
              </button>
            )}
          </div>
        </div>

        {/* Desktop Queue Stats - below header */}
        {(pendingCount > 0 || unmatchedBookings.length > 0) && (
          <div className="hidden lg:flex items-center gap-4 mb-4 animate-content-enter-delay-1">
            {pendingCount > 0 && (
              <button 
                onClick={() => navigateToTab('simulator')}
                className="tactile-btn flex items-center gap-1.5 px-3 py-1.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">pending_actions</span>
                {pendingCount} pending request{pendingCount !== 1 ? 's' : ''}
              </button>
            )}
            {unmatchedBookings.length > 0 && (
              <button 
                onClick={() => navigateToTab('simulator')}
                className="tactile-btn flex items-center gap-1.5 px-3 py-1.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 rounded-full text-xs font-medium hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">link_off</span>
                {unmatchedBookings.length} need{unmatchedBookings.length !== 1 ? '' : 's'} assignment
              </button>
            )}
          </div>
        )}

        {/* Desktop Layout */}
        <div className="hidden lg:block space-y-6 animate-content-enter-delay-2">
          {/* Top row: Next Tour, Next Event, Facility Status */}
          <div className="grid grid-cols-3 gap-6">
            <TodayScheduleSection
              upcomingTours={data.upcomingTours}
              upcomingEvents={data.upcomingEvents}
              upcomingWellness={data.upcomingWellness}
              nextTour={data.nextTour}
              nextEvent={data.nextEvent}
              nextScheduleItem={data.nextScheduleItem}
              nextActivityItem={data.nextActivityItem}
              today={today}
              variant="desktop-top"
            />
            <ResourcesSection
              bayStatuses={data.bayStatuses}
              closures={data.closures}
              upcomingClosure={data.upcomingClosure}
              announcements={data.announcements}
              variant="desktop"
              recentActivity={data.recentActivity}
              notifications={data.notifications}
            />
          </div>

          {/* Row 1: Booking Requests, Upcoming Wellness, Alerts + Notice Board */}
          <div className="grid grid-cols-3 gap-6">
            <BookingQueuesSection
              pendingRequests={data.pendingRequests}
              todaysBookings={data.todaysBookings}
              unmatchedBookings={unmatchedBookings}
              today={today}
              actionInProgress={actionInProgress}
              onOpenTrackman={handleOpenTrackman}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCheckIn={handleCheckIn}
              onCompleteCancellation={handleCompleteCancellation}
              onPaymentClick={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
              onRosterClick={(bookingId) => setBookingSheet({ isOpen: true, trackmanBookingId: null, bookingId, mode: 'manage' as const })}
              onAssignMember={(booking) => setBookingSheet({
                isOpen: true,
                trackmanBookingId: booking.trackman_booking_id || null,
                bayName: booking.bay_name || `Bay ${booking.resource_id}`,
                bookingDate: booking.request_date || booking.slot_date,
                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                matchedBookingId: Number(booking.id),
                isRelink: false,
                importedName: booking.user_name || undefined,
                notes: booking.notes || undefined
              })}
              variant="desktop-top"
            />
            <TodayScheduleSection
              upcomingTours={data.upcomingTours}
              upcomingEvents={data.upcomingEvents}
              upcomingWellness={data.upcomingWellness}
              nextTour={data.nextTour}
              nextEvent={data.nextEvent}
              nextScheduleItem={data.nextScheduleItem}
              nextActivityItem={data.nextActivityItem}
              today={today}
              variant="desktop-wellness"
            />
            <NoticeBoardWidget
              closures={data.closures}
              upcomingClosure={data.upcomingClosure}
              announcements={data.announcements}
            />
          </div>

          {/* Row 2: Upcoming Bookings, Upcoming Events, Alerts */}
          <div className="grid grid-cols-3 gap-6">
            <BookingQueuesSection
              pendingRequests={data.pendingRequests}
              todaysBookings={data.todaysBookings}
              unmatchedBookings={unmatchedBookings}
              today={today}
              actionInProgress={actionInProgress}
              onOpenTrackman={handleOpenTrackman}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCheckIn={handleCheckIn}
              onCompleteCancellation={handleCompleteCancellation}
              onPaymentClick={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
              onRosterClick={(bookingId) => setBookingSheet({ isOpen: true, trackmanBookingId: null, bookingId, mode: 'manage' as const })}
              onAssignMember={(booking) => setBookingSheet({
                isOpen: true,
                trackmanBookingId: booking.trackman_booking_id || null,
                bayName: booking.bay_name || `Bay ${booking.resource_id}`,
                bookingDate: booking.request_date || booking.slot_date,
                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                matchedBookingId: Number(booking.id),
                isRelink: false,
                importedName: booking.user_name || undefined,
                notes: booking.notes || undefined
              })}
              variant="desktop-bottom"
            />
            <TodayScheduleSection
              upcomingTours={data.upcomingTours}
              upcomingEvents={data.upcomingEvents}
              upcomingWellness={data.upcomingWellness}
              nextTour={data.nextTour}
              nextEvent={data.nextEvent}
              nextScheduleItem={data.nextScheduleItem}
              nextActivityItem={data.nextActivityItem}
              today={today}
              variant="desktop-events"
            />
            <AlertsCard 
              notifications={data.notifications} 
              onAlertClick={() => {
                navigateToTab('updates');
                setTimeout(() => window.dispatchEvent(new CustomEvent('switch-to-alerts-tab')), 100);
              }}
            />
          </div>

        </div>

        {/* Mobile Layout - Order: Next Tour/Event → Notice Board → Alerts → Facility Status → Booking Requests → Upcoming Bookings → Upcoming Events → Upcoming Wellness */}
        <div className="lg:hidden space-y-4 animate-content-enter-delay-2">
          {/* Next Tour/Event cards */}
          <TodayScheduleSection
            upcomingTours={data.upcomingTours}
            upcomingEvents={data.upcomingEvents}
            upcomingWellness={data.upcomingWellness}
            nextTour={data.nextTour}
            nextEvent={data.nextEvent}
            nextScheduleItem={data.nextScheduleItem}
            nextActivityItem={data.nextActivityItem}
            today={today}
            variant="mobile-top"
          />
          {/* Internal Notice Board (first under widgets on mobile) */}
          <ResourcesSection
            bayStatuses={data.bayStatuses}
            closures={data.closures}
            upcomingClosure={data.upcomingClosure}
            announcements={data.announcements}
            variant="mobile-notice-only"
            recentActivity={data.recentActivity}
          />
          {/* Alerts Card (below Notice Board on mobile) */}
          <AlertsCard 
            notifications={data.notifications} 
            onAlertClick={() => {
              navigateToTab('updates');
              setTimeout(() => window.dispatchEvent(new CustomEvent('switch-to-alerts-tab')), 100);
            }}
          />
          {/* Facility Status (below Alerts on mobile) */}
          <ResourcesSection
            bayStatuses={data.bayStatuses}
            closures={data.closures}
            upcomingClosure={data.upcomingClosure}
            announcements={data.announcements}
            variant="mobile-facility-only"
            recentActivity={data.recentActivity}
          />
          {/* Booking Requests & Upcoming Bookings */}
          <BookingQueuesSection
            pendingRequests={data.pendingRequests}
            todaysBookings={data.todaysBookings}
            unmatchedBookings={unmatchedBookings}
            today={today}
            actionInProgress={actionInProgress}
            onOpenTrackman={handleOpenTrackman}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onCheckIn={handleCheckIn}
            onCompleteCancellation={handleCompleteCancellation}
            onPaymentClick={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
            onRosterClick={(bookingId) => setBookingSheet({ isOpen: true, trackmanBookingId: null, bookingId, mode: 'manage' as const })}
            onAssignMember={(booking) => setBookingSheet({
                isOpen: true,
                trackmanBookingId: booking.trackman_booking_id || null,
                bayName: booking.bay_name || `Bay ${booking.resource_id}`,
                bookingDate: booking.request_date || booking.slot_date,
                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                matchedBookingId: Number(booking.id),
                isRelink: false,
                importedName: booking.user_name || undefined,
                notes: booking.notes || undefined
              })}
            variant="mobile"
          />
          {/* Upcoming Events & Wellness */}
          <TodayScheduleSection
            upcomingTours={data.upcomingTours}
            upcomingEvents={data.upcomingEvents}
            upcomingWellness={data.upcomingWellness}
            nextTour={data.nextTour}
            nextEvent={data.nextEvent}
            nextScheduleItem={data.nextScheduleItem}
            nextActivityItem={data.nextActivityItem}
            today={today}
            variant="mobile-cards"
          />
          <QuickActionsGrid isAdmin={isAdmin} variant="mobile" onNewMember={() => setNewUserDrawerOpen(true)} onScanQr={() => setQrScannerOpen(true)} />
          
          <div className="mt-6 mb-8 text-center">
            <p className="text-primary/40 dark:text-white/40 text-[10px]">
              v{getLatestVersion().version} · Updated {new Date(getLatestVersion().date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        </div>
      </AnimatedPage>

      <QrScannerModal
        isOpen={qrScannerOpen}
        onClose={() => setQrScannerOpen(false)}
        onScanSuccess={handleScanSuccess}
      />

      <CheckInConfirmationModal
        isOpen={checkinConfirmation.isOpen}
        onClose={() => setCheckinConfirmation(prev => ({ ...prev, isOpen: false }))}
        memberName={checkinConfirmation.memberName}
        pinnedNotes={checkinConfirmation.pinnedNotes}
        tier={checkinConfirmation.tier}
        membershipStatus={checkinConfirmation.membershipStatus}
      />

      <TrackmanBookingModal
        isOpen={trackmanModal.isOpen}
        onClose={() => setTrackmanModal({ isOpen: false, booking: null })}
        booking={trackmanModal.booking}
        onConfirm={handleTrackmanConfirm}
      />

      <UnifiedBookingSheet
        isOpen={bookingSheet.isOpen}
        onClose={() => setBookingSheet({ isOpen: false, trackmanBookingId: null })}
        trackmanBookingId={bookingSheet.trackmanBookingId}
        bayName={bookingSheet.bayName}
        bookingDate={bookingSheet.bookingDate}
        timeSlot={bookingSheet.timeSlot}
        matchedBookingId={bookingSheet.matchedBookingId}
        isRelink={bookingSheet.isRelink}
        importedName={bookingSheet.importedName}
        notes={bookingSheet.notes}
        originalEmail={bookingSheet.originalEmail}
        bookingId={bookingSheet.bookingId || undefined}
        mode={bookingSheet.mode || 'assign'}
        ownerName={bookingSheet.ownerName}
        ownerEmail={bookingSheet.ownerEmail}
        declaredPlayerCount={bookingSheet.declaredPlayerCount}
        onSuccess={(options) => {
          if (!options?.markedAsEvent) {
            showToast('Member assigned to booking', 'success');
          }
          window.dispatchEvent(new CustomEvent('booking-action-completed'));
          refresh();
        }}
        onRosterUpdated={() => refresh()}
        onOpenBillingModal={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
        onCollectPayment={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
      />

      {createPortal(
        <>
          {fabOpen && (
            <div 
              className="fixed inset-0 z-[9997]" 
              onClick={() => setFabOpen(false)}
              aria-hidden="true"
            />
          )}
          <div 
            className="fixed right-5 z-[9998] flex flex-col items-end gap-3" 
            style={{ 
              bottom: isMobile 
                ? (isAtBottom 
                    ? 'calc(24px + env(safe-area-inset-bottom, 0px))' 
                    : 'calc(140px + env(safe-area-inset-bottom, 0px))')
                : '24px',
              transition: 'bottom 0.3s ease-out'
            }}
          >
            {fabOpen && (
              <div className="flex flex-col items-end gap-2" role="menu">
                <button
                  onClick={() => { 
                    setFabOpen(false); 
                    setQrScannerOpen(true);
                  }}
                  className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-white/90 dark:bg-surface-dark/90 backdrop-blur-xl shadow-lg border border-gray-200 dark:border-white/20 transition-all duration-fast hover:scale-105 active:scale-95 animate-fab-item-6"
                  role="menuitem"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">QR Scanner</span>
                  <div className="w-10 h-10 rounded-full bg-primary dark:bg-white/90 flex items-center justify-center">
                    <span className="material-symbols-outlined text-xl text-white dark:text-primary">qr_code_scanner</span>
                  </div>
                </button>

                <button
                  onClick={() => { 
                    setFabOpen(false); 
                    setEventDrawerOpen(true);
                  }}
                  className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-white/90 dark:bg-surface-dark/90 backdrop-blur-xl shadow-lg border border-gray-200 dark:border-white/20 transition-all duration-fast hover:scale-105 active:scale-95 animate-fab-item-5"
                  role="menuitem"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">New Event</span>
                  <div className="w-10 h-10 rounded-full bg-indigo-500 flex items-center justify-center">
                    <span className="material-symbols-outlined text-xl text-white">celebration</span>
                  </div>
                </button>

                <button
                  onClick={() => { 
                    setFabOpen(false); 
                    setWellnessDrawerOpen(true);
                  }}
                  className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-white/90 dark:bg-surface-dark/90 backdrop-blur-xl shadow-lg border border-gray-200 dark:border-white/20 transition-all duration-fast hover:scale-105 active:scale-95 animate-fab-item-4"
                  role="menuitem"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">New Wellness</span>
                  <div className="w-10 h-10 rounded-full bg-teal-500 flex items-center justify-center">
                    <span className="material-symbols-outlined text-xl text-white">spa</span>
                  </div>
                </button>

                <button
                  onClick={() => { 
                    setFabOpen(false); 
                    setNoticeDrawerOpen(true);
                  }}
                  className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-white/90 dark:bg-surface-dark/90 backdrop-blur-xl shadow-lg border border-gray-200 dark:border-white/20 transition-all duration-fast hover:scale-105 active:scale-95 animate-fab-item-3"
                  role="menuitem"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">New Notice</span>
                  <div className="w-10 h-10 rounded-full bg-amber-500 flex items-center justify-center">
                    <span className="material-symbols-outlined text-xl text-white">notifications</span>
                  </div>
                </button>

                <button
                  onClick={() => { 
                    setFabOpen(false); 
                    setAnnouncementDrawerOpen(true);
                  }}
                  className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-white/90 dark:bg-surface-dark/90 backdrop-blur-xl shadow-lg border border-gray-200 dark:border-white/20 transition-all duration-fast hover:scale-105 active:scale-95 animate-fab-item-2"
                  role="menuitem"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">Announcement</span>
                  <div className="w-10 h-10 rounded-full bg-[#CCB8E4] flex items-center justify-center">
                    <span className="material-symbols-outlined text-xl text-[#293515]">campaign</span>
                  </div>
                </button>

                <button
                  onClick={() => { 
                    setFabOpen(false); 
                    setNewUserDrawerMode('member');
                    setNewUserDrawerOpen(true);
                  }}
                  className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-white/90 dark:bg-surface-dark/90 backdrop-blur-xl shadow-lg border border-gray-200 dark:border-white/20 transition-all duration-fast hover:scale-105 active:scale-95 animate-fab-item-1"
                  role="menuitem"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">New User</span>
                  <div className="w-10 h-10 rounded-full bg-green-600 flex items-center justify-center">
                    <span className="material-symbols-outlined text-xl text-white">person_add</span>
                  </div>
                </button>
              </div>
            )}

            <button
              onClick={() => setFabOpen(!fabOpen)}
              aria-label={fabOpen ? 'Close quick actions menu' : 'Open quick actions menu'}
              aria-expanded={fabOpen}
              aria-haspopup="menu"
              className={`w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-normal hover:scale-110 active:scale-95 ${
                fabOpen 
                  ? 'bg-red-500/80 text-white backdrop-blur-xl rotate-45' 
                  : 'bg-primary/50 dark:bg-white/50 text-white dark:text-primary backdrop-blur-xl'
              } border border-white/30`}
              title="Quick Actions"
            >
              <span className="material-symbols-outlined text-2xl" aria-hidden="true">add</span>
            </button>
          </div>
        </>,
        document.body
      )}
      
      <CheckinBillingModal
        isOpen={billingModal.isOpen}
        onClose={() => setBillingModal({ isOpen: false, bookingId: null })}
        bookingId={billingModal.bookingId || 0}
        onCheckinComplete={handleBillingModalComplete}
      />
      
      
      <NewUserDrawer
        isOpen={newUserDrawerOpen}
        onClose={() => {
          setNewUserDrawerOpen(false);
          setPrefillHostMember(null);
        }}
        onSuccess={(userData) => {
          refresh();
          refreshMembers();
          showToast(`${userData.mode === 'member' ? 'Member' : 'Visitor'} ${userData.name} created successfully`, 'success');
        }}
        onBookNow={(visitorData) => {
          setPrefillHostMember({
            id: visitorData.id,
            email: visitorData.email,
            name: visitorData.name,
            tier: null,
            membershipStatus: 'visitor'
          });
          setManualBookingModalOpen(true);
        }}
        defaultMode={newUserDrawerMode}
      />

      <StaffManualBookingModal
        isOpen={manualBookingModalOpen}
        onClose={() => {
          setManualBookingModalOpen(false);
          setPrefillHostMember(null);
        }}
        onSubmit={handleManualBookingSubmit}
        defaultHostMember={prefillHostMember}
      />

      <AnnouncementFormDrawer
        isOpen={announcementDrawerOpen}
        onClose={() => setAnnouncementDrawerOpen(false)}
      />

      <NoticeFormDrawer
        isOpen={noticeDrawerOpen}
        onClose={() => setNoticeDrawerOpen(false)}
      />

      <EventFormDrawer
        isOpen={eventDrawerOpen}
        onClose={() => setEventDrawerOpen(false)}
        onSuccess={() => {
          refresh();
          window.dispatchEvent(new CustomEvent('refreshEventsData'));
        }}
      />

      <WellnessFormDrawer
        isOpen={wellnessDrawerOpen}
        onClose={() => setWellnessDrawerOpen(false)}
        onSuccess={() => {
          refresh();
          window.dispatchEvent(new CustomEvent('refreshWellnessData'));
        }}
      />
    </PullToRefresh>
  );
};

export default StaffCommandCenter;

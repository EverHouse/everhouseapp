import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../contexts/DataContext';
import { useBottomNav } from '../../contexts/BottomNavContext';
import { useIsMobile } from '../../hooks/useBreakpoint';
import PullToRefresh from '../PullToRefresh';
import { useToast } from '../Toast';
import { getTodayPacific, formatTime12Hour, formatDateShort } from '../../utils/dateUtils';
import { StaffCommandCenterSkeleton } from '../skeletons';
import { AnimatedPage } from '../motion';

import { useCommandCenterData } from './hooks/useCommandCenterData';
import { formatLastSynced, formatTodayDate } from './helpers';
import { getLatestVersion } from '../../data/changelog';
import { BookingQueuesSection } from './sections/BookingQueuesSection';
import { TodayScheduleSection } from './sections/TodayScheduleSection';
import { ResourcesSection, NoticeBoardWidget } from './sections/ResourcesSection';
import { AlertsCard } from './sections/AlertsCard';
import { QuickActionsGrid } from './sections/QuickActionsGrid';
import { CheckinBillingModal } from './modals/CheckinBillingModal';
import { CompleteRosterModal } from './modals/CompleteRosterModal';
import { AddMemberModal } from './modals/AddMemberModal';
import QrScannerModal from './modals/QrScannerModal';
import { TrackmanBookingModal } from './modals/TrackmanBookingModal';
import { TrackmanLinkModal } from './modals/TrackmanLinkModal';
import type { StaffCommandCenterProps, BookingRequest, RecentActivity } from './types';

interface OptimisticUpdateRef {
  bookingId: number | string;
  originalStatus: string;
  optimisticStatus: string;
  timestamp: number;
}

const StaffCommandCenter: React.FC<StaffCommandCenterProps> = ({ onTabChange, isAdmin, wsConnected = false }) => {
  const { showToast } = useToast();
  const { isAtBottom } = useBottomNav();
  const isMobile = useIsMobile();
  const { actualUser } = useData();
  
  const { data, refresh, updatePendingRequests, updateBayStatuses, updateTodaysBookings, updateRecentActivity } = useCommandCenterData(actualUser?.email);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [billingModal, setBillingModal] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const [rosterModal, setRosterModal] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [trackmanModal, setTrackmanModal] = useState<{ isOpen: boolean; booking: BookingRequest | null }>({ isOpen: false, booking: null });
  const [trackmanLinkModal, setTrackmanLinkModal] = useState<{
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

  const handleScanSuccess = (decodedText: string) => {
    try {
      const scanData = JSON.parse(decodedText);
      if (scanData.bookingId) {
        const booking = data.todaysBookings.find(b => b.id === scanData.bookingId);
        if (booking) {
          handleCheckIn(booking);
          showToast(`Checking in ${booking.user_name}...`, 'info');
        } else {
          showToast('Booking not found for today.', 'error');
        }
      } else {
        showToast('Invalid QR code format.', 'error');
      }
    } catch (error) {
      showToast('Invalid QR code.', 'error');
    }
    setQrScannerOpen(false);
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
  const unmatchedBookings = data.todaysBookings.filter(b => (b as any).is_unmatched === true);

  const handleOpenTrackman = (booking?: BookingRequest) => {
    if (booking) {
      setTrackmanModal({ isOpen: true, booking });
    } else {
      window.open('https://portal.trackmangolf.com/facility/RmFjaWxpdHkKZGI4YWMyN2FhLTM2YWQtNDM4ZC04MjUzLWVmOWU5NzMwMjkxZg==', '_blank');
    }
  };

  const handleTrackmanConfirm = async (bookingId: number | string, trackmanExternalId: string) => {
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
          trackman_external_id: trackmanExternalId
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
    } catch (err: any) {
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
      type: 'booking_declined',
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

  const handleCheckIn = async (booking: BookingRequest) => {
    const id = typeof booking.id === 'string' ? parseInt(String(booking.id).replace('cal_', '')) : booking.id;
    setActionInProgress(`checkin-${id}`);
    
    const originalStatus = booking.status;
    const optimisticStatus = 'attended';
    
    optimisticUpdateRef.current = {
      bookingId: booking.id,
      originalStatus,
      optimisticStatus,
      timestamp: Date.now()
    };
    
    updateTodaysBookings(prev => prev.map(b => 
      b.id === booking.id ? { ...b, status: optimisticStatus } : b
    ));
    updateBayStatuses(prev => prev.map(bay => {
      if (bay.currentBooking?.id === booking.id) {
        return {
          ...bay,
          currentBooking: bay.currentBooking ? { ...bay.currentBooking, status: optimisticStatus } : null
        };
      }
      return bay;
    }));
    
    const newActivity: RecentActivity = {
      id: `checkin-${id}-${Date.now()}`,
      type: 'check_in',
      timestamp: new Date().toISOString(),
      primary_text: booking.user_name || 'Member',
      secondary_text: booking.bay_name || 'Bay',
      icon: 'how_to_reg'
    };
    updateRecentActivity(prev => [newActivity, ...prev]);
    
    try {
      const res = await fetch(`/api/bookings/${id}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      
      if (res.ok) {
        optimisticUpdateRef.current = null;
        showToast('Member checked in', 'success');
      } else if (res.status === 402) {
        const errorData = await res.json();
        safeRevertOptimisticUpdate(booking.id, optimisticStatus, newActivity.id);
        
        if (errorData.requiresRoster) {
          // Open the Complete Roster modal directly instead of switching tabs
          setRosterModal({ isOpen: true, bookingId: id });
        } else {
          setBillingModal({ isOpen: true, bookingId: id });
        }
      } else {
        safeRevertOptimisticUpdate(booking.id, optimisticStatus, newActivity.id);
        showToast('Failed to check in', 'error');
      }
    } catch (err) {
      safeRevertOptimisticUpdate(booking.id, optimisticStatus, newActivity.id);
      showToast('Failed to check in', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleBillingModalComplete = useCallback(() => {
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
                onClick={() => onTabChange('simulator')}
                className="flex lg:hidden items-center gap-1 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-[10px] font-medium"
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
                onClick={() => onTabChange('simulator')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">pending_actions</span>
                {pendingCount} pending request{pendingCount !== 1 ? 's' : ''}
              </button>
            )}
            {unmatchedBookings.length > 0 && (
              <button 
                onClick={() => onTabChange('simulator')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 rounded-full text-xs font-medium hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-colors"
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
              onTabChange={onTabChange}
              variant="desktop-top"
            />
            <ResourcesSection
              bayStatuses={data.bayStatuses}
              closures={data.closures}
              upcomingClosure={data.upcomingClosure}
              announcements={data.announcements}
              onTabChange={onTabChange}
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
              onTabChange={onTabChange}
              onOpenTrackman={handleOpenTrackman}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCheckIn={handleCheckIn}
              onPaymentClick={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
              onRosterClick={(bookingId) => setRosterModal({ isOpen: true, bookingId })}
              onAssignMember={(booking) => setTrackmanLinkModal({
                isOpen: true,
                trackmanBookingId: booking.trackman_booking_id || null,
                bayName: booking.bay_name || `Bay ${booking.resource_id}`,
                bookingDate: formatDateShort(booking.request_date || booking.slot_date),
                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                matchedBookingId: Number(booking.id),
                isRelink: false,
                importedName: (booking as any).user_name || (booking as any).userName,
                notes: (booking as any).notes || (booking as any).note
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
              onTabChange={onTabChange}
              variant="desktop-wellness"
            />
            <NoticeBoardWidget
              closures={data.closures}
              upcomingClosure={data.upcomingClosure}
              announcements={data.announcements}
              onTabChange={onTabChange}
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
              onTabChange={onTabChange}
              onOpenTrackman={handleOpenTrackman}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCheckIn={handleCheckIn}
              onPaymentClick={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
              onRosterClick={(bookingId) => setRosterModal({ isOpen: true, bookingId })}
              onAssignMember={(booking) => setTrackmanLinkModal({
                isOpen: true,
                trackmanBookingId: booking.trackman_booking_id || null,
                bayName: booking.bay_name || `Bay ${booking.resource_id}`,
                bookingDate: formatDateShort(booking.request_date || booking.slot_date),
                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                matchedBookingId: Number(booking.id),
                isRelink: false,
                importedName: (booking as any).user_name || (booking as any).userName,
                notes: (booking as any).notes || (booking as any).note
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
              onTabChange={onTabChange}
              variant="desktop-events"
            />
            <AlertsCard 
              notifications={data.notifications} 
              onAlertClick={() => {
                onTabChange('updates');
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
            onTabChange={onTabChange}
            variant="mobile-top"
          />
          {/* Internal Notice Board (first under widgets on mobile) */}
          <ResourcesSection
            bayStatuses={data.bayStatuses}
            closures={data.closures}
            upcomingClosure={data.upcomingClosure}
            announcements={data.announcements}
            onTabChange={onTabChange}
            variant="mobile-notice-only"
            recentActivity={data.recentActivity}
          />
          {/* Alerts Card (below Notice Board on mobile) */}
          <AlertsCard 
            notifications={data.notifications} 
            onAlertClick={() => {
              onTabChange('updates');
              setTimeout(() => window.dispatchEvent(new CustomEvent('switch-to-alerts-tab')), 100);
            }}
          />
          {/* Facility Status (below Alerts on mobile) */}
          <ResourcesSection
            bayStatuses={data.bayStatuses}
            closures={data.closures}
            upcomingClosure={data.upcomingClosure}
            announcements={data.announcements}
            onTabChange={onTabChange}
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
            onTabChange={onTabChange}
            onOpenTrackman={handleOpenTrackman}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onCheckIn={handleCheckIn}
            onPaymentClick={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
            onRosterClick={(bookingId) => setRosterModal({ isOpen: true, bookingId })}
            onAssignMember={(booking) => setTrackmanLinkModal({
                isOpen: true,
                trackmanBookingId: booking.trackman_booking_id || null,
                bayName: booking.bay_name || `Bay ${booking.resource_id}`,
                bookingDate: formatDateShort(booking.request_date || booking.slot_date),
                timeSlot: `${formatTime12Hour(booking.start_time)} - ${formatTime12Hour(booking.end_time)}`,
                matchedBookingId: Number(booking.id),
                isRelink: false,
                importedName: (booking as any).user_name || (booking as any).userName,
                notes: (booking as any).notes || (booking as any).note
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
            onTabChange={onTabChange}
            variant="mobile-cards"
          />
          <QuickActionsGrid onTabChange={onTabChange} isAdmin={isAdmin} variant="mobile" onNewMember={() => setAddMemberModalOpen(true)} onScanQr={() => setQrScannerOpen(true)} />
          
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

      <TrackmanBookingModal
        isOpen={trackmanModal.isOpen}
        onClose={() => setTrackmanModal({ isOpen: false, booking: null })}
        booking={trackmanModal.booking}
        onConfirm={handleTrackmanConfirm}
      />

      <TrackmanLinkModal
        isOpen={trackmanLinkModal.isOpen}
        onClose={() => setTrackmanLinkModal({ isOpen: false, trackmanBookingId: null })}
        trackmanBookingId={trackmanLinkModal.trackmanBookingId}
        bayName={trackmanLinkModal.bayName}
        bookingDate={trackmanLinkModal.bookingDate}
        timeSlot={trackmanLinkModal.timeSlot}
        matchedBookingId={trackmanLinkModal.matchedBookingId}
        isRelink={trackmanLinkModal.isRelink}
        importedName={trackmanLinkModal.importedName}
        notes={trackmanLinkModal.notes}
        originalEmail={trackmanLinkModal.originalEmail}
        onSuccess={() => {
          showToast('Member assigned to booking', 'success');
          window.dispatchEvent(new CustomEvent('booking-action-completed'));
          refresh();
        }}
        onOpenBillingModal={(bookingId) => setBillingModal({ isOpen: true, bookingId })}
      />

      {createPortal(
        <div 
          className="fixed right-5 z-[9998]" 
          style={{ 
            bottom: isMobile 
              ? (isAtBottom 
                  ? 'calc(24px + env(safe-area-inset-bottom, 0px))' 
                  : 'calc(140px + env(safe-area-inset-bottom, 0px))')
              : '24px',
            transition: 'bottom 0.3s ease-out'
          }}
        >
          <div 
            role="menu" 
            aria-label="Quick actions"
            aria-hidden={!fabOpen}
            className={`absolute bottom-16 right-0 flex flex-col gap-3 transition-all duration-300 ${fabOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}
          >
            <button
              role="menuitem"
              tabIndex={fabOpen ? 0 : -1}
              onClick={() => { 
                setFabOpen(false); 
                setAddMemberModalOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-green-600/90 text-white rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden="true">person_add</span>
              <span className="text-sm font-medium">New User</span>
            </button>
            <button
              role="menuitem"
              tabIndex={fabOpen ? 0 : -1}
              onClick={() => { 
                setFabOpen(false); 
                onTabChange('updates');
                setTimeout(() => window.dispatchEvent(new CustomEvent('open-new-announcement')), 100);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-[#CCB8E4]/90 text-[#293515] rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden="true">campaign</span>
              <span className="text-sm font-medium">New Announcement</span>
            </button>
            <button
              role="menuitem"
              tabIndex={fabOpen ? 0 : -1}
              onClick={() => { 
                setFabOpen(false); 
                onTabChange('blocks');
                setTimeout(() => window.dispatchEvent(new CustomEvent('open-new-closure')), 100);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/90 text-white rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden="true">notifications</span>
              <span className="text-sm font-medium">New Notice</span>
            </button>
          </div>

          <button
            onClick={() => setFabOpen(!fabOpen)}
            aria-label={fabOpen ? 'Close quick actions menu' : 'Open quick actions menu'}
            aria-expanded={fabOpen}
            aria-haspopup="menu"
            className={`w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 ${
              fabOpen 
                ? 'bg-red-500/80 text-white backdrop-blur-xl rotate-45' 
                : 'bg-primary/50 dark:bg-white/50 text-white dark:text-primary backdrop-blur-xl'
            } border border-white/30`}
            title="Quick Actions: New User, Announcement, or Notice"
          >
            <span className="material-symbols-outlined text-2xl" aria-hidden="true">add</span>
          </button>
        </div>,
        document.body
      )}
      
      <CheckinBillingModal
        isOpen={billingModal.isOpen}
        onClose={() => setBillingModal({ isOpen: false, bookingId: null })}
        bookingId={billingModal.bookingId || 0}
        onCheckinComplete={handleBillingModalComplete}
      />
      
      <CompleteRosterModal
        isOpen={rosterModal.isOpen}
        onClose={() => setRosterModal({ isOpen: false, bookingId: null })}
        bookingId={rosterModal.bookingId || 0}
        onRosterComplete={handleBillingModalComplete}
        onBillingRequired={(id) => setBillingModal({ isOpen: true, bookingId: id })}
      />
      
      <AddMemberModal
        isOpen={addMemberModalOpen}
        onClose={() => setAddMemberModalOpen(false)}
        onSuccess={() => refresh()}
        onSelectExisting={(user) => {
          refresh();
        }}
      />
    </PullToRefresh>
  );
};

export default StaffCommandCenter;

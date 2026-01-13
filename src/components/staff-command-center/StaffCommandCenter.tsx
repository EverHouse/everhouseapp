import React, { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../contexts/DataContext';
import { useBottomNav } from '../../contexts/BottomNavContext';
import PullToRefresh from '../PullToRefresh';
import { useToast } from '../Toast';
import { getTodayPacific, formatTime12Hour } from '../../utils/dateUtils';

import { useCommandCenterData } from './hooks/useCommandCenterData';
import { formatLastSynced, formatTodayDate } from './helpers';
import { BookingQueuesSection } from './sections/BookingQueuesSection';
import { TodayScheduleSection } from './sections/TodayScheduleSection';
import { ResourcesSection, NoticeBoardWidget } from './sections/ResourcesSection';
import { AlertsCard } from './sections/AlertsCard';
import { QuickActionsGrid } from './sections/QuickActionsGrid';
import { OverduePaymentsSection } from './sections/OverduePaymentsSection';
import { CheckinBillingModal } from './modals/CheckinBillingModal';
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
  const { actualUser } = useData();
  
  const { data, refresh, updatePendingRequests, updateBayStatuses, updateTodaysBookings, updateRecentActivity } = useCommandCenterData(actualUser?.email);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [trackmanModal, setTrackmanModal] = useState<BookingRequest | null>(null);
  const [trackmanBookingIdInput, setTrackmanBookingIdInput] = useState('');
  const [billingModal, setBillingModal] = useState<{ isOpen: boolean; bookingId: number | null }>({ isOpen: false, bookingId: null });
  
  const optimisticUpdateRef = useRef<OptimisticUpdateRef | null>(null);
  
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

  const handleApprove = (request: BookingRequest) => {
    setTrackmanModal(request);
  };

  const confirmApprove = async () => {
    if (!trackmanModal) return;
    const request = trackmanModal;
    const apiId = typeof request.id === 'string' ? parseInt(String(request.id).replace('cal_', '')) : request.id;
    setActionInProgress(`approve-${request.id}`);
    try {
      const res = await fetch(`/api/booking-requests/${apiId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'approved', resource_id: request.resource_id, trackman_booking_id: trackmanBookingIdInput || undefined })
      });
      if (res.ok) {
        updatePendingRequests(prev => prev.filter(r => r.id !== request.id));
        showToast('Booking approved', 'success');
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
        refresh();
        setTrackmanModal(null);
        setTrackmanBookingIdInput('');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to approve', 'error');
      }
    } catch (err) {
      showToast('Failed to approve booking', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDeny = async (request: BookingRequest) => {
    const apiId = typeof request.id === 'string' ? parseInt(String(request.id).replace('cal_', '')) : request.id;
    setActionInProgress(`deny-${request.id}`);
    try {
      const res = await fetch(`/api/booking-requests/${apiId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'declined' })
      });
      if (res.ok) {
        updatePendingRequests(prev => prev.filter(r => r.id !== request.id));
        showToast('Booking declined', 'success');
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
      } else {
        showToast('Failed to decline booking', 'error');
      }
    } catch (err) {
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
          showToast(`${errorData.emptySlots} player slot${errorData.emptySlots > 1 ? 's' : ''} need to be filled before check-in`, 'error');
          onTabChange('simulator');
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('open-booking-details', { detail: { bookingId: id } }));
          }, 100);
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

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <div className="animate-pop-in pb-40">
        <div className="flex items-start justify-between mb-4 lg:mb-6">
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
                className="flex items-center gap-1 px-2 py-0.5 lg:py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-[10px] lg:text-xs font-medium"
              >
                <span className="material-symbols-outlined text-xs lg:text-sm">pending_actions</span>
                {pendingCount} pending
              </button>
            )}
          </div>
        </div>

        {/* Desktop Layout */}
        <div className="hidden lg:block space-y-6">
          {/* Top row: Next Tour, Next Event, Internal Notice Board */}
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
            <NoticeBoardWidget
              closures={data.closures}
              upcomingClosure={data.upcomingClosure}
              announcements={data.announcements}
              onTabChange={onTabChange}
            />
          </div>

          {/* Row 1: Booking Requests, Upcoming Wellness, Facility Status */}
          <div className="grid grid-cols-3 gap-6">
            <BookingQueuesSection
              pendingRequests={data.pendingRequests}
              todaysBookings={data.todaysBookings}
              today={today}
              actionInProgress={actionInProgress}
              onTabChange={onTabChange}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCheckIn={handleCheckIn}
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

          {/* Row 2: Upcoming Bookings, Upcoming Events, Recent Activity */}
          <div className="grid grid-cols-3 gap-6">
            <BookingQueuesSection
              pendingRequests={data.pendingRequests}
              todaysBookings={data.todaysBookings}
              today={today}
              actionInProgress={actionInProgress}
              onTabChange={onTabChange}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCheckIn={handleCheckIn}
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
            <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 flex flex-col">
              <h3 className="font-bold text-primary dark:text-white mb-4">Recent Activity</h3>
              {data.recentActivity.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-4">
                  <span className="material-symbols-outlined text-3xl text-primary/30 dark:text-white/30 mb-2">history</span>
                  <p className="text-sm text-primary/50 dark:text-white/50">No recent activity</p>
                </div>
              ) : (
                <div className="flex-1 space-y-2 overflow-y-auto min-h-0">
                  {data.recentActivity.slice(0, 8).map(activity => (
                    <div key={activity.id} className="flex items-start gap-3 p-2 rounded-lg bg-white/50 dark:bg-white/5">
                      <span className={`material-symbols-outlined text-lg ${
                        activity.type === 'check_in' ? 'text-green-600 dark:text-green-400' :
                        activity.type === 'booking_created' ? 'text-blue-600 dark:text-blue-400' :
                        activity.type === 'booking_approved' ? 'text-emerald-600 dark:text-emerald-400' :
                        activity.type === 'cancellation' ? 'text-red-600 dark:text-red-400' :
                        'text-primary/60 dark:text-white/60'
                      }`}>{activity.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-primary dark:text-white truncate">{activity.primary_text}</p>
                        <p className="text-xs text-primary/60 dark:text-white/60 truncate">{activity.secondary_text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Row 3: Overdue Payments */}
          <div className="grid grid-cols-3 gap-6">
            <OverduePaymentsSection variant="desktop" />
          </div>
        </div>

        {/* Mobile Layout - Order: Next Tour/Event → Notice Board → Alerts → Facility Status → Booking Requests → Upcoming Bookings → Upcoming Events → Upcoming Wellness */}
        <div className="lg:hidden space-y-4">
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
            today={today}
            actionInProgress={actionInProgress}
            onTabChange={onTabChange}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onCheckIn={handleCheckIn}
            variant="mobile"
          />
          {/* Overdue Payments */}
          <OverduePaymentsSection variant="mobile" />
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
          <QuickActionsGrid onTabChange={onTabChange} isAdmin={isAdmin} variant="mobile" />
        </div>
      </div>

      {createPortal(
        <div 
          className="fixed right-5 z-[9998]" 
          style={{ 
            bottom: isAtBottom 
              ? 'calc(24px + env(safe-area-inset-bottom, 0px))' 
              : 'calc(140px + env(safe-area-inset-bottom, 0px))',
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
                onTabChange('simulator');
                setTimeout(() => window.dispatchEvent(new CustomEvent('open-manual-booking')), 100);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-[#293515]/90 text-white rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden="true">sports_golf</span>
              <span className="text-sm font-medium">New Booking</span>
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
            title="Quick Actions: New Booking, Announcement, or Notice"
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
      
      {trackmanModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => { setTrackmanModal(null); setTrackmanBookingIdInput(''); }} />
          <div className="relative bg-white dark:bg-surface-dark rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center mx-auto mb-3">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-2xl">sports_golf</span>
              </div>
              <h3 className="text-lg font-bold text-primary dark:text-white mb-2">Trackman Confirmation</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Have you created this booking in Trackman?
              </p>
            </div>
            
            <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg text-sm">
              <p className="font-medium text-primary dark:text-white">{trackmanModal.user_name || trackmanModal.user_email}</p>
              <p className="text-gray-500 dark:text-gray-400">
                {trackmanModal.request_date} • {formatTime12Hour(trackmanModal.start_time)} - {formatTime12Hour(trackmanModal.end_time)}
              </p>
              {trackmanModal.bay_name && (
                <p className="text-gray-500 dark:text-gray-400">{trackmanModal.bay_name}</p>
              )}
            </div>
            
            <div>
              <label className="block text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">
                Trackman Booking ID <span className="text-gray-500 dark:text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={trackmanBookingIdInput}
                onChange={(e) => setTrackmanBookingIdInput(e.target.value)}
                placeholder="e.g., TM-12345"
                className="w-full p-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-primary dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Enter the ID from Trackman to link this booking for easier import matching
              </p>
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={() => { setTrackmanModal(null); setTrackmanBookingIdInput(''); }}
                className="flex-1 py-2 px-4 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmApprove}
                disabled={actionInProgress === `approve-${trackmanModal.id}`}
                className="flex-1 py-2 px-4 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {actionInProgress === `approve-${trackmanModal.id}` ? 'Approving...' : 'Yes, Approve'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </PullToRefresh>
  );
};

export default StaffCommandCenter;

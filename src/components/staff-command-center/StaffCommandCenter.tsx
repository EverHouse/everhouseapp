import React, { useState, useCallback } from 'react';
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
import type { StaffCommandCenterProps, BookingRequest, RecentActivity } from './types';

const StaffCommandCenter: React.FC<StaffCommandCenterProps> = ({ onTabChange, isAdmin, wsConnected = false }) => {
  const { showToast } = useToast();
  const { isAtBottom } = useBottomNav();
  const { actualUser } = useData();
  
  const { data, refresh, updatePendingRequests, updateBayStatuses, updateTodaysBookings, updateRecentActivity } = useCommandCenterData(actualUser?.email);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [trackmanModal, setTrackmanModal] = useState<BookingRequest | null>(null);

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
        body: JSON.stringify({ status: 'approved', resource_id: request.resource_id })
      });
      if (res.ok) {
        updatePendingRequests(prev => prev.filter(r => r.id !== request.id));
        showToast('Booking approved', 'success');
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
        refresh();
        setTrackmanModal(null);
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
    
    // Optimistic UI: immediately update todaysBookings and bayStatuses
    updateTodaysBookings(prev => prev.map(b => 
      b.id === booking.id ? { ...b, status: 'attended' } : b
    ));
    updateBayStatuses(prev => prev.map(bay => {
      if (bay.currentBooking?.id === booking.id) {
        return {
          ...bay,
          currentBooking: bay.currentBooking ? { ...bay.currentBooking, status: 'attended' } : null
        };
      }
      return bay;
    }));
    
    // Optimistic UI: add check-in activity to recent activity
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
        showToast('Member checked in', 'success');
      } else {
        // Revert optimistic update on failure
        updateTodaysBookings(prev => prev.map(b => 
          b.id === booking.id ? { ...b, status: booking.status } : b
        ));
        updateBayStatuses(prev => prev.map(bay => {
          if (bay.currentBooking?.id === booking.id) {
            return {
              ...bay,
              currentBooking: bay.currentBooking ? { ...bay.currentBooking, status: booking.status } : null
            };
          }
          return bay;
        }));
        updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
        showToast('Failed to check in', 'error');
      }
    } catch (err) {
      // Revert optimistic update on error
      updateTodaysBookings(prev => prev.map(b => 
        b.id === booking.id ? { ...b, status: booking.status } : b
      ));
      updateBayStatuses(prev => prev.map(bay => {
        if (bay.currentBooking?.id === booking.id) {
          return {
            ...bay,
            currentBooking: bay.currentBooking ? { ...bay.currentBooking, status: booking.status } : null
          };
        }
        return bay;
      }));
      updateRecentActivity(prev => prev.filter(a => a.id !== newActivity.id));
      showToast('Failed to check in', 'error');
    } finally {
      setActionInProgress(null);
    }
  };

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

          {/* Main content: 3 columns with 2 rows - equal height cards */}
          <div className="grid grid-cols-3 grid-rows-2 gap-6" style={{ gridTemplateRows: '1fr 1fr' }}>
            {/* Row 1: Booking Requests, Upcoming Wellness, Facility Status */}
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
            {/* Row 2: Upcoming Bookings, Upcoming Events, Employee Resources */}
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
            <QuickActionsGrid onTabChange={onTabChange} isAdmin={isAdmin} variant="desktop" />
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
          <div className={`absolute bottom-16 right-0 flex flex-col gap-3 transition-all duration-300 ${fabOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
            <button
              onClick={() => { 
                setFabOpen(false); 
                onTabChange('simulator');
                setTimeout(() => window.dispatchEvent(new CustomEvent('open-manual-booking')), 100);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-[#293515]/90 text-white rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg">sports_golf</span>
              <span className="text-sm font-medium">New Booking</span>
            </button>
            <button
              onClick={() => { 
                setFabOpen(false); 
                onTabChange('updates');
                setTimeout(() => window.dispatchEvent(new CustomEvent('open-new-announcement')), 100);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-[#CCB8E4]/90 text-[#293515] rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg">campaign</span>
              <span className="text-sm font-medium">New Announcement</span>
            </button>
            <button
              onClick={() => { 
                setFabOpen(false); 
                onTabChange('blocks');
                setTimeout(() => window.dispatchEvent(new CustomEvent('open-new-closure')), 100);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/90 text-white rounded-full shadow-lg whitespace-nowrap backdrop-blur-sm"
            >
              <span className="material-symbols-outlined text-lg">notifications</span>
              <span className="text-sm font-medium">New Notice</span>
            </button>
          </div>

          <button
            onClick={() => setFabOpen(!fabOpen)}
            className={`w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 ${
              fabOpen 
                ? 'bg-red-500/80 text-white backdrop-blur-xl rotate-45' 
                : 'bg-primary/50 dark:bg-white/50 text-white dark:text-primary backdrop-blur-xl'
            } border border-white/30`}
          >
            <span className="material-symbols-outlined text-2xl">add</span>
          </button>
        </div>,
        document.body
      )}
      
      {trackmanModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setTrackmanModal(null)} />
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
            
            <div className="flex gap-3">
              <button
                onClick={() => setTrackmanModal(null)}
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

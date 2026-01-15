import React from 'react';
import { useNavigate } from 'react-router-dom';
import EmptyState from '../../EmptyState';
import { formatTime12Hour, isFacilityOpen, formatDateDisplayWithDay } from '../../../utils/dateUtils';
import type { BayStatus, Closure, Announcement, TabType, RecentActivity, StaffNotification } from '../types';
import { AlertsCard } from './AlertsCard';

interface ResourcesSectionProps {
  bayStatuses: BayStatus[];
  closures: Closure[];
  upcomingClosure?: Closure | null;
  announcements: Announcement[];
  onTabChange: (tab: TabType) => void;
  variant: 'desktop' | 'mobile' | 'mobile-notice-only' | 'mobile-facility-only';
  recentActivity?: RecentActivity[];
  notifications?: StaffNotification[];
}

export const ResourcesSection: React.FC<ResourcesSectionProps> = ({
  bayStatuses,
  closures,
  upcomingClosure,
  announcements,
  onTabChange,
  variant,
  recentActivity = [],
  notifications = []
}) => {
  const navigate = useNavigate();

  const isBlocking = (areas: string | null | undefined): boolean => {
    return areas !== 'none' && areas !== '' && areas !== null && areas !== undefined;
  };

  const getNoticeTypeLabel = (closure: Closure) => {
    const blocking = isBlocking(closure.affectedAreas);
    if (blocking) {
      return 'Closure';
    }
    return closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? closure.noticeType : 'Notice';
  };

  const getSecondaryTag = (closure: Closure) => {
    const blocking = isBlocking(closure.affectedAreas);
    if (blocking && closure.noticeType && closure.noticeType.trim() && closure.noticeType.toLowerCase() !== 'closure') {
      return closure.noticeType;
    }
    const reason = closure.reason && closure.reason.trim() ? closure.reason : null;
    if (reason && reason.toLowerCase() === 'internal calendar event') {
      return null;
    }
    return reason;
  };

  const NoticeBoardCard = () => (
    <div className={`${variant === 'desktop' ? 'h-full' : ''} bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 ${variant === 'desktop' ? 'flex flex-col' : ''}`}>
      <div className="flex items-center justify-between mb-3 lg:mb-4">
        <h3 className="font-bold text-primary dark:text-white">Internal Notice Board</h3>
        <button onClick={() => onTabChange('blocks')} className="text-xs text-primary/60 dark:text-white/60 hover:underline">Manage</button>
      </div>
      {closures.length === 0 && announcements.length === 0 ? (
        upcomingClosure ? (
          <div className={`space-y-3 ${variant === 'desktop' ? 'flex-1' : ''}`}>
            <button 
              onClick={() => onTabChange('blocks')}
              className={`w-full text-left rounded-lg p-3 transition-colors ${
                isBlocking(upcomingClosure.affectedAreas)
                  ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                  : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  isBlocking(upcomingClosure.affectedAreas)
                    ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                    : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                }`}>
                  {getNoticeTypeLabel(upcomingClosure)}
                </span>
                {getSecondaryTag(upcomingClosure) && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    isBlocking(upcomingClosure.affectedAreas)
                      ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                      : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                  }`}>
                    {getSecondaryTag(upcomingClosure)}
                  </span>
                )}
              </div>
              <p className={`text-sm font-medium ${
                isBlocking(upcomingClosure.affectedAreas)
                  ? 'text-red-800 dark:text-red-200'
                  : 'text-amber-800 dark:text-amber-200'
              }`}>{upcomingClosure.title}</p>
              <p className={`text-xs mt-0.5 ${
                isBlocking(upcomingClosure.affectedAreas)
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}>
                {formatDateDisplayWithDay(upcomingClosure.startDate.split('T')[0])}
                {upcomingClosure.startTime && ` at ${formatTime12Hour(upcomingClosure.startTime)}`}
              </p>
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-4">
            <EmptyState icon="notifications_none" title="No active notices" variant="compact" />
          </div>
        )
      ) : (
        <div className={`space-y-3 ${variant === 'desktop' ? 'flex-1' : ''}`}>
          {closures.slice(0, 3).map(closure => {
            const blocking = isBlocking(closure.affectedAreas);
            return (
              <button 
                key={closure.id}
                onClick={() => onTabChange('blocks')}
                className={`w-full text-left rounded-lg p-3 transition-colors ${
                  blocking
                    ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                    : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                }`}
              >
                <div className="flex flex-wrap items-center gap-1.5 mb-1">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    blocking
                      ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                      : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                  }`}>
                    {getNoticeTypeLabel(closure)}
                  </span>
                  {getSecondaryTag(closure) && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      blocking
                        ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                        : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                    }`}>
                      {getSecondaryTag(closure)}
                    </span>
                  )}
                </div>
                <p className={`text-sm font-medium ${
                  blocking ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200'
                }`}>{closure.title}</p>
                <p className={`text-xs mt-0.5 ${
                  blocking ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                }`}>
                  {formatDateDisplayWithDay(closure.startDate.split('T')[0])}
                  {closure.startTime && ` at ${formatTime12Hour(closure.startTime)}`}
                </p>
              </button>
            );
          })}
          {announcements.slice(0, 3).map(announcement => (
            <button 
              key={announcement.id}
              onClick={() => onTabChange('announcements')}
              className="w-full text-left bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors"
            >
              <p className="text-sm font-medium text-purple-800 dark:text-purple-200">{announcement.title}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const FacilityStatusCard = () => (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3 lg:mb-4">
        <h3 className="font-bold text-primary dark:text-white">Facility Status</h3>
        <div className="flex items-center gap-3 text-xs text-primary/60 dark:text-white/60">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />Available</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />Booked</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />Closed</span>
        </div>
      </div>
      
      {bayStatuses.filter(b => b.type === 'conference_room').map(bay => {
        const facilityStatus = isFacilityOpen();
        const isClosed = bay.isClosed || !facilityStatus.isOpen;
        const dotColor = isClosed ? 'bg-red-500' : bay.isOccupied ? 'bg-amber-500' : 'bg-green-500';
        return (
          <button
            key={`conf-${variant}-${bay.id}`}
            onClick={() => navigate(`/admin?tab=simulator&resourceType=conference&bay=${bay.id}`)}
            className="w-full flex items-center gap-2 py-2 mb-2 border-b border-primary/5 dark:border-white/10 text-left hover:opacity-80 transition-opacity"
          >
            <span className={`w-2 h-2 rounded-full ${dotColor}`} />
            <div>
              <p className="text-sm font-medium text-primary dark:text-white">{bay.name}</p>
              {bay.currentBooking && !isClosed && (
                <p className="text-xs text-primary/60 dark:text-white/60">
                  {bay.currentBooking.userName} (until {formatTime12Hour(bay.currentBooking.endTime)})
                </p>
              )}
            </div>
          </button>
        );
      })}
      
      <div className="grid grid-cols-2 gap-3 mt-3">
        {bayStatuses.filter(b => b.type === 'simulator').map(bay => {
          const facilityStatus = isFacilityOpen();
          const isClosed = bay.isClosed || !facilityStatus.isOpen;
          const dotColor = isClosed ? 'bg-red-500' : bay.isOccupied ? 'bg-amber-500' : 'bg-green-500';
          return (
            <button
              key={`bay-${variant}-${bay.id}`}
              onClick={() => navigate(`/admin?tab=simulator&bay=${bay.id}`)}
              className={`p-3 rounded-xl border text-left hover:opacity-80 transition-opacity ${isClosed ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-white dark:bg-white/10 border-primary/5 dark:border-white/10'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                <p className="text-sm font-medium text-primary dark:text-white">{bay.name.replace(/^Simulator\s*/i, '')}</p>
              </div>
              {bay.currentBooking && !isClosed && (
                <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                  {bay.currentBooking.userName} (until {formatTime12Hour(bay.currentBooking.endTime)})
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (variant === 'mobile-notice-only') {
    return <NoticeBoardCard />;
  }

  if (variant === 'mobile-facility-only') {
    return <FacilityStatusCard />;
  }

  if (variant === 'mobile') {
    return (
      <>
        <NoticeBoardCard />
        <FacilityStatusCard />
      </>
    );
  }

  // Desktop variant - just Facility Status (Alerts rendered separately)
  return <FacilityStatusCard />;
};

export const NoticeBoardWidget: React.FC<{
  closures: Closure[];
  upcomingClosure?: Closure | null;
  announcements: Announcement[];
  onTabChange: (tab: TabType) => void;
}> = ({ closures, upcomingClosure, announcements, onTabChange }) => {
  const isBlocking = (areas: string | null | undefined): boolean => {
    return areas !== 'none' && areas !== '' && areas !== null && areas !== undefined;
  };

  const getNoticeTypeLabel = (closure: Closure) => {
    const blocking = isBlocking(closure.affectedAreas);
    if (blocking) {
      return 'Closure';
    }
    return closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? closure.noticeType : 'Notice';
  };

  const getSecondaryTag = (closure: Closure) => {
    const blocking = isBlocking(closure.affectedAreas);
    if (blocking && closure.noticeType && closure.noticeType.trim() && closure.noticeType.toLowerCase() !== 'closure') {
      return closure.noticeType;
    }
    const reason = closure.reason && closure.reason.trim() ? closure.reason : null;
    if (reason && reason.toLowerCase() === 'internal calendar event') {
      return null;
    }
    return reason;
  };

  return (
    <div className="h-full min-h-[140px] bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-primary dark:text-white">Internal Notice Board</h3>
        <button onClick={() => onTabChange('blocks')} className="text-xs text-primary/60 dark:text-white/60 hover:underline">Manage</button>
      </div>
      {closures.length === 0 && announcements.length === 0 ? (
        upcomingClosure ? (
          <div className="space-y-3 flex-1">
            <button 
              onClick={() => onTabChange('blocks')}
              className={`w-full text-left rounded-lg p-3 transition-colors ${
                isBlocking(upcomingClosure.affectedAreas)
                  ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                  : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  isBlocking(upcomingClosure.affectedAreas)
                    ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                    : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                }`}>
                  {getNoticeTypeLabel(upcomingClosure)}
                </span>
                {getSecondaryTag(upcomingClosure) && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    isBlocking(upcomingClosure.affectedAreas)
                      ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                      : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                  }`}>
                    {getSecondaryTag(upcomingClosure)}
                  </span>
                )}
              </div>
              <p className={`text-sm font-medium ${
                isBlocking(upcomingClosure.affectedAreas)
                  ? 'text-red-800 dark:text-red-200'
                  : 'text-amber-800 dark:text-amber-200'
              }`}>{upcomingClosure.title}</p>
              <p className={`text-xs mt-0.5 ${
                isBlocking(upcomingClosure.affectedAreas)
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}>
                {formatDateDisplayWithDay(upcomingClosure.startDate.split('T')[0])}
                {upcomingClosure.startTime && ` at ${formatTime12Hour(upcomingClosure.startTime)}`}
              </p>
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-4">
            <EmptyState icon="notifications_none" title="No active notices" variant="compact" />
          </div>
        )
      ) : (
        <div className="space-y-3 flex-1">
          {closures.slice(0, 3).map(closure => {
            const blocking = isBlocking(closure.affectedAreas);
            return (
              <button 
                key={closure.id} 
                onClick={() => onTabChange('blocks')}
                className={`w-full text-left rounded-lg p-3 transition-colors ${
                  blocking
                    ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                    : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                }`}
              >
                <div className="flex flex-wrap items-center gap-1.5 mb-1">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    blocking
                      ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                      : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                  }`}>
                    {getNoticeTypeLabel(closure)}
                  </span>
                  {getSecondaryTag(closure) && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      blocking
                        ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                        : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                    }`}>
                      {getSecondaryTag(closure)}
                    </span>
                  )}
                </div>
                <p className={`text-sm font-medium ${
                  blocking ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200'
                }`}>{closure.title}</p>
                <p className={`text-xs mt-0.5 ${
                  blocking ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                }`}>
                  {formatDateDisplayWithDay(closure.startDate.split('T')[0])}
                  {closure.startTime && ` at ${formatTime12Hour(closure.startTime)}`}
                </p>
              </button>
            );
          })}
          {announcements.slice(0, 3).map(announcement => (
            <button 
              key={announcement.id}
              onClick={() => onTabChange('announcements')}
              className="w-full text-left bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors"
            >
              <p className="text-sm font-medium text-purple-800 dark:text-purple-200">{announcement.title}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

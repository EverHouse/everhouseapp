import React, { useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import EmptyState from '../../EmptyState';
import { formatTime12Hour, isFacilityOpen, formatDateDisplayWithDay } from '../../../utils/dateUtils';
import { isBlockingClosure, getNoticeTypeLabel, getNoticeSecondaryTag } from '../../../utils/closureUtils';
import type { BayStatus, Closure, Announcement, TabType, RecentActivity, StaffNotification } from '../types';
import { tabToPath } from '../../../pages/Admin/layout/types';

interface NoticeBoardCardProps {
  variant: 'desktop' | 'mobile' | 'mobile-notice-only' | 'mobile-facility-only';
  closures: Closure[];
  announcements: Announcement[];
  upcomingClosure?: Closure | null;
  navigateToTab: (tab: TabType) => void;
}

const NoticeBoardCard = memo<NoticeBoardCardProps>(({
  variant,
  closures,
  announcements,
  upcomingClosure,
  navigateToTab
}) => (
  <div className={`${variant === 'desktop' ? 'h-full' : ''} bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-2xl pt-4 shadow-liquid dark:shadow-liquid-dark overflow-hidden ${variant === 'desktop' ? 'flex flex-col' : ''}`}>
    <div className="flex items-center justify-between mb-3 lg:mb-4 px-4">
      <h3 className="font-bold text-primary dark:text-white">Internal Notice Board</h3>
      <button onClick={() => navigateToTab('blocks')} className="text-xs text-primary/80 dark:text-white/80 hover:underline tactile-btn">Manage</button>
    </div>
    {closures.length === 0 && announcements.length === 0 ? (
      upcomingClosure ? (
        <div className={`space-y-3 px-4 pb-4 ${variant === 'desktop' ? 'flex-1' : ''}`}>
          <button 
            onClick={() => navigateToTab('blocks')}
            className={`w-full text-left rounded-lg p-3 transition-colors tactile-card ${
              isBlockingClosure(upcomingClosure.affectedAreas)
                ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
            }`}
          >
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                isBlockingClosure(upcomingClosure.affectedAreas)
                  ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                  : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
              }`}>
                {getNoticeTypeLabel(upcomingClosure)}
              </span>
              {getNoticeSecondaryTag(upcomingClosure) && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  isBlockingClosure(upcomingClosure.affectedAreas)
                    ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                    : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                }`}>
                  {getNoticeSecondaryTag(upcomingClosure)}
                </span>
              )}
            </div>
            <p className={`text-sm font-medium ${
              isBlockingClosure(upcomingClosure.affectedAreas)
                ? 'text-red-800 dark:text-red-200'
                : 'text-amber-800 dark:text-amber-200'
            }`}>{upcomingClosure.title}</p>
            <p className={`text-xs mt-0.5 ${
              isBlockingClosure(upcomingClosure.affectedAreas)
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
        {closures.slice(0, 3).map((closure, index) => {
          const blocking = isBlockingClosure(closure.affectedAreas);
          return (
            <button 
              key={closure.id}
              onClick={() => navigateToTab('blocks')}
              className={`w-full text-left rounded-lg p-3 transition-colors animate-slide-up-stagger tactile-card ${
                blocking
                  ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                  : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
              }`}
              style={{ '--stagger-index': index } as React.CSSProperties}
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  blocking
                    ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                    : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                }`}>
                  {getNoticeTypeLabel(closure)}
                </span>
                {getNoticeSecondaryTag(closure) && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    blocking
                      ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                      : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                  }`}>
                    {getNoticeSecondaryTag(closure)}
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
        {announcements.slice(0, 3).map((announcement, index) => (
          <button 
            key={announcement.id}
            onClick={() => navigateToTab('announcements')}
            className="w-full text-left bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors animate-slide-up-stagger tactile-card"
            style={{ '--stagger-index': index } as React.CSSProperties}
          >
            <p className="text-sm font-medium text-purple-800 dark:text-purple-200">{announcement.title}</p>
          </button>
        ))}
      </div>
    )}
  </div>
));

interface FacilityStatusCardProps {
  bayStatuses: BayStatus[];
  navigate: (path: string) => void;
  variant: 'desktop' | 'mobile' | 'mobile-notice-only' | 'mobile-facility-only';
}

const FacilityStatusCard = memo<FacilityStatusCardProps>(({
  bayStatuses,
  navigate,
  variant
}) => (
  <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-2xl p-4 shadow-liquid dark:shadow-liquid-dark">
    <div className="flex items-center justify-between mb-3 lg:mb-4">
      <h3 className="font-bold text-primary dark:text-white">Facility Status</h3>
      <div className="flex items-center gap-3 text-xs text-primary/80 dark:text-white/80">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />Available</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />Booked</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />Closed</span>
      </div>
    </div>
    
    {bayStatuses.filter(b => b.type === 'conference_room').map((bay, index) => {
      const facilityStatus = isFacilityOpen();
      const isClosed = bay.isClosed || !facilityStatus.isOpen;
      const dotColor = isClosed ? 'bg-red-500' : bay.isOccupied ? 'bg-amber-500' : 'bg-green-500';
      return (
        <button
          key={`conf-${variant}-${bay.id}`}
          onClick={() => navigate(`/admin/bookings?resourceType=conference&bay=${bay.id}`)}
          className="w-full flex items-center gap-2 py-2 mb-2 border-b border-primary/5 dark:border-white/10 text-left hover:opacity-80 transition-opacity animate-slide-up-stagger tactile-card"
          style={{ '--stagger-index': index } as React.CSSProperties}
        >
          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
          <div>
            <p className="text-sm font-medium text-primary dark:text-white">{bay.name}</p>
            {bay.currentBooking && !isClosed && (
              <p className="text-xs text-primary/80 dark:text-white/80">
                {bay.currentBooking.userName} (until {formatTime12Hour(bay.currentBooking.endTime)})
              </p>
            )}
          </div>
        </button>
      );
    })}
    
    <div className="grid grid-cols-2 gap-3 mt-3">
      {bayStatuses.filter(b => b.type === 'simulator').map((bay, index) => {
        const facilityStatus = isFacilityOpen();
        const isClosed = bay.isClosed || !facilityStatus.isOpen;
        const dotColor = isClosed ? 'bg-red-500' : bay.isOccupied ? 'bg-amber-500' : 'bg-green-500';
        return (
          <button
            key={`bay-${variant}-${bay.id}`}
            onClick={() => navigate(`/admin/bookings?bay=${bay.id}`)}
            className={`p-3 rounded-xl border text-left hover:opacity-80 transition-opacity animate-slide-up-stagger tactile-card ${isClosed ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-white dark:bg-white/10 border-primary/5 dark:border-white/10'}`}
            style={{ '--stagger-index': index } as React.CSSProperties}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${dotColor}`} />
              <p className="text-sm font-medium text-primary dark:text-white">{bay.name.replace(/^Simulator\s*/i, '')}</p>
            </div>
            {bay.currentBooking && !isClosed && (
              <p className="text-xs text-primary/80 dark:text-white/80 truncate">
                {bay.currentBooking.userName} (until {formatTime12Hour(bay.currentBooking.endTime)})
              </p>
            )}
          </button>
        );
      })}
    </div>
  </div>
));

interface ResourcesSectionProps {
  bayStatuses: BayStatus[];
  closures: Closure[];
  upcomingClosure?: Closure | null;
  announcements: Announcement[];
  variant: 'desktop' | 'mobile' | 'mobile-notice-only' | 'mobile-facility-only';
  recentActivity?: RecentActivity[];
  notifications?: StaffNotification[];
}

export const ResourcesSection: React.FC<ResourcesSectionProps> = ({
  bayStatuses,
  closures,
  upcomingClosure,
  announcements,
  variant,
  recentActivity = [],
  notifications = []
}) => {
  const navigate = useNavigate();
  const navigateToTab = useCallback((tab: TabType) => {
    if (tabToPath[tab]) navigate(tabToPath[tab]);
  }, [navigate]);

  if (variant === 'mobile-notice-only') {
    return (
      <NoticeBoardCard
        variant={variant}
        closures={closures}
        announcements={announcements}
        upcomingClosure={upcomingClosure}
        navigateToTab={navigateToTab}
      />
    );
  }

  if (variant === 'mobile-facility-only') {
    return (
      <FacilityStatusCard
        bayStatuses={bayStatuses}
        navigate={navigate}
        variant={variant}
      />
    );
  }

  if (variant === 'mobile') {
    return (
      <>
        <NoticeBoardCard
          variant={variant}
          closures={closures}
          announcements={announcements}
          upcomingClosure={upcomingClosure}
          navigateToTab={navigateToTab}
        />
        <FacilityStatusCard
          bayStatuses={bayStatuses}
          navigate={navigate}
          variant={variant}
        />
      </>
    );
  }

  return (
    <FacilityStatusCard
      bayStatuses={bayStatuses}
      navigate={navigate}
      variant={variant}
    />
  );
};

export const NoticeBoardWidget: React.FC<{
  closures: Closure[];
  upcomingClosure?: Closure | null;
  announcements: Announcement[];
}> = ({ closures, upcomingClosure, announcements }) => {
  const navigate = useNavigate();
  const navigateToTab = useCallback((tab: TabType) => {
    if (tabToPath[tab]) navigate(tabToPath[tab]);
  }, [navigate]);

  return (
    <div className="h-full min-h-[140px] bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-2xl p-4 shadow-liquid dark:shadow-liquid-dark flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-primary dark:text-white">Internal Notice Board</h3>
        <button onClick={() => navigateToTab('blocks')} className="text-xs text-primary/80 dark:text-white/80 hover:underline tactile-btn">Manage</button>
      </div>
      {closures.length === 0 && announcements.length === 0 ? (
        upcomingClosure ? (
          <div className="space-y-3 flex-1">
            <button 
              onClick={() => navigateToTab('blocks')}
              className={`w-full text-left rounded-lg p-3 transition-colors tactile-card ${
                isBlockingClosure(upcomingClosure.affectedAreas)
                  ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                  : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  isBlockingClosure(upcomingClosure.affectedAreas)
                    ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                    : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                }`}>
                  {getNoticeTypeLabel(upcomingClosure)}
                </span>
                {getNoticeSecondaryTag(upcomingClosure) && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    isBlockingClosure(upcomingClosure.affectedAreas)
                      ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                      : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                  }`}>
                    {getNoticeSecondaryTag(upcomingClosure)}
                  </span>
                )}
              </div>
              <p className={`text-sm font-medium ${
                isBlockingClosure(upcomingClosure.affectedAreas)
                  ? 'text-red-800 dark:text-red-200'
                  : 'text-amber-800 dark:text-amber-200'
              }`}>{upcomingClosure.title}</p>
              <p className={`text-xs mt-0.5 ${
                isBlockingClosure(upcomingClosure.affectedAreas)
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
          {closures.slice(0, 3).map((closure, index) => {
            const blocking = isBlockingClosure(closure.affectedAreas);
            return (
              <button 
                key={closure.id} 
                onClick={() => navigateToTab('blocks')}
                className={`w-full text-left rounded-lg p-3 transition-colors animate-slide-up-stagger tactile-card ${
                  blocking
                    ? 'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30'
                    : 'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                }`}
                style={{ '--stagger-index': index } as React.CSSProperties}
              >
                <div className="flex flex-wrap items-center gap-1.5 mb-1">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    blocking
                      ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                      : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                  }`}>
                    {getNoticeTypeLabel(closure)}
                  </span>
                  {getNoticeSecondaryTag(closure) && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      blocking
                        ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                        : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                    }`}>
                      {getNoticeSecondaryTag(closure)}
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
          {announcements.slice(0, 3).map((announcement, index) => (
            <button 
              key={announcement.id}
              onClick={() => navigateToTab('announcements')}
              className="w-full text-left bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors animate-slide-up-stagger tactile-card"
              style={{ '--stagger-index': index } as React.CSSProperties}
            >
              <p className="text-sm font-medium text-purple-800 dark:text-purple-200">{announcement.title}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

import React from 'react';
import ScheduleCard from '../../../components/ScheduleCard';
import { RosterManager } from '../../../components/booking';
import { downloadICalFile } from '../../../utils/icalUtils';
import { createPacificDate } from '../../../utils/dateUtils';
import { getStatusBadge as getStatusBadgeColor, formatStatusLabel } from '../../../utils/statusColors';
import { getIconForType, type ScheduleItem, type DashboardBookingItem, type DBBookingRequest, type DBBooking, type DBRSVP, type DBWellnessEnrollment } from './dashboardTypes';
import Icon from '../../../components/icons/Icon';

interface ScheduleSectionProps {
  isDark: boolean;
  upcomingItemsFiltered: ScheduleItem[];
  isStaffOrAdminProfile: boolean;
  walletPassAvailable: boolean;
  walletPassDownloading: number | null;
  rsvpSectionError: boolean | null | undefined;
  wellnessSectionError: boolean | null | undefined;
  startNavigation: () => void;
  navigate: (path: string) => void;
  refetchAllData: () => void;
  handleCancelBooking: (id: number, type: 'booking' | 'booking_request') => void;
  handleLeaveBooking: (id: number, name?: string | null) => void;
  handleCancelRSVP: (eventId: number) => void;
  handleCancelWellness: (classId: number) => void;
  handleDownloadBookingWalletPass: (id: number) => void;
  scheduleRef: React.Ref<HTMLDivElement>;
}

export const ScheduleSection: React.FC<ScheduleSectionProps> = ({
  isDark, upcomingItemsFiltered, isStaffOrAdminProfile, walletPassAvailable,
  walletPassDownloading, rsvpSectionError, wellnessSectionError,
  startNavigation, navigate, refetchAllData,
  handleCancelBooking, handleLeaveBooking, handleCancelRSVP, handleCancelWellness,
  handleDownloadBookingWalletPass, scheduleRef,
}) => {
  return (
    <div className="animate-content-enter-delay-4">
      <div className="flex justify-between items-center mb-4 px-1">
        <h3 className={`text-2xl leading-tight ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-headline)' }}>Your Schedule</h3>
        <button
          onClick={() => { startNavigation(); navigate('/book'); }}
          className={`tactile-btn text-xs font-semibold flex items-center gap-1 ${isDark ? 'text-accent' : 'text-brand-green'}`}
          aria-label="Book new"
        >
          <Icon name="add" className="text-base" />
          Book
        </button>
      </div>
      <div ref={scheduleRef} className="space-y-3">
        {upcomingItemsFiltered.length > 0 ? upcomingItemsFiltered.slice(0, 6).map((item, idx) => (
          <ScheduleItemRow
            key={item.id}
            item={item}
            idx={idx}
            isDark={isDark}
            isStaffOrAdminProfile={isStaffOrAdminProfile}
            walletPassAvailable={walletPassAvailable}
            walletPassDownloading={walletPassDownloading}
            refetchAllData={refetchAllData}
            handleCancelBooking={handleCancelBooking}
            handleLeaveBooking={handleLeaveBooking}
            handleCancelRSVP={handleCancelRSVP}
            handleCancelWellness={handleCancelWellness}
            handleDownloadBookingWalletPass={handleDownloadBookingWalletPass}
          />
        )) : (
          <EmptySchedule isDark={isDark} startNavigation={startNavigation} navigate={navigate} />
        )}
      </div>
      {rsvpSectionError && (
        <div className={`mt-3 p-3 rounded-xl text-xs flex items-center gap-2 ${isDark ? 'bg-red-500/10 border border-red-500/20 text-red-300' : 'bg-red-50 border border-red-200 text-red-600'}`}>
          <Icon name="error" className="text-sm" />
          Unable to load RSVPs. Other sections are up to date.
        </div>
      )}
      {wellnessSectionError && (
        <div className={`mt-3 p-3 rounded-xl text-xs flex items-center gap-2 ${isDark ? 'bg-red-500/10 border border-red-500/20 text-red-300' : 'bg-red-50 border border-red-200 text-red-600'}`}>
          <Icon name="error" className="text-sm" />
          Unable to load wellness classes. Other sections are up to date.
        </div>
      )}
    </div>
  );
};

interface ScheduleItemRowProps {
  item: ScheduleItem;
  idx: number;
  isDark: boolean;
  isStaffOrAdminProfile: boolean;
  walletPassAvailable: boolean;
  walletPassDownloading: number | null;
  refetchAllData: () => void;
  handleCancelBooking: (id: number, type: 'booking' | 'booking_request') => void;
  handleLeaveBooking: (id: number, name?: string | null) => void;
  handleCancelRSVP: (eventId: number) => void;
  handleCancelWellness: (classId: number) => void;
  handleDownloadBookingWalletPass: (id: number) => void;
}

const ScheduleItemRow: React.FC<ScheduleItemRowProps> = ({
  item, idx, isDark, isStaffOrAdminProfile, walletPassAvailable,
  walletPassDownloading, refetchAllData,
  handleCancelBooking, handleLeaveBooking, handleCancelRSVP, handleCancelWellness,
  handleDownloadBookingWalletPass,
}) => {
  // eslint-disable-next-line no-useless-assignment
  let actions: { icon: string; label: string; onClick: () => void; disabled?: boolean }[] = [];

  if (item.type === 'booking' || item.type === 'booking_request') {
    const bookingStatus = (item as unknown as DashboardBookingItem).status as string;
    const isConfirmed = bookingStatus === 'approved' || bookingStatus === 'confirmed';
    const rawBooking = item.raw as DBBookingRequest | DBBooking;
    const startTime24 = 'start_time' in rawBooking ? rawBooking.start_time : '';
    const endTime24 = 'end_time' in rawBooking ? rawBooking.end_time : '';
    const isLinkedMember = (item as unknown as DashboardBookingItem).isLinkedMember || false;
    const primaryBookerName = (item as unknown as DashboardBookingItem).primaryBookerName;
    const isCancellationPending = (item as unknown as DashboardBookingItem).status === 'cancellation_pending';

    const bookingHasStarted = item.rawDate && startTime24
      ? createPacificDate(item.rawDate, startTime24) <= new Date()
      : false;

    const isWalletEligible = walletPassAvailable && ['approved', 'confirmed', 'attended', 'checked_in'].includes(bookingStatus);

    if (isCancellationPending) {
      actions = [];
    } else {
      actions = [
        ...(isWalletEligible ? [{
          icon: walletPassDownloading === Number(item.dbId) ? 'progress_activity' : 'wallet',
          label: 'Add to Digital Wallet',
          onClick: () => handleDownloadBookingWalletPass(Number(item.dbId)),
          disabled: walletPassDownloading === Number(item.dbId)
        }] : []),
        ...(isConfirmed ? [{
          icon: 'calendar_add_on',
          label: 'Add to Calendar',
          onClick: () => downloadICalFile({
            title: `${item.title} - Ever Club`,
            description: `Your ${item.resourceType === 'conference_room' ? 'conference room' : 'golf simulator'} booking at Ever Club`,
            location: 'Ever Club, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
            startDate: item.rawDate,
            startTime: startTime24,
            endTime: endTime24
          }, `EverClub_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
        }] : []),
        ...(!isLinkedMember && !bookingHasStarted && bookingStatus !== 'attended' ? [
          { icon: 'close', label: 'Cancel', onClick: () => handleCancelBooking(Number(item.dbId), item.type as 'booking' | 'booking_request') }
        ] : []),
        ...(isLinkedMember && isConfirmed && !bookingHasStarted && (bookingStatus as string) !== 'attended' ? [{
          icon: 'logout',
          label: 'Leave',
          onClick: () => handleLeaveBooking(Number(item.dbId), primaryBookerName)
        }] : [])
      ];
    }
  } else if (item.type === 'rsvp') {
    const rsvpRaw = item.raw as DBRSVP;
    actions = [
      {
        icon: 'calendar_add_on',
        label: 'Add to Calendar',
        onClick: () => downloadICalFile({
          title: `${item.title} - Ever Club`,
          description: `Your event at Ever Club`,
          location: rsvpRaw.location || 'Ever Club, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
          startDate: item.rawDate,
          startTime: rsvpRaw.start_time,
          endTime: rsvpRaw.end_time || ''
        }, `EverClub_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
      },
      { icon: 'close', label: 'Cancel RSVP', onClick: () => handleCancelRSVP(rsvpRaw.event_id) }
    ];
  } else if (item.type === 'wellness') {
    const wellnessRaw = item.raw as DBWellnessEnrollment;
    actions = [
      {
        icon: 'calendar_add_on',
        label: 'Add to Calendar',
        onClick: () => downloadICalFile({
          title: `${item.title} - Ever Club`,
          description: `Your wellness class at Ever Club`,
          location: 'Ever Club, 15771 Red Hill Ave, Ste 500, Tustin, CA 92780',
          startDate: item.rawDate,
          startTime: wellnessRaw.time,
          endTime: ''
        }, `EverClub_${item.rawDate}_${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`)
      },
      { icon: 'close', label: 'Cancel', onClick: () => handleCancelWellness(wellnessRaw.class_id) }
    ];
  } else if (item.type === 'conference_room_calendar') {
    const confCalRaw = item.raw as DashboardBookingItem;
    const confCalStatus = confCalRaw.status || '';
    const confCalWalletEligible = walletPassAvailable && ['approved', 'confirmed', 'attended', 'checked_in'].includes(confCalStatus);
    actions = [
      ...(confCalWalletEligible && typeof item.dbId === 'number' ? [{
        icon: walletPassDownloading === item.dbId ? 'progress_activity' : 'wallet',
        label: 'Add to Digital Wallet',
        onClick: () => handleDownloadBookingWalletPass(item.dbId as number),
        disabled: walletPassDownloading === item.dbId
      }] : []),
    ];
  } else {
    actions = [];
  }

  const getScheduleStatus = () => {
    if (item.type === 'booking' || item.type === 'booking_request') {
      const s = (item as unknown as DashboardBookingItem).status;
      if (s === 'approved' || s === 'confirmed') return { label: 'Confirmed', color: 'bg-green-500' };
      if (s === 'pending' || s === 'pending_approval') return { label: 'Pending', color: 'bg-amber-500' };
      if (s === 'attended') return { label: 'Attended', color: 'bg-blue-500' };
      if (s === 'cancellation_pending') return { label: 'Cancel Pending', color: 'bg-orange-500' };
      return { label: formatStatusLabel(s || ''), color: 'bg-gray-400' };
    }
    if (item.type === 'rsvp') return { label: "RSVP'd", color: 'bg-green-500' };
    if (item.type === 'wellness') return { label: 'Enrolled', color: 'bg-green-500' };
    return undefined;
  };

  const getMetadata = () => {
    const chips: { icon: string; label: string }[] = [];
    if (item.type === 'booking' || item.type === 'booking_request') {
      const raw = item.raw as DBBookingRequest;
      if (item.resourceType !== 'conference_room') {
        const playerCount = raw.declared_player_count || 1;
        chips.push({ icon: 'group', label: `${playerCount} Player${playerCount !== 1 ? 's' : ''}` });
      }
      if (raw.duration_minutes) {
        const hrs = Math.floor(raw.duration_minutes / 60);
        const mins = raw.duration_minutes % 60;
        chips.push({ icon: 'schedule', label: hrs > 0 ? (mins > 0 ? `${hrs}h ${mins}m` : `${hrs} Hour${hrs > 1 ? 's' : ''}`) : `${mins} min` });
      } else if (raw.start_time && raw.end_time) {
        const [sh, sm] = raw.start_time.split(':').map(Number);
        const [eh, em] = raw.end_time.split(':').map(Number);
        const dur = (eh * 60 + em) - (sh * 60 + sm);
        if (dur > 0) {
          const hrs = Math.floor(dur / 60);
          const mins = dur % 60;
          chips.push({ icon: 'schedule', label: hrs > 0 ? (mins > 0 ? `${hrs}h ${mins}m` : `${hrs} Hour${hrs > 1 ? 's' : ''}`) : `${mins} min` });
        }
      }
    } else if (item.type === 'rsvp') {
      const raw = item.raw as DBRSVP;
      if (raw.category) chips.push({ icon: 'category', label: raw.category });
    } else if (item.type === 'wellness') {
      const raw = item.raw as DBWellnessEnrollment;
      if (raw.category) chips.push({ icon: 'category', label: raw.category });
      if (raw.instructor) chips.push({ icon: 'person', label: raw.instructor });
    }
    return chips;
  };

  const scheduleStatus = getScheduleStatus();
  const linkedBookerInfo = (item.type === 'booking' || item.type === 'booking_request') && 
    (item as unknown as DashboardBookingItem).isLinkedMember && (item as unknown as DashboardBookingItem).primaryBookerName
    ? `Booked by ${(item as unknown as DashboardBookingItem).primaryBookerName?.split(' ')[0]}`
    : undefined;

  const isSimulatorBooking = item.resourceType === 'simulator';
  const isApprovedOrConfirmed = ['approved', 'confirmed'].includes((item as unknown as DashboardBookingItem).status || '');
  const isOwnerOfBooking = !((item as unknown as DashboardBookingItem).isLinkedMember);
  const showRosterManager = (item.type === 'booking' || item.type === 'booking_request') && 
    (isSimulatorBooking || item.resourceType === 'conference_room') && 
    isApprovedOrConfirmed && 
    isOwnerOfBooking;
  const rawBookingData = item.raw as DBBookingRequest;

  return (
    <React.Fragment>
      <ScheduleCard
        status={scheduleStatus?.label}
        statusColor={scheduleStatus?.color}
        icon={getIconForType(item.resourceType)}
        title={item.title}
        dateTime={`${item.date} • ${item.time}${item.endTime ? ` - ${item.endTime}` : ''}`}
        metadata={getMetadata()}
        actions={actions}
        staggerIndex={idx + 4}
        linkedInfo={linkedBookerInfo}
      />
      {showRosterManager && (
        <div className="mt-2 mb-4">
          <RosterManager
            bookingId={item.dbId}
            declaredPlayerCount={rawBookingData.declared_player_count || 1}
            isOwner={isOwnerOfBooking}
            isStaff={isStaffOrAdminProfile}
            onUpdate={() => refetchAllData()}
            resourceType={item.resourceType === 'conference_room' ? 'conference_room' : 'simulator'}
          />
        </div>
      )}
    </React.Fragment>
  );
};

interface EmptyScheduleProps {
  isDark: boolean;
  startNavigation: () => void;
  navigate: (path: string) => void;
}

const EmptySchedule: React.FC<EmptyScheduleProps> = ({ isDark, startNavigation, navigate }) => (
  <div className="space-y-4 animate-pop-in">
    <div className={`flex flex-col items-center justify-center text-center py-6 px-6 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/[0.03]'}`}>
      <div className="relative mb-3">
        <div className={`w-14 h-14 rounded-full flex items-center justify-center ${isDark ? 'bg-accent/20' : 'bg-accent/10'}`}>
          <Icon name="sports_golf" className={`text-2xl ${isDark ? 'text-accent' : 'text-brand-green'}`} />
        </div>
      </div>
      <h4 className={`text-base font-semibold mb-1 ${isDark ? 'text-white' : 'text-primary'}`}>No upcoming bookings</h4>
      <p className={`text-xs max-w-[260px] mb-3 ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
        Ready to play? Book a golf simulator session.
      </p>
      <button
        onClick={() => { startNavigation(); navigate('/book'); }}
        className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all duration-fast hover:scale-[1.02] active:scale-[0.98] ${isDark ? 'bg-accent text-brand-green' : 'bg-brand-green text-white'}`}
      >
        Book a Session
      </button>
    </div>

    <div className={`flex items-center gap-3 py-4 px-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/[0.03]'}`}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-lavender/20' : 'bg-lavender/10'}`}>
        <Icon name="event" className={`text-xl ${isDark ? 'text-lavender' : 'text-primary/70'}`} />
      </div>
      <div>
        <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No upcoming events</p>
        <p className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>Check back soon for club events and activities.</p>
      </div>
    </div>

    <div className={`flex items-center gap-3 py-4 px-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/[0.03]'}`}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
        <Icon name="how_to_reg" className={`text-xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
      </div>
      <div>
        <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No RSVPs yet</p>
        <p className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>RSVP to events to see them here.</p>
      </div>
    </div>
  </div>
);

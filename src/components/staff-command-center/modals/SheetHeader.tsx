import { BookingContextType, ManageModeRosterData, FetchedContext } from './bookingSheetTypes';
import TrackmanIcon from '../../icons/TrackmanIcon';
import { formatTime12Hour } from '../../memberProfile/memberProfileTypes';

const formatDateForDisplay = (dateStr: string): string => {
  if (!dateStr) return 'No Date';
  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  try {
    const [y, m, d] = datePart.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr;
  }
};

interface SheetHeaderProps {
  isManageMode: boolean;
  isConferenceRoom: boolean;
  bayName?: string;
  bookingDate?: string;
  timeSlot?: string;
  trackmanBookingId?: string | null;
  notes?: string;
  bookingContext?: BookingContextType;
  fetchedContext?: FetchedContext | null;
  bookingStatus?: string;

  isRelink?: boolean;
  currentMemberName?: string;
  currentMemberEmail?: string;
  importedName?: string;
  isPlaceholderEmail?: (email: string) => boolean;

  ownerMembershipStatus?: string | null;
  isOwnerStaff?: boolean;
  rosterData?: ManageModeRosterData | null;
}

export function SheetHeader({
  isManageMode,
  isConferenceRoom,
  bayName,
  bookingDate,
  timeSlot,
  trackmanBookingId,
  notes,
  bookingContext,
  fetchedContext,
  bookingStatus,
  isRelink,
  currentMemberName,
  currentMemberEmail,
  importedName,
  isPlaceholderEmail,
  ownerMembershipStatus,
  isOwnerStaff,
  rosterData,
}: SheetHeaderProps) {
  if (isManageMode) {
    return (
      <>
        {ownerMembershipStatus && !isOwnerStaff && ownerMembershipStatus.toLowerCase() !== 'active' && ownerMembershipStatus.toLowerCase() !== 'trial' && ownerMembershipStatus.toLowerCase() !== 'past_due' && ownerMembershipStatus.toLowerCase() !== 'unknown' && (
          <div className="p-3 rounded-xl border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-900/15 flex items-center gap-2">
            <span className="material-symbols-outlined text-red-500 dark:text-red-400 text-lg">warning</span>
            <div>
              <p className="text-sm font-medium text-red-700 dark:text-red-300">Inactive Member</p>
              <p className="text-xs text-red-600 dark:text-red-400">This booking owner's membership status is "{ownerMembershipStatus}" — they may not be eligible to book.</p>
            </div>
          </div>
        )}
        <div className="p-3 bg-gradient-to-r from-primary/5 to-primary/10 dark:from-white/5 dark:to-white/10 rounded-xl border border-primary/10 dark:border-white/10">
          <div className="grid grid-cols-2 gap-2 text-sm">
            {(bookingContext?.resourceName || bayName || fetchedContext?.bayName) && (
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">sports_golf</span>
                <span className="font-medium text-primary dark:text-white">{bookingContext?.resourceName || bayName || fetchedContext?.bayName}</span>
              </div>
            )}
            {(bookingContext?.requestDate || bookingDate || fetchedContext?.bookingDate) && (
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">calendar_today</span>
                <span className="text-primary/80 dark:text-white/80">{formatDateForDisplay(bookingContext?.requestDate || bookingDate || fetchedContext?.bookingDate || '')}</span>
              </div>
            )}
            {(bookingContext?.startTime && bookingContext?.endTime) ? (
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">schedule</span>
                <span className="text-primary/80 dark:text-white/80">{formatTime12Hour(bookingContext.startTime)} - {formatTime12Hour(bookingContext.endTime)}</span>
              </div>
            ) : (timeSlot || fetchedContext?.timeSlot) ? (
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">schedule</span>
                <span className="text-primary/80 dark:text-white/80">{timeSlot || fetchedContext?.timeSlot}</span>
              </div>
            ) : null}
            {(bookingContext?.durationMinutes || fetchedContext?.durationMinutes) && (
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">timer</span>
                <span className="text-primary/80 dark:text-white/80">{bookingContext?.durationMinutes || fetchedContext?.durationMinutes} min</span>
              </div>
            )}
            {(trackmanBookingId || fetchedContext?.trackmanBookingId) && (
              <div className="flex items-center gap-2">
                <TrackmanIcon className="w-4 h-4 text-primary/60 dark:text-white/60" />
                <span className="text-primary/80 dark:text-white/80 text-xs">{trackmanBookingId || fetchedContext?.trackmanBookingId}</span>
              </div>
            )}
            {(bookingStatus || fetchedContext?.bookingStatus) && (
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-base">info</span>
                <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                  (bookingStatus || fetchedContext?.bookingStatus) === 'attended' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                  (bookingStatus || fetchedContext?.bookingStatus) === 'cancelled' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' :
                  (bookingStatus || fetchedContext?.bookingStatus) === 'confirmed' || (bookingStatus || fetchedContext?.bookingStatus) === 'approved' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                  'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300'
                }`}>
                  {(bookingStatus || fetchedContext?.bookingStatus || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </span>
              </div>
            )}
          </div>
        </div>

        {(() => {
          const bookingNotesText = (rosterData?.bookingNotes?.notes || notes || fetchedContext?.notes || '').trim();
          const trackmanNotesText = (rosterData?.bookingNotes?.trackmanNotes || bookingContext?.trackmanCustomerNotes || '').trim();
          const showTrackman = trackmanNotesText && bookingNotesText !== trackmanNotesText && !bookingNotesText.includes(trackmanNotesText) && !trackmanNotesText.includes(bookingNotesText);
          return (
            <>
              {bookingNotesText && (
                <div className="p-3 rounded-xl border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-900/10">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-base">description</span>
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Booking Notes</span>
                  </div>
                  <p className="text-sm text-amber-800 dark:text-amber-200 whitespace-pre-wrap">{bookingNotesText}</p>
                </div>
              )}
              {showTrackman && (
                <div className="p-3 rounded-xl border border-blue-200 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-900/10">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-blue-600 dark:text-blue-400 text-base">sell</span>
                    <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Trackman Notes</span>
                  </div>
                  <p className="text-sm text-blue-800 dark:text-blue-200 whitespace-pre-wrap">{trackmanNotesText}</p>
                </div>
              )}
            </>
          );
        })()}

        {rosterData?.bookingNotes?.staffNotes && (
          <div className="p-3 rounded-xl border border-purple-200 dark:border-purple-500/20 bg-purple-50 dark:bg-purple-900/10">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-purple-600 dark:text-purple-400 text-base">sticky_note_2</span>
              <span className="text-xs font-medium text-purple-700 dark:text-purple-300">Staff Notes</span>
            </div>
            <p className="text-sm text-purple-800 dark:text-purple-200 whitespace-pre-wrap">{rosterData.bookingNotes.staffNotes}</p>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {isRelink && currentMemberName && (
        <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1">
            Currently Linked To
          </p>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">person</span>
            <div>
              <p className="font-medium text-blue-800 dark:text-blue-200">{currentMemberName}</p>
              {currentMemberEmail && !(isPlaceholderEmail?.(currentMemberEmail)) && (
                <p className="text-sm text-blue-600 dark:text-blue-400">{currentMemberEmail}</p>
              )}
            </div>
          </div>
        </div>
      )}
      
      {!isConferenceRoom && trackmanBookingId && (
        <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-2">
            Booking Details
          </p>
          <div className="grid grid-cols-2 gap-2 text-sm text-amber-700 dark:text-amber-400">
            {importedName && (
              <p className="flex items-center gap-1 col-span-2 font-semibold">
                <span className="material-symbols-outlined text-sm">person</span>
                {importedName}
              </p>
            )}
            {bayName && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">sports_golf</span>
                {bayName}
              </p>
            )}
            {bookingDate && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">calendar_today</span>
                {formatDateForDisplay(bookingDate)}
              </p>
            )}
            {timeSlot && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">schedule</span>
                {timeSlot}
              </p>
            )}
            <p className="flex items-center gap-1 text-xs opacity-70">
              <span className="material-symbols-outlined text-xs">tag</span>
              ID: #{trackmanBookingId}
            </p>
          </div>
        </div>
      )}

      {isConferenceRoom && (
        <div className="p-3 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 rounded-lg">
          <p className="text-sm font-medium text-indigo-800 dark:text-indigo-300 mb-2">
            Conference Room Booking
          </p>
          <div className="grid grid-cols-2 gap-2 text-sm text-indigo-700 dark:text-indigo-400">
            {bayName && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">meeting_room</span>
                {bayName}
              </p>
            )}
            {bookingDate && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">calendar_today</span>
                {formatDateForDisplay(bookingDate)}
              </p>
            )}
            {timeSlot && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">schedule</span>
                {timeSlot}
              </p>
            )}
          </div>
        </div>
      )}

      {(() => {
        const bNotes = (notes || '').trim();
        const tNotes = (bookingContext?.trackmanCustomerNotes || '').trim();
        const showTrackmanAssign = tNotes && bNotes !== tNotes && !bNotes.includes(tNotes) && !tNotes.includes(bNotes);
        return (
          <>
            {bNotes && (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-500/20 rounded-lg">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-1 flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">description</span>
                  Booking Notes
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-400 whitespace-pre-wrap">{bNotes}</p>
              </div>
            )}
            {showTrackmanAssign && (
              <div className="p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-500/20 rounded-lg">
                <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1 flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">sell</span>
                  Trackman Notes
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-400 whitespace-pre-wrap">{tNotes}</p>
              </div>
            )}
          </>
        );
      })()}
    </>
  );
}

export default SheetHeader;

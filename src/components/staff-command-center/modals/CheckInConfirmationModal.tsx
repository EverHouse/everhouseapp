import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { playSound } from '../../../utils/sounds';

interface PinnedNote {
  content: string;
  createdBy: string;
}

interface BookingDetails {
  bayName: string;
  startTime: string;
  endTime: string;
  resourceType: string;
}

interface CheckInConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberName: string;
  pinnedNotes: PinnedNote[];
  tier?: string | null;
  membershipStatus?: string | null;
  bookingDetails?: BookingDetails | null;
}

function formatTime(time: string): string {
  try {
    const [hours, minutes] = time.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch {
    return time;
  }
}

function formatResourceType(type: string): string {
  if (type === 'golf_simulator') return 'Golf Simulator';
  if (type === 'conference_room') return 'Conference Room';
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const CheckInConfirmationModal: React.FC<CheckInConfirmationModalProps> = ({
  isOpen,
  onClose,
  memberName,
  pinnedNotes,
  tier,
  membershipStatus,
  bookingDetails
}) => {
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const statusLower = membershipStatus?.toLowerCase() || '';
  const isActive = statusLower === 'active' || statusLower === 'trialing';

  useEffect(() => {
    if (isOpen) {
      const showWarning = !isActive && statusLower !== '';
      playSound(showWarning ? 'checkinWarning' : 'checkinSuccess');

      timerRef.current = setTimeout(() => {
        onClose();
      }, bookingDetails ? 6000 : 4000);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isOpen, onClose, isActive, statusLower, bookingDetails]);

  if (!isOpen) return null;
  const isExpired = statusLower === 'expired';
  const isInactive = ['cancelled', 'suspended', 'inactive', 'unpaid', 'terminated', 'past_due', 'paused'].includes(statusLower);
  const showWarning = !isActive && statusLower !== '';

  const modal = (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute',
          top: '-50px',
          left: '-50px',
          right: '-50px',
          bottom: '-50px',
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(4px)',
        }}
        aria-hidden="true"
      />
      <div
        className="relative w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300"
        style={{ position: 'relative', zIndex: 1 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`p-6 text-center ${showWarning ? 'bg-gradient-to-br from-red-700 via-red-600 to-red-800' : 'bg-gradient-to-br from-primary via-primary/95 to-primary/85'}`}>
          <div className="flex justify-end mb-2">
            <button
              onClick={onClose}
              className="tactile-btn w-7 h-7 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 transition-colors text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>

          {showWarning ? (
            <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-3">
              <span className="material-symbols-outlined text-3xl text-yellow-300">warning</span>
            </div>
          ) : (
            <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-3">
              <span className="material-symbols-outlined text-3xl text-white">check_circle</span>
            </div>
          )}

          <h2 className="text-xl font-bold text-white mb-1">{memberName}</h2>
          <p className="text-white/80 text-sm font-medium">Checked In</p>

          {tier && (
            <div className="mt-2 inline-flex items-center px-3 py-1 rounded-full bg-white/15 text-white/90 text-xs font-semibold uppercase tracking-wider">
              {tier}
            </div>
          )}

          {bookingDetails && (
            <div className="mt-3 flex items-center justify-center gap-1.5 text-white/85 text-sm">
              <span className="material-symbols-outlined text-base">{bookingDetails.resourceType === 'conference_room' ? 'meeting_room' : 'sports_golf'}</span>
              <span className="font-medium">
                {bookingDetails.bayName} · {formatResourceType(bookingDetails.resourceType)} · {formatTime(bookingDetails.startTime)} – {formatTime(bookingDetails.endTime)}
              </span>
            </div>
          )}

          {showWarning && (
            <div className="mt-3 flex flex-col items-center gap-1">
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-yellow-400/20 border border-yellow-400/40 text-yellow-200 text-sm font-bold uppercase tracking-wider">
                <span className="material-symbols-outlined text-base">error</span>
                {membershipStatus} Membership
              </div>
              <p className="text-yellow-200/80 text-xs mt-1">Please verify membership before granting access</p>
            </div>
          )}
        </div>

        {pinnedNotes.length > 0 && (
          <div className="bg-white p-4 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-sm text-amber-500">push_pin</span>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Pinned Notes</span>
            </div>
            {pinnedNotes.map((note, i) => (
              <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-sm text-gray-800">{note.content}</p>
                <p className="text-xs text-gray-400 mt-1">— {note.createdBy}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};

export default CheckInConfirmationModal;

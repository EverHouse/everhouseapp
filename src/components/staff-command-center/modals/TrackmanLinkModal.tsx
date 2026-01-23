import { useState, useEffect } from 'react';
import { ModalShell } from '../../ModalShell';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import TrackmanIcon from '../../icons/TrackmanIcon';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';

interface TrackmanLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  trackmanBookingId: string | null;
  bayName?: string;
  bookingDate?: string;
  timeSlot?: string;
  matchedBookingId?: number;
  currentMemberName?: string;
  currentMemberEmail?: string;
  isRelink?: boolean;
  onSuccess?: () => void;
}

export function TrackmanLinkModal({ 
  isOpen, 
  onClose, 
  trackmanBookingId,
  bayName,
  bookingDate,
  timeSlot,
  matchedBookingId,
  currentMemberName,
  currentMemberEmail,
  isRelink,
  onSuccess
}: TrackmanLinkModalProps) {
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const { execute: linkToMember, isLoading: linking } = useAsyncAction<void>();

  useEffect(() => {
    if (!isOpen) {
      setSelectedMember(null);
    }
  }, [isOpen]);

  const handleLink = async () => {
    if (!selectedMember) return;
    
    await linkToMember(async () => {
      // If re-linking an existing booking, use the change-owner endpoint
      if (isRelink && matchedBookingId) {
        const res = await fetch(`/api/bookings/${matchedBookingId}/change-owner`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            new_email: selectedMember.email,
            new_name: selectedMember.name,
            member_id: selectedMember.id
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to change booking owner');
        }
      } else if (trackmanBookingId) {
        const res = await fetch('/api/bookings/link-trackman-to-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            trackman_booking_id: trackmanBookingId,
            member_email: selectedMember.email,
            member_name: selectedMember.name,
            member_id: selectedMember.id
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to link booking to member');
        }
      }
      
      onSuccess?.();
      onClose();
    });
  };

  if (!trackmanBookingId && !matchedBookingId) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <TrackmanIcon size={20} />
          <span>{isRelink && currentMemberName ? 'Change Booking Owner' : 'Assign Member to Booking'}</span>
        </div>
      }
      size="md"
    >
      <div className="p-4 space-y-4">
        {isRelink && currentMemberName && (
          <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1">
              Currently Linked To
            </p>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">person</span>
              <div>
                <p className="font-medium text-blue-800 dark:text-blue-200">{currentMemberName}</p>
                {currentMemberEmail && (
                  <p className="text-sm text-blue-600 dark:text-blue-400">{currentMemberEmail}</p>
                )}
              </div>
            </div>
          </div>
        )}
        
        <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-2">
            Trackman Booking Details
          </p>
          <div className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
            {bayName && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">sports_golf</span>
                {bayName}
              </p>
            )}
            {bookingDate && (
              <p className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">calendar_today</span>
                {bookingDate}
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

        <MemberSearchInput
          label="Search for Member"
          placeholder="Search by name or email..."
          selectedMember={selectedMember}
          onSelect={setSelectedMember}
          onClear={() => setSelectedMember(null)}
          showTier={true}
          autoFocus={true}
        />

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleLink}
            disabled={!selectedMember || linking}
            className={`flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${
              isRelink && currentMemberName
                ? 'bg-blue-500 hover:bg-blue-600 text-white' 
                : 'bg-amber-500 hover:bg-amber-600 text-white'
            }`}
          >
            {linking ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                {isRelink && currentMemberName ? 'Changing...' : 'Assigning...'}
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">{isRelink && currentMemberName ? 'swap_horiz' : 'person_add'}</span>
                {isRelink && currentMemberName ? 'Change Owner' : 'Assign Member'}
              </>
            )}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

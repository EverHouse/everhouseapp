import React, { useState, useCallback } from 'react';
import { ModalShell } from '../../ModalShell';
import { useToast } from '../../Toast';
import { formatTime12Hour, formatDateShort } from '../../../utils/dateUtils';
import type { BookingRequest } from '../types';

const TRACKMAN_PORTAL_URL = 'https://portal.trackmangolf.com/facility/RmFjaWxpdHkKZGI4YWMyN2FhLTM2YWQtNDM4ZC04MjUzLWVmOWU5NzMwMjkxZg==';

interface Guest {
  id?: number;
  name: string;
  email?: string | null;
}

interface TrackmanBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: BookingRequest | null;
  guests?: Guest[];
  onConfirm: (bookingId: number | string, trackmanExternalId: string) => Promise<void>;
}

function generateNotesText(booking: BookingRequest | null, guests: Guest[] = []): string {
  if (!booking) return '';
  
  const lines: string[] = [];
  
  // Add the member (host) line
  if (booking.user_email && booking.user_name) {
    const nameParts = booking.user_name.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    lines.push(`M|${booking.user_email}|${firstName}|${lastName}`);
  }
  
  // Add known guests from booking_participants (filled post-approval)
  for (const guest of guests) {
    const email = guest.email || 'none';
    const nameParts = (guest.name || 'Guest').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    lines.push(`G|${email}|${firstName}|${lastName}`);
  }
  
  // Calculate filled count so far (host + guests)
  let filledCount = 1 + guests.length;
  
  // Add pre-declared participants from request (if not already covered by guests)
  const requestParticipants = booking.request_participants || [];
  const guestEmails = new Set(guests.map(g => g.email?.toLowerCase()).filter(Boolean));
  
  for (const participant of requestParticipants) {
    // Skip if this email is already in guests list
    if (participant.email && guestEmails.has(participant.email.toLowerCase())) {
      continue;
    }
    
    const prefix = participant.type === 'member' ? 'M' : 'G';
    const email = participant.email || 'none';
    // Pre-declared participants only have email, not names yet
    lines.push(`${prefix}|${email}|Pending|Info`);
    filledCount++;
  }
  
  // Add placeholder lines for remaining players based on declared_player_count
  // Format: G|none|Guest|N where N is the player number
  // The parser treats "none" as a recognized placeholder (email becomes null)
  const declaredCount = booking.declared_player_count ?? 1;
  const remainingSlots = declaredCount - filledCount;
  
  for (let i = 0; i < remainingSlots; i++) {
    const playerNum = filledCount + i + 1;
    lines.push(`G|none|Guest|${playerNum}`);
  }
  
  return lines.join('\n');
}

export function TrackmanBookingModal({ 
  isOpen, 
  onClose, 
  booking, 
  guests = [],
  onConfirm 
}: TrackmanBookingModalProps) {
  const { showToast } = useToast();
  const [externalId, setExternalId] = useState('');
  const [copied, setCopied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notesText = generateNotesText(booking, guests);
  // Use declared_player_count from booking, fallback to 1 + guests if not set
  // Use nullish coalescing to preserve 0 as a valid value (though unlikely)
  const totalPlayers = booking?.declared_player_count ?? Math.max(1, 1 + guests.length);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(notesText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [notesText]);

  const handleOpenTrackman = useCallback(() => {
    window.open(TRACKMAN_PORTAL_URL, '_blank', 'noopener,noreferrer');
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!booking || !externalId.trim()) {
      setError('Please paste the Trackman External Booking ID');
      return;
    }

    const trimmedId = externalId.trim();
    if (trimmedId.length < 10) {
      setError('The ID looks too short. Please paste the full External Booking ID from Trackman.');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await onConfirm(booking.id, trimmedId);
      showToast(`Booking confirmed for ${booking.user_name}`, 'success');
      setExternalId('');
      onClose();
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to confirm booking';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }, [booking, externalId, onConfirm, onClose, showToast]);

  const handleClose = useCallback(() => {
    setExternalId('');
    setError(null);
    onClose();
  }, [onClose]);

  if (!booking) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={handleClose}
      title="Book on Trackman"
      size="md"
    >
      <div className="p-4 space-y-5">
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
            <h4 className="font-semibold text-blue-900 dark:text-blue-100">Booking Details</h4>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-blue-700/70 dark:text-blue-300/70">Member</span>
              <p className="font-medium text-blue-900 dark:text-blue-100">{booking.user_name}</p>
            </div>
            <div>
              <span className="text-blue-700/70 dark:text-blue-300/70">Date</span>
              <p className="font-medium text-blue-900 dark:text-blue-100">{formatDateShort(booking.request_date)}</p>
            </div>
            <div>
              <span className="text-blue-700/70 dark:text-blue-300/70">Time</span>
              <p className="font-medium text-blue-900 dark:text-blue-100">
                {formatTime12Hour(booking.start_time)} - {formatTime12Hour(booking.end_time)}
              </p>
            </div>
            <div>
              <span className="text-blue-700/70 dark:text-blue-300/70">Bay</span>
              <p className="font-medium text-blue-900 dark:text-blue-100">
                {booking.bay_name || booking.resource_name || (booking as any).resource_preference || 'Any Available'}
              </p>
            </div>
            <div className="col-span-2">
              <span className="text-blue-700/70 dark:text-blue-300/70">Total Players</span>
              <p className="font-medium text-blue-900 dark:text-blue-100">
                {totalPlayers} {totalPlayers === 1 ? 'player' : 'players'}
                {guests.length > 0 && ` (1 member + ${guests.length} guest${guests.length > 1 ? 's' : ''})`}
              </p>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Notes to paste into Trackman
            </label>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary dark:text-[#CCB8E4] bg-primary/10 dark:bg-[#CCB8E4]/20 rounded-lg hover:bg-primary/20 dark:hover:bg-[#CCB8E4]/30 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">
                {copied ? 'check' : 'content_copy'}
              </span>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-3 font-mono text-sm border border-gray-200 dark:border-white/10">
            <pre className="whitespace-pre-wrap break-all text-gray-800 dark:text-gray-200">{notesText}</pre>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Copy this text and paste it into the "Notes" field in Trackman. Set player count to {totalPlayers}.
          </p>
        </div>

        <button
          onClick={handleOpenTrackman}
          className="w-full py-3 px-4 bg-[#E55A22] hover:bg-[#D04D18] text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined">open_in_new</span>
          Open Trackman Portal
        </button>

        <div className="border-t border-gray-200 dark:border-white/10 pt-5">
          <label htmlFor="externalId" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Paste External Booking ID from Trackman
          </label>
          <input
            id="externalId"
            type="text"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            placeholder="e.g., 019bdde0-e12e-7d41-910a-731855716740"
            className="w-full px-4 py-3 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
          />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            After creating the booking in Trackman, copy the "Linked Booking" ID and paste it here.
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
            <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
          </div>
        )}

        <button
          onClick={handleConfirm}
          disabled={isSubmitting || !externalId.trim()}
          className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:cursor-not-allowed"
        >
          {isSubmitting ? (
            <>
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              Confirming...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined">check_circle</span>
              Confirm Booking
            </>
          )}
        </button>
      </div>
    </ModalShell>
  );
}

export default TrackmanBookingModal;

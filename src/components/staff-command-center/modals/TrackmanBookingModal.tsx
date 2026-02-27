import React, { useState, useCallback, useEffect, useRef } from 'react';
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

interface EnrichedParticipant {
  email?: string;
  type: 'member' | 'guest';
  userId?: string;
  name?: string;
}

interface TrackmanBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: BookingRequest | null;
  guests?: Guest[];
  onConfirm: (bookingId: number | string, trackmanBookingId: string) => Promise<void>;
}

function generateNotesText(booking: BookingRequest | null, guests: Guest[] = [], enrichedParticipants: EnrichedParticipant[] = []): string {
  if (!booking) return '';
  
  const lines: string[] = [];
  
  if (booking.user_email && booking.user_name) {
    const nameParts = booking.user_name.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    lines.push(`M|${booking.user_email}|${firstName}|${lastName}`);
  }
  
  for (const guest of guests) {
    const email = guest.email || 'none';
    const nameParts = (guest.name || 'Guest').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    lines.push(`G|${email}|${firstName}|${lastName}`);
  }
  
  let filledCount = 1 + guests.length;
  
  const guestEmails = new Set(guests.map(g => g.email?.toLowerCase()).filter(Boolean));
  
  for (const participant of enrichedParticipants) {
    if (participant.email && guestEmails.has(participant.email.toLowerCase())) {
      continue;
    }
    
    const prefix = participant.type === 'member' ? 'M' : 'G';
    const email = participant.email || 'none';
    
    let firstName = 'Pending';
    let lastName = 'Info';
    if (participant.name) {
      const nameParts = participant.name.trim().split(/\s+/);
      firstName = nameParts[0] || 'Pending';
      lastName = nameParts.slice(1).join(' ') || 'Info';
    }
    
    lines.push(`${prefix}|${email}|${firstName}|${lastName}`);
    filledCount++;
  }
  
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
  const [enrichedParticipants, setEnrichedParticipants] = useState<EnrichedParticipant[]>([]);
  const [autoApproved, setAutoApproved] = useState(false);
  const [autoConfirmedId, setAutoConfirmedId] = useState<string | null>(null);
  const [showSuccessOverlay, setShowSuccessOverlay] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) {
      setAutoApproved(false);
      setAutoConfirmedId(null);
      setShowSuccessOverlay(false);
      setExternalId('');
      setError(null);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      return;
    }

    if (!booking) {
      return;
    }

    const bookingId = booking.id;
    const bookingEmail = booking.user_email;
    const bookingDate = booking.request_date;

    const handleAutoConfirmed = (event: CustomEvent) => {
      const detail = event.detail;
      const eventBookingId = detail?.data?.bookingId;
      const eventEmail = detail?.data?.memberEmail;
      const eventDate = detail?.data?.date;
      const trackmanId = detail?.data?.trackmanBookingId;

      const isMatch = (eventBookingId && String(eventBookingId) === String(bookingId)) ||
        (eventEmail && eventDate && eventEmail.toLowerCase() === bookingEmail?.toLowerCase() && eventDate === bookingDate);

      if (isMatch) {
        if (trackmanId) {
          setExternalId(String(trackmanId));
          setAutoConfirmedId(String(trackmanId));
        }
        setAutoApproved(true);
        setTimeout(() => setShowSuccessOverlay(true), 50);
        closeTimerRef.current = setTimeout(() => {
          onCloseRef.current();
        }, 3500);
      }
    };

    window.addEventListener('booking-auto-confirmed', handleAutoConfirmed as EventListener);
    return () => {
      window.removeEventListener('booking-auto-confirmed', handleAutoConfirmed as EventListener);
    };
  }, [isOpen, booking]);

  useEffect(() => {
    if (!isOpen || !booking) {
      setEnrichedParticipants([]);
      return;
    }

    const requestParticipants = (booking.request_participants || []) as EnrichedParticipant[];
    
    const participantsNeedingEmail = requestParticipants.filter(p => p.userId && !p.email);
    
    if (participantsNeedingEmail.length === 0) {
      setEnrichedParticipants(requestParticipants);
      return;
    }

    const fetchEmails = async () => {
      try {
        const userIds = participantsNeedingEmail.map(p => p.userId).filter(Boolean);
        const response = await fetch('/api/users/batch-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userIds })
        });
        
        if (response.ok) {
          const data = await response.json();
          const emailMap = new Map<string, string>(
            Object.entries(data.emails || {})
          );
          
          const enriched = requestParticipants.map(p => ({
            ...p,
            email: p.email || (p.userId ? emailMap.get(p.userId) : undefined)
          }));
          setEnrichedParticipants(enriched);
        } else {
          setEnrichedParticipants(requestParticipants);
        }
      } catch (err: unknown) {
        console.error('Failed to fetch participant emails:', err);
        setEnrichedParticipants(requestParticipants);
      }
    };
    
    fetchEmails();
  }, [isOpen, booking]);

  const notesText = generateNotesText(booking, guests, enrichedParticipants);
  const totalPlayers = booking?.declared_player_count ?? Math.max(1, 1 + guests.length);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(notesText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
    }
  }, [notesText]);

  const handleOpenTrackman = useCallback(() => {
    window.open(TRACKMAN_PORTAL_URL, '_blank', 'noopener,noreferrer');
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!booking || !externalId.trim()) {
      setError('Please paste the Trackman Booking ID');
      return;
    }

    const trimmedId = externalId.trim();
    if (!/^\d+$/.test(trimmedId)) {
      setError("Trackman Booking IDs are numbers only (e.g., 19510379). This doesn't look like a Trackman ID.");
      return;
    }
    if (trimmedId.length < 5) {
      setError('The ID looks too short.');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await onConfirm(booking.id, trimmedId);
      setExternalId('');
      onClose();
    } catch (err: unknown) {
      const errorMsg = (err instanceof Error ? err.message : String(err)) || 'Failed to confirm booking';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }, [booking, externalId, onConfirm, onClose, showToast]);

  const handleClose = useCallback(() => {
    setExternalId('');
    setError(null);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    onClose();
  }, [onClose]);

  if (!booking) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={handleClose}
      title={autoApproved ? '' : 'Book on Trackman'}
      size="md"
    >
      <div className="relative overflow-hidden">
        <div
          className={`p-4 space-y-5 transition-all duration-500 ease-out ${
            autoApproved ? 'opacity-0 scale-95 max-h-0 overflow-hidden pointer-events-none' : 'opacity-100 scale-100'
          }`}
          style={{ transformOrigin: 'top center' }}
        >
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
            className="tactile-btn w-full py-3 px-4 bg-[#E55A22] hover:bg-[#D04D18] text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined">open_in_new</span>
            Open Trackman Portal
          </button>

          <div className="border-t border-gray-200 dark:border-white/10 pt-5">
            <label htmlFor="externalId" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Paste Trackman Booking ID
            </label>
            <input
              id="externalId"
              type="text"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder="e.g., 19510379"
              className="w-full px-4 py-3 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all duration-fast"
            />
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              After creating the booking in Trackman, copy the Booking ID and paste it here.
            </p>
          </div>

          {!autoApproved && error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
              <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
            </div>
          )}

          <button
            onClick={handleConfirm}
            disabled={isSubmitting || !externalId.trim() || autoApproved}
            className="tactile-btn w-full py-3 px-4 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:cursor-not-allowed"
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

        {autoApproved && (
          <div
            className={`p-6 flex flex-col items-center justify-center transition-all duration-500 ease-out ${
              showSuccessOverlay ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}
          >
            <div className="relative mb-5">
              <div
                className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center"
                style={{
                  animation: showSuccessOverlay ? 'trackmanCheckScale 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards' : 'none'
                }}
              >
                <span
                  className="material-symbols-outlined text-green-600 dark:text-green-400"
                  style={{
                    fontSize: '40px',
                    animation: showSuccessOverlay ? 'trackmanCheckDraw 0.4s ease-out 0.3s both' : 'none'
                  }}
                >
                  check_circle
                </span>
              </div>
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  animation: showSuccessOverlay ? 'trackmanRipple 1s ease-out 0.2s' : 'none',
                  border: '2px solid rgb(34 197 94 / 0.4)',
                  opacity: 0
                }}
              />
            </div>

            <h3
              className="text-lg font-bold text-green-800 dark:text-green-200 mb-1"
              style={{
                animation: showSuccessOverlay ? 'trackmanFadeUp 0.4s ease-out 0.4s both' : 'none'
              }}
            >
              Auto-Confirmed by Trackman
            </h3>
            <p
              className="text-sm text-green-600/80 dark:text-green-400/80 mb-5"
              style={{
                animation: showSuccessOverlay ? 'trackmanFadeUp 0.4s ease-out 0.5s both' : 'none'
              }}
            >
              No further action needed
            </p>

            {autoConfirmedId && (
              <div
                className="w-full max-w-xs"
                style={{
                  animation: showSuccessOverlay ? 'trackmanFadeUp 0.4s ease-out 0.6s both' : 'none'
                }}
              >
                <div className="relative overflow-hidden rounded-xl border-2 border-green-400 dark:border-green-500 bg-green-50/50 dark:bg-green-900/20 p-4">
                  <div
                    className="absolute inset-0 opacity-20"
                    style={{
                      background: 'linear-gradient(90deg, transparent, rgba(34,197,94,0.3), transparent)',
                      animation: showSuccessOverlay ? 'trackmanShimmer 2s ease-in-out 0.8s infinite' : 'none'
                    }}
                  />
                  <div className="relative">
                    <p className="text-xs font-medium text-green-700/70 dark:text-green-300/70 mb-1">
                      Trackman Booking ID
                    </p>
                    <p className="text-xl font-mono font-bold text-green-800 dark:text-green-200 tracking-wider">
                      {autoConfirmedId}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div
              className="mt-5 flex items-center gap-2 text-xs text-green-600/60 dark:text-green-400/60"
              style={{
                animation: showSuccessOverlay ? 'trackmanFadeUp 0.4s ease-out 0.8s both' : 'none'
              }}
            >
              <span className="material-symbols-outlined text-sm">schedule</span>
              Closing automatically...
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes trackmanCheckScale {
          0% { transform: scale(0); opacity: 0; }
          50% { transform: scale(1.15); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes trackmanCheckDraw {
          0% { opacity: 0; transform: scale(0.5); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes trackmanRipple {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes trackmanFadeUp {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes trackmanShimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </ModalShell>
  );
}

export default TrackmanBookingModal;

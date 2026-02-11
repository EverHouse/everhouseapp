import { useState, useEffect, useCallback, useMemo } from 'react';
import { SlideUpDrawer } from '../SlideUpDrawer';
import { useToast } from '../Toast';
import { formatTime12Hour, formatDateDisplayWithDay } from '../../utils/dateUtils';

interface RescheduleBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: {
    id: number;
    user_email: string | null;
    user_name: string | null;
    resource_id: number | null;
    bay_name: string | null;
    request_date: string;
    start_time: string;
    end_time: string;
    duration_minutes: number | null;
    notes: string | null;
    trackman_booking_id?: string | null;
  } | null;
  resources: Array<{ id: number; name: string; type?: string }>;
  onSuccess: () => void;
}

function calculateDuration(startTime: string, endTime: string): number {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  return endMins > startMins ? endMins - startMins : 0;
}

export function RescheduleBookingModal({ isOpen, onClose, booking, resources, onSuccess }: RescheduleBookingModalProps) {
  const { showToast } = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [newResourceId, setNewResourceId] = useState<number | null>(null);
  const [newDate, setNewDate] = useState('');
  const [newStartTime, setNewStartTime] = useState('');
  const [newEndTime, setNewEndTime] = useState('');
  const [newTrackmanId, setNewTrackmanId] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rescheduleStarted, setRescheduleStarted] = useState(false);

  const isConferenceRoom = useMemo(() => {
    if (!booking?.resource_id) return false;
    const currentResource = resources.find(r => r.id === booking.resource_id);
    return currentResource?.type === 'conference_room';
  }, [booking, resources]);

  const filteredResources = useMemo(
    () => resources.filter(r => isConferenceRoom ? r.type === 'conference_room' : (!r.type || r.type === 'simulator')),
    [resources, isConferenceRoom]
  );

  const newDuration = useMemo(() => calculateDuration(newStartTime, newEndTime), [newStartTime, newEndTime]);
  const originalDuration = booking?.duration_minutes || 0;
  const durationChanged = newDuration > 0 && originalDuration > 0 && newDuration !== originalDuration;

  const newBayName = useMemo(() => {
    if (!newResourceId) return '';
    return filteredResources.find(r => r.id === newResourceId)?.name || '';
  }, [newResourceId, filteredResources]);

  useEffect(() => {
    if (isOpen && booking) {
      setStep(1);
      setNewResourceId(booking.resource_id);
      setNewDate(booking.request_date);
      setNewStartTime(booking.start_time);
      setNewEndTime(booking.end_time);
      setNewTrackmanId('');
      setErrorMsg(null);
      setIsConfirming(false);
      setRescheduleStarted(false);
    }
  }, [isOpen, booking]);

  useEffect(() => {
    if (!isOpen || !booking || rescheduleStarted) return;
    const startReschedule = async () => {
      try {
        const res = await fetch(`/api/admin/booking/${booking.id}/reschedule/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        });
        if (res.ok) {
          setRescheduleStarted(true);
        } else {
          const data = await res.json();
          setErrorMsg(data.error || 'Failed to start reschedule');
        }
      } catch {
        setErrorMsg('Failed to connect to server');
      }
    };
    startReschedule();
  }, [isOpen, booking, rescheduleStarted]);

  const handleClose = useCallback(() => {
    if (booking && rescheduleStarted) {
      fetch(`/api/admin/booking/${booking.id}/reschedule/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      }).catch(() => {});
    }
    onClose();
  }, [booking, rescheduleStarted, onClose]);

  const handleConfirm = useCallback(async () => {
    if (!booking || !newResourceId || !newDate || !newStartTime || !newEndTime || (!isConferenceRoom && !newTrackmanId.trim())) return;
    setIsConfirming(true);
    setErrorMsg(null);

    try {
      const body: any = {
        resource_id: newResourceId,
        request_date: newDate,
        start_time: newStartTime,
        end_time: newEndTime,
        duration_minutes: newDuration
      };
      if (!isConferenceRoom) {
        body.trackman_booking_id = newTrackmanId.trim();
      }

      const res = await fetch(`/api/admin/booking/${booking.id}/reschedule/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to confirm reschedule');
      }

      showToast('Booking rescheduled successfully', 'success');
      onSuccess();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to reschedule booking');
    } finally {
      setIsConfirming(false);
    }
  }, [booking, newResourceId, newDate, newStartTime, newEndTime, newTrackmanId, newDuration, newBayName, showToast, onSuccess, isConferenceRoom]);

  if (!booking) return null;

  const canContinue = newResourceId && newDate && newStartTime && newEndTime && newDuration > 0;
  const canConfirm = canContinue && (isConferenceRoom || newTrackmanId.trim().length > 0);

  return (
    <SlideUpDrawer isOpen={isOpen} onClose={handleClose} title="Reschedule Booking">
      <div className="px-5 py-4 space-y-5">
        {errorMsg && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm flex items-center gap-2">
            <span className="material-symbols-outlined text-lg" aria-hidden="true">error</span>
            {errorMsg}
          </div>
        )}

        {step === 1 && (
          <>
            <div className="p-4 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-lg text-gray-500 dark:text-gray-400" aria-hidden="true">info</span>
                <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">Current Booking</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Member</span>
                  <p className="font-medium text-primary dark:text-white">{booking.user_name || booking.user_email || 'Unknown'}</p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">{isConferenceRoom ? 'Room' : 'Bay'}</span>
                  <p className="font-medium text-primary dark:text-white">{booking.bay_name || 'Unassigned'}</p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Date</span>
                  <p className="font-medium text-primary dark:text-white">{formatDateDisplayWithDay(booking.request_date)}</p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Time</span>
                  <p className="font-medium text-primary dark:text-white">{formatTime12Hour(booking.start_time)} – {formatTime12Hour(booking.end_time)}</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-primary dark:text-white flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-accent" aria-hidden="true">edit_calendar</span>
                {isConferenceRoom ? 'New Room & Time' : 'New Bay & Time'}
              </h4>

              <div>
                <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">{isConferenceRoom ? 'Room' : 'Bay'}</label>
                <select
                  value={newResourceId || ''}
                  onChange={e => setNewResourceId(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-primary dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option value="">{isConferenceRoom ? 'Select room...' : 'Select bay...'}</option>
                  {filteredResources.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Date</label>
                <input
                  type="date"
                  value={newDate}
                  onChange={e => setNewDate(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-primary dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={newStartTime}
                    onChange={e => setNewStartTime(e.target.value)}
                    step={1800}
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-primary dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">End Time</label>
                  <input
                    type="time"
                    value={newEndTime}
                    onChange={e => setNewEndTime(e.target.value)}
                    step={1800}
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-primary dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>

              {newDuration > 0 && (
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Duration: <span className="font-medium text-primary dark:text-white">{newDuration} minutes</span>
                </div>
              )}

              {durationChanged && (
                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">warning</span>
                  Duration changed from {originalDuration} to {newDuration} minutes. Fees may need to be recalculated.
                </div>
              )}
            </div>

            <button
              onClick={() => {
                setErrorMsg(null);
                if (isConferenceRoom) {
                  handleConfirm();
                } else {
                  setStep(2);
                }
              }}
              disabled={!canConfirm}
              className="w-full py-3 px-4 rounded-lg bg-accent hover:bg-accent/90 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">{isConferenceRoom ? 'check' : 'arrow_forward'}</span>
              {isConferenceRoom ? 'Confirm Reschedule' : 'Continue'}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-lg text-blue-500" aria-hidden="true">swap_horiz</span>
                <span className="text-sm font-semibold text-blue-700 dark:text-blue-300">New Booking Details</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-blue-500/70 dark:text-blue-400/70">Member</span>
                  <p className="font-medium text-blue-800 dark:text-blue-200">{booking.user_name || booking.user_email || 'Unknown'}</p>
                </div>
                <div>
                  <span className="text-blue-500/70 dark:text-blue-400/70">{isConferenceRoom ? 'Room' : 'Bay'}</span>
                  <p className="font-medium text-blue-800 dark:text-blue-200">{newBayName || (isConferenceRoom ? 'Select room' : 'Select bay')}</p>
                </div>
                <div>
                  <span className="text-blue-500/70 dark:text-blue-400/70">Date</span>
                  <p className="font-medium text-blue-800 dark:text-blue-200">{newDate ? formatDateDisplayWithDay(newDate) : ''}</p>
                </div>
                <div>
                  <span className="text-blue-500/70 dark:text-blue-400/70">Time</span>
                  <p className="font-medium text-blue-800 dark:text-blue-200">{formatTime12Hour(newStartTime)} – {formatTime12Hour(newEndTime)}</p>
                </div>
              </div>
            </div>

            {booking.notes && (
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-lg text-gray-500 dark:text-gray-400" aria-hidden="true">sticky_note_2</span>
                  <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">Booking Notes</span>
                </div>
                <p className="text-sm text-primary dark:text-white whitespace-pre-wrap select-all">{booking.notes}</p>
              </div>
            )}

            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined text-lg text-amber-600 dark:text-amber-400" aria-hidden="true">sports_golf</span>
                <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">Trackman Steps</span>
              </div>
              <ol className="list-decimal list-inside space-y-2 text-sm text-amber-800 dark:text-amber-200">
                <li>Create this booking on Trackman with the details above.</li>
                <li>Delete the original booking on Trackman.</li>
                <li>Copy the new Trackman Booking ID and paste it below.</li>
              </ol>
            </div>

            <div>
              <label className="block text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">New Trackman Booking ID</label>
              <input
                type="text"
                value={newTrackmanId}
                onChange={e => setNewTrackmanId(e.target.value)}
                placeholder="Paste Trackman Booking ID..."
                className="w-full px-3 py-2.5 rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/5 text-primary dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder:text-amber-400/60"
              />
            </div>

            {durationChanged && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg" aria-hidden="true">warning</span>
                Duration changed ({originalDuration} → {newDuration} min). Fees may need recalculation.
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setErrorMsg(null);
                  setStep(1);
                }}
                disabled={isConfirming}
                className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 font-medium flex items-center justify-center gap-2 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">arrow_back</span>
                Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={!canConfirm || isConfirming}
                className="flex-1 py-3 px-4 rounded-lg bg-accent hover:bg-accent/90 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isConfirming ? (
                  <span className="material-symbols-outlined animate-spin text-sm" aria-hidden="true">progress_activity</span>
                ) : (
                  <span className="material-symbols-outlined text-sm" aria-hidden="true">check</span>
                )}
                Confirm Reschedule
              </button>
            </div>
          </>
        )}
      </div>
    </SlideUpDrawer>
  );
}

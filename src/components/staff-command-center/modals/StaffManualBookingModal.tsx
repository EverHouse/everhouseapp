import React, { useState, useCallback, useEffect } from 'react';
import { ModalShell } from '../../ModalShell';
import { MemberSearchInput, type SelectedMember } from '../../shared/MemberSearchInput';
import { getTodayPacific, formatTime12Hour, formatDateShort } from '../../../utils/dateUtils';

const TRACKMAN_PORTAL_URL = 'https://portal.trackmangolf.com/facility/RmFjaWxpdHkKZGI4YWMyN2FhLTM2YWQtNDM4ZC04MjUzLWVmOWU5NzMwMjkxZg==';

interface Resource {
  id: number;
  name: string;
  type: string;
}

interface ParticipantSlot {
  type: 'member' | 'guest';
  member: SelectedMember | null;
}

export interface StaffManualBookingData {
  hostMember: SelectedMember;
  resourceId: number;
  requestDate: string;
  startTime: string;
  durationMinutes: number;
  declaredPlayerCount: number;
  participants: Array<{
    type: 'member' | 'guest';
    member?: SelectedMember;
    name?: string;
    email?: string;
  }>;
  trackmanExternalId: string;
}

interface StaffManualBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: StaffManualBookingData) => Promise<void>;
  defaultResourceId?: number;
  defaultStartTime?: string;
  defaultDate?: string;
}

function generateNotesText(
  hostMember: SelectedMember,
  participants: ParticipantSlot[],
  declaredPlayerCount: number
): string {
  const lines: string[] = [];

  const hostNameParts = hostMember.name.trim().split(/\s+/);
  const hostFirstName = hostNameParts[0] || '';
  const hostLastName = hostNameParts.slice(1).join(' ') || '';
  lines.push(`M|${hostMember.email}|${hostFirstName}|${hostLastName}`);

  for (const participant of participants) {
    if (participant.member) {
      const prefix = participant.type === 'member' ? 'M' : 'G';
      const email = participant.member.email || 'none';
      const nameParts = participant.member.name.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      lines.push(`${prefix}|${email}|${firstName}|${lastName}`);
    } else if (participant.type === 'guest') {
      lines.push(`G|none|Guest|Pending`);
    }
  }

  const filledCount = 1 + participants.filter(p => p.member).length;
  const remainingSlots = declaredPlayerCount - filledCount;

  for (let i = 0; i < remainingSlots; i++) {
    const playerNum = filledCount + i + 1;
    lines.push(`G|none|Guest|${playerNum}`);
  }

  return lines.join('\n');
}

function calculateEndTime(startTime: string, durationMinutes: number): string {
  const [hours, minutes] = startTime.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes + durationMinutes;
  const endHours = Math.floor(totalMinutes / 60) % 24;
  const endMinutes = totalMinutes % 60;
  return `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`;
}

export function StaffManualBookingModal({
  isOpen,
  onClose,
  onSubmit,
  defaultResourceId,
  defaultStartTime,
  defaultDate
}: StaffManualBookingModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loadingResources, setLoadingResources] = useState(false);

  const [resourceId, setResourceId] = useState<number | null>(defaultResourceId ?? null);
  const [requestDate, setRequestDate] = useState(defaultDate ?? getTodayPacific());
  const [startTime, setStartTime] = useState(defaultStartTime ?? '10:00');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [playerCount, setPlayerCount] = useState(1);

  const [hostMember, setHostMember] = useState<SelectedMember | null>(null);
  const [participants, setParticipants] = useState<ParticipantSlot[]>([]);

  const [notesText, setNotesText] = useState('');
  const [copied, setCopied] = useState(false);
  const [externalId, setExternalId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setHostMember(null);
      setParticipants([]);
      setNotesText('');
      setCopied(false);
      setExternalId('');
      setError(null);
      setPlayerCount(1);
      setDurationMinutes(60);
      
      setResourceId(defaultResourceId ?? null);
      setStartTime(defaultStartTime ?? '10:00');
      setRequestDate(defaultDate ?? getTodayPacific());
      
      setLoadingResources(true);
      fetch('/api/resources?type=simulator', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          setResources(data);
          if (data.length > 0 && defaultResourceId === undefined) {
            setResourceId(prev => prev ?? data[0].id);
          }
        })
        .catch(err => console.error('Failed to load resources:', err))
        .finally(() => setLoadingResources(false));
    }
  }, [isOpen, defaultResourceId, defaultStartTime, defaultDate]);

  useEffect(() => {
    const additionalSlots = Math.max(0, playerCount - 1);
    setParticipants(prev => {
      if (prev.length === additionalSlots) return prev;
      if (prev.length < additionalSlots) {
        const newSlots = [...prev];
        for (let i = prev.length; i < additionalSlots; i++) {
          newSlots.push({ type: 'guest', member: null });
        }
        return newSlots;
      }
      return prev.slice(0, additionalSlots);
    });
  }, [playerCount]);

  const handleParticipantTypeChange = useCallback((index: number, type: 'member' | 'guest') => {
    setParticipants(prev => {
      const updated = [...prev];
      updated[index] = { type, member: null };
      return updated;
    });
  }, []);

  const handleParticipantSelect = useCallback((index: number, member: SelectedMember) => {
    setParticipants(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], member };
      return updated;
    });
  }, []);

  const handleParticipantClear = useCallback((index: number) => {
    setParticipants(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], member: null };
      return updated;
    });
  }, []);

  const getExcludedEmails = useCallback(() => {
    const emails: string[] = [];
    if (hostMember) emails.push(hostMember.email);
    participants.forEach(p => {
      if (p.member) emails.push(p.member.email);
    });
    return emails;
  }, [hostMember, participants]);

  const canFinalize = useCallback(() => {
    if (!hostMember) return false;
    if (!resourceId) return false;
    if (!requestDate) return false;
    if (!startTime) return false;

    for (const p of participants) {
      if (p.type === 'member' && !p.member) {
        return false;
      }
    }
    return true;
  }, [hostMember, resourceId, requestDate, startTime, participants]);

  const handleFinalize = useCallback(() => {
    if (!canFinalize() || !hostMember) {
      setError('Please fill in all required fields');
      return;
    }
    setError(null);

    const notes = generateNotesText(hostMember, participants, playerCount);
    setNotesText(notes);
    setStep(2);
  }, [canFinalize, hostMember, participants, playerCount]);

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

  const handleSubmit = useCallback(async () => {
    if (!hostMember || !resourceId) {
      setError('Missing required booking data');
      return;
    }

    const trimmedId = externalId.trim();
    if (!trimmedId) {
      setError('Please paste the Trackman External Booking ID');
      return;
    }

    if (trimmedId.length < 10) {
      setError('The ID looks too short. Please paste the full External Booking ID from Trackman.');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const data: StaffManualBookingData = {
        hostMember,
        resourceId,
        requestDate,
        startTime,
        durationMinutes,
        declaredPlayerCount: playerCount,
        participants: participants.map(p => ({
          type: p.type,
          member: p.member || undefined,
          name: p.member?.name,
          email: p.member?.email
        })),
        trackmanExternalId: trimmedId
      };

      await onSubmit(data);
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create booking');
    } finally {
      setIsSubmitting(false);
    }
  }, [hostMember, resourceId, externalId, requestDate, startTime, durationMinutes, playerCount, participants, onSubmit]);

  const handleClose = useCallback(() => {
    setStep(1);
    setResourceId(null);
    setRequestDate(getTodayPacific());
    setStartTime('10:00');
    setDurationMinutes(60);
    setPlayerCount(1);
    setHostMember(null);
    setParticipants([]);
    setNotesText('');
    setExternalId('');
    setError(null);
    onClose();
  }, [onClose]);

  const handleBack = useCallback(() => {
    setStep(1);
    setExternalId('');
    setError(null);
  }, []);

  const selectedResource = resources.find(r => r.id === resourceId);
  const endTime = calculateEndTime(startTime, durationMinutes);

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={handleClose}
      title={step === 1 ? 'Create Manual Booking' : 'Complete Trackman Booking'}
      size="md"
    >
      <div className="p-4 space-y-5">
        {step === 1 ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Bay
                </label>
                <select
                  value={resourceId ?? ''}
                  onChange={(e) => setResourceId(Number(e.target.value))}
                  disabled={loadingResources}
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                >
                  {loadingResources ? (
                    <option value="">Loading...</option>
                  ) : (
                    resources.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Date
                </label>
                <input
                  type="date"
                  value={requestDate}
                  onChange={(e) => setRequestDate(e.target.value)}
                  min={getTodayPacific()}
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Start Time
                </label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Duration
                </label>
                <select
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                >
                  <option value={30}>30 minutes</option>
                  <option value={60}>60 minutes</option>
                  <option value={90}>90 minutes</option>
                  <option value={120}>120 minutes</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Player Count
                </label>
                <select
                  value={playerCount}
                  onChange={(e) => setPlayerCount(Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                >
                  <option value={1}>1 player</option>
                  <option value={2}>2 players</option>
                  <option value={3}>3 players</option>
                  <option value={4}>4 players</option>
                </select>
              </div>
            </div>

            <div className="border-t border-gray-200 dark:border-white/10 pt-4">
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">
                Participants
              </h4>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Host (Member) <span className="text-red-500">*</span>
                  </label>
                  <MemberSearchInput
                    onSelect={setHostMember}
                    onClear={() => setHostMember(null)}
                    selectedMember={hostMember}
                    placeholder="Search for host member..."
                    excludeEmails={getExcludedEmails().filter(e => e !== hostMember?.email)}
                  />
                </div>

                {participants.map((participant, index) => (
                  <div key={index} className="bg-gray-50 dark:bg-white/5 rounded-xl p-3 border border-gray-200 dark:border-white/10">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Player {index + 2}
                      </span>
                      <div className="flex bg-gray-200 dark:bg-white/10 rounded-lg p-0.5">
                        <button
                          type="button"
                          onClick={() => handleParticipantTypeChange(index, 'member')}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                            participant.type === 'member'
                              ? 'bg-white dark:bg-white/20 text-primary dark:text-white shadow-sm'
                              : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                          }`}
                        >
                          Member
                        </button>
                        <button
                          type="button"
                          onClick={() => handleParticipantTypeChange(index, 'guest')}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                            participant.type === 'guest'
                              ? 'bg-white dark:bg-white/20 text-primary dark:text-white shadow-sm'
                              : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                          }`}
                        >
                          Guest
                        </button>
                      </div>
                    </div>

                    <MemberSearchInput
                      onSelect={(member) => handleParticipantSelect(index, member)}
                      onClear={() => handleParticipantClear(index)}
                      selectedMember={participant.member}
                      placeholder={participant.type === 'member' ? 'Search member...' : 'Search guest (optional)...'}
                      includeVisitors={participant.type === 'guest'}
                      excludeEmails={getExcludedEmails().filter(e => e !== participant.member?.email)}
                    />
                    {participant.type === 'member' && !participant.member && (
                      <p className="mt-1 text-xs text-red-500">Required for members</p>
                    )}
                    {participant.type === 'guest' && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Optional - leave empty for walk-in guest</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <button
              onClick={handleFinalize}
              disabled={!canFinalize()}
              className="w-full py-3 px-4 bg-primary hover:bg-primary/90 dark:bg-[#CCB8E4] dark:hover:bg-[#CCB8E4]/90 text-white dark:text-[#1a1d15] font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined">check_circle</span>
              Finalize & Generate Notes
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleBack}
              className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              <span className="material-symbols-outlined text-lg">arrow_back</span>
              Back to edit
            </button>

            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <h4 className="font-semibold text-blue-900 dark:text-blue-100">Booking Summary</h4>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-blue-700/70 dark:text-blue-300/70">Host</span>
                  <p className="font-medium text-blue-900 dark:text-blue-100">{hostMember?.name}</p>
                </div>
                <div>
                  <span className="text-blue-700/70 dark:text-blue-300/70">Date</span>
                  <p className="font-medium text-blue-900 dark:text-blue-100">{formatDateShort(requestDate)}</p>
                </div>
                <div>
                  <span className="text-blue-700/70 dark:text-blue-300/70">Time</span>
                  <p className="font-medium text-blue-900 dark:text-blue-100">
                    {formatTime12Hour(startTime)} - {formatTime12Hour(endTime)}
                  </p>
                </div>
                <div>
                  <span className="text-blue-700/70 dark:text-blue-300/70">Bay</span>
                  <p className="font-medium text-blue-900 dark:text-blue-100">{selectedResource?.name || 'Unknown'}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-blue-700/70 dark:text-blue-300/70">Total Players</span>
                  <p className="font-medium text-blue-900 dark:text-blue-100">
                    {playerCount} {playerCount === 1 ? 'player' : 'players'}
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
                Copy this text and paste it into the "Notes" field in Trackman. Set player count to {playerCount}.
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
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !externalId.trim()}
              className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                  Creating Booking...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">check</span>
                  Submit Booking
                </>
              )}
            </button>
          </>
        )}
      </div>
    </ModalShell>
  );
}

export default StaffManualBookingModal;

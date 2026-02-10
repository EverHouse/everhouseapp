import React, { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { SlideUpDrawer } from '../../SlideUpDrawer';
import { MemberSearchInput, type SelectedMember } from '../../shared/MemberSearchInput';
import { useToast } from '../../Toast';
import { getTodayPacific, formatTime12Hour, formatDateShort } from '../../../utils/dateUtils';

const TRACKMAN_PORTAL_URL = 'https://portal.trackmangolf.com/facility/RmFjaWxpdHkKZGI4YWMyN2FhLTM2YWQtNDM4ZC04MjUzLWVmOWU5NzMwMjkxZg==';

interface FeeEstimate {
  dailyAllowance: number;
  usedToday: number;
  remainingAllowance: number;
  overageMinutes: number;
  overageCents: number;
  tierName: string | null;
}

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
  trackmanBookingId: string;
}

interface StaffManualBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: StaffManualBookingData) => Promise<void>;
  defaultResourceId?: number;
  defaultStartTime?: string;
  defaultDate?: string;
  defaultHostMember?: SelectedMember | null;
  initialMode?: 'member' | 'lesson' | 'conference';
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

const modeIndex: Record<'member' | 'lesson' | 'conference', number> = { member: 0, lesson: 1, conference: 2 };

function getSimulatorDurations(players: number): number[] {
  switch (players) {
    case 1: return [30, 60, 90, 120, 150, 180, 210, 240];
    case 2: return [60, 120, 180, 240];
    case 3: return [90, 120, 150, 180, 270];
    case 4: return [120, 180, 240];
    default: return [60, 120, 180, 240];
  }
}

export function StaffManualBookingModal({
  isOpen,
  onClose,
  onSubmit,
  defaultResourceId,
  defaultStartTime,
  defaultDate,
  defaultHostMember,
  initialMode = 'member'
}: StaffManualBookingModalProps) {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'member' | 'lesson' | 'conference'>('member');
  const [step, setStep] = useState<1 | 2>(1);
  
  const memberContentRef = useRef<HTMLDivElement>(null);
  const lessonContentRef = useRef<HTMLDivElement>(null);
  const conferenceContentRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number | undefined>(undefined);
  
  const [resources, setResources] = useState<Resource[]>([]);
  const [loadingResources, setLoadingResources] = useState(false);
  
  // Lesson helper state
  const [lessonClientName, setLessonClientName] = useState('');
  const [lessonCopied, setLessonCopied] = useState(false);
  
  // Conference Room state
  const [confDate, setConfDate] = useState(getTodayPacific());
  const [confDuration, setConfDuration] = useState(60);
  const [confAvailableSlots, setConfAvailableSlots] = useState<string[]>([]);
  const [confSelectedSlot, setConfSelectedSlot] = useState<string>('');
  const [confHostMember, setConfHostMember] = useState<SelectedMember | null>(null);
  const [confFeeEstimate, setConfFeeEstimate] = useState<FeeEstimate | null>(null);
  const [confLoadingSlots, setConfLoadingSlots] = useState(false);
  const [confLoadingFee, setConfLoadingFee] = useState(false);
  const [confSubmitting, setConfSubmitting] = useState(false);

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

  useLayoutEffect(() => {
    const activeRef = mode === 'member' ? memberContentRef : mode === 'lesson' ? lessonContentRef : conferenceContentRef;
    if (activeRef.current) {
      const height = activeRef.current.offsetHeight;
      setContainerHeight(height);
    }
  }, [mode, step, playerCount, participants, confAvailableSlots, confFeeEstimate, confHostMember]);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setStep(1);
      setHostMember(defaultHostMember ?? null);
      setParticipants([]);
      setNotesText('');
      setCopied(false);
      setExternalId('');
      setError(null);
      setPlayerCount(1);
      setDurationMinutes(60);
      setLessonClientName('');
      setLessonCopied(false);
      
      // Reset conference room state
      setConfDate(defaultDate ?? getTodayPacific());
      setConfDuration(60);
      setConfAvailableSlots([]);
      setConfSelectedSlot('');
      setConfHostMember(null);
      setConfFeeEstimate(null);
      
      setResourceId(defaultResourceId ?? null);
      setStartTime(defaultStartTime ?? '10:00');
      setRequestDate(defaultDate ?? getTodayPacific());
      
      setLoadingResources(true);
      fetch('/api/resources?type=simulator', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          // Filter out conference room from resources list
          const simulatorResources = data.filter((r: Resource) => r.type === 'simulator');
          setResources(simulatorResources);
          if (simulatorResources.length > 0 && defaultResourceId === undefined) {
            setResourceId(prev => prev ?? simulatorResources[0].id);
          }
        })
        .catch(err => console.error('Failed to load resources:', err))
        .finally(() => setLoadingResources(false));
    }
  }, [isOpen, defaultResourceId, defaultStartTime, defaultDate, defaultHostMember, initialMode]);

  // Reset duration when player count changes if current duration is not valid
  useEffect(() => {
    if (mode !== 'member') return;
    const validDurations = getSimulatorDurations(playerCount);
    if (!validDurations.includes(durationMinutes)) {
      setDurationMinutes(validDurations[0]);
    }
  }, [playerCount, mode, durationMinutes]);

  // Fetch available conference room slots when date/duration changes
  useEffect(() => {
    if (mode !== 'conference') return;
    if (!confDate) return;

    setConfLoadingSlots(true);
    setConfSelectedSlot('');
    fetch(`/api/staff/conference-room/available-slots?date=${confDate}&duration=${confDuration}`, { credentials: 'include' })
      .then(res => res.json())
      .then(slots => {
        setConfAvailableSlots(slots);
        if (slots.length > 0) {
          let selectedSlot = slots[0];
          
          // Try to pre-select the clicked time slot
          if (defaultStartTime) {
            // First try exact match
            if (slots.includes(defaultStartTime)) {
              selectedSlot = defaultStartTime;
            } else {
              // Round to nearest 30-minute slot (conference room slots are 30-min intervals)
              const [hours, mins] = defaultStartTime.split(':').map(Number);
              const roundedMins = mins < 30 ? 0 : 30;
              const roundedSlot = `${String(hours).padStart(2, '0')}:${String(roundedMins).padStart(2, '0')}`;
              if (slots.includes(roundedSlot)) {
                selectedSlot = roundedSlot;
              }
            }
          }
          
          setConfSelectedSlot(selectedSlot);
        }
      })
      .catch(err => console.error('Failed to load available slots:', err))
      .finally(() => setConfLoadingSlots(false));
  }, [mode, confDate, confDuration, defaultStartTime]);

  // Fetch fee estimate when host member or date/duration changes
  useEffect(() => {
    if (mode !== 'conference') return;
    if (!confHostMember || !confDate) {
      setConfFeeEstimate(null);
      return;
    }

    setConfLoadingFee(true);
    fetch(`/api/staff/conference-room/fee-estimate?email=${encodeURIComponent(confHostMember.email)}&date=${confDate}&duration=${confDuration}`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => setConfFeeEstimate(data))
      .catch(err => console.error('Failed to load fee estimate:', err))
      .finally(() => setConfLoadingFee(false));
  }, [mode, confHostMember, confDate, confDuration]);

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
    if (durationMinutes < 30 || durationMinutes > 240) return false;

    for (const p of participants) {
      if (p.type === 'member' && !p.member) {
        return false;
      }
    }
    return true;
  }, [hostMember, resourceId, requestDate, startTime, durationMinutes, participants]);

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

  const handleCopyLessonNotes = useCallback(async () => {
    const text = lessonClientName.trim() ? `Lesson: ${lessonClientName.trim()}` : 'Lesson';
    try {
      await navigator.clipboard.writeText(text);
      setLessonCopied(true);
      setTimeout(() => setLessonCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [lessonClientName]);

  const handleConferenceSubmit = useCallback(async () => {
    if (!confHostMember || !confSelectedSlot || !confDate) {
      setError('Please fill in all required fields');
      return;
    }

    setError(null);
    setConfSubmitting(true);

    try {
      const response = await fetch('/api/staff/conference-room/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          hostEmail: confHostMember.email,
          hostName: confHostMember.name,
          date: confDate,
          startTime: confSelectedSlot,
          durationMinutes: confDuration
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create booking');
      }

      showToast(`Conference room booked for ${confHostMember.name}`, 'success');
      handleClose();
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to create conference room booking';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setConfSubmitting(false);
    }
  }, [confHostMember, confSelectedSlot, confDate, confDuration, showToast]);

  const canCreateConferenceBooking = confHostMember && confSelectedSlot && confDate;

  const handleSubmit = useCallback(async () => {
    if (!hostMember || !resourceId) {
      setError('Missing required booking data');
      return;
    }

    const trimmedId = externalId.trim();
    if (!trimmedId) {
      setError('Please paste the Trackman Booking ID');
      return;
    }

    if (trimmedId.length < 5) {
      setError('The ID looks too short.');
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
        trackmanBookingId: trimmedId
      };

      await onSubmit(data);
      showToast(`Booking created for ${hostMember.name}`, 'success');
      handleClose();
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to create booking';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }, [hostMember, resourceId, externalId, requestDate, startTime, durationMinutes, playerCount, participants, onSubmit, showToast]);

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

  const stickyFooterContent = mode === 'conference' ? (
    <div className="p-4 space-y-3">
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}
      <button
        onClick={handleConferenceSubmit}
        disabled={confSubmitting || !canCreateConferenceBooking}
        className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {confSubmitting ? (
          <>
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
            Creating Booking...
          </>
        ) : (
          <>
            <span className="material-symbols-outlined">meeting_room</span>
            Create Booking
          </>
        )}
      </button>
    </div>
  ) : mode === 'lesson' ? (
    <div className="p-4 flex gap-3">
      <button
        onClick={handleCopyLessonNotes}
        className="flex-1 py-3 px-4 bg-primary/10 dark:bg-[#CCB8E4]/20 hover:bg-primary/20 dark:hover:bg-[#CCB8E4]/30 text-primary dark:text-[#CCB8E4] font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined">
          {lessonCopied ? 'check' : 'content_copy'}
        </span>
        {lessonCopied ? 'Copied!' : 'Copy Notes'}
      </button>
      <button
        onClick={handleOpenTrackman}
        className="flex-1 py-3 px-4 bg-[#E55A22] hover:bg-[#D04D18] text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined">open_in_new</span>
        Open Trackman
      </button>
    </div>
  ) : step === 1 ? (
    <div className="p-4">
      {error && (
        <div className="p-3 mb-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
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
    </div>
  ) : (
    <div className="p-4 space-y-3">
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
    </div>
  );

  const getTitle = () => {
    if (mode === 'conference') return 'Conference Room Booking';
    if (mode === 'lesson') return 'Lesson / Staff Block';
    return step === 1 ? 'Create Manual Booking' : 'Complete Trackman Booking';
  };

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={handleClose}
      title={getTitle()}
      maxHeight="full"
      stickyFooter={stickyFooterContent}
    >
      <div className="p-4 space-y-5">
        {/* Mode Selector */}
        <div className="flex p-1 bg-gray-100 dark:bg-white/10 rounded-lg">
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-all ${
              mode === 'member' 
                ? 'bg-white dark:bg-white/20 shadow text-gray-900 dark:text-white' 
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/5'
            }`}
            onClick={() => setMode('member')}
          >
            Member Booking
          </button>
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-all ${
              mode === 'lesson' 
                ? 'bg-white dark:bg-white/20 shadow text-gray-900 dark:text-white' 
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/5'
            }`}
            onClick={() => setMode('lesson')}
          >
            Lesson / Staff Block
          </button>
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-all ${
              mode === 'conference' 
                ? 'bg-white dark:bg-white/20 shadow text-gray-900 dark:text-white' 
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/5'
            }`}
            onClick={() => setMode('conference')}
          >
            Conference Room
          </button>
        </div>

        {/* Sliding Tab Content Container */}
        <div 
          className="overflow-hidden transition-[height] duration-300 ease-out"
          style={{ height: containerHeight !== undefined ? `${containerHeight}px` : 'auto' }}
        >
          <div 
            className="flex transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${modeIndex[mode] * 100}%)` }}
          >
            {/* Member Booking Tab (index 0) */}
            <div ref={memberContentRef} className="w-full flex-shrink-0">
              {step === 1 ? (
                <div className="space-y-5">
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

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Duration
                      </label>
                      <select
                        value={durationMinutes}
                        onChange={(e) => setDurationMinutes(Number(e.target.value))}
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                      >
                        {getSimulatorDurations(playerCount).map(mins => (
                          <option key={mins} value={mins}>{mins} minutes</option>
                        ))}
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
                          includeVisitors={true}
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
                            includeVisitors={true}
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
                </div>
              ) : (
                <div className="space-y-5">
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
                      Paste Trackman Booking ID
                    </label>
                    <input
                      id="externalId"
                      type="text"
                      value={externalId}
                      onChange={(e) => setExternalId(e.target.value)}
                      placeholder="e.g., 19510379"
                      className="w-full px-4 py-3 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                    />
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      After creating the booking in Trackman, copy the Booking ID and paste it here.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Lesson / Staff Block Tab (index 1) */}
            <div ref={lessonContentRef} className="w-full flex-shrink-0">
              <div className="space-y-6">
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-4">
                  <div className="flex gap-3">
                    <div className="p-2 bg-blue-100 dark:bg-blue-800/50 rounded-lg h-fit">
                      <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                    </div>
                    <div>
                      <h3 className="font-medium text-blue-900 dark:text-blue-100">New Workflow</h3>
                      <p className="text-sm text-blue-700 dark:text-blue-300 mt-1 leading-relaxed">
                        Lessons and Staff Blocks are now handled automatically. Instead of creating a booking here, simply book in Trackman using your staff email.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      Client Name (Optional)
                    </label>
                    <input
                      type="text"
                      value={lessonClientName}
                      onChange={(e) => setLessonClientName(e.target.value)}
                      placeholder="e.g. John Doe"
                      className="w-full px-3 py-2.5 bg-gray-50 dark:bg-white/10 border border-gray-200 dark:border-white/20 rounded-lg focus:ring-2 focus:ring-primary/20 dark:focus:ring-[#CCB8E4]/20 focus:border-primary dark:focus:border-[#CCB8E4] transition-colors"
                    />
                  </div>

                  <div className="border border-gray-100 dark:border-white/10 rounded-xl divide-y divide-gray-100 dark:divide-white/10 bg-white dark:bg-white/5 shadow-sm">
                    <div className="p-4 flex gap-4">
                      <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300 shrink-0">1</div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">Open Trackman</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">Go to the Trackman booking grid.</p>
                      </div>
                    </div>

                    <div className="p-4 flex gap-4">
                      <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300 shrink-0">2</div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">Create booking with your @evenhouse.club email</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">This tells the system it's a lesson/staff block, not a member booking.</p>
                      </div>
                    </div>

                    <div className="p-4 flex gap-4">
                      <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300 shrink-0">3</div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">Paste the notes (optional)</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">Click "Copy Notes" below, then paste into Trackman's notes field.</p>
                      </div>
                    </div>

                    <div className="p-4 flex gap-4">
                      <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-sm font-bold text-green-600 dark:text-green-400 shrink-0">
                        <span className="material-symbols-outlined text-lg">check</span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">That's it!</p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">The system will auto-convert it to an availability block.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Conference Room Tab (index 2) */}
            <div ref={conferenceContentRef} className="w-full flex-shrink-0">
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Date
                    </label>
                    <input
                      type="date"
                      value={confDate}
                      onChange={(e) => setConfDate(e.target.value)}
                      min={getTodayPacific()}
                      className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Duration
                    </label>
                    <select
                      value={confDuration}
                      onChange={(e) => setConfDuration(Number(e.target.value))}
                      className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                    >
                      <option value={30}>30 minutes</option>
                      <option value={60}>60 minutes</option>
                      <option value={90}>90 minutes</option>
                      <option value={120}>120 minutes</option>
                      <option value={150}>150 minutes</option>
                      <option value={180}>180 minutes</option>
                      <option value={210}>210 minutes</option>
                      <option value={240}>240 minutes</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Available Time Slots
                  </label>
                  {confLoadingSlots ? (
                    <div className="flex items-center gap-2 py-2.5 px-4 text-sm text-gray-500 dark:text-gray-400">
                      <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                      Loading available slots...
                    </div>
                  ) : confAvailableSlots.length === 0 ? (
                    <div className="py-2.5 px-4 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10">
                      No available slots for this date and duration
                    </div>
                  ) : (
                    <select
                      value={confSelectedSlot}
                      onChange={(e) => setConfSelectedSlot(e.target.value)}
                      className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all"
                    >
                      {confAvailableSlots.map(slot => (
                        <option key={slot} value={slot}>
                          {formatTime12Hour(slot)} - {formatTime12Hour(calculateEndTime(slot, confDuration))}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Host Member <span className="text-red-500">*</span>
                  </label>
                  <MemberSearchInput
                    onSelect={setConfHostMember}
                    onClear={() => setConfHostMember(null)}
                    selectedMember={confHostMember}
                    placeholder="Search for host member..."
                    includeVisitors={true}
                  />
                </div>

                {confHostMember && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">receipt_long</span>
                      <h4 className="font-semibold text-blue-900 dark:text-blue-100">Fee Estimate</h4>
                    </div>
                    {confLoadingFee ? (
                      <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
                        <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                        Calculating...
                      </div>
                    ) : confFeeEstimate ? (
                      <div className="space-y-2 text-sm">
                        {confFeeEstimate.tierName && (
                          <div className="flex justify-between">
                            <span className="text-blue-700/70 dark:text-blue-300/70">Member Tier</span>
                            <span className="font-medium text-blue-900 dark:text-blue-100">{confFeeEstimate.tierName}</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-blue-700/70 dark:text-blue-300/70">Daily Allowance</span>
                          <span className="font-medium text-blue-900 dark:text-blue-100">{confFeeEstimate.dailyAllowance} min</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-blue-700/70 dark:text-blue-300/70">Used Today</span>
                          <span className="font-medium text-blue-900 dark:text-blue-100">{confFeeEstimate.usedToday} min</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-blue-700/70 dark:text-blue-300/70">This Booking</span>
                          <span className="font-medium text-blue-900 dark:text-blue-100">{confDuration} min</span>
                        </div>
                        {confFeeEstimate.overageMinutes > 0 ? (
                          <div className="pt-2 mt-2 border-t border-blue-200 dark:border-blue-700">
                            <div className="flex justify-between items-center">
                              <span className="text-amber-700 dark:text-amber-400 font-medium">Overage Fee</span>
                              <span className="font-bold text-amber-700 dark:text-amber-400">
                                ${(confFeeEstimate.overageCents / 100).toFixed(2)} for {confFeeEstimate.overageMinutes} min
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="pt-2 mt-2 border-t border-blue-200 dark:border-blue-700">
                            <div className="flex justify-between items-center">
                              <span className="text-green-700 dark:text-green-400 font-medium">Within Allowance</span>
                              <span className="font-bold text-green-700 dark:text-green-400">No fee</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-blue-600/70 dark:text-blue-400/70">
                        Unable to calculate fee estimate
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </SlideUpDrawer>
  );
}

export default StaffManualBookingModal;

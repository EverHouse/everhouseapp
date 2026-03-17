import React, { useState, useCallback, useEffect } from 'react';
import { SlideUpDrawer } from '../../SlideUpDrawer';
import { MemberSearchInput, type SelectedMember } from '../../shared/MemberSearchInput';
import { useToast } from '../../Toast';
import { getTodayPacific, formatTime12Hour } from '../../../utils/dateUtils';
import { fetchWithCredentials, postWithCredentials } from '../../../hooks/queries/useFetch';

interface FeeEstimate {
  dailyAllowance: number;
  usedToday: number;
  remainingAllowance: number;
  overageMinutes: number;
  overageCents: number;
  tierName: string | null;
}

interface StaffManualBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultStartTime?: string;
  defaultDate?: string;
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
  defaultStartTime,
  defaultDate,
}: StaffManualBookingModalProps) {
  const { showToast } = useToast();

  const [confDate, setConfDate] = useState(defaultDate ?? getTodayPacific());
  const [confDuration, setConfDuration] = useState(60);
  const [confStartTime, setConfStartTime] = useState(defaultStartTime ?? '08:30');
  const [confHostMember, setConfHostMember] = useState<SelectedMember | null>(null);
  const [confFeeEstimate, setConfFeeEstimate] = useState<FeeEstimate | null>(null);
  const [confLoadingFee, setConfLoadingFee] = useState(false);
  const [confSubmitting, setConfSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setConfDate(defaultDate ?? getTodayPacific());
      setConfStartTime(defaultStartTime ?? '08:30');
      setConfDuration(60);
      setConfHostMember(null);
      setConfFeeEstimate(null);
      setError(null);
    }
  }, [isOpen, defaultDate, defaultStartTime]);

  useEffect(() => {
    if (!isOpen || !confHostMember || !confDate) {
      setConfFeeEstimate(null);
      setConfLoadingFee(false);
      return;
    }

    const controller = new AbortController();
    setConfLoadingFee(true);
    fetchWithCredentials<FeeEstimate>(`/api/staff/conference-room/fee-estimate?email=${encodeURIComponent(confHostMember.email)}&date=${confDate}&duration=${confDuration}`, { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) setConfFeeEstimate(data);
      })
      .catch(err => {
        if (!controller.signal.aborted) console.error('Failed to load fee estimate:', err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setConfLoadingFee(false);
      });

    return () => {
      controller.abort();
      setConfLoadingFee(false);
    };
  }, [isOpen, confHostMember, confDate, confDuration]);

  const handleClose = useCallback(() => {
    setConfDate(getTodayPacific());
    setConfDuration(60);
    setConfStartTime('08:30');
    setConfHostMember(null);
    setConfFeeEstimate(null);
    setError(null);
    onClose();
  }, [onClose]);

  const handleConferenceSubmit = useCallback(async () => {
    if (!confHostMember || !confStartTime || !confDate) {
      setError('Please fill in all required fields');
      return;
    }

    setError(null);
    setConfSubmitting(true);

    try {
      await postWithCredentials('/api/staff/conference-room/booking', {
        hostEmail: confHostMember.email,
        hostName: confHostMember.name,
        date: confDate,
        startTime: confStartTime,
        durationMinutes: confDuration
      });

      showToast(`Conference room booked for ${confHostMember.name}`, 'success');
      handleClose();
    } catch (err: unknown) {
      const errorMsg = (err instanceof Error ? err.message : String(err)) || 'Failed to create conference room booking';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setConfSubmitting(false);
    }
  }, [confHostMember, confStartTime, confDate, confDuration, showToast, handleClose]);

  const canCreateConferenceBooking = confHostMember && confStartTime && confDate;

  const stickyFooterContent = (
    <div className="p-4 space-y-3">
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}
      <button
        onClick={handleConferenceSubmit}
        disabled={confSubmitting || !canCreateConferenceBooking}
        className="tactile-btn w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={handleClose}
      title="Conference Room Booking"
      maxHeight="full"
      stickyFooter={stickyFooterContent}
    >
      <div className="p-4 space-y-5">
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
                className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all duration-fast"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Duration
              </label>
              <select
                value={confDuration}
                onChange={(e) => setConfDuration(Number(e.target.value))}
                className="w-full px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all duration-fast"
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
              Start Time
            </label>
            <div className="flex items-center gap-3">
              <input
                type="time"
                value={confStartTime}
                onChange={(e) => setConfStartTime(e.target.value)}
                step="900"
                className="flex-1 px-4 py-2.5 text-sm bg-white dark:bg-white/10 border border-gray-300 dark:border-white/20 rounded-xl focus:ring-2 focus:ring-primary dark:focus:ring-[#CCB8E4] focus:border-transparent outline-none transition-all duration-fast"
              />
              <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {formatTime12Hour(confStartTime)} – {formatTime12Hour(calculateEndTime(confStartTime, confDuration))}
              </span>
            </div>
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
    </SlideUpDrawer>
  );
}

export default StaffManualBookingModal;

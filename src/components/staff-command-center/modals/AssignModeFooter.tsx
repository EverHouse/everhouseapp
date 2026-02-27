import React from 'react';

interface AssignModeFooterProps {
  hasOwner: boolean;
  linking: boolean;
  feeEstimate: { totalCents: number; overageCents: number; guestCents: number } | null;
  isCalculatingFees: boolean;
  isConferenceRoom: boolean;
  onClose: () => void;
  handleFinalizeBooking: () => Promise<void>;
}

export interface AssignModeSecondaryActionsProps {
  markingAsEvent: boolean;
  isLoadingNotices: boolean;
  showNoticeSelection: boolean;
  setShowNoticeSelection: (show: boolean) => void;
  overlappingNotices: Array<{id: number; title: string; reason: string | null; notice_type: string | null; start_date: string; end_date: string; start_time: string | null; end_time: string | null; source: string}>;
  showStaffList: boolean;
  setShowStaffList: (show: boolean) => void;
  staffList: Array<{id: string; email: string; first_name: string; last_name: string; role: string; user_id: string | null}>;
  isLoadingStaff: boolean;
  assigningToStaff: boolean;
  handleMarkAsEvent: () => Promise<void>;
  executeMarkAsEvent: (existingClosureId?: number) => Promise<void>;
  handleAssignToStaff: (staff: { id: string | number; name: string; email: string }) => Promise<void>;
  getRoleBadge: (role: string) => React.ReactNode;
  onDeleteBooking?: () => Promise<void>;
  deleting?: boolean;
}

export function AssignModeFooter({
  hasOwner,
  linking,
  feeEstimate,
  isCalculatingFees,
  isConferenceRoom,
  onClose,
  handleFinalizeBooking,
}: AssignModeFooterProps) {
  return (
    <div className="p-4 space-y-2">
      {feeEstimate && feeEstimate.totalCents > 0 && (
        <div className="mb-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-lg">payments</span>
              <span className="text-sm font-medium text-amber-700 dark:text-amber-300">Estimated Fees</span>
            </div>
            <span className="text-lg font-bold text-amber-700 dark:text-amber-300">
              ${(feeEstimate.totalCents / 100).toFixed(2)}
            </span>
          </div>
          <div className="mt-1 flex gap-4 text-xs text-amber-600 dark:text-amber-400">
            {feeEstimate.overageCents > 0 && (
              <span>Overage: ${(feeEstimate.overageCents / 100).toFixed(2)}</span>
            )}
            {feeEstimate.guestCents > 0 && (
              <span>Guest fees: ${(feeEstimate.guestCents / 100).toFixed(2)}</span>
            )}
          </div>
        </div>
      )}
      {isCalculatingFees && (
        <div className="mb-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 flex items-center justify-center gap-2 text-sm text-primary/50 dark:text-white/50">
          <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
          Calculating fees...
        </div>
      )}
      <div className="flex gap-3">
        <button
          onClick={onClose}
          className="tactile-btn flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleFinalizeBooking}
          disabled={!hasOwner || linking}
          className="tactile-btn flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white"
        >
          {linking ? (
            <>
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Assigning...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-sm">check_circle</span>
              Assign & Confirm
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function AssignModeSecondaryActions({
  markingAsEvent,
  isLoadingNotices,
  showNoticeSelection,
  setShowNoticeSelection,
  overlappingNotices,
  showStaffList,
  setShowStaffList,
  staffList,
  isLoadingStaff,
  assigningToStaff,
  handleMarkAsEvent,
  executeMarkAsEvent,
  handleAssignToStaff,
  getRoleBadge,
  onDeleteBooking,
  deleting,
}: AssignModeSecondaryActionsProps) {
  return (
    <div className="space-y-2 pt-2 border-t border-primary/10 dark:border-white/10">
      <button
        onClick={handleMarkAsEvent}
        disabled={markingAsEvent || isLoadingNotices}
        className="tactile-btn w-full py-2.5 px-4 rounded-lg border border-purple-500 text-purple-600 dark:text-purple-400 font-medium hover:bg-purple-50 dark:hover:bg-purple-500/10 transition-colors flex items-center justify-center gap-2"
      >
        {markingAsEvent || isLoadingNotices ? (
          <>
            <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
            {isLoadingNotices ? 'Checking...' : 'Marking...'}
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-sm">event</span>
            Mark as Private Event
          </>
        )}
      </button>

      {showNoticeSelection && (
        <div className="p-3 rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50/50 dark:bg-purple-900/10 space-y-2">
          <div className="flex items-center gap-2 text-purple-700 dark:text-purple-400">
            <span className="material-symbols-outlined text-sm">info</span>
            <span className="text-sm font-medium">
              {overlappingNotices.length > 0 ? 'Existing notices found for this day' : 'No existing notices for this day'}
            </span>
          </div>
          {overlappingNotices.length > 0 && (
            <p className="text-xs text-primary/60 dark:text-white/60">
              Link to an existing notice to avoid duplicates, or create a new one.
            </p>
          )}
          <div className="space-y-1.5">
            {overlappingNotices.map((notice) => (
              <button
                key={notice.id}
                onClick={() => executeMarkAsEvent(notice.id)}
                disabled={markingAsEvent}
                className="tactile-btn w-full p-2 text-left rounded-lg bg-white dark:bg-white/5 hover:bg-purple-100 dark:hover:bg-purple-900/20 transition-colors border border-purple-200 dark:border-purple-500/20"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-primary dark:text-white">{notice.title || notice.reason || 'Untitled Notice'}</p>
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded">
                    {notice.source}
                  </span>
                </div>
                <p className="text-xs text-primary/60 dark:text-white/60 mt-0.5">
                  {notice.start_time && notice.end_time 
                    ? `${notice.start_time.slice(0, 5)} - ${notice.end_time.slice(0, 5)}` 
                    : 'All day'
                  }
                  {notice.notice_type && ` • ${notice.notice_type}`}
                </p>
              </button>
            ))}
            <button
              onClick={() => executeMarkAsEvent()}
              disabled={markingAsEvent}
              className="tactile-btn w-full p-2 text-center rounded-lg border-2 border-dashed border-purple-300 dark:border-purple-600 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-500/10 transition-colors text-sm font-medium"
            >
              <span className="material-symbols-outlined text-sm mr-1">add</span>
              Create New Notice Instead
            </button>
          </div>
          <button
            onClick={() => setShowNoticeSelection(false)}
            className="tactile-btn w-full text-center text-xs text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white pt-1"
          >
            Cancel
          </button>
        </div>
      )}

      <button
        onClick={() => setShowStaffList(!showStaffList)}
        disabled={assigningToStaff}
        className="tactile-btn w-full py-2.5 px-4 rounded-lg border border-teal-500 text-teal-600 dark:text-teal-400 font-medium hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-sm">badge</span>
        Assign to Staff
        <span className={`material-symbols-outlined text-sm transition-transform ${showStaffList ? 'rotate-180' : ''}`}>expand_more</span>
      </button>

      {showStaffList && (
        <div className="border border-teal-200 dark:border-teal-500/30 rounded-lg overflow-hidden">
          {isLoadingStaff ? (
            <div className="p-4 text-center">
              <span className="material-symbols-outlined animate-spin text-teal-500">progress_activity</span>
              <p className="text-sm text-primary/60 dark:text-white/60 mt-1">Loading staff...</p>
            </div>
          ) : staffList.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-sm text-primary/60 dark:text-white/60">No active staff found</p>
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {staffList.map((staff) => (
                <button
                  key={staff.id}
                  onClick={() => handleAssignToStaff({ id: staff.id, name: `${staff.first_name} ${staff.last_name}`, email: staff.email })}
                  disabled={assigningToStaff}
                  className="tactile-btn w-full p-3 text-left hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors border-b border-teal-100 dark:border-teal-500/20 last:border-b-0 disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-primary dark:text-white">
                        {staff.first_name} {staff.last_name}
                      </p>
                      <p className="text-xs text-primary/60 dark:text-white/60">{staff.email}</p>
                    </div>
                    {getRoleBadge(staff.role)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {onDeleteBooking && (
        <button
          onClick={onDeleteBooking}
          disabled={deleting}
          className="tactile-btn w-full py-2.5 px-4 rounded-lg border border-red-400 text-red-600 dark:text-red-400 font-medium hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center justify-center gap-2"
        >
          {deleting ? (
            <>
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Deleting...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-sm">delete</span>
              Delete Booking
            </>
          )}
        </button>
      )}

      <p className="text-xs text-center text-primary/50 dark:text-white/50">
        Use for event blocks that don't require member assignment
      </p>
    </div>
  );
}

import React from 'react';
import { MemberSearchInput } from '../../shared/MemberSearchInput';
import type { BookingMember, ManageModeRosterData, MemberMatchWarning } from './bookingSheetTypes';

interface ManageModeRosterProps {
  rosterData: ManageModeRosterData | null;
  editingPlayerCount: number;
  guestFeeDollars: number;
  unlinkingSlotId: number | null;
  removingGuestId: number | null;
  manageModeGuestForm: number | null;
  setManageModeGuestForm: (slot: number | null) => void;
  manageModeGuestData: { firstName: string; lastName: string; email: string; phone: string };
  setManageModeGuestData: (data: { firstName: string; lastName: string; email: string; phone: string }) => void;
  isAddingManageGuest: boolean;
  memberMatchWarning: MemberMatchWarning | null;
  setMemberMatchWarning: (warning: MemberMatchWarning | null) => void;
  manageModeSearchSlot: number | null;
  setManageModeSearchSlot: (slot: number | null) => void;
  isLinkingMember: boolean;
  isConferenceRoom: boolean;
  handleManageModeRemoveGuest: (guestId: number) => Promise<void>;
  handleManageModeUnlinkMember: (slotId: number) => Promise<void>;
  handleManageModeLinkMember: (slotId: number, memberEmail: string) => Promise<void>;
  handleManageModeAddGuest: (slotNumber: number, forceAddAsGuest?: boolean) => Promise<void>;
  handleManageModeMemberMatchResolve: (action: 'member' | 'guest') => Promise<void>;
  handleManageModeQuickAddGuest: (slotNumber: number) => Promise<void>;
  isQuickAddingGuest: boolean;
  renderTierBadge: (tier: string | null | undefined, membershipStatus?: string | null) => React.ReactNode;
  isReassigningOwner: boolean;
  reassignSearchOpen: boolean;
  setReassignSearchOpen: (open: boolean) => void;
  handleReassignOwner: (newMemberEmail: string) => Promise<void>;
  bookingId?: number;
}

export function ManageModeRoster({
  rosterData,
  editingPlayerCount,
  guestFeeDollars,
  unlinkingSlotId,
  removingGuestId,
  manageModeGuestForm,
  setManageModeGuestForm,
  manageModeGuestData,
  setManageModeGuestData,
  isAddingManageGuest,
  memberMatchWarning,
  setMemberMatchWarning,
  manageModeSearchSlot,
  setManageModeSearchSlot,
  isLinkingMember,
  isConferenceRoom,
  handleManageModeRemoveGuest,
  handleManageModeUnlinkMember,
  handleManageModeLinkMember,
  handleManageModeAddGuest,
  handleManageModeMemberMatchResolve,
  handleManageModeQuickAddGuest,
  isQuickAddingGuest,
  renderTierBadge,
  isReassigningOwner,
  reassignSearchOpen,
  setReassignSearchOpen,
  handleReassignOwner,
  bookingId,
}: ManageModeRosterProps) {
  const filledMembers = (rosterData?.members.filter(m => (m.userEmail || m.guestInfo) && m.slotNumber <= editingPlayerCount) || []);
  const emptySlotNumbers: number[] = [];
  if (rosterData?.members) {
    for (const m of rosterData.members) {
      if (!m.userEmail && !m.guestInfo && m.slotNumber <= editingPlayerCount) {
        emptySlotNumbers.push(m.slotNumber);
      }
    }
  }

  const renderManageModeSlot = (member: BookingMember, index: number) => {
    const isOwner = member.isPrimary;
    const isUnlinking = unlinkingSlotId === member.id;
    const isGuestSlot = !!member.guestInfo;
    const isRemoving = isGuestSlot && removingGuestId === member.guestInfo?.guestId;
    const showGuestPassBadge = isGuestSlot && member.guestInfo?.usedGuestPass === true && member.guestInfo?.fee === 0;
    const isStaff = member.isStaff || member.tier === 'Staff';

    return (
      <div 
        key={member.id}
        className={`relative p-3 rounded-xl border transition-all duration-fast ${
          isOwner 
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700'
            : isGuestSlot
              ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700'
              : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700'
        }`}
      >
        {(isUnlinking || isRemoving) && (
          <div className="absolute inset-0 bg-white/60 dark:bg-black/40 rounded-xl flex items-center justify-center z-10">
            <span className="material-symbols-outlined animate-spin text-red-500">progress_activity</span>
            <span className="ml-2 text-sm text-red-600 dark:text-red-400">Removing...</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
              isOwner 
                ? 'bg-green-200 dark:bg-green-800 text-green-700 dark:text-green-300'
                : 'bg-primary/10 dark:bg-white/10 text-primary/60 dark:text-white/60'
            }`}>
              {member.slotNumber}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium text-sm text-primary dark:text-white truncate">
                  {isGuestSlot ? member.guestInfo?.guestName : member.memberName}
                </p>
                {isOwner && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 rounded">
                    Owner
                  </span>
                )}
                {renderTierBadge(member.tier, member.membershipStatus)}
                {isGuestSlot && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 rounded">
                    Guest
                  </span>
                )}
                {showGuestPassBadge && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 rounded flex items-center gap-0.5">
                    <span className="material-symbols-outlined text-[10px]">redeem</span>
                    Guest Pass Used
                  </span>
                )}
              </div>
              <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                {isGuestSlot ? member.guestInfo?.guestEmail : member.userEmail}
              </p>
              {isStaff ? (
                <p className="text-xs text-blue-600 dark:text-blue-400">$0.00 — Staff — included</p>
              ) : member.fee > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ${member.fee.toFixed(2)} — {member.feeNote}
                </p>
              ) : member.fee === 0 && member.feeNote ? (
                <p className="text-xs text-green-600 dark:text-green-400">{member.feeNote}</p>
              ) : null}
            </div>
          </div>
          {isOwner ? (
            <button
              onClick={() => setReassignSearchOpen(!reassignSearchOpen)}
              className="p-2.5 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 active:bg-blue-200 dark:active:bg-blue-900/50 text-blue-500 transition-colors flex-shrink-0"
              title="Reassign Owner"
            >
              <span className="material-symbols-outlined text-base">swap_horiz</span>
            </button>
          ) : (
            <button
              onClick={() => {
                if (isGuestSlot && member.guestInfo) {
                  handleManageModeRemoveGuest(member.guestInfo.guestId);
                } else {
                  handleManageModeUnlinkMember(member.id);
                }
              }}
              disabled={isUnlinking || isRemoving}
              className="p-2.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 active:bg-red-200 dark:active:bg-red-900/50 text-red-500 transition-colors flex-shrink-0 disabled:opacity-50"
              title="Remove"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          )}
        </div>
        {isOwner && reassignSearchOpen && (
          <div className="mt-2 pt-2 border-t border-green-200 dark:border-green-700">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-primary/60 dark:text-white/60">Search new owner</span>
              <button onClick={() => setReassignSearchOpen(false)} className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
            <MemberSearchInput
              placeholder="Search member..."
              onSelect={(selected) => handleReassignOwner(selected.email)}
              showTier={true}
              autoFocus={true}
              includeVisitors={true}
              disabled={isReassigningOwner}
            />
            {isReassigningOwner && (
              <div className="flex items-center justify-center gap-2 mt-2 text-sm text-primary/50 dark:text-white/50">
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Reassigning...
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderManageModeEmptySlot = (slotNumber: number) => {
    const isSearching = manageModeSearchSlot === slotNumber;
    const isGuestForm = manageModeGuestForm === slotNumber;
    const memberSlot = rosterData?.members.find(m => m.slotNumber === slotNumber);

    if (isGuestForm) {
      return (
        <div key={`empty-${slotNumber}`} className="p-3 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-900/10 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary/10 dark:bg-white/10 text-primary/60 dark:text-white/60">
                {slotNumber}
              </div>
              <span className="text-xs font-medium text-primary dark:text-white">New Guest</span>
            </div>
            <button
              onClick={() => {
                setManageModeGuestForm(null);
                setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
                setMemberMatchWarning(null);
              }}
              className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="First Name *"
              value={manageModeGuestData.firstName}
              onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, firstName: e.target.value })}
              className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
            />
            <input
              type="text"
              placeholder="Last Name *"
              value={manageModeGuestData.lastName}
              onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, lastName: e.target.value })}
              className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
            />
          </div>
          <input
            type="email"
            placeholder="Email Address *"
            value={manageModeGuestData.email}
            onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, email: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
          />
          <input
            type="tel"
            placeholder="Phone (optional)"
            value={manageModeGuestData.phone}
            onChange={(e) => setManageModeGuestData({ ...manageModeGuestData, phone: e.target.value })}
            className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
          />

          {memberMatchWarning && memberMatchWarning.slotNumber === slotNumber && (
            <div className="p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-500/30 rounded-lg space-y-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">warning</span>
                This email matches an existing member
              </p>
              <p className="text-xs text-primary/70 dark:text-white/70">
                {memberMatchWarning.memberMatch.name} ({memberMatchWarning.memberMatch.tier}) — {memberMatchWarning.memberMatch.note}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleManageModeMemberMatchResolve('member')}
                  className="tactile-btn flex-1 py-1.5 px-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
                >
                  Add as Member
                </button>
                <button
                  onClick={() => handleManageModeMemberMatchResolve('guest')}
                  className="tactile-btn flex-1 py-1.5 px-2 rounded-lg border border-amber-500 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors"
                >
                  Add as Guest Anyway
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => handleManageModeAddGuest(slotNumber)}
            disabled={!manageModeGuestData.firstName || !manageModeGuestData.lastName || !manageModeGuestData.email || isAddingManageGuest}
            className="tactile-btn w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
          >
            {isAddingManageGuest ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Adding...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">person_add</span>
                Add Guest
              </>
            )}
          </button>
        </div>
      );
    }

    if (isSearching) {
      return (
        <div key={`empty-${slotNumber}`} className="p-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary/10 dark:bg-white/10 text-primary/60 dark:text-white/60">
                {slotNumber}
              </div>
              <span className="text-xs font-medium text-primary/60 dark:text-white/60">Search Member</span>
            </div>
            <button
              onClick={() => setManageModeSearchSlot(null)}
              className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          <MemberSearchInput
            placeholder="Search member..."
            onSelect={(selected) => {
              if (memberSlot) {
                handleManageModeLinkMember(memberSlot.id, selected.email);
              }
            }}
            showTier={true}
            autoFocus={true}
            includeVisitors={true}
            disabled={isLinkingMember}
          />
          {isLinkingMember && (
            <div className="flex items-center justify-center gap-2 text-sm text-primary/50 dark:text-white/50">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Linking...
            </div>
          )}
        </div>
      );
    }

    return (
      <div key={`empty-${slotNumber}`} className="p-3 rounded-xl border-2 border-dashed border-primary/20 dark:border-white/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary/10 dark:bg-white/10 text-primary/40 dark:text-white/40">
              {slotNumber}
            </div>
            <div>
              <p className="text-sm text-primary/50 dark:text-white/50">Empty Slot</p>
              <p className={`text-xs ${rosterData?.financialSummary?.allPaid ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {rosterData?.financialSummary?.allPaid ? `$${guestFeeDollars} — Paid` : `$${guestFeeDollars} fee applies`}
              </p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                setManageModeSearchSlot(slotNumber);
                setManageModeGuestForm(null);
              }}
              className="tactile-btn py-1 px-2 rounded-lg border border-blue-500 text-blue-600 dark:text-blue-400 text-xs font-medium hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-xs">search</span>
              Search
            </button>
            <button
              onClick={() => {
                setManageModeGuestForm(slotNumber);
                setManageModeSearchSlot(null);
                setManageModeGuestData({ firstName: '', lastName: '', email: '', phone: '' });
              }}
              className="tactile-btn py-1 px-2 rounded-lg border border-amber-500 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-xs">person_add</span>
              New Guest
            </button>
          </div>
        </div>
        <button
          onClick={() => handleManageModeQuickAddGuest(slotNumber)}
          disabled={isQuickAddingGuest}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-xl font-semibold text-sm transition-all duration-fast active:scale-[0.98] border border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 tactile-btn"
        >
          {isQuickAddingGuest ? (
            <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <span className="material-symbols-outlined text-lg">person_add</span>
              Quick Add Guest (+${guestFeeDollars})
            </>
          )}
        </button>
      </div>
    );
  };

  if (isConferenceRoom) {
    if (filledMembers.length > 0) {
      return (
        <div className="space-y-2">
          {filledMembers.filter(m => m.isPrimary).map((member, idx) => renderManageModeSlot(member, idx))}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="space-y-2">
      {filledMembers.map((member, idx) => renderManageModeSlot(member, idx))}
      {emptySlotNumbers.map(slotNum => renderManageModeEmptySlot(slotNum))}
    </div>
  );
}

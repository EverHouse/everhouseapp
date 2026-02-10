import React from 'react';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';
import type { SlotState, SlotsArray, VisitorSearchResult } from './useUnifiedBookingLogic';

interface AssignModeSlotsProps {
  slots: SlotsArray;
  activeSlotIndex: number | null;
  setActiveSlotIndex: (index: number | null) => void;
  showAddVisitor: boolean;
  setShowAddVisitor: (show: boolean) => void;
  visitorData: { firstName: string; lastName: string; email: string; visitorType: string };
  setVisitorData: (data: { firstName: string; lastName: string; email: string; visitorType: string }) => void;
  isCreatingVisitor: boolean;
  visitorSearch: string;
  setVisitorSearch: (search: string) => void;
  visitorSearchResults: VisitorSearchResult[];
  isSearchingVisitors: boolean;
  potentialDuplicates: Array<{id: string; email: string; name: string}>;
  isCheckingDuplicates: boolean;
  guestFeeDollars: number;
  isLegacyReview?: boolean;
  isLessonOrStaffBlock: boolean;
  isConferenceRoom: boolean;
  filledSlotsCount: number;
  guestCount: number;
  updateSlot: (index: number, slotState: SlotState) => void;
  clearSlot: (index: number) => void;
  handleMemberSelect: (member: SelectedMember, slotIndex: number) => void;
  handleAddGuestPlaceholder: (slotIndex: number) => void;
  handleSelectExistingVisitor: (visitor: VisitorSearchResult) => void;
  handleCreateVisitorAndAssign: () => Promise<void>;
  renderTierBadge: (tier: string | null | undefined) => React.ReactNode;
}

export function AssignModeSlots({
  slots,
  activeSlotIndex,
  setActiveSlotIndex,
  showAddVisitor,
  setShowAddVisitor,
  visitorData,
  setVisitorData,
  isCreatingVisitor,
  visitorSearch,
  setVisitorSearch,
  visitorSearchResults,
  isSearchingVisitors,
  potentialDuplicates,
  isCheckingDuplicates,
  guestFeeDollars,
  isLegacyReview,
  isLessonOrStaffBlock,
  isConferenceRoom,
  filledSlotsCount,
  guestCount,
  updateSlot,
  clearSlot,
  handleMemberSelect,
  handleAddGuestPlaceholder,
  handleSelectExistingVisitor,
  handleCreateVisitorAndAssign,
  renderTierBadge,
}: AssignModeSlotsProps) {
  const renderSlot = (slotIndex: number, isOwnerSlot: boolean) => {
    const slot = slots[slotIndex];
    const isActive = activeSlotIndex === slotIndex;
    
    if (slot.type !== 'empty') {
      return (
        <div className={`p-3 rounded-xl border ${isOwnerSlot ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                slot.type === 'guest_placeholder' ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-green-100 dark:bg-green-900/40'
              }`}>
                <span className={`material-symbols-outlined text-sm ${
                  slot.type === 'guest_placeholder' ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'
                }`}>
                  {slot.type === 'guest_placeholder' ? 'person_add' : 'person'}
                </span>
              </div>
              <div>
                <p className="font-medium text-sm text-primary dark:text-white">
                  {slot.type === 'guest_placeholder' ? slot.guestName : slot.member?.name}
                </p>
                {slot.member?.email && (
                  <p className="text-xs text-primary/60 dark:text-white/60">{slot.member.email}</p>
                )}
                {slot.member?.tier === 'Staff' ? (
                  <p className="text-xs text-blue-600 dark:text-blue-400">$0.00 — Staff — included</p>
                ) : slot.type === 'guest_placeholder' ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{`Guest fee: $${guestFeeDollars}`}</p>
                ) : null}
              </div>
            </div>
            <button
              onClick={() => clearSlot(slotIndex)}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 transition-colors"
              title="Remove"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        </div>
      );
    }

    if (isActive) {
      if (showAddVisitor) {
        return (
          <div className="p-3 rounded-xl border border-green-200 dark:border-green-700 bg-green-50/50 dark:bg-green-900/10 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm text-primary dark:text-white">Create New Visitor</h4>
              <button
                onClick={() => {
                  setShowAddVisitor(false);
                  setVisitorData({ firstName: '', lastName: '', email: '', visitorType: 'guest' });
                  setVisitorSearch('');
                }}
                className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            <div>
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="First Name *"
                    value={visitorData.firstName}
                    onChange={(e) => setVisitorData({ ...visitorData, firstName: e.target.value })}
                    className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Last Name *"
                    value={visitorData.lastName}
                    onChange={(e) => setVisitorData({ ...visitorData, lastName: e.target.value })}
                    className="px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
                  />
                </div>
                <input
                  type="email"
                  placeholder="Email Address *"
                  value={visitorData.email}
                  onChange={(e) => setVisitorData({ ...visitorData, email: e.target.value })}
                  className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-xs"
                />
                <div>
                  <label className="block text-xs text-primary/70 dark:text-white/70 mb-1">Visitor Type *</label>
                  <select
                    value={visitorData.visitorType}
                    onChange={(e) => setVisitorData({ ...visitorData, visitorType: e.target.value })}
                    className={`w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border text-primary dark:text-white text-xs ${
                      visitorData.visitorType ? 'border-primary/20 dark:border-white/20' : 'border-red-300 dark:border-red-500/50'
                    }`}
                    required
                  >
                    <option value="">Select visitor type...</option>
                    <option value="guest">Guest</option>
                    <option value="day_pass">Day Pass</option>
                    <option value="sim_walkin">Simulator Walk-in</option>
                    <option value="golfnow">GolfNow</option>
                    <option value="classpass">ClassPass</option>
                    <option value="private_lesson">Private Lesson</option>
                    <option value="lead">Lead</option>
                  </select>
                  {!visitorData.visitorType && visitorData.email && (
                    <p className="text-xs text-red-500 mt-0.5">Please select a visitor type</p>
                  )}
                </div>
              </div>
            </div>

            {potentialDuplicates.length > 0 && (
              <div className="p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-1">
                  <span className="material-symbols-outlined text-sm">warning</span>
                  Possible duplicate found
                </p>
                <div className="space-y-1">
                  {potentialDuplicates.map((dup) => (
                    <button
                      key={dup.id}
                      onClick={() => {
                        if (activeSlotIndex !== null) {
                          updateSlot(activeSlotIndex, {
                            type: 'visitor',
                            member: { id: dup.id, email: dup.email, name: dup.name }
                          });
                          setShowAddVisitor(false);
                          setVisitorData({ firstName: '', lastName: '', email: '', visitorType: '' });
                          setActiveSlotIndex(null);
                        }
                      }}
                      className="w-full p-1.5 text-left rounded-lg bg-white dark:bg-white/5 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors border border-amber-200 dark:border-amber-500/20"
                    >
                      <p className="text-xs font-medium text-primary dark:text-white">{dup.name}</p>
                      <p className="text-xs text-primary/60 dark:text-white/60">{dup.email}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Click to use existing record instead</p>
              </div>
            )}

            <button
              onClick={handleCreateVisitorAndAssign}
              disabled={!visitorData.email || !visitorData.firstName || !visitorData.lastName || !visitorData.visitorType || isCreatingVisitor}
              className="w-full py-2 px-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
            >
              {isCreatingVisitor ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Creating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">add_circle</span>
                  Create & Add
                </>
              )}
            </button>
          </div>
        );
      }

      return (
        <div className="p-3 rounded-xl border border-primary/20 dark:border-white/20 bg-white/50 dark:bg-white/5 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-primary/60 dark:text-white/60">
              {isOwnerSlot ? 'Select Owner (Required)' : `Player ${slotIndex + 1}`}
            </span>
            <button
              onClick={() => setActiveSlotIndex(null)}
              className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          
          <MemberSearchInput
            placeholder="Search..."
            onSelect={(member) => handleMemberSelect(member, slotIndex)}
            showTier={true}
            autoFocus={true}
            includeVisitors={true}
          />
          
          <div className="flex gap-2 pt-1">
            {!isOwnerSlot && (
              <button
                onClick={() => handleAddGuestPlaceholder(slotIndex)}
                className="flex-1 py-1.5 px-2 rounded-lg border border-amber-500 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors flex items-center justify-center gap-1"
              >
                <span className="material-symbols-outlined text-sm">person_add</span>
                Add Guest
              </button>
            )}
            <button
              onClick={() => setShowAddVisitor(true)}
              className="flex-1 py-1.5 px-2 rounded-lg border border-green-500 text-green-600 dark:text-green-400 text-xs font-medium hover:bg-green-50 dark:hover:bg-green-500/10 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">person_add</span>
              New Visitor
            </button>
          </div>
        </div>
      );
    }

    return (
      <button
        onClick={() => setActiveSlotIndex(slotIndex)}
        className={`w-full p-3 rounded-xl border-2 border-dashed transition-colors text-left ${
          isOwnerSlot 
            ? 'border-amber-300 dark:border-amber-600 hover:border-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-900/10'
            : 'border-primary/20 dark:border-white/20 hover:border-primary/40 dark:hover:border-white/40 hover:bg-primary/5 dark:hover:bg-white/5'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            isOwnerSlot ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-primary/10 dark:bg-white/10'
          }`}>
            <span className={`material-symbols-outlined text-sm ${
              isOwnerSlot ? 'text-amber-600 dark:text-amber-400' : 'text-primary/40 dark:text-white/40'
            }`}>add</span>
          </div>
          <div>
            <p className={`font-medium text-sm ${isOwnerSlot ? 'text-amber-700 dark:text-amber-400' : 'text-primary/60 dark:text-white/60'}`}>
              {isOwnerSlot ? 'Add Owner (Required)' : `Add Player ${slotIndex + 1}`}
            </p>
            <p className="text-xs text-primary/40 dark:text-white/40">
              {isOwnerSlot ? 'Search member or add visitor' : 'Member or guest'}
            </p>
          </div>
        </div>
      </button>
    );
  };

  if (isConferenceRoom) {
    return (
      <div className="space-y-3">
        <h4 className="font-medium text-primary dark:text-white">Assign To</h4>
        <div>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-1 font-medium">Owner (Required)</p>
          {renderSlot(0, true)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-primary dark:text-white">Player Slots</h4>
        {filledSlotsCount > 0 && (
          <span className="text-xs text-primary/60 dark:text-white/60">
            {filledSlotsCount} player{filledSlotsCount !== 1 ? 's' : ''}
            {guestCount > 0 && ` (${guestCount} guest${guestCount !== 1 ? 's' : ''} = $${guestCount * guestFeeDollars})`}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <div>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-1 font-medium">Slot 1: Owner (Required)</p>
          {renderSlot(0, true)}
        </div>
        
        {!isLessonOrStaffBlock && (
          <div className="border-t border-primary/10 dark:border-white/10 pt-2">
            <p className="text-xs text-primary/50 dark:text-white/50 mb-1">Additional Players (Optional)</p>
            {isLegacyReview ? (
              <p className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-500/10 p-2 rounded-lg">
                Add additional players after assigning the owner. This booking needs review first.
              </p>
            ) : (
              <div className="space-y-2">
                {[1, 2, 3].map(index => (
                  <div key={index}>
                    {renderSlot(index, false)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {!isLessonOrStaffBlock && slots.slice(1).some(s => s.type === 'empty') && (
        <button
          onClick={() => {
            const emptyIndex = slots.findIndex((s, i) => i > 0 && s.type === 'empty');
            if (emptyIndex > 0) handleAddGuestPlaceholder(emptyIndex);
          }}
          className="w-full py-2 px-3 rounded-lg border-2 border-dashed border-amber-300 dark:border-amber-600 text-amber-600 dark:text-amber-400 font-medium text-sm hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-sm">person_add</span>
          {`Quick Add Guest (+$${guestFeeDollars})`}
        </button>
      )}
    </div>
  );
}

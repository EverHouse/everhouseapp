import { useState, useEffect } from 'react';
import { ModalShell } from '../../ModalShell';
import TrackmanIcon from '../../icons/TrackmanIcon';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';
import { useToast } from '../../Toast';

interface TrackmanLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  trackmanBookingId: string | null;
  bayName?: string;
  bookingDate?: string;
  timeSlot?: string;
  matchedBookingId?: number | string;
  currentMemberName?: string;
  currentMemberEmail?: string;
  isRelink?: boolean;
  onSuccess?: () => void;
  onOpenBillingModal?: (bookingId: number) => void;
  importedName?: string;
  notes?: string;
  isLegacyReview?: boolean;
}

interface VisitorSearchResult {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name?: string;
}

interface SlotState {
  type: 'empty' | 'member' | 'guest_placeholder' | 'visitor';
  member?: { id: string; email: string; name: string; tier?: string | null };
  guestName?: string;
}

type SlotsArray = [SlotState, SlotState, SlotState, SlotState];

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
  onSuccess,
  onOpenBillingModal,
  importedName,
  notes,
  isLegacyReview
}: TrackmanLinkModalProps) {
  const [slots, setSlots] = useState<SlotsArray>([
    { type: 'empty' },
    { type: 'empty' },
    { type: 'empty' },
    { type: 'empty' }
  ]);
  const [activeSlotIndex, setActiveSlotIndex] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const [markingAsEvent, setMarkingAsEvent] = useState(false);
  const [showAddVisitor, setShowAddVisitor] = useState(false);
  const [visitorData, setVisitorData] = useState({ firstName: '', lastName: '', email: '', visitorType: 'guest' as string });
  const [isCreatingVisitor, setIsCreatingVisitor] = useState(false);
  const [visitorSearch, setVisitorSearch] = useState('');
  const [visitorSearchResults, setVisitorSearchResults] = useState<VisitorSearchResult[]>([]);
  const [isSearchingVisitors, setIsSearchingVisitors] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (!isOpen) {
      setSlots([
        { type: 'empty' },
        { type: 'empty' },
        { type: 'empty' },
        { type: 'empty' }
      ]);
      setActiveSlotIndex(null);
      setLinking(false);
      setMarkingAsEvent(false);
      setShowAddVisitor(false);
      setVisitorData({ firstName: '', lastName: '', email: '', visitorType: 'guest' });
      setVisitorSearch('');
      setVisitorSearchResults([]);
    }
  }, [isOpen]);

  useEffect(() => {
    const searchVisitors = async () => {
      if (!visitorSearch || visitorSearch.length < 2) {
        setVisitorSearchResults([]);
        return;
      }
      setIsSearchingVisitors(true);
      try {
        const res = await fetch(`/api/visitors/search?query=${encodeURIComponent(visitorSearch)}&limit=10`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setVisitorSearchResults(data);
        }
      } catch (err) {
        console.error('Visitor search error:', err);
      } finally {
        setIsSearchingVisitors(false);
      }
    };
    const timeoutId = setTimeout(searchVisitors, 300);
    return () => clearTimeout(timeoutId);
  }, [visitorSearch]);

  const updateSlot = (index: number, slotState: SlotState) => {
    setSlots(prev => {
      const newSlots = [...prev] as SlotsArray;
      newSlots[index] = slotState;
      return newSlots;
    });
  };

  const clearSlot = (index: number) => {
    updateSlot(index, { type: 'empty' });
  };

  const handleMemberSelect = (member: SelectedMember, slotIndex: number) => {
    updateSlot(slotIndex, {
      type: 'member',
      member: {
        id: member.id,
        email: member.email,
        name: member.name,
        tier: member.tier
      }
    });
    setActiveSlotIndex(null);
  };

  const handleAddGuestPlaceholder = (slotIndex: number) => {
    updateSlot(slotIndex, {
      type: 'guest_placeholder',
      guestName: 'Guest (info pending)'
    });
    setActiveSlotIndex(null);
  };

  const handleSelectExistingVisitor = (visitor: VisitorSearchResult) => {
    if (activeSlotIndex === null) return;
    updateSlot(activeSlotIndex, {
      type: 'visitor',
      member: {
        id: visitor.id,
        email: visitor.email,
        name: visitor.name || `${visitor.firstName} ${visitor.lastName}`.trim()
      }
    });
    setShowAddVisitor(false);
    setVisitorSearch('');
    setVisitorSearchResults([]);
    setActiveSlotIndex(null);
  };

  const handleCreateVisitorAndAssign = async () => {
    if (!visitorData.email || !visitorData.firstName || !visitorData.lastName || activeSlotIndex === null) return;
    
    setIsCreatingVisitor(true);
    try {
      const createRes = await fetch('/api/visitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: visitorData.email,
          firstName: visitorData.firstName,
          lastName: visitorData.lastName,
          visitorType: visitorData.visitorType,
          createStripeCustomer: true
        })
      });
      
      if (!createRes.ok) {
        const errorData = await createRes.json();
        if (createRes.status === 409 && errorData.existingUser) {
          showToast(`User already exists: ${errorData.existingUser.name || errorData.existingUser.email}`, 'error');
        } else {
          showToast(errorData.error || 'Failed to create visitor', 'error');
        }
        setIsCreatingVisitor(false);
        return;
      }
      
      const data = await createRes.json();
      if (data.stripeCreated) {
        showToast(`Created visitor: ${data.visitor.firstName} ${data.visitor.lastName}`, 'success');
      } else {
        showToast(`Created visitor but Stripe setup failed - can add later`, 'warning');
      }
      
      updateSlot(activeSlotIndex, {
        type: 'visitor',
        member: {
          id: data.visitor.id,
          email: data.visitor.email,
          name: `${data.visitor.firstName} ${data.visitor.lastName}`
        }
      });
      
      setShowAddVisitor(false);
      setVisitorData({ firstName: '', lastName: '', email: '', visitorType: 'guest' });
      setActiveSlotIndex(null);
    } catch (err: any) {
      showToast(err.message || 'Failed to create visitor', 'error');
    } finally {
      setIsCreatingVisitor(false);
    }
  };

  const ownerSlot = slots[0];
  const hasOwner = ownerSlot.type !== 'empty';
  const filledSlotsCount = slots.filter(s => s.type !== 'empty').length;
  const guestCount = slots.filter(s => s.type === 'guest_placeholder').length;

  const handleFinalizeBooking = async () => {
    if (!hasOwner || linking) return;
    
    setLinking(true);
    try {
      const owner = ownerSlot.member!;
      const additionalPlayers = slots.slice(1).filter(s => s.type !== 'empty').map(s => {
        if (s.type === 'member' || s.type === 'visitor') {
          return {
            type: 'member' as const,
            member_id: s.member!.id,
            email: s.member!.email,
            name: s.member!.name
          };
        } else {
          return {
            type: 'guest_placeholder' as const,
            guest_name: s.guestName || 'Guest (info pending)'
          };
        }
      });

      let feesRecalculated = false;
      let resultBookingId = matchedBookingId;

      if (isLegacyReview && matchedBookingId) {
        // Resolve legacy requires-review booking from trackman_unmatched_bookings table
        // Extract numeric ID from string or use as-is if already numeric
        let numericId: number;
        if (typeof matchedBookingId === 'string') {
          numericId = parseInt(matchedBookingId.replace('review-', ''), 10);
        } else {
          numericId = matchedBookingId;
        }
        
        if (isNaN(numericId)) {
          throw new Error('Invalid booking ID for legacy resolution');
        }
        
        const res = await fetch(`/api/admin/trackman/unmatched/${numericId}/resolve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            memberEmail: owner.email,
            rememberEmail: true
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to resolve booking');
        }
        const data = await res.json();
        feesRecalculated = data.feesRecalculated === true;
        if (data.booking?.id) {
          // Ensure resultBookingId is numeric for billing modal
          resultBookingId = typeof data.booking.id === 'number' ? data.booking.id : parseInt(data.booking.id, 10);
        }
      } else if (matchedBookingId && !isLegacyReview) {
        const res = await fetch(`/api/bookings/${matchedBookingId}/assign-with-players`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            owner: {
              email: owner.email,
              name: owner.name,
              member_id: owner.id
            },
            additional_players: additionalPlayers
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to assign member to booking');
        }
        const data = await res.json();
        feesRecalculated = data.feesRecalculated === true;
      } else if (trackmanBookingId) {
        const res = await fetch('/api/bookings/link-trackman-to-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            trackman_booking_id: trackmanBookingId,
            owner: {
              email: owner.email,
              name: owner.name,
              member_id: owner.id
            },
            additional_players: additionalPlayers
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to link booking to member');
        }
        const data = await res.json();
        feesRecalculated = data.feesRecalculated === true;
        if (data.bookingId) {
          resultBookingId = data.bookingId;
        }
      }
      
      if (isLegacyReview) {
        showToast(`Booking resolved and assigned to ${owner.name}`, 'success');
      } else {
        showToast(`Booking assigned with ${filledSlotsCount} player${filledSlotsCount > 1 ? 's' : ''}${guestCount > 0 ? ` (${guestCount} guest${guestCount > 1 ? 's' : ''})` : ''}`, 'success');
      }
      onSuccess?.();
      onClose();
      
      if (feesRecalculated && resultBookingId && onOpenBillingModal) {
        // Ensure numeric ID for billing modal
        const numericBookingId = typeof resultBookingId === 'number' 
          ? resultBookingId 
          : parseInt(String(resultBookingId).replace('review-', ''), 10);
        if (!isNaN(numericBookingId)) {
          setTimeout(() => {
            onOpenBillingModal(numericBookingId);
          }, 300);
        }
      }
    } catch (err: any) {
      showToast(err.message || 'Failed to assign booking', 'error');
    } finally {
      setLinking(false);
    }
  };

  const handleMarkAsEvent = async () => {
    if (markingAsEvent) return;
    
    setMarkingAsEvent(true);
    try {
      const bookingId = matchedBookingId;
      if (!bookingId && !trackmanBookingId) {
        throw new Error('No booking to mark as event');
      }

      const res = await fetch('/api/bookings/mark-as-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          booking_id: bookingId,
          trackman_booking_id: trackmanBookingId
        })
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.message || 'Failed to mark as event');
      }
      
      showToast('Booking marked as private event', 'success');
      onSuccess?.();
      onClose();
    } catch (err: any) {
      showToast(err.message || 'Failed to mark as event', 'error');
    } finally {
      setMarkingAsEvent(false);
    }
  };

  if (!trackmanBookingId && !matchedBookingId) return null;

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
                {slot.type === 'guest_placeholder' && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">Guest fee: $25</p>
                )}
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
              <h4 className="font-medium text-sm text-primary dark:text-white">Add Visitor</h4>
              <button
                onClick={() => {
                  setShowAddVisitor(false);
                  setVisitorData({ firstName: '', lastName: '', email: '', visitorType: 'guest' });
                  setVisitorSearch('');
                  setVisitorSearchResults([]);
                }}
                className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-primary dark:text-white mb-1">
                Search Existing Visitors
              </label>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-primary/40 dark:text-white/40 text-sm">search</span>
                <input
                  type="text"
                  placeholder="Search visitors..."
                  value={visitorSearch}
                  onChange={(e) => setVisitorSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-sm"
                />
              </div>
              {isSearchingVisitors && <p className="text-xs text-primary/50 dark:text-white/50 mt-1">Searching...</p>}
              {visitorSearchResults.length > 0 && (
                <div className="mt-2 max-h-24 overflow-y-auto space-y-1 border border-primary/10 dark:border-white/20 rounded-lg p-1">
                  {visitorSearchResults.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => handleSelectExistingVisitor(v)}
                      className="w-full p-2 text-left rounded-lg hover:bg-primary/5 dark:hover:bg-white/10 transition-colors"
                    >
                      <p className="font-medium text-xs text-primary dark:text-white">
                        {v.firstName} {v.lastName}
                      </p>
                      <p className="text-xs text-primary/60 dark:text-white/60">{v.email}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-primary/10 dark:border-white/20 pt-3">
              <p className="text-xs font-medium text-primary dark:text-white mb-2">Or Create New Visitor</p>
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
                  <label className="block text-xs text-primary/70 dark:text-white/70 mb-1">Visitor Type</label>
                  <select
                    value={visitorData.visitorType}
                    onChange={(e) => setVisitorData({ ...visitorData, visitorType: e.target.value })}
                    className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white text-xs"
                  >
                    <option value="guest">Guest</option>
                    <option value="day_pass">Day Pass</option>
                    <option value="sim_walkin">Simulator Walk-in</option>
                    <option value="golfnow">GolfNow</option>
                    <option value="classpass">ClassPass</option>
                    <option value="private_lesson">Private Lesson</option>
                    <option value="lead">Lead</option>
                  </select>
                </div>
              </div>
            </div>

            <button
              onClick={handleCreateVisitorAndAssign}
              disabled={!visitorData.email || !visitorData.firstName || !visitorData.lastName || isCreatingVisitor}
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
            placeholder="Search member..."
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
              Add Visitor
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

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <TrackmanIcon size={20} />
          <span>{isRelink && currentMemberName ? 'Change Booking Owner' : 'Assign Players to Booking'}</span>
        </div>
      }
      size="lg"
      overflowVisible={true}
    >
      <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
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
          <div className="grid grid-cols-2 gap-2 text-sm text-amber-700 dark:text-amber-400">
            {importedName && (
              <p className="flex items-center gap-1 col-span-2 font-semibold">
                <span className="material-symbols-outlined text-sm">person</span>
                {importedName}
              </p>
            )}
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

        {notes && (
          <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">notes</span>
              Notes from Import
            </p>
            <p className="text-sm text-blue-700 dark:text-blue-400 whitespace-pre-wrap">{notes}</p>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-primary dark:text-white">Player Slots</h4>
            {filledSlotsCount > 0 && (
              <span className="text-xs text-primary/60 dark:text-white/60">
                {filledSlotsCount} player{filledSlotsCount !== 1 ? 's' : ''}
                {guestCount > 0 && ` (${guestCount} guest${guestCount !== 1 ? 's' : ''} = $${guestCount * 25})`}
              </span>
            )}
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-xs text-amber-600 dark:text-amber-400 mb-1 font-medium">Slot 1: Owner (Required)</p>
              {renderSlot(0, true)}
            </div>
            
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
          </div>
        </div>

        <div className="pt-4 border-t border-primary/10 dark:border-white/10 space-y-2">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleFinalizeBooking}
              disabled={!hasOwner || linking}
              className="flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white"
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

          <button
            onClick={handleMarkAsEvent}
            disabled={markingAsEvent}
            className="w-full py-2.5 px-4 rounded-lg border border-purple-500 text-purple-600 dark:text-purple-400 font-medium hover:bg-purple-50 dark:hover:bg-purple-500/10 transition-colors flex items-center justify-center gap-2"
          >
            {markingAsEvent ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Marking...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">event</span>
                Mark as Private Event
              </>
            )}
          </button>
          <p className="text-xs text-center text-primary/50 dark:text-white/50">
            Use for event blocks that don't require member assignment
          </p>
        </div>
      </div>
    </ModalShell>
  );
}

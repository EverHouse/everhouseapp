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
  matchedBookingId?: number;
  currentMemberName?: string;
  currentMemberEmail?: string;
  isRelink?: boolean;
  onSuccess?: () => void;
  onVisitorAssigned?: (bookingId: number) => void;
}

interface VisitorSearchResult {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name?: string;
}

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
  onVisitorAssigned
}: TrackmanLinkModalProps) {
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [linking, setLinking] = useState(false);
  const [showAddVisitor, setShowAddVisitor] = useState(false);
  const [visitorData, setVisitorData] = useState({ firstName: '', lastName: '', email: '' });
  const [isCreatingVisitor, setIsCreatingVisitor] = useState(false);
  const [visitorSearch, setVisitorSearch] = useState('');
  const [visitorSearchResults, setVisitorSearchResults] = useState<VisitorSearchResult[]>([]);
  const [isSearchingVisitors, setIsSearchingVisitors] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (!isOpen) {
      setSelectedMember(null);
      setLinking(false);
      setShowAddVisitor(false);
      setVisitorData({ firstName: '', lastName: '', email: '' });
      setVisitorSearch('');
      setVisitorSearchResults([]);
    }
  }, [isOpen]);

  // Search for existing visitors
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

  const handleLink = async () => {
    if (!selectedMember || linking) return;
    
    setLinking(true);
    try {
      // If re-linking an existing booking OR assigning an unmatched booking with a matchedBookingId
      if (matchedBookingId) {
        const res = await fetch(`/api/bookings/${matchedBookingId}/change-owner`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            new_email: selectedMember.email,
            new_name: selectedMember.name,
            member_id: selectedMember.id
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to assign member to booking');
        }
      } else if (trackmanBookingId) {
        const res = await fetch('/api/bookings/link-trackman-to-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            trackman_booking_id: trackmanBookingId,
            member_email: selectedMember.email,
            member_name: selectedMember.name,
            member_id: selectedMember.id
          })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || data.message || 'Failed to link booking to member');
        }
      }
      
      showToast('Member assigned to booking successfully', 'success');
      onSuccess?.();
      onClose();
    } catch (err: any) {
      showToast(err.message || 'Failed to assign member', 'error');
    } finally {
      setLinking(false);
    }
  };

  const handleSelectExistingVisitor = (visitor: VisitorSearchResult) => {
    setSelectedMember({
      id: visitor.id,
      email: visitor.email,
      name: visitor.name || `${visitor.firstName} ${visitor.lastName}`.trim()
    });
    setShowAddVisitor(false);
    setVisitorSearch('');
    setVisitorSearchResults([]);
  };

  const handleCreateVisitorAndAssign = async () => {
    if (!visitorData.email || !visitorData.firstName || !visitorData.lastName) return;
    
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
      
      // Now assign the booking to this visitor
      let assignedBookingId: number | null = null;
      
      if (matchedBookingId) {
        const res = await fetch(`/api/bookings/${matchedBookingId}/change-owner`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            new_email: data.visitor.email,
            new_name: `${data.visitor.firstName} ${data.visitor.lastName}`,
            member_id: data.visitor.id
          })
        });
        if (!res.ok) {
          showToast('Visitor created but failed to assign booking', 'error');
          setIsCreatingVisitor(false);
          return;
        }
        assignedBookingId = matchedBookingId;
      } else if (trackmanBookingId) {
        const res = await fetch('/api/bookings/link-trackman-to-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            trackman_booking_id: trackmanBookingId,
            member_email: data.visitor.email,
            member_name: `${data.visitor.firstName} ${data.visitor.lastName}`,
            member_id: data.visitor.id
          })
        });
        if (!res.ok) {
          showToast('Visitor created but failed to assign booking', 'error');
          setIsCreatingVisitor(false);
          return;
        }
        const linkData = await res.json();
        assignedBookingId = linkData.booking?.id || null;
      }
      
      showToast('Visitor created and booking assigned', 'success');
      onSuccess?.();
      onClose();
      
      // Open check-in modal for visitor fee handling
      if (assignedBookingId && onVisitorAssigned) {
        onVisitorAssigned(assignedBookingId);
      }
    } catch (err: any) {
      showToast(err.message || 'Failed to create visitor', 'error');
    } finally {
      setIsCreatingVisitor(false);
    }
  };

  if (!trackmanBookingId && !matchedBookingId) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <TrackmanIcon size={20} />
          <span>{isRelink && currentMemberName ? 'Change Booking Owner' : 'Assign Member to Booking'}</span>
        </div>
      }
      size="md"
      overflowVisible={true}
    >
      <div className="p-4 space-y-4">
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
          <div className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
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

        {!showAddVisitor ? (
          <>
            <MemberSearchInput
              label="Search for Member"
              placeholder="Search by name or email..."
              selectedMember={selectedMember}
              onSelect={setSelectedMember}
              onClear={() => setSelectedMember(null)}
              showTier={true}
              autoFocus={true}
            />

            <div className="flex flex-col gap-2 pt-2">
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleLink}
                  disabled={!selectedMember || linking}
                  className={`flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${
                    isRelink && currentMemberName
                      ? 'bg-blue-500 hover:bg-blue-600 text-white' 
                      : 'bg-amber-500 hover:bg-amber-600 text-white'
                  }`}
                >
                  {linking ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                      {isRelink && currentMemberName ? 'Changing...' : 'Assigning...'}
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-sm">{isRelink && currentMemberName ? 'swap_horiz' : 'person_add'}</span>
                      {isRelink && currentMemberName ? 'Change Owner' : 'Assign Member'}
                    </>
                  )}
                </button>
              </div>
              <button
                onClick={() => setShowAddVisitor(true)}
                className="w-full py-2 px-4 rounded-lg border border-green-500 text-green-600 dark:text-green-400 font-medium hover:bg-green-50 dark:hover:bg-green-500/10 transition-colors flex items-center justify-center gap-2 text-sm"
              >
                <span className="material-symbols-outlined text-sm">person_add</span>
                Not a member? Add as Visitor
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-primary dark:text-white">Add Visitor</h4>
              <button
                onClick={() => {
                  setShowAddVisitor(false);
                  setVisitorData({ firstName: '', lastName: '', email: '' });
                  setVisitorSearch('');
                  setVisitorSearchResults([]);
                }}
                className="text-primary/50 dark:text-white/50 hover:text-primary dark:hover:text-white"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* Search existing visitors */}
            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-1.5">
                Search Existing Visitors
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-primary/40 dark:text-white/40">search</span>
                <input
                  type="text"
                  placeholder="Search visitors by name or email..."
                  value={visitorSearch}
                  onChange={(e) => setVisitorSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-sm"
                />
              </div>
              {isSearchingVisitors && (
                <p className="text-xs text-primary/50 dark:text-white/50 mt-1">Searching...</p>
              )}
              {visitorSearchResults.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto space-y-1 border border-primary/10 dark:border-white/20 rounded-lg p-1">
                  {visitorSearchResults.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => handleSelectExistingVisitor(v)}
                      className="w-full p-2 text-left rounded-lg hover:bg-primary/5 dark:hover:bg-white/10 transition-colors"
                    >
                      <p className="font-medium text-sm text-primary dark:text-white">
                        {v.firstName} {v.lastName}
                      </p>
                      <p className="text-xs text-primary/60 dark:text-white/60">{v.email}</p>
                    </button>
                  ))}
                </div>
              )}
              {visitorSearch.length >= 2 && visitorSearchResults.length === 0 && !isSearchingVisitors && (
                <p className="text-xs text-primary/50 dark:text-white/50 mt-1">No existing visitors found</p>
              )}
            </div>

            <div className="border-t border-primary/10 dark:border-white/20 pt-4">
              <p className="text-sm font-medium text-primary dark:text-white mb-3">Or Create New Visitor</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="First Name *"
                    value={visitorData.firstName}
                    onChange={(e) => setVisitorData({ ...visitorData, firstName: e.target.value })}
                    className="px-3 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Last Name *"
                    value={visitorData.lastName}
                    onChange={(e) => setVisitorData({ ...visitorData, lastName: e.target.value })}
                    className="px-3 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-sm"
                  />
                </div>
                <input
                  type="email"
                  placeholder="Email Address *"
                  value={visitorData.email}
                  onChange={(e) => setVisitorData({ ...visitorData, email: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/50 dark:placeholder:text-white/50 text-sm"
                />
                <p className="text-xs text-green-600 dark:text-green-400">
                  A Stripe account will be created for billing. Visitor will appear in Directory.
                </p>
              </div>
            </div>

            <button
              onClick={handleCreateVisitorAndAssign}
              disabled={!visitorData.email || !visitorData.firstName || !visitorData.lastName || isCreatingVisitor}
              className="w-full py-2.5 px-4 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isCreatingVisitor ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Creating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">add_circle</span>
                  Create Visitor & Assign Booking
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

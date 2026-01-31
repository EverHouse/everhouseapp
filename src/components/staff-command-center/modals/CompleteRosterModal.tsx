import React, { useState, useEffect } from 'react';
import { useToast } from '../../Toast';
import BookingMembersEditor from '../../admin/BookingMembersEditor';
import { CheckinBillingModal } from './CheckinBillingModal';
import SlideUpDrawer from '../../SlideUpDrawer';

interface BookingContext {
  bookingId: number;
  ownerName: string;
  ownerEmail: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  declaredPlayerCount: number;
  emptySlots: number;
  totalSlots: number;
}

interface CompleteRosterModalProps {
  isOpen: boolean;
  onClose: () => void;
  bookingId: number;
  onRosterComplete: () => void;
  onBillingRequired?: (bookingId: number) => void;
}

export const CompleteRosterModal: React.FC<CompleteRosterModalProps> = ({
  isOpen,
  onClose,
  bookingId,
  onRosterComplete,
  onBillingRequired
}) => {
  const { showToast } = useToast();
  const [context, setContext] = useState<BookingContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [rosterComplete, setRosterComplete] = useState(false);
  const [showBillingModal, setShowBillingModal] = useState(false);

  useEffect(() => {
    if (isOpen && bookingId) {
      fetchContext();
    }
  }, [isOpen, bookingId]);

  const fetchContext = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/booking/${bookingId}/members`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        const bookingRes = await fetch(`/api/booking-requests/${bookingId}`, {
          credentials: 'include'
        });
        let bookingDetails = null;
        if (bookingRes.ok) {
          bookingDetails = await bookingRes.json();
        }
        
        const ownerName = bookingDetails?.user_name || 'Unknown';
        const ownerEmail = bookingDetails?.user_email || '';
        
        setContext({
          bookingId,
          ownerName,
          ownerEmail,
          bookingDate: bookingDetails?.request_date || '',
          startTime: bookingDetails?.start_time || '',
          endTime: bookingDetails?.end_time || '',
          resourceName: bookingDetails?.bay_name || bookingDetails?.resource_name || '',
          declaredPlayerCount: bookingDetails?.declared_player_count || 1,
          emptySlots: data.validation?.emptySlots || 0,
          totalSlots: data.validation?.expectedPlayerCount || 1
        });
        setRosterComplete(data.validation?.emptySlots === 0);
      } else {
        setError('Failed to load booking details');
      }
    } catch (err) {
      setError('Failed to load booking details');
    } finally {
      setLoading(false);
    }
  };

  const handleMemberLinked = () => {
    fetchContext();
  };

  const handleCheckIn = async () => {
    setIsCheckingIn(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      
      if (res.ok) {
        showToast('Member checked in successfully', 'success');
        onRosterComplete();
        onClose();
      } else if (res.status === 402) {
        const data = await res.json();
        if (data.requiresRoster) {
          setError('Please assign all player slots before checking in');
          await fetchContext();
        } else {
          onClose();
          if (onBillingRequired) {
            onBillingRequired(bookingId);
          }
        }
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to check in');
      }
    } catch (err) {
      setError('Failed to check in');
    } finally {
      setIsCheckingIn(false);
    }
  };

  const formatTime = (time: string) => {
    if (!time) return '';
    const [hours, minutes] = time.split(':');
    const h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${minutes} ${ampm}`;
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const drawerTitle = context 
    ? `Complete Roster - ${context.ownerName}`
    : 'Complete Booking Details';

  const stickyFooter = (
    <div className="px-5 py-4 bg-primary/5 dark:bg-white/5">
      <div className="flex flex-col gap-2">
        <button
          onClick={handleCheckIn}
          disabled={isCheckingIn || !rosterComplete}
          className={`w-full py-3 font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors ${
            rosterComplete
              ? 'bg-green-600 text-white hover:bg-green-700'
              : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
          } disabled:opacity-50`}
        >
          <span className="material-symbols-outlined">how_to_reg</span>
          {isCheckingIn ? 'Checking In...' : rosterComplete ? 'Complete Check-In' : 'Assign All Players to Check In'}
        </button>
        <button
          onClick={onClose}
          className="w-full py-2 text-primary/70 dark:text-white/70 font-medium hover:text-primary dark:hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <>
      <SlideUpDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={drawerTitle}
        maxHeight="large"
        stickyFooter={stickyFooter}
      >
        <div className="p-5">
          <div className="mb-4 px-1">
            <p className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-lg">group_add</span>
              Please assign all player slots to proceed with check-in
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
              <p className="text-red-600 dark:text-red-400">{error}</p>
              <button onClick={fetchContext} className="mt-4 px-4 py-2 bg-primary text-white rounded-lg">
                Retry
              </button>
            </div>
          ) : context ? (
            <div className="space-y-4">
              <div className="bg-primary/5 dark:bg-white/5 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-primary/60 dark:text-white/60 mt-0.5">person</span>
                  <div>
                    <h3 className="font-semibold text-primary dark:text-white">{context.ownerName}</h3>
                    {context.ownerEmail && (
                      <p className="text-sm text-primary/70 dark:text-white/70">{context.ownerEmail}</p>
                    )}
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-primary/10 dark:border-white/10 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-primary/50 dark:text-white/50 text-xs">Date</p>
                    <p className="text-primary dark:text-white font-medium">{formatDate(context.bookingDate)}</p>
                  </div>
                  <div>
                    <p className="text-primary/50 dark:text-white/50 text-xs">Time</p>
                    <p className="text-primary dark:text-white font-medium">{formatTime(context.startTime)} - {formatTime(context.endTime)}</p>
                  </div>
                  {context.resourceName && (
                    <div className="col-span-2">
                      <p className="text-primary/50 dark:text-white/50 text-xs">Bay/Resource</p>
                      <p className="text-primary dark:text-white font-medium">{context.resourceName}</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-xl p-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">warning</span>
                  <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
                    {context.emptySlots} of {context.totalSlots} player slot{context.emptySlots !== 1 ? 's' : ''} need{context.emptySlots === 1 ? 's' : ''} assignment
                  </p>
                </div>
              </div>

              <BookingMembersEditor 
                bookingId={bookingId} 
                onMemberLinked={handleMemberLinked}
                onCollectPayment={() => setShowBillingModal(true)}
              />
            </div>
          ) : null}
        </div>
      </SlideUpDrawer>
      <CheckinBillingModal
        isOpen={showBillingModal}
        onClose={() => setShowBillingModal(false)}
        bookingId={bookingId}
        onCheckinComplete={() => {
          setShowBillingModal(false);
          onRosterComplete();
        }}
      />
    </>
  );
};

export default CompleteRosterModal;

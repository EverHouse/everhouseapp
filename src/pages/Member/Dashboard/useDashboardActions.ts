import { useState, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { fetchWithCredentials, putWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';
import { apiRequestBlob } from '../../../lib/apiRequest';
import { useToast } from '../../../components/Toast';
import type { DBBooking, ConfirmModalState } from './dashboardTypes';

interface UseDashboardActionsParams {
  user: { email: string; name?: string } | null;
  isAdminViewingAs: boolean;
  refetchAllData: () => void;
}

export function useDashboardActions({ user, isAdminViewingAs, refetchAllData }: UseDashboardActionsParams) {
  const { showToast } = useToast();

  const [_selectedBooking, setSelectedBooking] = useState<DBBooking | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [optimisticCancelledIds, setOptimisticCancelledIds] = useState<Set<number>>(new Set());
  const [walletPassDownloading, setWalletPassDownloading] = useState<number | null>(null);

  const cancelBookingMutation = useMutation({
    mutationFn: async ({ bookingId, bookingType }: { bookingId: number; bookingType: 'booking' | 'booking_request' }) => {
      const endpoint = bookingType === 'booking'
        ? `/api/bookings/${bookingId}/member-cancel`
        : `/api/booking-requests/${bookingId}/member-cancel`;
      const data = await putWithCredentials<Record<string, unknown>>(endpoint, isAdminViewingAs ? { acting_as_email: user?.email } : {});
      return { bookingId, data };
    },
    onMutate: async ({ bookingId }) => {
      setOptimisticCancelledIds(prev => new Set(prev).add(bookingId));
      setSelectedBooking(null);
    },
    onSuccess: ({ bookingId, data }) => {
      if (data.status === 'cancellation_pending') {
        setOptimisticCancelledIds(prev => {
          const next = new Set(prev);
          next.delete(bookingId);
          return next;
        });
        showToast('Cancellation request submitted. You\'ll be notified when it\'s complete.', 'success');
      } else {
        showToast('Booking cancelled successfully', 'success');
      }
      refetchAllData();
    },
    onError: (error: Error, { bookingId }) => {
      setOptimisticCancelledIds(prev => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });
      showToast(error.message || 'Failed to cancel booking', 'error');
    },
  });

  const handleCancelBooking = (bookingId: number, bookingType: 'booking' | 'booking_request') => {
    setConfirmModal({
      isOpen: true,
      title: "Cancel Booking",
      message: "Are you sure you want to cancel this booking?",
      onConfirm: () => {
        setConfirmModal(null);
        cancelBookingMutation.mutate({ bookingId, bookingType });
      }
    });
  };

  const handleLeaveBooking = (bookingId: number, primaryBookerName?: string | null) => {
    if (!user?.email) return;

    setConfirmModal({
      isOpen: true,
      title: "Leave Booking",
      message: `Are you sure you want to leave this booking${primaryBookerName ? ` with ${primaryBookerName}` : ''}? You will be removed from the player list.`,
      onConfirm: async () => {
        setConfirmModal(null);

        try {
          const participantsData = await fetchWithCredentials<{ participants: Array<{ user_email?: string; id?: number }> }>(`/api/bookings/${bookingId}/participants`);
          const participants = participantsData.participants || [];

          const myParticipant = participants.find((p: { user_email?: string }) => 
            p.user_email?.toLowerCase() === user.email.toLowerCase()
          );

          if (!myParticipant) {
            showToast('Could not find your participant record', 'error');
            return;
          }

          const body = isAdminViewingAs && user?.email ? { onBehalfOf: user.email } : {};
          await fetchWithCredentials(`/api/bookings/${bookingId}/participants/${myParticipant.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          showToast('You have left the booking', 'success');
          refetchAllData();
        } catch (_err: unknown) {
          showToast('Failed to leave booking', 'error');
        }
      }
    });
  };

  const handleCancelRSVP = (eventId: number) => {
    if (!user?.email) return;

    setConfirmModal({
      isOpen: true,
      title: "Cancel RSVP",
      message: "Are you sure you want to cancel your RSVP?",
      onConfirm: async () => {
        setConfirmModal(null);

        try {
          await deleteWithCredentials(`/api/rsvps/${eventId}/${encodeURIComponent(user.email)}`);
          showToast('RSVP cancelled', 'success');
          refetchAllData();
        } catch (_err: unknown) {
          showToast('Failed to cancel RSVP', 'error');
        }
      }
    });
  };

  const handleCancelWellness = (classId: number) => {
    if (!user?.email) return;

    setConfirmModal({
      isOpen: true,
      title: "Cancel Enrollment",
      message: "Are you sure you want to cancel this enrollment?",
      onConfirm: async () => {
        setConfirmModal(null);

        try {
          await deleteWithCredentials(`/api/wellness-enrollments/${classId}/${encodeURIComponent(user.email)}`);
          showToast('Enrollment cancelled', 'success');
          refetchAllData();
        } catch (_err: unknown) {
          showToast('Failed to cancel enrollment', 'error');
        }
      }
    });
  };

  const isAppleDevice = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);

  const handleDownloadBookingWalletPass = async (bookingId: number) => {
    setWalletPassDownloading(bookingId);
    try {
      const response = await apiRequestBlob(`/api/member/booking-wallet-pass/${bookingId}`);
      if (!response.ok || !response.blob) throw new Error(response.error || 'Failed to download');
      const url = URL.createObjectURL(response.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `EverClub-Booking-${bookingId}.pkpass`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Wallet pass downloaded — open it to add to Apple Wallet', 'success', 5000);
    } catch {
      showToast('Failed to download booking wallet pass', 'error');
    } finally {
      setWalletPassDownloading(null);
    }
  };

  return {
    showToast,
    confirmModal, setConfirmModal,
    optimisticCancelledIds,
    walletPassDownloading,
    isAppleDevice,
    handleCancelBooking,
    handleLeaveBooking,
    handleCancelRSVP,
    handleCancelWellness,
    handleDownloadBookingWalletPass,
  };
}

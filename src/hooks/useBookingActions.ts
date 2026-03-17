import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { bookingsKeys, simulatorKeys } from './queries/adminKeys';

export interface CheckInOptions {
  status?: 'attended' | 'no_show' | 'cancelled';
  source?: string;
  skipPaymentCheck?: boolean;
}

export interface CheckInResult {
  success: boolean;
  requiresPayment?: boolean;
  requiresRoster?: boolean;
  requiresSync?: boolean;
  error?: string;
  data?: unknown;
}

export interface ChargeCardOptions {
  memberEmail: string;
  bookingId: number;
  sessionId: number;
  participantIds?: number[];
}

export interface FeeLineItemResult {
  participantId: number;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  overageCents: number;
  guestCents: number;
  totalCents: number;
}

export interface ChargeCardResult {
  success: boolean;
  noSavedCard?: boolean;
  noStripeCustomer?: boolean;
  requiresAction?: boolean;
  cardError?: boolean;
  error?: string;
  message?: string;
  invoiceId?: string;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
  feeLineItems?: FeeLineItemResult[];
  totalAmount?: number;
  amountCharged?: number;
  balanceApplied?: number;
}

export interface StaffCancelOptions {
  source?: string;
  cancelledBy?: string;
}

function invalidateBookingQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
  queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
}

export function useBookingActions() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const checkInBooking = useCallback(async (
    bookingId: number | string,
    options: CheckInOptions = {}
  ): Promise<CheckInResult> => {
    const { status = 'attended', source, skipPaymentCheck } = options;

    await queryClient.cancelQueries({ queryKey: bookingsKeys.all });
    await queryClient.cancelQueries({ queryKey: simulatorKeys.all });
    const previousBookings = queryClient.getQueriesData({ queryKey: bookingsKeys.all });
    const previousSimulator = queryClient.getQueriesData({ queryKey: simulatorKeys.all });

    queryClient.setQueriesData(
      { queryKey: bookingsKeys.all },
      (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) =>
          String(b.id) === String(bookingId) ? { ...b, status } : b
        );
      }
    );
    queryClient.setQueriesData(
      { queryKey: simulatorKeys.all },
      (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) =>
          String(b.id) === String(bookingId) ? { ...b, status } : b
        );
      }
    );

    try {
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status, source, skipPaymentCheck })
      });

      if (res.status === 402) {
        previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
        previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
        const errorData = await res.json();
        return {
          success: false,
          requiresPayment: !errorData.requiresRoster,
          requiresRoster: !!errorData.requiresRoster,
          error: errorData.error || 'Payment required',
          data: errorData
        };
      }

      if (res.status === 400) {
        previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
        previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
        const errorData = await res.json();
        if (errorData.requiresSync && !skipPaymentCheck) {
          const retryRes = await fetch(`/api/bookings/${bookingId}/checkin`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ status, source, skipPaymentCheck: true })
          });
          if (retryRes.ok) {
            invalidateBookingQueries(queryClient);
            return { success: true };
          }
          const retryErr = await retryRes.json().catch(() => ({}));
          return { success: false, error: retryErr.error || 'Failed to check in after retry' };
        }
        return { success: false, requiresSync: !!errorData.requiresSync, error: errorData.error || 'Check-in failed' };
      }

      if (!res.ok) {
        previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
        previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || 'Failed to update status' };
      }

      invalidateBookingQueries(queryClient);
      return { success: true };
    } catch (err: unknown) {
      previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
      previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
      return { success: false, error: (err instanceof Error ? err.message : String(err)) || 'Network error during check-in' };
    }
  }, [queryClient]);

  const checkInWithToast = useCallback(async (
    bookingId: number | string,
    options: CheckInOptions = {}
  ): Promise<CheckInResult> => {
    const result = await checkInBooking(bookingId, options);
    const status = options.status || 'attended';

    if (result.success) {
      const label = status === 'attended' ? 'checked in' :
                    status === 'no_show' ? 'marked as no show' :
                    status === 'cancelled' ? 'cancelled' : 'updated';
      const suffix = result.requiresSync === undefined && options.skipPaymentCheck
        ? ' (billing session pending)' : '';
      showToast(`Booking ${label}${suffix}`, 'success');
    } else if (!result.requiresPayment && !result.requiresRoster) {
      showToast(result.error || 'Check-in failed', 'error');
    }

    return result;
  }, [checkInBooking, showToast]);

  const chargeCardOnFile = useCallback(async (
    options: ChargeCardOptions
  ): Promise<ChargeCardResult> => {
    const { memberEmail, bookingId, sessionId, participantIds } = options;

    try {
      const res = await fetch('/api/stripe/staff/charge-saved-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail,
          bookingId,
          sessionId,
          ...(participantIds ? { participantIds } : {})
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        invalidateBookingQueries(queryClient);
        return { 
          success: true, 
          message: data.message || 'Card charged successfully',
          invoiceId: data.invoiceId,
          hostedInvoiceUrl: data.hostedInvoiceUrl,
          invoicePdf: data.invoicePdf,
          feeLineItems: data.feeLineItems,
          totalAmount: data.totalAmount,
          amountCharged: data.amountCharged,
          balanceApplied: data.balanceApplied,
        };
      }

      if (data.noSavedCard || data.noStripeCustomer) {
        return { success: false, noSavedCard: true };
      }
      if (data.requiresAction) {
        return { success: false, requiresAction: true };
      }
      if (data.cardError) {
        return { success: false, cardError: true, error: data.error };
      }
      return { success: false, error: data.error || 'Failed to charge card' };
    } catch (err: unknown) {
      return { success: false, error: (err instanceof Error ? err.message : String(err)) || 'Network error charging card' };
    }
  }, [queryClient]);

  const chargeCardWithToast = useCallback(async (
    options: ChargeCardOptions
  ): Promise<ChargeCardResult> => {
    const result = await chargeCardOnFile(options);

    if (result.success) {
      showToast(result.message || 'Card charged successfully', 'success');
    } else if (result.noSavedCard) {
      showToast('No saved card on file', 'warning');
    } else if (result.requiresAction) {
      showToast('Card requires additional verification - use the card payment option', 'warning');
    } else if (result.cardError) {
      showToast(`Card declined: ${result.error}`, 'error');
    } else {
      showToast(result.error || 'Failed to charge card', 'error');
    }

    return result;
  }, [chargeCardOnFile, showToast]);

  const staffCancelBooking = useCallback(async (
    bookingId: number | string,
    options: StaffCancelOptions = {}
  ): Promise<{ success: boolean; error?: string }> => {
    const { source, cancelledBy } = options;

    await queryClient.cancelQueries({ queryKey: bookingsKeys.all });
    await queryClient.cancelQueries({ queryKey: simulatorKeys.all });
    const previousBookings = queryClient.getQueriesData({ queryKey: bookingsKeys.all });
    const previousSimulator = queryClient.getQueriesData({ queryKey: simulatorKeys.all });

    queryClient.setQueriesData(
      { queryKey: bookingsKeys.all },
      (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) =>
          String(b.id) === String(bookingId) ? { ...b, status: 'cancelled' } : b
        );
      }
    );
    queryClient.setQueriesData(
      { queryKey: simulatorKeys.all },
      (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) =>
          String(b.id) === String(bookingId) ? { ...b, status: 'cancelled' } : b
        );
      }
    );

    try {
      const res = await fetch(`/api/booking-requests/${bookingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'cancelled', source, cancelled_by: cancelledBy })
      });

      if (!res.ok) {
        previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
        previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || 'Failed to cancel booking' };
      }

      invalidateBookingQueries(queryClient);
      return { success: true };
    } catch (err: unknown) {
      previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
      previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
      return { success: false, error: (err instanceof Error ? err.message : String(err)) || 'Network error cancelling booking' };
    }
  }, [queryClient]);

  const staffCancelWithToast = useCallback(async (
    bookingId: number | string,
    options: StaffCancelOptions = {}
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await staffCancelBooking(bookingId, options);

    if (result.success) {
      showToast('Booking cancelled', 'success');
    } else {
      showToast(result.error || 'Failed to cancel booking', 'error');
    }

    return result;
  }, [staffCancelBooking, showToast]);

  const revertToApproved = useCallback(async (bookingId: number | string): Promise<{ success?: boolean; error?: string }> => {
    await queryClient.cancelQueries({ queryKey: bookingsKeys.all });
    await queryClient.cancelQueries({ queryKey: simulatorKeys.all });
    const previousBookings = queryClient.getQueriesData({ queryKey: bookingsKeys.all });
    const previousSimulator = queryClient.getQueriesData({ queryKey: simulatorKeys.all });

    queryClient.setQueriesData(
      { queryKey: bookingsKeys.all },
      (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) =>
          String(b.id) === String(bookingId) ? { ...b, status: 'approved' } : b
        );
      }
    );
    queryClient.setQueriesData(
      { queryKey: simulatorKeys.all },
      (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((b: Record<string, unknown>) =>
          String(b.id) === String(bookingId) ? { ...b, status: 'approved' } : b
        );
      }
    );

    try {
      const res = await fetch(`/api/bookings/${bookingId}/revert-to-approved`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      if (!res.ok) {
        previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
        previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
        const data = await res.json().catch(() => ({}));
        return { error: data.error || 'Failed to revert booking' };
      }

      invalidateBookingQueries(queryClient);
      return { success: true };
    } catch {
      previousBookings.forEach(([key, data]) => queryClient.setQueryData(key, data));
      previousSimulator.forEach(([key, data]) => queryClient.setQueryData(key, data));
      return { error: 'Network error' };
    }
  }, [queryClient]);

  const revertToApprovedWithToast = useCallback(async (bookingId: number | string) => {
    const result = await revertToApproved(bookingId);
    if (result.success) {
      showToast('Booking reverted to approved', 'success');
    } else {
      showToast(result.error || 'Failed to revert booking', 'error');
    }
    return result;
  }, [revertToApproved, showToast]);

  return {
    checkInBooking,
    checkInWithToast,
    chargeCardOnFile,
    chargeCardWithToast,
    staffCancelBooking,
    staffCancelWithToast,
    revertToApproved,
    revertToApprovedWithToast,
    invalidateBookingQueries: () => invalidateBookingQueries(queryClient)
  };
}

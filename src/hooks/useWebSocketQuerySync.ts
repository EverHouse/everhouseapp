import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bookingsKeys, simulatorKeys } from './queries/useBookingsQueries';
import { financialsKeys } from './queries/useFinancialsQueries';
import { cafeKeys } from './queries/useCafeQueries';
import { toursKeys } from './queries/useToursQueries';

const directoryKeys = {
  all: ['directory'] as const,
  syncStatus: () => [...directoryKeys.all, 'sync-status'] as const,
  team: () => [...directoryKeys.all, 'team'] as const,
};

const eventKeys = {
  all: ['admin-events'] as const,
  needsReview: () => ['events-needs-review'] as const,
  rsvps: (eventId?: number) => eventId ? ['event-rsvps', eventId] as const : ['event-rsvps'] as const,
};

const wellnessKeys = {
  all: ['wellness-classes'] as const,
  needsReview: () => ['wellness-needs-review'] as const,
  enrollments: (classId?: number) => classId ? ['class-enrollments', classId] as const : ['class-enrollments'] as const,
};

export function useWebSocketQuerySync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleBookingUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      if (!detail) return;

      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating queries for:', detail.eventType);

      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });

      if (detail.eventType === 'check_in' || detail.eventType === 'check_out' || detail.eventType === 'payment') {
        queryClient.invalidateQueries({ queryKey: financialsKeys.all });
      }

      if (detail.eventType?.startsWith('rsvp_')) {
        queryClient.invalidateQueries({ queryKey: eventKeys.all });
        queryClient.invalidateQueries({ queryKey: eventKeys.needsReview() });
        if (detail.bookingId) {
          queryClient.invalidateQueries({ queryKey: eventKeys.rsvps(detail.bookingId) });
        }
      }

      if (detail.eventType?.startsWith('wellness_')) {
        queryClient.invalidateQueries({ queryKey: wellnessKeys.all });
        queryClient.invalidateQueries({ queryKey: wellnessKeys.needsReview() });
        if (detail.bookingId) {
          queryClient.invalidateQueries({ queryKey: wellnessKeys.enrollments(detail.bookingId) });
        }
      }
    };

    const handleCafeMenuUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating cafe queries');
      queryClient.invalidateQueries({ queryKey: cafeKeys.all });
    };

    const handleTourUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating tour queries for action:', detail?.action);
      queryClient.invalidateQueries({ queryKey: toursKeys.all });
    };

    const handleDirectoryUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating directory queries for action:', detail?.action);
      queryClient.invalidateQueries({ queryKey: directoryKeys.all });
      queryClient.invalidateQueries({ queryKey: directoryKeys.team() });
    };

    const handleBillingUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating billing/financials queries');
      queryClient.invalidateQueries({ queryKey: financialsKeys.all });
      queryClient.invalidateQueries({ queryKey: ['member'] });
    };

    const handleTierUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating member/profile queries for tier update');
      queryClient.invalidateQueries({ queryKey: ['members'] });
      queryClient.invalidateQueries({ queryKey: ['member'] });
      queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
    };

    const handleMemberStatsUpdated = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating member/profile queries for stats update');
      queryClient.invalidateQueries({ queryKey: ['member'] });
      queryClient.invalidateQueries({ queryKey: ['members'] });
      queryClient.invalidateQueries({ queryKey: ['book-golf'] });
    };

    const handleMemberDataUpdated = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating member/profile queries for data update');
      queryClient.invalidateQueries({ queryKey: ['members'] });
      queryClient.invalidateQueries({ queryKey: ['member'] });
      queryClient.invalidateQueries({ queryKey: directoryKeys.all });
    };

    const handleDataIntegrityUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating data-integrity queries');
      queryClient.invalidateQueries({ queryKey: ['data-integrity'] });
    };

    const handleDayPassUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating day-pass/visitor queries');
      queryClient.invalidateQueries({ queryKey: ['book-golf'] });
      queryClient.invalidateQueries({ queryKey: directoryKeys.all });
    };

    const handleClosureUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating closure/availability queries');
      queryClient.invalidateQueries({ queryKey: ['closures'] });
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: ['book-golf'] });
    };

    const handleBookingAutoConfirmed = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating queries for booking-auto-confirmed');
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
    };

    const handleBookingConfirmed = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating queries for booking-confirmed');
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
    };

    const handleAvailabilityUpdate = (event: CustomEvent) => {
      if (import.meta.env.DEV) console.log('[WebSocketQuerySync] Invalidating queries for availability-update');
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });
      queryClient.invalidateQueries({ queryKey: ['book-golf'] });
    };

    window.addEventListener('booking-update', handleBookingUpdate as EventListener);
    window.addEventListener('cafe-menu-update', handleCafeMenuUpdate as EventListener);
    window.addEventListener('tour-update', handleTourUpdate as EventListener);
    window.addEventListener('directory-update', handleDirectoryUpdate as EventListener);
    window.addEventListener('billing-update', handleBillingUpdate as EventListener);
    window.addEventListener('tier-update', handleTierUpdate as EventListener);
    window.addEventListener('member-stats-updated', handleMemberStatsUpdated as EventListener);
    window.addEventListener('member-data-updated', handleMemberDataUpdated as EventListener);
    window.addEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
    window.addEventListener('day-pass-update', handleDayPassUpdate as EventListener);
    window.addEventListener('closure-update', handleClosureUpdate as EventListener);
    window.addEventListener('booking-auto-confirmed', handleBookingAutoConfirmed as EventListener);
    window.addEventListener('booking-confirmed', handleBookingConfirmed as EventListener);
    window.addEventListener('availability-update', handleAvailabilityUpdate as EventListener);

    return () => {
      window.removeEventListener('booking-update', handleBookingUpdate as EventListener);
      window.removeEventListener('cafe-menu-update', handleCafeMenuUpdate as EventListener);
      window.removeEventListener('tour-update', handleTourUpdate as EventListener);
      window.removeEventListener('directory-update', handleDirectoryUpdate as EventListener);
      window.removeEventListener('billing-update', handleBillingUpdate as EventListener);
      window.removeEventListener('tier-update', handleTierUpdate as EventListener);
      window.removeEventListener('member-stats-updated', handleMemberStatsUpdated as EventListener);
      window.removeEventListener('member-data-updated', handleMemberDataUpdated as EventListener);
      window.removeEventListener('data-integrity-update', handleDataIntegrityUpdate as EventListener);
      window.removeEventListener('day-pass-update', handleDayPassUpdate as EventListener);
      window.removeEventListener('closure-update', handleClosureUpdate as EventListener);
      window.removeEventListener('booking-auto-confirmed', handleBookingAutoConfirmed as EventListener);
      window.removeEventListener('booking-confirmed', handleBookingConfirmed as EventListener);
      window.removeEventListener('availability-update', handleAvailabilityUpdate as EventListener);
    };
  }, [queryClient]);
}

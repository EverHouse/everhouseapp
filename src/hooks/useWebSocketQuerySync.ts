import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bookingsKeys, simulatorKeys } from './queries/useBookingsQueries';
import { financialsKeys } from './queries/useFinancialsQueries';
import { cafeKeys } from './queries/useCafeQueries';
import { toursKeys } from './queries/useToursQueries';

// Local query key definitions for directory (mirrors DirectoryTab.tsx structure)
const directoryKeys = {
  all: ['directory'] as const,
  syncStatus: () => [...directoryKeys.all, 'sync-status'] as const,
  team: () => [...directoryKeys.all, 'team'] as const,
};

/**
 * Query key definitions for events and wellness classes
 * These track admin event management and wellness class enrollment
 */
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
    /**
     * Handles booking-related WebSocket updates
     * Invalidates booking queries, and conditionally financials/events/wellness queries
     * 
     * Event types handled:
     * - booking_* events: Invalidate bookings and simulator queries
     * - check_in/check_out/payment events: Also invalidate financials
     * - rsvp_* events: Invalidate event and RSVP queries
     * - wellness_* events: Invalidate wellness class and enrollment queries
     */
    const handleBookingUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      if (!detail) return;

      console.log('[WebSocketQuerySync] Invalidating queries for:', detail.eventType);

      // Always invalidate booking and simulator queries
      queryClient.invalidateQueries({ queryKey: bookingsKeys.all });
      queryClient.invalidateQueries({ queryKey: simulatorKeys.all });

      // Invalidate financials on payment-related events
      if (detail.eventType === 'check_in' || detail.eventType === 'check_out' || detail.eventType === 'payment') {
        queryClient.invalidateQueries({ queryKey: financialsKeys.all });
      }

      // Invalidate event queries on RSVP events
      if (detail.eventType?.startsWith('rsvp_')) {
        queryClient.invalidateQueries({ queryKey: eventKeys.all });
        queryClient.invalidateQueries({ queryKey: eventKeys.needsReview() });
        // Invalidate specific event RSVPs if eventId is available (bookingId contains eventId for rsvp events)
        if (detail.bookingId) {
          queryClient.invalidateQueries({ queryKey: eventKeys.rsvps(detail.bookingId) });
        }
      }

      // Invalidate wellness queries on wellness class events
      if (detail.eventType?.startsWith('wellness_')) {
        queryClient.invalidateQueries({ queryKey: wellnessKeys.all });
        queryClient.invalidateQueries({ queryKey: wellnessKeys.needsReview() });
        // Invalidate specific class enrollments if classId is available (bookingId contains classId for wellness events)
        if (detail.bookingId) {
          queryClient.invalidateQueries({ queryKey: wellnessKeys.enrollments(detail.bookingId) });
        }
      }
    };

    /**
     * Handles cafe menu updates from WebSocket
     * Invalidates all cafe menu queries
     */
    const handleCafeMenuUpdate = (event: CustomEvent) => {
      console.log('[WebSocketQuerySync] Invalidating cafe queries');
      queryClient.invalidateQueries({ queryKey: cafeKeys.all });
    };

    /**
     * Handles tour updates from WebSocket
     * Invalidates all tour queries on tour changes (scheduled, rescheduled, cancelled, checked in)
     */
    const handleTourUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      console.log('[WebSocketQuerySync] Invalidating tour queries for action:', detail?.action);
      queryClient.invalidateQueries({ queryKey: toursKeys.all });
    };

    /**
     * Handles directory/staff updates from WebSocket
     * Invalidates directory and team member queries
     */
    const handleDirectoryUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      console.log('[WebSocketQuerySync] Invalidating directory queries for action:', detail?.action);
      queryClient.invalidateQueries({ queryKey: directoryKeys.all });
      queryClient.invalidateQueries({ queryKey: directoryKeys.team() });
    };

    // Register event listeners
    window.addEventListener('booking-update', handleBookingUpdate as EventListener);
    window.addEventListener('cafe-menu-update', handleCafeMenuUpdate as EventListener);
    window.addEventListener('tour-update', handleTourUpdate as EventListener);
    window.addEventListener('directory-update', handleDirectoryUpdate as EventListener);

    // Cleanup function
    return () => {
      window.removeEventListener('booking-update', handleBookingUpdate as EventListener);
      window.removeEventListener('cafe-menu-update', handleCafeMenuUpdate as EventListener);
      window.removeEventListener('tour-update', handleTourUpdate as EventListener);
      window.removeEventListener('directory-update', handleDirectoryUpdate as EventListener);
    };
  }, [queryClient]);
}

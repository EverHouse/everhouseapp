import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { fetchWithCredentials } from './useFetch';
import { getTodayPacific, addDaysToPacificDate } from '../../utils/dateUtils';
import { simulatorKeys } from './useBookingsQueries';
import type { BookingRequest, Tour, DBEvent, WellnessClass, Closure, RecentActivity, StaffNotification, Announcement } from '../../components/staff-command-center/types';

export const commandCenterKeys = {
  all: ['command-center'] as const,
  pendingRequests: () => [...commandCenterKeys.all, 'pending-requests'] as const,
  scheduling: () => [...commandCenterKeys.all, 'scheduling'] as const,
  facility: () => [...commandCenterKeys.all, 'facility'] as const,
  activity: (userEmail?: string) =>
    [...commandCenterKeys.all, 'activity', userEmail] as const,
  hubspotContacts: () => [...commandCenterKeys.all, 'hubspot-contacts'] as const,
  announcements: () => [...commandCenterKeys.all, 'announcements'] as const,
};

export function useCommandCenterTodaysBookings() {
  const today = getTodayPacific();
  const weekAhead = addDaysToPacificDate(today, 7);

  return useQuery({
    queryKey: simulatorKeys.approvedBookings(today, weekAhead),
    queryFn: () =>
      fetchWithCredentials<BookingRequest[]>(
        `/api/approved-bookings?start_date=${today}&end_date=${weekAhead}`
      ),
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
  });
}

export function useCommandCenterUpcomingBookings() {
  const today = getTodayPacific();
  const futureDate = addDaysToPacificDate(today, 30);

  return useQuery({
    queryKey: simulatorKeys.approvedBookings(today, futureDate),
    queryFn: () =>
      fetchWithCredentials<BookingRequest[]>(
        `/api/approved-bookings?start_date=${today}&end_date=${futureDate}`
      ),
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
  });
}

interface PendingRequestsResult {
  bookingRequests: BookingRequest[];
  pendingBookings: BookingRequest[];
}

export function useCommandCenterPendingRequests() {
  return useQuery({
    queryKey: commandCenterKeys.pendingRequests(),
    queryFn: async (): Promise<PendingRequestsResult> => {
      const [requestsRes, pendingRes] = await Promise.all([
        fetch('/api/booking-requests?include_all=true', { credentials: 'include' }).catch(() => null),
        fetch('/api/pending-bookings', { credentials: 'include' }).catch(() => null),
      ]);

      const bookingRequests = requestsRes?.ok ? await requestsRes.json() : [];
      const pendingBookings = pendingRes?.ok ? await pendingRes.json() : [];

      return { bookingRequests, pendingBookings };
    },
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 2,
  });
}

interface SchedulingResult {
  tours: Tour[];
  events: DBEvent[];
  wellness: WellnessClass[];
}

export function useCommandCenterScheduling() {
  return useQuery({
    queryKey: commandCenterKeys.scheduling(),
    queryFn: async (): Promise<SchedulingResult> => {
      const [toursRes, eventsRes, wellnessRes] = await Promise.all([
        fetch('/api/tours?upcoming=true', { credentials: 'include' }).catch(() => null),
        fetch('/api/events', { credentials: 'include' }).catch(() => null),
        fetch('/api/wellness-classes', { credentials: 'include' }).catch(() => null),
      ]);

      const tours = toursRes?.ok ? await toursRes.json() : [];
      const events = eventsRes?.ok ? await eventsRes.json() : [];
      const wellness = wellnessRes?.ok ? await wellnessRes.json() : [];

      return { tours, events, wellness };
    },
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 2,
  });
}

interface FacilityResult {
  bays: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  closures: Closure[];
}

export function useCommandCenterFacility() {
  return useQuery({
    queryKey: commandCenterKeys.facility(),
    queryFn: async (): Promise<FacilityResult> => {
      const [baysRes, resourcesRes, closuresRes] = await Promise.all([
        fetch('/api/bays', { credentials: 'include' }).catch(() => null),
        fetch('/api/resources', { credentials: 'include' }).catch(() => null),
        fetch('/api/closures', { credentials: 'include' }).catch(() => null),
      ]);

      const bays = baysRes?.ok ? await baysRes.json() : [];
      const resources = resourcesRes?.ok ? await resourcesRes.json() : [];
      const closures = closuresRes?.ok ? await closuresRes.json() : [];

      return { bays, resources, closures };
    },
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 5,
  });
}

interface ActivityResult {
  recentActivity: RecentActivity[];
  notifications: StaffNotification[];
}

export function useCommandCenterActivity(userEmail?: string) {
  return useQuery({
    queryKey: commandCenterKeys.activity(userEmail),
    queryFn: async (): Promise<ActivityResult> => {
      const fetches: Promise<Response | null>[] = [
        fetch('/api/recent-activity', { credentials: 'include' }).catch(() => null),
      ];
      if (userEmail) {
        fetches.push(
          fetch(
            `/api/notifications?user_email=${encodeURIComponent(userEmail)}`,
            { credentials: 'include' }
          ).catch(() => null)
        );
      }

      const [activityRes, notificationsRes] = await Promise.all(fetches);

      const recentActivity = activityRes?.ok ? await activityRes.json() : [];
      const notifications =
        notificationsRes && notificationsRes.ok
          ? await notificationsRes.json()
          : [];

      return { recentActivity, notifications };
    },
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60,
  });
}

export function useCommandCenterHubSpotContacts() {
  return useQuery({
    queryKey: commandCenterKeys.hubspotContacts(),
    queryFn: async (): Promise<Record<string, string>> => {
      const res = await fetch('/api/hubspot/contacts?status=all', {
        credentials: 'include',
      });
      if (!res.ok) return {};

      const data = await res.json();
      const contacts = Array.isArray(data) ? data : data.contacts || [];
      const nameMap: Record<string, string> = {};

      contacts.forEach(
        (contact: {
          email?: string;
          firstName?: string;
          lastName?: string;
          manuallyLinkedEmails?: string[];
        }) => {
          const name = [contact.firstName, contact.lastName]
            .filter(Boolean)
            .join(' ');
          if (contact.email && name) {
            nameMap[contact.email.toLowerCase()] = name;
          }
          if (contact.manuallyLinkedEmails) {
            contact.manuallyLinkedEmails.forEach((linkedEmail: string) => {
              if (linkedEmail && name) {
                nameMap[linkedEmail.toLowerCase()] = name;
              }
            });
          }
        }
      );

      return nameMap;
    },
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 10,
  });
}

export function useCommandCenterAnnouncements() {
  return useQuery({
    queryKey: commandCenterKeys.announcements(),
    queryFn: () => fetchWithCredentials<Announcement[]>('/api/announcements'),
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 5,
  });
}

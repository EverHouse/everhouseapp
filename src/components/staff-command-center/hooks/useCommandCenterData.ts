import { useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getTodayPacific, addDaysToPacificDate, getNowTimePacific } from '../../../utils/dateUtils';
import {
  commandCenterKeys,
  useCommandCenterTodaysBookings,
  useCommandCenterUpcomingBookings,
  useCommandCenterPendingRequests,
  useCommandCenterScheduling,
  useCommandCenterFacility,
  useCommandCenterActivity,
  useCommandCenterHubSpotContacts,
  useCommandCenterAnnouncements,
} from '../../../hooks/queries/useCommandCenterQueries';
import type { BookingRequest, Tour, Closure, Announcement, WellnessClass, DBEvent, BayStatus, CommandCenterData, UpcomingBooking, NextScheduleItem, NextActivityItem, RecentActivity, StaffNotification } from '../types';

export const REFRESH_INTERVAL = 5 * 60 * 1000;

export function useCommandCenterData(userEmail?: string) {
  const queryClient = useQueryClient();

  const todaysBookingsQuery = useCommandCenterTodaysBookings();
  const upcomingBookingsQuery = useCommandCenterUpcomingBookings();
  const pendingRequestsQuery = useCommandCenterPendingRequests();
  const schedulingQuery = useCommandCenterScheduling();
  const facilityQuery = useCommandCenterFacility();
  const activityQuery = useCommandCenterActivity(userEmail);
  const hubspotQuery = useCommandCenterHubSpotContacts();
  const announcementsQuery = useCommandCenterAnnouncements();

  const memberNameByEmail = hubspotQuery.data ?? new Map<string, string>();

  const getDisplayName = useCallback((email: string | null | undefined, originalName: string | null): string => {
    if (email) {
      const hubspotName = memberNameByEmail.get(email.toLowerCase());
      if (hubspotName) return hubspotName;
    }
    return originalName || 'Guest';
  }, [memberNameByEmail]);

  const pendingRequests = useMemo((): BookingRequest[] => {
    const raw = pendingRequestsQuery.data;
    if (!raw) return [];

    let allPending: BookingRequest[] = [];

    const pending = (raw.bookingRequests || []).filter((r: BookingRequest) =>
      r.status === 'pending' || r.status === 'pending_approval' || r.status === 'cancellation_pending'
    ).map((r: BookingRequest) => ({
      ...r,
      user_name: getDisplayName(r.user_email, r.user_name),
      source: 'booking_request' as const
    }));
    allPending = [...allPending, ...pending];

    const pendingBookings = (raw.pendingBookings || []).map((b: any) => {
      const email = b.user_email || b.userEmail;
      const originalName = b.user_name || b.userName;
      return {
        ...b,
        id: b.id,
        user_name: getDisplayName(email, originalName),
        user_email: email,
        bay_name: b.bay_name || b.bayName,
        resource_id: b.resource_id || b.resourceId,
        request_date: b.request_date || b.requestDate,
        start_time: b.start_time || b.startTime,
        end_time: b.end_time || b.endTime,
        status: b.status || 'pending',
        source: 'booking' as const
      };
    });
    allPending = [...allPending, ...pendingBookings];

    return allPending;
  }, [pendingRequestsQuery.data, getDisplayName]);

  const todaysBookings = useMemo((): BookingRequest[] => {
    const raw = todaysBookingsQuery.data;
    if (!raw) return [];
    return raw.map((b: BookingRequest) => ({
      ...b,
      user_name: getDisplayName(b.user_email, b.user_name)
    }));
  }, [todaysBookingsQuery.data, getDisplayName]);

  const upcomingBookings = useMemo((): UpcomingBooking[] => {
    const raw = upcomingBookingsQuery.data;
    if (!raw) return [];

    const today = getTodayPacific();
    const nowTime = getNowTimePacific();
    const normalizeTime = (t: string) => t ? t.slice(0, 5) : '00:00';

    return raw.filter((b: any) => {
      const bookingDate = b.request_date;
      const startTime = normalizeTime(b.start_time);
      if (bookingDate > today) return true;
      if (bookingDate === today && startTime >= nowTime) return true;
      return false;
    }).sort((a: any, b: any) => {
      if (a.request_date !== b.request_date) return String(a.request_date).localeCompare(String(b.request_date));
      return normalizeTime(a.start_time).localeCompare(normalizeTime(b.start_time));
    }).map((b: any) => ({
      id: b.id,
      resource_name: b.resource_name || b.bay_name || 'Booking',
      resource_type: b.resource_type || 'simulator',
      booking_date: b.request_date,
      start_time: normalizeTime(b.start_time),
      end_time: normalizeTime(b.end_time),
      user_name: getDisplayName(b.user_email, b.user_name)
    }));
  }, [upcomingBookingsQuery.data, getDisplayName]);

  const { upcomingTours, nextTour } = useMemo(() => {
    const raw = schedulingQuery.data?.tours;
    if (!raw) return { upcomingTours: [] as Tour[], nextTour: null as Tour | null };

    const today = getTodayPacific();
    const nowTime = getNowTimePacific();

    const upcoming = raw.filter((t: Tour) =>
      t.tourDate >= today && t.status === 'scheduled'
    ).sort((a: Tour, b: Tour) => {
      if (a.tourDate !== b.tourDate) return a.tourDate.localeCompare(b.tourDate);
      return a.startTime.localeCompare(b.startTime);
    }).slice(0, 10);

    const next = upcoming.find((t: Tour) =>
      t.tourDate === today ? t.startTime >= nowTime : true
    ) || null;

    return { upcomingTours: upcoming, nextTour: next };
  }, [schedulingQuery.data?.tours]);

  const { upcomingEvents, firstEvent } = useMemo(() => {
    const raw = schedulingQuery.data?.events;
    if (!raw) return { upcomingEvents: [] as DBEvent[], firstEvent: null as DBEvent | null };

    const today = getTodayPacific();
    const nowTime = getNowTimePacific();

    const filtered = raw.filter((e: DBEvent) => {
      if (e.event_date > today) return true;
      if (e.event_date === today && (e.start_time || '00:00') >= nowTime) return true;
      return false;
    }).sort((a: DBEvent, b: DBEvent) => {
      if (a.event_date !== b.event_date) return a.event_date.localeCompare(b.event_date);
      return (a.start_time || '00:00').localeCompare(b.start_time || '00:00');
    });

    return {
      upcomingEvents: filtered.slice(0, 10),
      firstEvent: filtered.length > 0 ? filtered[0] : null
    };
  }, [schedulingQuery.data?.events]);

  const { upcomingWellness, firstWellness } = useMemo(() => {
    const raw = schedulingQuery.data?.wellness;
    if (!raw) return { upcomingWellness: [] as WellnessClass[], firstWellness: null as WellnessClass | null };

    const today = getTodayPacific();
    const nowTime = getNowTimePacific();

    const upcomingClasses = raw.filter((w: WellnessClass) => {
      if (w.date > today) return true;
      if (w.date === today && w.time >= nowTime) return true;
      return false;
    }).sort((a: WellnessClass, b: WellnessClass) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });

    return {
      upcomingWellness: upcomingClasses.slice(0, 5),
      firstWellness: upcomingClasses.length > 0 ? upcomingClasses[0] : null
    };
  }, [schedulingQuery.data?.wellness]);

  const nextEvent = useMemo((): DBEvent | WellnessClass | null => {
    if (firstEvent) return firstEvent;
    if (firstWellness) return firstWellness;
    return null;
  }, [firstEvent, firstWellness]);

  const nextScheduleItem = useMemo((): NextScheduleItem | null => {
    const nextBooking = upcomingBookings.length > 0 ? upcomingBookings[0] : null;

    const getDateTimeMs = (dateStr: string, timeStr: string): number => {
      if (!dateStr) return Infinity;
      let normalizedDate = dateStr;
      if (dateStr.includes('T')) {
        normalizedDate = dateStr.split('T')[0];
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          normalizedDate = parsed.toISOString().split('T')[0];
        } else {
          return Infinity;
        }
      }
      const normalizedTime = timeStr ? timeStr.slice(0, 5) : '00:00';
      const result = new Date(`${normalizedDate}T${normalizedTime}:00`).getTime();
      return isNaN(result) ? Infinity : result;
    };

    if (nextTour && nextBooking) {
      const tourTime = getDateTimeMs(nextTour.tourDate, nextTour.startTime);
      const bookingTime = getDateTimeMs(nextBooking.booking_date, nextBooking.start_time);
      if (tourTime <= bookingTime) {
        return { type: 'tour', tour: nextTour };
      }
      return { type: 'booking', booking: nextBooking };
    }
    if (nextTour) return { type: 'tour', tour: nextTour };
    if (nextBooking) return { type: 'booking', booking: nextBooking };
    return null;
  }, [nextTour, upcomingBookings]);

  const nextActivityItem = useMemo((): NextActivityItem | null => {
    const getDateTimeMs = (dateStr: string, timeStr: string): number => {
      if (!dateStr) return Infinity;
      let normalizedDate = dateStr;
      if (dateStr.includes('T')) {
        normalizedDate = dateStr.split('T')[0];
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          normalizedDate = parsed.toISOString().split('T')[0];
        } else {
          return Infinity;
        }
      }
      const normalizedTime = timeStr ? timeStr.slice(0, 5) : '00:00';
      const result = new Date(`${normalizedDate}T${normalizedTime}:00`).getTime();
      return isNaN(result) ? Infinity : result;
    };

    if (firstEvent && firstWellness) {
      const eventTime = getDateTimeMs(firstEvent.event_date, firstEvent.start_time || '00:00');
      const wellnessTime = getDateTimeMs(firstWellness.date, firstWellness.time);
      if (eventTime <= wellnessTime) {
        return { type: 'event', event: firstEvent };
      }
      return { type: 'wellness', wellness: firstWellness };
    }
    if (firstEvent) return { type: 'event', event: firstEvent };
    if (firstWellness) return { type: 'wellness', wellness: firstWellness };
    return null;
  }, [firstEvent, firstWellness]);

  const { closures, upcomingClosure } = useMemo(() => {
    const raw = facilityQuery.data?.closures;
    if (!raw) return { closures: [] as Closure[], upcomingClosure: null as Closure | null };

    const today = getTodayPacific();
    const tomorrow = addDaysToPacificDate(today, 1);
    const nowTime = getNowTimePacific();

    const relevant = raw.filter((c: Closure) => {
      if (c.endDate < today) return false;
      if (c.startDate > tomorrow) return false;
      if (c.endDate === today && c.endTime) {
        const normalizedEndTime = c.endTime.slice(0, 5);
        if (normalizedEndTime <= nowTime) return false;
      }
      return true;
    });

    const futureClosures = raw.filter((c: Closure) => c.startDate > tomorrow)
      .sort((a: Closure, b: Closure) => a.startDate.localeCompare(b.startDate));

    return {
      closures: relevant,
      upcomingClosure: futureClosures.length > 0 ? futureClosures[0] : null
    };
  }, [facilityQuery.data?.closures]);

  const bayStatuses = useMemo((): BayStatus[] => {
    const facilityData = facilityQuery.data;
    if (!facilityData) return [];

    const today = getTodayPacific();
    const nowTime = getNowTimePacific();

    const bayMap = new Map<number, BayStatus>();
    const inactiveBayStatuses = new Set(['checked_out', 'cancelled', 'declined', 'no_show']);
    todaysBookings.forEach((b: BookingRequest) => {
      const bookingDate = b.request_date?.split('T')[0];
      const isToday = bookingDate === today;

      if (isToday && b.resource_id && !inactiveBayStatuses.has(b.status) && b.start_time <= nowTime + ':00' && b.end_time > nowTime + ':00') {
        bayMap.set(b.resource_id, {
          id: b.resource_id,
          name: b.bay_name || `Bay ${b.resource_id}`,
          type: b.bay_name?.toLowerCase().includes('conference') ? 'conference_room' : 'simulator',
          isOccupied: true,
          currentBooking: {
            id: b.id,
            userName: b.user_name || 'Guest',
            endTime: b.end_time,
            status: b.status
          }
        });
      }
    });

    const resourceMap = new Map<number, { id: number; name: string; type?: string }>();
    facilityData.bays.forEach((b: { id: number; name: string; type?: string }) =>
      resourceMap.set(b.id, { ...b, type: 'simulator' })
    );
    facilityData.resources.forEach((r: { id: number; name: string; type?: string }) =>
      resourceMap.set(r.id, r)
    );

    const allResources = Array.from(resourceMap.values());
    if (allResources.length === 0) return [];

    const activeClosures = closures;

    const isClosureActive = (closure: Closure): boolean => {
      const todayStr = getTodayPacific();
      const now = new Date();
      if (closure.startDate > todayStr || closure.endDate < todayStr) return false;
      if (closure.startTime && closure.endTime) {
        const currentTime = now.toTimeString().slice(0, 5);
        if (currentTime < closure.startTime || currentTime > closure.endTime) return false;
      }
      return true;
    };

    const getAffectedBays = (closure: Closure): string[] => {
      const areas = closure.affectedAreas?.toLowerCase() || '';
      if (areas === 'entire_facility' || areas === 'all_bays') return ['all'];
      try {
        const parsed = JSON.parse(closure.affectedAreas);
        if (Array.isArray(parsed)) return parsed.map((a: string) => a.toLowerCase());
      } catch {}
      return [areas];
    };

    const isBayClosed = (bay: { id: number; name: string; type: string }): { closed: boolean; reason?: string } => {
      for (const closure of activeClosures) {
        if (!isClosureActive(closure)) continue;
        const affectedAreas = getAffectedBays(closure);
        if (affectedAreas.includes('all')) return { closed: true, reason: closure.title };
        if (bay.type === 'conference_room' && affectedAreas.includes('conference_room')) return { closed: true, reason: closure.title };
        for (const area of affectedAreas) {
          const areaMatch = area.match(/bay[_\s]?(\d+)/i);
          if (areaMatch) {
            const areaId = parseInt(areaMatch[1], 10);
            if (bay.id === areaId) return { closed: true, reason: closure.title };
          }
          if (area === 'all_bays' && bay.type === 'simulator') return { closed: true, reason: closure.title };
        }
      }
      return { closed: false };
    };

    const statuses: BayStatus[] = allResources.map((r) => {
      const existing = bayMap.get(r.id);
      const closureStatus = isBayClosed(r as { id: number; name: string; type: string });
      if (existing) {
        return { ...existing, name: r.name, type: r.type || existing.type, isClosed: closureStatus.closed, closureReason: closureStatus.reason };
      }
      return {
        id: r.id,
        name: r.name,
        type: r.type || 'simulator',
        isOccupied: false,
        isClosed: closureStatus.closed,
        closureReason: closureStatus.reason,
        currentBooking: null
      };
    });

    statuses.sort((a, b) => {
      if (a.type === 'conference_room' && b.type !== 'conference_room') return 1;
      if (a.type !== 'conference_room' && b.type === 'conference_room') return -1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    return statuses;
  }, [facilityQuery.data, todaysBookings, closures]);

  const announcements = useMemo((): Announcement[] => {
    const raw = announcementsQuery.data;
    if (!raw) return [];
    return raw.filter((a: Announcement) => a.is_active).slice(0, 5);
  }, [announcementsQuery.data]);

  const recentActivity = useMemo((): RecentActivity[] => {
    return activityQuery.data?.recentActivity ?? [];
  }, [activityQuery.data?.recentActivity]);

  const notifications = useMemo((): StaffNotification[] => {
    return activityQuery.data?.notifications ?? [];
  }, [activityQuery.data?.notifications]);

  const isLoading =
    todaysBookingsQuery.isLoading ||
    pendingRequestsQuery.isLoading ||
    schedulingQuery.isLoading ||
    facilityQuery.isLoading ||
    activityQuery.isLoading ||
    announcementsQuery.isLoading;

  const lastSynced = useMemo(() => {
    const timestamps = [
      todaysBookingsQuery.dataUpdatedAt,
      pendingRequestsQuery.dataUpdatedAt,
      schedulingQuery.dataUpdatedAt,
      facilityQuery.dataUpdatedAt,
      activityQuery.dataUpdatedAt,
    ].filter(Boolean);
    if (timestamps.length === 0) return new Date();
    return new Date(Math.max(...timestamps));
  }, [
    todaysBookingsQuery.dataUpdatedAt,
    pendingRequestsQuery.dataUpdatedAt,
    schedulingQuery.dataUpdatedAt,
    facilityQuery.dataUpdatedAt,
    activityQuery.dataUpdatedAt,
  ]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: commandCenterKeys.all });
  }, [queryClient]);

  const today = getTodayPacific();
  const weekAhead = addDaysToPacificDate(today, 7);

  const updatePendingRequests = useCallback((updater: (prev: BookingRequest[]) => BookingRequest[]) => {
    queryClient.setQueryData(commandCenterKeys.pendingRequests(), (old: any) => {
      if (!old) return old;

      const pendingStatuses = new Set(['pending', 'pending_approval', 'cancellation_pending']);
      const derivePendingFromRaw = (raw: any): BookingRequest[] => {
        const requests = (raw.bookingRequests || [])
          .filter((r: BookingRequest) => pendingStatuses.has(r.status))
          .map((r: BookingRequest) => ({ ...r, source: 'booking_request' as const }));
        const bookings = (raw.pendingBookings || []).map((b: any) => ({
          ...b,
          source: 'booking' as const
        }));
        return [...requests, ...bookings];
      };

      const currentFromCache = derivePendingFromRaw(old);
      const updated = updater(currentFromCache);

      const nonPendingRequests = old.bookingRequests.filter((r: any) => !pendingStatuses.has(r.status));
      const bookingRequestItems = updated.filter((r: any) => r.source === 'booking_request');
      const pendingBookingItems = updated.filter((r: any) => r.source === 'booking');
      return {
        bookingRequests: [...nonPendingRequests, ...bookingRequestItems],
        pendingBookings: pendingBookingItems.length > 0 ? pendingBookingItems : old.pendingBookings,
      };
    });
  }, [queryClient]);

  const updateBayStatuses = useCallback((_updater: (prev: BayStatus[]) => BayStatus[]) => {
    queryClient.invalidateQueries({ queryKey: commandCenterKeys.todaysBookings(today, weekAhead) });
    queryClient.invalidateQueries({ queryKey: commandCenterKeys.facility() });
  }, [queryClient, today, weekAhead]);

  const updateTodaysBookings = useCallback((updater: (prev: BookingRequest[]) => BookingRequest[]) => {
    queryClient.setQueryData(
      commandCenterKeys.todaysBookings(today, weekAhead),
      (old: any[]) => {
        if (!old) return old;
        return updater(old as BookingRequest[]);
      }
    );
  }, [queryClient, today, weekAhead]);

  const updateRecentActivity = useCallback((updater: (prev: RecentActivity[]) => RecentActivity[]) => {
    queryClient.setQueryData(
      commandCenterKeys.activity(userEmail),
      (old: any) => {
        if (!old) return old;
        return {
          ...old,
          recentActivity: updater(old.recentActivity || []),
        };
      }
    );
  }, [queryClient, userEmail]);

  return {
    data: {
      pendingRequests,
      upcomingTours,
      upcomingWellness,
      upcomingEvents,
      todaysBookings,
      upcomingBookings,
      bayStatuses,
      closures,
      upcomingClosure,
      announcements,
      nextTour,
      nextEvent,
      nextScheduleItem,
      nextActivityItem,
      recentActivity,
      notifications,
      isLoading,
      lastSynced
    } as CommandCenterData,
    refresh,
    updatePendingRequests,
    updateBayStatuses,
    updateTodaysBookings,
    updateRecentActivity
  };
}

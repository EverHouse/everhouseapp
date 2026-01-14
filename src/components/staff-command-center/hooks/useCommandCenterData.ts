import { useState, useEffect, useCallback } from 'react';
import { getTodayPacific, addDaysToPacificDate, getNowTimePacific } from '../../../utils/dateUtils';
import type { BookingRequest, Tour, Closure, Announcement, WellnessClass, DBEvent, BayStatus, CommandCenterData, UpcomingBooking, NextScheduleItem, NextActivityItem, RecentActivity, StaffNotification } from '../types';

export const REFRESH_INTERVAL = 5 * 60 * 1000;

export function useCommandCenterData(userEmail?: string) {
  const [pendingRequests, setPendingRequests] = useState<BookingRequest[]>([]);
  const [upcomingTours, setUpcomingTours] = useState<Tour[]>([]);
  const [upcomingWellness, setUpcomingWellness] = useState<WellnessClass[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<DBEvent[]>([]);
  const [todaysBookings, setTodaysBookings] = useState<BookingRequest[]>([]);
  const [upcomingBookings, setUpcomingBookings] = useState<UpcomingBooking[]>([]);
  const [bayStatuses, setBayStatuses] = useState<BayStatus[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [upcomingClosure, setUpcomingClosure] = useState<Closure | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [nextTour, setNextTour] = useState<Tour | null>(null);
  const [nextEvent, setNextEvent] = useState<DBEvent | WellnessClass | null>(null);
  const [nextScheduleItem, setNextScheduleItem] = useState<NextScheduleItem | null>(null);
  const [nextActivityItem, setNextActivityItem] = useState<NextActivityItem | null>(null);
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [notifications, setNotifications] = useState<StaffNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState<Date>(new Date());

  const fetchAllData = useCallback(async () => {
    const today = getTodayPacific();
    const tomorrow = addDaysToPacificDate(today, 1);
    
    try {
      const futureDate = addDaysToPacificDate(today, 30);
      const [
        requestsRes,
        pendingBookingsRes,
        toursRes,
        bookingsRes,
        upcomingBookingsRes,
        baysRes,
        resourcesRes,
        closuresRes,
        announcementsRes,
        eventsRes,
        wellnessRes,
        recentActivityRes,
        notificationsRes,
        hubspotContactsRes
      ] = await Promise.all([
        fetch('/api/booking-requests?include_all=true', { credentials: 'include' }),
        fetch('/api/pending-bookings', { credentials: 'include' }),
        fetch(`/api/tours?upcoming=true`, { credentials: 'include' }),
        fetch(`/api/approved-bookings?start_date=${today}&end_date=${today}`, { credentials: 'include' }),
        fetch(`/api/approved-bookings?start_date=${today}&end_date=${futureDate}`, { credentials: 'include' }),
        fetch('/api/bays', { credentials: 'include' }),
        fetch('/api/resources', { credentials: 'include' }),
        fetch('/api/closures', { credentials: 'include' }),
        fetch('/api/announcements', { credentials: 'include' }),
        fetch('/api/events', { credentials: 'include' }),
        fetch('/api/wellness-classes', { credentials: 'include' }),
        fetch('/api/recent-activity', { credentials: 'include' }),
        userEmail ? fetch(`/api/notifications?user_email=${encodeURIComponent(userEmail)}`, { credentials: 'include' }) : Promise.resolve(null),
        fetch('/api/hubspot/contacts', { credentials: 'include' })
      ]);

      // Build a map of email -> properly formatted member name from HubSpot contacts
      const memberNameByEmail = new Map<string, string>();
      if (hubspotContactsRes.ok) {
        const data = await hubspotContactsRes.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        contacts.forEach((contact: any) => {
          const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
          if (contact.email && name) {
            memberNameByEmail.set(contact.email.toLowerCase(), name);
          }
          // Also check manually linked emails
          if (contact.manuallyLinkedEmails) {
            contact.manuallyLinkedEmails.forEach((linkedEmail: string) => {
              if (linkedEmail && name) {
                memberNameByEmail.set(linkedEmail.toLowerCase(), name);
              }
            });
          }
        });
      }

      // Helper function to get display name - use HubSpot name if matched, otherwise original
      const getDisplayName = (email: string | null | undefined, originalName: string | null): string => {
        if (email) {
          const hubspotName = memberNameByEmail.get(email.toLowerCase());
          if (hubspotName) return hubspotName;
        }
        return originalName || 'Guest';
      };

      let allPending: BookingRequest[] = [];
      
      if (requestsRes.ok) {
        const data = await requestsRes.json();
        const pending = data.filter((r: BookingRequest) => 
          r.status === 'pending' || r.status === 'pending_approval'
        ).map((r: BookingRequest) => ({ 
          ...r, 
          user_name: getDisplayName(r.user_email, r.user_name),
          source: 'booking_request' as const 
        }));
        allPending = [...allPending, ...pending];
      }

      if (pendingBookingsRes.ok) {
        const pendingBookings = await pendingBookingsRes.json();
        allPending = [...allPending, ...pendingBookings.map((b: any) => {
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
        })];
      }
      
      setPendingRequests(allPending);

      const nowTime = getNowTimePacific();
      let localNextTour: Tour | null = null;

      if (toursRes.ok) {
        const data = await toursRes.json();
        const upcoming = data.filter((t: Tour) => 
          t.tourDate >= today && t.status === 'scheduled'
        ).sort((a: Tour, b: Tour) => {
          if (a.tourDate !== b.tourDate) return a.tourDate.localeCompare(b.tourDate);
          return a.startTime.localeCompare(b.startTime);
        }).slice(0, 10);
        setUpcomingTours(upcoming);
        
        const next = upcoming.find((t: Tour) => 
          t.tourDate === today ? t.startTime >= nowTime : true
        );
        localNextTour = next || null;
        setNextTour(localNextTour);
      }
      const bayMap = new Map<number, BayStatus>();

      if (bookingsRes.ok) {
        const data = await bookingsRes.json();
        // Enhance booking names with HubSpot member names
        const enhancedBookings = data.map((b: BookingRequest) => ({
          ...b,
          user_name: getDisplayName(b.user_email, b.user_name)
        }));
        setTodaysBookings(enhancedBookings);
        
        enhancedBookings.forEach((b: BookingRequest) => {
          if (b.resource_id && b.start_time <= nowTime + ':00' && b.end_time > nowTime + ':00') {
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
      } else {
        setTodaysBookings([]);
      }
      
      const resourceMap = new Map<number, any>();

      if (baysRes.ok) {
        const baysData = await baysRes.json();
        baysData.forEach((b: any) => resourceMap.set(b.id, { ...b, type: 'simulator' }));
      }
      if (resourcesRes.ok) {
        const resourcesData = await resourcesRes.json();
        resourcesData.forEach((r: any) => resourceMap.set(r.id, r));
      }

      const allResources = Array.from(resourceMap.values());

      let activeClosures: Closure[] = [];
      if (closuresRes.ok) {
        const data = await closuresRes.json();
        const relevant = data.filter((c: Closure) => {
          // Only show closures that haven't ended yet
          if (c.endDate < today) return false;
          if (c.startDate > tomorrow) return false;
          
          // If closure ends today and has an end time, check if it's passed
          // Normalize times to HH:MM format for comparison
          if (c.endDate === today && c.endTime) {
            const normalizedEndTime = c.endTime.slice(0, 5);
            if (normalizedEndTime <= nowTime) return false;
          }
          
          return true;
        });
        activeClosures = relevant;
        setClosures(relevant);
        
        const futureClosures = data.filter((c: Closure) => c.startDate > tomorrow)
          .sort((a: Closure, b: Closure) => a.startDate.localeCompare(b.startDate));
        setUpcomingClosure(futureClosures.length > 0 ? futureClosures[0] : null);
      }

      const isClosureActive = (closure: Closure): boolean => {
        const now = new Date();
        const todayStr = getTodayPacific();
        
        if (closure.startDate > todayStr || closure.endDate < todayStr) return false;
        
        if (closure.startTime && closure.endTime) {
          const nowTime = now.toTimeString().slice(0, 5);
          if (nowTime < closure.startTime || nowTime > closure.endTime) return false;
        }
        return true;
      };

      const getAffectedBays = (closure: Closure): string[] => {
        const areas = closure.affectedAreas?.toLowerCase() || '';
        
        if (areas === 'entire_facility' || areas === 'all_bays') {
          return ['all'];
        }
        
        try {
          const parsed = JSON.parse(closure.affectedAreas);
          if (Array.isArray(parsed)) {
            return parsed.map((a: string) => a.toLowerCase());
          }
        } catch {}
        
        return [areas];
      };

      const isBayClosed = (bay: { id: number; name: string; type: string }): { closed: boolean; reason?: string } => {
        for (const closure of activeClosures) {
          if (!isClosureActive(closure)) continue;
          
          const affectedAreas = getAffectedBays(closure);
          
          if (affectedAreas.includes('all')) {
            return { closed: true, reason: closure.title };
          }
          
          if (bay.type === 'conference_room' && affectedAreas.includes('conference_room')) {
            return { closed: true, reason: closure.title };
          }
          
          for (const area of affectedAreas) {
            const areaMatch = area.match(/bay[_\s]?(\d+)/i);
            if (areaMatch) {
              const areaId = parseInt(areaMatch[1], 10);
              if (bay.id === areaId) {
                return { closed: true, reason: closure.title };
              }
            }
            
            if (area === 'all_bays' && bay.type === 'simulator') {
              return { closed: true, reason: closure.title };
            }
          }
        }
        return { closed: false };
      };
      
      if (allResources.length > 0) {
        const statuses: BayStatus[] = allResources.map((r: any) => {
          const existing = bayMap.get(r.id);
          const closureStatus = isBayClosed(r);
          
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
        
        setBayStatuses(statuses);
      }

      if (announcementsRes.ok) {
        const data = await announcementsRes.json();
        const active = data.filter((a: Announcement) => a.is_active).slice(0, 5);
        setAnnouncements(active);
      }

      let nextEventItem: DBEvent | WellnessClass | null = null;
      let firstEvent: DBEvent | null = null;
      let firstWellness: WellnessClass | null = null;

      if (eventsRes.ok) {
        const events = await eventsRes.json();
        const filteredEvents = events.filter((e: DBEvent) => {
          if (e.event_date > today) return true;
          if (e.event_date === today && (e.start_time || '00:00') >= nowTime) return true;
          return false;
        }).sort((a: DBEvent, b: DBEvent) => {
          if (a.event_date !== b.event_date) return a.event_date.localeCompare(b.event_date);
          return (a.start_time || '00:00').localeCompare(b.start_time || '00:00');
        });
        if (filteredEvents.length > 0) {
          firstEvent = filteredEvents[0];
          nextEventItem = filteredEvents[0];
        }
        setUpcomingEvents(filteredEvents.slice(0, 10));
      }

      if (wellnessRes.ok) {
        const wellness = await wellnessRes.json();
        const upcomingClasses = wellness.filter((w: WellnessClass) => {
          if (w.date > today) return true;
          if (w.date === today && w.time >= nowTime) return true;
          return false;
        }).sort((a: WellnessClass, b: WellnessClass) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return a.time.localeCompare(b.time);
        });
        setUpcomingWellness(upcomingClasses.slice(0, 5));
        
        if (upcomingClasses.length > 0) {
          firstWellness = upcomingClasses[0];
          if (!nextEventItem) {
            nextEventItem = upcomingClasses[0];
          }
        }
      }

      let nextBooking: UpcomingBooking | null = null;
      if (upcomingBookingsRes.ok) {
        const bookings = await upcomingBookingsRes.json();
        const normalizeTime = (t: string) => t ? t.slice(0, 5) : '00:00';
        const filteredBookings = bookings.filter((b: any) => {
          const bookingDate = b.request_date;
          const startTime = normalizeTime(b.start_time);
          if (bookingDate > today) return true;
          if (bookingDate === today && startTime >= nowTime) return true;
          return false;
        }).sort((a: any, b: any) => {
          if (a.request_date !== b.request_date) return a.request_date.localeCompare(b.request_date);
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
        setUpcomingBookings(filteredBookings);
        if (filteredBookings.length > 0) {
          nextBooking = filteredBookings[0];
        }
      }

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

      let scheduleItem: NextScheduleItem | null = null;
      if (localNextTour && nextBooking) {
        const tourTime = getDateTimeMs(localNextTour.tourDate, localNextTour.startTime);
        const bookingTime = getDateTimeMs(nextBooking.booking_date, nextBooking.start_time);
        if (tourTime <= bookingTime) {
          scheduleItem = { type: 'tour', tour: localNextTour };
        } else {
          scheduleItem = { type: 'booking', booking: nextBooking };
        }
      } else if (localNextTour) {
        scheduleItem = { type: 'tour', tour: localNextTour };
      } else if (nextBooking) {
        scheduleItem = { type: 'booking', booking: nextBooking };
      }
      setNextScheduleItem(scheduleItem);

      let activityItem: NextActivityItem | null = null;
      if (firstEvent && firstWellness) {
        const eventTime = getDateTimeMs(firstEvent.event_date, firstEvent.start_time || '00:00');
        const wellnessTime = getDateTimeMs(firstWellness.date, firstWellness.time);
        if (eventTime <= wellnessTime) {
          activityItem = { type: 'event', event: firstEvent };
        } else {
          activityItem = { type: 'wellness', wellness: firstWellness };
        }
      } else if (firstEvent) {
        activityItem = { type: 'event', event: firstEvent };
      } else if (firstWellness) {
        activityItem = { type: 'wellness', wellness: firstWellness };
      }
      setNextActivityItem(activityItem);

      setNextEvent(nextEventItem);

      if (recentActivityRes.ok) {
        const activityData = await recentActivityRes.json();
        setRecentActivity(activityData);
      } else {
        setRecentActivity([]);
      }

      if (notificationsRes && notificationsRes.ok) {
        const notificationsData = await notificationsRes.json();
        setNotifications(notificationsData);
      } else {
        setNotifications([]);
      }

      setLastSynced(new Date());
    } catch (err) {
      console.error('Failed to fetch command center data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [userEmail]);

  useEffect(() => {
    fetchAllData();
    const interval = setInterval(fetchAllData, REFRESH_INTERVAL);
    
    const handleGlobalBookingUpdate = () => {
      console.log('[CommandCenter] Global booking-update event received, refreshing data');
      fetchAllData();
    };
    window.addEventListener('booking-update', handleGlobalBookingUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('booking-update', handleGlobalBookingUpdate);
    };
  }, [fetchAllData]);

  const updatePendingRequests = (updater: (prev: BookingRequest[]) => BookingRequest[]) => {
    setPendingRequests(updater);
  };

  const updateBayStatuses = (updater: (prev: BayStatus[]) => BayStatus[]) => {
    setBayStatuses(updater);
  };

  const updateTodaysBookings = (updater: (prev: BookingRequest[]) => BookingRequest[]) => {
    setTodaysBookings(updater);
  };

  const updateRecentActivity = (updater: (prev: RecentActivity[]) => RecentActivity[]) => {
    setRecentActivity(updater);
  };

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
    refresh: fetchAllData,
    updatePendingRequests,
    updateBayStatuses,
    updateTodaysBookings,
    updateRecentActivity
  };
}

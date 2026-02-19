import { getGoogleCalendarClient } from '../integrations';
import { createPacificDate } from '../../utils/dateUtils';
import { CALENDAR_CONFIG, TimeSlot, BusyPeriod } from './config';
import { getCalendarIdByName } from './cache';

import { logger } from '../logger';
export async function getCalendarBusyTimes(calendarId: string, date: string): Promise<BusyPeriod[]> {
  try {
    const calendar = await getGoogleCalendarClient();
    
    const startOfDay = createPacificDate(date, '00:00:00');
    const endOfDay = createPacificDate(date, '23:59:59');
    
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        timeZone: 'America/Los_Angeles',
        items: [{ id: calendarId }]
      }
    });
    
    const busyPeriods: BusyPeriod[] = [];
    const calendarBusy = response.data.calendars?.[calendarId]?.busy || [];
    
    for (const period of calendarBusy) {
      if (period.start && period.end) {
        busyPeriods.push({
          start: new Date(period.start),
          end: new Date(period.end)
        });
      }
    }
    
    return busyPeriods;
  } catch (error: unknown) {
    logger.error('Error fetching busy times:', { error: error });
    return [];
  }
}

export function generateTimeSlots(
  date: string,
  busyPeriods: BusyPeriod[],
  businessHours: { start: number; end: number },
  slotDurationMinutes: number
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const dateObj = new Date(date);
  
  for (let hour = businessHours.start; hour < businessHours.end; hour++) {
    for (let minute = 0; minute < 60; minute += slotDurationMinutes) {
      const slotStart = new Date(dateObj);
      slotStart.setHours(hour, minute, 0, 0);
      
      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + slotDurationMinutes);
      
      if (slotEnd.getHours() > businessHours.end || 
          (slotEnd.getHours() === businessHours.end && slotEnd.getMinutes() > 0)) {
        continue;
      }
      
      const isAvailable = !busyPeriods.some(busy => {
        return (slotStart < busy.end && slotEnd > busy.start);
      });
      
      const formatTime = (d: Date) => {
        const h = d.getHours().toString().padStart(2, '0');
        const m = d.getMinutes().toString().padStart(2, '0');
        return `${h}:${m}`;
      };
      
      slots.push({
        start: formatTime(slotStart),
        end: formatTime(slotEnd),
        available: isAvailable
      });
    }
  }
  
  return slots;
}

export async function getCalendarAvailability(
  resourceType: 'golf' | 'conference' | 'tours',
  date: string,
  durationMinutes?: number
): Promise<{ slots: TimeSlot[]; calendarId: string | null; error?: string }> {
  const config = CALENDAR_CONFIG[resourceType];
  if (!config) {
    return { slots: [], calendarId: null, error: 'Invalid resource type' };
  }
  
  const calendarId = await getCalendarIdByName(config.name);
  if (!calendarId) {
    return { slots: [], calendarId: null, error: `Calendar "${config.name}" not found` };
  }
  
  const busyPeriods = await getCalendarBusyTimes(calendarId, date);
  const slotDuration = durationMinutes || config.slotDuration;
  const slots = generateTimeSlots(date, busyPeriods, config.businessHours, slotDuration);
  
  return { slots, calendarId };
}

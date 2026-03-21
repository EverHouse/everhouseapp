import { getGoogleCalendarClient } from '../integrations';
import { createPacificDate } from '../../utils/dateUtils';
import { CALENDAR_CONFIG, getResourceConfig, TimeSlot, BusyPeriod } from './config';
import { getCalendarIdByName } from './cache';

import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
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
    logger.error('Error fetching busy times:', { error: getErrorMessage(error) });
    return [];
  }
}

export function generateTimeSlots(
  date: string,
  busyPeriods: BusyPeriod[],
  businessHours: { start: number; end: number; startMinute?: number },
  slotDurationMinutes: number
): TimeSlot[] {
  if (!Number.isFinite(slotDurationMinutes) || slotDurationMinutes <= 0) {
    return [];
  }
  const slots: TimeSlot[] = [];
  const startTotal = businessHours.start * 60 + (businessHours.startMinute || 0);
  const endTotal = businessHours.end * 60;

  const minutesToTimeStr = (totalMin: number): string => {
    const h = Math.floor(totalMin / 60).toString().padStart(2, '0');
    const m = (totalMin % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  for (let totalMin = startTotal; totalMin + slotDurationMinutes <= endTotal; totalMin += slotDurationMinutes) {
    const startTimeStr = minutesToTimeStr(totalMin);
    const endTimeStr = minutesToTimeStr(totalMin + slotDurationMinutes);
    const slotStart = createPacificDate(date, `${startTimeStr}:00`);
    const slotEnd = createPacificDate(date, `${endTimeStr}:00`);

    const isAvailable = !busyPeriods.some(busy => {
      return (slotStart < busy.end && slotEnd > busy.start);
    });

    slots.push({
      start: startTimeStr,
      end: endTimeStr,
      available: isAvailable
    });
  }
  
  return slots;
}

export async function getCalendarAvailability(
  resourceType: 'golf' | 'conference' | 'tours',
  date: string,
  durationMinutes?: number
): Promise<{ slots: TimeSlot[]; calendarId: string | null; error?: string }> {
  const staticConfig = CALENDAR_CONFIG[resourceType];
  if (!staticConfig) {
    return { slots: [], calendarId: null, error: 'Invalid resource type' };
  }
  
  const calendarId = await getCalendarIdByName(staticConfig.name);
  if (!calendarId) {
    return { slots: [], calendarId: null, error: `Calendar "${staticConfig.name}" not found` };
  }
  
  const config = await getResourceConfig(resourceType, date);
  const busyPeriods = await getCalendarBusyTimes(calendarId, date);
  const slotDuration: number = (durationMinutes && durationMinutes > 0) ? durationMinutes : (config.slotDuration ?? 60);
  const slots = generateTimeSlots(date, busyPeriods, config.businessHours, slotDuration);
  
  return { slots, calendarId };
}

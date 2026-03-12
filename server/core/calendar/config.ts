import { getSettingValue } from '../settingsHelper';

export const CALENDAR_CONFIG = {
  golf: {
    name: 'Booked Golf',
    businessHours: { start: 9, end: 21 },
    slotDuration: 60,
  },
  conference: {
    name: 'MBO_Conference_Room',
    businessHours: { start: 8, end: 18 },
    slotDuration: 30,
  },
  events: {
    name: 'Events',
  },
  wellness: {
    name: 'Wellness & Classes',
    businessHours: { start: 6, end: 21 },
  },
  tours: {
    name: 'Tours Scheduled',
    businessHours: { start: 10, end: 17 },
    slotDuration: 30,
  },
  internal: {
    name: 'Internal Calendar',
  }
};

function parseTimeString(timeStr: string): number | null {
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return hours + minutes / 60;
}

function parseDisplayHours(displayStr: string): { startMinutes: number; endMinutes: number } | null {
  if (!displayStr || displayStr.toLowerCase() === 'closed') return null;
  const parts = displayStr.split(/\s*[–\-]\s*/);
  if (parts.length !== 2) return null;
  const startTime = parseTimeString(parts[0]);
  const endTime = parseTimeString(parts[1]);
  if (startTime === null || endTime === null) return null;
  return { startMinutes: Math.round(startTime * 60), endMinutes: Math.round(endTime * 60) };
}

async function getDisplayHoursForDate(date: string): Promise<{ startMinutes: number; endMinutes: number } | null> {
  const d = new Date(date + 'T12:00:00');
  const dayOfWeek = d.getDay();

  let settingKey: string;
  let fallback: string;
  switch (dayOfWeek) {
    case 0: settingKey = 'hours.sunday'; fallback = '8:30 AM – 6:00 PM'; break;
    case 1: settingKey = 'hours.monday'; fallback = 'Closed'; break;
    case 5:
    case 6: settingKey = 'hours.friday_saturday'; fallback = '8:30 AM – 10:00 PM'; break;
    default: settingKey = 'hours.tuesday_thursday'; fallback = '8:30 AM – 8:00 PM'; break;
  }

  const displayStr = await getSettingValue(settingKey, fallback);
  return parseDisplayHours(displayStr);
}

export async function getResourceConfig(resourceType: 'golf' | 'conference' | 'wellness' | 'tours', date?: string) {
  const config = CALENDAR_CONFIG[resourceType];
  const defaultHours = config.businessHours || { start: 9, end: 21 };

  let businessHours: { start: number; end: number; startMinute?: number };
  if (date) {
    const dayHours = await getDisplayHoursForDate(date);
    if (dayHours) {
      businessHours = {
        start: Math.floor(dayHours.startMinutes / 60),
        end: Math.ceil(dayHours.endMinutes / 60),
        startMinute: dayHours.startMinutes % 60,
      };
    } else {
      businessHours = { start: 0, end: 0 };
    }
  } else {
    businessHours = defaultHours;
  }

  const slotDuration = 'slotDuration' in config
    ? Number(await getSettingValue(`resource.${resourceType}.slot_duration`, String(config.slotDuration)))
    : undefined;

  return {
    ...config,
    businessHours,
    ...(slotDuration !== undefined ? { slotDuration } : {}),
  };
}

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface BusyPeriod {
  start: Date;
  end: Date;
}

export interface ConferenceRoomBooking {
  id: string;
  summary: string;
  description: string | null;
  date: string;
  startTime: string;
  endTime: string;
  memberName: string | null;
}

export interface MemberMatchResult {
  userEmail: string | null;
  userName: string | null;
  matchMethod: 'attendee' | 'description' | 'name' | 'linked_email' | 'manual_link' | null;
}

export interface CalendarEventData {
  summary?: string;
  description?: string;
  attendees?: Array<{ email?: string }>;
}

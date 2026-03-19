import { CLUB_TIMEZONE } from '../../shared/constants/timezone';
export { CLUB_TIMEZONE };

export {
  getTodayPacific,
  addDaysToPacificDate,
  parseLocalDate,
  formatDateDisplay,
  formatDateDisplayWithDay,
  formatTime12Hour
} from '../../shared/utils/dateUtils';

import {
  getTodayPacific,
  addDaysToPacificDate,
  formatDateDisplayWithDay,
  formatTime12Hour
} from '../../shared/utils/dateUtils';

export function getPacificHour(): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    hour: 'numeric',
    hourCycle: 'h23'
  });
  return parseInt(formatter.format(new Date()), 10);
}

export function getPacificDateParts(): { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  const dowFormatter = new Intl.DateTimeFormat('en-US', { timeZone: CLUB_TIMEZONE, weekday: 'short' });
  const dayName = dowFormatter.format(now);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    dayOfWeek: dayMap[dayName] ?? 0
  };
}

export function getPacificDayOfMonth(): number {
  const parts = getPacificDateParts();
  return parts.day;
}

export function formatDatePacific(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

export function getPacificMidnightUTC(dateStr?: string): Date {
  const targetDate = dateStr || getTodayPacific();
  
  const getOffsetAtInstant = (instant: Date): number => {
    const offsetStr = new Intl.DateTimeFormat('en-US', {
      timeZone: CLUB_TIMEZONE,
      timeZoneName: 'shortOffset'
    }).formatToParts(instant).find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
    
    const offsetMatch = offsetStr.match(/GMT([+-]?\d+)/);
    return offsetMatch ? parseInt(offsetMatch[1], 10) : -8;
  };
  
  const formatOffset = (hours: number): string => {
    return hours < 0 
      ? `-${String(Math.abs(hours)).padStart(2, '0')}:00`
      : `+${String(hours).padStart(2, '0')}:00`;
  };
  
  let guess = new Date(`${targetDate}T00:00:00-08:00`);
  const actualOffset = getOffsetAtInstant(guess);
  
  if (actualOffset !== -8) {
    guess = new Date(`${targetDate}T00:00:00${formatOffset(actualOffset)}`);
    const finalOffset = getOffsetAtInstant(guess);
    if (finalOffset !== actualOffset) {
      guess = new Date(`${targetDate}T00:00:00${formatOffset(finalOffset)}`);
    }
  }
  
  return guess;
}

export function formatTimePacific(date: Date): string {
  return date.toLocaleTimeString('en-GB', { timeZone: CLUB_TIMEZONE, hour12: false });
}

export function getPacificISOString(dateStr: string, timeStr: string): string {
  const normalizedTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  
  const [year, month, day] = dateStr.split('-').map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  
  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    timeZoneName: 'shortOffset'
  });
  const parts = pacificFormatter.formatToParts(targetDate);
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || '-08:00';
  
  let offset = '-08:00';
  const offsetMatch = offsetPart.match(/GMT([+-])(\d+)/);
  if (offsetMatch) {
    const sign = offsetMatch[1];
    const hours = parseInt(offsetMatch[2], 10);
    offset = `${sign}${hours.toString().padStart(2, '0')}:00`;
  }
  
  return `${dateStr}T${normalizedTime}${offset}`;
}

export function createPacificDate(dateStr: string, timeStr: string): Date {
  return new Date(getPacificISOString(dateStr, timeStr));
}

export function getTomorrowPacific(): string {
  return addDaysToPacificDate(getTodayPacific(), 1);
}

export function formatNotificationDateTime(dateStr: string, timeStr: string): string {
  return `${formatDateDisplayWithDay(dateStr)} at ${formatTime12Hour(timeStr)}`;
}

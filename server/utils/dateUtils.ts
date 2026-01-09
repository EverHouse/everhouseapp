/**
 * Pacific Timezone Utilities for Backend
 * 
 * All club operations use America/Los_Angeles timezone for consistency.
 * Use these utilities for all date/time operations to ensure timezone correctness.
 */

export const CLUB_TIMEZONE = 'America/Los_Angeles';

/**
 * Get today's date in Pacific timezone as YYYY-MM-DD string
 */
export function getTodayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

/**
 * Get current hour (0-23) in Pacific timezone
 */
export function getPacificHour(): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    hour: 'numeric',
    hour12: false
  });
  return parseInt(formatter.format(new Date()), 10);
}

/**
 * Get Pacific date parts from current time
 */
export function getPacificDateParts(): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute')
  };
}

/**
 * Add days to a YYYY-MM-DD date string, returning a new YYYY-MM-DD string
 */
export function addDaysToPacificDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().split('T')[0];
}

/**
 * Parse a YYYY-MM-DD string as a local date (avoids timezone shift issues)
 * The returned Date represents the date at midnight in local time
 */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Format a date to YYYY-MM-DD in Pacific timezone
 */
export function formatDatePacific(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

/**
 * Format a date to HH:MM:SS in Pacific timezone (24-hour format)
 */
export function formatTimePacific(date: Date): string {
  return date.toLocaleTimeString('en-GB', { timeZone: CLUB_TIMEZONE, hour12: false });
}

/**
 * Get ISO string for a Pacific date and time
 * This creates a proper ISO timestamp from a date (YYYY-MM-DD) and time (HH:MM or HH:MM:SS)
 * interpreted as Pacific timezone. Handles DST correctly by computing offset for the target date.
 */
export function getPacificISOString(dateStr: string, timeStr: string): string {
  // Ensure time has seconds
  const normalizedTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  
  // Create a reference date for the target date to get the correct DST offset
  // Use noon to avoid edge cases around midnight DST transitions
  const [year, month, day] = dateStr.split('-').map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  
  // Get Pacific offset for the target date
  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    timeZoneName: 'shortOffset'
  });
  const parts = pacificFormatter.formatToParts(targetDate);
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || '-08:00';
  
  // Parse offset like "GMT-8" or "GMT-7" to "-08:00" or "-07:00"
  let offset = '-08:00'; // Default to PST
  const offsetMatch = offsetPart.match(/GMT([+-])(\d+)/);
  if (offsetMatch) {
    const sign = offsetMatch[1];
    const hours = parseInt(offsetMatch[2], 10);
    offset = `${sign}${hours.toString().padStart(2, '0')}:00`;
  }
  
  return `${dateStr}T${normalizedTime}${offset}`;
}

/**
 * Create a Date object from Pacific date and time strings
 * Properly handles the Pacific timezone offset
 */
export function createPacificDate(dateStr: string, timeStr: string): Date {
  return new Date(getPacificISOString(dateStr, timeStr));
}

/**
 * Format a YYYY-MM-DD date string for display (e.g., "Jan 15")
 * This parses the string directly and formats without timezone issues
 */
export function formatDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[month - 1]} ${day}`;
}

/**
 * Get day of week (0-6) for a YYYY-MM-DD date using Zeller's algorithm (timezone-agnostic)
 */
function getDayOfWeek(year: number, month: number, day: number): number {
  // Adjust for Zeller's algorithm (January = 13, February = 14 of previous year)
  if (month < 3) {
    month += 12;
    year -= 1;
  }
  const k = year % 100;
  const j = Math.floor(year / 100);
  const h = (day + Math.floor(13 * (month + 1) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) - 2 * j) % 7;
  // Convert from Zeller (0=Saturday) to JS convention (0=Sunday)
  return ((h + 6) % 7);
}

/**
 * Format a YYYY-MM-DD date string for display with weekday (e.g., "Wed, Jan 15")
 * Uses pure calculation, no timezone dependencies
 */
export function formatDateDisplayWithDay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayOfWeek = getDayOfWeek(year, month, day);
  return `${days[dayOfWeek]}, ${months[month - 1]} ${day}`;
}

/**
 * Get tomorrow's date in Pacific timezone as YYYY-MM-DD string
 */
export function getTomorrowPacific(): string {
  return addDaysToPacificDate(getTodayPacific(), 1);
}

/**
 * Format a time string (HH:MM or HH:MM:SS) to 12-hour format (e.g., "1:00 PM")
 */
export function formatTime12Hour(timeStr: string): string {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

/**
 * Format a date and time for user-friendly notification display
 * e.g., "Tue, Dec 30 at 1:00 PM"
 */
export function formatNotificationDateTime(dateStr: string, timeStr: string): string {
  return `${formatDateDisplayWithDay(dateStr)} at ${formatTime12Hour(timeStr)}`;
}

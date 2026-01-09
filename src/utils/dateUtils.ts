export const CLUB_TIMEZONE = 'America/Los_Angeles';

export function parseLocalDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  const cleanDate = dateStr.split('T')[0];
  const [year, month, day] = cleanDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Get day of week (0-6) for a YYYY-MM-DD date using Zeller's algorithm (timezone-agnostic)
 */
function getDayOfWeek(year: number, month: number, day: number): number {
  let m = month;
  let y = year;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const k = y % 100;
  const j = Math.floor(y / 100);
  const h = (day + Math.floor(13 * (m + 1) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) - 2 * j) % 7;
  return ((h + 6) % 7);
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDateLocal(dateStr: string, options?: Intl.DateTimeFormatOptions): string {
  const cleanDate = dateStr.split('T')[0];
  const [year, month, day] = cleanDate.split('-').map(Number);
  const dayOfWeek = getDayOfWeek(year, month, day);
  
  const useShortWeekday = !options?.weekday || options.weekday === 'short';
  const useShortMonth = !options?.month || options.month === 'short';
  
  const weekdayStr = useShortWeekday ? SHORT_DAYS[dayOfWeek] : LONG_DAYS[dayOfWeek];
  const monthStr = useShortMonth ? SHORT_MONTHS[month - 1] : LONG_MONTHS[month - 1];
  
  return `${weekdayStr}, ${monthStr} ${day}`;
}

export function formatDateShort(dateStr: string): string {
  return formatDateLocal(dateStr, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatDateFull(dateStr: string): string {
  return formatDateLocal(dateStr, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function formatDateDisplay(dateStr: string): string {
  const cleanDate = dateStr.split('T')[0];
  const [, month, day] = cleanDate.split('-').map(Number);
  return `${SHORT_MONTHS[month - 1]} ${day}`;
}

export function formatMemberSince(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const cleanDate = dateStr.split('T')[0];
    const [year, month] = cleanDate.split('-').map(Number);
    if (!year || !month || month < 1 || month > 12) return dateStr;
    return `${LONG_MONTHS[month - 1]} ${year}`;
  } catch {
    return dateStr;
  }
}

export function getDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTodayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

export function getTodayString(): string {
  return getTodayPacific();
}

export function getPacificHour(): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    hour: 'numeric',
    hour12: false
  });
  return parseInt(formatter.format(new Date()), 10);
}

export function getPacificDateParts(): { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value || 'Sun';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    dayOfWeek: weekdayMap[weekdayStr] ?? 0
  };
}

export function getNowTimePacific(): string {
  const parts = getPacificDateParts();
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function addDaysToPacificDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().split('T')[0];
}

export function compareDates(dateStr1: string, dateStr2: string): number {
  const clean1 = dateStr1.split('T')[0];
  const clean2 = dateStr2.split('T')[0];
  return clean1.localeCompare(clean2);
}

export function formatDateDisplayWithDay(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown date';
  const cleanDate = dateStr.split('T')[0];
  const [year, month, day] = cleanDate.split('-').map(Number);
  const dayOfWeek = getDayOfWeek(year, month, day);
  return `${SHORT_DAYS[dayOfWeek]}, ${SHORT_MONTHS[month - 1]} ${day}`;
}

export function formatTime12Hour(timeStr: string): string {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
}

export function formatDateTimePacific(isoString: string | null | undefined): string {
  if (!isoString) return 'Unknown date';
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric',
    timeZone: CLUB_TIMEZONE 
  });
}

/**
 * Get business hours for a given day of week
 * Returns null if closed (Monday)
 * Hours are in minutes from midnight
 */
export function getBusinessHours(dayOfWeek: number): { open: number; close: number } | null {
  const openMinutes = 8 * 60 + 30; // 8:30 AM
  switch (dayOfWeek) {
    case 1: // Monday - Closed
      return null;
    case 2: // Tuesday
    case 3: // Wednesday
    case 4: // Thursday
      return { open: openMinutes, close: 20 * 60 }; // 8 PM
    case 5: // Friday
    case 6: // Saturday
      return { open: openMinutes, close: 22 * 60 }; // 10 PM
    case 0: // Sunday
      return { open: openMinutes, close: 18 * 60 }; // 6 PM
    default:
      return null;
  }
}

/**
 * Check if the facility is currently open based on Pacific time
 * Returns { isOpen, reason } where reason explains why if closed
 */
export function isFacilityOpen(): { isOpen: boolean; reason?: string } {
  const parts = getPacificDateParts();
  const dayOfWeek = parts.dayOfWeek;
  const currentMinutes = parts.hour * 60 + parts.minute;
  
  const hours = getBusinessHours(dayOfWeek);
  
  if (!hours) {
    return { isOpen: false, reason: 'Closed on Mondays' };
  }
  
  if (currentMinutes < hours.open) {
    return { isOpen: false, reason: 'Before opening' };
  }
  
  if (currentMinutes >= hours.close) {
    return { isOpen: false, reason: 'After closing' };
  }
  
  return { isOpen: true };
}

/**
 * Get relative date label for cards (Today, Tomorrow, Yesterday, or formatted date)
 * Optimized for Pacific timezone
 */
export function getRelativeDateLabel(dateStr: string): string {
  const today = getTodayPacific();
  const cleanDate = dateStr.split('T')[0];
  
  if (cleanDate === today) {
    return 'Today';
  }
  
  const tomorrow = addDaysToPacificDate(today, 1);
  if (cleanDate === tomorrow) {
    return 'Tomorrow';
  }
  
  const yesterday = addDaysToPacificDate(today, -1);
  if (cleanDate === yesterday) {
    return 'Yesterday';
  }
  
  return formatDateDisplayWithDay(cleanDate);
}

/**
 * Format ISO timestamp to friendly relative time for cards
 * Examples: "Just now", "2 hours ago", "Yesterday", "Nov 21"
 */
export function formatRelativeTime(isoString: string): string {
  if (!isoString) return '';
  
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMinutes < 1) {
      return 'Just now';
    }
    
    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }
    
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    
    if (diffDays === 1) {
      return 'Yesterday';
    }
    
    if (diffDays < 7) {
      return `${diffDays} days ago`;
    }
    
    return formatDateDisplay(isoString);
  } catch {
    return '';
  }
}

/**
 * Format ISO timestamp for card metadata (compact, friendly format)
 * Example: "Nov 21 at 2:30 PM" or "Today at 2:30 PM"
 */
export function formatCardTimestamp(isoString: string): string {
  if (!isoString) return '';
  
  try {
    const date = new Date(isoString);
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
    const relativeDate = getRelativeDateLabel(dateStr);
    
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: CLUB_TIMEZONE,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    const timeStr = timeFormatter.format(date);
    
    if (relativeDate === 'Today' || relativeDate === 'Yesterday') {
      return `${relativeDate} at ${timeStr}`;
    }
    
    return `${formatDateDisplay(dateStr)} at ${timeStr}`;
  } catch {
    return '';
  }
}

/**
 * Format duration in minutes to human-readable string
 * Examples: "45 min", "1 hr", "1.5 hrs", "2 hrs"
 */
export function formatDuration(minutes: number): string {
  if (!minutes || minutes <= 0) return '';
  
  if (minutes < 60) {
    return `${minutes} min`;
  }
  
  const hours = minutes / 60;
  if (hours === 1) {
    return '1 hr';
  }
  
  if (Number.isInteger(hours)) {
    return `${hours} hrs`;
  }
  
  return `${hours.toFixed(1)} hrs`;
}

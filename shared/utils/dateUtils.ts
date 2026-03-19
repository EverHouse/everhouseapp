import { CLUB_TIMEZONE } from '../constants/timezone';

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
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function getTodayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

export function addDaysToPacificDate(dateStr: string, days: number): string {
  if (!dateStr) return getTodayPacific();
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().split('T')[0];
}

export function parseLocalDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  const cleanDate = dateStr.substring(0, 10);
  const [year, month, day] = cleanDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatDateDisplay(dateStr: string): string {
  if (!dateStr) return 'Unknown date';
  const cleanDate = dateStr.substring(0, 10);
  const [, month, day] = cleanDate.split('-').map(Number);
  if (!month || !day || month < 1 || month > 12) return 'Unknown date';
  return `${SHORT_MONTHS[month - 1]} ${day}`;
}

export function formatDateDisplayWithDay(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown date';
  const cleanDate = dateStr.substring(0, 10);
  const [year, month, day] = cleanDate.split('-').map(Number);
  const dayOfWeek = getDayOfWeek(year, month, day);
  return `${SHORT_DAYS[dayOfWeek]}, ${SHORT_MONTHS[month - 1]} ${day}`;
}

export function formatTime12Hour(timeStr: string): string {
  if (!timeStr || !timeStr.includes(':')) return timeStr || '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes ?? 0).padStart(2, '0')} ${period}`;
}

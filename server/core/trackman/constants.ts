import { getTodayPacific, getPacificDateParts } from '../../utils/dateUtils';

export interface UserIdRow {
  id: string;
}

export interface PaidCheckRow {
  has_paid?: boolean;
  has_snapshot?: boolean;
  has_paid_participants: boolean;
}

export interface SessionCheckRow {
  session_id: number | null;
}

export interface PaymentIntentRow {
  stripe_payment_intent_id: string;
}

export interface LinkedEmailRow {
  primary_email: string;
  linked_email: string;
}

export interface ParsedPlayer {
  type: 'member' | 'guest';
  email: string | null;
  name: string | null;
}

export interface TrackmanRow {
  bookingId: string;
  userName: string;
  userEmail: string;
  bookedDate: string;
  startDate: string;
  endDate: string;
  durationMins: number;
  status: string;
  bayNumber: string;
  playerCount: number;
  notes: string;
}

export interface HubSpotMember {
  email: string;
  firstName: string;
  lastName: string;
  status: string;
}

export interface SessionCreationInput {
  bookingId: number;
  trackmanBookingId: string;
  resourceId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  ownerEmail: string;
  ownerName: string;
  parsedPlayers: ParsedPlayer[];
  membersByEmail: Map<string, string>;
  trackmanEmailMapping: Map<string, string>;
  isPast: boolean;
}

export const PLACEHOLDER_EMAILS = [
  'anonymous@yourgolfbooking.com',
  'booking@evenhouse.club',
  'bookings@evenhouse.club',
  'tccmembership@evenhouse.club',
  'booking@everclub.co',
  'bookings@everclub.co',
];

export const VALID_MEMBER_STATUSES = ['active', 'expired', 'terminated', 'former_member', 'inactive'];

export function isPlaceholderEmail(email: string): boolean {
  const normalizedEmail = email.toLowerCase().trim();
  if (PLACEHOLDER_EMAILS.includes(normalizedEmail)) return true;
  if ((normalizedEmail.endsWith('@evenhouse.club') || normalizedEmail.endsWith('@everclub.co')) && normalizedEmail.length < 25) {
    const localPart = normalizedEmail.split('@')[0];
    if (/^[a-z]{3,12}$/.test(localPart) && !/\d/.test(localPart)) {
      return true;
    }
  }
  if (normalizedEmail.endsWith('@trackman.local') || normalizedEmail.startsWith('unmatched-')) return true;
  return false;
}

export function normalizeStatus(status: string, bookingDate: string, startTime: string): string | null {
  const s = status.toLowerCase().trim();
  const isFuture = isFutureBooking(bookingDate, startTime);
  
  if (s === 'attended' || s === 'confirmed') {
    return isFuture ? 'approved' : 'attended';
  }
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'no_show' || s === 'noshow') return 'no_show';
  return null;
}

export function isFutureBooking(bookingDate: string, startTime: string): boolean {
  const todayPacific = getTodayPacific();
  
  if (bookingDate > todayPacific) return true;
  if (bookingDate < todayPacific) return false;
  
  const pacificNow = getPacificDateParts();
  const currentMinutesSinceMidnight = pacificNow.hour * 60 + pacificNow.minute;
  
  const timeParts = startTime.split(':');
  const bookingHour = parseInt(timeParts[0], 10) || 0;
  const bookingMinute = parseInt(timeParts[1], 10) || 0;
  const bookingMinutesSinceMidnight = bookingHour * 60 + bookingMinute;
  
  return bookingMinutesSinceMidnight > currentMinutesSinceMidnight;
}

export function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  return hours * 60 + minutes;
}

export function isTimeWithinTolerance(time1: string, time2: string, toleranceMinutes: number = 5): boolean {
  const mins1 = timeToMinutes(time1);
  const mins2 = timeToMinutes(time2);
  return Math.abs(mins1 - mins2) <= toleranceMinutes;
}

import type { MemberProfile } from '../../types/data';

export interface MemberProfileDrawerProps {
  isOpen: boolean;
  member: MemberProfile | null;
  isAdmin: boolean;
  onClose: () => void;
  onViewAs: (member: MemberProfile) => void;
  onMemberDeleted?: () => void;
  visitorMode?: boolean;
}

export interface BookingHistoryItem {
  id: number | string;
  resource_name?: string;
  bay_name?: string;
  request_date: string;
  start_time: string;
  end_time: string;
  status: string;
  user_name?: string;
  user_email?: string;
  resource_id?: number;
  source?: string;
  created_at?: string;
  notes?: string;
  member_notes?: string;
  declared_player_count?: number | null;
  guest_count?: number | null;
}

export interface EventRsvpItem {
  id: number;
  event_id: number;
  title?: string;
  event_date?: string;
  start_time?: string;
  status: string;
  created_at?: string;
}

export interface WellnessHistoryItem {
  id: number;
  class_id?: number;
  title?: string;
  date?: string;
  time?: string;
  status: string;
  created_at?: string;
}

export interface GuestPassInfo {
  totalPasses: number;
  usedPasses: number;
  remainingPasses: number;
  passType?: string;
}

export interface GuestCheckInItem {
  id: number;
  guest_name?: string;
  guest_email?: string;
  check_in_date: string;
  booking_id?: number;
  member_email?: string;
}

export interface VisitHistoryItem {
  id: number;
  visit_date: string;
  check_in_time?: string;
  status: string;
  resource_name?: string;
}

export interface MemberHistory {
  bookingHistory: BookingHistoryItem[];
  bookingRequestsHistory: BookingHistoryItem[];
  eventRsvpHistory: EventRsvpItem[];
  wellnessHistory: WellnessHistoryItem[];
  guestPassInfo: GuestPassInfo | null;
  guestCheckInsHistory: GuestCheckInItem[];
  visitHistory: VisitHistoryItem[];
  pastBookingsCount?: number;
  pastEventsCount?: number;
  pastWellnessCount?: number;
  attendedVisitsCount?: number;
}

export interface GuestVisit {
  id: number;
  bookingId: number;
  guestName: string | null;
  guestEmail: string | null;
  visitDate: string;
  startTime: string;
  resourceName: string | null;
}

export interface MemberNote {
  id: number;
  memberEmail: string;
  content: string;
  createdBy: string;
  createdByName: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationLog {
  id: number;
  memberEmail: string;
  type: string;
  direction: string;
  subject: string;
  body: string;
  status: string;
  occurredAt: string;
  loggedBy: string;
  loggedByName: string;
  createdAt: string;
}

export type TabType = 'overview' | 'billing' | 'activity' | 'notes' | 'communications';

export const stripHtml = (html: string) => html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '';

export const formatDatePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const normalizedDate = dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`;
    const d = new Date(normalizedDate);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr;
  }
};

export const formatDateTimePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr;
  }
};

export const formatTime12Hour = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
};

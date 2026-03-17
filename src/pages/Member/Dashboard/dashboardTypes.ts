import { formatDateShort } from '../../../utils/dateUtils';

export const GUEST_CHECKIN_FIELDS = [
  { name: 'guest_firstname', label: 'Guest First Name', type: 'text' as const, required: true, placeholder: 'John' },
  { name: 'guest_lastname', label: 'Guest Last Name', type: 'text' as const, required: true, placeholder: 'Smith' },
  { name: 'guest_email', label: 'Guest Email', type: 'email' as const, required: true, placeholder: 'john@example.com' },
  { name: 'guest_phone', label: 'Guest Phone', type: 'tel' as const, required: false, placeholder: '(555) 123-4567' }
];

export interface DBBooking {
  id: number;
  resource_id: number;
  resource_name?: string;
  resource_type?: string;
  user_email: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  notes: string;
  declared_player_count?: number;
}

export interface _DBEvent {
  id: number;
  title: string;
  description: string;
  event_date: string;
  start_time: string;
  end_time: string;
  location: string;
  category: string;
}

export interface DBRSVP {
  id: number;
  event_id: number;
  status: string;
  title: string;
  event_date: string;
  start_time: string;
  end_time?: string;
  location: string;
  category: string;
}

export interface DBWellnessEnrollment {
  id: number;
  class_id: number;
  user_email: string;
  status: string;
  title: string;
  date: string;
  time: string;
  instructor: string;
  duration: string;
  category: string;
}

export interface DBBookingRequest {
  id: number;
  user_email: string;
  user_name: string | null;
  resource_id: number | null;
  resource_name?: string | null;
  bay_name: string | null;
  resource_preference: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  notes: string | null;
  status: 'pending' | 'approved' | 'confirmed' | 'attended' | 'no_show' | 'declined' | 'cancelled' | 'cancellation_pending';
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string;
  calendar_event_id?: string | null;
  is_linked_member?: boolean;
  primary_booker_name?: string | null;
  declared_player_count?: number;
}

export interface GuestPasses {
  passes_used: number;
  passes_total: number;
  passes_remaining: number;
}

export interface BannerAnnouncement {
  id: string;
  title: string;
  desc: string;
  linkType?: string;
  linkTarget?: string;
}

export interface DashboardWellnessClass { id: number; title: string; date: string; time: string }
export interface DashboardEvent { id: number; title: string; event_date: string; start_time: string }

export interface DashboardBookingItem {
  id: number | string;
  resource_name?: string;
  bay_name?: string;
  request_date?: string;
  start_time?: string;
  end_time?: string;
  status?: string;
  user_email?: string;
  user_name?: string;
  resource_id?: number;
  resource_type?: string;
  isLinkedMember?: boolean;
  primaryBookerName?: string;
  declared_player_count?: number;
  notes?: string;
  calendar_event_id?: string | null;
}

export interface DashboardRawBooking {
  booking_id?: number;
  request_date?: string;
  start_time?: string;
  end_time?: string;
  bay_name?: string;
  resource_name?: string;
  resource_type?: string;
  status?: string;
  declared_player_count?: number;
}

export interface ConfirmModalState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

export type ScheduleItem = {
  id: number | string;
  dbId: number;
  type: 'booking' | 'booking_request' | 'rsvp' | 'wellness' | 'conference_room_calendar';
  title: string;
  resourceType: string;
  date: string;
  rawDate: string;
  time: string;
  endTime: string;
  details: string;
  sortKey: string;
  status?: string;
  isLinkedMember?: boolean;
  primaryBookerName?: string | null;
  raw: DBBooking | DBBookingRequest | DBRSVP | DBWellnessEnrollment | DashboardBookingItem;
  source?: string;
  classId?: number;
};

export const formatDate = (dateStr: string): string => {
  return formatDateShort(dateStr);
};

export const getIconForType = (type: string) => {
  switch(type) {
    case 'simulator': return 'sports_golf';
    case 'conference_room': return 'meeting_room';
    case 'wellness_room': return 'spa';
    case 'wellness_class': return 'self_improvement';
    case 'event': return 'celebration';
    default: return 'event';
  }
};

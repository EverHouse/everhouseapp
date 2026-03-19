import { getDateString, getPacificDateParts } from '../../../utils/dateUtils';

export interface APIResource {
  id: number;
  name: string;
  type: string;
  description: string;
  capacity: number;
}

export interface APISlot {
  start_time: string;
  end_time: string;
  available: boolean;
  requested?: boolean;
}

export interface TimeSlot {
  id: string;
  start: string;
  end: string;
  startTime24: string;
  endTime24: string;
  label: string;
  available: boolean;
  availableResourceDbIds: number[];
  requestedResourceDbIds: number[];
}

export interface Resource {
  id: string;
  dbId: number;
  name: string;
  meta: string;
  badge?: string;
  icon?: string;
  image?: string;
}

export interface BookingRequest {
  id: number;
  user_email: string;
  user_name: string;
  resource_id: number | null;
  bay_name: string | null;
  resource_preference: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  notes: string | null;
  status: 'pending' | 'pending_approval' | 'approved' | 'confirmed' | 'attended' | 'no_show' | 'declined' | 'cancelled' | 'cancellation_pending';
  total_player_count?: number | null;
  trackman_booking_id?: string | null;
  staff_notes: string | null;
  suggested_time: string | null;
  created_at: string;
  is_linked_member?: boolean;
  primary_booker_name?: string | null;
}

export interface Closure {
  id: number;
  title: string | null;
  reason: string | null;
  noticeType: string | null;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  affectedAreas: string;
  isActive: boolean;
}

export interface GuestPassInfo {
  passes_used: number;
  passes_total: number;
  passes_remaining: number;
  passes_pending?: number;
  passes_remaining_conservative?: number;
}

export interface ExistingBookingCheck {
  hasExisting: boolean;
  bookings: Array<{ id: number; resourceName: string; startTime: string; endTime: string; status: string; isStaffCreated: boolean }>;
  staffCreated: boolean;
}

export interface FeeEstimateResponse {
  totalFee: number;
  feeBreakdown: {
    overageFee: number;
    guestFees: number;
    guestCount: number;
    overageMinutes: number;
    guestsUsingPasses: number;
    guestsCharged: number;
    guestPassesRemaining: number;
    guestFeePerUnit?: number;
    overageRatePerBlock?: number;
  };
}

export type { PlayerSlot } from '../../../components/shared/PlayerSlotEditor';

export const bookGolfKeys = {
  all: ['bookGolf'] as const,
  resources: (type: string) => [...bookGolfKeys.all, 'resources', type] as const,
  availability: (resourceIds: number[], date: string, duration: number, ignoreId?: number, userEmail?: string) => 
    [...bookGolfKeys.all, 'availability', resourceIds, date, duration, ignoreId, userEmail] as const,
  guestPasses: (email: string, tier: string) => [...bookGolfKeys.all, 'guestPasses', email, tier] as const,
  myRequests: (email: string) => [...bookGolfKeys.all, 'myRequests', email] as const,
  closures: () => [...bookGolfKeys.all, 'closures'] as const,
  existingBookings: (date: string, resourceType: string) => [...bookGolfKeys.all, 'existingBookings', date, resourceType] as const,
  feeEstimate: (params: string) => [...bookGolfKeys.all, 'feeEstimate', params] as const,
};

export const generateDates = (advanceDays: number = 7): { label: string; date: string; day: string; dateNum: string }[] => {
  const dates = [];
  const { year, month, day } = getPacificDateParts();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  for (let i = 0; i <= advanceDays; i++) {
    const d = new Date(year, month - 1, day + i);
    const dayName = days[d.getDay()];
    const dateNum = d.getDate().toString();
    dates.push({
      label: `${dayName} ${dateNum}`,
      date: getDateString(d),
      day: dayName,
      dateNum: dateNum
    });
  }
  return dates;
};

export const doesClosureAffectResource = (affectedAreas: string, resourceType: 'simulator' | 'conference'): boolean => {
  if (!affectedAreas) return false;
  
  const normalized = affectedAreas.toLowerCase().trim();
  if (normalized === 'entire_facility') return true;
  
  let parts: string[];
  if (normalized.startsWith('[')) {
    try {
      parts = JSON.parse(affectedAreas).map((p: string) => p.toLowerCase().trim());
    } catch {
      parts = [normalized];
    }
  } else {
    parts = normalized.split(',').map(p => p.trim());
  }
  
  if (resourceType === 'simulator') {
    return parts.some(part => 
      part === 'all_bays' || 
      part.startsWith('bay_') || 
      part.startsWith('bay ') ||
      /^bay\s*\d+$/.test(part)
    );
  } else if (resourceType === 'conference') {
    return parts.some(part => 
      part === 'conference_room' || 
      part === 'conference room'
    );
  }
  
  return false;
};

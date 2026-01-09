export interface BookingRequest {
  id: number | string;
  user_email: string | null;
  user_name: string | null;
  resource_id: number | null;
  bay_name: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  status: string;
  source?: string;
  resource_name?: string;
}

export interface Tour {
  id: number;
  guestName: string;
  guestEmail: string;
  tourDate: string;
  startTime: string;
  status: string;
  notes?: string;
}

export interface Closure {
  id: number;
  title: string;
  reason: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  affectedAreas: string;
  noticeType?: string | null;
}

export interface Announcement {
  id: number;
  title: string;
  content: string;
  type: string;
  is_active: boolean;
  created_at: string;
}

export interface WellnessClass {
  id: number;
  title: string;
  time: string;
  end_time: string;
  date: string;
}

export interface DBEvent {
  id: number;
  title: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  category?: string;
}

export interface BayStatus {
  id: number;
  name: string;
  type: string;
  isOccupied: boolean;
  isClosed?: boolean;
  closureReason?: string;
  currentBooking?: {
    id: number | string;
    userName: string;
    endTime: string;
    status: string;
  } | null;
}

export type TabType = 'home' | 'cafe' | 'events' | 'announcements' | 'directory' | 'simulator' | 'team' | 'faqs' | 'inquiries' | 'gallery' | 'tiers' | 'blocks' | 'changelog' | 'training' | 'updates' | 'tours' | 'bugs' | 'trackman' | 'wellness';

export interface StaffCommandCenterProps {
  onTabChange: (tab: TabType) => void;
  isAdmin?: boolean;
  wsConnected?: boolean;
}

export interface UpcomingBooking {
  id: number | string;
  resource_name: string;
  resource_type: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  user_name?: string;
}

export interface NextScheduleItem {
  type: 'tour' | 'booking';
  tour?: Tour;
  booking?: UpcomingBooking;
}

export interface NextActivityItem {
  type: 'event' | 'wellness';
  event?: DBEvent;
  wellness?: WellnessClass;
}

export interface CommandCenterData {
  pendingRequests: BookingRequest[];
  upcomingTours: Tour[];
  upcomingWellness: WellnessClass[];
  upcomingEvents: DBEvent[];
  todaysBookings: BookingRequest[];
  upcomingBookings: UpcomingBooking[];
  bayStatuses: BayStatus[];
  closures: Closure[];
  upcomingClosure: Closure | null;
  announcements: Announcement[];
  nextTour: Tour | null;
  nextEvent: DBEvent | WellnessClass | null;
  nextScheduleItem: NextScheduleItem | null;
  nextActivityItem: NextActivityItem | null;
  recentActivity: RecentActivity[];
  notifications: StaffNotification[];
  isLoading: boolean;
  lastSynced: Date;
}

export interface QuickLink {
  id: TabType;
  icon: string;
  label: string;
}

export interface RecentActivity {
  id: string;
  type: 'booking_created' | 'booking_approved' | 'check_in' | 'cancellation' | 'tour' | 'notification';
  timestamp: string;
  primary_text: string;
  secondary_text: string;
  icon: string;
}

export interface Alert {
  id: string | number;
  type: 'tour_scheduled' | 'booking_request' | 'booking_approved' | 'booking_cancelled' | 'system_alert' | 'notification';
  title: string;
  message: string;
  timestamp: string;
  is_read?: boolean;
  data?: Record<string, any>;
}

export interface StaffNotification {
  id: number;
  user_email: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  is_read: boolean;
  created_at: string;
}

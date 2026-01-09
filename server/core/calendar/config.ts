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
  },
  internal: {
    name: 'Internal Calendar',
  }
};

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
  matchMethod: 'attendee' | 'description' | 'name' | 'manual_link' | null;
}

export interface CalendarEventData {
  summary?: string;
  description?: string;
  attendees?: Array<{ email?: string }>;
}

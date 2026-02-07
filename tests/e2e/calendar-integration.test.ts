import { describe, it, expect } from 'vitest';

describe('Calendar Integration - Event Creation', () => {
  interface CalendarEvent {
    summary: string;
    description: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    location?: string;
  }
  
  function createCalendarEvent(booking: {
    memberName: string;
    resourceName: string;
    date: string;
    startTime: string;
    endTime: string;
    notes?: string;
  }): CalendarEvent {
    const startDateTime = `${booking.date}T${booking.startTime}:00`;
    const endDateTime = `${booking.date}T${booking.endTime}:00`;
    
    return {
      summary: `${booking.memberName} - ${booking.resourceName}`,
      description: booking.notes || `Booking for ${booking.memberName}`,
      start: { dateTime: startDateTime, timeZone: 'America/Los_Angeles' },
      end: { dateTime: endDateTime, timeZone: 'America/Los_Angeles' },
      location: 'Ever Club'
    };
  }
  
  it('should create calendar event with correct format for booking', () => {
    const booking = {
      memberName: 'John Doe',
      resourceName: 'Simulator Bay 1',
      date: '2026-01-15',
      startTime: '14:00',
      endTime: '15:00'
    };
    
    const event = createCalendarEvent(booking);
    
    expect(event.summary).toBe('John Doe - Simulator Bay 1');
    expect(event.start.timeZone).toBe('America/Los_Angeles');
    expect(event.start.dateTime).toBe('2026-01-15T14:00:00');
    expect(event.end.dateTime).toBe('2026-01-15T15:00:00');
    expect(event.location).toBe('Ever Club');
  });
  
  it('should include member notes in description when provided', () => {
    const booking = {
      memberName: 'Jane Doe',
      resourceName: 'Simulator Bay 2',
      date: '2026-01-15',
      startTime: '16:00',
      endTime: '17:00',
      notes: 'Bringing 3 guests for group lesson'
    };
    
    const event = createCalendarEvent(booking);
    
    expect(event.description).toBe('Bringing 3 guests for group lesson');
  });
  
  it('should use default description when no notes provided', () => {
    const booking = {
      memberName: 'John Doe',
      resourceName: 'Simulator Bay 1',
      date: '2026-01-15',
      startTime: '14:00',
      endTime: '15:00'
    };
    
    const event = createCalendarEvent(booking);
    
    expect(event.description).toContain('John Doe');
  });
});

describe('Calendar Integration - Event Deletion', () => {
  interface BookingWithCalendar {
    id: number;
    status: string;
    calendarEventId: string | null;
  }
  
  function shouldDeleteFromCalendar(booking: BookingWithCalendar): boolean {
    return booking.status === 'approved' && booking.calendarEventId !== null;
  }
  
  it('should identify approved booking with calendar event for deletion', () => {
    const booking: BookingWithCalendar = {
      id: 123,
      status: 'approved',
      calendarEventId: 'google-cal-event-id-123'
    };
    
    expect(shouldDeleteFromCalendar(booking)).toBe(true);
  });
  
  it('should not attempt deletion when calendarEventId is null', () => {
    const booking: BookingWithCalendar = {
      id: 123,
      status: 'approved',
      calendarEventId: null
    };
    
    expect(shouldDeleteFromCalendar(booking)).toBe(false);
  });
  
  it('should not attempt deletion for pending bookings', () => {
    const booking: BookingWithCalendar = {
      id: 123,
      status: 'pending',
      calendarEventId: null
    };
    
    expect(shouldDeleteFromCalendar(booking)).toBe(false);
  });
});

describe('Calendar Integration - Event Update on Reschedule', () => {
  interface CalendarEventUpdate {
    id: string;
    start: { dateTime: string };
    end: { dateTime: string };
  }
  
  function createRescheduleUpdate(
    eventId: string,
    newDate: string,
    newStartTime: string,
    newEndTime: string
  ): CalendarEventUpdate {
    return {
      id: eventId,
      start: { dateTime: `${newDate}T${newStartTime}:00` },
      end: { dateTime: `${newDate}T${newEndTime}:00` }
    };
  }
  
  it('should create update with new times for reschedule', () => {
    const update = createRescheduleUpdate(
      'evt-123',
      '2026-01-16',
      '16:00',
      '17:00'
    );
    
    expect(update.id).toBe('evt-123');
    expect(update.start.dateTime).toContain('2026-01-16');
    expect(update.start.dateTime).toContain('16:00');
    expect(update.end.dateTime).toContain('17:00');
  });
});

describe('Calendar Integration - External Sync', () => {
  interface ExternalEvent {
    id: string;
    summary: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    status: 'confirmed' | 'cancelled' | 'tentative';
  }
  
  function detectNewEvents(
    existingCalendarIds: string[],
    calendarEvents: ExternalEvent[]
  ): ExternalEvent[] {
    return calendarEvents.filter(
      event => !existingCalendarIds.includes(event.id) && event.status === 'confirmed'
    );
  }
  
  function detectCancelledEvents(calendarEvents: ExternalEvent[]): ExternalEvent[] {
    return calendarEvents.filter(event => event.status === 'cancelled');
  }
  
  it('should detect new events from calendar sync', () => {
    const existingIds = ['evt-1', 'evt-2'];
    const calendarEvents: ExternalEvent[] = [
      { id: 'evt-1', summary: 'Booking 1', start: { dateTime: '' }, end: { dateTime: '' }, status: 'confirmed' },
      { id: 'evt-2', summary: 'Booking 2', start: { dateTime: '' }, end: { dateTime: '' }, status: 'confirmed' },
      { id: 'evt-3', summary: 'New Booking', start: { dateTime: '' }, end: { dateTime: '' }, status: 'confirmed' }
    ];
    
    const newEvents = detectNewEvents(existingIds, calendarEvents);
    
    expect(newEvents.length).toBe(1);
    expect(newEvents[0].id).toBe('evt-3');
  });
  
  it('should detect cancelled events from calendar', () => {
    const calendarEvents: ExternalEvent[] = [
      { id: 'evt-1', summary: 'Booking 1', start: { dateTime: '' }, end: { dateTime: '' }, status: 'confirmed' },
      { id: 'evt-2', summary: 'Booking 2', start: { dateTime: '' }, end: { dateTime: '' }, status: 'cancelled' }
    ];
    
    const cancelledEvents = detectCancelledEvents(calendarEvents);
    
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0].id).toBe('evt-2');
  });
});

describe('Calendar Integration - Closure Parsing', () => {
  interface ClosureInfo {
    title: string;
    affectedAreas: string;
    startDate: string;
    endDate: string;
  }
  
  function parseClosureFromCalendarEvent(event: { 
    summary: string; 
    start: { date?: string; dateTime?: string };
    end: { date?: string; dateTime?: string };
  }): ClosureInfo | null {
    const bracketMatch = event.summary.match(/\[([^\]]+)\]/);
    if (!bracketMatch) return null;
    
    const title = event.summary.replace(/\[[^\]]+\]\s*/, '').trim();
    const affectedAreas = bracketMatch[1];
    
    const startDate = event.start.date || event.start.dateTime?.split('T')[0] || '';
    const endDate = event.end.date || event.end.dateTime?.split('T')[0] || '';
    
    return { title, affectedAreas, startDate, endDate };
  }
  
  it('should parse closure type from bracket prefix', () => {
    const event = {
      summary: '[Private Event] Company Holiday Party',
      start: { date: '2026-01-20' },
      end: { date: '2026-01-21' }
    };
    
    const closure = parseClosureFromCalendarEvent(event);
    
    expect(closure).not.toBeNull();
    expect(closure!.affectedAreas).toBe('Private Event');
    expect(closure!.title).toBe('Company Holiday Party');
    expect(closure!.startDate).toBe('2026-01-20');
  });
  
  it('should return null for events without bracket prefix', () => {
    const event = {
      summary: 'Regular Meeting',
      start: { date: '2026-01-20' },
      end: { date: '2026-01-21' }
    };
    
    const closure = parseClosureFromCalendarEvent(event);
    
    expect(closure).toBeNull();
  });
  
  it('should handle dateTime format for partial-day closures', () => {
    const event = {
      summary: '[Partial] Staff Training',
      start: { dateTime: '2026-01-20T14:00:00-08:00' },
      end: { dateTime: '2026-01-20T18:00:00-08:00' }
    };
    
    const closure = parseClosureFromCalendarEvent(event);
    
    expect(closure).not.toBeNull();
    expect(closure!.startDate).toBe('2026-01-20');
    expect(closure!.affectedAreas).toBe('Partial');
  });
});

describe('Calendar Integration - Conference Room Sync', () => {
  interface ConferenceRoomBooking {
    resourceType: string;
    requestDate: string;
    startTime: string;
    endTime: string;
    notes: string;
    status: string;
    source: string;
    calendarEventId: string;
  }
  
  function mapMindBodyEventToBooking(event: {
    id: string;
    summary: string;
    start: { dateTime: string };
    end: { dateTime: string };
  }): ConferenceRoomBooking {
    const startDate = event.start.dateTime.split('T')[0];
    const startTime = event.start.dateTime.split('T')[1].substring(0, 5);
    const endTime = event.end.dateTime.split('T')[1].substring(0, 5);
    
    return {
      resourceType: 'conference_room',
      requestDate: startDate,
      startTime,
      endTime,
      notes: event.summary,
      status: 'approved',
      source: 'mindbody_sync',
      calendarEventId: event.id
    };
  }
  
  it('should map MindBody calendar event to booking request', () => {
    const mindBodyEvent = {
      id: 'mb-evt-123',
      summary: 'Client Meeting - Smith Corp',
      start: { dateTime: '2026-01-20T10:00:00-08:00' },
      end: { dateTime: '2026-01-20T11:00:00-08:00' }
    };
    
    const booking = mapMindBodyEventToBooking(mindBodyEvent);
    
    expect(booking.resourceType).toBe('conference_room');
    expect(booking.requestDate).toBe('2026-01-20');
    expect(booking.startTime).toBe('10:00');
    expect(booking.endTime).toBe('11:00');
    expect(booking.source).toBe('mindbody_sync');
    expect(booking.status).toBe('approved');
    expect(booking.calendarEventId).toBe('mb-evt-123');
  });
  
  it('should skip duplicate synced events by calendarEventId', () => {
    const existingBookings = [
      { calendarEventId: 'mb-evt-1', source: 'mindbody_sync' },
      { calendarEventId: 'mb-evt-2', source: 'mindbody_sync' }
    ];
    
    const incomingEvents = [
      { id: 'mb-evt-1', summary: 'Existing Meeting' },
      { id: 'mb-evt-2', summary: 'Existing Meeting 2' },
      { id: 'mb-evt-3', summary: 'New Meeting' }
    ];
    
    const existingIds = existingBookings.map(b => b.calendarEventId);
    const newEvents = incomingEvents.filter(e => !existingIds.includes(e.id));
    
    expect(newEvents.length).toBe(1);
    expect(newEvents[0].id).toBe('mb-evt-3');
  });
});

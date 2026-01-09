import { getGoogleCalendarClient } from '../integrations';
import { getPacificISOString } from '../../utils/dateUtils';
import { withCalendarRetry } from '../retryUtils';

export async function createCalendarEvent(booking: any, bayName: string): Promise<string | null> {
  try {
    const calendar = await getGoogleCalendarClient();
    
    const requestDate = booking.requestDate || booking.request_date;
    const startTime = booking.startTime || booking.start_time;
    const endTime = booking.endTime || booking.end_time;
    const userName = booking.userName || booking.user_name;
    const userEmail = booking.userEmail || booking.user_email;
    const durationMinutes = booking.durationMinutes || booking.duration_minutes;
    
    if (!requestDate || !startTime || !endTime) {
      console.error('Error creating calendar event: Missing required booking fields', { requestDate, startTime, endTime });
      return null;
    }
    
    const event = {
      summary: `Booking: ${userName || userEmail}`,
      description: `Area: ${bayName}\nMember: ${userEmail}\nDuration: ${durationMinutes} minutes${booking.notes ? '\nNotes: ' + booking.notes : ''}`,
      start: {
        dateTime: getPacificISOString(requestDate, startTime),
        timeZone: 'America/Los_Angeles',
      },
      end: {
        dateTime: getPacificISOString(requestDate, endTime),
        timeZone: 'America/Los_Angeles',
      },
    };
    
    const response = await withCalendarRetry(
      () => calendar.events.insert({
        calendarId: 'primary',
        requestBody: event,
      }),
      'createCalendarEvent'
    );
    
    return response.data.id || null;
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return null;
  }
}

export async function createCalendarEventOnCalendar(
  calendarId: string,
  summary: string,
  description: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<string | null> {
  try {
    if (!date || !startTime) {
      console.error('Error creating calendar event: Missing date or startTime');
      return null;
    }
    
    const calendar = await getGoogleCalendarClient();
    
    const event = {
      summary,
      description,
      start: {
        dateTime: getPacificISOString(date, startTime),
        timeZone: 'America/Los_Angeles',
      },
      end: {
        dateTime: getPacificISOString(date, endTime || startTime),
        timeZone: 'America/Los_Angeles',
      },
    };
    
    const response = await withCalendarRetry(
      () => calendar.events.insert({
        calendarId,
        requestBody: event,
      }),
      'createCalendarEventOnCalendar'
    );
    
    return response.data.id || null;
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return null;
  }
}

export async function deleteCalendarEvent(eventId: string, calendarId: string = 'primary'): Promise<boolean> {
  try {
    const calendar = await getGoogleCalendarClient();
    await withCalendarRetry(
      () => calendar.events.delete({
        calendarId,
        eventId: eventId,
      }),
      'deleteCalendarEvent'
    );
    return true;
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    return false;
  }
}

export async function updateCalendarEvent(
  eventId: string,
  calendarId: string,
  summary: string,
  description: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  try {
    if (!date || !startTime) {
      console.error('Error updating calendar event: Missing date or startTime');
      return false;
    }
    
    const calendar = await getGoogleCalendarClient();
    
    await withCalendarRetry(
      () => calendar.events.update({
        calendarId,
        eventId,
        requestBody: {
          summary,
          description,
          start: {
            dateTime: getPacificISOString(date, startTime),
            timeZone: 'America/Los_Angeles',
          },
          end: {
            dateTime: getPacificISOString(date, endTime || startTime),
            timeZone: 'America/Los_Angeles',
          },
        },
      }),
      'updateCalendarEvent'
    );
    
    return true;
  } catch (error) {
    console.error('Error updating calendar event:', error);
    return false;
  }
}

import { getGoogleCalendarClient } from '../../integrations';
import { db } from '../../../db';
import { bookingRequests, users } from '../../../../shared/models/auth';
import { eq, and, ilike, or, sql } from 'drizzle-orm';
import { getTodayPacific, getPacificMidnightUTC } from '../../../utils/dateUtils';
import { CALENDAR_CONFIG, ConferenceRoomBooking, MemberMatchResult, CalendarEventData } from '../config';
import { getCalendarIdByName } from '../cache';
import { getConferenceRoomId } from '../../affectedAreas';
import { ensureSessionForBooking } from '../../bookingService/sessionManager';

export async function getConferenceRoomBookingsFromCalendar(
  memberName?: string,
  memberEmail?: string
): Promise<ConferenceRoomBooking[]> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
    
    if (!calendarId) {
      return [];
    }
    
    // Use Pacific midnight for consistent timezone handling
    const pacificMidnight = getPacificMidnightUTC();
    
    const response = await calendar.events.list({
      calendarId,
      timeMin: pacificMidnight.toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const events = response.data.items || [];
    const bookings: ConferenceRoomBooking[] = [];
    
    for (const event of events) {
      if (!event.id || !event.summary) continue;
      
      const summary = event.summary;
      let extractedName: string | null = null;
      
      const bookingMatch = summary.match(/^Booking:\s*(.+)$/i);
      if (bookingMatch) {
        extractedName = bookingMatch[1].trim();
      } else if (summary.includes('|')) {
        const segments = summary.split('|').map(s => s.trim());
        extractedName = segments[segments.length - 1] || summary.trim();
      } else {
        extractedName = summary.trim();
      }
      
      const normalizeName = (name: string): string[] => {
        const cleaned = name.toLowerCase().replace(/\s+/g, ' ').trim();
        const parts = cleaned.split(/[,\s]+/).filter(p => p.length > 0);
        return parts;
      };
      
      if (memberName || memberEmail) {
        let nameMatch = false;
        
        if (memberName && extractedName) {
          if (extractedName.toLowerCase().includes(memberName.toLowerCase())) {
            nameMatch = true;
          } else {
            const searchParts = normalizeName(memberName);
            const eventParts = normalizeName(extractedName);
            nameMatch = searchParts.every(sp => 
              eventParts.some(ep => ep.includes(sp) || sp.includes(ep))
            );
          }
        }
        
        const emailMatch = memberEmail && 
          (summary.toLowerCase().includes(memberEmail.toLowerCase()) ||
           (event.description && event.description.toLowerCase().includes(memberEmail.toLowerCase())));
        
        if (!nameMatch && !emailMatch) continue;
      }
      
      let eventDate: string;
      let startTime: string;
      let endTime: string;
      
      if (event.start?.dateTime) {
        const startDt = new Date(event.start.dateTime);
        const endDt = event.end?.dateTime ? new Date(event.end.dateTime) : startDt;
        
        eventDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        startTime = startDt.toLocaleTimeString('en-US', { 
          hour12: false, 
          hour: '2-digit', 
          minute: '2-digit',
          timeZone: 'America/Los_Angeles'
        });
        endTime = endDt.toLocaleTimeString('en-US', { 
          hour12: false, 
          hour: '2-digit', 
          minute: '2-digit',
          timeZone: 'America/Los_Angeles'
        });
      } else if (event.start?.date) {
        eventDate = event.start.date;
        startTime = '09:00';
        endTime = '17:00';
      } else {
        continue;
      }
      
      bookings.push({
        id: event.id,
        summary: event.summary,
        description: event.description || null,
        date: eventDate,
        startTime,
        endTime,
        memberName: extractedName
      });
    }
    
    return bookings;
  } catch (error) {
    console.error('Error fetching conference room bookings from calendar:', error);
    return [];
  }
}

export async function findMemberByCalendarEvent(eventData: CalendarEventData): Promise<MemberMatchResult> {
  const { summary, description, attendees } = eventData;
  
  const collectedEmails: string[] = [];

  if (attendees && attendees.length > 0) {
    for (const attendee of attendees) {
      if (attendee.email && !attendee.email.includes('calendar.google.com') && !attendee.email.includes('resource.calendar.google.com')) {
        const email = attendee.email.toLowerCase();
        collectedEmails.push(email);
        
        const user = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        
        if (user.length > 0) {
          const u = user[0];
          const userName = u.firstName && u.lastName 
            ? `${u.firstName} ${u.lastName}` 
            : (u.firstName || u.lastName || null);
          return { userEmail: email, userName, matchMethod: 'attendee' };
        }
      }
    }
  }

  if (description) {
    const emailLineMatch = description.match(/Email:\s*([\w.-]+@[\w.-]+\.\w+)/i);
    if (emailLineMatch) {
      const email = emailLineMatch[1].toLowerCase();
      if (!collectedEmails.includes(email)) {
        collectedEmails.push(email);
      }
      
      const user = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      
      if (user.length > 0) {
        const u = user[0];
        const userName = u.firstName && u.lastName 
          ? `${u.firstName} ${u.lastName}` 
          : (u.firstName || u.lastName || null);
        return { userEmail: email, userName, matchMethod: 'description' };
      }
    }
    
    const anyEmailMatch = description.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (anyEmailMatch) {
      const email = anyEmailMatch[0].toLowerCase();
      if (!collectedEmails.includes(email)) {
        collectedEmails.push(email);
      }
      
      const user = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      
      if (user.length > 0) {
        const u = user[0];
        const userName = u.firstName && u.lastName 
          ? `${u.firstName} ${u.lastName}` 
          : (u.firstName || u.lastName || null);
        return { userEmail: email, userName, matchMethod: 'description' };
      }
    }
  }

  for (const email of collectedEmails) {
    const userWithLinkedEmail = await db
      .select()
      .from(users)
      .where(sql`${users.manuallyLinkedEmails}::jsonb @> ${JSON.stringify([email])}::jsonb`)
      .limit(1);
    
    if (userWithLinkedEmail.length > 0) {
      const u = userWithLinkedEmail[0];
      const userName = u.firstName && u.lastName 
        ? `${u.firstName} ${u.lastName}` 
        : (u.firstName || u.lastName || null);
      return { userEmail: u.email || email, userName, matchMethod: 'manual_link' };
    }
  }

  let extractedName: string | null = null;
  if (summary) {
    const bookingMatch = summary.match(/^Booking:\s*(.+)$/i);
    if (bookingMatch) {
      extractedName = bookingMatch[1].trim();
    } else if (summary.includes('|')) {
      const segments = summary.split('|').map(s => s.trim());
      extractedName = segments[segments.length - 1] || null;
    } else {
      extractedName = summary.trim();
    }
  }

  if (extractedName) {
    const nameParts = extractedName.toLowerCase().split(/\s+/).filter(p => p.length > 0);
    
    if (nameParts.length >= 2) {
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ');
      
      const exactMatch = await db
        .select()
        .from(users)
        .where(
          and(
            ilike(users.firstName, firstName),
            ilike(users.lastName, lastName)
          )
        )
        .limit(1);
      
      if (exactMatch.length > 0) {
        const u = exactMatch[0];
        return { userEmail: u.email, userName: extractedName, matchMethod: 'name' };
      }
      
      const reverseMatch = await db
        .select()
        .from(users)
        .where(
          and(
            ilike(users.firstName, lastName),
            ilike(users.lastName, firstName)
          )
        )
        .limit(1);
      
      if (reverseMatch.length > 0) {
        const u = reverseMatch[0];
        return { userEmail: u.email, userName: extractedName, matchMethod: 'name' };
      }
    }
    
    if (nameParts.length >= 1) {
      const fuzzyUsers = await db
        .select()
        .from(users)
        .where(
          or(
            ...nameParts.flatMap(part => [
              ilike(users.firstName, `%${part}%`),
              ilike(users.lastName, `%${part}%`)
            ])
          )
        );
      
      let bestMatch: typeof fuzzyUsers[0] | null = null;
      let bestScore = 0;
      
      for (const user of fuzzyUsers) {
        const userNameParts = [
          user.firstName?.toLowerCase() || '',
          user.lastName?.toLowerCase() || ''
        ].filter(p => p.length > 0);
        
        let score = 0;
        for (const searchPart of nameParts) {
          for (const userPart of userNameParts) {
            if (userPart.includes(searchPart) || searchPart.includes(userPart)) {
              score++;
            }
          }
        }
        
        if (score > bestScore) {
          bestScore = score;
          bestMatch = user;
        }
      }
      
      if (bestMatch && (bestScore >= 2 || bestScore >= nameParts.length)) {
        return { userEmail: bestMatch.email, userName: extractedName, matchMethod: 'name' };
      }
    }
  }

  return { userEmail: null, userName: extractedName, matchMethod: null };
}

export async function syncConferenceRoomCalendarToBookings(options?: { monthsBack?: number }): Promise<{ synced: number; linked: number; created: number; skipped: number; error?: string; warning?: string }> {
  let linked = 0;
  let created = 0;
  let skipped = 0;

  try {
    const conferenceRoomId = await getConferenceRoomId();
    if (!conferenceRoomId) {
      return { synced: 0, linked: 0, created: 0, skipped: 0, warning: 'No conference room resource found in database' };
    }

    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);

    if (!calendarId) {
      return { synced: 0, linked: 0, created: 0, skipped: 0, warning: `Calendar "${CALENDAR_CONFIG.conference.name}" not found` };
    }

    const todayPacific = getTodayPacific();
    
    // Use Pacific midnight for consistent timezone handling
    let timeMin: Date;
    if (options?.monthsBack !== undefined) {
      // Get Pacific midnight and subtract months
      timeMin = getPacificMidnightUTC();
      timeMin.setMonth(timeMin.getMonth() - options.monthsBack);
    } else {
      timeMin = getPacificMidnightUTC();
    }

    let pageToken: string | undefined = undefined;
    
    do {
      const response = await calendar.events.list({
        calendarId,
        timeMin: timeMin.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        pageToken: pageToken,
      });

      const calendarEvents = response.data.items || [];
      pageToken = response.data.nextPageToken || undefined;

      for (const event of calendarEvents) {
        if (!event.id || !event.summary) continue;

        const googleEventId = event.id;
        const summary = event.summary;
        const description = event.description || '';

        let eventDate: string;
        let startTime: string;
        let endTime: string;

        if (event.start?.dateTime) {
          const startDt = new Date(event.start.dateTime);
          const endDt = event.end?.dateTime ? new Date(event.end.dateTime) : startDt;

          eventDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
          startTime = startDt.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Los_Angeles'
          });
          endTime = endDt.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Los_Angeles'
          });
        } else if (event.start?.date) {
          eventDate = event.start.date;
          startTime = '09:00';
          endTime = '17:00';
        } else {
          continue;
        }

        const isPastEvent = eventDate < todayPacific;
        const eventStatus = isPastEvent ? 'attended' : 'approved';

        const memberMatch = await findMemberByCalendarEvent({
          summary,
          description,
          attendees: event.attendees?.map(a => ({ email: a.email }))
        });
        
        const memberEmail = memberMatch.userEmail;
        const memberName = memberMatch.userName;

        let memberId: string | null = null;
        if (memberEmail) {
          const userLookup = await db
            .select({ id: users.id })
            .from(users)
            .where(ilike(users.email, memberEmail))
            .limit(1);
          if (userLookup.length > 0) {
            memberId = userLookup[0].id;
          }
        }

        const [startHour, startMin] = startTime.split(':').map(Number);
        const [endHour, endMin] = endTime.split(':').map(Number);
        const rawDuration = (endHour * 60 + endMin) - (startHour * 60 + startMin);
        // Round to nearest allowed duration (30-minute increments: 30, 60, 90, 120, 150, 180, 210, 240, 270, 300)
        const allowedDurations = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
        const durationMinutes = rawDuration <= 0 ? 60 : 
          allowedDurations.reduce((prev, curr) => 
            Math.abs(curr - rawDuration) < Math.abs(prev - rawDuration) ? curr : prev
          );

        const existingByCalendarEventId = await db
          .select()
          .from(bookingRequests)
          .where(eq(bookingRequests.calendarEventId, googleEventId));

        if (existingByCalendarEventId.length > 0) {
          skipped++;
          continue;
        }

        const existingBookings = await db
          .select()
          .from(bookingRequests)
          .where(
            and(
              eq(bookingRequests.resourceId, conferenceRoomId),
              eq(bookingRequests.requestDate, eventDate)
            )
          );

        let matchedBooking = null;
        for (const booking of existingBookings) {
          const bookingStart = booking.startTime as string;
          const bookingEnd = booking.endTime as string;
          const [bsH, bsM] = bookingStart.split(':').map(Number);
          const [beH, beM] = bookingEnd.split(':').map(Number);
          const bookingStartMins = bsH * 60 + bsM;
          const bookingEndMins = beH * 60 + beM;
          const eventStartMins = startHour * 60 + startMin;
          const eventEndMins = endHour * 60 + endMin;

          if (eventStartMins < bookingEndMins && eventEndMins > bookingStartMins) {
            matchedBooking = booking;
            break;
          }
        }

        if (matchedBooking) {
          const updates: any = { calendarEventId: googleEventId, updatedAt: new Date() };
          if (matchedBooking.status === 'pending') {
            updates.status = eventStatus;
          }
          if (memberId && !matchedBooking.userId) {
            updates.userId = memberId;
            updates.userEmail = memberEmail;
          }
          await db
            .update(bookingRequests)
            .set(updates)
            .where(eq(bookingRequests.id, matchedBooking.id));
          linked++;

          if (!matchedBooking.sessionId) {
            try {
              await ensureSessionForBooking({
                bookingId: matchedBooking.id,
                resourceId: conferenceRoomId,
                sessionDate: eventDate,
                startTime: startTime + ':00',
                endTime: endTime + ':00',
                ownerEmail: (memberEmail || matchedBooking.userEmail || 'unknown@calendar.sync').toLowerCase(),
                ownerName: memberName || matchedBooking.userName || undefined,
                ownerUserId: memberId || matchedBooking.userId || undefined,
                source: 'staff_manual',
                createdBy: 'calendar_sync'
              });
            } catch (sessionErr) {
              console.error('[Conference Room Sync] Failed to ensure session for linked booking:', sessionErr);
            }
          }
        } else {
          const [newBooking] = await db.insert(bookingRequests).values({
            userEmail: memberEmail || 'unknown@mindbody.com',
            userName: memberName,
            userId: memberId,
            resourceId: conferenceRoomId,
            requestDate: eventDate,
            startTime: startTime,
            endTime: endTime,
            durationMinutes,
            notes: `Synced from Google Calendar: ${summary}`,
            status: eventStatus,
            calendarEventId: googleEventId,
          }).returning({ id: bookingRequests.id });
          created++;

          if (newBooking) {
            try {
              await ensureSessionForBooking({
                bookingId: newBooking.id,
                resourceId: conferenceRoomId,
                sessionDate: eventDate,
                startTime: startTime + ':00',
                endTime: endTime + ':00',
                ownerEmail: (memberEmail || 'unknown@mindbody.com').toLowerCase(),
                ownerName: memberName || undefined,
                ownerUserId: memberId || undefined,
                source: 'staff_manual',
                createdBy: 'calendar_sync'
              });
            } catch (sessionErr) {
              console.error('[Conference Room Sync] Failed to ensure session for new booking:', sessionErr);
            }
          }
        }
      }
    } while (pageToken);

    const synced = linked + created;
    console.log(`[Conference Room Sync] Synced ${synced} events (linked: ${linked}, created: ${created}, skipped: ${skipped})`);
    return { synced, linked, created, skipped };
  } catch (error) {
    console.error('Error syncing conference room calendar to bookings:', error);
    return { synced: 0, linked: 0, created: 0, skipped: 0, error: String(error) };
  }
}

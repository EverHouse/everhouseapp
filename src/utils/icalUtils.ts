export interface ICalEventData {
  title: string;
  description?: string;
  location?: string;
  startDate: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}

function formatICalDate(dateStr: string, timeStr?: string): string {
  const [year, month, day] = dateStr.split('-');
  if (timeStr) {
    const timeParts = timeStr.split(':');
    const hours = timeParts[0] || '00';
    const minutes = timeParts[1] || '00';
    return `${year}${month}${day}T${hours.padStart(2, '0')}${minutes.padStart(2, '0')}00`;
  }
  return `${year}${month}${day}T000000`;
}

function formatICalDateOnly(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${year}${month}${day}`;
}

function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  if (line.length <= 75) {
    return line;
  }
  const chunks: string[] = [];
  chunks.push(line.substring(0, 75));
  let remaining = line.substring(75);
  while (remaining.length > 0) {
    chunks.push(' ' + remaining.substring(0, 74));
    remaining = remaining.substring(74);
  }
  return chunks.join('\r\n');
}

export function generateICalEvent(event: ICalEventData): string {
  const uid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@evenhouse.club`;
  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  
  const isAllDay = !event.startTime;
  const timezone = 'America/Los_Angeles';
  
  let dtstartLine: string;
  let dtendLine: string;
  
  if (isAllDay) {
    const startDateOnly = formatICalDateOnly(event.startDate);
    dtstartLine = `DTSTART;VALUE=DATE:${startDateOnly}`;
    const nextDay = new Date(event.startDate + 'T12:00:00');
    nextDay.setDate(nextDay.getDate() + 1);
    const endDateOnly = `${nextDay.getFullYear()}${String(nextDay.getMonth() + 1).padStart(2, '0')}${String(nextDay.getDate()).padStart(2, '0')}`;
    dtendLine = `DTEND;VALUE=DATE:${endDateOnly}`;
  } else {
    const dtstart = formatICalDate(event.startDate, event.startTime);
    dtstartLine = `DTSTART;TZID=${timezone}:${dtstart}`;
    
    let dtend: string;
    if (event.endTime) {
      dtend = formatICalDate(event.startDate, event.endTime);
    } else if (event.durationMinutes) {
      const [hours, minutes] = event.startTime!.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + event.durationMinutes;
      const endHours = Math.floor(totalMinutes / 60) % 24;
      const endMins = totalMinutes % 60;
      dtend = formatICalDate(event.startDate, `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`);
    } else {
      const [hours, minutes] = event.startTime!.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + 120;
      const endHours = Math.floor(totalMinutes / 60) % 24;
      const endMins = totalMinutes % 60;
      dtend = formatICalDate(event.startDate, `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`);
    }
    dtendLine = `DTEND;TZID=${timezone}:${dtend}`;
  }
  
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ever House//Members App//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    'TZID:America/Los_Angeles',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'TZNAME:PDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'TZNAME:PST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    dtstartLine,
    dtendLine,
    foldLine(`SUMMARY:${escapeICalText(event.title)}`),
  ];
  
  if (event.description) {
    lines.push(foldLine(`DESCRIPTION:${escapeICalText(event.description)}`));
  }
  
  if (event.location) {
    lines.push(foldLine(`LOCATION:${escapeICalText(event.location)}`));
  }
  
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  
  return lines.join('\r\n') + '\r\n';
}

export function downloadICalFile(event: ICalEventData, filename?: string): void {
  const icalContent = generateICalEvent(event);
  const blob = new Blob([icalContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `${event.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

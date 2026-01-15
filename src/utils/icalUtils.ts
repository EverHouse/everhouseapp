export function downloadICalFile(event: {
  title: string;
  description?: string;
  startDate: Date | string;
  endDate?: Date | string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  location?: string;
}, customFilename?: string) {
  const formatICalDate = (date: Date) => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  const escape = (str: string | undefined) => {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  };

  const parseTimeToHoursMinutes = (timeStr: string): { hours: number; minutes: number } => {
    if (!timeStr) return { hours: 12, minutes: 0 };
    
    const match24Hour = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (match24Hour) {
      return { hours: parseInt(match24Hour[1]), minutes: parseInt(match24Hour[2]) };
    }
    
    const match12Hour = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (match12Hour) {
      let hours = parseInt(match12Hour[1]);
      const minutes = match12Hour[2] ? parseInt(match12Hour[2]) : 0;
      const period = match12Hour[3].toUpperCase();
      if (period === 'AM') {
        hours = hours === 12 ? 0 : hours;
      } else {
        hours = hours === 12 ? 12 : hours + 12;
      }
      return { hours, minutes };
    }
    
    return { hours: 12, minutes: 0 };
  };

  const parseDateString = (dateStr: string): Date => {
    if (dateStr.includes('T')) {
      return new Date(dateStr);
    }
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  };

  let startDateTime: Date;
  let endDateTime: Date;

  if (event.startDate instanceof Date) {
    startDateTime = new Date(event.startDate);
  } else {
    startDateTime = parseDateString(event.startDate);
  }

  if (event.startTime) {
    const { hours, minutes } = parseTimeToHoursMinutes(event.startTime);
    startDateTime.setHours(hours, minutes, 0, 0);
  }

  if (event.endDate) {
    if (event.endDate instanceof Date) {
      endDateTime = new Date(event.endDate);
    } else {
      endDateTime = parseDateString(event.endDate);
    }
    if (event.endTime) {
      const { hours, minutes } = parseTimeToHoursMinutes(event.endTime);
      endDateTime.setHours(hours, minutes, 0, 0);
    }
  } else if (event.endTime) {
    endDateTime = new Date(startDateTime);
    const { hours, minutes } = parseTimeToHoursMinutes(event.endTime);
    endDateTime.setHours(hours, minutes, 0, 0);
  } else if (event.durationMinutes) {
    endDateTime = new Date(startDateTime.getTime() + event.durationMinutes * 60 * 1000);
  } else {
    endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
  }

  const icalContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EvenHouse//Members App//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `DTSTART:${formatICalDate(startDateTime)}`,
    `DTEND:${formatICalDate(endDateTime)}`,
    `SUMMARY:${escape(event.title)}`,
    event.description ? `DESCRIPTION:${escape(event.description)}` : '',
    event.location ? `LOCATION:${escape(event.location)}` : '',
    `UID:${Date.now()}@evenhouse.club`,
    `DTSTAMP:${formatICalDate(new Date())}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');

  const filename = customFilename || `${event.title.replace(/[^a-z0-9]/gi, '_')}.ics`;
  const blob = new Blob([icalContent], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

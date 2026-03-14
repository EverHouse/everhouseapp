// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  CLUB_TIMEZONE,
  addDaysToPacificDate,
  parseLocalDate,
  formatDatePacific,
  formatDateDisplay,
  formatDateDisplayWithDay,
  formatTime12Hour,
  formatNotificationDateTime,
  getPacificISOString,
  createPacificDate,
} from '../server/utils/dateUtils';

describe('CLUB_TIMEZONE', () => {
  it('is America/Los_Angeles', () => {
    expect(CLUB_TIMEZONE).toBe('America/Los_Angeles');
  });
});

describe('addDaysToPacificDate', () => {
  it('adds 1 day', () => {
    expect(addDaysToPacificDate('2025-01-15', 1)).toBe('2025-01-16');
  });

  it('adds 0 days', () => {
    expect(addDaysToPacificDate('2025-01-15', 0)).toBe('2025-01-15');
  });

  it('handles month rollover', () => {
    expect(addDaysToPacificDate('2025-01-31', 1)).toBe('2025-02-01');
  });

  it('handles year rollover', () => {
    expect(addDaysToPacificDate('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('handles negative days', () => {
    expect(addDaysToPacificDate('2025-01-15', -1)).toBe('2025-01-14');
  });

  it('handles leap year Feb 28 -> 29', () => {
    expect(addDaysToPacificDate('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('handles non-leap year Feb 28 -> Mar 1', () => {
    expect(addDaysToPacificDate('2025-02-28', 1)).toBe('2025-03-01');
  });
});

describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD to a Date at midnight local', () => {
    const date = parseLocalDate('2025-06-15');
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(5);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(0);
  });

  it('handles January 1st', () => {
    const date = parseLocalDate('2025-01-01');
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(1);
  });

  it('handles December 31st', () => {
    const date = parseLocalDate('2025-12-31');
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(11);
    expect(date.getDate()).toBe(31);
  });
});

describe('formatDatePacific', () => {
  it('formats a Date to YYYY-MM-DD in Pacific timezone', () => {
    const date = new Date('2025-06-15T20:00:00Z');
    const result = formatDatePacific(date);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatDateDisplay', () => {
  it('formats to "Jan 15" style', () => {
    expect(formatDateDisplay('2025-01-15')).toBe('Jan 15');
  });

  it('formats December date', () => {
    expect(formatDateDisplay('2025-12-25')).toBe('Dec 25');
  });

  it('formats single-digit day', () => {
    expect(formatDateDisplay('2025-03-01')).toBe('Mar 1');
  });

  it('formats all months correctly', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    months.forEach((name, index) => {
      const monthStr = (index + 1).toString().padStart(2, '0');
      expect(formatDateDisplay(`2025-${monthStr}-10`)).toBe(`${name} 10`);
    });
  });
});

describe('formatDateDisplayWithDay', () => {
  it('formats with weekday (known date)', () => {
    expect(formatDateDisplayWithDay('2025-01-15')).toBe('Wed, Jan 15');
  });

  it('formats Sunday', () => {
    expect(formatDateDisplayWithDay('2025-01-12')).toBe('Sun, Jan 12');
  });

  it('formats Saturday', () => {
    expect(formatDateDisplayWithDay('2025-01-11')).toBe('Sat, Jan 11');
  });
});

describe('formatTime12Hour', () => {
  it('formats midnight as 12:00 AM', () => {
    expect(formatTime12Hour('00:00')).toBe('12:00 AM');
  });

  it('formats noon as 12:00 PM', () => {
    expect(formatTime12Hour('12:00')).toBe('12:00 PM');
  });

  it('formats 1 PM', () => {
    expect(formatTime12Hour('13:00')).toBe('1:00 PM');
  });

  it('formats 11:30 AM', () => {
    expect(formatTime12Hour('11:30')).toBe('11:30 AM');
  });

  it('formats 23:59 as 11:59 PM', () => {
    expect(formatTime12Hour('23:59')).toBe('11:59 PM');
  });

  it('handles HH:MM:SS format', () => {
    expect(formatTime12Hour('14:30:00')).toBe('2:30 PM');
  });

  it('returns empty string for null/undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatTime12Hour(null as any)).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatTime12Hour(undefined as any)).toBe('');
  });

  it('returns original string if no colon', () => {
    expect(formatTime12Hour('invalid')).toBe('invalid');
  });
});

describe('formatNotificationDateTime', () => {
  it('combines date and time formatting', () => {
    expect(formatNotificationDateTime('2025-01-15', '13:00')).toBe('Wed, Jan 15 at 1:00 PM');
  });

  it('handles midnight', () => {
    expect(formatNotificationDateTime('2025-01-12', '00:00')).toBe('Sun, Jan 12 at 12:00 AM');
  });
});

describe('getPacificISOString', () => {
  it('returns ISO string with offset for HH:MM time', () => {
    const result = getPacificISOString('2025-01-15', '14:30');
    expect(result).toMatch(/^2025-01-15T14:30:00[+-]\d{2}:00$/);
  });

  it('returns ISO string with offset for HH:MM:SS time', () => {
    const result = getPacificISOString('2025-01-15', '14:30:45');
    expect(result).toMatch(/^2025-01-15T14:30:45[+-]\d{2}:00$/);
  });
});

describe('createPacificDate', () => {
  it('returns a Date object', () => {
    const result = createPacificDate('2025-01-15', '14:30');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });
});

import { CLUB_TIMEZONE, getTodayPacific } from './dateUtils';

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function getCurrentPacificYear(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric'
  }).formatToParts(new Date());
  return parseInt(parts.find(p => p.type === 'year')!.value, 10);
}

export function normalizeToISODate(input: string | undefined | null): string {
  if (!input || typeof input !== 'string') {
    return getTodayPacific();
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return getTodayPacific();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  const humanMatch = trimmed.match(/([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (humanMatch) {
    const monthStr = humanMatch[1].slice(0, 3).toLowerCase();
    const day = parseInt(humanMatch[2], 10);
    const month = MONTH_MAP[monthStr];

    if (month !== undefined && day >= 1 && day <= 31) {
      const year = humanMatch[3] ? parseInt(humanMatch[3], 10) : getCurrentPacificYear();
      return `${year}-${pad(month + 1)}-${pad(day)}`;
    }
  }

  const dayPrefixMatch = trimmed.match(/^[A-Za-z]+,\s*([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (dayPrefixMatch) {
    const monthStr = dayPrefixMatch[1].slice(0, 3).toLowerCase();
    const day = parseInt(dayPrefixMatch[2], 10);
    const month = MONTH_MAP[monthStr];

    if (month !== undefined && day >= 1 && day <= 31) {
      const year = dayPrefixMatch[3] ? parseInt(dayPrefixMatch[3], 10) : getCurrentPacificYear();
      return `${year}-${pad(month + 1)}-${pad(day)}`;
    }
  }

  try {
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = parsed.getMonth() + 1;
      const d = parsed.getDate();
      return `${y}-${pad(m)}-${pad(d)}`;
    }
  } catch {}

  return getTodayPacific();
}

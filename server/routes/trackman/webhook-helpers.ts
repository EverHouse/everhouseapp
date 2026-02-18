import { logger } from '../../core/logger';
import { formatDatePacific, formatTimePacific } from '../../utils/dateUtils';

export const isProduction = process.env.NODE_ENV === 'production';

export function calculateDurationMinutes(startTime: string, endTime: string): number {
  const startParts = startTime.split(':').map(Number);
  const endParts = endTime.split(':').map(Number);
  const startMinutes = startParts[0] * 60 + startParts[1];
  let endMinutes = endParts[0] * 60 + endParts[1];
  
  if (endMinutes === startMinutes) {
    logger.warn('[Trackman Webhook] Equal start and end times detected, defaulting to 60 minutes', {
      extra: { startTime, endTime }
    });
    return 60;
  }
  
  if (endMinutes < startMinutes) {
    endMinutes += 24 * 60;
  }
  
  return endMinutes - startMinutes;
}

export interface TrackmanBookingPayload {
  id?: string;
  booking_id?: string;
  bookingId?: string;
  status?: string;
  bay_id?: string;
  bayId?: string;
  bay_name?: string;
  bayName?: string;
  bay_serial?: string;
  baySerial?: string;
  resource_serial?: string;
  resourceSerial?: string;
  start_time?: string;
  startTime?: string;
  end_time?: string;
  endTime?: string;
  date?: string;
  customer?: {
    email?: string;
    name?: string;
    phone?: string;
    id?: string;
  };
  user?: {
    email?: string;
    name?: string;
    phone?: string;
    id?: string;
  };
  player_count?: number;
  playerCount?: number;
  created_at?: string;
  updated_at?: string;
  external_booking_id?: string;
  externalBookingId?: string;
}

export interface TrackmanV2BayOption {
  id: number;
  name: string;
  duration?: number;
  subtitle?: string | null;
}

export interface TrackmanV2PlayerOption {
  id: number;
  name: string;
  quantity: number;
  subtitle?: string | null;
}

export interface TrackmanV2Booking {
  id: number;
  bay?: {
    id: number;
    ref: string;
  };
  start: string;
  end: string;
  type?: string;
  range?: {
    id: number;
  };
  status: string;
  bayOption?: TrackmanV2BayOption;
  created_at?: string;
  playerOptions?: TrackmanV2PlayerOption[];
  externalBookingId?: string;
  externalBookingProvider?: string;
}

export interface TrackmanV2Venue {
  id: number;
  name: string;
  slug: string;
}

export interface TrackmanV2WebhookPayload {
  venue?: TrackmanV2Venue;
  booking?: TrackmanV2Booking;
}

export interface TrackmanWebhookPayload {
  event_type?: string;
  eventType?: string;
  data?: TrackmanBookingPayload;
  booking?: TrackmanBookingPayload | TrackmanV2Booking;
  user?: Record<string, unknown>;
  purchase?: Record<string, unknown>;
  timestamp?: string;
  venue?: TrackmanV2Venue;
}

export interface NormalizedBookingFields {
  trackmanBookingId: string | undefined;
  bayId: string | undefined;
  bayName: string | undefined;
  baySerial: string | undefined;
  startTime: string | undefined;
  endTime: string | undefined;
  date: string | undefined;
  customerEmail: string | undefined;
  customerName: string | undefined;
  customerPhone: string | undefined;
  customerId: string | undefined;
  playerCount: number;
  status: string | undefined;
  parsedDate: string | undefined;
  parsedStartTime: string | undefined;
  parsedEndTime: string | undefined;
  externalBookingId?: string;
}

export const BAY_SERIAL_TO_RESOURCE: Record<string, number> = {
  '24120062': 1,
  '23510044': 2,
  '24070104': 3,
  '24080064': 4,
};

export function extractBookingData(payload: TrackmanWebhookPayload): TrackmanBookingPayload | null {
  return payload.data || payload.booking as TrackmanBookingPayload || null;
}

export function isTrackmanV2Payload(payload: unknown): payload is TrackmanV2WebhookPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const booking = p.booking as Record<string, unknown> | undefined;
  return !!booking?.start && 
         !!booking?.end && 
         typeof booking?.id === 'number' &&
         !!(p.venue || (booking?.bay as Record<string, unknown>)?.ref);
}

export function parseISOToPacific(isoStr: string): { date: string; time: string } {
  const dt = new Date(isoStr);
  if (isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO date: ${isoStr}`);
  }
  return {
    date: formatDatePacific(dt),
    time: formatTimePacific(dt).substring(0, 5),
  };
}

export function inferEventTypeFromStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === 'cancelled' || s === 'canceled' || s === 'deleted') {
    return 'booking.cancelled';
  }
  if (s === 'attended' || s === 'confirmed' || s === 'booked') {
    return 'booking.created';
  }
  return 'booking_update';
}

export function parseTrackmanV2Payload(payload: TrackmanV2WebhookPayload): {
  normalized: NormalizedBookingFields;
  eventType: string;
  externalBookingId: string | undefined;
  bayRef: string | undefined;
} {
  const booking = payload.booking!;
  
  const startParsed = parseISOToPacific(booking.start);
  const endParsed = parseISOToPacific(booking.end);
  
  const playerCount = booking.playerOptions?.reduce((sum, opt) => sum + opt.quantity, 0) || 1;
  
  const normalized: NormalizedBookingFields = {
    trackmanBookingId: String(booking.id),
    bayId: booking.bay?.ref,
    bayName: booking.bay?.ref ? `Bay ${booking.bay.ref}` : undefined,
    baySerial: undefined,
    startTime: `${startParsed.date}T${startParsed.time}:00`,
    endTime: `${endParsed.date}T${endParsed.time}:00`,
    date: startParsed.date,
    customerEmail: undefined,
    customerName: undefined,
    customerPhone: undefined,
    customerId: undefined,
    playerCount,
    status: booking.status,
    parsedDate: startParsed.date,
    parsedStartTime: startParsed.time,
    parsedEndTime: endParsed.time,
    externalBookingId: booking.externalBookingId,
  };
  
  return {
    normalized,
    eventType: inferEventTypeFromStatus(booking.status),
    externalBookingId: booking.externalBookingId,
    bayRef: booking.bay?.ref,
  };
}

export function normalizeBookingFields(booking: TrackmanBookingPayload): NormalizedBookingFields {
  return {
    trackmanBookingId: booking.id || booking.booking_id || booking.bookingId,
    bayId: booking.bay_id || booking.bayId,
    bayName: booking.bay_name || booking.bayName,
    baySerial: booking.bay_serial || booking.baySerial || booking.resource_serial || booking.resourceSerial,
    startTime: booking.start_time || booking.startTime,
    endTime: booking.end_time || booking.endTime,
    date: booking.date,
    customerEmail: booking.customer?.email || booking.user?.email,
    customerName: booking.customer?.name || booking.user?.name,
    customerPhone: booking.customer?.phone || booking.user?.phone,
    customerId: booking.customer?.id || booking.user?.id,
    playerCount: booking.player_count || booking.playerCount || 1,
    status: booking.status,
    parsedDate: undefined,
    parsedStartTime: undefined,
    parsedEndTime: undefined,
    externalBookingId: booking.external_booking_id || booking.externalBookingId,
  };
}

export function mapBayNameToResourceId(
  bayName: string | undefined, 
  bayId: string | undefined,
  baySerial?: string,
  bayRef?: string
): number | null {
  if (bayRef) {
    const refNum = parseInt(bayRef.trim(), 10);
    if (refNum >= 1 && refNum <= 4) {
      logger.info('[Trackman Webhook] Matched bay by ref', {
        extra: { bayRef, resourceId: refNum }
      });
      return refNum;
    }
  }
  
  if (baySerial) {
    const serialMatch = BAY_SERIAL_TO_RESOURCE[baySerial.trim()];
    if (serialMatch) {
      logger.info('[Trackman Webhook] Matched bay by serial number', {
        extra: { baySerial, resourceId: serialMatch }
      });
      return serialMatch;
    }
  }
  
  if (!bayName && !bayId) return null;
  
  const name = (bayName || bayId || '').toLowerCase().trim();
  
  const bayPatternMatch = name.match(/(?:bay|sim(?:ulator)?)\s*[-_]?\s*(\d+)/i);
  if (bayPatternMatch) {
    const bayNum = parseInt(bayPatternMatch[1], 10);
    if (bayNum >= 1 && bayNum <= 4) {
      return bayNum;
    }
  }
  
  if (name.length <= 5) {
    const standaloneMatch = name.match(/^(\d)$/);
    if (standaloneMatch) {
      const bayNum = parseInt(standaloneMatch[1], 10);
      if (bayNum >= 1 && bayNum <= 4) {
        return bayNum;
      }
    }
  }
  
  if (name === 'bay1' || name === 'bay 1' || name === 'bay-1' || name === 'bay_1') return 1;
  if (name === 'bay2' || name === 'bay 2' || name === 'bay-2' || name === 'bay_2') return 2;
  if (name === 'bay3' || name === 'bay 3' || name === 'bay-3' || name === 'bay_3') return 3;
  if (name === 'bay4' || name === 'bay 4' || name === 'bay-4' || name === 'bay_4') return 4;
  
  if (name.includes('one') || name.includes('first')) return 1;
  if (name.includes('two') || name.includes('second')) return 2;
  if (name.includes('three') || name.includes('third')) return 3;
  if (name.includes('four') || name.includes('fourth')) return 4;
  
  return null;
}

export function parseDateTime(dateTimeStr: string | undefined, dateStr: string | undefined): { date: string; time: string } | null {
  if (!dateTimeStr && !dateStr) return null;
  
  try {
    if (dateTimeStr) {
      const dt = new Date(dateTimeStr);
      if (!isNaN(dt.getTime())) {
        return {
          date: formatDatePacific(dt),
          time: formatTimePacific(dt).substring(0, 5),
        };
      }
    }
    
    if (dateStr) {
      return { date: dateStr, time: '00:00' };
    }
  } catch (e) {
    logger.warn('[Trackman Webhook] Failed to parse date/time', { extra: { dateTimeStr, dateStr } });
  }
  
  return null;
}

export function redactPII(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  
  const redacted: Record<string, unknown> = Array.isArray(payload) ? [...payload] as unknown as Record<string, unknown> : { ...(payload as Record<string, unknown>) };
  const sensitiveFields = ['email', 'phone', 'phoneNumber', 'mobile', 'customer_email', 'customerEmail'];
  
  for (const key of Object.keys(redacted)) {
    if (sensitiveFields.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
      if (typeof redacted[key] === 'string' && (redacted[key] as string).includes('@')) {
        const parts = (redacted[key] as string).split('@');
        redacted[key] = `${parts[0].substring(0, 2)}***@${parts[1]}`;
      } else if (typeof redacted[key] === 'string') {
        redacted[key] = (redacted[key] as string).replace(/\d/g, '*').substring(0, 6) + '...';
      }
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactPII(redacted[key]);
    }
  }
  
  return redacted;
}

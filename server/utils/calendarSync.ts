import { getTodayPacific } from './dateUtils';

const APP_METADATA_PREFIX = 'ehApp';

export interface WellnessMetadata {
  imageUrl?: string | null;
  externalUrl?: string | null;
  spots?: string | null;
  status?: string | null;
  appId?: number;
}

export interface EventMetadata {
  imageUrl?: string | null;
  externalUrl?: string | null;
  maxAttendees?: number | null;
  visibility?: string | null;
  requiresRsvp?: boolean;
  location?: string | null;
  appId?: number;
}

export function encodeWellnessMetadata(metadata: WellnessMetadata): Record<string, string> {
  const props: Record<string, string> = {};
  props[`${APP_METADATA_PREFIX}_type`] = 'wellness';
  if (metadata.appId) props[`${APP_METADATA_PREFIX}_id`] = String(metadata.appId);
  if (metadata.imageUrl) props[`${APP_METADATA_PREFIX}_imageUrl`] = metadata.imageUrl;
  if (metadata.externalUrl) props[`${APP_METADATA_PREFIX}_externalUrl`] = metadata.externalUrl;
  if (metadata.spots) props[`${APP_METADATA_PREFIX}_spots`] = metadata.spots;
  if (metadata.status) props[`${APP_METADATA_PREFIX}_status`] = metadata.status;
  return props;
}

export function decodeWellnessMetadata(extendedProperties: Record<string, string> | undefined): WellnessMetadata | null {
  if (!extendedProperties) return null;
  if (extendedProperties[`${APP_METADATA_PREFIX}_type`] !== 'wellness') return null;
  
  return {
    appId: extendedProperties[`${APP_METADATA_PREFIX}_id`] ? parseInt(extendedProperties[`${APP_METADATA_PREFIX}_id`]) : undefined,
    imageUrl: extendedProperties[`${APP_METADATA_PREFIX}_imageUrl`] || null,
    externalUrl: extendedProperties[`${APP_METADATA_PREFIX}_externalUrl`] || null,
    spots: extendedProperties[`${APP_METADATA_PREFIX}_spots`] || null,
    status: extendedProperties[`${APP_METADATA_PREFIX}_status`] || null,
  };
}

export function encodeEventMetadata(metadata: EventMetadata): Record<string, string> {
  const props: Record<string, string> = {};
  props[`${APP_METADATA_PREFIX}_type`] = 'event';
  if (metadata.appId) props[`${APP_METADATA_PREFIX}_id`] = String(metadata.appId);
  if (metadata.imageUrl) props[`${APP_METADATA_PREFIX}_imageUrl`] = metadata.imageUrl;
  if (metadata.externalUrl) props[`${APP_METADATA_PREFIX}_externalUrl`] = metadata.externalUrl;
  if (metadata.maxAttendees) props[`${APP_METADATA_PREFIX}_maxAttendees`] = String(metadata.maxAttendees);
  if (metadata.visibility) props[`${APP_METADATA_PREFIX}_visibility`] = metadata.visibility;
  if (metadata.requiresRsvp !== undefined) props[`${APP_METADATA_PREFIX}_requiresRsvp`] = String(metadata.requiresRsvp);
  if (metadata.location) props[`${APP_METADATA_PREFIX}_location`] = metadata.location;
  return props;
}

export function decodeEventMetadata(extendedProperties: Record<string, string> | undefined): EventMetadata | null {
  if (!extendedProperties) return null;
  if (extendedProperties[`${APP_METADATA_PREFIX}_type`] !== 'event') return null;
  
  return {
    appId: extendedProperties[`${APP_METADATA_PREFIX}_id`] ? parseInt(extendedProperties[`${APP_METADATA_PREFIX}_id`]) : undefined,
    imageUrl: extendedProperties[`${APP_METADATA_PREFIX}_imageUrl`] || null,
    externalUrl: extendedProperties[`${APP_METADATA_PREFIX}_externalUrl`] || null,
    maxAttendees: extendedProperties[`${APP_METADATA_PREFIX}_maxAttendees`] ? parseInt(extendedProperties[`${APP_METADATA_PREFIX}_maxAttendees`]) : null,
    visibility: extendedProperties[`${APP_METADATA_PREFIX}_visibility`] || null,
    requiresRsvp: extendedProperties[`${APP_METADATA_PREFIX}_requiresRsvp`] === 'true',
    location: extendedProperties[`${APP_METADATA_PREFIX}_location`] || null,
  };
}

export function shouldSyncFromCalendar(
  googleUpdatedAt: Date | null,
  appModifiedAt: Date | null,
  locallyEdited: boolean
): 'calendar' | 'app' | 'skip' {
  if (locallyEdited && appModifiedAt) {
    if (!googleUpdatedAt) return 'app';
    return appModifiedAt > googleUpdatedAt ? 'app' : 'calendar';
  }
  return 'calendar';
}

export function parseGoogleDateTime(dateTime: string | undefined, date: string | undefined, timeZone?: string): { date: string; time: string } {
  if (dateTime) {
    const dt = new Date(dateTime);
    const dateStr = dt.toLocaleDateString('en-CA', { timeZone: timeZone || 'America/Los_Angeles' });
    const timeStr = dt.toLocaleTimeString('en-GB', { timeZone: timeZone || 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
    return { date: dateStr, time: timeStr };
  }
  if (date) {
    return { date, time: '09:00' };
  }
  return { date: getTodayPacific(), time: '09:00' };
}

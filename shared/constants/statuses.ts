export const BOOKING_STATUSES = [
  'pending',
  'pending_approval',
  'approved',
  'confirmed',
  'declined',
  'cancelled',
  'attended',
  'no_show',
  'checked_in'
] as const;

export type BookingStatus = typeof BOOKING_STATUSES[number];

export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ['pending', 'pending_approval', 'approved', 'confirmed'];
export const COMPLETED_BOOKING_STATUSES: BookingStatus[] = ['attended', 'checked_in'];
export const CANCELLED_BOOKING_STATUSES: BookingStatus[] = ['declined', 'cancelled', 'no_show'];

export const NOTIFICATION_TYPES = [
  'booking',
  'booking_confirmed',
  'booking_declined',
  'booking_cancelled',
  'booking_reminder',
  'event',
  'event_reminder',
  'announcement',
  'guest_pass',
  'wellness',
  'system',
  'welcome'
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const RSVP_STATUSES = [
  'confirmed',
  'cancelled',
  'waitlisted'
] as const;

export type RSVPStatus = typeof RSVP_STATUSES[number];

export const EVENT_CATEGORIES = [
  'Social',
  'Golf',
  'Wellness',
  'Business',
  'Member',
  'Community'
] as const;

export type EventCategory = typeof EVENT_CATEGORIES[number];

export const USER_ROLES = ['member', 'staff', 'admin'] as const;
export type UserRole = typeof USER_ROLES[number];

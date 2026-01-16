import type { MembershipTier } from '../../../shared/schema';

export type MemberRole = 'admin' | 'staff' | 'member';

export interface MemberRecord {
  id: string;
  email: string;
  normalizedEmail: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  
  role: MemberRole;
  isStaff: boolean;
  isAdmin: boolean;
  
  tier: string | null;
  tierId: number | null;
  tierConfig: MembershipTier | null;
  
  phone: string | null;
  tags: string[];
  
  stripeCustomerId: string | null;
  hubspotId: string | null;
  mindbodyClientId: string | null;
  
  membershipStatus: string | null;
  joinDate: Date | null;
  lifetimeVisits: number;
  
  linkedEmails: string[];
  trackmanEmail: string | null;
}

export interface StaffRecord {
  id: number;
  email: string;
  normalizedEmail: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  role: MemberRole;
  jobTitle: string | null;
  phone: string | null;
  isActive: boolean;
}

export type IdentifierType = 'email' | 'uuid' | 'hubspot_id' | 'mindbody_id' | 'unknown';

export interface ResolvedIdentifier {
  type: IdentifierType;
  value: string;
  normalizedValue: string;
}

export interface BillingMemberMatch {
  member: MemberRecord | null;
  matchedBy: 'uuid' | 'email' | 'linked_email' | 'trackman_email' | 'booking_email' | 'hubspot_id' | 'mindbody_id' | null;
  originalIdentifier: string;
}

export interface MemberLookupOptions {
  includeArchived?: boolean;
  includeTierConfig?: boolean;
  bypassCache?: boolean;
}

export function isUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

export function isEmail(value: string): boolean {
  return value.includes('@') && value.includes('.');
}

export function isHubSpotId(value: string): boolean {
  return /^\d{6,15}$/.test(value);
}

export function isMindbodyClientId(value: string): boolean {
  return /^\d{8,12}$/.test(value);
}

export function detectIdentifierType(value: string): IdentifierType {
  if (!value) return 'unknown';
  if (isUUID(value)) return 'uuid';
  if (isEmail(value)) return 'email';
  if (isHubSpotId(value)) return 'hubspot_id';
  return 'unknown';
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

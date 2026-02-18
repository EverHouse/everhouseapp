export interface CafeItem {
  id: string;
  category: string;
  name: string;
  price: number;
  desc: string;
  icon: string;
  image: string;
}

export type EventSource = 'internal' | 'eventbrite';

export interface EventData {
  id: string;
  source: EventSource;
  externalLink?: string;
  title: string;
  category: string;
  date: string;
  time: string;
  location: string;
  image: string;
  description: string;
  attendees: string[];
  capacity?: number;
  ticketsSold?: number;
}

export interface Announcement {
  id: string;
  title: string;
  desc: string;
  type: 'update' | 'announcement';
  date: string;
  createdAt?: string;
  priority?: 'normal' | 'high' | 'urgent';
  startDate?: string;
  endDate?: string;
  linkType?: 'events' | 'wellness' | 'golf' | 'external';
  linkTarget?: string;
  notifyMembers?: boolean;
  showAsBanner?: boolean;
}

export interface MemberProfile {
  id: string;
  name: string;
  tier: string;
  rawTier?: string | null;
  lastTier?: string | null;
  membershipStatus?: string | null;
  gracePeriodStart?: string | null;
  tags?: string[];
  isFounding?: boolean;
  status: 'Active' | 'Pending' | 'Expired' | 'Inactive' | 'Terminated' | 'former_member' | string;
  email: string;
  phone: string;
  jobTitle?: string;
  joinDate?: string;
  avatar?: string;
  role?: 'member' | 'staff' | 'admin';
  mindbodyClientId?: string;
  stripeCustomerId?: string;
  hubspotId?: string;
  lifetimeVisits?: number;
  lastBookingDate?: string;
  manuallyLinkedEmails?: string[];
  dateOfBirth?: string | null;
  billingGroupId?: number | null;
  billingProvider?: string | null;
  discountCode?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  companyName?: string | null;
  emailOptIn?: boolean | null;
  smsOptIn?: boolean | null;
  firstLoginAt?: string | null;
}

export interface Booking {
  id: string;
  type: 'golf' | 'event' | 'wellness' | 'dining';
  title: string;
  date: string;
  time: string;
  details: string;
  color?: 'primary' | 'accent';
}

export type CheckSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface IntegrityCheckMetadata {
  checkName: string;
  title: string;
  description: string;
  impact: string;
  severity: CheckSeverity;
}

export const integrityCheckMetadata: IntegrityCheckMetadata[] = [
  {
    checkName: 'Deal Stage Drift',
    title: 'Deal Stage Drift',
    description: 'Compares each member\'s HubSpot deal stage against their actual membership status in the app.',
    impact: 'Mismatched deal stages can cause billing problems - members may be charged incorrectly or miss renewal notices if their CRM status doesn\'t match reality.',
    severity: 'critical'
  },
  {
    checkName: 'Stripe Subscription Sync',
    title: 'Stripe Subscription Sync',
    description: 'Verifies that each member\'s subscription status in Stripe matches what the app shows for their membership.',
    impact: 'Sync issues can cause members to lose access to the club even if they\'re paying, or allow access to members whose payments have lapsed.',
    severity: 'critical'
  },
  {
    checkName: 'Stuck Transitional Members',
    title: 'Stuck Transitional Members',
    description: 'Finds members who have an active Stripe subscription but are stuck in a "pending" or "non-member" status for over 24 hours.',
    impact: 'These members are paying but can\'t access the club. This usually means a webhook failed to process their payment confirmation.',
    severity: 'critical'
  },
  {
    checkName: 'HubSpot Sync Status',
    title: 'Member Data Sync Issues',
    description: 'Checks for members whose data is out of sync between the local database and HubSpot CRM.',
    impact: 'Member contact information, billing details, or membership status may be incorrect, leading to communication failures or billing errors.',
    severity: 'critical'
  },
  {
    checkName: 'Calendar Sync Mismatches',
    title: 'Calendar Event Mismatches',
    description: 'Identifies bookings that don\'t match their corresponding Google Calendar events.',
    impact: 'Staff may see incorrect schedules, leading to double-bookings or missed appointments.',
    severity: 'high'
  },
  {
    checkName: 'Participant User Relationships',
    title: 'Guest Profiles Missing Member Links',
    description: 'Finds booking participants whose profiles aren\'t properly linked to member accounts.',
    impact: 'Guest history and booking records won\'t appear in member profiles, affecting usage tracking and tier calculations.',
    severity: 'high'
  },
  {
    checkName: 'Booking Request Integrity',
    title: 'Booking Records Missing Details',
    description: 'Detects bookings that are missing required information like time slots, resources, or member assignments.',
    impact: 'Incomplete bookings may cause scheduling conflicts or prevent proper resource allocation.',
    severity: 'high'
  },
  {
    checkName: 'Orphan Booking Participants',
    title: 'Booking Guests Without Accounts',
    description: 'Identifies guests listed on bookings whose user accounts no longer exist in the system.',
    impact: 'Historical booking data becomes incomplete and guest statistics may be inaccurate.',
    severity: 'medium'
  },
  {
    checkName: 'Orphan Wellness Enrollments',
    title: 'Wellness Signups Missing Classes',
    description: 'Finds wellness class enrollments that reference classes which have been deleted.',
    impact: 'Members may think they\'re enrolled in classes that no longer exist, causing confusion.',
    severity: 'medium'
  },
  {
    checkName: 'Empty Booking Sessions',
    title: 'Empty Booking Records',
    description: 'Locates booking sessions that have no participants assigned.',
    impact: 'These empty records clutter the system but have minimal operational impact.',
    severity: 'low'
  },
  {
    checkName: 'Deals Without Line Items',
    title: 'Member Deals Missing Products',
    description: 'Identifies HubSpot deals that don\'t have proper product line items attached.',
    impact: 'Billing won\'t work correctly for these members as they have no products on their membership deal.',
    severity: 'high'
  },
  {
    checkName: 'Members Without Email',
    title: 'Members Without Email',
    description: 'Finds member accounts that are missing an email address.',
    impact: 'These members cannot log in, receive booking confirmations, or get club communications. They need an email added to their profile.',
    severity: 'high'
  }
];

export const severityOrder: Record<CheckSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

export function getCheckMetadata(checkName: string): IntegrityCheckMetadata | undefined {
  return integrityCheckMetadata.find(m => m.checkName === checkName);
}

export function sortBySeverity<T extends { checkName: string }>(results: T[]): T[] {
  return [...results].sort((a, b) => {
    const metaA = getCheckMetadata(a.checkName);
    const metaB = getCheckMetadata(b.checkName);
    const severityA = metaA ? severityOrder[metaA.severity] : 999;
    const severityB = metaB ? severityOrder[metaB.severity] : 999;
    return severityA - severityB;
  });
}

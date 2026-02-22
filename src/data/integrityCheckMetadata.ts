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
  },
  {
    checkName: 'Billing Provider Hybrid State',
    title: 'Billing Provider Hybrid State',
    description: 'Detects members who have both a MindBody client ID and Stripe subscription, creating conflicting billing authorities.',
    impact: 'Members may be double-billed or have unpredictable billing behavior when two systems claim ownership.',
    severity: 'critical'
  },
  {
    checkName: 'Active Bookings Without Sessions',
    title: 'Active Bookings Without Sessions',
    description: 'Finds confirmed or approved bookings that are missing their booking session record.',
    impact: 'These bookings cannot be checked into, billed, or tracked properly. They appear on schedules but have no session data.',
    severity: 'critical'
  },
  {
    checkName: 'Orphaned Payment Intents',
    title: 'Orphaned Payment Intents',
    description: 'Identifies Stripe payment intents that are not linked to any booking or invoice in the system.',
    impact: 'These represent unresolved charges or holds on member cards that may cause confusion or block future payments.',
    severity: 'critical'
  },
  {
    checkName: 'Invoice-Booking Reconciliation',
    title: 'Invoice-Booking Reconciliation',
    description: 'Detects bookings with unpaid participant fees but no Stripe invoice, and bookings with duplicate invoices.',
    impact: 'Members may not be billed for attended sessions, causing revenue loss, or may receive duplicate charges.',
    severity: 'critical'
  },
  {
    checkName: 'Overlapping Bookings',
    title: 'Overlapping Bookings',
    description: 'Finds confirmed bookings that overlap on the same bay at the same time.',
    impact: 'Two groups may show up for the same bay, causing scheduling conflicts and a poor member experience.',
    severity: 'critical'
  },
  {
    checkName: 'Guest Pass Accounting Drift',
    title: 'Guest Pass Accounting Drift',
    description: 'Detects guest pass records where the used count exceeds the total, or where expired holds are still in place.',
    impact: 'Members may be unable to use their guest passes or may have incorrect remaining pass counts.',
    severity: 'high'
  },
  {
    checkName: 'Stale Pending Bookings',
    title: 'Stale Pending Bookings',
    description: 'Finds pending or approved bookings whose start time has passed by more than 24 hours without being confirmed or cancelled.',
    impact: 'These stale bookings clutter the schedule and may block bay availability for future bookings.',
    severity: 'high'
  },
  {
    checkName: 'Duplicate Stripe Customers',
    title: 'Duplicate Stripe Customers',
    description: 'Identifies members who have multiple Stripe customer records, which can cause payment confusion.',
    impact: 'Payments may be applied to the wrong customer record, and billing history becomes fragmented.',
    severity: 'high'
  },
  {
    checkName: 'Tier Reconciliation',
    title: 'Tier Reconciliation',
    description: 'Compares each member\'s tier in the app against their Stripe subscription tier to find mismatches.',
    impact: 'Members may have incorrect pricing, access levels, or guest pass allocations if their tier is wrong.',
    severity: 'high'
  },
  {
    checkName: 'HubSpot ID Duplicates',
    title: 'HubSpot ID Duplicates',
    description: 'Finds multiple app members sharing the same HubSpot contact ID.',
    impact: 'CRM sync will overwrite data unpredictably, and member communications may be sent to wrong people.',
    severity: 'high'
  },
  {
    checkName: 'Unmatched Trackman Bookings',
    title: 'Unmatched Trackman Bookings',
    description: 'Identifies Trackman-imported booking sessions that have not been matched to a member.',
    impact: 'Usage tracking and billing for these sessions cannot be completed until they are assigned to a member.',
    severity: 'medium'
  },
  {
    checkName: 'MindBody Stale Sync',
    title: 'MindBody Stale Sync',
    description: 'Detects members with MindBody client IDs who may need migration to Stripe billing.',
    impact: 'Legacy billing members may have outdated records that need manual review for migration.',
    severity: 'medium'
  },
  {
    checkName: 'Orphan Event RSVPs',
    title: 'Orphan Event RSVPs',
    description: 'Finds event RSVPs that reference events which have been deleted from the system.',
    impact: 'These orphaned records clutter the database but have minimal operational impact.',
    severity: 'medium'
  },
  {
    checkName: 'Orphaned Fee Snapshots',
    title: 'Orphaned Fee Snapshots',
    description: 'Identifies fee snapshot records that are no longer linked to active bookings.',
    impact: 'These records take up space but do not affect billing or operations.',
    severity: 'low'
  },
  {
    checkName: 'Sessions Without Participants',
    title: 'Sessions Without Participants',
    description: 'Finds booking sessions that have no participants assigned to them.',
    impact: 'Empty sessions clutter the booking system and may be leftover from incomplete booking processes.',
    severity: 'low'
  },
  {
    checkName: 'Guest Passes Without Members',
    title: 'Guest Passes Without Members',
    description: 'Guest pass records that reference members who no longer exist in the system.',
    impact: 'These orphaned records do not affect operations but should be cleaned up.',
    severity: 'low'
  },
  {
    checkName: 'Items Needing Review',
    title: 'Items Needing Review',
    description: 'Flagged items across the system that require manual staff review before processing.',
    impact: 'Unreviewed items may contain data conflicts that need human judgment to resolve.',
    severity: 'low'
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

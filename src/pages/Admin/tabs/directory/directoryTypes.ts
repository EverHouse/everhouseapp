export type SortField = 'name' | 'tier' | 'visits' | 'joinDate' | 'lastVisit';
export type SortDirection = 'asc' | 'desc';
export type MemberTab = 'active' | 'former' | 'visitors' | 'team';

export type BillingFilter = 'All' | 'Individual' | 'Group' | 'Stripe' | 'Mindbody' | 'Family Add-on' | 'Comped';

export type VisitorType = 'all' | 'NEW' | 'classpass' | 'sim_walkin' | 'private_lesson' | 'day_pass' | 'guest' | 'lead';
export type VisitorSource = 'all' | 'mindbody' | 'hubspot' | 'stripe' | 'APP';
export type VisitorSortField = 'name' | 'email' | 'type' | 'source' | 'lastActivity' | 'createdAt' | 'purchases';

export type StaffRole = 'staff' | 'admin' | 'golf_instructor';

export const TIER_OPTIONS = ['All', 'Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;
export const ASSIGNABLE_TIERS = ['Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;
export const BILLING_OPTIONS = ['All', 'Individual', 'Group', 'Stripe', 'Mindbody', 'Family Add-on', 'Comped'] as const;

export const SORT_OPTIONS: { value: SortField; label: string }[] = [
    { value: 'name', label: 'Name A-Z' },
    { value: 'joinDate', label: 'Join Date' },
    { value: 'lastVisit', label: 'Last Visit' },
    { value: 'visits', label: 'Lifetime Visits' },
    { value: 'tier', label: 'Tier' },
];

export const VIRTUALIZATION_THRESHOLD = 75;
export const ITEMS_PER_PAGE = 50;
export const VISITORS_PAGE_SIZE = 100;

export interface TeamMember {
    staff_id: number;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    job_title: string | null;
    role: StaffRole | null;
    is_active: boolean;
    user_id: string | null;
    tier: string | null;
    membership_status: string | null;
    stripe_customer_id: string | null;
    hubspot_id: string | null;
}

export interface Visitor {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    purchaseCount: number;
    totalSpentCents: number;
    lastPurchaseDate: string | null;
    guestCount: number;
    lastGuestDate: string | null;
    membershipStatus: string | null;
    role: string | null;
    stripeCustomerId: string | null;
    hubspotId: string | null;
    mindbodyClientId: string | null;
    lastActivityAt: string | null;
    lastActivitySource: string | null;
    createdAt: string | null;
    source: 'mindbody' | 'hubspot' | 'stripe' | 'app';
    type: 'classpass' | 'sim_walkin' | 'private_lesson' | 'day_pass' | 'guest' | 'lead';
}

export interface VisitorPurchase {
    id: string;
    purchaserEmail: string;
    purchaserFirstName: string | null;
    purchaserLastName: string | null;
    purchaserPhone: string | null;
    quantity: number;
    amountCents: number;
    stripePaymentIntentId: string | null;
    purchasedAt: string;
}

export interface VisitorsResponse {
    visitors: Visitor[];
    total: number;
}

export interface SyncStatusResponse {
    lastSyncTime: string | null;
    status: 'idle' | 'running' | 'completed' | 'failed';
    jobId?: string;
    startedAt?: string;
    completedAt?: string;
    progress?: Record<string, unknown>;
    result?: DirectorySyncResult | null;
    error?: string | null;
}

export interface DirectorySyncResult {
    pullCount: number;
    pushCount: number;
    pushErrors?: number;
    stripeUpdated: number;
    stripeSkipped?: boolean;
    errors: string[];
}

export interface SyncResponse {
    created?: number;
    updated?: number;
    synced?: number;
}

export const directoryKeys = {
    all: ['directory'] as const,
    syncStatus: () => [...directoryKeys.all, 'sync-status'] as const,
    visitors: (params: { type?: VisitorType; source?: VisitorSource; search?: string; page?: number; archived?: string }) => 
        [...directoryKeys.all, 'visitors', params] as const,
    team: () => [...directoryKeys.all, 'team'] as const,
    visitorPurchases: (visitorId: string) => [...directoryKeys.all, 'visitor-purchases', visitorId] as const,
};

export const formatJoinDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '-';
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/Los_Angeles' });
    } catch {
        return '-';
    }
};

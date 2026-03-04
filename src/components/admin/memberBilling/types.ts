export interface GuestHistoryItem {
  id: number;
  guestName: string | null;
  guestEmail: string | null;
  visitDate: string;
  startTime: string;
  resourceName: string | null;
}

export interface GuestCheckInItem {
  id: number;
  guestName: string | null;
  checkInDate: string;
}

export interface MemberBillingTabProps {
  memberEmail: string;
  memberId?: string;
  currentTier?: string;
  onTierUpdate?: (tier: string) => void;
  onMemberUpdated?: () => void;
  onDrawerClose?: () => void;
  guestPassInfo?: { remainingPasses: number; totalUsed: number } | null;
  guestHistory?: GuestHistoryItem[];
  guestCheckInsHistory?: GuestCheckInItem[];
  purchases?: Array<{ id: number | string; category?: string; description?: string; amount?: number; date?: string; created_at?: string; product_name?: string; quantity?: number; status?: string }>;
}

export interface Subscription {
  id: string;
  status: string;
  planName?: string;
  planAmount?: number;
  currency?: string;
  interval?: string;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  isPaused?: boolean;
  pausedUntil?: string | null;
  discount?: {
    id: string;
    coupon: {
      id: string;
      name?: string;
      percentOff?: number;
      amountOff?: number;
    };
  } | null;
}

export interface PaymentMethod {
  id: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface Invoice {
  id: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
}

export interface FamilyGroup {
  id: number;
  primaryEmail: string;
  primaryName?: string;
  groupName?: string;
  members?: {
    id: number;
    memberEmail: string;
    memberName: string;
    addOnPriceCents: number;
  }[];
}

export interface BillingInfo {
  email: string;
  firstName?: string;
  lastName?: string;
  billingProvider: 'stripe' | 'mindbody' | 'family_addon' | 'comped' | null;
  stripeCustomerId?: string;
  mindbodyClientId?: string;
  hubspotId?: string;
  tier?: string;
  subscriptions?: Subscription[];
  activeSubscription?: Subscription | null;
  paymentMethods?: PaymentMethod[];
  recentInvoices?: Invoice[];
  customerBalance?: number;
  familyGroup?: FamilyGroup | null;
  stripeError?: string;
  familyError?: string;
  billingMigrationRequestedAt?: string;
  migrationStatus?: string | null;
  migrationBillingStartDate?: string | null;
  migrationRequestedBy?: string | null;
  migrationTierSnapshot?: string | null;
}

export interface OutstandingData {
  totalOutstandingCents: number;
  totalOutstandingDollars: number;
  items: Array<{
    bookingId: number;
    trackmanBookingId: string | null;
    bookingDate: string;
    startTime: string;
    endTime: string;
    resourceName: string;
    participantId: number;
    participantType: string;
    displayName: string;
    feeCents: number;
    feeDollars: number;
    feeLabel: string;
  }>;
}

export interface MigrationEligibility {
  hasCardOnFile: boolean;
  tierHasStripePrice: boolean;
  cardOnFile?: { brand?: string; last4?: string } | null;
}

export interface CouponOption {
  id: string;
  name: string;
  percentOff: number | null;
  amountOff: number | null;
  duration: string;
}

export interface PurchaseRecord {
  id: number | string;
  category?: string;
  itemCategory?: string;
  description?: string;
  amount?: number;
  date?: string;
  created_at?: string;
  product_name?: string;
  quantity?: number;
  status?: string;
  saleDate?: string;
  amountCents?: number;
  salePriceCents?: number;
  source?: string;
  type?: string;
  itemName?: string;
}

export const BILLING_PROVIDERS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'mindbody', label: 'Mindbody' },
  { value: 'family_addon', label: 'Family Add-on' },
  { value: 'comped', label: 'Comped' },
];

export const formatDatePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const normalizedDate = dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`;
    const d = new Date(normalizedDate);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr || '';
  }
};

export const formatTime12Hour = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
};

export const CATEGORY_LABELS: Record<string, string> = {
  sim_walk_in: 'Sim Walk-In',
  guest_pass: 'Guest Pass',
  membership: 'Membership',
  cafe: 'Cafe',
  retail: 'Retail',
  add_funds: 'Account Top-Up',
  subscription: 'Subscription',
  payment: 'Payment',
  invoice: 'Invoice',
  other: 'Other',
};

export const CATEGORY_ICONS: Record<string, string> = {
  sim_walk_in: 'golf_course',
  guest_pass: 'badge',
  membership: 'card_membership',
  cafe: 'local_cafe',
  retail: 'shopping_bag',
  add_funds: 'account_balance_wallet',
  subscription: 'autorenew',
  payment: 'payments',
  invoice: 'receipt_long',
  other: 'receipt',
};

export const CATEGORY_ORDER = ['add_funds', 'subscription', 'membership', 'sim_walk_in', 'guest_pass', 'payment', 'invoice', 'cafe', 'retail', 'other'];

export const getCategoryColors = (isDark: boolean): Record<string, string> => ({
  sim_walk_in: isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700',
  guest_pass: isDark ? 'bg-purple-500/20 text-purple-300' : 'bg-purple-100 text-purple-700',
  membership: isDark ? 'bg-green-500/20 text-green-300' : 'bg-green-100 text-green-700',
  cafe: isDark ? 'bg-orange-500/20 text-orange-300' : 'bg-orange-100 text-orange-700',
  retail: isDark ? 'bg-pink-500/20 text-pink-300' : 'bg-pink-100 text-pink-700',
  add_funds: isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700',
  subscription: isDark ? 'bg-indigo-500/20 text-indigo-300' : 'bg-indigo-100 text-indigo-700',
  payment: isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-100 text-cyan-700',
  invoice: isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700',
  other: isDark ? 'bg-gray-500/20 text-gray-300' : 'bg-gray-100 text-gray-700',
});

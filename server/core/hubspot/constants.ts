import { getSettingValue } from '../settingsHelper';
import { CANONICAL_TIER_NAMES } from '../../utils/tierUtils';

export type ContactMembershipStatus = 'Active' | 'trialing' | 'past_due' | 'Pending' | 'Declined' | 'Suspended' | 'Expired' | 'Froze' | 'Terminated' | 'Non-Member';

export type BillingProvider = 'Stripe' | 'MindBody' | 'Manual';

export const MINDBODY_TO_CONTACT_STATUS_MAP: Record<string, ContactMembershipStatus> = {
  'active': 'Active',
  'trialing': 'trialing',
  'past_due': 'past_due',
  'pending': 'Pending',
  'declined': 'Declined',
  'suspended': 'Suspended',
  'expired': 'Expired',
  'froze': 'Froze',
  'frozen': 'Froze',
  'terminated': 'Terminated',
  'cancelled': 'Terminated',
  'non-member': 'Non-Member',
};

export const DB_STATUS_TO_HUBSPOT_STATUS: Record<string, ContactMembershipStatus> = {
  'active': 'Active',
  'trialing': 'trialing',
  'past_due': 'past_due',
  'inactive': 'Suspended',
  'cancelled': 'Terminated',
  'expired': 'Expired',
  'terminated': 'Terminated',
  'former_member': 'Terminated',
  'pending': 'Pending',
  'suspended': 'Suspended',
  'frozen': 'Froze',
  'non-member': 'Non-Member',
  'deleted': 'Terminated',
};

export const DB_BILLING_PROVIDER_TO_HUBSPOT: Record<string, string> = {
  'stripe': 'stripe',
  'mindbody': 'mindbody',
  'manual': 'manual',
  'comped': 'Comped',
  'none': 'None',
  'family_addon': 'stripe',
};

function buildDbTierToHubSpot(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [slug, name] of Object.entries(CANONICAL_TIER_NAMES)) {
    const membership = `${name} Membership`;
    map[slug] = membership;
    map[slug.replace(/-/g, '_')] = membership;
    map[slug.replace(/-/g, ' ')] = membership;
    map[name.toLowerCase()] = membership;
    map[`${name.toLowerCase()} membership`] = membership;

    map[`${slug}-founding`] = `${membership} Founding Members`;
    map[`${slug}_founding`] = `${membership} Founding Members`;
    map[`${name.toLowerCase()} membership founding members`] = `${membership} Founding Members`;
  }
  return map;
}

export function getDbTierToHubSpot(): Record<string, string> {
  return buildDbTierToHubSpot();
}

export const DB_TIER_TO_HUBSPOT = new Proxy({} as Record<string, string>, {
  get(_target, prop: string) {
    return buildDbTierToHubSpot()[prop];
  },
  has(_target, prop: string) {
    return prop in buildDbTierToHubSpot();
  },
  ownKeys() {
    return Object.keys(buildDbTierToHubSpot());
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const map = buildDbTierToHubSpot();
    if (prop in map) {
      return { value: map[prop], writable: true, enumerable: true, configurable: true };
    }
    return undefined;
  },
});

export const INACTIVE_STATUSES = ['pending', 'declined', 'suspended', 'expired', 'froze', 'frozen'];
export const CHURNED_STATUSES = ['terminated', 'cancelled', 'non-member'];
export const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

export async function getDbStatusToHubSpotMapping(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [dbStatus, defaultVal] of Object.entries(DB_STATUS_TO_HUBSPOT_STATUS)) {
    result[dbStatus] = await getSettingValue(`hubspot.status.${dbStatus}`, defaultVal);
  }
  return result;
}

export async function getTierToHubSpotMapping(): Promise<Record<string, string>> {

  const result: Record<string, string> = {};
  for (const [slug, name] of Object.entries(CANONICAL_TIER_NAMES)) {
    const defaultLabel = `${name} Membership`;
    const label = await getSettingValue(`hubspot.tier.${slug}`, defaultLabel);
    result[slug] = label;
    result[slug.replace(/-/g, '_')] = label;
    result[slug.replace(/-/g, ' ')] = label;
    const longName = `${slug.replace(/-/g, ' ')} membership`;
    if (longName !== slug) result[longName] = label;

    const foundingLabel = await getSettingValue(`hubspot.tier.${slug}-founding`, `${defaultLabel} Founding Members`);
    result[`${slug}-founding`] = foundingLabel;
    result[`${slug}_founding`] = foundingLabel;
  }
  return result;
}

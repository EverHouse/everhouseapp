export type SubTab = 'tiers' | 'fees' | 'discounts' | 'cafe';

export interface TierFeature {
    id: number;
    featureKey: string;
    displayLabel: string;
    valueType: 'boolean' | 'number' | 'text';
    sortOrder: number;
    isActive: boolean;
    values: Record<string, { tierId: number; value: string | boolean | number | null }>;
}

export interface MembershipTier {
    id: number;
    name: string;
    slug: string;
    price_string: string;
    description: string | null;
    button_text: string;
    sort_order: number;
    is_active: boolean;
    is_popular: boolean;
    show_in_comparison: boolean;
    show_on_membership_page: boolean;
    highlighted_features: string[];
    all_features: Record<string, boolean | { label?: string; value?: string | boolean; included?: boolean }>;
    daily_sim_minutes: number;
    guest_passes_per_year: number;
    booking_window_days: number;
    daily_conf_room_minutes: number;
    can_book_simulators: boolean;
    can_book_conference: boolean;
    can_book_wellness: boolean;
    has_group_lessons: boolean;
    has_extended_sessions: boolean;
    has_private_lesson: boolean;
    has_simulator_guest_passes: boolean;
    has_discounted_merch: boolean;
    unlimited_access: boolean;
    stripe_price_id?: string | null;
    stripe_product_id?: string | null;
    price_cents?: number | null;
    product_type?: 'subscription' | 'one_time' | null;
    wallet_pass_bg_color?: string | null;
    wallet_pass_foreground_color?: string | null;
    wallet_pass_label_color?: string | null;
}

export interface StripePrice {
    id: string;
    productId: string;
    productName: string;
    nickname: string | null;
    amount: number;
    amountCents: number;
    currency: string;
    interval: string;
    displayString: string;
}

export const BOOLEAN_FIELDS = [
    { key: 'can_book_simulators', label: 'Can Book Simulators' },
    { key: 'can_book_conference', label: 'Can Book Conference Room' },
    { key: 'can_book_wellness', label: 'Can Book Wellness' },
    { key: 'has_group_lessons', label: 'Has Group Lessons' },
    { key: 'has_extended_sessions', label: 'Has Extended Sessions' },
    { key: 'has_private_lesson', label: 'Has Private Lesson' },
    { key: 'has_simulator_guest_passes', label: 'Has Simulator Guest Passes' },
    { key: 'has_discounted_merch', label: 'Has Discounted Merch' },
    { key: 'unlimited_access', label: 'Unlimited Access' },
] as const;

export interface TierRecord {
  id: number;
  name: string;
  slug?: string;
  description?: string;
  monthlyPrice?: number;
  product_type?: string;
  stripe_price_id?: string;
  [key: string]: unknown;
}

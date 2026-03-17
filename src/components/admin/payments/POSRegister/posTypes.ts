import type { CafeItem } from '../../../../types/data';

export interface CartItem {
  productId: string;
  name: string;
  priceCents: number;
  quantity: number;
  icon: string;
}

export type PaymentMethodType = 'online_card' | 'terminal' | 'saved_card';
export type CategoryTab = 'all' | 'passes' | 'cafe' | 'merch';

export const PASS_PRODUCT_SLUGS = ['day-pass-coworking', 'day-pass-golf-sim', 'guest-pass'];

export const PASS_SLUG_ICONS: Record<string, string> = {
  'day-pass-coworking': 'workspace_premium',
  'day-pass-golf-sim': 'sports_golf',
  'guest-pass': 'person_add',
};

export const CAFE_CATEGORY_ICONS: Record<string, string> = {
  Breakfast: 'breakfast_dining',
  Lunch: 'lunch_dining',
  Dessert: 'cake',
  Kids: 'child_care',
  Shareables: 'restaurant',
  Sides: 'set_meal',
};

export const CATEGORY_TABS: { key: CategoryTab; label: string; icon: string }[] = [
  { key: 'all', label: 'All', icon: 'grid_view' },
  { key: 'passes', label: 'Passes', icon: 'confirmation_number' },
  { key: 'cafe', label: 'Cafe', icon: 'coffee' },
  { key: 'merch', label: 'Merch', icon: 'storefront' },
];

export const CAFE_CATEGORY_ORDER = ['Breakfast', 'Dessert', 'Kids', 'Lunch', 'Shareables', 'Sides'];

export function getCafeItemIcon(item: CafeItem): string {
  if (item.icon) return item.icon;
  return CAFE_CATEGORY_ICONS[item.category] || 'restaurant';
}

export function cafeItemToCartProduct(item: CafeItem) {
  return {
    productId: item.id,
    name: item.name,
    priceCents: Math.round(item.price * 100),
    icon: getCafeItemIcon(item),
  };
}

export interface CustomerInfo {
  email: string;
  name: string;
  isNewCustomer: boolean;
  isGuestCheckout: boolean;
  id: string | null;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface SavedCardInfo {
  hasSavedCard: boolean;
  cardLast4?: string;
  cardBrand?: string;
}

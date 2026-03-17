import { useState, useMemo, useEffect, useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import type { SelectedMember } from '../../../shared/MemberSearchInput';
import { useTheme } from '../../../../contexts/ThemeContext';
import { useIsMobile } from '../../../../hooks/useBreakpoint';
import { useCafeMenu } from '../../../../hooks/queries/useCafeQueries';
import { fetchWithCredentials, postWithCredentials } from '../../../../hooks/queries/useFetch';
import type { CafeItem } from '../../../../types/data';
import {
  type CartItem,
  type PaymentMethodType,
  type CategoryTab,
  type SavedCardInfo,
  PASS_PRODUCT_SLUGS,
  PASS_SLUG_ICONS,
  CAFE_CATEGORY_ORDER,
} from './posTypes';
import { createPaymentHandlers } from './usePOSPayments';

export function usePOSRegister() {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const isMobile = useIsMobile();
  const { data: cafeItems, isLoading: cafeLoading } = useCafeMenu();

  const [passProducts, setPassProducts] = useState<{ productId: string; name: string; priceCents: number; icon: string }[]>([]);
  const [passProductsLoading, setPassProductsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tiers = await fetchWithCredentials<Array<{ slug: string; stripe_product_id?: string; name: string; price_cents: number }>>('/api/membership-tiers?active=true');
        const products = PASS_PRODUCT_SLUGS
          .map(slug => {
            const tier = tiers.find((t: { slug: string }) => t.slug === slug);
            if (!tier || !tier.stripe_product_id) return null;
            return {
              productId: tier.stripe_product_id,
              name: tier.name,
              priceCents: tier.price_cents || 0,
              icon: PASS_SLUG_ICONS[slug] || 'confirmation_number',
            };
          })
          .filter(Boolean) as { productId: string; name: string; priceCents: number; icon: string }[];
        if (!cancelled) {
          setPassProducts(products);
          setPassProductsLoading(false);
        }
      } catch {
        if (!cancelled) setPassProductsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const stripePromise = useMemo(() => loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || ''), []);

  const [activeTab, setActiveTab] = useState<CategoryTab>('all');
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [description, setDescription] = useState('');
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [useNewCustomer, setUseNewCustomer] = useState(false);
  const [useGuestCheckout, setUseGuestCheckout] = useState(false);
  const [newCustomerFirstName, setNewCustomerFirstName] = useState('');
  const [newCustomerLastName, setNewCustomerLastName] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [addedProductId, setAddedProductId] = useState<string | null>(null);
  const [showIdScanner, setShowIdScanner] = useState(false);
  const [scannedIdImage, setScannedIdImage] = useState<{ base64: string; mimeType: string } | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethodType | null>(null);

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [isCreatingIntent, setIsCreatingIntent] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [receiptSent, setReceiptSent] = useState(false);
  const [receiptSending, setReceiptSending] = useState(false);
  const [guestReceiptEmail, setGuestReceiptEmail] = useState('');
  const [attachingEmail, setAttachingEmail] = useState(false);

  const [savedCard, setSavedCard] = useState<SavedCardInfo | null>(null);
  const [checkingSavedCard, setCheckingSavedCard] = useState(false);

  const totalCents = cartItems.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const totalFormatted = `$${(totalCents / 100).toFixed(2)}`;
  const totalItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  const groupedCafeItems = useMemo(() => {
    if (!cafeItems) return {};
    const groups: Record<string, CafeItem[]> = {};
    for (const item of cafeItems) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    }
    return groups;
  }, [cafeItems]);

  const sortedCafeCategories = useMemo(() => {
    const cats = Object.keys(groupedCafeItems);
    return CAFE_CATEGORY_ORDER.filter(c => cats.includes(c)).concat(
      cats.filter(c => !CAFE_CATEGORY_ORDER.includes(c))
    );
  }, [groupedCafeItems]);

  const checkSavedCard = useCallback(async (email: string) => {
    setCheckingSavedCard(true);
    setSavedCard(null);
    try {
      const data = await fetchWithCredentials<{ hasSavedCard: boolean; last4?: string; brand?: string }>(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`);
      setSavedCard(data);
    } catch {
      setSavedCard({ hasSavedCard: false });
    } finally {
      setCheckingSavedCard(false);
    }
  }, []);

  useEffect(() => {
    if (selectedMember?.email) {
      checkSavedCard(selectedMember.email);
    } else {
      setSavedCard(null);
    }
  }, [selectedMember?.email, checkSavedCard]);

  const addToCart = (product: { productId: string; name: string; priceCents: number; icon: string }) => {
    setCartItems(prev => {
      const existing = prev.find(item => item.productId === product.productId);
      if (existing) {
        return prev.map(item =>
          item.productId === product.productId
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [...prev, { ...product, quantity: 1 }];
    });
    setAddedProductId(product.productId);
    setTimeout(() => setAddedProductId(null), 300);
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCartItems(prev =>
      prev
        .map(item => {
          if (item.productId === productId) {
            const newQty = item.quantity + delta;
            return newQty <= 0 ? null : { ...item, quantity: newQty };
          }
          return item;
        })
        .filter(Boolean) as CartItem[]
    );
  };

  const clearCart = () => setCartItems([]);

  const getCustomerInfo = () => {
    if (useGuestCheckout) {
      return {
        email: '',
        name: 'Guest',
        isNewCustomer: false as const,
        isGuestCheckout: true as const,
        id: null as string | null,
      };
    }
    if (useNewCustomer) {
      return {
        email: newCustomerEmail,
        name: `${newCustomerFirstName} ${newCustomerLastName}`.trim(),
        firstName: newCustomerFirstName,
        lastName: newCustomerLastName,
        phone: newCustomerPhone || undefined,
        isNewCustomer: true as const,
        isGuestCheckout: false as const,
        id: null as string | null,
      };
    }
    return selectedMember
      ? {
          email: selectedMember.email,
          name: selectedMember.name,
          isNewCustomer: false as const,
          isGuestCheckout: false as const,
          id: selectedMember.id as string | null,
        }
      : null;
  };

  const isCustomerValid = () => {
    if (useGuestCheckout) return true;
    if (useNewCustomer) {
      return !!(newCustomerFirstName.trim() && newCustomerLastName.trim() && newCustomerEmail.trim());
    }
    return !!selectedMember;
  };

  const canReview = cartItems.length > 0 && isCustomerValid();

  const buildDescription = () => {
    if (description) return description;
    return cartItems.map(item => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name)).join(', ');
  };

  const paymentHandlers = createPaymentHandlers(
    { cartItems, totalCents, paymentIntentId, clientSecret, selectedPaymentMethod, useGuestCheckout, guestReceiptEmail, getCustomerInfo, buildDescription },
    { setClientSecret, setPaymentIntentId, setIsCreatingIntent, setIsProcessing, setError, setSuccess, setReceiptSent, setReceiptSending, setAttachingEmail, setSelectedPaymentMethod }
  );

  const { handleSelectPaymentMethod, handleCardPaymentSuccess, handleTerminalSuccess, handleSavedCardCharge, handleSendReceipt, handleGuestReceiptSubmit } = paymentHandlers;

  const resetForm = () => {
    setCartItems([]);
    setDescription('');
    setSelectedMember(null);
    setUseNewCustomer(false);
    setUseGuestCheckout(false);
    setNewCustomerFirstName('');
    setNewCustomerLastName('');
    setNewCustomerEmail('');
    setNewCustomerPhone('');
    setDrawerOpen(false);
    setMobileCartOpen(false);
    setSelectedPaymentMethod(null);
    setClientSecret(null);
    setPaymentIntentId(null);
    setIsCreatingIntent(false);
    setIsProcessing(false);
    setError(null);
    setSuccess(false);
    setReceiptSent(false);
    setReceiptSending(false);
    setScannedIdImage(null);
    setGuestReceiptEmail('');
    setAttachingEmail(false);
  };

  const handleIdScanComplete = useCallback((data: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
    imageBase64: string;
    imageMimeType: string;
  }) => {
    setScannedIdImage({ base64: data.imageBase64, mimeType: data.imageMimeType });
    setNewCustomerFirstName(data.firstName || '');
    setNewCustomerLastName(data.lastName || '');
    setShowIdScanner(false);
  }, []);

  useEffect(() => {
    if (!success || !scannedIdImage || !useNewCustomer) return;
    const email = newCustomerEmail.trim();
    if (!email) return;

    (async () => {
      try {
        const results = await fetchWithCredentials<Array<{ id?: string; email?: string }>>(`/api/members/search?q=${encodeURIComponent(email)}&limit=1`);
        const user = Array.isArray(results) ? results.find((u) => u.email?.toLowerCase() === email.toLowerCase()) : null;
        if (user?.id) {
          await postWithCredentials('/api/admin/save-id-image', {
            userId: user.id,
            image: scannedIdImage.base64,
            mimeType: scannedIdImage.mimeType,
          });
        }
      } catch (err: unknown) {
        console.error('[POS] Failed to save scanned ID image:', err);
      }
    })();
  }, [success, scannedIdImage, useNewCustomer, newCustomerEmail]);

  return {
    isDark,
    isMobile,
    cafeItems,
    cafeLoading,
    passProducts,
    passProductsLoading,
    stripePromise,
    activeTab,
    setActiveTab,
    cartItems,
    description,
    setDescription,
    selectedMember,
    setSelectedMember,
    useNewCustomer,
    setUseNewCustomer,
    useGuestCheckout,
    setUseGuestCheckout,
    newCustomerFirstName,
    setNewCustomerFirstName,
    newCustomerLastName,
    setNewCustomerLastName,
    newCustomerEmail,
    setNewCustomerEmail,
    newCustomerPhone,
    setNewCustomerPhone,
    addedProductId,
    showIdScanner,
    setShowIdScanner,
    scannedIdImage,
    setScannedIdImage,
    drawerOpen,
    setDrawerOpen,
    mobileCartOpen,
    setMobileCartOpen,
    selectedPaymentMethod,
    setSelectedPaymentMethod,
    clientSecret,
    setClientSecret,
    paymentIntentId,
    setPaymentIntentId,
    isCreatingIntent,
    isProcessing,
    error,
    setError,
    success,
    receiptSent,
    receiptSending,
    guestReceiptEmail,
    setGuestReceiptEmail,
    attachingEmail,
    savedCard,
    setSavedCard,
    checkingSavedCard,
    totalCents,
    totalFormatted,
    totalItems,
    groupedCafeItems,
    sortedCafeCategories,
    addToCart,
    updateQuantity,
    clearCart,
    getCustomerInfo,
    canReview,
    handleSelectPaymentMethod,
    handleCardPaymentSuccess,
    handleTerminalSuccess,
    handleSavedCardCharge,
    handleSendReceipt,
    handleGuestReceiptSubmit,
    resetForm,
    handleIdScanComplete,
    buildDescription,
  };
}

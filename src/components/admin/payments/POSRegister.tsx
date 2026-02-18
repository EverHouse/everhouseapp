import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { SimpleCheckoutForm } from '../../stripe/StripePaymentForm';
import { getStripeAppearance } from '../../stripe/stripeAppearance';
import { MemberSearchInput, SelectedMember } from '../../shared/MemberSearchInput';
import { SlideUpDrawer } from '../../SlideUpDrawer';
import { TerminalPayment } from '../../staff-command-center/TerminalPayment';
import AnimatedCheckmark from '../../AnimatedCheckmark';
import { useTheme } from '../../../contexts/ThemeContext';
import { useIsMobile } from '../../../hooks/useBreakpoint';
import { useCafeMenu } from '../../../hooks/queries/useCafeQueries';
import type { CafeItem } from '../../../types/data';
import RedeemDayPassSection from './RedeemPassCard';
import IdScannerModal from '../../staff-command-center/modals/IdScannerModal';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';

interface CartItem {
  productId: string;
  name: string;
  priceCents: number;
  quantity: number;
  icon: string;
}

type PaymentMethodType = 'online_card' | 'terminal' | 'saved_card';
type CategoryTab = 'all' | 'passes' | 'cafe' | 'merch';

const PASS_PRODUCTS = [
  { productId: 'prod_TvPiZ9a7L3BqZX', name: 'Day Pass - Coworking', priceCents: 3500, icon: 'workspace_premium' },
  { productId: 'prod_TvPiHiafkZcoKR', name: 'Day Pass - Golf Sim', priceCents: 5000, icon: 'sports_golf' },
];

const CAFE_CATEGORY_ICONS: Record<string, string> = {
  Breakfast: 'breakfast_dining',
  Lunch: 'lunch_dining',
  Dessert: 'cake',
  Kids: 'child_care',
  Shareables: 'restaurant',
  Sides: 'set_meal',
};

const CATEGORY_TABS: { key: CategoryTab; label: string; icon: string }[] = [
  { key: 'all', label: 'All', icon: 'grid_view' },
  { key: 'passes', label: 'Passes', icon: 'confirmation_number' },
  { key: 'cafe', label: 'Cafe', icon: 'coffee' },
  { key: 'merch', label: 'Merch', icon: 'storefront' },
];

const CAFE_CATEGORY_ORDER = ['Breakfast', 'Dessert', 'Kids', 'Lunch', 'Shareables', 'Sides'];

function getCafeItemIcon(item: CafeItem): string {
  if (item.icon) return item.icon;
  return CAFE_CATEGORY_ICONS[item.category] || 'restaurant';
}

function cafeItemToCartProduct(item: CafeItem) {
  return {
    productId: item.id,
    name: item.name,
    priceCents: Math.round(item.price * 100),
    icon: getCafeItemIcon(item),
  };
}

const POSRegister: React.FC = () => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const isMobile = useIsMobile();
  const { data: cafeItems, isLoading: cafeLoading } = useCafeMenu();

  const stripePromise = useMemo(() => loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || ''), []);

  const [activeTab, setActiveTab] = useState<CategoryTab>('all');
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [description, setDescription] = useState('');
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [useNewCustomer, setUseNewCustomer] = useState(false);
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

  const [savedCard, setSavedCard] = useState<{ hasSavedCard: boolean; cardLast4?: string; cardBrand?: string } | null>(null);
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
      const res = await fetch(`/api/stripe/staff/check-saved-card/${encodeURIComponent(email)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSavedCard(data);
      }
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
    if (useNewCustomer) {
      return {
        email: newCustomerEmail,
        name: `${newCustomerFirstName} ${newCustomerLastName}`.trim(),
        firstName: newCustomerFirstName,
        lastName: newCustomerLastName,
        phone: newCustomerPhone || undefined,
        isNewCustomer: true as const,
        id: null as string | null,
      };
    }
    return selectedMember
      ? {
          email: selectedMember.email,
          name: selectedMember.name,
          isNewCustomer: false as const,
          id: selectedMember.id as string | null,
        }
      : null;
  };

  const isCustomerValid = () => {
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

  const handleSelectPaymentMethod = async (method: PaymentMethodType) => {
    setSelectedPaymentMethod(method);
    setError(null);

    if (method === 'online_card' && !clientSecret) {
      await createPaymentIntent();
    }
  };

  const createPaymentIntent = async () => {
    const customer = getCustomerInfo();
    if (!customer || totalCents <= 0) return;

    setIsCreatingIntent(true);
    setError(null);

    try {
      const payload: Record<string, any> = {
        memberEmail: customer.email,
        memberName: customer.name,
        amountCents: totalCents,
        description: buildDescription(),
      };

      if (cartItems.length === 1) {
        payload.productId = cartItems[0].productId;
      }

      if (cartItems.length > 0) {
        payload.cartItems = cartItems.map(item => ({
          productId: item.productId,
          name: item.name,
          priceCents: item.priceCents,
          quantity: item.quantity,
        }));
      }

      if (customer.isNewCustomer) {
        payload.isNewCustomer = true;
        payload.firstName = (customer as any).firstName;
        payload.lastName = (customer as any).lastName;
        if ((customer as any).phone) {
          payload.phone = (customer as any).phone;
        }
      }

      const res = await fetch('/api/stripe/staff/quick-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create payment');
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to create payment');
    } finally {
      setIsCreatingIntent(false);
    }
  };

  const handleCardPaymentSuccess = async (piId?: string) => {
    const intentId = piId || paymentIntentId;
    if (!intentId) return;

    try {
      const res = await fetch('/api/stripe/staff/quick-charge/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId: intentId }),
      });
      if (!res.ok) {
        console.warn('[POS] Confirm call returned non-OK status:', res.status);
      }
    } catch (err) {
      console.error('[POS] Failed to confirm payment record:', err);
    }

    setPaymentIntentId(intentId);
    setSuccess(true);
  };

  const handleTerminalSuccess = async (piId: string) => {
    try {
      const res = await fetch('/api/stripe/staff/quick-charge/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId: piId }),
      });
      if (!res.ok) {
        console.warn('[POS] Terminal confirm returned non-OK status:', res.status);
      }
    } catch (err) {
      console.error('[POS] Failed to confirm terminal payment record:', err);
    }

    setPaymentIntentId(piId);
    setSuccess(true);
  };

  const handleSavedCardCharge = async () => {
    const customer = getCustomerInfo();
    if (!customer || totalCents <= 0) return;

    setIsProcessing(true);
    setError(null);

    try {
      const res = await fetch('/api/stripe/staff/charge-saved-card-pos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: customer.email,
          memberName: customer.name,
          amountCents: totalCents,
          description: buildDescription(),
          productId: cartItems.length === 1 ? cartItems[0].productId : undefined,
          cartItems: cartItems.map(item => ({
            productId: item.productId,
            name: item.name,
            priceCents: item.priceCents,
            quantity: item.quantity,
          })),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to charge card');
      }

      setPaymentIntentId(data.paymentIntentId);
      setSuccess(true);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to charge card on file');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSendReceipt = async () => {
    const customer = getCustomerInfo();
    if (!customer) return;

    setReceiptSending(true);
    try {
      const effectivePaymentMethod =
        selectedPaymentMethod === 'terminal'
          ? 'terminal'
          : 'card';

      const res = await fetch('/api/purchases/send-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: customer.email,
          memberName: customer.name,
          items: cartItems.map(item => ({
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.priceCents,
            total: item.priceCents * item.quantity,
          })),
          totalAmount: totalCents,
          paymentMethod: effectivePaymentMethod,
          paymentIntentId: paymentIntentId || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to send receipt');
      }

      setReceiptSent(true);
    } catch {
      setError('Failed to send receipt');
    } finally {
      setReceiptSending(false);
    }
  };

  const resetForm = () => {
    setCartItems([]);
    setDescription('');
    setSelectedMember(null);
    setUseNewCustomer(false);
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
        const searchRes = await fetch(`/api/members/search?q=${encodeURIComponent(email)}&limit=1`, { credentials: 'include' });
        if (searchRes.ok) {
          const results = await searchRes.json();
          const user = Array.isArray(results) ? results.find((u: any) => u.email?.toLowerCase() === email.toLowerCase()) : null;
          if (user?.id) {
            await fetch('/api/admin/save-id-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                userId: user.id,
                image: scannedIdImage.base64,
                mimeType: scannedIdImage.mimeType,
              }),
            });
          }
        }
      } catch (err) {
        console.error('[POS] Failed to save scanned ID image:', err);
      }
    })();
  }, [success, scannedIdImage, useNewCustomer, newCustomerEmail]);

  const renderProductCard = (product: { productId: string; name: string; priceCents: number; icon: string }) => (
    <button
      key={product.productId}
      onClick={() => addToCart(product)}
      className={`flex flex-col items-center gap-2 p-3 rounded-xl bg-white/60 dark:bg-white/5 border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10 transition-all duration-fast text-center active:scale-95 ${
        addedProductId === product.productId ? 'scale-95 ring-2 ring-emerald-400/50' : ''
      }`}
    >
      <span className="material-symbols-outlined text-2xl text-primary dark:text-white">{product.icon}</span>
      <span className="text-xs font-medium text-primary dark:text-white leading-tight">{product.name}</span>
      <span className="text-sm font-bold text-primary dark:text-white">
        ${(product.priceCents / 100).toFixed(2)}
      </span>
    </button>
  );

  const renderSkeletonCards = (count: number) => (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={`skeleton-${i}`}
          className="flex flex-col items-center gap-2 p-3 rounded-xl bg-white/60 dark:bg-white/5 border border-primary/10 dark:border-white/10 animate-pulse"
        >
          <div className="w-8 h-8 rounded-full bg-primary/10 dark:bg-white/10" />
          <div className="w-16 h-3 rounded bg-primary/10 dark:bg-white/10" />
          <div className="w-10 h-4 rounded bg-primary/10 dark:bg-white/10" />
        </div>
      ))}
    </>
  );

  const renderProductGrid = () => {
    const gridCols = isMobile ? 'grid-cols-2' : 'grid-cols-3 xl:grid-cols-4';

    if (activeTab === 'merch') {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <span className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/30">storefront</span>
          <p className="text-primary/60 dark:text-white/60 font-medium">Merchandise coming soon</p>
        </div>
      );
    }

    if (activeTab === 'passes' || activeTab === 'all') {
      const showPasses = activeTab === 'all' || activeTab === 'passes';
      const showCafe = activeTab === 'all';

      return (
        <div className="space-y-4">
          {showPasses && (
            <div>
              {activeTab === 'all' && (
                <h4 className="text-xs font-semibold text-primary/50 dark:text-white/50 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">confirmation_number</span>
                  Passes
                </h4>
              )}
              <div className={`grid ${gridCols} gap-2`}>
                {PASS_PRODUCTS.map(renderProductCard)}
              </div>
            </div>
          )}
          {showCafe && (
            <div>
              <h4 className="text-xs font-semibold text-primary/50 dark:text-white/50 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">coffee</span>
                Cafe
              </h4>
              {cafeLoading ? (
                <div className={`grid ${gridCols} gap-2`}>
                  {renderSkeletonCards(6)}
                </div>
              ) : sortedCafeCategories.length > 0 ? (
                <div className="space-y-3">
                  {sortedCafeCategories.map(cat => (
                    <div key={cat}>
                      <p className="text-xs font-medium text-primary/40 dark:text-white/40 mb-1.5 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">{CAFE_CATEGORY_ICONS[cat] || 'restaurant'}</span>
                        {cat}
                      </p>
                      <div className={`grid ${gridCols} gap-2`}>
                        {groupedCafeItems[cat].map(item =>
                          renderProductCard(cafeItemToCartProduct(item))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-primary/40 dark:text-white/40 py-4 text-center">No cafe items available</p>
              )}
            </div>
          )}
        </div>
      );
    }

    if (activeTab === 'cafe') {
      if (cafeLoading) {
        return (
          <div className={`grid ${gridCols} gap-2`}>
            {renderSkeletonCards(8)}
          </div>
        );
      }

      if (sortedCafeCategories.length === 0) {
        return (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <span className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/30">coffee</span>
            <p className="text-primary/60 dark:text-white/60 font-medium">No cafe items available</p>
          </div>
        );
      }

      return (
        <div className="space-y-3">
          {sortedCafeCategories.map(cat => (
            <div key={cat}>
              <p className="text-xs font-medium text-primary/40 dark:text-white/40 mb-1.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">{CAFE_CATEGORY_ICONS[cat] || 'restaurant'}</span>
                {cat}
              </p>
              <div className={`grid ${gridCols} gap-2`}>
                {groupedCafeItems[cat].map(item =>
                  renderProductCard(cafeItemToCartProduct(item))
                )}
              </div>
            </div>
          ))}
        </div>
      );
    }

    return null;
  };

  const renderCartItems = () => {
    if (cartItems.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <span className="material-symbols-outlined text-3xl text-primary/20 dark:text-white/20">shopping_cart</span>
          <p className="text-sm text-primary/40 dark:text-white/40">Cart is empty</p>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-primary dark:text-white">Cart</span>
          <button
            onClick={clearCart}
            className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">delete</span>
            Clear Cart
          </button>
        </div>
        {cartItems.map(item => (
          <div key={item.productId} className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-sm text-primary dark:text-white flex-1 truncate">{item.name}</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => updateQuantity(item.productId, -1)}
                className="w-7 h-7 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white flex items-center justify-center hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">remove</span>
              </button>
              <span className="w-6 text-center text-sm font-semibold text-primary dark:text-white">
                {item.quantity}
              </span>
              <button
                onClick={() => updateQuantity(item.productId, 1)}
                className="w-7 h-7 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white flex items-center justify-center hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">add</span>
              </button>
            </div>
            <span className="text-sm font-semibold text-primary dark:text-white w-16 text-right">
              ${((item.priceCents * item.quantity) / 100).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  const renderCustomerSection = () => {
    if (!useNewCustomer) {
      return (
        <div className="space-y-2">
          <MemberSearchInput
            label="Customer"
            placeholder="Search by name or email..."
            selectedMember={selectedMember}
            onSelect={(member) => setSelectedMember(member)}
            onClear={() => setSelectedMember(null)}
            includeVisitors={true}
            includeFormer={true}
          />
          <button
            type="button"
            onClick={() => {
              setUseNewCustomer(true);
              setSelectedMember(null);
            }}
            className="text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-base">person_add</span>
            New Customer
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-primary dark:text-white">New Customer</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowIdScanner(true)}
              className="text-sm text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-base">badge</span>
              Scan ID
            </button>
            <button
              type="button"
              onClick={() => {
                setUseNewCustomer(false);
                setNewCustomerFirstName('');
                setNewCustomerLastName('');
                setNewCustomerEmail('');
                setNewCustomerPhone('');
                setScannedIdImage(null);
              }}
              className="text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-base">search</span>
              Search existing
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
              First Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newCustomerFirstName}
              onChange={(e) => setNewCustomerFirstName(e.target.value)}
              placeholder="John"
              className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
              Last Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newCustomerLastName}
              onChange={(e) => setNewCustomerLastName(e.target.value)}
              placeholder="Doe"
              className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
            Email <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            value={newCustomerEmail}
            onChange={(e) => setNewCustomerEmail(e.target.value)}
            placeholder="john@example.com"
            className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
            Phone (optional)
          </label>
          <input
            type="tel"
            value={newCustomerPhone}
            onChange={(e) => setNewCustomerPhone(e.target.value)}
            placeholder="(555) 123-4567"
            className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
          />
        </div>
        {scannedIdImage && (
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-xs mt-1">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            ID scanned — image will be saved with this customer
          </div>
        )}
      </div>
    );
  };

  const renderDrawerContent = () => {
    if (success) {
      return (
        <div className="flex flex-col items-center justify-center py-8 gap-4 px-5">
          <AnimatedCheckmark size={64} color={isDark ? '#4ade80' : '#16a34a'} />
          <p className="text-xl font-bold text-primary dark:text-white">
            Payment of {totalFormatted} successful!
          </p>
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl text-red-700 dark:text-red-300 text-sm w-full max-w-xs">
              {error}
            </div>
          )}
          <div className="flex flex-col gap-3 w-full max-w-xs mt-4">
            <button
              onClick={handleSendReceipt}
              disabled={receiptSent || receiptSending}
              className={`w-full py-3 px-6 rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors ${
                receiptSent
                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                  : 'bg-white/60 dark:bg-white/5 border border-primary/20 dark:border-white/20 text-primary dark:text-white hover:bg-white/80 dark:hover:bg-white/10'
              }`}
            >
              <span className="material-symbols-outlined text-lg">
                {receiptSent ? 'check' : 'email'}
              </span>
              {receiptSending ? 'Sending...' : receiptSent ? 'Receipt Sent' : 'Email Receipt'}
            </button>
            <button
              onClick={resetForm}
              className="w-full py-3 px-6 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-colors hover:opacity-90"
            >
              Done
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-5 px-5 pb-5">
        <div>
          <h4 className="text-sm font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider mb-3">
            Order Summary
          </h4>
          <div className={`rounded-xl overflow-hidden border ${isDark ? 'border-white/10' : 'border-primary/10'}`}>
            {cartItems.map((item, idx) => (
              <div
                key={item.productId}
                className={`flex items-center justify-between px-4 py-3 ${
                  idx < cartItems.length - 1 ? `border-b ${isDark ? 'border-white/10' : 'border-primary/10'}` : ''
                }`}
              >
                <div className="flex-1">
                  <span className="text-sm font-medium text-primary dark:text-white">{item.name}</span>
                  <span className="text-sm text-primary/60 dark:text-white/60 ml-2">
                    {item.quantity} × ${(item.priceCents / 100).toFixed(2)}
                  </span>
                </div>
                <span className="text-sm font-semibold text-primary dark:text-white">
                  ${((item.priceCents * item.quantity) / 100).toFixed(2)}
                </span>
              </div>
            ))}
            <div
              className={`flex items-center justify-between px-4 py-3 border-t ${
                isDark ? 'border-white/10 bg-white/5' : 'border-primary/10 bg-primary/5'
              }`}
            >
              <span className="text-base font-bold text-primary dark:text-white">Total</span>
              <span className="text-lg font-bold text-primary dark:text-white">{totalFormatted}</span>
            </div>
          </div>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider mb-2">
            Customer
          </h4>
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
            <span className="material-symbols-outlined text-primary/60 dark:text-white/60">person</span>
            <div>
              <p className="text-sm font-medium text-primary dark:text-white">{getCustomerInfo()?.name}</p>
              <p className="text-xs text-primary/60 dark:text-white/60">{getCustomerInfo()?.email}</p>
            </div>
          </div>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wider mb-3">
            Payment Method
          </h4>
          <div className={`grid gap-2 ${savedCard?.hasSavedCard && !useNewCustomer ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <button
              onClick={() => handleSelectPaymentMethod('online_card')}
              className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
                selectedPaymentMethod === 'online_card'
                  ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                  : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
              }`}
            >
              <span className="material-symbols-outlined text-xl">credit_card</span>
              Online Card
            </button>
            <button
              onClick={() => handleSelectPaymentMethod('terminal')}
              className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
                selectedPaymentMethod === 'terminal'
                  ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                  : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
              }`}
            >
              <span className="material-symbols-outlined text-xl">contactless</span>
              Card Reader
            </button>
            {savedCard?.hasSavedCard && !useNewCustomer && (
              <button
                onClick={() => handleSelectPaymentMethod('saved_card')}
                className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-sm font-medium transition-colors ${
                  selectedPaymentMethod === 'saved_card'
                    ? 'bg-primary dark:bg-lavender text-white shadow-sm'
                    : 'bg-white/60 dark:bg-white/5 text-primary dark:text-white border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
                }`}
              >
                <span className="material-symbols-outlined text-xl">wallet</span>
                <span className="leading-tight text-center">Card on File{savedCard.cardLast4 ? ` ••${savedCard.cardLast4}` : ''}</span>
              </button>
            )}
          </div>
          {checkingSavedCard && (
            <p className="text-xs text-primary/40 dark:text-white/40 mt-2 flex items-center gap-1">
              <span className="animate-spin inline-block w-3 h-3 border border-primary/30 dark:border-white/30 border-t-transparent rounded-full" />
              Checking saved card...
            </p>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-xl text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {selectedPaymentMethod === 'online_card' && (
          <div>
            {isCreatingIntent ? (
              <div className="flex items-center justify-center py-8">
                <WalkingGolferSpinner size="sm" variant="dark" />
              </div>
            ) : clientSecret ? (
              <Elements
                stripe={stripePromise}
                options={{
                  clientSecret,
                  appearance: getStripeAppearance(isDark),
                }}
              >
                <SimpleCheckoutForm
                  onSuccess={handleCardPaymentSuccess}
                  onError={(msg) => setError(msg)}
                  submitLabel={`Pay ${totalFormatted}`}
                />
              </Elements>
            ) : null}
          </div>
        )}

        {selectedPaymentMethod === 'terminal' && (
          <TerminalPayment
            amount={totalCents}
            userId={getCustomerInfo()?.id || null}
            description={buildDescription()}
            paymentMetadata={{
              source: 'pos',
              items: cartItems.map(i => `${i.name} x${i.quantity}`).join(', '),
              ...(getCustomerInfo()?.id ? { userId: getCustomerInfo()!.id! } : {}),
              ...(getCustomerInfo()?.email ? { ownerEmail: getCustomerInfo()!.email } : {}),
              ...(getCustomerInfo()?.name ? { ownerName: getCustomerInfo()!.name } : {}),
            }}
            cartItems={cartItems.map(item => ({
              productId: item.productId,
              name: item.name,
              priceCents: item.priceCents,
              quantity: item.quantity,
            }))}
            onSuccess={handleTerminalSuccess}
            onError={(msg) => setError(msg)}
            onCancel={() => setSelectedPaymentMethod(null)}
          />
        )}

        {selectedPaymentMethod === 'saved_card' && (
          <div className="space-y-4">
            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl ${isDark ? 'bg-white/5' : 'bg-primary/5'}`}>
              <span className="material-symbols-outlined text-primary/60 dark:text-white/60">credit_card</span>
              <div>
                <p className="text-sm font-medium text-primary dark:text-white capitalize">
                  {savedCard?.cardBrand || 'Card'} ending in {savedCard?.cardLast4 || '****'}
                </p>
                <p className="text-xs text-primary/50 dark:text-white/50">Will be charged instantly</p>
              </div>
            </div>
            <button
              onClick={handleSavedCardCharge}
              disabled={isProcessing}
              className="w-full py-4 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50"
            >
              {isProcessing ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  Charging...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">bolt</span>
                  Charge {totalFormatted}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderMobileCartDrawerContent = () => (
    <div className="space-y-4 px-5 pb-5">
      {renderCartItems()}

      {cartItems.length > 0 && (
        <>
          <div>
            <label className="block text-sm font-medium text-primary dark:text-white mb-1.5">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a note..."
              className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="text-center">
            <p className="text-3xl font-bold text-primary dark:text-white">{totalFormatted}</p>
          </div>

          <button
            onClick={() => {
              setMobileCartOpen(false);
              setDrawerOpen(true);
            }}
            disabled={!canReview}
            className="w-full py-4 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">shopping_cart_checkout</span>
            Review & Charge
          </button>
        </>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div className="pb-24">
        <div className="space-y-4">
          <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
            {renderCustomerSection()}
          </div>

          <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 overflow-hidden">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-primary dark:text-accent">grid_view</span>
              <h3 className="font-bold text-primary dark:text-white">Products</h3>
            </div>

            <div className="flex gap-2 mb-4 overflow-x-auto pb-1 scrollbar-hide">
              {CATEGORY_TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                    activeTab === tab.key
                      ? 'bg-primary dark:bg-lavender text-white'
                      : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60 hover:bg-white/80 dark:hover:bg-white/15'
                  }`}
                >
                  <span className="material-symbols-outlined text-base">{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>

            {renderProductGrid()}
          </div>

          <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl">
            <RedeemDayPassSection variant="card" />
          </div>
        </div>

        {(cartItems.length > 0 || canReview) && (
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-white/80 dark:bg-[#1a1d12]/90 backdrop-blur-xl border-t border-primary/10 dark:border-white/10 px-4 py-3 safe-area-bottom">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setMobileCartOpen(true)}
                className="relative p-2"
              >
                <span className="material-symbols-outlined text-2xl text-primary dark:text-white">shopping_cart</span>
                {totalItems > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
                    {totalItems}
                  </span>
                )}
              </button>

              <div className="flex-1">
                <p className="text-lg font-bold text-primary dark:text-white">{totalFormatted}</p>
              </div>

              <button
                onClick={() => {
                  if (canReview) {
                    setDrawerOpen(true);
                  } else {
                    setMobileCartOpen(true);
                  }
                }}
                disabled={cartItems.length === 0}
                className="px-6 py-3 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center gap-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-lg">shopping_cart_checkout</span>
                Review
              </button>
            </div>
          </div>
        )}

        <SlideUpDrawer
          isOpen={mobileCartOpen}
          onClose={() => setMobileCartOpen(false)}
          title="Your Cart"
          maxHeight="large"
        >
          {renderMobileCartDrawerContent()}
        </SlideUpDrawer>

        <SlideUpDrawer
          isOpen={drawerOpen}
          onClose={() => {
            if (!success) {
              setDrawerOpen(false);
              setSelectedPaymentMethod(null);
              setClientSecret(null);
              setPaymentIntentId(null);
              setError(null);
            }
          }}
          title="Review & Charge"
          maxHeight="large"
          dismissible={!success && !isProcessing && !isCreatingIntent}
        >
          {renderDrawerContent()}
        </SlideUpDrawer>
      </div>
    );
  }

  return (
    <div className="flex gap-6 items-start">
      <div className="flex-[2] min-w-0">
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-primary dark:text-accent">grid_view</span>
            <h3 className="font-bold text-primary dark:text-white text-lg">Products</h3>
          </div>

          <div className="flex gap-2 mb-4 flex-wrap">
            {CATEGORY_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'bg-primary dark:bg-lavender text-white'
                    : 'bg-white/60 dark:bg-white/10 text-primary/60 dark:text-white/60 hover:bg-white/80 dark:hover:bg-white/15'
                }`}
              >
                <span className="material-symbols-outlined text-base">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          {renderProductGrid()}
        </div>
      </div>

      <div className="flex-1 min-w-[320px] max-w-[400px] sticky top-4">
        <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary dark:text-accent">point_of_sale</span>
            <h3 className="font-bold text-primary dark:text-white">Checkout</h3>
          </div>

          {renderCustomerSection()}

          <div className={`border-t ${isDark ? 'border-white/10' : 'border-primary/10'}`} />

          {renderCartItems()}

          {cartItems.length > 0 && (
            <>
              <div>
                <label className="block text-sm font-medium text-primary dark:text-white mb-1.5">
                  Description (optional)
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add a note..."
                  className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div className="text-center">
                <p className="text-3xl font-bold text-primary dark:text-white">{totalFormatted}</p>
              </div>
            </>
          )}

          <button
            onClick={() => setDrawerOpen(true)}
            disabled={!canReview}
            className="w-full py-4 rounded-xl font-semibold bg-primary dark:bg-lavender text-white transition-all duration-fast flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">shopping_cart_checkout</span>
            Review & Charge
          </button>
        </div>

        <div className="mt-4 bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl">
          <RedeemDayPassSection variant="card" />
        </div>
      </div>

      <SlideUpDrawer
        isOpen={drawerOpen}
        onClose={() => {
          if (!success) {
            setDrawerOpen(false);
            setSelectedPaymentMethod(null);
            setClientSecret(null);
            setPaymentIntentId(null);
            setError(null);
          }
        }}
        title="Review & Charge"
        maxHeight="large"
        dismissible={!success && !isProcessing && !isCreatingIntent}
      >
        {renderDrawerContent()}
      </SlideUpDrawer>

      <IdScannerModal
        isOpen={showIdScanner}
        onClose={() => setShowIdScanner(false)}
        onScanComplete={handleIdScanComplete}
        isDark={isDark}
      />
    </div>
  );
};

export default POSRegister;

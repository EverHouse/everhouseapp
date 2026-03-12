import React, { useState, useEffect } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';

interface StripeProduct {
  id: number;
  hubspotProductId: string;
  stripeProductId: string;
  stripePriceId: string;
  name: string;
  priceCents: number;
  billingInterval: string | null;
  billingIntervalCount: number | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ProductsSubTabProps {
  activeSubTab: 'membership' | 'fees' | 'discounts';
}

const ProductsSubTab: React.FC<ProductsSubTabProps> = ({ activeSubTab }) => {
  const [products, setProducts] = useState<StripeProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [productsRef] = useAutoAnimate();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const res = await fetch('/api/stripe/products', { credentials: 'include' });
      const data = await res.json();
      setProducts(data.products || []);
    } catch (err: unknown) {
      console.error('Failed to fetch Stripe products:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span aria-hidden="true" className="material-symbols-outlined animate-spin text-4xl text-primary/70">progress_activity</span>
      </div>
    );
  }

  const membershipProducts = products.filter(p => p.billingInterval != null);
  const feeProducts = products.filter(p => p.billingInterval == null);

  const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  const renderProduct = (product: StripeProduct, index: number) => {
    return (
      <div key={product.id} className="p-4 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 tactile-row">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="font-semibold text-primary dark:text-white">{product.name}</h4>
              {!product.isActive && (
                <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">
                  Inactive
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-2 text-sm">
              <span className="font-medium text-primary dark:text-white">
                {formatPrice(product.priceCents)}
                {product.billingInterval && `/${product.billingInterval}`}
              </span>
              <span className="text-gray-500 text-xs">
                Stripe: {product.stripeProductId}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (activeSubTab === 'membership') {
    return (
      <div ref={productsRef} className="space-y-4">
        <div className="flex items-center justify-between mb-2 animate-content-enter">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {membershipProducts.length} membership product{membershipProducts.length !== 1 ? 's' : ''} in Stripe
          </p>
        </div>
        {membershipProducts.map((p, i) => renderProduct(p, i))}
        {membershipProducts.length === 0 && (
          <p className="text-center py-8 text-gray-500">No membership products configured</p>
        )}
      </div>
    );
  }

  if (activeSubTab === 'fees') {
    return (
      <div ref={productsRef} className="space-y-4">
        <div className="flex items-center justify-between mb-2 animate-content-enter">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {feeProducts.length} fee product{feeProducts.length !== 1 ? 's' : ''} for charges and passes
          </p>
        </div>
        {feeProducts.map((p, i) => renderProduct(p, i))}
        {feeProducts.length === 0 && (
          <p className="text-center py-8 text-gray-500">No fee products configured</p>
        )}
      </div>
    );
  }

  if (activeSubTab === 'discounts') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between mb-2 animate-content-enter">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Discount rules are managed through Stripe coupons
          </p>
        </div>
        <p className="text-center py-8 text-gray-500">
          Manage discounts directly in your Stripe Dashboard
        </p>
      </div>
    );
  }

  return null;
};

export default ProductsSubTab;

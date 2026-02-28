import React, { useState, useEffect } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import Toggle from '../../../components/Toggle';

interface ProductMapping {
  id: number;
  hubspot_product_id: string;
  product_name: string;
  product_type: 'membership' | 'fee' | 'pass';
  tier_name: string | null;
  unit_price: string;
  billing_frequency: string | null;
  description: string | null;
  is_active: boolean;
}

interface DiscountRule {
  id: number;
  discount_tag: string;
  discount_percent: number;
  description: string | null;
  is_active: boolean;
}

interface ProductsSubTabProps {
  activeSubTab: 'membership' | 'fees' | 'discounts';
}

const ProductsSubTab: React.FC<ProductsSubTabProps> = ({ activeSubTab }) => {
  const [products, setProducts] = useState<ProductMapping[]>([]);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string | number | boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [productsRef] = useAutoAnimate();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [productsRes, rulesRes] = await Promise.all([
        fetch('/api/hubspot/products', { credentials: 'include' }),
        fetch('/api/hubspot/discount-rules', { credentials: 'include' })
      ]);
      
      const productsData = await productsRes.json();
      const rulesData = await rulesRes.json();
      
      setProducts(productsData.products || []);
      setDiscountRules(rulesData.rules || []);
    } catch (err: unknown) {
      console.error('Failed to fetch products/rules:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditProduct = (product: ProductMapping) => {
    setEditingId(product.id);
    setEditValues({
      unitPrice: product.unit_price,
      description: product.description,
      isActive: product.is_active
    });
  };

  const handleEditRule = (rule: DiscountRule) => {
    setEditingId(rule.id);
    setEditValues({
      discountPercent: rule.discount_percent,
      description: rule.description,
      isActive: rule.is_active
    });
  };

  const handleSaveProduct = async (productId: number) => {
    setIsSaving(true);
    try {
      await fetch(`/api/hubspot/products/${productId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editValues)
      });
      await fetchData();
      setEditingId(null);
    } catch (err: unknown) {
      console.error('Failed to save product:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveRule = async (tag: string) => {
    setIsSaving(true);
    try {
      await fetch(`/api/hubspot/discount-rules/${encodeURIComponent(tag)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editValues)
      });
      await fetchData();
      setEditingId(null);
    } catch (err: unknown) {
      console.error('Failed to save rule:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span aria-hidden="true" className="material-symbols-outlined animate-spin text-4xl text-primary/70">progress_activity</span>
      </div>
    );
  }

  const membershipProducts = products.filter(p => p.product_type === 'membership');
  const feeProducts = products.filter(p => p.product_type === 'fee' || p.product_type === 'pass');

  const renderProduct = (product: ProductMapping, index: number) => {
    const isEditing = editingId === product.id;
    
    return (
      <div key={product.id} className={`p-4 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 tactile-row ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'}`}>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="font-semibold text-primary dark:text-white">{product.product_name}</h4>
              {product.tier_name && (
                <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary dark:bg-primary/20 dark:text-white rounded-full">
                  {product.tier_name}
                </span>
              )}
              {!product.is_active && (
                <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">
                  Inactive
                </span>
              )}
            </div>
            
            {isEditing ? (
              <div className="space-y-3 mt-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-gray-500">Unit Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-primary dark:text-white text-sm"
                    value={String(editValues.unitPrice || '')}
                    onChange={e => setEditValues({ ...editValues, unitPrice: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-gray-500">Description</label>
                  <textarea
                    className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-primary dark:text-white text-sm resize-none"
                    rows={2}
                    value={String(editValues.description || '')}
                    onChange={e => setEditValues({ ...editValues, description: e.target.value })}
                  />
                </div>
                <label className="flex items-center justify-between">
                  <span className="text-sm text-primary dark:text-white">Active</span>
                  <Toggle
                    checked={editValues.isActive as boolean ?? true}
                    onChange={val => setEditValues({ ...editValues, isActive: val })}
                    label="Active"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSaveProduct(product.id)}
                    disabled={isSaving}
                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="px-4 py-2 bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-white rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-white/20 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-400">{product.description}</p>
                <div className="flex items-center gap-4 mt-2 text-sm">
                  <span className="font-medium text-primary dark:text-white">
                    ${parseFloat(product.unit_price).toFixed(2)}
                    {product.billing_frequency === 'monthly' && '/mo'}
                  </span>
                  <span className="text-gray-500 text-xs">
                    HubSpot ID: {product.hubspot_product_id}
                  </span>
                </div>
              </>
            )}
          </div>
          
          {!isEditing && (
            <button
              onClick={() => handleEditProduct(product)}
              className="p-2 text-gray-500 hover:text-primary dark:hover:text-white transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-lg">edit</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderDiscountRule = (rule: DiscountRule, index: number) => {
    const isEditing = editingId === rule.id;
    
    return (
      <div key={rule.id} className={`p-4 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'}`}>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="font-semibold text-primary dark:text-white">{rule.discount_tag}</h4>
              {!rule.is_active && (
                <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">
                  Inactive
                </span>
              )}
            </div>
            
            {isEditing ? (
              <div className="space-y-3 mt-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-gray-500">Discount Percent (%)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-primary dark:text-white text-sm"
                    value={String(editValues.discountPercent ?? '')}
                    onChange={e => setEditValues({ ...editValues, discountPercent: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-gray-500">Description</label>
                  <textarea
                    className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-primary dark:text-white text-sm resize-none"
                    rows={2}
                    value={String(editValues.description || '')}
                    onChange={e => setEditValues({ ...editValues, description: e.target.value })}
                  />
                </div>
                <label className="flex items-center justify-between">
                  <span className="text-sm text-primary dark:text-white">Active</span>
                  <Toggle
                    checked={editValues.isActive as boolean ?? true}
                    onChange={val => setEditValues({ ...editValues, isActive: val })}
                    label="Active"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSaveRule(rule.discount_tag)}
                    disabled={isSaving}
                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="px-4 py-2 bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-white rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-white/20 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-400">{rule.description}</p>
                <div className="mt-2">
                  <span className="text-2xl font-bold text-primary dark:text-white">{rule.discount_percent}%</span>
                  <span className="text-sm text-gray-500 ml-1">off</span>
                </div>
              </>
            )}
          </div>
          
          {!isEditing && (
            <button
              onClick={() => handleEditRule(rule)}
              className="p-2 text-gray-500 hover:text-primary dark:hover:text-white transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-lg">edit</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  if (activeSubTab === 'membership') {
    return (
      <div ref={productsRef} className="space-y-4">
        <div className="flex items-center justify-between mb-2 animate-content-enter">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {membershipProducts.length} membership product{membershipProducts.length !== 1 ? 's' : ''} linked to HubSpot
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
      <div ref={productsRef} className="space-y-4">
        <div className="flex items-center justify-between mb-2 animate-content-enter">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {discountRules.length} discount rule{discountRules.length !== 1 ? 's' : ''} based on member tags
          </p>
        </div>
        {discountRules.map((r, i) => renderDiscountRule(r, i))}
        {discountRules.length === 0 && (
          <p className="text-center py-8 text-gray-500">No discount rules configured</p>
        )}
      </div>
    );
  }

  return null;
};

export default ProductsSubTab;

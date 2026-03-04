import React from 'react';
import { formatDatePacific, CATEGORY_LABELS, CATEGORY_ICONS, CATEGORY_ORDER, getCategoryColors } from './types';
import type { PurchaseRecord } from './types';

export function PurchaseHistorySection({
  purchases,
  isDark,
}: {
  purchases: Array<{ id: number | string; category?: string; description?: string; amount?: number; date?: string; created_at?: string; product_name?: string; quantity?: number; status?: string }>;
  isDark: boolean;
}) {
  if (purchases.length === 0) return null;

  const categoryColors = getCategoryColors(isDark);

  const groupedPurchases = (purchases as PurchaseRecord[]).reduce((acc: Record<string, PurchaseRecord[]>, purchase: PurchaseRecord) => {
    const category = purchase.itemCategory || purchase.category || 'other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(purchase);
    return acc;
  }, {});
  
  const formatCurrency = (cents: number | undefined | null): string => {
    if (cents == null || isNaN(cents)) return '$0.00';
    return `$${(cents / 100).toFixed(2)}`;
  };

  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
      <div className="flex items-center gap-2 mb-4">
        <span className={`material-symbols-outlined ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>receipt_long</span>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Purchase History</h3>
      </div>
      
      <div className="space-y-6">
        {CATEGORY_ORDER.map(category => {
          const categoryPurchases = groupedPurchases[category];
          if (!categoryPurchases || categoryPurchases.length === 0) return null;
          
          return (
            <div key={category}>
              <h4 className={`text-sm font-semibold mb-3 flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 ${categoryColors[category] || categoryColors.other}`}>
                  <span className="material-symbols-outlined text-xs">{CATEGORY_ICONS[category] || 'receipt'}</span>
                  {CATEGORY_LABELS[category] || category}
                </span>
                <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                  ({categoryPurchases.length})
                </span>
              </h4>
              <div className="space-y-3">
                {categoryPurchases.slice(0, 5).map((purchase: PurchaseRecord) => {
                  const displayDate = purchase.saleDate || purchase.date;
                  const displayAmount = purchase.salePriceCents || purchase.amountCents || 0;
                  const displaySource = purchase.source || (purchase.type === 'stripe' ? 'Stripe' : '');
                  
                  return (
                    <div key={purchase.id} className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                              {purchase.itemName || purchase.product_name || purchase.description}
                            </span>
                            {purchase.quantity! > 1 && (
                              <span className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                                x{purchase.quantity}
                              </span>
                            )}
                            {displaySource && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-200 text-gray-500'}`}>
                                {displaySource}
                              </span>
                            )}
                          </div>
                          <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                            {formatDatePacific(displayDate)}
                          </p>
                        </div>
                        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {formatCurrency(displayAmount)}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {categoryPurchases.length > 5 && (
                  <p className={`text-xs text-center ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                    +{categoryPurchases.length - 5} more {CATEGORY_LABELS[category] || category} purchases
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

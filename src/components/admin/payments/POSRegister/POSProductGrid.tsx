import React from 'react';
import type { CafeItem } from '../../../../types/data';
import {
  type CategoryTab,
  CAFE_CATEGORY_ICONS,
  cafeItemToCartProduct,
} from './posTypes';

interface POSProductGridProps {
  activeTab: CategoryTab;
  isMobile: boolean;
  passProducts: { productId: string; name: string; priceCents: number; icon: string }[];
  passProductsLoading: boolean;
  cafeLoading: boolean;
  sortedCafeCategories: string[];
  groupedCafeItems: Record<string, CafeItem[]>;
  addedProductId: string | null;
  addToCart: (product: { productId: string; name: string; priceCents: number; icon: string }) => void;
}

const ProductCard: React.FC<{
  product: { productId: string; name: string; priceCents: number; icon: string };
  isAdded: boolean;
  onClick: () => void;
}> = ({ product, isAdded, onClick }) => (
  <button
    key={product.productId}
    onClick={onClick}
    className={`tactile-card flex flex-col items-center gap-2 p-3 rounded-xl bg-white/60 dark:bg-white/5 border border-primary/10 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10 transition-all duration-fast text-center active:scale-95 ${
      isAdded ? 'scale-95 ring-2 ring-emerald-400/50' : ''
    }`}
  >
    <span className="material-symbols-outlined text-3xl text-primary dark:text-white">{product.icon}</span>
    <span className="text-sm font-medium text-primary dark:text-white leading-tight">{product.name}</span>
    <span className="text-lg font-bold text-primary dark:text-white">
      ${(product.priceCents / 100).toFixed(2)}
    </span>
  </button>
);

const SkeletonCards: React.FC<{ count: number }> = ({ count }) => (
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

const POSProductGrid: React.FC<POSProductGridProps> = ({
  activeTab,
  isMobile,
  passProducts,
  passProductsLoading,
  cafeLoading,
  sortedCafeCategories,
  groupedCafeItems,
  addedProductId,
  addToCart,
}) => {
  const gridCols = isMobile ? 'grid-cols-2' : 'grid-cols-3 xl:grid-cols-4';

  const renderProductCard = (product: { productId: string; name: string; priceCents: number; icon: string }) => (
    <ProductCard
      key={product.productId}
      product={product}
      isAdded={addedProductId === product.productId}
      onClick={() => addToCart(product)}
    />
  );

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
              {passProductsLoading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-20 rounded-xl bg-surface/50 dark:bg-white/5 animate-pulse" />
                  ))
                : passProducts.map(renderProductCard)}
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
                <SkeletonCards count={6} />
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
          <SkeletonCards count={8} />
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

export default POSProductGrid;

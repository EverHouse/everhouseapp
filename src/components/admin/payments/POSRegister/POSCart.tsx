import React from 'react';
import type { CartItem } from './posTypes';

interface POSCartProps {
  cartItems: CartItem[];
  updateQuantity: (productId: string, delta: number) => void;
  clearCart: () => void;
}

const POSCart: React.FC<POSCartProps> = ({ cartItems, updateQuantity, clearCart }) => {
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

export default POSCart;

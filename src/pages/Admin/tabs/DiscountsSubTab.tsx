import React, { useState, useEffect } from 'react';
import ModalShell from '../../../components/ModalShell';

interface StripeCoupon {
  id: string;
  name: string;
  percentOff: number | null;
  amountOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  durationInMonths: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  valid: boolean;
  createdAt: string;
  metadata: Record<string, string>;
}

interface DiscountsSubTabProps {
  onCreateClick?: () => void;
}

const DiscountsSubTab: React.FC<DiscountsSubTabProps> = ({ onCreateClick }) => {
  const [coupons, setCoupons] = useState<StripeCoupon[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  
  const [newCoupon, setNewCoupon] = useState({
    id: '',
    name: '',
    discountType: 'percent' as 'percent' | 'amount',
    percentOff: 10,
    amountOffCents: 500,
    duration: 'forever' as 'once' | 'repeating' | 'forever',
    durationInMonths: 3,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchCoupons = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/coupons', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch coupons');
      const data = await res.json();
      setCoupons(data.coupons || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load coupons');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCoupons();
  }, []);

  const handleCreate = async () => {
    setFormError(null);
    setIsSaving(true);
    
    try {
      const payload: any = {
        duration: newCoupon.duration,
        name: newCoupon.name || undefined,
      };
      
      if (newCoupon.id.trim()) {
        payload.id = newCoupon.id.trim().toUpperCase().replace(/\s+/g, '_');
      }
      
      if (newCoupon.discountType === 'percent') {
        payload.percentOff = newCoupon.percentOff;
      } else {
        payload.amountOffCents = newCoupon.amountOffCents;
      }
      
      if (newCoupon.duration === 'repeating') {
        payload.durationInMonths = newCoupon.durationInMonths;
      }
      
      const res = await fetch('/api/stripe/coupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create coupon');
      
      await fetchCoupons();
      setIsCreating(false);
      setNewCoupon({
        id: '',
        name: '',
        discountType: 'percent',
        percentOff: 10,
        amountOffCents: 500,
        duration: 'forever',
        durationInMonths: 3,
      });
    } catch (err: any) {
      setFormError(err.message || 'Failed to create coupon');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (couponId: string) => {
    setIsDeleting(couponId);
    try {
      const res = await fetch(`/api/stripe/coupons/${encodeURIComponent(couponId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete coupon');
      }
      
      await fetchCoupons();
      setDeleteConfirmId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to delete coupon');
    } finally {
      setIsDeleting(null);
    }
  };

  const openCreateModal = () => {
    setFormError(null);
    setIsCreating(true);
    if (onCreateClick) onCreateClick();
  };

  const getDurationLabel = (coupon: StripeCoupon) => {
    switch (coupon.duration) {
      case 'once': return 'One-time';
      case 'repeating': return `${coupon.durationInMonths} months`;
      case 'forever': return 'Forever';
      default: return coupon.duration;
    }
  };

  const getDiscountLabel = (coupon: StripeCoupon) => {
    if (coupon.percentOff) {
      return `${coupon.percentOff}% off`;
    }
    if (coupon.amountOff) {
      return `$${coupon.amountOff.toFixed(2)} off`;
    }
    return 'Unknown discount';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span aria-hidden="true" className="material-symbols-outlined animate-spin text-4xl text-primary/70">progress_activity</span>
      </div>
    );
  }

  if (error && coupons.length === 0) {
    return (
      <div className="text-center py-12 px-6 rounded-2xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-900/10">
        <span aria-hidden="true" className="material-symbols-outlined text-5xl mb-4 text-red-500">error</span>
        <h3 className="text-lg font-bold mb-2 text-red-700 dark:text-red-400">Error Loading Coupons</h3>
        <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
        <button 
          onClick={fetchCoupons}
          className="mt-4 px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800/40 transition-colors"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {coupons.length} Stripe coupon{coupons.length !== 1 ? 's' : ''}
          </p>
          {error && (
            <p className="text-xs text-red-500 mt-1">{error}</p>
          )}
        </div>
        <button
          onClick={openCreateModal}
          data-create-coupon-btn
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-lg">add</span>
          Create Coupon
        </button>
      </div>

      {coupons.length === 0 ? (
        <div className="text-center py-12 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
          <span aria-hidden="true" className="material-symbols-outlined text-5xl mb-4 text-gray-500 dark:text-white/20">percent</span>
          <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">No Coupons Found</h3>
          <p className="text-sm text-gray-500 dark:text-white/70 max-w-xs mx-auto mb-4">
            Create your first Stripe coupon to offer discounts on memberships and purchases.
          </p>
          <button 
            onClick={openCreateModal}
            data-create-coupon-btn
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
          >
            Create Your First Coupon
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {coupons.map((coupon, index) => (
            <div 
              key={coupon.id} 
              className={`p-4 rounded-xl border transition-all animate-pop-in ${
                coupon.valid 
                  ? 'bg-white dark:bg-surface-dark border-gray-200 dark:border-white/20' 
                  : 'bg-gray-50 dark:bg-surface-dark/50 border-gray-200 dark:border-white/10 opacity-60'
              }`}
              style={{animationDelay: `${0.05 + index * 0.03}s`}}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <h4 className="font-bold text-lg text-primary dark:text-white">{coupon.name || coupon.id}</h4>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                      coupon.percentOff 
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' 
                        : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    }`}>
                      {getDiscountLabel(coupon)}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">
                      {getDurationLabel(coupon)}
                    </span>
                    {!coupon.valid && (
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 rounded">
                        Inactive
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
                    <span className="font-mono text-xs bg-gray-100 dark:bg-black/30 px-2 py-1 rounded">{coupon.id}</span>
                    {coupon.timesRedeemed > 0 && (
                      <span className="flex items-center gap-1">
                        <span aria-hidden="true" className="material-symbols-outlined text-sm">redeem</span>
                        {coupon.timesRedeemed} redeemed
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  {deleteConfirmId === coupon.id ? (
                    <>
                      <button
                        onClick={() => handleDelete(coupon.id)}
                        disabled={isDeleting === coupon.id}
                        className="px-3 py-1.5 bg-red-500 text-white text-sm rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
                      >
                        {isDeleting === coupon.id ? 'Deleting...' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(null)}
                        className="px-3 py-1.5 bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-white text-sm rounded-lg hover:bg-gray-300 dark:hover:bg-white/20 transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirmId(coupon.id)}
                      className="p-2 text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title="Delete coupon"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ModalShell 
        isOpen={isCreating} 
        onClose={() => setIsCreating(false)} 
        title="Create New Coupon"
        size="md"
      >
        <div className="p-6 space-y-6">
          {formError && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm">
              {formError}
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Coupon ID (Optional)</label>
            <input
              type="text"
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
              value={newCoupon.id}
              onChange={e => setNewCoupon({ ...newCoupon, id: e.target.value })}
              placeholder="Auto-generate if blank (e.g., SUMMER20)"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Name / Description</label>
            <input
              type="text"
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
              value={newCoupon.name}
              onChange={e => setNewCoupon({ ...newCoupon, name: e.target.value })}
              placeholder="e.g., Summer Sale 20% Off"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-2 block">Discount Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNewCoupon({ ...newCoupon, discountType: 'percent' })}
                className={`flex-1 px-4 py-3 rounded-xl border-2 transition-all ${
                  newCoupon.discountType === 'percent'
                    ? 'border-primary bg-primary/10 text-primary dark:text-white'
                    : 'border-gray-200 dark:border-white/20 text-gray-600 dark:text-gray-400'
                }`}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-xl mb-1">percent</span>
                <p className="font-medium">Percent Off</p>
              </button>
              <button
                type="button"
                onClick={() => setNewCoupon({ ...newCoupon, discountType: 'amount' })}
                className={`flex-1 px-4 py-3 rounded-xl border-2 transition-all ${
                  newCoupon.discountType === 'amount'
                    ? 'border-primary bg-primary/10 text-primary dark:text-white'
                    : 'border-gray-200 dark:border-white/20 text-gray-600 dark:text-gray-400'
                }`}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-xl mb-1">payments</span>
                <p className="font-medium">Fixed Amount</p>
              </button>
            </div>
          </div>

          {newCoupon.discountType === 'percent' ? (
            <div>
              <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Percent Off (%)</label>
              <input
                type="number"
                min="1"
                max="100"
                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                value={newCoupon.percentOff}
                onChange={e => setNewCoupon({ ...newCoupon, percentOff: Math.min(100, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
            </div>
          ) : (
            <div>
              <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Amount Off ($)</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                value={(newCoupon.amountOffCents / 100).toFixed(2)}
                onChange={e => setNewCoupon({ ...newCoupon, amountOffCents: Math.round(parseFloat(e.target.value) * 100) || 0 })}
              />
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-2 block">Duration</label>
            <div className="grid grid-cols-3 gap-2">
              {(['once', 'repeating', 'forever'] as const).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setNewCoupon({ ...newCoupon, duration: d })}
                  className={`px-3 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
                    newCoupon.duration === d
                      ? 'border-primary bg-primary/10 text-primary dark:text-white'
                      : 'border-gray-200 dark:border-white/20 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {d === 'once' ? 'One-time' : d === 'repeating' ? 'Repeating' : 'Forever'}
                </button>
              ))}
            </div>
          </div>

          {newCoupon.duration === 'repeating' && (
            <div>
              <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Duration (Months)</label>
              <input
                type="number"
                min="1"
                max="24"
                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                value={newCoupon.durationInMonths}
                onChange={e => setNewCoupon({ ...newCoupon, durationInMonths: Math.min(24, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
            </div>
          )}

          <div className="flex gap-3 justify-end pt-4 border-t border-gray-200 dark:border-white/25">
            <button 
              onClick={() => setIsCreating(false)} 
              className="px-5 py-2.5 text-gray-500 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={handleCreate} 
              disabled={isSaving}
              className="px-6 py-2.5 bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSaving && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
              {isSaving ? 'Creating...' : 'Create Coupon'}
            </button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
};

export default DiscountsSubTab;

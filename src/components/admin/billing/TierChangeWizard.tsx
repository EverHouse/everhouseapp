import React, { useState, useEffect } from 'react';
import { ModalShell } from '../../ModalShell';
import { useTheme } from '../../../contexts/ThemeContext';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../../utils/errorHandling';

interface Tier {
  id: number;
  name: string;
  slug: string;
  priceCents: number;
  stripePriceId: string;
  billingInterval: string;
}

interface TierChangePreview {
  currentTier: string;
  newTier: string;
  prorationAmountCents: number;
  nextInvoiceAmountCents: number;
  effectiveDate: string;
  isImmediate: boolean;
}

interface TierChangeWizardProps {
  isOpen: boolean;
  onClose: () => void;
  memberEmail: string;
  subscriptionId: string;
  currentTierName: string;
  currentPriceId?: string;
  onSuccess: () => void;
}

export function TierChangeWizard({ isOpen, onClose, memberEmail, subscriptionId, currentTierName, onSuccess }: TierChangeWizardProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [selectedPriceId, setSelectedPriceId] = useState<string>('');
  const [immediate, setImmediate] = useState(true);
  const [preview, setPreview] = useState<TierChangePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedPriceId('');
      setPreview(null);
      setError(null);
      fetch('/api/admin/tier-change/tiers', { credentials: 'include' })
        .then(r => {
          if (!r.ok) {
            setError(getApiErrorMessage(r, 'load tiers'));
            return;
          }
          return r.json();
        })
        .then(data => {
          if (data && data.tiers) {
            setTiers(data.tiers);
          }
        })
        .catch(() => setError(getNetworkErrorMessage()));
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedPriceId && subscriptionId) {
      setPreviewLoading(true);
      setError(null);
      fetch('/api/admin/tier-change/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ subscriptionId, newPriceId: selectedPriceId, immediate })
      })
        .then(r => {
          if (!r.ok) {
            setError(getApiErrorMessage(r, 'preview'));
            return;
          }
          return r.json();
        })
        .then(data => {
          if (data && data.preview) {
            setPreview(data.preview);
          } else if (data && data.error) {
            setError(data.error);
          }
        })
        .catch(() => setError(getNetworkErrorMessage()))
        .finally(() => setPreviewLoading(false));
    } else {
      setPreview(null);
    }
  }, [selectedPriceId, immediate, subscriptionId]);

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tier-change/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail, subscriptionId, newPriceId: selectedPriceId, immediate })
      });
      if (!res.ok) {
        setError(getApiErrorMessage(res, 'change tier'));
        return;
      }
      const data = await res.json();
      if (data.success) {
        onSuccess();
        onClose();
      } else {
        setError(data.error || 'Failed to change tier');
      }
    } catch {
      setError(getNetworkErrorMessage());
    } finally {
      setLoading(false);
    }
  };

  const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Change Membership Tier" size="md">
      <div className="p-4 space-y-4">
        {error && (
          <div className={`p-3 rounded-lg flex items-center gap-2 ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
            <span className="material-symbols-outlined text-red-500 text-base">error</span>
            <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>
          </div>
        )}
        
        <div>
          <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Current Tier</p>
          <p className={`font-medium ${isDark ? 'text-white' : 'text-primary'}`}>{currentTierName}</p>
        </div>
        
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>New Tier</label>
          <select
            value={selectedPriceId}
            onChange={(e) => setSelectedPriceId(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg border text-sm ${
              isDark
                ? 'bg-black/30 border-white/20 text-white'
                : 'bg-white border-gray-200 text-primary'
            }`}
          >
            <option value="">Select a tier...</option>
            {tiers.map(t => (
              <option key={t.id} value={t.stripePriceId}>
                {t.name} - {formatCents(t.priceCents)}/{t.billingInterval}
              </option>
            ))}
          </select>
        </div>
        
        <div className="space-y-2">
          <p className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Apply Change</p>
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            <label className={`flex items-center gap-2 cursor-pointer text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
              <input
                type="radio"
                name="timing"
                checked={immediate}
                onChange={() => setImmediate(true)}
                className="w-4 h-4"
              />
              <span>Immediately (with proration)</span>
            </label>
            <label className={`flex items-center gap-2 cursor-pointer text-sm ${isDark ? 'text-white' : 'text-primary'}`}>
              <input
                type="radio"
                name="timing"
                checked={!immediate}
                onChange={() => setImmediate(false)}
                className="w-4 h-4"
              />
              <span>At next billing cycle</span>
            </label>
          </div>
        </div>
        
        {previewLoading && (
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Loading preview...</span>
          </div>
        )}
        
        {preview && !previewLoading && (
          <div className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <h4 className={`font-medium mb-2 text-sm ${isDark ? 'text-white' : 'text-primary'}`}>Preview</h4>
            <div className="text-sm space-y-1">
              <div className="flex items-center gap-2">
                <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>{preview.currentTier}</span>
                <span className="material-symbols-outlined text-base">arrow_forward</span>
                <span className={isDark ? 'text-white' : 'text-primary'}>{preview.newTier}</span>
              </div>
              {immediate && preview.prorationAmountCents !== 0 && (
                <p className={preview.prorationAmountCents > 0 ? 'text-amber-500' : 'text-green-500'}>
                  {preview.prorationAmountCents > 0 ? 'Charge' : 'Credit'}: {formatCents(Math.abs(preview.prorationAmountCents))}
                </p>
              )}
              <p className={isDark ? 'text-gray-300' : 'text-gray-700'}>
                Next invoice: {formatCents(preview.nextInvoiceAmountCents)}
              </p>
              <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Effective: {preview.effectiveDate && new Date(preview.effectiveDate).getFullYear() > 1970 
                  ? new Date(preview.effectiveDate).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }) 
                  : immediate ? 'Today' : 'Next billing cycle'}
              </p>
            </div>
          </div>
        )}
        
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors tactile-btn ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedPriceId || loading}
            className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors tactile-btn"
          >
            {loading ? 'Changing...' : 'Confirm Change'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export default TierChangeWizard;

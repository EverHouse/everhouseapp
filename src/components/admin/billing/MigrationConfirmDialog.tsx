import React, { useState } from 'react';
import { ModalShell } from '../../ModalShell';

interface MigrationConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (billingStartDate: string) => void;
  memberEmail: string;
  memberName?: string;
  currentTier?: string;
  cardOnFile?: { brand?: string; last4?: string } | null;
  isDark: boolean;
  isLoading: boolean;
}

export const MigrationConfirmDialog: React.FC<MigrationConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  memberEmail,
  memberName,
  currentTier,
  cardOnFile,
  isDark,
  isLoading,
}) => {
  const defaultDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [confirmedMindBodyCancelled, setConfirmedMindBodyCancelled] = useState(false);
  const [billingStartDate, setBillingStartDate] = useState(defaultDate);

  const canConfirm = confirmedMindBodyCancelled && billingStartDate && !isLoading;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(billingStartDate);
  };

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Migrate to Stripe Billing" size="sm">
      <div className="p-4 space-y-4">
        <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'}`}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className={`material-symbols-outlined text-base ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>person</span>
              <span className={`text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {memberName || memberEmail}
              </span>
            </div>
            {currentTier && (
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined text-base ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>badge</span>
                <span className={`text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {currentTier}
                </span>
              </div>
            )}
            {cardOnFile && (
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined text-base ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>credit_card</span>
                <span className={`text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {cardOnFile.brand?.toUpperCase()} •••• {cardOnFile.last4}
                </span>
              </div>
            )}
          </div>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmedMindBodyCancelled}
            onChange={(e) => setConfirmedMindBodyCancelled(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
          />
          <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            I have cancelled (or will cancel) this member's MindBody subscription
          </span>
        </label>

        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            When should Stripe billing start?
          </label>
          <input
            type="date"
            value={billingStartDate}
            onChange={(e) => setBillingStartDate(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg border text-sm ${
              isDark
                ? 'bg-black/30 border-white/20 text-white'
                : 'bg-white border-gray-200 text-primary'
            }`}
          />
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Defaults to 30 days from today
          </p>
        </div>

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
            disabled={!canConfirm}
            className="flex-1 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity tactile-btn"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                Migrating...
              </span>
            ) : (
              'Confirm Migration'
            )}
          </button>
        </div>
      </div>
    </ModalShell>
  );
};

export default MigrationConfirmDialog;

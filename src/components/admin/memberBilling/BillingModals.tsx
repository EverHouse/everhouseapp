import React, { useState } from 'react';
import { ModalShell } from '../../ModalShell';

export function ApplyCreditModal({
  isOpen,
  onClose,
  onApply,
  isLoading,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  onApply: (amountCents: number, description: string) => void;
  isLoading: boolean;
  isDark: boolean;
}) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = () => {
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) return;
    onApply(amountCents, description || 'Staff applied credit');
  };

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Apply Credit" size="sm">
      <div className="p-4 space-y-4">
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Credit Amount ($)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className={`w-full px-3 py-2 rounded-lg border text-sm ${
              isDark
                ? 'bg-black/30 border-white/20 text-white placeholder:text-gray-500'
                : 'bg-white border-gray-200 text-primary placeholder:text-gray-400'
            }`}
          />
        </div>
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Reason for credit"
            className={`w-full px-3 py-2 rounded-lg border text-sm ${
              isDark
                ? 'bg-black/30 border-white/20 text-white placeholder:text-gray-500'
                : 'bg-white border-gray-200 text-primary placeholder:text-gray-400'
            }`}
          />
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
            onClick={handleSubmit}
            disabled={isLoading || !amount || parseFloat(amount) <= 0}
            className="flex-1 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity tactile-btn"
          >
            {isLoading ? 'Applying...' : 'Apply Credit'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ApplyDiscountModal({
  isOpen,
  onClose,
  onApply,
  isLoading,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  onApply: (percentOff: number, duration: string) => void;
  isLoading: boolean;
  isDark: boolean;
}) {
  const [percentOff, setPercentOff] = useState('');
  const [duration, setDuration] = useState('once');

  const handleSubmit = () => {
    const percent = parseFloat(percentOff);
    if (isNaN(percent) || percent <= 0 || percent > 100) return;
    onApply(percent, duration);
  };

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Apply Discount" size="sm">
      <div className="p-4 space-y-4">
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Discount Percentage
          </label>
          <input
            type="number"
            min="1"
            max="100"
            value={percentOff}
            onChange={(e) => setPercentOff(e.target.value)}
            placeholder="10"
            className={`w-full px-3 py-2 rounded-lg border text-sm ${
              isDark
                ? 'bg-black/30 border-white/20 text-white placeholder:text-gray-500'
                : 'bg-white border-gray-200 text-primary placeholder:text-gray-400'
            }`}
          />
        </div>
        <div>
          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Duration
          </label>
          <select
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg border text-sm ${
              isDark
                ? 'bg-black/30 border-white/20 text-white'
                : 'bg-white border-gray-200 text-primary'
            }`}
          >
            <option value="once">Once (next invoice only)</option>
            <option value="forever">Forever</option>
          </select>
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
            onClick={handleSubmit}
            disabled={isLoading || !percentOff || parseFloat(percentOff) <= 0}
            className="flex-1 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity tactile-btn"
          >
            {isLoading ? 'Applying...' : 'Apply Discount'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ConfirmCancelModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  isDark: boolean;
}) {
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Cancel Subscription" size="sm">
      <div className="p-4 space-y-4">
        <div className={`p-4 rounded-lg ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-red-500 text-xl">warning</span>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                Are you sure you want to cancel this subscription?
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-red-400/80' : 'text-red-500'}`}>
                The subscription will remain active until the end of the current billing period.
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors tactile-btn ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Keep Subscription
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 px-4 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors tactile-btn"
          >
            {isLoading ? 'Canceling...' : 'Cancel Subscription'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ConfirmResumeModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  isDark: boolean;
}) {
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Resume Subscription" size="sm">
      <div className="p-4 space-y-4">
        <div className={`p-4 rounded-lg ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-green-500 text-xl">play_circle</span>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                Resume this member's subscription?
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-green-400/80' : 'text-green-600'}`}>
                Billing will restart immediately and the member will be charged on their next billing date.
              </p>
            </div>
          </div>
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
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 px-4 py-2.5 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 transition-colors tactile-btn"
          >
            {isLoading ? 'Resuming...' : 'Resume Subscription'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ConfirmBillingSourceModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  isDark,
  currentSource,
  newSource,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  isDark: boolean;
  currentSource: string;
  newSource: string;
}) {
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Change Billing Source" size="sm">
      <div className="p-4 space-y-4">
        <div className={`p-4 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-amber-500 text-xl">swap_horiz</span>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                Change billing source from <strong>{currentSource || 'None'}</strong> to <strong>{newSource || 'None'}</strong>?
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-amber-400/80' : 'text-amber-600'}`}>
                This changes how the member's subscription is managed and may affect their billing status and sync behavior.
              </p>
            </div>
          </div>
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
            onClick={onConfirm}
            disabled={isLoading}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 tactile-btn ${
              isDark ? 'bg-amber-500 text-black hover:bg-amber-400' : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            {isLoading ? 'Updating...' : 'Confirm Change'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function PauseDurationModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (durationDays: 30 | 60) => void;
  isLoading: boolean;
  isDark: boolean;
}) {
  const [selectedDuration, setSelectedDuration] = useState<30 | 60>(30);

  const getResumeDate = (days: number) => {
    const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  };

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Pause Subscription" size="sm">
      <div className="p-4 space-y-4">
        <div className={`p-4 rounded-lg ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-yellow-500 text-xl">pause_circle</span>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-700'}`}>
                Choose pause duration
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-yellow-400/80' : 'text-yellow-600'}`}>
                Billing will automatically resume after the selected period.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <button
            onClick={() => setSelectedDuration(30)}
            className={`w-full p-3 rounded-lg border text-left transition-colors ${
              selectedDuration === 30
                ? isDark
                  ? 'bg-accent/20 border-accent text-white'
                  : 'bg-primary/10 border-primary text-primary'
                : isDark
                  ? 'bg-white/5 border-white/10 text-white hover:bg-white/10'
                  : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">30 Days</p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Resumes on {getResumeDate(30)}
                </p>
              </div>
              {selectedDuration === 30 && (
                <span className="material-symbols-outlined text-accent-dark dark:text-accent">check_circle</span>
              )}
            </div>
          </button>

          <button
            onClick={() => setSelectedDuration(60)}
            className={`w-full p-3 rounded-lg border text-left transition-colors ${
              selectedDuration === 60
                ? isDark
                  ? 'bg-accent/20 border-accent text-white'
                  : 'bg-primary/10 border-primary text-primary'
                : isDark
                  ? 'bg-white/5 border-white/10 text-white hover:bg-white/10'
                  : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">60 Days</p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Resumes on {getResumeDate(60)}
                </p>
              </div>
              {selectedDuration === 60 && (
                <span className="material-symbols-outlined text-accent-dark dark:text-accent">check_circle</span>
              )}
            </div>
          </button>
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
            onClick={() => onConfirm(selectedDuration)}
            disabled={isLoading}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 tactile-btn ${
              isDark ? 'bg-yellow-500 text-black hover:bg-yellow-400' : 'bg-yellow-500 text-white hover:bg-yellow-600'
            }`}
          >
            {isLoading ? 'Pausing...' : `Pause for ${selectedDuration} Days`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

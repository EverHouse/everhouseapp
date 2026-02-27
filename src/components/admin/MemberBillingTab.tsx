import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { ModalShell } from '../ModalShell';
import { StripeBillingSection } from './billing/StripeBillingSection';
import { MindbodyBillingSection } from './billing/MindbodyBillingSection';
import { MigrationConfirmDialog } from './billing/MigrationConfirmDialog';
import { FamilyAddonBillingSection } from './billing/FamilyAddonBillingSection';
import { CompedBillingSection } from './billing/CompedBillingSection';
import { TierChangeWizard } from './billing/TierChangeWizard';
import { TIER_NAMES } from '../../../shared/constants/tiers';
import GroupBillingManager from './GroupBillingManager';
import { getApiErrorMessage, getNetworkErrorMessage, extractApiError } from '../../utils/errorHandling';
import { TerminalPayment } from '../staff-command-center/TerminalPayment';

interface GuestHistoryItem {
  id: number;
  guestName: string | null;
  guestEmail: string | null;
  visitDate: string;
  startTime: string;
  resourceName: string | null;
}

interface GuestCheckInItem {
  id: number;
  guestName: string | null;
  checkInDate: string;
}

interface MemberBillingTabProps {
  memberEmail: string;
  memberId?: string;
  currentTier?: string;
  onTierUpdate?: (tier: string) => void;
  guestPassInfo?: { remainingPasses: number; totalUsed: number } | null;
  guestHistory?: GuestHistoryItem[];
  guestCheckInsHistory?: GuestCheckInItem[];
  purchases?: Array<{ id: number | string; category?: string; description?: string; amount?: number; date?: string; created_at?: string; product_name?: string; quantity?: number; status?: string }>;
}

interface Subscription {
  id: string;
  status: string;
  planName?: string;
  planAmount?: number;
  currency?: string;
  interval?: string;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  isPaused?: boolean;
  pausedUntil?: string | null;
  discount?: {
    id: string;
    coupon: {
      id: string;
      name?: string;
      percentOff?: number;
      amountOff?: number;
    };
  } | null;
}

interface PaymentMethod {
  id: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

interface Invoice {
  id: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
}

interface FamilyGroup {
  id: number;
  primaryEmail: string;
  primaryName?: string;
  groupName?: string;
  members?: {
    id: number;
    memberEmail: string;
    memberName: string;
    addOnPriceCents: number;
  }[];
}

interface BillingInfo {
  email: string;
  firstName?: string;
  lastName?: string;
  billingProvider: 'stripe' | 'mindbody' | 'family_addon' | 'comped' | null;
  stripeCustomerId?: string;
  mindbodyClientId?: string;
  hubspotId?: string;
  tier?: string;
  subscriptions?: Subscription[];
  activeSubscription?: Subscription | null;
  paymentMethods?: PaymentMethod[];
  recentInvoices?: Invoice[];
  customerBalance?: number;
  familyGroup?: FamilyGroup | null;
  stripeError?: string;
  familyError?: string;
  billingMigrationRequestedAt?: string;
  migrationStatus?: string | null;
  migrationBillingStartDate?: string | null;
  migrationRequestedBy?: string | null;
  migrationTierSnapshot?: string | null;
}

const BILLING_PROVIDERS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'mindbody', label: 'Mindbody' },
  { value: 'family_addon', label: 'Family Add-on' },
  { value: 'comped', label: 'Comped' },
];

function ApplyCreditModal({
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

function ApplyDiscountModal({
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

function ConfirmCancelModal({
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

function PauseDurationModal({
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
                <span className="material-symbols-outlined text-accent">check_circle</span>
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
                <span className="material-symbols-outlined text-accent">check_circle</span>
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

const formatDatePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const normalizedDate = dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`;
    const d = new Date(normalizedDate);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr || '';
  }
};

const formatTime12Hour = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
};

const MemberBillingTab: React.FC<MemberBillingTabProps> = ({ 
  memberEmail, 
  memberId, 
  currentTier, 
  onTierUpdate,
  guestPassInfo,
  guestHistory = [],
  guestCheckInsHistory = [],
  purchases = []
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [isEditingTier, setIsEditingTier] = useState(false);
  const [manualTier, setManualTier] = useState('');
  const [isSavingTier, setIsSavingTier] = useState(false);
  const VALID_TIERS = [...TIER_NAMES];

  const [isUpdatingSource, setIsUpdatingSource] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [isApplyingCredit, setIsApplyingCredit] = useState(false);
  const [isApplyingDiscount, setIsApplyingDiscount] = useState(false);
  const [isGettingPaymentLink, setIsGettingPaymentLink] = useState(false);
  const [isOpeningBillingPortal, setIsOpeningBillingPortal] = useState(false);
  const [isSyncingToStripe, setIsSyncingToStripe] = useState(false);
  const [isSyncingStripeData, setIsSyncingStripeData] = useState(false);

  const [showCreditModal, setShowCreditModal] = useState(false);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [showTierChangeModal, setShowTierChangeModal] = useState(false);
  const [showCreateSubscriptionModal, setShowCreateSubscriptionModal] = useState(false);
  const [isCreatingSubscription, setIsCreatingSubscription] = useState(false);
  const [selectedSubscriptionTier, setSelectedSubscriptionTier] = useState('');
  const [selectedCoupon, setSelectedCoupon] = useState('');
  const [availableCoupons, setAvailableCoupons] = useState<Array<{
    id: string;
    name: string;
    percentOff: number | null;
    amountOff: number | null;
    duration: string;
  }>>([]);
  const [isLoadingCoupons, setIsLoadingCoupons] = useState(false);

  const [isSendingActivation, setIsSendingActivation] = useState(false);

  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [isMigrationLoading, setIsMigrationLoading] = useState(false);
  const [migrationEligibility, setMigrationEligibility] = useState<{ hasCardOnFile: boolean; tierHasStripePrice: boolean; cardOnFile?: { brand?: string; last4?: string } | null }>({ hasCardOnFile: false, tierHasStripePrice: true, cardOnFile: null });

  const [showUpdateCardTerminal, setShowUpdateCardTerminal] = useState(false);
  const [showCollectPayment, setShowCollectPayment] = useState(false);
  const [collectPaymentAmount, setCollectPaymentAmount] = useState(0);
  const [collectPaymentError, setCollectPaymentError] = useState<string | null>(null);
  const [collectPaymentMode, setCollectPaymentMode] = useState<'terminal' | 'charge_card'>('terminal');
  const [isChargingCard, setIsChargingCard] = useState(false);

  const [outstandingData, setOutstandingData] = useState<{
    totalOutstandingCents: number;
    totalOutstandingDollars: number;
    items: Array<{
      bookingId: number;
      trackmanBookingId: string | null;
      bookingDate: string;
      startTime: string;
      endTime: string;
      resourceName: string;
      participantId: number;
      participantType: string;
      displayName: string;
      feeCents: number;
      feeDollars: number;
      feeLabel: string;
    }>;
  } | null>(null);

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    console.log('[MemberBilling] Success:', message);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const fetchBillingInfo = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setBillingInfo(data);
      } else {
        setError(await extractApiError(res, 'load billing info'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsLoading(false);
    }
  }, [memberEmail]);

  const fetchOutstandingBalance = useCallback(async () => {
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/outstanding`, {
        credentials: 'include',
      });
      if (res.ok) {
        setOutstandingData(await res.json());
      }
    } catch (err: unknown) {
      console.error('[MemberBilling] Error fetching outstanding:', err);
    }
  }, [memberEmail]);

  useEffect(() => {
    fetchBillingInfo();
    fetchOutstandingBalance();
  }, [fetchBillingInfo, fetchOutstandingBalance]);

  // Listen for WebSocket billing updates and auto-refresh when this member's billing changes
  useEffect(() => {
    const handleBillingUpdate = (event: CustomEvent<{
      action: string;
      memberEmail?: string;
      customerId?: string;
    }>) => {
      const detail = event.detail;
      // Check if this update is for the currently viewed member
      if (detail.memberEmail?.toLowerCase() === memberEmail.toLowerCase() ||
          (billingInfo?.stripeCustomerId && detail.customerId === billingInfo.stripeCustomerId)) {
        console.log('[MemberBillingTab] Received billing update for this member, refreshing:', detail.action);
        fetchBillingInfo();
      }
    };

    window.addEventListener('billing-update', handleBillingUpdate as EventListener);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate as EventListener);
    };
  }, [memberEmail, billingInfo?.stripeCustomerId, fetchBillingInfo]);

  useEffect(() => {
    if (billingInfo?.billingProvider === 'mindbody') {
      const fetchMigrationStatus = async () => {
        try {
          const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/migration-status`, {
            credentials: 'include',
          });
          if (res.ok) {
            const data = await res.json();
            setMigrationEligibility({
              hasCardOnFile: data.hasCardOnFile || false,
              tierHasStripePrice: data.tierHasStripePrice || false,
              cardOnFile: data.cardOnFile || null,
            });
          }
        } catch (err: unknown) {
          console.error('[MemberBilling] Error fetching migration status:', err);
        }
      };
      fetchMigrationStatus();
    }
  }, [billingInfo?.billingProvider, memberEmail]);

  const handleInitiateMigration = async (billingStartDate: string) => {
    setIsMigrationLoading(true);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/migrate-to-stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ billingStartDate, confirmedMindBodyCancelled: true }),
      });
      if (res.ok) {
        setShowMigrationDialog(false);
        fetchBillingInfo();
        showSuccess('Migration initiated successfully');
      } else {
        setError(await extractApiError(res, 'initiate migration'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsMigrationLoading(false);
    }
  };

  const handleCancelMigration = async () => {
    setIsMigrationLoading(true);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/cancel-migration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (res.ok) {
        fetchBillingInfo();
        showSuccess('Migration cancelled');
      } else {
        setError(await extractApiError(res, 'cancel migration'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsMigrationLoading(false);
    }
  };

  const handleManualTierSave = async () => {
    if (!memberEmail) return;
    
    setIsSavingTier(true);
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(memberEmail)}/tier`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tier: manualTier })
      });
      
      if (!res.ok) {
        setError(await extractApiError(res, 'update tier'));
      } else {
        setIsEditingTier(false);
        if (onTierUpdate) onTierUpdate(manualTier);
        fetchBillingInfo();
        showSuccess('Membership level updated');
      }
    } catch (err: unknown) {
      console.error('Error updating tier:', err);
      setError(getNetworkErrorMessage());
    } finally {
      setIsSavingTier(false);
    }
  };

  const handleUpdateBillingSource = async (newSource: string) => {
    setIsUpdatingSource(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ billingProvider: newSource || null }),
      });
      if (res.ok) {
        await fetchBillingInfo();
        showSuccess('Billing source updated');
      } else {
        setError(getApiErrorMessage(res, 'update billing source'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsUpdatingSource(false);
    }
  };

  const handlePauseSubscription = async (durationDays: 30 | 60) => {
    setIsPausing(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ durationDays }),
      });
      if (res.ok) {
        const data = await res.json();
        await fetchBillingInfo();
        setShowPauseModal(false);
        const resumeDate = new Date(data.resumeDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
        showSuccess(`Subscription paused for ${durationDays} days. Billing resumes on ${resumeDate}.`);
      } else {
        setError(getApiErrorMessage(res, 'pause subscription'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsPausing(false);
    }
  };

  const handleResumeSubscription = async () => {
    setIsResuming(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/resume`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        await fetchBillingInfo();
        showSuccess('Subscription resumed');
      } else {
        setError(getApiErrorMessage(res, 'resume subscription'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsResuming(false);
    }
  };

  const handleCancelSubscription = async () => {
    setIsCanceling(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/cancel`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        await fetchBillingInfo();
        setShowCancelModal(false);
        showSuccess('Subscription will be canceled at period end');
      } else {
        setError(getApiErrorMessage(res, 'cancel subscription'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsCanceling(false);
    }
  };

  const handleApplyCredit = async (amountCents: number, description: string) => {
    setIsApplyingCredit(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amountCents, description }),
      });
      if (res.ok) {
        await fetchBillingInfo();
        setShowCreditModal(false);
        showSuccess(`Credit of $${(amountCents / 100).toFixed(2)} applied`);
      } else {
        setError(getApiErrorMessage(res, 'apply credit'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsApplyingCredit(false);
    }
  };

  const handleApplyDiscount = async (percentOff: number, duration: string) => {
    setIsApplyingDiscount(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/discount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ percentOff, duration }),
      });
      if (res.ok) {
        await fetchBillingInfo();
        setShowDiscountModal(false);
        showSuccess(`${percentOff}% discount applied`);
      } else {
        setError(getApiErrorMessage(res, 'apply discount'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsApplyingDiscount(false);
    }
  };

  const handleGetPaymentLink = async () => {
    setIsGettingPaymentLink(true);
    setError(null);
    const linkWindow = window.open('about:blank', '_blank');
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/payment-link`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          if (linkWindow) {
            linkWindow.location.href = data.url;
          } else {
            window.location.href = data.url;
          }
        } else {
          linkWindow?.close();
          setError('No payment link URL returned');
        }
      } else {
        linkWindow?.close();
        setError(getApiErrorMessage(res, 'get payment link'));
      }
    } catch (err: unknown) {
      linkWindow?.close();
      setError(getNetworkErrorMessage());
    } finally {
      setIsGettingPaymentLink(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setIsOpeningBillingPortal(true);
    setError(null);
    const portalWindow = window.open('about:blank', '_blank');
    try {
      const res = await fetch('/api/my/billing/portal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: memberEmail }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          if (portalWindow) {
            portalWindow.location.href = data.url;
          } else {
            window.location.href = data.url;
          }
        } else {
          portalWindow?.close();
          setError('No billing portal URL returned');
        }
      } else {
        portalWindow?.close();
        setError(getApiErrorMessage(res, 'open billing portal'));
      }
    } catch (err: unknown) {
      portalWindow?.close();
      setError(getNetworkErrorMessage());
    } finally {
      setIsOpeningBillingPortal(false);
    }
  };

  const handleSendActivationEmail = async () => {
    if (!memberEmail) return;
    setIsSendingActivation(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/staff/send-reactivation-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to send activation email');
      } else {
        showSuccess('Activation email sent!');
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsSendingActivation(false);
    }
  };

  const handleCopyActivationLink = async () => {
    if (!memberEmail) return;
    setError(null);
    try {
      const res = await fetch('/api/my/billing/portal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: memberEmail }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          await navigator.clipboard.writeText(data.url);
          showSuccess('Activation link copied to clipboard!');
        }
      } else {
        setError(getApiErrorMessage(res, 'get activation link'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    }
  };

  const handleSyncToStripe = async () => {
    setIsSyncingToStripe(true);
    setError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-stripe`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        await fetchBillingInfo();
        showSuccess(data.created ? 'Created new Stripe customer' : 'Linked existing Stripe customer');
      } else {
        setError(getApiErrorMessage(res, 'sync to Stripe'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsSyncingToStripe(false);
    }
  };

  const handleSyncStripeData = async () => {
    setIsSyncingStripeData(true);
    setError(null);
    const results: string[] = [];
    
    try {
      // 1. Sync metadata
      try {
        const metaRes = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-metadata`, {
          method: 'POST',
          credentials: 'include',
        });
        if (metaRes.ok) {
          results.push('Metadata synced');
        }
      } catch (e: unknown) { /* continue */ }
      
      // 2. Sync tier from Stripe
      try {
        const tierRes = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-tier-from-stripe`, {
          method: 'POST',
          credentials: 'include',
        });
        if (tierRes.ok) {
          const data = await tierRes.json();
          if (data.previousTier !== data.newTier) {
            results.push(`Tier: ${data.previousTier || 'none'} → ${data.newTier}`);
          } else {
            results.push(`Tier: ${data.newTier}`);
          }
        }
      } catch (e: unknown) { /* continue */ }
      
      // 3. Backfill transaction cache
      try {
        const cacheRes = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/backfill-cache`, {
          method: 'POST',
          credentials: 'include',
        });
        if (cacheRes.ok) {
          const data = await cacheRes.json();
          results.push(`${data.transactionCount || 0} transactions cached`);
        }
      } catch (e: unknown) { /* continue */ }
      
      await fetchBillingInfo();
      
      if (results.length > 0) {
        showSuccess(`Stripe sync complete: ${results.join(', ')}`);
      } else {
        setError('Sync completed but no changes were made');
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsSyncingStripeData(false);
    }
  };

  const handleCreateSubscription = async () => {
    if (!selectedSubscriptionTier) {
      setError('Please select a membership tier');
      return;
    }
    
    setIsCreatingSubscription(true);
    setError(null);
    
    try {
      const res = await fetch('/api/stripe/subscriptions/create-for-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail,
          tierName: selectedSubscriptionTier,
          couponId: selectedCoupon || undefined
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        await fetchBillingInfo();
        setShowCreateSubscriptionModal(false);
        setSelectedSubscriptionTier('');
        setSelectedCoupon('');
        showSuccess(data.message || 'Subscription created successfully');
      } else {
        setError(getApiErrorMessage(res, 'create subscription'));
      }
    } catch (err: unknown) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsCreatingSubscription(false);
    }
  };

  if (isLoading) {
    return (
      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 text-sm">
          <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
          <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>Loading billing info...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-20">
      {error && (
        <div className={`p-3 rounded-lg flex items-center gap-2 ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
          <span className="material-symbols-outlined text-red-500 text-base">error</span>
          <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>
          <button onClick={() => setError(null)} className="ml-auto p-1 hover:opacity-70">
            <span className="material-symbols-outlined text-red-500 text-base">close</span>
          </button>
        </div>
      )}

      {successMessage && (
        <div className={`p-3 rounded-lg flex items-center gap-2 ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
          <span className="material-symbols-outlined text-green-500 text-base">check_circle</span>
          <p className={`text-sm ${isDark ? 'text-green-400' : 'text-green-600'}`}>{successMessage}</p>
        </div>
      )}

      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-purple-400' : 'text-purple-600'}`}>badge</span>
            <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Membership Level</h3>
          </div>
          {!isEditingTier && (
            <button
              onClick={() => {
                setManualTier(currentTier || billingInfo?.tier || '');
                setIsEditingTier(true);
              }}
              className={`text-xs font-medium ${isDark ? 'text-purple-400 hover:text-purple-300' : 'text-purple-600 hover:text-purple-700'}`}
            >
              Edit Level
            </button>
          )}
        </div>

        {isEditingTier ? (
          <div className="flex items-center gap-2 mt-2">
            <select
              value={manualTier}
              onChange={(e) => setManualTier(e.target.value)}
              className={`flex-1 px-3 py-2 rounded-lg border text-sm ${
                isDark 
                  ? 'bg-black/30 border-white/20 text-white' 
                  : 'bg-white border-gray-200 text-primary'
              }`}
              disabled={isSavingTier}
            >
              <option value="">No Tier</option>
              {VALID_TIERS.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button
              onClick={handleManualTierSave}
              disabled={isSavingTier}
              className="px-3 py-2 bg-brand-green text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {isSavingTier ? '...' : 'Save'}
            </button>
            <button
              onClick={() => setIsEditingTier(false)}
              disabled={isSavingTier}
              className={`px-3 py-2 rounded-lg text-sm font-medium ${
                isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
              }`}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={`text-lg font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {currentTier || billingInfo?.tier || 'No Tier Assigned'}
            </span>
            {(currentTier || billingInfo?.tier) && (
               <span className={`px-2 py-0.5 rounded text-[10px] ${isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
                 {billingInfo?.billingProvider === 'stripe' && billingInfo?.activeSubscription 
                   ? 'Billed through Stripe' 
                   : billingInfo?.billingProvider === 'mindbody' 
                     ? 'Synced from Mindbody' 
                     : 'Database Record'}
               </span>
            )}
          </div>
        )}
        <p className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          Manually updating this will give the member app permissions immediately. It does not automatically update billing in Mindbody.
        </p>
      </div>

      {/* Outstanding Balance Section */}
      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 mb-3">
          <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>receipt_long</span>
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Outstanding Booking Fees</h3>
        </div>
        
        {(() => {
          const hasIncompleteSubscription = billingInfo?.activeSubscription?.status === 'incomplete';
          const subscriptionAmountCents = billingInfo?.activeSubscription?.planAmount || 0;
          const hasBookingFees = outstandingData && outstandingData.totalOutstandingCents > 0;

          const coupon = billingInfo?.activeSubscription?.discount?.coupon;
          const pendingAmount = coupon?.percentOff
            ? Math.round(subscriptionAmountCents * (1 - coupon.percentOff / 100))
            : coupon?.amountOff
              ? Math.max(0, subscriptionAmountCents - coupon.amountOff)
              : subscriptionAmountCents;

          if (!hasBookingFees && hasIncompleteSubscription && subscriptionAmountCents > 0) {
            return (
              <div className={`flex items-center justify-between p-3 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>pending</span>
                  <span className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    Subscription payment pending
                  </span>
                </div>
                <span className={`text-lg font-bold ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                  ${(pendingAmount / 100).toFixed(2)}
                </span>
              </div>
            );
          }

          if (!hasBookingFees && !hasIncompleteSubscription) {
            return (
              <div className={`flex items-center gap-2 py-2 ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                <span className="material-symbols-outlined text-base">check_circle</span>
                <span className="text-sm">No outstanding fees</span>
              </div>
            );
          }

          return null;
        })()}
        {outstandingData && outstandingData.totalOutstandingCents > 0 && (
          <div className="space-y-3">
            {billingInfo?.activeSubscription?.status === 'incomplete' && (billingInfo?.activeSubscription?.planAmount || 0) > 0 && (() => {
              const subAmountCents = billingInfo!.activeSubscription!.planAmount || 0;
              const subCoupon = billingInfo!.activeSubscription!.discount?.coupon;
              const discountedAmount = subCoupon?.percentOff
                ? Math.round(subAmountCents * (1 - subCoupon.percentOff / 100))
                : subCoupon?.amountOff
                  ? Math.max(0, subAmountCents - subCoupon.amountOff)
                  : subAmountCents;
              return (
                <div className={`flex items-center justify-between p-3 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`material-symbols-outlined text-base ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>pending</span>
                    <span className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      Subscription payment pending
                    </span>
                  </div>
                  <span className={`text-lg font-bold ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                    ${(discountedAmount / 100).toFixed(2)}
                  </span>
                </div>
              );
            })()}
            <div className={`flex items-center justify-between p-3 rounded-lg ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
              <span className={`text-sm font-medium ${isDark ? 'text-red-400' : 'text-red-700'}`}>Total Outstanding</span>
              <span className={`text-lg font-bold ${isDark ? 'text-red-400' : 'text-red-700'}`}>
                ${outstandingData.totalOutstandingDollars.toFixed(2)}
              </span>
            </div>
            
            <div className="space-y-2">
              {outstandingData.items.map((item) => (
                <div 
                  key={item.participantId} 
                  className={`flex items-center justify-between py-2 px-3 rounded-lg text-sm ${isDark ? 'bg-white/5' : 'bg-white'}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className={`font-medium truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      #{item.trackmanBookingId || item.bookingId} · {item.resourceName}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {new Date(item.bookingDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })} · {formatTime12Hour(item.startTime)} — {item.feeLabel}
                      {item.participantType === 'guest' && item.displayName && ` (${item.displayName})`}
                    </div>
                  </div>
                  <span className={`font-medium ml-2 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                    ${item.feeDollars.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Stripe Sync Actions - Only show separate section when no Stripe customer yet */}
      {!billingInfo?.stripeCustomerId && (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className={`material-symbols-outlined ${isDark ? 'text-accent' : 'text-primary'}`}>sync</span>
            <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Stripe Setup</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSyncToStripe}
              disabled={isSyncingToStripe}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors tactile-btn ${
                isDark ? 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30' : 'bg-purple-100 text-purple-700 hover:bg-purple-200'
              } disabled:opacity-50`}
            >
              {isSyncingToStripe ? (
                <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-base">person_add</span>
              )}
              Sync to Stripe
            </button>
          </div>
          <p className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            Create or link a Stripe customer for this member to enable wallet features.
          </p>
        </div>
      )}

      {/* Always show Stripe section when member has stripeCustomerId - allows wallet features for all members */}
      {billingInfo?.stripeCustomerId && (
        <StripeBillingSection
          activeSubscription={billingInfo.billingProvider === 'stripe' ? (billingInfo.activeSubscription || null) : null}
          paymentMethods={billingInfo.paymentMethods}
          recentInvoices={billingInfo.recentInvoices}
          customerBalance={billingInfo.customerBalance}
          isPausing={isPausing}
          isResuming={isResuming}
          isGettingPaymentLink={isGettingPaymentLink}
          onPause={billingInfo.billingProvider === 'stripe' ? () => setShowPauseModal(true) : undefined}
          onResume={billingInfo.billingProvider === 'stripe' ? handleResumeSubscription : undefined}
          onShowCancelModal={billingInfo.billingProvider === 'stripe' ? () => setShowCancelModal(true) : undefined}
          onShowCreditModal={() => setShowCreditModal(true)}
          onShowDiscountModal={billingInfo.billingProvider === 'stripe' ? () => setShowDiscountModal(true) : undefined}
          onShowTierChangeModal={billingInfo.billingProvider === 'stripe' ? () => setShowTierChangeModal(true) : undefined}
          onGetPaymentLink={handleGetPaymentLink}
          onOpenBillingPortal={handleOpenBillingPortal}
          isOpeningBillingPortal={isOpeningBillingPortal}
          isDark={isDark}
          isWalletOnly={billingInfo.billingProvider !== 'stripe'}
          onSyncStripeData={handleSyncStripeData}
          isSyncingStripeData={isSyncingStripeData}
          billingProvider={billingInfo.billingProvider}
          billingProviders={BILLING_PROVIDERS}
          onUpdateBillingSource={handleUpdateBillingSource}
          isUpdatingSource={isUpdatingSource}
          hasStripeCustomer={!!billingInfo.stripeCustomerId}
          onCreateSubscription={async () => {
            setShowCreateSubscriptionModal(true);
            setIsLoadingCoupons(true);
            try {
              const res = await fetch('/api/stripe/coupons', { credentials: 'include' });
              if (res.ok) {
                const data = await res.json();
                setAvailableCoupons(data.coupons || []);
              }
            } catch (err: unknown) {
              console.error('Failed to load coupons:', err);
            } finally {
              setIsLoadingCoupons(false);
            }
          }}
          onCollectPayment={billingInfo.activeSubscription?.status === 'incomplete' ? () => {
            const amount = billingInfo.activeSubscription?.planAmount || 0;
            setCollectPaymentAmount(amount);
            setCollectPaymentError(null);
            setShowCollectPayment(true);
          } : undefined}
          onSendActivationEmail={billingInfo.activeSubscription?.status === 'incomplete' ? handleSendActivationEmail : undefined}
          isSendingActivation={isSendingActivation}
          onCopyActivationLink={billingInfo.activeSubscription?.status === 'incomplete' ? handleCopyActivationLink : undefined}
          onUpdateCardViaReader={billingInfo?.stripeCustomerId ? () => setShowUpdateCardTerminal(true) : undefined}
        />
      )}

      {billingInfo?.billingProvider === 'mindbody' && (
        <>
          {(() => {
            const effectiveStatus = billingInfo.migrationStatus === 'cancelled' ? null : billingInfo.migrationStatus;
            if (effectiveStatus === 'pending') {
              const startDateStr = billingInfo.migrationBillingStartDate
                ? (() => { try { const d = billingInfo.migrationBillingStartDate.includes('T') ? billingInfo.migrationBillingStartDate : `${billingInfo.migrationBillingStartDate}T12:00:00`; return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }); } catch { return billingInfo.migrationBillingStartDate; } })()
                : '';
              return (
                <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>schedule</span>
                  <span className={`text-sm font-medium ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                    Migration Pending — Stripe billing starts {startDateStr}
                  </span>
                </div>
              );
            }
            if (effectiveStatus === 'failed') {
              return (
                <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-red-400' : 'text-red-600'}`}>error</span>
                  <span className={`text-sm font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                    Migration Failed
                  </span>
                </div>
              );
            }
            if (!effectiveStatus) {
              const hasCard = !!(billingInfo.paymentMethods && billingInfo.paymentMethods.length > 0);
              if (hasCard) {
                return (
                  <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
                    <span className={`material-symbols-outlined text-base ${isDark ? 'text-green-400' : 'text-green-600'}`}>check_circle</span>
                    <span className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                      Ready for Migration
                    </span>
                  </div>
                );
              }
              return (
                <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>credit_card_off</span>
                  <span className={`text-sm font-medium ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    Needs Card for Migration
                  </span>
                </div>
              );
            }
            return null;
          })()}
          <MindbodyBillingSection
            mindbodyClientId={billingInfo.mindbodyClientId}
            isDark={isDark}
            hasStripeCustomer={!!billingInfo.stripeCustomerId}
            stripeCustomerId={billingInfo.stripeCustomerId}
            paymentMethods={billingInfo.paymentMethods}
            recentInvoices={billingInfo.recentInvoices}
            customerBalance={billingInfo.customerBalance}
            migrationStatus={billingInfo.migrationStatus}
            migrationBillingStartDate={billingInfo.migrationBillingStartDate}
            migrationRequestedBy={billingInfo.migrationRequestedBy}
            hasCardOnFile={migrationEligibility.hasCardOnFile}
            tierHasStripePrice={migrationEligibility.tierHasStripePrice}
            onInitiateMigration={() => setShowMigrationDialog(true)}
            onCancelMigration={handleCancelMigration}
            isMigrationLoading={isMigrationLoading}
          />
          <MigrationConfirmDialog
            isOpen={showMigrationDialog}
            onClose={() => setShowMigrationDialog(false)}
            onConfirm={handleInitiateMigration}
            memberEmail={memberEmail}
            memberName={billingInfo.firstName ? `${billingInfo.firstName} ${billingInfo.lastName || ''}`.trim() : undefined}
            currentTier={currentTier || billingInfo.tier}
            cardOnFile={migrationEligibility.cardOnFile}
            isDark={isDark}
            isLoading={isMigrationLoading}
          />
        </>
      )}

      {billingInfo?.billingProvider === 'family_addon' && (
        <FamilyAddonBillingSection
          familyGroup={billingInfo.familyGroup}
          memberEmail={memberEmail}
          isDark={isDark}
        />
      )}

      {billingInfo?.billingProvider === 'comped' && (
        <CompedBillingSection isDark={isDark} />
      )}

      {!billingInfo?.billingProvider && (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>help_outline</span>
            </div>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No Billing Source Set</p>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Select a billing source above to manage this member's billing.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Guest Passes Section */}
      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 mb-4">
          <span className={`material-symbols-outlined ${isDark ? 'text-purple-400' : 'text-purple-600'}`}>badge</span>
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Guest Passes</h3>
        </div>
        
        {guestPassInfo ? (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-lg text-green-500">confirmation_number</span>
                <span className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {guestPassInfo.remainingPasses}
                </span>
              </div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Remaining Passes</p>
            </div>
            <div className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-lg text-blue-500">history</span>
                <span className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {guestPassInfo.totalUsed}
                </span>
              </div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Used Passes</p>
            </div>
          </div>
        ) : (
          <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-500'} mb-4`}>
            No guest pass information available
          </p>
        )}

        {guestHistory.length > 0 && (
          <div className="mb-4">
            <h4 className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Guests Brought to Bookings ({guestHistory.length})
            </h4>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {guestHistory.map((guest) => (
                <div key={guest.id} className={`p-2 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'} flex items-center justify-between`}>
                  <div>
                    <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {guest.guestName || guest.guestEmail || 'Unknown Guest'}
                    </p>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                      {guest.resourceName} · {formatDatePacific(guest.visitDate)} at {formatTime12Hour(guest.startTime)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {guestCheckInsHistory.length > 0 && (
          <div>
            <h4 className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Guest Check-In History ({guestCheckInsHistory.length})
            </h4>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {guestCheckInsHistory.map((checkIn) => (
                <div key={checkIn.id} className={`p-2 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'} flex items-center justify-between`}>
                  <div>
                    <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {checkIn.guestName || 'Unknown Guest'}
                    </p>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                      Checked in on {formatDatePacific(checkIn.checkInDate)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {guestHistory.length === 0 && guestCheckInsHistory.length === 0 && !guestPassInfo && (
          <div className={`text-center py-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            <span className="material-symbols-outlined text-3xl mb-2">group_off</span>
            <p className="text-sm">No guest activity recorded</p>
          </div>
        )}
      </div>

      {/* Group Billing Section */}
      <GroupBillingManager memberEmail={memberEmail} />

      {/* Purchase History Section */}
      {purchases.length > 0 && (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex items-center gap-2 mb-4">
            <span className={`material-symbols-outlined ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>receipt_long</span>
            <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Purchase History</h3>
          </div>
          
          {(() => {
            const categoryLabels: Record<string, string> = {
              sim_walk_in: 'Sim Walk-In',
              guest_pass: 'Guest Pass',
              membership: 'Membership',
              cafe: 'Cafe',
              retail: 'Retail',
              add_funds: 'Account Top-Up',
              subscription: 'Subscription',
              payment: 'Payment',
              invoice: 'Invoice',
              other: 'Other',
            };
            
            const categoryColors: Record<string, string> = {
              sim_walk_in: isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700',
              guest_pass: isDark ? 'bg-purple-500/20 text-purple-300' : 'bg-purple-100 text-purple-700',
              membership: isDark ? 'bg-green-500/20 text-green-300' : 'bg-green-100 text-green-700',
              cafe: isDark ? 'bg-orange-500/20 text-orange-300' : 'bg-orange-100 text-orange-700',
              retail: isDark ? 'bg-pink-500/20 text-pink-300' : 'bg-pink-100 text-pink-700',
              add_funds: isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700',
              subscription: isDark ? 'bg-indigo-500/20 text-indigo-300' : 'bg-indigo-100 text-indigo-700',
              payment: isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-100 text-cyan-700',
              invoice: isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700',
              other: isDark ? 'bg-gray-500/20 text-gray-300' : 'bg-gray-100 text-gray-700',
            };
            
            const categoryIcons: Record<string, string> = {
              sim_walk_in: 'golf_course',
              guest_pass: 'badge',
              membership: 'card_membership',
              cafe: 'local_cafe',
              retail: 'shopping_bag',
              add_funds: 'account_balance_wallet',
              subscription: 'autorenew',
              payment: 'payments',
              invoice: 'receipt_long',
              other: 'receipt',
            };
            
            const categoryOrder = ['add_funds', 'subscription', 'membership', 'sim_walk_in', 'guest_pass', 'payment', 'invoice', 'cafe', 'retail', 'other'];
            type PurchaseRecord = { id: number | string; category?: string; itemCategory?: string; description?: string; amount?: number; date?: string; created_at?: string; product_name?: string; quantity?: number; status?: string; saleDate?: string; amountCents?: number; salePriceCents?: number; source?: string; type?: string; itemName?: string };
            const groupedPurchases = purchases.reduce((acc: Record<string, PurchaseRecord[]>, purchase: PurchaseRecord) => {
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
              <div className="space-y-6">
                {categoryOrder.map(category => {
                  const categoryPurchases = groupedPurchases[category];
                  if (!categoryPurchases || categoryPurchases.length === 0) return null;
                  
                  return (
                    <div key={category}>
                      <h4 className={`text-sm font-semibold mb-3 flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 ${categoryColors[category] || categoryColors.other}`}>
                          <span className="material-symbols-outlined text-xs">{categoryIcons[category] || 'receipt'}</span>
                          {categoryLabels[category] || category}
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
                                    {purchase.quantity > 1 && (
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
                            +{categoryPurchases.length - 5} more {categoryLabels[category] || category} purchases
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      <ApplyCreditModal
        isOpen={showCreditModal}
        onClose={() => setShowCreditModal(false)}
        onApply={handleApplyCredit}
        isLoading={isApplyingCredit}
        isDark={isDark}
      />

      <ApplyDiscountModal
        isOpen={showDiscountModal}
        onClose={() => setShowDiscountModal(false)}
        onApply={handleApplyDiscount}
        isLoading={isApplyingDiscount}
        isDark={isDark}
      />

      <ConfirmCancelModal
        isOpen={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onConfirm={handleCancelSubscription}
        isLoading={isCanceling}
        isDark={isDark}
      />

      <PauseDurationModal
        isOpen={showPauseModal}
        onClose={() => setShowPauseModal(false)}
        onConfirm={handlePauseSubscription}
        isLoading={isPausing}
        isDark={isDark}
      />

      {billingInfo?.activeSubscription && (
        <TierChangeWizard
          isOpen={showTierChangeModal}
          onClose={() => setShowTierChangeModal(false)}
          memberEmail={memberEmail}
          subscriptionId={billingInfo.activeSubscription.id}
          currentTierName={billingInfo.activeSubscription.planName || billingInfo.tier || 'Unknown'}
          onSuccess={() => {
            fetchBillingInfo();
            setShowTierChangeModal(false);
          }}
        />
      )}

      {/* Create Subscription Modal */}
      <ModalShell
        isOpen={showCreateSubscriptionModal}
        onClose={() => {
          setShowCreateSubscriptionModal(false);
          setSelectedSubscriptionTier('');
        }}
        title="Create Subscription"
        size="sm"
      >
        <div className="p-4 space-y-4">
          <div className={`p-4 rounded-lg ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
            <div className="flex items-start gap-3">
              <span className={`material-symbols-outlined ${isDark ? 'text-green-400' : 'text-green-600'} text-xl`}>add_card</span>
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                  Start a new membership subscription
                </p>
                <p className={`text-xs mt-1 ${isDark ? 'text-green-400/80' : 'text-green-600'}`}>
                  This will create a subscription in Stripe and begin billing the member.
                </p>
              </div>
            </div>
          </div>

          <div>
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Select Membership Tier
            </label>
            <select
              value={selectedSubscriptionTier}
              onChange={(e) => setSelectedSubscriptionTier(e.target.value)}
              className={`w-full p-3 rounded-lg border ${
                isDark
                  ? 'bg-white/10 border-white/20 text-white'
                  : 'bg-white border-gray-300 text-gray-900'
              } focus:ring-2 focus:ring-green-500 focus:border-green-500`}
            >
              <option value="">Choose a tier...</option>
              {VALID_TIERS.map((tier) => (
                <option key={tier} value={tier}>{tier}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Apply Discount (Optional)
            </label>
            <select
              value={selectedCoupon}
              onChange={(e) => setSelectedCoupon(e.target.value)}
              disabled={isLoadingCoupons}
              className={`w-full p-3 rounded-lg border ${
                isDark
                  ? 'bg-white/10 border-white/20 text-white'
                  : 'bg-white border-gray-300 text-gray-900'
              } focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50`}
            >
              <option value="">No discount</option>
              {availableCoupons.map((coupon) => (
                <option key={coupon.id} value={coupon.id}>
                  {coupon.name} ({coupon.percentOff ? `${coupon.percentOff}% off` : coupon.amountOff ? `$${(coupon.amountOff / 100).toFixed(2)} off` : ''} - {coupon.duration === 'forever' ? 'Forever' : coupon.duration === 'once' ? 'First invoice' : `${coupon.duration}`})
                </option>
              ))}
            </select>
            {isLoadingCoupons && (
              <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Loading coupons...</p>
            )}
          </div>

          {error && (
            <div className={`p-3 rounded-lg ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'} text-sm`}>
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => {
                setShowCreateSubscriptionModal(false);
                setSelectedSubscriptionTier('');
                setSelectedCoupon('');
              }}
              className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors tactile-btn ${
                isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Cancel
            </button>
            <button
              onClick={handleCreateSubscription}
              disabled={isCreatingSubscription || !selectedSubscriptionTier}
              className="flex-1 px-4 py-2.5 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 transition-colors tactile-btn"
            >
              {isCreatingSubscription ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  Creating...
                </span>
              ) : (
                'Create Subscription'
              )}
            </button>
          </div>
        </div>
      </ModalShell>

      {showCollectPayment && billingInfo?.activeSubscription && (
        <ModalShell
          isOpen={showCollectPayment}
          onClose={() => {
            setShowCollectPayment(false);
            setCollectPaymentMode('terminal');
            setCollectPaymentError(null);
          }}
          title="Collect Subscription Payment"
          size="md"
        >
          <div className="p-4 space-y-4">
            <div className={`p-3 rounded-lg ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>info</span>
                <span className={`text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                  Collecting payment of ${(collectPaymentAmount / 100).toFixed(2)} for {billingInfo.activeSubscription.planName || 'membership subscription'}
                </span>
              </div>
            </div>

            <div className={`flex rounded-lg overflow-hidden border ${isDark ? 'border-white/20' : 'border-gray-200'}`}>
              <button
                onClick={() => { setCollectPaymentMode('terminal'); setCollectPaymentError(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  collectPaymentMode === 'terminal'
                    ? isDark
                      ? 'bg-accent text-primary'
                      : 'bg-primary text-white'
                    : isDark
                      ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span className="material-symbols-outlined text-lg">point_of_sale</span>
                Card Reader
              </button>
              <button
                onClick={() => { setCollectPaymentMode('charge_card'); setCollectPaymentError(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  collectPaymentMode === 'charge_card'
                    ? isDark
                      ? 'bg-accent text-primary'
                      : 'bg-primary text-white'
                    : isDark
                      ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span className="material-symbols-outlined text-lg">credit_card</span>
                Charge Saved Card
              </button>
            </div>

            {collectPaymentError && (
              <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                <p className="text-sm">{collectPaymentError}</p>
              </div>
            )}

            {collectPaymentMode === 'terminal' && (
              <TerminalPayment
                amount={collectPaymentAmount}
                subscriptionId={billingInfo.activeSubscription.id}
                userId={memberId || null}
                email={memberEmail}
                description={`${billingInfo.activeSubscription.planName || 'Membership'} subscription payment`}
                onSuccess={async (piId) => {
                  try {
                    const confirmRes = await fetch('/api/stripe/terminal/confirm-subscription-payment', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({
                        paymentIntentId: piId,
                        subscriptionId: billingInfo.activeSubscription!.id,
                        userId: memberId || null,
                        invoiceId: null
                      })
                    });
                    if (!confirmRes.ok) {
                      const data = await confirmRes.json();
                      setCollectPaymentError(data.error || 'Failed to confirm payment');
                      return;
                    }
                    const confirmData = await confirmRes.json();
                    if (confirmData.cardSaveWarning) {
                      showSuccess(`Payment received! Membership activated. Note: ${confirmData.cardSaveWarning}`);
                    } else {
                      showSuccess('Payment received! Membership activated.');
                    }
                    setShowCollectPayment(false);
                    setCollectPaymentMode('terminal');
                    fetchBillingInfo();
                  } catch (err: unknown) {
                    setCollectPaymentError((err instanceof Error ? err.message : String(err)) || 'Failed to confirm payment');
                  }
                }}
                onError={(msg) => setCollectPaymentError(msg)}
                onCancel={() => {
                  setShowCollectPayment(false);
                  setCollectPaymentMode('terminal');
                }}
              />
            )}

            {collectPaymentMode === 'charge_card' && (
              <div className="space-y-4">
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  This will charge the member's saved card on file for the outstanding subscription invoice.
                </p>

                {billingInfo.paymentMethods && billingInfo.paymentMethods.length > 0 ? (
                  <div className={`p-3 rounded-lg flex items-center gap-3 ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'}`}>
                    <span className={`material-symbols-outlined text-xl ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>credit_card</span>
                    <div>
                      <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {(billingInfo.paymentMethods[0].brand || 'Card').charAt(0).toUpperCase() + (billingInfo.paymentMethods[0].brand || 'Card').slice(1)} •••• {billingInfo.paymentMethods[0].last4}
                      </p>
                      <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        Expires {billingInfo.paymentMethods[0].expMonth}/{billingInfo.paymentMethods[0].expYear}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className={`p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`material-symbols-outlined ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>warning</span>
                      <span className={`text-sm ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
                        No saved card on file. Use the card reader or ask the member to update their payment method.
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => {
                      setShowCollectPayment(false);
                      setCollectPaymentMode('terminal');
                      setCollectPaymentError(null);
                    }}
                    className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setIsChargingCard(true);
                      setCollectPaymentError(null);
                      try {
                        const res = await fetch('/api/stripe/staff/charge-subscription-invoice', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({
                            subscriptionId: billingInfo.activeSubscription!.id,
                            userId: memberId
                          })
                        });
                        const data = await res.json();
                        if (!res.ok) {
                          setCollectPaymentError(data.error || 'Failed to charge card');
                          return;
                        }
                        showSuccess('Payment received! Membership activated.');
                        setShowCollectPayment(false);
                        setCollectPaymentMode('terminal');
                        fetchBillingInfo();
                      } catch (err: unknown) {
                        setCollectPaymentError((err instanceof Error ? err.message : String(err)) || 'Failed to charge card');
                      } finally {
                        setIsChargingCard(false);
                      }
                    }}
                    disabled={isChargingCard || !billingInfo.paymentMethods || billingInfo.paymentMethods.length === 0}
                    className="flex-1 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity tactile-btn"
                  >
                    {isChargingCard ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                        Charging...
                      </span>
                    ) : (
                      `Charge $${(collectPaymentAmount / 100).toFixed(2)}`
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </ModalShell>
      )}

      {showUpdateCardTerminal && billingInfo?.stripeCustomerId && (
        <ModalShell
          isOpen={showUpdateCardTerminal}
          onClose={() => setShowUpdateCardTerminal(false)}
          title="Update Payment Method"
          size="md"
        >
          <div className="p-4 space-y-4">
            <div className={`p-3 rounded-lg ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
              <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>info</span>
                <span className={`text-sm ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                  Tap or insert a card on the reader to update this member's payment method on file. No charge will be made.
                </span>
              </div>
            </div>

            <TerminalPayment
              amount={0}
              mode="save_card"
              userId={memberId || null}
              email={memberEmail}
              description="Update payment method on file"
              paymentMetadata={{
                customerId: billingInfo.stripeCustomerId!,
                source: 'member_profile',
                ...(memberEmail ? { ownerEmail: memberEmail } : {}),
              }}
              subscriptionId={billingInfo.activeSubscription?.id || null}
              onSuccess={() => {
                showSuccess('Payment method updated successfully!');
                setShowUpdateCardTerminal(false);
                fetchBillingInfo();
              }}
              onError={(msg) => {
                console.error('Terminal card save error:', msg);
              }}
              onCancel={() => setShowUpdateCardTerminal(false)}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
};

export default MemberBillingTab;

import { useState, useEffect, useCallback } from 'react';
import { TIER_NAMES } from '../../../../shared/constants/tiers';
import { getApiErrorMessage, getNetworkErrorMessage, extractApiError } from '../../../utils/errorHandling';
import { useToast } from '../../Toast';
import type { BillingInfo, OutstandingData, MigrationEligibility, CouponOption } from './types';

export function useMemberBilling(
  memberEmail: string,
  memberId?: string,
  currentTier?: string,
  onTierUpdate?: (tier: string) => void,
  onMemberUpdated?: () => void,
  onDrawerClose?: () => void,
) {
  const { showToast } = useToast();
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [showBillingSourceModal, setShowBillingSourceModal] = useState(false);
  const [pendingBillingSource, setPendingBillingSource] = useState('');
  const [showTierChangeModal, setShowTierChangeModal] = useState(false);
  const [showCreateSubscriptionModal, setShowCreateSubscriptionModal] = useState(false);
  const [isCreatingSubscription, setIsCreatingSubscription] = useState(false);
  const [selectedSubscriptionTier, setSelectedSubscriptionTier] = useState('');
  const [selectedCoupon, setSelectedCoupon] = useState('');
  const [availableCoupons, setAvailableCoupons] = useState<CouponOption[]>([]);
  const [isLoadingCoupons, setIsLoadingCoupons] = useState(false);

  const [isSendingActivation, setIsSendingActivation] = useState(false);

  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [isMigrationLoading, setIsMigrationLoading] = useState(false);
  const [migrationEligibility, setMigrationEligibility] = useState<MigrationEligibility>({ hasCardOnFile: false, tierHasStripePrice: true, cardOnFile: null });

  const [showUpdateCardTerminal, setShowUpdateCardTerminal] = useState(false);
  const [showCollectPayment, setShowCollectPayment] = useState(false);
  const [collectPaymentAmount, setCollectPaymentAmount] = useState(0);
  const [collectPaymentMode, setCollectPaymentMode] = useState<'terminal' | 'charge_card'>('terminal');
  const [isChargingCard, setIsChargingCard] = useState(false);

  const [outstandingData, setOutstandingData] = useState<OutstandingData | null>(null);

  const showSuccess = (message: string) => {
    showToast(message, 'success');
  };

  const showError = (message: string | null) => {
    if (message) showToast(message, 'error', 5000);
  };

  const fetchBillingInfo = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setBillingInfo(data);
      } else {
        showError(await extractApiError(res, 'load billing info'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
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

  useEffect(() => {
    const handleBillingUpdate = (event: CustomEvent<{
      action: string;
      memberEmail?: string;
      customerId?: string;
    }>) => {
      const detail = event.detail;
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
        onMemberUpdated?.();
        showSuccess('Migration initiated successfully');
        setTimeout(() => onDrawerClose?.(), 600);
      } else {
        showError(await extractApiError(res, 'initiate migration'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
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
        onMemberUpdated?.();
        showSuccess('Migration cancelled');
        setTimeout(() => onDrawerClose?.(), 600);
      } else {
        showError(await extractApiError(res, 'cancel migration'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
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
        showError(await extractApiError(res, 'update tier'));
      } else {
        setIsEditingTier(false);
        if (onTierUpdate) onTierUpdate(manualTier);
        fetchBillingInfo();
        onMemberUpdated?.();
        showSuccess('Membership level updated');
        setTimeout(() => onDrawerClose?.(), 600);
      }
    } catch (err: unknown) {
      console.error('Error updating tier:', err);
      showError(getNetworkErrorMessage());
    } finally {
      setIsSavingTier(false);
    }
  };

  const requestBillingSourceChange = (newSource: string) => {
    setPendingBillingSource(newSource);
    setShowBillingSourceModal(true);
  };

  const handleConfirmBillingSource = async () => {
    setIsUpdatingSource(true);
    showError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ billingProvider: pendingBillingSource || null }),
      });
      if (res.ok) {
        await fetchBillingInfo();
        onMemberUpdated?.();
        setShowBillingSourceModal(false);
        setPendingBillingSource('');
        showSuccess('Billing source updated');
        setTimeout(() => onDrawerClose?.(), 600);
      } else {
        showError(getApiErrorMessage(res, 'update billing source'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsUpdatingSource(false);
    }
  };

  const handlePauseSubscription = async (durationDays: 30 | 60) => {
    setIsPausing(true);
    showError(null);
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
        onMemberUpdated?.();
        setShowPauseModal(false);
        const resumeDate = new Date(data.resumeDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
        showSuccess(`Subscription paused for ${durationDays} days. Billing resumes on ${resumeDate}.`);
        setTimeout(() => onDrawerClose?.(), 600);
      } else {
        showError(getApiErrorMessage(res, 'pause subscription'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsPausing(false);
    }
  };

  const handleResumeSubscription = async () => {
    setIsResuming(true);
    showError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/resume`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        await fetchBillingInfo();
        onMemberUpdated?.();
        setShowResumeModal(false);
        showSuccess('Subscription resumed');
        setTimeout(() => onDrawerClose?.(), 600);
      } else {
        showError(getApiErrorMessage(res, 'resume subscription'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsResuming(false);
    }
  };

  const handleCancelSubscription = async () => {
    setIsCanceling(true);
    showError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/cancel`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        await fetchBillingInfo();
        onMemberUpdated?.();
        setShowCancelModal(false);
        showSuccess('Subscription will be canceled at period end');
        setTimeout(() => onDrawerClose?.(), 600);
      } else {
        showError(getApiErrorMessage(res, 'cancel subscription'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsCanceling(false);
    }
  };

  const handleApplyCredit = async (amountCents: number, description: string) => {
    setIsApplyingCredit(true);
    showError(null);
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
        showError(getApiErrorMessage(res, 'apply credit'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsApplyingCredit(false);
    }
  };

  const handleApplyDiscount = async (percentOff: number, duration: string) => {
    setIsApplyingDiscount(true);
    showError(null);
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
        showError(getApiErrorMessage(res, 'apply discount'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsApplyingDiscount(false);
    }
  };

  const handleGetPaymentLink = async () => {
    setIsGettingPaymentLink(true);
    showError(null);
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
          showError('No payment link URL returned');
        }
      } else {
        linkWindow?.close();
        showError(getApiErrorMessage(res, 'get payment link'));
      }
    } catch (err: unknown) {
      linkWindow?.close();
      showError(getNetworkErrorMessage());
    } finally {
      setIsGettingPaymentLink(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setIsOpeningBillingPortal(true);
    showError(null);
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
          showError('No billing portal URL returned');
        }
      } else {
        portalWindow?.close();
        showError(getApiErrorMessage(res, 'open billing portal'));
      }
    } catch (err: unknown) {
      portalWindow?.close();
      showError(getNetworkErrorMessage());
    } finally {
      setIsOpeningBillingPortal(false);
    }
  };

  const handleSendActivationEmail = async () => {
    if (!memberEmail) return;
    setIsSendingActivation(true);
    showError(null);
    try {
      const subId = billingInfo?.activeSubscription?.status === 'incomplete' ? billingInfo.activeSubscription.id : undefined;
      const res = await fetch('/api/stripe/staff/send-reactivation-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail, subscriptionId: subId }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Failed to send activation email');
      } else {
        showSuccess('Activation email sent!');
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsSendingActivation(false);
    }
  };

  const handleCopyActivationLink = async () => {
    if (!memberEmail) return;
    showError(null);
    try {
      const subId = billingInfo?.activeSubscription?.status === 'incomplete' ? billingInfo.activeSubscription.id : undefined;
      let url: string | null = null;

      if (subId) {
        const invoiceRes = await fetch(`/api/stripe/subscriptions/invoice-link/${subId}?memberEmail=${encodeURIComponent(memberEmail)}`, {
          credentials: 'include',
        });
        if (invoiceRes.ok) {
          const invoiceData = await invoiceRes.json();
          url = invoiceData.url || null;
        }
      }

      if (!url) {
        const res = await fetch('/api/my/billing/portal', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: memberEmail }),
        });
        if (res.ok) {
          const data = await res.json();
          url = data.url || null;
        }
      }

      if (url) {
        await navigator.clipboard.writeText(url);
        showSuccess('Activation link copied to clipboard!');
      } else {
        showError('Could not generate activation link');
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    }
  };

  const handleSyncToStripe = async () => {
    setIsSyncingToStripe(true);
    showError(null);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-stripe`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        await fetchBillingInfo();
        onMemberUpdated?.();
        showSuccess(data.created ? 'Created new Stripe customer' : 'Linked existing Stripe customer');
      } else {
        showError(getApiErrorMessage(res, 'sync to Stripe'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsSyncingToStripe(false);
    }
  };

  const handleSyncStripeData = async () => {
    setIsSyncingStripeData(true);
    showError(null);
    const results: string[] = [];
    
    try {
      try {
        const metaRes = await fetch(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-metadata`, {
          method: 'POST',
          credentials: 'include',
        });
        if (metaRes.ok) {
          results.push('Metadata synced');
        }
      } catch (e: unknown) { /* continue */ }
      
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
      onMemberUpdated?.();
      
      if (results.length > 0) {
        showSuccess(`Stripe sync complete: ${results.join(', ')}`);
      } else {
        showError('Sync completed but no changes were made');
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsSyncingStripeData(false);
    }
  };

  const handleCreateSubscription = async () => {
    if (!selectedSubscriptionTier) {
      showError('Please select a membership tier');
      return;
    }
    
    setIsCreatingSubscription(true);
    showError(null);
    
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
        onMemberUpdated?.();
        setShowCreateSubscriptionModal(false);
        setSelectedSubscriptionTier('');
        setSelectedCoupon('');
        showSuccess(data.message || 'Subscription created successfully');
        if (data.memberStatus === 'active') {
          setTimeout(() => onDrawerClose?.(), 600);
        }
      } else {
        showError(getApiErrorMessage(res, 'create subscription'));
      }
    } catch (err: unknown) {
      showError(getNetworkErrorMessage());
    } finally {
      setIsCreatingSubscription(false);
    }
  };

  const handleOpenCreateSubscription = async () => {
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
      showError('Failed to load available coupons');
    } finally {
      setIsLoadingCoupons(false);
    }
  };

  const handleOpenCollectPayment = () => {
    const amount = billingInfo?.activeSubscription?.planAmount || 0;
    setCollectPaymentAmount(amount);
    showError(null);
    setShowCollectPayment(true);
  };

  const handleChargeCard = async () => {
    setIsChargingCard(true);
    showError(null);
    try {
      const res = await fetch('/api/stripe/staff/charge-subscription-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          subscriptionId: billingInfo?.activeSubscription!.id,
          userId: memberId
        })
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Failed to charge card');
        return;
      }
      showSuccess('Payment received! Membership activated.');
      setShowCollectPayment(false);
      setCollectPaymentMode('terminal');
      fetchBillingInfo();
      onMemberUpdated?.();
    } catch (err: unknown) {
      showError((err instanceof Error ? err.message : String(err)) || 'Failed to charge card');
    } finally {
      setIsChargingCard(false);
    }
  };

  const handleTerminalPaymentSuccess = async (piId: string) => {
    try {
      const confirmRes = await fetch('/api/stripe/terminal/confirm-subscription-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          paymentIntentId: piId,
          subscriptionId: billingInfo?.activeSubscription!.id,
          userId: memberId || null,
          invoiceId: null
        })
      });
      if (!confirmRes.ok) {
        const data = await confirmRes.json();
        showError(data.error || 'Failed to confirm payment');
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
      onMemberUpdated?.();
    } catch (err: unknown) {
      showError((err instanceof Error ? err.message : String(err)) || 'Failed to confirm payment');
    }
  };

  const handleUpdateCardSuccess = () => {
    showSuccess('Payment method updated successfully!');
    setShowUpdateCardTerminal(false);
    fetchBillingInfo();
    onMemberUpdated?.();
  };

  const handleUpdateCardError = (msg: string) => {
    console.error('Terminal card save error:', msg);
    showError(msg || 'Failed to update payment method');
  };

  return {
    billingInfo,
    isLoading,
    outstandingData,
    migrationEligibility,

    isEditingTier,
    setIsEditingTier,
    manualTier,
    setManualTier,
    isSavingTier,
    VALID_TIERS,
    handleManualTierSave,

    isUpdatingSource,
    requestBillingSourceChange,
    handleConfirmBillingSource,
    showBillingSourceModal,
    setShowBillingSourceModal,
    pendingBillingSource,

    showResumeModal,
    setShowResumeModal,

    isPausing,
    isResuming,
    isCanceling,
    isApplyingCredit,
    isApplyingDiscount,
    isGettingPaymentLink,
    isOpeningBillingPortal,
    isSyncingToStripe,
    isSyncingStripeData,
    isSendingActivation,
    isCreatingSubscription,
    isLoadingCoupons,
    isChargingCard,
    isMigrationLoading,

    showCreditModal,
    setShowCreditModal,
    showDiscountModal,
    setShowDiscountModal,
    showCancelModal,
    setShowCancelModal,
    showPauseModal,
    setShowPauseModal,
    showTierChangeModal,
    setShowTierChangeModal,
    showCreateSubscriptionModal,
    setShowCreateSubscriptionModal,
    showMigrationDialog,
    setShowMigrationDialog,
    showUpdateCardTerminal,
    setShowUpdateCardTerminal,
    showCollectPayment,
    setShowCollectPayment,
    collectPaymentAmount,
    collectPaymentMode,
    setCollectPaymentMode,

    selectedSubscriptionTier,
    setSelectedSubscriptionTier,
    selectedCoupon,
    setSelectedCoupon,
    availableCoupons,

    handlePauseSubscription,
    handleResumeSubscription,
    handleCancelSubscription,
    handleApplyCredit,
    handleApplyDiscount,
    handleGetPaymentLink,
    handleOpenBillingPortal,
    handleSendActivationEmail,
    handleCopyActivationLink,
    handleSyncToStripe,
    handleSyncStripeData,
    handleCreateSubscription,
    handleOpenCreateSubscription,
    handleOpenCollectPayment,
    handleChargeCard,
    handleTerminalPaymentSuccess,
    handleInitiateMigration,
    handleCancelMigration,
    handleUpdateCardSuccess,
    handleUpdateCardError,

    fetchBillingInfo,
    showSuccess,
    showError,
  };
}

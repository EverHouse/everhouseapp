import { useState, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TIER_NAMES } from '../../../../shared/constants/tiers';
import { fetchWithCredentials, postWithCredentials, putWithCredentials } from '../../../hooks/queries/useFetch';
import { useToast } from '../../Toast';
import type { BillingInfo, OutstandingData, MigrationEligibility, CouponOption } from './types';

export const memberBillingKeys = {
  all: ['member-billing'] as const,
  info: (email: string) => [...memberBillingKeys.all, email] as const,
  outstanding: (email: string) => [...memberBillingKeys.all, email, 'outstanding'] as const,
  migrationStatus: (email: string) => [...memberBillingKeys.all, email, 'migration-status'] as const,
};

export function useMemberBilling(
  memberEmail: string,
  memberId?: string,
  currentTier?: string,
  onTierUpdate?: (tier: string) => void,
  onMemberUpdated?: () => void,
  onDrawerClose?: () => void,
) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [isEditingTier, setIsEditingTier] = useState(false);
  const [manualTier, setManualTier] = useState('');
  const VALID_TIERS = [...TIER_NAMES];

  const [showCreditModal, setShowCreditModal] = useState(false);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [showBillingSourceModal, setShowBillingSourceModal] = useState(false);
  const [pendingBillingSource, setPendingBillingSource] = useState('');
  const [showTierChangeModal, setShowTierChangeModal] = useState(false);
  const [showCreateSubscriptionModal, setShowCreateSubscriptionModal] = useState(false);
  const [selectedSubscriptionTier, setSelectedSubscriptionTier] = useState('');
  const [selectedCoupon, setSelectedCoupon] = useState('');

  const [showMigrationDialog, setShowMigrationDialog] = useState(false);

  const [showUpdateCardTerminal, setShowUpdateCardTerminal] = useState(false);
  const [showCollectPayment, setShowCollectPayment] = useState(false);
  const [collectPaymentAmount, setCollectPaymentAmount] = useState(0);
  const [collectPaymentMode, setCollectPaymentMode] = useState<'terminal' | 'charge_card'>('terminal');

  const showSuccess = (message: string) => {
    showToast(message, 'success');
  };

  const showError = useCallback((message: string | null) => {
    if (message) showToast(message, 'error', 5000);
  }, [showToast]);

  const invalidateBilling = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: memberBillingKeys.info(memberEmail) });
  }, [queryClient, memberEmail]);

  const billingQuery = useQuery({
    queryKey: memberBillingKeys.info(memberEmail),
    queryFn: () => fetchWithCredentials<BillingInfo>(`/api/member-billing/${encodeURIComponent(memberEmail)}`),
  });

  const outstandingQuery = useQuery({
    queryKey: memberBillingKeys.outstanding(memberEmail),
    queryFn: () => fetchWithCredentials<OutstandingData>(`/api/member-billing/${encodeURIComponent(memberEmail)}/outstanding`),
  });

  const migrationStatusQuery = useQuery({
    queryKey: memberBillingKeys.migrationStatus(memberEmail),
    queryFn: () => fetchWithCredentials<{ hasCardOnFile: boolean; tierHasStripePrice: boolean; cardOnFile: { brand?: string; last4?: string } | null }>(
      `/api/member-billing/${encodeURIComponent(memberEmail)}/migration-status`
    ),
    enabled: billingQuery.data?.billingProvider === 'mindbody',
  });

  const migrationEligibility: MigrationEligibility = migrationStatusQuery.data
    ? {
        hasCardOnFile: migrationStatusQuery.data.hasCardOnFile || false,
        tierHasStripePrice: migrationStatusQuery.data.tierHasStripePrice || false,
        cardOnFile: migrationStatusQuery.data.cardOnFile || null,
      }
    : { hasCardOnFile: false, tierHasStripePrice: true, cardOnFile: null };

  useEffect(() => {
    const handleBillingUpdate = (event: CustomEvent<{
      action: string;
      memberEmail?: string;
      customerId?: string;
    }>) => {
      const detail = event.detail;
      if (detail.memberEmail?.toLowerCase() === memberEmail.toLowerCase() ||
          (billingQuery.data?.stripeCustomerId && detail.customerId === billingQuery.data.stripeCustomerId)) {
        invalidateBilling();
      }
    };

    window.addEventListener('billing-update', handleBillingUpdate as EventListener);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate as EventListener);
    };
  }, [memberEmail, billingQuery.data?.stripeCustomerId, invalidateBilling]);

  const couponsQuery = useQuery({
    queryKey: ['stripe-coupons-for-subscription'],
    queryFn: () => fetchWithCredentials<{ coupons: CouponOption[] }>('/api/stripe/coupons'),
    enabled: showCreateSubscriptionModal,
  });

  const initiateMigrationMutation = useMutation({
    mutationFn: (billingStartDate: string) =>
      postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/migrate-to-stripe`, {
        billingStartDate,
        confirmedMindBodyCancelled: true,
      }),
    onSuccess: () => {
      setShowMigrationDialog(false);
      invalidateBilling();
      onMemberUpdated?.();
      showSuccess('Migration initiated successfully');
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to initiate migration');
    },
  });

  const cancelMigrationMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/cancel-migration`, {}),
    onSuccess: () => {
      invalidateBilling();
      onMemberUpdated?.();
      showSuccess('Migration cancelled');
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to cancel migration');
    },
  });

  const manualTierSaveMutation = useMutation({
    mutationFn: (tier: string) =>
      fetchWithCredentials<Record<string, unknown>>(`/api/members/${encodeURIComponent(memberEmail)}/tier`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      }),
    onSuccess: () => {
      setIsEditingTier(false);
      if (onTierUpdate) onTierUpdate(manualTier);
      invalidateBilling();
      onMemberUpdated?.();
      showSuccess('Membership level updated');
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to update tier');
    },
  });

  const handleManualTierSave = () => {
    if (!memberEmail) return;
    manualTierSaveMutation.mutate(manualTier);
  };

  const requestBillingSourceChange = (newSource: string) => {
    setPendingBillingSource(newSource);
    setShowBillingSourceModal(true);
  };

  const confirmBillingSourceMutation = useMutation({
    mutationFn: (billingProvider: string) =>
      putWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/source`, {
        billingProvider: billingProvider || null,
      }),
    onSuccess: () => {
      invalidateBilling();
      onMemberUpdated?.();
      setShowBillingSourceModal(false);
      setPendingBillingSource('');
      showSuccess('Billing source updated');
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to update billing source');
    },
  });

  const handleConfirmBillingSource = () => {
    confirmBillingSourceMutation.mutate(pendingBillingSource);
  };

  const pauseSubscriptionMutation = useMutation({
    mutationFn: (durationDays: 30 | 60) =>
      postWithCredentials<{ resumeDate: string }>(`/api/member-billing/${encodeURIComponent(memberEmail)}/pause`, { durationDays }),
    onSuccess: (data, durationDays) => {
      invalidateBilling();
      onMemberUpdated?.();
      setShowPauseModal(false);
      const resumeDate = new Date(data.resumeDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
      showSuccess(`Subscription paused for ${durationDays} days. Billing resumes on ${resumeDate}.`);
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to pause subscription');
    },
  });

  const resumeSubscriptionMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/resume`, {}),
    onSuccess: () => {
      invalidateBilling();
      onMemberUpdated?.();
      setShowResumeModal(false);
      showSuccess('Subscription resumed');
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to resume subscription');
    },
  });

  const cancelSubscriptionMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/cancel`, {}),
    onSuccess: () => {
      invalidateBilling();
      onMemberUpdated?.();
      setShowCancelModal(false);
      showSuccess('Subscription will be canceled at period end');
      setTimeout(() => onDrawerClose?.(), 600);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to cancel subscription');
    },
  });

  const applyCreditMutation = useMutation({
    mutationFn: ({ amountCents, description }: { amountCents: number; description: string }) =>
      postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/credit`, { amountCents, description }),
    onSuccess: (_data, variables) => {
      invalidateBilling();
      setShowCreditModal(false);
      showSuccess(`Credit of $${(variables.amountCents / 100).toFixed(2)} applied`);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to apply credit');
    },
  });

  const applyDiscountMutation = useMutation({
    mutationFn: ({ percentOff, duration }: { percentOff: number; duration: string }) =>
      postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/discount`, { percentOff, duration }),
    onSuccess: (_data, variables) => {
      invalidateBilling();
      setShowDiscountModal(false);
      showSuccess(`${variables.percentOff}% discount applied`);
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to apply discount');
    },
  });

  const getPaymentLinkMutation = useMutation({
    mutationFn: async () => {
      const linkWindow = window.open('about:blank', '_blank');
      try {
        const data = await postWithCredentials<{ url?: string }>(`/api/member-billing/${encodeURIComponent(memberEmail)}/payment-link`, {});
        if (data.url) {
          if (linkWindow) {
            linkWindow.location.href = data.url;
          } else {
            window.location.href = data.url;
          }
        } else {
          linkWindow?.close();
          throw new Error('No payment link URL returned');
        }
      } catch (err) {
        linkWindow?.close();
        throw err;
      }
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to get payment link');
    },
  });

  const openBillingPortalMutation = useMutation({
    mutationFn: async () => {
      const portalWindow = window.open('about:blank', '_blank');
      try {
        const data = await postWithCredentials<{ url?: string }>('/api/my/billing/portal', { email: memberEmail });
        if (data.url) {
          if (portalWindow) {
            portalWindow.location.href = data.url;
          } else {
            window.location.href = data.url;
          }
        } else {
          portalWindow?.close();
          throw new Error('No billing portal URL returned');
        }
      } catch (err) {
        portalWindow?.close();
        throw err;
      }
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to open billing portal');
    },
  });

  const sendActivationEmailMutation = useMutation({
    mutationFn: () => {
      const subId = billingQuery.data?.activeSubscription?.status === 'incomplete' ? billingQuery.data.activeSubscription.id : undefined;
      return postWithCredentials<Record<string, unknown>>('/api/stripe/staff/send-reactivation-link', {
        memberEmail,
        subscriptionId: subId,
      });
    },
    onSuccess: () => {
      showSuccess('Activation email sent!');
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to send activation email');
    },
  });

  const handleSendActivationEmail = () => {
    if (!memberEmail) return;
    sendActivationEmailMutation.mutate();
  };

  const handleCopyActivationLink = async () => {
    if (!memberEmail) return;
    try {
      const subId = billingQuery.data?.activeSubscription?.status === 'incomplete' ? billingQuery.data.activeSubscription.id : undefined;
      let url: string | null = null;

      if (subId) {
        try {
          const invoiceData = await fetchWithCredentials<{ url?: string }>(
            `/api/stripe/subscriptions/invoice-link/${subId}?memberEmail=${encodeURIComponent(memberEmail)}`
          );
          url = invoiceData.url || null;
        } catch {
          /* continue */
        }
      }

      if (!url) {
        const data = await postWithCredentials<{ url?: string }>('/api/my/billing/portal', { email: memberEmail });
        url = data.url || null;
      }

      if (url) {
        await navigator.clipboard.writeText(url);
        showSuccess('Activation link copied to clipboard!');
      } else {
        showError('Could not generate activation link');
      }
    } catch {
      showError('Network error. Please check your connection.');
    }
  };

  const syncToStripeMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<{ created?: boolean }>(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-stripe`, {}),
    onSuccess: (data) => {
      invalidateBilling();
      onMemberUpdated?.();
      showSuccess(data.created ? 'Created new Stripe customer' : 'Linked existing Stripe customer');
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to sync to Stripe');
    },
  });

  const syncStripeDataMutation = useMutation({
    mutationFn: async () => {
      const results: string[] = [];

      try {
        await postWithCredentials<Record<string, unknown>>(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-metadata`, {});
        results.push('Metadata synced');
      } catch { /* continue */ }

      try {
        const data = await postWithCredentials<{ previousTier?: string; newTier?: string }>(`/api/member-billing/${encodeURIComponent(memberEmail)}/sync-tier-from-stripe`, {});
        if (data.previousTier !== data.newTier) {
          results.push(`Tier: ${data.previousTier || 'none'} → ${data.newTier}`);
        } else {
          results.push(`Tier: ${data.newTier}`);
        }
      } catch { /* continue */ }

      try {
        const data = await postWithCredentials<{ transactionCount?: number }>(`/api/member-billing/${encodeURIComponent(memberEmail)}/backfill-cache`, {});
        results.push(`${data.transactionCount || 0} transactions cached`);
      } catch { /* continue */ }

      return results;
    },
    onSuccess: (results) => {
      invalidateBilling();
      onMemberUpdated?.();
      if (results.length > 0) {
        showSuccess(`Stripe sync complete: ${results.join(', ')}`);
      } else {
        showError('Sync completed but no changes were made');
      }
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to sync Stripe data');
    },
  });

  const createSubscriptionMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<{ message?: string; memberStatus?: string }>('/api/stripe/subscriptions/create-for-member', {
        memberEmail,
        tierName: selectedSubscriptionTier,
        couponId: selectedCoupon || undefined,
      }),
    onSuccess: (data) => {
      invalidateBilling();
      onMemberUpdated?.();
      setShowCreateSubscriptionModal(false);
      setSelectedSubscriptionTier('');
      setSelectedCoupon('');
      showSuccess(data.message || 'Subscription created successfully');
      if (data.memberStatus === 'active') {
        setTimeout(() => onDrawerClose?.(), 600);
      }
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to create subscription');
    },
  });

  const handleCreateSubscription = () => {
    if (!selectedSubscriptionTier) {
      showError('Please select a membership tier');
      return;
    }
    createSubscriptionMutation.mutate();
  };

  const handleOpenCreateSubscription = () => {
    setShowCreateSubscriptionModal(true);
  };

  const handleOpenCollectPayment = () => {
    const amount = billingQuery.data?.activeSubscription?.planAmount || 0;
    setCollectPaymentAmount(amount);
    setShowCollectPayment(true);
  };

  const chargeCardMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<{ error?: string }>('/api/stripe/staff/charge-subscription-invoice', {
        subscriptionId: billingQuery.data?.activeSubscription!.id,
        userId: memberId,
      }),
    onSuccess: () => {
      showSuccess('Payment received! Membership activated.');
      setShowCollectPayment(false);
      setCollectPaymentMode('terminal');
      invalidateBilling();
      onMemberUpdated?.();
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to charge card');
    },
  });

  const terminalPaymentMutation = useMutation({
    mutationFn: (piId: string) =>
      postWithCredentials<{ cardSaveWarning?: string }>('/api/stripe/terminal/confirm-subscription-payment', {
        paymentIntentId: piId,
        subscriptionId: billingQuery.data?.activeSubscription!.id,
        userId: memberId || null,
        invoiceId: null,
      }),
    onSuccess: (data) => {
      if (data.cardSaveWarning) {
        showSuccess(`Payment received! Membership activated. Note: ${data.cardSaveWarning}`);
      } else {
        showSuccess('Payment received! Membership activated.');
      }
      setShowCollectPayment(false);
      setCollectPaymentMode('terminal');
      invalidateBilling();
      onMemberUpdated?.();
    },
    onError: (err: Error) => {
      showError(err.message || 'Failed to confirm payment');
    },
  });

  const handleUpdateCardSuccess = () => {
    showSuccess('Payment method updated successfully!');
    setShowUpdateCardTerminal(false);
    invalidateBilling();
    onMemberUpdated?.();
  };

  const handleUpdateCardError = (msg: string) => {
    console.error('Terminal card save error:', msg);
    showError(msg || 'Failed to update payment method');
  };

  return {
    billingInfo: billingQuery.data ?? null,
    isLoading: billingQuery.isLoading,
    outstandingData: outstandingQuery.data ?? null,
    migrationEligibility,

    isEditingTier,
    setIsEditingTier,
    manualTier,
    setManualTier,
    isSavingTier: manualTierSaveMutation.isPending,
    VALID_TIERS,
    handleManualTierSave,

    isUpdatingSource: confirmBillingSourceMutation.isPending,
    requestBillingSourceChange,
    handleConfirmBillingSource,
    showBillingSourceModal,
    setShowBillingSourceModal,
    pendingBillingSource,

    showResumeModal,
    setShowResumeModal,

    isPausing: pauseSubscriptionMutation.isPending,
    isResuming: resumeSubscriptionMutation.isPending,
    isCanceling: cancelSubscriptionMutation.isPending,
    isApplyingCredit: applyCreditMutation.isPending,
    isApplyingDiscount: applyDiscountMutation.isPending,
    isGettingPaymentLink: getPaymentLinkMutation.isPending,
    isOpeningBillingPortal: openBillingPortalMutation.isPending,
    isSyncingToStripe: syncToStripeMutation.isPending,
    isSyncingStripeData: syncStripeDataMutation.isPending,
    isSendingActivation: sendActivationEmailMutation.isPending,
    isCreatingSubscription: createSubscriptionMutation.isPending,
    isLoadingCoupons: couponsQuery.isLoading && showCreateSubscriptionModal,
    isChargingCard: chargeCardMutation.isPending,
    isMigrationLoading: initiateMigrationMutation.isPending || cancelMigrationMutation.isPending,

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
    availableCoupons: couponsQuery.data?.coupons ?? [],

    handlePauseSubscription: (durationDays: 30 | 60) => pauseSubscriptionMutation.mutate(durationDays),
    handleResumeSubscription: () => resumeSubscriptionMutation.mutate(),
    handleCancelSubscription: () => cancelSubscriptionMutation.mutate(),
    handleApplyCredit: (amountCents: number, description: string) => applyCreditMutation.mutate({ amountCents, description }),
    handleApplyDiscount: (percentOff: number, duration: string) => applyDiscountMutation.mutate({ percentOff, duration }),
    handleGetPaymentLink: () => getPaymentLinkMutation.mutate(),
    handleOpenBillingPortal: () => openBillingPortalMutation.mutate(),
    handleSendActivationEmail,
    handleCopyActivationLink,
    handleSyncToStripe: () => syncToStripeMutation.mutate(),
    handleSyncStripeData: () => syncStripeDataMutation.mutate(),
    handleCreateSubscription,
    handleOpenCreateSubscription,
    handleOpenCollectPayment,
    handleChargeCard: () => chargeCardMutation.mutate(),
    handleTerminalPaymentSuccess: (piId: string) => terminalPaymentMutation.mutate(piId),
    handleInitiateMigration: (billingStartDate: string) => initiateMigrationMutation.mutate(billingStartDate),
    handleCancelMigration: () => cancelMigrationMutation.mutate(),
    handleUpdateCardSuccess,
    handleUpdateCardError,

    fetchBillingInfo: invalidateBilling,
    showSuccess,
    showError,
  };
}

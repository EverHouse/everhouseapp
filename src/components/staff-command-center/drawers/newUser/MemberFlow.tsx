import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Stripe } from '@stripe/stripe-js';
import {
  MemberFlowProps,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MembershipTier,
  GroupMember,
  EMAIL_REGEX,
  getStripePromise,
} from './newUserTypes';
import { fetchWithCredentials, postWithCredentials } from '../../../../hooks/queries/useFetch';
import { apiRequest } from '../../../../lib/apiRequest';
import { copyToClipboard } from '../../../../lib/copyToClipboard';
import { SuccessStep } from './SuccessStep';
import { PreviewStep } from './PreviewStep';
import { PaymentStep } from './PaymentStep';
import { MemberFormStep } from './MemberFormStep';
import { createGroupAndAddMembers, getGroupResultToast } from './groupMemberHelper';

export function MemberFlow({
  step,
  form,
  setForm,
  tiers,
  discounts,
  existingBillingGroups,
  isDark,
  isLoading,
  setIsLoading,
  setError,
  setPendingUserToCleanup,
  setStep,
  onSuccess,
  createdUser,
  onClose,
  showToast,
  scannedIdImage,
  onShowIdScanner,
  recentCreations,
  emailCheckResult,
  onEmailBlur,
}: MemberFlowProps) {
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [createdUserId, setCreatedUserId] = useState<string | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const paymentInitiatedRef = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [linkSending, setLinkSending] = useState(false);
  const linkSubmittingRef = useRef(false);
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'terminal'>('card');
  const [paymentPath, setPaymentPath] = useState<'choose' | 'card_or_terminal' | 'link'>('choose');
  const [subMemberScannedIds, setSubMemberScannedIds] = useState<Record<number, { base64: string; mimeType: string }>>({});
  const [scanningSubMemberIndex, setScanningSubMemberIndex] = useState<number | null>(null);
  const [_showIdScanner, setShowIdScanner] = useState(false);
  const reviewSubmittingRef = useRef(false);
  const reviewTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (reviewTimeoutRef.current) clearTimeout(reviewTimeoutRef.current);
    };
  }, []);

  const getInputClass = (fieldName: string) => `w-full px-3 py-2.5 rounded-lg border ${
    fieldErrors[fieldName]
      ? 'border-red-500 focus:border-red-500 focus:ring-red-500 bg-red-50 dark:bg-red-900/10'
      : isDark 
        ? 'bg-white/5 border-white/20 focus:border-emerald-500' 
        : 'bg-white border-gray-300 focus:border-emerald-500'
  } ${isDark ? 'text-white placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'} focus:outline-none focus:ring-1 transition-colors`;

  const inputClass = `w-full px-3 py-2.5 rounded-lg border ${
    isDark 
      ? 'bg-white/5 border-white/20 text-white placeholder-gray-500 focus:border-emerald-500' 
      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-emerald-500'
  } focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors`;

  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`;
  const errorMsgClass = 'text-red-500 text-xs mt-1 flex items-center gap-1';

  const selectedTier = tiers.find(t => t.id === form.tierId);

  const initializePayment = useCallback(async () => {
    if (paymentInitiatedRef.current || !selectedTier) return;
    paymentInitiatedRef.current = true;
    setStripeLoading(true);
    setStripeError(null);

    try {
      const stripe = await getStripePromise();
      if (!stripe) {
        throw new Error('Stripe is not configured');
      }
      setStripeInstance(stripe);

      if (subscriptionId && createdUserId && !form.joinExistingGroup) {
        try {
          const refreshData = await fetchWithCredentials<{ clientSecret?: string }>(`/api/stripe/subscriptions/refresh-intent/${subscriptionId}`);
          if (refreshData.clientSecret && !refreshData.clientSecret.startsWith('seti_')) {
            setClientSecret(refreshData.clientSecret);
            const piId = refreshData.clientSecret.split('_secret_')[0];
            if (piId) setPaymentIntentId(piId);
          }
          setStripeLoading(false);
          return;
        } catch (_resuseErr) {
          // intentionally empty
        }
      }

      if (form.joinExistingGroup && form.existingGroupId) {
        const discountedPrice = Math.round(selectedTier.priceCents * 0.8);
        
        const data = await postWithCredentials<{ clientSecret: string; paymentIntentId: string }>('/api/stripe/staff/quick-charge', {
          memberEmail: form.email,
          memberName: `${form.firstName} ${form.lastName}`,
          amountCents: discountedPrice,
          description: `${selectedTier.name} Membership (Group Add-on)`,
          isNewCustomer: true,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          dob: form.dob || undefined,
          tierSlug: selectedTier.slug,
          tierName: selectedTier.name,
          createUser: true,
          streetAddress: form.streetAddress || undefined,
          city: form.city || undefined,
          state: form.state || undefined,
          zipCode: form.zipCode || undefined,
        });

        setClientSecret(data.clientSecret);
        setPaymentIntentId(data.paymentIntentId);
      } else {
        const discount = discounts.find(d => d.code === form.discountCode);
        const couponId = discount?.stripeCouponId || undefined;
        
        const result = await apiRequest<Record<string, unknown>>('/api/stripe/subscriptions/create-new-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: form.email,
            firstName: form.firstName,
            lastName: form.lastName,
            phone: form.phone || undefined,
            dob: form.dob || undefined,
            tierSlug: selectedTier.slug,
            couponId,
            streetAddress: form.streetAddress || undefined,
            city: form.city || undefined,
            state: form.state || undefined,
            zipCode: form.zipCode || undefined,
          })
        }, { maxRetries: 1 });

        if (!result.ok) {
          if (result.errorData?.canCleanup && result.errorData?.existingUserId) {
            setPendingUserToCleanup({ id: result.errorData.existingUserId as string, name: (result.errorData.existingUserName as string) || form.email });
          }
          throw new Error(result.error || 'Failed to create subscription');
        }

        const data = result.data as Record<string, unknown>;
        
        if (data.freeActivation) {
          setSubscriptionId(data.subscriptionId as string);
          setCreatedUserId(data.userId as string);
          showToast('Membership activated — no payment required (100% discount).', 'success');
          
          if (scannedIdImage && data.userId) {
            postWithCredentials('/api/admin/save-id-image', {
              userId: data.userId,
              image: scannedIdImage.base64,
              mimeType: scannedIdImage.mimeType,
            }).catch(err => console.error('Failed to save ID image:', err));
          }
          
          onSuccess({ id: (data.userId as string) || 'member-' + Date.now(), email: form.email, name: `${form.firstName} ${form.lastName}` });
          return;
        }
        
        const clientSecret = data.clientSecret as string | undefined;
        if (clientSecret && !clientSecret.startsWith('seti_')) {
          setClientSecret(clientSecret);
          const piId = clientSecret.split('_secret_')[0];
          if (piId) setPaymentIntentId(piId);
        }
        setSubscriptionId(data.subscriptionId as string);
        setCreatedUserId(data.userId as string);
      }
    } catch (err: unknown) {
      setStripeError((err instanceof Error ? err.message : String(err)) || 'Failed to initialize payment');
      paymentInitiatedRef.current = false;
    } finally {
      setStripeLoading(false);
    }
  }, [selectedTier, subscriptionId, createdUserId, form.joinExistingGroup, form.existingGroupId, form.email, form.firstName, form.lastName, form.phone, form.dob, form.discountCode, form.streetAddress, form.city, form.state, form.zipCode, discounts, scannedIdImage, onSuccess, showToast, setPendingUserToCleanup]);

  useEffect(() => {
    if (step === 'payment' && paymentPath === 'card_or_terminal' && selectedTier && !paymentInitiatedRef.current) {
      initializePayment();
    }
  }, [step, paymentPath, selectedTier, initializePayment]);

  const handlePaymentSuccess = async (paymentIntentIdResult?: string) => {
    if (!paymentIntentIdResult) return;
    setIsLoading(true);
    
    try {
      if (form.joinExistingGroup && form.existingGroupId && selectedTier) {
        await postWithCredentials('/api/stripe/staff/quick-charge/confirm', { paymentIntentId: paymentIntentIdResult });
        
        try {
          const endpoint = form.existingGroupType === 'corporate'
            ? `/api/group-billing/groups/${form.existingGroupId}/corporate-members`
            : `/api/family-billing/groups/${form.existingGroupId}/members`;
          
          const payload = form.existingGroupType === 'corporate'
            ? { 
                email: form.email, 
                firstName: form.firstName,
                lastName: form.lastName,
                phone: form.phone,
                dob: form.dob
              }
            : { 
                memberEmail: form.email, 
                memberTier: selectedTier.slug, 
                relationship: 'family',
                firstName: form.firstName,
                lastName: form.lastName,
                phone: form.phone,
                dob: form.dob
              };
          
          await postWithCredentials(endpoint, payload);
          showToast('Payment received! Member added to billing group.', 'success');
        } catch (groupErr: unknown) {
          console.error('Error adding member to group:', groupErr);
          showToast('Payment received but failed to add to group. Contact support.', 'error');
        }
      } else {
        try {
          await postWithCredentials('/api/stripe/subscriptions/confirm-inline-payment', { 
            paymentIntentId: paymentIntentIdResult,
            subscriptionId,
            userId: createdUserId
          });
          
          showToast('Payment received! Membership activated.', 'success');

          if (scannedIdImage && createdUserId) {
            postWithCredentials('/api/admin/save-id-image', {
              userId: createdUserId,
              image: scannedIdImage.base64,
              mimeType: scannedIdImage.mimeType,
            }).catch(err => console.error('Failed to save ID image:', err));
          }
          
          if (form.addGroupMembers && form.groupMembers.length > 0) {
            try {
              const result = await createGroupAndAddMembers({
                form,
                tiers,
                selectedTierSlug: selectedTier?.slug,
                subMemberScannedIds,
              });
              const toast = getGroupResultToast(result.addedCount, result.failedCount);
              showToast(toast.message, toast.type);
            } catch (groupErr: unknown) {
              console.error('Error creating family group:', groupErr);
              showToast('Membership activated but failed to create family group. You can set this up manually.', 'warning');
            }
          }
        } catch (confirmErr: unknown) {
          console.error('Payment confirmation failed:', confirmErr);
          showToast('Payment received but activation failed. Contact support.', 'error');
        }
      }

      onSuccess({ 
        id: createdUserId || 'member-' + Date.now(), 
        email: form.email, 
        name: `${form.firstName} ${form.lastName}` 
      });
    } catch (_err: unknown) {
      setError('Payment confirmation failed. Please contact support.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendActivationLink = async () => {
    if (linkSubmittingRef.current) return;
    
    const errors: Record<string, string> = {};
    if (!form.tierId) errors.tierId = 'Please select a membership tier';
    if (!form.firstName) errors.firstName = 'First name is required';
    if (!form.lastName) errors.lastName = 'Last name is required';
    if (!form.email) errors.email = 'Email is required';
    else if (!EMAIL_REGEX.test(form.email)) errors.email = 'Please enter a valid email address';
    
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Please fill in all required fields');
      return;
    }
    
    linkSubmittingRef.current = true;
    setLinkSending(true);
    setIsLoading(true);
    setError(null);
    
    try {
      const selectedTier = tiers.find(t => t.id === form.tierId);
      if (!selectedTier) {
        throw new Error('Selected tier not found');
      }
      
      const discount = discounts.find(d => d.code === form.discountCode);
      
      const result = await apiRequest<Record<string, unknown>>('/api/stripe/subscriptions/send-activation-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || undefined,
          dob: form.dob || undefined,
          tierSlug: selectedTier.slug,
          couponId: discount?.stripeCouponId || undefined,
          streetAddress: form.streetAddress || undefined,
          city: form.city || undefined,
          state: form.state || undefined,
          zipCode: form.zipCode || undefined,
        })
      }, { maxRetries: 1 });
      
      if (!result.ok) {
        if (result.errorData?.canCleanup && result.errorData?.existingUserId) {
          setPendingUserToCleanup({ id: result.errorData.existingUserId as string, name: (result.errorData.existingUserName as string) || form.email });
        }
        const errMsg = result.error || 'Failed to send activation link';
        throw new Error(errMsg.includes('incomplete signup') ? 'This email has a pending signup that needs to be cleaned up first' : errMsg);
      }
      
      const data = result.data as Record<string, unknown>;
      
      setActivationUrl(data.checkoutUrl as string);
      showToast(`Activation link sent to ${form.email}`, 'success');
      if (scannedIdImage && data.userId) {
        postWithCredentials('/api/admin/save-id-image', {
          userId: data.userId,
          image: scannedIdImage.base64,
          mimeType: scannedIdImage.mimeType,
        }).catch(err => console.error('Failed to save ID image:', err));
      }
      onSuccess({ 
        id: data.userId as string, 
        email: form.email, 
        name: `${form.firstName} ${form.lastName}` 
      });
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to send activation link');
    } finally {
      linkSubmittingRef.current = false;
      setLinkSending(false);
      setIsLoading(false);
    }
  };

  const handleCopyActivationLink = async () => {
    if (!form.email || !form.tierId) return;
    if (linkSubmittingRef.current) return;
    
    linkSubmittingRef.current = true;
    setLinkSending(true);
    setError(null);
    
    try {
      const selectedTier = tiers.find(t => t.id === form.tierId);
      if (!selectedTier) {
        throw new Error('Selected tier not found');
      }
      
      const discount = discounts.find(d => d.code === form.discountCode);
      
      const result = await apiRequest<Record<string, unknown>>('/api/stripe/subscriptions/send-activation-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || undefined,
          dob: form.dob || undefined,
          tierSlug: selectedTier.slug,
          couponId: discount?.stripeCouponId || undefined,
          streetAddress: form.streetAddress || undefined,
          city: form.city || undefined,
          state: form.state || undefined,
          zipCode: form.zipCode || undefined,
        })
      }, { maxRetries: 1 });
      
      if (!result.ok) {
        if (result.errorData?.canCleanup && result.errorData?.existingUserId) {
          setPendingUserToCleanup({ id: result.errorData.existingUserId as string, name: (result.errorData.existingUserName as string) || form.email });
        }
        const errMsg = result.error || 'Failed to create activation link';
        throw new Error(errMsg.includes('incomplete signup') ? 'This email has a pending signup that needs to be cleaned up first' : errMsg);
      }
      
      const data = result.data as Record<string, unknown>;
      
      if (data.checkoutUrl) {
        const url = data.checkoutUrl as string;
        const copied = await copyToClipboard(url);
        setActivationUrl(url);
        if (copied) {
          showToast('Activation link copied to clipboard!', 'success');
        } else {
          showToast('Link ready — long-press the URL below to copy it', 'info');
        }
        if (scannedIdImage && data.userId) {
          postWithCredentials('/api/admin/save-id-image', {
            userId: data.userId,
            image: scannedIdImage.base64,
            mimeType: scannedIdImage.mimeType,
          }).catch(err => console.error('Failed to save ID image:', err));
        }
      } else {
        throw new Error('Failed to generate Stripe payment link — no checkout URL was returned');
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to copy activation link');
    } finally {
      linkSubmittingRef.current = false;
      setLinkSending(false);
    }
  };

  const resetPayment = () => {
    paymentInitiatedRef.current = false;
    setClientSecret(null);
    setPaymentIntentId(null);
    setStripeError(null);
  };

  const handleReviewCharges = () => {
    if (reviewSubmittingRef.current) return;

    const errors: Record<string, string> = {};
    if (!form.tierId) errors.tierId = 'Please select a membership tier';
    if (!form.firstName) errors.firstName = 'First name is required';
    if (!form.lastName) errors.lastName = 'Last name is required';
    if (!form.email) errors.email = 'Email is required';
    else if (!EMAIL_REGEX.test(form.email)) errors.email = 'Please enter a valid email address';
    if (!form.phone) errors.phone = 'Phone number is required';
    if (form.joinExistingGroup && !form.existingGroupId) errors.existingGroupId = 'Please select a billing group to join';
    
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Please fill in all required fields');
      return;
    }

    reviewSubmittingRef.current = true;
    reviewTimeoutRef.current = setTimeout(() => { reviewSubmittingRef.current = false; }, 1000);

    setError(null);
    setStep('preview');
  };

  const addGroupMember = () => {
    setForm(prev => ({
      ...prev,
      groupMembers: [...prev.groupMembers, { firstName: '', lastName: '', email: '', phone: '', dob: '', tierId: prev.tierId, discountCode: 'FAMILY20', streetAddress: '', city: '', state: '', zipCode: '' }],
    }));
  };

  const removeGroupMember = (index: number) => {
    setForm(prev => ({
      ...prev,
      groupMembers: prev.groupMembers.filter((_, i) => i !== index),
    }));
    setSubMemberScannedIds(prev => {
      const updated: Record<number, { base64: string; mimeType: string }> = {};
      for (const [key, val] of Object.entries(prev)) {
        const k = Number(key);
        if (k === index) continue;
        if (k < index) updated[k] = val;
        else updated[k - 1] = val;
      }
      return updated;
    });
    if (scanningSubMemberIndex === index) {
      setScanningSubMemberIndex(null);
    } else if (scanningSubMemberIndex !== null && scanningSubMemberIndex > index) {
      setScanningSubMemberIndex(scanningSubMemberIndex - 1);
    }
  };

  const updateGroupMember = (index: number, field: keyof GroupMember, value: string) => {
    setForm(prev => ({
      ...prev,
      groupMembers: prev.groupMembers.map((m, i) => 
        i === index ? { ...m, [field]: field === 'tierId' ? (value ? parseInt(value, 10) : null) : value } : m
      ),
    }));
  };

  if (step === 'success') {
    return (
      <SuccessStep
        isDark={isDark}
        createdUser={createdUser}
        onClose={onClose}
      />
    );
  }

  if (step === 'preview') {
    return (
      <PreviewStep
        form={form}
        tiers={tiers}
        discounts={discounts}
        existingBillingGroups={existingBillingGroups}
        selectedTier={selectedTier}
        isDark={isDark}
        setStep={setStep}
      />
    );
  }

  if (step === 'payment') {
    return (
      <PaymentStep
        form={form}
        tiers={tiers}
        discounts={discounts}
        selectedTier={selectedTier}
        isDark={isDark}
        isLoading={isLoading}
        stripeInstance={stripeInstance}
        clientSecret={clientSecret}
        paymentIntentId={paymentIntentId}
        subscriptionId={subscriptionId}
        createdUserId={createdUserId}
        stripeLoading={stripeLoading}
        stripeError={stripeError}
        paymentMethod={paymentMethod}
        paymentPath={paymentPath}
        activationUrl={activationUrl}
        linkSending={linkSending}
        scannedIdImage={scannedIdImage}
        subMemberScannedIds={subMemberScannedIds}
        setPaymentMethod={setPaymentMethod}
        setPaymentPath={setPaymentPath}
        resetPayment={resetPayment}
        initializePayment={initializePayment}
        handlePaymentSuccess={handlePaymentSuccess}
        handleSendActivationLink={handleSendActivationLink}
        handleCopyActivationLink={handleCopyActivationLink}
        setStripeError={setStripeError}
        setStep={setStep}
        showToast={showToast}
        onSuccess={onSuccess}
      />
    );
  }

  return (
    <MemberFormStep
      form={form}
      setForm={setForm}
      tiers={tiers}
      discounts={discounts}
      existingBillingGroups={existingBillingGroups}
      isDark={isDark}
      fieldErrors={fieldErrors}
      setFieldErrors={setFieldErrors}
      inputClass={inputClass}
      getInputClass={getInputClass}
      labelClass={labelClass}
      errorMsgClass={errorMsgClass}
      scannedIdImage={scannedIdImage}
      onShowIdScanner={onShowIdScanner}
      recentCreations={recentCreations}
      emailCheckResult={emailCheckResult}
      onEmailBlur={onEmailBlur}
      handleReviewCharges={handleReviewCharges}
      addGroupMember={addGroupMember}
      removeGroupMember={removeGroupMember}
      updateGroupMember={updateGroupMember}
      subMemberScannedIds={subMemberScannedIds}
      setScanningSubMemberIndex={setScanningSubMemberIndex}
      setShowIdScanner={setShowIdScanner}
    />
  );
}

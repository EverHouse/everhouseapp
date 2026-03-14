import React, { useState, useEffect, useRef } from 'react';
import { Stripe } from '@stripe/stripe-js';
import {
  MemberFlowProps,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MembershipTier,
  GroupMember,
  EMAIL_REGEX,
  getStripePromise,
} from './newUserTypes';
import { SuccessStep } from './SuccessStep';
import { PreviewStep } from './PreviewStep';
import { PaymentStep } from './PaymentStep';
import { MemberFormStep } from './MemberFormStep';

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

  useEffect(() => {
    if (step === 'payment' && paymentPath === 'card_or_terminal' && selectedTier && !paymentInitiatedRef.current) {
      initializePayment();
    }
  }, [step, paymentPath, selectedTier]);

  const initializePayment = async () => {
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
          const refreshRes = await fetch(`/api/stripe/subscriptions/refresh-intent/${subscriptionId}`, {
            credentials: 'include'
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            if (refreshData.clientSecret && !refreshData.clientSecret.startsWith('seti_')) {
              setClientSecret(refreshData.clientSecret);
              const piId = refreshData.clientSecret.split('_secret_')[0];
              if (piId) setPaymentIntentId(piId);
            }
            setStripeLoading(false);
            return;
          }
        } catch (_resuseErr) {
          // intentionally empty
        }
      }

      if (form.joinExistingGroup && form.existingGroupId) {
        const discountedPrice = Math.round(selectedTier.priceCents * 0.8);
        
        const res = await fetch('/api/stripe/staff/quick-charge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
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
          })
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create payment');
        }

        const data = await res.json();
        setClientSecret(data.clientSecret);
        setPaymentIntentId(data.paymentIntentId);
      } else {
        const discount = discounts.find(d => d.code === form.discountCode);
        const couponId = discount?.stripeCouponId || undefined;
        
        const res = await fetch('/api/stripe/subscriptions/create-new-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
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
        });

        if (!res.ok) {
          const data = await res.json();
          if (data.canCleanup && data.existingUserId) {
            setPendingUserToCleanup({ id: data.existingUserId, name: data.existingUserName || form.email });
          }
          throw new Error(data.error || 'Failed to create subscription');
        }

        const data = await res.json();
        
        if (data.freeActivation) {
          setSubscriptionId(data.subscriptionId);
          setCreatedUserId(data.userId);
          showToast('Membership activated — no payment required (100% discount).', 'success');
          
          if (scannedIdImage && data.userId) {
            fetch('/api/admin/save-id-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                userId: data.userId,
                image: scannedIdImage.base64,
                mimeType: scannedIdImage.mimeType,
              }),
            }).catch(err => console.error('Failed to save ID image:', err));
          }
          
          onSuccess({ id: data.userId || 'member-' + Date.now(), email: form.email, name: `${form.firstName} ${form.lastName}` });
          return;
        }
        
        if (data.clientSecret && !data.clientSecret.startsWith('seti_')) {
          setClientSecret(data.clientSecret);
          const piId = data.clientSecret.split('_secret_')[0];
          if (piId) setPaymentIntentId(piId);
        }
        setSubscriptionId(data.subscriptionId);
        setCreatedUserId(data.userId);
      }
    } catch (err: unknown) {
      setStripeError((err instanceof Error ? err.message : String(err)) || 'Failed to initialize payment');
      paymentInitiatedRef.current = false;
    } finally {
      setStripeLoading(false);
    }
  };

  const handlePaymentSuccess = async (paymentIntentIdResult?: string) => {
    if (!paymentIntentIdResult) return;
    setIsLoading(true);
    
    try {
      if (form.joinExistingGroup && form.existingGroupId && selectedTier) {
        await fetch('/api/stripe/staff/quick-charge/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ paymentIntentId: paymentIntentIdResult })
        });
        
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
          
          const groupRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
          });
          
          if (!groupRes.ok) {
            const groupData = await groupRes.json();
            console.error('Failed to add member to group:', groupData.error);
            showToast('Payment received but failed to add to group. Contact support.', 'error');
          } else {
            showToast('Payment received! Member added to billing group.', 'success');
          }
        } catch (groupErr: unknown) {
          console.error('Error adding member to group:', groupErr);
          showToast('Payment received but failed to add to group. Contact support.', 'error');
        }
      } else {
        const confirmRes = await fetch('/api/stripe/subscriptions/confirm-inline-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ 
            paymentIntentId: paymentIntentIdResult,
            subscriptionId,
            userId: createdUserId
          })
        });
        
        if (!confirmRes.ok) {
          const confirmData = await confirmRes.json();
          console.error('Payment confirmation failed:', confirmData.error);
          showToast('Payment received but activation failed. Contact support.', 'error');
        } else {
          showToast('Payment received! Membership activated.', 'success');

          if (scannedIdImage && createdUserId) {
            fetch('/api/admin/save-id-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                userId: createdUserId,
                image: scannedIdImage.base64,
                mimeType: scannedIdImage.mimeType,
              }),
            }).catch(err => console.error('Failed to save ID image:', err));
          }
          
          if (form.addGroupMembers && form.groupMembers.length > 0) {
            try {
              const groupCreateRes = await fetch('/api/family-billing/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  primaryEmail: form.email,
                  groupName: `${form.firstName} ${form.lastName} Family`
                })
              });

              if (!groupCreateRes.ok) {
                const groupCreateData = await groupCreateRes.json();
                console.error('Failed to create family billing group:', groupCreateData.error);
                showToast('Membership activated but failed to create family group. You can set this up manually.', 'warning');
              } else {
                const groupCreateData = await groupCreateRes.json();
                const groupId = groupCreateData.groupId;
                let addedCount = 0;
                let failedCount = 0;

                for (let i = 0; i < form.groupMembers.length; i++) {
                  const member = form.groupMembers[i];
                  try {
                    const memberTierSlug = tiers.find(t => t.id === member.tierId)?.slug || selectedTier?.slug;
                    const addMemberRes = await fetch(`/api/family-billing/groups/${groupId}/members`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({
                        memberEmail: member.email,
                        memberTier: memberTierSlug,
                        relationship: 'family',
                        firstName: member.firstName,
                        lastName: member.lastName,
                        phone: member.phone,
                        dob: member.dob,
                        streetAddress: member.streetAddress || undefined,
                        city: member.city || undefined,
                        state: member.state || undefined,
                        zipCode: member.zipCode || undefined,
                      })
                    });

                    if (addMemberRes.ok) {
                      addedCount++;
                      const addData = await addMemberRes.json();
                      if (subMemberScannedIds[i] && addData.memberId) {
                        fetch('/api/admin/save-id-image', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({
                            userId: addData.memberId,
                            image: subMemberScannedIds[i].base64,
                            mimeType: subMemberScannedIds[i].mimeType,
                          }),
                        }).catch(err => console.error('Failed to save sub-member ID image:', err));
                      }
                    } else {
                      failedCount++;
                      const addData = await addMemberRes.json();
                      console.error(`Failed to add group member ${member.email}:`, addData.error);
                    }
                  } catch (memberErr: unknown) {
                    failedCount++;
                    console.error(`Error adding group member ${member.email}:`, memberErr);
                  }
                }

                if (failedCount === 0) {
                  showToast(`Family group created with ${addedCount} member${addedCount !== 1 ? 's' : ''}.`, 'success');
                } else if (addedCount > 0) {
                  showToast(`Family group created. ${addedCount} added, ${failedCount} failed. Check group billing to fix.`, 'warning');
                } else {
                  showToast('Family group created but failed to add members. You can add them manually.', 'warning');
                }
              }
            } catch (groupErr: unknown) {
              console.error('Error creating family group:', groupErr);
              showToast('Membership activated but failed to create family group. You can set this up manually.', 'warning');
            }
          }
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
      
      const res = await fetch('/api/stripe/subscriptions/send-activation-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
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
      });
      
      if (!res.ok) {
        const data = await res.json();
        if (data.canCleanup && data.existingUserId) {
          setPendingUserToCleanup({ id: data.existingUserId, name: data.existingUserName || form.email });
        }
        const errMsg = data.error || 'Failed to send activation link';
        throw new Error(errMsg.includes('incomplete signup') ? 'This email has a pending signup that needs to be cleaned up first' : errMsg);
      }
      
      const data = await res.json();
      
      setActivationUrl(data.checkoutUrl);
      showToast(`Activation link sent to ${form.email}`, 'success');
      if (scannedIdImage && data.userId) {
        fetch('/api/admin/save-id-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: data.userId,
            image: scannedIdImage.base64,
            mimeType: scannedIdImage.mimeType,
          }),
        }).catch(err => console.error('Failed to save ID image:', err));
      }
      onSuccess({ 
        id: data.userId, 
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
      
      const res = await fetch('/api/stripe/subscriptions/send-activation-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
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
      });
      
      if (!res.ok) {
        const data = await res.json();
        if (data.canCleanup && data.existingUserId) {
          setPendingUserToCleanup({ id: data.existingUserId, name: data.existingUserName || form.email });
        }
        const errMsg = data.error || 'Failed to create activation link';
        throw new Error(errMsg.includes('incomplete signup') ? 'This email has a pending signup that needs to be cleaned up first' : errMsg);
      }
      
      const data = await res.json();
      
      if (data.checkoutUrl) {
        await navigator.clipboard.writeText(data.checkoutUrl);
        setActivationUrl(data.checkoutUrl);
        showToast('Activation link copied to clipboard!', 'success');
        if (scannedIdImage && data.userId) {
          fetch('/api/admin/save-id-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              userId: data.userId,
              image: scannedIdImage.base64,
              mimeType: scannedIdImage.mimeType,
            }),
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
    setTimeout(() => { reviewSubmittingRef.current = false; }, 1000);

    setError(null);
    setStep('preview');
  };

  const addGroupMember = () => {
    setForm(prev => ({
      ...prev,
      groupMembers: [...prev.groupMembers, { firstName: '', lastName: '', email: '', phone: '', dob: '', tierId: prev.tierId, streetAddress: '', city: '', state: '', zipCode: '' }],
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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { SimpleCheckoutForm } from '../../../stripe/StripePaymentForm';
import { TerminalPayment } from '../../TerminalPayment';
import { formatPhoneInput } from '../../../../utils/formatting';
import {
  MemberFlowProps,
  MembershipTier,
  GroupMember,
  EMAIL_REGEX,
  getStripePromise,
} from './newUserTypes';

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
  const [copyingLink, setCopyingLink] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'terminal'>('card');

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
    if (step === 'payment' && selectedTier && !paymentInitiatedRef.current) {
      initializePayment();
    }
  }, [step, selectedTier]);

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

      if (form.joinExistingGroup && form.existingGroupId) {
        const discount = discounts.find(d => d.code === form.discountCode);
        const discountPercent = discount?.percentOff || 0;
        const primaryPrice = Math.round(selectedTier.priceCents * 0.8);
        const discountedPrice = Math.round(primaryPrice * (1 - discountPercent / 100));
        
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
        
        if (data.clientSecret) {
          setClientSecret(data.clientSecret);
          const piId = data.clientSecret.split('_secret_')[0];
          if (piId) setPaymentIntentId(piId);
        }
        setSubscriptionId(data.subscriptionId);
        setCreatedUserId(data.userId);
      }
    } catch (err: any) {
      setStripeError(err.message || 'Failed to initialize payment');
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
        } catch (groupErr) {
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
                  } catch (memberErr) {
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
            } catch (groupErr) {
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
    } catch (err: any) {
      setError('Payment confirmation failed. Please contact support.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendActivationLink = async () => {
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
          couponId: discount?.stripeCouponId || undefined
        })
      });
      
      if (!res.ok) {
        const data = await res.json();
        if (data.canCleanup && data.existingUserId) {
          setPendingUserToCleanup({ id: data.existingUserId, name: data.existingUserName || form.email });
        }
        throw new Error(data.error || 'Failed to send activation link');
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
    } catch (err: any) {
      setError(err.message || 'Failed to send activation link');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyActivationLink = async () => {
    if (!form.email || !form.tierId) return;
    
    setCopyingLink(true);
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
          couponId: discount?.stripeCouponId || undefined
        })
      });
      
      if (!res.ok) {
        const data = await res.json();
        if (data.canCleanup && data.existingUserId) {
          setPendingUserToCleanup({ id: data.existingUserId, name: data.existingUserName || form.email });
        }
        throw new Error(data.error || 'Failed to create activation link');
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
        throw new Error('No checkout URL returned');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to copy activation link');
    } finally {
      setCopyingLink(false);
    }
  };

  const resetPayment = () => {
    paymentInitiatedRef.current = false;
    setClientSecret(null);
    setPaymentIntentId(null);
    setStripeError(null);
  };

  const handleReviewCharges = () => {
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
      <div className="text-center py-8">
        <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${
          isDark ? 'bg-emerald-600/20' : 'bg-emerald-100'
        }`}>
          <span className="material-symbols-outlined text-3xl text-emerald-600">check_circle</span>
        </div>
        <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Member Created!
        </h3>
        <p className={`text-sm mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          {createdUser?.name} has been added successfully.
        </p>
        <button
          onClick={onClose}
          className="px-6 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  if (step === 'preview') {
    const discount = discounts.find(d => d.code === form.discountCode);
    const tierPrice = selectedTier?.priceCents || 0;
    const discountPercent = discount?.percentOff || 0;
    const primaryPrice = form.joinExistingGroup 
      ? Math.round(tierPrice * 0.8)
      : Math.round(tierPrice * (1 - discountPercent / 100));
    
    const groupMembersPricing = form.groupMembers.map((member) => {
      const memberTier = tiers.find(t => t.id === member.tierId) || selectedTier;
      const memberTierPrice = memberTier?.priceCents || tierPrice;
      return {
        ...member,
        tierName: memberTier?.name || selectedTier?.name || 'Unknown',
        price: Math.round(memberTierPrice * 0.8),
      };
    });
    
    const groupMembersTotal = groupMembersPricing.reduce((sum, m) => sum + m.price, 0);
    const totalPrice = primaryPrice + groupMembersTotal;
    
    const selectedGroup = form.joinExistingGroup 
      ? existingBillingGroups.find(g => g.id === form.existingGroupId) 
      : null;

    return (
      <div className="space-y-4">
        <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Review Charges
        </h3>

        {form.joinExistingGroup && selectedGroup && (
          <div className={`p-3 rounded-lg ${isDark ? 'bg-blue-900/20 border border-blue-700' : 'bg-blue-50 border border-blue-200'}`}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-blue-500">group</span>
              <div>
                <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Adding to: {selectedGroup.groupName || selectedGroup.primaryName}
                </p>
                <p className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                  Billing through {selectedGroup.primaryEmail}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <div>
                <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {form.firstName} {form.lastName}
                </p>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {selectedTier?.name} Membership
                  {form.joinExistingGroup ? ' (20% family discount)' : discount ? ` (${discount.percentOff}% off)` : ''}
                </p>
              </div>
              <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                ${(primaryPrice / 100).toFixed(2)}/mo
              </span>
            </div>

            {groupMembersPricing.map((member, index) => (
              <div key={index} className="flex justify-between items-center">
                <div>
                  <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {member.firstName || 'Sub-member'} {member.lastName || index + 1}
                  </p>
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    {member.tierName} (Family 20% off)
                  </p>
                </div>
                <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  ${(member.price / 100).toFixed(2)}/mo
                </span>
              </div>
            ))}

            <div className={`pt-3 mt-3 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
              <div className="flex justify-between items-center">
                <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Monthly Total
                </span>
                <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  ${(totalPrice / 100).toFixed(2)}/mo
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            onClick={() => setStep('form')}
            className={`flex-1 py-2.5 rounded-lg font-medium transition-colors ${
              isDark 
                ? 'bg-white/10 text-white hover:bg-white/20' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Back
          </button>
          <button
            onClick={() => setStep('payment')}
            className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors"
          >
            Continue to Payment
          </button>
        </div>
      </div>
    );
  }

  if (step === 'payment') {
    const discount = discounts.find(d => d.code === form.discountCode);
    const tierPrice = selectedTier?.priceCents || 0;
    const discountPercent = discount?.percentOff || 0;
    const primaryPrice = form.joinExistingGroup 
      ? Math.round(tierPrice * 0.8)
      : Math.round(tierPrice * (1 - discountPercent / 100));
    
    const groupMembersTotal = form.groupMembers.reduce((sum, member) => {
      const memberTier = tiers.find(t => t.id === member.tierId) || selectedTier;
      const memberTierPrice = memberTier?.priceCents || tierPrice;
      return sum + Math.round(memberTierPrice * 0.8);
    }, 0);
    
    const totalPrice = primaryPrice + groupMembersTotal;

    const stripeOptions: StripeElementsOptions = clientSecret ? {
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#059669',
          colorBackground: isDark ? '#1a1d12' : '#ffffff',
          colorText: isDark ? '#ffffff' : '#31543C',
          colorDanger: '#df1b41',
          fontFamily: 'system-ui, sans-serif',
          borderRadius: '8px',
        },
      },
    } : undefined;

    return (
      <div className="space-y-4">
        <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Payment
        </h3>

        <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex justify-between items-center mb-2">
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {selectedTier?.name} Membership
            </span>
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              ${(totalPrice / 100).toFixed(2)}
            </span>
          </div>
          <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            for {form.firstName} {form.lastName}
          </p>
        </div>

        <div className="flex gap-2 p-1 rounded-lg bg-gray-100 dark:bg-white/5">
          <button
            onClick={() => setPaymentMethod('card')}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
              paymentMethod === 'card'
                ? 'bg-white dark:bg-white/10 shadow-sm text-emerald-600 dark:text-emerald-400'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            <span className="material-symbols-outlined text-lg">credit_card</span>
            Enter Card
          </button>
          <button
            onClick={() => setPaymentMethod('terminal')}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
              paymentMethod === 'terminal'
                ? 'bg-white dark:bg-white/10 shadow-sm text-emerald-600 dark:text-emerald-400'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            <span className="material-symbols-outlined text-lg">contactless</span>
            Card Reader
          </button>
        </div>

        {paymentMethod === 'card' && (
          <>
            {stripeLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-600 border-t-transparent" />
              </div>
            )}

            {stripeError && (
              <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                <p className="text-sm">{stripeError}</p>
                <button
                  onClick={() => {
                    resetPayment();
                    initializePayment();
                  }}
                  className="text-sm underline mt-2"
                >
                  Try Again
                </button>
              </div>
            )}

            {clientSecret && stripeInstance && stripeOptions && (
              <Elements stripe={stripeInstance} options={stripeOptions}>
                <SimpleCheckoutForm
                  onSuccess={handlePaymentSuccess}
                  onError={(msg) => setStripeError(msg)}
                  submitLabel={`Charge $${(totalPrice / 100).toFixed(2)}`}
                />
              </Elements>
            )}

            {!stripeLoading && !stripeError && !clientSecret && (
              <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                {subscriptionId ? (
                  <div className="text-center">
                    <p className={`text-sm mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Card entry not available for this subscription.
                    </p>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                      Use the Card Reader option above, or send an activation link.
                    </p>
                  </div>
                ) : (
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    Initializing payment...
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {paymentMethod === 'terminal' && (
          <>
            {stripeError && !subscriptionId ? (
              <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                <p className="text-sm">{stripeError}</p>
                <button
                  onClick={() => {
                    resetPayment();
                    initializePayment();
                  }}
                  className="text-sm underline mt-2"
                >
                  Try Again
                </button>
              </div>
            ) : (
              <TerminalPayment
                amount={totalPrice}
                subscriptionId={form.joinExistingGroup ? null : subscriptionId}
                existingPaymentIntentId={paymentIntentId || undefined}
                userId={createdUserId}
                description={form.joinExistingGroup ? `${selectedTier?.name || 'Membership'} (Group Add-on)` : undefined}
                onSuccess={async (piId) => {
                  if (form.joinExistingGroup) {
                    await handlePaymentSuccess(piId);
                  } else {
                    try {
                      const confirmRes = await fetch('/api/stripe/terminal/confirm-subscription-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                          paymentIntentId: piId,
                          subscriptionId,
                          userId: createdUserId,
                          invoiceId: null
                        })
                      });
                      if (!confirmRes.ok) {
                        const data = await confirmRes.json();
                        if (!data.autoRefunded) {
                          try {
                            await fetch('/api/stripe/terminal/refund-payment', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              credentials: 'include',
                              body: JSON.stringify({ paymentIntentId: piId })
                            });
                            showToast('Payment activation failed. The charge has been automatically refunded.', 'error');
                          } catch (refundErr) {
                            console.error('Auto-refund attempt failed:', refundErr);
                            showToast(`Payment activation failed: ${data.error}. Please refund manually in Stripe.`, 'error');
                          }
                        } else {
                          showToast('Member account not found. Payment has been automatically refunded.', 'error');
                        }
                        setStripeError(data.error || 'Failed to confirm payment');
                        return;
                      }
                      showToast('Payment received! Membership activated.', 'success');

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
                              } catch (memberErr) {
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
                        } catch (groupErr) {
                          console.error('Error creating family group:', groupErr);
                          showToast('Membership activated but failed to create family group. You can set this up manually.', 'warning');
                        }
                      }

                      onSuccess({
                        id: createdUserId || 'member-' + Date.now(),
                        email: form.email,
                        name: `${form.firstName} ${form.lastName}`
                      });
                    } catch (err: any) {
                      setStripeError(err.message || 'Failed to activate membership');
                    }
                  }
                }}
                onError={(msg) => setStripeError(msg)}
                onCancel={async () => {
                  if (createdUserId && subscriptionId) {
                    try {
                      await fetch(`/api/stripe/subscriptions/cleanup-pending/${createdUserId}`, {
                        method: 'DELETE',
                        credentials: 'include'
                      });
                      showToast('Signup cancelled. No charges were made.', 'info');
                    } catch (err) {
                      console.error('Failed to cleanup pending signup:', err);
                      showToast('Signup cancelled but cleanup failed. Use the cleanup button to remove the pending account.', 'warning');
                    }
                  }
                  paymentInitiatedRef.current = false;
                }}
              />
            )}
          </>
        )}

        <div className={`pt-2 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex gap-2">
            <button
              onClick={handleSendActivationLink}
              disabled={isLoading || copyingLink}
              className={`flex-1 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 ${
                isDark 
                  ? 'bg-white/10 text-white hover:bg-white/20' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {isLoading ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                  Sending...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">mail</span>
                  Send Link
                </>
              )}
            </button>
            <button
              onClick={handleCopyActivationLink}
              disabled={isLoading || copyingLink}
              className={`py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 ${
                isDark 
                  ? 'bg-white/10 text-white hover:bg-white/20' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title="Copy activation link to clipboard"
            >
              {copyingLink ? (
                <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-sm">content_copy</span>
              )}
              Copy Link
            </button>
          </div>
          <p className={`text-xs text-center mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            Member will complete payment via link
          </p>
        </div>

        <button
          onClick={() => {
            resetPayment();
            setStep('preview');
          }}
          className={`w-full py-2.5 mt-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
        >
          Back to Review
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onShowIdScanner}
        className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg border-2 border-dashed transition-colors ${
          isDark
            ? 'border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10'
            : 'border-emerald-500/50 text-emerald-600 hover:bg-emerald-50'
        }`}
      >
        <span className="material-symbols-outlined text-xl">photo_camera</span>
        <span className="text-sm font-medium">Scan Driver's License / ID</span>
      </button>
      {scannedIdImage && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
          isDark ? 'bg-emerald-900/30 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
        }`}>
          <span className="material-symbols-outlined text-sm">check_circle</span>
          ID scanned — fields auto-filled
        </div>
      )}
      <div className="space-y-1">
        <label className={labelClass}>Membership Tier *</label>
        <select
          value={form.tierId || ''}
          onChange={(e) => {
            setForm(prev => ({ ...prev, tierId: Number(e.target.value) || null }));
            if (fieldErrors.tierId) setFieldErrors(prev => ({ ...prev, tierId: '' }));
          }}
          className={getInputClass('tierId')}
        >
          <option value="">Select a tier...</option>
          {tiers.map(tier => (
            <option key={tier.id} value={tier.id}>
              {tier.name} - ${(tier.priceCents / 100).toFixed(2)}/mo
            </option>
          ))}
        </select>
        {fieldErrors.tierId && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.tierId}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className={labelClass}>First Name *</label>
          <input
            type="text"
            value={form.firstName}
            onChange={(e) => {
              setForm(prev => ({ ...prev, firstName: e.target.value }));
              if (fieldErrors.firstName) setFieldErrors(prev => ({ ...prev, firstName: '' }));
            }}
            placeholder="First name"
            className={getInputClass('firstName')}
          />
          {fieldErrors.firstName && (
            <p className={errorMsgClass}>
              <span className="material-symbols-outlined text-xs">error</span>
              {fieldErrors.firstName}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label className={labelClass}>Last Name *</label>
          <input
            type="text"
            value={form.lastName}
            onChange={(e) => {
              setForm(prev => ({ ...prev, lastName: e.target.value }));
              if (fieldErrors.lastName) setFieldErrors(prev => ({ ...prev, lastName: '' }));
            }}
            placeholder="Last name"
            className={getInputClass('lastName')}
          />
          {fieldErrors.lastName && (
            <p className={errorMsgClass}>
              <span className="material-symbols-outlined text-xs">error</span>
              {fieldErrors.lastName}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass}>Email *</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => {
            setForm(prev => ({ ...prev, email: e.target.value }));
            if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: '' }));
          }}
          placeholder="email@example.com"
          className={getInputClass('email')}
        />
        {fieldErrors.email && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.email}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className={labelClass}>Phone *</label>
        <input
          type="tel"
          value={formatPhoneInput(form.phone)}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
            setForm(prev => ({ ...prev, phone: digits }));
            if (fieldErrors.phone) setFieldErrors(prev => ({ ...prev, phone: '' }));
          }}
          placeholder="(555) 123-4567"
          className={getInputClass('phone')}
        />
        {fieldErrors.phone && (
          <p className={errorMsgClass}>
            <span className="material-symbols-outlined text-xs">error</span>
            {fieldErrors.phone}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Date of Birth</label>
        <input
          type="date"
          value={form.dob}
          onChange={(e) => setForm(prev => ({ ...prev, dob: e.target.value }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Discount Code</label>
        <select
          value={form.discountCode}
          onChange={(e) => setForm(prev => ({ ...prev, discountCode: e.target.value }))}
          className={inputClass}
        >
          <option value="">No discount</option>
          {discounts.map(discount => (
            <option key={discount.id} value={discount.code}>
              {discount.code} ({discount.percentOff}% off)
            </option>
          ))}
        </select>
      </div>

      {existingBillingGroups.length > 0 && (
        <div className={`p-4 rounded-lg ${isDark ? 'bg-blue-900/20 border border-blue-700' : 'bg-blue-50 border border-blue-200'}`}>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.joinExistingGroup}
              onChange={(e) => {
                setForm(prev => ({
                  ...prev,
                  joinExistingGroup: e.target.checked,
                  existingGroupId: e.target.checked ? null : null,
                  existingGroupType: null,
                  addGroupMembers: false,
                  groupMembers: [],
                }));
              }}
              className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Add to Existing Billing Group?
              </span>
              <p className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                Add this member to an existing family or corporate billing group
              </p>
            </div>
          </label>

          {form.joinExistingGroup && (
            <div className="mt-4">
              <label className={labelClass}>Select Billing Group</label>
              <select
                value={form.existingGroupId ?? ''}
                onChange={(e) => {
                  const groupId = e.target.value ? parseInt(e.target.value, 10) : null;
                  const selectedGroup = existingBillingGroups.find(g => g.id === groupId);
                  setForm(prev => ({
                    ...prev,
                    existingGroupId: groupId,
                    existingGroupType: selectedGroup?.groupType || null,
                  }));
                }}
                className={inputClass}
              >
                <option value="">Select a group...</option>
                {existingBillingGroups.map(group => (
                  <option key={group.id} value={group.id}>
                    {group.groupName || group.primaryName} ({group.primaryEmail}) - {group.groupType}
                  </option>
                ))}
              </select>
              {form.existingGroupId && (
                <p className={`mt-2 text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
                  <span className="material-symbols-outlined text-sm align-middle mr-1">info</span>
                  Member will be billed through the group's primary account with 20% family discount
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!form.joinExistingGroup && (
        <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.addGroupMembers}
              onChange={(e) => {
                setForm(prev => ({
                  ...prev,
                  addGroupMembers: e.target.checked,
                  groupMembers: e.target.checked ? [{ firstName: '', lastName: '', email: '', phone: '', dob: '', tierId: prev.tierId, streetAddress: '', city: '', state: '', zipCode: '' }] : [],
                }));
              }}
              className="w-5 h-5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <div>
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Add Group Members?
              </span>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                Family members get 20% off their membership
              </p>
            </div>
          </label>

          {form.addGroupMembers && (
            <div className="mt-4 space-y-4">
              {form.groupMembers.map((member, index) => (
                <div key={index} className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'} border ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                      Sub-Member {index + 1}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setScanningSubMemberIndex(index);
                          setShowIdScanner(true);
                        }}
                        className="text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1"
                      >
                        <span className="material-symbols-outlined text-sm">badge</span>
                        Scan ID
                      </button>
                      <button
                        onClick={() => removeGroupMember(index)}
                        className="text-red-500 hover:text-red-600"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  </div>
                  <div className="mb-2">
                    <select
                      value={member.tierId ?? ''}
                      onChange={(e) => updateGroupMember(index, 'tierId', e.target.value)}
                      className={`${inputClass} text-sm py-2`}
                    >
                      <option value="">Select tier...</option>
                      {tiers.map(tier => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name} - ${(tier.priceCents * 0.8 / 100).toFixed(2)}/mo (20% off)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={member.firstName}
                      onChange={(e) => updateGroupMember(index, 'firstName', e.target.value)}
                      placeholder="First name"
                      className={`${inputClass} text-sm py-2`}
                    />
                    <input
                      type="text"
                      value={member.lastName}
                      onChange={(e) => updateGroupMember(index, 'lastName', e.target.value)}
                      placeholder="Last name"
                      className={`${inputClass} text-sm py-2`}
                    />
                    <input
                      type="email"
                      value={member.email}
                      onChange={(e) => updateGroupMember(index, 'email', e.target.value)}
                      placeholder="Email"
                      className={`${inputClass} text-sm py-2`}
                    />
                    <input
                      type="tel"
                      value={formatPhoneInput(member.phone)}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                        updateGroupMember(index, 'phone', digits);
                      }}
                      placeholder="Phone"
                      className={`${inputClass} text-sm py-2`}
                    />
                  </div>
                  <div className="mt-2">
                    <input
                      type="date"
                      value={member.dob}
                      onChange={(e) => updateGroupMember(index, 'dob', e.target.value)}
                      placeholder="Date of birth"
                      className={`${inputClass} text-sm py-2`}
                    />
                  </div>
                  {subMemberScannedIds[index] && (
                    <div className={`flex items-center gap-2 mt-2 text-xs ${
                      isDark ? 'text-emerald-400' : 'text-emerald-600'
                    }`}>
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      ID scanned
                    </div>
                  )}
                </div>
              ))}
              <button
                onClick={addGroupMember}
                className={`w-full py-2 rounded-lg border-2 border-dashed transition-colors ${
                  isDark 
                    ? 'border-white/20 text-gray-400 hover:border-white/40' 
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                <span className="material-symbols-outlined text-sm mr-1 align-middle">add</span>
                Add Another Member
              </button>
            </div>
          )}
        </div>
      )}

      <button
        onClick={handleReviewCharges}
        disabled={!form.tierId || !form.firstName || !form.lastName || !form.email || !form.phone}
        className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Review Charges
      </button>
    </div>
  );
}

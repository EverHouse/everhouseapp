import React, { useState, useEffect, useCallback, useRef } from 'react';
import { loadStripe, Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { useTheme } from '../../../contexts/ThemeContext';
import { useBottomNav } from '../../../contexts/BottomNavContext';
import { useToast } from '../../Toast';
import { SimpleCheckoutForm } from '../../stripe/StripePaymentForm';
import { SlideUpDrawer } from '../../SlideUpDrawer';

let stripePromise: Promise<Stripe | null> | null = null;

async function getStripePromise(): Promise<Stripe | null> {
  if (stripePromise) return stripePromise;
  
  try {
    const res = await fetch('/api/stripe/config', { credentials: 'include' });
    if (!res.ok) return null;
    const { publishableKey } = await res.json();
    if (!publishableKey) return null;
    stripePromise = loadStripe(publishableKey);
    return stripePromise;
  } catch {
    return null;
  }
}

type Mode = 'member' | 'visitor';
type MemberStep = 'form' | 'preview' | 'payment' | 'success';
type VisitorStep = 'form' | 'payment' | 'success';

interface MembershipTier {
  id: number;
  name: string;
  slug: string;
  priceCents: number;
  stripePriceId: string | null;
  productType: string;
}

interface DayPassProduct {
  id: string;
  name: string;
  priceCents: number;
  stripePriceId: string;
}

interface GroupMember {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  tierId: number | null;
}

interface ExistingBillingGroup {
  id: number;
  primaryEmail: string;
  primaryName: string;
  groupName: string | null;
  groupType: 'family' | 'corporate';
  isActive: boolean;
  primaryStripeSubscriptionId: string | null;
  memberCount: number;
}

interface MemberFormData {
  tierId: number | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  discountCode: string;
  addGroupMembers: boolean;
  groupMembers: GroupMember[];
  joinExistingGroup: boolean;
  existingGroupId: number | null;
  existingGroupType: 'family' | 'corporate' | null;
}

interface VisitorFormData {
  productId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  notes: string;
}

interface NewUserDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (userData: { id: string; email: string; name: string; mode: Mode }) => void;
  onBookNow?: (visitorData: { id: string; email: string; name: string; phone: string }) => void;
  defaultMode?: Mode;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[\d\s\-\+\(\)\.]+$/;

const initialMemberForm: MemberFormData = {
  tierId: null,
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dob: '',
  discountCode: '',
  addGroupMembers: false,
  groupMembers: [],
  joinExistingGroup: false,
  existingGroupId: null,
  existingGroupType: null,
};

const initialVisitorForm: VisitorFormData = {
  productId: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dob: '',
  notes: '',
};

export function NewUserDrawer({
  isOpen,
  onClose,
  onSuccess,
  onBookNow,
  defaultMode = 'member',
}: NewUserDrawerProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const { setDrawerOpen } = useBottomNav();
  const { showToast } = useToast();
  
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [memberStep, setMemberStep] = useState<MemberStep>('form');
  const [visitorStep, setVisitorStep] = useState<VisitorStep>('form');
  
  const [memberForm, setMemberForm] = useState<MemberFormData>(initialMemberForm);
  const [visitorForm, setVisitorForm] = useState<VisitorFormData>(initialVisitorForm);
  
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [dayPassProducts, setDayPassProducts] = useState<DayPassProduct[]>([]);
  const [discounts, setDiscounts] = useState<{ id: string; code: string; percentOff: number }[]>([]);
  const [existingBillingGroups, setExistingBillingGroups] = useState<ExistingBillingGroup[]>([]);
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [createdUser, setCreatedUser] = useState<{ id: string; email: string; name: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDrawerOpen(true);
      fetchInitialData();
    } else {
      setDrawerOpen(false);
      resetForm();
    }
  }, [isOpen, setDrawerOpen]);

  const resetForm = useCallback(() => {
    setMode(defaultMode);
    setMemberStep('form');
    setVisitorStep('form');
    setMemberForm(initialMemberForm);
    setVisitorForm(initialVisitorForm);
    setError(null);
    setCreatedUser(null);
  }, [defaultMode]);

  const fetchInitialData = async () => {
    try {
      const [tiersRes, productsRes, discountsRes, billingGroupsRes] = await Promise.all([
        fetch('/api/membership-tiers?active=true', { credentials: 'include' }),
        fetch('/api/day-passes/products', { credentials: 'include' }),
        fetch('/api/stripe/coupons', { credentials: 'include' }),
        fetch('/api/group-billing/groups', { credentials: 'include' }),
      ]);

      if (tiersRes.ok) {
        const tiersData = await tiersRes.json();
        const subscriptionTiers = tiersData
          .filter((t: any) => t.product_type === 'subscription' && t.stripe_price_id)
          .map((t: any) => ({
            id: t.id,
            name: t.name,
            slug: t.slug,
            priceCents: t.price_cents,
            stripePriceId: t.stripe_price_id,
            productType: t.product_type,
          }));
        setTiers(subscriptionTiers);
      }

      if (productsRes.ok) {
        const productsData = await productsRes.json();
        setDayPassProducts(productsData.products || []);
      }

      if (discountsRes.ok) {
        const discountsData = await discountsRes.json();
        setDiscounts(discountsData.coupons || []);
      }

      if (billingGroupsRes.ok) {
        const groupsData = await billingGroupsRes.json();
        const activeGroups = (groupsData || [])
          .filter((g: any) => g.isActive && g.stripeSubscriptionId)
          .map((g: any) => ({
            id: g.id,
            primaryEmail: g.primaryEmail,
            primaryName: g.primaryName,
            groupName: g.groupName,
            groupType: g.type || 'family',
            isActive: g.isActive,
            primaryStripeSubscriptionId: g.stripeSubscriptionId,
            memberCount: g.members?.length || 0,
          }));
        setExistingBillingGroups(activeGroups);
      }
    } catch (err) {
      console.error('Failed to fetch initial data:', err);
    }
  };

  const handleClose = useCallback(() => {
    setDrawerOpen(false);
    onClose();
  }, [onClose, setDrawerOpen]);

  const handleModeChange = (newMode: Mode) => {
    setMode(newMode);
    setError(null);
  };

  const currentStep = mode === 'member' ? memberStep : visitorStep;
  const stepLabels = mode === 'member' 
    ? ['Details', 'Review', 'Payment', 'Done']
    : ['Details', 'Payment', 'Done'];

  const getStepIndex = () => {
    if (mode === 'member') {
      return ['form', 'preview', 'payment', 'success'].indexOf(memberStep);
    }
    return ['form', 'payment', 'success'].indexOf(visitorStep);
  };

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={handleClose}
      title="Add New User"
      maxHeight="full"
    >
      <div className="px-4 pt-2 pb-4">
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => handleModeChange('member')}
            className={`flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
              mode === 'member'
                ? 'bg-emerald-600 text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <span className="material-symbols-outlined text-sm mr-1.5 align-middle">badge</span>
            New Member
          </button>
          <button
            onClick={() => handleModeChange('visitor')}
            className={`flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
              mode === 'visitor'
                ? 'bg-emerald-600 text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <span className="material-symbols-outlined text-sm mr-1.5 align-middle">person_add</span>
            New Visitor
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          {stepLabels.map((label, index) => (
            <React.Fragment key={label}>
              <div className="flex items-center gap-1.5">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                  index <= getStepIndex()
                    ? 'bg-emerald-600 text-white'
                    : isDark
                      ? 'bg-white/10 text-gray-500'
                      : 'bg-gray-200 text-gray-400'
                }`}>
                  {index < getStepIndex() ? (
                    <span className="material-symbols-outlined text-sm">check</span>
                  ) : (
                    index + 1
                  )}
                </div>
                <span className={`text-xs ${
                  index <= getStepIndex()
                    ? isDark ? 'text-white' : 'text-gray-900'
                    : isDark ? 'text-gray-500' : 'text-gray-400'
                }`}>
                  {label}
                </span>
              </div>
              {index < stepLabels.length - 1 && (
                <div className={`flex-1 h-0.5 ${
                  index < getStepIndex()
                    ? 'bg-emerald-600'
                    : isDark ? 'bg-white/10' : 'bg-gray-200'
                }`} />
              )}
            </React.Fragment>
          ))}
        </div>

        {error && (
          <div className={`mb-4 p-3 rounded-lg ${
            isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'
          }`}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-lg">error</span>
              <span className="text-sm">{error}</span>
            </div>
          </div>
        )}

        {mode === 'member' ? (
          <MemberFlow
            step={memberStep}
            form={memberForm}
            setForm={setMemberForm}
            tiers={tiers}
            discounts={discounts}
            existingBillingGroups={existingBillingGroups}
            isDark={isDark}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
            setError={setError}
            setStep={setMemberStep}
            onSuccess={(user) => {
              setCreatedUser(user);
              setMemberStep('success');
              onSuccess?.({ ...user, mode: 'member' });
            }}
            createdUser={createdUser}
            onClose={handleClose}
            showToast={showToast}
          />
        ) : (
          <VisitorFlow
            step={visitorStep}
            form={visitorForm}
            setForm={setVisitorForm}
            products={dayPassProducts}
            isDark={isDark}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
            setError={setError}
            setStep={setVisitorStep}
            onSuccess={(user) => {
              setCreatedUser(user);
              setVisitorStep('success');
              onSuccess?.({ ...user, mode: 'visitor' });
            }}
            createdUser={createdUser}
            onClose={handleClose}
            showToast={showToast}
            onBookNow={() => {
              if (createdUser) {
                onBookNow?.({
                  id: createdUser.id,
                  email: createdUser.email,
                  name: createdUser.name,
                  phone: visitorForm.phone,
                });
                handleClose();
              }
            }}
          />
        )}
      </div>
    </SlideUpDrawer>
  );
}

interface MemberFlowProps {
  step: MemberStep;
  form: MemberFormData;
  setForm: React.Dispatch<React.SetStateAction<MemberFormData>>;
  tiers: MembershipTier[];
  discounts: { id: string; code: string; percentOff: number }[];
  existingBillingGroups: ExistingBillingGroup[];
  isDark: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setStep: (step: MemberStep) => void;
  onSuccess: (user: { id: string; email: string; name: string }) => void;
  createdUser: { id: string; email: string; name: string } | null;
  onClose: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

function MemberFlow({
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
  setStep,
  onSuccess,
  createdUser,
  onClose,
  showToast,
}: MemberFlowProps) {
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const paymentInitiatedRef = useRef(false);

  const inputClass = `w-full px-3 py-2.5 rounded-lg border ${
    isDark 
      ? 'bg-white/5 border-white/20 text-white placeholder-gray-500 focus:border-emerald-500' 
      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-emerald-500'
  } focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors`;

  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`;

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

      const discount = discounts.find(d => d.code === form.discountCode);
      const discountPercent = discount?.percentOff || 0;
      const primaryPrice = form.joinExistingGroup
        ? Math.round(selectedTier.priceCents * 0.8)
        : Math.round(selectedTier.priceCents * (1 - discountPercent / 100));
      
      const groupMembersTotal = form.groupMembers.reduce((sum, member) => {
        const memberTier = tiers.find(t => t.id === member.tierId) || selectedTier;
        return sum + Math.round(memberTier.priceCents * 0.8);
      }, 0);
      
      const totalPrice = primaryPrice + groupMembersTotal;

      const res = await fetch('/api/stripe/staff/quick-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: form.email,
          memberName: `${form.firstName} ${form.lastName}`,
          amountCents: totalPrice,
          description: form.joinExistingGroup 
            ? `${selectedTier.name} Membership (Group Add-on)` 
            : `${selectedTier.name} Membership Setup`,
          isNewCustomer: true,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create payment');
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
    } catch (err: any) {
      setStripeError(err.message || 'Failed to initialize payment');
      paymentInitiatedRef.current = false;
    } finally {
      setStripeLoading(false);
    }
  };

  const handlePaymentSuccess = async (paymentIntentIdResult?: string) => {
    if (!paymentIntentId && !paymentIntentIdResult) return;
    setIsLoading(true);
    
    try {
      await fetch('/api/stripe/staff/quick-charge/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId: paymentIntentIdResult || paymentIntentId })
      });

      if (form.joinExistingGroup && form.existingGroupId && selectedTier) {
        try {
          const endpoint = form.existingGroupType === 'corporate'
            ? `/api/group-billing/groups/${form.existingGroupId}/corporate-members`
            : `/api/family-billing/groups/${form.existingGroupId}/members`;
          
          const payload = form.existingGroupType === 'corporate'
            ? { memberEmail: form.email, memberTier: selectedTier.slug }
            : { memberEmail: form.email, memberTier: selectedTier.slug, relationship: 'family' };
          
          const groupRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
          });
          
          if (!groupRes.ok) {
            const groupData = await groupRes.json();
            console.error('Failed to add member to group:', groupData.error);
            showToast('Payment successful but failed to add to group. Contact support.', 'error');
          } else {
            showToast('Payment successful! Member added to billing group.', 'success');
          }
        } catch (groupErr) {
          console.error('Error adding member to group:', groupErr);
          showToast('Payment successful but failed to add to group. Contact support.', 'error');
        }
      } else {
        showToast('Payment successful!', 'success');
      }

      onSuccess({ 
        id: 'member-' + Date.now(), 
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
    setIsLoading(true);
    setError(null);
    
    try {
      showToast('Activation link functionality coming soon', 'info');
      onSuccess({ 
        id: 'pending-' + Date.now(), 
        email: form.email, 
        name: `${form.firstName} ${form.lastName}` 
      });
    } catch (err: any) {
      setError(err.message || 'Failed to send activation link');
    } finally {
      setIsLoading(false);
    }
  };

  const resetPayment = () => {
    paymentInitiatedRef.current = false;
    setClientSecret(null);
    setPaymentIntentId(null);
    setStripeError(null);
  };

  const handleReviewCharges = () => {
    if (!form.tierId || !form.firstName || !form.lastName || !form.email || !form.phone) {
      setError('Please fill in all required fields');
      return;
    }
    if (!EMAIL_REGEX.test(form.email)) {
      setError('Please enter a valid email address');
      return;
    }
    if (form.joinExistingGroup && !form.existingGroupId) {
      setError('Please select a billing group to join');
      return;
    }
    setError(null);
    setStep('preview');
  };

  const addGroupMember = () => {
    setForm(prev => ({
      ...prev,
      groupMembers: [...prev.groupMembers, { firstName: '', lastName: '', email: '', phone: '', dob: '', tierId: prev.tierId }],
    }));
  };

  const removeGroupMember = (index: number) => {
    setForm(prev => ({
      ...prev,
      groupMembers: prev.groupMembers.filter((_, i) => i !== index),
    }));
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
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Initializing payment...
            </p>
          </div>
        )}

        <div className={`pt-2 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <button
            onClick={handleSendActivationLink}
            disabled={isLoading}
            className={`w-full py-3 rounded-lg font-medium transition-colors ${
              isDark 
                ? 'bg-white/10 text-white hover:bg-white/20' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <span className="material-symbols-outlined text-sm mr-1.5 align-middle">mail</span>
            Send Activation Link Instead
          </button>
          <p className={`text-xs text-center mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            Member will complete payment via email
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
      <div>
        <label className={labelClass}>Membership Tier *</label>
        <select
          value={form.tierId || ''}
          onChange={(e) => setForm(prev => ({ ...prev, tierId: Number(e.target.value) || null }))}
          className={inputClass}
        >
          <option value="">Select a tier...</option>
          {tiers.map(tier => (
            <option key={tier.id} value={tier.id}>
              {tier.name} - ${(tier.priceCents / 100).toFixed(2)}/mo
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>First Name *</label>
          <input
            type="text"
            value={form.firstName}
            onChange={(e) => setForm(prev => ({ ...prev, firstName: e.target.value }))}
            placeholder="First name"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Last Name *</label>
          <input
            type="text"
            value={form.lastName}
            onChange={(e) => setForm(prev => ({ ...prev, lastName: e.target.value }))}
            placeholder="Last name"
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Email *</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
          placeholder="email@example.com"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Phone *</label>
        <input
          type="tel"
          value={form.phone}
          onChange={(e) => setForm(prev => ({ ...prev, phone: e.target.value }))}
          placeholder="(555) 123-4567"
          className={inputClass}
        />
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
                  groupMembers: e.target.checked ? [{ firstName: '', lastName: '', email: '', phone: '', dob: '', tierId: prev.tierId }] : [],
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
                    <button
                      onClick={() => removeGroupMember(index)}
                      className="text-red-500 hover:text-red-600"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
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
                      value={member.phone}
                      onChange={(e) => updateGroupMember(index, 'phone', e.target.value)}
                      placeholder="Phone"
                      className={`${inputClass} text-sm py-2`}
                    />
                  </div>
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

interface VisitorFlowProps {
  step: VisitorStep;
  form: VisitorFormData;
  setForm: React.Dispatch<React.SetStateAction<VisitorFormData>>;
  products: DayPassProduct[];
  isDark: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setStep: (step: VisitorStep) => void;
  onSuccess: (user: { id: string; email: string; name: string }) => void;
  createdUser: { id: string; email: string; name: string } | null;
  onClose: () => void;
  onBookNow: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

function VisitorFlow({
  step,
  form,
  setForm,
  products,
  isDark,
  isLoading,
  setIsLoading,
  setError,
  setStep,
  onSuccess,
  createdUser,
  onClose,
  onBookNow,
  showToast,
}: VisitorFlowProps) {
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const paymentInitiatedRef = useRef(false);

  const selectedProduct = products.find(p => p.id === form.productId);

  useEffect(() => {
    if (step === 'payment' && selectedProduct && !paymentInitiatedRef.current) {
      initializePayment();
    }
  }, [step, selectedProduct]);

  const initializePayment = async () => {
    if (paymentInitiatedRef.current || !selectedProduct) return;
    paymentInitiatedRef.current = true;
    setStripeLoading(true);
    setStripeError(null);

    try {
      const stripe = await getStripePromise();
      if (!stripe) {
        throw new Error('Stripe is not configured');
      }
      setStripeInstance(stripe);

      const res = await fetch('/api/day-passes/staff-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          productSlug: form.productId,  // productId contains the slug
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create payment');
      }

      const data = await res.json();
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
    } catch (err: any) {
      setStripeError(err.message || 'Failed to initialize payment');
      paymentInitiatedRef.current = false;
    } finally {
      setStripeLoading(false);
    }
  };

  const handlePaymentSuccess = async (paymentIntentIdResult?: string) => {
    if (!paymentIntentId && !paymentIntentIdResult) return;
    setIsLoading(true);
    
    try {
      const confirmRes = await fetch('/api/day-passes/staff-checkout/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentIntentId: paymentIntentIdResult || paymentIntentId })
      });

      if (!confirmRes.ok) {
        throw new Error('Failed to confirm purchase');
      }

      const confirmData = await confirmRes.json();
      showToast('Day pass purchased successfully!', 'success');
      onSuccess({
        id: confirmData.userId || 'visitor-' + Date.now(),
        email: form.email,
        name: `${form.firstName} ${form.lastName}`
      });
    } catch (err: any) {
      setError('Payment confirmation failed. Please contact support.');
    } finally {
      setIsLoading(false);
    }
  };

  const resetPayment = () => {
    paymentInitiatedRef.current = false;
    setClientSecret(null);
    setPaymentIntentId(null);
    setStripeError(null);
  };

  const inputClass = `w-full px-3 py-2.5 rounded-lg border ${
    isDark 
      ? 'bg-white/5 border-white/20 text-white placeholder-gray-500 focus:border-emerald-500' 
      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-emerald-500'
  } focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors`;

  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`;

  const handleProceedToPayment = () => {
    if (!form.productId || !form.firstName || !form.lastName || !form.email || !form.phone) {
      setError('Please fill in all required fields');
      return;
    }
    if (!EMAIL_REGEX.test(form.email)) {
      setError('Please enter a valid email address');
      return;
    }
    setError(null);
    setStep('payment');
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
          Day Pass Purchased!
        </h3>
        <p className={`text-sm mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          {createdUser?.name}'s day pass is ready. Would you like to book their session now?
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className={`flex-1 py-2.5 rounded-lg font-medium transition-colors ${
              isDark 
                ? 'bg-white/10 text-white hover:bg-white/20' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Done
          </button>
          <button
            onClick={onBookNow}
            className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors"
          >
            <span className="material-symbols-outlined text-sm mr-1 align-middle">calendar_add_on</span>
            Book Now
          </button>
        </div>
      </div>
    );
  }

  if (step === 'payment') {
    const totalPrice = selectedProduct?.priceCents || 0;

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
            <div>
              <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {selectedProduct?.name}
              </p>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                for {form.firstName} {form.lastName}
              </p>
            </div>
            <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              ${(totalPrice / 100).toFixed(2)}
            </span>
          </div>
        </div>

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
              submitLabel={`Pay $${(totalPrice / 100).toFixed(2)}`}
            />
          </Elements>
        )}

        {!stripeLoading && !stripeError && !clientSecret && (
          <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Initializing payment...
            </p>
          </div>
        )}

        <button
          onClick={() => {
            resetPayment();
            setStep('form');
          }}
          className={`w-full py-2.5 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
        >
          Back to Details
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className={labelClass}>Day Pass Product *</label>
        <select
          value={form.productId}
          onChange={(e) => setForm(prev => ({ ...prev, productId: e.target.value }))}
          className={inputClass}
        >
          <option value="">Select a product...</option>
          {products.map(product => (
            <option key={product.id} value={product.id}>
              {product.name} - ${(product.priceCents / 100).toFixed(2)}
            </option>
          ))}
        </select>
      </div>

      {selectedProduct && (
        <div className={`p-3 rounded-lg ${isDark ? 'bg-emerald-900/20 border border-emerald-700' : 'bg-emerald-50 border border-emerald-200'}`}>
          <div className="flex justify-between items-center">
            <span className={`text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
              Amount to charge:
            </span>
            <span className={`font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
              ${(selectedProduct.priceCents / 100).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>First Name *</label>
          <input
            type="text"
            value={form.firstName}
            onChange={(e) => setForm(prev => ({ ...prev, firstName: e.target.value }))}
            placeholder="First name"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Last Name *</label>
          <input
            type="text"
            value={form.lastName}
            onChange={(e) => setForm(prev => ({ ...prev, lastName: e.target.value }))}
            placeholder="Last name"
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Email *</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
          placeholder="email@example.com"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Phone *</label>
        <input
          type="tel"
          value={form.phone}
          onChange={(e) => setForm(prev => ({ ...prev, phone: e.target.value }))}
          placeholder="(555) 123-4567"
          className={inputClass}
        />
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
        <label className={labelClass}>Notes</label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
          placeholder="Any additional notes about this visitor..."
          rows={3}
          className={inputClass}
        />
      </div>

      <button
        onClick={handleProceedToPayment}
        disabled={!form.productId || !form.firstName || !form.lastName || !form.email || !form.phone}
        className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Proceed to Payment
      </button>
    </div>
  );
}

export default NewUserDrawer;

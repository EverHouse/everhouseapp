import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../../../contexts/ThemeContext';
import { useBottomNav } from '../../../contexts/BottomNavContext';
import { useToast } from '../../Toast';
import { SlideUpDrawer } from '../../SlideUpDrawer';
import { formatPhoneInput } from '../../../utils/formatting';
import IdScannerModal from '../modals/IdScannerModal';
import { MemberFlow } from './newUser/MemberFlow';
import { VisitorFlow } from './newUser/VisitorFlow';
import {
  Mode,
  MemberStep,
  VisitorStep,
  MemberFormData,
  VisitorFormData,
  MembershipTier,
  DayPassProduct,
  ExistingBillingGroup,
  NewUserDrawerProps,
  initialMemberForm,
  initialVisitorForm,
} from './newUser/newUserTypes';

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
  const [pendingUserToCleanup, setPendingUserToCleanup] = useState<{ id: string; name: string } | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  
  const [createdUser, setCreatedUser] = useState<{ id: string; email: string; name: string } | null>(null);
  const [showIdScanner, setShowIdScanner] = useState(false);
  const [scannedIdImage, setScannedIdImage] = useState<{ base64: string; mimeType: string } | null>(null);
  const [subMemberScannedIds, setSubMemberScannedIds] = useState<Record<number, { base64: string; mimeType: string }>>({});
  const [scanningSubMemberIndex, setScanningSubMemberIndex] = useState<number | null>(null);

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
    setMemberStep('form');
    setVisitorStep('form');
    setMemberForm(initialMemberForm);
    setVisitorForm(initialVisitorForm);
    setError(null);
    setPendingUserToCleanup(null);
    setCreatedUser(null);
    setScannedIdImage(null);
    setSubMemberScannedIds({});
    setScanningSubMemberIndex(null);
  }, [defaultMode]);
  
  const handleCleanupPendingUser = async () => {
    if (!pendingUserToCleanup) return;
    setIsCleaningUp(true);
    try {
      const res = await fetch(`/api/stripe/subscriptions/cleanup-pending/${pendingUserToCleanup.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        setError(null);
        setPendingUserToCleanup(null);
        showToast?.(`Cleaned up incomplete signup. You can now proceed.`, 'success');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cleanup');
      }
    } catch (err) {
      setError('Failed to cleanup pending user');
    } finally {
      setIsCleaningUp(false);
    }
  };

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

  const handleIdScanComplete = useCallback((data: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
    imageBase64: string;
    imageMimeType: string;
  }) => {
    if (scanningSubMemberIndex !== null) {
      const index = scanningSubMemberIndex;
      setSubMemberScannedIds(prev => ({
        ...prev,
        [index]: { base64: data.imageBase64, mimeType: data.imageMimeType },
      }));
      setMemberForm(prev => ({
        ...prev,
        groupMembers: prev.groupMembers.map((m, i) => 
          i === index ? {
            ...m,
            firstName: data.firstName || m.firstName,
            lastName: data.lastName || m.lastName,
            dob: data.dateOfBirth || m.dob,
            streetAddress: data.streetAddress || m.streetAddress,
            city: data.city || m.city,
            state: data.state || m.state,
            zipCode: data.zipCode || m.zipCode,
          } : m
        ),
      }));
      setScanningSubMemberIndex(null);
      setShowIdScanner(false);
      return;
    }
    setScannedIdImage({ base64: data.imageBase64, mimeType: data.imageMimeType });
    if (mode === 'member') {
      setMemberForm(prev => ({
        ...prev,
        firstName: data.firstName || prev.firstName,
        lastName: data.lastName || prev.lastName,
        dob: data.dateOfBirth || prev.dob,
        streetAddress: data.streetAddress || prev.streetAddress,
        city: data.city || prev.city,
        state: data.state || prev.state,
        zipCode: data.zipCode || prev.zipCode,
      }));
    } else {
      setVisitorForm(prev => ({
        ...prev,
        firstName: data.firstName || prev.firstName,
        lastName: data.lastName || prev.lastName,
        dob: data.dateOfBirth || prev.dob,
        streetAddress: data.streetAddress || prev.streetAddress,
        city: data.city || prev.city,
        state: data.state || prev.state,
        zipCode: data.zipCode || prev.zipCode,
      }));
    }
    setShowIdScanner(false);
  }, [mode, scanningSubMemberIndex]);

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
    <>
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
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
              mode === 'member'
                ? 'bg-emerald-600 text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            <span className="material-symbols-outlined text-sm align-middle mr-1">badge</span>
            New Member
          </button>
          <button
            onClick={() => handleModeChange('visitor')}
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
              mode === 'visitor'
                ? 'bg-emerald-600 text-white'
                : isDark
                  ? 'bg-white/5 text-gray-400 hover:bg-white/10'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            <span className="material-symbols-outlined text-sm align-middle mr-1">confirmation_number</span>
            Day Pass
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
            {pendingUserToCleanup && (
              <button
                onClick={handleCleanupPendingUser}
                disabled={isCleaningUp}
                className={`mt-2 w-full py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                  isDark
                    ? 'bg-amber-600 hover:bg-amber-500 text-white disabled:bg-amber-800'
                    : 'bg-amber-500 hover:bg-amber-600 text-white disabled:bg-amber-300'
                }`}
              >
                {isCleaningUp ? 'Cleaning up...' : 'Clean Up & Try Again'}
              </button>
            )}
          </div>
        )}

        {mode === 'member' ? (
        <MemberFlow
          step={memberStep}
          setPendingUserToCleanup={setPendingUserToCleanup}
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
            if (scannedIdImage) {
              fetch('/api/admin/save-id-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  userId: user.id,
                  image: scannedIdImage.base64,
                  mimeType: scannedIdImage.mimeType,
                }),
              }).catch(err => console.error('Failed to save ID image:', err));
            }
          }}
          createdUser={createdUser}
          onClose={handleClose}
          showToast={showToast}
          scannedIdImage={scannedIdImage}
          onShowIdScanner={() => setShowIdScanner(true)}
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
          onBookNow={onBookNow}
          showToast={showToast}
          scannedIdImage={scannedIdImage}
          onShowIdScanner={() => setShowIdScanner(true)}
        />
        )}
      </div>
    </SlideUpDrawer>
    <IdScannerModal
      isOpen={showIdScanner}
      onClose={() => { setShowIdScanner(false); setScanningSubMemberIndex(null); }}
      onScanComplete={handleIdScanComplete}
      isDark={isDark}
    />
  </>
  );
}

export default NewUserDrawer;

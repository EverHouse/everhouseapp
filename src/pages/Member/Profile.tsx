import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { useToast } from '../../components/Toast';
import { formatPhoneNumber } from '../../utils/formatting';
import HubSpotFormModal from '../../components/HubSpotFormModal';
import { isPushSupported, isSubscribedToPush, subscribeToPush, unsubscribeFromPush } from '../../services/pushNotifications';
import Toggle from '../../components/Toggle';
import MemberBottomNav from '../../components/MemberBottomNav';
import { BottomSentinel } from '../../components/layout/BottomSentinel';
import ModalShell from '../../components/ModalShell';
import WaiverModal from '../../components/WaiverModal';
import BillingSection from '../../components/profile/BillingSection';
import { AnimatedPage } from '../../components/motion';
import { fetchWithCredentials, postWithCredentials, patchWithCredentials, putWithCredentials } from '../../hooks/queries/useFetch';
import GoogleSignInButton from '../../components/GoogleSignInButton';


const GUEST_CHECKIN_FIELDS = [
  { name: 'guest_firstname', label: 'Guest First Name', type: 'text' as const, required: true, placeholder: 'John' },
  { name: 'guest_lastname', label: 'Guest Last Name', type: 'text' as const, required: true, placeholder: 'Smith' },
  { name: 'guest_email', label: 'Guest Email', type: 'email' as const, required: true, placeholder: 'john@example.com' },
  { name: 'guest_phone', label: 'Guest Phone', type: 'tel' as const, required: false, placeholder: '(555) 123-4567' }
];

interface AccountBalanceData {
  balanceDollars: number;
  isCredit: boolean;
}

interface StaffDetailsData {
  phone?: string;
  job_title?: string;
}

interface WaiverStatusData {
  needsWaiverUpdate?: boolean;
  currentVersion?: string;
}

interface PreferencesData {
  emailOptIn: boolean | null;
  smsOptIn: boolean | null;
  smsPromoOptIn?: boolean | null;
  smsTransactionalOptIn?: boolean | null;
  smsRemindersOptIn?: boolean | null;
  doNotSellMyInfo: boolean;
  dataExportRequestedAt: string | null;
}

interface StaffAdminCheckData {
  hasPassword: boolean;
}

const Profile: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, logout, actualUser, isViewingAs, refreshUser } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { startNavigation } = useNavigationLoading();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  const [showGuestCheckin, setShowGuestCheckin] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [showSmsDetails, setShowSmsDetails] = useState(false);
  
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswordSetupBanner, setShowPasswordSetupBanner] = useState(false);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showWaiverModal, setShowWaiverModal] = useState(false);
  const [currentWaiverVersion, setCurrentWaiverVersion] = useState<string>('1.0');

  const [googleLinking, setGoogleLinking] = useState(false);
  const [googleUnlinking, setGoogleUnlinking] = useState(false);

  const isStaffOrAdminProfile = user?.role === 'admin' || user?.role === 'staff';
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;

  const { data: googleStatus, refetch: refetchGoogleStatus } = useQuery({
    queryKey: ['google-status'],
    queryFn: () => fetchWithCredentials('/api/auth/google/status'),
    enabled: !!user,
  });

  const { data: accountBalance } = useQuery({
    queryKey: ['accountBalance', user?.email],
    queryFn: () => fetchWithCredentials<AccountBalanceData>(
      `/api/my-billing/account-balance?user_email=${encodeURIComponent(user!.email)}`
    ),
    enabled: !!user?.email && !isStaffOrAdminProfile,
    staleTime: 30000,
  });

  const { data: staffAdminCheck } = useQuery({
    queryKey: ['staffAdminCheck', user?.email],
    queryFn: () => fetchWithCredentials<StaffAdminCheckData>(
      `/api/auth/check-staff-admin?email=${encodeURIComponent(user!.email)}`
    ),
    enabled: !!user?.email && isStaffOrAdminProfile,
  });

  const { data: staffDetails } = useQuery({
    queryKey: ['staffDetails', user?.email],
    queryFn: () => fetchWithCredentials<StaffDetailsData>(
      `/api/staff-users/by-email/${encodeURIComponent(user!.email)}`
    ),
    enabled: !!user?.email && isStaffOrAdminProfile,
  });

  const { data: waiverStatus } = useQuery({
    queryKey: ['waiverStatus'],
    queryFn: () => fetchWithCredentials<WaiverStatusData>('/api/waivers/status'),
    enabled: !!user?.email && !isStaffOrAdminProfile,
  });

  const { data: preferences } = useQuery({
    queryKey: ['memberPreferences', user?.email],
    queryFn: () => fetchWithCredentials<PreferencesData>(
      `/api/members/me/preferences?user_email=${encodeURIComponent(user!.email)}`
    ),
    enabled: !!user?.email && !isStaffOrAdminProfile,
  });

  const hasPassword = staffAdminCheck?.hasPassword ?? false;
  const emailOptIn = preferences?.emailOptIn ?? null;
  const smsOptIn = preferences?.smsOptIn ?? null;
  const smsPromoOptIn = preferences?.smsPromoOptIn ?? null;
  const smsTransactionalOptIn = preferences?.smsTransactionalOptIn ?? null;
  const smsRemindersOptIn = preferences?.smsRemindersOptIn ?? null;
  const doNotSellMyInfo = preferences?.doNotSellMyInfo ?? false;
  const dataExportRequestedAt = preferences?.dataExportRequestedAt ?? null;

  useEffect(() => {
    if (waiverStatus?.needsWaiverUpdate) {
      setCurrentWaiverVersion(waiverStatus.currentVersion || '1.0');
      setShowWaiverModal(true);
    }
  }, [waiverStatus]);

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  useEffect(() => {
    const handleBillingUpdate = () => {
      queryClient.invalidateQueries({ queryKey: ['accountBalance', user?.email] });
    };
    window.addEventListener('billing-update', handleBillingUpdate);
    return () => window.removeEventListener('billing-update', handleBillingUpdate);
  }, [user?.email, queryClient]);

  useEffect(() => {
    const state = location.state as { showPasswordSetup?: boolean } | null;
    if (state?.showPasswordSetup && isStaffOrAdminProfile) {
      setShowPasswordSetupBanner(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state, isStaffOrAdminProfile]);

  useEffect(() => {
    const handleTierUpdate = (event: CustomEvent) => {
      const detail = event.detail;
      if (detail?.memberEmail?.toLowerCase() === user?.email?.toLowerCase()) {
        refreshUser();
      }
    };

    window.addEventListener('tier-update', handleTierUpdate as EventListener);
    return () => window.removeEventListener('tier-update', handleTierUpdate as EventListener);
  }, [user?.email, refreshUser]);

  const setPasswordMutation = useMutation({
    mutationFn: (data: { password: string; currentPassword?: string }) =>
      postWithCredentials<{ success: boolean }>('/api/auth/set-password', data),
    onSuccess: () => {
      showToast('Password updated', 'success');
      queryClient.invalidateQueries({ queryKey: ['staffAdminCheck', user?.email] });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordSetupBanner(false);
      setTimeout(() => {
        setShowPasswordSection(false);
      }, 1500);
    },
    onError: (err: Error) => {
      showToast(err.message || 'Failed to set password', 'error');
    },
  });

  const handlePasswordSubmit = async () => {
    if (newPassword.length < 8) {
      showToast('Password must be at least 8 characters', 'error');
      return;
    }
    
    if (newPassword !== confirmPassword) {
      showToast('Passwords do not match', 'error');
      return;
    }
    
    if (hasPassword && !currentPassword) {
      showToast('Current password is required', 'error');
      return;
    }
    
    setPasswordMutation.mutate({
      password: newPassword,
      currentPassword: hasPassword ? currentPassword : undefined,
    });
  };

  useEffect(() => {
    const checkPush = async () => {
      const supported = await isPushSupported();
      setPushSupported(supported);
      if (supported) {
        const subscribed = await isSubscribedToPush();
        setPushEnabled(subscribed);
      }
    };
    checkPush();
  }, []);

  const updatePreferencesMutation = useMutation({
    mutationFn: (data: { emailOptIn?: boolean; smsOptIn?: boolean; doNotSellMyInfo?: boolean }) =>
      patchWithCredentials<{ success: boolean }>(
        `/api/members/me/preferences?user_email=${encodeURIComponent(user!.email)}`,
        data
      ),
    onSuccess: () => {
      showToast('Preferences updated', 'success');
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
    onError: () => {
      showToast('Failed to update preferences', 'error');
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
  });

  const handlePreferenceToggle = (type: 'email' | 'sms', newValue: boolean) => {
    if (!user?.email || updatePreferencesMutation.isPending) return;
    
    const body = type === 'email' ? { emailOptIn: newValue } : { smsOptIn: newValue };
    updatePreferencesMutation.mutate(body);
  };

  const updateSmsPreferencesMutation = useMutation({
    mutationFn: (data: { smsPromoOptIn?: boolean; smsTransactionalOptIn?: boolean; smsRemindersOptIn?: boolean }) =>
      putWithCredentials<{ success: boolean }>(
        `/api/members/${encodeURIComponent(user!.email)}/sms-preferences`,
        data
      ),
    onSuccess: () => {
      showToast('SMS preferences updated', 'success');
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
    onError: () => {
      showToast('Failed to update SMS preferences', 'error');
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
  });

  const handleSmsPreferenceToggle = (type: 'promo' | 'transactional' | 'reminders', newValue: boolean) => {
    if (!user?.email || updateSmsPreferencesMutation.isPending) return;
    
    const body: Record<string, boolean> = {};
    if (type === 'promo') body.smsPromoOptIn = newValue;
    else if (type === 'transactional') body.smsTransactionalOptIn = newValue;
    else body.smsRemindersOptIn = newValue;
    
    updateSmsPreferencesMutation.mutate(body);
  };

  const handleGoogleLink = async (credential: string) => {
    setGoogleLinking(true);
    try {
      const res = await postWithCredentials('/api/auth/google/link', { credential });
      if (res.error) throw new Error(res.error);
      showToast('Google account linked successfully', 'success');
      refetchGoogleStatus();
    } catch (err: any) {
      showToast(err.message || 'Failed to link Google account', 'error');
    } finally {
      setGoogleLinking(false);
    }
  };

  const handleGoogleUnlink = async () => {
    setGoogleUnlinking(true);
    try {
      const res = await postWithCredentials('/api/auth/google/unlink', {});
      if (res.error) throw new Error(res.error);
      showToast('Google account unlinked', 'success');
      refetchGoogleStatus();
    } catch (err: any) {
      showToast(err.message || 'Failed to unlink Google account', 'error');
    } finally {
      setGoogleUnlinking(false);
    }
  };

  const handlePushToggle = async (newValue: boolean) => {
    if (!user?.email || pushLoading) return;
    
    setPushLoading(true);
    try {
      if (!newValue) {
        await unsubscribeFromPush();
        setPushEnabled(false);
        showToast('Push notifications disabled', 'info');
      } else {
        const success = await subscribeToPush(user.email);
        setPushEnabled(success);
        if (success) {
          showToast('Push notifications enabled', 'success');
        } else {
          showToast('Failed to enable push notifications', 'error');
        }
      }
    } catch {
      showToast('Failed to update push notifications', 'error');
    } finally {
      setPushLoading(false);
    }
  };

  const addFundsMutation = useMutation({
    mutationFn: (amountCents: number) =>
      postWithCredentials<{ checkoutUrl?: string; error?: string }>('/api/my/add-funds', { amountCents }),
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        showToast(data.error || 'Failed to create checkout', 'error');
      }
    },
    onError: () => {
      showToast('Failed to add funds', 'error');
    },
    onSettled: () => {
      setShowAddFunds(false);
    },
  });

  const handleAddFunds = (amountCents: number) => {
    if (addFundsMutation.isPending) return;
    addFundsMutation.mutate(amountCents);
  };

  const handleDoNotSellToggle = (newValue: boolean) => {
    if (!user?.email || updatePreferencesMutation.isPending) return;
    updatePreferencesMutation.mutate({ doNotSellMyInfo: newValue });
  };

  const dataExportMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<{ requestedAt: string }>('/api/members/me/data-export-request', {}),
    onSuccess: () => {
      showToast('Data export request submitted. We will email you within 45 days.', 'success');
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
    onError: () => {
      showToast('Failed to submit data export request', 'error');
    },
  });

  const handleDataExportRequest = () => {
    if (!user?.email || dataExportMutation.isPending) return;
    dataExportMutation.mutate();
  };

  const deleteAccountMutation = useMutation({
    mutationFn: () =>
      postWithCredentials<{ success: boolean }>('/api/account/delete-request', {}),
    onSuccess: () => {
      showToast('Deletion request sent to administration', 'success');
      setShowDeleteConfirm(false);
      setShowPrivacyModal(false);
    },
    onError: () => {
      showToast('Deletion request sent to administration', 'success');
      setShowDeleteConfirm(false);
      setShowPrivacyModal(false);
    },
  });

  if (!user) return null;

  return (
    <AnimatedPage>
    <div 
      className="px-6 pb-32 min-h-screen bg-transparent md:px-8 lg:px-12 xl:px-16"
      style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'calc(var(--header-offset) + 1.5rem)' }}
    >
      <div className="space-y-6 md:max-w-2xl md:mx-auto lg:max-w-3xl xl:max-w-4xl">
         {/* Staff Portal Quick Return - mobile only */}
         {isStaffOrAdminProfile && (
           <div className="lg:hidden">
             <button
               onClick={() => { startNavigation(); navigate('/admin'); }}
               className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl transition-colors ${
                 isDark 
                   ? 'bg-white/10 hover:bg-white/15 text-white' 
                   : 'bg-primary/10 hover:bg-primary/15 text-primary'
               }`}
             >
               <span className="material-symbols-outlined text-lg">arrow_back</span>
               <span className="font-medium text-sm">Return to Staff Portal</span>
             </button>
           </div>
         )}

         {/* Account Balance Section - only for members, not staff/admin */}
         {!isStaffOrAdminProfile && (
           <Section title="Account Balance" isDark={isDark} staggerIndex={1}>
             <div className={`p-4 ${isDark ? '' : ''}`}>
               <div className="flex items-center justify-between mb-4">
                 <div className="flex items-center gap-4">
                   <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>account_balance_wallet</span>
                   <div>
                     <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Available Credit</span>
                     <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                       Applied to guest fees & overages
                     </p>
                   </div>
                 </div>
                 <div className="text-right">
                   <span className={`text-2xl font-bold font-serif ${accountBalance && accountBalance.balanceDollars > 0 ? (isDark ? 'text-accent' : 'text-green-600') : (isDark ? 'text-white' : 'text-primary')}`}>
                     ${(accountBalance?.balanceDollars || 0).toFixed(2)}
                   </span>
                 </div>
               </div>
               
               {showAddFunds ? (
                 <div className="space-y-3">
                   <p className={`text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>Select amount to add:</p>
                   <div className="grid grid-cols-3 gap-2">
                     {[2500, 5000, 10000].map(cents => (
                       <button
                         key={cents}
                         onClick={() => handleAddFunds(cents)}
                         disabled={addFundsMutation.isPending}
                         className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                           isDark 
                             ? 'bg-white/10 hover:bg-white/20 text-white' 
                             : 'bg-primary/10 hover:bg-primary/20 text-primary'
                         } ${addFundsMutation.isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
                       >
                         ${cents / 100}
                       </button>
                     ))}
                   </div>
                   <button
                     onClick={() => setShowAddFunds(false)}
                     className={`w-full py-2 text-sm ${isDark ? 'text-white/60' : 'text-primary/60'}`}
                   >
                     Cancel
                   </button>
                 </div>
               ) : (
                 <button
                   onClick={() => setShowAddFunds(true)}
                   className="w-full py-3 bg-primary text-white font-semibold rounded-xl hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                 >
                   <span className="material-symbols-outlined text-lg">add</span>
                   Add Funds
                 </button>
               )}
             </div>
           </Section>
         )}

         <Section title="Account" isDark={isDark} staggerIndex={2}>
            <Row icon="person" label="Name" value={user.name} isDark={isDark} />
            <Row icon="mail" label="Email" value={user.email} isDark={isDark} />
            <Row icon="call" label="Phone" value={formatPhoneNumber(staffDetails?.phone || user.phone)} isDark={isDark} />
         </Section>

         <Section title="Settings" isDark={isDark} staggerIndex={3}>
            <div className={`p-4 flex items-center justify-between transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
              <div className="flex items-center gap-4">
                <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>notifications</span>
                <div>
                  <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Push Notifications</span>
                  <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                    {isStaffOrAdminProfile 
                      ? 'Get notified of new booking requests' 
                      : 'Get notified when bookings are approved'}
                  </p>
                  {!pushSupported && (
                    <p className={`text-xs mt-1 ${isDark ? 'text-amber-400/70' : 'text-amber-600'}`}>
                      Not supported in this browser
                    </p>
                  )}
                </div>
              </div>
              <Toggle
                checked={pushEnabled}
                onChange={handlePushToggle}
                disabled={pushLoading || !pushSupported}
                label="Push Notifications"
              />
            </div>
            
            {/* Email/SMS opt-in toggles - only for members */}
            {!isStaffOrAdminProfile && (
              <>
                <div className={`p-4 flex items-center justify-between transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                  <div className="flex items-center gap-4">
                    <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>mail</span>
                    <div>
                      <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Email Updates</span>
                      <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                        Receive club news and updates via email
                      </p>
                    </div>
                  </div>
                  <Toggle
                    checked={emailOptIn ?? false}
                    onChange={(val) => handlePreferenceToggle('email', val)}
                    disabled={updatePreferencesMutation.isPending}
                    label="Email Updates"
                  />
                </div>
                <div className={`p-4 flex items-center justify-between transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                  <div className="flex items-center gap-4">
                    <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>sms</span>
                    <div>
                      <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>SMS Updates</span>
                      <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                        Receive reminders and alerts via text message
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowSmsDetails(!showSmsDetails)}
                      className={`p-1 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
                      title="SMS Preferences"
                    >
                      <span className={`material-symbols-outlined text-lg ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                        {showSmsDetails ? 'expand_less' : 'tune'}
                      </span>
                    </button>
                    <Toggle
                      checked={smsOptIn ?? false}
                      onChange={(val) => handlePreferenceToggle('sms', val)}
                      disabled={updatePreferencesMutation.isPending}
                      label="SMS Updates"
                    />
                  </div>
                </div>
                
                {/* Granular SMS Preferences - expandable */}
                {showSmsDetails && (
                  <div className={`ml-8 mr-4 mb-4 p-3 rounded-xl space-y-3 ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
                    <p className={`text-xs font-medium mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                      Fine-tune your SMS preferences:
                    </p>
                    
                    {/* Promotional SMS */}
                    <div className="flex items-center justify-between">
                      <div>
                        <span className={`text-sm ${isDark ? '' : 'text-primary'}`}>Promotional</span>
                        <p className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                          Deals, events, and special offers
                        </p>
                      </div>
                      <Toggle
                        checked={smsPromoOptIn ?? false}
                        onChange={(val) => handleSmsPreferenceToggle('promo', val)}
                        disabled={updateSmsPreferencesMutation.isPending}
                        label="Promotional SMS"
                      />
                    </div>
                    
                    {/* Transactional SMS */}
                    <div className="flex items-center justify-between">
                      <div>
                        <span className={`text-sm ${isDark ? '' : 'text-primary'}`}>Account Updates</span>
                        <p className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                          Booking confirmations and billing
                        </p>
                      </div>
                      <Toggle
                        checked={smsTransactionalOptIn ?? false}
                        onChange={(val) => handleSmsPreferenceToggle('transactional', val)}
                        disabled={updateSmsPreferencesMutation.isPending}
                        label="Account Updates SMS"
                      />
                    </div>
                    
                    {/* Reminders SMS */}
                    <div className="flex items-center justify-between">
                      <div>
                        <span className={`text-sm ${isDark ? '' : 'text-primary'}`}>Reminders</span>
                        <p className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                          Session and appointment reminders
                        </p>
                      </div>
                      <Toggle
                        checked={smsRemindersOptIn ?? false}
                        onChange={(val) => handleSmsPreferenceToggle('reminders', val)}
                        disabled={updateSmsPreferencesMutation.isPending}
                        label="Reminders SMS"
                      />
                    </div>
                  </div>
                )}
              </>
            )}
            
            <Row icon="lock" label="Privacy" arrow isDark={isDark} onClick={() => setShowPrivacyModal(true)} />
         </Section>

         <Section title="Connected Accounts" isDark={isDark} staggerIndex={3.5}>
           <div className={`p-4 transition-colors ${isDark ? '' : ''}`}>
             <div className="flex items-center justify-between">
               <div className="flex items-center gap-4">
                 <svg className="w-5 h-5" viewBox="0 0 24 24">
                   <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                   <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                   <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                   <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                 </svg>
                 <div>
                   <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Google</span>
                   {googleStatus?.linked ? (
                     <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                       {googleStatus.googleEmail}
                     </p>
                   ) : (
                     <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                       Sign in faster with your Google account
                     </p>
                   )}
                 </div>
               </div>
               <div>
                 {googleStatus?.linked ? (
                   <button
                     onClick={handleGoogleUnlink}
                     disabled={googleUnlinking}
                     className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                       isDark 
                         ? 'bg-white/10 text-white/70 hover:bg-white/20' 
                         : 'bg-black/5 text-primary/70 hover:bg-black/10'
                     } disabled:opacity-50`}
                   >
                     {googleUnlinking ? 'Unlinking...' : 'Unlink'}
                   </button>
                 ) : (
                   <GoogleSignInButton
                     onSuccess={handleGoogleLink}
                     onError={(err) => showToast(err, 'error')}
                     text="signin"
                     width={100}
                     disabled={googleLinking}
                   />
                 )}
               </div>
             </div>
           </div>

           <div className={`px-4 pb-3 ${isDark ? 'opacity-50' : 'text-primary/40'}`}>
             <div className="flex items-center gap-3">
               <svg className="w-5 h-5" viewBox="0 0 24 24">
                 <path fill="currentColor" d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
               </svg>
               <div>
                 <span className={`font-medium text-sm`}>Apple</span>
                 <p className={`text-xs mt-0.5`}>Coming soon</p>
               </div>
             </div>
           </div>
         </Section>

         {/* Billing Section - only for members, not staff/admin */}
         {!isStaffOrAdminProfile && (
           <Section title="Billing & Invoices" isDark={isDark} staggerIndex={4}>
             <BillingSection isDark={isDark} />
           </Section>
         )}

         {/* Password Setup Banner for Staff/Admin */}
         {showPasswordSetupBanner && isStaffOrAdminProfile && (
           <div className={`rounded-2xl p-4 mb-4 ${isDark ? 'bg-accent/20 border border-accent/30' : 'bg-amber-50 border border-amber-200'}`}>
             <div className="flex items-start gap-3">
               <span className={`material-symbols-outlined text-xl ${isDark ? 'text-accent' : 'text-amber-600'}`}>key</span>
               <div className="flex-1">
                 <p className={`font-semibold text-sm ${isDark ? 'text-accent' : 'text-amber-800'}`}>
                   Set Up Password Login (Optional)
                 </p>
                 <p className={`text-xs mt-1 ${isDark ? 'text-white/80' : 'text-amber-700'}`}>
                   For faster access, you can set a password to log in without email codes.
                 </p>
                 <div className="flex gap-2 mt-3">
                   <button
                     onClick={() => { setShowPasswordSection(true); setShowPasswordSetupBanner(false); }}
                     className={`px-4 py-2 rounded-lg text-xs font-bold ${isDark ? 'bg-accent text-primary' : 'bg-amber-600 text-white'}`}
                   >
                     Set Password
                   </button>
                   <button
                     onClick={() => setShowPasswordSetupBanner(false)}
                     className={`px-4 py-2 rounded-lg text-xs font-medium ${isDark ? 'bg-white/10 text-white/70' : 'bg-amber-100 text-amber-700'}`}
                   >
                     Maybe Later
                   </button>
                 </div>
               </div>
             </div>
           </div>
         )}

         {/* Staff Info - only show for staff/admin users */}
         {isStaffOrAdminProfile && (
           <Section title="Staff Information" isDark={isDark} staggerIndex={5}>
              <Row icon="shield_person" label="Role" value={user?.role === 'admin' ? 'Administrator' : 'Staff'} isDark={isDark} />
              {staffDetails?.job_title && <Row icon="work" label="Job Title" value={staffDetails.job_title} isDark={isDark} />}
           </Section>
         )}

         {/* Password Section - only show for staff/admin users */}
         {isStaffOrAdminProfile && (
           <Section title="Security" isDark={isDark} staggerIndex={6}>
              <div 
                className={`p-4 flex items-center justify-between transition-colors cursor-pointer ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
                onClick={() => setShowPasswordSection(!showPasswordSection)}
              >
                <div className="flex items-center gap-4">
                  <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>key</span>
                  <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                    {hasPassword ? 'Change Password' : 'Set Up Password'}
                  </span>
                </div>
                <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  {showPasswordSection ? 'expand_less' : 'expand_more'}
                </span>
              </div>
              
              {showPasswordSection && (
                <div className={`px-4 pb-4 space-y-4 ${isDark ? '' : ''}`}>
                  {hasPassword && (
                    <div>
                      <label className={`text-xs font-medium block mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                        Current Password
                      </label>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className={`w-full px-4 py-3 rounded-xl text-sm ${
                          isDark 
                            ? 'bg-white/10 text-white placeholder:text-white/40' 
                            : 'bg-black/5 text-primary placeholder:text-primary/40'
                        }`}
                        placeholder="Enter current password"
                      />
                    </div>
                  )}
                  
                  <div>
                    <label className={`text-xs font-medium block mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                      New Password
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className={`w-full px-4 py-3 rounded-xl text-sm ${
                        isDark 
                          ? 'bg-white/10 text-white placeholder:text-white/40' 
                          : 'bg-black/5 text-primary placeholder:text-primary/40'
                      }`}
                      placeholder="At least 8 characters"
                    />
                  </div>
                  
                  <div>
                    <label className={`text-xs font-medium block mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={`w-full px-4 py-3 rounded-xl text-sm ${
                        isDark 
                          ? 'bg-white/10 text-white placeholder:text-white/40' 
                          : 'bg-black/5 text-primary placeholder:text-primary/40'
                      }`}
                      placeholder="Confirm new password"
                    />
                  </div>
                  
                  <button
                    onClick={handlePasswordSubmit}
                    disabled={setPasswordMutation.isPending || !newPassword || !confirmPassword}
                    className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
                      setPasswordMutation.isPending || !newPassword || !confirmPassword
                        ? 'opacity-50 cursor-not-allowed bg-primary/50 text-white/70'
                        : 'bg-primary text-white hover:bg-primary/90'
                    }`}
                  >
                    {setPasswordMutation.isPending ? (
                      <>
                        <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                        Saving...
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-lg">check</span>
                        {hasPassword ? 'Update Password' : 'Set Password'}
                      </>
                    )}
                  </button>
                </div>
              )}
           </Section>
         )}

         {/* Logout Button */}
         <button
           onClick={logout}
           className={`w-full p-4 rounded-2xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
             isDark 
               ? 'glass-card text-red-400 hover:bg-red-500/20' 
               : 'bg-red-50 text-red-600 hover:bg-red-100'
           }`}
         >
           <span className="material-symbols-outlined text-lg">logout</span>
           Sign Out
         </button>

         {/* View as Banner for admin viewing member */}
         {isAdminViewingAs && (
           <div className={`rounded-2xl p-4 ${isDark ? 'bg-accent/20 border border-accent/30' : 'bg-amber-50 border border-amber-200'}`}>
             <div className="flex items-center gap-3">
               <span className={`material-symbols-outlined text-xl ${isDark ? 'text-accent' : 'text-amber-600'}`}>visibility</span>
               <div className="flex-1">
                 <p className={`font-semibold text-sm ${isDark ? 'text-accent' : 'text-amber-800'}`}>
                   Viewing as {user.name}
                 </p>
                 <p className={`text-xs mt-0.5 ${isDark ? 'text-white/70' : 'text-amber-700'}`}>
                   You are viewing this profile as an administrator
                 </p>
               </div>
             </div>
           </div>
         )}
      </div>

      {/* Privacy Modal */}
      <ModalShell isOpen={showPrivacyModal} onClose={() => setShowPrivacyModal(false)} title="Privacy Settings">
        <div className="space-y-6">
          {/* Do Not Sell My Info */}
          <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <span className={`material-symbols-outlined ${isDark ? 'text-white/70' : 'text-primary/70'}`}>security</span>
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Do Not Sell My Information</span>
              </div>
              <Toggle
                checked={doNotSellMyInfo}
                onChange={handleDoNotSellToggle}
                disabled={updatePreferencesMutation.isPending}
                label="Do Not Sell"
              />
            </div>
            <p className={`text-sm ml-9 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Opt out of having your personal information sold or shared with third parties for targeted advertising.
            </p>
          </div>

          {/* Data Export */}
          <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
            <div className="flex items-center gap-3 mb-2">
              <span className={`material-symbols-outlined ${isDark ? 'text-white/70' : 'text-primary/70'}`}>download</span>
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Request Data Export</span>
            </div>
            <p className={`text-sm ml-9 mb-3 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Request a copy of all personal data we have stored about you. We will email you within 45 days.
            </p>
            {dataExportRequestedAt ? (
              <p className={`text-sm ml-9 ${isDark ? 'text-accent' : 'text-green-600'}`}>
                ✓ Request submitted on {new Date(dataExportRequestedAt).toLocaleDateString()}
              </p>
            ) : (
              <button
                onClick={handleDataExportRequest}
                disabled={dataExportMutation.isPending}
                className={`ml-9 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isDark 
                    ? 'bg-white/10 hover:bg-white/20 text-white' 
                    : 'bg-primary/10 hover:bg-primary/20 text-primary'
                } ${dataExportMutation.isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {dataExportMutation.isPending ? 'Submitting...' : 'Request Export'}
              </button>
            )}
          </div>

          {/* Delete Account */}
          <div className={`p-4 rounded-xl border ${isDark ? 'border-red-500/30 bg-red-500/10' : 'border-red-200 bg-red-50'}`}>
            <div className="flex items-center gap-3 mb-2">
              <span className={`material-symbols-outlined ${isDark ? 'text-red-400' : 'text-red-600'}`}>delete_forever</span>
              <span className={`font-medium ${isDark ? 'text-red-400' : 'text-red-700'}`}>Delete Account</span>
            </div>
            <p className={`text-sm ml-9 mb-3 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="ml-9 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
            >
              Delete My Account
            </button>
          </div>

          {/* Delete Confirmation */}
          {showDeleteConfirm && (
            <div className={`p-4 rounded-xl border-2 ${isDark ? 'border-red-500 bg-red-500/20' : 'border-red-300 bg-red-100'}`}>
              <div className="flex items-start gap-3 mb-4">
                <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-red-400' : 'text-red-600'}`}>warning</span>
                <div>
                  <h4 className={`font-bold text-lg mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Are you sure?
                  </h4>
                  <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    This will initiate the termination of your membership and deletion of your data. 
                    This action cannot be undone.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={deleteAccountMutation.isPending}
                  className={`flex-1 py-3 font-semibold rounded-xl transition-colors ${
                    isDark 
                      ? 'bg-white/10 hover:bg-white/20 text-white' 
                      : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                  }`}
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteAccountMutation.mutate()}
                  disabled={deleteAccountMutation.isPending}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {deleteAccountMutation.isPending ? (
                    <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-lg">delete_forever</span>
                      Confirm Delete
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </ModalShell>

      <BottomSentinel />

      {/* Bottom Navigation - only show for members, not for staff/admin viewing their own profile */}
      {(!isStaffOrAdminProfile || isViewingAs) && (
        <MemberBottomNav currentPath="/profile" isDarkTheme={isDark} />
      )}

      <WaiverModal
        isOpen={showWaiverModal}
        onComplete={() => setShowWaiverModal(false)}
        currentVersion={currentWaiverVersion}
      />
    </div>
    </AnimatedPage>
  );
};

const Section: React.FC<{title: string; children: React.ReactNode; isDark?: boolean; staggerIndex?: number}> = ({ title, children, isDark = true, staggerIndex }) => (
  <div className="animate-slide-up-stagger" style={staggerIndex !== undefined ? { '--stagger-index': staggerIndex } as React.CSSProperties : undefined}>
     <h3 className={`text-xs font-bold uppercase tracking-wider ml-2 mb-3 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>{title}</h3>
     <div className={`rounded-2xl overflow-hidden glass-card divide-y ${isDark ? 'divide-white/20 border-white/25' : 'divide-black/5 border-black/10'}`}>
        {children}
     </div>
  </div>
);

const Row: React.FC<{icon: string; label: string; value?: string; toggle?: boolean; arrow?: boolean; isDark?: boolean; onClick?: () => void}> = ({ icon, label, value, toggle, arrow, isDark = true, onClick }) => (
   <div onClick={onClick} className={`p-4 flex items-center justify-between transition-colors cursor-pointer ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
      <div className="flex items-center gap-4">
         <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>{icon}</span>
         <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>{label}</span>
      </div>
      <div className="flex items-center gap-2">
         {value && <span className={`text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>{value}</span>}
         {toggle && (
            <div className="w-10 h-6 bg-green-500 rounded-full relative">
               <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm"></div>
            </div>
         )}
         {arrow && <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>arrow_forward_ios</span>}
      </div>
   </div>
);

export default Profile;

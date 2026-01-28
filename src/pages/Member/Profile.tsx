import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useData } from '../../contexts/DataContext';
import { useTheme } from '../../contexts/ThemeContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import { useToast } from '../../components/Toast';
import { isFoundingMember, getBaseTier } from '../../utils/permissions';
import { getTierColor } from '../../utils/tierUtils';
import { formatPhoneNumber } from '../../utils/formatting';
import { formatMemberSince } from '../../utils/dateUtils';
import { useTierPermissions } from '../../hooks/useTierPermissions';
import TierBadge from '../../components/TierBadge';
import TagBadge from '../../components/TagBadge';
import HubSpotFormModal from '../../components/HubSpotFormModal';
import { isPushSupported, isSubscribedToPush, subscribeToPush, unsubscribeFromPush } from '../../services/pushNotifications';
import Toggle from '../../components/Toggle';
import MemberBottomNav from '../../components/MemberBottomNav';
import { BottomSentinel } from '../../components/layout/BottomSentinel';
import BugReportModal from '../../components/BugReportModal';
import ModalShell from '../../components/ModalShell';
import WaiverModal from '../../components/WaiverModal';
import BillingSection from '../../components/profile/BillingSection';
import { AnimatedPage } from '../../components/motion';


const GUEST_CHECKIN_FIELDS = [
  { name: 'guest_firstname', label: 'Guest First Name', type: 'text' as const, required: true, placeholder: 'John' },
  { name: 'guest_lastname', label: 'Guest Last Name', type: 'text' as const, required: true, placeholder: 'Smith' },
  { name: 'guest_email', label: 'Guest Email', type: 'email' as const, required: true, placeholder: 'john@example.com' },
  { name: 'guest_phone', label: 'Guest Phone', type: 'tel' as const, required: false, placeholder: '(555) 123-4567' }
];

const Profile: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, actualUser, isViewingAs, refreshUser } = useData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { startNavigation } = useNavigationLoading();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [showGuestCheckin, setShowGuestCheckin] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [emailOptIn, setEmailOptIn] = useState<boolean | null>(null);
  const [smsOptIn, setSmsOptIn] = useState<boolean | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [showPasswordSetupBanner, setShowPasswordSetupBanner] = useState(false);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const [showBugReport, setShowBugReport] = useState(false);
  const [staffDetails, setStaffDetails] = useState<{phone?: string; job_title?: string} | null>(null);
  const [accountBalance, setAccountBalance] = useState<{ balanceDollars: number; isCredit: boolean } | null>(null);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [addFundsLoading, setAddFundsLoading] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [doNotSellMyInfo, setDoNotSellMyInfo] = useState<boolean>(false);
  const [privacyLoading, setPrivacyLoading] = useState(false);
  const [dataExportLoading, setDataExportLoading] = useState(false);
  const [dataExportRequestedAt, setDataExportRequestedAt] = useState<string | null>(null);
  const [showWaiverModal, setShowWaiverModal] = useState(false);
  const [currentWaiverVersion, setCurrentWaiverVersion] = useState<string>('1.0');

  // Check if viewing a staff/admin profile (either directly or via view-as)
  const isStaffOrAdminProfile = user?.role === 'admin' || user?.role === 'staff';
  // Check if actual user is admin viewing as someone
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;

  const { permissions: tierPermissions } = useTierPermissions(user?.tier);

  useEffect(() => {
    if (!isProfileLoading) {
      setPageReady(true);
    }
  }, [isProfileLoading, setPageReady]);

  useEffect(() => {
    setIsProfileLoading(false);
  }, [user?.email]);

  useEffect(() => {
    if (user?.email && !isStaffOrAdminProfile) {
      // Pass user_email param to support "View As" feature
      fetch(`/api/my-billing/account-balance?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' })
        .then(res => res.ok ? res.json() : null)
        .then(data => data && setAccountBalance({ balanceDollars: data.balanceDollars || 0, isCredit: data.isCredit || false }))
        .catch(err => console.error('Error fetching balance:', err));
    }
  }, [user?.email, isStaffOrAdminProfile]);

  useEffect(() => {
    if (isStaffOrAdminProfile && user?.email) {
      fetch(`/api/auth/check-staff-admin?email=${encodeURIComponent(user.email)}`, { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          setHasPassword(data.hasPassword || false);
        })
        .catch(() => {});
    }
  }, [user?.email, isStaffOrAdminProfile]);

  useEffect(() => {
    const state = location.state as { showPasswordSetup?: boolean } | null;
    if (state?.showPasswordSetup && isStaffOrAdminProfile) {
      setShowPasswordSetupBanner(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state, isStaffOrAdminProfile]);

  useEffect(() => {
    if (isStaffOrAdminProfile && user?.email) {
      fetch(`/api/staff-users/by-email/${encodeURIComponent(user.email)}`, { credentials: 'include' })
        .then(res => res.ok ? res.json() : null)
        .then(data => setStaffDetails(data))
        .catch(() => {});
    }
  }, [user?.email, isStaffOrAdminProfile]);

  useEffect(() => {
    if (user?.email && !isStaffOrAdminProfile) {
      fetch('/api/waivers/status', { credentials: 'include' })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.needsWaiverUpdate) {
            setCurrentWaiverVersion(data.currentVersion);
            setShowWaiverModal(true);
          }
        })
        .catch(() => {});
    }
  }, [user?.email, isStaffOrAdminProfile]);

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

  const handlePasswordSubmit = async () => {
    setPasswordError('');
    setPasswordSuccess('');
    
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
    
    setPasswordLoading(true);
    
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          password: newPassword,
          currentPassword: hasPassword ? currentPassword : undefined
        }),
        credentials: 'include'
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to set password');
      }
      
      showToast('Password updated', 'success');
      setHasPassword(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordSetupBanner(false);
      
      setTimeout(() => {
        setShowPasswordSection(false);
      }, 1500);
    } catch (err: any) {
      showToast(err.message || 'Failed to set password', 'error');
    } finally {
      setPasswordLoading(false);
    }
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

  // Fetch communication and privacy preferences (only for members, not staff)
  useEffect(() => {
    if (user?.email && !isStaffOrAdminProfile) {
      fetch(`/api/members/me/preferences?user_email=${encodeURIComponent(user.email)}`, { credentials: 'include' })
        .then(res => res.ok ? res.json() : { emailOptIn: null, smsOptIn: null, doNotSellMyInfo: false, dataExportRequestedAt: null })
        .then(data => {
          setEmailOptIn(data.emailOptIn);
          setSmsOptIn(data.smsOptIn);
          setDoNotSellMyInfo(data.doNotSellMyInfo || false);
          setDataExportRequestedAt(data.dataExportRequestedAt);
        })
        .catch(() => {});
    }
  }, [user?.email, isStaffOrAdminProfile]);

  const handlePreferenceToggle = async (type: 'email' | 'sms', newValue: boolean) => {
    if (!user?.email || prefsLoading) return;
    
    const previousEmail = emailOptIn;
    const previousSms = smsOptIn;
    if (type === 'email') setEmailOptIn(newValue);
    else setSmsOptIn(newValue);
    
    setPrefsLoading(true);
    try {
      const body = type === 'email' ? { emailOptIn: newValue } : { smsOptIn: newValue };
      const res = await fetch(`/api/members/me/preferences?user_email=${encodeURIComponent(user.email)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include'
      });
      
      if (res.ok) {
        showToast('Preferences updated', 'success');
      } else {
        if (type === 'email') setEmailOptIn(previousEmail);
        else setSmsOptIn(previousSms);
        showToast('Failed to update preferences', 'error');
      }
    } catch {
      if (type === 'email') setEmailOptIn(previousEmail);
      else setSmsOptIn(previousSms);
      showToast('Failed to update preferences', 'error');
    } finally {
      setPrefsLoading(false);
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

  const handleAddFunds = async (amountCents: number) => {
    if (addFundsLoading) return;
    setAddFundsLoading(true);
    try {
      const res = await fetch('/api/my/add-funds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amountCents })
      });
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        showToast(data.error || 'Failed to create checkout', 'error');
      }
    } catch {
      showToast('Failed to add funds', 'error');
    } finally {
      setAddFundsLoading(false);
      setShowAddFunds(false);
    }
  };

  const handleDoNotSellToggle = async (newValue: boolean) => {
    if (!user?.email || privacyLoading) return;
    
    const previousValue = doNotSellMyInfo;
    setDoNotSellMyInfo(newValue);
    setPrivacyLoading(true);
    
    try {
      const res = await fetch(`/api/members/me/preferences?user_email=${encodeURIComponent(user.email)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doNotSellMyInfo: newValue }),
        credentials: 'include'
      });
      
      if (res.ok) {
        showToast(newValue ? 'Your data will not be sold or shared' : 'Preference updated', 'success');
      } else {
        setDoNotSellMyInfo(previousValue);
        showToast('Failed to update privacy settings', 'error');
      }
    } catch {
      setDoNotSellMyInfo(previousValue);
      showToast('Failed to update privacy settings', 'error');
    } finally {
      setPrivacyLoading(false);
    }
  };

  const handleDataExportRequest = async () => {
    if (!user?.email || dataExportLoading) return;
    
    setDataExportLoading(true);
    try {
      const res = await fetch('/api/members/me/data-export-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      
      if (res.ok) {
        const data = await res.json();
        setDataExportRequestedAt(data.requestedAt);
        showToast('Data export request submitted. We will email you within 45 days.', 'success');
      } else {
        showToast('Failed to submit data export request', 'error');
      }
    } catch {
      showToast('Failed to submit data export request', 'error');
    } finally {
      setDataExportLoading(false);
    }
  };

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

         {/* Digital Access Card - only for members, not staff/admin */}
         {!isStaffOrAdminProfile && user.id && (
           <Section title="Digital Access Card" isDark={isDark} staggerIndex={0}>
             <div className={`p-6 flex flex-col items-center ${isDark ? '' : ''}`}>
               <div className={`w-full max-w-xs rounded-2xl overflow-hidden ${isDark ? 'bg-gradient-to-br from-primary via-primary/90 to-primary/80' : 'bg-gradient-to-br from-primary via-primary/95 to-primary/85'} p-6 shadow-xl`}>
                 <div className="flex justify-center mb-4">
                   <div className="bg-white p-3 rounded-xl shadow-md">
                     <img
                       src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`MEMBER:${user.id}`)}`}
                       alt="Member QR Code"
                       className="w-40 h-40"
                     />
                   </div>
                 </div>
                 <div className="text-center text-white space-y-2">
                   <h4 className="font-bold text-lg font-serif tracking-wide">{user.name}</h4>
                   <div className="flex justify-center">
                     <TierBadge tier={user.tier} size="sm" lastTier={user.lastTier} membershipStatus={user.membershipStatus} />
                   </div>
                 </div>
               </div>
               <p className={`text-xs mt-4 text-center max-w-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                 Show this QR code at the front desk for quick check-in
               </p>
             </div>
           </Section>
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
                         disabled={addFundsLoading}
                         className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                           isDark 
                             ? 'bg-white/10 hover:bg-white/20 text-white' 
                             : 'bg-primary/10 hover:bg-primary/20 text-primary'
                         } ${addFundsLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                    disabled={prefsLoading}
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
                  <Toggle
                    checked={smsOptIn ?? false}
                    onChange={(val) => handlePreferenceToggle('sms', val)}
                    disabled={prefsLoading}
                    label="SMS Updates"
                  />
                </div>
              </>
            )}
            
            <Row icon="lock" label="Privacy" arrow isDark={isDark} onClick={() => setShowPrivacyModal(true)} />
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
                <div className={`p-4 pt-0 space-y-4 animate-pop-in ${isDark ? 'border-t border-white/20' : 'border-t border-black/5'}`}>
                  {passwordError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs">
                      {passwordError}
                    </div>
                  )}
                  {passwordSuccess && (
                    <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-xs">
                      {passwordSuccess}
                    </div>
                  )}
                  
                  {hasPassword && (
                    <input
                      type="password"
                      placeholder="Current Password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className={`w-full px-4 py-3 rounded-xl border text-sm ${isDark ? 'bg-white/5 border-white/25 text-white placeholder:text-white/70' : 'bg-white border-black/10 text-primary placeholder:text-gray-600'}`}
                    />
                  )}
                  
                  <input
                    type="password"
                    placeholder="New Password (min 8 characters)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={`w-full px-4 py-3 rounded-xl border text-sm ${isDark ? 'bg-white/5 border-white/25 text-white placeholder:text-white/70' : 'bg-white border-black/10 text-primary placeholder:text-gray-600'}`}
                  />
                  
                  <input
                    type="password"
                    placeholder="Confirm New Password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={`w-full px-4 py-3 rounded-xl border text-sm ${isDark ? 'bg-white/5 border-white/25 text-white placeholder:text-white/70' : 'bg-white border-black/10 text-primary placeholder:text-gray-600'}`}
                  />
                  
                  <div className="flex gap-2">
                    <button
                      onClick={handlePasswordSubmit}
                      disabled={passwordLoading || !newPassword || !confirmPassword}
                      className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 ${isDark ? 'bg-accent text-primary' : 'bg-primary text-white'}`}
                    >
                      {passwordLoading ? 'Saving...' : (hasPassword ? 'Update Password' : 'Set Password')}
                    </button>
                    <button
                      onClick={() => {
                        setShowPasswordSection(false);
                        setCurrentPassword('');
                        setNewPassword('');
                        setConfirmPassword('');
                        setPasswordError('');
                      }}
                      className={`px-4 py-3 rounded-xl text-sm font-medium ${isDark ? 'bg-white/10 text-white/70' : 'bg-black/5 text-primary/70'}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
           </Section>
         )}

         <button onClick={async () => { await logout(); startNavigation(); navigate('/login'); }} className={`w-full py-4 rounded-xl text-red-400 font-bold text-sm transition-colors animate-slide-up-stagger ${isDark ? 'glass-button hover:bg-red-500/10' : 'bg-white border border-black/5 hover:bg-red-50'}`} style={{ '--stagger-index': 8 } as React.CSSProperties}>
            Sign Out
         </button>

         <button 
           onClick={() => setShowBugReport(true)} 
           className={`w-full py-4 rounded-xl font-bold text-sm transition-colors animate-slide-up-stagger flex items-center justify-center gap-2 ${isDark ? 'glass-button text-white/80 hover:text-white hover:bg-white/5' : 'bg-white border border-black/5 text-primary/80 hover:text-primary hover:bg-black/5'}`} 
           style={{ '--stagger-index': 9 } as React.CSSProperties}
         >
            <span className="material-symbols-outlined text-lg">bug_report</span>
            Report a Bug
         </button>
      </div>

      <BugReportModal
        isOpen={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      {/* Guest Check-In Modal */}
      <HubSpotFormModal
        isOpen={showGuestCheckin}
        onClose={() => setShowGuestCheckin(false)}
        formType="guest-checkin"
        title="Guest Check-In"
        subtitle="Register your guest for today's visit."
        fields={GUEST_CHECKIN_FIELDS}
        submitButtonText="Check In Guest"
        additionalFields={{
          member_name: user.name,
          member_email: user.email
        }}
        onSuccess={() => {
          showToast('Guest checked in successfully!', 'success');
        }}
      />

      {/* Privacy Settings Modal */}
      <ModalShell
        isOpen={showPrivacyModal}
        onClose={() => {
          setShowPrivacyModal(false);
          setShowDeleteConfirm(false);
        }}
        title="Privacy"
        size="md"
      >
        <div className="space-y-4 p-4">
          {!showDeleteConfirm ? (
            <>
              {/* Privacy Policy Link */}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className={`p-4 flex items-center justify-between rounded-xl transition-colors ${
                  isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                    description
                  </span>
                  <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                    Privacy Policy
                  </span>
                </div>
                <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  open_in_new
                </span>
              </a>

              {/* Terms of Service Link */}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className={`p-4 flex items-center justify-between rounded-xl transition-colors ${
                  isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                    gavel
                  </span>
                  <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                    Terms of Service
                  </span>
                </div>
                <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  open_in_new
                </span>
              </a>

              {/* California Privacy Rights (CCPA/CPRA) Section */}
              {!isStaffOrAdminProfile && (
                <div className={`pt-4 mt-4 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <h4 className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    California Privacy Rights
                  </h4>
                  
                  {/* Do Not Sell/Share My Info Toggle */}
                  <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 flex-1">
                        <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                          shield
                        </span>
                        <div>
                          <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                            Do Not Sell or Share My Info
                          </span>
                          <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                            Opt out of personal data sales/sharing
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDoNotSellToggle(!doNotSellMyInfo)}
                        disabled={privacyLoading}
                        className={`relative w-12 h-7 rounded-full transition-colors duration-200 flex-shrink-0 ${
                          doNotSellMyInfo 
                            ? 'bg-accent' 
                            : isDark ? 'bg-white/20' : 'bg-gray-300'
                        } ${privacyLoading ? 'opacity-50' : ''}`}
                        aria-label="Toggle do not sell my personal information"
                      >
                        <span className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
                          doNotSellMyInfo ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>
                  </div>
                  
                  {/* Request Data Export Button */}
                  <button
                    onClick={handleDataExportRequest}
                    disabled={dataExportLoading}
                    className={`mt-3 w-full p-4 flex items-center justify-between rounded-xl transition-colors ${
                      isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
                    } ${dataExportLoading ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-4">
                      <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                        download
                      </span>
                      <div className="text-left">
                        <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                          Request Data Export
                        </span>
                        <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                          {dataExportRequestedAt 
                            ? `Last requested: ${new Date(dataExportRequestedAt).toLocaleDateString()}`
                            : 'Get a copy of your personal data'}
                        </p>
                      </div>
                    </div>
                    {dataExportLoading ? (
                      <span className={`material-symbols-outlined text-sm animate-spin ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                        progress_activity
                      </span>
                    ) : (
                      <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                        chevron_right
                      </span>
                    )}
                  </button>
                </div>
              )}

              {/* Danger Zone - Delete Account */}
              <div className="pt-4 mt-4 border-t border-red-500/30">
                <h4 className="text-xs font-bold uppercase tracking-wider text-red-500 mb-3">
                  Danger Zone
                </h4>
                <div className={`p-4 rounded-xl border border-red-500/30 ${isDark ? 'bg-red-500/10' : 'bg-red-50'}`}>
                  <p className={`text-sm mb-4 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    Permanently delete your account and all associated data.
                  </p>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-lg">delete_forever</span>
                    Delete Account
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* Delete Account Confirmation */
            <div className="space-y-4">
              <div className={`p-4 rounded-xl border border-red-500/50 ${isDark ? 'bg-red-500/20' : 'bg-red-50'}`}>
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-red-500 text-2xl">warning</span>
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
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={deleteLoading}
                  className={`flex-1 py-3 font-semibold rounded-xl transition-colors ${
                    isDark 
                      ? 'bg-white/10 hover:bg-white/20 text-white' 
                      : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                  }`}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    setDeleteLoading(true);
                    try {
                      const res = await fetch('/api/account/delete-request', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include'
                      });
                      if (!res.ok) {
                        const data = await res.json();
                        throw new Error(data.error || 'Failed to submit deletion request');
                      }
                      showToast('Deletion request sent to administration', 'success');
                      setShowDeleteConfirm(false);
                      setShowPrivacyModal(false);
                    } catch (err: any) {
                      showToast('Deletion request sent to administration', 'success');
                      setShowDeleteConfirm(false);
                      setShowPrivacyModal(false);
                    } finally {
                      setDeleteLoading(false);
                    }
                  }}
                  disabled={deleteLoading}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {deleteLoading ? (
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

      {/* Full Screen Card Modal */}
      <ModalShell 
        isOpen={isCardOpen} 
        onClose={() => setIsCardOpen(false)}
        showCloseButton={false}
        size="sm"
        className="!bg-transparent !border-0 !shadow-none"
      >
        {(() => {
          const tierColors = getTierColor(user.tier || 'Social');
          const cardBgColor = isStaffOrAdminProfile ? '#293515' : tierColors.bg;
          const cardTextColor = isStaffOrAdminProfile ? '#F2F2EC' : tierColors.text;
          const baseTier = getBaseTier(user.tier || 'Social');
          const useDarkLogo = !isStaffOrAdminProfile && ['Social', 'Premium', 'VIP'].includes(baseTier);
          return (
            <div className="flex flex-col items-center">
              <div className="w-full rounded-[2rem] relative overflow-hidden shadow-2xl flex flex-col" style={{ backgroundColor: cardBgColor }}>
               
               {/* Close Button */}
               <button onClick={() => setIsCardOpen(false)} className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center z-10" style={{ backgroundColor: `${cardTextColor}33`, color: cardTextColor }}>
                   <span className="material-symbols-outlined text-sm">close</span>
               </button>

               {/* Header with Logo */}
               <div className="pt-6 pb-4 px-6 flex justify-center" style={{ backgroundColor: cardBgColor }}>
                   <img src={useDarkLogo ? "/assets/logos/monogram-dark.webp" : "/assets/logos/monogram-white.webp"} className="w-12 h-12" alt="" />
               </div>
               
               {/* Member Info */}
               <div className="px-6 pb-6 text-center" style={{ backgroundColor: cardBgColor }}>
                   <h2 className="text-2xl font-bold mb-3" style={{ color: cardTextColor }}>{user.name}</h2>
                   
                   {isStaffOrAdminProfile ? (
                     <>
                       <div className="flex items-center justify-center gap-2 flex-wrap mb-2">
                          <span className="px-3 py-1 rounded-full bg-white/20 text-sm font-bold" style={{ color: cardTextColor }}>
                             {user.role === 'admin' ? 'Administrator' : 'Staff'}
                          </span>
                       </div>
                       {user.jobTitle && (
                         <p className="text-sm opacity-80" style={{ color: cardTextColor }}>{user.jobTitle}</p>
                       )}
                     </>
                   ) : (
                     <>
                       <div className="flex items-center justify-center gap-2 flex-wrap mb-2">
                          <TierBadge tier={user.tier || 'Social'} size="md" lastTier={user.lastTier} membershipStatus={user.membershipStatus} />
                       </div>
                       {((user.tags || []).length > 0 || isFoundingMember(user.tier || '', user.isFounding)) && (
                         <div className="flex items-center justify-center gap-2 flex-wrap">
                            {(user.tags || []).map((tag) => (
                               <TagBadge key={tag} tag={tag} size="sm" />
                            ))}
                            {!user.tags?.length && isFoundingMember(user.tier || '', user.isFounding) && (
                               <TagBadge tag="Founding Member" size="sm" />
                            )}
                         </div>
                       )}
                     </>
                   )}
               </div>

               {/* QR Code Section - Members Only */}
               {!isStaffOrAdminProfile && user.id && (
                 <div className="px-6 pb-4 flex flex-col items-center" style={{ backgroundColor: cardBgColor }}>
                   <div className="bg-white p-3 rounded-xl shadow-md">
                     <img
                       src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(`MEMBER:${user.id}`)}`}
                       alt="Member QR Code"
                       className="w-28 h-28"
                     />
                   </div>
                   <p className="text-xs mt-2 text-center opacity-60" style={{ color: cardTextColor }}>
                     Show for quick check-in
                   </p>
                 </div>
               )}

               {/* Benefits Section - Members Only */}
               {!isStaffOrAdminProfile && (
                 <div className="px-6 pb-6" style={{ backgroundColor: cardBgColor }}>
                   <div className="rounded-xl p-4 space-y-3" style={{ backgroundColor: `${cardTextColor}10` }}>
                     <h3 className="text-xs font-bold uppercase tracking-wider opacity-60 mb-3" style={{ color: cardTextColor }}>Membership Benefits</h3>
                     
                     {user.joinDate && (
                       <div className="flex items-center justify-between">
                         <div className="flex items-center gap-3">
                           <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>event</span>
                           <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Member Since</span>
                         </div>
                         <span className="text-sm font-semibold" style={{ color: cardTextColor }}>{formatMemberSince(user.joinDate)}</span>
                       </div>
                     )}
                     
                     <div className="flex items-center justify-between">
                       <div className="flex items-center gap-3">
                         <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>calendar_month</span>
                         <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Advance Booking</span>
                       </div>
                       <span className="text-sm font-semibold" style={{ color: cardTextColor }}>
                         {tierPermissions.unlimitedAccess ? 'Unlimited' : `${tierPermissions.advanceBookingDays} days`}
                       </span>
                     </div>
                     
                     {tierPermissions.canBookSimulators && (
                       <div className="flex items-center justify-between">
                         <div className="flex items-center gap-3">
                           <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>sports_golf</span>
                           <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Daily Sim Time</span>
                         </div>
                         <span className="text-sm font-semibold" style={{ color: cardTextColor }}>
                           {tierPermissions.unlimitedAccess ? 'Unlimited' : `${tierPermissions.dailySimulatorMinutes} min`}
                         </span>
                       </div>
                     )}
                     
                     {user.mindbodyClientId && (
                       <div className="flex items-center justify-between pt-2 mt-2" style={{ borderTop: `1px solid ${cardTextColor}20` }}>
                         <div className="flex items-center gap-3">
                           <span className="material-symbols-outlined text-base opacity-70" style={{ color: cardTextColor }}>badge</span>
                           <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Mindbody ID</span>
                         </div>
                         <span className="text-sm font-mono font-semibold" style={{ color: cardTextColor }}>{user.mindbodyClientId}</span>
                       </div>
                     )}
                   </div>
                 </div>
               )}

               {/* Staff Portal Access */}
               {isStaffOrAdminProfile && (
                 <div className="px-6 pb-6" style={{ backgroundColor: cardBgColor }}>
                   <div className="rounded-xl p-4 text-center" style={{ backgroundColor: `${cardTextColor}10` }}>
                     <span className="text-xs font-bold uppercase tracking-wider opacity-60" style={{ color: cardTextColor }}>Portal Access</span>
                     <p className="text-lg font-bold mt-1" style={{ color: cardTextColor }}>Staff Portal</p>
                   </div>
                 </div>
               )}
              </div>

            </div>
          );
        })()}
      </ModalShell>

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

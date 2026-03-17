import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthData } from '../../../contexts/DataContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { usePageReady } from '../../../stores/pageReadyStore';
import { useNavigationLoading } from '../../../stores/navigationLoadingStore';
import { useToast } from '../../../components/Toast';
import { isPushSupported, isSubscribedToPush, subscribeToPush, unsubscribeFromPush } from '../../../services/pushNotifications';
import { fetchWithCredentials, postWithCredentials, patchWithCredentials, putWithCredentials } from '../../../hooks/queries/useFetch';
import type { AccountBalanceData, StaffDetailsData, WaiverStatusData, PreferencesData, StaffAdminCheckData } from './profileTypes';
import { useProfileAuth } from './useProfileAuth';

export function useProfileData() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, logout, actualUser, isViewingAs, refreshUser } = useAuthData();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const { startNavigation } = useNavigationLoading();
  const { showToast } = useToast();
  const isDark = effectiveTheme === 'dark';

  const isStaffOrAdminProfile = user?.role === 'admin' || user?.role === 'staff';
  const isAdminViewingAs = actualUser?.role === 'admin' && isViewingAs;

  const auth = useProfileAuth(!!user);

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
  const [editingProfile, setEditingProfile] = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editPhone, setEditPhone] = useState('');

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
    const state = location.state as { showPasswordSetup?: boolean; showWaiver?: boolean; scrollToPasskeys?: boolean } | null;
    if (state?.showPasswordSetup && isStaffOrAdminProfile) {
      setShowPasswordSetupBanner(true);
      window.history.replaceState({}, document.title);
    }
    if (state?.showWaiver) {
      setShowWaiverModal(true);
      window.history.replaceState({}, document.title);
    }
    if (state?.scrollToPasskeys) {
      window.history.replaceState({}, document.title);
      const timer = setTimeout(() => {
        document.getElementById('passkeys-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 500);
      return () => clearTimeout(timer);
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
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to set password', 'error');
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

  const updatePreferencesMutation = useMutation<{ success: boolean }, Error, { emailOptIn?: boolean; smsOptIn?: boolean; doNotSellMyInfo?: boolean }, { previous?: PreferencesData }>({
    mutationFn: (data) =>
      patchWithCredentials<{ success: boolean }>(
        `/api/members/me/preferences?user_email=${encodeURIComponent(user!.email)}`,
        data
      ),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: ['memberPreferences', user?.email] });
      const previous = queryClient.getQueryData<PreferencesData>(['memberPreferences', user?.email]);
      queryClient.setQueryData<PreferencesData>(['memberPreferences', user?.email], (old) => {
        if (!old) return old;
        return { ...old, ...(data as Partial<PreferencesData>) };
      });
      return { previous };
    },
    onError: (_err, _data, context) => {
      if (context?.previous) queryClient.setQueryData(['memberPreferences', user?.email], context.previous);
      showToast('Failed to update preferences', 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
    onSuccess: () => {
      showToast('Preferences updated', 'success');
    },
  });

  const updateProfileMutation = useMutation<{ success: boolean; firstName: string; lastName: string; phone: string }, Error, { firstName: string; lastName: string; phone: string }>({
    mutationFn: (data) =>
      putWithCredentials<{ success: boolean; firstName: string; lastName: string; phone: string }>(
        '/api/member/profile',
        data
      ),
    onSuccess: async () => {
      showToast('Profile updated', 'success');
      setEditingProfile(false);
      await refreshUser();
    },
    onError: (err: Error) => {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to update profile', 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['memberOnboarding'] });
      queryClient.invalidateQueries({ queryKey: ['member', 'dashboard'] });
    },
  });

  const handleStartEdit = () => {
    if (!user) return;
    if (user.firstName) {
      setEditFirstName(user.firstName);
      setEditLastName(user.lastName || '');
    } else {
      const displayName = (user.name || '').includes('@') ? '' : (user.name || '');
      const nameParts = displayName.split(' ');
      setEditFirstName(nameParts[0] || '');
      setEditLastName(nameParts.slice(1).join(' ') || '');
    }
    setEditPhone(user.phone || '');
    setEditingProfile(true);
  };

  const handleSaveProfile = () => {
    if (!editFirstName.trim() || !editLastName.trim() || !editPhone.trim()) {
      showToast('All fields are required', 'error');
      return;
    }
    updateProfileMutation.mutate({
      firstName: editFirstName.trim(),
      lastName: editLastName.trim(),
      phone: editPhone.trim(),
    });
  };

  const handlePreferenceToggle = (type: 'email' | 'sms', newValue: boolean) => {
    if (!user?.email || updatePreferencesMutation.isPending) return;

    const body = type === 'email' ? { emailOptIn: newValue } : { smsOptIn: newValue };
    updatePreferencesMutation.mutate(body);
  };

  const updateSmsPreferencesMutation = useMutation<{ success: boolean }, Error, { smsPromoOptIn?: boolean; smsTransactionalOptIn?: boolean; smsRemindersOptIn?: boolean }, { previous?: PreferencesData }>({
    mutationFn: (data) =>
      putWithCredentials<{ success: boolean }>(
        `/api/members/${encodeURIComponent(user!.email)}/sms-preferences`,
        data
      ),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: ['memberPreferences', user?.email] });
      const previous = queryClient.getQueryData<PreferencesData>(['memberPreferences', user?.email]);
      queryClient.setQueryData<PreferencesData>(['memberPreferences', user?.email], (old) => {
        if (!old) return old;
        return { ...old, ...(data as Partial<PreferencesData>) };
      });
      return { previous };
    },
    onError: (_err, _data, context) => {
      if (context?.previous) queryClient.setQueryData(['memberPreferences', user?.email], context.previous);
      showToast('Failed to update SMS preferences', 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['memberPreferences', user?.email] });
    },
    onSuccess: () => {
      showToast('SMS preferences updated', 'success');
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
      showToast('Failed to delete account. Please try again.', 'error');
      setShowDeleteConfirm(false);
      setShowPrivacyModal(false);
    },
  });

  return {
    navigate,
    user,
    logout,
    isDark,
    isStaffOrAdminProfile,
    isAdminViewingAs,
    isViewingAs,
    startNavigation,

    editingProfile,
    setEditingProfile,
    editFirstName,
    setEditFirstName,
    editLastName,
    setEditLastName,
    editPhone,
    setEditPhone,
    handleStartEdit,
    handleSaveProfile,
    updateProfileMutation,

    accountBalance,
    showAddFunds,
    setShowAddFunds,
    handleAddFunds,
    addFundsMutation,

    staffDetails,
    hasPassword,
    showPasswordSection,
    setShowPasswordSection,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    showPasswordSetupBanner,
    setShowPasswordSetupBanner,
    handlePasswordSubmit,
    setPasswordMutation,

    pushEnabled,
    pushSupported,
    pushLoading,
    handlePushToggle,
    showSmsDetails,
    setShowSmsDetails,
    emailOptIn,
    smsOptIn,
    smsPromoOptIn,
    smsTransactionalOptIn,
    smsRemindersOptIn,
    handlePreferenceToggle,
    handleSmsPreferenceToggle,
    updatePreferencesMutation,
    updateSmsPreferencesMutation,

    showPrivacyModal,
    setShowPrivacyModal,
    doNotSellMyInfo,
    handleDoNotSellToggle,
    dataExportRequestedAt,
    handleDataExportRequest,
    dataExportMutation,
    showDeleteConfirm,
    setShowDeleteConfirm,
    deleteAccountMutation,

    ...auth,

    showWaiverModal,
    setShowWaiverModal,
    currentWaiverVersion,
  };
}

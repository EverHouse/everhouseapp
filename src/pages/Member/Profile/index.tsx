import React from 'react';
import MemberBottomNav from '../../../components/MemberBottomNav';
import { BottomSentinel } from '../../../components/layout/BottomSentinel';
import WaiverModal from '../../../components/WaiverModal';
import BillingSection from '../../../components/profile/BillingSection';
import { AnimatedPage } from '../../../components/motion';
import { useToast } from '../../../components/Toast';
import { useProfileData } from './useProfileData';
import { Section } from './ProfileShared';
import AccountSection from './AccountSection';
import AccountBalanceSection from './AccountBalanceSection';
import SettingsSection from './SettingsSection';
import ConnectedAccountsSection from './ConnectedAccountsSection';
import PasskeysSection from './PasskeysSection';
import StaffSection from './StaffSection';
import PrivacyModal from './PrivacyModal';

const Profile: React.FC = () => {
  const { showToast } = useToast();
  const data = useProfileData();

  if (!data.user) return null;

  return (
    <AnimatedPage>
    <div 
      className="full-bleed-page px-6 pb-32 bg-transparent md:px-8 lg:px-12 xl:px-16 pt-6"
    >
      <div className="space-y-6 md:max-w-2xl md:mx-auto lg:max-w-3xl xl:max-w-4xl">
        {data.isStaffOrAdminProfile && (
          <div className="lg:hidden">
            <button
              onClick={() => { data.startNavigation(); data.navigate('/admin'); }}
              className={`tactile-btn w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl transition-colors ${
                data.isDark 
                  ? 'bg-white/10 hover:bg-white/15 text-white' 
                  : 'bg-primary/10 hover:bg-primary/15 text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-lg">arrow_back</span>
              <span className="font-medium text-sm">Return to Staff Portal</span>
            </button>
          </div>
        )}

        <AccountSection
          isDark={data.isDark}
          isStaffOrAdminProfile={data.isStaffOrAdminProfile}
          editingProfile={data.editingProfile}
          setEditingProfile={data.setEditingProfile}
          editFirstName={data.editFirstName}
          setEditFirstName={data.setEditFirstName}
          editLastName={data.editLastName}
          setEditLastName={data.setEditLastName}
          editPhone={data.editPhone}
          setEditPhone={data.setEditPhone}
          handleStartEdit={data.handleStartEdit}
          handleSaveProfile={data.handleSaveProfile}
          updateProfilePending={data.updateProfileMutation.isPending}
          user={data.user}
          staffPhone={data.staffDetails?.phone}
        />

        {!data.isStaffOrAdminProfile && (
          <AccountBalanceSection
            isDark={data.isDark}
            accountBalance={data.accountBalance}
            showAddFunds={data.showAddFunds}
            setShowAddFunds={data.setShowAddFunds}
            handleAddFunds={data.handleAddFunds}
            addFundsPending={data.addFundsMutation.isPending}
          />
        )}

        {!data.isStaffOrAdminProfile && (
          <Section title="Billing & Invoices" isDark={data.isDark} staggerIndex={3}>
            <BillingSection isDark={data.isDark} />
          </Section>
        )}

        <SettingsSection
          isDark={data.isDark}
          isStaffOrAdminProfile={data.isStaffOrAdminProfile}
          pushEnabled={data.pushEnabled}
          pushSupported={data.pushSupported}
          pushLoading={data.pushLoading}
          handlePushToggle={data.handlePushToggle}
          showSmsDetails={data.showSmsDetails}
          setShowSmsDetails={data.setShowSmsDetails}
          emailOptIn={data.emailOptIn}
          smsOptIn={data.smsOptIn}
          smsPromoOptIn={data.smsPromoOptIn}
          smsTransactionalOptIn={data.smsTransactionalOptIn}
          smsRemindersOptIn={data.smsRemindersOptIn}
          handlePreferenceToggle={data.handlePreferenceToggle}
          handleSmsPreferenceToggle={data.handleSmsPreferenceToggle}
          updatePreferencesPending={data.updatePreferencesMutation.isPending}
          updateSmsPreferencesPending={data.updateSmsPreferencesMutation.isPending}
          onPrivacyClick={() => data.setShowPrivacyModal(true)}
        />

        <ConnectedAccountsSection
          isDark={data.isDark}
          googleStatus={data.googleStatus}
          googleLinking={data.googleLinking}
          googleUnlinking={data.googleUnlinking}
          handleGoogleLink={data.handleGoogleLink}
          handleGoogleUnlink={data.handleGoogleUnlink}
          appleStatus={data.appleStatus}
          appleLinking={data.appleLinking}
          appleUnlinking={data.appleUnlinking}
          handleAppleLink={data.handleAppleLink}
          handleAppleUnlink={data.handleAppleUnlink}
          showToast={showToast}
        />

        {data.passkeySupported && (
          <PasskeysSection
            isDark={data.isDark}
            passkeyData={data.passkeyData}
            passkeyRegistering={data.passkeyRegistering}
            passkeyRemoving={data.passkeyRemoving}
            handlePasskeyRegister={data.handlePasskeyRegister}
            handlePasskeyRemove={data.handlePasskeyRemove}
          />
        )}

        {data.isStaffOrAdminProfile && (
          <StaffSection
            isDark={data.isDark}
            user={data.user}
            staffJobTitle={data.staffDetails?.job_title}
            showPasswordSetupBanner={data.showPasswordSetupBanner}
            setShowPasswordSetupBanner={data.setShowPasswordSetupBanner}
            showPasswordSection={data.showPasswordSection}
            setShowPasswordSection={data.setShowPasswordSection}
            hasPassword={data.hasPassword}
            currentPassword={data.currentPassword}
            setCurrentPassword={data.setCurrentPassword}
            newPassword={data.newPassword}
            setNewPassword={data.setNewPassword}
            confirmPassword={data.confirmPassword}
            setConfirmPassword={data.setConfirmPassword}
            handlePasswordSubmit={data.handlePasswordSubmit}
            setPasswordPending={data.setPasswordMutation.isPending}
          />
        )}

        <button
          onClick={data.logout}
          className={`w-full p-4 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
            data.isDark 
              ? 'glass-card text-red-400 hover:bg-red-500/20' 
              : 'bg-red-50 text-red-600 hover:bg-red-100'
          }`}
        >
          <span className="material-symbols-outlined text-lg">logout</span>
          Sign Out
        </button>

        {data.isAdminViewingAs && (
          <div className={`rounded-xl p-4 ${data.isDark ? 'bg-accent/20 border border-accent/30' : 'bg-amber-50 border border-amber-200'}`}>
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined text-xl ${data.isDark ? 'text-accent' : 'text-amber-600'}`}>visibility</span>
              <div className="flex-1">
                <p className={`font-semibold text-sm ${data.isDark ? 'text-accent' : 'text-amber-800'}`}>
                  Viewing as {(data.user.name || '').includes('@') ? data.user.email?.split('@')[0] : data.user.name}
                </p>
                <p className={`text-xs mt-0.5 ${data.isDark ? 'text-white/70' : 'text-amber-700'}`}>
                  You are viewing this profile as an administrator
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <PrivacyModal
        isDark={data.isDark}
        isOpen={data.showPrivacyModal}
        onClose={() => data.setShowPrivacyModal(false)}
        doNotSellMyInfo={data.doNotSellMyInfo}
        handleDoNotSellToggle={data.handleDoNotSellToggle}
        updatePreferencesPending={data.updatePreferencesMutation.isPending}
        dataExportRequestedAt={data.dataExportRequestedAt}
        handleDataExportRequest={data.handleDataExportRequest}
        dataExportPending={data.dataExportMutation.isPending}
        showDeleteConfirm={data.showDeleteConfirm}
        setShowDeleteConfirm={data.setShowDeleteConfirm}
        deleteAccountPending={data.deleteAccountMutation.isPending}
        onDeleteAccount={() => data.deleteAccountMutation.mutate()}
      />

      <BottomSentinel />

      {(!data.isStaffOrAdminProfile || data.isViewingAs) && (
        <MemberBottomNav currentPath="/profile" isDarkTheme={data.isDark} />
      )}

      <WaiverModal
        isOpen={data.showWaiverModal}
        onComplete={() => data.setShowWaiverModal(false)}
        currentVersion={data.currentWaiverVersion}
      />
    </div>
    </AnimatedPage>
  );
};

export default Profile;

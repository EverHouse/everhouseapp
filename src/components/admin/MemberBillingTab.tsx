import React from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { StripeBillingSection } from './billing/StripeBillingSection';
import { MindbodyBillingSection } from './billing/MindbodyBillingSection';
import { MigrationConfirmDialog } from './billing/MigrationConfirmDialog';
import { FamilyAddonBillingSection } from './billing/FamilyAddonBillingSection';
import { CompedBillingSection } from './billing/CompedBillingSection';
import { TierChangeWizard } from './billing/TierChangeWizard';
import GroupBillingManager from './GroupBillingManager';
import type { MemberBillingTabProps } from './memberBilling/types';
import { BILLING_PROVIDERS } from './memberBilling/types';
import { useMemberBilling } from './memberBilling/useMemberBilling';
import { ApplyCreditModal, ApplyDiscountModal, ConfirmCancelModal, ConfirmResumeModal, ConfirmBillingSourceModal, PauseDurationModal } from './memberBilling/BillingModals';
import { CreateSubscriptionModal } from './memberBilling/CreateSubscriptionModal';
import { CollectPaymentModal } from './memberBilling/CollectPaymentModal';
import { UpdateCardTerminalModal } from './memberBilling/UpdateCardTerminalModal';
import { MembershipLevelSection } from './memberBilling/MembershipLevelSection';
import { OutstandingFeesSection } from './memberBilling/OutstandingFeesSection';
import { StripeSetupSection } from './memberBilling/StripeSetupSection';
import { GuestPassesSection } from './memberBilling/GuestPassesSection';
import { PurchaseHistorySection } from './memberBilling/PurchaseHistorySection';

const MemberBillingTab: React.FC<MemberBillingTabProps> = ({ 
  memberEmail, 
  memberId, 
  currentTier, 
  onTierUpdate,
  onMemberUpdated,
  onDrawerClose,
  guestPassInfo,
  guestHistory = [],
  guestCheckInsHistory = [],
  purchases = []
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';

  const billing = useMemberBilling(
    memberEmail,
    memberId,
    currentTier,
    onTierUpdate,
    onMemberUpdated,
    onDrawerClose,
  );

  if (billing.isLoading) {
    return (
      <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2 text-sm">
          <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
          <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>Loading billing info...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-20">
      <MembershipLevelSection
        billingInfo={billing.billingInfo}
        currentTier={currentTier}
        isEditingTier={billing.isEditingTier}
        setIsEditingTier={billing.setIsEditingTier}
        manualTier={billing.manualTier}
        setManualTier={billing.setManualTier}
        isSavingTier={billing.isSavingTier}
        validTiers={billing.VALID_TIERS}
        onSave={billing.handleManualTierSave}
        isDark={isDark}
      />

      <OutstandingFeesSection
        billingInfo={billing.billingInfo}
        outstandingData={billing.outstandingData}
        isDark={isDark}
      />

      {!billing.billingInfo?.stripeCustomerId && (
        <StripeSetupSection
          onSyncToStripe={billing.handleSyncToStripe}
          isSyncingToStripe={billing.isSyncingToStripe}
          isDark={isDark}
        />
      )}

      {billing.billingInfo?.stripeCustomerId && (
        <StripeBillingSection
          activeSubscription={billing.billingInfo.billingProvider === 'stripe' ? (billing.billingInfo.activeSubscription || null) : null}
          paymentMethods={billing.billingInfo.paymentMethods}
          recentInvoices={billing.billingInfo.recentInvoices}
          customerBalance={billing.billingInfo.customerBalance}
          isPausing={billing.isPausing}
          isResuming={billing.isResuming}
          isGettingPaymentLink={billing.isGettingPaymentLink}
          onPause={billing.billingInfo.billingProvider === 'stripe' ? () => billing.setShowPauseModal(true) : undefined}
          onResume={billing.billingInfo.billingProvider === 'stripe' ? () => billing.setShowResumeModal(true) : undefined}
          onShowCancelModal={billing.billingInfo.billingProvider === 'stripe' ? () => billing.setShowCancelModal(true) : undefined}
          onShowCreditModal={() => billing.setShowCreditModal(true)}
          onShowDiscountModal={billing.billingInfo.billingProvider === 'stripe' ? () => billing.setShowDiscountModal(true) : undefined}
          onShowTierChangeModal={billing.billingInfo.billingProvider === 'stripe' ? () => billing.setShowTierChangeModal(true) : undefined}
          onGetPaymentLink={billing.handleGetPaymentLink}
          onOpenBillingPortal={billing.handleOpenBillingPortal}
          isOpeningBillingPortal={billing.isOpeningBillingPortal}
          isDark={isDark}
          isWalletOnly={billing.billingInfo.billingProvider !== 'stripe'}
          onSyncStripeData={billing.handleSyncStripeData}
          isSyncingStripeData={billing.isSyncingStripeData}
          billingProvider={billing.billingInfo.billingProvider}
          billingProviders={BILLING_PROVIDERS}
          onUpdateBillingSource={billing.requestBillingSourceChange}
          isUpdatingSource={billing.isUpdatingSource}
          hasStripeCustomer={!!billing.billingInfo.stripeCustomerId}
          onCreateSubscription={billing.handleOpenCreateSubscription}
          onCollectPayment={billing.billingInfo.activeSubscription?.status === 'incomplete' ? billing.handleOpenCollectPayment : undefined}
          onSendActivationEmail={billing.billingInfo.activeSubscription?.status === 'incomplete' ? billing.handleSendActivationEmail : undefined}
          isSendingActivation={billing.isSendingActivation}
          onCopyActivationLink={billing.billingInfo.activeSubscription?.status === 'incomplete' ? billing.handleCopyActivationLink : undefined}
          onUpdateCardViaReader={billing.billingInfo?.stripeCustomerId ? () => billing.setShowUpdateCardTerminal(true) : undefined}
        />
      )}

      {billing.billingInfo?.billingProvider === 'mindbody' && (
        <>
          {(() => {
            const effectiveStatus = billing.billingInfo!.migrationStatus === 'cancelled' ? null : billing.billingInfo!.migrationStatus;
            if (effectiveStatus === 'pending') {
              const startDateStr = billing.billingInfo!.migrationBillingStartDate
                ? (() => { try { const d = billing.billingInfo!.migrationBillingStartDate!.includes('T') ? billing.billingInfo!.migrationBillingStartDate! : `${billing.billingInfo!.migrationBillingStartDate}T12:00:00`; return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }); } catch { return billing.billingInfo!.migrationBillingStartDate; } })()
                : '';
              return (
                <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>schedule</span>
                  <span className={`text-sm font-medium ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                    Migration Pending — Stripe billing starts {startDateStr}
                  </span>
                </div>
              );
            }
            if (effectiveStatus === 'failed') {
              return (
                <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-red-400' : 'text-red-600'}`}>error</span>
                  <span className={`text-sm font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                    Migration Failed
                  </span>
                </div>
              );
            }
            if (!effectiveStatus) {
              const hasCard = !!(billing.billingInfo!.paymentMethods && billing.billingInfo!.paymentMethods.length > 0);
              if (hasCard) {
                return (
                  <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-green-500/10 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}>
                    <span className={`material-symbols-outlined text-base ${isDark ? 'text-green-400' : 'text-green-600'}`}>check_circle</span>
                    <span className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                      Ready for Migration
                    </span>
                  </div>
                );
              }
              return (
                <div className={`p-3 rounded-xl flex items-center gap-2 ${isDark ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-amber-50 border border-amber-200'}`}>
                  <span className={`material-symbols-outlined text-base ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>credit_card_off</span>
                  <span className={`text-sm font-medium ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    Needs Card for Migration
                  </span>
                </div>
              );
            }
            return null;
          })()}
          <MindbodyBillingSection
            mindbodyClientId={billing.billingInfo!.mindbodyClientId}
            isDark={isDark}
            hasStripeCustomer={!!billing.billingInfo!.stripeCustomerId}
            stripeCustomerId={billing.billingInfo!.stripeCustomerId}
            paymentMethods={billing.billingInfo!.paymentMethods}
            recentInvoices={billing.billingInfo!.recentInvoices}
            customerBalance={billing.billingInfo!.customerBalance}
            migrationStatus={billing.billingInfo!.migrationStatus}
            migrationBillingStartDate={billing.billingInfo!.migrationBillingStartDate}
            migrationRequestedBy={billing.billingInfo!.migrationRequestedBy}
            hasCardOnFile={billing.migrationEligibility.hasCardOnFile}
            tierHasStripePrice={billing.migrationEligibility.tierHasStripePrice}
            onInitiateMigration={() => billing.setShowMigrationDialog(true)}
            onCancelMigration={billing.handleCancelMigration}
            isMigrationLoading={billing.isMigrationLoading}
          />
          <MigrationConfirmDialog
            isOpen={billing.showMigrationDialog}
            onClose={() => billing.setShowMigrationDialog(false)}
            onConfirm={billing.handleInitiateMigration}
            memberEmail={memberEmail}
            memberName={billing.billingInfo!.firstName ? `${billing.billingInfo!.firstName} ${billing.billingInfo!.lastName || ''}`.trim() : undefined}
            currentTier={currentTier || billing.billingInfo!.tier}
            cardOnFile={billing.migrationEligibility.cardOnFile}
            isDark={isDark}
            isLoading={billing.isMigrationLoading}
          />
        </>
      )}

      {billing.billingInfo?.billingProvider === 'family_addon' && (
        <FamilyAddonBillingSection
          familyGroup={billing.billingInfo.familyGroup}
          memberEmail={memberEmail}
          isDark={isDark}
        />
      )}

      {billing.billingInfo?.billingProvider === 'comped' && (
        <CompedBillingSection isDark={isDark} />
      )}

      {!billing.billingInfo?.billingProvider && (
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
              <span className={`material-symbols-outlined ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>help_outline</span>
            </div>
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-primary'}`}>No Billing Source Set</p>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Select a billing source above to manage this member's billing.
              </p>
            </div>
          </div>
        </div>
      )}

      <GuestPassesSection
        guestPassInfo={guestPassInfo}
        guestHistory={guestHistory}
        guestCheckInsHistory={guestCheckInsHistory}
        isDark={isDark}
      />

      <GroupBillingManager memberEmail={memberEmail} />

      <PurchaseHistorySection
        purchases={purchases}
        isDark={isDark}
      />

      <ApplyCreditModal
        isOpen={billing.showCreditModal}
        onClose={() => billing.setShowCreditModal(false)}
        onApply={billing.handleApplyCredit}
        isLoading={billing.isApplyingCredit}
        isDark={isDark}
      />

      <ApplyDiscountModal
        isOpen={billing.showDiscountModal}
        onClose={() => billing.setShowDiscountModal(false)}
        onApply={billing.handleApplyDiscount}
        isLoading={billing.isApplyingDiscount}
        isDark={isDark}
      />

      <ConfirmCancelModal
        isOpen={billing.showCancelModal}
        onClose={() => billing.setShowCancelModal(false)}
        onConfirm={billing.handleCancelSubscription}
        isLoading={billing.isCanceling}
        isDark={isDark}
      />

      <ConfirmResumeModal
        isOpen={billing.showResumeModal}
        onClose={() => billing.setShowResumeModal(false)}
        onConfirm={billing.handleResumeSubscription}
        isLoading={billing.isResuming}
        isDark={isDark}
      />

      <ConfirmBillingSourceModal
        isOpen={billing.showBillingSourceModal}
        onClose={() => {
          billing.setShowBillingSourceModal(false);
        }}
        onConfirm={billing.handleConfirmBillingSource}
        isLoading={billing.isUpdatingSource}
        isDark={isDark}
        currentSource={billing.billingInfo?.billingProvider || ''}
        newSource={billing.pendingBillingSource}
      />

      <PauseDurationModal
        isOpen={billing.showPauseModal}
        onClose={() => billing.setShowPauseModal(false)}
        onConfirm={billing.handlePauseSubscription}
        isLoading={billing.isPausing}
        isDark={isDark}
      />

      {billing.billingInfo?.activeSubscription && (
        <TierChangeWizard
          isOpen={billing.showTierChangeModal}
          onClose={() => billing.setShowTierChangeModal(false)}
          memberEmail={memberEmail}
          subscriptionId={billing.billingInfo.activeSubscription.id}
          currentTierName={billing.billingInfo.activeSubscription.planName || billing.billingInfo.tier || 'Unknown'}
          onSuccess={() => {
            billing.fetchBillingInfo();
            billing.setShowTierChangeModal(false);
            onMemberUpdated?.();
            setTimeout(() => onDrawerClose?.(), 600);
          }}
        />
      )}

      <CreateSubscriptionModal
        isOpen={billing.showCreateSubscriptionModal}
        onClose={() => {
          billing.setShowCreateSubscriptionModal(false);
          billing.setSelectedSubscriptionTier('');
          billing.setSelectedCoupon('');
        }}
        validTiers={billing.VALID_TIERS}
        selectedTier={billing.selectedSubscriptionTier}
        onSelectTier={billing.setSelectedSubscriptionTier}
        selectedCoupon={billing.selectedCoupon}
        onSelectCoupon={billing.setSelectedCoupon}
        availableCoupons={billing.availableCoupons}
        isLoadingCoupons={billing.isLoadingCoupons}
        isCreating={billing.isCreatingSubscription}
        onCreateSubscription={billing.handleCreateSubscription}
        isDark={isDark}
      />

      {billing.showCollectPayment && billing.billingInfo?.activeSubscription && (
        <CollectPaymentModal
          isOpen={billing.showCollectPayment}
          onClose={() => {
            billing.setShowCollectPayment(false);
            billing.setCollectPaymentMode('terminal');
            billing.showError(null);
          }}
          billingInfo={billing.billingInfo}
          memberId={memberId}
          memberEmail={memberEmail}
          collectPaymentAmount={billing.collectPaymentAmount}
          collectPaymentMode={billing.collectPaymentMode}
          setCollectPaymentMode={billing.setCollectPaymentMode}
          isChargingCard={billing.isChargingCard}
          onChargeCard={billing.handleChargeCard}
          onTerminalSuccess={billing.handleTerminalPaymentSuccess}
          onError={(msg) => billing.showError(msg)}
          isDark={isDark}
        />
      )}

      {billing.showUpdateCardTerminal && billing.billingInfo?.stripeCustomerId && (
        <UpdateCardTerminalModal
          isOpen={billing.showUpdateCardTerminal}
          onClose={() => billing.setShowUpdateCardTerminal(false)}
          billingInfo={billing.billingInfo}
          memberId={memberId}
          memberEmail={memberEmail}
          onSuccess={billing.handleUpdateCardSuccess}
          onError={billing.handleUpdateCardError}
          isDark={isDark}
        />
      )}
    </div>
  );
};

export default MemberBillingTab;

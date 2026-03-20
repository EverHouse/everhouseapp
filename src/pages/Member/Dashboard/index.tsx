import React from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { getPacificHour, CLUB_TIMEZONE } from '../../../utils/dateUtils';
import PageLoadingSpinner from '../../../components/PageLoadingSpinner';
import { SmoothReveal } from '../../../components/motion/SmoothReveal';
import { AnimatedPage } from '../../../components/motion';
import ClosureAlert from '../../../components/ClosureAlert';
import AnnouncementAlert from '../../../components/AnnouncementAlert';
import ErrorState from '../../../components/ErrorState';
import OnboardingChecklist from '../../../components/OnboardingChecklist';
import ModalShell from '../../../components/ModalShell';
import HubSpotFormModal from '../../../components/HubSpotFormModal';
import FirstLoginWelcomeModal from '../../../components/FirstLoginWelcomeModal';
import NfcCheckinWelcomeModal from '../../../components/NfcCheckinWelcomeModal';
import { GUEST_CHECKIN_FIELDS } from './dashboardTypes';
import { useDashboardData } from './useDashboardData';
import { MembershipCard } from './MembershipCard';
import { ScheduleSection } from './ScheduleSection';
import { PasskeyNudge, BannerAlert, MembershipStatusAlert } from './DashboardAlerts';
import Icon from '../../../components/icons/Icon';

const getGreeting = () => {
  const hour = getPacificHour();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

const Dashboard: React.FC = () => {
  const data = useDashboardData();
  const [scheduleRef] = useAutoAnimate();

  const {
    navigate, queryClient, user, isDark, isStaffOrAdminProfile, tierPermissions,
    startNavigation, showToast,

    confirmModal, setConfirmModal,
    showGuestCheckin, setShowGuestCheckin,
    isCardOpen, setIsCardOpen,
    bannerDismissed, setBannerDismissed,
    bannerExiting, setBannerExiting,
    bannerExitTimer,
    showPasskeyNudge, setShowPasskeyNudge,
    walletPassDownloading,
    showFirstLoginModal, setShowFirstLoginModal,
    nfcCheckinData, setNfcCheckinData,

    coreScheduleLoading,
    initialLoading,
    error,
    rsvpSectionError,
    wellnessSectionError,

    guestPasses,
    bannerAnnouncement,
    isBannerInitiallyDismissed,
    walletPassAvailable,
    statsData,

    simMinutesToday,
    confMinutesToday,
    nextEvent,
    nextWellnessClass,
    upcomingItemsFiltered,

    isAppleDevice,

    refetchAllData,
    handleCancelBooking,
    handleLeaveBooking,
    handleCancelRSVP,
    handleCancelWellness,
    handleDownloadBookingWalletPass,
  } = data;

  if (error) {
    return (
      <div className="full-bleed-page px-6 pb-32 bg-transparent pt-4">
        <ErrorState
          title="Unable to load dashboard"
          message={error}
          onRetry={() => refetchAllData()}
        />
      </div>
    );
  }

  return (
    <AnimatedPage>
    <SmoothReveal isLoaded={!initialLoading}>
    <div className="full-bleed-page flex flex-col">
    {initialLoading ? (
      <PageLoadingSpinner />
    ) : (
    <>
    <div className="flex-1 flex flex-col">
      <div className="px-6 lg:px-8 xl:px-12 pt-4 md:pt-2 pb-32 font-sans relative flex-1">
        <ClosureAlert />
        <AnnouncementAlert />

        <PasskeyNudge
          isDark={isDark}
          showPasskeyNudge={showPasskeyNudge}
          setShowPasskeyNudge={setShowPasskeyNudge}
          startNavigation={startNavigation}
          navigate={navigate}
        />

        <SmoothReveal isLoaded={!!bannerAnnouncement && !bannerDismissed && !isBannerInitiallyDismissed} delay={50}>
          <BannerAlert
            isDark={isDark}
            bannerAnnouncement={bannerAnnouncement}
            bannerDismissed={bannerDismissed}
            isBannerInitiallyDismissed={isBannerInitiallyDismissed}
            bannerExiting={bannerExiting}
            setBannerExiting={setBannerExiting}
            setBannerDismissed={setBannerDismissed}
            bannerExitTimer={bannerExitTimer}
            userEmail={user?.email}
            startNavigation={startNavigation}
            navigate={navigate}
          />
        </SmoothReveal>
        
        <SmoothReveal isLoaded={!!user?.status && !['active', 'trialing', 'past_due'].includes(user.status.toLowerCase())} delay={100}>
          <MembershipStatusAlert isDark={isDark} userStatus={user?.status} />
        </SmoothReveal>
        
        <OnboardingChecklist />
        
        <div className="mb-6 animate-content-enter">
          <div className="flex items-center gap-3">
            <h1 className={`text-3xl sm:text-4xl md:text-5xl leading-none translate-y-[1px] ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-display)', fontOpticalSizing: 'auto', letterSpacing: '-0.03em' }}>
              {getGreeting()}, {user?.firstName || (user?.name && !user.name.includes('@') ? user.name.split(' ')[0] : 'there')}
            </h1>
          </div>
          <p className={`text-sm lg:text-base font-medium mt-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            {new Date().toLocaleDateString('en-US', { timeZone: CLUB_TIMEZONE, weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>

        <SmoothReveal isLoaded={!isStaffOrAdminProfile} delay={150}>
        {!isStaffOrAdminProfile && (
          <MembershipCard
            user={user}
            isDark={isDark}
            isStaffOrAdminProfile={isStaffOrAdminProfile}
            statsData={statsData}
            guestPasses={guestPasses}
            tierPermissions={tierPermissions}
            simMinutesToday={simMinutesToday}
            confMinutesToday={confMinutesToday}
            nextWellnessClass={nextWellnessClass}
            nextEvent={nextEvent}
            walletPassAvailable={walletPassAvailable}
            isCardOpen={isCardOpen}
            setIsCardOpen={setIsCardOpen}
            navigate={navigate}
            showToast={showToast}
          />
        )}
        </SmoothReveal>

        <SmoothReveal isLoaded={!coreScheduleLoading} delay={200}>
        {error ? (
        <div className="p-4 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm flex items-center gap-3 mb-6">
          <Icon name="error" />
          {error}
        </div>
      ) : (
        <>
          <ScheduleSection
            isDark={isDark}
            upcomingItemsFiltered={upcomingItemsFiltered}
            isStaffOrAdminProfile={isStaffOrAdminProfile}
            walletPassAvailable={walletPassAvailable}
            isAppleDevice={isAppleDevice}
            walletPassDownloading={walletPassDownloading}
            rsvpSectionError={rsvpSectionError}
            wellnessSectionError={wellnessSectionError}
            startNavigation={startNavigation}
            navigate={navigate}
            refetchAllData={refetchAllData}
            handleCancelBooking={handleCancelBooking}
            handleLeaveBooking={handleLeaveBooking}
            handleCancelRSVP={handleCancelRSVP}
            handleCancelWellness={handleCancelWellness}
            handleDownloadBookingWalletPass={handleDownloadBookingWalletPass}
            scheduleRef={scheduleRef}
          />
        </>
      )}
      </SmoothReveal>
      </div>
    </div>

    <ModalShell 
      isOpen={!!confirmModal} 
      onClose={() => setConfirmModal(null)}
      title={confirmModal?.title || ''}
      size="sm"
    >
      {confirmModal && (
        <div className="p-6">
          <p className="mb-6 text-sm opacity-70">{confirmModal.message}</p>
          <div className="flex gap-3">
            <button 
              onClick={() => setConfirmModal(null)}
              className={`tactile-btn flex-1 py-3 rounded-xl font-bold text-sm cursor-pointer ${isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-100 hover:bg-gray-200'}`}
            >
              Keep it
            </button>
            <button 
              onClick={confirmModal.onConfirm}
              className="tactile-btn flex-1 py-3 rounded-xl font-bold text-sm bg-red-500 hover:bg-red-600 text-white shadow-lg cursor-pointer"
            >
              Yes, Cancel
            </button>
          </div>
        </div>
      )}
    </ModalShell>

    <HubSpotFormModal
      isOpen={showGuestCheckin}
      onClose={() => setShowGuestCheckin(false)}
      formType="guest-checkin"
      title="Guest Check-In"
      subtitle="Register your guest for today's visit."
      fields={GUEST_CHECKIN_FIELDS}
      submitButtonText="Check In Guest"
      additionalFields={{
        member_name: (user?.name || '').includes('@') ? '' : (user?.name || ''),
        member_email: user?.email || ''
      }}
      onSuccess={async () => {
        queryClient.invalidateQueries({ queryKey: ['member', 'dashboard'] });
      }}
    />

    <FirstLoginWelcomeModal
      isOpen={showFirstLoginModal}
      onClose={() => setShowFirstLoginModal(false)}
      firstName={user?.firstName || (user?.name && !user.name.includes('@') ? user.name.split(' ')[0] : undefined)}
    />

    <NfcCheckinWelcomeModal
      isOpen={!!nfcCheckinData}
      onClose={() => setNfcCheckinData(null)}
      checkinData={nfcCheckinData}
    />
    </>
  )}
    </div>
    </SmoothReveal>
    </AnimatedPage>
  );
};

export default Dashboard;

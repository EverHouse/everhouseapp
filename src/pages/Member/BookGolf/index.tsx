import React from 'react';
import { SegmentedButton } from '../../../components/ui/SegmentedButton';
import SwipeablePage from '../../../components/SwipeablePage';
import { haptic } from '../../../utils/haptics';
import PlayerSlotEditor from '../../../components/shared/PlayerSlotEditor';
import { AnimatedPage } from '../../../components/motion';
import { TabTransition } from '../../../components/motion/TabTransition';
import { formatTime12Hour } from '../../../utils/dateUtils';
import DatePickerStrip from '../bookGolf/DatePickerStrip';
import ResourceCard from '../bookGolf/ResourceCard';
import { useBookGolf } from './useBookGolf';
import DurationSelector from './DurationSelector';
import TimeSlotsSection from './TimeSlotsSection';
import ExistingBookings from './ExistingBookings';
import BookingModals from './BookingModals';
import BookingFooter from './BookingFooter';
import ClosureAlerts from './ClosureAlerts';

const BookGolf: React.FC = () => {
  const state = useBookGolf();

  const {
    activeTab, setActiveTab, playerCount, setPlayerCount, duration, setDuration,
    memberNotes, setMemberNotes, selectedSlot, setSelectedSlot, selectedResource, setSelectedResource,
    showConfirmation, showViewAsConfirm, setShowViewAsConfirm,
    expandedHour, setExpandedHour, hasUserSelectedDuration, setHasUserSelectedDuration,
    playerSlots, setPlayerSlots, cancelTargetBooking, setCancelTargetBooking,
    showCancelConfirm, setShowCancelConfirm, showGuardianConsent, setShowGuardianConsent,
    walletPassDownloading, setWalletPassDownloading,
    conferencePaymentRequired, conferenceOverageFee,
    showUnfilledSlotsWarning, setShowUnfilledSlotsWarning,
    selectedDateObj, setSelectedDateObj,
    effectiveUser, viewAsUser,
    tierPermissions, isTierLoaded, canBookSimulators, canBookConference,
    dates, resources, guestPassInfo, walletPassAvailable,
    estimatedFees, isLoading, error, isBooking, isDark,
    memberBayBookingsForDay, usedMinutesForDay, isAtDailyLimit,
    slotsByHour, activeClosures, canBook,
    handleCancelRequest, handleConfirm, handleGuardianConsentSubmit, submitBooking, getAvailableResourcesForSlot,
    guestFeeDollars, overageRatePerBlockDollars, cancelBookingMutation,
    resourcesRef, errorRef, playerSlotRef, feeRef, timeSlotsAnimRef,
    timeSlotsRef, baySelectionRef, requestButtonRef, showToast,
  } = state;

  return (
    <AnimatedPage>
    <SwipeablePage className="px-6 lg:px-8 xl:px-12 relative">
      <section className="mb-8 pt-6 md:pt-4 animate-content-enter-delay-1">
        <h1 className={`leading-none mb-3 text-4xl md:text-5xl ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-display)' }}>
          Your <span className="italic">{activeTab === 'simulator' ? 'Session' : 'Room'}</span>
        </h1>
        <p className={`text-base leading-relaxed max-w-md ${isDark ? 'text-white/60' : 'text-primary/60'}`} style={{ fontFamily: 'var(--font-body)' }}>{activeTab === 'simulator' ? 'Choose your party size, select a date, and reserve your preferred bay from the availability grid below. Requests are reviewed and confirmed by Concierge.' : 'Select your date, duration, and preferred conference space below. Conference rooms are confirmed instantly upon booking.'}</p>
      </section>

      {effectiveUser?.status && !['active', 'trialing', 'past_due'].includes(effectiveUser.status.toLowerCase()) ? (
        <section className={`rounded-xl p-6 border text-center glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <span className="material-symbols-outlined text-4xl text-accent-dark dark:text-accent mb-4">lock</span>
          <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Membership Not Active</h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
            Your membership is currently {effectiveUser.status.toLowerCase()}. Please contact the front desk or update your membership to resume booking.
          </p>
          <a href="/membership" className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-brand-green rounded-xl font-bold text-sm">
            <span className="material-symbols-outlined text-lg">upgrade</span>View Membership Options
          </a>
        </section>
      ) : (
        <>
        <section className="mb-8">
          <SegmentedButton
            options={[
              { value: 'simulator' as const, label: 'Golf Simulator' },
              { value: 'conference' as const, label: 'Conference Room' },
            ]}
            value={activeTab}
            onChange={setActiveTab}
            aria-label="Booking type"
          />
        </section>

        {activeTab === 'simulator' && isTierLoaded && !canBookSimulators ? (
          <section className={`rounded-xl p-6 border text-center glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
            <span className="material-symbols-outlined text-4xl text-accent-dark dark:text-accent mb-4">lock</span>
            <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Upgrade to Book Simulators</h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
              Golf simulator access is available for Core, Premium, and Corporate members. Upgrade your membership to start booking.
            </p>
            <a href="/membership" className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-brand-green rounded-xl font-bold text-sm">
              <span className="material-symbols-outlined text-lg">upgrade</span>View Membership Options
            </a>
          </section>
        ) : activeTab === 'conference' && isTierLoaded && !canBookConference ? (
          <section className={`rounded-xl p-6 border text-center glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
            <span className="material-symbols-outlined text-4xl text-accent-dark dark:text-accent mb-4">lock</span>
            <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-primary'}`}>Upgrade for Conference Room Access</h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
              Conference room booking is available for Core, Premium, and Corporate members. Upgrade your membership to start booking.
            </p>
            <a href="/membership" className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-brand-green rounded-xl font-bold text-sm">
              <span className="material-symbols-outlined text-lg">upgrade</span>View Membership Options
            </a>
          </section>
        ) : (
          <TabTransition activeKey={activeTab}>
          <div ref={playerSlotRef} className="relative z-10 animate-content-enter space-y-6">
            {activeTab === 'simulator' && (
              <PlayerSlotEditor
                playerCount={playerCount}
                onPlayerCountChange={(count) => { haptic.selection(); setPlayerCount(count); }}
                slots={playerSlots}
                onSlotsChange={setPlayerSlots}
                guestPassesRemaining={guestPassInfo?.passes_remaining}
                isDark={isDark}
                privacyMode={true}
                maxPlayers={4}
                showPlayerCountSelector={true}
                ownerMemberId={effectiveUser?.id}
              />
            )}

            <section>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[11px] font-bold uppercase tracking-[0.2em] ${isDark ? 'text-white/80' : 'text-primary/80'}`} style={{ fontFamily: 'var(--font-label)' }}>Date & Duration</span>
              </div>
              <div className="space-y-4">
                <DatePickerStrip
                  dates={dates}
                  selectedDate={selectedDateObj?.date}
                  onSelectDate={(d) => { setSelectedDateObj(d); setExpandedHour(null); }}
                  isDark={isDark}
                />
                <div className={`grid ${activeTab === 'simulator' ? 'grid-cols-2' : 'grid-cols-4'} gap-2`}>
                  <DurationSelector
                    activeTab={activeTab}
                    playerCount={playerCount}
                    duration={duration}
                    setDuration={setDuration}
                    setExpandedHour={setExpandedHour}
                    setHasUserSelectedDuration={setHasUserSelectedDuration}
                    isDark={isDark}
                    usedMinutesForDay={usedMinutesForDay}
                    overageRatePerBlockDollars={overageRatePerBlockDollars}
                    tierPermissions={tierPermissions}
                  />
                </div>
              </div>
            </section>

            <div className={`border-t my-2 ${isDark ? 'border-white/10' : 'border-black/5'}`} />

            <div ref={errorRef}>
              {error && (
                <div className="p-4 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm flex items-center gap-3">
                  <span className="material-symbols-outlined">error</span>
                  {error}
                </div>
              )}
            </div>

            <ClosureAlerts closures={activeClosures} isDark={isDark} />

            {activeTab === 'simulator' && (
              <ExistingBookings
                bookings={memberBayBookingsForDay}
                isDark={isDark}
                walletPassAvailable={walletPassAvailable}
                walletPassDownloading={walletPassDownloading}
                setWalletPassDownloading={setWalletPassDownloading}
                setCancelTargetBooking={setCancelTargetBooking}
                setShowCancelConfirm={setShowCancelConfirm}
                showToast={showToast}
              />
            )}

            <BookingModals
              isDark={isDark}
              showCancelConfirm={showCancelConfirm}
              setShowCancelConfirm={setShowCancelConfirm}
              cancelTargetBooking={cancelTargetBooking}
              setCancelTargetBooking={setCancelTargetBooking}
              cancelBookingIsPending={cancelBookingMutation.isPending}
              handleCancelRequest={handleCancelRequest}
              showViewAsConfirm={showViewAsConfirm}
              setShowViewAsConfirm={setShowViewAsConfirm}
              viewAsUser={viewAsUser}
              submitBooking={submitBooking}
              showGuardianConsent={showGuardianConsent}
              setShowGuardianConsent={setShowGuardianConsent}
              effectiveUserName={effectiveUser?.name || ''}
              handleGuardianConsentSubmit={handleGuardianConsentSubmit}
              showUnfilledSlotsWarning={showUnfilledSlotsWarning}
              setShowUnfilledSlotsWarning={setShowUnfilledSlotsWarning}
              playerCount={playerCount}
              playerSlots={playerSlots}
            />

            {activeTab === 'conference' && memberBayBookingsForDay.length > 0 && (
              <div className={`rounded-xl p-3 border ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}>
                <p className={`text-sm flex items-center gap-2 ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                  <span className="material-symbols-outlined text-lg">info</span>
                  Time slots during your {memberBayBookingsForDay.length > 1 ? 'bay bookings' : 'bay booking'} ({memberBayBookingsForDay.map(b => `${formatTime12Hour(b.start_time)} - ${formatTime12Hour(b.end_time)}`).join(', ')}) are unavailable
                </p>
              </div>
            )}

            {(activeTab !== 'simulator' || !isAtDailyLimit) && (
              <>
              <TimeSlotsSection
                slotsByHour={slotsByHour}
                selectedSlot={selectedSlot}
                setSelectedSlot={setSelectedSlot}
                setSelectedResource={() => setSelectedResource(null)}
                expandedHour={expandedHour}
                setExpandedHour={setExpandedHour}
                isLoading={isLoading}
                isDark={isDark}
                activeTab={activeTab}
                dates={dates}
                selectedDateObj={selectedDateObj}
                setSelectedDateObj={setSelectedDateObj}
                timeSlotsRef={timeSlotsRef}
                timeSlotsAnimRef={timeSlotsAnimRef}
              />

              {selectedSlot && (
                <section ref={baySelectionRef} className="animate-pop-in">
                  <h3 className={`text-[11px] font-bold uppercase tracking-[0.2em] mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`} style={{ fontFamily: 'var(--font-label)' }}>
                    {activeTab === 'simulator' ? 'Facility' : 'Select Room'}
                  </h3>
                  <div ref={resourcesRef} className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                    {getAvailableResourcesForSlot(selectedSlot).map((resource) => (
                      <div key={resource.id}>
                        <ResourceCard
                          resource={resource}
                          selected={selectedResource?.id === resource.id}
                          onClick={() => { haptic.medium(); setSelectedResource(resource); }}
                          isDark={isDark}
                        />
                      </div>
                    ))}
                    {resources
                      .filter(r => selectedSlot.requestedResourceDbIds.includes(r.dbId) && !selectedSlot.availableResourceDbIds.includes(r.dbId))
                      .map((resource) => (
                        <div key={`requested-${resource.id}`}>
                          <ResourceCard resource={resource} selected={false} onClick={() => {}} isDark={isDark} requested />
                        </div>
                      ))}
                  </div>
                </section>
              )}

              {selectedResource && (
                <section className={`animate-content-enter ${activeTab === 'conference' ? (conferencePaymentRequired && conferenceOverageFee > 0 ? 'pb-96' : 'pb-56') : 'pb-32'}`}>
                  <h3 className={`text-[11px] font-bold uppercase tracking-[0.2em] mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`} style={{ fontFamily: 'var(--font-label)' }}>
                    Notes for Staff <span className="font-normal opacity-60">(optional)</span>
                  </h3>
                  <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-white/20 bg-black/20' : 'border-black/10 bg-white'}`}>
                    <textarea
                      value={memberNotes}
                      onChange={(e) => setMemberNotes(e.target.value.slice(0, 280))}
                      placeholder="Any special requests or information for staff..."
                      maxLength={280}
                      rows={3}
                      className={`w-full p-4 resize-none focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset ${
                        isDark ? 'bg-transparent text-white placeholder:text-white/40' : 'bg-transparent text-primary placeholder:text-primary/40'
                      }`}
                    />
                    <div className={`px-4 py-2 text-xs text-right border-t ${isDark ? 'border-white/10 text-white/50' : 'border-black/5 text-primary/50'}`}>
                      {memberNotes.length}/280
                    </div>
                  </div>
                </section>
              )}
              </>
            )}
          </div>
          </TabTransition>
        )}
        </>
      )}

      <BookingFooter
        canBook={canBook}
        isBooking={isBooking}
        isDark={isDark}
        activeTab={activeTab}
        conferencePaymentRequired={conferencePaymentRequired}
        conferenceOverageFee={conferenceOverageFee}
        handleConfirm={handleConfirm}
        estimatedFees={estimatedFees}
        guestFeeDollars={guestFeeDollars}
        guestPassInfo={guestPassInfo}
        effectiveUserTier={effectiveUser?.tier}
        requestButtonRef={requestButtonRef}
        feeRef={feeRef}
        showConfirmation={showConfirmation}
      />

    </SwipeablePage>
    </AnimatedPage>
  );
};

export default BookGolf;

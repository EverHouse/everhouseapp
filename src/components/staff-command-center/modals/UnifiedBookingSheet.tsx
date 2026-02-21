import { SlideUpDrawer } from '../../SlideUpDrawer';
import { SheetHeader } from './SheetHeader';
import { PaymentSummaryBody, PaymentActionFooter } from './PaymentSection';
import { AssignModeSlots } from './AssignModeSlots';
import { ManageModeRoster } from './ManageModeRoster';
import { AssignModeFooter, AssignModeSecondaryActions } from './AssignModeFooter';
import { ErrorBoundary } from '../../ErrorBoundary';
import { useUnifiedBookingLogic } from './useUnifiedBookingLogic';
import { isPlaceholderEmail } from './bookingSheetTypes';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import type { BookingContextType } from './bookingSheetTypes';

export type BookingType = 'simulator' | 'conference_room' | 'lesson' | 'staff_block';
export type SheetMode = 'assign' | 'manage';

export interface UnifiedBookingSheetProps {
  isOpen: boolean;
  onClose: () => void;
  mode: SheetMode;
  bookingType?: BookingType;
  trackmanBookingId?: string | null;
  bayName?: string;
  bookingDate?: string;
  timeSlot?: string;
  matchedBookingId?: number | string;
  currentMemberName?: string;
  currentMemberEmail?: string;
  isRelink?: boolean;
  importedName?: string;
  notes?: string;
  isLegacyReview?: boolean;
  originalEmail?: string;
  bookingId?: number;
  ownerName?: string;
  ownerEmail?: string;
  declaredPlayerCount?: number;
  bookingContext?: BookingContextType;
  checkinMode?: boolean;
  onSuccess?: (options?: { markedAsEvent?: boolean; memberEmail?: string; memberName?: string }) => void;
  onOpenBillingModal?: (bookingId: number) => void;
  onRosterUpdated?: () => void;
  onCheckinComplete?: () => void;
  onCollectPayment?: (bookingId: number) => void;
  onReschedule?: (booking: { id: number; requestDate: string; startTime: string; endTime: string; resourceId: number; resourceName?: string; userName?: string; userEmail?: string }) => void;
  onCancelBooking?: (bookingId: number) => void;
  onCheckIn?: (bookingId: number) => void;
  bookingStatus?: string;
  ownerMembershipStatus?: string | null;
}

export function UnifiedBookingSheet(props: UnifiedBookingSheetProps) {
  const {
    isOpen,
    onClose,
    bookingType,
    trackmanBookingId,
    bayName,
    bookingDate,
    timeSlot,
    notes,
    isLegacyReview,
    originalEmail,
    bookingId,
    ownerName,
    ownerEmail,
    bookingContext,
    checkinMode,
    onReschedule,
    onCancelBooking,
    onCheckIn,
    bookingStatus,
    ownerMembershipStatus,
    isRelink,
    currentMemberName,
    currentMemberEmail,
    importedName,
    declaredPlayerCount,
  } = props;

  const logic = useUnifiedBookingLogic(props);

  if (logic.isManageMode) {
    const validation = logic.rosterData?.validation;
    const filledCount = validation ? validation.actualPlayerCount : 0;
    const totalCount = validation ? validation.expectedPlayerCount : (declaredPlayerCount || 1);

    const manageModeTitle = ownerName || logic.fetchedContext?.ownerName || 'Booking Details';

    const handleManagedClose = () => {
      onClose();
    };

    const manageModeFooter = (
      <PaymentActionFooter
        isConferenceRoom={logic.isConferenceRoom}
        bookingId={bookingId}
        rosterData={logic.rosterData}
        fetchedContext={logic.fetchedContext}
        ownerName={ownerName}
        ownerEmail={ownerEmail}
        bayName={bayName}
        bookingDate={bookingDate}
        showInlinePayment={logic.showInlinePayment}
        setShowInlinePayment={logic.setShowInlinePayment}
        inlinePaymentAction={logic.inlinePaymentAction}
        setInlinePaymentAction={logic.setInlinePaymentAction}
        paymentSuccess={logic.paymentSuccess}
        processingPayment={logic.processingPayment}
        savedCardInfo={logic.savedCardInfo}
        checkingCard={logic.checkingCard}
        showWaiverInput={logic.showWaiverInput}
        setShowWaiverInput={logic.setShowWaiverInput}
        waiverReason={logic.waiverReason}
        setWaiverReason={logic.setWaiverReason}
        handleInlineStripeSuccess={logic.handleInlineStripeSuccess}
        handleChargeCardOnFile={logic.handleInlineChargeSavedCard}
        handleWaiveFees={logic.handleInlineWaiveAll}
        renderTierBadge={logic.renderTierBadge}
        onClose={handleManagedClose}
        checkinMode={checkinMode}
        savingChanges={logic.savingChanges}
        handleManageModeSave={logic.handleManageModeSave}
        onCheckIn={onCheckIn}
        onReschedule={onReschedule}
        onCancelBooking={onCancelBooking}
        bookingContext={bookingContext}
        bookingStatus={bookingStatus}
      />
    );

    return (
      <SlideUpDrawer
        isOpen={isOpen}
        onClose={handleManagedClose}
        title={manageModeTitle}
        maxHeight="full"
        stickyFooter={manageModeFooter}
      >
        <div className="p-4 space-y-4">
          {logic.isLoadingRoster ? (
            <div className="flex items-center justify-center py-12">
              <WalkingGolferSpinner size="sm" variant="dark" />
            </div>
          ) : logic.rosterError ? (
            <div className="text-center py-8">
              <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
              <p className="text-red-600 dark:text-red-400">{logic.rosterError}</p>
              <button type="button" onClick={logic.fetchRosterData} className="mt-4 px-4 py-2 bg-primary text-white rounded-lg text-sm">
                Retry
              </button>
            </div>
          ) : (
            <>
              <SheetHeader
                isManageMode={true}
                isConferenceRoom={logic.isConferenceRoom}
                bayName={bayName}
                bookingDate={bookingDate}
                timeSlot={timeSlot}
                trackmanBookingId={trackmanBookingId}
                notes={notes}
                bookingContext={bookingContext}
                fetchedContext={logic.fetchedContext}
                bookingStatus={bookingStatus}
                ownerMembershipStatus={ownerMembershipStatus}
                isOwnerStaff={logic.rosterData?.isOwnerStaff}
                rosterData={logic.rosterData}
              />

              {!logic.isConferenceRoom && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h4 className="font-medium text-primary dark:text-white">Player Slots</h4>
                    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                      filledCount === totalCount 
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                    }`}>
                      {filledCount}/{totalCount} Assigned
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-primary/60 dark:text-white/60">Players:</label>
                    <select
                      value={logic.editingPlayerCount}
                      onChange={(e) => logic.handleManageModeUpdatePlayerCount(Number(e.target.value))}
                      disabled={logic.isUpdatingPlayerCount}
                      className="px-2 py-1 rounded-lg bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white text-xs disabled:opacity-50"
                    >
                      {[1, 2, 3, 4].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    {logic.isUpdatingPlayerCount && (
                      <span className="material-symbols-outlined animate-spin text-sm text-primary/50 dark:text-white/50">progress_activity</span>
                    )}
                  </div>
                </div>
              )}

              {!logic.isConferenceRoom && logic.rosterData?.tierLimits?.guest_passes_per_month && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="material-symbols-outlined text-emerald-500 text-sm">redeem</span>
                  <span className="text-primary/70 dark:text-white/70">
                    Guest Passes: <span className="font-semibold text-primary dark:text-white">
                      {logic.rosterData.ownerGuestPassesRemaining}/{logic.rosterData.tierLimits.guest_passes_per_month}
                    </span> remaining
                  </span>
                </div>
              )}

              <ErrorBoundary fallback={<div className="p-3 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-900/10 text-sm text-red-600 dark:text-red-400">Roster section encountered an error. Please close and reopen this booking.</div>}>
                <ManageModeRoster
                  rosterData={logic.rosterData}
                  editingPlayerCount={logic.editingPlayerCount}
                  guestFeeDollars={logic.guestFeeDollars}
                  unlinkingSlotId={logic.unlinkingSlotId}
                  removingGuestId={logic.removingGuestId}
                  manageModeGuestForm={logic.manageModeGuestForm}
                  setManageModeGuestForm={logic.setManageModeGuestForm}
                  manageModeGuestData={logic.manageModeGuestData}
                  setManageModeGuestData={logic.setManageModeGuestData}
                  isAddingManageGuest={logic.isAddingManageGuest}
                  memberMatchWarning={logic.memberMatchWarning}
                  setMemberMatchWarning={logic.setMemberMatchWarning}
                  manageModeSearchSlot={logic.manageModeSearchSlot}
                  setManageModeSearchSlot={logic.setManageModeSearchSlot}
                  isLinkingMember={logic.isLinkingMember}
                  isConferenceRoom={logic.isConferenceRoom}
                  handleManageModeRemoveGuest={logic.handleManageModeRemoveGuest}
                  handleManageModeUnlinkMember={logic.handleManageModeUnlinkMember}
                  handleManageModeLinkMember={logic.handleManageModeLinkMember}
                  handleManageModeAddGuest={logic.handleManageModeAddGuest}
                  handleManageModeMemberMatchResolve={logic.handleManageModeMemberMatchResolve}
                  handleManageModeQuickAddGuest={logic.handleManageModeQuickAddGuest}
                  isQuickAddingGuest={logic.isQuickAddingGuest}
                  renderTierBadge={logic.renderTierBadge}
                  isReassigningOwner={logic.isReassigningOwner}
                  reassignSearchOpen={logic.reassignSearchOpen}
                  setReassignSearchOpen={logic.setReassignSearchOpen}
                  handleReassignOwner={logic.handleReassignOwner}
                  bookingId={bookingId}
                />
              </ErrorBoundary>

              <ErrorBoundary fallback={<div className="p-3 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-900/10 text-sm text-red-600 dark:text-red-400">Payment section encountered an error. Please close and reopen this booking.</div>}>
                <PaymentSummaryBody
                  isConferenceRoom={logic.isConferenceRoom}
                  rosterData={logic.rosterData}
                  renderTierBadge={logic.renderTierBadge}
                  paymentSuccess={logic.paymentSuccess}
                />
              </ErrorBoundary>

            </>
          )}
        </div>
      </SlideUpDrawer>
    );
  }

  const drawerTitle = `${bayName || 'Booking'}${timeSlot ? ` • ${timeSlot}` : ''}`;

  const stickyFooterContent = (
    <AssignModeFooter
      hasOwner={logic.hasOwner}
      linking={logic.linking}
      feeEstimate={logic.feeEstimate}
      isCalculatingFees={logic.isCalculatingFees}
      isConferenceRoom={logic.isConferenceRoom}
      onClose={onClose}
      handleFinalizeBooking={logic.handleFinalizeBooking}
    />
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={drawerTitle}
      maxHeight="full"
      stickyFooter={stickyFooterContent}
    >
      <div className="p-4 space-y-4">
        <SheetHeader
          isManageMode={false}
          isConferenceRoom={logic.isConferenceRoom}
          bayName={bayName}
          bookingDate={bookingDate}
          timeSlot={timeSlot}
          trackmanBookingId={trackmanBookingId}
          notes={notes}
          bookingContext={bookingContext}
          fetchedContext={logic.fetchedContext}
          bookingStatus={bookingStatus}
          isRelink={isRelink}
          currentMemberName={currentMemberName}
          currentMemberEmail={currentMemberEmail}
          importedName={importedName}
          isPlaceholderEmail={isPlaceholderEmail}
        />

        <AssignModeSlots
          slots={logic.slots}
          activeSlotIndex={logic.activeSlotIndex}
          setActiveSlotIndex={logic.setActiveSlotIndex}
          showAddVisitor={logic.showAddVisitor}
          setShowAddVisitor={logic.setShowAddVisitor}
          visitorData={logic.visitorData}
          setVisitorData={logic.setVisitorData}
          isCreatingVisitor={logic.isCreatingVisitor}
          visitorSearch={logic.visitorSearch}
          setVisitorSearch={logic.setVisitorSearch}
          visitorSearchResults={logic.visitorSearchResults}
          isSearchingVisitors={logic.isSearchingVisitors}
          potentialDuplicates={logic.potentialDuplicates}
          isCheckingDuplicates={logic.isCheckingDuplicates}
          guestFeeDollars={logic.guestFeeDollars}
          isLegacyReview={isLegacyReview}
          isLessonOrStaffBlock={logic.isLessonOrStaffBlock}
          isConferenceRoom={logic.isConferenceRoom}
          filledSlotsCount={logic.filledSlotsCount}
          guestCount={logic.guestCount}
          updateSlot={logic.updateSlot}
          clearSlot={logic.clearSlot}
          handleMemberSelect={logic.handleMemberSelect}
          handleAddGuestPlaceholder={logic.handleAddGuestPlaceholder}
          handleSelectExistingVisitor={logic.handleSelectExistingVisitor}
          handleCreateVisitorAndAssign={logic.handleCreateVisitorAndAssign}
          renderTierBadge={logic.renderTierBadge}
        />

        {logic.shouldShowRememberEmail() && (
          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-500/30">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={logic.rememberEmail}
                onChange={(e) => logic.setRememberEmail(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-amber-400 text-amber-500 focus:ring-amber-500/50 focus:ring-offset-0"
              />
              <div>
                <p className="text-sm font-medium text-primary dark:text-white">Remember this email for future bookings</p>
                <p className="text-xs text-primary/70 dark:text-white/70 mt-0.5">
                  Link "{originalEmail}" to this member's account so future imports match automatically
                </p>
              </div>
            </label>
          </div>
        )}

        <AssignModeSecondaryActions
          markingAsEvent={logic.markingAsEvent}
          isLoadingNotices={logic.isLoadingNotices}
          showNoticeSelection={logic.showNoticeSelection}
          setShowNoticeSelection={logic.setShowNoticeSelection}
          overlappingNotices={logic.overlappingNotices}
          showStaffList={logic.showStaffList}
          setShowStaffList={logic.setShowStaffList}
          staffList={logic.staffList}
          isLoadingStaff={logic.isLoadingStaff}
          assigningToStaff={logic.assigningToStaff}
          handleMarkAsEvent={logic.handleMarkAsEvent}
          executeMarkAsEvent={logic.executeMarkAsEvent}
          handleAssignToStaff={logic.handleAssignToStaff as any}
          getRoleBadge={logic.getRoleBadge}
          onDeleteBooking={logic.handleDeleteBooking}
          deleting={logic.deleting}
        />
      </div>
    </SlideUpDrawer>
  );
}

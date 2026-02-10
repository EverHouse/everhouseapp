import { SlideUpDrawer } from '../../SlideUpDrawer';
import { SheetHeader } from './SheetHeader';
import { BookingActions } from './BookingActions';
import { PaymentSection } from './PaymentSection';
import { AssignModeSlots } from './AssignModeSlots';
import { ManageModeRoster } from './ManageModeRoster';
import { AssignModeFooter } from './AssignModeFooter';
import { ErrorBoundary } from '../../ErrorBoundary';
import { useUnifiedBookingLogic } from './useUnifiedBookingLogic';
import { isPlaceholderEmail } from './bookingSheetTypes';
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
  onReschedule?: (booking: { id: number; request_date: string; start_time: string; end_time: string; resource_id: number; resource_name?: string; user_name?: string; user_email?: string }) => void;
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

    const manageModeFooter = (
      <div className="p-4 space-y-2">
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 px-4 rounded-lg border border-gray-200 dark:border-white/20 text-primary dark:text-white font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={logic.handleManageModeSave}
            disabled={logic.savingChanges}
            className="flex-1 py-2.5 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white"
          >
            {logic.savingChanges ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                {checkinMode ? 'Checking In...' : 'Saving...'}
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-sm">{checkinMode ? 'how_to_reg' : 'save'}</span>
                {checkinMode ? 'Complete Check-In' : 'Save Changes'}
              </>
            )}
          </button>
        </div>
      </div>
    );

    return (
      <SlideUpDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={manageModeTitle}
        maxHeight="full"
        stickyFooter={manageModeFooter}
      >
        <div className="p-4 space-y-4">
          {logic.isLoadingRoster ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
            </div>
          ) : logic.rosterError ? (
            <div className="text-center py-8">
              <span className="material-symbols-outlined text-4xl text-red-500 mb-2">error</span>
              <p className="text-red-600 dark:text-red-400">{logic.rosterError}</p>
              <button onClick={logic.fetchRosterData} className="mt-4 px-4 py-2 bg-primary text-white rounded-lg text-sm">
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
                  renderTierBadge={logic.renderTierBadge}
                />
              </ErrorBoundary>

              <ErrorBoundary fallback={<div className="p-3 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-900/10 text-sm text-red-600 dark:text-red-400">Payment section encountered an error. Please close and reopen this booking.</div>}>
              <PaymentSection
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
              />
              </ErrorBoundary>

              <BookingActions
                bookingId={bookingId}
                bookingStatus={bookingStatus}
                fetchedContext={logic.fetchedContext}
                bookingContext={bookingContext}
                rosterData={logic.rosterData}
                onCheckIn={onCheckIn}
                onReschedule={onReschedule}
                onCancelBooking={onCancelBooking}
                ownerName={ownerName}
                ownerEmail={ownerEmail}
                bayName={bayName}
              />
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
      feeEstimate={logic.feeEstimate}
      isCalculatingFees={logic.isCalculatingFees}
      isConferenceRoom={logic.isConferenceRoom}
      onClose={onClose}
      handleFinalizeBooking={logic.handleFinalizeBooking}
      handleMarkAsEvent={logic.handleMarkAsEvent}
      executeMarkAsEvent={logic.executeMarkAsEvent}
      handleAssignToStaff={logic.handleAssignToStaff}
      getRoleBadge={logic.getRoleBadge}
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
      </div>
    </SlideUpDrawer>
  );
}

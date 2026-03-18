export interface BookingMember {
  id: number;
  bookingId: number;
  userEmail: string | null;
  slotNumber: number;
  isPrimary: boolean;
  linkedAt: string | null;
  linkedBy: string | null;
  memberName: string;
  tier: string | null;
  membershipStatus?: string | null;
  isStaff?: boolean;
  /** Fee amount in cents */
  fee: number;
  feeNote: string;
  guestInfo?: { guestId: number; guestName: string; guestEmail: string; /** Fee amount in cents */ fee: number; feeNote: string; usedGuestPass: boolean } | null;
}

export interface BookingGuest {
  id: number;
  bookingId: number;
  guestName: string | null;
  guestEmail: string | null;
  slotNumber: number;
  /** Fee amount in cents */
  fee: number;
  feeNote: string;
}

export interface ValidationInfo {
  expectedPlayerCount: number;
  actualPlayerCount: number;
  filledMemberSlots: number;
  guestCount: number;
  playerCountMismatch: boolean;
  emptySlots: number;
}

export interface FinancialSummary {
  ownerOverageFee: number;
  guestFeesWithoutPass: number;
  totalOwnerOwes: number;
  totalPlayersOwe: number;
  grandTotal: number;
  playerBreakdown: Array<{ name: string; tier: string | null; /** Fee amount in cents */ fee: number; feeNote: string; membershipStatus?: string | null }>;
  allPaid?: boolean;
}

export interface BookingContextType {
  requestDate?: string;
  startTime?: string;
  endTime?: string;
  resourceId?: number;
  resourceName?: string;
  durationMinutes?: number;
  notes?: string;
  trackmanCustomerNotes?: string;
}

export interface ManageModeRosterData {
  members: BookingMember[];
  guests: BookingGuest[];
  validation: ValidationInfo;
  ownerGuestPassesRemaining: number;
  tierLimits?: { guest_passes_per_year: number };
  guestPassContext?: { passesBeforeBooking: number; passesUsedThisBooking: number };
  financialSummary?: FinancialSummary;
  bookingNotes?: { notes: string | null; staffNotes: string | null; trackmanNotes: string | null };
  sessionId?: number;
  ownerId?: string;
  isOwnerStaff?: boolean;
}

export interface MemberMatchWarning {
  slotNumber: number;
  guestData: { guestName: string; guestEmail: string; guestPhone?: string };
  memberMatch: { email: string; name: string; tier: string; status: string; note: string };
}

export interface FetchedContext {
  bayName?: string;
  bookingDate?: string;
  timeSlot?: string;
  trackmanBookingId?: string;
  bookingStatus?: string;
  ownerName?: string;
  ownerEmail?: string;
  ownerUserId?: string;
  durationMinutes?: number;
  resourceId?: number;
  notes?: string;
}

export const isPlaceholderEmail = (email: string): boolean => {
  if (!email) return true;
  const lower = email.toLowerCase();
  return lower.includes('@visitors.evenhouse.club') || 
         lower.includes('@trackman.local') || 
         lower.startsWith('classpass-') ||
         lower.startsWith('golfnow-') ||
         lower.startsWith('lesson-') ||
         lower.startsWith('unmatched-');
};

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
  originalEmail?: string;
  bookingId?: number;
  sessionId?: number | string | null;
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
  onCheckIn?: (bookingId: number, targetStatus?: 'attended' | 'no_show') => void;
  onRevertToApproved?: (bookingId: number) => void | Promise<void>;
  bookingStatus?: string;
  ownerMembershipStatus?: string | null;
}

export interface VisitorSearchResult {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name?: string;
  userType?: 'visitor' | 'member' | 'staff' | 'instructor';
  isInstructor?: boolean;
  staffRole?: string;
}

export interface SlotState {
  type: 'empty' | 'member' | 'guest_placeholder' | 'visitor';
  /**
   * member.id source depends on context:
   * - In manage mode (existing booking): String(BookingMember.id) — the booking_participants row ID
   * - In assign mode (new booking): users.id — the user's string UUID
   * - For visitors: visitors.id — the visitor record UUID
   */
  member?: { id: string; email: string; name: string; tier?: string | null };
  guestName?: string;
}

export type SlotsArray = [SlotState, SlotState, SlotState, SlotState];

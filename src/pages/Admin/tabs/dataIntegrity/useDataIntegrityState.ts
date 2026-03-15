import { useState } from 'react';
import type {
  SystemHealth,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  IntegrityIssue,
  IgnoreModalState,
  BulkIgnoreModalState,
} from './dataIntegrityTypes';
import type { MemberProfile } from '../../../../types/data';

interface UnlinkedGuestFee {
  id: number;
  guest_name?: string;
  guest_email?: string;
  fee_amount?: number;
  booking_date?: string;
  member_email?: string;
  memberEmail?: string;
  saleDate?: string;
}

interface AvailableSession {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  resource_name?: string;
}

interface AttendanceBooking {
  id: number;
  user_email?: string;
  user_name?: string;
  request_date?: string;
  start_time?: string;
  end_time?: string;
  status?: string;
  resource_name?: string;
  reconciliationStatus?: string;
  reconciliationNotes?: string;
}

interface HubspotSyncMember {
  email: string;
  firstName?: string;
  lastName?: string;
  tier?: string;
  status?: string;
}

interface SubscriptionUpdate {
  email: string;
  oldStatus?: string;
  newStatus?: string;
  reason?: string;
}

interface OrphanedStripeRecord {
  email: string;
  stripeCustomerId?: string;
  reason?: string;
}

interface StripeHubspotMember {
  email: string;
  name?: string;
  stripeCustomerId?: string;
  hubspotId?: string;
}

interface PaymentUpdate {
  email: string;
  oldStatus?: string;
  newStatus?: string;
}

interface VisitMismatch {
  email: string;
  name?: string;
  currentCount?: number;
  actualCount?: number;
}

interface OrphanedParticipantDetail {
  email: string;
  bookingId?: number;
  action?: string;
}

interface DuplicateRecord {
  email: string;
  emails?: string[];
  name?: string;
  count?: number;
}

interface StripeCacheStats {
  cached?: number;
  total?: number;
  failed?: number;
  paymentIntents?: number;
  charges?: number;
  invoices?: number;
}

export function useDataIntegrityState() {
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);

  const [showCalendars, setShowCalendars] = useState(true);
  const [showHistory, setShowHistory] = useState(true);
  const [syncingIssues, setSyncingIssues] = useState<Set<string>>(new Set());
  const [cancellingBookings, setCancellingBookings] = useState<Set<number>>(new Set());
  const [fixingIssues, setFixingIssues] = useState<Set<string>>(new Set());

  const [ignoreModal, setIgnoreModal] = useState<IgnoreModalState>({ isOpen: false, issue: null, checkName: '' });
  const [bulkIgnoreModal, setBulkIgnoreModal] = useState<BulkIgnoreModalState>({ isOpen: false, checkName: '', issues: [] });
  const [ignoreDuration, setIgnoreDuration] = useState<'24h' | '1w' | '30d'>('24h');
  const [ignoreReason, setIgnoreReason] = useState<string>('');
  const [showIgnoredIssues, setShowIgnoredIssues] = useState(false);

  const [showDataTools, setShowDataTools] = useState(true);
  const [showSchedulerMonitor, setShowSchedulerMonitor] = useState(false);
  const [showWebhookEvents, setShowWebhookEvents] = useState(false);
  const [showJobQueue, setShowJobQueue] = useState(false);
  const [showHubSpotQueue, setShowHubSpotQueue] = useState(false);
  const [showAlertHistory, setShowAlertHistory] = useState(false);
  const [showPushNotifications, setShowPushNotifications] = useState(false);
  const [showAutoApprove, setShowAutoApprove] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [showStripeTerminal, setShowStripeTerminal] = useState(false);
  const [showEmailHealth, setShowEmailHealth] = useState(false);
  const [showMarketingAudit, setShowMarketingAudit] = useState(false);
  const [resyncEmail, setResyncEmail] = useState('');
  const [resyncResult, setResyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const [guestFeeStartDate, setGuestFeeStartDate] = useState('');
  const [guestFeeEndDate, setGuestFeeEndDate] = useState('');
  const [unlinkedGuestFees, setUnlinkedGuestFees] = useState<UnlinkedGuestFee[]>([]);
  const [availableSessions, setAvailableSessions] = useState<AvailableSession[]>([]);
  const [selectedFeeId, setSelectedFeeId] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const [attendanceSearchDate, setAttendanceSearchDate] = useState('');
  const [attendanceSearchEmail, setAttendanceSearchEmail] = useState('');
  const [attendanceBookings, setAttendanceBookings] = useState<AttendanceBooking[]>([]);
  const [updatingAttendanceId, setUpdatingAttendanceId] = useState<number | null>(null);
  const [attendanceNote, setAttendanceNote] = useState('');

  const [mindbodyStartDate, setMindbodyStartDate] = useState('');
  const [mindbodyEndDate, setMindbodyEndDate] = useState('');
  const [mindbodyResult, setMindbodyResult] = useState<{ success: boolean; message: string } | null>(null);

  const [hubspotSyncResult, setHubspotSyncResult] = useState<{ success: boolean; message: string; members?: HubspotSyncMember[]; dryRun?: boolean } | null>(null);
  const [mindbodyCleanupResult, setMindbodyCleanupResult] = useState<{ success: boolean; message: string; toClean?: number; dryRun?: boolean } | null>(null);
  const [stripeCleanupResult, setStripeCleanupResult] = useState<{ 
    success: boolean; 
    message: string; 
    dryRun?: boolean;
    totalCustomers?: number;
    emptyCount?: number;
    skippedActiveCount?: number;
    customers?: Array<{ id: string; email: string | null; name: string | null; created: string }>;
    deleted?: Array<{ id: string; email: string | null }>;
    deletedCount?: number;
  } | null>(null);

  const [firstVisitFile, setFirstVisitFile] = useState<File | null>(null);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [csvUploadResult, setCsvUploadResult] = useState<{
    success: boolean;
    message: string;
    firstVisit?: { total: number; linked: number; alreadyLinked: number; skipped: number };
    sales?: { total: number; imported: number; skipped: number; matchedByEmail: number; matchedByPhone: number; matchedByName: number; unmatched: number };
  } | null>(null);

  const [reconcileResult, setReconcileResult] = useState<{
    success: boolean;
    groupsChecked: number;
    membersDeactivated: number;
    membersReactivated: number;
    membersCreated: number;
    itemsRelinked: number;
    errors: string[];
  } | null>(null);

  const [stripeCacheResult, setStripeCacheResult] = useState<{ success: boolean; message: string; stats?: StripeCacheStats } | null>(null);

  const [showSyncTools, setShowSyncTools] = useState(true);
  const [subscriptionStatusResult, setSubscriptionStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; mismatchCount?: number; updated?: SubscriptionUpdate[]; dryRun?: boolean } | null>(null);
  const [orphanedStripeResult, setOrphanedStripeResult] = useState<{ success: boolean; message: string; totalChecked?: number; orphanedCount?: number; cleared?: OrphanedStripeRecord[]; dryRun?: boolean } | null>(null);
  const [stripeHubspotLinkResult, setStripeHubspotLinkResult] = useState<{ success: boolean; message: string; stripeOnlyMembers?: StripeHubspotMember[]; hubspotOnlyMembers?: StripeHubspotMember[]; linkedCount?: number; dryRun?: boolean } | null>(null);
  const [paymentStatusResult, setPaymentStatusResult] = useState<{ success: boolean; message: string; totalChecked?: number; updatedCount?: number; updates?: PaymentUpdate[]; dryRun?: boolean } | null>(null);
  const [visitCountResult, setVisitCountResult] = useState<{ success: boolean; message: string; mismatchCount?: number; updatedCount?: number; sampleMismatches?: VisitMismatch[]; dryRun?: boolean } | null>(null);
  const [ghostBookingResult, setGhostBookingResult] = useState<{ success: boolean; message: string; ghostBookings?: number; fixed?: number; dryRun?: boolean; errors?: Array<{ bookingId: number; error: string }> } | null>(null);
  const [orphanedParticipantResult, setOrphanedParticipantResult] = useState<{ success: boolean; message: string; relinked?: number; converted?: number; total?: number; dryRun?: boolean; relinkedDetails?: OrphanedParticipantDetail[]; convertedDetails?: OrphanedParticipantDetail[] } | null>(null);
  const [reviewItemsResult, setReviewItemsResult] = useState<{ success: boolean; message: string; wellnessCount?: number; eventCount?: number; total?: number; dryRun?: boolean } | null>(null);
  const [duplicateDetectionResult, setDuplicateDetectionResult] = useState<{ success: boolean; message: string; appDuplicates?: DuplicateRecord[]; hubspotDuplicates?: DuplicateRecord[] } | null>(null);
  const [expandedDuplicates, setExpandedDuplicates] = useState<{ app: boolean; hubspot: boolean }>({ app: false, hubspot: false });

  const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);
  const [isProfileDrawerOpen, setIsProfileDrawerOpen] = useState(false);
  const [loadingMemberEmail, setLoadingMemberEmail] = useState<string | null>(null);
  
  const [bookingSheet, setBookingSheet] = useState<{
    isOpen: boolean;
    bookingId: number | null;
    sessionId?: number | string | null;
    bayName?: string;
    bookingDate?: string;
    timeSlot?: string;
    memberName?: string;
    memberEmail?: string;
    trackmanBookingId?: string;
    importedName?: string;
    notes?: string;
    originalEmail?: string;
    isUnmatched?: boolean;
  }>({ isOpen: false, bookingId: null });

  const [showPlaceholderCleanup, setShowPlaceholderCleanup] = useState(true);
  const [placeholderAccounts, setPlaceholderAccounts] = useState<{
    stripeCustomers: Array<{ id: string; email: string; name: string | null; created: number }>;
    hubspotContacts: Array<{ id: string; email: string; name: string }>;
    localDatabaseUsers: Array<{ id: string; email: string; name: string; status: string; createdAt: string }>;
    totals: { stripe: number; hubspot: number; localDatabase: number; total: number };
  } | null>(null);
  const [placeholderDeleteResult, setPlaceholderDeleteResult] = useState<{
    stripeDeleted: number;
    stripeFailed: number;
    hubspotDeleted: number;
    hubspotFailed: number;
    localDatabaseDeleted: number;
    localDatabaseFailed: number;
  } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  const [isRunningVisitorArchive, setIsRunningVisitorArchive] = useState(false);
  const [visitorArchiveProgress, setVisitorArchiveProgress] = useState<{
    phase: string;
    totalVisitors: number;
    checked: number;
    eligibleCount: number;
    keptCount: number;
    deleted: number;
    errors: number;
  } | null>(null);
  const [visitorArchiveResult, setVisitorArchiveResult] = useState<{
    success: boolean;
    message: string;
    dryRun?: boolean;
    totalScanned?: number;
    eligibleCount?: number;
    keptCount?: number;
    deletedCount?: number;
    sampleDeleted?: Array<{ name: string; email: string }>;
  } | null>(null);

  const [isRunningStripeCleanup, setIsRunningStripeCleanup] = useState(false);
  const [stripeCleanupProgress, setStripeCleanupProgress] = useState<{
    phase: string;
    totalCustomers: number;
    checked: number;
    emptyFound: number;
    skippedActiveCount: number;
    deleted: number;
    errors: number;
  } | null>(null);

  const toggleCheck = (checkName: string) => {
    setExpandedChecks(prev => {
      const next = new Set(prev);
      if (next.has(checkName)) {
        next.delete(checkName);
      } else {
        next.add(checkName);
      }
      return next;
    });
  };

  return {
    expandedChecks, setExpandedChecks,
    selectedCheck, setSelectedCheck,
    showCalendars, setShowCalendars,
    showHistory, setShowHistory,
    syncingIssues, setSyncingIssues,
    cancellingBookings, setCancellingBookings,
    fixingIssues, setFixingIssues,
    ignoreModal, setIgnoreModal,
    bulkIgnoreModal, setBulkIgnoreModal,
    ignoreDuration, setIgnoreDuration,
    ignoreReason, setIgnoreReason,
    showIgnoredIssues, setShowIgnoredIssues,
    showDataTools, setShowDataTools,
    showSchedulerMonitor, setShowSchedulerMonitor,
    showWebhookEvents, setShowWebhookEvents,
    showJobQueue, setShowJobQueue,
    showHubSpotQueue, setShowHubSpotQueue,
    showAlertHistory, setShowAlertHistory,
    showPushNotifications, setShowPushNotifications,
    showAutoApprove, setShowAutoApprove,
    showAuditLog, setShowAuditLog,
    showStripeTerminal, setShowStripeTerminal,
    showEmailHealth, setShowEmailHealth,
    showMarketingAudit, setShowMarketingAudit,
    resyncEmail, setResyncEmail,
    resyncResult, setResyncResult,
    guestFeeStartDate, setGuestFeeStartDate,
    guestFeeEndDate, setGuestFeeEndDate,
    unlinkedGuestFees, setUnlinkedGuestFees,
    availableSessions, setAvailableSessions,
    selectedFeeId, setSelectedFeeId,
    selectedSessionId, setSelectedSessionId,
    attendanceSearchDate, setAttendanceSearchDate,
    attendanceSearchEmail, setAttendanceSearchEmail,
    attendanceBookings, setAttendanceBookings,
    updatingAttendanceId, setUpdatingAttendanceId,
    attendanceNote, setAttendanceNote,
    mindbodyStartDate, setMindbodyStartDate,
    mindbodyEndDate, setMindbodyEndDate,
    mindbodyResult, setMindbodyResult,
    hubspotSyncResult, setHubspotSyncResult,
    mindbodyCleanupResult, setMindbodyCleanupResult,
    stripeCleanupResult, setStripeCleanupResult,
    firstVisitFile, setFirstVisitFile,
    salesFile, setSalesFile,
    csvUploadResult, setCsvUploadResult,
    reconcileResult, setReconcileResult,
    stripeCacheResult, setStripeCacheResult,
    showSyncTools, setShowSyncTools,
    subscriptionStatusResult, setSubscriptionStatusResult,
    orphanedStripeResult, setOrphanedStripeResult,
    stripeHubspotLinkResult, setStripeHubspotLinkResult,
    paymentStatusResult, setPaymentStatusResult,
    visitCountResult, setVisitCountResult,
    ghostBookingResult, setGhostBookingResult,
    orphanedParticipantResult, setOrphanedParticipantResult,
    reviewItemsResult, setReviewItemsResult,
    duplicateDetectionResult, setDuplicateDetectionResult,
    expandedDuplicates, setExpandedDuplicates,
    selectedMember, setSelectedMember,
    isProfileDrawerOpen, setIsProfileDrawerOpen,
    loadingMemberEmail, setLoadingMemberEmail,
    bookingSheet, setBookingSheet,
    showPlaceholderCleanup, setShowPlaceholderCleanup,
    placeholderAccounts, setPlaceholderAccounts,
    placeholderDeleteResult, setPlaceholderDeleteResult,
    showDeleteConfirm, setShowDeleteConfirm,
    systemHealth, setSystemHealth,
    isCheckingHealth, setIsCheckingHealth,
    isRunningVisitorArchive, setIsRunningVisitorArchive,
    visitorArchiveProgress, setVisitorArchiveProgress,
    visitorArchiveResult, setVisitorArchiveResult,
    isRunningStripeCleanup, setIsRunningStripeCleanup,
    stripeCleanupProgress, setStripeCleanupProgress,
    toggleCheck,
  };
}

export type DataIntegrityState = ReturnType<typeof useDataIntegrityState>;

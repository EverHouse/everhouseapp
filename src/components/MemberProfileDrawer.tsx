import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../contexts/ThemeContext';
import { useBottomNav } from '../stores/bottomNavStore';
import TierBadge from './TierBadge';
import { formatPhoneNumber } from '../utils/formatting';
import { getMemberStatusColor, getMemberStatusLabel } from '../utils/statusColors';
import { useScrollLock } from '../hooks/useScrollLock';
import type { MemberProfile } from '../types/data';
import { copyToClipboard } from '../lib/copyToClipboard';
import MemberSearchInput, { SelectedMember } from './shared/MemberSearchInput';
import { useTierNames } from '../hooks/useTierNames';
import IdScannerModal from './staff-command-center/modals/IdScannerModal';
import { formatDatePacific } from './memberProfile/memberProfileTypes';
import Icon from './icons/Icon';
import type { MemberHistory, GuestVisit, MemberNote, CommunicationLog, TabType, BookingHistoryItem } from './memberProfile/memberProfileTypes';
import {
  useMemberDetails, useMemberHistory, useMemberNotes, useMemberCommunications,
  useMemberGuests, useMemberPayments, useMemberBalance, useMemberIdImage,
  useMemberAddOptions, useAddMemberNote, useUpdateMemberNote, useDeleteMemberNote,
  useAddCommunication, useDeleteCommunication, useApplyCredit, useSaveIdImage,
  useDeleteIdImage, useRemoveLinkedEmail, useDeleteMember, useChangeMemberEmail,
  useUpdateMemberContactInfo, useAssignTier, useSendPaymentLink, useSendReactivationLink,
  useMergePreview, useExecuteMerge, memberProfileKeys,
} from '../hooks/queries';

interface PurchaseItem {
  id: number | string;
  description?: string;
  amount?: number;
  date?: string;
  status?: string;
  type?: string;
  category?: string;
  product_name?: string;
  quantity?: number;
  created_at?: string;
}

interface MergePreviewData {
  sourceEmail: string;
  targetEmail: string;
  recordsToTransfer?: number;
  bookings?: number;
  notes?: number;
  communications?: number;
  guestPasses?: number;
  recordsToMerge?: Record<string, { source: number; target: number; action: string }>;
  conflicts?: Array<{ field: string; sourceValue: unknown; targetValue: unknown }>;
  recommendations?: Array<{ field: string; recommendation: string }>;
}
import OverviewTab from './memberProfile/OverviewTab';
import BillingTab from './memberProfile/BillingTab';
import ActivityTab from './memberProfile/ActivityTab';
import NotesTab from './memberProfile/NotesTab';
import CommunicationsTab from './memberProfile/CommunicationsTab';

interface MemberProfileDrawerProps {
  isOpen: boolean;
  member: MemberProfile | null;
  isAdmin: boolean;
  onClose: () => void;
  onViewAs: (member: MemberProfile) => void;
  onMemberDeleted?: () => void;
  onMemberUpdated?: () => void;
  visitorMode?: boolean;
}

const TABS: { id: TabType; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'billing', label: 'Billing', icon: 'payments' },
  { id: 'activity', label: 'Activity', icon: 'history' },
  { id: 'notes', label: 'Notes', icon: 'sticky_note_2' },
  { id: 'communications', label: 'Comms', icon: 'chat' },
];

const VISITOR_TABS: TabType[] = ['overview', 'billing', 'activity', 'communications', 'notes'];

const CopyButton: React.FC<{ value: string; isDark: boolean; size?: 'sm' | 'xs' }> = ({ value, isDark, size = 'sm' }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const success = await copyToClipboard(value);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const iconSize = size === 'xs' ? 'text-[12px]' : 'text-[14px]';
  const btnSize = size === 'xs' ? 'w-5 h-5 min-w-[20px]' : 'w-6 h-6 min-w-[24px]';
  return (
    <button
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy'}
      className={`${btnSize} flex items-center justify-center rounded transition-all tactile-btn ${
        copied
          ? 'text-green-500'
          : isDark ? 'text-gray-500 hover:text-gray-300 hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
      }`}
    >
      <Icon name={copied ? 'check' : 'content_copy'} className={`${iconSize}`} />
    </button>
  );
};

const MemberProfileDrawer: React.FC<MemberProfileDrawerProps> = ({ isOpen, member, isAdmin, onClose, onViewAs, onMemberDeleted, onMemberUpdated, visitorMode = false }) => {
  const { tiers: TIER_NAMES } = useTierNames();
  const { effectiveTheme } = useTheme();
  const { setDrawerOpen } = useBottomNav();
  const isDark = effectiveTheme === 'dark';
  
  useEffect(() => {
    setDrawerOpen(isOpen);
    return () => setDrawerOpen(false);
  }, [isOpen, setDrawerOpen]);
  
  
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  
  useEffect(() => {
    if (isOpen) {
      setActiveTab('overview');
      setShowEmailChange(false);
      setNewEmailValue('');
      setEmailChangeError('');
      setShowNameEdit(false);
      setNameEditError('');
      setShowPhoneEdit(false);
      setPhoneEditError('');
    }
  }, [isOpen, visitorMode]);
  
  const visibleTabs = visitorMode 
    ? TABS.filter(tab => VISITOR_TABS.includes(tab.id))
    : TABS;
  const [enrichedMember, setEnrichedMember] = useState<MemberProfile | null>(member);
  useEffect(() => {
    if (member) setEnrichedMember(member);
  }, [member]);


  const queryClient = useQueryClient();
  const memberEmail = isOpen ? member?.email : undefined;
  const memberId = isOpen ? member?.id : undefined;

  const detailsQuery = useMemberDetails(memberEmail);
  const historyQuery = useMemberHistory(memberEmail);
  const notesQuery = useMemberNotes(memberEmail);
  const commsQuery = useMemberCommunications(memberEmail);
  const guestsQuery = useMemberGuests(memberEmail);
  const paymentsQuery = useMemberPayments(memberEmail);
  const balanceQuery = useMemberBalance(memberEmail);
  const idImageQuery = useMemberIdImage(memberId ? String(memberId) : undefined, { enabled: isOpen && isAdmin });
  const addOptionsQuery = useMemberAddOptions({ enabled: isOpen && visitorMode && isAdmin });

  const isLoading = detailsQuery.isLoading || historyQuery.isLoading;
  const history = (historyQuery.data as unknown as MemberHistory) ?? null;
  const notes = (notesQuery.data as unknown as MemberNote[]) ?? [];
  const communications = (commsQuery.data as unknown as CommunicationLog[]) ?? [];
  const guestHistory = (guestsQuery.data as unknown as GuestVisit[]) ?? [];
  const rawPurchases = paymentsQuery.data as { payments?: PurchaseItem[] } | PurchaseItem[] | undefined;
  const purchases: PurchaseItem[] = rawPurchases ? (Array.isArray(rawPurchases) ? rawPurchases : (Array.isArray((rawPurchases as { payments?: PurchaseItem[] }).payments) ? (rawPurchases as { payments: PurchaseItem[] }).payments : [])) : [];
  const accountBalance = (balanceQuery.data as { balanceCents: number; balanceDollars: number }) ?? null;
  const idImageUrl = (idImageQuery.data as { idImageUrl: string | null })?.idImageUrl ?? null;
  const isLoadingIdImage = idImageQuery.isLoading;
  const membershipTiers = ((addOptionsQuery.data as { tiersWithIds?: Array<{id: number; name: string; priceCents: number; billingInterval: string; hasStripePrice: boolean}> })?.tiersWithIds) ?? [];

  useEffect(() => {
    if (detailsQuery.data) {
      setEnrichedMember(prev => prev ? { ...prev, ...(detailsQuery.data as Record<string, unknown>) } : prev);
    }
  }, [detailsQuery.data]);

  const addNoteMutation = useAddMemberNote();
  const updateNoteMutation = useUpdateMemberNote();
  const deleteNoteMutation = useDeleteMemberNote();
  const addCommMutation = useAddCommunication();
  const deleteCommMutation = useDeleteCommunication();
  const applyCreditMutation = useApplyCredit();
  const saveIdImageMutation = useSaveIdImage();
  const deleteIdImageMutation = useDeleteIdImage();
  const removeLinkedEmailMutation = useRemoveLinkedEmail();
  const deleteMemberMutation = useDeleteMember();
  const changeEmailMutation = useChangeMemberEmail();
  const updateContactInfoMutation = useUpdateMemberContactInfo();
  const assignTierMutation = useAssignTier();
  const sendPaymentLinkMutation = useSendPaymentLink();
  const sendReactivationLinkMutation = useSendReactivationLink();
  const mergePreviewMutation = useMergePreview();
  const executeMergeMutation = useExecuteMerge();

  const [linkedEmails, setLinkedEmails] = useState<string[]>([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteOptions, setDeleteOptions] = useState({ hubspot: true, stripe: true });
  const [selectedTierId, setSelectedTierId] = useState<number | null>(null);
  const [selectedAssignTier, setSelectedAssignTier] = useState<string>('');
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [newNotePinned, setNewNotePinned] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [showAddComm, setShowAddComm] = useState(false);
  const [newCommType, setNewCommType] = useState<string>('note');
  const [newCommDirection, setNewCommDirection] = useState<string>('outbound');
  const [newCommSubject, setNewCommSubject] = useState('');
  const [newCommBody, setNewCommBody] = useState('');

  const [displayedTier, setDisplayedTier] = useState<string>('');
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [selectedMergeTarget, setSelectedMergeTarget] = useState<SelectedMember | null>(null);
  const [mergePreview, setMergePreview] = useState<MergePreviewData | null>(null);
  const [showApplyCreditModal, setShowApplyCreditModal] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditDescription, setCreditDescription] = useState('');
  const [showIdScanner, setShowIdScanner] = useState(false);
  const [showIdImageFull, setShowIdImageFull] = useState(false);
  const [showEmailChange, setShowEmailChange] = useState(false);
  const [newEmailValue, setNewEmailValue] = useState('');
  const [emailChangeError, setEmailChangeError] = useState('');
  const [showNameEdit, setShowNameEdit] = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [nameEditError, setNameEditError] = useState('');
  const [showPhoneEdit, setShowPhoneEdit] = useState(false);
  const [editPhone, setEditPhone] = useState('');
  const [phoneEditError, setPhoneEditError] = useState('');

  const isSavingIdImage = saveIdImageMutation.isPending;
  const isDeletingIdImage = deleteIdImageMutation.isPending;
  const isAddingNote = addNoteMutation.isPending;
  const isAddingComm = addCommMutation.isPending;
  const isApplyingCredit = applyCreditMutation.isPending;
  const isDeleting = deleteMemberMutation.isPending;
  const isChangingEmail = changeEmailMutation.isPending;
  const isSavingName = updateContactInfoMutation.isPending && showNameEdit;
  const isSavingPhone = updateContactInfoMutation.isPending && showPhoneEdit;
  const assigningTier = assignTierMutation.isPending;
  const sendingPaymentLink = sendPaymentLinkMutation.isPending;
  const isMerging = executeMergeMutation.isPending;
  const isLoadingPreview = mergePreviewMutation.isPending;

  useEffect(() => {
    setDisplayedTier(member?.rawTier || member?.tier || '');
  }, [member?.rawTier, member?.tier]);

  useEffect(() => {
    if (isOpen && member) {
      setLinkedEmails(member.manuallyLinkedEmails || []);
    }
  }, [isOpen, member]);

  useEffect(() => {
    if (membershipTiers.length > 0 && !selectedTierId) {
      setSelectedTierId(membershipTiers[0].id);
    }
  }, [membershipTiers, selectedTierId]);

  const invalidateAllMemberData = useCallback(() => {
    if (!member?.email) return;
    queryClient.invalidateQueries({ queryKey: memberProfileKeys.all });
  }, [member?.email, queryClient]);

  useEffect(() => {
    const handleStatsUpdate = (event: CustomEvent) => {
      if (isOpen && member?.email && event.detail?.memberEmail?.toLowerCase() === member.email.toLowerCase()) {
        invalidateAllMemberData();
      }
    };
    window.addEventListener('member-stats-updated', handleStatsUpdate as EventListener);
    return () => window.removeEventListener('member-stats-updated', handleStatsUpdate as EventListener);
  }, [isOpen, member?.email, invalidateAllMemberData]);

  const hasUnsavedContent = 
    newNoteContent.trim().length > 0 ||
    editingNoteId !== null ||
    (showAddComm && (newCommSubject.trim().length > 0 || newCommBody.trim().length > 0));

  const handleDrawerClose = useCallback(() => {
    if (hasUnsavedContent) {
      if (!window.confirm('You have unsaved changes. Discard and close?')) {
        return;
      }
    }
    setNewNoteContent('');
    setEditingNoteId(null);
    setEditingNoteContent('');
    setShowAddComm(false);
    setNewCommSubject('');
    setNewCommBody('');
    onClose();
  }, [hasUnsavedContent, onClose]);

  useScrollLock(isOpen, handleDrawerClose);

  const handleIdScanComplete = useCallback(async (data: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
    imageBase64: string;
    imageMimeType: string;
  }) => {
    if (!member?.id) return;
    setShowIdScanner(false);
    saveIdImageMutation.mutate(
      { userId: String(member.id), image: data.imageBase64, mimeType: data.imageMimeType },
      { onError: (err) => console.error('Failed to save ID image:', err) }
    );
  }, [member?.id, saveIdImageMutation]);

  const handleDeleteIdImage = useCallback(() => {
    if (!member?.id) return;
    deleteIdImageMutation.mutate(
      { memberId: String(member.id) },
      {
        onSuccess: () => setShowIdImageFull(false),
        onError: (err) => console.error('Failed to delete ID image:', err),
      }
    );
  }, [member?.id, deleteIdImageMutation]);

  const handleRemoveLinkedEmail = (email: string) => {
    if (!member || !isAdmin) return;
    setRemovingEmail(email);
    removeLinkedEmailMutation.mutate(
      { memberEmail: member.email, linkedEmail: email },
      {
        onSuccess: (data) => {
          setLinkedEmails((data as { manuallyLinkedEmails: string[] }).manuallyLinkedEmails || []);
          setRemovingEmail(null);
        },
        onError: () => setRemovingEmail(null),
      }
    );
  };

  const handleApplyCredit = () => {
    if (!member?.email || !creditAmount || isApplyingCredit) return;
    const amountCents = Math.round(parseFloat(creditAmount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) return;
    applyCreditMutation.mutate(
      { email: member.email, amountCents, description: creditDescription || 'Staff applied credit' },
      {
        onSuccess: () => {
          setShowApplyCreditModal(false);
          setCreditAmount('');
          setCreditDescription('');
        },
        onError: (err) => alert(err.message || 'Failed to apply credit'),
      }
    );
  };

  const handleAddNote = () => {
    if (!member?.email || !newNoteContent.trim()) return;
    addNoteMutation.mutate(
      { email: member.email, content: newNoteContent, isPinned: newNotePinned },
      {
        onSuccess: () => {
          setNewNoteContent('');
          setNewNotePinned(false);
        },
        onError: (err) => console.error('Failed to add note:', err),
      }
    );
  };

  const handlePermanentDelete = () => {
    if (!member?.email && !member?.id) return;
    const entityType = visitorMode ? 'Visitor' : 'Member';
    deleteMemberMutation.mutate(
      {
        email: member.email,
        memberId: member.id ? String(member.id) : undefined,
        visitorMode,
        deleteFromHubSpot: deleteOptions.hubspot,
        deleteFromStripe: deleteOptions.stripe,
      },
      {
        onSuccess: (result) => {
          const r = result as { deletedRecords?: string[]; stripeDeleted?: boolean; hubspotArchived?: boolean };
          alert(`${entityType} deleted successfully.\n\nDeleted records: ${r.deletedRecords?.join(', ') || 'user'}\nStripe deleted: ${r.stripeDeleted ? 'Yes' : 'No'}\nHubSpot archived: ${r.hubspotArchived ? 'Yes' : 'No'}`);
          setShowDeleteModal(false);
          onClose();
          onMemberDeleted?.();
        },
        onError: (err) => alert(`Failed to delete ${entityType.toLowerCase()}: ${err.message || 'Unknown error'}`),
      }
    );
  };

  const handleUpdateNote = (noteId: number, content: string, isPinned?: boolean) => {
    if (!member?.email) return;
    updateNoteMutation.mutate(
      { email: member.email, noteId, content, isPinned },
      {
        onSuccess: () => {
          setEditingNoteId(null);
          setEditingNoteContent('');
        },
        onError: (err) => console.error('Failed to update note:', err),
      }
    );
  };

  const handleDeleteNote = (noteId: number) => {
    if (!member?.email) return;
    deleteNoteMutation.mutate(
      { email: member.email, noteId },
      { onError: (err) => console.error('Failed to delete note:', err) }
    );
  };

  const handleAddCommunication = () => {
    if (!member?.email || !newCommSubject.trim()) return;
    addCommMutation.mutate(
      {
        email: member.email, type: newCommType, direction: newCommDirection,
        subject: newCommSubject, body: newCommBody,
      },
      {
        onSuccess: () => {
          setNewCommType('note');
          setNewCommDirection('outbound');
          setNewCommSubject('');
          setNewCommBody('');
          setShowAddComm(false);
        },
        onError: (err) => console.error('Failed to add communication:', err),
      }
    );
  };

  const handleDeleteCommunication = (logId: number) => {
    if (!member?.email) return;
    deleteCommMutation.mutate(
      { email: member.email, logId },
      { onError: (err) => console.error('Failed to delete communication:', err) }
    );
  };

  if (!isOpen || !member || !enrichedMember) return null;

  const filteredBookingHistory = (history?.bookingHistory || []).filter((b: BookingHistoryItem) => b.status !== 'cancelled' && b.status !== 'declined' && b.status !== 'deleted');
  const filteredBookingRequestsHistory = (history?.bookingRequestsHistory || []).filter((b: BookingHistoryItem) => b.status !== 'cancelled' && b.status !== 'declined' && b.status !== 'deleted');
  const bookingsCount = filteredBookingHistory.length + filteredBookingRequestsHistory.length;
  const eventsCount = history?.eventRsvpHistory?.length || 0;
  const wellnessCount = history?.wellnessHistory?.length || 0;
  const visitsCount = history?.attendedVisitsCount || 0;

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-20">
          <Icon name="progress_activity" className="text-4xl text-gray-400 animate-spin" />
        </div>
      );
    }

    switch (activeTab) {
      case 'overview':
        return (
          <OverviewTab
            member={enrichedMember}
            isDark={isDark}
            isAdmin={isAdmin}
            visitorMode={visitorMode}
            bookingsCount={bookingsCount}
            eventsCount={eventsCount}
            wellnessCount={wellnessCount}
            visitsCount={visitsCount}
            accountBalance={accountBalance}
            showApplyCreditModal={showApplyCreditModal}
            setShowApplyCreditModal={setShowApplyCreditModal}
            creditAmount={creditAmount}
            setCreditAmount={setCreditAmount}
            creditDescription={creditDescription}
            setCreditDescription={setCreditDescription}
            isApplyingCredit={isApplyingCredit}
            handleApplyCredit={handleApplyCredit}
            idImageUrl={idImageUrl}
            isLoadingIdImage={isLoadingIdImage}
            isSavingIdImage={isSavingIdImage}
            isDeletingIdImage={isDeletingIdImage}
            setShowIdScanner={setShowIdScanner}
            showIdImageFull={showIdImageFull}
            setShowIdImageFull={setShowIdImageFull}
            handleDeleteIdImage={handleDeleteIdImage}
            linkedEmails={linkedEmails}
            removingEmail={removingEmail}
            handleRemoveLinkedEmail={handleRemoveLinkedEmail}
            onMemberUpdated={() => { invalidateAllMemberData(); onMemberUpdated?.(); }}
          />
        );

      case 'communications':
        return (
          <CommunicationsTab
            isDark={isDark}
            communications={communications}
            showAddComm={showAddComm}
            setShowAddComm={setShowAddComm}
            newCommType={newCommType}
            setNewCommType={setNewCommType}
            newCommDirection={newCommDirection}
            setNewCommDirection={setNewCommDirection}
            newCommSubject={newCommSubject}
            setNewCommSubject={setNewCommSubject}
            newCommBody={newCommBody}
            setNewCommBody={setNewCommBody}
            isAddingComm={isAddingComm}
            handleAddCommunication={handleAddCommunication}
            handleDeleteCommunication={handleDeleteCommunication}
          />
        );

      case 'notes':
        return (
          <NotesTab
            isDark={isDark}
            notes={notes}
            newNoteContent={newNoteContent}
            setNewNoteContent={setNewNoteContent}
            newNotePinned={newNotePinned}
            setNewNotePinned={setNewNotePinned}
            isAddingNote={isAddingNote}
            handleAddNote={handleAddNote}
            editingNoteId={editingNoteId}
            setEditingNoteId={setEditingNoteId}
            editingNoteContent={editingNoteContent}
            setEditingNoteContent={setEditingNoteContent}
            handleUpdateNote={handleUpdateNote}
            handleDeleteNote={handleDeleteNote}
          />
        );

      case 'billing':
        return (
          <BillingTab
            memberEmail={member.email}
            memberId={member.id}
            displayedTier={displayedTier}
            onTierUpdate={(newTier) => setDisplayedTier(newTier)}
            onMemberUpdated={onMemberUpdated}
            onDrawerClose={handleDrawerClose}
            guestPassInfo={history?.guestPassInfo ?? null}
            guestHistory={guestHistory}
            guestCheckInsHistory={history?.guestCheckInsHistory || []}
            purchases={purchases}
          />
        );

      case 'activity':
        return (
          <ActivityTab
            memberEmail={member.email}
            filteredBookingHistory={filteredBookingHistory}
            filteredBookingRequestsHistory={filteredBookingRequestsHistory}
            eventRsvpHistory={history?.eventRsvpHistory || []}
            wellnessHistory={history?.wellnessHistory || []}
            visitHistory={history?.visitHistory || []}
          />
        );

      default:
        return null;
    }
  };

  const drawerContent = (
    <div className={`fixed inset-0 ${isDark ? 'dark' : ''}`} style={{ zIndex: 'var(--z-modal)', height: '100%' }}>
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-normal"
        style={{ height: '100%' }}
        onClick={handleDrawerClose}
        aria-hidden="true"
      />
      
      <div 
        className={`fixed top-0 w-full max-w-xl rounded-tl-[2rem] ${isDark ? 'bg-[#1a1d15]' : 'bg-white'} shadow-2xl transform transition-transform duration-normal flex flex-col overflow-hidden`}
        style={{ 
          animation: 'slideInRight 0.4s var(--spring-bounce)',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          right: '-100px',
          paddingRight: '100px',
          bottom: 0
        }}
      >
        <div 
          className={`flex-shrink-0 px-4 pb-4 sm:px-6 sm:pb-6 border-b ${isDark ? 'border-white/10' : 'border-gray-200'} pt-4`}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <h2 className={`text-xl sm:text-2xl font-bold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{enrichedMember.name}</h2>
                {isAdmin && !showNameEdit && (
                  <button
                    onClick={() => {
                      setEditFirstName(enrichedMember.firstName || enrichedMember.name?.split(' ')[0] || '');
                      setEditLastName(enrichedMember.lastName || enrichedMember.name?.split(' ').slice(1).join(' ') || '');
                      setNameEditError('');
                      setShowNameEdit(true);
                    }}
                    className={`text-xs opacity-60 hover:opacity-100 transition-opacity cursor-pointer tactile-btn ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                    title="Edit name"
                  >
                    <Icon name="edit" className="text-xs" />
                  </button>
                )}
              </div>
              {showNameEdit && (
                <div className={`mt-2 p-3 rounded-xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-xs mb-2 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                    This will update the name across all systems (database, Stripe, HubSpot).
                  </p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      placeholder="First name"
                      value={editFirstName}
                      onChange={(e) => { setEditFirstName(e.target.value); setNameEditError(''); }}
                      className={`flex-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-white/10 border-white/20 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
                    />
                    <input
                      type="text"
                      placeholder="Last name"
                      value={editLastName}
                      onChange={(e) => { setEditLastName(e.target.value); setNameEditError(''); }}
                      className={`flex-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-white/10 border-white/20 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setNameEditError('');
                        updateContactInfoMutation.mutate(
                          { email: member.email, firstName: editFirstName.trim(), lastName: editLastName.trim() },
                          {
                            onSuccess: (data) => {
                              setShowNameEdit(false);
                              if (data.name !== undefined) {
                                setEnrichedMember(prev => prev ? { ...prev, name: String(data.name ?? ''), firstName: String(data.firstName ?? ''), lastName: String(data.lastName ?? '') } as MemberProfile : prev);
                              }
                              const failedSyncs: string[] = [];
                              if (data.syncResults?.stripe === false) failedSyncs.push('Stripe');
                              if (data.syncResults?.hubspot === false) failedSyncs.push('HubSpot');
                              if (failedSyncs.length > 0) {
                                setNameEditError(`Saved locally but failed to sync to ${failedSyncs.join(' and ')}`);
                              }
                              onMemberUpdated?.();
                            },
                            onError: (err) => setNameEditError(err.message || 'Failed to update name'),
                          }
                        );
                      }}
                      disabled={isSavingName}
                      className="px-4 py-2 rounded-lg bg-brand-green text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 tactile-btn"
                    >
                      {isSavingName ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setShowNameEdit(false); setNameEditError(''); }}
                      className={`px-3 py-2 rounded-lg text-sm font-medium tactile-btn ${isDark ? 'bg-white/10 text-gray-300 hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} transition-colors`}
                    >
                      Cancel
                    </button>
                  </div>
                  {nameEditError && (
                    <p className={`text-xs mt-2 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{nameEditError}</p>
                  )}
                </div>
              )}
              {!showNameEdit && nameEditError && (
                <p className={`text-xs mt-1 ${nameEditError.includes('Saved locally') ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-red-400' : 'text-red-600')}`}>{nameEditError}</p>
              )}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <TierBadge tier={displayedTier || enrichedMember.rawTier || enrichedMember.tier} size="md" showNoTier={true} lastTier={enrichedMember.lastTier} membershipStatus={enrichedMember.membershipStatus} role={enrichedMember.role} />
                {enrichedMember.status && typeof enrichedMember.status === 'string' && enrichedMember.status.toLowerCase() !== 'active' && (
                  <span className={`w-fit px-2 py-0.5 rounded-[4px] text-[10px] font-bold uppercase tracking-widest ${
                    getMemberStatusColor(enrichedMember.status, isDark)
                  }`}>
                    {getMemberStatusLabel(enrichedMember.status)}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={handleDrawerClose}
              aria-label="Close drawer"
              className={`w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:rotate-90 transition-transform duration-normal active:scale-90 tactile-btn ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
            >
              <Icon name="close" className="text-2xl" />
            </button>
          </div>

          <div className="mt-4 space-y-1">
            <div className="flex items-center gap-1">
              <a 
                href={`mailto:${member.email}`}
                className={`flex items-center gap-2 text-sm hover:underline ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
              >
                <Icon name="mail" className="text-lg" />
                {member.email}
              </a>
              <CopyButton value={member.email} isDark={isDark} />
              {isAdmin && (
                <button
                  onClick={() => {
                    setShowEmailChange(true);
                    setNewEmailValue('');
                    setEmailChangeError('');
                  }}
                  className={`text-xs opacity-60 hover:opacity-100 transition-opacity cursor-pointer tactile-btn ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                  title="Change email"
                >
                  <Icon name="edit" className="text-xs" />
                </button>
              )}
            </div>
            {showEmailChange && (
              <div className={`mt-2 p-3 rounded-xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
                <p className={`text-xs mb-2 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  This will update the email across all systems (database, Stripe, HubSpot).
                </p>
                <div className="flex gap-2">
                  <input
                    type="email"
                    placeholder="New email address"
                    value={newEmailValue}
                    onChange={(e) => {
                      setNewEmailValue(e.target.value);
                      setEmailChangeError('');
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-white/10 border-white/20 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
                  />
                  <button
                    onClick={() => {
                      if (!newEmailValue.trim()) return;
                      setEmailChangeError('');
                      changeEmailMutation.mutate(
                        { oldEmail: member.email, newEmail: newEmailValue.trim() },
                        {
                          onSuccess: (data) => {
                            alert((data as { message?: string }).message || 'Email changed successfully');
                            setShowEmailChange(false);
                            setNewEmailValue('');
                            setEmailChangeError('');
                            onMemberUpdated?.();
                          },
                          onError: (err) => setEmailChangeError(err.message || 'Failed to change email'),
                        }
                      );
                    }}
                    disabled={isChangingEmail || !newEmailValue.trim()}
                    className="px-4 py-2 rounded-lg bg-brand-green text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 tactile-btn"
                  >
                    {isChangingEmail ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => {
                      setShowEmailChange(false);
                      setNewEmailValue('');
                      setEmailChangeError('');
                    }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium tactile-btn ${isDark ? 'bg-white/10 text-gray-300 hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} transition-colors`}
                  >
                    Cancel
                  </button>
                </div>
                {emailChangeError && (
                  <p className={`text-xs mt-2 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{emailChangeError}</p>
                )}
              </div>
            )}
            {!showPhoneEdit && (
              <div className="flex items-center gap-1">
                {enrichedMember.phone ? (
                  <>
                    <a 
                      href={`tel:${enrichedMember.phone}`}
                      className={`flex items-center gap-2 text-sm hover:underline ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
                    >
                      <Icon name="phone" className="text-lg" />
                      {formatPhoneNumber(enrichedMember.phone)}
                    </a>
                    <CopyButton value={enrichedMember.phone} isDark={isDark} />
                  </>
                ) : (
                  <span className={`flex items-center gap-2 text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    <Icon name="phone" className="text-lg" />
                    No phone
                  </span>
                )}
                {isAdmin && (
                  <button
                    onClick={() => {
                      setEditPhone(enrichedMember.phone || '');
                      setPhoneEditError('');
                      setShowPhoneEdit(true);
                    }}
                    className={`text-xs opacity-60 hover:opacity-100 transition-opacity cursor-pointer tactile-btn ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                    title={enrichedMember.phone ? 'Edit phone' : 'Add phone'}
                  >
                    <Icon name="edit" className="text-xs" />
                  </button>
                )}
              </div>
            )}
            {showPhoneEdit && (
              <div className={`mt-1 p-3 rounded-xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
                <p className={`text-xs mb-2 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  This will update the phone across all systems (database, Stripe, HubSpot).
                </p>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    placeholder="(555) 123-4567"
                    value={editPhone}
                    onChange={(e) => { setEditPhone(e.target.value); setPhoneEditError(''); }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-white/10 border-white/20 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
                  />
                  <button
                    onClick={() => {
                      setPhoneEditError('');
                      updateContactInfoMutation.mutate(
                        { email: member.email, phone: editPhone.trim() || null },
                        {
                          onSuccess: (data) => {
                            setShowPhoneEdit(false);
                            setEnrichedMember(prev => prev ? { ...prev, phone: data.phone || '' } : prev);
                            const failedSyncs: string[] = [];
                            if (data.syncResults?.stripe === false) failedSyncs.push('Stripe');
                            if (data.syncResults?.hubspot === false) failedSyncs.push('HubSpot');
                            if (failedSyncs.length > 0) {
                              setPhoneEditError(`Saved locally but failed to sync to ${failedSyncs.join(' and ')}`);
                            }
                            onMemberUpdated?.();
                          },
                          onError: (err) => setPhoneEditError(err.message || 'Failed to update phone'),
                        }
                      );
                    }}
                    disabled={isSavingPhone}
                    className="px-4 py-2 rounded-lg bg-brand-green text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 tactile-btn"
                  >
                    {isSavingPhone ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setShowPhoneEdit(false); setPhoneEditError(''); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium tactile-btn ${isDark ? 'bg-white/10 text-gray-300 hover:bg-white/20' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} transition-colors`}
                  >
                    Cancel
                  </button>
                </div>
                {phoneEditError && (
                  <p className={`text-xs mt-2 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{phoneEditError}</p>
                )}
              </div>
            )}
            {!showPhoneEdit && phoneEditError && (
              <p className={`text-xs mt-1 ${phoneEditError.includes('Saved locally') ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-red-400' : 'text-red-600')}`}>{phoneEditError}</p>
            )}
            <div className="flex items-center gap-4 flex-wrap text-xs">
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                {visitsCount} lifetime visits
              </span>
              {enrichedMember.joinDate && (
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  Joined {formatDatePacific(enrichedMember.joinDate)}
                </span>
              )}
              {enrichedMember.lastModifiedAt && (
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  Modified {formatDatePacific(enrichedMember.lastModifiedAt)}
                </span>
              )}
            </div>
          </div>

          {isAdmin && !visitorMode && (
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => onViewAs(member)}
                className="flex-1 py-2.5 px-4 rounded-[4px] bg-brand-green text-white font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity tactile-btn"
              >
                <Icon name="visibility" className="text-lg" />
                View As
              </button>
              {enrichedMember.membershipStatus !== 'merged' && (
                <button
                  onClick={() => {
                    setShowMergeModal(true);
                    setSelectedMergeTarget(null);
                    setMergePreview(null);
                  }}
                  className="py-2.5 px-4 rounded-[4px] bg-indigo-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-indigo-700 transition-colors tactile-btn"
                  title="Merge with another user"
                >
                  <Icon name="merge" className="text-lg" />
                </button>
              )}
              <button
                onClick={() => setShowDeleteModal(true)}
                className="py-2.5 px-4 rounded-[4px] bg-red-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-red-700 transition-colors tactile-btn"
                title="Permanently delete member (for testing)"
              >
                <Icon name="delete_forever" className="text-lg" />
              </button>
            </div>
          )}

          {isAdmin && !visitorMode && !displayedTier && enrichedMember.membershipStatus === 'active' && (
            <div className={`mt-4 p-3 rounded-xl border ${isDark ? 'bg-yellow-900/20 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                <Icon name="warning" className="text-yellow-500" />
                <span className={`text-sm font-medium ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
                  No tier assigned {enrichedMember.billingProvider === 'mindbody' && '(MindBody member)'}
                </span>
              </div>
              <div className="flex gap-2">
                <select
                  value={selectedAssignTier}
                  onChange={(e) => setSelectedAssignTier(e.target.value)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-[#1a1d12] border-white/20 text-white' : 'bg-white border-gray-200 text-gray-800'}`}
                  aria-label="Select tier to assign"
                >
                  <option value="">Select tier...</option>
                  {TIER_NAMES.map(tier => (
                    <option key={tier} value={tier}>{tier}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    if (!selectedAssignTier) return;
                    assignTierMutation.mutate(
                      { email: member.email, tier: selectedAssignTier },
                      {
                        onSuccess: () => {
                          setDisplayedTier(selectedAssignTier);
                          setSelectedAssignTier('');
                        },
                        onError: (err) => alert(err.message || 'Failed to assign tier'),
                      }
                    );
                  }}
                  disabled={!selectedAssignTier || assigningTier}
                  className="px-4 py-2 rounded-lg bg-brand-green text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {assigningTier ? 'Saving...' : 'Assign'}
                </button>
              </div>
            </div>
          )}

          {isAdmin && visitorMode && member.email && (
            <div className="mt-4 space-y-3">
              <div className="flex flex-col gap-2">
                <label className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                  Send Payment Link
                </label>
                <div className="flex gap-2">
                  <select
                    value={selectedTierId || ''}
                    onChange={(e) => setSelectedTierId(e.target.value ? parseInt(e.target.value, 10) : null)}
                    className={`flex-1 px-3 py-2.5 rounded-xl border ${isDark ? 'bg-[#1a1d12] border-white/20 text-white' : 'bg-white border-gray-200 text-gray-800'}`}
                  >
                    <option value="">Select a tier...</option>
                    {membershipTiers.map(t => (
                      <option key={t.id} value={t.id} disabled={!t.hasStripePrice}>
                        {t.name} - ${(t.priceCents / 100).toFixed(0)}/{t.billingInterval}
                        {!t.hasStripePrice && ' (not synced)'}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      if (!selectedTierId) {
                        alert('Please select a tier first');
                        return;
                      }
                      sendPaymentLinkMutation.mutate(
                        {
                          email: member.email,
                          firstName: enrichedMember.name?.split(' ')[0] || '',
                          lastName: enrichedMember.name?.split(' ').slice(1).join(' ') || '',
                          tierId: selectedTierId,
                        },
                        {
                          onSuccess: () => alert(`Payment link sent to ${member.email}`),
                          onError: (err) => alert(err.message || 'Failed to send payment link'),
                        }
                      );
                    }}
                    disabled={sendingPaymentLink || !selectedTierId}
                    className="py-2.5 px-4 rounded-[4px] bg-brand-green text-white font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 tactile-btn"
                    title="Send payment link for selected tier"
                  >
                    {sendingPaymentLink ? (
                      <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    ) : (
                      <Icon name="send" className="text-lg" />
                    )}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowMergeModal(true);
                    setSelectedMergeTarget(null);
                    setMergePreview(null);
                  }}
                  className="flex-1 py-2.5 px-4 rounded-[4px] bg-indigo-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-indigo-700 transition-colors tactile-btn"
                  title="Merge visitor records into a member account"
                >
                  <Icon name="merge" className="text-lg" />
                  Merge to Member
                </button>
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="py-2.5 px-4 rounded-[4px] bg-red-600/10 text-red-600 dark:text-red-400 font-medium flex items-center justify-center gap-2 hover:bg-red-600/20 transition-colors tactile-btn"
                  title="Permanently delete visitor"
                >
                  <Icon name="delete_forever" className="text-lg" />
                </button>
              </div>
            </div>
          )}

          {isAdmin && !visitorMode && enrichedMember.membershipStatus && ['terminated', 'cancelled', 'canceled', 'frozen', 'inactive', 'suspended', 'expired', 'former_member'].includes(enrichedMember.membershipStatus.toLowerCase()) && (
            <div className="mt-3">
              <button
                onClick={() => {
                  sendReactivationLinkMutation.mutate(
                    { memberEmail: member.email },
                    {
                      onSuccess: () => alert(`Reactivation link sent to ${member.email}`),
                      onError: (err) => alert(err.message || 'Failed to send reactivation link'),
                    }
                  );
                }}
                className={`w-full py-2.5 px-4 rounded-[4px] font-medium flex items-center justify-center gap-2 transition-colors tactile-btn ${
                  isDark 
                    ? 'bg-amber-600/20 text-amber-400 border border-amber-600/30 hover:bg-amber-600/30'
                    : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                }`}
              >
                <Icon name="send" className="text-lg" />
                Send Reactivation Link
              </button>
            </div>
          )}
        </div>

        {showDeleteModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
            <div className={`${isDark ? 'bg-gray-800' : 'bg-white'} rounded-xl p-6 max-w-md w-full shadow-xl`}>
              <div className="flex items-center gap-3 mb-4">
                <Icon name="warning" className="text-3xl text-red-500" />
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Delete {visitorMode ? 'Visitor' : 'Member'} Permanently
                </h3>
              </div>
              
              <p className={`mb-4 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                This will permanently delete <strong>{enrichedMember.name}</strong> ({member.email}) and all their data from the app.
              </p>
              
              <div className="space-y-3 mb-6">
                <label className={`flex items-center gap-3 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
                  <input
                    type="checkbox"
                    checked={deleteOptions.hubspot}
                    onChange={(e) => setDeleteOptions(prev => ({ ...prev, hubspot: e.target.checked }))}
                    className="w-4 h-4 rounded"
                  />
                  <span>Also archive from HubSpot</span>
                </label>
                <label className={`flex items-center gap-3 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
                  <input
                    type="checkbox"
                    checked={deleteOptions.stripe}
                    onChange={(e) => setDeleteOptions(prev => ({ ...prev, stripe: e.target.checked }))}
                    className="w-4 h-4 rounded"
                  />
                  <span>Also delete from Stripe{visitorMode ? '' : ' (cancels subscriptions)'}</span>
                </label>
              </div>
              
              <p className={`text-sm mb-4 ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                This action cannot be undone. All bookings, notes, and history will be removed.
              </p>
              
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  disabled={isDeleting}
                  className={`flex-1 py-2.5 px-4 rounded-[4px] font-medium tactile-btn ${
                    isDark ? 'bg-gray-700 text-white hover:bg-gray-600' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                  } transition-colors`}
                >
                  Cancel
                </button>
                <button
                  onClick={handlePermanentDelete}
                  disabled={isDeleting}
                  className="flex-1 py-2.5 px-4 rounded-[4px] bg-red-600 text-white font-medium hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 tactile-btn"
                >
                  {isDeleting ? (
                    <>
                      <Icon name="progress_activity" className="animate-spin text-lg" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Icon name="delete_forever" className="text-lg" />
                      Delete Forever
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {showMergeModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
            <div className={`${isDark ? 'bg-gray-800' : 'bg-white'} rounded-xl p-6 max-w-lg w-full shadow-xl max-h-[90vh] overflow-y-auto`}>
              <div className="flex items-center gap-3 mb-4">
                <Icon name="merge" className="text-3xl text-indigo-500" />
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Merge {member.name}
                </h3>
              </div>
              
              <div className={`p-3 rounded-xl mb-4 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  <strong>User to be merged (will be deleted):</strong>
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isDark ? 'bg-red-900/30' : 'bg-red-100'}`}>
                    <Icon name="person_remove" className="text-red-500 text-sm" />
                  </div>
                  <div>
                    <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{enrichedMember.name}</p>
                    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{member.email}</p>
                  </div>
                </div>
              </div>

              <div className="mb-4">
                <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Search for PRIMARY user (will be kept):
                </label>
                <MemberSearchInput
                  onSelect={(selected) => {
                    setSelectedMergeTarget(selected);
                    setMergePreview(null);
                    mergePreviewMutation.mutate(
                      { primaryUserId: String(selected.id), secondaryUserId: String(member.id) },
                      {
                        onSuccess: (data) => setMergePreview(data as MergePreviewData),
                        onError: (err) => {
                          alert(err.message || 'Failed to load merge preview');
                          setSelectedMergeTarget(null);
                        },
                      }
                    );
                  }}
                  onClear={() => {
                    setSelectedMergeTarget(null);
                    setMergePreview(null);
                  }}
                  selectedMember={selectedMergeTarget}
                  placeholder="Search by name or email..."
                  excludeEmails={[member.email]}
                  includeVisitors={true}
                  includeFormer={true}
                  autoFocus
                />
              </div>

              {selectedMergeTarget && (
                <div className={`p-3 rounded-xl mb-4 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                  <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                    <strong>Primary user (will be kept):</strong>
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isDark ? 'bg-green-900/30' : 'bg-green-100'}`}>
                      <Icon name="person" className="text-green-500 text-sm" />
                    </div>
                    <div>
                      <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{selectedMergeTarget.name}</p>
                      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{selectedMergeTarget.email}</p>
                    </div>
                  </div>
                </div>
              )}

              {isLoadingPreview && (
                <div className="flex items-center justify-center py-6">
                  <Icon name="progress_activity" className="text-2xl text-indigo-500 animate-spin" />
                  <span className={`ml-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Loading preview...</span>
                </div>
              )}

              {mergePreview && (
                <div className={`p-4 rounded-xl mb-4 ${isDark ? 'bg-indigo-900/20 border border-indigo-500/30' : 'bg-indigo-50 border border-indigo-200'}`}>
                  <h4 className={`font-medium mb-3 flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    <Icon name="preview" className="text-lg text-indigo-500" />
                    Merge Preview
                  </h4>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {mergePreview.recordsToMerge?.bookings !== undefined && (mergePreview.recordsToMerge.bookings?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="event_note" className="text-sm align-middle mr-1" />
                        Bookings: <strong>{mergePreview.recordsToMerge.bookings?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.visits !== undefined && (mergePreview.recordsToMerge.visits?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="check_circle" className="text-sm align-middle mr-1" />
                        Visits: <strong>{mergePreview.recordsToMerge.visits?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.eventRsvps !== undefined && (mergePreview.recordsToMerge.eventRsvps?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="celebration" className="text-sm align-middle mr-1" />
                        Events: <strong>{mergePreview.recordsToMerge.eventRsvps?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.wellnessBookings !== undefined && (mergePreview.recordsToMerge.wellnessBookings?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="spa" className="text-sm align-middle mr-1" />
                        Wellness: <strong>{mergePreview.recordsToMerge.wellnessBookings?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.memberNotes !== undefined && (mergePreview.recordsToMerge.memberNotes?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="sticky_note_2" className="text-sm align-middle mr-1" />
                        Notes: <strong>{mergePreview.recordsToMerge.memberNotes?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.notifications !== undefined && (mergePreview.recordsToMerge.notifications?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="notifications" className="text-sm align-middle mr-1" />
                        Notifications: <strong>{mergePreview.recordsToMerge.notifications?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.usageLedger !== undefined && (mergePreview.recordsToMerge.usageLedger?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="payments" className="text-sm align-middle mr-1" />
                        Fees: <strong>{mergePreview.recordsToMerge.usageLedger?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.guestCheckIns !== undefined && (mergePreview.recordsToMerge.guestCheckIns?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="how_to_reg" className="text-sm align-middle mr-1" />
                        Guest Check-ins: <strong>{mergePreview.recordsToMerge.guestCheckIns?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.bookingParticipants !== undefined && (mergePreview.recordsToMerge.bookingParticipants?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="group" className="text-sm align-middle mr-1" />
                        Booking Participants: <strong>{mergePreview.recordsToMerge.bookingParticipants?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.dayPassPurchases !== undefined && (mergePreview.recordsToMerge.dayPassPurchases?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="confirmation_number" className="text-sm align-middle mr-1" />
                        Day Passes: <strong>{mergePreview.recordsToMerge.dayPassPurchases?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.legacyPurchases !== undefined && (mergePreview.recordsToMerge.legacyPurchases?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="receipt_long" className="text-sm align-middle mr-1" />
                        Legacy Purchases: <strong>{mergePreview.recordsToMerge.legacyPurchases?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.groupMembers !== undefined && (mergePreview.recordsToMerge.groupMembers?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="groups" className="text-sm align-middle mr-1" />
                        Group Memberships: <strong>{mergePreview.recordsToMerge.groupMembers?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.pushSubscriptions !== undefined && (mergePreview.recordsToMerge.pushSubscriptions?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="notifications_active" className="text-sm align-middle mr-1" />
                        Push Subscriptions: <strong>{mergePreview.recordsToMerge.pushSubscriptions?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.dismissedNotices !== undefined && (mergePreview.recordsToMerge.dismissedNotices?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="visibility_off" className="text-sm align-middle mr-1" />
                        Dismissed Notices: <strong>{mergePreview.recordsToMerge.dismissedNotices?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.billingGroups !== undefined && (mergePreview.recordsToMerge.billingGroups?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="account_balance" className="text-sm align-middle mr-1" />
                        Billing Groups: <strong>{mergePreview.recordsToMerge.billingGroups?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.bugReports !== undefined && (mergePreview.recordsToMerge.bugReports?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="bug_report" className="text-sm align-middle mr-1" />
                        Bug Reports: <strong>{mergePreview.recordsToMerge.bugReports?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.dataExportRequests !== undefined && (mergePreview.recordsToMerge.dataExportRequests?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="download" className="text-sm align-middle mr-1" />
                        Data Exports: <strong>{mergePreview.recordsToMerge.dataExportRequests?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.hubspotDeals !== undefined && (mergePreview.recordsToMerge.hubspotDeals?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="handshake" className="text-sm align-middle mr-1" />
                        HubSpot Deals: <strong>{mergePreview.recordsToMerge.hubspotDeals?.source ?? 0}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.stripePaymentIntents !== undefined && (mergePreview.recordsToMerge.stripePaymentIntents?.source ?? 0) > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Icon name="credit_card" className="text-sm align-middle mr-1" />
                        Payment Intents: <strong>{mergePreview.recordsToMerge.stripePaymentIntents?.source ?? 0}</strong>
                      </div>
                    )}
                  </div>
                  
                  {((mergePreview.conflicts && mergePreview.conflicts.length > 0) || (mergePreview.recommendations && mergePreview.recommendations.length > 0)) && (
                    <div className={`mt-3 p-2 rounded-lg ${isDark ? 'bg-amber-900/30' : 'bg-amber-50'}`}>
                      <p className={`text-xs font-medium ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                        <Icon name="warning" className="text-sm align-middle mr-1" />
                        Conflicts/Recommendations:
                      </p>
                      <ul className={`text-xs mt-1 space-y-1 ${isDark ? 'text-amber-300' : 'text-amber-600'}`}>
                        {mergePreview.conflicts?.map((c: { field: string; sourceValue: unknown; targetValue: unknown }, i: number) => (
                          <li key={`conflict-${i}`}>• {`${c.field}: ${String(c.sourceValue)} vs ${String(c.targetValue)}`}</li>
                        ))}
                        {mergePreview.recommendations?.map((r: { field: string; recommendation: string }, i: number) => (
                          <li key={`rec-${i}`}>• {`${r.field}: ${r.recommendation}`}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <p className={`text-sm mb-4 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                <Icon name="warning" className="text-sm align-middle mr-1" />
                This action cannot be undone. {member.name}'s account will be deleted after merging.
              </p>
              
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowMergeModal(false);
                    setSelectedMergeTarget(null);
                    setMergePreview(null);
                  }}
                  disabled={isMerging}
                  className={`flex-1 py-2.5 px-4 rounded-[4px] font-medium ${
                    isDark ? 'bg-gray-700 text-white hover:bg-gray-600' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                  } transition-colors`}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!selectedMergeTarget) return;
                    executeMergeMutation.mutate(
                      { primaryUserId: String(selectedMergeTarget.id), secondaryUserId: String(member.id) },
                      {
                        onSuccess: (result) => {
                          const r = result as { mergedCounts?: { bookings?: number; visits?: number; notes?: number } };
                          alert(`Merge successful!\n\nRecords merged into ${selectedMergeTarget.name}:\n• Bookings: ${r.mergedCounts?.bookings || 0}\n• Visits: ${r.mergedCounts?.visits || 0}\n• Notes: ${r.mergedCounts?.notes || 0}`);
                          setShowMergeModal(false);
                          setSelectedMergeTarget(null);
                          setMergePreview(null);
                          onClose();
                          onMemberDeleted?.();
                        },
                        onError: (err) => alert(err.message || 'Failed to merge users'),
                      }
                    );
                  }}
                  disabled={isMerging || !selectedMergeTarget || !mergePreview}
                  className="flex-1 py-2.5 px-4 rounded-[4px] bg-red-600 text-white font-medium hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isMerging ? (
                    <>
                      <Icon name="progress_activity" className="animate-spin text-lg" />
                      Merging...
                    </>
                  ) : (
                    <>
                      <Icon name="merge" className="text-lg" />
                      Confirm Merge
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className={`flex-shrink-0 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex overflow-x-auto scrollbar-hide">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-shrink-0 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 tactile-btn ${
                  activeTab === tab.id
                    ? `border-brand-green ${isDark ? 'text-white' : 'text-gray-900'}`
                    : `border-transparent ${isDark ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`
                }`}
              >
                <Icon name={tab.icon} className="text-lg" />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div 
          className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6"
          style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {renderContent()}
        </div>
      </div>
      {showIdImageFull && idImageUrl && (
        <div 
          className="fixed inset-0 flex items-center justify-center bg-black/80 p-4"
          style={{ zIndex: 'calc(var(--z-modal) + 10)' }}
          onClick={() => setShowIdImageFull(false)}
          aria-hidden="true"
        >
          <div className="relative max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setShowIdImageFull(false)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white tactile-btn"
            >
              <Icon name="close" />
            </button>
            <img
              src={idImageUrl}
              alt="ID Document Full Size"
              className="w-full rounded-xl"
            />
          </div>
        </div>
      )}
      <IdScannerModal
        isOpen={showIdScanner}
        onClose={() => setShowIdScanner(false)}
        onScanComplete={handleIdScanComplete}
        isDark={isDark}
      />
    </div>
  );

  return createPortal(drawerContent, document.body);
};

export default MemberProfileDrawer;

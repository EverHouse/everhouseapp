import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useBottomNav } from '../contexts/BottomNavContext';
import TierBadge from './TierBadge';
import TagBadge from './TagBadge';
import { formatPhoneNumber } from '../utils/formatting';
import { getMemberStatusColor, getMemberStatusLabel } from '../utils/statusColors';
import { useScrollLock } from '../hooks/useScrollLock';
import type { MemberProfile } from '../types/data';
import MemberSearchInput, { SelectedMember } from './shared/MemberSearchInput';
import { TIER_NAMES } from '../../shared/constants/tiers';
import IdScannerModal from './staff-command-center/modals/IdScannerModal';
import { useBookingActions } from '../hooks/useBookingActions';
import { formatDatePacific } from './memberProfile/memberProfileTypes';
import type { MemberHistory, GuestVisit, MemberNote, CommunicationLog, TabType } from './memberProfile/memberProfileTypes';
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
  visitorMode?: boolean;
}

const TABS: { id: TabType; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'billing', label: 'Billing', icon: 'payments' },
  { id: 'activity', label: 'Activity', icon: 'history' },
  { id: 'notes', label: 'Notes', icon: 'sticky_note_2' },
  { id: 'communications', label: 'Comms', icon: 'chat' },
];

const VISITOR_TABS: TabType[] = ['billing', 'activity', 'communications', 'notes'];

const MemberProfileDrawer: React.FC<MemberProfileDrawerProps> = ({ isOpen, member, isAdmin, onClose, onViewAs, onMemberDeleted, visitorMode = false }) => {
  const { effectiveTheme } = useTheme();
  const { setDrawerOpen } = useBottomNav();
  const { checkInWithToast } = useBookingActions();
  const isDark = effectiveTheme === 'dark';
  
  useEffect(() => {
    setDrawerOpen(isOpen);
    return () => setDrawerOpen(false);
  }, [isOpen, setDrawerOpen]);
  
  
  const [activeTab, setActiveTab] = useState<TabType>(visitorMode ? 'billing' : 'overview');
  
  useEffect(() => {
    if (isOpen) {
      setActiveTab(visitorMode ? 'billing' : 'overview');
    }
  }, [isOpen, visitorMode]);
  
  const visibleTabs = visitorMode 
    ? TABS.filter(tab => VISITOR_TABS.includes(tab.id))
    : TABS;
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<MemberHistory | null>(null);
  const [notes, setNotes] = useState<MemberNote[]>([]);
  const [communications, setCommunications] = useState<CommunicationLog[]>([]);
  const [guestHistory, setGuestHistory] = useState<GuestVisit[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [linkedEmails, setLinkedEmails] = useState<string[]>([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteOptions, setDeleteOptions] = useState({ hubspot: true, stripe: true });
  const [isDeleting, setIsDeleting] = useState(false);
  const [membershipTiers, setMembershipTiers] = useState<{id: number; name: string; priceCents: number; billingInterval: string; hasStripePrice: boolean}[]>([]);
  const [selectedTierId, setSelectedTierId] = useState<number | null>(null);
  const [sendingPaymentLink, setSendingPaymentLink] = useState(false);
  const [assigningTier, setAssigningTier] = useState(false);
  const [selectedAssignTier, setSelectedAssignTier] = useState<string>('');
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [newNotePinned, setNewNotePinned] = useState(false);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [showAddComm, setShowAddComm] = useState(false);
  const [newCommType, setNewCommType] = useState<string>('note');
  const [newCommDirection, setNewCommDirection] = useState<string>('outbound');
  const [newCommSubject, setNewCommSubject] = useState('');
  const [newCommBody, setNewCommBody] = useState('');
  const [isAddingComm, setIsAddingComm] = useState(false);
  const [updatingBookingId, setUpdatingBookingId] = useState<number | string | null>(null);
  const [displayedTier, setDisplayedTier] = useState<string>('');
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [selectedMergeTarget, setSelectedMergeTarget] = useState<SelectedMember | null>(null);
  const [mergePreview, setMergePreview] = useState<any>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [accountBalance, setAccountBalance] = useState<{ balanceCents: number; balanceDollars: number } | null>(null);
  const [showApplyCreditModal, setShowApplyCreditModal] = useState(false);
  const [isApplyingCredit, setIsApplyingCredit] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditDescription, setCreditDescription] = useState('');
  const [idImageUrl, setIdImageUrl] = useState<string | null>(null);
  const [isLoadingIdImage, setIsLoadingIdImage] = useState(false);
  const [showIdScanner, setShowIdScanner] = useState(false);
  const [showIdImageFull, setShowIdImageFull] = useState(false);
  const [isSavingIdImage, setIsSavingIdImage] = useState(false);
  const [isDeletingIdImage, setIsDeletingIdImage] = useState(false);

  useEffect(() => {
    setDisplayedTier(member?.rawTier || member?.tier || '');
  }, [member?.rawTier, member?.tier]);

  useEffect(() => {
    if (isOpen && visitorMode && isAdmin) {
      fetch('/api/members/add-options', { credentials: 'include' })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.tiersWithIds) {
            setMembershipTiers(data.tiersWithIds);
            if (data.tiersWithIds.length > 0 && !selectedTierId) {
              setSelectedTierId(data.tiersWithIds[0].id);
            }
          }
        })
        .catch(() => {});
    }
  }, [isOpen, visitorMode, isAdmin, selectedTierId]);

  const fetchMemberData = useCallback(async () => {
    if (!member?.email) return;
    setIsLoading(true);
    try {
      const [historyRes, notesRes, commsRes, guestsRes, purchasesRes, balanceRes] = await Promise.all([
        fetch(`/api/members/${encodeURIComponent(member.email)}/history`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/notes`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/communications`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/guests`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/unified-purchases`, { credentials: 'include' }),
        fetch(`/api/my-billing/account-balance?user_email=${encodeURIComponent(member.email)}`, { credentials: 'include' }),
      ]);

      if (historyRes.ok) {
        const historyData = await historyRes.json();
        setHistory(historyData);
      }
      if (notesRes.ok) {
        const notesData = await notesRes.json();
        setNotes(notesData);
      }
      if (commsRes.ok) {
        const commsData = await commsRes.json();
        setCommunications(commsData);
      }
      if (guestsRes.ok) {
        const guestsData = await guestsRes.json();
        setGuestHistory(guestsData);
      }
      if (purchasesRes.ok) {
        const purchasesData = await purchasesRes.json();
        setPurchases(purchasesData);
      }
      if (balanceRes.ok) {
        const balanceData = await balanceRes.json();
        setAccountBalance(balanceData);
      }
    } catch (err) {
      console.error('Failed to fetch member data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [member?.email]);

  const fetchIdImage = useCallback(async () => {
    if (!member?.id) return;
    setIsLoadingIdImage(true);
    try {
      const res = await fetch(`/api/admin/member/${encodeURIComponent(member.id)}/id-image`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setIdImageUrl(data.idImageUrl);
      }
    } catch (err) {
      console.error('Failed to fetch ID image:', err);
    } finally {
      setIsLoadingIdImage(false);
    }
  }, [member?.id]);

  useEffect(() => {
    if (isOpen && member) {
      setActiveTab('overview');
      setLinkedEmails(member.manuallyLinkedEmails || []);
      fetchMemberData();
    }
  }, [isOpen, member, fetchMemberData]);

  useEffect(() => {
    if (isOpen && member) {
      fetchIdImage();
    }
  }, [isOpen, member, fetchIdImage]);

  useEffect(() => {
    const handleStatsUpdate = (event: CustomEvent) => {
      if (isOpen && member?.email && event.detail?.memberEmail?.toLowerCase() === member.email.toLowerCase()) {
        fetchMemberData();
      }
    };
    window.addEventListener('member-stats-updated', handleStatsUpdate as EventListener);
    return () => window.removeEventListener('member-stats-updated', handleStatsUpdate as EventListener);
  }, [isOpen, member?.email, fetchMemberData]);

  useScrollLock(isOpen, onClose);

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
    setIsSavingIdImage(true);
    try {
      const res = await fetch('/api/admin/save-id-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: member.id,
          image: data.imageBase64,
          mimeType: data.imageMimeType,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setIdImageUrl(result.imageUrl);
      }
    } catch (err) {
      console.error('Failed to save ID image:', err);
    } finally {
      setIsSavingIdImage(false);
    }
  }, [member?.id]);

  const handleDeleteIdImage = useCallback(async () => {
    if (!member?.id) return;
    setIsDeletingIdImage(true);
    try {
      const res = await fetch(`/api/admin/member/${encodeURIComponent(member.id)}/id-image`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setIdImageUrl(null);
        setShowIdImageFull(false);
      }
    } catch (err) {
      console.error('Failed to delete ID image:', err);
    } finally {
      setIsDeletingIdImage(false);
    }
  }, [member?.id]);

  const handleRemoveLinkedEmail = async (email: string) => {
    if (!member || !isAdmin) return;
    setRemovingEmail(email);
    try {
      const res = await fetch('/api/admin/trackman/linked-email', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberEmail: member.email, linkedEmail: email })
      });
      if (res.ok) {
        const data = await res.json();
        setLinkedEmails(data.manuallyLinkedEmails || []);
      }
    } catch (err) {
      console.error('Failed to remove linked email:', err);
    } finally {
      setRemovingEmail(null);
    }
  };

  const handleApplyCredit = async () => {
    if (!member?.email || !creditAmount || isApplyingCredit) return;
    const amountCents = Math.round(parseFloat(creditAmount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) return;
    
    setIsApplyingCredit(true);
    try {
      const res = await fetch(`/api/member-billing/${encodeURIComponent(member.email)}/credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          amountCents, 
          description: creditDescription || 'Staff applied credit' 
        }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setAccountBalance(prev => ({
          balanceCents: Math.abs(data.endingBalance || 0),
          balanceDollars: Math.abs(data.endingBalance || 0) / 100,
        }));
        setShowApplyCreditModal(false);
        setCreditAmount('');
        setCreditDescription('');
      } else {
        const errorData = await res.json().catch(() => ({}));
        alert(errorData.error || 'Failed to apply credit');
      }
    } catch (err) {
      console.error('Failed to apply credit:', err);
      alert('Failed to apply credit');
    } finally {
      setIsApplyingCredit(false);
    }
  };

  const handleUpdateBookingStatus = async (bookingId: number | string, newStatus: 'attended' | 'no_show' | 'cancelled') => {
    setUpdatingBookingId(bookingId);
    try {
      const result = await checkInWithToast(bookingId, { status: newStatus });
      if (result.success) {
        setHistory(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            bookingHistory: prev.bookingHistory.map((b: any) => 
              b.id === bookingId ? { ...b, status: newStatus } : b
            ),
            bookingRequestsHistory: prev.bookingRequestsHistory.map((b: any) => 
              b.id === bookingId ? { ...b, status: newStatus } : b
            )
          };
        });
      }
    } finally {
      setUpdatingBookingId(null);
    }
  };

  const handleAddNote = async () => {
    if (!member?.email || !newNoteContent.trim()) return;
    setIsAddingNote(true);
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content: newNoteContent, isPinned: newNotePinned })
      });
      if (res.ok) {
        const newNote = await res.json();
        setNotes(prev => [newNote, ...prev]);
        setNewNoteContent('');
        setNewNotePinned(false);
      }
    } catch (err) {
      console.error('Failed to add note:', err);
    } finally {
      setIsAddingNote(false);
    }
  };

  const handlePermanentDelete = async () => {
    if (!member?.email && !member?.id) return;
    setIsDeleting(true);
    try {
      const params = new URLSearchParams();
      if (deleteOptions.hubspot) params.append('deleteFromHubSpot', 'true');
      if (deleteOptions.stripe) params.append('deleteFromStripe', 'true');
      
      // Use visitor API for visitors, member API for members
      const url = visitorMode && member.id
        ? `/api/visitors/${member.id}?${params}`
        : `/api/members/${encodeURIComponent(member.email)}/permanent?${params}`;
      
      const res = await fetch(url, {
        method: 'DELETE',
        credentials: 'include'
      });
      
      const entityType = visitorMode ? 'Visitor' : 'Member';
      
      if (res.ok) {
        const result = await res.json();
        alert(`${entityType} deleted successfully.\n\nDeleted records: ${result.deletedRecords?.join(', ') || 'user'}\nStripe deleted: ${result.stripeDeleted ? 'Yes' : 'No'}\nHubSpot archived: ${result.hubspotArchived ? 'Yes' : 'No'}`);
        setShowDeleteModal(false);
        onClose();
        onMemberDeleted?.();
      } else {
        const error = await res.json();
        alert(`Failed to delete ${entityType.toLowerCase()}: ${error.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Failed to delete:', err);
      alert('Failed to delete. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleUpdateNote = async (noteId: number, content: string, isPinned?: boolean) => {
    if (!member?.email) return;
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content, isPinned })
      });
      if (res.ok) {
        const updated = await res.json();
        setNotes(prev => prev.map(n => n.id === noteId ? updated : n));
        setEditingNoteId(null);
        setEditingNoteContent('');
      }
    } catch (err) {
      console.error('Failed to update note:', err);
    }
  };

  const handleDeleteNote = async (noteId: number) => {
    if (!member?.email) return;
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/notes/${noteId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        setNotes(prev => prev.filter(n => n.id !== noteId));
      }
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  const handleAddCommunication = async () => {
    if (!member?.email || !newCommSubject.trim()) return;
    setIsAddingComm(true);
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/communications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          type: newCommType,
          direction: newCommDirection,
          subject: newCommSubject,
          body: newCommBody,
          status: 'completed',
          occurredAt: new Date().toISOString()
        })
      });
      if (res.ok) {
        const newComm = await res.json();
        setCommunications(prev => [newComm, ...prev]);
        setNewCommType('note');
        setNewCommDirection('outbound');
        setNewCommSubject('');
        setNewCommBody('');
        setShowAddComm(false);
      }
    } catch (err) {
      console.error('Failed to add communication:', err);
    } finally {
      setIsAddingComm(false);
    }
  };

  const handleDeleteCommunication = async (logId: number) => {
    if (!member?.email) return;
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/communications/${logId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        setCommunications(prev => prev.filter(c => c.id !== logId));
      }
    } catch (err) {
      console.error('Failed to delete communication:', err);
    }
  };

  if (!isOpen || !member) return null;

  const filteredBookingHistory = (history?.bookingHistory || []).filter((b: any) => b.status !== 'cancelled' && b.status !== 'declined');
  const filteredBookingRequestsHistory = (history?.bookingRequestsHistory || []).filter((b: any) => b.status !== 'cancelled' && b.status !== 'declined');
  const bookingsCount = filteredBookingHistory.length + filteredBookingRequestsHistory.length;
  const eventsCount = history?.eventRsvpHistory?.length || 0;
  const wellnessCount = history?.wellnessHistory?.length || 0;
  const visitsCount = history?.attendedVisitsCount || 0;

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-20">
          <span className="material-symbols-outlined text-4xl text-gray-400 animate-spin">progress_activity</span>
        </div>
      );
    }

    switch (activeTab) {
      case 'overview':
        return (
          <OverviewTab
            member={member}
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
            guestPassInfo={history?.guestPassInfo}
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
    <div className={`fixed inset-0 ${isDark ? 'dark' : ''}`} style={{ zIndex: 'var(--z-modal)', height: '100dvh' }}>
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300"
        style={{ height: '100dvh' }}
        onClick={onClose}
      />
      
      <div 
        className={`fixed top-0 w-full max-w-xl rounded-tl-[2rem] ${isDark ? 'bg-[#1a1d15]' : 'bg-white'} shadow-2xl transform transition-transform duration-300 flex flex-col overflow-hidden`}
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
              <h2 className={`text-xl sm:text-2xl font-bold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{member.name}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <TierBadge tier={displayedTier || member.rawTier || member.tier} size="md" showNoTier={true} lastTier={member.lastTier} membershipStatus={member.membershipStatus} />
                {member.status && typeof member.status === 'string' && member.status.toLowerCase() !== 'active' && (
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                    getMemberStatusColor(member.status, isDark)
                  }`}>
                    {getMemberStatusLabel(member.status)}
                  </span>
                )}
                {member.tags?.filter((tag): tag is string => typeof tag === 'string').map(tag => (
                  <TagBadge key={tag} tag={tag} size="sm" />
                ))}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close drawer"
              className={`w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:rotate-90 transition-transform duration-300 active:scale-90 ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
            >
              <span className="material-symbols-outlined text-2xl">close</span>
            </button>
          </div>

          <div className="mt-4 space-y-2">
            <a 
              href={`mailto:${member.email}`}
              className={`flex items-center gap-2 text-sm hover:underline ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
            >
              <span className="material-symbols-outlined text-lg">mail</span>
              {member.email}
            </a>
            {member.phone && (
              <a 
                href={`tel:${member.phone}`}
                className={`flex items-center gap-2 text-sm hover:underline ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
              >
                <span className="material-symbols-outlined text-lg">phone</span>
                {formatPhoneNumber(member.phone)}
              </a>
            )}
            <div className="flex items-center gap-4 flex-wrap text-xs">
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                {visitsCount} lifetime visits
              </span>
              {member.joinDate && (
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  Joined {formatDatePacific(member.joinDate)}
                </span>
              )}
            </div>
            {/* System IDs section - only show mindbody ID if validated from HubSpot */}
            <div className="flex items-center gap-3 flex-wrap text-xs mt-1">
              {member.mindbodyClientId && member.hubspotId && (
                <span className={isDark ? 'text-gray-500' : 'text-gray-400'}>
                  MB: {member.mindbodyClientId}
                </span>
              )}
              {member.stripeCustomerId && (
                <span className={isDark ? 'text-gray-500' : 'text-gray-400'}>
                  Stripe: {member.stripeCustomerId.substring(0, 14)}...
                </span>
              )}
              {member.hubspotId && (
                <span className={isDark ? 'text-gray-500' : 'text-gray-400'}>
                  HS: {member.hubspotId}
                </span>
              )}
            </div>
          </div>

          {isAdmin && !visitorMode && (
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => onViewAs(member)}
                className="flex-1 py-2.5 px-4 rounded-xl bg-brand-green text-white font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
              >
                <span className="material-symbols-outlined text-lg">visibility</span>
                View As This Member
              </button>
              <button
                onClick={() => {
                  setShowMergeModal(true);
                  setSelectedMergeTarget(null);
                  setMergePreview(null);
                }}
                className="py-2.5 px-4 rounded-xl bg-indigo-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-indigo-700 transition-colors"
                title="Merge with another user"
              >
                <span className="material-symbols-outlined text-lg">merge</span>
              </button>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="py-2.5 px-4 rounded-xl bg-red-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-red-700 transition-colors"
                title="Permanently delete member (for testing)"
              >
                <span className="material-symbols-outlined text-lg">delete_forever</span>
              </button>
            </div>
          )}

          {isAdmin && !visitorMode && !displayedTier && member.membershipStatus === 'active' && (
            <div className={`mt-4 p-3 rounded-xl border ${isDark ? 'bg-yellow-900/20 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-yellow-500">warning</span>
                <span className={`text-sm font-medium ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>
                  No tier assigned {member.billingProvider === 'mindbody' && '(MindBody member)'}
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
                  onClick={async () => {
                    if (!selectedAssignTier) return;
                    setAssigningTier(true);
                    try {
                      const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/tier`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ tier: selectedAssignTier })
                      });
                      const data = await res.json();
                      if (res.ok && data.success) {
                        setDisplayedTier(selectedAssignTier);
                        setSelectedAssignTier('');
                      } else {
                        alert(data.error || 'Failed to assign tier');
                      }
                    } catch {
                      alert('Failed to assign tier');
                    } finally {
                      setAssigningTier(false);
                    }
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
                    onClick={async () => {
                      if (!selectedTierId) {
                        alert('Please select a tier first');
                        return;
                      }
                      setSendingPaymentLink(true);
                      try {
                        const res = await fetch('/api/stripe/staff/send-membership-link', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({ 
                            email: member.email,
                            firstName: member.firstName || member.name?.split(' ')[0] || '',
                            lastName: member.lastName || member.name?.split(' ').slice(1).join(' ') || '',
                            tierId: selectedTierId
                          })
                        });
                        if (res.ok) {
                          alert(`Payment link sent to ${member.email}`);
                        } else {
                          const data = await res.json();
                          alert(data.error || 'Failed to send payment link');
                        }
                      } catch (err) {
                        alert('Failed to send payment link');
                      } finally {
                        setSendingPaymentLink(false);
                      }
                    }}
                    disabled={sendingPaymentLink || !selectedTierId}
                    className="py-2.5 px-4 rounded-xl bg-brand-green text-white font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
                    title="Send payment link for selected tier"
                  >
                    {sendingPaymentLink ? (
                      <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    ) : (
                      <span className="material-symbols-outlined text-lg">send</span>
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
                  className="flex-1 py-2.5 px-4 rounded-xl bg-indigo-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-indigo-700 transition-colors"
                  title="Merge visitor records into a member account"
                >
                  <span className="material-symbols-outlined text-lg">merge</span>
                  Merge to Member
                </button>
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="py-2.5 px-4 rounded-xl bg-red-600/10 text-red-600 dark:text-red-400 font-medium flex items-center justify-center gap-2 hover:bg-red-600/20 transition-colors"
                  title="Permanently delete visitor"
                >
                  <span className="material-symbols-outlined text-lg">delete_forever</span>
                </button>
              </div>
            </div>
          )}

          {isAdmin && !visitorMode && member.membershipStatus && ['terminated', 'cancelled', 'canceled', 'frozen', 'inactive', 'suspended'].includes(member.membershipStatus.toLowerCase()) && (
            <div className="mt-3">
              <button
                onClick={async () => {
                  try {
                    const res = await fetch('/api/stripe/staff/send-reactivation-link', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ memberEmail: member.email })
                    });
                    if (res.ok) {
                      alert(`Reactivation link sent to ${member.email}`);
                    } else {
                      const data = await res.json();
                      alert(data.error || 'Failed to send reactivation link');
                    }
                  } catch (err) {
                    alert('Failed to send reactivation link');
                  }
                }}
                className={`w-full py-2.5 px-4 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors ${
                  isDark 
                    ? 'bg-amber-600/20 text-amber-400 border border-amber-600/30 hover:bg-amber-600/30'
                    : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                }`}
              >
                <span className="material-symbols-outlined text-lg">send</span>
                Send Reactivation Link
              </button>
            </div>
          )}
        </div>

        {showDeleteModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
            <div className={`${isDark ? 'bg-gray-800' : 'bg-white'} rounded-2xl p-6 max-w-md w-full shadow-xl`}>
              <div className="flex items-center gap-3 mb-4">
                <span className="material-symbols-outlined text-3xl text-red-500">warning</span>
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Delete {visitorMode ? 'Visitor' : 'Member'} Permanently
                </h3>
              </div>
              
              <p className={`mb-4 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                This will permanently delete <strong>{member.firstName} {member.lastName}</strong> ({member.email}) and all their data from the app.
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
                  className={`flex-1 py-2.5 px-4 rounded-xl font-medium ${
                    isDark ? 'bg-gray-700 text-white hover:bg-gray-600' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                  } transition-colors`}
                >
                  Cancel
                </button>
                <button
                  onClick={handlePermanentDelete}
                  disabled={isDeleting}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-red-600 text-white font-medium hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isDeleting ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                      Deleting...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-lg">delete_forever</span>
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
            <div className={`${isDark ? 'bg-gray-800' : 'bg-white'} rounded-2xl p-6 max-w-lg w-full shadow-xl max-h-[90vh] overflow-y-auto`}>
              <div className="flex items-center gap-3 mb-4">
                <span className="material-symbols-outlined text-3xl text-indigo-500">merge</span>
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Merge {member.name || member.firstName}
                </h3>
              </div>
              
              <div className={`p-3 rounded-xl mb-4 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  <strong>User to be merged (will be deleted):</strong>
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isDark ? 'bg-red-900/30' : 'bg-red-100'}`}>
                    <span className="material-symbols-outlined text-red-500 text-sm">person_remove</span>
                  </div>
                  <div>
                    <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{member.name}</p>
                    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{member.email}</p>
                  </div>
                </div>
              </div>

              <div className="mb-4">
                <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Search for PRIMARY user (will be kept):
                </label>
                <MemberSearchInput
                  onSelect={async (selected) => {
                    setSelectedMergeTarget(selected);
                    setMergePreview(null);
                    setIsLoadingPreview(true);
                    try {
                      const res = await fetch('/api/members/merge/preview', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                          primaryUserId: selected.id,
                          secondaryUserId: member.id || member.userId
                        })
                      });
                      if (res.ok) {
                        const data = await res.json();
                        setMergePreview(data);
                      } else {
                        const error = await res.json();
                        alert(error.error || 'Failed to load merge preview');
                        setSelectedMergeTarget(null);
                      }
                    } catch (err) {
                      console.error('Failed to fetch merge preview:', err);
                      alert('Failed to load merge preview');
                      setSelectedMergeTarget(null);
                    } finally {
                      setIsLoadingPreview(false);
                    }
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
                      <span className="material-symbols-outlined text-green-500 text-sm">person</span>
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
                  <span className="material-symbols-outlined text-2xl text-indigo-500 animate-spin">progress_activity</span>
                  <span className={`ml-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Loading preview...</span>
                </div>
              )}

              {mergePreview && (
                <div className={`p-4 rounded-xl mb-4 ${isDark ? 'bg-indigo-900/20 border border-indigo-500/30' : 'bg-indigo-50 border border-indigo-200'}`}>
                  <h4 className={`font-medium mb-3 flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    <span className="material-symbols-outlined text-lg text-indigo-500">preview</span>
                    Merge Preview
                  </h4>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {mergePreview.recordsToMerge?.bookings !== undefined && mergePreview.recordsToMerge.bookings > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">event_note</span>
                        Bookings: <strong>{mergePreview.recordsToMerge.bookings}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.visits !== undefined && mergePreview.recordsToMerge.visits > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">check_circle</span>
                        Visits: <strong>{mergePreview.recordsToMerge.visits}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.eventRsvps !== undefined && mergePreview.recordsToMerge.eventRsvps > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">celebration</span>
                        Events: <strong>{mergePreview.recordsToMerge.eventRsvps}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.wellnessBookings !== undefined && mergePreview.recordsToMerge.wellnessBookings > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">spa</span>
                        Wellness: <strong>{mergePreview.recordsToMerge.wellnessBookings}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.memberNotes !== undefined && mergePreview.recordsToMerge.memberNotes > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">sticky_note_2</span>
                        Notes: <strong>{mergePreview.recordsToMerge.memberNotes}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.notifications !== undefined && mergePreview.recordsToMerge.notifications > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">notifications</span>
                        Notifications: <strong>{mergePreview.recordsToMerge.notifications}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.usageLedger !== undefined && mergePreview.recordsToMerge.usageLedger > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">payments</span>
                        Fees: <strong>{mergePreview.recordsToMerge.usageLedger}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.guestCheckIns !== undefined && mergePreview.recordsToMerge.guestCheckIns > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">how_to_reg</span>
                        Guest Check-ins: <strong>{mergePreview.recordsToMerge.guestCheckIns}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.bookingParticipants !== undefined && mergePreview.recordsToMerge.bookingParticipants > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">group</span>
                        Booking Participants: <strong>{mergePreview.recordsToMerge.bookingParticipants}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.dayPassPurchases !== undefined && mergePreview.recordsToMerge.dayPassPurchases > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">confirmation_number</span>
                        Day Passes: <strong>{mergePreview.recordsToMerge.dayPassPurchases}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.legacyPurchases !== undefined && mergePreview.recordsToMerge.legacyPurchases > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">receipt_long</span>
                        Legacy Purchases: <strong>{mergePreview.recordsToMerge.legacyPurchases}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.groupMembers !== undefined && mergePreview.recordsToMerge.groupMembers > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">groups</span>
                        Group Memberships: <strong>{mergePreview.recordsToMerge.groupMembers}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.pushSubscriptions !== undefined && mergePreview.recordsToMerge.pushSubscriptions > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">notifications_active</span>
                        Push Subscriptions: <strong>{mergePreview.recordsToMerge.pushSubscriptions}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.dismissedNotices !== undefined && mergePreview.recordsToMerge.dismissedNotices > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">visibility_off</span>
                        Dismissed Notices: <strong>{mergePreview.recordsToMerge.dismissedNotices}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.billingGroups !== undefined && mergePreview.recordsToMerge.billingGroups > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">account_balance</span>
                        Billing Groups: <strong>{mergePreview.recordsToMerge.billingGroups}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.bugReports !== undefined && mergePreview.recordsToMerge.bugReports > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">bug_report</span>
                        Bug Reports: <strong>{mergePreview.recordsToMerge.bugReports}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.dataExportRequests !== undefined && mergePreview.recordsToMerge.dataExportRequests > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">download</span>
                        Data Exports: <strong>{mergePreview.recordsToMerge.dataExportRequests}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.hubspotDeals !== undefined && mergePreview.recordsToMerge.hubspotDeals > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">handshake</span>
                        HubSpot Deals: <strong>{mergePreview.recordsToMerge.hubspotDeals}</strong>
                      </div>
                    )}
                    {mergePreview.recordsToMerge?.stripePaymentIntents !== undefined && mergePreview.recordsToMerge.stripePaymentIntents > 0 && (
                      <div className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">credit_card</span>
                        Payment Intents: <strong>{mergePreview.recordsToMerge.stripePaymentIntents}</strong>
                      </div>
                    )}
                  </div>
                  
                  {((mergePreview.conflicts && mergePreview.conflicts.length > 0) || (mergePreview.recommendations && mergePreview.recommendations.length > 0)) && (
                    <div className={`mt-3 p-2 rounded-lg ${isDark ? 'bg-amber-900/30' : 'bg-amber-50'}`}>
                      <p className={`text-xs font-medium ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                        <span className="material-symbols-outlined text-sm align-middle mr-1">warning</span>
                        Conflicts/Recommendations:
                      </p>
                      <ul className={`text-xs mt-1 space-y-1 ${isDark ? 'text-amber-300' : 'text-amber-600'}`}>
                        {mergePreview.conflicts?.map((c: string, i: number) => (
                          <li key={`conflict-${i}`}>• {c}</li>
                        ))}
                        {mergePreview.recommendations?.map((r: string, i: number) => (
                          <li key={`rec-${i}`}>• {r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <p className={`text-sm mb-4 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                <span className="material-symbols-outlined text-sm align-middle mr-1">warning</span>
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
                  className={`flex-1 py-2.5 px-4 rounded-xl font-medium ${
                    isDark ? 'bg-gray-700 text-white hover:bg-gray-600' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                  } transition-colors`}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!selectedMergeTarget) return;
                    setIsMerging(true);
                    try {
                      const res = await fetch('/api/members/merge/execute', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                          primaryUserId: selectedMergeTarget.id,
                          secondaryUserId: member.id || member.userId
                        })
                      });
                      if (res.ok) {
                        const result = await res.json();
                        alert(`Merge successful!\n\nRecords merged into ${selectedMergeTarget.name}:\n• Bookings: ${result.mergedCounts?.bookings || 0}\n• Visits: ${result.mergedCounts?.visits || 0}\n• Notes: ${result.mergedCounts?.notes || 0}`);
                        setShowMergeModal(false);
                        setSelectedMergeTarget(null);
                        setMergePreview(null);
                        onClose();
                        onMemberDeleted?.();
                      } else {
                        const error = await res.json();
                        alert(error.error || 'Failed to merge users');
                      }
                    } catch (err) {
                      console.error('Failed to merge users:', err);
                      alert('Failed to merge users. Please try again.');
                    } finally {
                      setIsMerging(false);
                    }
                  }}
                  disabled={isMerging || !selectedMergeTarget || !mergePreview}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-red-600 text-white font-medium hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isMerging ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                      Merging...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-lg">merge</span>
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
                className={`flex-shrink-0 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === tab.id
                    ? `border-brand-green ${isDark ? 'text-white' : 'text-gray-900'}`
                    : `border-transparent ${isDark ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`
                }`}
              >
                <span className="material-symbols-outlined text-lg">{tab.icon}</span>
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
          className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setShowIdImageFull(false)}
        >
          <div className="relative max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setShowIdImageFull(false)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white"
            >
              <span className="material-symbols-outlined">close</span>
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
